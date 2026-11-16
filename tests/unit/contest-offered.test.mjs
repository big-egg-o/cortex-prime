import { describe, expect, it } from "vitest";
import {
  addContestRoll, addTestRoll, closeContest, closeTest, contestRollFromTotal, createContest, createTest,
  dispatchContestRequest, giveIn, offeredActions, setContestHighStakes
} from "../../module/rules/index.mjs";

/** Fake ids in Foundry's 16-character format. */
const P1 = "playerOne0000001";
const P2 = "playerTwo0000001";
const P3 = "playerThree00001";
const GM_ID = "gameMaster000001";
const MESSAGE = "contestCard00001";

/** The senders: the GM, the two players, and a player on no side. */
const GM = Object.freeze({ userId: GM_ID, isGM: true });
const PLAYER_ONE = Object.freeze({ userId: P1, isGM: false });
const PLAYER_TWO = Object.freeze({ userId: P2, isGM: false });
const STRANGER = Object.freeze({ userId: P3, isGM: false });
const EVERYONE = Object.freeze([GM, PLAYER_ONE, PLAYER_TWO, STRANGER]);

/** What a sender with nothing to do is offered. */
const NOTHING = Object.freeze({ roll: null, giveIn: null, highStakes: false, close: false });

/** What a GM is offered besides a roll or giving in, until the card is closed (ADR-022). */
const GM_ONLY = Object.freeze({ highStakes: true, close: true });

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
      { key: "initiator", userId: P1, actorUuid: "Actor.actorAyla0000001", label: "Ayla" },
      { key: "opposition", userId: P2, actorUuid: "Actor.actorBren0000001", label: "Bren" }
    ]
  };
}

/** A contest record with P1 initiating against the GM's side. */
function againstGM(state, revision = 0) {
  return {
    type: "contest", revision, state,
    sides: [
      { key: "initiator", userId: P1, actorUuid: "Actor.actorAyla0000001", label: "Ayla" },
      { key: "opposition", userId: null, actorUuid: "Actor.actorBrute000001", label: "Brute" }
    ]
  };
}

/** A test record. By default P1 rolls and the GM set the difficulty. */
function testRecord(state, { roller = P1, setter = null, revision = 0 } = {}) {
  return {
    type: "test", revision, state,
    sides: [
      { key: "roller", userId: roller, actorUuid: null, label: "Roller" },
      { key: "setter", userId: setter, actorUuid: null, label: "Setter" }
    ]
  };
}

/** @returns {object} the ContestRoll for a typed total with typed effect dice (ADR-021) */
function typed(side, total, ...sizes) {
  return unwrap(contestRollFromTotal(side, total, sizes), `typed ${total}`);
}

/** Starts a contest and adds the rolls in order, failing the test on any refusal. */
function exchange(rolls, options) {
  let state = unwrap(createContest(options), "createContest");
  for ( const roll of rolls ) state = unwrap(addContestRoll(state, roll), `${roll.side} ${roll.total}`);
  return state;
}

const freshContest = () => unwrap(createContest(), "createContest");

/** TC-15 after the initiator's 11: the opposition's turn, before its first roll. */
const tc15Opened = () => exchange([typed("initiator", 11, 6)]);

/** TC-18: I 11 → O 14; the initiator's turn. */
const tc18 = () => exchange([typed("initiator", 11, 6), typed("opposition", 14, 8)]);

/** TC-18, second case: I 11 → O 14 → I 16; the opposition's turn, after its first roll. */
const tc18OsTurn = () => exchange([typed("initiator", 11, 6), typed("opposition", 14, 8), typed("initiator", 16, 8)]);

/** TC-17: I 11 → O 13 → I 15 → O 12 fails; the initiator wins. */
const tc17 = () => exchange([
  typed("initiator", 11, 6), typed("opposition", 13, 8), typed("initiator", 15, 10), typed("opposition", 12, 6)
]);

