import { describe, expect, it } from "vitest";
import {
  addContestRoll, addTestRoll, applyContestHeroicSteps, applyResults, applyTestHeroicSteps,
  autoApplyContestHeroicSteps, buildPool, chooseContestOverflow, closeContest, closeTest, contestRollFromResolution,
  contestRollFromTotal, createContest, createTest, dispatchContestRequest, giveIn, liveOverflowIds, offeredEndChoices,
  resolve, stepEffectDie
} from "../../module/rules/index.mjs";

/** Fake ids in Foundry's 16-character format. */
const P1 = "playerOne0000001";
const P2 = "playerTwo0000001";
const P3 = "playerThree00001";
const GM_ID = "gameMaster000001";
const MESSAGE = "contestCard00001";
const CARD_I = "rollCardI0000001";
const CARD_O = "rollCardO0000001";
const CARD_R = "rollCardR0000001";

/** The senders: the GM, the two players, and a player on no side. */
const GM = Object.freeze({ userId: GM_ID, isGM: true });
const PLAYER_ONE = Object.freeze({ userId: P1, isGM: false });
const PLAYER_TWO = Object.freeze({ userId: P2, isGM: false });
const STRANGER = Object.freeze({ userId: P3, isGM: false });
const EVERYONE = Object.freeze([GM, PLAYER_ONE, PLAYER_TWO, STRANGER]);

/** What a sender with no end choice to make is offered. */
const NOTHING = Object.freeze({ heroic: null, overflows: [], pick: null });

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

/** Freezes an object and everything inside it. */
function deepFreeze(value) {
  if ( value && (typeof value === "object") && !Object.isFrozen(value) ) {
    Object.freeze(value);
    for ( const inner of Object.values(value) ) deepFreeze(inner);
  }
  return value;
}

/** @returns {Set<object>} every object reachable from `value`, itself included */
function objectsIn(value, found = new Set()) {
  if ( value && (typeof value === "object") && !found.has(value) ) {
    found.add(value);
    for ( const inner of Object.values(value) ) objectsIn(inner, found);
  }
  return found;
}

/** A contest record between the two players: P1 initiates, P2 opposes. */
function pvp(state, revision = 0) {
  return {
    type: "contest", revision, state,
    sides: [
      { key: "initiator", userId: P1, actorUuid: null, label: "Ayla" },
      { key: "opposition", userId: P2, actorUuid: null, label: "Bren" }
    ]
  };
}

/** A test record: P1 rolls, P2 set the difficulty. */
function testRecord(state, revision = 0) {
  return {
    type: "test", revision, state,
    sides: [
      { key: "roller", userId: P1, actorUuid: null, label: "Ayla" },
      { key: "setter", userId: P2, actorUuid: null, label: "Bren" }
    ]
  };
}

/**
 * Rolls `sizes` with `results` and confirms the dice at `totalAt` as the total and those at
 * `effectAt` as effect dice.
 * @returns {{rolled: object[], resolution: object}}
 */
function confirmRoll(sizes, results, totalAt, effectAt, extraEffectDicePaid = 0) {
  const pool = buildPool(sizes.map((size, i) => ({ size, source: { kind: "trait", label: `Die ${i + 1}` } })));
  const rolled = applyResults(pool, results);
  const resolution = resolve(rolled, {
    totalIds: totalAt.map(i => rolled[i].id), effectDieIds: effectAt.map(i => rolled[i].id),
    extraResultsPaid: 0, extraEffectDicePaid
  });
  return { rolled, resolution };
}

/** A confirmed roll whose effect die e1 an SFX then steps past d12, leaving its choice open. */
function pastD12(sizes, results, totalAt, effectAt, extraEffectDicePaid = 0) {
  const { rolled, resolution } = confirmRoll(sizes, results, totalAt, effectAt, extraEffectDicePaid);
  const stepped = stepEffectDie(rolled, resolution, "e1", 1, "other");
  expect(stepped.overflow).toMatchObject({ effectId: "e1" });
  return { rolled, resolution: stepped };
}

