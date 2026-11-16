/**
 * Smoke test of contest actions over real player sessions (Decisions ADR-027 tests; M3 Step 4.4
 * S5). The Quench batches call the GM's query handler directly with other users as senders; this
 * script covers what they can't: the query transport itself, and that the sender the GM's client
 * sees is the user the server reports, whatever the request claims.
 *
 * Three sessions join world "cp-tests": the Gamemaster and its two Player users. The players send
 * contest requests the way the cards do (sendContestRequest), and the checks read the stored
 * message on the GM's and the players' clients. The one contest message it creates is deleted again.
 *
 * Assumes dev Foundry is already running at http://localhost:30000 with "cp-tests" launched, as
 * scripts/run-quench.mjs does, and that the core "query users" permission is on for players (the
 * Foundry default).
 *
 * Usage:   node scripts/run-quench-players.mjs
 * Passwords (only for users that have one): CP_TESTS_GM_PASSWORD, CP_TESTS_PLAYER1_PASSWORD and
 * CP_TESTS_PLAYER2_PASSWORD in the environment. Never pass them on the command line or store them
 * in a file.
 */

import { chromium } from "playwright-core";

import { TIMEOUT_MS, fail, joinWorld } from "./foundry-session.mjs";

const RELAY_MODULE = "/systems/cortex-prime/module/contest/relay.mjs";
const GM_NAME = "Gamemaster";
const PLAYER_NAMES = ["Test Player 1", "Test Player 2"];

/** @type {{name: string, ok: boolean, detail: string}[]} */
const checks = [];

/**
 * Records one check and prints it.
 * @param {string} name
 * @param {boolean} ok
 * @param {unknown} [detail] - shown when the check fails
 */
function check(name, ok, detail) {
  const text = ok ? "" : JSON.stringify(detail);
  checks.push({ name, ok, detail: text });
  console.log(`${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : `\n      got ${text}`}`);
}

/**
 * Sends a contest request from a session, through the same function the cards use.
 * @param {import("playwright-core").Page} page
 * @param {object} request
 * @returns {Promise<{ok: boolean, code?: string, value?: object}>}
 */
function send(page, request) {
  return page.evaluate(async ([path, data]) => {
    const { sendContestRequest } = await import(path);
    return sendContestRequest(data);
  }, [RELAY_MODULE, request]);
}

/**
 * The stored contest message as a session sees it, or null when it has none with that id.
 * @param {import("playwright-core").Page} page
 * @param {string} messageId
 * @returns {Promise<{authorId: string, system: object}|null>}
 */
function stored(page, messageId) {
  return page.evaluate(id => {
    const message = game.messages.get(id);
    return message ? { authorId: message.author?.id ?? null, system: message.system.toObject() } : null;
  }, messageId);
}

/**
 * Waits until a session sees the message at a revision, so a check never races the socket.
 * @param {import("playwright-core").Page} page
 * @param {string} messageId
 * @param {number} revision
 */
async function seesRevision(page, messageId, revision) {
  return page.waitForFunction(
    ([id, wanted]) => game.messages.get(id)?.system?.revision === wanted, [messageId, revision], { timeout: TIMEOUT_MS }
  ).then(() => true, () => false);
}

