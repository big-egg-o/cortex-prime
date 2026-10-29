/**
 * Traits, their ratings, and what an edit changes in a character's traits (Traits & Trait Sets
 * spec, Decisions ADR-037 and ADR-038). Every function here returns an EngineResult instead of
 * throwing (Decisions ADR-025).
 * @module rules/traits
 */

import { fail, ok } from "./result.mjs";
import { DIE_SIZES } from "./types.mjs";

/**
 * Checks a trait's rating: a list of die sizes (ADR-033), several for mobs, bosses, resources
 * and the like (rule 2), none for a trait with no die (rule 3). This is technical validation,
 * which ADR-029 keeps enforced: every entry must be a size on the step ladder (TS-E01), and a
 * set whose traits need dice of one size refuses a mix (TS-E02). Nothing is coerced, so a rating
 * that isn't an array, an entry that isn't one of the DIE_SIZES numbers, or an empty slot is
 * refused. A set's usual range is guidance for the sheet, not checked here (rule 9).
 * @param {unknown} dice
 * @param {{sameSizeDice?: boolean}} [options] - an object, or left out. `sameSizeDice: true`
 *   refuses mixed sizes; `false`, left out or `undefined` allows them.
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").DieSize[]>} a copy of the
 *   rating; refuses, checked in this order: INVALID_RATING_OPTIONS (options that aren't an
 *   object, or a sameSizeDice that isn't a boolean: a calling error, not a rule),
 *   INVALID_DIE_SIZE, RATING_MIXED_SIZES
 */
export function validateRating(dice, options = {}) {
  if ( (typeof options !== "object") || (options === null) || Array.isArray(options) ) {
    return fail("INVALID_RATING_OPTIONS");
  }
  const { sameSizeDice = false } = options;
  if ( typeof sameSizeDice !== "boolean" ) return fail("INVALID_RATING_OPTIONS");
  if ( !Array.isArray(dice) ) return fail("INVALID_DIE_SIZE");
  // An indexed loop, not some(), so an empty slot is checked rather than skipped.
  for ( let i = 0; i < dice.length; i++ ) {
    if ( !DIE_SIZES.includes(dice[i]) ) return fail("INVALID_DIE_SIZE");
  }
  if ( sameSizeDice && dice.some(size => size !== dice[0]) ) return fail("RATING_MIXED_SIZES");
  return ok([...dice]);
}

/** The id format of the character data: 16 letters or digits, as Foundry generates ids. */
const TRAIT_ID_PATTERN = /^[a-zA-Z0-9]{16}$/;

/**
 * @param {unknown} value
 * @returns {boolean} whether value is an id in the character data's 16-character format
 */
function isTraitId(value) {
  return (typeof value === "string") && TRAIT_ID_PATTERN.test(value);
}

/**
 * @param {unknown} value
 * @returns {boolean} whether value is a plain object, not an array, class instance or null
 */
function isPlainObject(value) {
  if ( (value === null) || (typeof value !== "object") ) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype) || (proto === null);
}

/**
 * Whether a list of entries has the shape the diff can compare: every slot an object with an id
 * and a dice array; in a set, a defId that is null, missing or an id. An indexed loop, not
 * every(), so an empty slot is checked rather than skipped.
 * @param {unknown[]} entries
 * @param {boolean} inSet - free traits have no defId to check
 * @returns {boolean}
 */
function entriesWellFormed(entries, inSet) {
  for ( let i = 0; i < entries.length; i++ ) {
    const entry = entries[i];
    if ( !isPlainObject(entry) || !isTraitId(entry.id) || !Array.isArray(entry.dice) ) return false;
    if ( inSet && (entry.defId !== undefined) && (entry.defId !== null) && !isTraitId(entry.defId) ) return false;
  }
  return true;
}

/**
 * @param {unknown} state
 * @returns {boolean} whether state has the shape of a character's trait data
 */
