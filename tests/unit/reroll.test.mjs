import { describe, expect, it } from "vitest";
import { buildPool } from "../../module/rules/pool.mjs";
import {
  applyResults, applyRerolls, largestEligible, rerollableIds, resolve, twoHighest,
  unrolledEffectDie, validateSelection
} from "../../module/rules/roll.mjs";

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

describe("shortcuts", () => {
  it("DP-19 suggests the two highest for the total and the largest eligible leftover for effect", () => {
    const rolled = rollPool([10, 8, 6, 4], [3, 8, 6, 1]);

    const totalIds = twoHighest(rolled, 2);
    expect(totalIds).toEqual([rolled[1].id, rolled[2].id]);

    const effectId = largestEligible(rolled, totalIds);
    expect(effectId).toBe(rolled[0].id);

    const sel = selection({ totalIds, effectDieIds: [effectId] });
    expect(validateSelection(rolled, sel).valid).toBe(true);
    expect(resolve(rolled, sel)).toMatchObject({
      total: 14,
      effectDice: [{ id: "e1", kind: "rolled", size: 10, dieId: rolled[0].id, isDefault: false }]
    });
  });

  it("DP-26 picks the largest die in an unrolled pool as the unopposed effect die", () => {
    const pool = buildPool([
      { size: 10, source: source("Die 1") },
      { size: 8, source: source("Die 2") },
      { size: 8, source: source("Die 3") },
      { size: 6, source: source("Die 4") }
    ]);

    expect(unrolledEffectDie(pool)).toBe(10);
  });
});

describe("rerolls", () => {
  it("DP-27 rerolls a hitch and resolves the no-longer-hitchy roll", () => {
    const rolled = rollPool([8, 6, 6], [1, 5, 4]);

    expect(rerollableIds(rolled)).toEqual(rolled.map(d => d.id));

    const rerolled = applyRerolls(rolled, { [rolled[0].id]: 6 });
    expect(rerolled[0].hitch).toBe(false);
    const sel = selection({ totalIds: [rerolled[0].id, rerolled[1].id], effectDieIds: [rerolled[2].id] });

    expect(validateSelection(rerolled, sel).valid).toBe(true);
    expect(resolve(rerolled, sel)).toMatchObject({
      total: 11,
      effectDice: [{ id: "e1", kind: "rolled", size: 6, dieId: rerolled[2].id, isDefault: false }]
    });

    expect(() => applyRerolls(rolled, { [rolled[0].id]: 9 })).toThrow();
    expect(() => applyRerolls(rolled, { [rolled[0].id]: 2.5 })).toThrow();
    expect(() => applyRerolls(rolled, { "not-a-real-id": 4 })).toThrow();
  });

  it("DP-28 refuses to reroll a hitch that's already been spent", () => {
    const rolled = rollPool([8, 6, 6], [1, 5, 4]);
    const activated = rolled.map((d, i) => (i === 0 ? { ...d, state: "hitch-activated" } : d));

    expect(rerollableIds(activated)).toEqual([activated[1].id, activated[2].id]);
    expect(() => applyRerolls(activated, { [activated[0].id]: 6 })).toThrow();
  });

  it("DP-29 rerolls a whole botch into a normal total", () => {
    const rolled = rollPool([6, 6], [1, 1]);

    expect(rerollableIds(rolled)).toEqual(rolled.map(d => d.id));

    const rerolled = applyRerolls(rolled, { [rolled[0].id]: 4, [rolled[1].id]: 3 });
    const sel = selection({ totalIds: [rerolled[0].id, rerolled[1].id] });

    expect(validateSelection(rerolled, sel).valid).toBe(true);
    expect(resolve(rerolled, sel)).toMatchObject({
      total: 7,
      effectDice: [{ id: "e1", kind: "default", size: 4, dieId: null, isDefault: true }]
    });
  });
});
