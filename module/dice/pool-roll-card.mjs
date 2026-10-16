/**
 * The poolRoll chat card: renders message.system into HTML, and (for the message's owner and
 * the GM, ADR-013) makes it interactive. Registered on the "renderChatMessageHTML" hook in
 * module/cortex-prime.mjs init, which also preloads the template so the hook can render
 * synchronously (no flash of the default Roll content Foundry would otherwise insert first
 * for a message with `rolls`).
 * @module dice/pool-roll-card
 */

import { evaluate, validateSelection } from "../rules/index.mjs";
import { applyCardChange, canEditPoolRollCard } from "./card-actions.mjs";

const TEMPLATE = "systems/cortex-prime/templates/chat/pool-roll.hbs";

// Same options renderTemplate uses (client/applications/handlebars.mjs): resolving prototype
// methods/properties is safe here since it only happens client-side.
const HANDLEBARS_OPTIONS = { allowProtoMethodsByDefault: true, allowProtoPropertiesByDefault: true };

/**
 * @typedef {Object} CardDie
 * @property {string} id
 * @property {string|null} label - the die's source label, or null when it has none (a
 *   default effect die)
 * @property {number} size
 * @property {string} sizeLabel - e.g. "d8", built here so the template only interpolates
 * @property {number|null} result - null for a default effect die with no die behind it
 * @property {'total'|'effect'|'unused'} role - where the die currently sits in the selection
 * @property {boolean} clickable - whether a click on this die would do anything
 */

/**
 * Preloads the card template so module/cortex-prime.mjs's renderChatMessageHTML hook can
 * render it synchronously.
 * @returns {Promise<Handlebars.TemplateDelegate[]>}
 */
export function preloadPoolRollCardTemplate() {
  return foundry.applications.handlebars.loadTemplates([TEMPLATE]);
}

/**
 * Builds the Handlebars context for a poolRoll card: whether the roll botched (rule 11,
 * DP-09), dice grouped by source with hitches kept apart and each die's current role, whether
 * the current user may act on the card, and (once resolved) the total and effect dice.
 * While unresolved, also carries the live validateSelection check — its errors translated
 * from lang/en.json — so the template can disable Confirm without any game logic of its own.
 * `botch` comes from module/rules/'s own evaluate(), not re-derived here, since a botch is
 * already known as soon as the dice are rolled, before anything is resolved.
 * @param {ChatMessage} message
 * @returns {{botch: boolean, groups: {label: string, dice: CardDie[]}[], hitches: CardDie[],
 *   resolved: object|null, interactive: boolean,
 *   selection: {valid: boolean, errors: {code: string, message: string}[],
 *     extraResultsPaid: number, extraEffectDicePaid: number}|null}}
 */
export function preparePoolRollCardContext(message) {
  const system = message.system;
  const { botch } = evaluate(system.rolled);
  const resolvedState = system.state === "resolved";
  const interactive = !resolvedState && canEditPoolRollCard(message);

  const roleOf = die => {
    if ( system.selection.totalIds.includes(die.id) ) return "total";
    if ( system.selection.effectDieIds.includes(die.id) ) return "effect";
    return "unused";
  };

  const byId = new Map(system.rolled.map(die => [die.id, die]));
  const bySourceLabel = new Map();
  const hitches = [];

  for ( const die of system.rolled ) {
    const card = {
      id: die.id, label: die.source.label, size: die.size, sizeLabel: `d${die.size}`,
      result: die.result, role: die.hitch ? "unused" : roleOf(die),
      clickable: interactive && !die.hitch && (die.state === "available")
    };
    if ( die.hitch ) {
      hitches.push(card);
      continue;
    }
    if ( !bySourceLabel.has(die.source.label) ) bySourceLabel.set(die.source.label, []);
    bySourceLabel.get(die.source.label).push(card);
  }
  const groups = Array.from(bySourceLabel, ([label, dice]) => ({ label, dice }));

  let resolved = null;
  if ( !botch && resolvedState ) {
    const totalDice = system.resolution.totalIds.map(id => {
      const die = byId.get(id);
      return { label: die.source.label, size: die.size, sizeLabel: `d${die.size}`, result: die.result };
    });
    const effectDice = system.resolution.effectDice.map(entry => {
      const die = entry.dieId ? byId.get(entry.dieId) : null;
      return {
        label: die?.source.label ?? null,
        size: entry.size,
        sizeLabel: `d${entry.size}`,
        result: die?.result ?? null,
        isDefaultD4: entry.isDefault && (entry.size === 4)
      };
    });
    resolved = { total: system.resolution.total, totalDice, effectDice };
  }

  let selection = null;
  if ( !resolvedState ) {
    const { valid, errors } = validateSelection(system.rolled, system.selection);
    selection = {
      valid,
      errors: errors.map(e => ({ code: e.code, message: game.i18n.localize(`CORTEX.Chat.Errors.${e.code}`) })),
      extraResultsPaid: system.selection.extraResultsPaid,
      extraEffectDicePaid: system.selection.extraEffectDicePaid
    };
  }

  return { botch, groups, hitches, resolved, interactive, selection };
}

/**
 * Renders the card body HTML for a poolRoll message. Used by the hook's async fallback and
 * directly by the Quench batch; the hook itself prefers the synchronous path.
 * @param {ChatMessage} message
 * @returns {Promise<string>}
 */
export async function renderPoolRollCard(message) {
  return foundry.applications.handlebars.renderTemplate(TEMPLATE, preparePoolRollCardContext(message));
}

/**
 * Attaches one delegated click listener to a rendered card's content element, dispatching
 * every `[data-action]` click to module/dice/card-actions.mjs. No game logic here: the
 * listener only reads the clicked element's dataset and calls applyCardChange with it.
 * @param {ChatMessage} message
 * @param {HTMLElement} content
 */
function activatePoolRollCardListeners(message, content) {
  content.addEventListener("click", event => {
    const target = event.target.closest("[data-action]");
    if ( !target ) return;
    const { action, dieId } = target.dataset;
    applyCardChange(message, dieId ? { action, dieId } : { action });
  });
}

/**
 * Replaces the message body of poolRoll messages with the rendered card, and (for an
 * interactive, unresolved card) wires up its click handling. No game logic here: every value
 * shown already lives in message.system or comes from module/rules/'s evaluate() and
 * validateSelection(). Does nothing for a message whose content isn't visible to the current
 * user (a blind or whispered-away roll): Foundry's own hidden-content placeholder is left as
 * it is.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export function onRenderPoolRollMessage(message, html) {
  if ( message.type !== "poolRoll" ) return;
  if ( !message.isContentVisible ) return;
  const content = html.querySelector(".message-content");
  if ( !content ) return;

  const context = preparePoolRollCardContext(message);

  const compiled = Handlebars.partials[TEMPLATE];
  if ( typeof compiled === "function" ) {
    content.innerHTML = compiled(context, HANDLEBARS_OPTIONS);
    if ( context.interactive ) activatePoolRollCardListeners(message, content);
    return;
  }

  // Fallback for the rare case the template hasn't finished preloading yet: async, so this
  // path alone can still show a brief flash of the default Roll content.
  renderPoolRollCard(message).then(rendered => {
    content.innerHTML = rendered;
    if ( context.interactive ) activatePoolRollCardListeners(message, content);
  });
}
