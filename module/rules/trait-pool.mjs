/**
 * From a character's traits to pool dice: the dice a trait gives, the pool entries it adds, and
 * what the traits chosen for one pool cost and warn of (Traits & Trait Sets spec, rules 1-3, 6-8,
 * 11, 12, 15, 16 and 22; Rules Questions RQ-029 to RQ-031; Decisions ADR-029, ADR-035 and
 * ADR-037). Every function returns an EngineResult (ADR-025) and never changes its inputs.
 * @module rules/trait-pool
 */

import { fail, ok } from "./result.mjs";
import { actorKindById, ratingOptionsOf, traitSetById } from "./game-config.mjs";
import { validateRating } from "./traits.mjs";

/** @returns {boolean} whether value is a plain object, not an array, class instance or null */
function isPlainObject(value) {
  if ( (value === null) || (typeof value !== "object") ) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype) || (proto === null);
}

/** @returns {boolean} whether value is left out or a boolean */
function isOptionalBoolean(value) {
  return (value === undefined) || (typeof value === "boolean");
}

/**
 * The dice a trait puts into a pool, before Hinder or a challenge (rules 1-3 and 8). A trait in
 * a set without dice gives none (TRAIT_HAS_NO_DICE), like a talent (rule 3, TS-05), and so does
 * one whose set lost its dice after it was rated: the stored dice are kept, not used (ADR-037
 * point 5). A value in a fixed set whose definition the GM deleted is orphaned and ignored when
 * traits are resolved (TRAIT_ORPHANED; TS-E03, ADR-037 point 6); so are entries of a set the
 * configuration no longer has, which the caller leaves out. With no rating, which includes an
 * empty one (ADR-037 Q1), the trait counts as its set's fallback die (rule 8, TS-03), or isn't
 * rated at all (TRAIT_UNRATED, TS-04). A free trait belongs to no set and has no fallback. A
 * stored rating that no longer fits its set's shape is used as stored, with the warning
 * RATING_CONFLICTS_WITH_SET (ADR-037 point 5). Shut-down flags don't matter here; poolTraitCost
 * reports them.
 * @param {import("./types.mjs").TraitSetDef|null} set - null for a free trait
 * @param {import("./types.mjs").TraitDef|null} traitDef - in a fixed set, the definition the
 *   entry points at (or the one to resolve when the actor has no entry); null when the set has
 *   none with that id
 * @param {{dice: unknown, defId?: string|null}|null|undefined} entry - what the actor stores, or
 *   nothing
 * @returns {import("./types.mjs").EngineResult<{dice: import("./types.mjs").DieSize[],
 *   isFallback: boolean, warnings: {code: string}[]}>} refuses, in this order: TRAIT_HAS_NO_DICE,
 *   TRAIT_ORPHANED, INVALID_DIE_SIZE (a stored die size that doesn't exist), TRAIT_UNRATED
 */
export function effectiveRating(set, traitDef, entry) {
  if ( set && !set.hasDice ) return fail("TRAIT_HAS_NO_DICE");
  if ( set && (set.list === "fixed") && !traitDef && ((entry?.defId ?? null) !== null) ) return fail("TRAIT_ORPHANED");
  const stored = entry?.dice ?? [];
  const sizes = validateRating(stored);
  if ( !sizes.ok ) return sizes;
  if ( sizes.value.length === 0 ) {
    if ( set?.fallbackDie ) return ok({ dice: [set.fallbackDie], isFallback: true, warnings: [] });
    return fail("TRAIT_UNRATED");
  }
  const conflicts = set && !validateRating(sizes.value, ratingOptionsOf(set)).ok;
  return ok({ dice: sizes.value, isFallback: false, warnings: conflicts ? [{ code: "RATING_CONFLICTS_WITH_SET" }] : [] });
}

