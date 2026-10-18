/**
 * The poolRoll chat card: renders message.system into HTML, and (for the message's owner and
 * the GM, ADR-013) makes it interactive. Registered on the "renderChatMessageHTML" hook in
 * module/cortex-prime.mjs init, which also preloads the template so the hook can render
 * synchronously (no flash of the default Roll content Foundry would otherwise insert first
 * for a message with `rolls`).
 * @module dice/pool-roll-card
 */

import { evaluate, rerollableIds, resolve, validateSelection } from "../rules/index.mjs";
import { applyCardChange, canEditPoolRollCard } from "./card-actions.mjs";

const TEMPLATE = "systems/cortex-prime/templates/chat/pool-roll.hbs";

// Same options renderTemplate uses (client/applications/handlebars.mjs): resolving prototype
// methods/properties is safe here since it only happens client-side.
const HANDLEBARS_OPTIONS = { allowProtoMethodsByDefault: true, allowProtoPropertiesByDefault: true };

/**
 * Whether a card is in reroll-marking mode, and which dice are marked (Decisions ADR-017):
 * purely local to this browser tab, never written to the message, so it's kept here rather
 * than in message.system. Keyed by message id; cleared entirely once a reroll is attempted.
 * @type {Map<string, {active: boolean, marked: Set<string>}>}
 */
const rerollUiState = new Map();

/** @param {string} messageId @returns {{active: boolean, marked: Set<string>}} */
function getRerollState(messageId) {
  return rerollUiState.get(messageId) ?? { active: false, marked: new Set() };
}

/** Localization keys for each die role, shown as a title/aria-label on the die. */
const ROLE_LABEL_KEYS = {
  total: "CORTEX.Chat.Role.Total",
  effect: "CORTEX.Chat.Role.Effect",
  hitch: "CORTEX.Chat.Role.Hitch",
  unused: "CORTEX.Chat.Role.Unused"
};

/**
 * Each role drawn with core's result classes where one fits (ADR-019): a hitch is a 1, so it
 * gets core's `min` look; an unused die gets the `discarded` look. Total and effect have no
 * core equivalent.
 */
const ROLE_CSS = { hitch: "min", unused: "discarded", total: "cp-total", effect: "cp-effect" };

/**
 * @typedef {Object} CardDie
 * @property {string} id
 * @property {string} label - the die's source label (escaped by the template)
 * @property {number} size
 * @property {number} result
 * @property {'total'|'effect'|'unused'|'hitch'} role
 * @property {string} roleLabel - localized, for the die's tooltip/aria-label
 * @property {string} cssClass - role, clickable and marked classes for the core `li.roll`
 * @property {boolean} clickable
 * @property {'cycle-die'|'toggle-reroll-mark'} action
 * @property {boolean} marked - marked for reroll (only meaningful in reroll mode)
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
 * @returns {{botch: boolean, dice: CardDie[], formula: string, headline: string,
 *   preview: boolean, interactive: boolean,
 *   selection: {valid: boolean, errors: {code: string, message: string}[],
 *     extraResultsPaid: number, extraEffectDicePaid: number}|null,
 *   effectControls: {index: number, size: number, canStepDown: boolean}[]|null,
 *   overflowChoice: {leftovers: {dieId: string, label: string}[], newDieLabel: string,
 *     takeOutAvailable: boolean, takeOutLabel: string}|null,
 *   reroll: {active: boolean, canReroll: boolean}|null}}
 */
