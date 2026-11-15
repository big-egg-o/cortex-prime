import { describe, expect, it } from "vitest";
import { initialSystem } from "../../module/data/chat/contest-mapping.mjs";
import {
  DIFFICULTY_SOURCE_KIND, addContestRoll, addTestRoll, applyOverflowChoice, applyResults, buildPool, closeContest,
  closeTest, contestRollFromResolution, contestRollFromTotal, createContest, createTest, difficultyLevelOfPool,
  dispatchStartRequest, expectedRoll, giveIn, mayActFor, resolve, rollCardHold, stepEffectDie
} from "../../module/rules/index.mjs";

/** Fake ids in Foundry's 16-character format. */
const P1 = "playerOne0000001";
const P2 = "playerTwo0000001";
const P3 = "playerThree00001";
const GM_ID = "gameMaster000001";
const MESSAGE = "contestCard00001";
const GM_CARD = "gmRollCard000001";
const CARD_I = "rollCardI0000001";
const CARD_O = "rollCardO0000001";
const CARD_R = "rollCardR0000001";
const OTHER_CARD = "rollCardX0000001";

/** Fake actor UUIDs: P1's Ayla, P2's Bren, and the GM's Brute, which no player owns. */
const AYLA = "Actor.actorAyla0000001";
const BREN = "Actor.actorBren0000001";
const BRUTE = "Actor.actorBrute000001";
const MISSING = "Actor.actorGone0000001";

/** The senders: the GM, the two players, and a player on no side. */
const GM = Object.freeze({ userId: GM_ID, isGM: true });
const PLAYER_ONE = Object.freeze({ userId: P1, isGM: false });
const PLAYER_TWO = Object.freeze({ userId: P2, isGM: false });
const STRANGER = Object.freeze({ userId: P3, isGM: false });

/** The actors as the handler reads them for each sender: whether that sender owns each one. */
const OWNED = Object.freeze({
  [P1]: { [AYLA]: true, [BREN]: false, [BRUTE]: false },
  [P2]: { [AYLA]: false, [BREN]: true, [BRUTE]: false },
  [P3]: { [AYLA]: false, [BREN]: false, [BRUTE]: false },
  [GM_ID]: { [AYLA]: true, [BREN]: true, [BRUTE]: true }
});

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

/** @returns {Set<object>} every object reachable from `value`, itself included */
function objectsIn(value, found = new Set()) {
  if ( value && (typeof value === "object") && !found.has(value) ) {
    found.add(value);
    for ( const inner of Object.values(value) ) objectsIn(inner, found);
  }
  return found;
}

/** @returns {object[]} the objects in `output` that also belong to one of the inputs */
function sharedObjects(output, ...inputs) {
  const inputObjects = new Set(inputs.flatMap(input => [...objectsIn(input)]));
  return [...objectsIn(output)].filter(object => inputObjects.has(object));
}

/**
 * @param {string} userId
 * @returns {Object<string, {ownedBySender: boolean}>} the actors map the handler builds for a sender
 */
function actorsFor(userId) {
  const owned = OWNED[userId] ?? OWNED[P3];
  return Object.fromEntries(Object.entries(owned).map(([uuid, ownedBySender]) => [uuid, { ownedBySender }]));
}

/**
 * A test's sides to start with. By default P1 rolls as Ayla, and the GM sets the difficulty.
 * @param {{roller?: string|null, setter?: string|null, rollerActor?: string|null, setterActor?: string|null}} [options]
 */
function testStartSides({ roller = P1, setter = null, rollerActor = AYLA, setterActor = null } = {}) {
  return [
    { key: "roller", userId: roller, actorUuid: rollerActor, label: "Ayla" },
    { key: "setter", userId: setter, actorUuid: setterActor, label: "GM" }
  ];
}

/**
 * A contest's sides to start with. By default P1's Ayla initiates against the GM's Brute.
 * @param {{initiator?: string|null, opposition?: string|null, initiatorActor?: string|null,
 *   oppositionActor?: string|null}} [options]
 */
function contestStartSides({ initiator = P1, opposition = null, initiatorActor = AYLA, oppositionActor = BRUTE } = {}) {
  return [
    { key: "initiator", userId: initiator, actorUuid: initiatorActor, label: "Ayla" },
    { key: "opposition", userId: opposition, actorUuid: oppositionActor, label: "Brute" }
  ];
}

/** A request to start a test against the GM's roll card, at the level "hard" by default. */
function cardTest(fields = {}) {
  return { action: "start", type: "test", sides: testStartSides(), difficultyMessageId: GM_CARD, difficultyLevel: "hard", ...fields };
}

/** A request to start a test against a typed difficulty. */
function typedTest(difficulty, fields = {}) {
  return { action: "start", type: "test", sides: testStartSides(), difficulty, ...fields };
}

/** A request to start a contest. */
function contestStart(fields = {}) {
  return { action: "start", type: "contest", sides: contestStartSides(), ...fields };
}