function traitDataWellFormed(state) {
  if ( !isPlainObject(state) ) return false;
  if ( (state.kindId !== null) && !isTraitId(state.kindId) ) return false;
  if ( !isPlainObject(state.traits) || !Array.isArray(state.freeTraits) ) return false;
  for ( const [setId, set] of Object.entries(state.traits) ) {
    if ( !isTraitId(setId) || !isPlainObject(set) || !Array.isArray(set.entries) ) return false;
    if ( !entriesWellFormed(set.entries, true) ) return false;
  }
  return entriesWellFormed(state.freeTraits, false);
}

/**
 * Every entry of a character, where it is and what the checks look at: sets in key order and
 * their entries in array order, then the free traits (setId null, defId always null). Each
 * occurrence's dice is the input rating array itself, not a copy; the public result copies it.
 * @param {import("./types.mjs").CharacterTraitData} state - well formed
 * @returns {{id: string, setId: string|null, defId: string|null, dice: unknown[]}[]}
 */
function traitOccurrences(state) {
  const occurrences = [];
  for ( const [setId, set] of Object.entries(state.traits) ) {
    for ( const entry of set.entries ) occurrences.push({ id: entry.id, setId, defId: entry.defId ?? null, dice: entry.dice });
  }
  for ( const entry of state.freeTraits ) occurrences.push({ id: entry.id, setId: null, defId: null, dice: entry.dice });
  return occurrences;
}

/**
 * @param {ReturnType<typeof traitOccurrences>} occurrences
 * @returns {Map<string, ReturnType<typeof traitOccurrences>>} occurrences by id, ids in the order
 *   they first appear
 */
function groupById(occurrences) {
  const groups = new Map();
  for ( const occurrence of occurrences ) {
    if ( !groups.has(occurrence.id) ) groups.set(occurrence.id, []);
    groups.get(occurrence.id).push(occurrence);
  }
  return groups;
}

/**
 * Whether two ratings hold the same dice in any order, as a multiset. Values are compared as
 * they are, without conversion, so "8" and 8 differ.
 * @param {unknown[]} a
 * @param {unknown[]} b
 * @returns {boolean}
 */
function sameDice(a, b) {
  if ( a.length !== b.length ) return false;
  const counts = new Map();
  for ( let i = 0; i < a.length; i++ ) counts.set(a[i], (counts.get(a[i]) ?? 0) + 1);
  for ( let i = 0; i < b.length; i++ ) {
    const count = counts.get(b[i]);
    if ( !count ) return false;
    counts.set(b[i], count - 1);
  }
  return true;
}

/** @returns {boolean} whether two occurrences agree on place, definition id and dice */
function sameOccurrence(a, b) {
  return (a.setId === b.setId) && (a.defId === b.defId) && sameDice(a.dice, b.dice);
}

/**
 * Whether a proposed group of occurrences of one id is a multiset subset of the earlier group
 * (ADR-038): every proposed occurrence pairs with a different earlier one that agrees on place,
 * definition id (missing counts as null) and dice as a multiset, in any order. The group may be
 * smaller than before, never larger. Names are not compared, because no check depends on them.
 * Only the resulting occurrences are compared, not how they came about. Taking the first unused
 * match is enough: agreeing on place, definition id and dice is an equivalence, so the earlier
 * occurrences a proposed one could pair with are interchangeable.
 * @returns {boolean}
 */
function sameGroup(proposed, current) {
  if ( proposed.length > current.length ) return false;
  const used = new Array(current.length).fill(false);
  for ( const occurrence of proposed ) {
    const match = current.findIndex((earlier, i) => !used[i] && sameOccurrence(earlier, occurrence));
    if ( match === -1 ) return false;
    used[match] = true;
  }
  return true;
}

/**
 * What one proposed entry, whose id occurs once in the proposed data, needs checked. Compared
 * with the earlier occurrences of its id at the same place: if one of them has the same
 * definition id and the same dice, nothing; if there is none, it entered this place; otherwise
 * both are compared with the first of them, never each with a different one.
 * @param {ReturnType<typeof traitOccurrences>[number]} occurrence
 * @param {ReturnType<typeof traitOccurrences>} earlier - the current occurrences of its id
 * @returns {import("./types.mjs").TraitEntryChange|null}
 */
