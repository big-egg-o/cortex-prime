/**
 * Building, doubling and stepping dice pools (Dice & Pools spec).
 * @module rules/pool
 */

import { stepDie } from "./dice.mjs";

let nextId = 0;

/** @returns {string} a fresh id, unique within this process */
function makeId() {
  nextId += 1;
  return `d${nextId}`;
}

/**
 * Assembles rated sources into a flat, id-tagged pool. Each die of a multi-die rating
 * (`count`) becomes its own PoolDie with the same source (rule 6); every die gets its own id
 * even when size and source are shared (DP-E03). Defaults origin to "rating" — pass "bonus"
 * for a die that isn't a source's own rating (e.g. a flat SFX bonus die).
 * @param {Array<{size: import("./types.mjs").DieSize, source: import("./types.mjs").DieSource,
 *   count?: number, origin?: 'rating'|'bonus'}>} entries
 * @returns {import("./types.mjs").PoolDie[]}
 */
export function buildPool(entries) {
  const pool = [];
  for ( const entry of entries ) {
    const count = entry.count ?? 1;
    for ( let i = 0; i < count; i++ ) {
      pool.push({
        id: makeId(),
        size: entry.size,
        source: entry.source,
        origin: entry.origin ?? "rating"
      });
    }
  }
  return pool;
}

/**
 * Adds one more die of the same size and source right after the original, origin "doubled"
 * (rule 7).
 * @param {import("./types.mjs").PoolDie[]} pool
 * @param {string} id
 * @returns {import("./types.mjs").PoolDie[]} a new pool
 */
export function doubleDie(pool, id) {
  const index = pool.findIndex(d => d.id === id);
  if ( index === -1 ) throw new Error(`doubleDie: no die with id ${id}`);
  const original = pool[index];

  const next = pool.slice();
  next.splice(index + 1, 0, {
    id: makeId(),
    size: original.size,
    source: original.source,
    origin: "doubled"
  });
  return next;
}

/**
 * Steps one pool die up or down. Stepping down a d4 removes it (rule 3). A step that would
 * push the die past d12 instead leaves it at d12 and adds a new d6 right after it, origin
 * "overflow", carrying the stepped die's source (rule 4, RQ-004); several steps past d12 add
 * one d6 per step (RQ-008). Never writes to `pool`, its dice, or any source object: the
 * asset/trait a pool die points at is read, never changed (RQ-004, DP-04c).
 * @param {import("./types.mjs").PoolDie[]} pool
 * @param {string} id
 * @param {number} steps
 * @returns {import("./types.mjs").PoolDie[]} a new pool
 */
export function stepPoolDie(pool, id, steps) {
  const index = pool.findIndex(d => d.id === id);
  if ( index === -1 ) throw new Error(`stepPoolDie: no die with id ${id}`);
  const die = pool[index];
  const result = stepDie(die.size, steps);

  const next = pool.slice();

  if ( result.removed ) {
    next.splice(index, 1);
    return next;
  }

  next[index] = { ...die, size: result.size };

  if ( result.beyond ) {
    const overflow = Array.from({ length: result.beyond }, () => ({
      id: makeId(),
      size: /** @type {import("./types.mjs").DieSize} */ (6),
      source: die.source,
      origin: "overflow"
    }));
    next.splice(index + 1, 0, ...overflow);
  }

  return next;
}
