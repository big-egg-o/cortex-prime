/**
 * The minimal contest card (Decisions ADR-020, Step 4.4 S3 proposal review): the sides, the total
 * to beat, the status, and one button, "Roll" for the initiator's first roll and "Roll to beat N"
 * otherwise, shown where mayActFor allows. The button opens the pool builder with the target and
 * sends nothing. Rendered from message.system only; S4a extends it. When a contest message changes
 * or goes, the roll cards it names or that are flagged for it are rendered again, so a held card
 * turns sent or free on every client.
 * @module contest/contest-card
 */

import { openPoolBuilderFor } from "../apps/pool-builder.mjs";
import { expectedRoll, mayActFor } from "../rules/index.mjs";
import { contestRecordOf } from "./records.mjs";
import { contestFlagOf } from "./roll-card.mjs";

const TEMPLATE = "systems/cortex-prime/templates/chat/contest.hbs";

// Same options renderTemplate uses (client/applications/handlebars.mjs).
const HANDLEBARS_OPTIONS = { allowProtoMethodsByDefault: true, allowProtoPropertiesByDefault: true };

/**
 * @typedef {Object} ContestCardContext
 * @property {string} title - "Test" or "Contest"
 * @property {{key: string, label: string}[]} sides
 * @property {number|null} toBeat - a test's difficulty, a contest's standing total, or null
 * @property {{key: "waiting"|"decided"|"closed", label: string}} status - whose roll is next, or
 *   that the test or contest is decided or closed
 * @property {{side: string, rollIndex: number, toBeat: number|null, label: string}|null} button -
 *   the roll the user may make now, or null
 */

/**
 * Preloads the card template so the render hook can render synchronously.
 * @returns {Promise<Handlebars.TemplateDelegate[]>}
 */
export function preloadContestCardTemplate() {
  return foundry.applications.handlebars.loadTemplates([TEMPLATE]);
}

/**
 * @param {{key: string, label: string}[]} sides
 * @param {string} key
 * @returns {string} the side's label, or its key when it has none
 */
function sideLabel(sides, key) {
  return sides.find(side => side.key === key)?.label || key;
}

/**
 * The card's context for one user.
 * @param {ChatMessage} message - a contest message
 * @param {User} [user=game.user]
 * @returns {ContestCardContext|null} null for a message that isn't a contest a GM wrote
 */
export function prepareContestCardContext(message, user = game.user) {
  const record = contestRecordOf(message)?.record;
  if ( !record ) return null;
  const sides = record.sides.map(({ key, label }) => ({ key, label }));
  const expected = expectedRoll(record);
  const toBeat = record.state.difficulty ?? null;

  let status;
  if ( record.state.closed ) status = { key: "closed", label: game.i18n.localize("CORTEX.Contest.Card.Closed") };
  else if ( expected ) {
    status = {
      key: "waiting", label: game.i18n.format("CORTEX.Contest.Card.Waiting", { side: sideLabel(sides, expected.side) })
    };
  }
  else status = { key: "decided", label: game.i18n.localize("CORTEX.Contest.Card.Decided") };

  const sender = { userId: user.id, isGM: user.isGM === true };
  const button = (expected && mayActFor(sender, record, expected.side)) ? {
    side: expected.side, rollIndex: expected.rollIndex, toBeat: expected.toBeat,
    label: (expected.toBeat === null) ? game.i18n.localize("CORTEX.Contest.Card.Roll")
      : game.i18n.format("CORTEX.Contest.Card.RollToBeat", { total: expected.toBeat })
  } : null;

  return {
    title: game.i18n.localize(record.type === "test" ? "CORTEX.Contest.Card.Test" : "CORTEX.Contest.Card.Contest"),
    sides, toBeat, status, button
  };
}

/**
 * Replaces the body of a contest message with the card, and wires its one button. Does nothing
 * for other messages, or for a contest message a GM didn't write.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export function onRenderContestMessage(message, html) {
  if ( message.type !== "contest" ) return;
  const content = html.querySelector(".message-content");
  const context = content ? prepareContestCardContext(message) : null;
  if ( !context ) return;

  const wire = () => {
    content.querySelector('[data-action="roll-for-contest"]')?.addEventListener("click", event => {
      const { side, rollIndex } = event.currentTarget.dataset;
      openPoolBuilderFor({ messageId: message.id, side, rollIndex: Number(rollIndex) });
    });
  };
  const compiled = Handlebars.partials[TEMPLATE];
  if ( typeof compiled === "function" ) {
    content.innerHTML = compiled(context, HANDLEBARS_OPTIONS);
    wire();
    return;
  }
  foundry.applications.handlebars.renderTemplate(TEMPLATE, context).then(rendered => {
    content.innerHTML = rendered;
    wire();
  });
}

/**
 * Renders again, in this client's chat log, the roll cards a contest message names or that are
 * flagged for it, so what they offer (held, sent, free) follows the contest. Called from the
 * updateChatMessage and deleteChatMessage hooks; uses ui.chat.updateMessage (14.369
 * client/applications/sidebar/tabs/chat.mjs).
 * @param {ChatMessage} contest - a contest message, changed or deleted
 */
export function refreshRollCards(contest) {
  if ( contest?.type !== "contest" ) return;
  const flow = contest.system?.flow;
  const named = new Set((flow?.type === "contest" ? flow.rolls : (flow?.roll ? [flow.roll] : []))
    .map(roll => roll.messageRef).filter(Boolean));
  for ( const message of game.messages ) {
    if ( message.type !== "poolRoll" ) continue;
    if ( named.has(message.id) || (contestFlagOf(message)?.messageId === contest.id) ) ui.chat.updateMessage(message);
  }
}
