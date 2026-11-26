/**
 * Export and import of a game configuration as a file (M5, draft "M5 mod switch and configuration
 * import/export", MS-D5 and MS-D6). The file wraps the configuration with a format marker and the
 * system version it came from. Importing checks the marker, then runs the same validation as the
 * configuration app, so errors block and warnings allow saving (ADR-041). Pure: no Foundry.
 * @module rules/config-export
 */

import { validateGameConfig } from "./game-config.mjs";

/** The marker an exported configuration file carries. */
export const CONFIG_EXPORT_FORMAT = "cortex-prime.gameConfig";

/** @returns {boolean} whether value is an object that isn't an array */
function isPlainObject(value) {
  return (value !== null) && (typeof value === "object") && !Array.isArray(value);
}

/**
 * The text of an export file for a configuration.
 * @param {import("./types.mjs").GameConfig} config
 * @param {string} systemVersion - the system's version, recorded as `exportedFrom`
 * @returns {string} JSON, indented for reading
 * @throws {Error} with the validation code when the configuration isn't valid, since a file that
 *   can't be imported again is no use
 */
export function buildConfigExport(config, systemVersion) {
  const checked = validateGameConfig(config);
  if ( !checked.ok ) throw new Error(checked.code);
  return JSON.stringify({ format: CONFIG_EXPORT_FORMAT, exportedFrom: String(systemVersion), config: checked.value },
    null, 2);
}

/**
 * Read an export file's text.
 * @param {unknown} text
 * @returns {{ok: true, value: import("./types.mjs").GameConfig, errors: [],
 *   warnings: {code: string, path: string}[]}
 *   | {ok: false, code: string, errors: {code: string, path: string}[],
 *   warnings: {code: string, path: string}[]}} EXPORT_NOT_JSON or EXPORT_WRONG_FORMAT with no
 *   errors listed, otherwise what validateGameConfig reports for the wrapped configuration
 */
export function parseConfigExport(text) {
  const refuse = code => ({ ok: false, code, errors: [], warnings: [] });
  if ( typeof text !== "string" ) return refuse("EXPORT_NOT_JSON");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return refuse("EXPORT_NOT_JSON");
  }
  if ( !isPlainObject(data) || (data.format !== CONFIG_EXPORT_FORMAT) || !("config" in data) ) {
    return refuse("EXPORT_WRONG_FORMAT");
  }
  return validateGameConfig(data.config);
}
