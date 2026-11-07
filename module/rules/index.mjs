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
export { REQUEST_ACTIONS, checkContestRequest, checkStartRequest, dispatchContestRequest } from "./contest-request.mjs";
export {
  OVERFLOW_PENDING, applyOverflowChoice, applyRerolls, applyResults, evaluate, largestEligible, rerollableIds,
  resolve, stepEffectDie, suggestSelection, twoHighest, unrolledEffectDie, validateSelection
} from "./roll.mjs";
export {
  EXTRA_TRAIT_RULES, GAME_CONFIG_SCHEMA_VERSION, TRAIT_SET_FEATURES, TRAIT_SET_LISTS, TRAIT_SET_ROLES, actorKindById,
  defaultGameConfig, kindUsesPrimeSets, ratingOptionsOf, removeTraitSet, traitDefById, traitSetById, validateGameConfig
} from "./game-config.mjs";
export { ratingGuidance } from "./sheet-hints.mjs";
export {
  SHUT_DOWN_REASONS, STATEMENT_SHUT_DOWN_REASON, challengeStatement, editStatement, resolveChallengedStatement
} from "./statements.mjs";
export { effectiveRating, poolTraitCost, traitPoolEntries } from "./trait-pool.mjs";
export {
  checkCharacterEdit, checkCharacterUpdate, diffCharacterTraits, proposedTraitData, validateEntryRatings, validateRating,
  validateTraitChanges
} from "./traits.mjs";