/** The engine's own copy of a confirmed roll card's roll. */
function fromCard(side, { rolled, resolution }, messageRef) {
  return unwrap(contestRollFromResolution(side, rolled, resolution, messageRef), `${side} from ${messageRef}`);
}

/** @returns {object} the ContestRoll for a typed total with typed effect dice (ADR-021) */
function typed(side, total, ...sizes) {
  return unwrap(contestRollFromTotal(side, total, sizes), `typed ${total}`);
}

/**
 * Starts a contest and adds the rolls in order, with the automatic heroic steps the relay applies
 * after each roll (ADR-023).
 */
function exchange(rolls) {
  let state = unwrap(createContest(), "createContest");
  for ( const roll of rolls ) {
    state = unwrap(addContestRoll(state, roll), `${roll.side} ${roll.total}`);
    state = unwrap(autoApplyContestHeroicSteps(state), "automatic steps");
  }
  return state;
}

/** Starts a test and adds its roll, without the automatic steps. */
function testWith(difficulty, roll) {
  return unwrap(addTestRoll(unwrap(createTest({ difficulty }), "createTest"), roll), "addTestRoll");
}

/** TC-17: I 11 → O 13 → I 15 (d10) → O 12 fails; the initiator wins by 3. */
const tc17 = () => exchange([
  typed("initiator", 11, 6), typed("opposition", 13, 8), typed("initiator", 15, 10), typed("opposition", 12, 6)
]);

/** TC-32: I 13 with e1 (d12) past d12 and the d4 left over; the opposition hasn't rolled. */
const tc32 = () => exchange([fromCard("initiator", pastD12([10, 8, 12, 4], [7, 6, 5, 3], [0, 1], [2]), CARD_I)]);

/** TC-34: TC-32's roll → O 15 → I 17 (d10) → O 14 fails; the open overflow is on a beaten roll. */
const tc34 = () => exchange([
  fromCard("initiator", pastD12([10, 8, 12, 4], [7, 6, 5, 3], [0, 1], [2]), CARD_I), typed("opposition", 15, 8),
  typed("initiator", 17, 10), typed("opposition", 14, 6)
]);

/** TC-35: I 15 (d8) → O 12 fails, with O's d12 effect die pushed past d12 during the exchange. */
const tc35 = () => exchange([
  typed("initiator", 15, 8), fromCard("opposition", pastD12([12, 8, 6], [5, 7, 5], [1, 2], [0]), CARD_O)
]);

/** TC-36: I 15 with e1 past d12 (open) and the d4 left over → O 12 (d8) fails; won by 3. */
const tc36 = () => exchange([
  fromCard("initiator", pastD12([10, 8, 12, 4], [8, 7, 5, 3], [0, 1], [2]), CARD_I), typed("opposition", 12, 8)
]);

/** TC-37: I 17 with d8 (e1) and d6 (e2) → O 12 (d8) fails; won by 5, one step to place. */
const tc37 = () => exchange([typed("initiator", 17, 8, 6), typed("opposition", 12, 8)]);

/** TC-38: I 17 with d12 (e1) and a d8 left over → O 12 fails; the automatic step takes e1 past d12. */
const tc38 = () => exchange([
  fromCard("initiator", confirmRoll([12, 10, 8, 8], [2, 9, 8, 3], [1, 2], [0]), CARD_I), typed("opposition", 12, 8)
]);

/** TC-39: I 17 with e1 (d12, past d12 during the exchange) and e2 (d6) → O 12 fails; won by 5. */
const tc39 = () => exchange([
  fromCard("initiator", pastD12([10, 8, 12, 6], [9, 8, 2, 3], [0, 1], [2, 3], 1), CARD_I), typed("opposition", 12, 8)
]);

