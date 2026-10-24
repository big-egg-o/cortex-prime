/**
 * Shared JSDoc typedefs for the rules engine (Dice & Pools and Tests & Contests specs). Pure
 * data shapes only: nothing here decides an outcome, so there is nothing to unit test beyond
 * the DIE_SIZES constant.
 * @module rules/types
 */

/**
 * What new engine functions return instead of throwing (Decisions ADR-025): the value, or the
 * upper-case code of the first check that failed.
 * @template T
 * @typedef {{ok: true, value: T} | {ok: false, code: string}} EngineResult
 */

/**
 * One of the five sizes on the step ladder (rule 1).
 * @typedef {4|6|8|10|12} DieSize
 */

/** The step ladder, smallest to largest (rule 2). */
export const DIE_SIZES = Object.freeze(/** @type {DieSize[]} */ ([4, 6, 8, 10, 12]));

/**
 * Where a pool die came from: a trait, an asset, an SFX, a complication, a doom die, a custom
 * die added by hand, and so on. Only ever referenced by a PoolDie, never mutated through one
 * (overflow and doubled dice carry their origin die's source, but stepping or doubling a pool
 * die never changes the source itself).
 * @typedef {Object} DieSource
 * @property {string} kind - e.g. "trait", "asset", "sfx", "complication", "doom", "difficulty",
 *   "custom"
 * @property {string} [actorId]
 * @property {string} [traitId]
 * @property {string} label - display label for the chat card
 */

/**
 * One die in an unrolled pool (rule 5).
 * @typedef {Object} PoolDie
 * @property {string} id - unique within the pool, stable across steps/doubling (DP-E03)
 * @property {DieSize} size
 * @property {DieSource} source
 * @property {'rating'|'doubled'|'bonus'|'overflow'} origin - "overflow" is a d6 added when a
 *   d12 pool die is stepped up (rule 4); it carries the stepped die's source
 */

/**
 * A PoolDie after rolling: its result, whether it is a hitch, and whether it is still
 * available for the roller to pick.
 * @typedef {Object} RolledDie
 * @property {string} id
 * @property {DieSize} size
 * @property {DieSource} source
 * @property {string} origin
 * @property {number} result - a whole number from 1 to `size` (rule 1, DP-12)
 * @property {boolean} hitch - true when `result` is 1 (rule 10)
 * @property {'available'|'unavailable'|'hitch-activated'} state - "unavailable" is a die
 *   otherwise spoken for (DP-E04); "hitch-activated" is a hitch already spent on another
 *   effect, so it can no longer be rerolled (rule 26, DP-28)
 */

/**
 * The roller's picks for one roll: which results form the total, which dice are effect dice,
 * and how many extra results/effect dice were paid for with Plot Points (Plot Points spec owns
 * the spend; this engine only takes the paid-for count as input).
 * @typedef {Object} Selection
 * @property {string[]} totalIds - RolledDie ids summed for the total (rule 12)
 * @property {string[]} effectDieIds - RolledDie ids chosen as effect dice (rule 18)
 * @property {number} extraResultsPaid - extra results added to the total beyond keepLimit
 *   (rule 14)
 * @property {number} extraEffectDicePaid - extra effect dice beyond the first (rule 21)
 * @property {number} [keepLimit=2] - how many results make up the total before PP; 1 under
 *   rule 15
 */

/**
 * One effect die in a Resolution. `dieId` is null when the slot had no eligible die left and
 * defaulted instead: to a d4 normally (rule 20, rule 21, RQ-002), or to a d6 for a second
 * effect die from an effect-die overflow (rule 22, RQ-003, RQ-007).
 * @typedef {Object} EffectDieEntry
 * @property {string} id - "e1", "e2", ... in the order the entries were created; never reused
 *   within a roll, and separate from the rolled die's own id (ADR-026)
 * @property {'rolled'|'default'|'overflow'} kind - a rolled die, the d4 default (rule 20,
 *   rule 21), or the new d6 from an overflow choice (rule 22)
 * @property {DieSize} size
 * @property {string|null} dieId
 * @property {boolean} isDefault - true for the "default" and "overflow" kinds
 */

/**
 * What the roller may do when an effect die is stepped past d12 (rule 22): take any eligible
 * leftover die as a second effect die at its own size, take a new d6 as a second effect die, or
 * take the opponent out at once. `cause` only affects display and RQ tagging (RQ-005): the
 * options themselves are identical whether a heroic success or an SFX caused the overflow.
 * @typedef {Object} OverflowOptions
 * @property {'heroic'|'other'} cause
 * @property {{dieId: string, size: DieSize}[]} leftovers - every eligible unused die (not a
 *   hitch, available, not in the total, not already an effect die, not in consumedDieIds), in
 *   roll order; empty when none (RQ-003, RQ-007, DP-24c)
 * @property {6} newDie
 * @property {true} takeOutAvailable
 */

