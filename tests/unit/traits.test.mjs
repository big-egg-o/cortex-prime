import { describe, expect, it } from "vitest";
import { validateRating } from "../../module/rules/traits.mjs";

const INVALID = { ok: false, code: "INVALID_DIE_SIZE" };
const MIXED = { ok: false, code: "RATING_MIXED_SIZES" };
const NO_DICE = { ok: false, code: "RATING_DICE_NOT_ALLOWED" };
const TOO_MANY = { ok: false, code: "RATING_TOO_MANY_DICE" };
const BAD_OPTIONS = { ok: false, code: "INVALID_RATING_OPTIONS" };

/** Every value an option may take, undefined meaning left out. */
const FLAGS = [true, false, undefined];

describe("validateRating", () => {
  it("accepts no dice, one die and several dice of one size (ADR-033)", () => {
    for ( const sameSizeDice of [true, false] ) {
      expect(validateRating([], { sameSizeDice })).toEqual({ ok: true, value: [] });
      expect(validateRating([8], { sameSizeDice })).toEqual({ ok: true, value: [8] });
      expect(validateRating([6, 6, 6, 6], { sameSizeDice })).toEqual({ ok: true, value: [6, 6, 6, 6] });
    }
  });

  it("accepts every size on the step ladder", () => {
    for ( const size of [4, 6, 8, 10, 12] ) {
      expect(validateRating([size], { sameSizeDice: true })).toEqual({ ok: true, value: [size] });
    }
    expect(validateRating([4, 6, 8, 10, 12], { sameSizeDice: false })).toEqual({ ok: true, value: [4, 6, 8, 10, 12] });
  });

  it("TS-E01 refuses a die size that doesn't exist", () => {
    for ( const sameSizeDice of [true, false] ) {
      expect(validateRating([7], { sameSizeDice })).toEqual(INVALID);
      expect(validateRating([14], { sameSizeDice })).toEqual(INVALID);
      expect(validateRating([8, 14], { sameSizeDice })).toEqual(INVALID);
      for ( const size of [0, 2, -8, 8.5, 20, 100] ) {
        expect(validateRating([size], { sameSizeDice })).toEqual(INVALID);
      }
    }
  });

  it("TS-E02 refuses mixed sizes when the set needs dice of one size", () => {
    expect(validateRating([6, 8], { sameSizeDice: true })).toEqual(MIXED);
    expect(validateRating([6, 6, 8], { sameSizeDice: true })).toEqual(MIXED);
  });

  it("accepts mixed sizes when the set allows them", () => {
    expect(validateRating([6, 8], { sameSizeDice: false })).toEqual({ ok: true, value: [6, 8] });
  });

  it("reports a die size that doesn't exist before mixed sizes", () => {
    expect(validateRating([6, 7], { sameSizeDice: true })).toEqual(INVALID);
  });

  it("only checks for mixed sizes when sameSizeDice is true", () => {
    expect(validateRating([6, 8])).toEqual({ ok: true, value: [6, 8] });
    expect(validateRating([6, 8], {})).toEqual({ ok: true, value: [6, 8] });
  });

  it("refuses a rating that isn't an array instead of coercing it", () => {
    for ( const bad of [undefined, null, 8, "8", "[8]", { 0: 8, length: 1 }, new Set([8]), Uint8Array.of(8)] ) {
      expect(validateRating(bad, { sameSizeDice: false })).toEqual(INVALID);
    }
  });

  it("refuses an entry that isn't a die size number instead of coercing it", () => {
    for ( const bad of ["8", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, true, [8], { size: 8 }, 8n] ) {
      expect(validateRating([bad], { sameSizeDice: false })).toEqual(INVALID);
      expect(validateRating([8, bad], { sameSizeDice: true })).toEqual(INVALID);
    }
  });

  it("refuses a rating with an empty slot", () => {
    const sparse = new Array(2);
    sparse[1] = 8;
    expect(validateRating(sparse, { sameSizeDice: false })).toEqual(INVALID);
  });

  it("works from a frozen rating and returns a new array", () => {
    const dice = Object.freeze([6, 6]);
    const result = validateRating(dice, { sameSizeDice: true });
    expect(result).toEqual({ ok: true, value: [6, 6] });
    expect(result.value).not.toBe(dice);
    expect(dice).toEqual([6, 6]);
  });
});

