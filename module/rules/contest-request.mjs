/**
 * The pure half of the GM's handler for test and contest requests (Decisions ADR-027, Step 4.4
 * proposal review): the checks every request goes through, in a fixed order, and the dispatcher
 * that applies the engine function for an accepted request. The Foundry side (module/contest/)
 * receives the request as a user query, builds the plain inputs described below, calls
 * dispatchContestRequest, and writes the result through the contest message's mapping
 * (module/data/chat/contest-mapping.mjs, systemChangesAfter). A refusal writes nothing.
 *
 * Nothing here reads a Foundry document. The handler passes in:
 * - the sender, `{userId, isGM}`, from the user the query came from (never from the request);
 * - the request as sent, `{action, messageId, revision, payload}`;
 * - the contest message as a ContestRecord: its flow type, revision and sides, and its engine state
 *   from engineStateOf, or null when no contest message has the request's id. This module can't
 *   import the mapping (module/rules/ only imports from itself), so the handler does that step;
 * - for an add-roll naming a roll card, that poolRoll message as a PoolRollRecord, or null when it
 *   wasn't found.
 *
 * Starting a test or contest has no message yet, so it has its own pair: checkStartRequest and
 * dispatchStartRequest (Step 4.4 S3), which hand initialSystem what a new message starts from.
 * expectedRoll, mayActFor and rollCardHold answer the card's and the pool builder's questions with
 * the same rules the checks apply, and offeredActions says which controls a card may show a sender
 * by running the dispatcher itself (Step 4.4 S4a).
 *
 * The checks, in order, stopping at the first that fails (ADR-025). As ADR-027 orders them, the
 * messages are looked up and the sender is checked before the revision:
 * 1. MALFORMED_REQUEST: the request's shape (see requestMalformed).
 * 2. The messages and the action: CONTEST_NOT_FOUND, UNSUPPORTED_ACTION (an action the flow type
 *    doesn't have, or one this module doesn't know), then POOL_ROLL_NOT_FOUND for an add-roll whose
 *    roll card wasn't found.
 * 3. The sender: GM_ONLY for high stakes and closing (ADR-022); INVALID_SIDE, NOT_YOUR_SIDE or
 *    SIDE_REQUIRED for the side the action is taken for (see sideForAction); then NOT_YOUR_ROLL for
 *    a roll card that isn't the sender's.
 * 4. STALE_REVISION: the request was made against another revision of the card.
 * 5. The action's own checks: CONTEST_CLOSED for every action (ADR-027 lists the closed flag among
 *    the handler's checks), then DECLINE_AFTER_ROLL for a decline once the opposition has rolled,
 *    and for a roll card POOL_ROLL_NOT_CONFIRMED, ROLL_ALREADY_ADDED and ROLL_IN_OTHER_CONTEST.
 * 6. The engine's codes, in the order the engine checks them. A roll has to be built before it can
 *    be added, so the builder's codes (CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE for a roll card,
 *    INVALID_DIE_SIZE for typed effect dice) come before the add function's, CONTEST_RESOLVED
 *    included.
 * @module rules/contest-request
 */

import {
  CONTEST_SIDES, TEST_SIDES, addContestRoll, addTestRoll, applyContestHeroicSteps, applyTestHeroicSteps,
  autoApplyContestHeroicSteps, autoApplyTestHeroicSteps, chooseContestOverflow, chooseTestOverflow, closeContest,
  closeTest, contestConsequence, contestRollFromResolution, contestRollFromTotal, createContest, createTest, giveIn,
  setContestHighStakes, setTestHighStakes
} from "./contest.mjs";
import { DIFFICULTY_LEVELS } from "./outcome.mjs";
import { fail, ok } from "./result.mjs";
import { OVERFLOW_PENDING } from "./roll.mjs";

/**
 * @template T
 * @typedef {import("./types.mjs").EngineResult<T>} EngineResult
 */

/**
 * @typedef {import("./types.mjs").ContestState} ContestState
 * @typedef {import("./types.mjs").TestState} TestState
 * @typedef {import("./types.mjs").ContestRoll} ContestRoll
 */

/**
 * The user a request came from. The handler takes it from the query's own user, which the server
 * supplies, so it is trusted; only `isGM === true` counts as a GM.
 * @typedef {Object} RequestSender
 * @property {string} userId
 * @property {boolean} isGM - Foundry's `user.isGM` for that user
 */

/**
 * One side of a test or contest, as stored on the contest message (ADR-020). The checks only read
 * the key and the user; other fields are ignored.
 * @typedef {Object} RequestSide
 * @property {string} key - initiator or opposition; roller or setter
 * @property {string|null} userId - the side's user, or null for the GM's side
 */

/**
 * What the checks and the dispatcher read from a contest message. The handler builds it from
 * `message.system.toObject()`: `type` is `flow.type`, and `state` is `engineStateOf(flow)`.
 * @typedef {Object} ContestRecord
 * @property {string} type - "test" or "contest"
 * @property {number} revision
 * @property {RequestSide[]} sides
 * @property {ContestState|TestState} state
 */

/**
 * The poolRoll message an add-roll names with `payload.poolRollId`, as plain data from its source.
 * Its dice come from here, never from the request, so a sender can't send results of their own.
 * @typedef {Object} PoolRollRecord
 * @property {string|null} authorId - the message's author, or null when the author is gone
 * @property {import("./types.mjs").RolledDie[]} rolled
 * @property {import("./types.mjs").Resolution|null} resolution - null until the roll is confirmed
 * @property {string[]} [heldBy=[]] - the other contest messages, written by a GM, whose rolls name
 *   the card; one roll card answers one test or contest in M3 (ADR-020, Step 4.4 S3 proposal review)
 */

