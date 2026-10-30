/**
 * Pure mapping between the stored data of a `contest` chat message and the rules engine's state
 * (Decisions ADR-020, Step 4.4 S1 proposal review). The engine fields keep the names of
 * ContestState, TestState and ContestRoll, so the mapping is mostly a copy; what it adds are the
 * fields that live only in the model: the sides, the revision, who started the test or contest,
 * each roll's sender, the effect dice used against the loser, and a test's difficulty level,
 * difficulty card and opposition effect dice.
 *
 * It works on source data, i.e. `message.system.toObject()`, never on the initialized model, and
 * it never changes its inputs: every object it returns is new. It has no Foundry globals and
 * imports only from module/rules/ (checked by ESLint and tests/unit/rules-boundary.test.mjs), so
 * it loads and is unit tested in plain Node. The model in contest.mjs imports from here, never
 * the reverse.
 *
 * Every function returns an EngineResult, `{ ok: true, value }` or `{ ok: false, code }` (the
 * contract of Decisions ADR-025). A refusal here means a bug, not play: the GM's handler reports
 * it as WRITE_FAILED with the code in the console, so the codes get no language strings.
 * @module data/chat/contest-mapping
 */

import { fail, ok } from "../../rules/result.mjs";

/**
 * @typedef {import("../../rules/types.mjs").ContestState} ContestState
 * @typedef {import("../../rules/types.mjs").TestState} TestState
 * @typedef {import("../../rules/types.mjs").ContestRoll} ContestRoll
 * @typedef {import("../../rules/types.mjs").ContestEffect} ContestEffect
 * @typedef {import("../../rules/types.mjs").DifficultyLevel} DifficultyLevel
 */

/**
 * @template T
 * @typedef {import("../../rules/types.mjs").EngineResult<T>} EngineResult
 */

/**
 * One side of a stored test or contest (ADR-020).
 * @typedef {Object} StoredSide
 * @property {string} key - a side key; in M3 one of CONTEST_SIDES or TEST_SIDES
 * @property {string|null} userId - the user who acts for the side, or null for the GM's side
 * @property {string|null} actorUuid - the side's actor, or null
 * @property {string} label - the name the card shows for the side
 */

/**
 * A stored roll: the engine's ContestRoll plus the user who sent it.
 * @typedef {ContestRoll & {userId: string}} StoredRoll
 */

/**
 * The stored flow of a contest: the ContestState fields with stored rolls, plus the effect ids
 * the winner uses against the loser, null until the winner picks.
 * @typedef {Object} StoredContestFlow
 * @property {"contest"} type
 * @property {boolean} highStakes
 * @property {StoredRoll[]} rolls
 * @property {number|null} difficulty
 * @property {string|null} turn
 * @property {'open'|'won'|'gaveIn'|'declined'} status
 * @property {string|null} winner
 * @property {Object<string, boolean>} hasRolled - keyed by side key
 * @property {number|null} margin
 * @property {number} heroicSteps
 * @property {string|null} heroicAppliedTo
 * @property {boolean} closed
 * @property {string[]|null} usedAgainstLoser - model only
 */

/**
 * The stored flow of a test: the TestState fields with a stored roll, plus the test's difficulty
 * level, difficulty card and opposition effect dice (kept for rule 24, M4).
 * @typedef {Object} StoredTestFlow
 * @property {"test"} type
 * @property {boolean} highStakes
 * @property {number} difficulty
 * @property {StoredRoll|null} roll
 * @property {boolean|null} success
 * @property {number|null} margin
 * @property {number} heroicSteps
 * @property {string|null} heroicAppliedTo
 * @property {boolean} closed
 * @property {DifficultyLevel|null} difficultyLevel - model only; null for a typed difficulty
 * @property {string|null} difficultyMessageRef - model only; the difficulty card's message id
 * @property {ContestEffect[]} oppositionEffects - model only; empty for a typed difficulty
 */

/** @typedef {StoredContestFlow|StoredTestFlow} StoredFlow */

/**
 * The `system` source data of a contest message.
 * @typedef {Object} ContestSystemSource
 * @property {number} schemaVersion
 * @property {number} revision - raised by one with every write (ADR-027)
 * @property {string} startedBy - the user who started the test or contest
 * @property {StoredSide[]} sides
 * @property {StoredFlow} flow
 */

/**
 * What one write sends: the whole flow and the revision raised by one (ADR-027 block).
 * @typedef {Object} SystemChanges
 * @property {number} revision
 * @property {StoredFlow} flow
 */

/**
 * Model-only data that comes with a write.
 * @typedef {Object} WriteExtras
 * @property {string} [rollUserId] - the sender of the roll the engine appended; required exactly
 *   when a roll was appended
 * @property {string[]|null} [usedAgainstLoser] - the winner's pick (contest only); kept as stored
 *   when left out
 */

