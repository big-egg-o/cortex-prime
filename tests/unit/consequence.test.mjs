import { describe, expect, it } from "vitest";
import {
  addContestRoll, compareEffectDie, contestConsequence, createContest, decidingRolls, giveIn
} from "../../module/rules/contest.mjs";
import { applyHeroicSteps } from "../../module/rules/outcome.mjs";
import { buildPool } from "../../module/rules/pool.mjs";
import { applyOverflowChoice, applyResults, resolve } from "../../module/rules/roll.mjs";

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
 * @returns {import("../../module/rules/types.mjs").ContestRoll}
 */
function contestRoll(side, total, sizes = []) {
  return {
    side, total, effects: sizes.map((size, i) => ({ id: `e${i + 1}`, size })), overflow: null, messageRef: null
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
 */
function fromResolution(side, resolution) {
  return {
    side, total: resolution.total, effects: resolution.effectDice.map(({ id, size }) => ({ id, size })),
    overflow: null, messageRef: null
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
 * @param {import("../../module/rules/types.mjs").ContestOverflow|null} [overflow]
 * @returns {import("../../module/rules/types.mjs").ContestState}
 */
function recordWinnerEffects(state, resolution, overflow = null) {
  const { winnerRoll } = decidingRolls(state).value;
  const effects = resolution.effectDice.map(({ id, size }) => ({ id, size }));
  return { ...state, rolls: state.rolls.map(r => (r === winnerRoll ? { ...r, effects, overflow } : r)) };
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
  return recordWinnerEffects(heroic.value.heroic, takenOut, { effectId: overflowedId, kind: "take-out" });
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
    expect(decidingRolls(state).value.winnerRoll.overflow).toEqual({ effectId: "e1", kind: "take-out" });

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
