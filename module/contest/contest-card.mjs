/**
 * The test or contest card (Decisions ADR-020, Step 4.4 S3 and S4a proposal reviews): the sides, a
 * test's difficulty and where it came from, one row per roll, the total to beat, the status and the
 * outcome, with the controls the pure offeredActions offers this user: "Roll" or "Roll to beat N"
 * (opens the pool builder aimed at the roll), a total entered by hand, giving in or declining, and
 * for a GM the high-stakes flag and closing. Every control except "Roll" sends one request through
 * sendCardAction. Rendered from message.system only.
 *
 * At the end (Step 4.4 S4b proposal review) the card offers what the pure offeredEndChoices offers
 * this user: the die for the heroic steps, the choice for each effect die past d12, and for a won
 * contest the effect dice used against the loser. Everyone then sees a contest's consequence, as a
 * preview with every effect die until the winner has picked, or a test's result. A card closed
 * while a choice waited says so and shows neither.
 *
 * When a contest message changes or goes, the roll cards it names or that are flagged for it are
 * rendered again; when a roll card goes, so are the contest cards that name it.
 * @module contest/contest-card
 */

import { openPoolBuilderFor } from "../apps/pool-builder.mjs";
import {
  OVERFLOW_PENDING, contestConsequence, expectedRoll, liveOverflowIds, offeredActions, offeredEndChoices, testResult
} from "../rules/index.mjs";
import { prepareContestPp } from "../plot-points/contest-pp.mjs";
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
 *   test or contest holds them; `overflowOpen` marks one past d12 whose choice can still be made
 *   (liveOverflowIds); a lapsed one shows as a plain d12
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
 * @property {{heroic: {steps: number, dice: {effectId: string, size: number}[]}|null,
 *   overflows: {effectId: string, leftovers: {dieId: string, size: number}[], newDie: 6, takeOut: boolean}[],
 *   pick: {dice: {effectId: string, size: number, checked: boolean}[]}|null}} end - the end choices
 *   this user may make now. A die of `pick` is checked when it is in the stored pick, and every die
 *   is before any pick
 * @property {object|null} consequence - a contest's Consequence (rules/types.mjs) with the stored
 *   pick, plus `preview` (the winner hasn't picked, so every effect die is used against the loser),
 *   `unrolled` (the opposition declined before the initiator rolled) and `loserLabel`. Null for a
 *   test, and while the contest is open, an end choice waits, or the card was closed before it
 * @property {{effects: {id: string, size: number}[], takeOut: boolean}|null} result - a test's
 *   effect dice as they stand after its end choices, and whether the take-out or victory was chosen;
 *   null for a contest, before the roll, and while a choice waits
 * @property {boolean} closedEarly - the card was closed while an end choice waited
 * @property {object|null} pp - the plot points paid for giving in and staying in, and the Stay in
 *   offer for this user (prepareContestPp; P8)
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
  const live = liveOverflowIds(record);
  return rolls.map((roll, index) => {
    const origin = originOf(roll.messageRef);
    return {
      side: roll.side, label: sideLabel(sides, roll.side), total: roll.total,
      effects: roll.effects.map(({ id, size }) => ({ id, size, overflowOpen: (live[index] ?? []).includes(id) })),
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
 * The end choices this user may make now, with the dice's sizes for their labels.
 * @param {import("../rules/contest-request.mjs").ContestRecord} record
 * @param {ContestCardRoll[]} rolls - the card's rows
 * @param {string[]|null} stored - the stored pick, or null before any
 * @param {User} user
 * @returns {object} `end`, as ContestCardContext describes it
 */
function endChoices(record, rolls, stored, user) {
  const offered = offeredEndChoices({ userId: user.id, isGM: user.isGM === true }, record);
  const row = record.type === "test" ? rolls[0] : rolls.find(roll => roll.standing);
  const die = effectId => ({ effectId, size: row?.effects.find(effect => effect.id === effectId)?.size ?? null });
  return {
    heroic: offered.heroic ? { steps: offered.heroic.steps, dice: offered.heroic.effectIds.map(die) } : null,
    overflows: offered.overflows,
    pick: offered.pick ? {
      dice: offered.pick.effectIds.map(id => ({ ...die(id), checked: (stored == null) || stored.includes(id) }))
    } : null
  };
}

/**
 * A contest's consequence with the stored pick; before any pick, with every effect die of the
 * winner's last roll used against the loser, as a preview (ADR-020, Step 4.4 S4b proposal review).
 * @param {import("../rules/contest-request.mjs").ContestRecord} record
 * @param {{key: string, label: string}[]} sides
 * @param {ContestCardRoll[]} rolls - the card's rows
 * @param {string[]|null} stored - the stored pick, or null before any
 * @returns {object|null} `consequence`, as ContestCardContext describes it
 */
function consequenceOf(record, sides, rolls, stored) {
  const state = record.state;
  if ( (record.type !== "contest") || (state.status === "open") ) return null;
  const all = (rolls.find(roll => roll.standing)?.effects ?? []).map(effect => effect.id);
  const result = contestConsequence(state, { usedAgainstLoser: stored ?? all });
  if ( !result.ok ) return null;
  const consequence = result.value;
  return {
    ...consequence,
    preview: (consequence.ending === "won") && (stored == null) && (all.length > 0),
    unrolled: (consequence.ending === "declined") && (state.hasRolled?.initiator !== true),
    loserLabel: sideLabel(sides, consequence.loser)
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

  const rolls = rollRows(record, sides);
  const outcome = outcomeOf(record, sides);
  const stored = isTest ? null : (system.flow.usedAgainstLoser ?? null);
  const closedEarly = (state.closed === true) && (outcome?.pending != null);
  const tested = isTest && !closedEarly ? testResult(state) : null;

  return {
    title: game.i18n.localize(isTest ? "CORTEX.Contest.Card.Test" : "CORTEX.Contest.Card.Contest"),
    isTest, highStakes: state.highStakes === true, sides, difficulty, rolls,
    toBeat: state.difficulty ?? null, status, outcome, button, controls,
    end: endChoices(record, rolls, stored, user),
    consequence: closedEarly ? null : consequenceOf(record, sides, rolls, stored),
    result: tested?.ok ? { effects: tested.value.effects, takeOut: tested.value.takeOut } : null,
    closedEarly,
    pp: closedEarly ? null : prepareContestPp(message, loaded, key => sideLabel(sides, key), user)
  };
}

/**
 * Sends one action from a test or contest card to the GM relay, with the message's current
 * revision on this client, and shows a refusal with notifyContestResult (ADR-020, Step 4.4 S4a
 * proposal review). Every control on the card except "Roll" calls this, and so does Quench.
 * @param {ChatMessage} message - a contest message
 * @param {string} action - "add-roll" (a typed total), "give-in", "decline", "set-high-stakes",
 *   "close", or an end choice: "apply-heroic-steps", "choose-overflow" or "use-against-loser"
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
 * The GM's answers for staying in after a test (rule 15; RQ-035, RQ-044), read from the card's
 * form: the opposition effect dice marked as acting on the character, the size when there is none,
 * and whether the setter's take-out applies. A contest's Stay in has no form and sends nothing.
 * @param {HTMLElement|null} form
 * @returns {{overflowApplies?: boolean, usedAgainst?: string[], gmSize?: number|"none"}}
 */
function stayInAnswers(form) {
  if ( !form?.dataset.test ) return {};
  const overflowApplies = form.querySelector('input[name="overflowApplies"]')?.checked === true;
  if ( overflowApplies ) return { overflowApplies };
  const boxes = form.querySelectorAll('input[name="usedAgainst"]');
  if ( boxes.length ) return { overflowApplies, usedAgainst: Array.from(boxes).filter(box => box.checked).map(box => box.value) };
  const size = form.querySelector('select[name="gmSize"]')?.value;
  return { overflowApplies, gmSize: size === "none" ? "none" : Number(size) };
}

/**
 * Handles one click on a card control.
 * @param {ChatMessage} message
 * @param {HTMLElement} target - the clicked element, with `data-action`
 * @returns {Promise<unknown>}
 */
async function onCardClick(message, target) {
  const { action, side, request, rollId, value, effectId, kind, dieId } = target.dataset;
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
    case "apply-heroic-steps": return sendCardAction(message, action, { effectId });
    case "choose-overflow":
      return sendCardAction(message, action, kind === "leftover" ? { effectId, kind, dieId } : { effectId, kind });
    case "stay-in": {
      if ( !(await confirmed("StayIn")) ) return null;
      return sendCardAction(message, action, stayInAnswers(target.closest(".cp-pp-stay-in")));
    }
    case "use-against-loser": {
      const boxes = target.closest(".cp-end-pick")?.querySelectorAll("input[type=checkbox]:checked") ?? [];
      return sendCardAction(message, action, { effectIds: Array.from(boxes, box => box.dataset.effectId) });
    }
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
