import { describe, expect, it } from "vitest";
import {
  applyOverflowChoice, applyRerolls, applyResults, buildPool, doubleDie, resolve,
  stepEffectDie, stepPoolDie
} from "../../module/rules/index.mjs";

/** @param {*} value @returns {*} the same value, frozen all the way down */
function deepFreeze(value) {
  if ( value && typeof value === "object" && !Object.isFrozen(value) ) {
    Object.freeze(value);
    for ( const key of Object.keys(value) ) deepFreeze(value[key]);
  }
  return value;
}

/** @returns {{kind: string, label: string}} a minimal DieSource for tests */
function source(label) {
  return { kind: "trait", label };
}

describe("engine functions never mutate their inputs", () => {
  it("buildPool works from frozen entries", () => {
    const entries = deepFreeze([
      { size: 8, source: source("Skill") },
      { size: 6, source: source("Asset"), count: 2 }
    ]);

    const pool = buildPool(entries);
    expect(pool).not.toBe(entries);
    expect(pool.map(d => d.size)).toEqual([8, 6, 6]);
  });

  it("doubleDie works from a frozen pool", () => {
    const pool = deepFreeze(buildPool([
      { size: 8, source: source("Skill") },
      { size: 6, source: source("Asset") }
    ]));

    const doubled = doubleDie(pool, pool[0].id);
    expect(doubled).not.toBe(pool);
    expect(doubled.map(d => d.size)).toEqual([8, 8, 6]);
  });

  it("stepPoolDie works from a frozen pool, including an overflow step", () => {
    const pool = deepFreeze(buildPool([{ size: 12, source: source("Skill") }]));

    const stepped = stepPoolDie(pool, pool[0].id, 1);
    expect(stepped).not.toBe(pool);
    expect(stepped.map(d => d.size)).toEqual([12, 6]);
  });

  it("applyResults works from a frozen pool and a frozen results array", () => {
    const pool = deepFreeze(buildPool([
      { size: 10, source: source("Skill") },
      { size: 8, source: source("Asset") }
    ]));
    const results = deepFreeze([7, 5]);

    const rolled = applyResults(pool, results);
    expect(rolled).not.toBe(pool);
    expect(rolled.map(d => d.result)).toEqual([7, 5]);
  });

  it("resolve works from a frozen roll and a frozen selection", () => {
    const pool = buildPool([
      { size: 10, source: source("Skill") },
      { size: 8, source: source("Asset") },
      { size: 6, source: source("Distinction") }
    ]);
    const rolled = deepFreeze(applyResults(pool, [7, 5, 3]));
    const selection = deepFreeze({
      totalIds: [rolled[0].id, rolled[1].id],
      effectDieIds: [rolled[2].id],
      extraResultsPaid: 0,
      extraEffectDicePaid: 0
    });

    const resolution = resolve(rolled, selection);
    expect(resolution).not.toBe(selection);
    expect(resolution.total).toBe(12);
  });

  it("stepEffectDie and applyOverflowChoice work from a frozen roll and resolution", () => {
    const pool = buildPool([
      { size: 12, source: source("Skill") },
      { size: 10, source: source("Attribute") },
      { size: 8, source: source("Asset") }
    ]);
    const rolled = deepFreeze(applyResults(pool, [3, 9, 8]));
    const selection = {
      totalIds: [rolled[1].id, rolled[2].id],
      effectDieIds: [rolled[0].id],
      extraResultsPaid: 0,
      extraEffectDicePaid: 0
    };
    const resolution = deepFreeze(resolve(rolled, selection));

    const stepped = stepEffectDie(rolled, resolution, "e1", 1, "heroic");
    expect(stepped).not.toBe(resolution);
    expect(stepped.overflow).not.toBeNull();

    const frozenStepped = deepFreeze(stepped);
    const withD6 = applyOverflowChoice(rolled, frozenStepped, { kind: "new-d6" });
    expect(withD6).not.toBe(frozenStepped);
    expect(withD6.effectDice).toHaveLength(2);
  });

  it("stepEffectDie removes a d4 effect die from a frozen roll and resolution (DP-24b)", () => {
    const pool = buildPool([
      { size: 10, source: source("Skill") },
      { size: 8, source: source("Attribute") },
      { size: 4, source: source("Asset") }
    ]);
    const rolled = deepFreeze(applyResults(pool, [7, 5, 3]));
    const selection = {
      totalIds: [rolled[0].id, rolled[1].id],
      effectDieIds: [rolled[2].id],
      extraResultsPaid: 0,
      extraEffectDicePaid: 0
    };
    const resolution = deepFreeze(resolve(rolled, selection));

    const removed = stepEffectDie(rolled, resolution, "e1", -1, "other");
    expect(removed).not.toBe(resolution);
    expect(removed.effectDice).toEqual([]);
    expect(removed.consumedDieIds).toEqual([rolled[2].id]);
    expect(resolution.effectDice).toHaveLength(1);
    expect(resolution.consumedDieIds).toEqual([]);
  });

  it("applyRerolls works from a frozen roll and a frozen results map", () => {
    const pool = buildPool([{ size: 8, source: source("Skill") }, { size: 6, source: source("Asset") }]);
    const rolled = deepFreeze(applyResults(pool, [1, 5]));
    const results = deepFreeze({ [rolled[0].id]: 6 });

    const rerolled = applyRerolls(rolled, results);
    expect(rerolled).not.toBe(rolled);
    expect(rerolled[0].result).toBe(6);
  });
});
