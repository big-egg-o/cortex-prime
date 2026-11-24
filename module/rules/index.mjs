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
export { appendToPool, buildPool, doubleDie, stepPoolDie } from "./pool.mjs";
export {
  DIFFICULTY_LEVELS, DIFFICULTY_SOURCE_KIND, applyHeroicSteps, beats, difficultyDice, difficultyEntry,
  difficultyLevelOfPool, heroicSteps, resolveTest, setDifficultyDice
} from "./outcome.mjs";
export {
  CONTEST_SIDES, TEST_SIDES, addContestRoll, addTestRoll, applyContestHeroicSteps, applyTestHeroicSteps,
  autoApplyContestHeroicSteps, autoApplyTestHeroicSteps, chooseContestOverflow, chooseTestOverflow, closeContest,
  closeTest, compareEffectDie, contestConsequence, contestRollFromResolution, contestRollFromTotal, createContest,
  createTest, decidingRolls, giveIn, setContestHighStakes, setTestHighStakes, testResult
} from "./contest.mjs";
export {
  REQUEST_ACTIONS, checkContestRequest, checkStartRequest, dispatchContestRequest, dispatchStartRequest, expectedRoll,
  liveOverflowIds, mayActFor, offeredActions, offeredEndChoices, rollCardHold
} from "./contest-request.mjs";
export {
  OVERFLOW_PENDING, applyOverflowChoice, applyRerolls, applyResults, evaluate, largestEligible, rerollableIds,
  resolve, stepEffectDie, suggestSelection, twoHighest, unrolledEffectDie, validateSelection
} from "./roll.mjs";
export {
  EXTRA_TRAIT_RULES, GAME_CONFIG_SCHEMA_VERSION, TRAIT_SET_FEATURES, TRAIT_SET_LISTS, TRAIT_SET_MARKS, TRAIT_SET_ROLES,
  actorKindById, defaultGameConfig, kindUsesPrimeSets, markedTraitSets, ratingOptionsOf, removeTraitSet, traitDefById,
  traitSetById, validateGameConfig
} from "./game-config.mjs";
export { MOD_IDS, checkMods, modEnabled } from "./mods.mjs";
export { CONFIG_EXPORT_FORMAT, buildConfigExport, parseConfigExport } from "./config-export.mjs";
export { ratingGuidance } from "./sheet-hints.mjs";
export {
  SHUT_DOWN_REASONS, STATEMENT_SHUT_DOWN_REASON, challengeStatement, editStatement, resolveChallengedStatement
} from "./statements.mjs";
export { effectiveRating, poolTraitCost, traitPoolEntries } from "./trait-pool.mjs";
export {
  POOL_TRAIT_OPTIONS, addTraitDice, challengedPoolTraits, entriesAfterChallenge, groupPoolTraitsByActor,
  poolDieGroupKey, poolTraitReport, poolTraits, rollablePool, stepDownsAfterChallenge, traitPoolDice,
  withoutPoolTraits
} from "./pool-traits.mjs";
export {
  checkCharacterEdit, checkCharacterUpdate, diffCharacterTraits, proposedTraitData, validateEntryFields, validateRating,
  validateTraitChanges
} from "./traits.mjs";
export {
  PP_REASONS, ROLL_REASONS, STAY_IN_ROUTES, SUGGESTED_GM_COMPLICATION_SIZE, changeBalance, contestPpOptions, poolPpFacts,
  ppChangeAllowed, ppTotals, rollPpFacts, settleRoll, startSession, testStayInOption
} from "./plot-points.mjs";
export {
  AC_PP_REASONS, ASSET_DURATIONS, ASSET_ORIGINS, COMPLICATION_ORIGINS, TEMP_TRAIT_KINDS,
  actThroughOption, applyComplications, applyHitches, applyOpportunities, checkTemporaryTrait, contestComplications,
  createAsset, createSessionRelationship, endScene, endSession, loseSignatureAsset, recoverSignatureAsset,
  removeUsedD4Complications, signatureAssetPoolDice, stepTemporaryTrait, temporaryTraitPoolEntry, upgradeAsset
} from "./assets.mjs";
export {
  COMPLETED_ACTIONS_KEPT, MAX_NOTE_LENGTH, TEMP_TRAIT_CARD_WARNINGS, TRAIT_STORE_ACTIONS, checkTraitStore,
  consequenceComplications, dispatchTraitStoreRequest, effectAssetDice, emptyTraitStore, isTraitId, poolTraitChoices, previewEnd, trackerGroups, usedD4ComplicationIds
} from "./trait-store.mjs";