async function main() {
  const browser = await chromium.launch({ channel: "msedge" });
  let gm = null;
  let messageId = null;
  try {
    gm = await joinWorld(browser, { userName: GM_NAME, password: process.env.CP_TESTS_GM_PASSWORD ?? "" });
    const p1 = await joinWorld(browser, { userName: PLAYER_NAMES[0], password: process.env.CP_TESTS_PLAYER1_PASSWORD ?? "" });
    const p2 = await joinWorld(browser, { userName: PLAYER_NAMES[1], password: process.env.CP_TESTS_PLAYER2_PASSWORD ?? "" });

    const [gmId, p1Id, p2Id] = await Promise.all([gm, p1, p2].map(page => page.evaluate(() => game.user.id)));
    for ( const page of [p1, p2] ) {
      await page.waitForFunction(id => game.users.activeGM?.id === id, gmId, { timeout: TIMEOUT_MS })
        .catch(() => fail("A player session never saw the Gamemaster as the active GM."));
      const facts = await page.evaluate(() => ({ isGM: game.user.isGM, mayQuery: game.user.hasPermission("QUERY_USER") }));
      if ( facts.isGM ) fail("A player session joined as a GM user.");
      if ( !facts.mayQuery ) {
        fail('Players lack the core "query users" permission in this world, so no contest action can be sent.');
      }
    }
    console.log("Three sessions ready.\n");

    // Starting: the message is the GM's, and its starter is the player the server reports.
    const sides = [
      { key: "initiator", userId: p1Id, actorUuid: null, label: "Player 1 (players smoke)" },
      { key: "opposition", userId: p2Id, actorUuid: null, label: "Player 2 (players smoke)" }
    ];
    const started = await send(p1, { action: "start", type: "contest", sides });
    check("player 1 starts a contest over the query", started.ok === true, started);
    if ( !started.ok ) return;
    messageId = started.value.messageId;

    let seen = await stored(gm, messageId);
    check("the GM wrote the message, and its starter is player 1",
      (seen?.authorId === gmId) && (seen?.system.startedBy === p1Id), seen && { authorId: seen.authorId, startedBy: seen.system.startedBy });
    check("both players see the new message", (await seesRevision(p1, messageId, 0)) && (await seesRevision(p2, messageId, 0)));

    // A roll keeps its real sender.
    const first = await send(p1, { action: "add-roll", messageId, revision: 0, payload: { side: "initiator", total: 11, effectSizes: [8] } });
    check("player 1 enters a total for their side", first.ok === true, first);
    seen = await stored(gm, messageId);
    check("the stored roll names player 1 as its user", seen?.system.flow.rolls?.[0]?.userId === p1Id, seen?.system.flow.rolls);
    check("player 2 sees the write", await seesRevision(p2, messageId, 1));

    // The sender is the session's user, not what a request says.
    const forOther = await send(p1, { action: "add-roll", messageId, revision: 1, payload: { side: "opposition", total: 30, effectSizes: [12] } });
    check("player 1 can't roll for player 2's side", forOther.code === "NOT_YOUR_SIDE", forOther);
    const stale = await send(p2, { action: "add-roll", messageId, revision: 0, payload: { side: "opposition", total: 14, effectSizes: [6] } });
    check("a request against an old revision is refused", stale.code === "STALE_REVISION", stale);
    const gmOnly = await send(p1, { action: "set-high-stakes", messageId, revision: 1, payload: { highStakes: true } });
    check("a player can't set high stakes", gmOnly.code === "GM_ONLY", gmOnly);
    seen = await stored(gm, messageId);
    check("the refusals wrote nothing", (seen?.system.revision === 1) && (seen?.system.flow.rolls?.length === 1), seen?.system);

    const second = await send(p2, { action: "add-roll", messageId, revision: 1, payload: { side: "opposition", total: 14, effectSizes: [6] } });
    check("player 2 enters a total for their side", second.ok === true, second);
    seen = await stored(gm, messageId);
    check("the stored roll names player 2 as its user", seen?.system.flow.rolls?.[1]?.userId === p2Id, seen?.system.flow.rolls);
    check("player 1 sees the write", await seesRevision(p1, messageId, 2));

    const givenIn = await send(p1, { action: "give-in", messageId, revision: 2, payload: { side: "initiator" } });
    check("player 1 gives in", givenIn.ok === true, givenIn);

    // Clean up while there is a GM, then check what a player gets without one.
    await gm.evaluate(id => game.messages.get(id)?.delete(), messageId);
    messageId = null;
    await gm.context().close();
    gm = null;
    await p1.waitForFunction(() => !game.users.activeGM, null, { timeout: TIMEOUT_MS })
      .catch(() => fail("Player 1's session still saw an active GM after the Gamemaster left."));
    const noGm = await send(p1, { action: "start", type: "contest", sides });
    check("without an active GM a request is refused before sending", noGm.code === "GM_REQUIRED", noGm);
  } finally {
    if ( gm && messageId ) await gm.evaluate(id => game.messages.get(id)?.delete(), messageId).catch(() => {});
    await browser.close();
  }
}

main().then(() => {
  const failed = checks.filter(c => !c.ok).length;
  console.log(`\n${checks.length - failed} passed, ${failed} failed (${checks.length} total)`);
  if ( failed || !checks.length ) process.exitCode = 1;
}).catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
