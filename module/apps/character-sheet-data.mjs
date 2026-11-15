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
import { actorKindById, traitDefById, traitSetById } from "../rules/game-config.mjs";
import { ratingGuidance } from "../rules/sheet-hints.mjs";
import { editStatement, resolveChallengedStatement } from "../rules/statements.mjs";
import { effectiveRating } from "../rules/trait-pool.mjs";
import { DIE_SIZES } from "../rules/types.mjs";

/** The top-level name of the sheet's rating inputs: `ratings.<setId>.<entryId>.<dieIndex>`. */
export const RATING_INPUTS = "ratings";

/**
 * The top-level name of the rating inputs of fixed-set traits the actor holds no entry for:
 * `newRatings.<setId>.<defId>.<dieIndex>`. Choosing a die there creates the entry.
 */
export const NEW_RATING_INPUTS = "newRatings";

/** The top-level name of the name inputs of open-set traits: `names.<setId>.<entryId>`. */
export const NAME_INPUTS = "names";

/** The top-level name of the statement inputs of set traits: `statements.<setId>.<entryId>`. */
export const STATEMENT_INPUTS = "statements";

/** The top-level name of the rating inputs of free traits: `freeRatings.<entryId>.<dieIndex>`. */
export const FREE_RATING_INPUTS = "freeRatings";

/** The top-level name of the name inputs of free traits: `freeNames.<entryId>`. */
export const FREE_NAME_INPUTS = "freeNames";

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
 * @property {boolean} ownShutDown - the trait itself is flagged shut down, whatever the flag holds
 * @property {"manual"|"statementChallenged"|null} shutDownReason - the reason of the trait's own
 *   shut-down, null when the trait itself isn't shut down or its flag has no readable reason
 *   (RQ-034: the sheet shows the reason)
 * @property {boolean} canShutDown - a stored entry whose own shut-down flag the sheet offers to
 *   set, in a set with the shut-down feature, or to clear, whenever it is set (behaviour 17)
 * @property {string|null} statement - the trait's statement where its set has the statements
 *   feature (rule 16), "" for none yet; null in a set without the feature
 * @property {string|null} statementInput - the name of the statement's input, for a stored entry
 *   in a set with the statements feature
 * @property {boolean} challenged - the statement is challenged and not yet resolved (rule 16,
 *   TS-15); shown whatever the set's features say, so an open challenge is never hidden
 * @property {{inputName: string, options: {value: number, label: string}[]}|null} newSlot - for a
 *   fixed set's trait the actor holds no entry for, in a set with dice: the input whose choice
 *   creates the entry (Character Sheets behaviour 13); null otherwise
 * @property {string|null} nameInput - the name of an open-set trait's name input, for edit mode
 * @property {string|null} poolTraitId - the id the pool knows the trait by: a fixed set's
 *   definition id, an open set's entry id (module/rules/pool-traits.mjs)
 * @property {boolean} rollable - the trait gives a die, its rating or its set's fallback, so it
 *   can be added to a pool (Character Sheets behaviour 20)
 * @property {boolean} canHinder - the set offers Hinder (rule 11)
 * @property {boolean} canChallenge - the set offers statements and the trait has one (rule 16);
 *   who may challenge is the sheet's check (ADR-048)
 */

/**
 * @typedef {object} SheetSet
 * @property {string} id
 * @property {string} name - as the game configuration names it
 * @property {boolean} hasDice
 * @property {boolean} multiDice
 * @property {boolean} shutDown - the whole set is flagged shut down (rule 15)
 * @property {boolean} canShutDown - the sheet offers the set's flag: to set where the set has the
 *   shut-down feature, to clear whenever it is set (behaviour 17)
 * @property {boolean} open - each actor adds its own traits (ADR-034), so the sheet's edit mode
 *   offers adding, renaming and removing them
 * @property {SheetTrait[]} traits
 */

