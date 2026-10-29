import { describe, expect, it } from "vitest";
import {
  addTestRoll, applyTestHeroicSteps, autoApplyTestHeroicSteps, chooseTestOverflow, closeTest, contestRollFromResolution,
  contestRollFromTotal, createTest, setTestHighStakes, testResult
} from "../../module/rules/contest.mjs";
import { buildPool } from "../../module/rules/pool.mjs";
import { applyOverflowChoice, applyResults, resolve, stepEffectDie } from "../../module/rules/roll.mjs";

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

/**
 * Rolls `sizes` with `results` and confirms the dice at `totalAt` as the total and those at
 * `effectAt` as effect dice.
 * @param {number[]} sizes
 * @param {number[]} results
 * @param {number[]} totalAt - indexes into the rolled dice
 * @param {number[]} effectAt - indexes into the rolled dice
 * @param {number} [extraEffectDicePaid]
 * @returns {{rolled: import("../../module/rules/types.mjs").RolledDie[],
 *   resolution: import("../../module/rules/types.mjs").Resolution}}
 */
function confirmRoll(sizes, results, totalAt, effectAt, extraEffectDicePaid = 0) {
  const rolled = rollPool(sizes, results);
  const resolution = resolve(rolled, selection({
    totalIds: totalAt.map(i => rolled[i].id), effectDieIds: effectAt.map(i => rolled[i].id), extraEffectDicePaid
  }));
  return { rolled, resolution };
}

/**
 * An SFX steps an effect die past d12 after Confirm, leaving its choice pending on the roll card.
 * @param {import("../../module/rules/types.mjs").RolledDie[]} rolled
 * @param {import("../../module/rules/types.mjs").Resolution} resolution
 * @param {string} [effectId]
 * @returns {import("../../module/rules/types.mjs").Resolution}
 */
function sfxPastD12(rolled, resolution, effectId = "e1") {
  const pastD12 = stepEffectDie(rolled, resolution, effectId, 1, "other");
  expect(pastD12.overflow).toMatchObject({ effectId, cause: "other" });
  return pastD12;
}

/**
 * @template T
 * @param {import("../../module/rules/types.mjs").EngineResult<T>} result
 * @param {string} label
 * @returns {T} the value, failing the test on a refusal
 */
function unwrap(result, label) {
  expect(result, label).toMatchObject({ ok: true });
  return result.value;
}

/**
 * A hand-built roll for the test's roller, with effect ids e1, e2, ... in the order of `sizes` and
 * no leftover dice.
 * @param {number} total
 * @param {...number} sizes
 * @returns {import("../../module/rules/types.mjs").ContestRoll}
 */
function R(total, ...sizes) {
  return {
    side: "roller", total, effects: sizes.map((size, i) => ({ id: `e${i + 1}`, size })), overflows: [],
    leftovers: [], nextEffectNumber: sizes.length + 1, messageRef: null
  };
}

/**
 * The test's roll for a confirmed pool roll, failing the test on a refusal.
 * @param {import("../../module/rules/types.mjs").RolledDie[]} rolled
 * @param {import("../../module/rules/types.mjs").Resolution} resolution
 * @param {string|null} [messageRef]
 * @returns {import("../../module/rules/types.mjs").ContestRoll}
 */
function rollerRoll(rolled, resolution, messageRef = null) {
  return unwrap(contestRollFromResolution("roller", rolled, resolution, messageRef), "contestRollFromResolution");
}

/**
 * Starts a test with `difficulty` and adds `roll`, failing the test on any refusal.
 * @param {number} difficulty
 * @param {import("../../module/rules/types.mjs").ContestRoll} roll
 * @returns {import("../../module/rules/types.mjs").TestState}
 */
function testWith(difficulty, roll) {
  const started = unwrap(createTest({ difficulty }), "createTest");
  return unwrap(addTestRoll(started, roll), "addTestRoll");
}

/** TC-08's roll: d10:9, d8:7, d6:4, d4:2, total d10 + d8 = 16, effect die d6 (e1), the d4 left over. */
function tc08Roll() {
  const { rolled, resolution } = confirmRoll([10, 8, 6, 4], [9, 7, 4, 2], [0, 1], [2]);
  expect(resolution.total).toBe(16);
  return rollerRoll(rolled, resolution);
}

/** TC-13's roll: d10:8, d8:6, d6:5, d6:2 with 1 PP extra, total 14, effect dice d6 (e1) and d6 (e2). */
function tc13Roll() {
  const { rolled, resolution } = confirmRoll([10, 8, 6, 6], [8, 6, 5, 2], [0, 1], [2, 3], 1);
  expect(resolution.total).toBe(14);
  return rollerRoll(rolled, resolution);
}

