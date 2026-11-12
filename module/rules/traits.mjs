/**
 * Traits, their ratings, what an edit changes in a character's traits, and whether those changes
 * fit the game configuration (Traits & Trait Sets spec, Decisions ADR-037 and ADR-038). Every
 * function here returns an EngineResult instead of throwing (Decisions ADR-025).
 * @module rules/traits
 */

import { fail, ok } from "./result.mjs";
import { actorKindById, ratingOptionsOf, traitDefById, traitSetById } from "./game-config.mjs";
import { DIE_SIZES, SHUT_DOWN_REASONS } from "./types.mjs";

/**
 * Checks a trait's rating: a list of die sizes (ADR-033), several for mobs, bosses, resources
 * and the like (rule 2), none for a trait with no die (rule 3). This is technical validation,
 * which ADR-029 keeps enforced: every entry must be a size on the step ladder (TS-E01), and the
 * rating must fit its set's shape (ADR-037 point 2): a set without dice refuses any die, a set
 * with one die per trait refuses more, and a set whose traits need dice of one size refuses a
 * mix (TS-E02). An empty rating passes whatever the options, which restrict only the dice a
 * rating holds. Nothing is coerced, so a rating that isn't an array, an entry that isn't one of
 * the DIE_SIZES numbers, or an empty slot is refused. A set's usual range is guidance for the
 * sheet, not checked here (rule 9).
 * @param {unknown} dice
 * @param {{hasDice?: boolean, multiDice?: boolean, sameSizeDice?: boolean}} [options] - an
 *   object, or left out. Each option is true, false, left out or `undefined`, and left out or
 *   `undefined` allows: `hasDice: false` refuses any die, `multiDice: false` refuses more than
 *   one, and `sameSizeDice: true` refuses mixed sizes. Any combination is accepted; the first
 *   check that fails decides.
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").DieSize[]>} a copy of the
 *   rating; refuses, checked in this order: INVALID_RATING_OPTIONS (options that aren't an
 *   object, or an option that isn't a boolean: a calling error, not a rule), INVALID_DIE_SIZE,
 *   RATING_DICE_NOT_ALLOWED, RATING_TOO_MANY_DICE, RATING_MIXED_SIZES
 */