/**
 * @typedef {object} SheetView
 * @property {"unassigned"|"unknown"|"assigned"} kindStatus - no kind yet, a kind the
 *   configuration doesn't have, or a known kind
 * @property {{id: string, name: string}|null} kind
 * @property {SheetSet[]} sets
 * @property {SheetTrait[]|null} freeTraits - the free traits of a kind that has them (TS-22), in
 *   stored order; null for a kind without free traits and for a character without a known kind
 * @property {OtherTraits} others - what the character stores that the sheet doesn't list above
 */

/**
 * @typedef {object} OtherTrait
 * @property {string|null} entryId - null for an entry without an id, which can't be removed by id
 * @property {string} name - the stored name
 * @property {import("../rules/types.mjs").DieSize[]} dice - the stored rating
 */

/**
 * @typedef {object} OtherTraitGroup
 * @property {string} setId
 * @property {string|null} name - the set's name in the game configuration, null for a set it
 *   doesn't have
 * @property {"noDefinition"|"notInKind"|"unknownSet"} reason - entries of one of the kind's sets
 *   that the sheet's rows don't show (in a fixed set: no definition matches them, TS-E03, or
 *   another entry already stands for their definition), a set the kind doesn't include, or a set
 *   the configuration doesn't have
 * @property {OtherTrait[]} traits
 */

/**
 * Stored traits the sheet's sections don't list (Character Sheets behaviour 10, CS-D5, ADR-051).
 * @typedef {object} OtherTraits
 * @property {OtherTraitGroup[]} sets - in stored order; sets with nothing unlisted are left out
 * @property {OtherTrait[]} freeTraits - the stored free traits of a character whose kind has no
 *   free traits, or that has no known kind
 * @property {number} count - how many traits the groups and the free traits hold together
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
 * @param {string} prefix - the inputs' name up to the die index
 * @param {number[]} dice
 * @param {boolean} multiDice - whether a further die can be added to a rating that has one
 * @returns {RatingSlot[]}
 */
function ratingSlots(prefix, dice, multiDice) {
  const slot = (index, value) => ({
    inputName: `${prefix}.${index}`,
    index,
    value,
    adds: value === null,
    options: DIE_SIZES.map(size => ({ value: size, label: `d${size}`, selected: size === value }))
  });
  const slots = dice.map((size, index) => slot(index, size));
  if ( (dice.length === 0) || multiDice ) slots.push(slot(dice.length, null));
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
  const poolTraitId = (set.list === "fixed") ? (def?.id ?? null) : (entry?.id ?? null);
  const rollable = rating.ok && (typeof poolTraitId === "string");
  return {
    entryId: entry?.id ?? null,
    name: def?.name ?? ((typeof entry?.name === "string") ? entry.name : ""),
    dice: [...dice],
    editable,
    slots: editable ? ratingSlots(`${RATING_INPUTS}.${set.id}.${entry.id}`, dice, set.multiDice === true) : [],
    fallbackDie: (rating.ok && rating.value.isFallback) ? rating.value.dice[0] : null,
    unrated: !rating.ok && (rating.code === "TRAIT_UNRATED"),
    noDice: set.hasDice !== true,
    hints: hints.ok ? hints.value : [],
    shutDown: setShutDown || isPlainObject(entry?.shutDown),
    ownShutDown: isPlainObject(entry?.shutDown),
    shutDownReason: isPlainObject(entry?.shutDown) && (typeof entry.shutDown.reason === "string")
      ? entry.shutDown.reason : null,
    canShutDown: (typeof entry?.id === "string") && ((set.features?.shutDown === true) || isPlainObject(entry.shutDown)),
    statement: (set.features?.statements === true)
      ? ((typeof entry?.statement === "string") ? entry.statement : "") : null,
    statementInput: ((set.features?.statements === true) && (typeof entry?.id === "string"))
      ? `${STATEMENT_INPUTS}.${set.id}.${entry.id}` : null,
    challenged: entry?.challenged === true,
    newSlot: ((entry === null) && (set.list === "fixed") && (set.hasDice === true) && (typeof def?.id === "string"))
      ? { inputName: `${NEW_RATING_INPUTS}.${set.id}.${def.id}.0`,
        options: DIE_SIZES.map(size => ({ value: size, label: `d${size}` })) }
      : null,
    nameInput: ((set.list !== "fixed") && (typeof entry?.id === "string")) ? `${NAME_INPUTS}.${set.id}.${entry.id}` : null,
    poolTraitId,
    rollable,
    canHinder: rollable && (set.features?.hinder === true),
    canChallenge: rollable && (set.features?.statements === true) && (typeof entry?.statement === "string")
      && (entry.statement.trim() !== "")
  };
}

