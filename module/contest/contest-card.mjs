/**
 * The test or contest card (Decisions ADR-020, Step 4.4 S3 and S4a proposal reviews): the sides, a
 * test's difficulty and where it came from, one row per roll, the total to beat, the status and the
 * outcome, with the controls the pure offeredActions offers this user: "Roll" or "Roll to beat N"
 * (opens the pool builder aimed at the roll), a total entered by hand, giving in or declining, and
 * for a GM the high-stakes flag and closing. Every control except "Roll" sends one request through
 * sendCardAction. Rendered from message.system only. The end choices and the consequence come with
 * S4b. When a contest message changes or goes, the roll cards it names or that are flagged for it
 * are rendered again; when a roll card goes, so are the contest cards that name it.
 * @module contest/contest-card
 */

import { openPoolBuilderFor } from "../apps/pool-builder.mjs";
import { OVERFLOW_PENDING, contestConsequence, expectedRoll, offeredActions, testResult } from "../rules/index.mjs";
import { contestRecordOf } from "./records.mjs";
import { notifyContestResult, sendContestRequest } from "./relay.mjs";
import { contestFlagOf } from "./roll-card.mjs";
import { openTotalDialog } from "./total-dialog.mjs";

const TEMPLATE = "systems/cortex-prime/templates/chat/contest.hbs";

// Same options renderTemplate uses (client/applications/handlebars.mjs).
const HANDLEBARS_OPTIONS = { allowProtoMethodsByDefault: true, allowProtoPropertiesByDefault: true };

/**
 * Where a total came from: a roll card that still exists, one that was deleted, or typed by hand.
 * @typedef {"card"|"deleted"|"typed"} TotalOrigin
 */

/**
 * @typedef {Object} ContestCardRoll
 * @property {string} side - the side key
 * @property {string} label - the side's label
 * @property {number} total
 * @property {{id: string, size: number, overflowOpen: boolean}[]} effects - the effect dice as the
 *   test or contest holds them; `overflowOpen` marks one past d12 whose choice is still open
 * @property {TotalOrigin} origin
 * @property {string|null} messageId - the roll card, while it exists
 * @property {boolean} standing - the roll whose total stands: the last one while a contest is open,
 *   the winner's last once it is decided; never a test's roll
 */

/**
 * @typedef {Object} ContestCardContext
 * @property {string} title - "Test" or "Contest"
 * @property {boolean} isTest
 * @property {boolean} highStakes
 * @property {{key: string, label: string, role: string, expected: boolean, winner: boolean}[]} sides
 * @property {{total: number, level: {key: string, label: string}|null, origin: TotalOrigin,
 *   messageId: string|null, effects: {id: string, size: number}[], takeOut: boolean}|null} difficulty -
 *   a test's difficulty, its level, where it came from, and the opposition's effect dice and
 *   take-out as stored when the test started (ADR-021; RQ-035); null for a contest
 * @property {ContestCardRoll[]} rolls
 * @property {number|null} toBeat - a test's difficulty, a contest's standing total, or null
 * @property {{key: "waiting"|"decided"|"closed", label: string}} status - whose roll is next, or
 *   that the test or contest is decided or closed
 * @property {object|null} outcome - null until decided. A test's: `{success, margin, heroicSteps,
 *   pending}`. A contest's: `{winner, label, ending, margin, heroicSteps, pending}`, where `ending`
 *   is "won", "gaveIn" or "declined" and `margin` is null unless a roll failed. `pending` is
 *   "heroic" or "overflow" while that end choice waits (S4b's controls), otherwise null
 * @property {{side: string, rollIndex: number, toBeat: number|null, label: string}|null} button -
 *   the roll the user may make now, or null
 * @property {{total: {side: string}|null, giveIn: {side: string, action: "give-in"|"decline",
 *   label: string}|null, highStakes: {value: boolean}|null, close: boolean}} controls - what else
 *   the user may do now
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
 * @param {string|null} messageRef - a stored roll-card id, or null for a typed total
 * @returns {TotalOrigin}
 */
function originOf(messageRef) {
  if ( messageRef == null ) return "typed";
  return game.messages.get(messageRef)?.type === "poolRoll" ? "card" : "deleted";
}

/**
 * Which end choice a decided test or contest still waits for, read from the codes of testResult
 * and contestConsequence (ADR-028).
 * @param {import("../rules/contest-request.mjs").ContestRecord} record
 * @returns {"heroic"|"overflow"|null}
 */
function pendingOf(record) {
  const result = record.type === "test" ? testResult(record.state)
    : contestConsequence(record.state, { usedAgainstLoser: [] });
  if ( result.ok ) return null;
  if ( result.code === "HEROIC_PENDING" ) return "heroic";
  return result.code === OVERFLOW_PENDING ? "overflow" : null;
}

