import { describe, expect, it } from "vitest";
import { engineStateOf, initialSystem, systemChangesAfter } from "../../module/data/chat/contest-mapping.mjs";
import {
  REQUEST_ACTIONS, checkContestRequest, checkStartRequest, dispatchContestRequest
} from "../../module/rules/contest-request.mjs";
import {
  addContestRoll, addTestRoll, applyContestHeroicSteps, applyOverflowChoice, applyResults, buildPool,
  chooseContestOverflow, closeContest, closeTest, contestRollFromResolution, contestRollFromTotal, createContest,
  createTest, giveIn, resolve, setContestHighStakes, stepEffectDie
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

/** The senders: the GM, the two players of a contest, and a player on no side. */
const GM = Object.freeze({ userId: GM_ID, isGM: true });
const PLAYER_ONE = Object.freeze({ userId: P1, isGM: false });
const PLAYER_TWO = Object.freeze({ userId: P2, isGM: false });
const STRANGER = Object.freeze({ userId: P3, isGM: false });

const REFUSED = code => ({ ok: false, code });

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

/**
 * The stored sides of a contest. By default a player's initiator against the GM's side.
 * @param {{initiator?: string|null, opposition?: string|null}} [users]
 */
function contestSides({ initiator = P1, opposition = null } = {}) {
  return [
    { key: "initiator", userId: initiator, actorUuid: "Actor.actorAyla0000001", label: "Ayla" },
    { key: "opposition", userId: opposition, actorUuid: "Actor.actorBrute000001", label: "Brute" }
  ];
}

/**
 * The stored sides of a test. By default a player's roller and the GM as setter.
 * @param {{roller?: string|null, setter?: string|null}} [users]
 */
function testSides({ roller = P1, setter = null } = {}) {
  return [
    { key: "roller", userId: roller, actorUuid: "Actor.actorAyla0000001", label: "Ayla" },
    { key: "setter", userId: setter, actorUuid: null, label: "GM" }
  ];
}

/** A contest between the two players: P1 initiates, P2 opposes. */
const PVP = Object.freeze({ initiator: P1, opposition: P2 });

/** A test where P1 rolls against a difficulty P2 set. */
const P2_SETS = Object.freeze({ roller: P1, setter: P2 });

/** TC-12's roles swapped: the GM rolls for a GMC against a difficulty P1 set. */
const GMC_ROLLS = Object.freeze({ roller: null, setter: P1 });

/** What the handler reads from a contest message, built from an engine state (P1 against the GM by default). */
function contestRecord(state, { users, revision = 0 } = {}) {
  return { type: "contest", revision, sides: contestSides(users), state };
}

/** A contest record between the two players. */
function pvp(state, revision = 0) {
  return contestRecord(state, { users: PVP, revision });
}

/** What the handler reads from a test's message, built from an engine state (P1 rolls by default). */
function testRecord(state, { users, revision = 0 } = {}) {
  return { type: "test", revision, sides: testSides(users), state };
}

/** A request envelope for the contest message. */
function request(action, payload, { revision = 0, messageId = MESSAGE } = {}) {
  return payload === undefined ? { action, messageId, revision } : { action, messageId, revision, payload };
}

/**
 * Dispatches one request against a record.
 * @param {object} sender
 * @param {object|null} contest
 * @param {string} action
 * @param {object} [payload]
 * @param {{revision?: number, poolRoll?: object|null}} [options]
 */
function send(sender, contest, action, payload, { revision, poolRoll = null } = {}) {
  return dispatchContestRequest({ sender, request: request(action, payload, { revision }), contest, poolRoll });
}

/** Sends an add-roll naming a roll card, with that card as the handler passes it in. */
function sendCard(sender, contest, poolRollId, poolRoll, payload = {}) {
  return send(sender, contest, "add-roll", { ...payload, poolRollId }, { poolRoll });
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

/** An SFX steps an effect die past d12 after Confirm, leaving its choice open. */
function sfxPastD12(rolled, resolution, effectId = "e1") {
  const pastD12 = stepEffectDie(rolled, resolution, effectId, 1, "other");
  expect(pastD12.overflow).toMatchObject({ effectId, cause: "other" });
  return pastD12;
}

/** The poolRoll message an add-roll request names, as the handler passes it in. */
function poolRollOf({ rolled, resolution }, authorId = P1) {
  return { authorId, rolled, resolution };
}

/** The engine's own copy of a confirmed roll card's roll. */
function fromCard(side, { rolled, resolution }, messageRef) {
  return unwrap(contestRollFromResolution(side, rolled, resolution, messageRef), `${side} from ${messageRef}`);
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

/** Starts a test and adds its roll, failing the test on any refusal. */
function testWith(difficulty, roll) {
  return unwrap(addTestRoll(unwrap(createTest({ difficulty }), "createTest"), roll), "addTestRoll");
}

/** A fresh contest, and a fresh test with difficulty 13 by default. */
const freshContest = () => unwrap(createContest(), "createContest");
const freshTest = (difficulty = 13) => unwrap(createTest({ difficulty }), "createTest");

/** TC-15's initiator roll: d8:6, d8:5, d6:3, total 11, effect die d6. */
function tc15I() {
  const roll = confirmRoll([8, 8, 6], [6, 5, 3], [0, 1], [2]);
  expect(roll.resolution.total).toBe(11);
  return roll;
}

/** TC-15's opposition roll: d10:6, d8:4, d6:2, total d10 + d8 = 10, effect die d6. */
function tc15O() {
  const roll = confirmRoll([10, 8, 6], [6, 4, 2], [0, 1], [2]);
  expect(roll.resolution.total).toBe(10);
  return roll;
}

/** TC-15's contest after the initiator's roll, added from its roll card. */
function tc15Opened() {
  return exchange([fromCard("initiator", tc15I(), CARD_I)]);
}

/** TC-15's contest after both roll cards: 10 doesn't beat 11, so the initiator wins by 1. */
function tc15Won() {
  return unwrap(addContestRoll(tc15Opened(), fromCard("opposition", tc15O(), CARD_O)), "O 10");
}

/** TC-17: I 11 (d6) → O 13 (d8) → I 15 (d10) → O 12 (d6) fails; I wins with the d10 as e1. */
function tc17() {
  return exchange([
    typed("initiator", 11, 6), typed("opposition", 13, 8), typed("initiator", 15, 10), typed("opposition", 12, 6)
  ]);
}

/** TC-18: I 11 → O 14; it is I's turn. */
function tc18() {
  return exchange([typed("initiator", 11, 6), typed("opposition", 14, 8)]);
}

/** TC-18, second case: I 11 → O 14 → I 16; it is O's turn. */
function tc18OsTurn() {
  return exchange([typed("initiator", 11, 6), typed("opposition", 14, 8), typed("initiator", 16, 8)]);
}

/** TC-18b's initiator roll: d10:7, d8:6, d6:4, total 13, effect die d6; O hasn't rolled. */
function tc18bOpened() {
  const roll = confirmRoll([10, 8, 6], [7, 6, 4], [0, 1], [2]);
  expect(roll.resolution.total).toBe(13);
  return exchange([fromCard("initiator", roll, CARD_I)]);
}

/** TC-19, second case: I 11 → O 15 (d8) → I 9 fails; O wins by 6, one heroic step not yet applied. */
function tc19OWins() {
  const state = exchange([typed("initiator", 11, 6), typed("opposition", 15, 8), typed("initiator", 9, 6)]);
  expect(state).toMatchObject({ status: "won", winner: "opposition", margin: 6, heroicSteps: 1, heroicAppliedTo: null });
  return state;
}

/** TC-32's roll: d10:7, d8:6, d12:5, d4:3, total 13, e1 pushed past d12, the d4 left over; O hasn't rolled. */
function tc32Opened() {
  const { rolled, resolution } = confirmRoll([10, 8, 12, 4], [7, 6, 5, 3], [0, 1], [2]);
  return exchange([fromCard("initiator", { rolled, resolution: sfxPastD12(rolled, resolution) }, CARD_I)]);
}

/** TC-36: I 15 with e1 past d12 (open) and the d4 left over → O 12 (d8) fails; won by 3. */
function tc36() {
  const { rolled, resolution } = confirmRoll([10, 8, 12, 4], [8, 7, 5, 3], [0, 1], [2]);
  const opening = fromCard("initiator", { rolled, resolution: sfxPastD12(rolled, resolution) }, CARD_I);
  return exchange([opening, typed("opposition", 12, 8)]);
}

/** TC-37: I 17 with d8 (e1) and d6 (e2) → O 12 (d8) fails; won by 5, one step for the roller to place. */
function tc37() {
  const state = exchange([typed("initiator", 17, 8, 6), typed("opposition", 12, 8)]);
  expect(state).toMatchObject({ status: "won", winner: "initiator", heroicSteps: 1, heroicAppliedTo: null });
  return state;
}

/**
 * TC-39: I 17 with d12 (e1, pushed past d12 during the exchange) and d6 (e2) → O 12 (d8) fails; won
 * by 5, so the heroic steps come before e1's open overflow.
 */
function tc39() {
  const { rolled, resolution } = confirmRoll([10, 8, 12, 6], [9, 8, 2, 3], [0, 1], [2, 3], 1);
  const opening = fromCard("initiator", { rolled, resolution: sfxPastD12(rolled, resolution) }, CARD_I);
  return exchange([opening, typed("opposition", 12, 8)]);
}

/** TC-47's contest after I's 17 (effect die d8, e1): O's 12 (d8) will fail by 5. */
function tc47Opened() {
  return exchange([typed("initiator", 17, 8)]);
}

/** TC-51: I 15 (d10) → O 12 (d6) fails. */
function tc51() {
  return exchange([typed("initiator", 15, 10), typed("opposition", 12, 6)]);
}

/** TC-44's roll: d10:8, d8:6, d6:4, d4:3, total 14, effect die d6 (e1), the d4 left over. */
function tc44Roll() {
  const roll = confirmRoll([10, 8, 6, 4], [8, 6, 4, 3], [0, 1], [2]);
  expect(roll.resolution.total).toBe(14);
  return roll;
}

/** TC-44's test after its roll: difficulty 13, a success by 1. */
function tc44() {
  return testWith(13, fromCard("roller", tc44Roll(), CARD_R));
}

/** TC-13's test: difficulty 7; d10:8, d8:6, d6:5, d6:2 with 1 PP extra, effect dice d6 (e1) and d6 (e2). */
function tc13() {
  return testWith(7, fromCard("roller", confirmRoll([10, 8, 6, 6], [8, 6, 5, 2], [0, 1], [2, 3], 1), CARD_R));
}

/** TC-42's roll: d12:3, d10:9, d8:8, d4:2, total 17, effect die d12 (e1) pushed past d12, the d4 left over. */
function tc42Roll() {
  const { rolled, resolution } = confirmRoll([12, 10, 8, 4], [3, 9, 8, 2], [1, 2], [0]);
  expect(resolution.total).toBe(17);
  return { rolled, resolution: sfxPastD12(rolled, resolution) };
}

/** TC-42 with a difficulty of 14: margin 3, no heroic step, so e1's choice is made straight away. */
function tc42NoSteps() {
  return testWith(14, fromCard("roller", tc42Roll(), CARD_R));
}

/** TC-48's test: difficulty 8; e1 (d12, past d12, open) and e2 (d6); margin 9, one step to place. */
function tc48() {
  const { rolled, resolution } = confirmRoll([10, 8, 12, 6], [9, 8, 2, 3], [0, 1], [2, 3], 1);
  return testWith(8, fromCard("roller", { rolled, resolution: sfxPastD12(rolled, resolution) }, CARD_R));
}

describe("the check order (ADR-027)", () => {
  /** P2's confirmed roll card, which P1 may not send. */
  const p2Card = () => poolRollOf(tc15O(), P2);

  it("MALFORMED_REQUEST comes before CONTEST_NOT_FOUND", () => {
    expect(send(PLAYER_ONE, null, "close", {}, { revision: -1 })).toEqual(REFUSED("MALFORMED_REQUEST"));
    expect(dispatchContestRequest({ sender: PLAYER_ONE, request: null, contest: null }))
      .toEqual(REFUSED("MALFORMED_REQUEST"));
  });

  it("CONTEST_NOT_FOUND comes before UNSUPPORTED_ACTION", () => {
    expect(send(PLAYER_ONE, null, "reroll", {})).toEqual(REFUSED("CONTEST_NOT_FOUND"));
  });

  it("UNSUPPORTED_ACTION comes before POOL_ROLL_NOT_FOUND and the sender checks", () => {
    expect(sendCard(STRANGER, { ...contestRecord(freshContest()), type: "duel" }, CARD_I, null))
      .toEqual(REFUSED("UNSUPPORTED_ACTION"));
    expect(send(STRANGER, testRecord(tc44()), "give-in", {})).toEqual(REFUSED("UNSUPPORTED_ACTION"));
    expect(send(STRANGER, contestRecord(tc17()), "reroll", {})).toEqual(REFUSED("UNSUPPORTED_ACTION"));
  });

  it("POOL_ROLL_NOT_FOUND comes before the sender checks and STALE_REVISION", () => {
    expect(sendCard(STRANGER, contestRecord(freshContest()), CARD_I, null)).toEqual(REFUSED("POOL_ROLL_NOT_FOUND"));
    const stale = { revision: 1 };
    expect(send(STRANGER, contestRecord(freshContest(), { revision: 2 }), "add-roll", { poolRollId: CARD_I }, stale))
      .toEqual(REFUSED("POOL_ROLL_NOT_FOUND"));
  });

  it("GM_ONLY comes before STALE_REVISION", () => {
    const record = contestRecord(tc51(), { revision: 4 });
    expect(send(PLAYER_ONE, record, "set-high-stakes", { highStakes: true }, { revision: 3 })).toEqual(REFUSED("GM_ONLY"));
  });

  it("INVALID_SIDE for a side that isn't on the card comes before NOT_YOUR_SIDE", () => {
    expect(send(STRANGER, contestRecord(freshContest()), "add-roll", { side: "referee", total: 11 }))
      .toEqual(REFUSED("INVALID_SIDE"));
  });

  it("INVALID_SIDE, NOT_YOUR_SIDE and SIDE_REQUIRED come before NOT_YOUR_ROLL", () => {
    const fresh = contestRecord(freshContest());
    expect(sendCard(PLAYER_ONE, fresh, CARD_O, p2Card(), { side: "referee" })).toEqual(REFUSED("INVALID_SIDE"));
    expect(sendCard(STRANGER, fresh, CARD_O, p2Card())).toEqual(REFUSED("NOT_YOUR_SIDE"));
    const both = contestRecord(freshContest(), { users: { initiator: P1, opposition: P1 } });
    expect(sendCard(PLAYER_ONE, both, CARD_O, p2Card())).toEqual(REFUSED("SIDE_REQUIRED"));
  });

  it("NOT_YOUR_ROLL comes before STALE_REVISION", () => {
    const record = contestRecord(freshContest(), { revision: 2 });
    expect(send(PLAYER_ONE, record, "add-roll", { poolRollId: CARD_O }, { revision: 1, poolRoll: p2Card() }))
      .toEqual(REFUSED("NOT_YOUR_ROLL"));
  });

  it("NOT_YOUR_SIDE and SIDE_REQUIRED come before STALE_REVISION", () => {
    const payload = { total: 11 };
    expect(send(STRANGER, contestRecord(freshContest(), { revision: 2 }), "add-roll", payload, { revision: 1 }))
      .toEqual(REFUSED("NOT_YOUR_SIDE"));
    expect(send(GM, pvp(freshContest(), 2), "add-roll", payload, { revision: 1 })).toEqual(REFUSED("SIDE_REQUIRED"));
  });

  it("STALE_REVISION comes before the action's own checks", () => {
    const closed = contestRecord(unwrap(closeContest(tc15Opened()), "close"), { revision: 2 });
    expect(send(GM, closed, "add-roll", { side: "opposition", total: 12 }, { revision: 1 }))
      .toEqual(REFUSED("STALE_REVISION"));
    const unconfirmed = { authorId: P1, rolled: tc15I().rolled, resolution: null };
    const fresh = contestRecord(freshContest(), { revision: 2 });
    expect(send(PLAYER_ONE, fresh, "add-roll", { poolRollId: CARD_I }, { revision: 1, poolRoll: unconfirmed }))
      .toEqual(REFUSED("STALE_REVISION"));
    expect(send(GM, contestRecord(tc18OsTurn(), { revision: 2 }), "decline", {}, { revision: 1 }))
      .toEqual(REFUSED("STALE_REVISION"));
  });

  it("TC-52 CONTEST_CLOSED comes first among the action's own checks, before POOL_ROLL_NOT_CONFIRMED", () => {
    const closed = testRecord(unwrap(closeTest(freshTest()), "close"));
    const unconfirmed = { authorId: P1, rolled: tc44Roll().rolled, resolution: null };
    expect(sendCard(PLAYER_ONE, closed, CARD_R, unconfirmed)).toEqual(REFUSED("CONTEST_CLOSED"));
  });

  it("TC-18 CONTEST_CLOSED comes before DECLINE_AFTER_ROLL", () => {
    const closed = contestRecord(unwrap(closeContest(tc18OsTurn()), "close"));
    expect(send(GM, closed, "decline", {})).toEqual(REFUSED("CONTEST_CLOSED"));
  });

  it("TC-44 POOL_ROLL_NOT_CONFIRMED comes before ROLL_ALREADY_ADDED", () => {
    const unconfirmed = { authorId: P1, rolled: tc44Roll().rolled, resolution: null };
    expect(sendCard(PLAYER_ONE, testRecord(tc44()), CARD_R, unconfirmed)).toEqual(REFUSED("POOL_ROLL_NOT_CONFIRMED"));
  });

  it("TC-15 ROLL_ALREADY_ADDED comes before the engine's CONTEST_NOT_YOUR_TURN", () => {
    expect(sendCard(PLAYER_ONE, contestRecord(tc15Opened()), CARD_I, poolRollOf(tc15I())))
      .toEqual(REFUSED("ROLL_ALREADY_ADDED"));
  });

  it("TC-18 DECLINE_AFTER_ROLL comes before the engine's CONTEST_NOT_YOUR_TURN and CONTEST_RESOLVED", () => {
    expect(send(GM, contestRecord(tc18()), "decline", {})).toEqual(REFUSED("DECLINE_AFTER_ROLL"));
    expect(send(GM, contestRecord(tc17()), "decline", {})).toEqual(REFUSED("DECLINE_AFTER_ROLL"));
  });

  it("TC-E09 CONTEST_CLOSED comes before the engine's codes for building the roll", () => {
    const closedTest = testRecord(unwrap(closeTest(freshTest()), "close"));
    expect(send(PLAYER_ONE, closedTest, "add-roll", { total: 14, effectSizes: [7] })).toEqual(REFUSED("CONTEST_CLOSED"));
  });

  it("CONTEST_CLOSED comes before the consequence's codes for the pick, which doesn't check the closed flag itself", () => {
    const closedOpen = contestRecord(unwrap(closeContest(tc15Opened()), "close"));
    expect(send(GM, closedOpen, "use-against-loser", { effectIds: ["e1"] })).toEqual(REFUSED("CONTEST_CLOSED"));
  });

  it("TC-50 the roll is built before it is added: CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE before CONTEST_RESOLVED", () => {
    const { rolled, resolution } = tc42Roll();
    const answered = poolRollOf({ rolled, resolution: applyOverflowChoice(rolled, resolution, { kind: "take-out" }) });
    expect(sendCard(PLAYER_ONE, testRecord(tc44()), "rollCardR0000002", answered))
      .toEqual(REFUSED("CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE"));
  });

  it("TC-E09 a typed d7 is refused with INVALID_DIE_SIZE before the engine looks at the contest", () => {
    expect(send(PLAYER_ONE, contestRecord(tc17()), "add-roll", { total: 14, effectSizes: [7] }))
      .toEqual(REFUSED("INVALID_DIE_SIZE"));
  });

  it("TC-E01 the engine's own order holds: CONTEST_RESOLVED, then INVALID_TOTAL, then CONTEST_NOT_YOUR_TURN", () => {
    expect(send(PLAYER_ONE, contestRecord(tc17()), "add-roll", { total: 2.5 })).toEqual(REFUSED("CONTEST_RESOLVED"));
    expect(send(PLAYER_ONE, contestRecord(tc15Opened()), "add-roll", { total: 2.5 })).toEqual(REFUSED("INVALID_TOTAL"));
    expect(send(PLAYER_ONE, contestRecord(tc15Opened()), "add-roll", { total: 12 }))
      .toEqual(REFUSED("CONTEST_NOT_YOUR_TURN"));
  });

  it("TC-39 and TC-36 the pick of effect dice waits as the consequence does: HEROIC_PENDING, then OVERFLOW_PENDING", () => {
    const twice = { effectIds: ["e1", "e1"] };
    expect(send(PLAYER_ONE, pvp(tc39()), "use-against-loser", twice)).toEqual(REFUSED("HEROIC_PENDING"));
    expect(send(PLAYER_ONE, pvp(tc36()), "use-against-loser", twice)).toEqual(REFUSED("OVERFLOW_PENDING"));
  });

  it("TC-36 then DUPLICATE_EFFECT_DIE before EFFECT_DIE_NOT_FOUND", () => {
    const chosen = pvp(unwrap(chooseContestOverflow(tc36(), { kind: "new-d6" }), "new d6"));
    expect(send(PLAYER_ONE, chosen, "use-against-loser", { effectIds: ["e9", "e9"] }))
      .toEqual(REFUSED("DUPLICATE_EFFECT_DIE"));
    expect(send(PLAYER_ONE, chosen, "use-against-loser", { effectIds: ["e9"] })).toEqual(REFUSED("EFFECT_DIE_NOT_FOUND"));
  });

  it("checkContestRequest stops before the engine, and dispatchContestRequest adds the engine's codes", () => {
    const input = { sender: PLAYER_ONE, request: request("add-roll", { total: 12 }), contest: contestRecord(tc15Opened()) };
    expect(checkContestRequest(input)).toEqual({ ok: true, value: { side: "initiator" } });
    expect(dispatchContestRequest(input)).toEqual(REFUSED("CONTEST_NOT_YOUR_TURN"));
  });
});

describe("MALFORMED_REQUEST: the shape the dispatcher needs to route a request", () => {
  const good = { action: "close", messageId: MESSAGE, revision: 0 };
  const addRoll = payload => ({ ...good, action: "add-roll", payload });
  const pick = payload => ({ ...good, action: "use-against-loser", payload });

  it.each([
    ["no request", undefined],
    ["a request that isn't an object", "close"],
    ["a list", [good]],
    ["no action", { ...good, action: undefined }],
    ["an empty action", { ...good, action: "" }],
    ["an action that isn't a string", { ...good, action: 7 }],
    ["no message id", { ...good, messageId: undefined }],
    ["an empty message id", { ...good, messageId: "" }],
    ["a message id that isn't a string", { ...good, messageId: 12 }],
    ["no revision", { ...good, revision: undefined }],
    ["a negative revision", { ...good, revision: -1 }],
    ["a revision that isn't whole", { ...good, revision: 1.5 }],
    ["a revision given as text", { ...good, revision: "0" }],
    ["a payload of null", { ...good, payload: null }],
    ["a payload that is a list", { ...good, payload: [] }],
    ["a payload that is text", { ...good, payload: "e1" }],
    ["a roll with neither a roll card nor a total", addRoll({ side: "initiator" })],
    ["a roll with both a roll card and a total", addRoll({ poolRollId: CARD_I, total: 11 })],
    ["a roll card id that is empty", addRoll({ poolRollId: "" })],
    ["a roll card id that isn't a string", addRoll({ poolRollId: 5 })],
    ["typed effect dice with a roll card", addRoll({ poolRollId: CARD_I, effectSizes: [6] })],
    ["a pick with no list", pick({})],
    ["a pick that isn't a list", pick({ effectIds: "e1" })]
  ])("%s is refused before the message is looked at", (_label, req) => {
    expect(dispatchContestRequest({ sender: GM, request: req, contest: null })).toEqual(REFUSED("MALFORMED_REQUEST"));
    expect(dispatchContestRequest({ sender: GM, request: req, contest: contestRecord(tc17()) }))
      .toEqual(REFUSED("MALFORMED_REQUEST"));
  });

  it("an unknown action's payload isn't checked, so it reaches UNSUPPORTED_ACTION", () => {
    const req = { ...good, action: "reroll", payload: { dieIds: 3 } };
    expect(dispatchContestRequest({ sender: GM, request: req, contest: contestRecord(tc17()) }))
      .toEqual(REFUSED("UNSUPPORTED_ACTION"));
  });

  it("a payload may be left out, and unknown payload fields are ignored", () => {
    expect(dispatchContestRequest({ sender: GM, request: good, contest: contestRecord(tc17()) }))
      .toMatchObject({ ok: true });
    expect(send(GM, contestRecord(tc17()), "close", { reason: "done" })).toMatchObject({ ok: true });
  });

  it("values the engine checks keep the engine's codes: TC-E11 high stakes, TC-E04 totals, effect ids", () => {
    for ( const highStakes of ["true", 1, null, undefined] ) {
      expect(send(GM, contestRecord(tc51()), "set-high-stakes", { highStakes }), String(highStakes))
        .toEqual(REFUSED("INVALID_HIGH_STAKES"));
    }
    const fresh = contestRecord(freshContest());
    expect(send(PLAYER_ONE, fresh, "add-roll", { total: "13" })).toEqual(REFUSED("INVALID_TOTAL"));
    expect(send(PLAYER_ONE, fresh, "add-roll", { total: null })).toEqual(REFUSED("INVALID_TOTAL"));
    expect(send(PLAYER_ONE, fresh, "add-roll", { total: 13, effectSizes: null })).toEqual(REFUSED("INVALID_DIE_SIZE"));
    expect(send(PLAYER_ONE, contestRecord(tc37()), "apply-heroic-steps", {})).toEqual(REFUSED("EFFECT_DIE_NOT_FOUND"));
    expect(send(PLAYER_ONE, contestRecord(tc37()), "apply-heroic-steps", { effectId: 1 }))
      .toEqual(REFUSED("EFFECT_DIE_NOT_FOUND"));
    expect(send(PLAYER_ONE, contestRecord(tc36()), "choose-overflow", { kind: "reroll" }))
      .toEqual(REFUSED("INVALID_OVERFLOW_CHOICE"));
  });
});

describe("the message and the action", () => {
  it("a message that wasn't found is refused with CONTEST_NOT_FOUND", () => {
    expect(send(GM, null, "close", {})).toEqual(REFUSED("CONTEST_NOT_FOUND"));
  });

  it("a test supports adding its roll, heroic steps, the overflow choice, high stakes and closing", () => {
    expect(REQUEST_ACTIONS.test).toEqual(["add-roll", "apply-heroic-steps", "choose-overflow", "set-high-stakes", "close"]);
    for ( const action of ["give-in", "decline", "use-against-loser", "start"] ) {
      expect(send(GM, testRecord(tc44()), action, { effectIds: [] }), action).toEqual(REFUSED("UNSUPPORTED_ACTION"));
    }
  });

  it("a contest also supports giving in, declining and the pick of effect dice against the loser", () => {
    expect([...REQUEST_ACTIONS.contest].sort()).toEqual([
      "add-roll", "apply-heroic-steps", "choose-overflow", "close", "decline", "give-in", "set-high-stakes",
      "use-against-loser"
    ]);
    expect([REQUEST_ACTIONS, REQUEST_ACTIONS.test, REQUEST_ACTIONS.contest].every(Object.isFrozen)).toBe(true);
  });

  it("a flow type the dispatcher doesn't know supports nothing", () => {
    expect(send(GM, { ...contestRecord(tc17()), type: "duel" }, "close", {})).toEqual(REFUSED("UNSUPPORTED_ACTION"));
  });
});

describe("the revision", () => {
  it("a request made against an older or a newer revision is refused with STALE_REVISION", () => {
    const record = contestRecord(tc17(), { revision: 4 });
    expect(send(GM, record, "close", {}, { revision: 3 })).toEqual(REFUSED("STALE_REVISION"));
    expect(send(GM, record, "close", {}, { revision: 5 })).toEqual(REFUSED("STALE_REVISION"));
    expect(send(GM, record, "close", {}, { revision: 4 })).toMatchObject({ ok: true });
  });
});

describe("who may do what (ADR-027)", () => {
  describe("adding a roll to a contest: the side comes from the sender, never from trust", () => {
    it("TC-15 the initiator's user hands in the opening roll for their side", () => {
      const written = unwrap(sendCard(PLAYER_ONE, contestRecord(freshContest()), CARD_I, poolRollOf(tc15I())), "P1");
      expect(written.state.rolls.map(r => [r.side, r.total])).toEqual([["initiator", 11]]);
      expect(written.extras).toEqual({ rollUserId: P1 });
    });

    it("TC-15 the GM may hand in the initiator's roll by naming the side, and is recorded as the roll's sender", () => {
      const card = poolRollOf(tc15I());
      const written = unwrap(sendCard(GM, contestRecord(freshContest()), CARD_I, card, { side: "initiator" }), "GM");
      expect(written.state.rolls.map(r => [r.side, r.total])).toEqual([["initiator", 11]]);
      expect(written.extras).toEqual({ rollUserId: GM_ID });
    });

    it("TC-E01 without a side the GM acts for the GM's side, which can't open the contest", () => {
      expect(send(GM, contestRecord(freshContest()), "add-roll", { total: 11 })).toEqual(REFUSED("CONTEST_NOT_YOUR_TURN"));
      const written = unwrap(send(GM, contestRecord(tc15Opened()), "add-roll", { total: 10 }), "GM for O");
      expect(written.state.rolls.map(r => r.side)).toEqual(["initiator", "opposition"]);
    });

    it("a player can't name the GM's side, or the other player's side", () => {
      expect(send(PLAYER_ONE, contestRecord(tc15Opened()), "add-roll", { side: "opposition", total: 12 }))
        .toEqual(REFUSED("NOT_YOUR_SIDE"));
      expect(send(PLAYER_TWO, pvp(freshContest()), "add-roll", { side: "initiator", total: 11 }))
        .toEqual(REFUSED("NOT_YOUR_SIDE"));
    });

    it("TC-E01 the other player's roll counts for their own side, so it can't open the contest for the initiator", () => {
      expect(send(PLAYER_TWO, pvp(freshContest()), "add-roll", { total: 11 })).toEqual(REFUSED("CONTEST_NOT_YOUR_TURN"));
    });

    it("a user on no side is refused, with or without a side", () => {
      const fresh = contestRecord(freshContest());
      expect(send(STRANGER, fresh, "add-roll", { total: 11 })).toEqual(REFUSED("NOT_YOUR_SIDE"));
      expect(send(STRANGER, fresh, "add-roll", { side: "initiator", total: 11 })).toEqual(REFUSED("NOT_YOUR_SIDE"));
    });

    it("a side that isn't one of the contest's sides is refused with INVALID_SIDE, for the GM and anyone else", () => {
      const fresh = contestRecord(freshContest());
      for ( const sender of [GM, PLAYER_ONE, STRANGER] ) {
        expect(send(sender, fresh, "add-roll", { side: "referee", total: 11 }), sender.userId)
          .toEqual(REFUSED("INVALID_SIDE"));
        expect(send(sender, fresh, "add-roll", { side: 0, total: 11 }), sender.userId).toEqual(REFUSED("INVALID_SIDE"));
        expect(send(sender, contestRecord(tc18()), "give-in", { side: "setter" }), sender.userId)
          .toEqual(REFUSED("INVALID_SIDE"));
      }
    });

    it("a user on both sides, or a GM with no side of their own or two GM's sides, must name the side", () => {
      const both = contestRecord(freshContest(), { users: { initiator: P1, opposition: P1 } });
      expect(send(PLAYER_ONE, both, "add-roll", { total: 11 })).toEqual(REFUSED("SIDE_REQUIRED"));
      expect(unwrap(send(PLAYER_ONE, both, "add-roll", { side: "initiator", total: 11 }), "named").state.turn)
        .toBe("opposition");

      expect(send(GM, pvp(freshContest()), "add-roll", { total: 11 })).toEqual(REFUSED("SIDE_REQUIRED"));
      const gmOnly = contestRecord(freshContest(), { users: { initiator: null, opposition: null } });
      expect(send(GM, gmOnly, "add-roll", { total: 11 })).toEqual(REFUSED("SIDE_REQUIRED"));
      expect(send(GM, gmOnly, "add-roll", { side: "initiator", total: 11 })).toMatchObject({ ok: true });
    });

    it("a GM who is also a side's user acts for that side and the GM's side, so must name one", () => {
      const record = contestRecord(freshContest(), { users: { initiator: GM_ID, opposition: null } });
      expect(send(GM, record, "add-roll", { total: 11 })).toEqual(REFUSED("SIDE_REQUIRED"));
      expect(send(GM, record, "add-roll", { side: "initiator", total: 11 })).toMatchObject({ ok: true });
    });

    it("a sender that isn't flagged as a GM with exactly true is treated as a player", () => {
      const sender = { userId: P3, isGM: "yes" };
      expect(send(sender, contestRecord(freshContest()), "add-roll", { side: "initiator", total: 11 }))
        .toEqual(REFUSED("NOT_YOUR_SIDE"));
    });
  });

  describe("adding a test's roll", () => {
    it("TC-44 the roller's user hands in the roll; the GM hands it in without naming a side", () => {
      const card = poolRollOf(tc44Roll());
      const byPlayer = unwrap(sendCard(PLAYER_ONE, testRecord(freshTest()), CARD_R, card), "P1");
      expect(byPlayer).toMatchObject({ state: { success: true, margin: 1 }, extras: { rollUserId: P1 } });
      const byGm = unwrap(sendCard(GM, testRecord(freshTest()), CARD_R, card), "GM");
      expect(byGm).toMatchObject({ state: { success: true, margin: 1 }, extras: { rollUserId: GM_ID } });
      const typedByGm = { sender: GM, request: request("add-roll", { total: 14 }), contest: testRecord(freshTest()) };
      expect(checkContestRequest(typedByGm)).toEqual({ ok: true, value: { side: "roller" } });
    });

    it("a test's roll is always the roller's: naming the roller is accepted, any other side gives INVALID_SIDE", () => {
      for ( const sender of [PLAYER_ONE, GM] ) {
        expect(send(sender, testRecord(freshTest()), "add-roll", { side: "roller", total: 14 }), sender.userId)
          .toMatchObject({ ok: true });
      }
      for ( const sender of [PLAYER_ONE, GM, STRANGER] ) {
        for ( const side of ["setter", "initiator", 0] ) {
          expect(send(sender, testRecord(freshTest()), "add-roll", { side, total: 14 }), `${sender.userId} ${side}`)
            .toEqual(REFUSED("INVALID_SIDE"));
        }
      }
    });

    it("the setter's user and a user on no side can't roll for the roller, named or not", () => {
      const record = testRecord(freshTest(), { users: P2_SETS });
      for ( const sender of [PLAYER_TWO, STRANGER] ) {
        expect(send(sender, record, "add-roll", { total: 14 }), sender.userId).toEqual(REFUSED("NOT_YOUR_SIDE"));
        expect(send(sender, record, "add-roll", { side: "roller", total: 14 }), sender.userId)
          .toEqual(REFUSED("NOT_YOUR_SIDE"));
      }
      expect(send(STRANGER, testRecord(freshTest()), "add-roll", { total: 14 })).toEqual(REFUSED("NOT_YOUR_SIDE"));
    });

    it("TC-12 with the roles swapped, the GM rolls for the GMC's roller side and the player who set the total can't", () => {
      const swapped = testRecord(freshTest(12), { users: GMC_ROLLS });
      expect(unwrap(send(GM, swapped, "add-roll", { total: 17 }), "GMC 17").state)
        .toMatchObject({ success: true, heroicSteps: 1 });
      expect(send(PLAYER_ONE, swapped, "add-roll", { total: 17 })).toEqual(REFUSED("NOT_YOUR_SIDE"));
      expect(send(PLAYER_ONE, swapped, "add-roll", { side: "roller", total: 17 })).toEqual(REFUSED("NOT_YOUR_SIDE"));
    });

    it("a user on both sides of a test rolls for the roller without naming a side", () => {
      const record = testRecord(freshTest(), { users: { roller: P1, setter: P1 } });
      expect(unwrap(send(PLAYER_ONE, record, "add-roll", { total: 14 }), "P1").state.roll.side).toBe("roller");
    });
  });

  describe("adding a roll from a roll card", () => {
    it("a player may send only a roll card they wrote; a GM may send anyone's", () => {
      const oCard = poolRollOf(tc15O(), P2);
      expect(sendCard(PLAYER_TWO, pvp(tc15Opened()), CARD_O, oCard)).toMatchObject({ ok: true });
      expect(sendCard(GM, pvp(tc15Opened()), CARD_O, oCard, { side: "opposition" })).toMatchObject({ ok: true });

      const p2VsGm = contestRecord(freshContest(), { users: { initiator: P2, opposition: null } });
      expect(sendCard(PLAYER_TWO, p2VsGm, CARD_I, poolRollOf(tc15I(), P1))).toEqual(REFUSED("NOT_YOUR_ROLL"));
      expect(sendCard(PLAYER_TWO, p2VsGm, CARD_I, poolRollOf(tc15I(), null))).toEqual(REFUSED("NOT_YOUR_ROLL"));
    });

    it("a roll card that wasn't found, isn't confirmed or is already in the contest is refused", () => {
      expect(sendCard(PLAYER_ONE, contestRecord(freshContest()), CARD_I, null)).toEqual(REFUSED("POOL_ROLL_NOT_FOUND"));
      const unconfirmed = { authorId: P1, rolled: tc15I().rolled, resolution: null };
      expect(sendCard(PLAYER_ONE, contestRecord(freshContest()), CARD_I, unconfirmed))
        .toEqual(REFUSED("POOL_ROLL_NOT_CONFIRMED"));
      expect(sendCard(GM, contestRecord(tc15Opened()), CARD_I, poolRollOf(tc15O(), GM_ID)))
        .toEqual(REFUSED("ROLL_ALREADY_ADDED"));
    });

    it("TC-44 a test's roll card that is already its roll is refused with ROLL_ALREADY_ADDED", () => {
      expect(sendCard(PLAYER_ONE, testRecord(tc44()), CARD_R, poolRollOf(tc44Roll())))
        .toEqual(REFUSED("ROLL_ALREADY_ADDED"));
    });
  });

  describe("giving in and declining", () => {
    it("TC-18 the side whose turn it is gives in through its user or the GM", () => {
      for ( const [sender, payload] of [[PLAYER_ONE, {}], [GM, { side: "initiator" }]] ) {
        const written = unwrap(send(sender, pvp(tc18()), "give-in", payload), sender.userId);
        expect(written.state).toMatchObject({ status: "gaveIn", winner: "opposition" });
        expect(written.extras).toEqual({});
      }
    });

    it("TC-18 the other side's user can't give in for the initiator, and gives in for their own side out of turn", () => {
      expect(send(PLAYER_TWO, pvp(tc18()), "give-in", { side: "initiator" })).toEqual(REFUSED("NOT_YOUR_SIDE"));
      expect(send(PLAYER_TWO, pvp(tc18()), "give-in", {})).toEqual(REFUSED("CONTEST_NOT_YOUR_TURN"));
      expect(send(STRANGER, pvp(tc18()), "give-in", {})).toEqual(REFUSED("NOT_YOUR_SIDE"));
    });

    it("TC-18 the GM's side gives in through the GM; a player can't name it", () => {
      expect(unwrap(send(GM, contestRecord(tc18OsTurn()), "give-in", {}), "GM").state)
        .toMatchObject({ status: "gaveIn", winner: "initiator" });
      expect(send(PLAYER_ONE, contestRecord(tc18OsTurn()), "give-in", { side: "opposition" }))
        .toEqual(REFUSED("NOT_YOUR_SIDE"));
    });

    it("TC-18b declining is the opposition's: its user or the GM declines, before or after the initiator's roll", () => {
      for ( const state of [freshContest(), tc18bOpened()] ) {
        for ( const sender of [PLAYER_TWO, GM] ) {
          const written = unwrap(send(sender, pvp(state), "decline", {}), sender.userId);
          expect(written.state).toMatchObject({ status: "declined", winner: "initiator" });
        }
      }
    });

    it("TC-18 once the opposition has rolled it can't decline (DECLINE_AFTER_ROLL), but it can still give in", () => {
      for ( const sender of [PLAYER_TWO, GM] ) {
        expect(send(sender, pvp(tc18OsTurn()), "decline", {}), sender.userId).toEqual(REFUSED("DECLINE_AFTER_ROLL"));
      }
      expect(unwrap(send(PLAYER_TWO, pvp(tc18OsTurn()), "give-in", {}), "give in").state)
        .toMatchObject({ status: "gaveIn", winner: "initiator" });
      expect(unwrap(send(PLAYER_TWO, pvp(tc18bOpened()), "decline", {}), "before O's roll").state.status).toBe("declined");
    });

    it("TC-18b the initiator's user and a user on no side can't decline, whatever side the payload names", () => {
      expect(send(PLAYER_ONE, pvp(tc18bOpened()), "decline", {})).toEqual(REFUSED("NOT_YOUR_SIDE"));
      expect(send(PLAYER_ONE, pvp(tc18bOpened()), "decline", { side: "initiator" })).toEqual(REFUSED("NOT_YOUR_SIDE"));
      expect(send(STRANGER, pvp(tc18bOpened()), "decline", {})).toEqual(REFUSED("NOT_YOUR_SIDE"));
      expect(send(PLAYER_ONE, contestRecord(tc18bOpened()), "decline", {})).toEqual(REFUSED("NOT_YOUR_SIDE"));
      expect(send(GM, contestRecord(tc18bOpened()), "decline", {})).toMatchObject({ ok: true });
    });
  });

  describe("the winner's choices: heroic steps, the overflow choice and the pick against the loser", () => {
    it("TC-37 the winner's user or the GM applies the heroic steps; the loser's user and a user on no side can't", () => {
      for ( const sender of [PLAYER_ONE, GM] ) {
        const written = unwrap(send(sender, pvp(tc37()), "apply-heroic-steps", { effectId: "e1" }), sender.userId);
        expect(written.state.rolls[0].effects).toEqual([{ id: "e1", size: 10 }, { id: "e2", size: 6 }]);
      }
      for ( const sender of [PLAYER_TWO, STRANGER] ) {
        expect(send(sender, pvp(tc37()), "apply-heroic-steps", { effectId: "e1" }), sender.userId)
          .toEqual(REFUSED("NOT_YOUR_SIDE"));
      }
    });

    it("TC-19 when the GM's side wins, only the GM applies its heroic steps", () => {
      const written = unwrap(send(GM, contestRecord(tc19OWins()), "apply-heroic-steps", { effectId: "e1" }), "GM");
      expect(written.state.rolls[1].effects).toEqual([{ id: "e1", size: 10 }]);
      expect(send(PLAYER_ONE, contestRecord(tc19OWins()), "apply-heroic-steps", { effectId: "e1" }))
        .toEqual(REFUSED("NOT_YOUR_SIDE"));
    });

    it("TC-15 while the contest has no winner, either side's user and the GM get the engine's CONTEST_NOT_RESOLVED", () => {
      const choices = [
        ["apply-heroic-steps", { effectId: "e1" }], ["choose-overflow", { kind: "new-d6" }],
        ["use-against-loser", { effectIds: [] }]
      ];
      for ( const [action, payload] of choices ) {
        for ( const sender of [PLAYER_ONE, PLAYER_TWO, GM] ) {
          expect(send(sender, pvp(tc15Opened()), action, payload), `${action} ${sender.userId}`)
            .toEqual(REFUSED("CONTEST_NOT_RESOLVED"));
        }
        expect(send(PLAYER_ONE, contestRecord(tc15Opened()), action, payload), `${action} against the GM's side`)
          .toEqual(REFUSED("CONTEST_NOT_RESOLVED"));
        expect(send(STRANGER, pvp(tc15Opened()), action, payload), `${action} stranger`).toEqual(REFUSED("NOT_YOUR_SIDE"));
      }
    });

    it("TC-15 a closed contest with no winner refuses either side's choices with CONTEST_CLOSED first", () => {
      const closed = pvp(unwrap(closeContest(tc15Opened()), "close"));
      expect(send(PLAYER_TWO, closed, "apply-heroic-steps", { effectId: "e1" })).toEqual(REFUSED("CONTEST_CLOSED"));
      expect(send(STRANGER, closed, "apply-heroic-steps", { effectId: "e1" })).toEqual(REFUSED("NOT_YOUR_SIDE"));
    });

    it("TC-36 the winner's user or the GM chooses the overflow; the loser's user and a user on no side can't", () => {
      for ( const sender of [PLAYER_ONE, GM] ) {
        const written = unwrap(send(sender, pvp(tc36()), "choose-overflow", { kind: "new-d6" }), sender.userId);
        expect(written.state.rolls[0].effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 6 }]);
      }
      for ( const sender of [PLAYER_TWO, STRANGER] ) {
        expect(send(sender, pvp(tc36()), "choose-overflow", { kind: "new-d6" }), sender.userId)
          .toEqual(REFUSED("NOT_YOUR_SIDE"));
      }
    });

    it("TC-17 the winner's user or the GM picks the dice against the loser; the loser's user and a stranger can't", () => {
      for ( const sender of [PLAYER_ONE, GM] ) {
        const written = unwrap(send(sender, pvp(tc17()), "use-against-loser", { effectIds: ["e1"] }), sender.userId);
        expect(written.extras).toEqual({ usedAgainstLoser: ["e1"] });
      }
      for ( const sender of [PLAYER_TWO, STRANGER] ) {
        expect(send(sender, pvp(tc17()), "use-against-loser", { effectIds: ["e1"] }), sender.userId)
          .toEqual(REFUSED("NOT_YOUR_SIDE"));
      }
    });

    it("TC-19 when the GM's side wins, a player can't pick its dice against the loser", () => {
      const record = contestRecord(unwrap(applyContestHeroicSteps(tc19OWins(), "e1"), "steps"));
      expect(send(PLAYER_ONE, record, "use-against-loser", { effectIds: ["e1"] })).toEqual(REFUSED("NOT_YOUR_SIDE"));
      expect(send(GM, record, "use-against-loser", { effectIds: ["e1"] })).toMatchObject({ ok: true });
    });

    it("TC-13 the roller's user or the GM applies a test's heroic steps; the setter's user and a stranger can't", () => {
      for ( const sender of [PLAYER_ONE, GM] ) {
        const record = testRecord(tc13(), { users: P2_SETS });
        const written = unwrap(send(sender, record, "apply-heroic-steps", { effectId: "e2" }), sender.userId);
        expect(written.state.roll.effects).toEqual([{ id: "e1", size: 6 }, { id: "e2", size: 8 }]);
      }
      for ( const sender of [PLAYER_TWO, STRANGER] ) {
        const record = testRecord(tc13(), { users: P2_SETS });
        expect(send(sender, record, "apply-heroic-steps", { effectId: "e2" }), sender.userId)
          .toEqual(REFUSED("NOT_YOUR_SIDE"));
      }
    });

    it("TC-13's test with the roller on the GM's side: only the GM makes its choices", () => {
      const swapped = testRecord(tc13(), { users: GMC_ROLLS });
      expect(send(PLAYER_ONE, swapped, "apply-heroic-steps", { effectId: "e1" })).toEqual(REFUSED("NOT_YOUR_SIDE"));
      expect(send(GM, swapped, "apply-heroic-steps", { effectId: "e1" })).toMatchObject({ ok: true });
    });

    it("TC-42 the roller's user or the GM chooses a test's overflow; the setter's user and a user on no side can't", () => {
      for ( const sender of [PLAYER_ONE, GM] ) {
        const record = testRecord(tc42NoSteps(), { users: P2_SETS });
        const written = unwrap(send(sender, record, "choose-overflow", { kind: "new-d6" }), sender.userId);
        expect(written.state.roll.effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 6 }]);
      }
      for ( const sender of [PLAYER_TWO, STRANGER] ) {
        const record = testRecord(tc42NoSteps(), { users: P2_SETS });
        expect(send(sender, record, "choose-overflow", { kind: "new-d6" }), sender.userId).toEqual(REFUSED("NOT_YOUR_SIDE"));
      }
    });
  });

  describe("high stakes and closing are the GM's (ADR-022)", () => {
    it.each([
      ["set-high-stakes", { highStakes: true }],
      ["close", {}]
    ])("TC-51 %s: the GM may, every player is refused with GM_ONLY", (action, payload) => {
      for ( const record of [pvp(tc51()), testRecord(tc44(), { users: P2_SETS })] ) {
        expect(send(GM, record, action, payload), `${record.type} GM`).toMatchObject({ ok: true });
        for ( const sender of [PLAYER_ONE, PLAYER_TWO, STRANGER] ) {
          expect(send(sender, record, action, payload), `${record.type} ${sender.userId}`).toEqual(REFUSED("GM_ONLY"));
        }
      }
    });
  });
});

