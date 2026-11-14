/**
 * What the character sheet shows of a character's trait sets, and how the sheet's rating inputs
 * become the trait changes of an update (Roadmap M2; Traits & Trait Sets spec; Decisions
 * ADR-031, ADR-033, ADR-034 and ADR-037). Sheet layout, not rules: the dice a trait gives come
 * from effectiveRating, the hints from ratingGuidance, and whether an edit may be written is
 * checkCharacterUpdate's decision, which the sheet asks before every write. Everything comes from
 * the game configuration (ADR-030), so a set the GM adds or renames shows without a code change.
 * Pure: no Foundry globals and imports only from module/rules/ (checked by
 * tests/unit/rules-boundary.test.mjs). Never changes its inputs.
 * @module apps/character-sheet-data
 */

import { fail, ok } from "../rules/result.mjs";
import { actorKindById, traitSetById } from "../rules/game-config.mjs";
import { ratingGuidance } from "../rules/sheet-hints.mjs";
import { effectiveRating } from "../rules/trait-pool.mjs";
import { DIE_SIZES } from "../rules/types.mjs";

/** The top-level name of the sheet's rating inputs: `ratings.<setId>.<entryId>.<dieIndex>`. */
export const RATING_INPUTS = "ratings";

/**
 * @typedef {object} RatingSlot
 * @property {string} inputName - the select's name
 * @property {number} index - the die's place in the rating
 * @property {import("../rules/types.mjs").DieSize|null} value - the stored die, null for a blank slot
 * @property {boolean} adds - a blank slot after the stored dice, which adds a die
 * @property {{value: number, label: string, selected: boolean}[]} options - one per die size
 */

/**
 * @typedef {object} SheetTrait
 * @property {string|null} entryId - the stored entry; null for a fixed set's trait the actor
 *   holds no entry for
 * @property {string} name - a fixed set's current definition name (TS-E04), or an open set's
 *   stored name
 * @property {import("../rules/types.mjs").DieSize[]} dice - the stored rating
 * @property {boolean} editable - a stored entry in a set with dice: the sheet offers its rating
 * @property {RatingSlot[]} slots - one per stored die, plus a blank slot when the rating is empty
 *   or its set allows several dice; empty when not editable
 * @property {import("../rules/types.mjs").DieSize|null} fallbackDie - the die an empty rating
 *   counts as (rule 8, TS-03), or null
 * @property {boolean} unrated - empty, with no fallback (TS-04)
 * @property {boolean} noDice - the set has no dice (rule 3)
 * @property {string[]} hints - ratingGuidance's codes (rule 9, ADR-037 point 5)
 * @property {boolean} shutDown - the trait or its whole set is flagged shut down (rule 15)
 */

/**
 * @typedef {object} SheetSet
 * @property {string} id
 * @property {string} name - as the game configuration names it
 * @property {boolean} hasDice
 * @property {boolean} multiDice
 * @property {boolean} shutDown - the whole set is flagged shut down (rule 15)
 * @property {SheetTrait[]} traits
 */

/**
 * @typedef {object} SheetView
 * @property {"unassigned"|"unknown"|"assigned"} kindStatus - no kind yet, a kind the
 *   configuration doesn't have, or a known kind
 * @property {{id: string, name: string}|null} kind
 * @property {SheetSet[]} sets
 */

/** @returns {boolean} whether value is a plain object, not an array, class instance or null */
function isPlainObject(value) {
  if ( (value === null) || (typeof value !== "object") ) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype) || (proto === null);
}

/**
 * A deep copy of plain data that leaves out keys whose value is undefined, as storing does. A
 * data model's toObject() keeps such keys for optional fields it leaves unset.
 * @param {unknown} value
 * @returns {unknown}
 */
function copyStored(value) {
  if ( Array.isArray(value) ) return value.map(copyStored);
  if ( !isPlainObject(value) ) return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, copyStored(v)]));
}

/** @returns {number[]} the stored rating as a list, [] for anything else */
function storedDice(entry) {
  return Array.isArray(entry?.dice) ? entry.dice : [];
}