/** TC-E08: I 17 with two d12 effect dice, e1 past d12 during the exchange → O 12 fails; one step to place. */
const tcE08 = () => exchange([
  fromCard("initiator", pastD12([10, 8, 12, 12], [9, 8, 2, 3], [0, 1], [2, 3], 1), CARD_I), typed("opposition", 12, 8)
]);

/** TC-40: TC-32's roll, then the opposition declines. */
const tc40Declined = () => unwrap(giveIn(tc32(), "opposition"), "decline");

/** TC-40: I 11 → O 14 with its d12 past d12 and nothing left over → I gives in. */
const tc40GaveIn = () => unwrap(giveIn(exchange([
  typed("initiator", 11, 6), fromCard("opposition", pastD12([12, 10, 8], [5, 7, 7], [1, 2], [0]), CARD_O)
]), "initiator"), "give in");

/** TC-41: I types 18 with no effect dice → O 12 fails; the heroic step lapses. */
const tc41 = () => exchange([typed("initiator", 18), typed("opposition", 12, 8)]);

/** TC-47: I 17 (d8) → O 12 fails; the step went on e1 automatically. */
const tc47 = () => exchange([typed("initiator", 17, 8), typed("opposition", 12, 8)]);

/** TC-13's test: difficulty 7, two d6 effect dice, margin 7; one step to place. */
const tc13 = () => testWith(7, typed("roller", 14, 6, 6));

/** TC-42 with a difficulty of 14: e1 past d12 (open), the d4 left over, margin 3. */
const tc42 = () => testWith(14, fromCard("roller", pastD12([12, 10, 8, 4], [3, 9, 8, 2], [1, 2], [0]), CARD_R));

/** TC-44: difficulty 13, a 14 with a d6; nothing waits. */
const tc44 = () => testWith(13, typed("roller", 14, 6));

/** TC-48: difficulty 8; e1 (d12, past d12, open) and e2 (d6); margin 9, one step to place. */
const tc48 = () => testWith(8, fromCard("roller", pastD12([10, 8, 12, 6], [9, 8, 2, 3], [0, 1], [2, 3], 1), CARD_R));

/** TC-49: difficulty 8; e1 (d12, past d12, open) and e2 (d12); margin 9, one step to place. */
const tc49 = () => testWith(8, fromCard("roller", pastD12([10, 8, 12, 12], [9, 8, 2, 3], [0, 1], [2, 3], 1), CARD_R));

/** TC-55: difficulty 15; a 13 with e1 past d12: a failure, so the overflow lapses. */
const tc55 = () => testWith(15, fromCard("roller", pastD12([12, 10, 8, 4], [3, 7, 6, 2], [1, 2], [0]), CARD_R));

/** A request envelope carrying the record's own revision. */
function send(sender, contest, action, payload) {
  return dispatchContestRequest({
    sender, contest, request: { action, messageId: MESSAGE, revision: contest.revision, payload }
  });
}

/** The roll the end choices are made on: the winner's last roll, or a test's roll. */
function finalRoll(record) {
  if ( record.type === "test" ) return record.state.roll;
  return record.state.rolls.findLast(roll => roll.side === record.state.winner) ?? null;
}