describe("what an accepted request writes", () => {
  it("TC-15 a roll from its roll card is built through contestRollFromResolution, with the card as its message ref", () => {
    const written = unwrap(sendCard(PLAYER_ONE, contestRecord(freshContest()), CARD_I, poolRollOf(tc15I())), "I 11");
    const expected = unwrap(addContestRoll(freshContest(), fromCard("initiator", tc15I(), CARD_I)), "add");
    expect(written).toEqual({ state: expected, extras: { rollUserId: P1 } });
    expect(written.state.rolls[0].messageRef).toBe(CARD_I);
  });

  it("TC-15 the opposition's 10 doesn't beat 11: the initiator wins by 1", () => {
    const written = unwrap(sendCard(GM, contestRecord(tc15Opened()), CARD_O, poolRollOf(tc15O(), GM_ID)), "O 10");
    expect(written.state).toMatchObject({ status: "won", winner: "initiator", margin: 1, heroicSteps: 0 });
    expect(written.extras).toEqual({ rollUserId: GM_ID });
  });

  it("TC-54b a typed total is built through contestRollFromTotal, with its typed effect dice", () => {
    const state = exchange([typed("initiator", 11), typed("opposition", 13, 8)]);
    const written = unwrap(send(PLAYER_ONE, contestRecord(state), "add-roll", { total: 12, effectSizes: [10] }), "I 12");
    expect(written.state.rolls[2]).toEqual(typed("initiator", 12, 10));
    expect(written.state).toMatchObject({ status: "won", winner: "opposition", margin: 1 });
  });

  it("TC-47 the automatic heroic step goes into the same write as the roll that ends the contest", () => {
    const written = unwrap(send(GM, contestRecord(tc47Opened()), "add-roll", { total: 12, effectSizes: [8] }), "O 12");
    expect(written.state).toMatchObject({ status: "won", margin: 5, heroicSteps: 1, heroicAppliedTo: "e1" });
    expect(written.state.rolls[0].effects).toEqual([{ id: "e1", size: 10 }]);
  });

  it("TC-47 with TC-37's two effect dice nothing is applied, and the steps wait for the winner", () => {
    const opened = exchange([typed("initiator", 17, 8, 6)]);
    const written = unwrap(send(GM, contestRecord(opened), "add-roll", { total: 12, effectSizes: [8] }), "O 12");
    expect(written.state).toMatchObject({ heroicSteps: 1, heroicAppliedTo: null });
    expect(send(PLAYER_ONE, contestRecord(written.state), "use-against-loser", { effectIds: ["e1"] }))
      .toEqual(REFUSED("HEROIC_PENDING"));
  });

  it("TC-46 a test's automatic heroic step goes into the same write as its roll", () => {
    const tc08Roll = confirmRoll([10, 8, 6, 4], [9, 7, 4, 2], [0, 1], [2]);
    const written = unwrap(sendCard(PLAYER_ONE, testRecord(freshTest(8)), CARD_R, poolRollOf(tc08Roll)), "TC-08's roll");
    expect(written.state).toMatchObject({ success: true, margin: 8, heroicSteps: 1, heroicAppliedTo: "e1" });
    expect(written.state.roll.effects).toEqual([{ id: "e1", size: 8 }]);
    expect(written.extras).toEqual({ rollUserId: P1 });
  });

  it("TC-45 a typed 16 with a typed d8 against 10: the step goes on the d8 automatically", () => {
    const written = unwrap(send(PLAYER_ONE, testRecord(freshTest(10)), "add-roll", { total: 16, effectSizes: [8] }), "16");
    expect(written.state.roll.effects).toEqual([{ id: "e1", size: 10 }]);
    expect(written.state.heroicAppliedTo).toBe("e1");
  });

  it("TC-42 a roll whose overflow is open joins the test with the overflow still open", () => {
    const written = unwrap(sendCard(PLAYER_ONE, testRecord(freshTest(8)), CARD_R, poolRollOf(tc42Roll())), "TC-42");
    expect(written.state).toMatchObject({ success: true, margin: 9, heroicAppliedTo: "e1" });
    expect(written.state.roll.overflows).toEqual([{ effectId: "e1", cause: "other", kind: null, dieId: null }]);
  });

  it("TC-18 and TC-18b giving in and declining write the engine's ending and no model-only data", () => {
    expect(unwrap(send(PLAYER_ONE, contestRecord(tc18()), "give-in", {}), "give in")).toEqual({
      state: unwrap(giveIn(tc18(), "initiator"), "engine"), extras: {}
    });
    expect(unwrap(send(GM, contestRecord(tc18bOpened()), "decline", {}), "decline")).toEqual({
      state: unwrap(giveIn(tc18bOpened(), "opposition"), "engine"), extras: {}
    });
  });

  it("TC-37 heroic steps on e2 make it a d8", () => {
    const written = unwrap(send(PLAYER_ONE, contestRecord(tc37()), "apply-heroic-steps", { effectId: "e2" }), "e2");
    expect(written.state.rolls[0].effects).toEqual([{ id: "e1", size: 8 }, { id: "e2", size: 8 }]);
    expect(written.state.heroicAppliedTo).toBe("e2");
    expect(written.extras).toEqual({});
  });

  it("TC-36 the overflow choice passes the effect id, the kind and the leftover's die id to the engine", () => {
    const choice = { effectId: "e1", kind: "leftover", dieId: "d4" };
    const written = unwrap(send(PLAYER_ONE, contestRecord(tc36()), "choose-overflow", choice), "d4");
    expect(written.state.rolls[0].effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 4 }]);
    expect(written.state.rolls[0].overflows).toEqual([{ effectId: "e1", cause: "other", kind: "leftover", dieId: "d4" }]);
  });

  it("TC-48 a test's steps on e1 join its overflow, and the choice that follows adds a new d6", () => {
    const stepped = unwrap(send(PLAYER_ONE, testRecord(tc48()), "apply-heroic-steps", { effectId: "e1" }), "steps");
    const chosen = unwrap(send(PLAYER_ONE, testRecord(stepped.state), "choose-overflow", { kind: "new-d6" }), "new d6");
    expect(chosen.state.roll.effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 6 }, { id: "e3", size: 6 }]);
  });

  it("TC-51 high stakes is set on a contest and a test", () => {
    expect(unwrap(send(GM, contestRecord(tc51()), "set-high-stakes", { highStakes: true }), "contest")).toEqual({
      state: unwrap(setContestHighStakes(tc51(), true), "engine"), extras: {}
    });
    expect(unwrap(send(GM, testRecord(tc44()), "set-high-stakes", { highStakes: true }), "test").state)
      .toMatchObject({ highStakes: true, success: true, margin: 1 });
  });

  it("TC-52 closing writes the closed flag on a contest and a test", () => {
    expect(unwrap(send(GM, contestRecord(tc17()), "close", {}), "contest").state.closed).toBe(true);
    expect(unwrap(send(GM, testRecord(freshTest()), "close", {}), "test").state.closed).toBe(true);
  });

  it("TC-17 the pick changes no engine state and gives the handler its own copy of the effect ids", () => {
    const state = tc17();
    const effectIds = ["e1"];
    const written = unwrap(send(PLAYER_ONE, contestRecord(state), "use-against-loser", { effectIds }), "pick");
    expect(written.state).toBe(state);
    expect(written.extras).toEqual({ usedAgainstLoser: ["e1"] });
    expect(written.extras.usedAgainstLoser).not.toBe(effectIds);
  });

  it("TC-17 the winner may pick, pick again with no dice, and can't pick once the contest is closed", () => {
    const pick = (state, revision, effectIds) => {
      const record = contestRecord(state, { revision });
      return send(PLAYER_ONE, record, "use-against-loser", { effectIds }, { revision });
    };
    const first = pick(tc17(), 4, ["e1"]);
    expect(unwrap(first, "first pick").extras).toEqual({ usedAgainstLoser: ["e1"] });
    const again = pick(first.value.state, 5, []);
    expect(unwrap(again, "second pick").extras).toEqual({ usedAgainstLoser: [] });
    const closed = contestRecord(unwrap(closeContest(tc17()), "close"), { revision: 6 });
    expect(send(PLAYER_ONE, closed, "use-against-loser", { effectIds: ["e1"] }, { revision: 6 }))
      .toEqual(REFUSED("CONTEST_CLOSED"));
  });

  it("TC-40 after a decline the pick is accepted as the consequence accepts it, once the overflow is chosen", () => {
    const declined = contestRecord(unwrap(giveIn(tc32Opened(), "opposition"), "decline"));
    expect(send(PLAYER_ONE, declined, "use-against-loser", { effectIds: ["e1"] })).toEqual(REFUSED("OVERFLOW_PENDING"));
    const chosen = unwrap(send(PLAYER_ONE, declined, "choose-overflow", { kind: "new-d6" }), "new d6");
    const both = { effectIds: ["e1", "e2"] };
    const picked = unwrap(send(PLAYER_ONE, contestRecord(chosen.state), "use-against-loser", both), "pick");
    expect(picked.extras).toEqual({ usedAgainstLoser: ["e1", "e2"] });
  });
});