/**
 * TC-42's pool roll: d12:3, d10:9, d8:8, d4:2, total d10 + d8 = 17, effect die d12 (e1), the d4
 * left over; an SFX then steps e1 past d12 after Confirm.
 */
function tc42PoolRoll() {
  const { rolled, resolution } = confirmRoll([12, 10, 8, 4], [3, 9, 8, 2], [1, 2], [0]);
  expect(resolution.total).toBe(17);
  return { rolled, resolution: sfxPastD12(rolled, resolution), d4: rolled[3] };
}

/** TC-44's pool roll: d10:8, d8:6, d6:4, d4:3, total 14, effect die d6 (e1), the d4 left over. */
function tc44PoolRoll() {
  const { rolled, resolution } = confirmRoll([10, 8, 6, 4], [8, 6, 4, 3], [0, 1], [2]);
  expect(resolution.total).toBe(14);
  return { rolled, resolution, d4: rolled[3] };
}

/**
 * TC-48: d10:9, d8:8, d12:2, d6:3 with 1 PP extra, total 17, effect dice d12 (e1) and d6 (e2), nothing
 * left over; an SFX steps e1 past d12 after Confirm. Against difficulty 8: margin 9, one step.
 */
function tc48() {
  const { rolled, resolution } = confirmRoll([10, 8, 12, 6], [9, 8, 2, 3], [0, 1], [2, 3], 1);
  expect(resolution.total).toBe(17);
  const state = testWith(8, rollerRoll(rolled, sfxPastD12(rolled, resolution)));
  expect(state).toMatchObject({ success: true, margin: 9, heroicSteps: 1, heroicAppliedTo: null });
  return state;
}

/**
 * TC-49: d10:9, d8:8, d12:2, d12:3 with 1 PP extra, total 17, effect dice d12 (e1) and d12 (e2),
 * nothing left over; an SFX steps e1 past d12. Against difficulty 8 the one step goes on e2, which
 * goes past d12 too.
 */
function tc49Stepped() {
  const { rolled, resolution } = confirmRoll([10, 8, 12, 12], [9, 8, 2, 3], [0, 1], [2, 3], 1);
  expect(resolution.total).toBe(17);
  const state = testWith(8, rollerRoll(rolled, sfxPastD12(rolled, resolution)));
  expect(state).toMatchObject({ success: true, margin: 9, heroicSteps: 1 });
  const stepped = unwrap(applyTestHeroicSteps(state, "e2"), "steps on e2");
  expect(stepped.roll.overflows).toEqual([
    { effectId: "e1", cause: "other", kind: null, dieId: null },
    { effectId: "e2", cause: "heroic", kind: null, dieId: null }
  ]);
  return stepped;
}

/**
 * TC-55: d12:3, d10:7, d8:6, d4:2, total 13, effect die d12 (e1), the d4 left over; an SFX steps e1
 * past d12 after Confirm. Against difficulty 15 the test fails by 2.
 */
function tc55() {
  const { rolled, resolution } = confirmRoll([12, 10, 8, 4], [3, 7, 6, 2], [1, 2], [0]);
  expect(resolution.total).toBe(13);
  return { state: testWith(15, rollerRoll(rolled, sfxPastD12(rolled, resolution))), d4: rolled[3] };
}

