/**
 * Builders for EngineResult, the return value of new engine functions (Decisions ADR-025):
 * `{ ok: true, value }`, or `{ ok: false, code }` naming the first check that failed. Older
 * functions keep throwing (see errors.mjs), and validateSelection keeps `{ valid, errors }`.
 * @module rules/result
 */

/**
 * @template T
 * @param {T} value
 * @returns {{ok: true, value: T}}
 */
export function ok(value) {
  return { ok: true, value };
}

/**
 * @param {string} code - an upper-case code; the UI turns it into a language string
 * @returns {{ok: false, code: string}}
 */
export function fail(code) {
  return { ok: false, code };
}
