/**
 * Contest actions go to the active GM as a Foundry user query (Decisions ADR-027, Step 4.4
 * proposal review; ADR-039). The sender asks; the GM's client checks the request with the pure
 * dispatcher in module/rules/contest-request.mjs, writes the contest message as its author, and
 * answers with an EngineResult. Starting a test or contest goes the same way, as the action
 * "start", which creates the message (Step 4.4 S3). Nothing here decides an outcome: it loads data,
 * calls the pure functions and writes what they return.
 * @module contest/relay
 */

import ContestData from "../data/chat/contest.mjs";
import { initialSystem, systemChangesAfter } from "../data/chat/contest-mapping.mjs";
import { CONTEST_SIDES, TEST_SIDES } from "../rules/contest.mjs";
import { dispatchContestRequest, dispatchStartRequest } from "../rules/contest-request.mjs";
import { contestRecordOf, poolRollRecordOf, sideActor, sideSpeaker } from "./records.mjs";

/** The query name, registered in `CONFIG.queries`. */
export const CONTEST_QUERY = "cortex-prime.contest";

/** How long a sender waits for the GM's answer, in milliseconds. */
const QUERY_TIMEOUT = 15000;

/** @returns {{ok: false, code: string}} */
function fail(code) {
  return { ok: false, code };
}

/** Registers the GM side's query handler; called from the `init` hook. */
export function registerContestQuery() {
  CONFIG.queries[CONTEST_QUERY] = handleContestQuery;
}

/**
 * Sends one contest action to the active GM and returns the answer (ADR-027). Refuses before
 * sending: GM_REQUIRED without an active GM, QUERY_NOT_PERMITTED without the core "query users"
 * permission (client/documents/user.mjs `query`). The active GM's own actions skip the query and
 * call the handler directly, as DialogV2.query does for the current user. A query that throws
 * (the GM disconnected, the timeout ran out) is REQUEST_FAILED, with the error in the console.
 * @param {import("../rules/contest-request.mjs").ContestRequest} request
 * @returns {Promise<{ok: boolean, code?: string, value?: object}>}
 */
export async function sendContestRequest(request) {
  const gm = game.users.activeGM;
  if ( !gm ) return fail("GM_REQUIRED");
  if ( gm.isSelf ) return handleContestQuery(request, { user: game.user });
  if ( !game.user.hasPermission("QUERY_USER") ) return fail("QUERY_NOT_PERMITTED");
  try {
    return await gm.query(CONTEST_QUERY, request, { timeout: QUERY_TIMEOUT });
  }
  catch( err ) {
    console.error(err);
    return fail("REQUEST_FAILED");
  }
}

/**
 * Shows a refused or failed contest action to the user who sent it, in their language
 * (CORTEX.Contest.Errors.<CODE>); a code without a string is shown as it is.
 * @param {{ok: boolean, code?: string}} result
 * @returns {boolean} whether the action went through
 */
export function notifyContestResult(result) {
  if ( result?.ok ) return true;
  const key = `CORTEX.Contest.Errors.${result?.code}`;
  ui.notifications.warn(game.i18n.has(key) ? game.i18n.localize(key) : String(result?.code));
  return false;
}

/** The tail of each message's queue: the GM handles requests for one message one at a time. */
const queues = new Map();

/**
 * The GM side's query handler (client/documents/collections/users.mjs `#handleUserQuery` passes
 * the query data and `{user}`, the querying user as the server reports it). Requests for one
 * message run one after another, so each sees the previous write; a refusal writes nothing.
 * It never throws: a failure becomes WRITE_FAILED or REQUEST_FAILED, with the error in the console.
 * @param {unknown} request - the query data
 * @param {{user: User}} context
 * @returns {Promise<{ok: boolean, code?: string, value?: object}>}
 */
export function handleContestQuery(request, { user }) {
  const key = (typeof request?.messageId === "string") ? request.messageId : "";
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(() => processRequest(request, user));
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if ( queues.get(key) === tail ) queues.delete(key); });
  return run.catch(err => {
    console.error(err);
    return fail("REQUEST_FAILED");
  });
}

/**
 * For each actor a start request's sides name that exists, whether the sender owns it (Foundry's
 * OWNER permission, so shared actors work; ADR-027, Step 4.4 S3 proposal review). An actor that
 * isn't found is left out, which the pure check reports as ACTOR_NOT_FOUND.
 * @param {unknown} sides - the request's sides, not yet checked
 * @param {User} user - the sender
 * @returns {Object<string, {ownedBySender: boolean}>}
 */