/** Dispatches one start request, with the actors the handler would read for the sender. */
function start(sender, request, { difficultyCard = null, actors = actorsFor(sender.userId) } = {}) {
  return dispatchStartRequest({ sender, request, difficultyCard, actors });
}

/**
 * Rolls `sizes` with `results` and confirms the dice at `totalAt` as the total and those at
 * `effectAt` as effect dice.
 * @returns {{rolled: object[], resolution: object}}
 */
function confirmRoll(sizes, results, totalAt, effectAt) {
  const pool = buildPool(sizes.map((size, i) => ({ size, source: { kind: "trait", label: `Die ${i + 1}` } })));
  const rolled = applyResults(pool, results);
  const resolution = resolve(rolled, {
    totalIds: totalAt.map(i => rolled[i].id), effectDieIds: effectAt.map(i => rolled[i].id),
    extraResultsPaid: 0, extraEffectDicePaid: 0
  });
  return { rolled, resolution };
}

/** An SFX steps an effect die past d12 after Confirm, leaving its choice open. */
function sfxPastD12(rolled, resolution, effectId = "e1") {
  const pastD12 = stepEffectDie(rolled, resolution, effectId, 1, "other");
  expect(pastD12.overflow).toMatchObject({ effectId, cause: "other" });
  return pastD12;
}

/** TC-02's pool: Hard difficulty (two d10 with the difficulty source kind), a GMC trait d8 and a risk d6. */
function tc02Pool() {
  return buildPool([
    { size: 10, source: { kind: DIFFICULTY_SOURCE_KIND, label: "Hard difficulty" }, count: 2 },
    { size: 8, source: { kind: "trait", label: "Gate guard" } },
    { size: 6, source: { kind: "risk", label: "Extra risk" } }
  ]);
}

/**
 * TC-03's card: TC-02's pool rolls d10:7, d10:3, d8:6, d6:2; the GM keeps d10(7) + d8(6) for 13,
 * and the d10 that rolled 3 is the effect die (e1).
 * @returns {{authorId: string, rolled: object[], resolution: object}} as the handler passes it in
 */
function tc03Card() {
  const rolled = applyResults(tc02Pool(), [7, 3, 6, 2]);
  const resolution = resolve(rolled, {
    totalIds: [rolled[0].id, rolled[2].id], effectDieIds: [rolled[1].id], extraResultsPaid: 0, extraEffectDicePaid: 0
  });
  expect(resolution.total).toBe(13);
  return { authorId: GM_ID, rolled, resolution };
}

/** TC-11's GM botch: d8:1, d6:1 total 0, so the difficulty is 0; the effect die is the d4 default. */
function tc11BotchCard() {
  const { rolled, resolution } = confirmRoll([8, 6], [1, 1], [], []);
  expect(resolution).toMatchObject({ total: 0, botch: true });
  return { authorId: GM_ID, rolled, resolution };
}

/**
 * The GM's card for an opposition with a d12: d12:5, d10:7, d8:6, d4:3; d10 + d8 for 13, the d12 as
 * effect die (e1), the d4 left over. An SFX then pushes e1 past d12; `choice` answers the overflow on
 * the card, or leaves it open when null.
 * @param {object|null} choice - an OverflowChoice for applyOverflowChoice
 */
