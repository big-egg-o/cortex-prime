import { describe, expect, it } from "vitest";
import {
  DIFFICULTY_LEVELS, applyHeroicSteps, beats, difficultyDice, difficultyEntry, heroicSteps, resolveTest
} from "../../module/rules/outcome.mjs";
import { buildPool } from "../../module/rules/pool.mjs";
import { applyResults, resolve, stepEffectDie, unrolledEffectDie } from "../../module/rules/roll.mjs";

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
function selection({ totalIds = [], effectDieIds = [], extraResultsPaid = 0, extraEffectDicePaid = 0 } = {}) {
  return { totalIds, effectDieIds, extraResultsPaid, extraEffectDicePaid };
}

/** @param {number[]} sizes @returns {import("../../module/rules/types.mjs").PoolDie[]} an unrolled pool */
function unrolledPool(sizes) {
  return buildPool(sizes.map((size, i) => ({ size, source: source(`Die ${i + 1}`) })));
}

describe("difficulty", () => {
  it("TC-01 gives a pair of chart-sized dice for each level and refuses an unknown level", () => {
    expect(DIFFICULTY_LEVELS).toEqual(["veryEasy", "easy", "challenging", "hard", "veryHard"]);
    expect(difficultyDice("veryEasy")).toEqual({ ok: true, value: [4, 4] });
    expect(difficultyDice("easy")).toEqual({ ok: true, value: [6, 6] });
    expect(difficultyDice("challenging")).toEqual({ ok: true, value: [8, 8] });
    expect(difficultyDice("hard")).toEqual({ ok: true, value: [10, 10] });
    expect(difficultyDice("veryHard")).toEqual({ ok: true, value: [12, 12] });

    for ( const level of ["medium", "Hard", "", undefined, null, 10, "toString", "constructor"] ) {
      expect(difficultyDice(level)).toEqual({ ok: false, code: "UNKNOWN_DIFFICULTY_LEVEL" });
      expect(difficultyEntry(level, source("Difficulty"))).toEqual({ ok: false, code: "UNKNOWN_DIFFICULTY_LEVEL" });
    }
  });

  it("TC-02 builds a Hard opposition pool plus a GMC trait and a risk die, each die keeping its source", () => {
    const difficulty = { kind: "difficulty", label: "Hard" };
    const gmcTrait = { kind: "trait", label: "Gate guard" };
    const risk = { kind: "risk", label: "Extra risk" };

    const entries = difficultyEntry("hard", difficulty);
    expect(entries).toEqual({ ok: true, value: [{ size: 10, source: difficulty }, { size: 10, source: difficulty }] });

    const pool = buildPool([...entries.value, { size: 8, source: gmcTrait }, { size: 6, source: risk }]);
    expect(pool.map(d => d.size)).toEqual([10, 10, 8, 6]);
    expect(pool.map(d => d.source)).toEqual([difficulty, difficulty, gmcTrait, risk]);
    expect(new Set(pool.map(d => d.id)).size).toBe(4);
  });

  it("TC-03 sets difficulty 13 with a d10 effect die from the opposition roll, through the dice engine unchanged", () => {
    const rolled = rollPool([10, 10, 8, 6], [7, 3, 6, 2]);
    const [d10Seven, d10Three, d8] = rolled;

    const resolution = resolve(rolled, selection({ totalIds: [d10Seven.id, d8.id], effectDieIds: [d10Three.id] }));
    expect(resolution.total).toBe(13);
    expect(resolution.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 10, dieId: d10Three.id, isDefault: false }
    ]);
  });
});