describe("the end choices a contest's card offers (offeredEndChoices; ADR-027, Step 4.4 S4b proposal review)", () => {
  it("TC-37 the heroic steps wait: the winner's user and the GM pick the die; nothing else is offered yet", () => {
    const record = pvp(tc37());
    for ( const sender of [PLAYER_ONE, GM] ) {
      expect(offeredEndChoices(sender, record), sender.userId).toEqual({
        heroic: { steps: 1, effectIds: ["e1", "e2"] }, overflows: [], pick: null
      });
    }
    for ( const sender of [PLAYER_TWO, STRANGER] ) expect(offeredEndChoices(sender, record), sender.userId).toEqual(NOTHING);
  });

  it("TC-37 once the steps are applied, the pick against the loser is offered", () => {
    const record = pvp(unwrap(applyContestHeroicSteps(tc37(), "e2"), "steps"));
    expect(offeredEndChoices(PLAYER_ONE, record)).toEqual({ ...NOTHING, pick: { effectIds: ["e1", "e2"] } });
    expect(offeredEndChoices(PLAYER_TWO, record)).toEqual(NOTHING);
  });

  it("TC-47 with one effect die the steps were applied with the roll, so only the pick is offered", () => {
    const record = pvp(tc47());
    expect(record.state.heroicAppliedTo).toBe("e1");
    expect(offeredEndChoices(PLAYER_ONE, record)).toEqual({ ...NOTHING, pick: { effectIds: ["e1"] } });
    expect(offeredEndChoices(GM, record)).toEqual({ ...NOTHING, pick: { effectIds: ["e1"] } });
  });

  it("TC-17 a win without heroic steps: the pick for the winner's user and the GM, nothing for the others", () => {
    const record = pvp(tc17());
    for ( const sender of [PLAYER_ONE, GM] ) {
      expect(offeredEndChoices(sender, record), sender.userId).toEqual({ ...NOTHING, pick: { effectIds: ["e1"] } });
    }
    for ( const sender of [PLAYER_TWO, STRANGER] ) expect(offeredEndChoices(sender, record), sender.userId).toEqual(NOTHING);
  });

  it("TC-36 an open overflow: the leftover d4, a new d6 and the take-out; the pick waits for the choice", () => {
    const record = pvp(tc36());
    const leftover = record.state.rolls[0].leftovers[0];
    expect(leftover.size).toBe(4);
    expect(offeredEndChoices(PLAYER_ONE, record)).toEqual({
      heroic: null, pick: null,
      overflows: [{ effectId: "e1", leftovers: [{ dieId: leftover.dieId, size: 4 }], newDie: 6, takeOut: true }]
    });
    expect(offeredEndChoices(PLAYER_TWO, record)).toEqual(NOTHING);

    const chosen = pvp(unwrap(chooseContestOverflow(tc36(), { kind: "new-d6" }), "new d6"));
    expect(offeredEndChoices(PLAYER_ONE, chosen)).toEqual({ ...NOTHING, pick: { effectIds: ["e1", "e2"] } });
  });

  it("TC-38 a step that takes the only effect die past d12 opens its choice, with the leftover d8", () => {
    const record = pvp(tc38());
    expect(offeredEndChoices(PLAYER_ONE, record)).toEqual({
      heroic: null, pick: null,
      overflows: [{ effectId: "e1", leftovers: [expect.objectContaining({ size: 8 })], newDie: 6, takeOut: true }]
    });
  });

  it("TC-39 the heroic steps come before an overflow from the exchange (RQ-023)", () => {
    const record = pvp(tc39());
    expect(offeredEndChoices(PLAYER_ONE, record)).toEqual({
      heroic: { steps: 1, effectIds: ["e1", "e2"] }, overflows: [], pick: null
    });
    const joined = pvp(unwrap(applyContestHeroicSteps(tc39(), "e1"), "steps on e1"));
    expect(offeredEndChoices(PLAYER_ONE, joined)).toEqual({
      heroic: null, pick: null, overflows: [{ effectId: "e1", leftovers: [], newDie: 6, takeOut: true }]
    });
  });

  it("TC-E08 two dice past d12: each gets its own entry, named by its effect id", () => {
    const record = pvp(unwrap(applyContestHeroicSteps(tcE08(), "e2"), "steps on e2"));
    expect(offeredEndChoices(GM, record)).toEqual({
      heroic: null, pick: null,
      overflows: [
        { effectId: "e1", leftovers: [], newDie: 6, takeOut: true },
        { effectId: "e2", leftovers: [], newDie: 6, takeOut: true }
      ]
    });
  });

  it("TC-40 after a decline or giving in: a second effect die only, no take-out, and no pick (RQ-024)", () => {
    const declined = pvp(tc40Declined());
    expect(offeredEndChoices(PLAYER_ONE, declined)).toEqual({
      heroic: null, pick: null,
      overflows: [{ effectId: "e1", leftovers: [expect.objectContaining({ size: 4 })], newDie: 6, takeOut: false }]
    });
    const gaveIn = pvp(tc40GaveIn());
    expect(offeredEndChoices(PLAYER_TWO, gaveIn)).toEqual({
      heroic: null, pick: null, overflows: [{ effectId: "e1", leftovers: [], newDie: 6, takeOut: false }]
    });
    expect(offeredEndChoices(PLAYER_ONE, gaveIn)).toEqual(NOTHING);

    const answered = pvp(unwrap(chooseContestOverflow(tc40Declined(), { kind: "new-d6" }), "new d6"));
    expect(offeredEndChoices(PLAYER_ONE, answered)).toEqual(NOTHING);
  });

  it("TC-41 a winner with no effect die is offered nothing: the steps lapse and there is nothing to pick (RQ-025)", () => {
    for ( const sender of EVERYONE ) expect(offeredEndChoices(sender, pvp(tc41())), sender.userId).toEqual(NOTHING);
  });

  it("an open contest, a closed one and a missing record offer nothing", () => {
    const open = pvp(exchange([typed("initiator", 11, 6)]));
    const closed = pvp(unwrap(closeContest(tc37()), "close"));
    for ( const sender of EVERYONE ) {
      expect(offeredEndChoices(sender, open), sender.userId).toEqual(NOTHING);
      expect(offeredEndChoices(sender, closed), sender.userId).toEqual(NOTHING);
      expect(offeredEndChoices(sender, null), sender.userId).toEqual(NOTHING);
    }
  });
});