describe("validateRating set shape (ADR-037)", () => {
  it("accepts no dice in a set without dice", () => {
    expect(validateRating([], { hasDice: false })).toEqual({ ok: true, value: [] });
  });

  it("refuses any die in a set without dice", () => {
    for ( const dice of [[8], [4], [6, 6], [6, 8]] ) {
      expect(validateRating(dice, { hasDice: false })).toEqual(NO_DICE);
    }
  });

  it("accepts dice when hasDice is true or left out", () => {
    for ( const options of [{ hasDice: true }, {}, { hasDice: undefined }] ) {
      expect(validateRating([8], options)).toEqual({ ok: true, value: [8] });
      expect(validateRating([6, 6, 6, 6], options)).toEqual({ ok: true, value: [6, 6, 6, 6] });
      expect(validateRating([6, 8], options)).toEqual({ ok: true, value: [6, 8] });
    }
  });

  it("accepts no dice whatever the options say", () => {
    for ( const hasDice of FLAGS ) {
      for ( const multiDice of FLAGS ) {
        for ( const sameSizeDice of FLAGS ) {
          expect(validateRating([], { hasDice, multiDice, sameSizeDice })).toEqual({ ok: true, value: [] });
        }
      }
    }
  });

  it("accepts one die when multiDice is false", () => {
    for ( const size of [4, 6, 8, 10, 12] ) {
      expect(validateRating([size], { multiDice: false })).toEqual({ ok: true, value: [size] });
    }
  });

  it("refuses more than one die when multiDice is false", () => {
    for ( const dice of [[6, 6], [6, 6, 6, 6], [6, 8]] ) {
      expect(validateRating(dice, { multiDice: false })).toEqual(TOO_MANY);
    }
  });

  it("accepts several dice when multiDice is true or left out", () => {
    for ( const options of [{ multiDice: true }, {}, { multiDice: undefined }] ) {
      expect(validateRating([6, 6, 6, 6], options)).toEqual({ ok: true, value: [6, 6, 6, 6] });
      expect(validateRating([6, 8], options)).toEqual({ ok: true, value: [6, 8] });
    }
  });

  it("stores TS-07's [6, 6] when the set allows several dice, not when it allows one", () => {
    expect(validateRating([6, 6], { multiDice: true })).toEqual({ ok: true, value: [6, 6] });
    expect(validateRating([6, 6], { multiDice: false })).toEqual(TOO_MANY);
  });

  it("reports a die size that doesn't exist before the set's shape", () => {
    expect(validateRating([7], { hasDice: false })).toEqual(INVALID);
    expect(validateRating([7, 7], { multiDice: false })).toEqual(INVALID);
    expect(validateRating([6, 8, 7], { multiDice: false, sameSizeDice: true })).toEqual(INVALID);
    expect(validateRating([8, 14], { hasDice: false, multiDice: false, sameSizeDice: true })).toEqual(INVALID);
    expect(validateRating("8", { hasDice: false })).toEqual(INVALID);
    const sparse = new Array(2);
    sparse[1] = 8;
    expect(validateRating(sparse, { hasDice: false })).toEqual(INVALID);
    expect(validateRating(sparse, { multiDice: false })).toEqual(INVALID);
  });

  it("reports dice not allowed before too many dice and mixed sizes", () => {
    const options = { hasDice: false, multiDice: false, sameSizeDice: true };
    expect(validateRating([6, 8], options)).toEqual(NO_DICE);
    expect(validateRating([6, 6], options)).toEqual(NO_DICE);
  });

  it("reports too many dice before mixed sizes", () => {
    expect(validateRating([6, 8], { multiDice: false, sameSizeDice: true })).toEqual(TOO_MANY);
  });

  it("refuses mixed sizes when the set allows several dice of one size", () => {
    expect(validateRating([6, 8], { hasDice: true, multiDice: true, sameSizeDice: true })).toEqual(MIXED);
  });

  it("accepts one die when the set allows one die of one size", () => {
    expect(validateRating([8], { hasDice: true, multiDice: false, sameSizeDice: true })).toEqual({ ok: true, value: [8] });
  });

  it("decides on hasDice false alone, whatever multiDice and sameSizeDice say", () => {
    for ( const multiDice of FLAGS ) {
      for ( const sameSizeDice of FLAGS ) {
        const options = { hasDice: false, multiDice, sameSizeDice };
        expect(validateRating([], options)).toEqual({ ok: true, value: [] });
        expect(validateRating([8], options)).toEqual(NO_DICE);
        expect(validateRating([6, 8], options)).toEqual(NO_DICE);
      }
    }
  });

  it("treats left-out options like the values that allow", () => {
    const allowing = { hasDice: true, multiDice: true, sameSizeDice: false };
    for ( const dice of [[], [8], [6, 6, 6, 6], [6, 8], [4, 6, 8, 10, 12]] ) {
      const expected = { ok: true, value: dice };
      expect(validateRating(dice)).toEqual(expected);
      expect(validateRating(dice, {})).toEqual(expected);
      expect(validateRating(dice, allowing)).toEqual(expected);
    }
  });

  it("works from a frozen rating and frozen options and returns a new array", () => {
    const dice = Object.freeze([6, 6]);
    const result = validateRating(dice, Object.freeze({ hasDice: true, multiDice: true, sameSizeDice: true }));
    expect(result).toEqual({ ok: true, value: [6, 6] });
    expect(result.value).not.toBe(dice);
    const none = Object.freeze([]);
    const empty = validateRating(none, Object.freeze({ hasDice: false }));
    expect(empty).toEqual({ ok: true, value: [] });
    expect(empty.value).not.toBe(none);
  });
});