export function validateRating(dice, options = {}) {
  if ( (typeof options !== "object") || (options === null) || Array.isArray(options) ) {
    return fail("INVALID_RATING_OPTIONS");
  }
  const { hasDice = true, multiDice = true, sameSizeDice = false } = options;
  if ( [hasDice, multiDice, sameSizeDice].some(flag => typeof flag !== "boolean") ) {
    return fail("INVALID_RATING_OPTIONS");
  }
  if ( !Array.isArray(dice) ) return fail("INVALID_DIE_SIZE");
  // An indexed loop, not some(), so an empty slot is checked rather than skipped.
  for ( let i = 0; i < dice.length; i++ ) {
    if ( !DIE_SIZES.includes(dice[i]) ) return fail("INVALID_DIE_SIZE");
  }
  if ( !hasDice && (dice.length > 0) ) return fail("RATING_DICE_NOT_ALLOWED");
  if ( !multiDice && (dice.length > 1) ) return fail("RATING_TOO_MANY_DICE");
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

/** @returns {boolean} whether value is null or an id in the character data's format */
function isIdOrNull(value) {
  return (value === null) || isTraitId(value);
}

/**
 * Whether changes has the shape diffCharacterTraits returns, as far as validateTraitChanges
 * reads it.
 * @param {unknown} changes
 * @returns {boolean}
 */
function traitChangesWellFormed(changes) {
  if ( !isPlainObject(changes) ) return false;
  if ( (typeof changes.kindChanged !== "boolean") || !isIdOrNull(changes.kindId) ) return false;
  if ( !Array.isArray(changes.addedSetIds) || !Array.isArray(changes.entries) ) return false;
  for ( let i = 0; i < changes.addedSetIds.length; i++ ) {
    if ( !isTraitId(changes.addedSetIds[i]) ) return false;
  }
  for ( let i = 0; i < changes.entries.length; i++ ) {
    const entry = changes.entries[i];
    if ( !isPlainObject(entry) || !isTraitId(entry.id) || !isIdOrNull(entry.setId) || !isIdOrNull(entry.defId) ) return false;
    if ( !Array.isArray(entry.dice) || (typeof entry.entered !== "boolean") ) return false;
    if ( (typeof entry.diceChanged !== "boolean") || (typeof entry.defIdChanged !== "boolean") ) return false;
  }
  return true;
}

/**
 * Checks what an edit changes against the current game configuration (ADR-037 point 2): every
 * new or changed rating, and every new or changed reference. Takes the output of
 * diffCharacterTraits, so ratings and references the edit didn't touch are never checked again:
 * a stored rating that no longer fits its set doesn't stop an unrelated edit (point 5), nor does
 * a stored kind, set or definition the configuration no longer has (point 1).
 *
 * The order: first every changed rating's die sizes, because a size that doesn't exist is data
 * that can't exist (TS-E01); then the shape of each changed rating against its set, in the
 * diff's order (for a free trait (TS-22), or an entry the edit left in a set the configuration
 * no longer has, there is no shape to check: ADR-037 leaves such edits at the schema check);
 * then the references, in the order ADR-037 lists them: a kind the edit sets (clearing it to
 * none is always allowed), a set key the edit adds or an entry it puts into a set the
 * configuration doesn't have (a new broken reference, ADR-029 point 2), and a definition id the
 * edit sets on an entry of a set the configuration has. An open set has no definitions
 * (ADR-034), so any definition id there is unknown. Whether a set or a free trait belongs to the
 * actor's kind is a hint for the sheet, never a refusal (ADR-029).
 * @param {import("./types.mjs").TraitChanges} changes - from diffCharacterTraits
 * @param {import("./types.mjs").GameConfig} config - a configuration validateGameConfig accepts;
 *   only its lists are checked here, and a set with malformed shape options gives
 *   INVALID_RATING_OPTIONS
 * @returns {import("./types.mjs").EngineResult<{checkedEntryIds: string[]}>} the ids of the
 *   entries whose rating or definition was checked against the configuration or for die sizes;
 *   refuses, in this order: INVALID_TRAIT_DATA (changes not shaped like a diff),
 *   INVALID_GAME_CONFIG (no lists of sets and kinds), INVALID_DIE_SIZE, then the first of
 *   RATING_DICE_NOT_ALLOWED, RATING_TOO_MANY_DICE, RATING_MIXED_SIZES over the entries, then
 *   UNKNOWN_ACTOR_KIND, UNKNOWN_TRAIT_SET, UNKNOWN_TRAIT_DEFINITION
 */
export function validateTraitChanges(changes, config) {
  if ( !traitChangesWellFormed(changes) ) return fail("INVALID_TRAIT_DATA");
  if ( !isPlainObject(config) || !Array.isArray(config.traitSets) || !Array.isArray(config.actorKinds) ) {
    return fail("INVALID_GAME_CONFIG");
  }
  const checked = new Set();
  const setOf = entry => ((entry.setId === null) ? null : traitSetById(config, entry.setId));

  for ( const entry of changes.entries ) {
    if ( !entry.diceChanged ) continue;
    checked.add(entry.id);
    const sizes = validateRating(entry.dice);
    if ( !sizes.ok ) return sizes;
  }
  for ( const entry of changes.entries ) {
    const set = setOf(entry);
    if ( !entry.diceChanged || !set ) continue;
    const shape = validateRating(entry.dice, ratingOptionsOf(set));
    if ( !shape.ok ) return shape;
  }

  if ( changes.kindChanged && (changes.kindId !== null) && !actorKindById(config, changes.kindId) ) {
    return fail("UNKNOWN_ACTOR_KIND");
  }
  if ( changes.addedSetIds.some(setId => !traitSetById(config, setId)) ) return fail("UNKNOWN_TRAIT_SET");
  if ( changes.entries.some(entry => entry.entered && (entry.setId !== null) && !setOf(entry)) ) {
    return fail("UNKNOWN_TRAIT_SET");
  }
  for ( const entry of changes.entries ) {
    const set = setOf(entry);
    if ( !entry.defIdChanged || !set ) continue;
    checked.add(entry.id);
    if ( !traitDefById(set, entry.defId) ) return fail("UNKNOWN_TRAIT_DEFINITION");
  }

  return ok({ checkedEntryIds: changes.entries.map(entry => entry.id).filter(id => checked.has(id)) });
}

/**
 * Whether an entry's sub-traits can be read: absent, or a list of objects with an id.
 * @param {unknown} sub
 * @returns {boolean}
 */
function subTraitsWellFormed(sub) {
  if ( sub === undefined ) return true;
  if ( !Array.isArray(sub) ) return false;
  for ( let i = 0; i < sub.length; i++ ) {
    if ( !isPlainObject(sub[i]) || !isTraitId(sub[i].id) ) return false;
  }
  return true;
}

/**
 * The first problem with the statement fields of a trait entry, as the statement functions read
 * them (rule 16; module/rules/statements.mjs): `challenged` is a boolean when present; a
 * challenged entry's `preChallengeDice` is a rating with at least one die, its rating from before
 * the first unresolved challenge (RQ-022); `shutDown` is absent or `{reason}` with one of
 * SHUT_DOWN_REASONS. An unchallenged entry's `preChallengeDice` is left unread, because a challenge
 * replaces it. The entry's own rating isn't read. Every INVALID_TRAIT_DATA check comes before the
 * saved rating's die sizes, so a die-size problem never hides a malformed field.
 * @param {object} entry - a plain object; the caller checks that first
 * @returns {string|null} INVALID_TRAIT_DATA or INVALID_DIE_SIZE, or null when the fields are well
 *   formed
 */
export function statementFieldsProblem(entry) {
  if ( (entry.challenged !== undefined) && (typeof entry.challenged !== "boolean") ) return "INVALID_TRAIT_DATA";
  if ( (entry.shutDown !== undefined)
    && !(isPlainObject(entry.shutDown) && SHUT_DOWN_REASONS.includes(entry.shutDown.reason)) ) return "INVALID_TRAIT_DATA";
  if ( entry.challenged ) {
    if ( !Array.isArray(entry.preChallengeDice) ) return "INVALID_TRAIT_DATA";
    const saved = validateRating(entry.preChallengeDice);
    if ( !saved.ok ) return saved.code;
    if ( saved.value.length === 0 ) return "INVALID_TRAIT_DATA";
  }
  return null;
}

/** @returns {boolean} whether two values are both absent, or both ratings with the same dice */
function sameOptionalDice(a, b) {
  if ( (a === undefined) || (b === undefined) ) return a === b;
  return Array.isArray(a) && Array.isArray(b) && sameDice(a, b);
}

/** @returns {boolean} whether two entries agree on their statement fields as statementFieldsProblem reads them */
function sameStatementFields(a, b) {
  return (a.challenged === b.challenged) && sameOptionalDice(a.preChallengeDice, b.preChallengeDice)
    && ((a.shutDown === undefined) === (b.shutDown === undefined)) && (a.shutDown?.reason === b.shutDown?.reason);
}

/** @returns {object[]} a stored entry's sub-traits that can be compared: objects in a list */
function readableSubTraits(entry) {
  return Array.isArray(entry.sub) ? entry.sub.filter(isPlainObject) : [];
}

/** @returns {boolean} whether value is absent or text */
function optionalText(value) {
  return (value === undefined) || (typeof value === "string");
}

/**
 * Whether a list of SFX can be stored: absent, or a list of `{text, unlocked}` whose text is
 * absent or text and whose unlocked flag is a boolean. The flag has no default (ADR-046 point 3).
 * @param {unknown} sfx
 * @returns {boolean}
 */
function sfxWellFormed(sfx) {
  if ( sfx === undefined ) return true;
  if ( !Array.isArray(sfx) ) return false;
  for ( let i = 0; i < sfx.length; i++ ) {
    if ( !isPlainObject(sfx[i]) || !optionalText(sfx[i].text) || (typeof sfx[i].unlocked !== "boolean") ) return false;
  }
  return true;
}

/**
 * Whether a set entry's plain fields can be stored (ADR-046 point 4): its name, description and
 * statement are absent or text, its SFX are well formed, its tags are absent or a list of text,
 * and each sub-trait's name is absent or text and its rating a list. The sub-traits' ids and die
 * sizes are checked elsewhere.
 * @param {object} entry - a plain object
 * @returns {boolean}
 */
function entryPlainFieldsWellFormed(entry) {
  if ( !optionalText(entry.name) || !optionalText(entry.description) || !optionalText(entry.statement) ) return false;
  if ( !sfxWellFormed(entry.sfx) ) return false;
  if ( entry.tags !== undefined ) {
    if ( !Array.isArray(entry.tags) ) return false;
    for ( let i = 0; i < entry.tags.length; i++ ) {
      if ( typeof entry.tags[i] !== "string" ) return false;
    }
  }
  for ( const sub of entry.sub ?? [] ) {
    if ( !optionalText(sub.name) || !Array.isArray(sub.dice) ) return false;
  }
  return true;
}

/** @returns {boolean} whether two plain values hold the same data, key order included */
function samePlain(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The plain fields of a set entry, as entryPlainFieldsWellFormed reads them. */
const ENTRY_PLAIN_FIELDS = Object.freeze(["name", "description", "statement", "sfx", "tags", "sub"]);

/** @returns {boolean} whether two entries hold the same plain fields */
function sameEntryPlainFields(a, b) {
  return ENTRY_PLAIN_FIELDS.every(field => samePlain(a[field], b[field]));
}

/**
 * Checks the fields of the set entries an edit sets, beyond their own rating, definition and
 * name (which diffCharacterTraits and validateTraitChanges check):
 * - the statement fields (rule 16; statementFieldsProblem), so that a challenge the statement
 *   functions couldn't resolve, such as `challenged` without a saved rating, is refused visibly
 *   instead of being stored, and a malformed value Foundry would drop without an error is
 *   refused visibly (ADR-037 point 3);
 * - the die sizes of the other ratings an entry holds: `preChallengeDice` (RQ-022) and each
 *   sub-trait's rating (rule 19). A die size that doesn't exist is refused (TS-E01), as for any
 *   rating, because Foundry drops a list holding one without an error;
 * - the plain fields (ADR-046 point 4): an entry's name, description, statement, SFX, tags and
 *   sub-trait names, a set's shut-down flag and its own SFX (point 5), and a free trait's name.
 *   A value the schema couldn't store, such as an SFX without its unlocked flag or a tag that
 *   isn't text, is refused visibly: Foundry would otherwise drop the whole list it sits in
 *   without an error, and with it every other change to that set's entries.
 * A field counts as set by the edit unless an entry with the same id in the same set already
 * holds the same value (for a sub-trait: a sub-trait with the same id and the same dice as a
 * multiset), so what the edit leaves as stored is never checked again (ADR-037 point 2), and what
 * moves with its entry to another set is. Only the proposed data's shape is checked; the stored
 * data is read only to find what stayed the same, so a stored problem never stops an edit that
 * repairs it.
 *
 * Only die sizes are checked, never a set's shape. `preChallengeDice` is a past rating, which may
 * no longer fit its set after a configuration change and is kept all the same (ADR-037 point 5).
 * A sub-trait's rating gets the die-size check only: the parent set's rating options don't apply
 * to it (ADR-046 point 1; Handbook p. 59), and ADR-029 point 2 refuses only data that can't
 * exist. Free traits hold an id, a name and a rating; only the name is read here. Pure; never
 * changes its inputs.
 * @param {import("./types.mjs").CharacterTraitData} current - the stored data before the edit
 * @param {import("./types.mjs").CharacterTraitData} proposed - the trait data after the edit
 * @returns {import("./types.mjs").EngineResult<{checked: {setId: string, entryId: string,
 *   subId: string|null, field: "preChallengeDice"|"sub"}[]}>} the ratings whose die sizes were
 *   checked, in proposed order (sets in key order, entries in array order, an entry's
 *   preChallengeDice before its sub-traits); refuses, in this order: INVALID_TRAIT_DATA (either
 *   state isn't shaped like trait data, an entry's sub-traits aren't a list of objects with ids,
 *   or a statement field or plain field the edit sets is malformed), INVALID_DIE_SIZE
 */
export function validateEntryFields(current, proposed) {
  if ( !traitDataWellFormed(current) || !traitDataWellFormed(proposed) ) return fail("INVALID_TRAIT_DATA");
  const earlierOf = (setId, entry) => (current.traits[setId]?.entries ?? []).filter(e => e.id === entry.id);

  for ( const [setId, set] of Object.entries(proposed.traits) ) {
    const storedSet = current.traits[setId];
    if ( (set.shutDown !== storedSet?.shutDown) && (set.shutDown !== undefined) && (typeof set.shutDown !== "boolean") ) {
      return fail("INVALID_TRAIT_DATA");
    }
    if ( !samePlain(set.sfx, storedSet?.sfx) && !sfxWellFormed(set.sfx) ) return fail("INVALID_TRAIT_DATA");
    for ( const entry of set.entries ) {
      if ( !subTraitsWellFormed(entry.sub) ) return fail("INVALID_TRAIT_DATA");
      const earlier = earlierOf(setId, entry);
      if ( !earlier.some(e => sameEntryPlainFields(e, entry)) && !entryPlainFieldsWellFormed(entry) ) {
        return fail("INVALID_TRAIT_DATA");
      }
      if ( earlier.some(e => sameStatementFields(e, entry)) ) continue;
      if ( statementFieldsProblem(entry) === "INVALID_TRAIT_DATA" ) return fail("INVALID_TRAIT_DATA");
    }
  }
  for ( const free of proposed.freeTraits ) {
    const kept = current.freeTraits.some(e => (e.id === free.id) && (e.name === free.name));
    if ( !kept && !optionalText(free.name) ) return fail("INVALID_TRAIT_DATA");
  }

  const checked = [];
  for ( const [setId, set] of Object.entries(proposed.traits) ) {
    for ( const entry of set.entries ) {
      const earlier = earlierOf(setId, entry);
      if ( entry.preChallengeDice !== undefined ) {
        const kept = earlier.some(e => Array.isArray(e.preChallengeDice) && Array.isArray(entry.preChallengeDice)
          && sameDice(e.preChallengeDice, entry.preChallengeDice));
        if ( !kept ) {
          const sizes = validateRating(entry.preChallengeDice);
          if ( !sizes.ok ) return sizes;
          checked.push({ setId, entryId: entry.id, subId: null, field: "preChallengeDice" });
        }
      }
      for ( const sub of entry.sub ?? [] ) {
        const kept = earlier.some(e => readableSubTraits(e).some(s => (s.id === sub.id) && Array.isArray(s.dice)
          && Array.isArray(sub.dice) && sameDice(s.dice, sub.dice)));
        if ( kept ) continue;
        const sizes = validateRating(sub.dice);
        if ( !sizes.ok ) return sizes;
        checked.push({ setId, entryId: entry.id, subId: sub.id, field: "sub" });
      }
    }
  }
  return ok({ checked });
}

/**
 * Checks an edit of a character's traits from its stored data to the data it would have
 * afterwards: what changed (diffCharacterTraits), the entries' other fields the edit sets
 * (validateEntryFields), then whether the changes fit the configuration (validateTraitChanges).
 * Die sizes come before set shapes, as in validateTraitChanges. This is the check ADR-037 point 3
 * puts before every write of our apps and in the character model's update backstop. Creating an
 * actor, a replacing update and the system's own migrations count as loading (point 4) and don't
 * come here. Statement and SFX text, tags, descriptions and shut-down flags are checked for
 * their type only (ADR-046 point 4), never against the configuration (ADR-029).
 * @param {import("./types.mjs").CharacterTraitData} current
 * @param {import("./types.mjs").CharacterTraitData} proposed
 * @param {import("./types.mjs").GameConfig} config
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").TraitChanges>} the diff;
 *   refuses with the diff's codes, then validateEntryFields's, then validateTraitChanges's
 */
export function checkCharacterEdit(current, proposed, config) {
  const diff = diffCharacterTraits(current, proposed);
  if ( !diff.ok ) return diff;
  const fields = validateEntryFields(current, proposed);
  if ( !fields.ok ) return fields;
  const checked = validateTraitChanges(diff.value, config);
  return checked.ok ? diff : checked;
}

/**
 * Splits keys written with dots ("traits.abc.entries") into nested objects, one level at a
 * time, as Foundry's cleaning does before an update reaches the data model. Returns a new object;
 * a later key for the same path wins, as in Foundry's expansion.
 * @param {object} object - a plain object
 * @returns {object}
 */
function expandDotted(object) {
  const expanded = {};
  for ( const [key, value] of Object.entries(object) ) {
    const [head, ...rest] = key.split(".");
    if ( !rest.length ) {
      expanded[head] = value;
      continue;
    }
    const inner = isPlainObject(expanded[head]) ? expanded[head] : {};
    expanded[head] = { ...inner, [rest.join(".")]: value };
  }
  return expanded;
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
 * A copy of a value with every operator inside it applied, as Foundry applies the operators
 * nested in a forced replacement's value (common/utils/helpers.mjs `applyDataOperators`): a
 * forced deletion removes its key, a forced replacement gives its value.
 * @param {unknown} value
 * @param {(value: unknown) => ({deletion: true}|{replacement: unknown}|null)} operatorOf
 * @returns {unknown}
 */
function withOperatorsApplied(value, operatorOf) {
  const operator = operatorOf(value);
  if ( operator && ("replacement" in operator) ) return withOperatorsApplied(operator.replacement, operatorOf);
  if ( Array.isArray(value) ) return value.map(v => withOperatorsApplied(v, operatorOf));
  if ( !isPlainObject(value) ) return value;
  const copy = {};
  for ( const [key, inner] of Object.entries(value) ) {
    const innerOperator = operatorOf(inner);
    if ( innerOperator && ("deletion" in innerOperator) ) continue;
    copy[key] = withOperatorsApplied(inner, operatorOf);
  }
  return copy;
}

/**
 * The value a field takes from one update value: a forced deletion leaves it undefined, a
 * forced replacement sets the given value without merging, anything else is the value itself.
 * @param {unknown} value
 * @param {(value: unknown) => ({deletion: true}|{replacement: unknown}|null)} operatorOf
 * @returns {{set: unknown}|{merge: object}} merge only for a plain object, which the caller merges
 */
function readUpdateValue(value, operatorOf) {
  const operator = operatorOf(value);
  if ( operator && ("deletion" in operator) ) return { set: undefined };
  if ( operator && ("replacement" in operator) ) return { set: withOperatorsApplied(operator.replacement, operatorOf) };
  if ( isPlainObject(value) ) return { merge: expandDotted(value) };
  return { set: withOperatorsApplied(value, operatorOf) };
}

/**
 * Applies an update's system changes to a character's stored trait data and returns the trait
 * data the update would leave, as far as the edit checks read it (kind, entries, a set's
 * shut-down flag and own SFX, free traits; anything else in a set is kept as stored), for
 * checkCharacterEdit (ADR-037 point 3). It expects the
 * changes as Foundry passes them to `_preUpdate`: cleaned, so dotted keys are expanded, legacy
 * deletion and replacement keys are operators, nulls are reset to their initial values and form
 * input is cast (client/data/client-backend.mjs `#preUpdateDocumentArray`). Our apps clean their
 * changes the same way before calling it; raw form data can be refused where Foundry would
 * accept it. On such changes it follows how Foundry 14.369 applies an ordinary, recursive update
 * to the character schema (common/data/fields.mjs: SchemaField, TypedObjectField and ArrayField
 * `_updateDiff`):
 * - `kindId` and `freeTraits` take the given value; a list is always replaced whole.
 * - `traits` merges by set key: a key that is forcibly deleted removes the set, a plain object
 *   merges into the stored set (or starts an empty one), and anything else replaces the set.
 *   Within a set, `entries` is read and replaced whole, because every edit sends a set's whole
 *   list; so are the set's `shutDown` flag and its own `sfx` list, which validateEntryFields
 *   checks (a forced deletion of either leaves it absent).
 * - A forced replacement sets its value without merging, with the operators inside it applied;
 *   a forced deletion of a field other than a set key leaves it undefined, which the diff then
 *   refuses as malformed, as Foundry refuses the missing value.
 * - A forced replacement of the whole system data is a replacing update, which counts as loading
 *   (ADR-037 point 4); the result says so with `replaced: true` (see checkCharacterUpdate).
 * - Keys written with dots are still read as nested keys. Other system fields are ignored.
 * Foundry's operators are classes this layer can't see, so the caller passes `operatorOf`,
 * which says whether a value is a forced deletion or replacement; without it every value is
 * plain data. Replacing updates with `recursive: false` don't come here either.
 * @param {import("./types.mjs").CharacterTraitData} current - the stored trait data
 * @param {object|null|undefined} changes - the update's `system` changes; none means no change
 * @param {{operatorOf?: (value: unknown) => ({deletion: true}|{replacement: unknown}|null)}} [operators]
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").CharacterTraitData
 *   & {replaced?: true}>} a new object that shares nothing with the inputs; refuses with
 *   INVALID_TRAIT_DATA when the stored data or the changes aren't plain objects, or the whole
 *   system data is forcibly deleted
 */
export function proposedTraitData(current, changes, operators = {}) {
  const operatorOf = operators?.operatorOf ?? (() => null);
  if ( !isPlainObject(current) ) return fail("INVALID_TRAIT_DATA");
  const rootOperator = operatorOf(changes);
  if ( rootOperator && ("deletion" in rootOperator) ) return fail("INVALID_TRAIT_DATA");
  if ( rootOperator && ("replacement" in rootOperator) ) {
    const replacement = withOperatorsApplied(rootOperator.replacement, operatorOf);
    if ( !isPlainObject(replacement) ) return fail("INVALID_TRAIT_DATA");
    return ok({ kindId: replacement.kindId, traits: replacement.traits, freeTraits: replacement.freeTraits, replaced: true });
  }
  if ( (changes !== undefined) && (changes !== null) && !isPlainObject(changes) ) return fail("INVALID_TRAIT_DATA");
  const proposed = { kindId: current.kindId, traits: copyPlain(current.traits), freeTraits: copyPlain(current.freeTraits) };
  const update = changes ? expandDotted(changes) : {};

  for ( const key of ["kindId", "freeTraits"] ) {
    if ( !Object.hasOwn(update, key) ) continue;
    const read = readUpdateValue(update[key], operatorOf);
    proposed[key] = ("set" in read) ? read.set : withOperatorsApplied(read.merge, operatorOf);
  }

  if ( Object.hasOwn(update, "traits") ) {
    const read = readUpdateValue(update.traits, operatorOf);
    if ( "set" in read ) proposed.traits = read.set;
    else {
      const traits = isPlainObject(proposed.traits) ? proposed.traits : {};
      for ( const [setId, value] of Object.entries(read.merge) ) {
        const operator = operatorOf(value);
        if ( operator && ("deletion" in operator) ) {
          delete traits[setId];
          continue;
        }
        const setRead = readUpdateValue(value, operatorOf);
        if ( "set" in setRead ) {
          traits[setId] = setRead.set;
          continue;
        }
        const stored = isPlainObject(traits[setId]) ? traits[setId] : { entries: [] };
        const set = { ...stored };
        if ( Object.hasOwn(setRead.merge, "entries") ) {
          const entriesRead = readUpdateValue(setRead.merge.entries, operatorOf);
          set.entries = ("set" in entriesRead) ? entriesRead.set : withOperatorsApplied(entriesRead.merge, operatorOf);
        }
        for ( const key of ["shutDown", "sfx"] ) {
          if ( !Object.hasOwn(setRead.merge, key) ) continue;
          const read = readUpdateValue(setRead.merge[key], operatorOf);
          const value = ("set" in read) ? read.set : withOperatorsApplied(read.merge, operatorOf);
          if ( value === undefined ) delete set[key];
          else set[key] = value;
        }
        traits[setId] = set;
      }
      proposed.traits = traits;
    }
  }

  return ok(proposed);
}

/**
 * Checks an update before it is written: the complete trait data it would leave
 * (proposedTraitData), then that edit (checkCharacterEdit). What the character model's update
 * backstop calls (ADR-037 point 3). A forced replacement of the whole system data is a replacing
 * update and counts as loading (point 4): it gets no edit check here, and the result is null.
 * @param {import("./types.mjs").CharacterTraitData} current - the stored trait data
 * @param {object|null|undefined} changes - the update's `system` changes, cleaned as
 *   proposedTraitData expects
 * @param {import("./types.mjs").GameConfig} config
 * @param {Parameters<typeof proposedTraitData>[2]} [operators]
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").TraitChanges|null>} the
 *   diff, or null for a replacing update; refuses with proposedTraitData's code, then
 *   checkCharacterEdit's
 */
export function checkCharacterUpdate(current, changes, config, operators = {}) {
  const proposed = proposedTraitData(current, changes, operators);
  if ( !proposed.ok ) return proposed;
  if ( proposed.value.replaced ) return ok(null);
  return checkCharacterEdit(current, proposed.value, config);
}