describe("the engine's codes come through unchanged", () => {
  const steppedTc37 = () => contestRecord(unwrap(applyContestHeroicSteps(tc37(), "e1"), "steps"));
  const chosenTc36 = () => contestRecord(unwrap(chooseContestOverflow(tc36(), { kind: "new-d6" }), "new d6"));
  const declinedTc32 = () => contestRecord(unwrap(giveIn(tc32Opened(), "opposition"), "decline"));
  const answeredOnCard = () => {
    const { rolled, resolution } = tc42Roll();
    return poolRollOf({ rolled, resolution: applyOverflowChoice(rolled, resolution, { kind: "new-d6" }) });
  };

  it.each([
    ["TC-E01 the same side twice in a row", "CONTEST_NOT_YOUR_TURN",
      () => send(PLAYER_ONE, contestRecord(tc15Opened()), "add-roll", { total: 13 })],
    ["TC-E02 the initiator giving in before the first roll", "CONTEST_NOT_STARTED",
      () => send(PLAYER_ONE, contestRecord(freshContest()), "give-in", {})],
    ["TC-E03 giving in after the contest has a winner", "CONTEST_RESOLVED",
      () => send(PLAYER_TWO, pvp(tc17()), "give-in", {})],
    ["TC-44 a second roll for a test", "CONTEST_RESOLVED",
      () => send(PLAYER_ONE, testRecord(tc44()), "add-roll", { total: 15 })],
    ["TC-E09 a typed d7", "INVALID_DIE_SIZE",
      () => send(PLAYER_ONE, testRecord(freshTest()), "add-roll", { total: 14, effectSizes: [7] })],
    ["TC-E09 a total of 2.5", "INVALID_TOTAL",
      () => send(PLAYER_ONE, testRecord(freshTest()), "add-roll", { total: 2.5 })],
    ["TC-50 a roll answered on its own card", "CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE",
      () => sendCard(PLAYER_ONE, testRecord(freshTest(8)), CARD_R, answeredOnCard())],
    ["TC-E06 heroic steps on TC-15's win by 1", "HEROIC_NOT_EARNED",
      () => send(PLAYER_ONE, contestRecord(tc15Won()), "apply-heroic-steps", { effectId: "e1" })],
    ["TC-37 applying the heroic steps twice", "HEROIC_ALREADY_APPLIED",
      () => send(PLAYER_ONE, steppedTc37(), "apply-heroic-steps", { effectId: "e2" })],
    ["TC-E06 heroic steps on an unknown effect die", "EFFECT_DIE_NOT_FOUND",
      () => send(PLAYER_ONE, contestRecord(tc37()), "apply-heroic-steps", { effectId: "e7" })],
    ["TC-39 choosing the overflow before the heroic steps", "HEROIC_PENDING",
      () => send(PLAYER_ONE, contestRecord(tc39()), "choose-overflow", { kind: "new-d6" })],
    ["TC-48 choosing a test's overflow before its heroic steps", "HEROIC_PENDING",
      () => send(PLAYER_ONE, testRecord(tc48()), "choose-overflow", { kind: "new-d6" })],
    ["TC-36 a second overflow choice", "OVERFLOW_NOT_PENDING",
      () => send(PLAYER_ONE, chosenTc36(), "choose-overflow", { kind: "new-d6" })],
    ["TC-40 the take-out after a decline", "INVALID_OVERFLOW_CHOICE",
      () => send(PLAYER_ONE, declinedTc32(), "choose-overflow", { kind: "take-out" })],
    ["TC-E11 high stakes given as text", "INVALID_HIGH_STAKES",
      () => send(GM, testRecord(tc44()), "set-high-stakes", { highStakes: "true" })],
    ["TC-52 closing a closed test", "CONTEST_CLOSED",
      () => send(GM, testRecord(unwrap(closeTest(freshTest()), "close")), "close", {})],
    ["TC-E11 high stakes on a closed contest", "CONTEST_CLOSED",
      () => send(GM, contestRecord(unwrap(closeContest(tc51()), "close")), "set-high-stakes", { highStakes: "true" })],
    ["TC-36 the pick before the overflow is chosen", "OVERFLOW_PENDING",
      () => send(PLAYER_ONE, contestRecord(tc36()), "use-against-loser", { effectIds: ["e1"] })],
    ["TC-17 the pick naming e1 twice", "DUPLICATE_EFFECT_DIE",
      () => send(PLAYER_ONE, contestRecord(tc17()), "use-against-loser", { effectIds: ["e1", "e1"] })],
    ["TC-17 the pick naming the loser's die", "EFFECT_DIE_NOT_FOUND",
      () => send(PLAYER_ONE, contestRecord(tc17()), "use-against-loser", { effectIds: ["e2"] })]
  ])("%s → %s", (_label, code, run) => {
    expect(run()).toEqual(REFUSED(code));
  });

  it("TC-55 a choice after a failed test is refused with OVERFLOW_NOT_PENDING", () => {
    const { rolled, resolution } = confirmRoll([12, 10, 8, 4], [3, 7, 6, 2], [1, 2], [0]);
    const failed = testWith(15, fromCard("roller", { rolled, resolution: sfxPastD12(rolled, resolution) }, CARD_R));
    expect(send(PLAYER_ONE, testRecord(failed), "choose-overflow", { kind: "new-d6" }))
      .toEqual(REFUSED("OVERFLOW_NOT_PENDING"));
  });
});