describe("test outcomes", () => {
  it("TC-04 beating difficulty 13 with 14 is a success by 1, not heroic", () => {
    expect(beats(14, 13)).toEqual({ ok: true, value: true });
    expect(resolveTest({ total: 14, difficulty: 13 })).toEqual({
      ok: true, value: { success: true, margin: 1, heroic: false, heroicSteps: 0 }
    });
  });

  it("TC-05 a total equal to the difficulty fails", () => {
    expect(beats(13, 13)).toEqual({ ok: true, value: false });
    expect(resolveTest({ total: 13, difficulty: 13 })).toEqual({
      ok: true, value: { success: false, margin: 0, heroic: false, heroicSteps: 0 }
    });
  });

  it("TC-06 a total below the difficulty fails with a negative margin", () => {
    expect(beats(10, 13)).toEqual({ ok: true, value: false });
    expect(resolveTest({ total: 10, difficulty: 13 })).toEqual({
      ok: true, value: { success: false, margin: -3, heroic: false, heroicSteps: 0 }
    });
  });

  it("TC-07 heroic steps come once per full 5 points of margin, from 5 up", () => {
    const cases = [
      { total: 14, heroic: false, steps: 0 },
      { total: 15, heroic: true, steps: 1 },
      { total: 19, heroic: true, steps: 1 },
      { total: 20, heroic: true, steps: 2 },
      { total: 27, heroic: true, steps: 3 }
    ];
    for ( const { total, heroic, steps } of cases ) {
      expect(resolveTest({ total, difficulty: 10 })).toEqual({
        ok: true, value: { success: true, margin: total - 10, heroic, heroicSteps: steps }
      });
      expect(heroicSteps(total - 10)).toEqual({ ok: true, value: steps });
    }
    expect(heroicSteps(0)).toEqual({ ok: true, value: 0 });
    expect(heroicSteps(-3)).toEqual({ ok: true, value: 0 });
  });

  it("TC-08 a margin of 8 steps the d6 effect die up once to a d8", () => {
    const rolled = rollPool([10, 8, 6, 4], [9, 7, 4, 2]);
    const [d10, d8, d6] = rolled;
    const resolution = resolve(rolled, selection({ totalIds: [d10.id, d8.id], effectDieIds: [d6.id] }));
    expect(resolution.total).toBe(16);

    const outcome = resolveTest({ total: resolution.total, difficulty: 8 });
    expect(outcome).toEqual({ ok: true, value: { success: true, margin: 8, heroic: true, heroicSteps: 1 } });

    const stepped = applyHeroicSteps(rolled, resolution, outcome.value, "e1");
    expect(stepped.ok).toBe(true);
    expect(stepped.value.resolution.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 8, dieId: d6.id, isDefault: false }
    ]);
    expect(stepped.value.resolution.overflow).toBeNull();
    expect(stepped.value.resolution.total).toBe(16);
    expect(stepped.value.heroic).toEqual({ ...outcome.value, heroicAppliedTo: "e1" });
  });

  it("TC-09 a margin of 11 steps the d6 effect die up twice to a d10", () => {
    const rolled = rollPool([12, 10, 6], [9, 8, 5]);
    const [d12, d10, d6] = rolled;
    const resolution = resolve(rolled, selection({ totalIds: [d12.id, d10.id], effectDieIds: [d6.id] }));
    expect(resolution.total).toBe(17);

    const outcome = resolveTest({ total: resolution.total, difficulty: 6 });
    expect(outcome).toEqual({ ok: true, value: { success: true, margin: 11, heroic: true, heroicSteps: 2 } });

    const stepped = applyHeroicSteps(rolled, resolution, outcome.value, "e1");
    expect(stepped.value.resolution.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 10, dieId: d6.id, isDefault: false }
    ]);
  });

  it("TC-10 a heroic step on a d12 effect die offers the leftover d4, a new d6 or the take-out", () => {
    const rolled = rollPool([12, 10, 8, 4], [2, 8, 7, 3]);
    const [d12, d10, d8, d4] = rolled;
    const resolution = resolve(rolled, selection({ totalIds: [d10.id, d8.id], effectDieIds: [d12.id] }));
    expect(resolution.total).toBe(15);

    const outcome = resolveTest({ total: resolution.total, difficulty: 9 });
    expect(outcome).toEqual({ ok: true, value: { success: true, margin: 6, heroic: true, heroicSteps: 1 } });

    const stepped = applyHeroicSteps(rolled, resolution, outcome.value, "e1");
    expect(stepped.ok).toBe(true);
    expect(stepped.value.resolution.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 12, dieId: d12.id, isDefault: false }
    ]);
    expect(stepped.value.resolution.overflow).toEqual({
      effectId: "e1",
      cause: "heroic",
      options: { cause: "heroic", leftovers: [{ dieId: d4.id, size: 4 }], newDie: 6, takeOutAvailable: true }
    });
  });

  it("TC-11 a botch totals 0: it fails against 5, a botched difficulty of 0 is beaten by 2, and 0 against 0 fails", () => {
    const botched = rollPool([8, 6], [1, 1]);
    const botch = resolve(botched, selection());
    expect(botch.botch).toBe(true);
    expect(botch.total).toBe(0);

    expect(resolveTest({ total: botch.total, difficulty: 5 })).toEqual({
      ok: true, value: { success: false, margin: -5, heroic: false, heroicSteps: 0 }
    });
    expect(resolveTest({ total: 2, difficulty: 0 })).toEqual({
      ok: true, value: { success: true, margin: 2, heroic: false, heroicSteps: 0 }
    });
    expect(resolveTest({ total: 0, difficulty: 0 })).toEqual({
      ok: true, value: { success: false, margin: 0, heroic: false, heroicSteps: 0 }
    });
  });

  it("TC-12 a player's 12 as the difficulty for a GMC: 12 fails, 17 succeeds heroically with 1 step", () => {
    expect(resolveTest({ total: 12, difficulty: 12 })).toEqual({
      ok: true, value: { success: false, margin: 0, heroic: false, heroicSteps: 0 }
    });
    expect(resolveTest({ total: 17, difficulty: 12 })).toEqual({
      ok: true, value: { success: true, margin: 5, heroic: true, heroicSteps: 1 }
    });
  });

  it("TC-13 with two d6 effect dice, the roller's pick takes the heroic step, and stepping the other too is refused", () => {
    const rolled = rollPool([10, 8, 6, 6], [8, 6, 5, 2]);
    const [d10, d8, d6Five, d6Two] = rolled;
    const resolution = resolve(rolled, selection({
      totalIds: [d10.id, d8.id], effectDieIds: [d6Five.id, d6Two.id], extraEffectDicePaid: 1
    }));
    expect(resolution.total).toBe(14);

    const outcome = resolveTest({ total: resolution.total, difficulty: 7 });
    expect(outcome).toEqual({ ok: true, value: { success: true, margin: 7, heroic: true, heroicSteps: 1 } });

    const first = applyHeroicSteps(rolled, resolution, outcome.value, "e1");
    expect(first.value.resolution.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 8, dieId: d6Five.id, isDefault: false },
      { id: "e2", kind: "rolled", size: 6, dieId: d6Two.id, isDefault: false }
    ]);
    expect(applyHeroicSteps(rolled, first.value.resolution, first.value.heroic, "e2"))
      .toEqual({ ok: false, code: "HEROIC_ALREADY_APPLIED" });

    const other = applyHeroicSteps(rolled, resolution, outcome.value, "e2");
    expect(other.value.resolution.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 6, dieId: d6Five.id, isDefault: false },
      { id: "e2", kind: "rolled", size: 8, dieId: d6Two.id, isDefault: false }
    ]);
  });

  it("TC-14 an unrolled test takes its effect die from the opposition pool, not the player's", () => {
    const opposition = unrolledPool([10, 10, 8]);
    const player = unrolledPool([8, 8, 6]);
    expect(unrolledEffectDie(opposition)).toBe(10);
    expect(unrolledEffectDie(player)).toBe(8);
  });
});

