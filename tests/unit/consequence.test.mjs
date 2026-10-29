import { describe, expect, it } from "vitest";
import {
  addContestRoll, applyContestHeroicSteps, chooseContestOverflow, closeContest, compareEffectDie, contestConsequence,
  contestRollFromResolution, createContest, decidingRolls, giveIn
} from "../../module/rules/contest.mjs";
import { applyHeroicSteps } from "../../module/rules/outcome.mjs";
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
 * @param {'initiator'|'opposition'} side
 * @param {number} total
 * @param {number[]} sizes - effect die sizes, given the ids e1, e2, ... in order
 * @returns {import("../../module/rules/types.mjs").ContestRoll} with no leftover dice
 */
function contestRoll(side, total, sizes = []) {
  return {
    side, total, effects: sizes.map((size, i) => ({ id: `e${i + 1}`, size })), overflows: [],
    leftovers: [], nextEffectNumber: sizes.length + 1, messageRef: null
  };
}

/** @returns {import("../../module/rules/types.mjs").ContestRoll} an initiator roll */
function I(total, ...sizes) {
  return contestRoll("initiator", total, sizes);
}

/** @returns {import("../../module/rules/types.mjs").ContestRoll} an opposition roll */
function O(total, ...sizes) {
  return contestRoll("opposition", total, sizes);
}

/**
 * @param {'initiator'|'opposition'} side
 * @param {import("../../module/rules/types.mjs").Resolution} resolution
 * @returns {import("../../module/rules/types.mjs").ContestRoll} a contest roll copied from a Resolution
 *   whose dice are all used, so it has no leftovers
 */
function fromResolution(side, resolution) {
  return {
    side, total: resolution.total, effects: resolution.effectDice.map(({ id, size }) => ({ id, size })),
    overflows: [], leftovers: [], nextEffectNumber: resolution.nextEffectNumber, messageRef: null
  };
}

/**
 * Starts a contest and adds the rolls in order, failing the test on any refusal.
 * @param {import("../../module/rules/types.mjs").ContestRoll[]} rolls
 * @param {{highStakes?: boolean}} [options]
 * @returns {import("../../module/rules/types.mjs").ContestState}
 */
function exchange(rolls, options) {
  let state = createContest(options).value;
  for ( const roll of rolls ) {
    const next = addContestRoll(state, roll);
    expect(next, `${roll.side} ${roll.total}`).toMatchObject({ ok: true });
    state = next.value;
  }
  return state;
}

/**
 * Writes the winner's effect dice, as they stand after heroic steps and an overflow choice,
 * back into the contest's copy of the winner's last roll, as the GM-side handler does
 * (ADR-027).
 * @param {import("../../module/rules/types.mjs").ContestState} state
 * @param {import("../../module/rules/types.mjs").Resolution} resolution
 * @param {import("../../module/rules/types.mjs").ContestOverflow[]} [overflows]
 * @returns {import("../../module/rules/types.mjs").ContestState}
 */
function recordWinnerEffects(state, resolution, overflows = []) {
  const { winnerRoll } = decidingRolls(state).value;
  const effects = resolution.effectDice.map(({ id, size }) => ({ id, size }));
  return { ...state, rolls: state.rolls.map(r => (r === winnerRoll ? { ...r, effects, overflows } : r)) };
}

/**
 * The initiator's roll d12:2, d10:9, d8:8 (plus `extra` dice as further effect dice), total 17,
 * wins against the opposition's 12 by 5: one heroic step, which pushes the d12 effect die past
 * d12, and the roller takes the take-out.
 * @param {{highStakes?: boolean, loserSizes?: number[], extraSizes?: number[], extraResults?: number[]}} options
 * @returns {import("../../module/rules/types.mjs").ContestState}
 */