/**
 * What a new test or contest message starts from.
 * @typedef {Object} InitialInput
 * @property {string} type - one of FLOW_TYPES
 * @property {ContestState|TestState} state - from createContest or createTest, with no roll yet
 * @property {string} startedBy
 * @property {StoredSide[]} sides
 * @property {DifficultyLevel|null} [difficultyLevel=null] - test only; a contest leaves it out
 * @property {string|null} [difficultyMessageRef=null] - test only; a contest leaves it out
 * @property {ContestEffect[]} [oppositionEffects=[]] - test only; a contest leaves it out
 */

/** The current schema version of the contest message's data; contest.mjs re-exports it. */
export const CONTEST_SCHEMA_VERSION = 1;

/** The values of `system.flow.type` (ADR-020). */
export const FLOW_TYPES = Object.freeze(["test", "contest"]);

/** The ContestState fields, copied both ways under the same names. */
export const CONTEST_STATE_KEYS = Object.freeze([
  "highStakes", "rolls", "difficulty", "turn", "status", "winner", "hasRolled", "margin", "heroicSteps",
  "heroicAppliedTo", "closed"
]);

/** The TestState fields, copied both ways under the same names. */
export const TEST_STATE_KEYS = Object.freeze([
  "highStakes", "difficulty", "roll", "success", "margin", "heroicSteps", "heroicAppliedTo", "closed"
]);

/** The ContestRoll fields, copied both ways under the same names. */
export const ROLL_KEYS = Object.freeze([
  "side", "total", "effects", "overflows", "leftovers", "nextEffectNumber", "messageRef"
]);

/** The fields of a stored side. */
const SIDE_KEYS = Object.freeze(["key", "userId", "actorUuid", "label"]);

/**
 * A deep copy of plain data (arrays, plain objects and primitives), so no returned object is shared
 * with an input.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function copyPlain(value) {
  if ( Array.isArray(value) ) return value.map(copyPlain);
  if ( value && (typeof value === "object") ) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, copyPlain(inner)]));
  }
  return value;
}

/**
 * @param {object} source
 * @param {readonly string[]} keys
 * @returns {object} a deep copy of the named fields of `source`, and nothing else
 */
function pick(source, keys) {
  return Object.fromEntries(keys.map(key => [key, copyPlain(source[key])]));
}

/**
 * Whether `state` is an engine state of the kind the flow type holds: a contest has a list of
 * rolls, a test a roll or null.
 * @param {string} type - one of FLOW_TYPES
 * @param {unknown} state
 * @returns {boolean}
 */
function isStateOf(type, state) {
  if ( !state || (typeof state !== "object") ) return false;
  return type === "contest" ? Array.isArray(state.rolls) : ("roll" in state);
}

/**
 * @param {string} type - one of FLOW_TYPES
 * @param {object} holder - a stored flow or an engine state of that type
 * @returns {object[]} its rolls in order; a test has none or one
 */
function rollsOf(type, holder) {
  if ( type === "contest" ) return holder.rolls;
  return holder.roll ? [holder.roll] : [];
}

/**
 * Whether the rolls after an engine function keep the stored ones: the same rolls at the same
 * positions, each with its side, total and message ref unchanged, and at most one roll appended.
 * The engine replaces rolls in place and only appends (contest.mjs), so anything else is a bug.
 * @param {object[]} before - the stored rolls
 * @param {object[]} after - the engine's rolls
 * @returns {boolean}
 */
function rollsKept(before, after) {
  if ( (after.length < before.length) || (after.length > before.length + 1) ) return false;
  return before.every((roll, i) => (roll.side === after[i].side) && (roll.total === after[i].total)
    && (roll.messageRef === after[i].messageRef));
}

/**
 * A stored flow of the given type from an engine state, its stored rolls and its model-only fields.
 * @param {string} type - one of FLOW_TYPES
 * @param {ContestState|TestState} state
 * @param {StoredRoll[]} rolls - new objects, each with its userId
 * @param {object} modelOnly - usedAgainstLoser for a contest; difficultyLevel, difficultyMessageRef
 *   and oppositionEffects for a test
 * @returns {StoredFlow}
 */
function storedFlow(type, state, rolls, modelOnly) {
  if ( type === "contest" ) {
    return { type, ...pick(state, CONTEST_STATE_KEYS), rolls, usedAgainstLoser: copyPlain(modelOnly.usedAgainstLoser) };
  }
  return {
    type, ...pick(state, TEST_STATE_KEYS), roll: rolls[0] ?? null, difficultyLevel: modelOnly.difficultyLevel,
    difficultyMessageRef: modelOnly.difficultyMessageRef, oppositionEffects: copyPlain(modelOnly.oppositionEffects)
  };
}

/**
 * The engine state held in a stored flow: a new copy of its engine fields, without the model-only
 * ones (each roll's userId, usedAgainstLoser, and a test's difficultyLevel, difficultyMessageRef and
 * oppositionEffects). It doesn't check what the model's schema already guarantees.
 * @param {StoredFlow} flow - source data, e.g. `message.system.toObject().flow`
 * @returns {EngineResult<ContestState|TestState>} UNKNOWN_FLOW_TYPE for a flow type that isn't one
 *   of FLOW_TYPES
 */
