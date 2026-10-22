import { describe, expect, it } from "vitest";
import { buildPool } from "../../module/rules/pool.mjs";
import {
  applyRerolls, applyResults, resolve, suggestSelection, validateSelection
} from "../../module/rules/roll.mjs";

/**
 * @param {number[]} sizes
 * @param {number[]} results
 * @returns {import("../../module/rules/types.mjs").RolledDie[]}
 */
function rollPool(sizes, results) {
  const pool = buildPool(sizes.map((size, i) => ({ size, source: { kind: "trait", label: `Die ${i + 1}` } })));
  return applyResults(pool, results);
}

/** @returns {import("../../module/rules/types.mjs").Selection} an empty selection with the given counters */
function counters({ extraResultsPaid = 0, extraEffectDicePaid = 0, keepLimit = 2 } = {}) {
  return { totalIds: [], effectDieIds: [], extraResultsPaid, extraEffectDicePaid, keepLimit };
}

/**
 * Applies the suggestion to `base`, checks it passes validateSelection, and resolves it.
 * @param {import("../../module/rules/types.mjs").RolledDie[]} rolled
 * @param {import("../../module/rules/types.mjs").Selection} base
 */
function suggestAndResolve(rolled, base) {
  const suggestion = suggestSelection(rolled, base);
  const sel = { ...base, ...suggestion };
  expect(validateSelection(rolled, sel)).toEqual({ valid: true, errors: [] });
  return { suggestion, resolution: resolve(rolled, sel) };
}

/** @param {import("../../module/rules/types.mjs").Resolution} resolution */
function effectSizes(resolution) {
  return resolution.effectDice.map(e => e.size);
}

describe("suggestSelection", () => {
  it("DP-13 suggests d10 + d8 for the total and the d6 as effect die", () => {
    const rolled = rollPool([10, 8, 6], [7, 5, 3]);
    const { suggestion, resolution } = suggestAndResolve(rolled, counters());

    expect(suggestion).toEqual({ totalIds: [rolled[0].id, rolled[1].id], effectDieIds: [rolled[2].id] });
    expect(resolution.total).toBe(12);
    expect(effectSizes(resolution)).toEqual([6]);
  });

  it("DP-18 keeps both dice of a two-die roll in the total, leaving a default d4 effect die", () => {
    const rolled = rollPool([12, 4], [9, 3]);
    const { suggestion, resolution } = suggestAndResolve(rolled, counters());

    expect(suggestion).toEqual({ totalIds: [rolled[0].id, rolled[1].id], effectDieIds: [] });
    expect(resolution.total).toBe(12);
    expect(resolution.effectDice).toEqual([{ id: "e1", kind: "default", size: 4, dieId: null, isDefault: true }]);
  });

  it("DP-19 suggests d8 + d6 and the d10 as effect die, skipping the d4 hitch", () => {
    const rolled = rollPool([10, 8, 6, 4], [3, 8, 6, 1]);
    const { suggestion, resolution } = suggestAndResolve(rolled, counters());

    expect(suggestion).toEqual({ totalIds: [rolled[1].id, rolled[2].id], effectDieIds: [rolled[0].id] });
    expect(resolution.total).toBe(14);
    expect(effectSizes(resolution)).toEqual([10]);
  });

  it("DP-20 adds the third highest result to the total for one paid extra result", () => {
    const rolled = rollPool([10, 8, 6, 4], [8, 6, 5, 4]);
    const { suggestion, resolution } = suggestAndResolve(rolled, counters({ extraResultsPaid: 1 }));

    expect(suggestion.totalIds).toEqual([rolled[0].id, rolled[1].id, rolled[2].id]);
    expect(resolution.total).toBe(19);
    expect(resolution.effectDice).toEqual([{ id: "e1", kind: "rolled", size: 4, dieId: rolled[3].id, isDefault: false }]);
  });

  it("DP-21 fills a paid extra effect slot with the next largest leftover", () => {
    const rolled = rollPool([12, 10, 8, 6], [5, 7, 6, 2]);
    const { resolution } = suggestAndResolve(rolled, counters({ extraEffectDicePaid: 1 }));

    expect(resolution.total).toBe(13);
    expect(effectSizes(resolution)).toEqual([12, 6]);
  });

  it("DP-22 leaves both effect slots empty when nothing is left, for two default d4s", () => {
    const rolled = rollPool([8, 6], [5, 4]);
    const { suggestion, resolution } = suggestAndResolve(rolled, counters({ extraEffectDicePaid: 1 }));

    expect(suggestion.effectDieIds).toEqual([]);
    expect(resolution.total).toBe(9);
    expect(resolution.effectDice).toEqual([
      { id: "e1", kind: "default", size: 4, dieId: null, isDefault: true },
      { id: "e2", kind: "default", size: 4, dieId: null, isDefault: true }
    ]);
  });

  it("DP-23 keeps only the highest result with a keep limit of one, suggesting the d8 as effect die", () => {
    const rolled = rollPool([10, 8, 6], [7, 6, 3]);
    const { suggestion, resolution } = suggestAndResolve(rolled, counters({ keepLimit: 1 }));

    expect(suggestion).toEqual({ totalIds: [rolled[0].id], effectDieIds: [rolled[1].id] });
    expect(resolution.total).toBe(7);
  });

  it("DP-09 suggests nothing for a botch", () => {
    const rolled = rollPool([8, 6, 4], [1, 1, 1]);
    const { suggestion, resolution } = suggestAndResolve(rolled, counters());

    expect(suggestion).toEqual({ totalIds: [], effectDieIds: [] });
    expect(resolution.total).toBe(0);
  });

  it("puts both usable dice in the total when a hitch leaves only two (d8:1, d6:5, d6:4)", () => {
    const rolled = rollPool([8, 6, 6], [1, 5, 4]);
    const { suggestion, resolution } = suggestAndResolve(rolled, counters());

    expect(suggestion).toEqual({ totalIds: [rolled[1].id, rolled[2].id], effectDieIds: [] });
    expect(resolution.total).toBe(9);
    expect(resolution.effectDice).toEqual([{ id: "e1", kind: "default", size: 4, dieId: null, isDefault: true }]);
  });

  it("DP-29 suggests total 7 and a default d4 for a botch rerolled to 4 and 3", () => {
    const botch = rollPool([6, 6], [1, 1]);
    const rolled = applyRerolls(botch, { [botch[0].id]: 4, [botch[1].id]: 3 });
    const { resolution } = suggestAndResolve(rolled, counters());

    expect(resolution.total).toBe(7);
    expect(resolution.effectDice).toEqual([{ id: "e1", kind: "default", size: 4, dieId: null, isDefault: true }]);
  });

  it("suggests the one usable die for a botch rerolled to 1 and 3", () => {
    const botch = rollPool([6, 6], [1, 1]);
    const rolled = applyRerolls(botch, { [botch[0].id]: 1, [botch[1].id]: 3 });
    const { suggestion, resolution } = suggestAndResolve(rolled, counters());

    expect(suggestion).toEqual({ totalIds: [rolled[1].id], effectDieIds: [] });
    expect(resolution.total).toBe(3);
  });

  it("doesn't change its inputs", () => {
    const rolled = Object.freeze(rollPool([10, 8, 6], [7, 5, 3]).map(d => Object.freeze(d)));
    const base = Object.freeze(counters());
    expect(() => suggestSelection(rolled, base)).not.toThrow();
  });
});
