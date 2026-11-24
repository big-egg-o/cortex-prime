/**
 * Plot point bookkeeping (Plot Points spec, revised draft; Rules Questions RQ-036 and RQ-037;
 * provisional project decisions P5 and P7). This first part holds the reason codes, a single
 * change of a balance, and the start of a session. The roll, contest and test functions of the
 * spec follow in later steps.
 *
 * Every function returns an EngineResult (ADR-025), stops at the first failing check in the order
 * its JSDoc gives, never changes its inputs and returns no object shared with them.
 * @module rules/plot-points
 */

import { fail, ok } from "./result.mjs";

/**
 * Every reason a balance can change, mapped to its direction. Other specs (Assets & Complications)
 * add their own reasons; HITCH_COMPLICATION is here because the timing rule depends on it.
 * @type {Readonly<Record<string, "gain"|"spend"|"adjust">>}
 */
export const PP_REASONS = Object.freeze({
  HINDER: "gain",
  D4_COMPLICATION: "gain",
  SFX_GAIN: "gain",
  HITCH_COMPLICATION: "gain",
  GIVE_IN: "gain",
  AWARD: "gain",
  SESSION_START: "gain",
  EXTRA_TRAIT: "spend",
  EXTRA_RESULT: "spend",
  EXTRA_EFFECT_DIE: "spend",
  SFX_SPEND: "spend",
  STAY_IN: "spend",
  GM_ADJUST: "adjust"
});

/** @returns {boolean} whether value is a plain object, not an array, class instance or null */
function isPlainObject(value) {
  if ( (value === null) || (typeof value !== "object") ) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype) || (proto === null);
}

/**
 * @param {unknown} value
 * @param {number} min
 * @returns {boolean} whether value is a whole number of at least min (a number, not a string)
 */
function isWholeFrom(value, min) {
  return Number.isInteger(value) && (value >= min);
}

/** @returns {boolean} whether value is a non-empty string */
function isNonEmptyString(value) {
  return (typeof value === "string") && (value.length > 0);
}

/**
 * One change of a balance outside a roll's settlement: an award, giving in, staying in, a gain
 * from another spec after a roll was settled, or a GM adjustment. The caller records the reason.
 * A balance never goes below zero (P5; spends are limited by what the payer holds).
 *
 * Check order: (1) the balance is a whole number from 0, else INVALID_PP_AMOUNT; (2) the change is
 * a whole number other than 0, else INVALID_PP_AMOUNT; (3) the new balance would be below 0,
 * PP_INSUFFICIENT.
 * @param {number} balance - the stored balance of the player or the bank
 * @param {number} delta - positive for a gain, negative for a spend
 * @returns {import("./types.mjs").EngineResult<{balance: number}>}
 */
export function changeBalance(balance, delta) {
  if ( !isWholeFrom(balance, 0) ) return fail("INVALID_PP_AMOUNT");
  if ( !Number.isInteger(delta) || (delta === 0) ) return fail("INVALID_PP_AMOUNT");
  if ( balance + delta < 0 ) return fail("PP_INSUFFICIENT");
  return ok({ balance: balance + delta });
}

/**
 * The start of a session (rules 2 and 3). Each listed character below one PP is raised to one and
 * nobody else gains (RQ-036). The bank keeps what it holds and gains one PP per player (RQ-037).
 * Who counts as a player, and which characters are listed, is the caller's choice (P7); the two
 * are passed separately. The caller records a SESSION_START entry for every gain above 0.
 *
 * Check order: (1) players is an array of plain objects with distinct non-empty string actorIds,
 * else INVALID_PP_INPUT; (2) each balance is a whole number from 0, else INVALID_PP_AMOUNT; (3) so
 * is the bank, else INVALID_PP_AMOUNT; (4) playerCount is a whole number from 0, else
 * INVALID_PP_INPUT.
 * @param {object} input
 * @param {{actorId: string, balance: number}[]} input.players - the characters whose balances start
 *   the session, in the order the result keeps
 * @param {number} input.bank - what the bank holds before the session starts
 * @param {number} input.playerCount - the number of players the bank is paid for
 * @returns {import("./types.mjs").EngineResult<{
 *   players: {actorId: string, balance: number, gained: number}[], bank: number, bankGained: number
 * }>}
 */
export function startSession(input) {
  if ( !isPlainObject(input) || !Array.isArray(input.players) ) return fail("INVALID_PP_INPUT");
  const { players, bank, playerCount } = input;
  const seen = new Set();
  for ( const player of players ) {
    if ( !isPlainObject(player) || !isNonEmptyString(player.actorId) || seen.has(player.actorId) ) {
      return fail("INVALID_PP_INPUT");
    }
    seen.add(player.actorId);
  }
  if ( !players.every(player => isWholeFrom(player.balance, 0)) ) return fail("INVALID_PP_AMOUNT");
  if ( !isWholeFrom(bank, 0) ) return fail("INVALID_PP_AMOUNT");
  if ( !isWholeFrom(playerCount, 0) ) return fail("INVALID_PP_INPUT");

  return ok({
    players: players.map(({ actorId, balance }) => {
      const raised = Math.max(balance, 1);
      return { actorId, balance: raised, gained: raised - balance };
    }),
    bank: bank + playerCount,
    bankGained: playerCount
  });
}