describe("the end choices a test's card offers (offeredEndChoices)", () => {
  it("TC-13 the roller's user and the GM pick the die for the step; the setter's user doesn't", () => {
    const record = testRecord(tc13());
    for ( const sender of [PLAYER_ONE, GM] ) {
      expect(offeredEndChoices(sender, record), sender.userId).toEqual({
        heroic: { steps: 1, effectIds: ["e1", "e2"] }, overflows: [], pick: null
      });
    }
    for ( const sender of [PLAYER_TWO, STRANGER] ) expect(offeredEndChoices(sender, record), sender.userId).toEqual(NOTHING);
  });

  it("TC-42 an open overflow on a successful test: the leftover d4, a new d6 and the take-out or victory", () => {
    expect(offeredEndChoices(PLAYER_ONE, testRecord(tc42()))).toEqual({
      heroic: null, pick: null,
      overflows: [{ effectId: "e1", leftovers: [expect.objectContaining({ size: 4 })], newDie: 6, takeOut: true }]
    });
  });

  it("TC-48 the steps first, then the overflow (RQ-026)", () => {
    expect(offeredEndChoices(PLAYER_ONE, testRecord(tc48()))).toEqual({
      heroic: { steps: 1, effectIds: ["e1", "e2"] }, overflows: [], pick: null
    });
    const stepped = testRecord(unwrap(applyTestHeroicSteps(tc48(), "e2"), "steps on e2"));
    expect(offeredEndChoices(PLAYER_ONE, stepped)).toEqual({
      heroic: null, pick: null, overflows: [{ effectId: "e1", leftovers: [], newDie: 6, takeOut: true }]
    });
  });

  it("TC-49 two dice past d12 in a test: two entries", () => {
    const stepped = testRecord(unwrap(applyTestHeroicSteps(tc49(), "e2"), "steps on e2"));
    expect(offeredEndChoices(PLAYER_ONE, stepped).overflows.map(o => o.effectId)).toEqual(["e1", "e2"]);
  });

  it("TC-55 a failed test offers nothing: its open overflow has lapsed (RQ-028)", () => {
    for ( const sender of EVERYONE ) expect(offeredEndChoices(sender, testRecord(tc55())), sender.userId).toEqual(NOTHING);
  });

  it("TC-44 a test with nothing waiting, a test without its roll and a closed test offer nothing; a test has no pick", () => {
    const fresh = unwrap(createTest({ difficulty: 13 }), "createTest");
    for ( const state of [tc44(), fresh, unwrap(closeTest(tc13()), "close")] ) {
      for ( const sender of EVERYONE ) expect(offeredEndChoices(sender, testRecord(state)), sender.userId).toEqual(NOTHING);
    }
  });
});

