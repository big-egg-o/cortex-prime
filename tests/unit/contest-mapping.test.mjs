import { describe, expect, it } from "vitest";
import {
  CONTEST_STATE_KEYS, ROLL_KEYS, TEST_STATE_KEYS, engineStateOf, initialSystem, systemChangesAfter
} from "../../module/data/chat/contest-mapping.mjs";
import {
  addContestRoll, addTestRoll, applyContestHeroicSteps, applyResults, applyTestHeroicSteps,
  autoApplyContestHeroicSteps, buildPool, chooseContestOverflow, chooseTestOverflow, contestConsequence,
  contestRollFromResolution, contestRollFromTotal, createContest, createTest, resolve, setContestHighStakes,
  setTestHighStakes, stepEffectDie, testResult
} from "../../module/rules/index.mjs";

/** Fake ids in Foundry's 16-character format. */
const PLAYER = "playerOne0000001";
const GM = "gameMaster000001";
const CARD_I = "rollCardI0000001";
const CARD_R = "rollCardR0000001";
const DIFFICULTY_CARD = "gmRollCard000001";

/** @returns {object[]} the stored sides of a contest: a player's initiator, the GM's opposition */
function contestSides() {
  return [
    { key: "initiator", userId: PLAYER, actorUuid: "Actor.actorAyla0000001", label: "Ayla" },
    { key: "opposition", userId: null, actorUuid: "Actor.actorBrute000001", label: "Brute" }
  ];
}

/** @returns {object[]} the stored sides of a test: a player's roller, the GM as setter */
function testSides() {
  return [
    { key: "roller", userId: PLAYER, actorUuid: "Actor.actorAyla0000001", label: "Ayla" },
    { key: "setter", userId: null, actorUuid: null, label: "GM" }
  ];
}

/** @returns {object} a test's model-only fields when the difficulty came from a roll card */
function difficultyCard() {
  return { difficultyLevel: "challenging", difficultyMessageRef: DIFFICULTY_CARD, oppositionEffects: [{ id: "e1", size: 8 }] };
}

