/**
 * What the pure contest checks read from Foundry documents (module/rules/contest-request.mjs):
 * the record of a contest message, the record of a poolRoll card, and the speaker of a side. The
 * relay, the roll card, the contest card and the pool builder all read messages through here, so
 * each counts the same contest messages: only those a GM wrote (ADR-027, Step 4.4 proposal review).
 * @module contest/records
 */

import { engineStateOf } from "../data/chat/contest-mapping.mjs";

/**
 * The record of a contest message that the pure checks read (contest-request.mjs ContestRecord),
 * or null when the message isn't a contest message a GM wrote. Only the GM's client writes contest
 * messages, as a GM, so one a player wrote is ignored: its author could have changed it directly,
 * past every check.
 * @param {ChatMessage|undefined} message
 * @returns {{record: import("../rules/contest-request.mjs").ContestRecord, system: object}|null}
 */
export function contestRecordOf(message) {
  if ( message?.type !== "contest" ) return null;
  if ( message.author?.isGM !== true ) return null;
  const system = message.system.toObject();
  const state = engineStateOf(system.flow);
  if ( !state.ok ) return null;
  return {
    system,
    record: { type: system.flow.type, revision: system.revision, sides: system.sides, state: state.value }
  };
}

/**
 * @param {object} flow - a stored flow
 * @returns {object[]} its rolls; a test has none or one
 */
function storedRolls(flow) {
  if ( flow?.type === "contest" ) return flow.rolls ?? [];
  return flow?.roll ? [flow.roll] : [];
}

/**
 * The ids of the contest messages, written by a GM, whose rolls name a roll card.
 * @param {string} poolRollId
 * @param {string} [exceptId] - a contest message to leave out, the one a request is for
 * @returns {string[]}
 */
export function contestsHolding(poolRollId, exceptId) {
  return game.messages
    .filter(m => (m.type === "contest") && (m.id !== exceptId) && (m.author?.isGM === true)
      && storedRolls(m.system.flow).some(roll => roll.messageRef === poolRollId))
    .map(m => m.id);
}

/**
 * The record of a poolRoll card that the pure checks read (contest-request.mjs PoolRollRecord), or
 * null when the id names no poolRoll message. The dice always come from the stored card, never from
 * a request (ADR-027). `heldBy` lists the other GM-written contest messages whose rolls name it
 * (ADR-020, Step 4.4 S3 proposal review).
 * @param {unknown} id
 * @param {{exceptId?: string}} [options] - the contest message a request is for, left out of heldBy
 * @returns {import("../rules/contest-request.mjs").PoolRollRecord & {id: string}|null}
 */
export function poolRollRecordOf(id, { exceptId } = {}) {
  if ( typeof id !== "string" ) return null;
  const message = game.messages.get(id);
  if ( message?.type !== "poolRoll" ) return null;
  const system = message.system.toObject();
  return {
    id, authorId: message.author?.id ?? null, rolled: system.rolled, resolution: system.resolution,
    heldBy: contestsHolding(id, exceptId)
  };
}

/**
 * The actor a side names, or null when it names none or the actor can't be found.
 * @param {{actorUuid?: string|null}} side
 * @returns {Actor|null}
 */
export function sideActor(side) {
  if ( (typeof side?.actorUuid !== "string") || !side.actorUuid ) return null;
  try {
    const actor = fromUuidSync(side.actorUuid);
    return actor instanceof foundry.documents.Actor ? actor : null;
  }
  catch {
    return null;
  }
}

/**
 * The speaker for a side: its actor, through ChatMessage.getSpeaker, or else its label as the alias
 * with no actor or token, so the speaker isn't taken from whatever this client happens to control.
 * @param {{actorUuid?: string|null, label?: string}} side
 * @returns {{scene: string|null, actor: string|null, token: string|null, alias: string}}
 */
export function sideSpeaker(side) {
  const actor = sideActor(side);
  if ( actor ) return ChatMessage.getSpeaker({ actor });
  return { scene: null, actor: null, token: null, alias: side?.label ?? "" };
}