describe("test outcomes through the test state", () => {
  it("TC-04 a total of 14 against difficulty 13 is a success by 1, not heroic", () => {
    const state = testWith(13, R(14, 6));
    expect(state).toMatchObject({ difficulty: 13, success: true, margin: 1, heroicSteps: 0, heroicAppliedTo: null });
    expect(testResult(state)).toEqual({
      ok: true,
      value: { success: true, margin: 1, heroic: false, heroicSteps: 0, effects: [{ id: "e1", size: 6 }], takeOut: false }
    });
  });

  it("TC-05 a total equal to the difficulty fails", () => {
    const state = testWith(13, R(13, 6));
    expect(state).toMatchObject({ success: false, margin: 0, heroicSteps: 0 });
    expect(testResult(state).value).toMatchObject({ success: false, margin: 0, heroic: false });
  });

  it("TC-06 a total of 10 against difficulty 13 fails with a margin of -3", () => {
    const state = testWith(13, R(10, 6));
    expect(state).toMatchObject({ success: false, margin: -3, heroicSteps: 0 });
    expect(testResult(state).value).toMatchObject({ success: false, margin: -3, heroic: false });
  });

  it("TC-07 heroic steps come once per full 5 points of margin, from 5 up", () => {
    // Typed totals with no effect die, so the result reports the steps without waiting (RQ-027).
    const cases = [
      { total: 14, heroic: false, steps: 0 },
      { total: 15, heroic: true, steps: 1 },
      { total: 19, heroic: true, steps: 1 },
      { total: 20, heroic: true, steps: 2 },
      { total: 27, heroic: true, steps: 3 }
    ];
    for ( const { total, heroic, steps } of cases ) {
      const state = testWith(10, R(total));
      expect(state, `total ${total}`).toMatchObject({ success: true, margin: total - 10, heroicSteps: steps });
      expect(testResult(state).value, `total ${total}`).toMatchObject({ heroic, heroicSteps: steps });
    }
  });

  it("TC-08 a margin of 8 steps the d6 effect die up once to a d8", () => {
    const state = testWith(8, tc08Roll());
    expect(state).toMatchObject({ success: true, margin: 8, heroicSteps: 1, heroicAppliedTo: null });

    const stepped = unwrap(applyTestHeroicSteps(state, "e1"), "steps on e1");
    expect(stepped.heroicAppliedTo).toBe("e1");
    expect(stepped.roll.effects).toEqual([{ id: "e1", size: 8 }]);
    expect(stepped.roll.overflows).toEqual([]);
  });

  it("TC-09 a margin of 11 steps the d6 effect die up twice to a d10", () => {
    const { rolled, resolution } = confirmRoll([12, 10, 6], [9, 8, 5], [0, 1], [2]);
    expect(resolution.total).toBe(17);
    const state = testWith(6, rollerRoll(rolled, resolution));
    expect(state).toMatchObject({ success: true, margin: 11, heroicSteps: 2 });

    const stepped = unwrap(applyTestHeroicSteps(state, "e1"), "steps on e1");
    expect(stepped.roll.effects).toEqual([{ id: "e1", size: 10 }]);
  });

  it("TC-10 a heroic step on the d12 effect die offers the leftover d4, a new d6 or the take-out", () => {
    const { rolled, resolution } = confirmRoll([12, 10, 8, 4], [2, 8, 7, 3], [1, 2], [0]);
    expect(resolution.total).toBe(15);
    const d4 = rolled[3];
    const state = testWith(9, rollerRoll(rolled, resolution));
    expect(state).toMatchObject({ success: true, margin: 6, heroicSteps: 1 });

    const stepped = unwrap(applyTestHeroicSteps(state, "e1"), "steps on e1");
    expect(stepped.roll.effects).toEqual([{ id: "e1", size: 12 }]);
    expect(stepped.roll.overflows).toEqual([{ effectId: "e1", cause: "heroic", kind: null, dieId: null }]);
    expect(stepped.roll.leftovers).toEqual([{ dieId: d4.id, size: 4 }]);

    const leftover = unwrap(chooseTestOverflow(stepped, { kind: "leftover", dieId: d4.id }), "leftover d4");
    expect(leftover.roll.effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 4 }]);
    expect(leftover.roll.overflows).toEqual([{ effectId: "e1", cause: "heroic", kind: "leftover", dieId: d4.id }]);
    expect(leftover.roll.leftovers).toEqual([]);

    const newD6 = unwrap(chooseTestOverflow(stepped, { kind: "new-d6" }), "new d6");
    expect(newD6.roll.effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 6 }]);

    const takeOut = unwrap(chooseTestOverflow(stepped, { kind: "take-out" }), "take-out");
    expect(takeOut.roll.effects).toEqual([{ id: "e1", size: 12 }]);
    expect(takeOut.roll.overflows).toEqual([{ effectId: "e1", cause: "heroic", kind: "take-out", dieId: null }]);
    expect(testResult(takeOut).value.takeOut).toBe(true);
  });

  it("TC-11 a botch totals 0: it fails against 5, a botched difficulty of 0 is beaten by 2, and 0 against 0 fails", () => {
    const botched = rollPool([8, 6], [1, 1]);
    const botch = resolve(botched, selection());
    expect(botch).toMatchObject({ botch: true, total: 0 });

    expect(testWith(5, rollerRoll(botched, botch))).toMatchObject({ success: false, margin: -5, heroicSteps: 0 });
    expect(testWith(0, R(2, 6))).toMatchObject({ success: true, margin: 2, heroicSteps: 0 });
    expect(testWith(0, rollerRoll(botched, botch))).toMatchObject({ success: false, margin: 0, heroicSteps: 0 });
  });

  it("TC-12 a player's 12 as the difficulty for a GMC: a GMC total of 12 fails, 17 succeeds heroically with 1 step", () => {
    expect(testWith(12, R(12, 6))).toMatchObject({ success: false, margin: 0, heroicSteps: 0 });
    expect(testWith(12, R(17, 6))).toMatchObject({ success: true, margin: 5, heroicSteps: 1 });
  });

  it("TC-13 with two d6 effect dice the roller's pick takes the step, and stepping the other too is refused", () => {
    const state = testWith(7, tc13Roll());
    expect(state).toMatchObject({ success: true, margin: 7, heroicSteps: 1 });

    const onE1 = unwrap(applyTestHeroicSteps(state, "e1"), "steps on e1");
    expect(onE1.roll.effects).toEqual([{ id: "e1", size: 8 }, { id: "e2", size: 6 }]);
    expect(applyTestHeroicSteps(onE1, "e2")).toEqual({ ok: false, code: "HEROIC_ALREADY_APPLIED" });

    const onE2 = unwrap(applyTestHeroicSteps(state, "e2"), "steps on e2");
    expect(onE2.roll.effects).toEqual([{ id: "e1", size: 6 }, { id: "e2", size: 8 }]);
  });

  it("TC-42 the overflow waits for the heroic step, which joins it on e1: one choice, made on the test card", () => {
    const { rolled, resolution, d4 } = tc42PoolRoll();
    const roll = rollerRoll(rolled, resolution, "roll-r1");
    expect(roll).toMatchObject({
      side: "roller", overflows: [{ effectId: "e1", cause: "other", kind: null, dieId: null }],
      leftovers: [{ dieId: d4.id, size: 4 }], nextEffectNumber: 2
    });
    const state = testWith(8, roll);
    expect(state).toMatchObject({ success: true, margin: 9, heroicSteps: 1 });

    const stepped = unwrap(autoApplyTestHeroicSteps(state), "automatic step");
    expect(stepped.heroicAppliedTo).toBe("e1");
    expect(stepped.roll.effects).toEqual([{ id: "e1", size: 12 }]);
    expect(stepped.roll.overflows).toEqual([{ effectId: "e1", cause: "other", kind: null, dieId: null }]);

    const leftover = unwrap(chooseTestOverflow(stepped, { kind: "leftover", dieId: d4.id }), "leftover d4");
    expect(leftover.roll.effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 4 }]);
    const newD6 = unwrap(chooseTestOverflow(stepped, { kind: "new-d6" }), "new d6");
    expect(newD6.roll.effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 6 }]);
    const takeOut = unwrap(chooseTestOverflow(stepped, { kind: "take-out" }), "take-out");
    expect(takeOut.roll.overflows).toEqual([{ effectId: "e1", cause: "other", kind: "take-out", dieId: null }]);
    expect(chooseTestOverflow(newD6, { kind: "new-d6" })).toEqual({ ok: false, code: "OVERFLOW_NOT_PENDING" });
  });

  it("TC-42 with difficulty 14 (margin 3, no heroic step) the choice is made on the test card straight away", () => {
    const { rolled, resolution } = tc42PoolRoll();
    const state = testWith(14, rollerRoll(rolled, resolution));
    expect(state).toMatchObject({ success: true, margin: 3, heroicSteps: 0 });

    const chosen = unwrap(chooseTestOverflow(state, { kind: "new-d6" }), "new d6");
    expect(chosen.roll.effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 6 }]);
  });
});