export function preparePoolRollCardContext(message) {
  const system = message.system;
  const { botch } = evaluate(system.rolled);
  const resolvedState = system.state === "resolved";
  const canEdit = canEditPoolRollCard(message);
  const interactive = !resolvedState && canEdit;

  // Roles come from the confirmed Resolution once resolved, otherwise the live selection.
  const totalIds = resolvedState ? system.resolution.totalIds : system.selection.totalIds;
  const effectDieIds = resolvedState
    ? system.resolution.effectDice.map(e => e.dieId).filter(id => id !== null)
    : system.selection.effectDieIds;

  // Reroll-marking mode (ADR-017) changes what a die click means and which dice can be
  // clicked at all, so it overrides the normal cycle-die clickability below.
  const rerollState = interactive ? getRerollState(message.id) : null;
  const rerollableSet = rerollState?.active ? new Set(rerollableIds(system.rolled)) : null;

  const dice = system.rolled.map(die => {
    const role = die.hitch ? "hitch"
      : totalIds.includes(die.id) ? "total"
        : effectDieIds.includes(die.id) ? "effect" : "unused";
    const clickable = rerollableSet
      ? rerollableSet.has(die.id)
      : interactive && !die.hitch && (die.state === "available");
    const marked = Boolean(rerollState?.active && rerollState.marked.has(die.id));
    return {
      id: die.id, label: die.source.label, size: die.size, result: die.result, role,
      roleLabel: game.i18n.localize(ROLE_LABEL_KEYS[role]),
      cssClass: [ROLE_CSS[role], clickable ? "cp-clickable" : null, marked ? "cp-marked" : null].filterJoin(" "),
      clickable, action: rerollableSet ? "toggle-reroll-mark" : "cycle-die", marked
    };
  });
  const formula = system.rolled.map(d => `d${d.size}`).join(" ");

  const validation = interactive ? validateSelection(system.rolled, system.selection) : null;

  let headline;
  let preview = false;
  let listedErrors = validation?.errors ?? [];
  if ( botch ) {
    headline = game.i18n.localize("CORTEX.Chat.Botch");
  } else if ( resolvedState ) {
    if ( system.resolution.takeOut ) headline = game.i18n.localize("CORTEX.Chat.TakeOutVictory");
    else if ( system.resolution.overflow ) headline = game.i18n.localize("CORTEX.Chat.OverflowPending");
    else {
      headline = game.i18n.format("CORTEX.Chat.ResolvedHeadline", {
        total: system.resolution.total, effect: formatEffectPhrase(system.resolution.effectDice)
      });
    }
  } else if ( !interactive ) {
    headline = game.i18n.localize("CORTEX.Chat.Choosing");
  } else {
    const empty = (system.selection.totalIds.length === 0) && (system.selection.effectDieIds.length === 0);
    if ( empty ) headline = game.i18n.localize("CORTEX.Chat.ChooseDice");
    else if ( !validation.valid ) {
      headline = game.i18n.localize(`CORTEX.Chat.Errors.${validation.errors[0].code}`);
      listedErrors = validation.errors.slice(1); // the headline already shows the first
    } else {
      const previewResolution = resolve(system.rolled, system.selection);
      headline = game.i18n.format("CORTEX.Chat.ResolvedHeadline", {
        total: previewResolution.total, effect: formatEffectPhrase(previewResolution.effectDice)
      });
      preview = true;
    }
  }

  const selection = interactive ? {
    valid: validation.valid,
    errors: listedErrors.map(e => ({ code: e.code, message: game.i18n.localize(`CORTEX.Chat.Errors.${e.code}`) })),
    extraResultsPaid: system.selection.extraResultsPaid,
    extraEffectDicePaid: system.selection.extraEffectDicePaid
  } : null;

  // Controls for stepping an effect die or resolving a pending overflow (rule 22, rule 23):
  // resolved cards only, and only one of the two panels at a time, since the data model has
  // a single overflow slot for the whole Resolution, not one per die.
  let effectControls = null;
  let overflowChoice = null;
  if ( resolvedState && canEdit && !botch && !system.resolution.takeOut ) {
    const overflow = system.resolution.overflow;
    if ( overflow ) {
      overflowChoice = {
        leftovers: overflow.options.leftovers.map(l => ({
          dieId: l.dieId, label: game.i18n.format("CORTEX.Chat.OverflowLeftover", { size: l.size })
        })),
        newDieLabel: game.i18n.format("CORTEX.Chat.OverflowNewDie", { size: overflow.options.newDie }),
        takeOutAvailable: overflow.options.takeOutAvailable,
        takeOutLabel: game.i18n.localize("CORTEX.Chat.TakeOutVictory")
      };
    } else {
      effectControls = system.resolution.effectDice.map((entry, index) => (
        { index, size: entry.size, canStepDown: entry.size > 4 }
      ));
    }
  }

  // Reroll controls (rule 25-26, ADR-017): available any time the card is interactive,
  // unlike effectControls/overflowChoice — a botch can be rerolled too (DP-29).
  const reroll = interactive
    ? { active: Boolean(rerollState.active), canReroll: rerollState.marked.size > 0 }
    : null;

  return {
    botch, dice, formula, headline, preview, interactive, selection, effectControls, overflowChoice, reroll
  };
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
 * Re-renders a card's content in place from message.system and the local reroll-ui state,
 * without touching the message itself. Used for the two reroll-mode interactions that are
 * purely local (ADR-017: toggling the mode, marking/unmarking a die) — the listener stays
 * attached to `content` itself, so replacing only its children doesn't lose it.
 * @param {ChatMessage} message
 * @param {HTMLElement} content
 */
function rerenderCardContent(message, content) {
  const compiled = Handlebars.partials[TEMPLATE];
  if ( typeof compiled === "function" ) {
    content.innerHTML = compiled(preparePoolRollCardContext(message), HANDLEBARS_OPTIONS);
  } else {
    renderPoolRollCard(message).then(rendered => { content.innerHTML = rendered; });
  }
}

/**
 * Attaches one delegated click listener to a rendered card's content element. Two actions are
 * purely local reroll-ui state (ADR-017) and never reach module/dice/card-actions.mjs:
 * toggling reroll mode and marking/unmarking a die, each followed by an in-place re-render.
 * Everything else — including "reroll" itself, once the marked ids are gathered — is
 * forwarded verbatim (the clicked element's whole dataset) to applyCardChange(). Catches a
 * thrown refusal (currently only EFFECT_DIE_D4_STEP_DOWN, RQ-009) so it reaches the roller as
 * a notification rather than an unhandled rejection; every other refusal is already silent by
 * design (card-actions.mjs).
 * @param {ChatMessage} message
 * @param {HTMLElement} content
 */
function activatePoolRollCardListeners(message, content) {
  content.addEventListener("click", event => {
    const target = event.target.closest("[data-action]");
    if ( !target ) return;
    const { action, ...rest } = target.dataset;

    if ( action === "toggle-reroll-mode" ) {
      const state = getRerollState(message.id);
      state.active = !state.active;
      state.marked.clear();
      rerollUiState.set(message.id, state);
      return rerenderCardContent(message, content);
    }

    if ( action === "toggle-reroll-mark" ) {
      const state = getRerollState(message.id);
      if ( state.marked.has(rest.dieId) ) state.marked.delete(rest.dieId); else state.marked.add(rest.dieId);
      rerollUiState.set(message.id, state);
      return rerenderCardContent(message, content);
    }

    if ( action === "reroll" ) {
      const dieIds = [...getRerollState(message.id).marked];
      rerollUiState.delete(message.id); // leaving reroll mode clears the marks (ADR-017)
      rerenderCardContent(message, content);
      return applyCardChange(message, { action, dieIds })
        .catch(err => ui.notifications.error(game.i18n.localize(`CORTEX.Chat.Errors.${err.message}`)));
    }

    return applyCardChange(message, { action, ...rest })
      .catch(err => ui.notifications.error(game.i18n.localize(`CORTEX.Chat.Errors.${err.message}`)));
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

  // interactive covers the pre-confirm controls; a resolved card's step/overflow controls are
  // gated the same way (canEditPoolRollCard) but live in effectControls/overflowChoice instead,
  // since interactive itself is specifically "not yet resolved" (used for die clickability too).
  const hasControls = context.interactive || context.effectControls || context.overflowChoice;

  const compiled = Handlebars.partials[TEMPLATE];
  if ( typeof compiled === "function" ) {
    content.innerHTML = compiled(context, HANDLEBARS_OPTIONS);
    if ( hasControls ) activatePoolRollCardListeners(message, content);
    return;
  }

  // Fallback for the rare case the template hasn't finished preloading yet: async, so this
  // path alone can still show a brief flash of the default Roll content.
  renderPoolRollCard(message).then(rendered => {
    content.innerHTML = rendered;
    if ( hasControls ) activatePoolRollCardListeners(message, content);
  });
}
