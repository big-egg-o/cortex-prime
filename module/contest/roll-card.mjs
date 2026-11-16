/**
 * A poolRoll card rolled for a test or contest (Decisions ADR-020, Step 4.4 S3 proposal review):
 * its flag, what it offers (held, sent or free), and the Send action that hands it to the test or
 * contest through the GM relay. Nothing here decides an outcome; the pure rollCardHold decides
 * what the card offers, and the relay checks Send like any other request.
 * @module contest/roll-card
 */

import { rollCardHold } from "../rules/contest-request.mjs";
import { contestRecordOf } from "./records.mjs";
import { notifyContestResult, sendContestRequest } from "./relay.mjs";

/** The system's flag scope. */
const SCOPE = "cortex-prime";

/** The flag key, under the system's scope, that ties a roll card to a test or contest and turn. */
export const CONTEST_FLAG = "contest";

/**
 * A roll card's flag, `{messageId, side, rollIndex}`, or null when it has none with a message id.
 * @param {ChatMessage} message
 * @returns {{messageId: string, side: string, rollIndex: number}|null}
 */
export function contestFlagOf(message) {
  const flag = message?.getFlag?.(SCOPE, CONTEST_FLAG);
  return (flag && (typeof flag.messageId === "string")) ? flag : null;
}

/**
 * What a poolRoll card offers: "sent" when the test or contest its flag names holds it, "held"
 * while that test or contest waits for this side's roll on this turn, "free" otherwise, a card
 * without a flag included. Only a contest message a GM wrote counts, as in the relay.
 * @param {ChatMessage} message - a poolRoll message
 * @returns {"sent"|"held"|"free"}
 */
export function holdOf(message) {
  const flag = contestFlagOf(message);
  if ( !flag ) return "free";
  const loaded = contestRecordOf(game.messages.get(flag.messageId));
  return rollCardHold(loaded?.record ?? null, message.id, flag);
}

/**
 * Sends a held, resolved roll card to its test or contest: an add-roll request with the contest
 * message's current revision on this client, the side from the card's flag and the card's id.
 * A refusal is shown with notifyContestResult. The Send button's click calls this.
 * @param {ChatMessage} message - a poolRoll message
 * @returns {Promise<{ok: boolean, code?: string, value?: object}>} the relay's answer
 */
export async function sendRollCard(message) {
  const flag = contestFlagOf(message);
  const loaded = flag ? contestRecordOf(game.messages.get(flag.messageId)) : null;
  const result = loaded
    ? await sendContestRequest({
      action: "add-roll", messageId: flag.messageId, revision: loaded.record.revision,
      payload: { side: flag.side, poolRollId: message.id }
    })
    : { ok: false, code: "CONTEST_NOT_FOUND" };
  notifyContestResult(result);
  return result;
}
