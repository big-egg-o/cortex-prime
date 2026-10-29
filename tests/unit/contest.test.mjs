import { describe, expect, it } from "vitest";
import {
  addContestRoll, closeContest, contestRollFromResolution, createContest, decidingRolls, giveIn
} from "../../module/rules/contest.mjs";
import { buildPool } from "../../module/rules/pool.mjs";
import {
  applyOverflowChoice, applyResults, resolve, stepEffectDie, unrolledEffectDie
} from "../../module/rules/roll.mjs";
import { contestConsequence, contestRollFromTotal, setContestHighStakes } from "../../module/rules/index.mjs";

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
 * A contest roll for a side, with effect ids e1, e2, ... in the order of `sizes`, as the
 * contest copies them from a confirmed poolRoll (ADR-027), with no leftover dice.
 * @param {'initiator'|'opposition'} side
 * @param {number} total
 * @param {number[]} sizes
 * @returns {import("../../module/rules/types.mjs").ContestRoll}
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
 * A contest roll copied from a Resolution of the dice engine. Every roll in this file uses all its
 * dice, so none has a leftover.
 * @param {'initiator'|'opposition'} side
 * @param {import("../../module/rules/types.mjs").Resolution} resolution
 * @param {string} messageRef
 * @returns {import("../../module/rules/types.mjs").ContestRoll}
 */
