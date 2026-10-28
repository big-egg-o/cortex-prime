/**
 * Quench batch "cortex-prime.rating": the rating schema field on its own, through a throwaway
 * DataModel, so no Actor type or game configuration is involved (Decisions ADR-033). It records
 * how Foundry 14.369's standard fields treat a rating:
 * - valid ratings are stored as given;
 * - a die size that doesn't exist is refused when a model is built strictly;
 * - malformed shapes are normalised by Foundry's cleaning before validation, so they are stored
 *   rather than refused. They are not approved input: strict input checking stays with the pure
 *   validateRating (module/rules/traits.mjs), which refuses every one of them;
 * - an updateSource with an invalid die size is ignored without an error, leaving the previous
 *   rating in place.
 * This is the schema half of TS-E01 only, not its Actor-level acceptance, and the field doesn't
 * enforce same-size dice (TS-E02).
 * @module tests/quench/rating-field
 */

import { ratingField } from "../../module/data/fields/rating-field.mjs";
import { validateRating } from "../../module/rules/traits.mjs";

/** A model holding one rating, so the field is tested the way any model would use it. */
class RatingModel extends foundry.abstract.DataModel {
  /** @override */
  static defineSchema() {
    return { dice: ratingField() };
  }
}

/**
 * A readable label for a test input. Called before the input reaches a model, because Foundry's
 * cleaning changes arrays and objects in place.
 * @param {*} value
 * @returns {string}
 */
function show(value) {
  if ( value instanceof Set ) return `Set(${JSON.stringify([...value])})`;
  return JSON.stringify(value) ?? String(value);
}

/**
 * Builds a RatingModel strictly, as world loading does, from a fresh input.
 * @param {() => *} makeDice - returns a new input each call, so no case sees a mutated one
 * @returns {{input: string, stored?: *, error?: Error}}
 */
function construct(makeDice) {
  const dice = makeDice();
  const input = show(dice);
  try {
    return { input, stored: RatingModel.fromSource({ dice }, { strict: true }).toObject().dice };
  } catch(error) {
    return { input, error };
  }
}

/** @returns {RatingModel} a model holding the rating [8] */
function modelWithD8() {
  return RatingModel.fromSource({ dice: [8] }, { strict: true });
}

/**
 * Inputs that Foundry's cleaning turns into a valid rating, with what it stores. Each is a
 * factory so every test gets an unmutated input.
 * @type {[() => *, number[]][]}
 */
const NORMALISED = [
  [() => ["8"], [8]],
  [() => "8", [8]],
  [() => 8, [8]],
  [() => ({ 0: 8 }), [8]],
  [() => ({ 0: 6, 1: 6 }), [6, 6]],
  [() => new Set([8]), [8]],
  [() => [[8]], [8]]
];

/**
 * Register the batch with Quench.
 * @param {object} quench
 */
export function registerRatingFieldBatch(quench) {
  quench.registerBatch(
    "cortex-prime.rating",
    ({ describe, it, assert }) => {

      describe("ratingField: construction", () => {
        it("stores no dice, one die, several dice of one size, and mixed sizes as given", () => {
          // [6, 8] is stored because same-size dice (TS-E02) are not this field's concern.
          for ( const dice of [[], [8], [6, 6, 6, 6], [6, 8]] ) {
            const result = construct(() => [...dice]);
            assert.isUndefined(result.error, `${result.input} should be accepted`);
            assert.deepEqual(result.stored, dice);
          }
        });

        it("starts empty when no rating is given", () => {
          assert.deepEqual(RatingModel.fromSource({}, { strict: true }).toObject().dice, []);
        });

        it("refuses die sizes that don't exist", () => {
          for ( const dice of [[7], [14], [8, 14], [0], [-8]] ) {
            const result = construct(() => [...dice]);
            assert.instanceOf(result.error, Error, `${result.input} should be refused`);
          }
        });

        it("refuses entries that don't clean to a die size", () => {
          // true casts to 1 and "abc" to NaN; 7.6 isn't rounded because the field has no `integer`.
          for ( const makeDice of [() => [null], () => [true], () => [7.6], () => ["abc"]] ) {
            const result = construct(makeDice);
            assert.instanceOf(result.error, Error, `${result.input} should be refused`);
          }
        });
      });

      describe("ratingField: normalisation by Foundry's cleaning (stored, not approved input)", () => {
        for ( const [makeDice, expected] of NORMALISED ) {
          it(`normalises ${show(makeDice())} to ${show(expected)}, which validateRating refuses`, () => {
            const result = construct(makeDice);
            assert.isUndefined(result.error, `${result.input} was refused, not normalised`);
            assert.deepEqual(result.stored, expected);
            assert.deepEqual(validateRating(makeDice()), { ok: false, code: "INVALID_DIE_SIZE" });
          });
        }

        it("normalises null to [] (a risk: an empty rating is sent as [], never null)", () => {
          const result = construct(() => null);
          assert.isUndefined(result.error);
          assert.deepEqual(result.stored, []);
          assert.deepEqual(validateRating(null), { ok: false, code: "INVALID_DIE_SIZE" });
        });
      });

      describe("ratingField: updateSource", () => {
        it("applies a valid rating", () => {
          const model = modelWithD8();
          assert.deepEqual(model.updateSource({ dice: [6, 6] }), { dice: [6, 6] });
          assert.deepEqual(model.toObject().dice, [6, 6]);
        });

        it("ignores a die size that doesn't exist without an error, keeping the previous rating", () => {
          for ( const dice of [[7], [14]] ) {
            const model = modelWithD8();
            let diff;
            assert.doesNotThrow(() => { diff = model.updateSource({ dice: [...dice] }); });
            assert.deepEqual(diff, {}, `${show(dice)} should leave an empty diff`);
            assert.deepEqual(model.toObject().dice, [8]);
            assert.isTrue(model.validate({ changes: { dice: [...dice] }, strict: false }),
              `a dry run reports ${show(dice)} as valid: no error is surfaced`);
          }
        });

        it("normalises a malformed rating the same way as construction", () => {
          for ( const makeDice of [() => ["6"], () => "6"] ) {
            const model = modelWithD8();
            const input = show(makeDice());
            assert.deepEqual(model.updateSource({ dice: makeDice() }), { dice: [6] }, input);
            assert.deepEqual(model.toObject().dice, [6], input);
          }
        });

        it("clears the rating to [] on a null update (a risk: an empty rating is sent as [], never null)", () => {
          const model = modelWithD8();
          assert.deepEqual(model.updateSource({ dice: null }), { dice: [] });
          assert.deepEqual(model.toObject().dice, []);
        });
      });
    },
    { displayName: "Cortex Prime: rating field" }
  );
}