function d12Card(choice) {
  const { rolled, resolution } = confirmRoll([12, 10, 8, 4], [5, 7, 6, 3], [1, 2], [0]);
  expect(resolution.total).toBe(13);
  const pending = sfxPastD12(rolled, resolution);
  const settled = choice ? applyOverflowChoice(rolled, pending, typeof choice === "function" ? choice(rolled) : choice) : pending;
  return { authorId: GM_ID, rolled, resolution: settled };
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
function exchange(rolls) {
  let state = unwrap(createContest(), "createContest");
  for ( const roll of rolls ) state = unwrap(addContestRoll(state, roll), `${roll.side} ${roll.total}`);
  return state;
}

const freshContest = () => unwrap(createContest(), "createContest");
const freshTest = (difficulty = 13) => unwrap(createTest({ difficulty }), "createTest");

/** The stored sides of a record: P1 initiates or rolls against the GM's side unless `users` says otherwise. */
function recordSides(type, users = {}) {
  const [first, second] = type === "test" ? ["roller", "setter"] : ["initiator", "opposition"];
  return [
    { key: first, userId: users[first] === undefined ? P1 : users[first], actorUuid: AYLA, label: "Ayla" },
    { key: second, userId: users[second] === undefined ? null : users[second], actorUuid: BRUTE, label: "Brute" }
  ];
}

/** What the handler and the card read from a contest message. */
function contestRecord(state, users) {
  return { type: "contest", revision: state.rolls.length, sides: recordSides("contest", users), state };
}

/** What the handler and the card read from a test's message. */
function testRecord(state, users) {
  return { type: "test", revision: state.roll ? 1 : 0, sides: recordSides("test", users), state };
}

/** TC-15's initiator roll card: d8:6, d8:5, d6:3, total 11, effect die d6. */
function tc15I() {
  return confirmRoll([8, 8, 6], [6, 5, 3], [0, 1], [2]);
}

/** TC-15's opposition roll card: d10:6, d8:4, d6:2, total 10, effect die d6. */
function tc15O() {
  return confirmRoll([10, 8, 6], [6, 4, 2], [0, 1], [2]);
}

/** TC-15's contest after the initiator's card: I 11. */
function tc15Opened() {
  return exchange([fromCard("initiator", tc15I(), CARD_I)]);
}

/** TC-15's contest after both cards: 10 doesn't beat 11, so the initiator wins by 1. */
function tc15Won() {
  return unwrap(addContestRoll(tc15Opened(), fromCard("opposition", tc15O(), CARD_O)), "O 10");
}

/** TC-17's typed rolls: I 11 (d6) → O 13 (d8) → I 15 (d10) → O 12 (d6) fails. */
function tc17Rolls() {
  return [typed("initiator", 11, 6), typed("opposition", 13, 8), typed("initiator", 15, 10), typed("opposition", 12, 6)];
}

/** TC-44's test: difficulty 13; d10:8, d8:6, d6:4, d4:3 from CARD_R, total 14, a success by 1. */
function tc44() {
  const roll = fromCard("roller", confirmRoll([10, 8, 6, 4], [8, 6, 4, 3], [0, 1], [2]), CARD_R);
  return unwrap(addTestRoll(freshTest(13), roll), "addTestRoll");
}

/** A roll card's `flags["cortex-prime"].contest` for the contest message. */
function flag(side, rollIndex) {
  return { messageId: MESSAGE, side, rollIndex };
}

describe("starting a test from a roll card (dispatchStartRequest)", () => {
  it("TC-03 P1's test against the GM's card: difficulty 13, the d10 as opposition effect die, level hard, no take-out", () => {
    expect(start(PLAYER_ONE, cardTest(), { difficultyCard: tc03Card() })).toEqual({
      ok: true,
      value: {
        type: "test", state: freshTest(13), startedBy: P1, sides: testStartSides(),
        difficultyLevel: "hard", difficultyMessageRef: GM_CARD, oppositionEffects: [{ id: "e1", size: 10 }],
        oppositionTakeOut: false
      }
    });
  });

  it("TC-53 the dialog pre-selects hard from TC-03's card, and the start keeps the level the request sends, or none", () => {
    expect(difficultyLevelOfPool(tc03Card().rolled)).toEqual({ ok: true, value: "hard" });
    const sent = level => unwrap(start(PLAYER_ONE, cardTest({ difficultyLevel: level }), { difficultyCard: tc03Card() }), level);
    expect(sent("veryHard").difficultyLevel).toBe("veryHard");
    expect(sent(null).difficultyLevel).toBeNull();
    const noLevel = cardTest();
    delete noLevel.difficultyLevel;
    expect(unwrap(start(PLAYER_ONE, noLevel, { difficultyCard: tc03Card() }), "no level").difficultyLevel).toBeNull();
  });

  it("TC-11 a botched card sets difficulty 0, and its d4 default effect die is copied", () => {
    const value = unwrap(start(PLAYER_ONE, cardTest({ difficultyLevel: null }), { difficultyCard: tc11BotchCard() }), "botch");
    expect(value.state).toEqual(freshTest(0));
    expect(value.oppositionEffects).toEqual([{ id: "e1", size: 4 }]);
    expect(value.oppositionTakeOut).toBe(false);
  });

  it("RQ-035 a card whose overflow was answered with the take-out stores oppositionTakeOut true and the d12", () => {
    const value = unwrap(start(PLAYER_ONE, cardTest(), { difficultyCard: d12Card({ kind: "take-out" }) }), "take-out");
    expect(value.oppositionTakeOut).toBe(true);
    expect(value.oppositionEffects).toEqual([{ id: "e1", size: 12 }]);
  });

  it("RQ-035 a second effect die the setter chose on the card, a new d6 or the leftover d4, is one of the opposition effect dice", () => {
    const newD6 = unwrap(start(PLAYER_ONE, cardTest(), { difficultyCard: d12Card({ kind: "new-d6" }) }), "new d6");
    expect(newD6.oppositionEffects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 6 }]);
    expect(newD6.oppositionTakeOut).toBe(false);

    const leftover = d12Card(rolled => ({ kind: "leftover", dieId: rolled[3].id }));
    const withLeftover = unwrap(start(PLAYER_ONE, cardTest(), { difficultyCard: leftover }), "leftover");
    expect(withLeftover.oppositionEffects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 4 }]);
    expect(withLeftover.oppositionTakeOut).toBe(false);
  });

  it("the setter isn't tied to the card's author: P1 starts against P2's card with the GM as setter", () => {
    const p2Card = { ...tc03Card(), authorId: P2 };
    expect(start(PLAYER_ONE, cardTest(), { difficultyCard: p2Card })).toMatchObject({ ok: true });
  });

  it("TC-12 with the roles swapped, the GM starts a test for the GMC's roll against P1's card", () => {
    const sides = testStartSides({ roller: null, setter: P1, rollerActor: BRUTE, setterActor: AYLA });
    const value = unwrap(start(GM, cardTest({ sides }), { difficultyCard: { ...tc03Card(), authorId: P1 } }), "swapped");
    expect(value).toMatchObject({ startedBy: GM_ID, sides, difficultyMessageRef: GM_CARD });
  });

  it("the GM may start a test with high stakes", () => {
    const value = unwrap(start(GM, cardTest({ highStakes: true }), { difficultyCard: tc03Card() }), "high stakes");
    expect(value.state).toEqual(unwrap(createTest({ difficulty: 13, highStakes: true }), "createTest"));
  });

  it("TC-03 the value goes into initialSystem unchanged, and the stored flow holds the snapshot", () => {
    const value = unwrap(start(PLAYER_ONE, cardTest(), { difficultyCard: d12Card({ kind: "take-out" }) }), "start");
    const created = unwrap(initialSystem(value), "initialSystem");
    expect(created).toMatchObject({ revision: 0, startedBy: P1, sides: testStartSides() });
    expect(created.flow).toMatchObject({
      type: "test", difficulty: 13, roll: null, difficultyLevel: "hard", difficultyMessageRef: GM_CARD,
      oppositionEffects: [{ id: "e1", size: 12 }], oppositionTakeOut: true
    });
  });
});

