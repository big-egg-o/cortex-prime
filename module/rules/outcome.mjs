/**
 * Difficulty dice, beating a total, heroic success and test outcomes (Tests & Contests spec).
 * Every function here returns an EngineResult instead of throwing (Decisions ADR-025).
 * @module rules/outcome
 */

import { fail, ok } from "./result.mjs";
import { OVERFLOW_PENDING, stepEffectDie } from "./roll.mjs";

/** Size of the two difficulty dice for each level, easiest first (rule 5; Handbook p. 18). */
const DIFFICULTY_DIE_SIZES = new Map([
  ["veryEasy", 4], ["easy", 6], ["challenging", 8], ["hard", 10], ["veryHard", 12]
]);

/**
 * The difficulty levels, easiest first (rule 5). Their labels live in lang/en.json.
 * @type {readonly import("./types.mjs").DifficultyLevel[]}
 */
export const DIFFICULTY_LEVELS = Object.freeze([...DIFFICULTY_DIE_SIZES.keys()]);

/**
 * Whether `value` can be a total or a difficulty: a whole number of 0 or more (a botch totals
 * 0, rule 9). A technical guard, not a rule (TC-E04).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidTotal(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * The pair of difficulty dice for a level (rule 5, TC-01).
 * @param {import("./types.mjs").DifficultyLevel} level
 * @returns {import("./types.mjs").EngineResult<[import("./types.mjs").DieSize, import("./types.mjs").DieSize]>}
 *   UNKNOWN_DIFFICULTY_LEVEL for anything but the five levels
 */
export function difficultyDice(level) {
  const size = DIFFICULTY_DIE_SIZES.get(level);
  if ( size === undefined ) return fail("UNKNOWN_DIFFICULTY_LEVEL");
  return ok([size, size]);
}

/**
 * The difficulty dice as two buildPool entries carrying `source`, to start an opposition pool
 * that the GM then adds trait and risk dice to (rule 4, TC-02).
 * @param {import("./types.mjs").DifficultyLevel} level
 * @param {import("./types.mjs").DieSource} source
 * @returns {import("./types.mjs").EngineResult<{size: import("./types.mjs").DieSize,
 *   source: import("./types.mjs").DieSource}[]>} UNKNOWN_DIFFICULTY_LEVEL as in difficultyDice
 */
export function difficultyEntry(level, source) {
  const dice = difficultyDice(level);
  if ( !dice.ok ) return dice;
  return ok(dice.value.map(size => ({ size, source })));
}

/**
 * Whether `total` beats `difficulty`: it has to be strictly higher, so a tie doesn't (rule 8).
 * A botch totals 0 and never beats anything (rule 9).
 * @param {number} total
 * @param {number} difficulty
 * @returns {import("./types.mjs").EngineResult<boolean>} INVALID_TOTAL unless both are whole
 *   numbers of 0 or more (TC-E04)
 */
export function beats(total, difficulty) {
  if ( !isValidTotal(total) || !isValidTotal(difficulty) ) return fail("INVALID_TOTAL");
  return ok(total > difficulty);
}

/**
 * Heroic steps for a margin: one for every full 5 points from 5 up, none below 5 (rules 10-11).
 * A margin may be negative (a failure). It is the difference of two totals, so one that isn't a
 * whole number is refused as a bad total.
 * @param {number} margin
 * @returns {import("./types.mjs").EngineResult<number>} INVALID_TOTAL for a margin that isn't a
 *   whole number
 */
export function heroicSteps(margin) {
  if ( !Number.isInteger(margin) ) return fail("INVALID_TOTAL");
  return ok(margin >= 5 ? Math.floor(margin / 5) : 0);
}

/**
 * The outcome of a test: a success when the total beats the difficulty (rule 8), with the
 * margin taken as total minus difficulty (negative on a failure) and its heroic steps (rules
 * 10-11). The same comparison serves when the roles swap and a player's roll sets the
 * difficulty for a GMC (rule 7).
 * @param {{total: number, difficulty: number}} test
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").TestOutcome>} INVALID_TOTAL
 *   as in beats
 */
export function resolveTest({ total, difficulty } = {}) {
  const success = beats(total, difficulty);
  if ( !success.ok ) return success;
  const margin = total - difficulty;
  const steps = heroicSteps(margin).value;
  return ok({ success: success.value, margin, heroic: steps > 0, heroicSteps: steps });
}

/**
 * Puts all of a success's heroic steps on the one effect die the roller picks (rules 11-12,
 * RQ-011 a, ADR-023), through stepEffectDie with the cause "heroic": a step past d12 leaves the
 * usual overflow options pending for applyOverflowChoice (Dice & Pools rule 22). `heroic` is
 * anything carrying heroicSteps and heroicAppliedTo, such as a TestOutcome (where a missing
 * heroicAppliedTo means not applied yet) or a ContestState.
 * @param {import("./types.mjs").RolledDie[]} rolled
 * @param {import("./types.mjs").Resolution} resolution
 * @param {import("./types.mjs").HeroicRecord} heroic
 * @param {string} effectId - the id of the effect die that takes the steps (ADR-026)
 * @returns {import("./types.mjs").EngineResult<{resolution: import("./types.mjs").Resolution,
 *   heroic: import("./types.mjs").HeroicRecord}>} the stepped Resolution, and a copy of `heroic`
 *   with heroicAppliedTo set to `effectId`. Refuses, checked in this order: HEROIC_NOT_EARNED
 *   (no heroic steps), HEROIC_ALREADY_APPLIED, EFFECT_DIE_NOT_FOUND, OVERFLOW_PENDING.
 */
export function applyHeroicSteps(rolled, resolution, heroic, effectId) {
  if ( !(heroic.heroicSteps > 0) ) return fail("HEROIC_NOT_EARNED");
  if ( heroic.heroicAppliedTo != null ) return fail("HEROIC_ALREADY_APPLIED");
  if ( !resolution.effectDice.some(e => e.id === effectId) ) return fail("EFFECT_DIE_NOT_FOUND");
  if ( resolution.overflow ) return fail(OVERFLOW_PENDING);

  const stepped = stepEffectDie(rolled, resolution, effectId, heroic.heroicSteps, "heroic");
  return ok({ resolution: stepped, heroic: { ...heroic, heroicAppliedTo: effectId } });
}
