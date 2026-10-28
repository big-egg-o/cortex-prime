import { describe, expect, it } from "vitest";
import { validateRating } from "../../module/rules/traits.mjs";

const INVALID = { ok: false, code: "INVALID_DIE_SIZE" };
const MIXED = { ok: false, code: "RATING_MIXED_SIZES" };
const BAD_OPTIONS = { ok: false, code: "INVALID_RATING_OPTIONS" };

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
});