describe("starting a test with a typed difficulty", () => {
  it("a typed 13 has no level, no card, no opposition effect dice and an unknown take-out", () => {
    expect(start(PLAYER_ONE, typedTest(13))).toEqual({
      ok: true,
      value: {
        type: "test", state: freshTest(13), startedBy: P1, sides: testStartSides(),
        difficultyLevel: null, difficultyMessageRef: null, oppositionEffects: [], oppositionTakeOut: null
      }
    });
    expect(unwrap(start(PLAYER_ONE, typedTest(13, { difficultyLevel: null })), "level null").difficultyLevel).toBeNull();
  });

  it("TC-11 a typed 0 is a difficulty like any other", () => {
    expect(unwrap(start(PLAYER_ONE, typedTest(0)), "typed 0").state).toEqual(freshTest(0));
  });

  it("TC-E09 a typed difficulty of -1, 1.5, \"7\" or null is refused with INVALID_TOTAL", () => {
    for ( const difficulty of [-1, 1.5, "7", null] ) {
      expect(start(PLAYER_ONE, typedTest(difficulty)), String(difficulty)).toEqual(REFUSED("INVALID_TOTAL"));
    }
  });

  it("the typed value goes into initialSystem unchanged, with the take-out stored as null", () => {
    const created = unwrap(initialSystem(unwrap(start(PLAYER_ONE, typedTest(13)), "start")), "initialSystem");
    expect(created.flow).toMatchObject({
      difficulty: 13, difficultyLevel: null, difficultyMessageRef: null, oppositionEffects: [], oppositionTakeOut: null
    });
  });
});

describe("starting a contest", () => {
  it("TC-15 P1's contest starts as createContest does, with no test-only fields at all", () => {
    expect(start(PLAYER_ONE, contestStart())).toEqual({
      ok: true, value: { type: "contest", state: freshContest(), startedBy: P1, sides: contestStartSides() }
    });
  });

  it("the GM may start a contest with high stakes, between two players", () => {
    const sides = contestStartSides({ initiator: P1, opposition: P2, oppositionActor: BREN });
    const value = unwrap(start(GM, contestStart({ sides, highStakes: true })), "GM start");
    expect(value).toEqual({
      type: "contest", state: unwrap(createContest({ highStakes: true }), "createContest"), startedBy: GM_ID, sides
    });
  });

  it("the value goes into initialSystem unchanged", () => {
    const created = unwrap(initialSystem(unwrap(start(PLAYER_ONE, contestStart()), "start")), "initialSystem");
    expect(created.flow).toEqual({ type: "contest", ...freshContest(), usedAgainstLoser: null });
  });
});

describe("MALFORMED_REQUEST: the shape of a start", () => {
  const withSide = (request, i, fields) => ({ ...request, sides: request.sides.map((s, j) => (j === i ? { ...s, ...fields } : s)) });
  const unlabelled = testStartSides()[0];
  delete unlabelled.label;

  it.each([
    ["no request", undefined],
    ["an action other than start", { ...typedTest(13), action: "add-roll" }],
    ["sides that aren't a list", { ...typedTest(13), sides: "none" }],
    ["a side whose actor is an empty string", withSide(typedTest(13), 0, { actorUuid: "" })],
    ["a side whose actor isn't a string or null", withSide(typedTest(13), 0, { actorUuid: 5 })],
    ["a side without a label", { ...typedTest(13), sides: [unlabelled, testStartSides()[1]] }],
    ["a side whose label isn't a string", withSide(typedTest(13), 1, { label: null })],
    ["a test with both a typed difficulty and a card", cardTest({ difficulty: 13 })],
    ["a test with neither a typed difficulty nor a card", { action: "start", type: "test", sides: testStartSides() }],
    ["a test whose card id is empty", cardTest({ difficultyMessageId: "" })],
    ["a test whose card id isn't a string", cardTest({ difficultyMessageId: 7 })],
    ["a typed test with a level", typedTest(13, { difficultyLevel: "hard" })],
    ["a contest with a typed difficulty", contestStart({ difficulty: 13 })],
    ["a contest with a card", contestStart({ difficultyMessageId: GM_CARD })],
    ["a contest with a level", contestStart({ difficultyLevel: "hard" })]
  ])("%s is refused with MALFORMED_REQUEST", (_name, request) => {
    expect(start(GM, request, { difficultyCard: tc03Card() })).toEqual(REFUSED("MALFORMED_REQUEST"));
  });

  it("a label may be empty", () => {
    expect(start(PLAYER_ONE, withSide(typedTest(13), 1, { label: "" }))).toMatchObject({ ok: true });
  });
});