export function engineStateOf(flow) {
  switch ( flow?.type ) {
    case "contest":
      return ok({ ...pick(flow, CONTEST_STATE_KEYS), rolls: flow.rolls.map(roll => pick(roll, ROLL_KEYS)) });
    case "test":
      return ok({ ...pick(flow, TEST_STATE_KEYS), roll: flow.roll ? pick(flow.roll, ROLL_KEYS) : null });
    default:
      return fail("UNKNOWN_FLOW_TYPE");
  }
}

/**
 * The changes for one write after an engine function returned `state` for the stored flow: the
 * whole flow and the revision raised by one (ADR-027). The engine fields are copied from `state`;
 * the model-only fields are kept from the stored flow, except usedAgainstLoser when `extras` gives
 * it. Each existing roll keeps its userId by position, and a roll the engine appended gets
 * `extras.rollUserId`. The engine only appends rolls or replaces them in place, and a roll's side,
 * total and message ref never change, so a roll that moved or went missing means a bug.
 * @param {ContestSystemSource} system - the message's current source
 * @param {ContestState|TestState} state - the engine's result for engineStateOf(system.flow)
 * @param {WriteExtras} [extras]
 * @returns {EngineResult<SystemChanges>} refuses, checked in this order: UNKNOWN_FLOW_TYPE (the
 *   stored flow type isn't one of FLOW_TYPES), FLOW_TYPE_MISMATCH (the state isn't of the stored
 *   flow's kind, or usedAgainstLoser is given for a test), ROLLS_CHANGED (fewer rolls, more than one
 *   new roll, or a changed side, total or message ref at a position; for a test, a roll removed or
 *   changed), ROLL_USER_MISSING (a roll was appended without rollUserId), ROLL_USER_UNUSED
 *   (rollUserId is given but no roll was appended)
 */
export function systemChangesAfter(system, state, extras = {}) {
  const { rollUserId, usedAgainstLoser } = extras;
  const flow = system.flow;
  const type = flow?.type;
  if ( !FLOW_TYPES.includes(type) ) return fail("UNKNOWN_FLOW_TYPE");
  if ( !isStateOf(type, state) ) return fail("FLOW_TYPE_MISMATCH");
  if ( (type === "test") && (usedAgainstLoser !== undefined) ) return fail("FLOW_TYPE_MISMATCH");

  const before = rollsOf(type, flow);
  const after = rollsOf(type, state);
  if ( !rollsKept(before, after) ) return fail("ROLLS_CHANGED");
  const appended = after.length > before.length;
  if ( appended && ((typeof rollUserId !== "string") || !rollUserId) ) return fail("ROLL_USER_MISSING");
  if ( !appended && (rollUserId !== undefined) ) return fail("ROLL_USER_UNUSED");

  const rolls = after.map((roll, i) => ({
    ...pick(roll, ROLL_KEYS), userId: i < before.length ? before[i].userId : rollUserId
  }));
  const modelOnly = type === "contest"
    ? { usedAgainstLoser: usedAgainstLoser === undefined ? flow.usedAgainstLoser : usedAgainstLoser }
    : flow;
  return ok({ revision: system.revision + 1, flow: storedFlow(type, state, rolls, modelOnly) });
}

/**
 * The system data for a new test or contest message: the current schema version, revision 0, the
 * given sides and starter, and a flow copied from the engine's starting state. A test's model-only
 * fields default to null, null and an empty list; a contest's usedAgainstLoser starts as null.
 * @param {InitialInput} input
 * @returns {EngineResult<ContestSystemSource>} refuses, checked in this order: UNKNOWN_FLOW_TYPE,
 *   FLOW_TYPE_MISMATCH (the state isn't of the given type's kind, then a contest given
 *   difficultyLevel, difficultyMessageRef or oppositionEffects, any of them not undefined, as
 *   systemChangesAfter refuses usedAgainstLoser for a test), INITIAL_ROLLS_PRESENT (the state
 *   already holds a roll)
 */
export function initialSystem({
  type, state, startedBy, sides, difficultyLevel, difficultyMessageRef, oppositionEffects
} = {}) {
  if ( !FLOW_TYPES.includes(type) ) return fail("UNKNOWN_FLOW_TYPE");
  if ( !isStateOf(type, state) ) return fail("FLOW_TYPE_MISMATCH");
  const testOnly = [difficultyLevel, difficultyMessageRef, oppositionEffects];
  if ( (type === "contest") && testOnly.some(value => value !== undefined) ) return fail("FLOW_TYPE_MISMATCH");
  if ( rollsOf(type, state).length > 0 ) return fail("INITIAL_ROLLS_PRESENT");

  const modelOnly = type === "contest" ? { usedAgainstLoser: null } : {
    difficultyLevel: difficultyLevel ?? null,
    difficultyMessageRef: difficultyMessageRef ?? null,
    oppositionEffects: oppositionEffects ?? []
  };
  return ok({
    schemaVersion: CONTEST_SCHEMA_VERSION,
    revision: 0,
    startedBy,
    sides: sides.map(side => pick(side, SIDE_KEYS)),
    flow: storedFlow(type, state, [], modelOnly)
  });
}