/**
 * One free trait's row: a name and a rating, in no set (TS-22). It has no fallback die, so an
 * empty rating is unrated, and neither Hinder nor a statement, which are set features. Its rating
 * gets a select per stored die, and a blank one only while it is empty.
 * @param {object} entry - what the actor stores
 * @returns {SheetTrait}
 */
function freeTraitRow(entry) {
  const dice = storedDice(entry);
  const hasId = typeof entry.id === "string";
  const rating = effectiveRating(null, null, entry);
  const hints = ratingGuidance(null, dice);
  return {
    entryId: hasId ? entry.id : null,
    name: (typeof entry.name === "string") ? entry.name : "",
    dice: [...dice],
    editable: hasId,
    slots: hasId ? ratingSlots(`${FREE_RATING_INPUTS}.${entry.id}`, dice, false) : [],
    fallbackDie: null,
    unrated: !rating.ok && (rating.code === "TRAIT_UNRATED"),
    noDice: false,
    hints: hints.ok ? hints.value : [],
    shutDown: false,
    ownShutDown: false,
    shutDownReason: null,
    canShutDown: false,
    statement: null,
    statementInput: null,
    challenged: false,
    newSlot: null,
    nameInput: hasId ? `${FREE_NAME_INPUTS}.${entry.id}` : null,
    poolTraitId: hasId ? entry.id : null,
    rollable: rating.ok && hasId,
    canHinder: false,
    canChallenge: false
  };
}

/** @returns {OtherTrait} a stored entry as the "Other stored traits" list shows it */
function otherTrait(entry) {
  return {
    entryId: (typeof entry.id === "string") ? entry.id : null,
    name: (typeof entry.name === "string") ? entry.name : "",
    dice: [...storedDice(entry)]
  };
}

/**
 * The stored traits the sheet's sections don't list (CS-D5, ADR-051): every stored entry that no
 * row stands for, grouped by its set, and the free traits of a character whose kind has none.
 * Nothing is left out because of its shape, so everything stored can be found and removed.
 * @param {object} system
 * @param {import("../rules/types.mjs").GameConfig} config
 * @param {object|null} kind - the character's kind, null when it has none the configuration knows
 * @param {Set<object>} listed - the stored entries the sheet's rows stand for
 * @returns {OtherTraits}
 */
function otherStoredTraits(system, config, kind, listed) {
  const kindSetIds = Array.isArray(kind?.traitSetIds) ? kind.traitSetIds : [];
  const sets = [];
  for ( const [setId, stored] of Object.entries(isPlainObject(system?.traits) ? system.traits : {}) ) {
    const entries = Array.isArray(stored?.entries) ? stored.entries.filter(isPlainObject) : [];
    const traits = entries.filter(entry => !listed.has(entry)).map(otherTrait);
    if ( !traits.length ) continue;
    const set = Array.isArray(config?.traitSets) ? traitSetById(config, setId) : null;
    const reason = !isPlainObject(set) ? "unknownSet" : kindSetIds.includes(setId) ? "noDefinition" : "notInKind";
    sets.push({ setId, name: isPlainObject(set) ? set.name : null, reason, traits });
  }
  const free = ((kind?.freeTraits === true) || !Array.isArray(system?.freeTraits)) ? []
    : system.freeTraits.filter(isPlainObject).map(otherTrait);
  return { sets, freeTraits: free, count: sets.reduce((sum, group) => sum + group.traits.length, free.length) };
}