/**
 * @param {import("../rules/contest-request.mjs").ContestRecord} record
 * @param {{key: string, label: string}[]} sides
 * @returns {ContestCardRoll[]}
 */
function rollRows(record, sides) {
  const state = record.state;
  const rolls = record.type === "test" ? (state.roll ? [state.roll] : []) : state.rolls;
  let standing = -1;
  if ( record.type === "contest" ) {
    standing = state.status === "open" ? rolls.length - 1 : rolls.findLastIndex(roll => roll.side === state.winner);
  }
  return rolls.map((roll, index) => {
    const origin = originOf(roll.messageRef);
    return {
      side: roll.side, label: sideLabel(sides, roll.side), total: roll.total,
      effects: roll.effects.map(({ id, size }) => ({
        id, size, overflowOpen: (roll.overflows ?? []).some(o => (o.effectId === id) && (o.kind == null))
      })),
      origin, messageId: origin === "card" ? roll.messageRef : null, standing: index === standing
    };
  });
}

/**
 * @param {import("../rules/contest-request.mjs").ContestRecord} record
 * @param {{key: string, label: string}[]} sides
 * @returns {object|null} the outcome, as ContestCardContext describes it
 */
function outcomeOf(record, sides) {
  const state = record.state;
  if ( record.type === "test" ) {
    if ( state.roll == null ) return null;
    return { success: state.success, margin: state.margin, heroicSteps: state.heroicSteps, pending: pendingOf(record) };
  }
  if ( state.status === "open" ) return null;
  return {
    winner: state.winner, label: sideLabel(sides, state.winner), ending: state.status, margin: state.margin,
    heroicSteps: state.heroicSteps, pending: pendingOf(record)
  };
}

/**
 * The card's context for one user.
 * @param {ChatMessage} message - a contest message
 * @param {User} [user=game.user]
 * @returns {ContestCardContext|null} null for a message that isn't a contest a GM wrote
 */
export function prepareContestCardContext(message, user = game.user) {
  const loaded = contestRecordOf(message);
  if ( !loaded ) return null;
  const { record, system } = loaded;
  const state = record.state;
  const isTest = record.type === "test";
  const expected = expectedRoll(record);
  const winner = isTest ? null : state.winner;
  const sides = record.sides.map(({ key, label }) => ({
    key, label, role: game.i18n.localize(`CORTEX.Contest.Card.Roles.${key}`), expected: expected?.side === key,
    winner: winner === key
  }));

  let difficulty = null;
  if ( isTest ) {
    const flow = system.flow;
    const origin = originOf(flow.difficultyMessageRef);
    difficulty = {
      total: state.difficulty,
      level: flow.difficultyLevel
        ? { key: flow.difficultyLevel, label: game.i18n.localize(`CORTEX.Contest.DifficultyLevels.${flow.difficultyLevel}`) }
        : null,
      origin, messageId: origin === "card" ? flow.difficultyMessageRef : null,
      effects: (flow.oppositionEffects ?? []).map(({ id, size }) => ({ id, size })),
      takeOut: flow.oppositionTakeOut === true
    };
  }

  let status;
  if ( state.closed ) status = { key: "closed", label: game.i18n.localize("CORTEX.Contest.Card.Closed") };
  else if ( expected ) {
    status = {
      key: "waiting", label: game.i18n.format("CORTEX.Contest.Card.Waiting", { side: sideLabel(sides, expected.side) })
    };
  }
  else status = { key: "decided", label: game.i18n.localize("CORTEX.Contest.Card.Decided") };

  const offered = offeredActions({ userId: user.id, isGM: user.isGM === true }, record);
  const button = offered.roll ? {
    ...offered.roll,
    label: (offered.roll.toBeat === null) ? game.i18n.localize("CORTEX.Contest.Card.Roll")
      : game.i18n.format("CORTEX.Contest.Card.RollToBeat", { total: offered.roll.toBeat })
  } : null;
  const controls = {
    total: offered.roll ? { side: offered.roll.side } : null,
    giveIn: offered.giveIn ? {
      ...offered.giveIn,
      label: game.i18n.localize(offered.giveIn.action === "decline" ? "CORTEX.Contest.Card.Decline" : "CORTEX.Contest.Card.GiveIn")
    } : null,
    highStakes: offered.highStakes ? { value: state.highStakes === true } : null,
    close: offered.close
  };

  return {
    title: game.i18n.localize(isTest ? "CORTEX.Contest.Card.Test" : "CORTEX.Contest.Card.Contest"),
    isTest, highStakes: state.highStakes === true, sides, difficulty, rolls: rollRows(record, sides),
    toBeat: state.difficulty ?? null, status, outcome: outcomeOf(record, sides), button, controls
  };
}

