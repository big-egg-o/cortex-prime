/**
 * Traits and their ratings (Traits & Trait Sets spec). Every function here returns an
 * EngineResult instead of throwing (Decisions ADR-025).
 * @module rules/traits
 */

import { fail, ok } from "./result.mjs";
import { DIE_SIZES } from "./types.mjs";

/**
 * Checks a trait's rating: a list of die sizes (ADR-033), several for mobs, bosses, resources
 * and the like (rule 2), none for a trait with no die (rule 3). This is technical validation,
 * which ADR-029 keeps enforced: every entry must be a size on the step ladder (TS-E01), and a
 * set whose traits need dice of one size refuses a mix (TS-E02). Nothing is coerced, so a rating
 * that isn't an array, an entry that isn't one of the DIE_SIZES numbers, or an empty slot is
 * refused. A set's usual range is guidance for the sheet, not checked here (rule 9).
 * @param {unknown} dice
 * @param {{sameSizeDice?: boolean}} [options] - an object, or left out. `sameSizeDice: true`
 *   refuses mixed sizes; `false`, left out or `undefined` allows them.
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").DieSize[]>} a copy of the
 *   rating; refuses, checked in this order: INVALID_RATING_OPTIONS (options that aren't an
 *   object, or a sameSizeDice that isn't a boolean: a calling error, not a rule),
 *   INVALID_DIE_SIZE, RATING_MIXED_SIZES
 */
export function validateRating(dice, options = {}) {
  if ( (typeof options !== "object") || (options === null) || Array.isArray(options) ) {
    return fail("INVALID_RATING_OPTIONS");
  }
  const { sameSizeDice = false } = options;
  if ( typeof sameSizeDice !== "boolean" ) return fail("INVALID_RATING_OPTIONS");
  if ( !Array.isArray(dice) ) return fail("INVALID_DIE_SIZE");
  // An indexed loop, not some(), so an empty slot is checked rather than skipped.
  for ( let i = 0; i < dice.length; i++ ) {
    if ( !DIE_SIZES.includes(dice[i]) ) return fail("INVALID_DIE_SIZE");
  }
  if ( sameSizeDice && dice.some(size => size !== dice[0]) ) return fail("RATING_MIXED_SIZES");
  return ok([...dice]);
}