/** TC-18 after the initiator gives in. */
const gaveIn = () => unwrap(giveIn(tc18(), "initiator"), "give in");

/** TC-18b: the opposition declines after the initiator's roll. */
const declined = () => unwrap(giveIn(tc15Opened(), "opposition"), "decline");

/** TC-43: a test with difficulty 13, before its roll. */
const tc43 = () => unwrap(createTest({ difficulty: 13 }), "createTest");

/** TC-44: that test after a 14, a success by 1. */
const tc44 = () => unwrap(addTestRoll(tc43(), typed("roller", 14, 6)), "addTestRoll");

/** A request envelope carrying the record's own revision. */
function send(sender, contest, action, payload) {
  return dispatchContestRequest({
    sender, contest, request: { action, messageId: MESSAGE, revision: contest.revision, payload }
  });
}

describe("what the card offers in a contest (offeredActions; ADR-027, Step 4.4 S4a proposal review)", () => {
  it("before the first roll: the initiator's user may roll, the opposition's may decline (TC-18b)", () => {
    const record = pvp(freshContest());
    expect(offeredActions(PLAYER_ONE, record)).toEqual({
      ...NOTHING, roll: { side: "initiator", toBeat: null, rollIndex: 0 }
    });
    expect(offeredActions(PLAYER_TWO, record)).toEqual({
      ...NOTHING, giveIn: { side: "opposition", action: "decline" }
    });
    expect(offeredActions(STRANGER, record)).toEqual(NOTHING);
  });

  it("TC-E02 the initiator can't give in before the first roll, the GM included", () => {
    const record = pvp(freshContest());
    expect(offeredActions(PLAYER_ONE, record).giveIn).toBeNull();
    expect(offeredActions(GM, record)).toEqual({
      ...GM_ONLY, roll: { side: "initiator", toBeat: null, rollIndex: 0 },
      giveIn: { side: "opposition", action: "decline" }
    });
  });

  it("TC-15 after the initiator's 11: the opposition's user may roll to beat 11 or decline; the initiator's waits", () => {
    const record = pvp(tc15Opened());
    expect(offeredActions(PLAYER_TWO, record)).toEqual({
      ...NOTHING, roll: { side: "opposition", toBeat: 11, rollIndex: 1 },
      giveIn: { side: "opposition", action: "decline" }
    });
    expect(offeredActions(PLAYER_ONE, record)).toEqual(NOTHING);
    expect(offeredActions(STRANGER, record)).toEqual(NOTHING);
  });

  it("TC-18 on the initiator's turn: its user may roll to beat 14 or give in; the opposition's waits", () => {
    const record = pvp(tc18());
    expect(offeredActions(PLAYER_ONE, record)).toEqual({
      ...NOTHING, roll: { side: "initiator", toBeat: 14, rollIndex: 2 },
      giveIn: { side: "initiator", action: "give-in" }
    });
    expect(offeredActions(PLAYER_TWO, record)).toEqual(NOTHING);
  });

  it("TC-E02 once the opposition has rolled, it gives in instead of declining", () => {
    const record = pvp(tc18OsTurn());
    expect(offeredActions(PLAYER_TWO, record)).toEqual({
      ...NOTHING, roll: { side: "opposition", toBeat: 16, rollIndex: 3 },
      giveIn: { side: "opposition", action: "give-in" }
    });
    expect(offeredActions(PLAYER_ONE, record)).toEqual(NOTHING);
  });

  it("a GM is offered the roll and the giving in of whichever side's turn it is, plus high stakes and close", () => {
    expect(offeredActions(GM, pvp(tc18()))).toEqual({
      ...GM_ONLY, roll: { side: "initiator", toBeat: 14, rollIndex: 2 },
      giveIn: { side: "initiator", action: "give-in" }
    });
    expect(offeredActions(GM, pvp(tc18OsTurn()))).toEqual({
      ...GM_ONLY, roll: { side: "opposition", toBeat: 16, rollIndex: 3 },
      giveIn: { side: "opposition", action: "give-in" }
    });
  });

  it("the GM's side is the GM's: a player is offered nothing for it", () => {
    const record = againstGM(tc15Opened());
    expect(offeredActions(PLAYER_ONE, record)).toEqual(NOTHING);
    expect(offeredActions(PLAYER_TWO, record)).toEqual(NOTHING);
    expect(offeredActions(GM, record)).toEqual({
      ...GM_ONLY, roll: { side: "opposition", toBeat: 11, rollIndex: 1 },
      giveIn: { side: "opposition", action: "decline" }
    });
  });

  it.each([
    ["TC-17 won", tc17],
    ["TC-18 given in", gaveIn],
    ["TC-18b declined", declined]
  ])("%s: no roll and no giving in for anyone; the GM keeps high stakes and close (ADR-022)", (_name, build) => {
    const record = pvp(build());
    for ( const sender of [PLAYER_ONE, PLAYER_TWO, STRANGER] ) {
      expect(offeredActions(sender, record), sender.userId).toEqual(NOTHING);
    }
    expect(offeredActions(GM, record)).toEqual({ ...NOTHING, ...GM_ONLY });
  });

  it("TC-51 high stakes that is already on can still be changed by the GM", () => {
    const state = unwrap(setContestHighStakes(tc17(), true), "high stakes");
    expect(offeredActions(GM, pvp(state)).highStakes).toBe(true);
    expect(offeredActions(PLAYER_ONE, pvp(state)).highStakes).toBe(false);
  });

  it("a closed contest offers nothing, to the GM either", () => {
    for ( const build of [tc15Opened, tc17] ) {
      const record = pvp(unwrap(closeContest(build()), "close"));
      for ( const sender of EVERYONE ) expect(offeredActions(sender, record), sender.userId).toEqual(NOTHING);
    }
  });
});