/** @returns {object} a test's model-only fields for a typed difficulty */
function noCard() {
  return { difficultyLevel: null, difficultyMessageRef: null, oppositionEffects: [] };
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

/** TC-15's first roll: I rolls d8:6, d8:5, d6:3, total 11, effect die d6. */
function tc15FirstRoll() {
  const { rolled, resolution } = confirmRoll([8, 8, 6], [6, 5, 3], [0, 1], [2]);
  expect(resolution.total).toBe(11);
  return unwrap(contestRollFromResolution("initiator", rolled, resolution, CARD_I), "contestRollFromResolution");
}

/** TC-17's rolls: I 11 (d6) → O 13 (d8) → I 15 (d10) → O 12 (d6). */
function tc17Rolls() {
  return [typed("initiator", 11, 6), typed("opposition", 13, 8), typed("initiator", 15, 10), typed("opposition", 12, 6)];
}

/** The senders of TC-17's rolls: the player for the initiator, the GM for the opposition. */
const TC17_USERS = [PLAYER, GM, PLAYER, GM];

/** TC-44's roll: d10:8, d8:6, d6:4, d4:3, total 14, effect die d6 (e1), the d4 left over. */
function tc44Roll() {
  const { rolled, resolution } = confirmRoll([10, 8, 6, 4], [8, 6, 4, 3], [0, 1], [2]);
  expect(resolution.total).toBe(14);
  return unwrap(contestRollFromResolution("roller", rolled, resolution, CARD_R), "contestRollFromResolution");
}

/** TC-44's test: difficulty 13 with TC-44's roll, a success by 1. */
function tc44State() {
  return unwrap(addTestRoll(unwrap(createTest({ difficulty: 13 }), "createTest"), tc44Roll()), "addTestRoll");
}

/**
 * TC-48's test: difficulty 8; d10:9, d8:8, d12:2, d6:3 with 1 PP extra, total 17, effect dice d12
 * (e1) and d6 (e2); an SFX steps e1 past d12 after Confirm. Margin 9, one step.
 */
function tc48State() {
  const { rolled, resolution } = confirmRoll([10, 8, 12, 6], [9, 8, 2, 3], [0, 1], [2, 3], 1);
  const roll = unwrap(contestRollFromResolution("roller", rolled, sfxPastD12(rolled, resolution), CARD_R), "roll");
  return unwrap(addTestRoll(unwrap(createTest({ difficulty: 8 }), "createTest"), roll), "addTestRoll");
}

/**
 * TC-E08's initiator roll: d10:9, d8:8, d12:2, d12:3 with 1 PP extra, total 17, effect dice d12 (e1)
 * and d12 (e2); an SFX pushes e1 past d12 during the exchange.
 */
function tcE08InitiatorRoll() {
  const { rolled, resolution } = confirmRoll([10, 8, 12, 12], [9, 8, 2, 3], [0, 1], [2, 3], 1);
  return unwrap(contestRollFromResolution("initiator", rolled, sfxPastD12(rolled, resolution), CARD_I), "roll");
}

/** TC-55's roll: d12:3, d10:7, d8:6, d4:2, total 13, effect die d12 (e1) stepped past d12 by an SFX. */
function tc55Roll() {
  const { rolled, resolution } = confirmRoll([12, 10, 8, 4], [3, 7, 6, 2], [1, 2], [0]);
  expect(resolution.total).toBe(13);
  return unwrap(contestRollFromResolution("roller", rolled, sfxPastD12(rolled, resolution), CARD_R), "roll");
}

/**
 * A stored contest flow built by hand from an engine state, in the documented shape.
 * @param {object} state - a ContestState
 * @param {string[]} userIds - the sender of each roll, in order
 * @param {string[]|null} [usedAgainstLoser]
 */
function storedContestFlow(state, userIds, usedAgainstLoser = null) {
  return structuredClone({
    type: "contest", ...state, rolls: state.rolls.map((roll, i) => ({ ...roll, userId: userIds[i] })), usedAgainstLoser
  });
}

/**
 * A stored test flow built by hand from an engine state, in the documented shape.
 * @param {object} state - a TestState
 * @param {string|null} userId - the roll's sender; unused while there is no roll
 * @param {object} [card] - the test's model-only fields
 */
function storedTestFlow(state, userId, card = noCard()) {
  return structuredClone({ type: "test", ...state, roll: state.roll && { ...state.roll, userId }, ...card });
}

/** A stored system source around a flow. */
function storedSystem(flow, revision = 0) {
  return {
    schemaVersion: 1, revision, startedBy: PLAYER, sides: flow.type === "test" ? testSides() : contestSides(), flow
  };
}

/** The stored system after one write, failing the test on a refusal. */
function write(system, state, extras) {
  return { ...system, ...unwrap(systemChangesAfter(system, state, extras), "systemChangesAfter") };
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

const REFUSED = code => ({ ok: false, code });

describe("a new test or contest (initialSystem)", () => {
  it("TC-43 a new test gets schema version 1, revision 0, its sides and starter, and empty test-only fields", () => {
    const state = unwrap(createTest({ difficulty: 13 }), "createTest");
    const created = initialSystem({ type: "test", state, startedBy: PLAYER, sides: testSides() });
    expect(created).toEqual({
      ok: true,
      value: {
        schemaVersion: 1, revision: 0, startedBy: PLAYER, sides: testSides(),
        flow: { type: "test", ...state, difficultyLevel: null, difficultyMessageRef: null, oppositionEffects: [] }
      }
    });
    expect(engineStateOf(created.value.flow)).toEqual({ ok: true, value: state });
  });

  it("TC-43 a test started with high stakes stores the flag", () => {
    const state = unwrap(createTest({ difficulty: 13, highStakes: true }), "createTest");
    const created = unwrap(initialSystem({ type: "test", state, startedBy: PLAYER, sides: testSides() }), "initialSystem");
    expect(created.flow.highStakes).toBe(true);
  });

  it("a new contest stores hasRolled as false for both sides and usedAgainstLoser as null, and reads back unchanged", () => {
    const state = unwrap(createContest(), "createContest");
    const created = unwrap(initialSystem({ type: "contest", state, startedBy: PLAYER, sides: contestSides() }), "initialSystem");
    expect(created).toEqual({
      schemaVersion: 1, revision: 0, startedBy: PLAYER, sides: contestSides(),
      flow: { type: "contest", ...state, usedAgainstLoser: null }
    });
    expect(created.flow.hasRolled).toEqual({ initiator: false, opposition: false });
    expect(engineStateOf(created.flow)).toEqual({ ok: true, value: state });
  });

  it("an unknown flow type is refused with UNKNOWN_FLOW_TYPE", () => {
    const state = unwrap(createTest({ difficulty: 13 }), "createTest");
    expect(initialSystem({ type: "duel", state, startedBy: PLAYER, sides: testSides() }))
      .toEqual(REFUSED("UNKNOWN_FLOW_TYPE"));
  });

  it("TC-15 a contest state that already holds the initiator's first roll is refused with INITIAL_ROLLS_PRESENT", () => {
    const state = unwrap(addContestRoll(unwrap(createContest(), "createContest"), tc15FirstRoll()), "I 11");
    expect(initialSystem({ type: "contest", state, startedBy: PLAYER, sides: contestSides() }))
      .toEqual(REFUSED("INITIAL_ROLLS_PRESENT"));
  });

  it("a test state given the type contest is refused with FLOW_TYPE_MISMATCH", () => {
    const state = unwrap(createTest({ difficulty: 13 }), "createTest");
    expect(initialSystem({ type: "contest", state, startedBy: PLAYER, sides: contestSides() }))
      .toEqual(REFUSED("FLOW_TYPE_MISMATCH"));
  });

  it("a contest given difficultyLevel, difficultyMessageRef or oppositionEffects is refused with FLOW_TYPE_MISMATCH", () => {
    const state = unwrap(createContest(), "createContest");
    for ( const fields of [difficultyCard(), noCard()] ) {
      for ( const [field, value] of Object.entries(fields) ) {
        expect(initialSystem({ type: "contest", state, startedBy: PLAYER, sides: contestSides(), [field]: value }), field)
          .toEqual(REFUSED("FLOW_TYPE_MISMATCH"));
      }
    }
  });
});

describe("reading the engine state (engineStateOf)", () => {
  it("TC-17 the stored exchange reads back as the engine state without the model-only fields, and gives the d10 complication", () => {
    const state = exchange(tc17Rolls());
    const read = engineStateOf(storedContestFlow(state, TC17_USERS));
    expect(read).toEqual({ ok: true, value: state });

    const consequence = unwrap(contestConsequence(read.value, { usedAgainstLoser: ["e1"] }), "consequence");
    expect(consequence.comparisons).toEqual([
      { effectId: "e1", winnerDie: 10, loserDie: 6, steppedDown: false, complication: 10, takesOut: false }
    ]);
  });

  it("TC-44 the stored test reads back without the roll's userId and the test-only fields; it is a success by 1", () => {
    const state = tc44State();
    const read = engineStateOf(storedTestFlow(state, PLAYER, difficultyCard()));
    expect(read).toEqual({ ok: true, value: state });
    expect(testResult(read.value)).toEqual({
      ok: true,
      value: { success: true, margin: 1, heroic: false, heroicSteps: 0, effects: [{ id: "e1", size: 6 }], takeOut: false }
    });
  });

  it("an unknown flow type is refused with UNKNOWN_FLOW_TYPE", () => {
    expect(engineStateOf({ ...storedTestFlow(tc44State(), PLAYER), type: "duel" })).toEqual(REFUSED("UNKNOWN_FLOW_TYPE"));
  });
});

describe("one write (systemChangesAfter)", () => {
  it("TC-44 the roll is stored with its sender's userId, the revision goes up by one and the test-only fields stay", () => {
    const started = unwrap(createTest({ difficulty: 13 }), "createTest");
    const before = storedSystem(storedTestFlow(started, null, difficultyCard()));
    const added = unwrap(addTestRoll(started, tc44Roll()), "addTestRoll");

    const changes = systemChangesAfter(before, added, { rollUserId: PLAYER });
    expect(changes).toEqual({ ok: true, value: { revision: 1, flow: storedTestFlow(added, PLAYER, difficultyCard()) } });
    expect(engineStateOf(changes.value.flow)).toEqual({ ok: true, value: added });
  });

  it("TC-44 a roll appended without rollUserId is refused with ROLL_USER_MISSING", () => {
    const started = unwrap(createTest({ difficulty: 13 }), "createTest");
    const before = storedSystem(storedTestFlow(started, null));
    const added = unwrap(addTestRoll(started, tc44Roll()), "addTestRoll");
    expect(systemChangesAfter(before, added)).toEqual(REFUSED("ROLL_USER_MISSING"));
  });

  it("TC-51 setting high stakes with a rollUserId, when no roll was appended, is refused with ROLL_USER_UNUSED", () => {
    const state = tc44State();
    const before = storedSystem(storedTestFlow(state, PLAYER, difficultyCard()));
    const highStakes = unwrap(setTestHighStakes(state, true), "high stakes on");
    expect(systemChangesAfter(before, highStakes, { rollUserId: PLAYER })).toEqual(REFUSED("ROLL_USER_UNUSED"));
  });

  it("TC-47 two writes store each roll with its sender, and the automatic step replaces the winner's roll in place", () => {
    const started = unwrap(createContest(), "createContest");
    let stored = storedSystem(storedContestFlow(started, []));
    const opened = unwrap(addContestRoll(started, typed("initiator", 17, 8)), "I 17");
    stored = write(stored, opened, { rollUserId: PLAYER });
    const won = unwrap(addContestRoll(opened, typed("opposition", 12, 8)), "O 12");
    stored = write(stored, won, { rollUserId: GM });

    const stepped = unwrap(autoApplyContestHeroicSteps(won), "automatic step");
    expect(stepped).not.toBe(won);
    stored = write(stored, stepped);

    expect(stored.revision).toBe(3);
    expect(stored.flow.heroicAppliedTo).toBe("e1");
    expect(stored.flow.rolls).toEqual([{ ...stepped.rolls[0], userId: PLAYER }, { ...stepped.rolls[1], userId: GM }]);
    expect(stored.flow.rolls[0].effects).toEqual([{ id: "e1", size: 10 }]);
  });

  it("TC-48 steps that join e1's overflow, then a new d6, store d12, d6 and d6; the userId and the test-only fields stay", () => {
    const added = tc48State();
    let stored = storedSystem(storedTestFlow(added, PLAYER, difficultyCard()));
    const stepped = unwrap(applyTestHeroicSteps(added, "e1"), "steps on e1");
    stored = write(stored, stepped);
    const chosen = unwrap(chooseTestOverflow(stepped, { kind: "new-d6" }), "new d6");
    stored = write(stored, chosen);

    expect(stored.revision).toBe(2);
    expect(stored.flow.roll.effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 6 }, { id: "e3", size: 6 }]);
    expect(stored.flow.roll.userId).toBe(PLAYER);
    expect(stored.flow).toMatchObject(difficultyCard());
    expect(engineStateOf(stored.flow)).toEqual({ ok: true, value: chosen });
  });

  it("TC-E08 the winner's roll at position 0 changes, the loser's at position 1 doesn't, and both keep their userIds", () => {
    const state = exchange([tcE08InitiatorRoll(), typed("opposition", 12, 8)]);
    let stored = storedSystem(storedContestFlow(state, [PLAYER, GM]));
    const loserBefore = structuredClone(stored.flow.rolls[1]);

    const stepped = unwrap(applyContestHeroicSteps(state, "e2"), "steps on e2");
    stored = write(stored, stepped);
    const afterE1 = unwrap(chooseContestOverflow(stepped, { effectId: "e1", kind: "new-d6" }), "new d6 for e1");
    stored = write(stored, afterE1);
    const afterE2 = unwrap(chooseContestOverflow(afterE1, { effectId: "e2", kind: "take-out" }), "take-out for e2");
    stored = write(stored, afterE2);

    expect(stored.flow.rolls[0]).toEqual({ ...afterE2.rolls[0], userId: PLAYER });
    expect(stored.flow.rolls[0].effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 12 }, { id: "e3", size: 6 }]);
    expect(stored.flow.rolls[1]).toEqual(loserBefore);
    expect(stored.flow.rolls.map(roll => roll.userId)).toEqual([PLAYER, GM]);
  });

  it("TC-55 the open overflow is stored with kind null, and after the round trip e1 counts as a d12 without waiting", () => {
    const started = unwrap(createTest({ difficulty: 15 }), "createTest");
    const added = unwrap(addTestRoll(started, tc55Roll()), "addTestRoll");
    const stored = write(storedSystem(storedTestFlow(started, null)), added, { rollUserId: PLAYER });

    expect(stored.flow.roll.overflows).toEqual([{ effectId: "e1", cause: "other", kind: null, dieId: null }]);
    expect(testResult(unwrap(engineStateOf(stored.flow), "engineStateOf"))).toEqual({
      ok: true,
      value: { success: false, margin: -2, heroic: false, heroicSteps: 0, effects: [{ id: "e1", size: 12 }], takeOut: false }
    });
  });

  it("TC-54b typed rolls are stored with no message ref and read back unchanged", () => {
    let state = unwrap(createContest(), "createContest");
    let stored = storedSystem(storedContestFlow(state, []));
    const rolls = [typed("initiator", 11), typed("opposition", 13, 8), typed("initiator", 12, 10)];
    for ( const [i, roll] of rolls.entries() ) {
      state = unwrap(addContestRoll(state, roll), `${roll.side} ${roll.total}`);
      stored = write(stored, state, { rollUserId: [PLAYER, GM, PLAYER][i] });
    }

    expect(stored.flow.rolls.map(roll => roll.messageRef)).toEqual([null, null, null]);
    expect(stored.flow.rolls[2].effects).toEqual([{ id: "e1", size: 10 }]);
    const read = engineStateOf(stored.flow);
    expect(read).toEqual({ ok: true, value: state });
    expect(unwrap(contestConsequence(read.value, { usedAgainstLoser: ["e1"] }), "consequence").comparisons).toEqual([
      { effectId: "e1", winnerDie: 8, loserDie: 10, steppedDown: true, complication: 6, takesOut: false }
    ]);
  });

  it("TC-17 usedAgainstLoser is set through extras, kept as stored when left out, and never part of the engine state", () => {
    const state = exchange(tc17Rolls());
    let stored = storedSystem(storedContestFlow(state, TC17_USERS));
    stored = write(stored, state, { usedAgainstLoser: ["e1"] });
    expect(stored.flow.usedAgainstLoser).toEqual(["e1"]);

    const highStakes = unwrap(setContestHighStakes(state, true), "high stakes on");
    stored = write(stored, highStakes);
    expect(stored.flow.usedAgainstLoser).toEqual(["e1"]);
    expect(stored.flow.highStakes).toBe(true);

    const read = unwrap(engineStateOf(stored.flow), "engineStateOf");
    expect(read).not.toHaveProperty("usedAgainstLoser");
    expect(read).toEqual(highStakes);
  });
});