function fromResolution(side, resolution, messageRef) {
  return {
    side,
    total: resolution.total,
    effects: resolution.effectDice.map(({ id, size }) => ({ id, size })),
    overflows: [],
    leftovers: [],
    nextEffectNumber: resolution.nextEffectNumber,
    messageRef
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

describe("starting a contest", () => {
  it("starts open, with the initiator to roll first and high stakes off unless asked for", () => {
    expect(createContest()).toEqual({
      ok: true,
      value: {
        highStakes: false,
        rolls: [],
        difficulty: null,
        turn: "initiator",
        status: "open",
        winner: null,
        hasRolled: { initiator: false, opposition: false },
        margin: null,
        heroicSteps: 0,
        heroicAppliedTo: null,
        closed: false
      }
    });
    expect(createContest({ highStakes: true }).value.highStakes).toBe(true);
  });
});

describe("the exchange", () => {
  it("TC-15 the opposition's 10 doesn't beat the initiator's 11, so the initiator wins by 1", () => {
    const iRolled = rollPool([8, 8, 6], [6, 5, 3]);
    const iResolution = resolve(iRolled, selection({ totalIds: [iRolled[0].id, iRolled[1].id], effectDieIds: [iRolled[2].id] }));
    const oRolled = rollPool([10, 8, 6], [6, 4, 2]);
    const oResolution = resolve(oRolled, selection({ totalIds: [oRolled[0].id, oRolled[1].id], effectDieIds: [oRolled[2].id] }));
    expect(iResolution.total).toBe(11);
    expect(oResolution.total).toBe(10);

    const opened = addContestRoll(createContest().value, fromResolution("initiator", iResolution, "roll-i1"));
    expect(opened.value).toMatchObject({
      difficulty: 11, turn: "opposition", status: "open", hasRolled: { initiator: true, opposition: false }
    });

    const ended = addContestRoll(opened.value, fromResolution("opposition", oResolution, "roll-o1"));
    expect(ended.value).toMatchObject({
      difficulty: 11, turn: null, status: "won", winner: "initiator", margin: 1, heroicSteps: 0,
      hasRolled: { initiator: true, opposition: true }
    });
    expect(decidingRolls(ended.value)).toEqual({
      ok: true,
      value: {
        winnerRoll: {
          side: "initiator", total: 11, effects: [{ id: "e1", size: 6 }], overflows: [],
          leftovers: [], nextEffectNumber: 2, messageRef: "roll-i1"
        },
        loserRoll: {
          side: "opposition", total: 10, effects: [{ id: "e1", size: 6 }], overflows: [],
          leftovers: [], nextEffectNumber: 2, messageRef: "roll-o1"
        }
      }
    });
  });

  it("TC-16 a tie doesn't beat the difficulty, so the initiator wins by 0", () => {
    const state = exchange([I(11, 6), O(11, 6)]);
    expect(state).toMatchObject({ status: "won", winner: "initiator", margin: 0, heroicSteps: 0 });
  });

  it("TC-17 back and forth until the opposition's 12 fails against 15: the deciding rolls are the 15 and the 12", () => {
    let state = exchange([I(11, 6), O(13, 8)]);
    expect(state).toMatchObject({ difficulty: 13, turn: "initiator", status: "open" });
    state = exchange([I(11, 6), O(13, 8), I(15, 10)]);
    expect(state).toMatchObject({ difficulty: 15, turn: "opposition", status: "open" });

    state = exchange([I(11, 6), O(13, 8), I(15, 10), O(12, 6)]);
    expect(state).toMatchObject({ status: "won", winner: "initiator", margin: 3, heroicSteps: 0 });
    expect(state.rolls.map(r => r.total)).toEqual([11, 13, 15, 12]);

    const { winnerRoll, loserRoll } = decidingRolls(state).value;
    expect(winnerRoll).toMatchObject({ side: "initiator", total: 15, effects: [{ id: "e1", size: 10 }] });
    expect(loserRoll).toMatchObject({ side: "opposition", total: 12, effects: [{ id: "e1", size: 6 }] });
  });

  it("TC-18 giving in on your turn hands the win to the other side, with no margin and no heroic steps", () => {
    const initiatorGivesIn = giveIn(exchange([I(11, 6), O(14, 8)]), "initiator");
    expect(initiatorGivesIn.value).toMatchObject({
      status: "gaveIn", winner: "opposition", turn: null, margin: null, heroicSteps: 0,
      hasRolled: { initiator: true, opposition: true }
    });
    expect(decidingRolls(initiatorGivesIn.value).value).toEqual({
      winnerRoll: O(14, 8), loserRoll: null
    });

    const oppositionGivesIn = giveIn(exchange([I(11, 6), O(14, 8), I(16, 8)]), "opposition");
    expect(oppositionGivesIn.value).toMatchObject({
      status: "gaveIn", winner: "initiator", turn: null, margin: null, heroicSteps: 0,
      hasRolled: { initiator: true, opposition: true }
    });
    expect(decidingRolls(oppositionGivesIn.value).value).toEqual({
      winnerRoll: I(16, 8), loserRoll: null
    });
  });

  it("TC-18b declining before or after the initiator's roll: the initiator wins, and only a rolled decline has effect dice", () => {
    const before = giveIn(createContest().value, "opposition");
    expect(before.value).toMatchObject({
      status: "declined", winner: "initiator", turn: null, rolls: [], margin: null, heroicSteps: 0,
      hasRolled: { initiator: false, opposition: false }
    });
    expect(decidingRolls(before.value).value).toEqual({ winnerRoll: null, loserRoll: null });
    expect(unrolledEffectDie(buildPool([8, 8, 6].map(size => ({ size, source: source("Initiator") }))))).toBe(8);

    const rolled = rollPool([10, 8, 6], [7, 6, 4]);
    const [d10, d8, d6] = rolled;
    const resolution = resolve(rolled, selection({ totalIds: [d10.id, d8.id], effectDieIds: [d6.id] }));
    expect(resolution.total).toBe(13);
    const after = giveIn(exchange([fromResolution("initiator", resolution, "roll-i1")]), "opposition");
    expect(after.value).toMatchObject({
      status: "declined", winner: "initiator", margin: null, heroicSteps: 0,
      hasRolled: { initiator: true, opposition: false }
    });
    expect(decidingRolls(after.value).value.winnerRoll.effects).toEqual([{ id: "e1", size: 6 }]);
    expect(decidingRolls(after.value).value.loserRoll).toBeNull();

    const twoEffects = rollPool([10, 8, 8, 6], [7, 6, 3, 4]);
    const [t10, t8Six, t8Three, t6] = twoEffects;
    const twoResolution = resolve(twoEffects, selection({
      totalIds: [t10.id, t8Six.id], effectDieIds: [t8Three.id, t6.id], extraEffectDicePaid: 1
    }));
    expect(twoResolution.total).toBe(13);
    const declined = giveIn(exchange([fromResolution("initiator", twoResolution, "roll-i1")]), "opposition");
    expect(declined.value.status).toBe("declined");
    expect(decidingRolls(declined.value).value.winnerRoll.effects).toEqual([{ id: "e1", size: 8 }, { id: "e2", size: 6 }]);
  });

  it("TC-19 the margin at the end of a contest is the winner's standing total minus the loser's failed total", () => {
    const first = exchange([I(17, 6), O(12, 6)]);
    expect(first).toMatchObject({ status: "won", winner: "initiator", margin: 5, heroicSteps: 1 });
    expect(decidingRolls(first).value.winnerRoll.total).toBe(17);

    const second = exchange([I(11, 6), O(15, 8), I(9, 6)]);
    expect(second).toMatchObject({ status: "won", winner: "opposition", margin: 6, heroicSteps: 1 });
    expect(decidingRolls(second).value.winnerRoll).toEqual(O(15, 8));

    const third = exchange([I(20, 8), O(9, 6)]);
    expect(third).toMatchObject({ status: "won", winner: "initiator", margin: 11, heroicSteps: 2 });
  });

  it("only the side whose turn it is can give in, once the initiator has rolled (rule 16)", () => {
    expect(giveIn(exchange([I(11, 6)]), "initiator")).toEqual({ ok: false, code: "CONTEST_NOT_YOUR_TURN" });
    expect(giveIn(exchange([I(11, 6), O(14, 8)]), "opposition")).toEqual({ ok: false, code: "CONTEST_NOT_YOUR_TURN" });
  });
});

describe("contest edge cases", () => {
  it("TC-E01 refuses a roll out of turn: the opposition first, or the same side twice in a row", () => {
    expect(addContestRoll(createContest().value, O(11, 6))).toEqual({ ok: false, code: "CONTEST_NOT_YOUR_TURN" });
    expect(addContestRoll(exchange([I(11, 6)]), I(13, 8))).toEqual({ ok: false, code: "CONTEST_NOT_YOUR_TURN" });
    expect(addContestRoll(exchange([I(11, 6), O(13, 8)]), O(15, 8))).toEqual({ ok: false, code: "CONTEST_NOT_YOUR_TURN" });
  });

  it("TC-E02 the opposition giving in before its first roll is a decline; the initiator can't give in before rolling", () => {
    expect(giveIn(createContest().value, "opposition").value.status).toBe("declined");
    expect(giveIn(exchange([I(11, 6)]), "opposition").value.status).toBe("declined");
    expect(giveIn(createContest().value, "initiator")).toEqual({ ok: false, code: "CONTEST_NOT_STARTED" });
  });

  it("TC-E03 refuses a roll or a give-in once the contest has a winner", () => {
    const won = exchange([I(11, 6), O(10, 6)]);
    const gaveIn = giveIn(exchange([I(11, 6), O(14, 8)]), "initiator").value;
    const declined = giveIn(createContest().value, "opposition").value;

    for ( const state of [won, gaveIn, declined] ) {
      expect(addContestRoll(state, O(20, 8))).toEqual({ ok: false, code: "CONTEST_RESOLVED" });
      expect(addContestRoll(state, I(20, 8))).toEqual({ ok: false, code: "CONTEST_RESOLVED" });
      expect(giveIn(state, "opposition")).toEqual({ ok: false, code: "CONTEST_RESOLVED" });
      expect(giveIn(state, "initiator")).toEqual({ ok: false, code: "CONTEST_RESOLVED" });
    }
  });

  it("TC-E05 a total raised with an extra result needs no special handling (TC-17 and TC-19)", () => {
    const iRolled = rollPool([10, 8, 4, 10], [7, 5, 3, 2]);
    const [i10, i8, i4, i10Two] = iRolled;
    const iThird = resolve(iRolled, selection({
      totalIds: [i10.id, i8.id, i4.id], effectDieIds: [i10Two.id], extraResultsPaid: 1
    }));
    expect(iThird.total).toBe(15);
    const tc17 = exchange([I(11, 6), O(13, 8), fromResolution("initiator", iThird, "roll-i2"), O(12, 6)]);
    expect(tc17).toMatchObject({ status: "won", winner: "initiator", margin: 3, heroicSteps: 0 });
    expect(decidingRolls(tc17).value.winnerRoll.effects).toEqual([{ id: "e1", size: 10 }]);

    const oRolled = rollPool([6, 6, 4, 8], [6, 5, 4, 3]);
    const [o6Six, o6Five, o4, o8] = oRolled;
    const oThird = resolve(oRolled, selection({
      totalIds: [o6Six.id, o6Five.id, o4.id], effectDieIds: [o8.id], extraResultsPaid: 1
    }));
    expect(oThird.total).toBe(15);
    const tc19 = exchange([I(11, 6), fromResolution("opposition", oThird, "roll-o1"), I(9, 6)]);
    expect(tc19).toMatchObject({ status: "won", winner: "opposition", margin: 6, heroicSteps: 1 });
    expect(decidingRolls(tc19).value.winnerRoll.effects).toEqual([{ id: "e1", size: 8 }]);
  });
});

describe("contest guards (ADR-025)", () => {
  it("refuses an unknown side", () => {
    expect(addContestRoll(createContest().value, contestRoll("gm", 11, [6]))).toEqual({ ok: false, code: "INVALID_SIDE" });
    expect(giveIn(exchange([I(11, 6)]), "both")).toEqual({ ok: false, code: "INVALID_SIDE" });
    expect(giveIn(exchange([I(11, 6)]))).toEqual({ ok: false, code: "INVALID_SIDE" });
  });

  it("refuses a total that isn't a whole number of 0 or more, and accepts a botch's 0", () => {
    for ( const bad of [-1, 2.5, "11", null, undefined, Number.NaN] ) {
      expect(addContestRoll(createContest().value, I(bad, 6))).toEqual({ ok: false, code: "INVALID_TOTAL" });
    }
    expect(exchange([I(0, 4), O(1, 4)])).toMatchObject({ status: "open", difficulty: 1, turn: "initiator" });
  });

  it("refuses an effect die of a size that doesn't exist, or two effect dice with the same id", () => {
    expect(addContestRoll(createContest().value, I(11, 7))).toEqual({ ok: false, code: "INVALID_DIE_SIZE" });
    const twice = { ...I(11), effects: [{ id: "e1", size: 8 }, { id: "e1", size: 6 }] };
    expect(addContestRoll(createContest().value, twice)).toEqual({ ok: false, code: "DUPLICATE_EFFECT_DIE" });
  });

  it("accepts a roll with no effect dice, such as a typed total (ADR-021)", () => {
    const typed = { side: "initiator", total: 11 };
    const state = addContestRoll(createContest().value, typed).value;
    expect(state.rolls).toEqual([{
      side: "initiator", total: 11, effects: [], overflows: [], leftovers: [], nextEffectNumber: 1, messageRef: null
    }]);
  });

  it("refuses an overflow already answered with a second effect die, and one that names a missing effect die (RQ-018)", () => {
    const withD6 = { ...I(15, 12, 6), overflows: [{ effectId: "e1", kind: "new-d6" }] };
    expect(addContestRoll(createContest().value, withD6))
      .toEqual({ ok: false, code: "CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE" });

    const missing = { ...I(15, 12, 6), overflows: [{ effectId: "e3", kind: "new-d6" }] };
    expect(addContestRoll(createContest().value, missing)).toEqual({ ok: false, code: "EFFECT_DIE_NOT_FOUND" });
  });

  it("refuses a roll that already chose the overflow take-out during the exchange (RQ-018)", () => {
    const takeOut = { ...I(15, 12), overflows: [{ effectId: "e1", kind: "take-out" }] };
    expect(addContestRoll(createContest().value, takeOut))
      .toEqual({ ok: false, code: "CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE" });
  });

  it("closing refuses every later roll and give-in, and can't be done twice", () => {
    const closed = closeContest(exchange([I(11, 6)]));
    expect(closed.value).toMatchObject({ closed: true, status: "open" });
    expect(addContestRoll(closed.value, O(13, 8))).toEqual({ ok: false, code: "CONTEST_CLOSED" });
    expect(giveIn(closed.value, "opposition")).toEqual({ ok: false, code: "CONTEST_CLOSED" });
    expect(closeContest(closed.value)).toEqual({ ok: false, code: "CONTEST_CLOSED" });

    const closedAfterWin = closeContest(exchange([I(11, 6), O(10, 6)])).value;
    expect(addContestRoll(closedAfterWin, I(20, 8))).toEqual({ ok: false, code: "CONTEST_CLOSED" });
    expect(decidingRolls(closedAfterWin).value.winnerRoll.total).toBe(11);
  });

  it("has no deciding rolls while the contest is still open", () => {
    expect(decidingRolls(createContest().value)).toEqual({ ok: false, code: "CONTEST_NOT_RESOLVED" });
    expect(decidingRolls(exchange([I(11, 6), O(13, 8)]))).toEqual({ ok: false, code: "CONTEST_NOT_RESOLVED" });
  });
});

describe("an overflow during the exchange (rule 21, RQ-018)", () => {
  /**
   * TC-32's pool roll: d10:7, d8:6, d12:5, d4:3, total d10 + d8 = 13, effect die d12 (e1), the d4
   * left over; an SFX then steps e1 past d12, which leaves its overflow choice pending.
   */
  function tc32PoolRoll() {
    const rolled = rollPool([10, 8, 12, 4], [7, 6, 5, 3]);
    const [d10, d8, d12, d4] = rolled;
    const resolution = resolve(rolled, selection({ totalIds: [d10.id, d8.id], effectDieIds: [d12.id] }));
    expect(resolution.total).toBe(13);
    const pastD12 = stepEffectDie(rolled, resolution, "e1", 1, "other");
    expect(pastD12.overflow).toMatchObject({ effectId: "e1", cause: "other" });
    return { rolled, resolution: pastD12, d4 };
  }

  /** @returns {import("../../module/rules/types.mjs").ContestRoll} TC-32's contest roll, overflow open */
  function tc32Roll() {
    const { d4 } = tc32PoolRoll();
    return {
      side: "initiator",
      total: 13,
      effects: [{ id: "e1", size: 12 }],
      overflows: [{ effectId: "e1", cause: "other", kind: null, dieId: null }],
      leftovers: [{ dieId: d4.id, size: 4 }],
      nextEffectNumber: 2,
      messageRef: "roll-i1"
    };
  }

  it("TC-32 a pool roll whose d12 effect die went past d12 becomes a contest roll with the overflow open, the d4 left over and next effect number 2", () => {
    const { rolled, resolution } = tc32PoolRoll();
    expect(contestRollFromResolution("initiator", rolled, resolution, "roll-i1")).toEqual({ ok: true, value: tc32Roll() });
  });

  it("TC-32 the roll joins the contest with its overflow still open: the difficulty is 13 and it is the opposition's turn", () => {
    const added = addContestRoll(createContest().value, tc32Roll());
    expect(added.ok).toBe(true);
    expect(added.value.rolls).toEqual([tc32Roll()]);
    expect(added.value).toMatchObject({ difficulty: 13, turn: "opposition", status: "open", winner: null });
  });

  it("TC-33 the take-out chosen during the exchange is refused", () => {
    const roll = { ...tc32Roll(), overflows: [{ effectId: "e1", cause: "other", kind: "take-out", dieId: null }] };
    expect(addContestRoll(createContest().value, roll)).toEqual({ ok: false, code: "CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE" });
  });

  it("TC-33 a new d6 chosen during the exchange is refused", () => {
    const roll = { ...tc32Roll(), overflows: [{ effectId: "e1", cause: "other", kind: "new-d6", dieId: null }] };
    expect(addContestRoll(createContest().value, roll)).toEqual({ ok: false, code: "CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE" });
  });

  it("TC-33 taking the leftover d4 during the exchange is refused", () => {
    const base = tc32Roll();
    const roll = {
      ...base, overflows: [{ effectId: "e1", cause: "other", kind: "leftover", dieId: base.leftovers[0].dieId }]
    };
    expect(addContestRoll(createContest().value, roll)).toEqual({ ok: false, code: "CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE" });
  });

  it("TC-33 a pool roll whose take-out was already chosen on its own card can't become a contest roll", () => {
    const { rolled, resolution } = tc32PoolRoll();
    const takenOut = applyOverflowChoice(rolled, resolution, { kind: "take-out" });
    expect(takenOut).toMatchObject({ takeOut: true, overflow: null });
    expect(contestRollFromResolution("initiator", rolled, takenOut, "roll-i1"))
      .toEqual({ ok: false, code: "CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE" });
  });

  it("TC-33 a pool roll whose new d6 was already chosen on its own card can't become a contest roll", () => {
    const { rolled, resolution } = tc32PoolRoll();
    const withD6 = applyOverflowChoice(rolled, resolution, { kind: "new-d6" });
    expect(withD6.effectDice).toMatchObject([{ id: "e1", size: 12 }, { id: "e2", kind: "overflow", size: 6 }]);
    expect(contestRollFromResolution("initiator", rolled, withD6, "roll-i1"))
      .toEqual({ ok: false, code: "CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE" });
  });

  it("TC-32 a roll added without its pool roll's data gets no leftovers and the number after its highest effect id", () => {
    const handBuilt = { side: "initiator", total: 11, effects: [{ id: "e1", size: 8 }, { id: "e3", size: 6 }] };
    const added = addContestRoll(createContest().value, handBuilt);
    expect(added.ok).toBe(true);
    expect(added.value.rolls).toEqual([{
      side: "initiator", total: 11, effects: [{ id: "e1", size: 8 }, { id: "e3", size: 6 }], overflows: [],
      leftovers: [], nextEffectNumber: 4, messageRef: null
    }]);
  });
});

describe("typed totals and high stakes (Step 4.4)", () => {
  /**
   * @template T
   * @param {import("../../module/rules/types.mjs").EngineResult<T>} result
   * @param {string} label
   * @returns {T} the value, failing the test on a refusal
   */
  function unwrapped(result, label) {
    expect(result, label).toMatchObject({ ok: true });
    return result.value;
  }

  /**
   * @param {'initiator'|'opposition'} side
   * @param {number} total
   * @param {number[]} [sizes] - typed effect dice
   * @returns {import("../../module/rules/types.mjs").ContestRoll} a roll typed by hand
   */
  function typed(side, total, sizes) {
    return unwrapped(contestRollFromTotal(side, total, sizes), `typed ${side} ${total}`);
  }

  /**
   * TC-54: I types 11, O rolls 13 (effect die d8), and I types 12 with `lastSizes` as its typed
   * effect dice, which fails: O wins by 1.
   * @param {{highStakes?: boolean, lastSizes?: number[]}} [options]
   * @returns {import("../../module/rules/types.mjs").ContestState}
   */
  function tc54({ highStakes = false, lastSizes = [] } = {}) {
    const state = exchange([typed("initiator", 11), O(13, 8), typed("initiator", 12, lastSizes)], { highStakes });
    expect(state).toMatchObject({ status: "won", winner: "opposition", margin: 1, heroicSteps: 0 });
    return state;
  }

  it("TC-54 a typed roll has no effect die, so O's d8 isn't limited: a d8 complication in a normal scene", () => {
    expect(contestRollFromTotal("initiator", 11)).toEqual({
      ok: true,
      value: { side: "initiator", total: 11, effects: [], overflows: [], leftovers: [], nextEffectNumber: 1, messageRef: null }
    });
    const consequence = unwrapped(contestConsequence(tc54(), { usedAgainstLoser: ["e1"] }), "consequence");
    expect(consequence.comparisons).toEqual([
      { effectId: "e1", winnerDie: 8, loserDie: null, steppedDown: false, complication: 8, takesOut: false }
    ]);
    expect(consequence.takenOut).toBe(false);
  });

  it("TC-54 in a high-stakes scene I is taken out, and a PP would give a d8 complication instead", () => {
    const consequence = unwrapped(contestConsequence(tc54({ highStakes: true }), { usedAgainstLoser: ["e1"] }), "consequence");
    expect(consequence).toMatchObject({
      takenOut: true, takeOutCause: "comparison", avoidWithPP: [{ effectId: "e1", size: 8 }]
    });
  });

  it("TC-54b I's typed 12 with a d10: d8 against d10 is stepped down to a d6 complication", () => {
    expect(contestRollFromTotal("initiator", 12, [10])).toEqual({
      ok: true,
      value: {
        side: "initiator", total: 12, effects: [{ id: "e1", size: 10 }], overflows: [], leftovers: [],
        nextEffectNumber: 2, messageRef: null
      }
    });
    const consequence = unwrapped(contestConsequence(tc54({ lastSizes: [10] }), { usedAgainstLoser: ["e1"] }), "consequence");
    expect(consequence.comparisons).toEqual([
      { effectId: "e1", winnerDie: 8, loserDie: 10, steppedDown: true, complication: 6, takesOut: false }
    ]);
  });

  it("TC-54b in a high-stakes scene I isn't taken out: a d8 complication", () => {
    const state = tc54({ highStakes: true, lastSizes: [10] });
    const consequence = unwrapped(contestConsequence(state, { usedAgainstLoser: ["e1"] }), "consequence");
    expect(consequence.comparisons).toEqual([
      { effectId: "e1", winnerDie: 8, loserDie: 10, steppedDown: false, complication: 8, takesOut: false }
    ]);
    expect(consequence.takenOut).toBe(false);
  });

  it("TC-51 high stakes on turns TC-24's d10 against d6 into a take-out, and off again into a d10 complication", () => {
    const state = exchange([I(15, 10), O(12, 6)]);
    expect(state).toMatchObject({ status: "won", winner: "initiator", margin: 3, heroicSteps: 0, highStakes: false });
    expect(unwrapped(contestConsequence(state, { usedAgainstLoser: ["e1"] }), "normal")).toMatchObject({
      takenOut: false, comparisons: [{ effectId: "e1", complication: 10, takesOut: false }]
    });

    const on = unwrapped(setContestHighStakes(state, true), "high stakes on");
    expect(on.highStakes).toBe(true);
    expect(unwrapped(contestConsequence(on, { usedAgainstLoser: ["e1"] }), "high stakes")).toMatchObject({
      takenOut: true, avoidWithPP: [{ effectId: "e1", size: 10 }]
    });

    const off = unwrapped(setContestHighStakes(on, false), "high stakes off");
    expect(off.highStakes).toBe(false);
    expect(unwrapped(contestConsequence(off, { usedAgainstLoser: ["e1"] }), "normal again")).toMatchObject({
      takenOut: false, comparisons: [{ effectId: "e1", complication: 10, takesOut: false }]
    });
  });

  it("TC-E11 a high-stakes value that isn't true or false is refused; a closed contest refuses first with CONTEST_CLOSED", () => {
    const state = exchange([I(15, 10), O(12, 6)]);
    for ( const bad of ["true", 1, null] ) {
      expect(setContestHighStakes(state, bad), `value ${bad}`).toEqual({ ok: false, code: "INVALID_HIGH_STAKES" });
    }
    const closed = unwrapped(closeContest(state), "close");
    expect(setContestHighStakes(closed, "true")).toEqual({ ok: false, code: "CONTEST_CLOSED" });
  });
});
