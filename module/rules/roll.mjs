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

/**
 * @typedef {Object} SelectionError
 * @property {string} code
 * @property {string[]} dieIds
 */

/** @param {string[]} ids @returns {string[]} ids that appear more than once in `ids` */
function duplicateIds(ids) {
  const seen = new Set();
  const dupes = new Set();
  for ( const id of ids ) {
    if ( seen.has(id) ) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

/**
 * Checks a proposed selection against rules 12-23: a hitch or an unavailable die in either id
 * list (rules 10, 19, DP-E04), the same die claimed for both total and effect (DP-20), keeping
 * fewer or more results than the keep limit allows (rule 17, RQ-001, rule 15), paying for more
 * extra results than there are dice rolled (rule 14, DP-E02), more effect dice than paid for or
 * granted (rule 21, DP-E06), and leaving an effect die slot empty while an eligible leftover die
 * remains (rule 20, rule 18, DP-E05).
 * @param {import("./types.mjs").RolledDie[]} rolled
 * @param {import("./types.mjs").Selection} selection
 * @returns {{valid: boolean, errors: SelectionError[]}}
 */
export function validateSelection(rolled, selection) {
  const byId = new Map(rolled.map(d => [d.id, d]));
  const { totalIds, effectDieIds } = selection;
  const keepLimit = selection.keepLimit ?? 2;
  const extraResultsPaid = selection.extraResultsPaid ?? 0;
  const extraEffectDicePaid = selection.extraEffectDicePaid ?? 0;

  const errors = [];
  const selectedIds = [...totalIds, ...effectDieIds];

  const hitchIds = selectedIds.filter(id => byId.get(id)?.hitch);
  if ( hitchIds.length > 0 ) errors.push({ code: "HITCH_SELECTED", dieIds: hitchIds });

  const unavailableIds = selectedIds.filter(id => byId.get(id)?.state !== "available");
  if ( unavailableIds.length > 0 ) errors.push({ code: "UNAVAILABLE_DIE", dieIds: unavailableIds });

  const reusedIds = new Set([
    ...totalIds.filter(id => effectDieIds.includes(id)),
    ...duplicateIds(totalIds),
    ...duplicateIds(effectDieIds)
  ]);
  if ( reusedIds.size > 0 ) errors.push({ code: "DIE_REUSED", dieIds: [...reusedIds] });

  const totalSlots = keepLimit + extraResultsPaid;
  if ( extraResultsPaid > 0 && totalSlots > rolled.length ) {
    errors.push({ code: "TOO_MANY_EXTRA_RESULTS", dieIds: [] });
  }

  const availableNonHitch = rolled.filter(d => !d.hitch && d.state === "available");
  const requiredKeep = Math.min(totalSlots, availableNonHitch.length);
  if ( totalIds.length < requiredKeep ) errors.push({ code: "KEEP_TOO_FEW", dieIds: totalIds });
  else if ( totalIds.length > requiredKeep ) errors.push({ code: "KEEP_TOO_MANY", dieIds: totalIds });

  const effectSlots = 1 + extraEffectDicePaid;
  if ( effectDieIds.length > effectSlots ) {
    errors.push({ code: "TOO_MANY_EFFECT_DICE", dieIds: effectDieIds });
  }

  const usedInTotal = new Set(totalIds);
  const usedAsEffect = new Set(effectDieIds);
  const leftoverEligible = rolled.filter(d => !d.hitch && d.state === "available"
    && !usedInTotal.has(d.id) && !usedAsEffect.has(d.id));
  if ( effectDieIds.length < effectSlots && leftoverEligible.length > 0 ) {
    errors.push({ code: "EFFECT_DIE_MISSING", dieIds: leftoverEligible.map(d => d.id) });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Turns an already-valid selection into a Resolution: sums the total, assigns the chosen effect
 * dice in the order given, and fills any slot left empty (nothing eligible to pick, DP-20, 21,
 * 22) with a default d4 (rule 20, rule 21, RQ-002).
 * @param {import("./types.mjs").RolledDie[]} rolled
 * @param {import("./types.mjs").Selection} selection
 * @returns {import("./types.mjs").Resolution}
 * @throws {Error} if the selection is invalid
 */
export function resolve(rolled, selection) {
  const { valid, errors } = validateSelection(rolled, selection);
  if ( !valid ) throw new Error(`resolve: invalid selection (${errors.map(e => e.code).join(", ")})`);

  const byId = new Map(rolled.map(d => [d.id, d]));
  const { totalIds, effectDieIds } = selection;
  const extraEffectDicePaid = selection.extraEffectDicePaid ?? 0;

  const total = totalIds.reduce((sum, id) => sum + byId.get(id).result, 0);

  const effectSlots = 1 + extraEffectDicePaid;
  const effectDice = Array.from({ length: effectSlots }, (_, i) => {
    const id = effectDieIds[i];
    if ( id === undefined ) return { size: 4, dieId: null, isDefault: true };
    const die = byId.get(id);
    return { size: die.size, dieId: die.id, isDefault: false };
  });

  const { hitchIds, botch } = evaluate(rolled);
  return { total, effectDice, hitchIds, botch };
}