describe("validateRating options", () => {
  it("refuses options that aren't an object instead of throwing", () => {
    for ( const bad of [null, 8, "sameSizeDice", true, [], [true], () => true] ) {
      expect(validateRating([8], bad)).toEqual(BAD_OPTIONS);
    }
  });

  it("refuses a sameSizeDice that isn't a boolean instead of coercing it", () => {
    for ( const bad of ["true", "false", 1, 0, null, {}, [], Number.NaN] ) {
      expect(validateRating([8], { sameSizeDice: bad })).toEqual(BAD_OPTIONS);
      expect(validateRating([6, 8], { sameSizeDice: bad })).toEqual(BAD_OPTIONS);
    }
  });

  it("checks the options before the rating", () => {
    expect(validateRating([7], null)).toEqual(BAD_OPTIONS);
    expect(validateRating("8", { sameSizeDice: "true" })).toEqual(BAD_OPTIONS);
    expect(validateRating([6, 8], { sameSizeDice: 1 })).toEqual(BAD_OPTIONS);
  });

  it("treats a sameSizeDice set to undefined as left out", () => {
    expect(validateRating([6, 8], { sameSizeDice: undefined })).toEqual({ ok: true, value: [6, 8] });
  });

  it("refuses a hasDice or multiDice that isn't a boolean instead of coercing it", () => {
    for ( const bad of ["true", "false", 1, 0, null, {}, [], Number.NaN] ) {
      for ( const dice of [[], [8], [6, 6]] ) {
        expect(validateRating(dice, { hasDice: bad })).toEqual(BAD_OPTIONS);
        expect(validateRating(dice, { multiDice: bad })).toEqual(BAD_OPTIONS);
      }
    }
  });

  it("checks every option before the rating, even when the others are valid", () => {
    expect(validateRating([7], { hasDice: "no" })).toEqual(BAD_OPTIONS);
    expect(validateRating("8", { multiDice: 1 })).toEqual(BAD_OPTIONS);
    expect(validateRating([6, 8], { hasDice: false, multiDice: null })).toEqual(BAD_OPTIONS);
    expect(validateRating([8], { hasDice: true, multiDice: true, sameSizeDice: 1 })).toEqual(BAD_OPTIONS);
  });

  it("treats a hasDice or multiDice set to undefined as left out", () => {
    expect(validateRating([6, 8], { hasDice: undefined, multiDice: undefined })).toEqual({ ok: true, value: [6, 8] });
  });
});