describe("what the card offers in a test (offeredActions)", () => {
  it("TC-43 before the roll: the roller's user may roll to beat 13; a test has no giving in", () => {
    const record = testRecord(tc43(), { setter: P2 });
    expect(offeredActions(PLAYER_ONE, record)).toEqual({
      ...NOTHING, roll: { side: "roller", toBeat: 13, rollIndex: 0 }
    });
    expect(offeredActions(PLAYER_TWO, record)).toEqual(NOTHING);
    expect(offeredActions(STRANGER, record)).toEqual(NOTHING);
    expect(offeredActions(GM, record)).toEqual({
      ...NOTHING, ...GM_ONLY, roll: { side: "roller", toBeat: 13, rollIndex: 0 }
    });
  });

  it("TC-12 with the roles swapped, the GM rolls for the GMC and the setting player is offered nothing", () => {
    const record = testRecord(tc43(), { roller: null, setter: P1 });
    expect(offeredActions(PLAYER_ONE, record)).toEqual(NOTHING);
    expect(offeredActions(GM, record).roll).toEqual({ side: "roller", toBeat: 13, rollIndex: 0 });
  });

  it("TC-44 after the roll: nothing for the players; the GM keeps high stakes and close", () => {
    const record = testRecord(tc44());
    expect(offeredActions(PLAYER_ONE, record)).toEqual(NOTHING);
    expect(offeredActions(GM, record)).toEqual({ ...NOTHING, ...GM_ONLY });
  });

  it("TC-52 a closed test offers nothing, before or after its roll", () => {
    for ( const build of [tc43, tc44] ) {
      const record = testRecord(unwrap(closeTest(build()), "close"));
      for ( const sender of EVERYONE ) expect(offeredActions(sender, record), sender.userId).toEqual(NOTHING);
    }
  });
});