/**
 * A request as the sender's client sends it. The payload fields each action reads:
 * - "add-roll": `side` (optional; a test's roll is always the roller's), and either `poolRollId` (a
 *   confirmed roll card) or `total` with `effectSizes` (typed by hand, ADR-021);
 * - "give-in": `side` (optional);
 * - "decline": nothing; it is always the opposition's;
 * - "apply-heroic-steps": `effectId`;
 * - "choose-overflow": `effectId` (optional with one open overflow), `kind`, `dieId` (for a leftover);
 * - "use-against-loser": `effectIds`, the winner's effect dice used against the loser;
 * - "set-high-stakes": `highStakes`;
 * - "close": nothing.
 * Other payload fields are ignored.
 * @typedef {Object} ContestRequest
 * @property {string} action - one of REQUEST_ACTIONS for the message's flow type
 * @property {string} messageId - the contest message
 * @property {number} revision - the card's revision the sender saw (ADR-027)
 * @property {object} [payload]
 */

/**
 * Everything one request is checked against.
 * @typedef {Object} RequestInput
 * @property {RequestSender} sender
 * @property {ContestRequest} request
 * @property {ContestRecord|null} contest - null when no contest message has the request's id
 * @property {PoolRollRecord|null} [poolRoll=null] - for an add-roll with `poolRollId`; null when not
 *   found
 */

/**
 * What an accepted request writes, in the shape of systemChangesAfter(system, state, extras).
 * @typedef {Object} RequestWrite
 * @property {ContestState|TestState} state - the engine state after the action. The engine copies
 *   only what it changes, so this may share nested objects with the record's state, such as the
 *   rolls the action didn't touch, and for the pick against the loser it is the record's state
 *   itself; the handler must treat it as read-only and not mutate it
 * @property {{rollUserId?: string, usedAgainstLoser?: string[]}} extras - `rollUserId` (the sender)
 *   for an added roll, `usedAgainstLoser` (a new list) for the pick, nothing otherwise
 */

/**
 * The actions a request may carry, for each flow type (ADR-027). The engine has no giving in or
 * declining for a test, and a test has no loser to use effect dice against, so those three actions
 * are the contest's only.
 */
export const REQUEST_ACTIONS = Object.freeze({
  test: Object.freeze(["add-roll", "apply-heroic-steps", "choose-overflow", "set-high-stakes", "close"]),
  contest: Object.freeze([
    "add-roll", "give-in", "decline", "apply-heroic-steps", "choose-overflow", "use-against-loser", "set-high-stakes",
    "close"
  ])
});

/** Actions only a GM may take (ADR-022, ADR-027). */
const GM_ONLY_ACTIONS = Object.freeze(["set-high-stakes", "close"]);

/** Actions that belong to the winner's side, or to a test's roller (ADR-027). */
const WINNER_ACTIONS = Object.freeze(["apply-heroic-steps", "choose-overflow", "use-against-loser"]);

/**
 * The side that declines: only the opposition can (rules 2 and 14; Handbook p. 18, p. 19; giveIn in
 * contest.mjs).
 */
const DECLINING_SIDE = CONTEST_SIDES[1];

/** A test's rolling side, whose user makes the test's end choices (ADR-027, Step 4.4 proposal review). */
const ROLLER = TEST_SIDES[0];

/** The engine functions for each flow type. */
const FLOW_FUNCTIONS = Object.freeze({
  test: Object.freeze({
    addRoll: addTestRoll, autoSteps: autoApplyTestHeroicSteps, heroicSteps: applyTestHeroicSteps,
    chooseOverflow: chooseTestOverflow, setHighStakes: setTestHighStakes, close: closeTest
  }),
  contest: Object.freeze({
    addRoll: addContestRoll, autoSteps: autoApplyContestHeroicSteps, heroicSteps: applyContestHeroicSteps,
    chooseOverflow: chooseContestOverflow, setHighStakes: setContestHighStakes, close: closeContest
  })
});

/**
 * @param {unknown} value
 * @returns {boolean} whether value is a plain object, not an array, class instance or null
 */
function isPlainObject(value) {
  if ( (value === null) || (typeof value !== "object") ) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype) || (proto === null);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return (typeof value === "string") && (value.length > 0);
}

/**
 * @param {RequestSender} sender
 * @returns {boolean} the sender is a GM; anything but `isGM === true` counts as a player
 */
function isGM(sender) {
  return sender?.isGM === true;
}

/**
 * @param {RequestSender} sender
 * @param {RequestSide} side
 * @returns {boolean} the sender is the side's user; the GM's side (userId null) has no user
 */
function isUserOf(sender, side) {
  return isNonEmptyString(side.userId) && (side.userId === sender?.userId);
}

/**
 * @param {string} type - a flow type
 * @returns {readonly string[]} the actions it has; none for a type this module doesn't know
 */
function actionsFor(type) {
  if ( type === "test" ) return REQUEST_ACTIONS.test;
  if ( type === "contest" ) return REQUEST_ACTIONS.contest;
  return [];
}

/**
 * @param {ContestRecord} contest
 * @returns {ContestRoll[]} the rolls in the record's state; a test has none or one
 */
function rollsOf(contest) {
  if ( contest.type === "contest" ) return contest.state.rolls;
  return contest.state.roll ? [contest.state.roll] : [];
}