describe("the handler's write through the mapping (systemChangesAfter)", () => {
  /**
   * A stand-in for the GM's handler: reads the record from the stored system, dispatches, and
   * applies the write through the mapping, as the Foundry side will.
   */
  function handle(system, sender, req, poolRoll = null) {
    const contest = system && {
      type: system.flow.type, revision: system.revision, sides: system.sides,
      state: unwrap(engineStateOf(system.flow), "engineStateOf")
    };
    const result = dispatchContestRequest({ sender, request: req, contest, poolRoll });
    if ( !result.ok ) return { result, system };
    const changes = unwrap(systemChangesAfter(system, result.value.state, result.value.extras), "systemChangesAfter");
    return { result, system: { ...system, ...changes } };
  }

  /** A new contest message's system data. */
  function newContest(users) {
    const input = { type: "contest", state: freshContest(), startedBy: P1, sides: contestSides(users) };
    return unwrap(initialSystem(input), "initialSystem");
  }

  it("TC-15 the exchange is stored with each roll's sender, the revision rises, and a stale request writes nothing", () => {
    let system = newContest();
    ({ system } = handle(system, PLAYER_ONE, request("add-roll", { poolRollId: CARD_I }), poolRollOf(tc15I())));
    const oCard = poolRollOf(tc15O(), GM_ID);
    const stale = handle(system, GM, request("add-roll", { poolRollId: CARD_O }, { revision: 0 }), oCard);
    expect(stale.result).toEqual(REFUSED("STALE_REVISION"));
    expect(stale.system).toBe(system);
    ({ system } = handle(system, GM, request("add-roll", { poolRollId: CARD_O }, { revision: 1 }), oCard));

    expect(system.revision).toBe(2);
    expect(system.flow.rolls.map(roll => [roll.side, roll.userId, roll.messageRef])).toEqual([
      ["initiator", P1, CARD_I], ["opposition", GM_ID, CARD_O]
    ]);
    expect(system.flow).toMatchObject({ status: "won", winner: "initiator", margin: 1 });
  });

  it("TC-17 the pick is stored as usedAgainstLoser and kept when high stakes changes", () => {
    let system = newContest(PVP);
    const steps = [
      [PLAYER_ONE, "add-roll", { total: 11, effectSizes: [6] }], [PLAYER_TWO, "add-roll", { total: 13, effectSizes: [8] }],
      [PLAYER_ONE, "add-roll", { total: 15, effectSizes: [10] }], [PLAYER_TWO, "add-roll", { total: 12, effectSizes: [6] }],
      [PLAYER_ONE, "use-against-loser", { effectIds: ["e1"] }], [GM, "set-high-stakes", { highStakes: true }]
    ];
    for ( const [sender, action, payload] of steps ) {
      const handled = handle(system, sender, request(action, payload, { revision: system.revision }));
      expect(handled.result, action).toMatchObject({ ok: true });
      system = handled.system;
    }
    expect(system.revision).toBe(6);
    expect(system.flow).toMatchObject({ usedAgainstLoser: ["e1"], highStakes: true, winner: "initiator" });
    expect(system.flow.rolls.map(roll => roll.userId)).toEqual([P1, P2, P1, P2]);
  });

  it("TC-17 a second pick replaces the first in the stored data", () => {
    const state = tc17();
    const rolls = state.rolls.map((roll, i) => ({ ...roll, userId: (i % 2 === 0) ? P1 : P2 }));
    let system = { ...newContest(PVP), flow: { type: "contest", ...state, rolls, usedAgainstLoser: null } };
    for ( const effectIds of [["e1"], []] ) {
      const handled = handle(system, PLAYER_ONE, request("use-against-loser", { effectIds }, { revision: system.revision }));
      expect(handled.result, effectIds.join()).toMatchObject({ ok: true });
      system = handled.system;
    }
    expect(system.revision).toBe(2);
    expect(system.flow.usedAgainstLoser).toEqual([]);
  });

  it("TC-44 a test's roll is stored with its sender and the test-only fields stay", () => {
    const system = unwrap(initialSystem({
      type: "test", state: freshTest(), startedBy: GM_ID, sides: testSides(), difficultyLevel: "challenging",
      difficultyMessageRef: "gmRollCard000001", oppositionEffects: [{ id: "e1", size: 8 }]
    }), "initialSystem");
    const handled = handle(system, PLAYER_ONE, request("add-roll", { poolRollId: CARD_R }), poolRollOf(tc44Roll()));
    expect(handled.system.revision).toBe(1);
    expect(handled.system.flow).toMatchObject({
      success: true, margin: 1, difficultyLevel: "challenging", roll: { userId: P1, messageRef: CARD_R }
    });
  });
});