describe("state for the test card (Step 4.4)", () => {
  it("TC-43 a test starts with high stakes off, no roll, no outcome yet, nothing stepped and not closed", () => {
    expect(createTest({ difficulty: 13 })).toEqual({
      ok: true,
      value: {
        highStakes: false, difficulty: 13, roll: null, success: null, margin: null, heroicSteps: 0,
        heroicAppliedTo: null, closed: false
      }
    });
    expect(unwrap(createTest({ difficulty: 13, highStakes: true }), "high stakes").highStakes).toBe(true);
  });

  it("TC-44 the test keeps its own copy of the roll and records a success by 1 with no heroic steps", () => {
    const { rolled, resolution, d4 } = tc44PoolRoll();
    const state = testWith(13, rollerRoll(rolled, resolution, "roll-r1"));
    expect(state.roll).toEqual({
      side: "roller", total: 14, effects: [{ id: "e1", size: 6 }], overflows: [],
      leftovers: [{ dieId: d4.id, size: 4 }], nextEffectNumber: 2, messageRef: "roll-r1"
    });
    expect(state).toMatchObject({ success: true, margin: 1, heroicSteps: 0, heroicAppliedTo: null });
  });

  it("TC-44 a second roll is refused with CONTEST_RESOLVED", () => {
    const { rolled, resolution } = tc44PoolRoll();
    const state = testWith(13, rollerRoll(rolled, resolution, "roll-r1"));
    expect(addTestRoll(state, R(16, 8))).toEqual({ ok: false, code: "CONTEST_RESOLVED" });
  });

  it("TC-45 a typed 12 with no effect dice against 10 is a success by 2", () => {
    const typed = contestRollFromTotal("roller", 12);
    expect(typed).toEqual({
      ok: true,
      value: { side: "roller", total: 12, effects: [], overflows: [], leftovers: [], nextEffectNumber: 1, messageRef: null }
    });
    expect(testWith(10, typed.value)).toMatchObject({ success: true, margin: 2, heroicSteps: 0 });
  });

  it("TC-45 a typed 9 against 10 is a failure by 1", () => {
    const typed = unwrap(contestRollFromTotal("roller", 9), "typed 9");
    expect(testWith(10, typed)).toMatchObject({ success: false, margin: -1, heroicSteps: 0 });
  });

  it("TC-45 a typed 16 is heroic with one step but no effect die: the step lapses and the result doesn't wait", () => {
    const state = testWith(10, unwrap(contestRollFromTotal("roller", 16), "typed 16"));
    expect(state).toMatchObject({ success: true, margin: 6, heroicSteps: 1, heroicAppliedTo: null });
    expect(testResult(state)).toEqual({
      ok: true, value: { success: true, margin: 6, heroic: true, heroicSteps: 1, effects: [], takeOut: false }
    });
  });

  it("TC-45 the same when the roll's only effect die, a d4, was stepped away", () => {
    const { rolled, resolution } = confirmRoll([10, 8, 4], [9, 7, 2], [0, 1], [2]);
    expect(resolution.total).toBe(16);
    const steppedAway = stepEffectDie(rolled, resolution, "e1", -1, "other");
    expect(steppedAway.effectDice).toEqual([]);

    const state = testWith(10, rollerRoll(rolled, steppedAway));
    expect(state).toMatchObject({ success: true, margin: 6, heroicSteps: 1 });
    expect(testResult(state)).toEqual({
      ok: true, value: { success: true, margin: 6, heroic: true, heroicSteps: 1, effects: [], takeOut: false }
    });
  });

  it("TC-45 a typed 16 with a typed d8 effect die takes the step automatically: a d10", () => {
    const typed = unwrap(contestRollFromTotal("roller", 16, [8]), "typed 16 with d8");
    expect(typed).toMatchObject({ effects: [{ id: "e1", size: 8 }], nextEffectNumber: 2 });

    const stepped = unwrap(autoApplyTestHeroicSteps(testWith(10, typed)), "automatic step");
    expect(stepped.heroicAppliedTo).toBe("e1");
    expect(stepped.roll.effects).toEqual([{ id: "e1", size: 10 }]);
  });

  it("TC-46 TC-08's roll takes its step automatically, and applying it automatically again changes nothing", () => {
    const stepped = unwrap(autoApplyTestHeroicSteps(testWith(8, tc08Roll())), "automatic step");
    expect(stepped.heroicAppliedTo).toBe("e1");
    expect(stepped.roll.effects).toEqual([{ id: "e1", size: 8 }]);

    const again = autoApplyTestHeroicSteps(stepped);
    expect(again.ok).toBe(true);
    expect(again.value).toBe(stepped);
  });

  it("TC-46 with difficulty 13 (margin 3) nothing changes", () => {
    const state = testWith(13, tc08Roll());
    expect(state).toMatchObject({ success: true, margin: 3, heroicSteps: 0 });

    const result = autoApplyTestHeroicSteps(state);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(state);
  });

  it("TC-46 TC-13's two effect dice: nothing changes, and the steps wait for the roller's pick", () => {
    const state = testWith(7, tc13Roll());
    const result = autoApplyTestHeroicSteps(state);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(state);
    expect(result.value.heroicAppliedTo).toBeNull();
    expect(testResult(state)).toEqual({ ok: false, code: "HEROIC_PENDING" });
  });

  it("TC-48 the automatic steps do nothing with two effect dice, and the overflow can't be chosen before the steps", () => {
    const state = tc48();
    const result = autoApplyTestHeroicSteps(state);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(state);
    expect(chooseTestOverflow(state, { kind: "new-d6" })).toEqual({ ok: false, code: "HEROIC_PENDING" });
  });

  it("TC-48 steps on e1 join its open overflow; a new d6 (e3) then gives d12, d6 and d6", () => {
    const stepped = unwrap(applyTestHeroicSteps(tc48(), "e1"), "steps on e1");
    expect(stepped.heroicAppliedTo).toBe("e1");
    expect(stepped.roll.effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 6 }]);
    expect(stepped.roll.overflows).toEqual([{ effectId: "e1", cause: "other", kind: null, dieId: null }]);

    const chosen = unwrap(chooseTestOverflow(stepped, { kind: "new-d6" }), "new d6");
    expect(chosen.roll.effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 6 }, { id: "e3", size: 6 }]);
  });

  it("TC-48 steps on e2 make it a d8, and e1's overflow is chosen afterwards: a new d6 gives d12, d8 and d6", () => {
    const stepped = unwrap(applyTestHeroicSteps(tc48(), "e2"), "steps on e2");
    expect(stepped.roll.effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 8 }]);

    const chosen = unwrap(chooseTestOverflow(stepped, { kind: "new-d6" }), "new d6");
    expect(chosen.roll.effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 8 }, { id: "e3", size: 6 }]);
  });

  it("TC-48 steps on e2, then the take-out or victory for e1 instead", () => {
    const stepped = unwrap(applyTestHeroicSteps(tc48(), "e2"), "steps on e2");
    const chosen = unwrap(chooseTestOverflow(stepped, { kind: "take-out" }), "take-out");
    expect(chosen.roll.effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 8 }]);
    expect(chosen.roll.overflows).toEqual([{ effectId: "e1", cause: "other", kind: "take-out", dieId: null }]);
  });

  it("TC-49 with both overflows open a choice without an effect id is refused", () => {
    expect(chooseTestOverflow(tc49Stepped(), { kind: "new-d6" })).toEqual({ ok: false, code: "INVALID_OVERFLOW_CHOICE" });
  });

  it("TC-49 a new d6 for e1 (e3), then the take-out or victory for e2: d12, d12 and d6, the take-out on e2", () => {
    const afterE1 = unwrap(chooseTestOverflow(tc49Stepped(), { effectId: "e1", kind: "new-d6" }), "new d6 for e1");
    const afterE2 = unwrap(chooseTestOverflow(afterE1, { effectId: "e2", kind: "take-out" }), "take-out for e2");
    expect(afterE2.roll.effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 12 }, { id: "e3", size: 6 }]);
    expect(afterE2.roll.overflows).toEqual([
      { effectId: "e1", cause: "other", kind: "new-d6", dieId: null },
      { effectId: "e2", cause: "heroic", kind: "take-out", dieId: null }
    ]);
    expect(testResult(afterE2).value).toMatchObject({
      effects: [{ id: "e1", size: 12 }, { id: "e2", size: 12 }, { id: "e3", size: 6 }], takeOut: true
    });
  });

  it("TC-50 a roll whose take-out was already chosen on its own card can't become the test's roll", () => {
    const { rolled, resolution } = tc42PoolRoll();
    const takenOut = applyOverflowChoice(rolled, resolution, { kind: "take-out" });
    expect(takenOut).toMatchObject({ takeOut: true, overflow: null });
    expect(contestRollFromResolution("roller", rolled, takenOut, "roll-r1"))
      .toEqual({ ok: false, code: "CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE" });
  });

  it("TC-50 a roll whose new d6 was already chosen on its own card can't become the test's roll", () => {
    const { rolled, resolution } = tc42PoolRoll();
    const withD6 = applyOverflowChoice(rolled, resolution, { kind: "new-d6" });
    expect(withD6.effectDice).toMatchObject([{ id: "e1", size: 12 }, { id: "e2", kind: "overflow", size: 6 }]);
    expect(contestRollFromResolution("roller", rolled, withD6, "roll-r1"))
      .toEqual({ ok: false, code: "CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE" });
  });

  it("TC-51 high stakes on for TC-44's test: the flag is on, and success and margin don't change", () => {
    const { rolled, resolution } = tc44PoolRoll();
    const state = testWith(13, rollerRoll(rolled, resolution));
    const highStakes = unwrap(setTestHighStakes(state, true), "high stakes on");
    expect(highStakes).toMatchObject({ highStakes: true, success: true, margin: 1, heroicSteps: 0 });
  });

  it("TC-52 a test closed before its roll refuses a roll, high stakes and a second close", () => {
    const closed = unwrap(closeTest(unwrap(createTest({ difficulty: 13 }), "createTest")), "close");
    expect(closed).toMatchObject({ closed: true, roll: null });
    expect(addTestRoll(closed, R(14, 6))).toEqual({ ok: false, code: "CONTEST_CLOSED" });
    expect(setTestHighStakes(closed, true)).toEqual({ ok: false, code: "CONTEST_CLOSED" });
    expect(closeTest(closed)).toEqual({ ok: false, code: "CONTEST_CLOSED" });
  });

  it("TC-52 TC-13's test closed before the roller picks the die refuses the heroic steps", () => {
    const closed = unwrap(closeTest(testWith(7, tc13Roll())), "close");
    expect(applyTestHeroicSteps(closed, "e1")).toEqual({ ok: false, code: "CONTEST_CLOSED" });
  });

  it("TC-52 automatic heroic steps on a closed test are refused with CONTEST_CLOSED, checked first", () => {
    const beforeRoll = unwrap(closeTest(unwrap(createTest({ difficulty: 8 }), "createTest")), "close before the roll");
    expect(autoApplyTestHeroicSteps(beforeRoll)).toEqual({ ok: false, code: "CONTEST_CLOSED" });

    const stepsWaiting = unwrap(closeTest(testWith(8, tc08Roll())), "close while the step waits");
    expect(autoApplyTestHeroicSteps(stepsWaiting)).toEqual({ ok: false, code: "CONTEST_CLOSED" });
    expect(stepsWaiting.roll.effects).toEqual([{ id: "e1", size: 6 }]);
  });

  it("TC-55 a failed roll keeps its open record as stored; the result reports e1 as a d12 and doesn't wait", () => {
    const { state } = tc55();
    expect(state).toMatchObject({ success: false, margin: -2, heroicSteps: 0 });
    expect(state.roll.overflows).toEqual([{ effectId: "e1", cause: "other", kind: null, dieId: null }]);
    expect(testResult(state)).toEqual({
      ok: true,
      value: { success: false, margin: -2, heroic: false, heroicSteps: 0, effects: [{ id: "e1", size: 12 }], takeOut: false }
    });
  });

  it("TC-55 a choice for the lapsed overflow is refused with OVERFLOW_NOT_PENDING", () => {
    expect(chooseTestOverflow(tc55().state, { kind: "new-d6" })).toEqual({ ok: false, code: "OVERFLOW_NOT_PENDING" });
  });
});