/**
 * What Hinder does to a rating, for the current roll only (rule 11; RQ-029, reading B). Prime
 * Core uses a distinction at d4 instead of its d8 and gains a plot point (Handbook p. 50, p. 61;
 * scene distinctions too, p. 116). Under RQ-029 Hinder works on the trait, not on each die: any
 * rating with a die above d4, or with several dice (a split scene distinction such as d6 d6,
 * p. 116), is replaced by one d4 and gains 1 PP; a distinction rated other than d8 is Rating
 * Distinctions (MOD), p. 50, and Codex p. 41 swaps the distinction's own die for a d4. A trait
 * already rated d4 keeps its d4 and gains nothing, with the hint HINDER_ALREADY_D4: a project
 * decision, since Hinder trades a real disadvantage for the plot point (p. 62; compare p. 28).
 * @param {import("./types.mjs").DieSize[]} dice - the rating, with at least one die
 * @returns {import("./types.mjs").DieSize[]|null} the dice for the roll, which gain 1 PP; null
 *   for a trait already rated d4, which Hinder leaves as it is
 */
function hinderedDice(dice) {
  return ((dice.length === 1) && (dice[0] === 4)) ? null : [4];
}

/**
 * Whether a trait has the shape traitPoolEntries reads.
 * @param {unknown} trait
 * @returns {boolean}
 */
function poolTraitWellFormed(trait) {
  if ( !isPlainObject(trait) ) return false;
  if ( (typeof trait.label !== "string") || (trait.label.trim() === "") ) return false;
  for ( const key of ["actorId", "traitId"] ) {
    if ( (trait[key] !== undefined) && (typeof trait[key] !== "string") ) return false;
  }
  return isOptionalBoolean(trait.isFallback);
}

/**
 * The pool entries one trait adds, in the shape buildPool takes: one entry per die, each with
 * its own copy of the trait as source (kind "trait"). With Hinder (RQ-029) the trait gives one
 * d4 and its first entry reports `ppGained: 1`, the one plot point a use of Hinder gains (TS-02);
 * a trait already rated d4 gives its d4 as usual, and its first entry reports `ppGained: 0` and
 * `hint: "HINDER_ALREADY_D4"`. Who gains the plot point (the roller, or the bank for a GMC) and
 * paying it out are Plot Points bookkeeping (ADR-014, ADR-029 point 3). Hinder changes the roll
 * only: the trait's stored rating stays as it is. A challenged statement (MOD Trait Statements)
 * gives each die three times for this roll (rule 16, TS-14, TS-16; the spec's implementation
 * notes for several dice). A fallback die is marked `isFallback` (TS-03). Hinder and a challenge
 * together are refused until RQ-032 is decided. Whether the trait's set offers Hinder or
 * statements is the caller's check; buildPool ignores the extra marks, so a caller that needs
 * them keeps the entries.
 * @param {{dice: import("./types.mjs").DieSize[], label: string, actorId?: string,
 *   traitId?: string, isFallback?: boolean}} trait - dice from effectiveRating
 * @param {{hinder?: boolean, challenge?: boolean}} [options]
 * @returns {import("./types.mjs").EngineResult<{size: import("./types.mjs").DieSize,
 *   source: import("./types.mjs").DieSource, ppGained?: number, hint?: string,
 *   isFallback?: true}[]>} refuses,
 *   in this order: INVALID_TRAIT_DATA (no label, or ids or marks of the wrong type),
 *   INVALID_TRAIT_OPTIONS (options that aren't an object of booleans), TRAIT_OPTIONS_CONFLICT
 *   (Hinder and a challenge), INVALID_DIE_SIZE, TRAIT_UNRATED (no dice)
 */