describe("the check order (ADR-027, Step 4.4 S3 proposal review)", () => {
  it("a type that isn't test or contest gets UNSUPPORTED_ACTION, even with difficulty fields", () => {
    const duel = { action: "start", type: "duel", sides: contestStartSides(), difficulty: 13, difficultyMessageId: GM_CARD };
    expect(start(GM, duel)).toEqual(REFUSED("UNSUPPORTED_ACTION"));
  });

  it("checkStartRequest's codes come through, before the card", () => {
    expect(start(PLAYER_ONE, cardTest({ highStakes: true }))).toEqual(REFUSED("GM_ONLY"));
    const swapped = testStartSides({ roller: null, setter: P1, rollerActor: BRUTE, setterActor: AYLA });
    expect(start(PLAYER_ONE, cardTest({ sides: swapped }))).toEqual(REFUSED("NOT_YOUR_SIDE"));
    expect(start(STRANGER, cardTest())).toEqual(REFUSED("NOT_YOUR_SIDE"));
    expect(start(GM, cardTest({ sides: [testStartSides()[0]] }))).toEqual(REFUSED("INVALID_SIDE"));
    expect(start(GM, cardTest({ highStakes: "yes" }))).toEqual(REFUSED("INVALID_HIGH_STAKES"));
  });

  it("the card's codes come before UNKNOWN_DIFFICULTY_LEVEL: not found, not confirmed, then an overflow choice still open", () => {
    const epic = cardTest({ difficultyLevel: "epic" });
    const unconfirmed = { ...tc03Card(), resolution: null };
    expect(start(GM, epic, { difficultyCard: null })).toEqual(REFUSED("POOL_ROLL_NOT_FOUND"));
    expect(start(GM, epic, { difficultyCard: unconfirmed })).toEqual(REFUSED("POOL_ROLL_NOT_CONFIRMED"));
    expect(start(GM, epic, { difficultyCard: d12Card(null) })).toEqual(REFUSED("OVERFLOW_PENDING"));
  });

  it("UNKNOWN_DIFFICULTY_LEVEL comes before the actors", () => {
    const request = cardTest({ difficultyLevel: "epic", sides: testStartSides({ rollerActor: MISSING }) });
    expect(start(PLAYER_ONE, request, { difficultyCard: tc03Card() })).toEqual(REFUSED("UNKNOWN_DIFFICULTY_LEVEL"));
  });

  it("ACTOR_NOT_FOUND, for any side, comes before NOT_YOUR_ACTOR", () => {
    const sides = testStartSides({ rollerActor: BRUTE, setterActor: MISSING });
    expect(start(PLAYER_ONE, typedTest(13, { sides }))).toEqual(REFUSED("ACTOR_NOT_FOUND"));
  });

  it("NOT_YOUR_ACTOR comes before createTest's INVALID_TOTAL", () => {
    expect(start(PLAYER_ONE, typedTest("7", { sides: testStartSides({ rollerActor: BRUTE }) })))
      .toEqual(REFUSED("NOT_YOUR_ACTOR"));
  });
});

describe("the difficulty card and its level", () => {
  it("a card that wasn't found is refused with POOL_ROLL_NOT_FOUND", () => {
    expect(start(PLAYER_ONE, cardTest())).toEqual(REFUSED("POOL_ROLL_NOT_FOUND"));
  });

  it("an unconfirmed card is refused with POOL_ROLL_NOT_CONFIRMED", () => {
    expect(start(PLAYER_ONE, cardTest(), { difficultyCard: { ...tc03Card(), resolution: null } }))
      .toEqual(REFUSED("POOL_ROLL_NOT_CONFIRMED"));
  });

  it("a card whose overflow choice is still open is refused with OVERFLOW_PENDING, so no option is dropped (p. 21)", () => {
    expect(start(PLAYER_ONE, cardTest(), { difficultyCard: d12Card(null) })).toEqual(REFUSED("OVERFLOW_PENDING"));
  });

  it("a level that isn't one of the five is refused with UNKNOWN_DIFFICULTY_LEVEL", () => {
    for ( const level of ["epic", "Hard", "", 10, "toString"] ) {
      expect(start(PLAYER_ONE, cardTest({ difficultyLevel: level }), { difficultyCard: tc03Card() }), String(level))
        .toEqual(REFUSED("UNKNOWN_DIFFICULTY_LEVEL"));
    }
  });

  it("the difficulty comes from the stored card, never from the request", () => {
    const request = { ...cardTest(), total: 4, effectSizes: [12] };
    const value = unwrap(start(PLAYER_ONE, request, { difficultyCard: tc03Card() }), "start");
    expect(value.state.difficulty).toBe(13);
    expect(value.oppositionEffects).toEqual([{ id: "e1", size: 10 }]);
  });
});

