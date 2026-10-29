/**
 * Rolling a pool: pairing results with dice, hitches and botches (Dice & Pools spec).
 * @module rules/roll
 */

import { stepDie } from "./dice.mjs";
import { codedError } from "./errors.mjs";

/**
 * Error code: an effect die can't change while an overflow choice is pending (DP-E07, ADR-026).
 * A technical guard, not a rule.
 */
export const OVERFLOW_PENDING = "OVERFLOW_PENDING";

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

/** @param {number} n @returns {string} the effect id for number `n` (ADR-026) */
function effectIdFor(n) {
  return `e${n}`;
}

/**
 * Turns an already-valid selection into a Resolution: sums the total, assigns the chosen effect
 * dice in the order given, and fills any slot left empty (nothing eligible to pick, DP-20, 21,
 * 22) with a default d4 (rule 20, rule 21, RQ-002). The effect dice get the ids e1, e2, ... in
 * that order (ADR-026).
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
    const id = effectIdFor(i + 1);
    const dieId = effectDieIds[i];
    if ( dieId === undefined ) return { id, kind: "default", size: 4, dieId: null, isDefault: true };
    const die = byId.get(dieId);
    return { id, kind: "rolled", size: die.size, dieId: die.id, isDefault: false };
  });

  const { hitchIds, botch } = evaluate(rolled);
  return {
    total, totalIds: [...totalIds], effectDice, consumedDieIds: [], nextEffectNumber: effectSlots + 1,
    hitchIds, botch, takeOut: false, overflow: null
  };
}

/**
 * Every eligible leftover die for a second effect die: not a hitch, available, not in the
 * total, not already an effect die, and not used up by an effect die that was removed, in roll
 * order (rule 18, rule 19, rule 23, RQ-003, RQ-007, DP-24c).
 * @param {import("./types.mjs").RolledDie[]} rolled
 * @param {import("./types.mjs").Resolution} resolution
 * @returns {{dieId: string, size: import("./types.mjs").DieSize}[]}
 */
export function leftoverEligible(rolled, resolution) {
  const used = new Set([
    ...resolution.totalIds,
    ...resolution.effectDice.map(e => e.dieId).filter(id => id !== null),
    ...resolution.consumedDieIds
  ]);
  return rolled
    .filter(d => !d.hitch && d.state === "available" && !used.has(d.id))
    .map(d => ({ dieId: d.id, size: d.size }));
}

/**
 * Steps one effect die up or down (rule 23). A d4 stepped down is removed from effectDice, no
 * d4 default takes its place, and the rolled die it came from (if any) goes into
 * consumedDieIds so it is never offered again (rule 23, RQ-009, DP-24b, DP-24c). The other
 * entries keep their ids (ADR-026). A step that would take it past d12 makes no size change;
 * instead it records a pending overflow with the options for the roller to pick from (rule
 * 22): every eligible leftover die, a new d6, or a take-out, resolved by applyOverflowChoice.
 * `cause` only affects labelling (RQ-005) — the options are identical for a heroic success and
 * for an SFX or other trigger. While an overflow choice is pending, every step is refused so
 * the pending choice is never dropped (DP-E07); applyOverflowChoice clears it.
 * @param {import("./types.mjs").RolledDie[]} rolled
 * @param {import("./types.mjs").Resolution} resolution
 * @param {string} effectId - the id of the entry in resolution.effectDice (ADR-026)
 * @param {number} steps
 * @param {'heroic'|'other'} cause
 * @returns {import("./types.mjs").Resolution} a new Resolution
 * @throws {Error} code OVERFLOW_PENDING while an overflow choice is pending; a plain Error if no
 *   effect die has the id `effectId`
 */
export function stepEffectDie(rolled, resolution, effectId, steps, cause) {
  if ( resolution.overflow ) {
    throw codedError(OVERFLOW_PENDING, "stepEffectDie: an overflow choice is still pending");
  }
  const entry = resolution.effectDice.find(e => e.id === effectId);
  if ( !entry ) throw new Error(`stepEffectDie: no effect die with id "${effectId}"`);
  const result = stepDie(entry.size, steps);

  if ( result.beyond ) {
    const options = {
      cause,
      leftovers: leftoverEligible(rolled, resolution),
      newDie: 6,
      takeOutAvailable: true
    };
    return { ...resolution, overflow: { effectId, cause, options } };
  }

  if ( result.removed ) {
    const effectDice = resolution.effectDice.filter(e => e !== entry);
    const consumedDieIds = entry.dieId === null
      ? resolution.consumedDieIds
      : [...resolution.consumedDieIds, entry.dieId];
    return { ...resolution, effectDice, consumedDieIds, overflow: null };
  }

  const effectDice = resolution.effectDice.map(e => (e === entry ? { ...e, size: result.size } : e));
  return { ...resolution, effectDice, overflow: null };
}

/**
 * Applies one of the options from a pending overflow (rule 22): adds the chosen leftover die
 * or a new d6 as a second effect die, or marks the take-out/victory outcome. Clears the
 * overflow once resolved. A new entry gets the id `e<nextEffectNumber>` (ADR-026).
 * @param {import("./types.mjs").RolledDie[]} rolled
 * @param {import("./types.mjs").Resolution} resolution
 * @param {import("./types.mjs").OverflowChoice} choice
 * @returns {import("./types.mjs").Resolution} a new Resolution
 * @throws {Error} if there is no pending overflow, the choice is unknown, or `dieId` isn't one
 *   of the offered leftovers
 */
