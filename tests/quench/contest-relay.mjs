/**
 * Quench batch "cortex-prime.contest-relay": the GM side of contest actions (Decisions ADR-027,
 * Step 4.4 S2). Run as the active GM in `cp-tests`, which needs two Player users (ADR-027 tests);
 * the batch calls the query handler with those users as senders, the way Foundry passes the
 * querying user, and never logs them in. Real player sessions are the separate smoke script.
 * @module tests/quench/contest-relay
 */

import { CONTEST_QUERY, handleContestQuery, sendContestRequest } from "../../module/contest/relay.mjs";
import { initialSystem } from "../../module/data/chat/contest-mapping.mjs";
import { createContest } from "../../module/rules/index.mjs";

/**
 * @param {object} quench  The Quench API object passed to the `quenchReady` hook.
 */
export function registerContestRelayBatch(quench) {
  quench.registerBatch(
    "cortex-prime.contest-relay",
    ({ it, assert, before, afterEach }) => {
      const tracked = [];
      let p1;
      let p2;
      before(() => {
        [p1, p2] = game.users.filter(u => !u.isGM);
      });
      afterEach(async () => {
        const ids = tracked.splice(0).map(m => m.id).filter(id => game.messages.has(id));
        if ( ids.length ) await ChatMessage.implementation.deleteDocuments(ids);
      });

      /** A contest between p1 (initiator) and the GM's side, created by this GM. */
      async function contest() {
        const state = createContest().value;
        const sides = [
          { key: "initiator", userId: p1.id, actorUuid: null, label: "P1" },
          { key: "opposition", userId: null, actorUuid: null, label: "GM" }
        ];
        const system = initialSystem({ type: "contest", state, startedBy: game.user.id, sides }).value;
        const message = await ChatMessage.implementation.create({ type: "contest", system });
        tracked.push(message);
        return message;
      }

      /** Skips a test when cp-tests lacks the two Player users it needs. */
      function needPlayers(test) {
        if ( !p1 || !p2 ) test.skip();
      }

      it("is registered as a user query and handled on this, the active GM's, client", () => {
        assert.equal(CONFIG.queries[CONTEST_QUERY], handleContestQuery);
        assert.equal(game.users.activeGM, game.user);
      });

      it("adds a typed roll for the initiator's user, raising the revision and keeping the sender", async function() {
        needPlayers(this);
        const message = await contest();
        const result = await handleContestQuery(
          { action: "add-roll", messageId: message.id, revision: 0, payload: { total: 11 } }, { user: p1 }
        );
        assert.isTrue(result.ok, result.code);
        const stored = message.system.toObject();
        assert.equal(stored.revision, 1);
        assert.equal(stored.flow.rolls.length, 1);
        assert.equal(stored.flow.rolls[0].userId, p1.id);
        assert.equal(stored.flow.rolls[0].total, 11);
      });

      it("refuses a player who acts for the other side, and writes nothing", async function() {
        needPlayers(this);
        const message = await contest();
        const result = await handleContestQuery(
          { action: "add-roll", messageId: message.id, revision: 0, payload: { total: 11 } }, { user: p2 }
        );
        assert.deepEqual(result, { ok: false, code: "NOT_YOUR_SIDE" });
        assert.equal(message.system.revision, 0);
      });

      it("refuses a stale revision, and handles two requests for one message one after the other", async function() {
        needPlayers(this);
        const message = await contest();
        const request = { action: "add-roll", messageId: message.id, revision: 0, payload: { total: 11 } };
        const [first, second] = await Promise.all([
          handleContestQuery(request, { user: p1 }), handleContestQuery(request, { user: p1 })
        ]);
        assert.isTrue(first.ok);
        assert.deepEqual(second, { ok: false, code: "STALE_REVISION" });
        assert.equal(message.system.flow.rolls.length, 1);
      });

      it("keeps high stakes and closing for a GM", async function() {
        needPlayers(this);
        const message = await contest();
        const byPlayer = await handleContestQuery(
          { action: "set-high-stakes", messageId: message.id, revision: 0, payload: { highStakes: true } }, { user: p1 }
        );
        assert.deepEqual(byPlayer, { ok: false, code: "GM_ONLY" });
        const byGM = await sendContestRequest({ action: "set-high-stakes", messageId: message.id, revision: 0, payload: { highStakes: true } });
        assert.isTrue(byGM.ok, byGM.code);
        assert.isTrue(message.system.flow.highStakes);
      });

      it("answers a request for a message that isn't a contest", async () => {
        const result = await handleContestQuery({ action: "close", messageId: "missingMessage01", revision: 0, payload: {} }, { user: game.user });
        assert.deepEqual(result, { ok: false, code: "CONTEST_NOT_FOUND" });
      });
    },
    { displayName: "Cortex Prime: contest relay" }
  );
}