describe("applyHeroicSteps refusals (ADR-025)", () => {
  /** d10:9, d8:7, d6:4 against difficulty 8: margin 8, one heroic step, effect die e1 (the d6). */
  function heroicRoll() {
    const rolled = rollPool([10, 8, 6], [9, 7, 4]);
    const [d10, d8, d6] = rolled;
    const resolution = resolve(rolled, selection({ totalIds: [d10.id, d8.id], effectDieIds: [d6.id] }));
    return { rolled, resolution, d6 };
  }

  it("refuses when no heroic steps were earned", () => {
    const { rolled, resolution } = heroicRoll();
    const plain = resolveTest({ total: 14, difficulty: 13 }).value;
    expect(applyHeroicSteps(rolled, resolution, plain, "e1")).toEqual({ ok: false, code: "HEROIC_NOT_EARNED" });
    const failed = resolveTest({ total: 10, difficulty: 13 }).value;
    expect(applyHeroicSteps(rolled, resolution, failed, "e1")).toEqual({ ok: false, code: "HEROIC_NOT_EARNED" });
  });

  it("refuses an effect id the resolution doesn't have, including a rolled die's id", () => {
    const { rolled, resolution, d6 } = heroicRoll();
    const heroic = { heroicSteps: 1, heroicAppliedTo: null };
    expect(applyHeroicSteps(rolled, resolution, heroic, "e2")).toEqual({ ok: false, code: "EFFECT_DIE_NOT_FOUND" });
    expect(applyHeroicSteps(rolled, resolution, heroic, d6.id)).toEqual({ ok: false, code: "EFFECT_DIE_NOT_FOUND" });
  });

  it("refuses while an overflow choice is pending", () => {
    const rolled = rollPool([12, 10, 8], [3, 9, 8]);
    const [d12, d10, d8] = rolled;
    const resolution = resolve(rolled, selection({ totalIds: [d10.id, d8.id], effectDieIds: [d12.id] }));
    const pending = stepEffectDie(rolled, resolution, "e1", 1, "other");
    expect(pending.overflow).not.toBeNull();

    expect(applyHeroicSteps(rolled, pending, { heroicSteps: 1, heroicAppliedTo: null }, "e1"))
      .toEqual({ ok: false, code: "OVERFLOW_PENDING" });
  });
});

describe("bad totals", () => {
  it("TC-E04 refuses a total or difficulty that isn't a whole number of 0 or more", () => {
    for ( const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "7", null, undefined] ) {
      expect(beats(bad, 5)).toEqual({ ok: false, code: "INVALID_TOTAL" });
      expect(beats(5, bad)).toEqual({ ok: false, code: "INVALID_TOTAL" });
      expect(resolveTest({ total: bad, difficulty: 5 })).toEqual({ ok: false, code: "INVALID_TOTAL" });
      expect(resolveTest({ total: 5, difficulty: bad })).toEqual({ ok: false, code: "INVALID_TOTAL" });
    }
    expect(resolveTest({})).toEqual({ ok: false, code: "INVALID_TOTAL" });
    expect(heroicSteps(5.5)).toEqual({ ok: false, code: "INVALID_TOTAL" });
    expect(heroicSteps("5")).toEqual({ ok: false, code: "INVALID_TOTAL" });
  });
});