/**
 * What the sheet shows: the trait sets of the character's actor kind, in the kind's order and
 * named as the configuration names them (ADR-031). A fixed set lists its definitions in the
 * configuration's order, each with the actor's entry for it (by definition id, ADR-034) or none;
 * a definition without an entry shows its fallback die or that it is unrated, with an input that
 * creates the entry when a die is chosen. An open set lists the actor's entries in stored order.
 * A kind with free traits lists them after its sets (TS-22). Everything else the character stores
 * (sets the kind doesn't include, entries no definition matches (TS-E03), free traits of a kind
 * without them) is listed in `others` for the sheet's edit mode (CS-D5) and kept as stored when
 * the sheet writes.
 * @param {import("../rules/types.mjs").CharacterTraitData} system - the actor's system data
 * @param {import("../rules/types.mjs").GameConfig} config - the current game configuration
 * @returns {SheetView}
 */
export function characterSheetView(system, config) {
  const kindId = system?.kindId ?? null;
  const kind = ((kindId !== null) && Array.isArray(config?.actorKinds)) ? (actorKindById(config, kindId) ?? null) : null;
  if ( !kind ) {
    return {
      kindStatus: (kindId === null) ? "unassigned" : "unknown", kind: null, sets: [], freeTraits: null,
      others: otherStoredTraits(system, config, null, new Set())
    };
  }
  const listed = new Set();
  const row = (set, def, entry, setShutDown) => {
    if ( entry ) listed.add(entry);
    return traitRow(set, def, entry, setShutDown);
  };

  const sets = (Array.isArray(kind.traitSetIds) ? kind.traitSetIds : [])
    .map(setId => traitSetById(config, setId))
    .filter(isPlainObject)
    .map(set => {
      const stored = isPlainObject(system.traits?.[set.id]) ? system.traits[set.id] : {};
      const entries = Array.isArray(stored.entries) ? stored.entries.filter(isPlainObject) : [];
      const setShutDown = stored.shutDown === true;
      const traits = (set.list === "fixed")
        ? (Array.isArray(set.traits) ? set.traits : []).filter(isPlainObject).map(def => {
          return row(set, def, entries.find(entry => entry.defId === def.id) ?? null, setShutDown);
        })
        : entries.map(entry => row(set, null, entry, setShutDown));
      return {
        id: set.id, name: set.name, hasDice: set.hasDice === true, multiDice: set.multiDice === true,
        shutDown: setShutDown, canShutDown: (set.features?.shutDown === true) || setShutDown,
        open: set.list !== "fixed", traits
      };
    });
  const freeTraits = (kind.freeTraits === true)
    ? (Array.isArray(system.freeTraits) ? system.freeTraits : []).filter(isPlainObject).map(freeTraitRow) : null;
  return {
    kindStatus: "assigned", kind: { id: kind.id, name: kind.name }, sets, freeTraits,
    others: otherStoredTraits(system, config, kind, listed)
  };
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


/**
 * A set's stored entries as a list of copies, [] for a set the actor doesn't hold yet.
 * @param {object} system
 * @param {string} setId
 * @returns {object[]}
 */
function storedEntries(system, setId) {
  const entries = system?.traits?.[setId]?.entries;
  return Array.isArray(entries) ? entries.map(copyStored) : [];
}

/** @returns {string} stored text without surrounding spaces, "" for anything that isn't text */
function trimmedText(value) {
  return (typeof value === "string") ? value.trim() : "";
}

/**
 * Turns everything the sheet's form holds about traits into the trait changes of an update:
 * the ratings of stored entries (traitChangesFromInputs), the names of open-set traits, and the
 * ratings chosen for fixed-set traits the actor holds no entry for, which create those entries
 * (Character Sheets behaviours 11, 13 and 14). As there, every changed set gets its whole entries
 * list back, and what an entry holds beside the changed field is kept as stored.
 *
 * A name is trimmed; a blank name, a name that isn't text, and a name for an entry of a fixed set
 * (whose traits are named by their definitions, ADR-034) change nothing. A new entry gets a new
 * id, its definition's id, the definition's name as a snapshot, the chosen rating and no SFX; it
 * goes at the end of its set's entries. A choice for a set that isn't fixed, a definition the set
 * doesn't have, or a definition the actor has an entry for by now is ignored, and so is a blank
 * choice. A statement is trimmed and may be blank; it changes only when its trimmed text differs
 * from the stored text, trimmed, so a submit of another field never rewrites it, and a blank input
 * for an entry that has no statement changes nothing. Changing the text never resolves a challenge
 * (TS-15c, editStatement). Whether the result fits the configuration is checkCharacterUpdate's
 * job.
 * @param {import("../rules/types.mjs").CharacterTraitData} system - the stored system data, read
 *   when the form is submitted
 * @param {import("../rules/types.mjs").GameConfig} config
 * @param {{ratings?: unknown, newRatings?: unknown, names?: unknown, statements?: unknown}} form -
 *   the form's groups of trait inputs, each as its inputs name it or undefined
 * @param {() => string} makeId - makes the id of a new entry
 * @returns {import("../rules/types.mjs").EngineResult<Record<string, {entries: object[]}>>} the
 *   changed sets by id; refuses INVALID_TRAIT_DATA (inputs not shaped as the sheet names them) and
 *   INVALID_DIE_SIZE
 */
export function sheetTraitChanges(system, config, form, makeId) {
  if ( !isPlainObject(form) || (typeof makeId !== "function") ) return fail("INVALID_TRAIT_DATA");
  const rated = traitChangesFromInputs(system, form.ratings);
  if ( !rated.ok ) return rated;
  const changes = rated.value;
  const entriesOf = setId => changes[setId]?.entries ?? storedEntries(system, setId);

  if ( form.names !== undefined ) {
    if ( !isPlainObject(form.names) ) return fail("INVALID_TRAIT_DATA");
    for ( const [setId, byEntry] of Object.entries(form.names) ) {
      if ( !isPlainObject(byEntry) ) return fail("INVALID_TRAIT_DATA");
      const set = Array.isArray(config?.traitSets) ? traitSetById(config, setId) : null;
      if ( set?.list === "fixed" ) continue;
      const entries = entriesOf(setId);
      let changed = false;
      for ( const entry of entries ) {
        const name = isPlainObject(entry) ? byEntry[entry.id] : undefined;
        if ( (typeof name !== "string") || (name.trim() === "") || (name.trim() === trimmedText(entry.name)) ) continue;
        entry.name = name.trim();
        changed = true;
      }
      if ( changed ) changes[setId] = { entries };
    }
  }

  if ( form.statements !== undefined ) {
    if ( !isPlainObject(form.statements) ) return fail("INVALID_TRAIT_DATA");
    for ( const [setId, byEntry] of Object.entries(form.statements) ) {
      if ( !isPlainObject(byEntry) ) return fail("INVALID_TRAIT_DATA");
      const entries = entriesOf(setId);
      let changed = false;
      for ( const [index, entry] of entries.entries() ) {
        const text = isPlainObject(entry) ? byEntry[entry.id] : undefined;
        if ( typeof text !== "string" ) continue;
        const statement = text.trim();
        if ( statement === trimmedText(entry.statement) ) continue;
        const edited = editStatement(entry, statement);
        if ( !edited.ok ) return edited;
        entries[index] = edited.value;
        changed = true;
      }
      if ( changed ) changes[setId] = { entries };
    }
  }

  if ( form.newRatings !== undefined ) {
    if ( !isPlainObject(form.newRatings) ) return fail("INVALID_TRAIT_DATA");
    for ( const [setId, byDef] of Object.entries(form.newRatings) ) {
      if ( !isPlainObject(byDef) ) return fail("INVALID_TRAIT_DATA");
      const set = Array.isArray(config?.traitSets) ? traitSetById(config, setId) : null;
      const entries = entriesOf(setId);
      let changed = false;
      for ( const [defId, dieInputs] of Object.entries(byDef) ) {
        const rating = inputRating(dieInputs);
        if ( !rating.ok ) return rating;
        const def = (set?.list === "fixed") ? traitDefById(set, defId) : null;
        if ( !def || (rating.value.length === 0) ) continue;
        if ( entries.some(entry => isPlainObject(entry) && (entry.defId === defId)) ) continue;
        entries.push({ id: makeId(), defId, name: def.name, dice: rating.value, sfx: [] });
        changed = true;
      }
      if ( changed ) changes[setId] = { entries };
    }
  }
  return ok(changes);
}

/**
 * A set's entries with a new trait at the end, for an open set (ADR-034; Character Sheets
 * behaviour 14). The trait starts at its set's starting rating where the set has dice and one is
 * configured, otherwise with no rating (CS-D9; rule 9: guidance, never enforced), and with no SFX.
 * @param {import("../rules/types.mjs").CharacterTraitData} system - the stored system data
 * @param {import("../rules/types.mjs").GameConfig} config
 * @param {string} setId
 * @param {string} id - the new entry's id, made by the caller
 * @param {string} name
 * @returns {import("../rules/types.mjs").EngineResult<{entries: object[]}>} refuses
 *   INVALID_TRAIT_DATA (ids or a name that aren't text, a blank name), UNKNOWN_TRAIT_SET, or
 *   TRAIT_SET_NOT_OPEN (a fixed set's traits are defined in the game configuration)
 */
export function addTraitEntry(system, config, setId, id, name) {
  if ( !isPlainObject(system) || (typeof setId !== "string") || (typeof id !== "string")
    || (typeof name !== "string") || (name.trim() === "") ) return fail("INVALID_TRAIT_DATA");
  const set = Array.isArray(config?.traitSets) ? traitSetById(config, setId) : null;
  if ( !isPlainObject(set) ) return fail("UNKNOWN_TRAIT_SET");
  if ( set.list === "fixed" ) return fail("TRAIT_SET_NOT_OPEN");
  const dice = ((set.hasDice === true) && DIE_SIZES.includes(set.startingRating)) ? [set.startingRating] : [];
  return ok({ entries: [...storedEntries(system, setId), { id, defId: null, name: name.trim(), dice, sfx: [] }] });
}

/**
 * A set's entries without one trait (Character Sheets behaviour 14). The set keeps its key even
 * when it ends up empty: the sheet never removes a set (ADR-044 point 4).
 * @param {import("../rules/types.mjs").CharacterTraitData} system - the stored system data
 * @param {string} setId
 * @param {string} entryId
 * @returns {import("../rules/types.mjs").EngineResult<{entries: object[]}>} refuses
 *   INVALID_TRAIT_DATA, or UNKNOWN_TRAIT when the set holds no entry with that id
 */
export function removeTraitEntry(system, setId, entryId) {
  if ( !isPlainObject(system) || (typeof setId !== "string") || (typeof entryId !== "string") ) {
    return fail("INVALID_TRAIT_DATA");
  }
  const entries = storedEntries(system, setId);
  if ( !entries.some(entry => isPlainObject(entry) && (entry.id === entryId)) ) return fail("UNKNOWN_TRAIT");
  return ok({ entries: entries.filter(entry => !(isPlainObject(entry) && (entry.id === entryId))) });
}

/**
 * The stored free traits as a list of copies, [] where the actor holds none.
 * @param {object} system
 * @returns {object[]}
 */
function storedFreeTraits(system) {
  return Array.isArray(system?.freeTraits) ? system.freeTraits.map(copyStored) : [];
}

/**
 * Turns the sheet's free-trait inputs into the free traits of an update (Character Sheets
 * behaviour 9; TS-22). The whole list comes back, because an update replaces it whole, with only
 * the changed ratings and names replaced. As for set traits, a name is trimmed and a blank one
 * changes nothing, a blank die input leaves its die out, and inputs for a trait the actor no
 * longer holds are ignored. Whether the dice exist is checkCharacterUpdate's job as well.
 * @param {import("../rules/types.mjs").CharacterTraitData} system - the stored system data, read
 *   when the form is submitted
 * @param {{ratings?: unknown, names?: unknown}} form - entry id to die index to value, and entry
 *   id to name; each undefined when the form has no such inputs
 * @returns {import("../rules/types.mjs").EngineResult<object[]|null>} the new list, or null when
 *   nothing changed; refuses INVALID_TRAIT_DATA and INVALID_DIE_SIZE
 */
export function freeTraitChanges(system, form) {
  if ( !isPlainObject(form) ) return fail("INVALID_TRAIT_DATA");
  const { ratings = {}, names = {} } = form;
  if ( !isPlainObject(ratings) || !isPlainObject(names) ) return fail("INVALID_TRAIT_DATA");
  const rated = new Map();
  for ( const [entryId, dieInputs] of Object.entries(ratings) ) {
    const rating = inputRating(dieInputs);
    if ( !rating.ok ) return rating;
    rated.set(entryId, rating.value);
  }
  let changed = false;
  const list = storedFreeTraits(system).map(entry => {
    if ( !isPlainObject(entry) ) return entry;
    if ( rated.has(entry.id) && !sameDice(rated.get(entry.id), storedDice(entry)) ) {
      entry.dice = rated.get(entry.id);
      changed = true;
    }
    const name = names[entry.id];
    if ( (typeof name === "string") && (name.trim() !== "") && (name.trim() !== entry.name) ) {
      entry.name = name.trim();
      changed = true;
    }
    return entry;
  });
  return ok(changed ? list : null);
}

/**
 * The free traits with a new one at the end: a name and no rating yet, since a free trait has no
 * set to give it a starting rating (TS-22, CS-D9).
 * @param {import("../rules/types.mjs").CharacterTraitData} system - the stored system data
 * @param {string} id - the new trait's id, made by the caller
 * @param {string} name
 * @returns {import("../rules/types.mjs").EngineResult<object[]>} refuses INVALID_TRAIT_DATA (an
 *   id or a name that isn't text, a blank name)
 */
export function addFreeTrait(system, id, name) {
  if ( !isPlainObject(system) || (typeof id !== "string") || (typeof name !== "string") || (name.trim() === "") ) {
    return fail("INVALID_TRAIT_DATA");
  }
  return ok([...storedFreeTraits(system), { id, name: name.trim(), dice: [] }]);
}

/**
 * The free traits without one of them.
 * @param {import("../rules/types.mjs").CharacterTraitData} system - the stored system data
 * @param {string} entryId
 * @returns {import("../rules/types.mjs").EngineResult<object[]>} refuses INVALID_TRAIT_DATA, or
 *   UNKNOWN_TRAIT when the actor holds no free trait with that id
 */
export function removeFreeTrait(system, entryId) {
  if ( !isPlainObject(system) || (typeof entryId !== "string") ) return fail("INVALID_TRAIT_DATA");
  const list = storedFreeTraits(system);
  if ( !list.some(entry => isPlainObject(entry) && (entry.id === entryId)) ) return fail("UNKNOWN_TRAIT");
  return ok(list.filter(entry => !(isPlainObject(entry) && (entry.id === entryId))));
}

/**
 * A set's entries with one of them replaced by what change makes of it.
 * @param {object} system
 * @param {string} setId
 * @param {string} entryId
 * @param {(entry: object) => import("../rules/types.mjs").EngineResult<object>} change
 * @returns {import("../rules/types.mjs").EngineResult<{entries: object[]}>} refuses
 *   INVALID_TRAIT_DATA, UNKNOWN_TRAIT, or change's code
 */
function withEntryChanged(system, setId, entryId, change) {
  if ( !isPlainObject(system) || (typeof setId !== "string") || (typeof entryId !== "string") ) {
    return fail("INVALID_TRAIT_DATA");
  }
  const entries = storedEntries(system, setId);
  const index = entries.findIndex(entry => isPlainObject(entry) && (entry.id === entryId));
  if ( index < 0 ) return fail("UNKNOWN_TRAIT");
  const changed = change(entries[index]);
  if ( !changed.ok ) return changed;
  entries[index] = changed.value;
  return ok({ entries });
}

/**
 * A set's entries after the table resolves a trait's challenged statement (Character Sheets
 * behaviour 15; rule 16; TS-15, TS-16; RQ-021, RQ-022, RQ-034): rewritten brings back the rating
 * from before the challenge and clears a shut-down the challenge set; kept leaves the reduced
 * rating and any shut-down. The decision is resolveChallengedStatement's.
 * @param {import("../rules/types.mjs").CharacterTraitData} system - the stored system data
 * @param {string} setId
 * @param {string} entryId
 * @param {boolean} rewritten
 * @returns {import("../rules/types.mjs").EngineResult<{entries: object[]}>} refuses
 *   INVALID_TRAIT_DATA, UNKNOWN_TRAIT, and resolveChallengedStatement's codes, such as
 *   STATEMENT_NOT_CHALLENGED
 */
export function resolveTraitChallenge(system, setId, entryId, rewritten) {
  if ( typeof rewritten !== "boolean" ) return fail("INVALID_TRAIT_DATA");
  return withEntryChanged(system, setId, entryId, entry => resolveChallengedStatement(entry, { rewritten }));
}

/**
 * Whether a set's shut-down flags may be set: only where the game configuration gives the set the
 * shut-down feature (rule 13). Clearing a flag is always allowed, so a stored flag is never stuck
 * (ADR-029; Character Sheets CS-D16).
 * @param {import("../rules/types.mjs").GameConfig} config
 * @param {string} setId
 * @returns {boolean}
 */
function shutDownOffered(config, setId) {
  const set = Array.isArray(config?.traitSets) ? traitSetById(config, setId) : null;
  return isPlainObject(set) && (set.features?.shutDown === true);
}

/**
 * A set's entries with one trait's own shut-down flag set or cleared (Character Sheets
 * behaviour 17; rule 15). Setting it marks the trait shut down by hand, where the set has the
 * shut-down feature; a trait that is already shut down keeps its reason. Clearing it removes the
 * flag whatever it holds, including the reason a challenged d4 left: lifting a shut-down is the
 * table's call (RQ-034, ADR-029 point 4).
 * @param {import("../rules/types.mjs").CharacterTraitData} system - the stored system data
 * @param {import("../rules/types.mjs").GameConfig} config
 * @param {string} setId
 * @param {string} entryId
 * @param {boolean} shutDown
 * @returns {import("../rules/types.mjs").EngineResult<{entries: object[]}>} refuses
 *   INVALID_TRAIT_DATA, UNKNOWN_TRAIT, and SHUT_DOWN_NOT_OFFERED (setting a flag in a set without
 *   the shut-down feature)
 */
export function setTraitShutDown(system, config, setId, entryId, shutDown) {
  if ( typeof shutDown !== "boolean" ) return fail("INVALID_TRAIT_DATA");
  if ( shutDown && (typeof setId === "string") && !shutDownOffered(config, setId) ) return fail("SHUT_DOWN_NOT_OFFERED");
  return withEntryChanged(system, setId, entryId, entry => {
    const next = { ...entry };
    if ( !shutDown ) delete next.shutDown;
    else if ( !isPlainObject(entry.shutDown) ) next.shutDown = { reason: "manual" };
    return ok(next);
  });
}

/**
 * A set's change after its whole shut-down flag is set or cleared (Character Sheets behaviour 17;
 * rule 15), as the update to write for that set: the flag alone for a set the actor holds, so its
 * entries and SFX are kept as stored; for a set it doesn't hold yet, the flag with an empty
 * entries list and no SFX. Setting the flag needs the set's shut-down feature; clearing it doesn't.
 * @param {import("../rules/types.mjs").CharacterTraitData} system - the stored system data
 * @param {import("../rules/types.mjs").GameConfig} config
 * @param {string} setId
 * @param {boolean} shutDown
 * @returns {import("../rules/types.mjs").EngineResult<{shutDown: boolean, sfx?: [], entries?: []}>}
 *   refuses INVALID_TRAIT_DATA and SHUT_DOWN_NOT_OFFERED
 */
export function setShutDownChange(system, config, setId, shutDown) {
  if ( !isPlainObject(system) || (typeof setId !== "string") || (typeof shutDown !== "boolean") ) {
    return fail("INVALID_TRAIT_DATA");
  }
  if ( shutDown && !shutDownOffered(config, setId) ) return fail("SHUT_DOWN_NOT_OFFERED");
  const held = isPlainObject(system.traits) && Object.hasOwn(system.traits, setId);
  return ok(held ? { shutDown } : { shutDown, sfx: [], entries: [] });
}