/**
 * The roller's pick among the OverflowOptions.
 * @typedef {Object} OverflowChoice
 * @property {'leftover'|'new-d6'|'take-out'} kind
 * @property {string} [dieId] - required when kind is "leftover"; must be one of options.leftovers
 */

/**
 * A pending overflow choice for one effect die (rule 22): which effect die overflowed, why, and
 * the options offered. Cleared by applyOverflowChoice once the roller picks.
 * @typedef {Object} OverflowSignal
 * @property {string} effectId - the id of the overflowing EffectDieEntry (ADR-026)
 * @property {'heroic'|'other'} cause
 * @property {OverflowOptions} options
 */

/**
 * The outcome of a validated Selection against a RolledDie list.
 * @typedef {Object} Resolution
 * @property {number} total - 0 for a botch (rule 11)
 * @property {string[]} totalIds - which RolledDie ids summed to `total`, kept around for
 *   working out leftovers and for display (added 2026-10-13)
 * @property {EffectDieEntry[]} effectDice
 * @property {string[]} consumedDieIds - rolled dice whose effect die was stepped down and
 *   removed; they stay used up and are never offered again (rule 23, DP-24c; added 2026-10-18)
 * @property {number} nextEffectNumber - the number for the next effect id (`e<n>`); it only
 *   goes up, so a removed entry's id is never reused (ADR-026)
 * @property {string[]} hitchIds
 * @property {boolean} botch
 * @property {boolean} takeOut - true once the take-out/victory option is chosen (rule 22;
 *   added 2026-10-13)
 * @property {OverflowSignal|null} overflow
 */

/**
 * A test's difficulty level on the chart (Tests & Contests rule 5).
 * @typedef {'veryEasy'|'easy'|'challenging'|'hard'|'veryHard'} DifficultyLevel
 */

/**
 * The outcome of a test (Tests & Contests rules 8, 10-11).
 * @typedef {Object} TestOutcome
 * @property {boolean} success - the total beat the difficulty
 * @property {number} margin - total minus difficulty; negative on a failure
 * @property {boolean} heroic - margin of 5 or more
 * @property {number} heroicSteps - one per full 5 points of margin
 */

/**
 * The heroic steps a success earned, and the effect die that took them, if any (ADR-023).
 * A TestOutcome and a ContestState both carry these fields.
 * @typedef {Object} HeroicRecord
 * @property {number} heroicSteps
 * @property {string|null} [heroicAppliedTo] - an effect id; missing or null until applied
 */

/**
 * The two sides of a contest (Tests & Contests rule 14).
 * @typedef {'initiator'|'opposition'} ContestSide
 */

/**
 * One effect die of a contest roll, as it stands after heroic steps and overflow choices
 * (ADR-027), named by its stable effect id (ADR-026).
 * @typedef {Object} ContestEffect
 * @property {string} id
 * @property {DieSize} size
 */

/**
 * How a contest roll's effect die past d12 was answered (Dice & Pools rule 22).
 * @typedef {Object} ContestOverflow
 * @property {string} effectId - the effect die that went past d12
 * @property {'leftover'|'new-d6'|'take-out'} kind - the OverflowChoice kind
 */

/**
 * One roll of a contest, the contest's own copy of a confirmed poolRoll (ADR-027).
 * @typedef {Object} ContestRoll
 * @property {ContestSide} side
 * @property {number} total
 * @property {ContestEffect[]} effects - empty for a typed total (ADR-021)
 * @property {ContestOverflow|null} overflow
 * @property {string|null} messageRef - the poolRoll message it came from; opaque to the engine
 */

/**
 * The state of a contest (Tests & Contests rules 14-16). Who acts for each side and the
 * revision number live in the contest message's data model (ADR-027).
 * @typedef {Object} ContestState
 * @property {boolean} highStakes - set by the GM (ADR-022)
 * @property {ContestRoll[]} rolls - in the order they were rolled
 * @property {number|null} difficulty - the total to beat; null before the first roll
 * @property {ContestSide|null} turn - null once the contest has a winner
 * @property {'open'|'won'|'gaveIn'|'declined'} status
 * @property {ContestSide|null} winner
 * @property {{initiator: boolean, opposition: boolean}} hasRolled - for the PP on giving in
 *   (rule 16)
 * @property {number|null} margin - the winner's standing total minus the loser's failed total;
 *   null unless a roll failed
 * @property {number} heroicSteps - from the margin (rules 10-11); 0 after giving in or declining
 * @property {string|null} heroicAppliedTo - the effect id that took the heroic steps (ADR-023)
 * @property {boolean} closed - every action is refused once closed (ADR-027)
 */

export {};