describe("frozen inputs", () => {
  /** Dispatches a deep-frozen input and checks that nothing in it changed. */
  function sendFrozen(sender, contest, action, payload, poolRoll = null) {
    const req = request(action, payload, { revision: contest.revision });
    const input = deepFreeze({ sender, request: req, contest, poolRoll });
    const before = structuredClone(input);
    const result = dispatchContestRequest(input);
    expect(input).toEqual(before);
    return result;
  }

  it("every action works from a frozen sender, request, record and roll card", () => {
    const runs = [
      () => sendFrozen(PLAYER_ONE, contestRecord(freshContest()), "add-roll", { poolRollId: CARD_I }, poolRollOf(tc15I())),
      () => sendFrozen(PLAYER_ONE, testRecord(freshTest(8)), "add-roll", { poolRollId: CARD_R }, poolRollOf(tc42Roll())),
      () => sendFrozen(GM, contestRecord(tc47Opened()), "add-roll", { total: 12, effectSizes: [8] }),
      () => sendFrozen(PLAYER_ONE, contestRecord(tc18()), "give-in", {}),
      () => sendFrozen(GM, contestRecord(tc18bOpened()), "decline", {}),
      () => sendFrozen(PLAYER_ONE, contestRecord(tc37()), "apply-heroic-steps", { effectId: "e1" }),
      () => sendFrozen(PLAYER_ONE, testRecord(tc48()), "apply-heroic-steps", { effectId: "e2" }),
      () => sendFrozen(PLAYER_ONE, contestRecord(tc36()), "choose-overflow", { kind: "leftover", dieId: "d4" }),
      () => sendFrozen(PLAYER_ONE, testRecord(tc42NoSteps()), "choose-overflow", { kind: "take-out" }),
      () => sendFrozen(PLAYER_ONE, contestRecord(tc17()), "use-against-loser", { effectIds: ["e1"] }),
      () => sendFrozen(GM, contestRecord(tc51()), "set-high-stakes", { highStakes: true }),
      () => sendFrozen(GM, testRecord(tc44()), "close", {})
    ];
    for ( const [i, run] of runs.entries() ) expect(run(), `run ${i}`).toMatchObject({ ok: true });
  });

  it("refusals leave frozen inputs alone too", () => {
    expect(sendFrozen(STRANGER, contestRecord(tc17()), "close", {})).toEqual(REFUSED("GM_ONLY"));
    expect(sendFrozen(PLAYER_ONE, contestRecord(tc15Opened()), "add-roll", { total: 13 }))
      .toEqual(REFUSED("CONTEST_NOT_YOUR_TURN"));
  });

  it("checkStartRequest works from a frozen sender and request", () => {
    const input = deepFreeze({ sender: PLAYER_ONE, request: { type: "contest", sides: contestSides(), highStakes: false } });
    expect(checkStartRequest(input)).toEqual({ ok: true, value: null });
  });
});