describe("test guards", () => {
  it("TC-E09 a difficulty that isn't a whole number of 0 or more is refused", () => {
    for ( const bad of [-1, 1.5, "7", null] ) {
      expect(createTest({ difficulty: bad }), `difficulty ${bad}`).toEqual({ ok: false, code: "INVALID_TOTAL" });
    }
  });

  it("TC-E09 a roll with a bad side, total, die size, a duplicate id or an overflow problem is refused", () => {
    const started = unwrap(createTest({ difficulty: 13 }), "createTest");
    expect(addTestRoll(started, { ...R(14, 6), side: "initiator" })).toEqual({ ok: false, code: "INVALID_SIDE" });
    expect(addTestRoll(started, R(2.5, 6))).toEqual({ ok: false, code: "INVALID_TOTAL" });
    expect(addTestRoll(started, R(14, 7))).toEqual({ ok: false, code: "INVALID_DIE_SIZE" });

    const twice = { ...R(14), effects: [{ id: "e1", size: 8 }, { id: "e1", size: 6 }] };
    expect(addTestRoll(started, twice)).toEqual({ ok: false, code: "DUPLICATE_EFFECT_DIE" });

    const missing = { ...R(14, 12), overflows: [{ effectId: "e3", cause: "other", kind: null, dieId: null }] };
    expect(addTestRoll(started, missing)).toEqual({ ok: false, code: "EFFECT_DIE_NOT_FOUND" });

    const answered = { ...R(14, 12), overflows: [{ effectId: "e1", cause: "other", kind: "new-d6", dieId: null }] };
    expect(addTestRoll(started, answered)).toEqual({ ok: false, code: "CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE" });
  });

  it("TC-E09 a closed test given a roll with a bad side refuses with CONTEST_CLOSED first", () => {
    const closed = unwrap(closeTest(unwrap(createTest({ difficulty: 13 }), "createTest")), "close");
    expect(addTestRoll(closed, { ...R(14, 6), side: "initiator" })).toEqual({ ok: false, code: "CONTEST_CLOSED" });
  });

  it("TC-E09 a typed roll with a typed d7 is refused", () => {
    expect(contestRollFromTotal("roller", 12, [7])).toEqual({ ok: false, code: "INVALID_DIE_SIZE" });
  });

  it("TC-E10 heroic steps or an overflow choice before the roll are refused with CONTEST_NOT_RESOLVED", () => {
    const started = unwrap(createTest({ difficulty: 8 }), "createTest");
    expect(applyTestHeroicSteps(started, "e1")).toEqual({ ok: false, code: "CONTEST_NOT_RESOLVED" });
    expect(chooseTestOverflow(started, { kind: "new-d6" })).toEqual({ ok: false, code: "CONTEST_NOT_RESOLVED" });
  });

  it("TC-E10 a closed test refuses both with CONTEST_CLOSED", () => {
    const closed = unwrap(closeTest(tc48()), "close");
    expect(applyTestHeroicSteps(closed, "e1")).toEqual({ ok: false, code: "CONTEST_CLOSED" });
    expect(chooseTestOverflow(closed, { kind: "new-d6" })).toEqual({ ok: false, code: "CONTEST_CLOSED" });
  });

  it("TC-E10 heroic steps after a failure, or on a margin of 4, are refused with HEROIC_NOT_EARNED", () => {
    expect(applyTestHeroicSteps(tc55().state, "e1")).toEqual({ ok: false, code: "HEROIC_NOT_EARNED" });
    expect(applyTestHeroicSteps(testWith(12, R(16, 6)), "e1")).toEqual({ ok: false, code: "HEROIC_NOT_EARNED" });
  });

  it("TC-E10 heroic steps on an unknown effect id, or on a typed total with no effect dice, are refused", () => {
    expect(applyTestHeroicSteps(testWith(8, tc08Roll()), "e2")).toEqual({ ok: false, code: "EFFECT_DIE_NOT_FOUND" });
    expect(applyTestHeroicSteps(testWith(10, R(16)), "e1")).toEqual({ ok: false, code: "EFFECT_DIE_NOT_FOUND" });
  });

  it("TC-E10 an overflow choice while the steps wait is refused with HEROIC_PENDING", () => {
    expect(chooseTestOverflow(tc48(), { effectId: "e1", kind: "new-d6" })).toEqual({ ok: false, code: "HEROIC_PENDING" });
  });

  it("TC-E10 an overflow choice with nothing open is refused with OVERFLOW_NOT_PENDING", () => {
    const { rolled, resolution } = tc44PoolRoll();
    const state = testWith(13, rollerRoll(rolled, resolution));
    expect(chooseTestOverflow(state, { kind: "new-d6" })).toEqual({ ok: false, code: "OVERFLOW_NOT_PENDING" });
  });

  it("TC-E10 an unknown option, or a leftover that wasn't offered, is refused with INVALID_OVERFLOW_CHOICE", () => {
    const { rolled, resolution } = tc42PoolRoll();
    const state = testWith(14, rollerRoll(rolled, resolution));
    expect(chooseTestOverflow(state, { kind: "reroll" })).toEqual({ ok: false, code: "INVALID_OVERFLOW_CHOICE" });
    expect(chooseTestOverflow(state, { kind: "leftover", dieId: "d2" }))
      .toEqual({ ok: false, code: "INVALID_OVERFLOW_CHOICE" });
    expect(chooseTestOverflow(state, { kind: "leftover" })).toEqual({ ok: false, code: "INVALID_OVERFLOW_CHOICE" });
  });

  it("TC-E10 a second choice for the same overflow is refused with OVERFLOW_NOT_PENDING", () => {
    const { rolled, resolution } = tc42PoolRoll();
    const chosen = unwrap(chooseTestOverflow(testWith(14, rollerRoll(rolled, resolution)), { kind: "new-d6" }), "new d6");
    expect(chooseTestOverflow(chosen, { kind: "new-d6" })).toEqual({ ok: false, code: "OVERFLOW_NOT_PENDING" });
  });

  it("TC-E10 any choice after a failure is refused with OVERFLOW_NOT_PENDING", () => {
    const { state, d4 } = tc55();
    for ( const choice of [
      { kind: "new-d6" }, { kind: "leftover", dieId: d4.id }, { kind: "take-out" }, { effectId: "e1", kind: "new-d6" }
    ] ) {
      expect(chooseTestOverflow(state, choice), choice.kind).toEqual({ ok: false, code: "OVERFLOW_NOT_PENDING" });
    }
  });

  it("TC-E11 a high-stakes value that isn't true or false is refused; a closed test refuses first with CONTEST_CLOSED", () => {
    const started = unwrap(createTest({ difficulty: 13 }), "createTest");
    for ( const bad of ["true", 1, null] ) {
      expect(setTestHighStakes(started, bad), `value ${bad}`).toEqual({ ok: false, code: "INVALID_HIGH_STAKES" });
    }
    const closed = unwrap(closeTest(started), "close");
    expect(setTestHighStakes(closed, "true")).toEqual({ ok: false, code: "CONTEST_CLOSED" });
  });

  it("TC-E12 after the d4 default e2 was stepped away, the new d6 from e1's automatic heroic overflow is e3", () => {
    const { rolled, resolution } = confirmRoll([12, 10, 8], [2, 9, 8], [1, 2], [0], 1);
    expect(resolution.total).toBe(17);
    expect(resolution.effectDice).toMatchObject([{ id: "e1", size: 12 }, { id: "e2", kind: "default", size: 4 }]);
    const steppedAway = stepEffectDie(rolled, resolution, "e2", -1, "other");
    expect(steppedAway).toMatchObject({ effectDice: [{ id: "e1" }], nextEffectNumber: 3 });

    const state = testWith(12, rollerRoll(rolled, steppedAway));
    expect(state).toMatchObject({ success: true, margin: 5, heroicSteps: 1 });
    const stepped = unwrap(autoApplyTestHeroicSteps(state), "automatic step");
    expect(stepped.roll.overflows).toEqual([{ effectId: "e1", cause: "heroic", kind: null, dieId: null }]);

    const chosen = unwrap(chooseTestOverflow(stepped, { kind: "new-d6" }), "new d6");
    expect(chosen.roll.effects).toEqual([{ id: "e1", size: 12 }, { id: "e3", size: 6 }]);
  });
});