/**
 * Sends one action from a test or contest card to the GM relay, with the message's current
 * revision on this client, and shows a refusal with notifyContestResult (ADR-020, Step 4.4 S4a
 * proposal review). Every control on the card except "Roll" calls this, and so does Quench.
 * @param {ChatMessage} message - a contest message
 * @param {string} action - "add-roll" (a typed total), "give-in", "decline", "set-high-stakes" or
 *   "close"
 * @param {object} [payload] - the action's payload, as ContestRequest describes it
 * @returns {Promise<{ok: boolean, code?: string, value?: object}>} the relay's answer
 */
export async function sendCardAction(message, action, payload = {}) {
  const result = await sendContestRequest({ action, messageId: message.id, revision: message.system.revision, payload });
  notifyContestResult(result);
  return result;
}

/**
 * Asks once before an action that can't be undone.
 * @param {string} key - the action's string group under CORTEX.Contest.Card.Confirm
 * @returns {Promise<boolean>}
 */
async function confirmed(key) {
  const answer = await foundry.applications.api.DialogV2.confirm({
    window: { title: `CORTEX.Contest.Card.Confirm.${key}.Title` },
    content: `<p>${game.i18n.localize(`CORTEX.Contest.Card.Confirm.${key}.Text`)}</p>`
  });
  return answer === true;
}

/**
 * Scrolls this client's chat log to a roll card. The chat log has no method for it (14.369
 * client/applications/sidebar/tabs/chat.mjs), so the message's element is scrolled into view. The
 * link carries the id as `data-roll-id`, so only the message itself has `data-message-id`.
 * @param {HTMLElement} from - an element inside the chat log that shows the contest card
 * @param {string} messageId
 */
function showRollCard(from, messageId) {
  const log = from.closest(".chat-log") ?? document;
  log.querySelector(`.chat-message[data-message-id="${CSS.escape(messageId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

/**
 * Handles one click on a card control.
 * @param {ChatMessage} message
 * @param {HTMLElement} target - the clicked element, with `data-action`
 * @returns {Promise<unknown>}
 */
async function onCardClick(message, target) {
  const { action, side, request, rollId, value } = target.dataset;
  switch ( action ) {
    case "roll-for-contest":
      return openPoolBuilderFor({ messageId: message.id, side, rollIndex: Number(target.dataset.rollIndex) });
    case "enter-total": return openTotalDialog(message, side);
    case "give-in":
      if ( !(await confirmed(request === "decline" ? "Decline" : "GiveIn")) ) return null;
      return sendCardAction(message, request, request === "decline" ? {} : { side });
    case "toggle-high-stakes": return sendCardAction(message, "set-high-stakes", { highStakes: value !== "true" });
    case "close-contest":
      if ( !(await confirmed("Close")) ) return null;
      return sendCardAction(message, "close", {});
    case "show-roll": return showRollCard(target, rollId);
    default: return null;
  }
}

/**
 * Replaces the body of a contest message with the card, and wires its controls. Does nothing
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
    for ( const control of content.querySelectorAll("[data-action]") ) {
      control.addEventListener("click", event => {
        event.preventDefault();
        onCardClick(message, event.currentTarget).catch(err => console.error(err));
      });
    }
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
 * @param {object} flow - a stored flow
 * @returns {string[]} the roll cards it names: its rolls', and a test's difficulty card
 */
function namedRollCards(flow) {
  const rolls = flow?.type === "contest" ? (flow.rolls ?? []) : (flow?.roll ? [flow.roll] : []);
  return [...rolls.map(roll => roll.messageRef), flow?.difficultyMessageRef].filter(Boolean);
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
  const rolls = flow?.type === "contest" ? (flow.rolls ?? []) : (flow?.roll ? [flow.roll] : []);
  const named = new Set(rolls.map(roll => roll.messageRef).filter(Boolean));
  for ( const message of game.messages ) {
    if ( message.type !== "poolRoll" ) continue;
    if ( named.has(message.id) || (contestFlagOf(message)?.messageId === contest.id) ) ui.chat.updateMessage(message);
  }
}

/**
 * Renders again, in this client's chat log, the contest cards that name a roll card: as one of
 * their rolls, or as a test's difficulty card. Called from the deleteChatMessage hook, so a deleted
 * roll card's link turns into "card deleted"; the stored totals and effect dice don't change
 * (ADR-020).
 * @param {ChatMessage} poolRoll - a poolRoll message, deleted or not
 * @returns {ChatMessage[]} the contest messages rendered again
 */
export function refreshContestCards(poolRoll) {
  if ( poolRoll?.type !== "poolRoll" ) return [];
  const naming = game.messages.filter(m => (m.type === "contest") && namedRollCards(m.system?.flow).includes(poolRoll.id));
  for ( const message of naming ) ui.chat.updateMessage(message);
  return naming;
}
