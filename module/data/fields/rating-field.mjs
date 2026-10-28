/**
 * Schema field for a stored trait rating: a list of die sizes (Decisions ADR-033). It checks
 * only the die sizes, which never depend on the game configuration, so a configuration change
 * can't make stored data invalid. Whether a set needs dice of one size (TS-E02) is not checked
 * here. It is a standard Foundry field, so Foundry's cleaning normalises some malformed input
 * (for example "8" or ["8"] becomes [8], null becomes []). DataModel#updateSource with an invalid
 * die size ignores the change without an error and keeps the previous rating; that is the
 * behaviour tested, and Actor.update() has not been verified. Strict input checking is the job
 * of the pure validateRating in module/rules/traits.mjs.
 * @module data/fields/rating-field
 */

import { DIE_SIZES } from "../../rules/types.mjs";

const { ArrayField, NumberField } = foundry.data.fields;

/**
 * A new rating field: an array of die sizes, empty by default (a trait with no die, ADR-033).
 * `integer` is left off on purpose: NumberField rounds integer fields while cleaning, which
 * would store 7.6 as a d8 instead of refusing it. `choices` already admits only whole numbers.
 * @returns {import("../../../reference/foundry-14.369/common/data/fields.mjs").ArrayField}
 */
export function ratingField() {
  return new ArrayField(new NumberField({ required: true, nullable: false, choices: DIE_SIZES }));
}
