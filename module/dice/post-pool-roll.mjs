/**
 * Posts a dice pool roll as a poolRoll chat message (Decisions ADR-009, ADR-010, ADR-013).
 * @module dice/post-pool-roll
 */

import { applyResults, suggestSelection } from "../rules/index.mjs";
import { rollPool } from "./roll-pool.mjs";

/**
 * Rolls a pool (or takes fixed results, dev/test only) and posts it as a poolRoll chat
 * message. The message starts unresolved, with the engine's suggested Selection pre-selected
 * (ADR-019; none for a botch) and a null Resolution, state "rolled" (post-roll actions
 * resolve it in place, ADR-013).
 * @param {object} params
 * @param {import("../rules/types.mjs").PoolDie[]} params.pool
 * @param {{scene?: string, actor?: string, token?: string, alias?: string}} [params.speaker] -
 *   forwarded to ChatMessage.create as `speaker`; defaults to ChatMessage.getSpeaker()
 * @param {number[]} [params.results] - dev and tests only: skip rolling and use these
 *   results directly (still checked by applyResults, rule 1/DP-12)
 * @returns {Promise<ChatMessage>} the created message
 * @throws {Error} if the system data is invalid, or if creation otherwise fails
 */
export async function postPoolRoll({ pool, speaker, results }) {
  let roll = null;
  let rolled;
  if ( results ) {
    rolled = applyResults(pool, results);
  } else {
    const rolledPool = await rollPool(pool);
    roll = rolledPool.roll;
    rolled = rolledPool.rolled;
  }

  const counters = { extraResultsPaid: 0, extraEffectDicePaid: 0, keepLimit: 2 };
  const messageData = {
    type: "poolRoll",
    speaker: speaker ?? ChatMessage.getSpeaker(),
    system: {
      schemaVersion: 1,
      pool,
      rolled,
      selection: { ...counters, ...suggestSelection(rolled, counters) },
      resolution: null,
      state: "rolled"
    }
  };
  if ( roll ) messageData.rolls = [roll];
  ChatMessage.applyMode(messageData); // core "messageMode" setting, the way Roll#toMessage does

  try {
    new ChatMessage(messageData);
  } catch ( err ) {
    ui.notifications.error(err.message);
    throw err;
  }

  const message = await ChatMessage.create(messageData);
  if ( !message ) {
    const err = new Error("postPoolRoll: ChatMessage.create did not create a message");
    ui.notifications.error(err.message);
    throw err;
  }
  return message;
}
