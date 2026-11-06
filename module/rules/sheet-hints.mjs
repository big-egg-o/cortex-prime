/**
 * Hints the character sheet shows about stored traits (Traits & Trait Sets rule 9, Decisions
 * ADR-029 and ADR-037 point 5). A hint never stops a rating from being kept; only input that
 * can't be read is refused. Returns an EngineResult (ADR-025).
 * @module rules/sheet-hints
 */

import { fail, ok } from "./result.mjs";
import { ratingOptionsOf } from "./game-config.mjs";
import { validateRating } from "./traits.mjs";

/**
 * Hints for the sheet about a stored rating. RATING_CONFLICTS_WITH_SET: the rating no longer
 * fits its set's shape (for example the GM made the set one die per trait, or took its dice
 * away), so it is kept and shown (ADR-037 point 5). RATING_OUTSIDE_GUIDANCE: a die is below the
 * set's usual minimum or above its usual maximum (rule 9), which in-play rules such as a
 * challenged statement can legitimately cause (TS-E07); every die of a rating is checked, and a
 * set without dice gives no such hint, its trait giving no die. An empty rating, and a free trait
 * (no set), get no hint (ADR-037 Q1, TS-22).
 * @param {import("./types.mjs").TraitSetDef|null} set - null for a free trait
 * @param {unknown} dice
 * @returns {import("./types.mjs").EngineResult<string[]>} the hint codes, in that order;
 *   refuses INVALID_DIE_SIZE (a die size that doesn't exist) and INVALID_RATING_OPTIONS (a set
 *   whose shape options aren't booleans)
 */
export function ratingGuidance(set, dice) {
  const rating = validateRating(dice);
  if ( !rating.ok ) return rating;
  const hints = [];
  if ( (set === null) || (rating.value.length === 0) ) return ok(hints);
  if ( (typeof set !== "object") ) return fail("INVALID_RATING_OPTIONS");
  const shape = validateRating(rating.value, ratingOptionsOf(set));
  if ( !shape.ok && (shape.code === "INVALID_RATING_OPTIONS") ) return shape;
  if ( !shape.ok ) hints.push("RATING_CONFLICTS_WITH_SET");
  if ( !set.hasDice ) return ok(hints);
  const below = (set.usualMin !== null) && rating.value.some(size => size < set.usualMin);
  const above = (set.usualMax !== null) && rating.value.some(size => size > set.usualMax);
  if ( below || above ) hints.push("RATING_OUTSIDE_GUIDANCE");
  return ok(hints);
}