describe("the offer agrees with the dispatcher: no end choice is offered that the relay would refuse", () => {
  /** Every record the tests above use, each at revision 3. */
  const records = () => [
    ["TC-17", pvp(tc17(), 3)],
    ["TC-36", pvp(tc36(), 3)],
    ["TC-37", pvp(tc37(), 3)],
    ["TC-37 with the steps applied", pvp(unwrap(applyContestHeroicSteps(tc37(), "e1"), "steps"), 3)],
    ["TC-38", pvp(tc38(), 3)],
    ["TC-39", pvp(tc39(), 3)],
    ["TC-E08 with the steps applied", pvp(unwrap(applyContestHeroicSteps(tcE08(), "e2"), "steps"), 3)],
    ["TC-40 declined", pvp(tc40Declined(), 3)],
    ["TC-40 given in", pvp(tc40GaveIn(), 3)],
    ["TC-41", pvp(tc41(), 3)],
    ["TC-47", pvp(tc47(), 3)],
    ["a closed contest", pvp(unwrap(closeContest(tc37()), "close"), 3)],
    ["TC-13", testRecord(tc13(), 3)],
    ["TC-42", testRecord(tc42(), 3)],
    ["TC-48", testRecord(tc48(), 3)],
    ["TC-55", testRecord(tc55(), 3)]
  ];

  it.each(records())("%s: the heroic steps", (_name, record) => {
    for ( const sender of EVERYONE ) {
      const { heroic } = offeredEndChoices(sender, record);
      const ids = heroic ? heroic.effectIds : (finalRoll(record)?.effects ?? []).map(e => e.id);
      for ( const effectId of ids ) {
        expect(send(sender, record, "apply-heroic-steps", { effectId }).ok, `${sender.userId} ${effectId}`)
          .toBe(heroic !== null);
      }
    }
  });

  it.each(records())("%s: the overflow choice", (_name, record) => {
    for ( const sender of EVERYONE ) {
      const { overflows } = offeredEndChoices(sender, record);
      if ( overflows.length === 0 ) {
        for ( const open of (finalRoll(record)?.overflows ?? []).filter(o => o.kind === null) ) {
          expect(send(sender, record, "choose-overflow", { effectId: open.effectId, kind: "new-d6" }).ok, sender.userId)
            .toBe(false);
        }
        continue;
      }
      for ( const { effectId, leftovers, takeOut } of overflows ) {
        expect(send(sender, record, "choose-overflow", { effectId, kind: "new-d6" }).ok, `${effectId} new d6`).toBe(true);
        expect(send(sender, record, "choose-overflow", { effectId, kind: "take-out" }).ok, `${effectId} take-out`)
          .toBe(takeOut);
        for ( const { dieId } of leftovers ) {
          expect(send(sender, record, "choose-overflow", { effectId, kind: "leftover", dieId }).ok, `${effectId} ${dieId}`)
            .toBe(true);
        }
      }
    }
  });

  it.each(records().filter(([, record]) => record.type === "contest"))("%s: the pick against the loser", (_name, record) => {
    for ( const sender of EVERYONE ) {
      const { pick } = offeredEndChoices(sender, record);
      if ( pick ) {
        expect(send(sender, record, "use-against-loser", { effectIds: pick.effectIds }), sender.userId)
          .toMatchObject({ ok: true });
        expect(send(sender, record, "use-against-loser", { effectIds: [] }).ok, `${sender.userId} none`).toBe(true);
        continue;
      }
      const effectIds = (finalRoll(record)?.effects ?? []).map(e => e.id);
      if ( (record.state.status === "won") && (effectIds.length > 0) ) {
        expect(send(sender, record, "use-against-loser", { effectIds }).ok, sender.userId).toBe(false);
      }
    }
  });
});

