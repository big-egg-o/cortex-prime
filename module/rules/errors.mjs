/**
 * Coded errors for engine functions that throw (Decisions ADR-025: the existing functions keep
 * throwing; a refusal that callers need to tell apart carries an upper-case code).
 * @module rules/errors
 */

/**
 * An Error with a readable message and an upper-case `code`. Callers and tests check the code,
 * never the message.
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
export function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}
