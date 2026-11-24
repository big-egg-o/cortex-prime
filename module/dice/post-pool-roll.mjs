/**
 * Posts a dice pool roll as a poolRoll chat message (Decisions ADR-009, ADR-010, ADR-013).
 * @module dice/post-pool-roll
 */

import { getGameConfig } from "../config/settings.mjs";
import { POOL_ROLL_SCHEMA_VERSION } from "../data/chat/pool-roll.mjs";
import { applyResults, suggestSelection, traitSetById } from "../rules/index.mjs";
import { rollPool } from "./roll-pool.mjs";

/**
 * The warnings as they are stored: copies, and each one that names a set and brings no
 * `setLabel` gets that set's current name as its label, so the card can name the set as it was
 * when the pool was rolled (ADR-047). A set the game configuration doesn't have gets no label.
 * Anything that isn't a warning object is passed on as it is, for the schema to refuse.
 * @param {unknown} warnings
 * @returns {unknown}
 */
function withSetLabels(warnings) {
  if ( !Array.isArray(warnings) ) return warnings;
  let config;
  return warnings.map(warning => {
    const copy = foundry.utils.deepClone(warning);
    if ( !copy || (typeof copy !== "object") || !copy.setId || copy.setLabel ) return copy;
    if ( config === undefined ) {
      try {
        config = getGameConfig();
      }
      catch {
        config = null;
      }
    }
    const name = config ? traitSetById(config, copy.setId)?.name : null;
    if ( (typeof name === "string") && name ) copy.setLabel = name;
    return copy;
  });
}

/**
 * Rolls a pool (or takes fixed results, dev/test only) and posts it as a poolRoll chat
 * message. The message starts unresolved, with the engine's suggested Selection pre-selected
 * (ADR-019; none for a botch) and a null Resolution, state "rolled" (post-roll actions
 * resolve it in place, ADR-013). The pool's warnings and unpriced traits are stored with it as
 * given, so the card shows what the pool was when it was rolled (ADR-029 consequences, RQ-030);
 * nothing here works them out or judges them. The one addition is the name of each set a
 * warning names, as the game configuration has it now (ADR-047).
 * @param {object} params
 * @param {import("../rules/types.mjs").PoolDie[]} params.pool
 * @param {{scene?: string, actor?: string, token?: string, alias?: string}} [params.speaker] -
 *   forwarded to ChatMessage.create as `speaker`; defaults to ChatMessage.getSpeaker()
 * @param {number[]} [params.results] - dev and tests only: skip rolling and use these
 *   results directly (still checked by applyResults, rule 1/DP-12)
 * @param {{code: string, setId?: string, setLabel?: string, actorId?: string, traitId?: string}[]} [params.warnings] -
 *   what the pool's traits warn of (poolTraitCost, effectiveRating); none by default. A
 *   `setLabel` the caller gives is kept
 * @param {{setId: string, count: number}[]} [params.unpricedTraits] - traits with no defined
 *   price (poolTraitCost, RQ-030); none by default
 * @param {object} [params.pp] - the roll's plot points as rollPpData gives them: its account and
 *   pool-stage lines (Plot Points P1, P4); left out, the schema's (no account, no lines)
 * @param {{messageId: string, side: string, rollIndex: number}} [params.contest] - the roll a test
 *   or contest waits for. The card gets it as its `flags["cortex-prime"].contest`, and is posted in
 *   the "public" mode whatever the user's setting: rolls are made openly (Handbook p. 17), and the
 *   total shows on the public contest card anyway (ADR-020, Step 4.4 S3 proposal review)
 * @returns {Promise<ChatMessage>} the created message
 * @throws {Error} if the system data is invalid, or if creation otherwise fails
 */
export async function postPoolRoll({ pool, speaker, results, warnings = [], unpricedTraits = [], pp, contest }) {
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
      schemaVersion: POOL_ROLL_SCHEMA_VERSION,
      pool,
      rolled,
      selection: { ...counters, ...suggestSelection(rolled, counters) },
      resolution: null,
      state: "rolled",
      warnings: withSetLabels(warnings),
      unpricedTraits: foundry.utils.deepClone(unpricedTraits)
    }
  };
  if ( pp ) messageData.system.pp = foundry.utils.deepClone(pp);
  if ( roll ) messageData.rolls = [roll];
  if ( contest ) {
    const { messageId, side, rollIndex } = contest;
    messageData.flags = { "cortex-prime": { contest: { messageId, side, rollIndex } } };
    ChatMessage.applyMode(messageData, "public");
  }
  else ChatMessage.applyMode(messageData); // core "messageMode" setting, the way Roll#toMessage does

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