export function applyOverflowChoice(rolled, resolution, choice) {
  const overflow = resolution.overflow;
  if ( !overflow ) throw new Error("applyOverflowChoice: no pending overflow to resolve");

  if ( choice.kind === "take-out" ) return { ...resolution, overflow: null, takeOut: true };

  const id = effectIdFor(resolution.nextEffectNumber);
  const nextEffectNumber = resolution.nextEffectNumber + 1;

  if ( choice.kind === "new-d6" ) {
    const added = { id, kind: "overflow", size: 6, dieId: null, isDefault: true };
    return { ...resolution, effectDice: [...resolution.effectDice, added], nextEffectNumber, overflow: null };
  }

  if ( choice.kind === "leftover" ) {
    const picked = overflow.options.leftovers.find(l => l.dieId === choice.dieId);
    if ( !picked ) throw new Error(`applyOverflowChoice: "${choice.dieId}" is not an eligible leftover`);
    const added = { id, kind: "rolled", size: picked.size, dieId: picked.dieId, isDefault: false };
    return { ...resolution, effectDice: [...resolution.effectDice, added], nextEffectNumber, overflow: null };
  }

  throw new Error(`applyOverflowChoice: unknown choice kind "${choice.kind}"`);
}

/**
 * The GM's shortcut: the `keep` highest non-hitch results, for the total (rule 12).
 * @param {import("./types.mjs").RolledDie[]} rolled
 * @param {number} [keep=2]
 * @returns {string[]} die ids, highest result first
 */
export function twoHighest(rolled, keep = 2) {
  return rolled
    .filter(d => !d.hitch && d.state === "available")
    .slice()
    .sort((a, b) => b.result - a.result)
    .slice(0, keep)
    .map(d => d.id);
}

/**
 * Suggests the largest available, non-hitch, unused rolled die as an effect die (rule 18).
 * It knows nothing of a Resolution: a caller working after Confirm must include the
 * Resolution's consumedDieIds in `usedIds`, since those dice stay used up (rule 23, DP-24c).
 * @param {import("./types.mjs").RolledDie[]} rolled
 * @param {string[]} usedIds - dice already in the total, chosen as effect dice, or used up
 * @returns {string|null} a die id, or null if none is eligible (rule 20 default applies)
 */
export function largestEligible(rolled, usedIds) {
  const used = new Set(usedIds);
  const eligible = rolled.filter(d => !d.hitch && d.state === "available" && !used.has(d.id));
  if ( eligible.length === 0 ) return null;
  return eligible.reduce((biggest, d) => (d.size > biggest.size ? d : biggest)).id;
}

/**
 * The suggested selection (Decisions ADR-019): the highest results for the total, as many as
 * the keep limit plus paid extra results allow (rule 12, rule 14, rule 17), then the largest
 * eligible leftover for each effect slot, 1 plus paid extra effect dice (rule 18, rule 21).
 * Filling the total first means it never keeps fewer results than RQ-001 requires; an effect
 * slot with nothing left stays empty, for resolve() to default to a d4 (rule 20). A botch
 * gets no suggestion, since nothing is eligible. Meant for before Confirm: it doesn't see a
 * Resolution's consumedDieIds, so a caller after Confirm uses largestEligible with those ids
 * in `usedIds` instead (rule 23, DP-24c).
 * @param {import("./types.mjs").RolledDie[]} rolled
 * @param {import("./types.mjs").Selection} selection - read for keepLimit and the paid counters
 * @returns {{totalIds: string[], effectDieIds: string[]}}
 */
export function suggestSelection(rolled, selection) {
  const keepLimit = selection.keepLimit ?? 2;
  const totalIds = twoHighest(rolled, keepLimit + (selection.extraResultsPaid ?? 0));
  const effectSlots = 1 + (selection.extraEffectDicePaid ?? 0);
  const effectDieIds = [];
  for ( let i = 0; i < effectSlots; i++ ) {
    const next = largestEligible(rolled, [...totalIds, ...effectDieIds]);
    if ( next === null ) break;
    effectDieIds.push(next);
  }
  return { totalIds, effectDieIds };
}

/**
 * The largest die in an unrolled pool, for an unopposed effect die (rule 24).
 * @param {import("./types.mjs").PoolDie[]} pool
 * @returns {import("./types.mjs").DieSize}
 */
export function unrolledEffectDie(pool) {
  return pool.reduce((biggest, d) => Math.max(biggest, d.size), 0);
}

/**
 * Which rolled dice may be rerolled: any die not already hitch-activated (rule 26).
 * @param {import("./types.mjs").RolledDie[]} rolled
 * @returns {string[]}
 */
export function rerollableIds(rolled) {
  return rolled.filter(d => d.state !== "hitch-activated").map(d => d.id);
}

/**
 * Replaces results for the given dice and recomputes their hitch flags (rule 25). Refuses a
 * die that isn't rerollable (rule 26, DP-28), an id not in the roll, or a result outside 1 to
 * the die's size (rule 1).
 * @param {import("./types.mjs").RolledDie[]} rolled
 * @param {Record<string, number>} results - die id -> new result
 * @returns {import("./types.mjs").RolledDie[]}
 * @throws {Error} on an unknown id, a non-rerollable die, or an out-of-range result
 */
export function applyRerolls(rolled, results) {
  const byId = new Map(rolled.map(d => [d.id, d]));
  const rerollable = new Set(rerollableIds(rolled));

  for ( const id of Object.keys(results) ) {
    const die = byId.get(id);
    if ( !die ) throw new Error(`applyRerolls: no die with id ${id}`);
    if ( !rerollable.has(id) ) throw new Error(`applyRerolls: ${id} can't be rerolled`);
    const result = results[id];
    if ( !Number.isInteger(result) || result < 1 || result > die.size ) {
      throw new Error(`applyRerolls: ${result} is not a valid result for a d${die.size}`);
    }
  }

  return rolled.map(d => {
    if ( !(d.id in results) ) return d;
    const result = results[d.id];
    return { ...d, result, hitch: result === 1 };
  });
}