describe("the actors (ADR-027, Step 4.4 S3 proposal review)", () => {
  it("a player may name for their own starting side an actor they own, or none", () => {
    expect(start(PLAYER_ONE, typedTest(13))).toMatchObject({ ok: true });
    expect(start(PLAYER_ONE, typedTest(13, { sides: testStartSides({ rollerActor: null }) }))).toMatchObject({ ok: true });
  });

  it("a player naming for their own starting side an actor they don't own is refused with NOT_YOUR_ACTOR", () => {
    for ( const rollerActor of [BRUTE, BREN] ) {
      expect(start(PLAYER_ONE, typedTest(13, { sides: testStartSides({ rollerActor }) })), rollerActor)
        .toEqual(REFUSED("NOT_YOUR_ACTOR"));
    }
    expect(start(PLAYER_TWO, contestStart({ sides: contestStartSides({ initiator: P2, initiatorActor: AYLA }) })))
      .toEqual(REFUSED("NOT_YOUR_ACTOR"));
  });

  it("a player may name any actor for the other side: the GM's Brute, or P2's Bren", () => {
    expect(start(PLAYER_ONE, contestStart())).toMatchObject({ ok: true });
    const pvp = contestStartSides({ opposition: P2, oppositionActor: BREN });
    expect(start(PLAYER_ONE, contestStart({ sides: pvp }))).toMatchObject({ ok: true });
  });

  it("the GM may name any actor for any side, whoever owns it", () => {
    const sides = contestStartSides({ initiator: P2, initiatorActor: AYLA, oppositionActor: BREN });
    const actors = { [AYLA]: { ownedBySender: false }, [BREN]: { ownedBySender: false } };
    expect(start(GM, contestStart({ sides }), { actors })).toMatchObject({ ok: true });
  });

  it("an actor that wasn't found is refused with ACTOR_NOT_FOUND, on either side and for the GM too", () => {
    expect(start(PLAYER_ONE, typedTest(13, { sides: testStartSides({ rollerActor: MISSING }) })))
      .toEqual(REFUSED("ACTOR_NOT_FOUND"));
    expect(start(PLAYER_ONE, typedTest(13, { sides: testStartSides({ setterActor: MISSING }) })))
      .toEqual(REFUSED("ACTOR_NOT_FOUND"));
    expect(start(GM, contestStart({ sides: contestStartSides({ oppositionActor: MISSING }) })))
      .toEqual(REFUSED("ACTOR_NOT_FOUND"));
  });

  it("an actor UUID that names a property every object has, such as toString, is not found", () => {
    expect(start(GM, typedTest(13, { sides: testStartSides({ rollerActor: "toString" }) })))
      .toEqual(REFUSED("ACTOR_NOT_FOUND"));
  });

  it("only ownedBySender exactly true counts as owning the actor", () => {
    for ( const fact of [{ ownedBySender: "true" }, { ownedBySender: 1 }, {}] ) {
      const actors = { [AYLA]: fact, [BRUTE]: { ownedBySender: false } };
      expect(start(PLAYER_ONE, typedTest(13), { actors }), JSON.stringify(fact)).toEqual(REFUSED("NOT_YOUR_ACTOR"));
    }
  });

  it("a sender that isn't flagged as a GM with exactly true is a player for the actor check", () => {
    const notQuiteGM = { userId: GM_ID, isGM: "true" };
    const sides = testStartSides({ roller: GM_ID, rollerActor: BRUTE });
    expect(start(notQuiteGM, typedTest(13, { sides }), { actors: { [BRUTE]: { ownedBySender: false } } }))
      .toEqual(REFUSED("NOT_YOUR_ACTOR"));
  });
});

describe("frozen inputs", () => {
  it("a start works from a frozen input, leaves it alone, and shares no object with it", () => {
    const inputs = [
      ["card", { sender: PLAYER_ONE, request: cardTest(), difficultyCard: d12Card({ kind: "new-d6" }), actors: actorsFor(P1) }],
      ["typed", { sender: PLAYER_ONE, request: typedTest(13), difficultyCard: null, actors: actorsFor(P1) }],
      ["contest", { sender: GM, request: contestStart({ highStakes: true }), difficultyCard: null, actors: actorsFor(GM_ID) }]
    ];
    for ( const [label, input] of inputs ) {
      const frozen = deepFreeze(input);
      const before = structuredClone(frozen);
      const value = unwrap(dispatchStartRequest(frozen), label);
      expect(frozen, label).toEqual(before);
      expect(sharedObjects(value, frozen), label).toEqual([]);
    }
  });

  it("refusals leave frozen inputs alone too", () => {
    const input = deepFreeze({ sender: PLAYER_ONE, request: cardTest(), difficultyCard: d12Card(null), actors: actorsFor(P1) });
    expect(dispatchStartRequest(input)).toEqual(REFUSED("OVERFLOW_PENDING"));
  });
});

