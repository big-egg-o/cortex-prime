/**
 * The poolRoll chat card: renders message.system into HTML, and (for the message's owner and
 * the GM, ADR-013) makes it interactive. Registered on the "renderChatMessageHTML" hook in
 * module/cortex-prime.mjs init, which also preloads the template so the hook can render
 * synchronously (no flash of the default Roll content Foundry would otherwise insert first
 * for a message with `rolls`).
 * @module dice/pool-roll-card
 */

import { evaluate, resolve, validateSelection } from "../rules/index.mjs";
import { applyCardChange, canEditPoolRollCard } from "./card-actions.mjs";

const TEMPLATE = "systems/cortex-prime/templates/chat/pool-roll.hbs";

// Same options renderTemplate uses (client/applications/handlebars.mjs): resolving prototype
// methods/properties is safe here since it only happens client-side.
const HANDLEBARS_OPTIONS = { allowProtoMethodsByDefault: true, allowProtoPropertiesByDefault: true };

/** Localization keys for each die role, shown as a title/aria-label on the die. */
const ROLE_LABEL_KEYS = {
  total: "CORTEX.Chat.Role.Total",
  effect: "CORTEX.Chat.Role.Effect",
  hitch: "CORTEX.Chat.Role.Hitch",
  unused: "CORTEX.Chat.Role.Unused"
};

/**
 * @typedef {Object} CardDie
 * @property {string} id
 * @property {string} label - the die's source label (escaped by the template)
 * @property {number} size
 * @property {number} result
 * @property {'total'|'effect'|'unused'|'hitch'} role
 * @property {string} roleLabel - localized, for the die's title/aria-label
 * @property {boolean} clickable
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
 * The "effect {dice}" part of a headline: a default effect die (rule 20, rule 21, DP-22) shows
 * as "default d4" rather than its size, since every default is a d4 and showing both would be
 * redundant.
 * @param {import("../rules/types.mjs").EffectDieEntry[]} effectDice
 * @returns {string}
 */
function formatEffectPhrase(effectDice) {
  return effectDice
    .map(e => (e.isDefault ? game.i18n.localize("CORTEX.Chat.DefaultD4") : `d${e.size}`))
    .join(", ");
}

/**
 * Builds the Handlebars context for a poolRoll card: a one-line headline, every rolled die
 * once with its current role, whether the current user may act on the card, and (while
 * interactive) the live validateSelection check for the controls panel. No game logic here
 * beyond calling module/rules/'s own evaluate(), validateSelection() and resolve() — the last
 * only to preview a valid-but-unconfirmed selection's total and effect dice, never to store
 * anything.
 * @param {ChatMessage} message
 * @returns {{botch: boolean, dice: CardDie[], headline: string, interactive: boolean,
 *   selection: {valid: boolean, errors: {code: string, message: string}[],
 *     extraResultsPaid: number, extraEffectDicePaid: number}|null}}
 */
export function preparePoolRollCardContext(message) {
  const system = message.system;
  const { botch } = evaluate(system.rolled);
  const resolvedState = system.state === "resolved";
  const interactive = !resolvedState && canEditPoolRollCard(message);

  // Roles come from the confirmed Resolution once resolved, otherwise the live selection.
  const totalIds = resolvedState ? system.resolution.totalIds : system.selection.totalIds;
  const effectDieIds = resolvedState
    ? system.resolution.effectDice.map(e => e.dieId).filter(id => id !== null)
    : system.selection.effectDieIds;

  const dice = system.rolled.map(die => {
    const role = die.hitch ? "hitch"
      : totalIds.includes(die.id) ? "total"
        : effectDieIds.includes(die.id) ? "effect" : "unused";
    return {
      id: die.id, label: die.source.label, size: die.size, result: die.result, role,
      roleLabel: game.i18n.localize(ROLE_LABEL_KEYS[role]),
      clickable: interactive && !die.hitch && (die.state === "available")
    };
  });

  const validation = interactive ? validateSelection(system.rolled, system.selection) : null;

  let headline;
  let listedErrors = validation?.errors ?? [];
  if ( botch ) {
    headline = game.i18n.localize("CORTEX.Chat.Botch");
  } else if ( resolvedState ) {
    headline = game.i18n.format("CORTEX.Chat.ResolvedHeadline", {
      total: system.resolution.total, effect: formatEffectPhrase(system.resolution.effectDice)
    });
  } else if ( !interactive ) {
    headline = game.i18n.localize("CORTEX.Chat.Choosing");
  } else {
    const empty = (system.selection.totalIds.length === 0) && (system.selection.effectDieIds.length === 0);
    if ( empty ) headline = game.i18n.localize("CORTEX.Chat.ChooseDice");
    else if ( !validation.valid ) {
      headline = game.i18n.localize(`CORTEX.Chat.Errors.${validation.errors[0].code}`);
      listedErrors = validation.errors.slice(1); // the headline already shows the first
    } else {
      const preview = resolve(system.rolled, system.selection);
      headline = game.i18n.format("CORTEX.Chat.PreviewHeadline", {
        total: preview.total, effect: formatEffectPhrase(preview.effectDice)
      });
    }
  }

  const selection = interactive ? {
    valid: validation.valid,
    errors: listedErrors.map(e => ({ code: e.code, message: game.i18n.localize(`CORTEX.Chat.Errors.${e.code}`) })),
    extraResultsPaid: system.selection.extraResultsPaid,
    extraEffectDicePaid: system.selection.extraEffectDicePaid
  } : null;

  return { botch, dice, headline, interactive, selection };
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
 * shown already lives in message.system or comes from module/rules/'s evaluate(),
 * validateSelection() and resolve(). Does nothing for a message whose content isn't visible to
 * the current user (a blind or whispered-away roll): Foundry's own hidden-content placeholder
 * is left as it is.
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
