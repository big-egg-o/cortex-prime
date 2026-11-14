/**
 * System settings (Decisions ADR-030): the game configuration as one world setting.
 * @module config/settings
 */

import GameConfigData from "../data/settings/game-config.mjs";
import { defaultGameConfig, validateGameConfig } from "../rules/game-config.mjs";

/** The package id, as declared in system.json. */
const SYSTEM_ID = "cortex-prime";

/** The key of the game configuration setting. */
export const GAME_CONFIG_SETTING = "gameConfig";

/**
 * Registers the settings; called from the `init` hook. The game configuration is a world
 * setting, hidden from the core settings list: the GM configuration app edits it. ADR-030's "only
 * the GM" means a user for whom `isGM` is true, an Assistant GM included; Foundry's own check is
 * the "Modify configuration settings" permission (common/documents/setting.mjs), which an
 * Assistant has by default and a GM can grant further, and setGameConfig adds the isGM check.
 * A new world starts with the ADR-036 defaults, which the active GM stores once the game is
 * ready, so a later change to the defaults never changes an existing world.
 * @param {object} [options]
 * @param {() => void} [options.onGameConfigChange] - called on every client once a new game
 *   configuration is stored, for example to render open sheets again
 */
export function registerSettings({ onGameConfigChange } = {}) {
  game.settings.register(SYSTEM_ID, GAME_CONFIG_SETTING, {
    name: "CORTEX.Settings.GameConfig.Name",
    hint: "CORTEX.Settings.GameConfig.Hint",
    scope: "world",
    config: false,
    type: GameConfigData,
    default: defaultGameConfig(),
    onChange: () => onGameConfigChange?.()
  });
  Hooks.once("ready", storeDefaultGameConfig);
}

/**
 * Stores the defaults as the world's configuration when nothing is stored yet; only the active
 * GM does, so it happens once.
 * @returns {Promise<void>}
 */
async function storeDefaultGameConfig() {
  if ( game.user !== game.users.activeGM ) return;
  const stored = game.settings.storage.get("world").getSetting(`${SYSTEM_ID}.${GAME_CONFIG_SETTING}`);
  if ( stored ) return;
  await game.settings.set(SYSTEM_ID, GAME_CONFIG_SETTING, defaultGameConfig());
}

/**
 * Whether the stored configuration failed its checks when it was loaded; it is then used as
 * stored (GameConfigData.fromSource) and the GM's app shows its problems.
 * @returns {boolean}
 */
export function isGameConfigInvalid() {
  return game.settings.get(SYSTEM_ID, GAME_CONFIG_SETTING).invalid === true;
}

/**
 * The current game configuration as plain data, for the pure functions in module/rules/.
 * @returns {import("../rules/types.mjs").GameConfig}
 */
export function getGameConfig() {
  return game.settings.get(SYSTEM_ID, GAME_CONFIG_SETTING).toObject();
}

/**
 * Stores a new game configuration after the pure check, so the GM's form gets every problem
 * with its path instead of a thrown error. A configuration with warnings only is stored like any
 * other, and the warnings come back with the result (ADR-041 points 4 and 5). Refuses a user who
 * isn't a GM (GM_ONLY, before any check, so with no warnings), and reports a write Foundry
 * refuses (before the game is ready, without permission, or on the server) as WRITE_FAILED, with
 * the error in the console. The result has the shape of validateGameConfig's (ADR-042).
 * @param {import("../rules/types.mjs").GameConfig} config
 * @returns {Promise<{ok: true, value: import("../rules/types.mjs").GameConfig, errors: [],
 *   warnings: {code: string, path: string}[]}
 *   | {ok: false, code: string, errors: {code: string, path: string}[],
 *   warnings: {code: string, path: string}[]}>}
 */
export async function setGameConfig(config) {
  const refuse = (code, warnings = []) => ({ ok: false, code, errors: [{ code, path: "" }], warnings });
  if ( !game.user.isGM ) return refuse("GM_ONLY");
  const checked = validateGameConfig(config);
  if ( !checked.ok ) return checked;
  try {
    await game.settings.set(SYSTEM_ID, GAME_CONFIG_SETTING, checked.value);
  }
  catch( err ) {
    console.error(err);
    return refuse("WRITE_FAILED", checked.warnings);
  }
  return { ok: true, value: getGameConfig(), errors: [], warnings: checked.warnings };
}
