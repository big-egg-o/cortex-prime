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
  DIFFICULTY_LEVELS, DIFFICULTY_SOURCE_KIND, applyHeroicSteps, beats, difficultyDice, difficultyEntry,
  difficultyLevelOfPool, heroicSteps, resolveTest
} from "./outcome.mjs";
export {
  CONTEST_SIDES, TEST_SIDES, addContestRoll, addTestRoll, applyContestHeroicSteps, applyTestHeroicSteps,
  autoApplyContestHeroicSteps, autoApplyTestHeroicSteps, chooseContestOverflow, chooseTestOverflow, closeContest,
  closeTest, compareEffectDie, contestConsequence, contestRollFromResolution, contestRollFromTotal, createContest,
  createTest, decidingRolls, giveIn, setContestHighStakes, setTestHighStakes, testResult
} from "./contest.mjs";
export {
  OVERFLOW_PENDING, applyOverflowChoice, applyRerolls, applyResults, evaluate, largestEligible, rerollableIds,
  resolve, stepEffectDie, suggestSelection, twoHighest, unrolledEffectDie, validateSelection
} from "./roll.mjs";
export { diffCharacterTraits, validateRating } from "./traits.mjs";