export function traitPoolEntries(trait, options = {}) {
  if ( !poolTraitWellFormed(trait) ) return fail("INVALID_TRAIT_DATA");
  if ( !isPlainObject(options) ) return fail("INVALID_TRAIT_OPTIONS");
  const { hinder = false, challenge = false } = options;
  if ( (typeof hinder !== "boolean") || (typeof challenge !== "boolean") ) return fail("INVALID_TRAIT_OPTIONS");
  if ( hinder && challenge ) return fail("TRAIT_OPTIONS_CONFLICT");
  const rating = validateRating(trait.dice);
  if ( !rating.ok ) return rating;
  if ( rating.value.length === 0 ) return fail("TRAIT_UNRATED");

  const source = () => {
    const s = { kind: "trait" };
    if ( trait.actorId !== undefined ) s.actorId = trait.actorId;
    if ( trait.traitId !== undefined ) s.traitId = trait.traitId;
    s.label = trait.label;
    return s;
  };
  const hindered = hinder ? hinderedDice(rating.value) : null;
  if ( hindered ) {
    return ok(hindered.map((size, i) => (i === 0 ? { size, source: source(), ppGained: 1 } : { size, source: source() })));
  }
  const dice = challenge ? rating.value.flatMap(size => [size, size, size]) : rating.value;
  const entries = dice.map(size => {
    const entry = { size, source: source() };
    if ( trait.isFallback ) entry.isFallback = true;
    return entry;
  });
  if ( hinder ) Object.assign(entries[0], { ppGained: 0, hint: "HINDER_ALREADY_D4" });
  return ok(entries);
}

/**
 * Whether a list holds pool traits poolTraitCost can read.
 * @param {unknown} traits
 * @returns {boolean}
 */
function poolTraitsWellFormed(traits) {
  if ( !Array.isArray(traits) ) return false;
  for ( let i = 0; i < traits.length; i++ ) {
    const trait = traits[i];
    if ( !isPlainObject(trait) || (typeof trait.traitId !== "string") ) return false;
    if ( (trait.setId !== null) && (typeof trait.setId !== "string") ) return false;
    if ( (trait.actorId !== undefined) && (typeof trait.actorId !== "string") ) return false;
    if ( ![trait.setShutDown, trait.traitShutDown, trait.hinder].every(isOptionalBoolean) ) return false;
  }
  return true;
}

/**
 * A warning about one trait: its set when it has one, its actor when given, and its id.
 * @param {string} code
 * @param {{setId: string|null, traitId: string, actorId?: string}} trait
 * @returns {{code: string, setId?: string, actorId?: string, traitId: string}}
 */
function traitWarning(code, { setId, actorId, traitId }) {
  const warning = { code };
  if ( setId !== null ) warning.setId = setId;
  if ( actorId !== undefined ) warning.actorId = actorId;
  warning.traitId = traitId;
  return warning;
}

/**
 * What the traits chosen for one pool cost and warn of (rules 6, 7 and 15). The first trait from
 * each set is free; each further one costs 1 PP, with no limit on how many (RQ-019; Handbook
 * p. 26, p. 28). The player or GM building the pool pays (p. 28; RQ-031), whoever's traits they
 * use; this only computes the cost. Traits are counted, not dice, and the same trait twice is one
 * trait (TS-E05). A distinction used with Hinder still counts as the set's one distinction
 * (TS-E06), so the `hinder` mark is accepted but changes nothing here. Each set is its own count,
 * so two power sets give one free power each (TS-11).
 *
 * Counting follows RQ-031: by set id first, whichever actor a trait comes from, so with the
 * defaults a location's scene distinctions are their own set, and one used next to a
 * character's own distinction is free while a second costs 1 PP. Within a set a trait is its
 * actor id and its trait id together, so traits of two actors that share an id are two traits
 * (a trait without an actor id counts as one actor's). Free traits belong to no set and are
 * never charged, whichever actor they come from (TS-22).
 *
 * Nothing is refused for rules reasons (ADR-029): the warnings tell the table the pool is
 * nonstandard and the dice stay in it. A further trait from a set whose game doesn't allow one
 * (rule 6) warns EXTRA_TRAIT_NOT_ALLOWED and has no defined price (RQ-030): it is neither free
 * nor 1 PP, so it is left out of ppCost and extraTraits and counted in unpricedTraits instead,
 * for the table to decide. Nothing is deducted in any case (ADR-029 point 3). A shut-down set or
 * trait warns TRAIT_SET_SHUT_DOWN or TRAIT_SHUT_DOWN (rule 15). A trait of a set the
 * configuration no longer has is orphaned (ADR-037 point 6, as TS-E03 does for deleted
 * definitions): it warns TRAIT_ORPHANED and isn't counted. For a kind that uses prime sets,
 * every prime set of the kind with no trait in the pool warns PRIME_SET_MISSING (RQ-020
 * reading C, as amended by ADR-029); a missing distinction never does, and a kind without prime
 * sets, or no kind, never does (TS-17b).
 * @param {{setId: string|null, traitId: string, actorId?: string, setShutDown?: boolean,
 *   traitShutDown?: boolean, hinder?: boolean}[]} traits - the traits of the pool, with the
 *   actor each comes from and the shut-down flags of that actor's data
 * @param {import("./types.mjs").GameConfig} config
 * @param {string|null} kindId - the rolling actor's kind
 * @returns {import("./types.mjs").EngineResult<{ppCost: number, extraTraits: {setId: string,
 *   count: number}[], unpricedTraits: {setId: string, count: number}[], warnings: {code: string,
 *   setId?: string, actorId?: string, traitId?: string}[]}>} ppCost is the sum of the
 *   extraTraits counts; extraTraits and unpricedTraits list sets in the order they first appear
 *   in the pool, each set in at most one of them. Warnings: per trait in pool order,
 *   TRAIT_ORPHANED and TRAIT_SHUT_DOWN (each trait once, naming its actor when it has one) and
 *   TRAIT_SET_SHUT_DOWN (each set once, naming no actor); then EXTRA_TRAIT_NOT_ALLOWED by set in
 *   pool order; then
 *   PRIME_SET_MISSING in the kind's order. Refuses with INVALID_TRAIT_DATA (including a flag that
 *   isn't a boolean, or an actor id that isn't text) or INVALID_GAME_CONFIG
 */
