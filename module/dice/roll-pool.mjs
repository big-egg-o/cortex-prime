/**
 * Rolls a dice pool with Foundry's own dice (Decisions ADR-009, ADR-011): the rules engine
 * never generates random numbers, so this adapter rolls and hands the results to
 * module/rules/ to turn into a RolledDie list.
 * @module dice/roll-pool
 */

import { applyResults } from "../rules/index.mjs";

/**
 * Builds one Roll with one `1dN` term per pool die, in pool order, evaluates it, and turns
 * the results into a RolledDie list via the rules engine. One term per die (rather than one
 * `NdN` term per size) keeps each result mapped to its own PoolDie and lets Dice So Nice
 * animate every die (ADR-009 point 2).
 * @param {import("../rules/types.mjs").PoolDie[]} pool
 * @returns {Promise<{roll: Roll, rolled: import("../rules/types.mjs").RolledDie[]}>}
 * @throws {Error} on an empty pool (DP-E01): there is nothing to roll
 */
export async function rollPool(pool) {
  if ( pool.length === 0 ) throw new Error("rollPool: cannot roll an empty pool (DP-E01)");

  const formula = pool.map(die => `1d${die.size}`).join(" + ");
  const roll = new Roll(formula);
  await roll.evaluate();

  // The Roll's own total sums every die and has no meaning in Cortex: never use roll.total.
  const results = pool.map((_die, i) => roll.dice[i].results[0].result);
  const rolled = applyResults(pool, results);
  return { roll, rolled };
}

/**
 * Rolls just the given dice again with Foundry's own dice (Decisions ADR-009, ADR-017): one
 * `1dN` term per die, in the order of `dieIds`, each term's size taken from the matching
 * RolledDie — not the engine's business, so this stays outside module/rules/.
 * @param {import("../rules/types.mjs").RolledDie[]} rolled
 * @param {string[]} dieIds
 * @returns {Promise<{roll: Roll, results: Record<string, number>}>}
 */
export async function rerollDice(rolled, dieIds) {
  const byId = new Map(rolled.map(d => [d.id, d]));
  const formula = dieIds.map(id => `1d${byId.get(id).size}`).join(" + ");
  const roll = new Roll(formula);
  await roll.evaluate();

  const results = {};
  dieIds.forEach((id, i) => { results[id] = roll.dice[i].results[0].result; });
  return { roll, results };
}