/**
 * Whether a request is malformed. MALFORMED_REQUEST covers only what the dispatcher needs to route
 * the request and call the engine safely: a plain object with an action and a message id that are
 * non-empty strings, a revision that is a whole number of 0 or more, and a payload that is absent or
 * a plain object; for an add-roll, exactly one of `poolRollId` (a non-empty string, with no
 * `effectSizes`) and `total`; for the pick against the loser, `effectIds` as a list. Every value the
 * engine checks keeps the engine's code, so the codes mean the same whoever calls the engine: a
 * total (INVALID_TOTAL), typed effect dice (INVALID_DIE_SIZE), an effect id (EFFECT_DIE_NOT_FOUND),
 * an overflow option (INVALID_OVERFLOW_CHOICE), the high-stakes value (INVALID_HIGH_STAKES); a side
 * key is checked with the sender (INVALID_SIDE, NOT_YOUR_SIDE). An unknown action's payload isn't
 * checked, so the request reaches UNSUPPORTED_ACTION.
 * @param {unknown} request
 * @returns {boolean}
 */
function requestMalformed(request) {
  if ( !isPlainObject(request) ) return true;
  const { action, messageId, revision, payload } = request;
  if ( !isNonEmptyString(action) || !isNonEmptyString(messageId) ) return true;
  if ( !Number.isInteger(revision) || (revision < 0) ) return true;
  if ( (payload !== undefined) && !isPlainObject(payload) ) return true;
  const fields = payload ?? {};
  if ( action === "add-roll" ) {
    const fromCard = fields.poolRollId !== undefined;
    if ( fromCard === (fields.total !== undefined) ) return true;
    return fromCard && (!isNonEmptyString(fields.poolRollId) || (fields.effectSizes !== undefined));
  }
  if ( action === "use-against-loser" ) return !Array.isArray(fields.effectIds);
  return false;
}

/**
 * The side a sender acts for when the request names it, or when the action fixes it: a GM may act
 * for any side, a player only for a side whose user they are (ADR-027).
 * @param {RequestSender} sender
 * @param {ContestRecord} contest
 * @param {unknown} key - a side key
 * @returns {EngineResult<string>} the side key; INVALID_SIDE for a key that isn't one of the
 *   record's sides, whoever names it; NOT_YOUR_SIDE for a side a player isn't the user of (the GM's
 *   side included)
 */
function namedSide(sender, contest, key) {
  const side = contest.sides.find(s => s.key === key);
  if ( !side ) return fail("INVALID_SIDE");
  if ( !(isGM(sender) || isUserOf(sender, side)) ) return fail("NOT_YOUR_SIDE");
  return ok(side.key);
}

/**
 * The side a sender acts for when adding a roll to a contest or giving in. The side is never taken
 * on trust (ADR-027): one named in the request is checked as namedSide does; otherwise it is the
 * sender's own side, the one whose user they are, which for a GM includes the GM's side (userId
 * null). A sender with no such side, or several, must name one: a player on no side is refused with
 * NOT_YOUR_SIDE, and a player on both sides, a GM with several such sides, or a GM with none (who
 * may act for any) with SIDE_REQUIRED.
 * @param {RequestSender} sender
 * @param {ContestRecord} contest
 * @param {unknown} requested - `payload.side`; undefined or null to take the sender's own side
 * @returns {EngineResult<string>} the side key; INVALID_SIDE, NOT_YOUR_SIDE or SIDE_REQUIRED
 */
function senderSide(sender, contest, requested) {
  if ( requested != null ) return namedSide(sender, contest, requested);
  const own = contest.sides.filter(side => isUserOf(sender, side) || (isGM(sender) && (side.userId === null)));
  if ( own.length === 1 ) return ok(own[0].key);
  return fail((own.length === 0) && !isGM(sender) ? "NOT_YOUR_SIDE" : "SIDE_REQUIRED");
}

/**
 * The sender check for one action (ADR-027): high stakes and closing are the GM's (ADR-022);
 * declining is the opposition's; heroic steps, the overflow choice and the pick against the loser
 * belong to the winner's side, or a test's roller; a test's roll is always the roller's, so a named
 * side other than the roller is refused with INVALID_SIDE; adding a roll to a contest and giving in
 * are for the sender's side (senderSide). While a contest has no winner, the user of either side
 * and a GM go on to the engine, which refuses the winner's choices with its own code
 * (CONTEST_NOT_RESOLVED); a user on no side is refused here.
 * @param {RequestSender} sender
 * @param {ContestRecord} contest
 * @param {string} action - one of the flow type's actions
 * @param {object} payload
 * @returns {EngineResult<string|null>} the side the action is taken for, or null for the GM's
 *   actions and for a winner's choice while the contest has no winner; refuses with GM_ONLY,
 *   INVALID_SIDE, NOT_YOUR_SIDE or SIDE_REQUIRED
 */
function sideForAction(sender, contest, action, payload) {
  if ( GM_ONLY_ACTIONS.includes(action) ) return isGM(sender) ? ok(null) : fail("GM_ONLY");
  if ( action === "decline" ) return namedSide(sender, contest, DECLINING_SIDE);
  if ( WINNER_ACTIONS.includes(action) ) {
    const winner = contest.type === "test" ? ROLLER : contest.state.winner;
    if ( winner != null ) return namedSide(sender, contest, winner);
    const onASide = contest.sides.some(side => isUserOf(sender, side));
    return isGM(sender) || onASide ? ok(null) : fail("NOT_YOUR_SIDE");
  }
  if ( (action === "add-roll") && (contest.type === "test") ) {
    if ( (payload.side != null) && (payload.side !== ROLLER) ) return fail("INVALID_SIDE");
    return namedSide(sender, contest, ROLLER);
  }
  return senderSide(sender, contest, payload.side);
}