/**
 * The rating inputs of one trait: a select per stored die, and a blank one that adds a die
 * when the rating is empty or the set allows several dice. A rating with more dice than its set
 * now allows gets a select for each, so nothing stored is hidden (ADR-037 point 5).
 * @param {object} set
 * @param {string} entryId
 * @param {number[]} dice
 * @returns {RatingSlot[]}
 */
function ratingSlots(set, entryId, dice) {
  const slot = (index, value) => ({
    inputName: `${RATING_INPUTS}.${set.id}.${entryId}.${index}`,
    index,
    value,
    adds: value === null,
    options: DIE_SIZES.map(size => ({ value: size, label: `d${size}`, selected: size === value }))
  });
  const slots = dice.map((size, index) => slot(index, size));
  if ( (dice.length === 0) || set.multiDice ) slots.push(slot(dice.length, null));
  return slots;
}

/**
 * One trait row of the sheet.
 * @param {object} set - the set's definition
 * @param {object|null} def - a fixed set's definition, null in an open set
 * @param {object|null} entry - what the actor stores, or null
 * @param {boolean} setShutDown
 * @returns {SheetTrait}
 */
function traitRow(set, def, entry, setShutDown) {
  const dice = storedDice(entry);
  const editable = (entry !== null) && (set.hasDice === true) && (typeof entry.id === "string");
  const rating = effectiveRating(set, def, entry);
  const hints = ratingGuidance(set, dice);
  return {
    entryId: entry?.id ?? null,
    name: def?.name ?? ((typeof entry?.name === "string") ? entry.name : ""),
    dice: [...dice],
    editable,
    slots: editable ? ratingSlots(set, entry.id, dice) : [],
    fallbackDie: (rating.ok && rating.value.isFallback) ? rating.value.dice[0] : null,
    unrated: !rating.ok && (rating.code === "TRAIT_UNRATED"),
    noDice: set.hasDice !== true,
    hints: hints.ok ? hints.value : [],
    shutDown: setShutDown || isPlainObject(entry?.shutDown)
  };
}

/**
 * What the sheet shows: the trait sets of the character's actor kind, in the kind's order and
 * named as the configuration names them (ADR-031). A fixed set lists its definitions in the
 * configuration's order, each with the actor's entry for it (by definition id, ADR-034) or none;
 * a definition without an entry shows its fallback die or that it is unrated, and gets no input
 * in this slice. An open set lists the actor's entries in stored order. Only stored entries are
 * edited, and only their rating. Not shown yet: free traits (TS-22), sets the kind doesn't
 * include, and entries no definition matches (TS-E03); they are kept as stored when the sheet
 * writes.
 * @param {import("../rules/types.mjs").CharacterTraitData} system - the actor's system data
 * @param {import("../rules/types.mjs").GameConfig} config - the current game configuration
 * @returns {SheetView}
 */
export function characterSheetView(system, config) {
  const kindId = system?.kindId ?? null;
  if ( kindId === null ) return { kindStatus: "unassigned", kind: null, sets: [] };
  const kind = Array.isArray(config?.actorKinds) ? actorKindById(config, kindId) : null;
  if ( !kind ) return { kindStatus: "unknown", kind: null, sets: [] };

  const sets = (Array.isArray(kind.traitSetIds) ? kind.traitSetIds : [])
    .map(setId => traitSetById(config, setId))
    .filter(isPlainObject)
    .map(set => {
      const stored = isPlainObject(system.traits?.[set.id]) ? system.traits[set.id] : {};
      const entries = Array.isArray(stored.entries) ? stored.entries.filter(isPlainObject) : [];
      const setShutDown = stored.shutDown === true;
      const traits = (set.list === "fixed")
        ? (Array.isArray(set.traits) ? set.traits : []).filter(isPlainObject).map(def => {
          return traitRow(set, def, entries.find(entry => entry.defId === def.id) ?? null, setShutDown);
        })
        : entries.map(entry => traitRow(set, null, entry, setShutDown));
      return {
        id: set.id, name: set.name, hasDice: set.hasDice === true, multiDice: set.multiDice === true,
        shutDown: setShutDown, traits
      };
    });
  return { kindStatus: "assigned", kind: { id: kind.id, name: kind.name }, sets };
}