function entryChange(occurrence, earlier) {
  const here = earlier.filter(e => e.setId === occurrence.setId);
  if ( here.some(e => sameOccurrence(e, occurrence)) ) return null;
  const entered = here.length === 0;
  const baseline = here[0];
  const diceChanged = entered || !sameDice(baseline.dice, occurrence.dice);
  const defIdChanged = (occurrence.setId !== null) && (occurrence.defId !== null)
    && (entered || (occurrence.defId !== baseline.defId));
  if ( !diceChanged && !defIdChanged ) return null;
  return {
    setId: occurrence.setId,
    id: occurrence.id,
    entered,
    diceChanged,
    defIdChanged,
    dice: Array.from(occurrence.dice),
    defId: occurrence.defId
  };
}

/**
 * Works out what an edit changes in a character's traits, so that the checks against the game
 * configuration look only at what changed (ADR-037 point 2). Entries are matched by id across
 * all trait sets and the free traits, because an edit replaces a set's whole list of entries.
 * Pure: no Foundry, no game configuration, and it never changes its inputs.
 *
 * An entry is reported when it entered a place (a new entry, or one moved into another set or
 * into or out of the free traits), when its dice differ as a multiset, or when it points at a
 * definition id that needs checking. Names, and entries that only moved within their list, are
 * never reported. Die sizes are not checked here: a changed [7] is reported like any rating.
 *
 * An id that occurs more than once in the proposed data is accepted only if its copies form a
 * multiset subset of the earlier copies of that id (ADR-038): each matches a different earlier
 * copy with the same place, definition id (missing counts as null) and dice as a multiset, in
 * any order. A legacy duplicate can thus shrink over several edits, but a group that stays
 * duplicated can't hold any combination of place, definition id and dice more often than before.
 * Such a group is not reported, and its id isn't in removedEntryIds, because it is still there.
 * Any other duplicate is refused. A group reduced to one copy compares it with the earlier copies
 * at its place, as above; an id with no copies left is listed as removed. Only the resulting
 * copies are compared, not how they came about: a removal alone and an edit plus a removal that
 * leave the same copies give the same answer, an ambiguity ADR-038 accepts. An empty result
 * therefore doesn't mean the proposed data equals the current data.
 * @param {import("./types.mjs").CharacterTraitData} current - the stored data before the edit
 * @param {import("./types.mjs").CharacterTraitData} proposed - the complete data after the edit
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").TraitChanges>} refuses,
 *   checked in this order: INVALID_TRAIT_DATA (either state isn't shaped like trait data, or an
 *   id isn't 16 letters or digits), DUPLICATE_TRAIT_ID (a duplicate group that isn't a subset of
 *   the earlier copies of its id; a new duplicate never is)
 */
export function diffCharacterTraits(current, proposed) {
  if ( !traitDataWellFormed(current) || !traitDataWellFormed(proposed) ) return fail("INVALID_TRAIT_DATA");

  const before = groupById(traitOccurrences(current));
  const afterList = traitOccurrences(proposed);
  const after = groupById(afterList);
  for ( const [id, group] of after ) {
    if ( (group.length > 1) && !sameGroup(group, before.get(id) ?? []) ) return fail("DUPLICATE_TRAIT_ID");
  }

  const entries = [];
  for ( const occurrence of afterList ) {
    if ( after.get(occurrence.id).length > 1 ) continue; // a subset of the earlier copies, checked above
    const change = entryChange(occurrence, before.get(occurrence.id) ?? []);
    if ( change ) entries.push(change);
  }

  return ok({
    kindChanged: current.kindId !== proposed.kindId,
    kindId: proposed.kindId,
    addedSetIds: Object.keys(proposed.traits).filter(setId => !Object.hasOwn(current.traits, setId)),
    removedSetIds: Object.keys(current.traits).filter(setId => !Object.hasOwn(proposed.traits, setId)),
    entries,
    removedEntryIds: [...before.keys()].filter(id => !after.has(id))
  });
}
