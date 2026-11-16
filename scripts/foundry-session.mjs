/**
 * Joins the already-running dev Foundry world "cp-tests" as one of its users, for the command-line
 * test scripts (Decisions ADR-005 fallback: Playwright driving dev Foundry).
 *
 * Nothing here opens or submits anything on /setup, and nothing launches or changes a world: a
 * session joins the world a person launched, the same way that person would.
 * @module scripts/foundry-session
 */

export const BASE_URL = "http://localhost:30000";
export const TIMEOUT_MS = 60_000;
export const WORLD_ID = "cp-tests";
const WORLD_TITLE = "CP Tests"; // the join page's <title>, before login exposes anything else

/** @param {string} message @returns {never} */
export function fail(message) {
  throw new Error(message);
}

/**
 * Opens a page in its own browser context (its own cookies, so its own Foundry session), joins
 * "cp-tests" as the named user and waits for `game.ready`.
 * @param {import("playwright-core").Browser} browser
 * @param {{userName: string, password?: string, onConsole?: (text: string) => void}} options
 *   `password` only if the user has one; it comes from the environment, never from a file.
 * @returns {Promise<import("playwright-core").Page>}
 */
export async function joinWorld(browser, { userName, password = "", onConsole }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  if ( onConsole ) page.on("console", msg => onConsole(msg.text()));

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  // The join form is injected by Foundry's own client script after domcontentloaded, not
  // present in the initial HTML, so this has to wait for it rather than check right away.
  const usernameSelect = page.locator("#join-username");
  await usernameSelect.waitFor({ timeout: TIMEOUT_MS }).catch(() => fail(
    `No join page appeared at ${BASE_URL} within ${TIMEOUT_MS}ms. This script never uses /setup, ` +
    `so start dev Foundry (npm run foundry) and launch world "${WORLD_ID}" yourself first, then run this again.`
  ));

  // Before logging in at all: the join page's title is the only thing it exposes about
  // which world is active, so check it names world "cp-tests" and refuse otherwise —
  // never join, let alone run anything, against some other world.
  const title = await page.title();
  if ( title !== WORLD_TITLE ) {
    fail(`The active world is "${title}", not "${WORLD_TITLE}" (world id "${WORLD_ID}"). This ` +
      `script never launches or switches worlds — launch "${WORLD_ID}" yourself, then run this again.`);
  }

  const option = usernameSelect.locator("option", { hasText: userName });
  if ( (await option.count()) === 0 ) {
    fail(`No "${userName}" user on the join page for world "${title}".`);
  }
  await usernameSelect.selectOption({ label: userName });
  if ( password ) await page.locator("#join-password").fill(password);
  console.log(`Joining world "${title}" as ${userName} ...`);
  await page.locator('form[name="join"] button[name="join"]').click();

  await page.waitForFunction(() => window.game?.ready === true, null, { timeout: TIMEOUT_MS })
    .catch(() => fail(`Joined as ${userName}, but game.ready never became true in world "${title}".`));

  // Belt and suspenders: confirm the real world id post-login too, in case a world's
  // display title and id ever drift apart. Still before anything else runs.
  const worldId = await page.evaluate(() => window.game?.world?.id);
  if ( worldId !== WORLD_ID ) {
    fail(`Joined, but game.world.id is "${worldId}", not "${WORLD_ID}". Refusing to go on.`);
  }
  return page;
}
