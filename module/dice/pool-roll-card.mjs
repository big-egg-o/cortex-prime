/**
 * The poolRoll chat card: renders message.system into HTML, nothing more (ADR-010).
 * Registered on the "renderChatMessageHTML" hook in module/cortex-prime.mjs init, which also
 * preloads the template so the hook can render synchronously (no flash of the default Roll
 * content Foundry would otherwise insert first for a message with `rolls`).
 * @module dice/pool-roll-card
 */

import { evaluate } from "../rules/index.mjs";

const TEMPLATE = "systems/cortex-prime/templates/chat/pool-roll.hbs";

// Same options renderTemplate uses (client/applications/handlebars.mjs): resolving prototype
// methods/properties is safe here since it only happens client-side.
const HANDLEBARS_OPTIONS = { allowProtoMethodsByDefault: true, allowProtoPropertiesByDefault: true };

/**
 * @typedef {Object} CardDie
 * @property {string|null} label - the die's source label, or null when it has none (a
 *   default effect die)
 * @property {number} size
 * @property {string} sizeLabel - e.g. "d8", built here so the template only interpolates
 * @property {number|null} result - null for a default effect die with no die behind it
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
 * Builds the Handlebars context for a poolRoll card from its system data alone: whether the
 * roll botched (rule 11, DP-09), dice grouped by source label, hitches kept apart, and (once
 * resolved) the total, the dice that made it, and the effect dice. `botch` comes from
 * module/rules/'s own evaluate(), not re-derived here, since a botch is already known as soon
 * as the dice are rolled, before anything is resolved.
 * @param {import("../data/chat/pool-roll.mjs").default} system
 * @returns {{botch: boolean, groups: {label: string, dice: CardDie[]}[], hitches: CardDie[],
 *   resolved: object|null}}
 */
export function preparePoolRollCardContext(system) {
  const { botch } = evaluate(system.rolled);

  const byId = new Map(system.rolled.map(die => [die.id, die]));
  const bySourceLabel = new Map();
  const hitches = [];

  for ( const die of system.rolled ) {
    const card = { label: die.source.label, size: die.size, sizeLabel: `d${die.size}`, result: die.result };
    if ( die.hitch ) {
      hitches.push(card);
      continue;
    }
    if ( !bySourceLabel.has(die.source.label) ) bySourceLabel.set(die.source.label, []);
    bySourceLabel.get(die.source.label).push(card);
  }
  const groups = Array.from(bySourceLabel, ([label, dice]) => ({ label, dice }));

  let resolved = null;
  if ( !botch && system.resolution ) {
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

  return { botch, groups, hitches, resolved };
}

/**
 * Renders the card body HTML for a poolRoll message's system data. Used by the hook's async
 * fallback and directly by the Quench batch; the hook itself prefers the synchronous path.
 * @param {import("../data/chat/pool-roll.mjs").default} system
 * @returns {Promise<string>}
 */
export async function renderPoolRollCard(system) {
  return foundry.applications.handlebars.renderTemplate(TEMPLATE, preparePoolRollCardContext(system));
}

/**
 * Replaces the message body of poolRoll messages with the rendered card. No game logic here:
 * every value shown already lives in message.system or comes from module/rules/'s evaluate().
 * Does nothing for a message whose content isn't visible to the current user (a blind or
 * whispered-away roll): Foundry's own hidden-content placeholder is left as it is.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export function onRenderPoolRollMessage(message, html) {
  if ( message.type !== "poolRoll" ) return;
  if ( !message.isContentVisible ) return;
  const content = html.querySelector(".message-content");
  if ( !content ) return;

  const compiled = Handlebars.partials[TEMPLATE];
  if ( typeof compiled === "function" ) {
    content.innerHTML = compiled(preparePoolRollCardContext(message.system), HANDLEBARS_OPTIONS);
    return;
  }

  // Fallback for the rare case the template hasn't finished preloading yet: async, so this
  // path alone can still show a brief flash of the default Roll content.
  renderPoolRollCard(message.system).then(rendered => { content.innerHTML = rendered; });
}