describe("starting a test or contest (checkStartRequest)", () => {
  const start = (sender, req) => checkStartRequest({ sender, request: req });
  const STARTS = { ok: true, value: null };

  it("the GM may start any test or contest, for any sides, with high stakes or without", () => {
    expect(start(GM, { type: "test", sides: testSides(), highStakes: true })).toEqual(STARTS);
    expect(start(GM, { type: "contest", sides: contestSides(PVP) })).toEqual(STARTS);
    expect(start(GM, { type: "contest", sides: contestSides({ initiator: null, opposition: null }), highStakes: false }))
      .toEqual(STARTS);
  });

  it("a player may start a contest as the initiator's user and a test as the roller's user", () => {
    expect(start(PLAYER_ONE, { type: "contest", sides: contestSides() })).toEqual(STARTS);
    expect(start(PLAYER_ONE, { type: "contest", sides: contestSides(PVP) })).toEqual(STARTS);
    expect(start(PLAYER_ONE, { type: "contest", sides: contestSides({ initiator: P1, opposition: P1 }) })).toEqual(STARTS);
    expect(start(PLAYER_ONE, { type: "test", sides: testSides() })).toEqual(STARTS);
    expect(start(PLAYER_ONE, { type: "test", sides: testSides(P2_SETS), highStakes: false })).toEqual(STARTS);
  });

  it("a player can't start a contest as the opposition only, or a test as the setter only (NOT_YOUR_SIDE)", () => {
    expect(start(PLAYER_ONE, { type: "contest", sides: contestSides({ initiator: P2, opposition: P1 }) }))
      .toEqual(REFUSED("NOT_YOUR_SIDE"));
    expect(start(PLAYER_ONE, { type: "test", sides: testSides(GMC_ROLLS) })).toEqual(REFUSED("NOT_YOUR_SIDE"));
    expect(start(PLAYER_ONE, { type: "contest", sides: testSides() })).toEqual(REFUSED("NOT_YOUR_SIDE"));
    expect(start(GM, { type: "test", sides: testSides(GMC_ROLLS) })).toEqual(STARTS);
  });

  it("a player on no side is refused with NOT_YOUR_SIDE; the GM's side is not theirs", () => {
    expect(start(STRANGER, { type: "contest", sides: contestSides(PVP) })).toEqual(REFUSED("NOT_YOUR_SIDE"));
    expect(start(PLAYER_ONE, { type: "contest", sides: contestSides({ initiator: null, opposition: null }) }))
      .toEqual(REFUSED("NOT_YOUR_SIDE"));
  });

  it("a player can't start one with high stakes on (ADR-022)", () => {
    expect(start(PLAYER_ONE, { type: "test", sides: testSides(), highStakes: true })).toEqual(REFUSED("GM_ONLY"));
    expect(start(PLAYER_ONE, { type: "test", sides: testSides(), highStakes: "true" })).toEqual(REFUSED("GM_ONLY"));
  });

  const [initiator, opposition] = contestSides();
  it.each([
    ["no request", undefined],
    ["a type that isn't a string", { type: 1, sides: contestSides() }],
    ["no sides", { type: "contest" }],
    ["a side that isn't an object", { type: "contest", sides: [null, opposition] }],
    ["a side with an empty key", { type: "contest", sides: [{ ...initiator, key: "" }, opposition] }],
    ["a side whose user isn't a string or null", { type: "contest", sides: [{ ...initiator, userId: 5 }, opposition] }],
    ["a side whose user is empty", { type: "contest", sides: [{ ...initiator, userId: "" }, opposition] }]
  ])("%s is refused with MALFORMED_REQUEST", (_label, req) => {
    expect(start(GM, req)).toEqual(REFUSED("MALFORMED_REQUEST"));
  });

  it("a type that isn't test or contest is refused with UNSUPPORTED_ACTION", () => {
    expect(start(GM, { type: "duel", sides: contestSides() })).toEqual(REFUSED("UNSUPPORTED_ACTION"));
  });

  it("sides other than exactly the type's sides are refused with INVALID_SIDE", () => {
    expect(start(GM, { type: "contest", sides: testSides() })).toEqual(REFUSED("INVALID_SIDE"));
    expect(start(GM, { type: "contest", sides: [initiator] })).toEqual(REFUSED("INVALID_SIDE"));
    expect(start(GM, { type: "contest", sides: [initiator, opposition, { key: "interferer", userId: null }] }))
      .toEqual(REFUSED("INVALID_SIDE"));
    expect(start(GM, { type: "test", sides: [testSides()[0], testSides()[0]] })).toEqual(REFUSED("INVALID_SIDE"));
  });

  it("TC-E11 a high-stakes value that isn't true or false is refused with INVALID_HIGH_STAKES", () => {
    for ( const highStakes of ["true", 1, null] ) {
      expect(start(GM, { type: "test", sides: testSides(), highStakes }), String(highStakes))
        .toEqual(REFUSED("INVALID_HIGH_STAKES"));
    }
  });

  it("the start checks run in order: shape, type, GM_ONLY, NOT_YOUR_SIDE, INVALID_SIDE, INVALID_HIGH_STAKES", () => {
    expect(start(STRANGER, { type: "duel", sides: "none", highStakes: true })).toEqual(REFUSED("MALFORMED_REQUEST"));
    expect(start(STRANGER, { type: "duel", sides: testSides(), highStakes: true })).toEqual(REFUSED("UNSUPPORTED_ACTION"));
    expect(start(STRANGER, { type: "contest", sides: testSides(), highStakes: true })).toEqual(REFUSED("GM_ONLY"));
    expect(start(STRANGER, { type: "contest", sides: testSides() })).toEqual(REFUSED("NOT_YOUR_SIDE"));
    expect(start(GM, { type: "contest", sides: testSides(), highStakes: "true" })).toEqual(REFUSED("INVALID_SIDE"));
  });
});