/**
 * @param {ContestRequest} request
 * @param {object} payload
 * @returns {boolean} the request adds a roll from a roll card
 */
function fromRollCard(request, payload) {
  return (request.action === "add-roll") && (payload.poolRollId !== undefined);
}

/**
 * Whether a roll card isn't the sender's to send: a poolRoll message belongs to its author and the
 * GM (ADR-013), so a player may send only a card they wrote, and a GM any card.
 * @param {RequestSender} sender
 * @param {PoolRollRecord} poolRoll
 * @returns {boolean}
 */
function notSendersRoll(sender, poolRoll) {
  return !isGM(sender) && !(isNonEmptyString(poolRoll.authorId) && (poolRoll.authorId === sender.userId));
}

/**
 * The action's own checks, after the revision and before the engine: a closed test or contest
 * refuses every action (ADR-027); a decline is refused once the opposition has rolled, since it can
 * then only give in (rules 14 and 16, Handbook p. 19; giveIn records a decline only before the
 * opposition's first roll); and a roll card must be confirmed, not be part of this test or contest
 * already (one card is one roll), and not be held by another one. The last is an M3 limit, not a
 * rule: with area attacks and area effects every target rolls against the attacker's one total
 * (Handbook p. 191, an SFX), to revisit with SFX (ADR-020, Step 4.4 S3 proposal review).
 * @param {ContestRecord} contest
 * @param {ContestRequest} request
 * @param {object} payload
 * @param {PoolRollRecord|null} poolRoll - found, for a roll card (checked before the revision)
 * @returns {string|null} checked in this order: CONTEST_CLOSED, DECLINE_AFTER_ROLL,
 *   POOL_ROLL_NOT_CONFIRMED, ROLL_ALREADY_ADDED, ROLL_IN_OTHER_CONTEST
 */
function actionProblem(contest, request, payload, poolRoll) {
  if ( contest.state.closed ) return "CONTEST_CLOSED";
  if ( (request.action === "decline") && (contest.state.hasRolled?.[DECLINING_SIDE] === true) ) {
    return "DECLINE_AFTER_ROLL";
  }
  if ( !fromRollCard(request, payload) ) return null;
  if ( poolRoll.resolution == null ) return "POOL_ROLL_NOT_CONFIRMED";
  if ( rollsOf(contest).some(roll => roll.messageRef === payload.poolRollId) ) return "ROLL_ALREADY_ADDED";
  if ( Array.isArray(poolRoll.heldBy) && (poolRoll.heldBy.length > 0) ) return "ROLL_IN_OTHER_CONTEST";
  return null;
}

/**
 * Checks a test or contest request up to the engine (ADR-027, Step 4.4 proposal review): its shape,
 * the message and the action, the sender, the revision, and the action's own checks, in that
 * order, stopping at the first that fails (see the module's description for the full list).
 * dispatchContestRequest runs these checks first; a client may also run them before sending.
 * @param {RequestInput} input
 * @returns {EngineResult<{side: string|null}>} the side the action is taken for (null for high
 *   stakes and closing, and for a winner's choice while a contest has no winner); refuses, checked
 *   in this order: MALFORMED_REQUEST, CONTEST_NOT_FOUND, UNSUPPORTED_ACTION, POOL_ROLL_NOT_FOUND,
 *   GM_ONLY or INVALID_SIDE, NOT_YOUR_SIDE, SIDE_REQUIRED, NOT_YOUR_ROLL, STALE_REVISION,
 *   CONTEST_CLOSED, DECLINE_AFTER_ROLL, POOL_ROLL_NOT_CONFIRMED, ROLL_ALREADY_ADDED, ROLL_IN_OTHER_CONTEST
 */
export function checkContestRequest({ sender, request, contest, poolRoll = null } = {}) {
  if ( requestMalformed(request) ) return fail("MALFORMED_REQUEST");
  if ( contest == null ) return fail("CONTEST_NOT_FOUND");
  if ( !actionsFor(contest.type).includes(request.action) ) return fail("UNSUPPORTED_ACTION");
  const payload = request.payload ?? {};
  const fromCard = fromRollCard(request, payload);
  if ( fromCard && (poolRoll == null) ) return fail("POOL_ROLL_NOT_FOUND");
  const side = sideForAction(sender, contest, request.action, payload);
  if ( !side.ok ) return side;
  if ( fromCard && notSendersRoll(sender, poolRoll) ) return fail("NOT_YOUR_ROLL");
  if ( request.revision !== contest.revision ) return fail("STALE_REVISION");
  const problem = actionProblem(contest, request, payload, poolRoll);
  if ( problem ) return fail(problem);
  return ok({ side: side.value });
}

/**
 * @param {EngineResult<ContestState|TestState>} result - an engine function's result
 * @param {RequestWrite["extras"]} [extras]
 * @returns {EngineResult<RequestWrite>}
 */
function written(result, extras = {}) {
  return result.ok ? ok({ state: result.value, extras }) : result;
}

/**
 * Adds a roll for `side`, built only through contestRollFromResolution (a roll card) or
 * contestRollFromTotal (a typed total), and applies the automatic heroic steps in the same write
 * (ADR-028, Step 4.4 S0 API review). The roll has to be built before it can be added, so the
 * builder's codes come before every code of the add function, CONTEST_RESOLVED included: a typed d7
 * on a decided contest gives INVALID_DIE_SIZE, and a card answered on its own card given to a test
 * that has its roll gives CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE.
 * @param {ContestRecord} contest
 * @param {string} side
 * @param {object} payload
 * @param {PoolRollRecord|null} poolRoll - checked by actionProblem when the payload names a card
 * @param {RequestSender} sender
 * @returns {EngineResult<RequestWrite>} refuses with the builder's codes, then the add function's
 */
