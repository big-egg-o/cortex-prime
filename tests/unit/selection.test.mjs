import { describe, expect, it } from "vitest";
import { buildPool } from "../../module/rules/pool.mjs";
import { applyResults, resolve, validateSelection } from "../../module/rules/roll.mjs";

/** @returns {{kind: string, label: string}} a minimal DieSource for tests */
function source(label) {
  return { kind: "trait", label };
}

/**
 * @param {number[]} sizes
 * @param {number[]} results
 * @returns {import("../../module/rules/types.mjs").RolledDie[]}
 */
function rollPool(sizes, results) {
  const pool = buildPool(sizes.map((size, i) => ({ size, source: source(`Die ${i + 1}`) })));
  return applyResults(pool, results);
}

/** @returns {import("../../module/rules/types.mjs").Selection} a Selection with sensible defaults */
function selection({
  totalIds = [], effectDieIds = [], extraResultsPaid = 0, extraEffectDicePaid = 0, keepLimit
} = {}) {
  const sel = { totalIds, effectDieIds, extraResultsPaid, extraEffectDicePaid };
  if ( keepLimit !== undefined ) sel.keepLimit = keepLimit;
  return sel;
}

describe("total and effect dice", () => {
  it("DP-09 resolves a botch to a total of 0 and a default d4 effect die", () => {
    const rolled = rollPool([8, 6, 4], [1, 1, 1]);
    const sel = selection();

    expect(validateSelection(rolled, sel).valid).toBe(true);
    expect(resolve(rolled, sel)).toMatchObject({
      total: 0,
      effectDice: [{ size: 4, dieId: null, isDefault: true }]
    });
  });

  it("DP-10 totals the one die that isn't a hitch, with a default d4 effect die", () => {
    const rolled = rollPool([8, 6, 4], [1, 1, 2]);
    const sel = selection({ totalIds: [rolled[2].id] });

    expect(validateSelection(rolled, sel).valid).toBe(true);
    expect(resolve(rolled, sel)).toMatchObject({
      total: 2,
      effectDice: [{ size: 4, dieId: null, isDefault: true }]
    });
  });

  it("DP-11 totals a single usable die, and a single hitch still botches", () => {
    const hit = rollPool([6], [4]);
    const hitSel = selection({ totalIds: [hit[0].id] });
    expect(validateSelection(hit, hitSel).valid).toBe(true);
    expect(resolve(hit, hitSel)).toMatchObject({
      total: 4,
      effectDice: [{ size: 4, dieId: null, isDefault: true }]
    });

    const botch = rollPool([6], [1]);
    const botchSel = selection();
    expect(validateSelection(botch, botchSel).valid).toBe(true);
    expect(resolve(botch, botchSel)).toMatchObject({
      total: 0,
      effectDice: [{ size: 4, dieId: null, isDefault: true }]
    });
  });

  it("DP-13 totals the two largest dice, with the remaining die as effect", () => {
    const rolled = rollPool([10, 8, 6], [7, 5, 3]);
    const sel = selection({ totalIds: [rolled[0].id, rolled[1].id], effectDieIds: [rolled[2].id] });

    expect(validateSelection(rolled, sel).valid).toBe(true);
    expect(resolve(rolled, sel)).toMatchObject({
      total: 12,
      effectDice: [{ size: 6, dieId: rolled[2].id, isDefault: false }]
    });
  });

  it("DP-14 allows saving either big die for the total or for effect", () => {
    const rolled = rollPool([12, 8, 8, 6, 4], [9, 7, 6, 5, 2]);

    const choiceA = selection({ totalIds: [rolled[0].id, rolled[1].id], effectDieIds: [rolled[2].id] });
    expect(validateSelection(rolled, choiceA).valid).toBe(true);
    expect(resolve(rolled, choiceA)).toMatchObject({
      total: 16,
      effectDice: [{ size: 8, dieId: rolled[2].id, isDefault: false }]
    });

    const choiceB = selection({ totalIds: [rolled[1].id, rolled[2].id], effectDieIds: [rolled[0].id] });
    expect(validateSelection(rolled, choiceB).valid).toBe(true);
    expect(resolve(rolled, choiceB)).toMatchObject({
      total: 13,
      effectDice: [{ size: 12, dieId: rolled[0].id, isDefault: false }]
    });
  });

  it("DP-15 totals both dice in a two-die pool, with a default d4 effect die", () => {
    const rolled = rollPool([8, 6], [6, 4]);
    const sel = selection({ totalIds: [rolled[0].id, rolled[1].id] });

    expect(validateSelection(rolled, sel).valid).toBe(true);
    expect(resolve(rolled, sel)).toMatchObject({
      total: 10,
      effectDice: [{ size: 4, dieId: null, isDefault: true }]
    });
  });

  it("DP-16 can't use a hitch as the effect die, so the leftover d4 takes the slot", () => {
    const rolled = rollPool([10, 8, 6, 4], [1, 6, 5, 3]);
    const sel = selection({ totalIds: [rolled[1].id, rolled[2].id], effectDieIds: [rolled[3].id] });

    expect(validateSelection(rolled, sel).valid).toBe(true);
    expect(resolve(rolled, sel)).toMatchObject({
      total: 11,
      effectDice: [{ size: 4, dieId: rolled[3].id, isDefault: false }]
    });

    const hitchAsEffect = selection({ totalIds: [rolled[1].id, rolled[2].id], effectDieIds: [rolled[0].id] });
    const hitchResult = validateSelection(rolled, hitchAsEffect);
    expect(hitchResult.valid).toBe(false);
    expect(hitchResult.errors.map(e => e.code)).toContain("HITCH_SELECTED");
    expect(() => resolve(rolled, hitchAsEffect)).toThrow();
  });

  it("DP-17 totals the only usable die in a two-die pool with one hitch", () => {
    const rolled = rollPool([6, 6], [1, 5]);
    const sel = selection({ totalIds: [rolled[1].id] });

    expect(validateSelection(rolled, sel).valid).toBe(true);
    expect(resolve(rolled, sel)).toMatchObject({
      total: 5,
      effectDice: [{ size: 4, dieId: null, isDefault: true }]
    });
  });

  it("DP-18 refuses to keep fewer results than allowed, and refuses a hitch in the total", () => {
    const rolled = rollPool([12, 4], [9, 3]);

    const tooFew = selection({ totalIds: [rolled[1].id], effectDieIds: [rolled[0].id] });
    const tooFewResult = validateSelection(rolled, tooFew);
    expect(tooFewResult.valid).toBe(false);
    expect(tooFewResult.errors.map(e => e.code)).toContain("KEEP_TOO_FEW");
    expect(() => resolve(rolled, tooFew)).toThrow();

    const onlyValid = selection({ totalIds: [rolled[0].id, rolled[1].id] });
    expect(validateSelection(rolled, onlyValid).valid).toBe(true);
    expect(resolve(rolled, onlyValid)).toMatchObject({
      total: 12,
      effectDice: [{ size: 4, dieId: null, isDefault: true }]
    });

    const withHitch = rollPool([10, 4], [1, 2]);
    const hitchInTotal = selection({ totalIds: [withHitch[0].id] });
    const hitchResult = validateSelection(withHitch, hitchInTotal);
    expect(hitchResult.valid).toBe(false);
    expect(hitchResult.errors.map(e => e.code)).toContain("HITCH_SELECTED");
    expect(() => resolve(withHitch, hitchInTotal)).toThrow();
  });

  it("DP-20 lets a bought extra result shift which die covers the total, with the other as effect", () => {
    const rolled = rollPool([10, 8, 6, 4], [8, 6, 5, 4]);

    const noPP = selection({ totalIds: [rolled[0].id, rolled[1].id], effectDieIds: [rolled[2].id] });
    expect(validateSelection(rolled, noPP).valid).toBe(true);
    expect(resolve(rolled, noPP)).toMatchObject({
      total: 14,
      effectDice: [{ size: 6, dieId: rolled[2].id, isDefault: false }]
    });

    const keepD6 = selection({
      totalIds: [rolled[0].id, rolled[1].id, rolled[2].id],
      effectDieIds: [rolled[3].id],
      extraResultsPaid: 1
    });
    expect(validateSelection(rolled, keepD6).valid).toBe(true);
    expect(resolve(rolled, keepD6)).toMatchObject({
      total: 19,
      effectDice: [{ size: 4, dieId: rolled[3].id, isDefault: false }]
    });

    const keepD4 = selection({
      totalIds: [rolled[0].id, rolled[1].id, rolled[3].id],
      effectDieIds: [rolled[2].id],
      extraResultsPaid: 1
    });
    expect(validateSelection(rolled, keepD4).valid).toBe(true);
    expect(resolve(rolled, keepD4)).toMatchObject({
      total: 18,
      effectDice: [{ size: 6, dieId: rolled[2].id, isDefault: false }]
    });

    const reused = selection({
      totalIds: [rolled[0].id, rolled[1].id, rolled[2].id],
      effectDieIds: [rolled[2].id],
      extraResultsPaid: 1
    });
    const reusedResult = validateSelection(rolled, reused);
    expect(reusedResult.valid).toBe(false);
    expect(reusedResult.errors.map(e => e.code)).toContain("DIE_REUSED");
    expect(() => resolve(rolled, reused)).toThrow();

    const sameDieTwice = selection({
      totalIds: [rolled[0].id, rolled[0].id],
      effectDieIds: [rolled[1].id]
    });
    const sameDieTwiceResult = validateSelection(rolled, sameDieTwice);
    expect(sameDieTwiceResult.valid).toBe(false);
    expect(sameDieTwiceResult.errors.map(e => e.code)).toContain("DIE_REUSED");
    expect(() => resolve(rolled, sameDieTwice)).toThrow();
  });

  it("DP-21 buys a second effect die with the dice left over from the total", () => {
    const rolled = rollPool([12, 10, 8, 6], [5, 7, 6, 2]);
    const sel = selection({
      totalIds: [rolled[1].id, rolled[2].id],
      effectDieIds: [rolled[0].id, rolled[3].id],
      extraEffectDicePaid: 1
    });

    expect(validateSelection(rolled, sel).valid).toBe(true);
    expect(resolve(rolled, sel)).toMatchObject({
      total: 13,
      effectDice: [
        { size: 12, dieId: rolled[0].id, isDefault: false },
        { size: 6, dieId: rolled[3].id, isDefault: false }
      ]
    });
  });

  it("DP-22 defaults both effect dice to d4 when a bought extra has nothing left over", () => {
    const rolled = rollPool([8, 6], [5, 4]);
    const sel = selection({
      totalIds: [rolled[0].id, rolled[1].id],
      extraEffectDicePaid: 1
    });

    expect(validateSelection(rolled, sel).valid).toBe(true);
    expect(resolve(rolled, sel)).toMatchObject({
      total: 9,
      effectDice: [
        { size: 4, dieId: null, isDefault: true },
        { size: 4, dieId: null, isDefault: true }
      ]
    });
  });

  it("DP-23 keeps only one result under a keep limit of one, and refuses two", () => {
    const rolled = rollPool([10, 8, 6], [7, 6, 3]);

    const keepD10 = selection({ totalIds: [rolled[0].id], effectDieIds: [rolled[1].id], keepLimit: 1 });
    expect(validateSelection(rolled, keepD10).valid).toBe(true);
    expect(resolve(rolled, keepD10)).toMatchObject({
      total: 7,
      effectDice: [{ size: 8, dieId: rolled[1].id, isDefault: false }]
    });

    const keepD8 = selection({ totalIds: [rolled[1].id], effectDieIds: [rolled[0].id], keepLimit: 1 });
    expect(validateSelection(rolled, keepD8).valid).toBe(true);
    expect(resolve(rolled, keepD8)).toMatchObject({
      total: 6,
      effectDice: [{ size: 10, dieId: rolled[0].id, isDefault: false }]
    });

    const keepTwo = selection({ totalIds: [rolled[0].id, rolled[1].id], keepLimit: 1 });
    const keepTwoResult = validateSelection(rolled, keepTwo);
    expect(keepTwoResult.valid).toBe(false);
    expect(keepTwoResult.errors.map(e => e.code)).toContain("KEEP_TOO_MANY");
    expect(() => resolve(rolled, keepTwo)).toThrow();
  });

  it("DP-E02 refuses to pay for more extra results than there are dice to keep", () => {
    const rolled = rollPool([8, 6], [5, 4]);
    const sel = selection({
      totalIds: [rolled[0].id, rolled[1].id],
      extraResultsPaid: 2
    });

    const result = validateSelection(rolled, sel);
    expect(result.valid).toBe(false);
    expect(result.errors.map(e => e.code)).toContain("TOO_MANY_EXTRA_RESULTS");
    expect(() => resolve(rolled, sel)).toThrow();
  });

  it("DP-E04 excludes an unavailable die from both the total and the effect die", () => {
    const rolled = rollPool([8, 6], [5, 4]);
    const reserved = rolled.map((d, i) => (i === 0 ? { ...d, state: "unavailable" } : d));

    const inTotal = selection({ totalIds: [reserved[0].id, reserved[1].id] });
    const inTotalResult = validateSelection(reserved, inTotal);
    expect(inTotalResult.valid).toBe(false);
    expect(inTotalResult.errors.map(e => e.code)).toContain("UNAVAILABLE_DIE");
    expect(() => resolve(reserved, inTotal)).toThrow();

    const asEffect = selection({ totalIds: [reserved[1].id], effectDieIds: [reserved[0].id] });
    const asEffectResult = validateSelection(reserved, asEffect);
    expect(asEffectResult.valid).toBe(false);
    expect(asEffectResult.errors.map(e => e.code)).toContain("UNAVAILABLE_DIE");
    expect(() => resolve(reserved, asEffect)).toThrow();
  });

  it("DP-E05 refuses no effect die chosen while an eligible leftover remains", () => {
    const rolled = rollPool([10, 8, 6], [7, 5, 3]);
    const sel = selection({ totalIds: [rolled[0].id, rolled[1].id] });

    const result = validateSelection(rolled, sel);
    expect(result.valid).toBe(false);
    expect(result.errors.map(e => e.code)).toContain("EFFECT_DIE_MISSING");
    expect(() => resolve(rolled, sel)).toThrow();
  });

  it("DP-E06 refuses a second effect die when none was paid for or granted", () => {
    const rolled = rollPool([12, 10, 8, 6], [5, 7, 6, 2]);
    const sel = selection({
      totalIds: [rolled[1].id, rolled[2].id],
      effectDieIds: [rolled[0].id, rolled[3].id]
    });

    const result = validateSelection(rolled, sel);
    expect(result.valid).toBe(false);
    expect(result.errors.map(e => e.code)).toContain("TOO_MANY_EFFECT_DICE");
    expect(() => resolve(rolled, sel)).toThrow();
  });
});
