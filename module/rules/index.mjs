/**
 * Pure game mechanics: pool assembly, totals, effect dice, step up/down, ...
 *
 * Everything under module/rules/ must be plain JavaScript with NO Foundry
 * dependencies (no imports from outside module/rules/, no Foundry globals).
 * This is enforced by ESLint and by tests/unit/rules-boundary.test.mjs.
 * @module rules
 */

export { DIE_SIZES } from "./types.mjs";
export { stepDie } from "./dice.mjs";
export { buildPool, doubleDie, stepPoolDie } from "./pool.mjs";
export {
  DIFFICULTY_LEVELS, applyHeroicSteps, beats, difficultyDice, difficultyEntry, heroicSteps, resolveTest
} from "./outcome.mjs";
export {
  addContestRoll, closeContest, compareEffectDie, contestConsequence, createContest, decidingRolls, giveIn
} from "./contest.mjs";
export {
  OVERFLOW_PENDING, applyOverflowChoice, applyRerolls, applyResults, evaluate, largestEligible, rerollableIds,
  resolve, stepEffectDie, suggestSelection, twoHighest, unrolledEffectDie, validateSelection
} from "./roll.mjs";
export { diffCharacterTraits, validateRating } from "./traits.mjs";