function heroicTakeOut({ highStakes = false, loserSizes = [8], extraSizes = [], extraResults = [] } = {}) {
  const rolled = rollPool([12, 10, 8, ...extraSizes], [2, 9, 8, ...extraResults]);
  const [d12, d10, d8, ...extras] = rolled;
  const resolution = resolve(rolled, selection({
    totalIds: [d10.id, d8.id], effectDieIds: [d12.id, ...extras.map(d => d.id)], extraEffectDicePaid: extras.length
  }));
  expect(resolution.total).toBe(17);

  const state = exchange([fromResolution("initiator", resolution), O(12, ...loserSizes)], { highStakes });
  expect(state).toMatchObject({ status: "won", winner: "initiator", margin: 5, heroicSteps: 1 });

  const heroic = applyHeroicSteps(rolled, resolution, state, "e1");
  expect(heroic.value.resolution.overflow).toMatchObject({ effectId: "e1", cause: "heroic" });
  const overflowedId = heroic.value.resolution.overflow.effectId;
  const takenOut = applyOverflowChoice(rolled, heroic.value.resolution, { kind: "take-out" });
  expect(takenOut.takeOut).toBe(true);
  return recordWinnerEffects(heroic.value.heroic, takenOut, [{ effectId: overflowedId, kind: "take-out" }]);
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
 * An SFX steps an effect die past d12 during the exchange, leaving its choice open (RQ-018).
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
 * The contest roll for a confirmed pool roll, failing the test on a refusal.
 * @param {'initiator'|'opposition'} side
 * @param {import("../../module/rules/types.mjs").RolledDie[]} rolled
 * @param {import("../../module/rules/types.mjs").Resolution} resolution
 * @returns {import("../../module/rules/types.mjs").ContestRoll}
 */
function fromPoolRoll(side, rolled, resolution) {
  const roll = contestRollFromResolution(side, rolled, resolution, null);
  expect(roll, "contestRollFromResolution").toMatchObject({ ok: true });
  return roll.value;
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
 * A hand-built contest roll whose effect die `effectId` went past d12 during the exchange.
 * @param {import("../../module/rules/types.mjs").ContestRoll} roll
 * @param {{dieId: string, size: number}[]} [leftovers]
 * @param {string} [effectId]
 * @returns {import("../../module/rules/types.mjs").ContestRoll}
 */
function withOpenOverflow(roll, leftovers = [], effectId = "e1") {
  return { ...roll, overflows: [{ effectId, cause: "other", kind: null, dieId: null }], leftovers };
}

/**
 * @param {import("../../module/rules/types.mjs").ContestState} state
 * @returns {import("../../module/rules/types.mjs").ContestEffect[]} the effect dice of the winner's last roll
 */
function winnerEffectsOf(state) {
  return decidingRolls(state).value.winnerRoll.effects;
}

describe("comparing effect dice", () => {
  it("TC-20 normal scene, the winner's d8 against the loser's d6 gives a d8 complication", () => {
    expect(compareEffectDie(8, 6, false)).toEqual({
      ok: true, value: { winnerDie: 8, loserDie: 6, steppedDown: false, complication: 8, takesOut: false }
    });
  });

  it("TC-21 normal scene, a larger loser's d10 steps the winner's d6 down to a d4 complication", () => {
    expect(compareEffectDie(6, 10, false)).toEqual({
      ok: true, value: { winnerDie: 6, loserDie: 10, steppedDown: true, complication: 4, takesOut: false }
    });
  });

  it("TC-22 normal scene, equal d8s step the winner's die down to a d6 complication", () => {
    expect(compareEffectDie(8, 8, false)).toEqual({
      ok: true, value: { winnerDie: 8, loserDie: 8, steppedDown: true, complication: 6, takesOut: false }
    });
  });

  it("TC-23 normal scene, a winner's d4 stepped down goes away, so there is no complication, yet the winner still wins", () => {
    expect(compareEffectDie(4, 6, false)).toEqual({
      ok: true, value: { winnerDie: 4, loserDie: 6, steppedDown: true, complication: null, takesOut: false }
    });
    expect(compareEffectDie(4, 4, false)).toEqual({
      ok: true, value: { winnerDie: 4, loserDie: 4, steppedDown: true, complication: null, takesOut: false }
    });

    const consequence = contestConsequence(exchange([I(15, 4), O(12, 6)]), { usedAgainstLoser: ["e1"] });
    expect(consequence.value).toMatchObject({
      winner: "initiator", loser: "opposition", ending: "won", takenOut: false, avoidWithPP: null
    });
    expect(consequence.value.comparisons).toEqual([
      { effectId: "e1", winnerDie: 4, loserDie: 6, steppedDown: true, complication: null, takesOut: false }
    ]);
  });

  it("TC-24 high stakes, the winner's larger d10 takes the loser out; a PP would give a d10 complication instead", () => {
    expect(compareEffectDie(10, 6, true)).toEqual({
      ok: true, value: { winnerDie: 10, loserDie: 6, steppedDown: false, complication: 10, takesOut: true }
    });

    const consequence = contestConsequence(exchange([I(15, 10), O(12, 6)], { highStakes: true }), { usedAgainstLoser: ["e1"] });
    expect(consequence.value).toMatchObject({
      takenOut: true, takeOutCause: "comparison", avoidWithPP: [{ effectId: "e1", size: 10 }]
    });
  });

  it("TC-25 high stakes, equal d8s: not taken out, and a d8 complication with no step-down", () => {
    expect(compareEffectDie(8, 8, true)).toEqual({
      ok: true, value: { winnerDie: 8, loserDie: 8, steppedDown: false, complication: 8, takesOut: false }
    });
  });

  it("TC-26 high stakes, a larger loser's d10: not taken out, and a d6 complication with no step-down", () => {
    expect(compareEffectDie(6, 10, true)).toEqual({
      ok: true, value: { winnerDie: 6, loserDie: 10, steppedDown: false, complication: 6, takesOut: false }
    });
  });

  it("TC-30 a loser with no effect die doesn't limit the winner: a full d6 complication, or taken out in high stakes", () => {
    expect(compareEffectDie(6, null, false)).toEqual({
      ok: true, value: { winnerDie: 6, loserDie: null, steppedDown: false, complication: 6, takesOut: false }
    });
    expect(compareEffectDie(6, null, true)).toEqual({
      ok: true, value: { winnerDie: 6, loserDie: null, steppedDown: false, complication: 6, takesOut: true }
    });
    expect(compareEffectDie(6, undefined, false)).toEqual({ ok: false, code: "INVALID_DIE_SIZE" });

    const normal = contestConsequence(exchange([I(15, 6), O(12)]), { usedAgainstLoser: ["e1"] });
    expect(normal.value.comparisons).toEqual([
      { effectId: "e1", winnerDie: 6, loserDie: null, steppedDown: false, complication: 6, takesOut: false }
    ]);
    expect(normal.value.takenOut).toBe(false);

    const high = contestConsequence(exchange([I(15, 6), O(12)], { highStakes: true }), { usedAgainstLoser: ["e1"] });
    expect(high.value).toMatchObject({
      takenOut: true, takeOutCause: "comparison", avoidWithPP: [{ effectId: "e1", size: 6 }]
    });
  });

  it("refuses a die size that doesn't exist on either side", () => {
    expect(compareEffectDie(7, 6, false)).toEqual({ ok: false, code: "INVALID_DIE_SIZE" });
    expect(compareEffectDie(undefined, 6, false)).toEqual({ ok: false, code: "INVALID_DIE_SIZE" });
    expect(compareEffectDie(null, 6, false)).toEqual({ ok: false, code: "INVALID_DIE_SIZE" });
    expect(compareEffectDie(8, 5, true)).toEqual({ ok: false, code: "INVALID_DIE_SIZE" });
  });
});

describe("the consequence of a contest", () => {
  it("TC-17 the winner's d10 from the 15 roll against the loser's d6 from the 12 roll gives a d10 complication", () => {
    const state = exchange([I(11, 6), O(13, 8), I(15, 10), O(12, 6)]);
    expect(contestConsequence(state, { usedAgainstLoser: ["e1"] })).toEqual({
      ok: true,
      value: {
        winner: "initiator",
        loser: "opposition",
        ending: "won",
        margin: 3,
        heroicSteps: 0,
        winnerEffects: [{ id: "e1", size: 10 }],
        comparisons: [
          { effectId: "e1", winnerDie: 10, loserDie: 6, steppedDown: false, complication: 10, takesOut: false }
        ],
        takenOut: false,
        takeOutCause: null,
        avoidWithPP: null,
        ppEligible: false,
        rematchBlocked: false
      }
    });
  });

  it("TC-18 giving in: no complication and no take-out, a PP for a side that has rolled, and no rematch for the initiator", () => {
    const initiatorGaveIn = giveIn(exchange([I(11, 6), O(14, 8)], { highStakes: true }), "initiator").value;
    expect(contestConsequence(initiatorGaveIn, { usedAgainstLoser: ["e1"] })).toEqual({
      ok: true,
      value: {
        winner: "opposition",
        loser: "initiator",
        ending: "gaveIn",
        margin: null,
        heroicSteps: 0,
        winnerEffects: [{ id: "e1", size: 8 }],
        comparisons: [],
        takenOut: false,
        takeOutCause: null,
        avoidWithPP: null,
        ppEligible: true,
        rematchBlocked: true
      }
    });

    const oppositionGaveIn = giveIn(exchange([I(11, 6), O(14, 8), I(16, 8)]), "opposition").value;
    expect(contestConsequence(oppositionGaveIn).value).toMatchObject({
      winner: "initiator", loser: "opposition", ending: "gaveIn", margin: null, heroicSteps: 0,
      winnerEffects: [{ id: "e1", size: 8 }], comparisons: [], takenOut: false,
      ppEligible: true, rematchBlocked: false
    });
  });

  it("TC-18b declining: no PP and nothing compared; after the initiator's roll, its effect dice are reported", () => {
    const before = giveIn(createContest().value, "opposition").value;
    expect(contestConsequence(before)).toEqual({
      ok: true,
      value: {
        winner: "initiator",
        loser: "opposition",
        ending: "declined",
        margin: null,
        heroicSteps: 0,
        winnerEffects: [],
        comparisons: [],
        takenOut: false,
        takeOutCause: null,
        avoidWithPP: null,
        ppEligible: false,
        rematchBlocked: false
      }
    });

    const rolled = rollPool([10, 8, 6], [7, 6, 4]);
    const [d10, d8, d6] = rolled;
    const resolution = resolve(rolled, selection({ totalIds: [d10.id, d8.id], effectDieIds: [d6.id] }));
    const after = giveIn(exchange([fromResolution("initiator", resolution)]), "opposition").value;
    expect(contestConsequence(after).value).toMatchObject({
      ending: "declined", winnerEffects: [{ id: "e1", size: 6 }], comparisons: [], ppEligible: false, margin: null
    });

    const twoEffects = rollPool([10, 8, 8, 6], [7, 6, 3, 4]);
    const [t10, t8Six, t8Three, t6] = twoEffects;
    const twoResolution = resolve(twoEffects, selection({
      totalIds: [t10.id, t8Six.id], effectDieIds: [t8Three.id, t6.id], extraEffectDicePaid: 1
    }));
    const declined = giveIn(exchange([fromResolution("initiator", twoResolution)]), "opposition").value;
    expect(contestConsequence(declined, { usedAgainstLoser: ["e1", "e2"] }).value).toMatchObject({
      ending: "declined", winnerEffects: [{ id: "e1", size: 8 }, { id: "e2", size: 6 }], comparisons: [], takenOut: false
    });
  });

  it("TC-27 the heroic step comes before the comparison: d8 stepped to d10 against d8 gives a d10 complication", () => {
    const rolled = rollPool([10, 8, 8], [8, 7, 3]);
    const [d10, d8Seven, d8Three] = rolled;
    const resolution = resolve(rolled, selection({ totalIds: [d10.id, d8Seven.id], effectDieIds: [d8Three.id] }));
    expect(resolution.total).toBe(15);

    const won = exchange([fromResolution("initiator", resolution), O(10, 8)]);
    expect(won).toMatchObject({ status: "won", margin: 5, heroicSteps: 1 });

    const heroic = applyHeroicSteps(rolled, resolution, won, "e1");
    expect(heroic.value.heroic).toMatchObject({ status: "won", heroicAppliedTo: "e1" });
    const state = recordWinnerEffects(heroic.value.heroic, heroic.value.resolution);

    const consequence = contestConsequence(state, { usedAgainstLoser: ["e1"] });
    expect(consequence.value.comparisons).toEqual([
      { effectId: "e1", winnerDie: 10, loserDie: 8, steppedDown: false, complication: 10, takesOut: false }
    ]);
    expect(consequence.value).toMatchObject({ heroicSteps: 1, winnerEffects: [{ id: "e1", size: 10 }] });
  });

  it("TC-28 each effect die used against the loser is compared: d10 against d8 gives a d10, d6 against d8 a d4", () => {
    const consequence = contestConsequence(exchange([I(15, 10, 6), O(12, 8)]), { usedAgainstLoser: ["e1", "e2"] });
    expect(consequence.value.comparisons).toEqual([
      { effectId: "e1", winnerDie: 10, loserDie: 8, steppedDown: false, complication: 10, takesOut: false },
      { effectId: "e2", winnerDie: 6, loserDie: 8, steppedDown: true, complication: 4, takesOut: false }
    ]);
    expect(consequence.value.takenOut).toBe(false);
  });

  it("TC-28b high stakes with d10 and d6 against d8: the d10 takes the loser out, the d6 gives a d6 complication", () => {
    const state = exchange([I(15, 10, 6), O(12, 8)], { highStakes: true });
    const consequence = contestConsequence(state, { usedAgainstLoser: ["e1", "e2"] });
    expect(consequence.value.comparisons).toEqual([
      { effectId: "e1", winnerDie: 10, loserDie: 8, steppedDown: false, complication: 10, takesOut: true },
      { effectId: "e2", winnerDie: 6, loserDie: 8, steppedDown: false, complication: 6, takesOut: false }
    ]);
    expect(consequence.value).toMatchObject({
      takenOut: true, takeOutCause: "comparison", avoidWithPP: [{ effectId: "e1", size: 10 }]
    });
  });

  it("TC-28c an extra d4 default used against a d6 is stepped away: a d8 complication and no second one", () => {
    const rolled = rollPool([10, 8, 8], [8, 7, 3]);
    const [d10, d8Seven, d8Three] = rolled;
    const resolution = resolve(rolled, selection({
      totalIds: [d10.id, d8Seven.id], effectDieIds: [d8Three.id], extraEffectDicePaid: 1
    }));
    expect(resolution.effectDice).toMatchObject([{ id: "e1", size: 8 }, { id: "e2", kind: "default", size: 4 }]);

    const state = exchange([fromResolution("initiator", resolution), O(12, 6)]);
    const consequence = contestConsequence(state, { usedAgainstLoser: ["e1", "e2"] });
    expect(consequence.value.comparisons).toEqual([
      { effectId: "e1", winnerDie: 8, loserDie: 6, steppedDown: false, complication: 8, takesOut: false },
      { effectId: "e2", winnerDie: 4, loserDie: 6, steppedDown: true, complication: null, takesOut: false }
    ]);
  });

  it("TC-29 a heroic overflow take-out takes the loser out in any scene, whatever the loser's die; a PP gives a d12", () => {
    for ( const highStakes of [false, true] ) {
      for ( const loserSizes of [[4], [12], []] ) {
        const state = heroicTakeOut({ highStakes, loserSizes });
        const consequence = contestConsequence(state, { usedAgainstLoser: ["e1"] });
        expect(consequence.value, `highStakes ${highStakes}, loser ${loserSizes}`).toMatchObject({
          winnerEffects: [{ id: "e1", size: 12 }],
          comparisons: [],
          takenOut: true,
          takeOutCause: "overflow",
          avoidWithPP: [{ effectId: "e1", size: 12 }]
        });
      }
    }

    const notListed = contestConsequence(heroicTakeOut(), { usedAgainstLoser: [] });
    expect(notListed.value).toMatchObject({ takenOut: true, takeOutCause: "overflow", comparisons: [] });
  });

  it("TC-29b the overflowed d12 takes the loser out uncompared, and the d6 against d8 still gives a d4", () => {
    const state = heroicTakeOut({ extraSizes: [6], extraResults: [3] });
    expect(decidingRolls(state).value.winnerRoll.overflows).toEqual([{ effectId: "e1", kind: "take-out" }]);

    const consequence = contestConsequence(state, { usedAgainstLoser: ["e1", "e2"] });
    expect(consequence.value).toMatchObject({
      winnerEffects: [{ id: "e1", size: 12 }, { id: "e2", size: 6 }],
      comparisons: [
        { effectId: "e2", winnerDie: 6, loserDie: 8, steppedDown: true, complication: 4, takesOut: false }
      ],
      takenOut: true,
      takeOutCause: "overflow",
      avoidWithPP: [{ effectId: "e1", size: 12 }]
    });
  });

  it("TC-31 two dice that would each take the loser out: taken out once, and one PP lists a d10 and a d8 complication", () => {
    const state = exchange([I(15, 10, 8), O(12, 6)], { highStakes: true });
    const consequence = contestConsequence(state, { usedAgainstLoser: ["e1", "e2"] });
    expect(consequence.value.comparisons).toEqual([
      { effectId: "e1", winnerDie: 10, loserDie: 6, steppedDown: false, complication: 10, takesOut: true },
      { effectId: "e2", winnerDie: 8, loserDie: 6, steppedDown: false, complication: 8, takesOut: true }
    ]);
    expect(consequence.value).toMatchObject({
      takenOut: true,
      takeOutCause: "comparison",
      avoidWithPP: [{ effectId: "e1", size: 10 }, { effectId: "e2", size: 8 }]
    });
  });

  it("compares against the loser's largest effect die, and only the dice used against the loser (rule 20)", () => {
    const state = exchange([I(15, 8, 6), O(12, 6, 10)]);
    expect(contestConsequence(state, { usedAgainstLoser: ["e1"] }).value.comparisons).toEqual([
      { effectId: "e1", winnerDie: 8, loserDie: 10, steppedDown: true, complication: 6, takesOut: false }
    ]);
    expect(contestConsequence(state, { usedAgainstLoser: [] }).value).toMatchObject({
      winnerEffects: [{ id: "e1", size: 8 }, { id: "e2", size: 6 }], comparisons: [], takenOut: false
    });
    expect(contestConsequence(state).value.comparisons).toEqual([]);
  });

  it("refuses an open contest, an effect id the winner's roll doesn't have, and the same id twice", () => {
    expect(contestConsequence(exchange([I(11, 6)]), { usedAgainstLoser: [] }))
      .toEqual({ ok: false, code: "CONTEST_NOT_RESOLVED" });

    const state = exchange([I(15, 10, 6), O(12, 8)]);
    expect(contestConsequence(state, { usedAgainstLoser: ["e3"] })).toEqual({ ok: false, code: "EFFECT_DIE_NOT_FOUND" });
    expect(contestConsequence(state, { usedAgainstLoser: ["e1", "e1"] }))
      .toEqual({ ok: false, code: "DUPLICATE_EFFECT_DIE" });

    const declined = giveIn(createContest().value, "opposition").value;
    expect(contestConsequence(declined, { usedAgainstLoser: ["e1"] })).toEqual({ ok: false, code: "EFFECT_DIE_NOT_FOUND" });
  });
});

describe("end-of-contest choices (rule 21)", () => {
  /**
   * TC-32's roll: d10:7, d8:6, d12:5, d4:3, total 13, effect die the d12 (e1), the d4 left over;
   * an SFX pushes e1 past d12 during the exchange.
   */
  function tc32Roll() {
    const { rolled, resolution } = confirmRoll([10, 8, 12, 4], [7, 6, 5, 3], [0, 1], [2]);
    expect(resolution.total).toBe(13);
    return { roll: fromPoolRoll("initiator", rolled, sfxPastD12(rolled, resolution)), d4: rolled[3] };
  }

  it("TC-34 an overflow left open on a roll that is later beaten lapses: d10 against d6 gives a d10 complication", () => {
    const opening = tc32Roll().roll;
    const state = exchange([opening, O(15, 8), I(17, 10), O(14, 6)]);
    expect(state).toMatchObject({ status: "won", winner: "initiator", margin: 3, heroicSteps: 0 });
    expect(state.rolls[0]).toEqual(opening);
    expect(state.rolls[0].overflows).toEqual([{ effectId: "e1", cause: "other", kind: null, dieId: null }]);

    const consequence = unwrap(contestConsequence(state, { usedAgainstLoser: ["e1"] }), "consequence");
    expect(consequence.comparisons).toEqual([
      { effectId: "e1", winnerDie: 10, loserDie: 6, steppedDown: false, complication: 10, takesOut: false }
    ]);
    expect(consequence).toMatchObject({ winnerEffects: [{ id: "e1", size: 10 }], takenOut: false });
  });

  /** O's 12 for TC-35: d8:6, d6:6, d12:4, effect die the d12, which an SFX pushes past d12. */
  function oppositionPastD12() {
    const { rolled, resolution } = confirmRoll([8, 6, 12], [6, 6, 4], [0, 1], [2]);
    expect(resolution.total).toBe(12);
    return fromPoolRoll("opposition", rolled, sfxPastD12(rolled, resolution));
  }

  it("TC-35 normal scene, the loser's open overflow lapses and its d12 steps the winner's d8 down to a d6 complication", () => {
    const state = exchange([I(15, 8), oppositionPastD12()]);
    expect(state).toMatchObject({ status: "won", winner: "initiator", margin: 3 });

    const consequence = unwrap(contestConsequence(state, { usedAgainstLoser: ["e1"] }), "consequence");
    expect(consequence.comparisons).toEqual([
      { effectId: "e1", winnerDie: 8, loserDie: 12, steppedDown: true, complication: 6, takesOut: false }
    ]);
    expect(consequence.takenOut).toBe(false);
  });

  it("TC-35 high stakes, the loser's lapsed d12 keeps them in: a d8 complication with no step-down", () => {
    const state = exchange([I(15, 8), oppositionPastD12()], { highStakes: true });

    const consequence = unwrap(contestConsequence(state, { usedAgainstLoser: ["e1"] }), "consequence");
    expect(consequence.comparisons).toEqual([
      { effectId: "e1", winnerDie: 8, loserDie: 12, steppedDown: false, complication: 8, takesOut: false }
    ]);
    expect(consequence.takenOut).toBe(false);
  });

  /**
   * TC-36: I's d10:8, d8:7, d12:5, d4:3 (total 15, effect die the d12 as e1, the d4 left over), with
   * e1 pushed past d12 during the exchange, beats O's 12 (d8) by 3: no heroic steps.
   */
  function tc36() {
    const { rolled, resolution } = confirmRoll([10, 8, 12, 4], [8, 7, 5, 3], [0, 1], [2]);
    expect(resolution.total).toBe(15);
    const state = exchange([fromPoolRoll("initiator", rolled, sfxPastD12(rolled, resolution)), O(12, 8)]);
    expect(state).toMatchObject({ status: "won", winner: "initiator", margin: 3, heroicSteps: 0 });
    return { state, d4: rolled[3] };
  }

  it("TC-36 the consequence waits until the winner's open overflow is chosen", () => {
    expect(contestConsequence(tc36().state, { usedAgainstLoser: ["e1"] })).toEqual({ ok: false, code: "OVERFLOW_PENDING" });
  });

  it("TC-36 take-out: e1 takes the loser out without a comparison, and a PP would give a d12 complication", () => {
    const chosen = unwrap(chooseContestOverflow(tc36().state, { kind: "take-out" }), "take-out");
    expect(decidingRolls(chosen).value.winnerRoll.overflows)
      .toEqual([{ effectId: "e1", cause: "other", kind: "take-out", dieId: null }]);

    expect(unwrap(contestConsequence(chosen, { usedAgainstLoser: ["e1"] }), "consequence")).toMatchObject({
      winnerEffects: [{ id: "e1", size: 12 }],
      comparisons: [],
      takenOut: true,
      takeOutCause: "overflow",
      avoidWithPP: [{ effectId: "e1", size: 12 }]
    });
  });

  it("TC-36 new d6: e2 joins the d12, giving a d12 and a d4 complication", () => {
    const chosen = unwrap(chooseContestOverflow(tc36().state, { kind: "new-d6" }), "new d6");
    expect(winnerEffectsOf(chosen)).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 6 }]);

    const consequence = unwrap(contestConsequence(chosen, { usedAgainstLoser: ["e1", "e2"] }), "consequence");
    expect(consequence.comparisons).toEqual([
      { effectId: "e1", winnerDie: 12, loserDie: 8, steppedDown: false, complication: 12, takesOut: false },
      { effectId: "e2", winnerDie: 6, loserDie: 8, steppedDown: true, complication: 4, takesOut: false }
    ]);
    expect(consequence.takenOut).toBe(false);
  });

  it("TC-36 leftover d4: e2 is the d4, which the loser's d8 steps away, so only the d12 complication", () => {
    const { state, d4 } = tc36();
    const chosen = unwrap(chooseContestOverflow(state, { kind: "leftover", dieId: d4.id }), "leftover");
    const { winnerRoll } = decidingRolls(chosen).value;
    expect(d4.id).toBe("d4");
    expect(winnerRoll.overflows).toEqual([{ effectId: "e1", cause: "other", kind: "leftover", dieId: "d4" }]);
    expect(winnerRoll.leftovers).toEqual([]);
    expect(winnerEffectsOf(chosen)).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 4 }]);

    const consequence = unwrap(contestConsequence(chosen, { usedAgainstLoser: ["e1", "e2"] }), "consequence");
    expect(consequence.comparisons).toEqual([
      { effectId: "e1", winnerDie: 12, loserDie: 8, steppedDown: false, complication: 12, takesOut: false },
      { effectId: "e2", winnerDie: 4, loserDie: 8, steppedDown: true, complication: null, takesOut: false }
    ]);
  });

  it("TC-36 a second choice for the same overflow is refused", () => {
    const chosen = unwrap(chooseContestOverflow(tc36().state, { kind: "new-d6" }), "new d6");
    expect(chooseContestOverflow(chosen, { kind: "new-d6" })).toEqual({ ok: false, code: "OVERFLOW_NOT_PENDING" });
  });

  it("TC-E06 heroic steps on TC-36's win by 3 are refused with HEROIC_NOT_EARNED", () => {
    expect(applyContestHeroicSteps(tc36().state, "e1")).toEqual({ ok: false, code: "HEROIC_NOT_EARNED" });
  });

  /** TC-37: I 17 with effect dice d8 (e1) and d6 (e2) beats O's 12 (d8) by 5: one heroic step. */
  function tc37() {
    const state = exchange([I(17, 8, 6), O(12, 8)]);
    expect(state).toMatchObject({ status: "won", winner: "initiator", margin: 5, heroicSteps: 1, heroicAppliedTo: null });
    return state;
  }

  it("TC-37 the consequence waits until the heroic steps are applied", () => {
    expect(contestConsequence(tc37(), { usedAgainstLoser: ["e1", "e2"] })).toEqual({ ok: false, code: "HEROIC_PENDING" });
  });

  it("TC-37 steps on e1: a d10 and a d6 against d8 give a d10 and a d4 complication", () => {
    const stepped = unwrap(applyContestHeroicSteps(tc37(), "e1"), "steps on e1");
    expect(stepped.heroicAppliedTo).toBe("e1");
    expect(winnerEffectsOf(stepped)).toEqual([{ id: "e1", size: 10 }, { id: "e2", size: 6 }]);

    const consequence = unwrap(contestConsequence(stepped, { usedAgainstLoser: ["e1", "e2"] }), "consequence");
    expect(consequence.comparisons).toEqual([
      { effectId: "e1", winnerDie: 10, loserDie: 8, steppedDown: false, complication: 10, takesOut: false },
      { effectId: "e2", winnerDie: 6, loserDie: 8, steppedDown: true, complication: 4, takesOut: false }
    ]);
  });

  it("TC-37 steps on e2: two d8s against d8 give two d6 complications", () => {
    const stepped = unwrap(applyContestHeroicSteps(tc37(), "e2"), "steps on e2");
    expect(stepped.heroicAppliedTo).toBe("e2");
    expect(winnerEffectsOf(stepped)).toEqual([{ id: "e1", size: 8 }, { id: "e2", size: 8 }]);

    const consequence = unwrap(contestConsequence(stepped, { usedAgainstLoser: ["e1", "e2"] }), "consequence");
    expect(consequence.comparisons).toEqual([
      { effectId: "e1", winnerDie: 8, loserDie: 8, steppedDown: true, complication: 6, takesOut: false },
      { effectId: "e2", winnerDie: 8, loserDie: 8, steppedDown: true, complication: 6, takesOut: false }
    ]);
  });

  it("TC-37 applying the heroic steps a second time is refused", () => {
    const stepped = unwrap(applyContestHeroicSteps(tc37(), "e1"), "steps on e1");
    expect(applyContestHeroicSteps(stepped, "e2")).toEqual({ ok: false, code: "HEROIC_ALREADY_APPLIED" });
  });

  /**
   * TC-38: I's d12:2, d10:9, d8:8, d8:3 (total 17, effect die the d12 as e1, the other d8 left
   * over) beats O's 12 (d8) by 5; the heroic step on e1 takes it past d12.
   */
  function tc38Stepped() {
    const { rolled, resolution } = confirmRoll([12, 10, 8, 8], [2, 9, 8, 3], [1, 2], [0]);
    expect(resolution.total).toBe(17);
    const state = exchange([fromPoolRoll("initiator", rolled, resolution), O(12, 8)]);
    expect(state).toMatchObject({ status: "won", winner: "initiator", margin: 5, heroicSteps: 1 });
    return { stepped: unwrap(applyContestHeroicSteps(state, "e1"), "steps on e1"), leftoverD8: rolled[3] };
  }

  it("TC-38 the heroic step takes e1 past d12 and opens its overflow, with the other d8 as the leftover on offer", () => {
    const { stepped, leftoverD8 } = tc38Stepped();
    expect(stepped.heroicAppliedTo).toBe("e1");
    const { winnerRoll } = decidingRolls(stepped).value;
    expect(winnerRoll).toMatchObject({
      effects: [{ id: "e1", size: 12 }],
      leftovers: [{ dieId: leftoverD8.id, size: 8 }]
    });
    expect(winnerRoll.overflows).toEqual([{ effectId: "e1", cause: "heroic", kind: null, dieId: null }]);
    expect(contestConsequence(stepped, { usedAgainstLoser: ["e1"] })).toEqual({ ok: false, code: "OVERFLOW_PENDING" });
  });

  it("TC-38 leftover d8: e2 is the d8, giving a d12 and a d6 complication", () => {
    const { stepped, leftoverD8 } = tc38Stepped();
    const chosen = unwrap(chooseContestOverflow(stepped, { kind: "leftover", dieId: leftoverD8.id }), "leftover");
    expect(winnerEffectsOf(chosen)).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 8 }]);

    const consequence = unwrap(contestConsequence(chosen, { usedAgainstLoser: ["e1", "e2"] }), "consequence");
    expect(consequence.comparisons).toEqual([
      { effectId: "e1", winnerDie: 12, loserDie: 8, steppedDown: false, complication: 12, takesOut: false },
      { effectId: "e2", winnerDie: 8, loserDie: 8, steppedDown: true, complication: 6, takesOut: false }
    ]);
  });

  it("TC-38 new d6: a d12 and a d4 complication", () => {
    const chosen = unwrap(chooseContestOverflow(tc38Stepped().stepped, { kind: "new-d6" }), "new d6");
    expect(winnerEffectsOf(chosen)).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 6 }]);

    const consequence = unwrap(contestConsequence(chosen, { usedAgainstLoser: ["e1", "e2"] }), "consequence");
    expect(consequence.comparisons).toEqual([
      { effectId: "e1", winnerDie: 12, loserDie: 8, steppedDown: false, complication: 12, takesOut: false },
      { effectId: "e2", winnerDie: 6, loserDie: 8, steppedDown: true, complication: 4, takesOut: false }
    ]);
  });

  it("TC-38 take-out: as TC-29, e1 takes the loser out and a PP would give a d12 complication", () => {
    const chosen = unwrap(chooseContestOverflow(tc38Stepped().stepped, { kind: "take-out" }), "take-out");
    expect(unwrap(contestConsequence(chosen, { usedAgainstLoser: ["e1"] }), "consequence")).toMatchObject({
      winnerEffects: [{ id: "e1", size: 12 }],
      comparisons: [],
      takenOut: true,
      takeOutCause: "overflow",
      avoidWithPP: [{ effectId: "e1", size: 12 }]
    });
  });

  /**
   * TC-39: I's d10:9, d8:8, d12:2, d6:3 with 1 PP for an extra effect die (total 17, effect dice the
   * d12 as e1 and the d6 as e2, nothing left over), with e1 pushed past d12 during the exchange,
   * beats O's 12 (d8) by 5: one heroic step.
   */
  function tc39() {
    const { rolled, resolution } = confirmRoll([10, 8, 12, 6], [9, 8, 2, 3], [0, 1], [2, 3], 1);
    expect(resolution.total).toBe(17);
    const state = exchange([fromPoolRoll("initiator", rolled, sfxPastD12(rolled, resolution)), O(12, 8)]);
    expect(state).toMatchObject({ status: "won", winner: "initiator", margin: 5, heroicSteps: 1 });
    return state;
  }

  it("TC-39 the heroic steps come first: the consequence reports HEROIC_PENDING, and the overflow can't be chosen yet", () => {
    const state = tc39();
    expect(contestConsequence(state, { usedAgainstLoser: ["e1", "e2"] })).toEqual({ ok: false, code: "HEROIC_PENDING" });
    expect(chooseContestOverflow(state, { kind: "new-d6" })).toEqual({ ok: false, code: "HEROIC_PENDING" });
  });

  it("TC-39 steps on e1 join its open overflow; a new d6 (e3) then gives a d12, a d4 and a d4 complication", () => {
    const stepped = unwrap(applyContestHeroicSteps(tc39(), "e1"), "steps on e1");
    expect(stepped.heroicAppliedTo).toBe("e1");
    const { winnerRoll } = decidingRolls(stepped).value;
    expect(winnerRoll.effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 6 }]);
    expect(winnerRoll.overflows).toEqual([{ effectId: "e1", cause: "other", kind: null, dieId: null }]);
    expect(contestConsequence(stepped, { usedAgainstLoser: ["e1", "e2"] })).toEqual({ ok: false, code: "OVERFLOW_PENDING" });

    const chosen = unwrap(chooseContestOverflow(stepped, { kind: "new-d6" }), "new d6");
    expect(winnerEffectsOf(chosen)).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 6 }, { id: "e3", size: 6 }]);
    const consequence = unwrap(contestConsequence(chosen, { usedAgainstLoser: ["e1", "e2", "e3"] }), "consequence");
    expect(consequence.comparisons).toEqual([
      { effectId: "e1", winnerDie: 12, loserDie: 8, steppedDown: false, complication: 12, takesOut: false },
      { effectId: "e2", winnerDie: 6, loserDie: 8, steppedDown: true, complication: 4, takesOut: false },
      { effectId: "e3", winnerDie: 6, loserDie: 8, steppedDown: true, complication: 4, takesOut: false }
    ]);
    expect(consequence.takenOut).toBe(false);
  });

  it("TC-39 steps on e1, then the take-out: taken out by e1 plus a d4 complication from e2, and a PP gives a d12 instead", () => {
    const stepped = unwrap(applyContestHeroicSteps(tc39(), "e1"), "steps on e1");
    const chosen = unwrap(chooseContestOverflow(stepped, { kind: "take-out" }), "take-out");

    expect(unwrap(contestConsequence(chosen, { usedAgainstLoser: ["e1", "e2"] }), "consequence")).toMatchObject({
      comparisons: [
        { effectId: "e2", winnerDie: 6, loserDie: 8, steppedDown: true, complication: 4, takesOut: false }
      ],
      takenOut: true,
      takeOutCause: "overflow",
      avoidWithPP: [{ effectId: "e1", size: 12 }]
    });
  });

  it("TC-39 steps on e2 make it a d8; e1's new d6 (e3) isn't used against the loser: a d12 and a d6 complication", () => {
    const stepped = unwrap(applyContestHeroicSteps(tc39(), "e2"), "steps on e2");
    expect(stepped.heroicAppliedTo).toBe("e2");
    expect(decidingRolls(stepped).value.winnerRoll).toMatchObject({
      effects: [{ id: "e1", size: 12 }, { id: "e2", size: 8 }],
      overflows: [{ effectId: "e1", kind: null }]
    });
    expect(contestConsequence(stepped, { usedAgainstLoser: ["e1", "e2"] })).toEqual({ ok: false, code: "OVERFLOW_PENDING" });

    const chosen = unwrap(chooseContestOverflow(stepped, { kind: "new-d6" }), "new d6");
    expect(winnerEffectsOf(chosen)).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 8 }, { id: "e3", size: 6 }]);
    const consequence = unwrap(contestConsequence(chosen, { usedAgainstLoser: ["e1", "e2"] }), "consequence");
    expect(consequence.comparisons).toEqual([
      { effectId: "e1", winnerDie: 12, loserDie: 8, steppedDown: false, complication: 12, takesOut: false },
      { effectId: "e2", winnerDie: 8, loserDie: 8, steppedDown: true, complication: 6, takesOut: false }
    ]);
  });

  it("TC-40 after a decline the consequence waits for the open overflow, and the take-out isn't offered", () => {
    const declined = unwrap(giveIn(exchange([tc32Roll().roll]), "opposition"), "decline");
    expect(declined).toMatchObject({ status: "declined", winner: "initiator", heroicSteps: 0 });

    expect(contestConsequence(declined)).toEqual({ ok: false, code: "OVERFLOW_PENDING" });
    expect(chooseContestOverflow(declined, { kind: "take-out" })).toEqual({ ok: false, code: "INVALID_OVERFLOW_CHOICE" });
  });

  it("TC-40 after a decline a new d6 gives the winner a d12 and a d6, with nothing compared", () => {
    const declined = unwrap(giveIn(exchange([tc32Roll().roll]), "opposition"), "decline");
    const chosen = unwrap(chooseContestOverflow(declined, { kind: "new-d6" }), "new d6");

    expect(unwrap(contestConsequence(chosen), "consequence")).toMatchObject({
      ending: "declined",
      margin: null,
      heroicSteps: 0,
      winnerEffects: [{ id: "e1", size: 12 }, { id: "e2", size: 6 }],
      comparisons: [],
      takenOut: false
    });
  });

  it("TC-40 after a decline the leftover d4 may be taken instead of a new d6", () => {
    const { roll, d4 } = tc32Roll();
    const declined = unwrap(giveIn(exchange([roll]), "opposition"), "decline");
    const chosen = unwrap(chooseContestOverflow(declined, { kind: "leftover", dieId: d4.id }), "leftover");

    expect(unwrap(contestConsequence(chosen), "consequence").winnerEffects)
      .toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 4 }]);
  });

  it("TC-40 after giving in only a new d6 is offered; the initiator takes no complication and is eligible for a PP", () => {
    // O's 14: d8:8, d6:6, d12:4, effect die the d12, pushed past d12 during the exchange; nothing left over.
    const { rolled, resolution } = confirmRoll([8, 6, 12], [8, 6, 4], [0, 1], [2]);
    expect(resolution.total).toBe(14);
    const fourteen = fromPoolRoll("opposition", rolled, sfxPastD12(rolled, resolution));
    const gaveIn = unwrap(giveIn(exchange([I(11, 6), fourteen]), "initiator"), "give in");
    expect(gaveIn).toMatchObject({ status: "gaveIn", winner: "opposition" });

    expect(contestConsequence(gaveIn)).toEqual({ ok: false, code: "OVERFLOW_PENDING" });
    expect(chooseContestOverflow(gaveIn, { kind: "take-out" })).toEqual({ ok: false, code: "INVALID_OVERFLOW_CHOICE" });
    expect(chooseContestOverflow(gaveIn, { kind: "leftover", dieId: rolled[0].id }))
      .toEqual({ ok: false, code: "INVALID_OVERFLOW_CHOICE" });

    const chosen = unwrap(chooseContestOverflow(gaveIn, { kind: "new-d6" }), "new d6");
    expect(unwrap(contestConsequence(chosen), "consequence")).toMatchObject({
      winner: "opposition",
      loser: "initiator",
      ending: "gaveIn",
      winnerEffects: [{ id: "e1", size: 12 }, { id: "e2", size: 6 }],
      comparisons: [],
      takenOut: false,
      ppEligible: true
    });
  });

  it("TC-41 a typed winning total has no effect die: the heroic step lapses but is still reported, and can't be applied", () => {
    const state = exchange([{ side: "initiator", total: 18 }, O(12, 8)]);
    expect(state).toMatchObject({ status: "won", winner: "initiator", margin: 6, heroicSteps: 1 });

    expect(unwrap(contestConsequence(state), "consequence")).toMatchObject({
      margin: 6, heroicSteps: 1, winnerEffects: [], comparisons: [], takenOut: false
    });
    expect(applyContestHeroicSteps(state, "e1")).toEqual({ ok: false, code: "EFFECT_DIE_NOT_FOUND" });
  });

  it("TC-41 the same when the winner's only effect die, a d4, was stepped away", () => {
    const { rolled, resolution } = confirmRoll([10, 8, 4], [10, 8, 2], [0, 1], [2]);
    expect(resolution.total).toBe(18);
    const steppedAway = stepEffectDie(rolled, resolution, "e1", -1, "other");
    expect(steppedAway.effectDice).toEqual([]);
    const state = exchange([fromPoolRoll("initiator", rolled, steppedAway), O(12, 8)]);
    expect(state).toMatchObject({ status: "won", margin: 6, heroicSteps: 1 });

    expect(unwrap(contestConsequence(state), "consequence")).toMatchObject({
      heroicSteps: 1, winnerEffects: [], comparisons: [], takenOut: false
    });
    expect(applyContestHeroicSteps(state, "e1")).toEqual({ ok: false, code: "EFFECT_DIE_NOT_FOUND" });
  });
});

