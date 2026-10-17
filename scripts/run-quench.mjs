/**
 * Runs Cortex Prime's Quench batches from the command line (Decisions ADR-005 fallback:
 * Playwright driving dev Foundry).
 *
 * Assumes dev Foundry is already running at http://localhost:30000 with world "cp-tests"
 * already launched (`npm run foundry`, then launch the world once in the browser). This
 * script never opens or submits anything on /setup and never launches or changes a world —
 * it only joins the already-running session as the Gamemaster, the same way a person would.
 *
 * Uses the system-installed Microsoft Edge via Playwright's "msedge" channel, so no browser
 * download is needed (no `playwright install`).
 *
 * Usage:   node scripts/run-quench.mjs [pattern]
 *   pattern   a quench.runBatches() glob, default "cortex-prime.**"
 * Password (only if the Gamemaster user has one): set CP_TESTS_GM_PASSWORD in the
 * environment. Never pass it on the command line or store it in a file.
 */

import { chromium } from "playwright-core";

const BASE_URL = "http://localhost:30000";
const DEFAULT_PATTERN = "cortex-prime.**";
const TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 10 * 60_000; // batches do real document create/update/delete round trips
const WORLD_ID = "cp-tests";
const WORLD_TITLE = "CP Tests"; // the join page's <title>, before login exposes anything else

/** @param {string} message @returns {never} */
function fail(message) {
  throw new Error(message);
}

async function main() {
  const pattern = process.argv[2] ?? DEFAULT_PATTERN;
  const password = process.env.CP_TESTS_GM_PASSWORD ?? "";

  const browser = await chromium.launch({ channel: "msedge" });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);
    page.on("console", msg => {
      if ( msg.text().startsWith("[quench] ") ) console.log(msg.text());
    });

    console.log(`Opening ${BASE_URL} ...`);
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

    // The join form is injected by Foundry's own client script after domcontentloaded, not
    // present in the initial HTML, so this has to wait for it rather than check right away.
    const usernameSelect = page.locator("#join-username");
    await usernameSelect.waitFor({ timeout: TIMEOUT_MS }).catch(() => fail(
      `No join page appeared at ${BASE_URL} within ${TIMEOUT_MS}ms. This script never uses /setup, ` +
      `so start dev Foundry (npm run foundry) and launch world "cp-tests" yourself first, then run this again.`
    ));

    // Before logging in at all: the join page's title is the only thing it exposes about
    // which world is active, so check it names world "cp-tests" and refuse otherwise —
    // never join, let alone run anything, against some other world.
    const title = await page.title();
    if ( title !== WORLD_TITLE ) {
      fail(`The active world is "${title}", not "${WORLD_TITLE}" (world id "${WORLD_ID}"). This ` +
        `script never launches or switches worlds — launch "${WORLD_ID}" yourself, then run this again.`);
    }

    const gmOption = usernameSelect.locator("option", { hasText: "Gamemaster" });
    if ( (await gmOption.count()) === 0 ) {
      fail(`No "Gamemaster" user on the join page for world "${title}".`);
    }
    await usernameSelect.selectOption({ label: "Gamemaster" });
    if ( password ) await page.locator("#join-password").fill(password);
    console.log(`Joining world "${title}" as Gamemaster ...`);
    await page.locator('form[name="join"] button[name="join"]').click();

    await page.waitForFunction(() => window.game?.ready === true, null, { timeout: TIMEOUT_MS })
      .catch(() => fail(`Joined, but game.ready never became true in world "${title}".`));
    console.log("game.ready.");

    // Belt and suspenders: confirm the real world id post-login too, in case a world's
    // display title and id ever drift apart. Still before any batch runs.
    const worldId = await page.evaluate(() => window.game?.world?.id);
    if ( worldId !== WORLD_ID ) {
      fail(`Joined, but game.world.id is "${worldId}", not "${WORLD_ID}". Refusing to run any batches.`);
    }

    await page.waitForFunction(
      () => window.quench?._testBatches?.has("cortex-prime.smoke") === true, null, { timeout: TIMEOUT_MS }
    ).catch(() => fail(
      `game.ready, but Quench never registered "cortex-prime.smoke" in world "${WORLD_ID}". Is the ` +
      "Quench module active?"
    ));
    console.log(`Quench ready. Running batches matching "${pattern}" (up to ${RUN_TIMEOUT_MS / 1000}s) ...`);

    const runPromise = page.evaluate(async runPattern => {
      // Quench's reporter calls methods on quench.app (its results window) that assume it has
      // been rendered (e.g. handleRunBegin() does this.element.querySelector(...) unconditionally);
      // without this, the very first such call throws and the whole run dies silently (no
      // further suite/test events, no quenchReports hook — just stuck). The window never has
      // to be visible for this; rendering it once is enough to give it a real `element`.
      if ( !quench.app.rendered ) await quench.app.render({ force: true });

      const reported = new Promise(resolve => {
        Hooks.once("quenchReports", data => resolve(JSON.parse(data.json)));
      });
      const runner = await quench.runBatches(runPattern);
      const { EVENT_TEST_BEGIN, EVENT_TEST_END } = Mocha.Runner.constants;
      runner?.on(EVENT_TEST_BEGIN, test => console.log(`[quench] BEGIN ${test.fullTitle()}`));
      runner?.on(EVENT_TEST_END, test => console.log(`[quench] END   ${test.fullTitle()}`));
      return reported;
    }, pattern);
    // A bare setTimeout here would keep Node's event loop alive for the losing side of the
    // race for the rest of RUN_TIMEOUT_MS even after runPromise wins, so the timer is always
    // cleared once the race is decided either way.
    let timer;
    const timeoutPromise = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(
        `Quench didn't finish "${pattern}" within ${RUN_TIMEOUT_MS / 1000}s. Check the dev Foundry ` +
        "console/logs for a stuck or crashed test."
      )), RUN_TIMEOUT_MS);
    });
    const result = await Promise.race([runPromise, timeoutPromise]).finally(() => clearTimeout(timer));

    const failed = printSummary(result);
    if ( failed ) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

/**
 * Prints one line per test and a totals line.
 * @param {{stats: object, tests: {title: string, fullTitle: string, err: object}[]}} result
 * @returns {boolean} true if anything failed
 */
function printSummary(result) {
  const { stats, tests } = result;
  let anyFailed = false;

  for ( const test of tests ) {
    const failed = Boolean(test.err?.message);
    if ( failed ) anyFailed = true;
    const batchMatch = /(\S+)_root\b/.exec(test.fullTitle);
    const batch = batchMatch ? batchMatch[1] : "(unknown batch)";
    console.log(`${failed ? "FAIL" : "pass"}  ${batch}  ${test.title}`);
    if ( failed ) console.log(`      ${test.err.message}`);
  }

  console.log(`\n${stats.passes} passed, ${stats.failures} failed, ${stats.pending} pending (${stats.tests} total)`);
  return anyFailed || (stats.failures > 0);
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