describe("guards", () => {
  it("TC-17 rolls reordered, a roll removed, or two rolls appended at once are refused with ROLLS_CHANGED", () => {
    const rolls = tc17Rolls();
    const state = exchange(rolls);
    const stored = storedSystem(storedContestFlow(state, TC17_USERS));
    const [r0, r1, r2, r3] = state.rolls;
    expect(systemChangesAfter(stored, { ...state, rolls: [r1, r0, r2, r3] })).toEqual(REFUSED("ROLLS_CHANGED"));
    expect(systemChangesAfter(stored, { ...state, rolls: [r0, r1, r2] })).toEqual(REFUSED("ROLLS_CHANGED"));

    const afterTwo = storedSystem(storedContestFlow(exchange(rolls.slice(0, 2)), TC17_USERS.slice(0, 2)));
    expect(systemChangesAfter(afterTwo, state, { rollUserId: PLAYER })).toEqual(REFUSED("ROLLS_CHANGED"));
  });

  it("TC-44 a test roll whose total changed, or that was removed, is refused with ROLLS_CHANGED", () => {
    const state = tc44State();
    const stored = storedSystem(storedTestFlow(state, PLAYER, difficultyCard()));
    expect(systemChangesAfter(stored, { ...state, roll: { ...state.roll, total: 15 } })).toEqual(REFUSED("ROLLS_CHANGED"));
    expect(systemChangesAfter(stored, { ...state, roll: null })).toEqual(REFUSED("ROLLS_CHANGED"));
  });

  it("a contest given a test state, or a test given usedAgainstLoser, is refused with FLOW_TYPE_MISMATCH", () => {
    const contest = storedSystem(storedContestFlow(unwrap(createContest(), "createContest"), []));
    expect(systemChangesAfter(contest, unwrap(createTest({ difficulty: 13 }), "createTest")))
      .toEqual(REFUSED("FLOW_TYPE_MISMATCH"));

    const state = tc44State();
    const test = storedSystem(storedTestFlow(state, PLAYER, difficultyCard()));
    expect(systemChangesAfter(test, state, { usedAgainstLoser: ["e1"] })).toEqual(REFUSED("FLOW_TYPE_MISMATCH"));
  });

  it("frozen inputs are left alone, and no output shares an object with an input", () => {
    const contestInput = deepFreeze({
      type: "contest", state: unwrap(createContest(), "createContest"), startedBy: PLAYER, sides: contestSides()
    });
    expect(sharedObjects(unwrap(initialSystem(contestInput), "initialSystem"), contestInput)).toEqual([]);
    const testInput = deepFreeze({
      type: "test", state: unwrap(createTest({ difficulty: 13 }), "createTest"), startedBy: PLAYER, sides: testSides(),
      ...difficultyCard()
    });
    expect(sharedObjects(unwrap(initialSystem(testInput), "initialSystem"), testInput)).toEqual([]);

    const contestFlow = deepFreeze(storedContestFlow(exchange(tc17Rolls()), TC17_USERS, ["e1"]));
    expect(sharedObjects(unwrap(engineStateOf(contestFlow), "engineStateOf"), contestFlow)).toEqual([]);
    const testFlow = deepFreeze(storedTestFlow(tc44State(), PLAYER, difficultyCard()));
    expect(sharedObjects(unwrap(engineStateOf(testFlow), "engineStateOf"), testFlow)).toEqual([]);

    const opened = exchange([typed("initiator", 17, 8)]);
    const contestSystem = deepFreeze(storedSystem(storedContestFlow(opened, [PLAYER], ["e1"])));
    const won = deepFreeze(unwrap(addContestRoll(opened, typed("opposition", 12, 8)), "O 12"));
    const contestChanges = unwrap(systemChangesAfter(contestSystem, won, { rollUserId: GM }), "contest write");
    expect(sharedObjects(contestChanges, contestSystem, won)).toEqual([]);

    const started = unwrap(createTest({ difficulty: 13 }), "createTest");
    const testSystem = deepFreeze(storedSystem(storedTestFlow(started, null, difficultyCard())));
    const added = deepFreeze(unwrap(addTestRoll(started, tc44Roll()), "addTestRoll"));
    const testChanges = unwrap(systemChangesAfter(testSystem, added, { rollUserId: PLAYER }), "test write");
    expect(sharedObjects(testChanges, testSystem, added)).toEqual([]);
  });

  it("the key lists match the fields of the engine's contest and test states and of its rolls", () => {
    const sorted = keys => [...keys].sort();
    expect(sorted(CONTEST_STATE_KEYS)).toEqual(sorted(Object.keys(unwrap(createContest(), "createContest"))));
    expect(sorted(CONTEST_STATE_KEYS)).toEqual(sorted(Object.keys(exchange(tc17Rolls()))));
    expect(sorted(TEST_STATE_KEYS)).toEqual(sorted(Object.keys(unwrap(createTest({ difficulty: 13 }), "createTest"))));
    expect(sorted(TEST_STATE_KEYS)).toEqual(sorted(Object.keys(tc44State())));
    expect(sorted(ROLL_KEYS)).toEqual(sorted(Object.keys(tc44Roll())));
    expect(sorted(ROLL_KEYS)).toEqual(sorted(Object.keys(typed("initiator", 11, 6))));
  });

  it("TC-17 the stored system and flow have exactly the documented fields; no consequence or test result is stored", () => {
    let state = unwrap(createContest(), "createContest");
    let stored = storedSystem(storedContestFlow(state, []));
    for ( const [i, roll] of tc17Rolls().entries() ) {
      state = unwrap(addContestRoll(state, roll), `${roll.side} ${roll.total}`);
      stored = write(stored, state, { rollUserId: TC17_USERS[i] });
    }

    expect(Object.keys(stored).sort()).toEqual(["flow", "revision", "schemaVersion", "sides", "startedBy"]);
    expect(Object.keys(stored.flow).sort()).toEqual([
      "closed", "difficulty", "hasRolled", "heroicAppliedTo", "heroicSteps", "highStakes", "margin", "rolls", "status",
      "turn", "type", "usedAgainstLoser", "winner"
    ]);
    for ( const roll of stored.flow.rolls ) {
      expect(Object.keys(roll).sort()).toEqual([
        "effects", "leftovers", "messageRef", "nextEffectNumber", "overflows", "side", "total", "userId"
      ]);
    }
  });
});
