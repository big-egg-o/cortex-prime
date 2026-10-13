/**
 * Rolling a pool: pairing results with dice, hitches and botches (Dice & Pools spec).
 * @module rules/roll
 */

/**
 * Pairs each pool die with its rolled result, in pool order, and flags hitches (a result of 1,
 * rule 10). Refuses an empty pool (no handbook rule covers a zero-die roll; a technical guard,
 * not a rule), a results list of the wrong length (ADR-009 point 3), and any result that isn't
 * a whole number from 1 to the die's size (rule 1, DP-12).
 * @param {import("./types.mjs").PoolDie[]} pool
 * @param {number[]} results - one result per pool die, in pool order
 * @returns {import("./types.mjs").RolledDie[]}
 * @throws {Error} on an empty pool, a mismatched results length, or an out-of-range result
 */
export function applyResults(pool, results) {
  if ( pool.length === 0 ) throw new Error("applyResults: cannot roll an empty pool");
  if ( results.length !== pool.length ) {
    throw new Error(`applyResults: expected ${pool.length} results, got ${results.length}`);
  }

  return pool.map((die, i) => {
    const result = results[i];
    if ( !Number.isInteger(result) || result < 1 || result > die.size ) {
      throw new Error(`applyResults: ${result} is not a valid result for a d${die.size}`);
    }
    return { ...die, result, hitch: result === 1, state: "available" };
  });
}

/**
 * Reports which rolled dice are hitches and whether every die is a hitch (rule 11).
 * @param {import("./types.mjs").RolledDie[]} rolled
 * @returns {{hitchIds: string[], botch: boolean}}
 */
export function evaluate(rolled) {
  const hitchIds = rolled.filter(d => d.hitch).map(d => d.id);
  const botch = rolled.length > 0 && hitchIds.length === rolled.length;
  return { hitchIds, botch };
}