describe("the roll a test or contest waits for (expectedRoll)", () => {
  it("TC-43 a new test waits for the roller, to beat its difficulty", () => {
    expect(expectedRoll(testRecord(freshTest(13)))).toEqual({ side: "roller", toBeat: 13, rollIndex: 0 });
  });

  it("TC-44 a test with its roll, and a test closed before its roll, wait for nothing", () => {
    expect(expectedRoll(testRecord(tc44()))).toBeNull();
    expect(expectedRoll(testRecord(unwrap(closeTest(freshTest(13)), "closeTest")))).toBeNull();
  });

  it("TC-12 with the roles swapped the GMC's roller side is expected, against the total P1 set", () => {
    expect(expectedRoll(testRecord(freshTest(9), { roller: null, setter: P1 }))).toEqual({ side: "roller", toBeat: 9, rollIndex: 0 });
  });

  it("a new contest waits for the initiator, with no total to beat yet", () => {
    expect(expectedRoll(contestRecord(freshContest()))).toEqual({ side: "initiator", toBeat: null, rollIndex: 0 });
  });

  it("TC-15 after the initiator's 11 the opposition rolls to beat 11; once its 10 fails nothing is expected", () => {
    expect(expectedRoll(contestRecord(tc15Opened()))).toEqual({ side: "opposition", toBeat: 11, rollIndex: 1 });
    expect(expectedRoll(contestRecord(tc15Won()))).toBeNull();
  });

  it("TC-17 the turn and the total to beat follow the exchange: 11, 13, 15, then nothing", () => {
    const expected = [
      { side: "opposition", toBeat: 11, rollIndex: 1 },
      { side: "initiator", toBeat: 13, rollIndex: 2 },
      { side: "opposition", toBeat: 15, rollIndex: 3 },
      null
    ];
    let state = freshContest();
    for ( const [i, roll] of tc17Rolls().entries() ) {
      state = unwrap(addContestRoll(state, roll), `${roll.side} ${roll.total}`);
      expect(expectedRoll(contestRecord(state)), `after roll ${i + 1}`).toEqual(expected[i]);
    }
  });

  it("TC-18 a contest given up, and an open contest that was closed, wait for nothing", () => {
    const opened = exchange([typed("initiator", 11, 6), typed("opposition", 14, 8)]);
    expect(expectedRoll(contestRecord(unwrap(giveIn(opened, "initiator"), "give in")))).toBeNull();
    expect(expectedRoll(contestRecord(unwrap(closeContest(opened), "closeContest")))).toBeNull();
  });

  it("a missing record, or a type this module doesn't know, waits for nothing", () => {
    expect(expectedRoll(null)).toBeNull();
    expect(expectedRoll({ ...contestRecord(freshContest()), type: "duel" })).toBeNull();
  });

  it("a frozen record is left alone", () => {
    const record = deepFreeze(contestRecord(tc15Opened()));
    expect(expectedRoll(record)).toEqual({ side: "opposition", toBeat: 11, rollIndex: 1 });
  });
});

describe("who may act for a side (mayActFor)", () => {
  const PVP = { initiator: P1, opposition: P2 };

  it("the GM may act for any of the sides, the GM's side included", () => {
    for ( const key of ["initiator", "opposition"] ) {
      expect(mayActFor(GM, contestRecord(freshContest()), key), key).toBe(true);
      expect(mayActFor(GM, contestRecord(freshContest(), PVP), key), `${key} between players`).toBe(true);
    }
  });

  it("a player may act only for a side whose user they are", () => {
    expect(mayActFor(PLAYER_ONE, contestRecord(freshContest()), "initiator")).toBe(true);
    expect(mayActFor(PLAYER_ONE, contestRecord(freshContest()), "opposition")).toBe(false);
    expect(mayActFor(PLAYER_TWO, contestRecord(freshContest(), PVP), "opposition")).toBe(true);
    expect(mayActFor(PLAYER_TWO, contestRecord(freshContest(), PVP), "initiator")).toBe(false);
    expect(mayActFor(STRANGER, contestRecord(freshContest(), PVP), "initiator")).toBe(false);
    expect(mayActFor(STRANGER, contestRecord(freshContest(), PVP), "opposition")).toBe(false);
  });

  it("TC-12 with the roles swapped on a test, the GM acts for the GMC's roller and P1 for the setter only", () => {
    const swapped = testRecord(freshTest(9), { roller: null, setter: P1 });
    expect(mayActFor(GM, swapped, "roller")).toBe(true);
    expect(mayActFor(PLAYER_ONE, swapped, "setter")).toBe(true);
    expect(mayActFor(PLAYER_ONE, swapped, "roller")).toBe(false);
  });

  it("a key that isn't one of the record's sides gives false, for the GM too, and so does a missing record", () => {
    for ( const key of ["roller", "bystander", "", null] ) {
      expect(mayActFor(GM, contestRecord(freshContest()), key), String(key)).toBe(false);
      expect(mayActFor(PLAYER_ONE, contestRecord(freshContest()), key), String(key)).toBe(false);
    }
    expect(mayActFor(GM, null, "initiator")).toBe(false);
  });

  it("a sender that isn't flagged as a GM with exactly true is treated as a player", () => {
    expect(mayActFor({ userId: GM_ID, isGM: "true" }, contestRecord(freshContest()), "opposition")).toBe(false);
    expect(mayActFor({ userId: P1, isGM: 1 }, contestRecord(freshContest()), "initiator")).toBe(true);
  });
});