function addRoll(contest, side, payload, poolRoll, sender) {
  const flow = FLOW_FUNCTIONS[contest.type];
  const built = payload.poolRollId === undefined
    ? contestRollFromTotal(side, payload.total, payload.effectSizes)
    : contestRollFromResolution(side, poolRoll.rolled, poolRoll.resolution, payload.poolRollId);
  if ( !built.ok ) return built;
  const added = flow.addRoll(contest.state, built.value);
  if ( !added.ok ) return added;
  return written(flow.autoSteps(added.value), { rollUserId: sender.userId });
}

/**
 * Records the winner's pick of effect dice used against the loser (ADR-020 block). The engine state
 * doesn't change; the pick is checked by contestConsequence, which takes it as its input, so it
 * waits for the heroic steps and the overflow choice and must name distinct effect dice of the
 * winner's last roll. It may be made again until the contest is closed.
 * @param {ContestState} state
 * @param {unknown[]} effectIds - a list, checked by requestMalformed
 * @returns {EngineResult<RequestWrite>} refuses as contestConsequence: CONTEST_NOT_RESOLVED,
 *   HEROIC_PENDING, OVERFLOW_PENDING, DUPLICATE_EFFECT_DIE, EFFECT_DIE_NOT_FOUND, INVALID_DIE_SIZE
 */
function useAgainstLoser(state, effectIds) {
  const checked = contestConsequence(state, { usedAgainstLoser: effectIds });
  if ( !checked.ok ) return checked;
  return ok({ state, extras: { usedAgainstLoser: [...effectIds] } });
}

/**
 * Applies one test or contest request (ADR-027): runs checkContestRequest, then the engine function
 * for the action, and returns what the handler writes through systemChangesAfter(system, state,
 * extras). It decides nothing the engine doesn't: a roll is built only through
 * contestRollFromResolution or contestRollFromTotal and followed by the automatic heroic steps in
 * the same write; giving in and declining go through giveIn (declining for the opposition, before
 * its first roll, so the engine records a decline); the heroic steps, the overflow
 * choice, high stakes and closing go through the flow type's own functions; the pick against the
 * loser through contestConsequence. A refusal writes nothing.
 * @param {RequestInput} input
 * @returns {EngineResult<RequestWrite>} refuses with checkContestRequest's codes, then the engine's
 *   in the engine's order: for a roll card the builder's CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE, for a
 *   typed total its INVALID_DIE_SIZE, then those of addContestRoll or addTestRoll (the builder's
 *   come first, before the add function's CONTEST_RESOLVED, because the roll is built before it is
 *   added); giveIn's;
 *   applyContestHeroicSteps' or applyTestHeroicSteps'; chooseContestOverflow's or
 *   chooseTestOverflow's; setContestHighStakes' or setTestHighStakes'; closeContest's or closeTest's;
 *   and for the pick, contestConsequence's
 */
export function dispatchContestRequest(input = {}) {
  const checked = checkContestRequest(input);
  if ( !checked.ok ) return checked;
  const { sender, request, contest, poolRoll = null } = input;
  const payload = request.payload ?? {};
  const side = checked.value.side;
  const flow = FLOW_FUNCTIONS[contest.type];
  const state = contest.state;

  switch ( request.action ) {
    case "add-roll": return addRoll(contest, side, payload, poolRoll, sender);
    case "give-in":
    case "decline": return written(giveIn(state, side));
    case "apply-heroic-steps": return written(flow.heroicSteps(state, payload.effectId));
    case "choose-overflow":
      return written(flow.chooseOverflow(state, { effectId: payload.effectId, kind: payload.kind, dieId: payload.dieId }));
    case "use-against-loser": return useAgainstLoser(state, payload.effectIds);
    case "set-high-stakes": return written(flow.setHighStakes(state, payload.highStakes));
    case "close": return written(flow.close(state));
    default: return fail("UNSUPPORTED_ACTION");
  }
}

/**
 * @param {unknown} side
 * @returns {boolean} whether a side to start with has a non-empty string key and a user that is a
 *   non-empty string or null
 */
function startSideWellFormed(side) {
  return isPlainObject(side) && isNonEmptyString(side.key) && ((side.userId === null) || isNonEmptyString(side.userId));
}

/**
 * Checks who may start a test or contest with which sides (ADR-027, Step 4.4 proposal review): a GM
 * may start any; a player only one started for their own side, read strictly as the side that
 * starts it: the initiator's user for a contest (rule 14, Handbook p. 19), the roller's user for a
 * test. A player starts with high stakes off, since high stakes is the GM's flag (ADR-022). The
 * sides must be exactly the flow type's sides (CONTEST_SIDES or TEST_SIDES), as the contest
 * message's model requires in M3. Only the type, the sides and high stakes are checked here; the
 * rest of a start (the difficulty and its card, the level, the actors) is dispatchStartRequest's,
 * which runs these checks first (Step 4.4 S3).
 * @param {{sender: RequestSender, request: {type: string, sides: RequestSide[], highStakes?: boolean}}} input
 * @returns {EngineResult<null>} null when the start may go ahead; refuses, checked in this order:
 *   MALFORMED_REQUEST (not a plain object, a type that isn't a string, sides that aren't a list of
 *   sides with a key and a user or null), UNSUPPORTED_ACTION (a type that isn't test or contest),
 *   GM_ONLY (a player with high stakes anything but off or left out), NOT_YOUR_SIDE (a player who
 *   isn't the user of the initiator or roller side), INVALID_SIDE (not exactly the type's sides),
 *   INVALID_HIGH_STAKES (a GM's value that isn't true or false)
 */