describe("end-of-contest guards", () => {
  /** I 15 with a d12 effect die whose overflow is open, with "d4" (a d4) left over, beats O's 12 (d8). */
  function openOverflowWin() {
    return exchange([withOpenOverflow(I(15, 12), [{ dieId: "d4", size: 4 }]), O(12, 8)]);
  }

  it("TC-E06 a closed contest refuses both end-of-contest functions with CONTEST_CLOSED", () => {
    const heroic = closeContest(exchange([I(17, 8, 6), O(12, 8)])).value;
    expect(applyContestHeroicSteps(heroic, "e1")).toEqual({ ok: false, code: "CONTEST_CLOSED" });

    const overflow = closeContest(openOverflowWin()).value;
    expect(chooseContestOverflow(overflow, { kind: "new-d6" })).toEqual({ ok: false, code: "CONTEST_CLOSED" });
  });

  it("TC-E06 an open contest refuses both with CONTEST_NOT_RESOLVED", () => {
    const open = exchange([withOpenOverflow(I(17, 12))]);
    expect(applyContestHeroicSteps(open, "e1")).toEqual({ ok: false, code: "CONTEST_NOT_RESOLVED" });
    expect(chooseContestOverflow(open, { kind: "new-d6" })).toEqual({ ok: false, code: "CONTEST_NOT_RESOLVED" });
  });

  it("TC-E06 heroic steps after giving in or declining are refused with HEROIC_NOT_EARNED", () => {
    const gaveIn = giveIn(exchange([I(11, 6), O(14, 8)]), "initiator").value;
    expect(applyContestHeroicSteps(gaveIn, "e1")).toEqual({ ok: false, code: "HEROIC_NOT_EARNED" });

    const declined = giveIn(exchange([I(13, 6)]), "opposition").value;
    expect(applyContestHeroicSteps(declined, "e1")).toEqual({ ok: false, code: "HEROIC_NOT_EARNED" });
  });

  it("TC-E06 heroic steps on an effect id the winner's last roll doesn't have are refused with EFFECT_DIE_NOT_FOUND", () => {
    expect(applyContestHeroicSteps(exchange([I(17, 8, 6), O(12, 8)]), "e3"))
      .toEqual({ ok: false, code: "EFFECT_DIE_NOT_FOUND" });
  });

  it("TC-E06 a choice with no open overflow on the winner's last roll is refused with OVERFLOW_NOT_PENDING", () => {
    expect(chooseContestOverflow(exchange([I(15, 10), O(12, 6)]), { kind: "new-d6" }))
      .toEqual({ ok: false, code: "OVERFLOW_NOT_PENDING" });

    const onLoser = exchange([I(15, 8), withOpenOverflow(O(12, 12))]);
    expect(chooseContestOverflow(onLoser, { kind: "new-d6" })).toEqual({ ok: false, code: "OVERFLOW_NOT_PENDING" });

    const onBeaten = exchange([withOpenOverflow(I(13, 12)), O(15, 8), I(17, 10), O(14, 6)]);
    expect(chooseContestOverflow(onBeaten, { kind: "new-d6" })).toEqual({ ok: false, code: "OVERFLOW_NOT_PENDING" });
  });

  it("TC-E06 an unknown option or a leftover that wasn't offered is refused with INVALID_OVERFLOW_CHOICE", () => {
    const state = openOverflowWin();
    expect(chooseContestOverflow(state, { kind: "reroll" })).toEqual({ ok: false, code: "INVALID_OVERFLOW_CHOICE" });
    expect(chooseContestOverflow(state, { kind: "leftover", dieId: "d2" }))
      .toEqual({ ok: false, code: "INVALID_OVERFLOW_CHOICE" });
    expect(chooseContestOverflow(state, { kind: "leftover" })).toEqual({ ok: false, code: "INVALID_OVERFLOW_CHOICE" });
  });

  it("TC-E07 after the d4 default e2 was stepped away, a new d6 from e1's heroic overflow is e3, not e2", () => {
    const { rolled, resolution } = confirmRoll([10, 8, 12], [9, 8, 2], [0, 1], [2], 1);
    expect(resolution.effectDice).toMatchObject([{ id: "e1", size: 12 }, { id: "e2", kind: "default", size: 4 }]);
    const steppedAway = stepEffectDie(rolled, resolution, "e2", -1, "other");
    expect(steppedAway).toMatchObject({ effectDice: [{ id: "e1" }], nextEffectNumber: 3 });

    const roll = fromPoolRoll("initiator", rolled, steppedAway);
    expect(roll).toMatchObject({ effects: [{ id: "e1", size: 12 }], nextEffectNumber: 3 });
    const state = exchange([roll, O(12, 8)]);
    expect(state).toMatchObject({ status: "won", margin: 5, heroicSteps: 1 });

    const stepped = unwrap(applyContestHeroicSteps(state, "e1"), "steps on e1");
    const chosen = unwrap(chooseContestOverflow(stepped, { kind: "new-d6" }), "new d6");
    expect(winnerEffectsOf(chosen)).toEqual([{ id: "e1", size: 12 }, { id: "e3", size: 6 }]);
  });

  /**
   * TC-E08: I's d10:9, d8:8, d12:2, d12:3 with 1 PP for an extra effect die (total 17, effect dice
   * the two d12s as e1 and e2, nothing left over), with e1 pushed past d12 during the exchange,
   * beats O's 12 (d8) by 5; the heroic step on e2 takes it past d12 as well.
   */
  function tcE08Stepped() {
    const { rolled, resolution } = confirmRoll([10, 8, 12, 12], [9, 8, 2, 3], [0, 1], [2, 3], 1);
    expect(resolution.total).toBe(17);
    const state = exchange([fromPoolRoll("initiator", rolled, sfxPastD12(rolled, resolution)), O(12, 8)]);
    expect(state).toMatchObject({ status: "won", margin: 5, heroicSteps: 1 });
    return unwrap(applyContestHeroicSteps(state, "e2"), "steps on e2");
  }

  it("TC-E08 two dice past d12 each get their own choice: a new d6 for e1, the take-out for e2", () => {
    const stepped = tcE08Stepped();
    expect(winnerEffectsOf(stepped)).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 12 }]);
    expect(decidingRolls(stepped).value.winnerRoll.overflows).toEqual([
      { effectId: "e1", cause: "other", kind: null, dieId: null },
      { effectId: "e2", cause: "heroic", kind: null, dieId: null }
    ]);
    expect(contestConsequence(stepped, { usedAgainstLoser: ["e1"] })).toEqual({ ok: false, code: "OVERFLOW_PENDING" });

    const afterE1 = unwrap(chooseContestOverflow(stepped, { effectId: "e1", kind: "new-d6" }), "new d6 for e1");
    expect(winnerEffectsOf(afterE1)).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 12 }, { id: "e3", size: 6 }]);
    expect(contestConsequence(afterE1, { usedAgainstLoser: ["e1", "e3"] })).toEqual({ ok: false, code: "OVERFLOW_PENDING" });

    const afterE2 = unwrap(chooseContestOverflow(afterE1, { effectId: "e2", kind: "take-out" }), "take-out for e2");
    expect(decidingRolls(afterE2).value.winnerRoll.overflows).toEqual([
      { effectId: "e1", cause: "other", kind: "new-d6", dieId: null },
      { effectId: "e2", cause: "heroic", kind: "take-out", dieId: null }
    ]);
    expect(unwrap(contestConsequence(afterE2, { usedAgainstLoser: ["e1", "e3"] }), "consequence")).toMatchObject({
      comparisons: [
        { effectId: "e1", winnerDie: 12, loserDie: 8, steppedDown: false, complication: 12, takesOut: false },
        { effectId: "e3", winnerDie: 6, loserDie: 8, steppedDown: true, complication: 4, takesOut: false }
      ],
      takenOut: true,
      takeOutCause: "overflow",
      avoidWithPP: [{ effectId: "e2", size: 12 }]
    });
  });

  it("TC-E08 with both open the choice must name its die; an answered die or an id the roll doesn't have is refused", () => {
    const stepped = tcE08Stepped();
    expect(chooseContestOverflow(stepped, { kind: "new-d6" })).toEqual({ ok: false, code: "INVALID_OVERFLOW_CHOICE" });
    expect(chooseContestOverflow(stepped, { effectId: "e9", kind: "new-d6" }))
      .toEqual({ ok: false, code: "EFFECT_DIE_NOT_FOUND" });

    const afterE1 = unwrap(chooseContestOverflow(stepped, { effectId: "e1", kind: "new-d6" }), "new d6 for e1");
    expect(chooseContestOverflow(afterE1, { effectId: "e1", kind: "new-d6" }))
      .toEqual({ ok: false, code: "OVERFLOW_NOT_PENDING" });
  });
});