describe("what a flagged roll card offers (rollCardHold)", () => {
  it("TC-15 the initiator's card for the opening roll is held, then sent once the contest holds it", () => {
    expect(rollCardHold(contestRecord(freshContest()), CARD_I, flag("initiator", 0))).toBe("held");
    expect(rollCardHold(contestRecord(tc15Opened()), CARD_I, flag("initiator", 0))).toBe("sent");
  });

  it("TC-15 a sent card stays sent once the contest is decided or closed, whatever its flag says", () => {
    expect(rollCardHold(contestRecord(tc15Won()), CARD_I, flag("initiator", 0))).toBe("sent");
    expect(rollCardHold(contestRecord(tc15Won()), CARD_O, null)).toBe("sent");
    const closed = unwrap(closeContest(tc15Opened()), "closeContest");
    expect(rollCardHold(contestRecord(closed), CARD_I, flag("opposition", 5))).toBe("sent");
  });

  it("TC-15 the opposition's card is held for the second roll; one it rolled before the opening roll is free", () => {
    expect(rollCardHold(contestRecord(tc15Opened()), CARD_O, flag("opposition", 1))).toBe("held");
    expect(rollCardHold(contestRecord(tc15Opened()), CARD_O, flag("opposition", 0))).toBe("free");
  });

  it("TC-17 a card rolled for the initiator's opening turn is free on its next turn; one rolled for that turn is held", () => {
    const afterO13 = exchange(tc17Rolls().slice(0, 2));
    expect(rollCardHold(contestRecord(afterO13), OTHER_CARD, flag("initiator", 0))).toBe("free");
    expect(rollCardHold(contestRecord(afterO13), OTHER_CARD, flag("initiator", 2))).toBe("held");
  });

  it("a card flagged for the side that isn't expected to roll is free", () => {
    expect(rollCardHold(contestRecord(freshContest()), CARD_O, flag("opposition", 0))).toBe("free");
    expect(rollCardHold(contestRecord(tc15Opened()), OTHER_CARD, flag("initiator", 1))).toBe("free");
  });

  it("a decided, given-up or closed contest holds no card", () => {
    expect(rollCardHold(contestRecord(tc15Won()), OTHER_CARD, flag("initiator", 2))).toBe("free");
    expect(rollCardHold(contestRecord(tc15Won()), OTHER_CARD, flag("opposition", 2))).toBe("free");
    const opened = exchange([typed("initiator", 11, 6), typed("opposition", 14, 8)]);
    expect(rollCardHold(contestRecord(unwrap(giveIn(opened, "initiator"), "give in")), OTHER_CARD, flag("initiator", 2)))
      .toBe("free");
    const closed = unwrap(closeContest(freshContest()), "closeContest");
    expect(rollCardHold(contestRecord(closed), CARD_I, flag("initiator", 0))).toBe("free");
  });

  it("TC-44 a test's card is held for the roller until it is the test's roll; another card is then free", () => {
    expect(rollCardHold(testRecord(freshTest(13)), CARD_R, flag("roller", 0))).toBe("held");
    expect(rollCardHold(testRecord(tc44()), CARD_R, flag("roller", 0))).toBe("sent");
    expect(rollCardHold(testRecord(tc44()), OTHER_CARD, flag("roller", 0))).toBe("free");
    expect(rollCardHold(testRecord(freshTest(13)), CARD_R, flag("setter", 0))).toBe("free");
  });

  it("a missing record, or a missing or malformed flag on a card the record doesn't name, gives free", () => {
    expect(rollCardHold(null, CARD_I, flag("initiator", 0))).toBe("free");
    for ( const bad of [null, undefined, {}, { side: "initiator" }, { side: "initiator", rollIndex: "0" }] ) {
      expect(rollCardHold(contestRecord(freshContest()), CARD_I, bad), JSON.stringify(bad)).toBe("free");
    }
  });

  it("a frozen record and flag are left alone", () => {
    const record = deepFreeze(contestRecord(tc15Opened()));
    expect(rollCardHold(record, CARD_O, deepFreeze(flag("opposition", 1)))).toBe("held");
  });
});
