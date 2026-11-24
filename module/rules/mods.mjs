/**
 * The mod switch: which optional mods a world has turned on (M5, draft "M5 mod switch and
 * configuration import/export", MS-D1 to MS-D3). The switches live in the game configuration
 * under `mods`, so the one world setting stays the single source of truth (ADR-030). A missing
 * `mods`, or a missing entry, means the mod is off, so older configurations need no schema
 * version (MS-D2). Pure: no Foundry.
 * @module rules/mods
 */

/**
 * The mods the system knows. An id is added here only together with the spec and code of its
 * mod, so the configuration app never offers a switch that does nothing (MS-D3).
 * @type {readonly string[]}
 */
export const MOD_IDS = Object.freeze([]);

/** @returns {boolean} whether value is an object that isn't an array */
function isPlainObject(value) {
  return (value !== null) && (typeof value === "object") && !Array.isArray(value);
}

/**
 * Check a configuration's `mods` field. Reports UNKNOWN_MOD for an id that isn't known, and
 * INVALID_GAME_CONFIG for a field that isn't an object of `{enabled: boolean}` entries. An absent
 * field is fine (MS-D2).
 * @param {unknown} mods - the configuration's `mods`
 * @param {(code: string, path: string) => void} report
 * @param {readonly string[]} [modIds] - the known ids; tests pass their own
 */
export function checkMods(mods, report, modIds = MOD_IDS) {
  if ( mods === undefined ) return;
  if ( !isPlainObject(mods) ) {
    report("INVALID_GAME_CONFIG", "mods");
    return;
  }
  for ( const [id, entry] of Object.entries(mods) ) {
    const path = `mods.${id}`;
    if ( !modIds.includes(id) ) report("UNKNOWN_MOD", path);
    else if ( !isPlainObject(entry) ) report("INVALID_GAME_CONFIG", path);
    else if ( typeof entry.enabled !== "boolean" ) report("INVALID_GAME_CONFIG", `${path}.enabled`);
  }
}

/**
 * Whether a configuration has a mod turned on.
 * @param {{mods?: object}|undefined|null} config
 * @param {string} modId
 * @returns {boolean} false for a missing configuration, `mods` or entry
 */
export function modEnabled(config, modId) {
  const entry = isPlainObject(config?.mods) ? config.mods[modId] : undefined;
  return isPlainObject(entry) && (entry.enabled === true);
}
