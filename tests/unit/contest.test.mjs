import { describe, expect, it } from "vitest";
import { addContestRoll, closeContest, createContest, decidingRolls, giveIn } from "../../module/rules/contest.mjs";
import { buildPool } from "../../module/rules/pool.mjs";
import { applyResults, resolve, unrolledEffectDie } from "../../module/rules/roll.mjs";

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
 * contest copies them from a confirmed poolRoll (ADR-027).
 * @param {'initiator'|'opposition'} side
 * @param {number} total
 * @param {number[]} sizes
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
 * A contest roll copied from a Resolution of the dice engine.
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
    overflow: null,
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
        winnerRoll: { side: "initiator", total: 11, effects: [{ id: "e1", size: 6 }], overflow: null, messageRef: "roll-i1" },
        loserRoll: { side: "opposition", total: 10, effects: [{ id: "e1", size: 6 }], overflow: null, messageRef: "roll-o1" }
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
    expect(state.rolls).toEqual([{ side: "initiator", total: 11, effects: [], overflow: null, messageRef: null }]);
  });

  it("keeps an overflow answered with a second effect die, and refuses one that names a missing effect die", () => {
    const withD6 = { ...I(15, 12, 6), overflow: { effectId: "e1", kind: "new-d6" } };
    expect(addContestRoll(createContest().value, withD6).value.rolls[0].overflow).toEqual({ effectId: "e1", kind: "new-d6" });

    const missing = { ...I(15, 12, 6), overflow: { effectId: "e3", kind: "new-d6" } };
    expect(addContestRoll(createContest().value, missing)).toEqual({ ok: false, code: "EFFECT_DIE_NOT_FOUND" });
  });

  it("refuses a roll that already chose the overflow take-out, until RQ-018 (proposed) is decided", () => {
    const takeOut = { ...I(15, 12), overflow: { effectId: "e1", kind: "take-out" } };
    expect(addContestRoll(createContest().value, takeOut)).toEqual({ ok: false, code: "CONTEST_TAKE_OUT_IN_EXCHANGE" });
  });

  it.todo("RQ-018 (proposed): what an overflow take-out chosen during the exchange does to the contest");

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