/**
 * Reads one rating input: blank means no die in that place.
 * @param {unknown} value - a select's value as the form gives it: text, a number or null
 * @returns {import("../rules/types.mjs").EngineResult<number|null>}
 */
function inputDie(value) {
  if ( (value === "") || (value === null) || (value === undefined) ) return ok(null);
  const size = (typeof value === "string") ? Number(value) : value;
  return DIE_SIZES.includes(size) ? ok(size) : fail("INVALID_DIE_SIZE");
}

/**
 * The dice of one entry's inputs, in die order; blank inputs are left out.
 * @param {unknown} inputs - die index to value, as an object or a list
 * @returns {import("../rules/types.mjs").EngineResult<number[]>}
 */
function inputRating(inputs) {
  const pairs = Array.isArray(inputs) ? inputs.map((value, index) => [index, value])
    : isPlainObject(inputs) ? Object.entries(inputs).map(([index, value]) => [Number(index), value]) : null;
  if ( !pairs || pairs.some(([index]) => !Number.isInteger(index) || (index < 0)) ) return fail("INVALID_TRAIT_DATA");
  const dice = [];
  for ( const [, value] of pairs.sort((a, b) => a[0] - b[0]) ) {
    const die = inputDie(value);
    if ( !die.ok ) return die;
    if ( die.value !== null ) dice.push(die.value);
  }
  return ok(dice);
}

/** @returns {boolean} whether two ratings hold the same dice in the same order */
function sameDice(a, b) {
  return (a.length === b.length) && a.every((size, i) => size === b[i]);
}

/**
 * Turns the sheet's rating inputs into the trait changes of an update. Every set whose ratings
 * changed gets its whole stored entries list back with only those ratings replaced, because a
 * sheet write replaces a set's entries and they are compared by id (ADR-037 point 3). So what an
 * entry holds beside its rating (statement, challenge, SFX, tags, sub-traits, shut-down reason)
 * and entries the sheet doesn't show are kept as stored. Inputs for a set or an entry the actor
 * doesn't hold (for example one removed since the sheet rendered) are ignored. The dice keep the
 * inputs' order; a blank input leaves its die out. Whether the new ratings fit their sets is not
 * checked here: the sheet passes the result to checkCharacterUpdate before writing.
 * @param {import("../rules/types.mjs").CharacterTraitData} system - the stored system data, read
 *   when the form is submitted
 * @param {unknown} inputs - the form's `ratings` object: set id → entry id → die index → value;
 *   undefined when the form has no rating inputs
 * @returns {import("../rules/types.mjs").EngineResult<Record<string, {entries: object[]}>>} the
 *   changed sets by id, an empty object when nothing changed; refuses INVALID_TRAIT_DATA (inputs
 *   not shaped as above) and INVALID_DIE_SIZE (a value that isn't a die size or blank)
 */
export function traitChangesFromInputs(system, inputs) {
  if ( inputs === undefined ) return ok({});
  if ( !isPlainObject(inputs) ) return fail("INVALID_TRAIT_DATA");
  const changes = {};
  for ( const [setId, byEntry] of Object.entries(inputs) ) {
    if ( !isPlainObject(byEntry) ) return fail("INVALID_TRAIT_DATA");
    const stored = system?.traits?.[setId];
    const entries = Array.isArray(stored?.entries) ? stored.entries : null;
    let changed = false;
    const ratings = new Map();
    for ( const [entryId, dieInputs] of Object.entries(byEntry) ) {
      const rating = inputRating(dieInputs);
      if ( !rating.ok ) return rating;
      ratings.set(entryId, rating.value);
    }
    if ( !entries ) continue;
    const updated = entries.map(entry => {
      const copy = copyStored(entry);
      if ( !isPlainObject(entry) || !ratings.has(entry.id) ) return copy;
      const dice = ratings.get(entry.id);
      if ( sameDice(dice, storedDice(entry)) ) return copy;
      changed = true;
      return { ...copy, dice };
    });
    if ( changed ) changes[setId] = { entries: updated };
  }
  return ok(changes);
}
