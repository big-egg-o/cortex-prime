/**
 * Trait statements (MOD Trait Statements; Traits & Trait Sets rule 16; Handbook p. 65, p. 83;
 * Rules Questions RQ-021 and RQ-022). Challenging a statement triples the trait's die for one
 * roll (traitPoolEntries) and then lowers the trait; the table later resolves the challenge by
 * hand, with the statement rewritten or kept. The system tracks no sessions (ADR-029 point 4):
 * the challenged flag stays until resolveChallengedStatement clears it. Every function returns
 * an EngineResult (ADR-025) and never changes its input. Whether the trait's set has statements
 * turned on (rule 13) is the caller's check.
 * @module rules/statements
 */

import { stepDie } from "./dice.mjs";
import { fail, ok } from "./result.mjs";
import { validateRating } from "./traits.mjs";

/** The shut-down reason a challenge sets on a d4 trait (spec data shapes). */
export const STATEMENT_SHUT_DOWN_REASON = "statementChallenged";

/** The shut-down reasons a trait entry can store (spec data shapes). */
export const SHUT_DOWN_REASONS = Object.freeze(["manual", STATEMENT_SHUT_DOWN_REASON]);

/** @returns {boolean} whether value is a plain object, not an array, class instance or null */
function isPlainObject(value) {
  if ( (value === null) || (typeof value !== "object") ) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype) || (proto === null);
}

/**
 * A deep copy of plain data: objects and arrays are copied, anything else is kept as it is.
 * @param {unknown} value
 * @returns {unknown}
 */
function copyPlain(value) {
  if ( Array.isArray(value) ) return value.map(copyPlain);
  if ( isPlainObject(value) ) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copyPlain(v)]));
  return value;
}

/**
 * The first problem with the fields these functions read: the rating; `challenged`, which is a
 * boolean when present; a challenged trait's `preChallengeDice`, which must be a rating with
 * dice; and `shutDown`, which is absent or `{reason}` with one of SHUT_DOWN_REASONS. An
 * unchallenged trait's `preChallengeDice` is left unread, because a challenge replaces it.
 * @param {unknown} trait
 * @returns {string|null} a code, or null when the fields are well formed
 */
function statementTraitProblem(trait) {
  if ( !isPlainObject(trait) ) return "INVALID_TRAIT_DATA";
  const rating = validateRating(trait.dice);
  if ( !rating.ok ) return rating.code;
  if ( (trait.challenged !== undefined) && (typeof trait.challenged !== "boolean") ) return "INVALID_TRAIT_DATA";
  if ( trait.challenged ) {
    if ( !Array.isArray(trait.preChallengeDice) ) return "INVALID_TRAIT_DATA";
    const saved = validateRating(trait.preChallengeDice);
    if ( !saved.ok ) return saved.code;
    if ( saved.value.length === 0 ) return "INVALID_TRAIT_DATA";
  }
  if ( (trait.shutDown !== undefined)
    && !(isPlainObject(trait.shutDown) && SHUT_DOWN_REASONS.includes(trait.shutDown.reason)) ) return "INVALID_TRAIT_DATA";
  return null;
}

/**
 * The trait after its statement is challenged, for after the challenge roll (rule 16; TS-14,
 * TS-14b, TS-16, TS-16c). The first unresolved challenge saves the rating as `preChallengeDice`;
 * a later challenge before resolution keeps the saved rating (RQ-022 a). The trait is marked
 * `challenged` and stepped down one step (Handbook p. 65). A d4 can't step lower: it stays a d4
 * and is shut down with the reason "statementChallenged" (RQ-021; Codex, Statements Mod Trait,
 * Questioning a Statement, last paragraph), unless the table had already shut it down by hand:
 * the one reason slot then keeps "manual" (parked: the books don't say what clearing that
 * manual shut-down later does to a trait whose statement still needs rewriting).
 *
 * The books describe one die tripled and stepped down; a rating of several dice is refused
 * (parked until a reading is recorded: step down every die, one die, or remove one), although
 * traitPoolEntries triples each die of such a rating as the spec's implementation notes say.
 * @param {object} trait - a trait entry: `dice`, and `challenged` and `preChallengeDice` when
 *   already challenged
 * @returns {import("./types.mjs").EngineResult<object>} a new entry; refuses, in this order:
 *   INVALID_TRAIT_DATA or INVALID_DIE_SIZE (malformed fields, see above), TRAIT_UNRATED (no dice),
 *   STATEMENT_RATING_NOT_ONE_DIE
 */
export function challengeStatement(trait) {
  const problem = statementTraitProblem(trait);
  if ( problem ) return fail(problem);
  if ( trait.dice.length === 0 ) return fail("TRAIT_UNRATED");
  if ( trait.dice.length > 1 ) return fail("STATEMENT_RATING_NOT_ONE_DIE");

  const next = copyPlain(trait);
  if ( !trait.challenged ) next.preChallengeDice = [...trait.dice];
  next.challenged = true;
  const stepped = stepDie(trait.dice[0], -1);
  if ( stepped.removed ) {
    next.dice = [4];
    if ( trait.shutDown === undefined ) next.shutDown = { reason: STATEMENT_SHUT_DOWN_REASON };
  }
  else next.dice = [stepped.size];
  return ok(next);
}

/**
 * Resolves a challenged statement, the table's choice made by hand (rule 16; TS-15, TS-15b,
 * TS-16, TS-16c). Rewritten: the trait goes back to `preChallengeDice`, its rating from before the
 * first unresolved challenge, including a trait that reached d4 and was shut down (RQ-022 b,
 * Handbook p. 65, p. 83), and a shut-down set by the challenge is cleared. Kept: the reduced
 * rating stays, and so does a shut-down set by the challenge (RQ-021). Either way `challenged`
 * and `preChallengeDice` are removed. A shut-down the table set by hand is never cleared here.
 * This is the only way to clear `challenged`; editing the statement doesn't (TS-15c).
 * @param {object} trait - a challenged trait entry
 * @param {{rewritten: boolean}} choice
 * @returns {import("./types.mjs").EngineResult<object>} a new entry; refuses, in this order:
 *   INVALID_TRAIT_DATA or INVALID_DIE_SIZE (malformed fields), INVALID_TRAIT_OPTIONS
 *   (`rewritten` not a boolean), STATEMENT_NOT_CHALLENGED
 */
export function resolveChallengedStatement(trait, choice) {
  const problem = statementTraitProblem(trait);
  if ( problem ) return fail(problem);
  if ( !isPlainObject(choice) || (typeof choice.rewritten !== "boolean") ) return fail("INVALID_TRAIT_OPTIONS");
  if ( trait.challenged !== true ) return fail("STATEMENT_NOT_CHALLENGED");

  const next = copyPlain(trait);
  if ( choice.rewritten ) {
    next.dice = [...trait.preChallengeDice];
    if ( trait.shutDown?.reason === STATEMENT_SHUT_DOWN_REASON ) delete next.shutDown;
  }
  delete next.challenged;
  delete next.preChallengeDice;
  return ok(next);
}

/**
 * The trait with its statement text changed and nothing else: editing the text of a challenged
 * statement doesn't resolve the challenge (TS-15c; RQ-021 as amended).
 * @param {object} trait
 * @param {string} statement
 * @returns {import("./types.mjs").EngineResult<object>} a new entry; refuses with
 *   INVALID_TRAIT_DATA
 */
export function editStatement(trait, statement) {
  if ( !isPlainObject(trait) || (typeof statement !== "string") ) return fail("INVALID_TRAIT_DATA");
  return ok({ ...copyPlain(trait), statement });
}
