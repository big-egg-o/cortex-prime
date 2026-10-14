/**
 * The poolRoll chat card: renders message.system into HTML, nothing more (ADR-010).
 * Registered on the "renderChatMessageHTML" hook in module/cortex-prime.mjs init.
 * @module dice/pool-roll-card
 */

const TEMPLATE = "systems/cortex-prime/templates/chat/pool-roll.hbs";

/**
 * @typedef {Object} CardDie
 * @property {string|null} label - the die's source label, or null when it has none (a
 *   default effect die)
 * @property {number} size
 * @property {string} sizeLabel - e.g. "d8", built here so the template only interpolates
 * @property {number|null} result - null for a default effect die with no die behind it
 */

/**
 * Builds the Handlebars context for a poolRoll card from its system data alone: dice grouped
 * by source label, hitches kept apart, and (once resolved) the total, the dice that made it,
 * and the effect dice.
 * @param {import("../data/chat/pool-roll.mjs").default} system
 * @returns {{groups: {label: string, dice: CardDie[]}[], hitches: CardDie[], resolved: object|null}}
 */
export function preparePoolRollCardContext(system) {
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
  if ( system.resolution ) {
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

  return { groups, hitches, resolved };
}

/**
 * Renders the card body HTML for a poolRoll message's system data.
 * @param {import("../data/chat/pool-roll.mjs").default} system
 * @returns {Promise<string>}
 */
export async function renderPoolRollCard(system) {
  return foundry.applications.handlebars.renderTemplate(TEMPLATE, preparePoolRollCardContext(system));
}

/**
 * Replaces the message body of poolRoll messages with the rendered card. No game logic here:
 * every value shown already lives in message.system (module/rules/ decided it earlier).
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export async function onRenderPoolRollMessage(message, html) {
  if ( message.type !== "poolRoll" ) return;
  const content = html.querySelector(".message-content");
  if ( !content ) return;
  content.innerHTML = await renderPoolRollCard(message.system);
}