export function checkStartRequest({ sender, request } = {}) {
  if ( !isPlainObject(request) ) return fail("MALFORMED_REQUEST");
  const { type, sides, highStakes } = request;
  if ( (typeof type !== "string") || !Array.isArray(sides) || ![...sides].every(startSideWellFormed) ) {
    return fail("MALFORMED_REQUEST");
  }
  const expected = type === "test" ? TEST_SIDES : (type === "contest" ? CONTEST_SIDES : null);
  if ( !expected ) return fail("UNSUPPORTED_ACTION");
  if ( !isGM(sender) && (highStakes !== undefined) && (highStakes !== false) ) return fail("GM_ONLY");
  const starting = sides.find(side => side.key === expected[0]); // the initiator or the roller, listed first
  if ( !isGM(sender) && !(starting && isUserOf(sender, starting)) ) return fail("NOT_YOUR_SIDE");
  const keys = sides.map(side => side.key);
  if ( (keys.length !== expected.length) || !expected.every(key => keys.includes(key)) ) return fail("INVALID_SIDE");
  if ( (highStakes !== undefined) && (typeof highStakes !== "boolean") ) return fail("INVALID_HIGH_STAKES");
  return ok(null);
}

/**
 * One side of a start request: a RequestSide plus the side's actor and the name the card shows.
 * @typedef {Object} StartSide
 * @property {string} key - initiator or opposition; roller or setter
 * @property {string|null} userId - the side's user, or null for the GM's side
 * @property {string|null} actorUuid - the side's actor, or null
 * @property {string} label - the name the card shows for the side; may be empty
 */

/**
 * A request to start a test or contest (ADR-027, Step 4.4 S3 proposal review). A test has exactly
 * one of `difficulty` (typed by hand) and `difficultyMessageId` (a roll card), and a level only with
 * a card; a contest has none of the three.
 * @typedef {Object} StartRequest
 * @property {"start"} action
 * @property {string} type - "test" or "contest"
 * @property {StartSide[]} sides
 * @property {boolean} [highStakes] - the GM's flag (ADR-022)
 * @property {unknown} [difficulty] - a test's typed difficulty, checked by createTest
 * @property {string} [difficultyMessageId] - the poolRoll message that sets a test's difficulty
 * @property {string|null} [difficultyLevel] - with a card only: the level the card shows, or null
 */

/**
 * What the handler knows about one actor a start request names. The handler reads the actor
 * itself; the request never says whether the sender owns it.
 * @typedef {Object} StartActor
 * @property {boolean} ownedBySender - the sender has OWNER permission on the actor; only true counts
 */

/**
 * Everything one start request is checked against.
 * @typedef {Object} StartInput
 * @property {RequestSender} sender
 * @property {StartRequest} request
 * @property {PoolRollRecord|null} [difficultyCard=null] - the roll card `difficultyMessageId` names,
 *   or null when it wasn't found or the request names none
 * @property {Object<string, StartActor>} [actors={}] - keyed by actor UUID, for each actor the
 *   request names that exists; a UUID missing here means the actor wasn't found
 */

/**
 * What an accepted start hands to initialSystem (module/data/chat/contest-mapping.mjs): the
 * engine's starting state, the sides, and the sender as the starter; for a test also its
 * model-only fields. A contest's value has no test-only fields at all, since initialSystem refuses
 * them for a contest.
 * @typedef {Object} StartWrite
 * @property {string} type
 * @property {ContestState|TestState} state - from createContest or createTest
 * @property {string} startedBy - the sender's userId
 * @property {StartSide[]} sides - new objects with exactly the StartSide fields
 * @property {import("./types.mjs").DifficultyLevel|null} [difficultyLevel] - test only
 * @property {string|null} [difficultyMessageRef] - test only: the card's message id, or null
 * @property {import("./types.mjs").ContestEffect[]} [oppositionEffects] - test only: the card's
 *   effect dice as they stand at the start, or empty
 * @property {boolean|null} [oppositionTakeOut] - test only: whether the card's overflow choice was
 *   the take-out; null for a typed difficulty
 */

/** A test's difficulty fields in a start request; a contest has none of them. */
const DIFFICULTY_FIELDS = Object.freeze(["difficulty", "difficultyMessageId", "difficultyLevel"]);

/**
 * @param {unknown} side
 * @returns {boolean} whether a side to start with is well formed (startSideWellFormed) and has an
 *   actor that is a non-empty string or null and a label that is a string
 */
function startSideComplete(side) {
  return startSideWellFormed(side) && ((side.actorUuid === null) || isNonEmptyString(side.actorUuid))
    && (typeof side.label === "string");
}

/**
 * Whether a start request is malformed: not a plain object, an action other than "start", sides
 * that aren't a list of complete sides, or difficulty fields that don't fit the type. A test has
 * exactly one of `difficulty` and `difficultyMessageId` (a non-empty string), and a level only with
 * a card; a contest has none of the three. The fields are checked against the type only when it is
 * test or contest, so an unknown type reaches checkStartRequest's UNSUPPORTED_ACTION. The type itself
 * and the values the engine checks (the typed difficulty, the level, high stakes) keep their own codes.
 * @param {unknown} request
 * @returns {boolean}
 */
