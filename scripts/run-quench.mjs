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

import { TIMEOUT_MS, WORLD_ID, fail, joinWorld } from "./foundry-session.mjs";

const DEFAULT_PATTERN = "cortex-prime.**";
const RUN_TIMEOUT_MS = 10 * 60_000; // batches do real document create/update/delete round trips

async function main() {
  const pattern = process.argv[2] ?? DEFAULT_PATTERN;
  const password = process.env.CP_TESTS_GM_PASSWORD ?? "";

  const browser = await chromium.launch({ channel: "msedge" });
  try {
    const page = await joinWorld(browser, {
      userName: "Gamemaster",
      password,
      onConsole: text => { if ( text.startsWith("[quench] ") ) console.log(text); }
    });
    console.log("game.ready.");

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