describe("the offer agrees with the dispatcher: nothing is offered that the relay would refuse", () => {
  /** Every record the tests above use, each at revision 3. */
  const records = () => [
    ["a fresh contest", pvp(freshContest(), 3)],
    ["TC-15 opened", pvp(tc15Opened(), 3)],
    ["TC-15 opened against the GM", againstGM(tc15Opened(), 3)],
    ["TC-18", pvp(tc18(), 3)],
    ["TC-18 on the opposition's turn", pvp(tc18OsTurn(), 3)],
    ["TC-17 won", pvp(tc17(), 3)],
    ["given in", pvp(gaveIn(), 3)],
    ["declined", pvp(declined(), 3)],
    ["a closed contest", pvp(unwrap(closeContest(tc18()), "close"), 3)],
    ["TC-43", testRecord(tc43(), { revision: 3 })],
    ["TC-43 with the roles swapped", testRecord(tc43(), { roller: null, setter: P1, revision: 3 })],
    ["TC-44", testRecord(tc44(), { revision: 3 })],
    ["a closed test", testRecord(unwrap(closeTest(tc43()), "close"), { revision: 3 })]
  ];

  it.each(records())("%s: the roll", (_name, record) => {
    for ( const sender of EVERYONE ) {
      const { roll } = offeredActions(sender, record);
      if ( roll ) {
        const total = (roll.toBeat ?? 0) + 1;
        expect(send(sender, record, "add-roll", { side: roll.side, total }), sender.userId).toMatchObject({ ok: true });
        continue;
      }
      for ( const side of record.sides ) {
        expect(send(sender, record, "add-roll", { side: side.key, total: 99 }).ok, `${sender.userId} ${side.key}`)
          .toBe(false);
      }
    }
  });

  it.each(records())("%s: giving in and declining", (_name, record) => {
    for ( const sender of EVERYONE ) {
      const offered = offeredActions(sender, record).giveIn;
      if ( offered ) {
        const payload = offered.action === "decline" ? {} : { side: offered.side };
        expect(send(sender, record, offered.action, payload), sender.userId).toMatchObject({ ok: true });
        continue;
      }
      expect(send(sender, record, "decline", {}).ok, `${sender.userId} decline`).toBe(false);
      for ( const side of record.sides ) {
        expect(send(sender, record, "give-in", { side: side.key }).ok, `${sender.userId} ${side.key}`).toBe(false);
      }
    }
  });

  it.each(records())("%s: high stakes and close", (_name, record) => {
    for ( const sender of EVERYONE ) {
      const offered = offeredActions(sender, record);
      const highStakes = send(sender, record, "set-high-stakes", { highStakes: !record.state.highStakes });
      expect(highStakes.ok, `${sender.userId} high stakes`).toBe(offered.highStakes);
      expect(send(sender, record, "close", {}).ok, `${sender.userId} close`).toBe(offered.close);
    }
  });

  it("the record's own revision is used, so a card at any revision is offered the same", () => {
    expect(offeredActions(PLAYER_ONE, pvp(tc18(), 7))).toEqual(offeredActions(PLAYER_ONE, pvp(tc18(), 0)));
    expect(offeredActions(GM, testRecord(tc43(), { revision: 7 }))).toEqual(offeredActions(GM, testRecord(tc43())));
  });
});

describe("offeredActions: a missing record and frozen inputs", () => {
  it("a missing record offers nothing", () => {
    for ( const missing of [null, undefined] ) {
      for ( const sender of [GM, PLAYER_ONE] ) expect(offeredActions(sender, missing)).toEqual(NOTHING);
    }
  });

  it("frozen inputs are left alone, and the answer shares no object with them", () => {
    for ( const record of [pvp(tc18()), pvp(tc15Opened()), testRecord(tc43())] ) {
      const frozen = deepFreeze(record);
      const before = JSON.stringify(frozen);
      const inputs = objectsIn(frozen);
      for ( const sender of EVERYONE ) {
        const offered = offeredActions(deepFreeze({ ...sender }), frozen);
        expect([...objectsIn(offered)].filter(object => inputs.has(object))).toEqual([]);
      }
      expect(JSON.stringify(frozen)).toBe(before);
    }
  });
});