function startMalformed(request) {
  if ( !isPlainObject(request) || (request.action !== "start") ) return true;
  if ( !Array.isArray(request.sides) || ![...request.sides].every(startSideComplete) ) return true;
  if ( request.type === "contest" ) return DIFFICULTY_FIELDS.some(field => request[field] !== undefined);
  if ( request.type !== "test" ) return false;
  const fromCard = request.difficultyMessageId !== undefined;
  if ( fromCard === (request.difficulty !== undefined) ) return true;
  return fromCard ? !isNonEmptyString(request.difficultyMessageId) : (request.difficultyLevel != null);
}

/**
 * The difficulty card's problem for a test started from a card: it must have been found, be
 * confirmed, and have no overflow choice open, since storing such a die as a d12 would drop the
 * second-effect-die option (Handbook p. 21; ADR-021, Step 4.4 S3 proposal review).
 * @param {StartRequest} request - well formed
 * @param {PoolRollRecord|null} difficultyCard
 * @returns {string|null} POOL_ROLL_NOT_FOUND, POOL_ROLL_NOT_CONFIRMED or OVERFLOW_PENDING; null for a
 *   card that may set the difficulty, and for a start without a card
 */
function difficultyCardProblem(request, difficultyCard) {
  if ( (request.type !== "test") || (request.difficultyMessageId === undefined) ) return null;
  if ( difficultyCard == null ) return "POOL_ROLL_NOT_FOUND";
  if ( difficultyCard.resolution == null ) return "POOL_ROLL_NOT_CONFIRMED";
  if ( difficultyCard.resolution.overflow ) return OVERFLOW_PENDING;
  return null;
}

/**
 * The actors' problem for a start (ADR-027, Step 4.4 S3 proposal review): every actor a side names
 * must have been found, and a player may name for their own starting side, the initiator or the
 * roller, only an actor they own (Foundry's OWNER permission, so shared actors work). A GM may name
 * any actor. The map is read through its own properties only, so a UUID such as "toString" isn't
 * found.
 * @param {RequestSender} sender
 * @param {StartRequest} request - accepted by checkStartRequest
 * @param {Object<string, StartActor>} actors
 * @returns {string|null} ACTOR_NOT_FOUND for any side first, then NOT_YOUR_ACTOR; null when the
 *   actors may be used
 */
function startActorProblem(sender, request, actors) {
  const known = isPlainObject(actors) ? actors : {};
  const found = uuid => Object.hasOwn(known, uuid) && isPlainObject(known[uuid]);
  if ( request.sides.some(side => (side.actorUuid !== null) && !found(side.actorUuid)) ) return "ACTOR_NOT_FOUND";
  if ( isGM(sender) ) return null;
  const startingKey = (request.type === "test" ? TEST_SIDES : CONTEST_SIDES)[0];
  const starting = request.sides.find(side => side.key === startingKey);
  if ( starting.actorUuid === null ) return null;
  return known[starting.actorUuid].ownedBySender === true ? null : "NOT_YOUR_ACTOR";
}

/**
 * Checks and applies a request to start a test or contest on the GM's client (ADR-027, Step 4.4 S3
 * proposal review). It runs checkStartRequest, then the rest of a start: the difficulty card, the
 * level and the actors. A test from a roll card takes its difficulty and opposition effect dice
 * from the stored card, never from the request (ADR-021, Step 4.4 S3 proposal review): the
 * difficulty is the card's total (a botch gives 0, rule 9), `difficultyMessageRef` is the card's
 * id, `oppositionEffects` are its effect dice as they stand, `oppositionTakeOut` is whether its
 * overflow choice was the take-out, and the level is the one the request sends, or null. A typed
 * difficulty has no level, no card reference, no opposition effect dice and an unknown take-out.
 * A player may name, for their own starting side, only an actor they own; a GM may name any actor.
 * @param {StartInput} input
 * @returns {EngineResult<StartWrite>} refuses, checked in this order: MALFORMED_REQUEST (the whole
 *   shape; the difficulty fields are checked against the type only when it is test or contest),
 *   checkStartRequest's codes in its order, POOL_ROLL_NOT_FOUND, POOL_ROLL_NOT_CONFIRMED,
 *   OVERFLOW_PENDING (the card's overflow choice is still open), UNKNOWN_DIFFICULTY_LEVEL,
 *   ACTOR_NOT_FOUND, NOT_YOUR_ACTOR, then createTest's INVALID_TOTAL for a typed difficulty
 */
export function dispatchStartRequest({ sender, request, difficultyCard = null, actors = {} } = {}) {
  if ( startMalformed(request) ) return fail("MALFORMED_REQUEST");
  const checked = checkStartRequest({ sender, request });
  if ( !checked.ok ) return checked;
  const cardProblem = difficultyCardProblem(request, difficultyCard);
  if ( cardProblem ) return fail(cardProblem);
  const level = request.difficultyLevel ?? null;
  if ( (level !== null) && !DIFFICULTY_LEVELS.includes(level) ) return fail("UNKNOWN_DIFFICULTY_LEVEL");
  const actorProblem = startActorProblem(sender, request, actors);
  if ( actorProblem ) return fail(actorProblem);

  const { type, highStakes } = request;
  const sides = request.sides.map(({ key, userId, actorUuid, label }) => ({ key, userId, actorUuid, label }));
  const started = { type, startedBy: sender.userId, sides };
  if ( type === "contest" ) return ok({ ...started, state: createContest({ highStakes }).value });

  if ( request.difficultyMessageId === undefined ) {
    const state = createTest({ difficulty: request.difficulty, highStakes });
    if ( !state.ok ) return state;
    return ok({
      ...started, state: state.value, difficultyLevel: null, difficultyMessageRef: null, oppositionEffects: [],
      oppositionTakeOut: null
    });
  }
  const resolution = difficultyCard.resolution;
  const state = createTest({ difficulty: resolution.total, highStakes });
  if ( !state.ok ) return state;
  return ok({
    ...started, state: state.value, difficultyLevel: level, difficultyMessageRef: request.difficultyMessageId,
    oppositionEffects: resolution.effectDice.map(({ id, size }) => ({ id, size })),
    oppositionTakeOut: resolution.takeOut === true
  });
}