function startActors(sides, user) {
  const actors = {};
  for ( const side of Array.isArray(sides) ? sides : [] ) {
    const actor = sideActor(side);
    if ( actor ) actors[side.actorUuid] = { ownedBySender: actor.testUserPermission(user, "OWNER") };
  }
  return actors;
}

/**
 * Starts a test or contest on the GM's client (ADR-027, Step 4.4 S3 proposal review): checks the
 * request with dispatchStartRequest, builds the message data with initialSystem, checks it with
 * ContestData.checkCandidate, and creates the message as this GM, in the "public" mode, spoken by
 * the starting side's actor or by its label. A message that wasn't stored exactly as built is
 * deleted again.
 * @param {unknown} request
 * @param {User} user - the querying user
 * @returns {Promise<{ok: boolean, code?: string, value?: {messageId: string}}>}
 */
async function startContest(request, user) {
  const sender = { userId: user.id, isGM: user.isGM === true };
  const result = dispatchStartRequest({
    sender, request, difficultyCard: poolRollRecordOf(request?.difficultyMessageId), actors: startActors(request?.sides, user)
  });
  if ( !result.ok ) return result;

  const candidate = initialSystem(result.value);
  if ( !candidate.ok ) {
    console.error(`${CONTEST_QUERY} | mapping refused the start: ${candidate.code}`);
    return fail("WRITE_FAILED");
  }
  const problem = ContestData.checkCandidate(candidate.value);
  if ( problem ) {
    console.error(`${CONTEST_QUERY} | the start would not be stored as given: ${problem}`);
    return fail("WRITE_FAILED");
  }
  const startingKey = (result.value.type === "test" ? TEST_SIDES : CONTEST_SIDES)[0];
  const starting = result.value.sides.find(side => side.key === startingKey);
  const data = { type: "contest", system: candidate.value, speaker: sideSpeaker(starting) };
  ChatMessage.applyMode(data, "public");
  const message = await ChatMessage.implementation.create(data);
  if ( !message ) return fail("WRITE_FAILED");
  if ( !foundry.utils.equals(message.system.toObject(), candidate.value) ) {
    console.error(`${CONTEST_QUERY} | the start did not land as sent`);
    await message.delete();
    return fail("WRITE_FAILED");
  }
  return { ok: true, value: { messageId: message.id } };
}

/**
 * Checks, applies and writes one request on the active GM's client. A "start" has no message yet,
 * so it is routed before the message lookup.
 * @param {unknown} request
 * @param {User} user - the querying user
 * @returns {Promise<{ok: boolean, code?: string, value?: object}>}
 */
async function processRequest(request, user) {
  if ( game.users.activeGM !== game.user ) return fail("GM_REQUIRED");
  if ( request?.action === "start" ) return startContest(request, user);
  const message = (typeof request?.messageId === "string") ? game.messages.get(request.messageId) : undefined;
  const loaded = contestRecordOf(message);
  const sender = { userId: user.id, isGM: user.isGM === true };
  const poolRoll = poolRollRecordOf(request?.payload?.poolRollId, { exceptId: request?.messageId });
  const result = dispatchContestRequest({ sender, request, contest: loaded?.record ?? null, poolRoll });
  if ( !result.ok ) return result;

  const changes = systemChangesAfter(loaded.system, result.value.state, result.value.extras);
  if ( !changes.ok ) {
    console.error(`${CONTEST_QUERY} | mapping refused the write: ${changes.code}`);
    return fail("WRITE_FAILED");
  }
  const candidate = { ...loaded.system, ...changes.value };
  const problem = ContestData.checkCandidate(candidate);
  if ( problem ) {
    console.error(`${CONTEST_QUERY} | the write would not be stored as given: ${problem}`);
    return fail("WRITE_FAILED");
  }
  await message.update({ "system.revision": changes.value.revision, "system.flow": changes.value.flow });

  // Foundry keeps a list's old value without an error when one entry is invalid (ADR-020, S1
  // Quench finding), so the stored data is compared with what was meant.
  const stored = message.system.toObject();
  if ( (stored.revision !== changes.value.revision) || !foundry.utils.equals(stored.flow, changes.value.flow) ) {
    console.error(`${CONTEST_QUERY} | the write did not land as sent`);
    return fail("WRITE_FAILED");
  }
  return { ok: true, value: { revision: stored.revision } };
}