describe("which overflows can still be chosen (liveOverflowIds; RQ-018, RQ-028)", () => {
  it("TC-32 while a contest is open, the standing roll's open overflow is live", () => {
    expect(liveOverflowIds(pvp(tc32()))).toEqual([["e1"]]);
  });

  it("TC-34 an open overflow on a beaten roll has lapsed, during the exchange and at the end", () => {
    const beaten = exchange([
      fromCard("initiator", pastD12([10, 8, 12, 4], [7, 6, 5, 3], [0, 1], [2]), CARD_I), typed("opposition", 15, 8)
    ]);
    expect(liveOverflowIds(pvp(beaten))).toEqual([[], []]);
    expect(liveOverflowIds(pvp(tc34()))).toEqual([[], [], [], []]);
  });

  it("TC-35 an open overflow on the loser's roll has lapsed", () => {
    expect(liveOverflowIds(pvp(tc35()))).toEqual([[], []]);
  });

  it("TC-36 the winner's last roll keeps its overflow live until the choice is made", () => {
    expect(liveOverflowIds(pvp(tc36()))).toEqual([["e1"], []]);
    expect(liveOverflowIds(pvp(unwrap(chooseContestOverflow(tc36(), { kind: "take-out" }), "take-out")))).toEqual([[], []]);
  });

  it("TC-E08 two live overflows on one roll", () => {
    const state = unwrap(applyContestHeroicSteps(tcE08(), "e2"), "steps on e2");
    expect(liveOverflowIds(pvp(state))).toEqual([["e1", "e2"], []]);
  });

  it("TC-40 after a decline the winner's overflow is still live", () => {
    expect(liveOverflowIds(pvp(tc40Declined()))).toEqual([["e1"]]);
  });

  it("TC-42 a successful test's overflow is live; TC-55 a failed test's has lapsed", () => {
    expect(liveOverflowIds(testRecord(tc42()))).toEqual([["e1"]]);
    expect(liveOverflowIds(testRecord(tc55()))).toEqual([[]]);
  });

  it("a closed card has no live overflow, since nothing on it can be chosen any more", () => {
    expect(liveOverflowIds(pvp(unwrap(closeContest(tc36()), "close")))).toEqual([[], []]);
    expect(liveOverflowIds(testRecord(unwrap(closeTest(tc42()), "close")))).toEqual([[]]);
  });

  it("one list per roll: none for a test without its roll or a contest without rolls, and none for a missing record", () => {
    expect(liveOverflowIds(testRecord(unwrap(createTest({ difficulty: 13 }), "createTest")))).toEqual([]);
    expect(liveOverflowIds(pvp(unwrap(createContest(), "createContest")))).toEqual([]);
    expect(liveOverflowIds(testRecord(tc44()))).toEqual([[]]);
    expect(liveOverflowIds(null)).toEqual([]);
  });
});

describe("offeredEndChoices and liveOverflowIds: frozen inputs", () => {
  it("frozen inputs are left alone, and the answers share no object with them", () => {
    for ( const record of [pvp(tc36()), pvp(tc37()), pvp(tc47()), testRecord(tc42()), testRecord(tc13())] ) {
      const frozen = deepFreeze(record);
      const before = JSON.stringify(frozen);
      const inputs = objectsIn(frozen);
      for ( const sender of EVERYONE ) {
        const offered = offeredEndChoices(deepFreeze({ ...sender }), frozen);
        expect([...objectsIn(offered)].filter(object => inputs.has(object))).toEqual([]);
      }
      expect([...objectsIn(liveOverflowIds(frozen))].filter(object => inputs.has(object))).toEqual([]);
      expect(JSON.stringify(frozen)).toBe(before);
    }
  });
});