/**
 * The roll a test or contest waits for, for the card's button and the pool builder's target: a test
 * without its roll waits for the roller against its difficulty; an open contest for the side whose
 * turn it is, against the standing total (null before the initiator's first roll). `rollIndex` is
 * the number of rolls the record holds, the value a roll card's flag carries for this turn.
 * @param {ContestRecord|null} contest
 * @returns {{side: string, toBeat: number|null, rollIndex: number}|null} null for a closed or
 *   decided test or contest, a missing record, or a type this module doesn't know
 */
export function expectedRoll(contest) {
  const state = contest?.state;
  if ( (state == null) || state.closed ) return null;
  if ( contest.type === "test" ) {
    return state.roll == null ? { side: ROLLER, toBeat: state.difficulty, rollIndex: 0 } : null;
  }
  if ( contest.type === "contest" ) {
    return state.status === "open" ? { side: state.turn, toBeat: state.difficulty, rollIndex: state.rolls.length } : null;
  }
  return null;
}

/**
 * Whether a sender may act for a side, as the request checks decide it (ADR-027): a GM for any of
 * the record's sides, a player only for a side whose user they are. The card shows a button only
 * where the relay would accept the action.
 * @param {RequestSender} sender
 * @param {ContestRecord|null} contest
 * @param {string} sideKey
 * @returns {boolean} false for a key that isn't one of the record's sides, and for a missing record
 */
export function mayActFor(sender, contest, sideKey) {
  if ( !Array.isArray(contest?.sides) ) return false;
  return namedSide(sender, contest, sideKey).ok;
}

/**
 * What a poolRoll card flagged for a test or contest offers (ADR-020, Step 4.4 S3 proposal review).
 * The caller passes the contest message the flag names, and only one a GM wrote.
 * - "sent": one of the record's rolls names the card, whatever the flag says;
 * - "held": the record is open, and the flag's side and rollIndex are those of expectedRoll;
 * - "free": anything else, a missing record or flag included.
 * @param {ContestRecord|null} contest
 * @param {string} poolRollId - the card's message id
 * @param {{messageId: string, side: string, rollIndex: number}|null} flag - the card's
 *   `flags["cortex-prime"].contest`
 * @returns {"sent"|"held"|"free"}
 */
export function rollCardHold(contest, poolRollId, flag) {
  if ( contest?.state == null ) return "free";
  if ( isNonEmptyString(poolRollId) && rollsOf(contest).some(roll => roll.messageRef === poolRollId) ) return "sent";
  const expected = expectedRoll(contest);
  if ( !expected || !isPlainObject(flag) ) return "free";
  return (flag.side === expected.side) && (flag.rollIndex === expected.rollIndex) ? "held" : "free";
}

/**
 * What a test or contest card may offer a sender now (ADR-027, Step 4.4 S4a proposal review). Each
 * candidate action is run through dispatchContestRequest with the record's own revision, and only
 * an accepted one is offered, so the card never shows what the relay would refuse:
 * - `roll`: the roll the record waits for (expectedRoll), when the sender may act for that side; a
 *   typed total is offered with it;
 * - `giveIn`: the side the sender may give in for, with the action to send: "decline" while the
 *   opposition hasn't rolled (the engine records a decline then, TC-E02), "give-in" afterwards. The
 *   opposition may decline before the initiator's first roll too (TC-18b). At most one of the two
 *   is ever accepted. A test has none, and neither has the initiator before the first roll;
 * - `highStakes` and `close`: whether the sender may change the flag and close the card (the GM's,
 *   until the card is closed; ADR-022).
 * @param {RequestSender} sender
 * @param {ContestRecord|null} contest
 * @returns {{roll: {side: string, toBeat: number|null, rollIndex: number}|null,
 *   giveIn: {side: string, action: "give-in"|"decline"}|null, highStakes: boolean, close: boolean}}
 *   new objects; nothing is offered for a missing record
 */
export function offeredActions(sender, contest) {
  const offered = { roll: null, giveIn: null, highStakes: false, close: false };
  if ( (contest?.state == null) || !Array.isArray(contest.sides) ) return offered;
  const accepted = (action, payload) => dispatchContestRequest({
    sender, contest, request: { action, messageId: "offered", revision: contest.revision, payload }
  }).ok;

  const expected = expectedRoll(contest);
  if ( expected && mayActFor(sender, contest, expected.side) ) offered.roll = expected;
  if ( contest.type === "contest" ) {
    if ( accepted("decline", {}) ) offered.giveIn = { side: DECLINING_SIDE, action: "decline" };
    else {
      const side = contest.sides.find(s => accepted("give-in", { side: s.key }));
      if ( side ) offered.giveIn = { side: side.key, action: "give-in" };
    }
  }
  offered.highStakes = accepted("set-high-stakes", { highStakes: !contest.state.highStakes });
  offered.close = accepted("close", {});
  return offered;
}