export function poolTraitCost(traits, config, kindId) {
  if ( !poolTraitsWellFormed(traits) ) return fail("INVALID_TRAIT_DATA");
  if ( !isPlainObject(config) || !Array.isArray(config.traitSets) || !Array.isArray(config.actorKinds) ) {
    return fail("INVALID_GAME_CONFIG");
  }

  const warnings = [];
  const traitsBySet = new Map();
  const warned = new Set();
  const warnOnce = (key, warning) => {
    if ( warned.has(key) ) return;
    warned.add(key);
    warnings.push(warning);
  };
  for ( const trait of traits ) {
    const { setId } = trait;
    const traitKey = JSON.stringify([setId, trait.actorId ?? null, trait.traitId]);
    if ( (setId !== null) && !traitSetById(config, setId) ) {
      warnOnce(`orphan:${traitKey}`, traitWarning("TRAIT_ORPHANED", trait));
      continue;
    }
    if ( trait.setShutDown && (setId !== null) ) warnOnce(`set:${setId}`, { code: "TRAIT_SET_SHUT_DOWN", setId });
    if ( trait.traitShutDown ) warnOnce(`trait:${traitKey}`, traitWarning("TRAIT_SHUT_DOWN", trait));
    if ( setId === null ) continue;
    if ( !traitsBySet.has(setId) ) traitsBySet.set(setId, new Set());
    traitsBySet.get(setId).add(traitKey);
  }

  let ppCost = 0;
  const extraTraits = [];
  const unpricedTraits = [];
  for ( const [setId, keys] of traitsBySet ) {
    const count = keys.size - 1;
    if ( count === 0 ) continue;
    if ( traitSetById(config, setId).extraTraits === "none" ) {
      unpricedTraits.push({ setId, count });
      warnings.push({ code: "EXTRA_TRAIT_NOT_ALLOWED", setId });
      continue;
    }
    extraTraits.push({ setId, count });
    ppCost += count;
  }

  const kind = actorKindById(config, kindId);
  for ( const setId of kind?.traitSetIds ?? [] ) {
    if ( (traitSetById(config, setId)?.role === "prime") && !traitsBySet.has(setId) ) {
      warnings.push({ code: "PRIME_SET_MISSING", setId });
    }
  }

  return ok({ ppCost, extraTraits, unpricedTraits, warnings });
}
