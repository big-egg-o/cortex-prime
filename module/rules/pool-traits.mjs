/**
 * Trait dice in a user's dice pool, for the character sheet's roll button (Roadmap M2; Character
 * Sheets behaviours 20 to 24; Decisions ADR-016, ADR-048 and ADR-049): the dice a trait the sheet
 * shows puts into a pool, adding them so that a trait is never in a pool twice (CS-D8, TS-E05),
 * what a pool's trait dice cost and warn of, the dice as they are rolled and stored, and the
 * step-down that follows a challenged statement. Every function returns an EngineResult (ADR-025)
 * and never changes its inputs.
 *
 * A trait die keeps its trait's marks in its source, beside the four fields the roll message
 * stores (`kind`, `actorId`, `traitId`, `label`):
 * - `actorRef`: which actor the trait belongs to. An unlinked token's actor has its base actor's
 *   id, so the caller passes a reference that tells them apart (Foundry code passes the uuid);
 * - `setId`: the trait's set;
 * - `option`: "hinder" or "challenge" when the trait was added that way, absent for a plain add;
 * - `ppGained` and `hint`: Hinder's plot point, or the hint for a trait already at d4 (RQ-029);
 * - `isFallback`: the die is its set's fallback (rule 8, TS-03);
 * - `ratingConflict`: the stored rating no longer fits its set (ADR-037 point 5).
 * The marks live in the user's pool only; rollablePool leaves them out of what is rolled.
 *
 * Within a set, a trait is its actor and its trait id together (RQ-031). A fixed set's trait is
 * named by its definition id, whether or not the actor holds an entry for it, so its id stays the
 * same when an entry is created later (ADR-034); an open set's trait by its entry id.
 * @module rules/pool-traits
 */

import { fail, ok } from "./result.mjs";
import { traitDefById, traitSetById } from "./game-config.mjs";
import { challengeStatement } from "./statements.mjs";
import { effectiveRating, poolTraitCost, traitPoolEntries } from "./trait-pool.mjs";

/** How a trait can be added besides plainly (Character Sheets CS-D10). */
export const POOL_TRAIT_OPTIONS = Object.freeze(["hinder", "challenge"]);

/** The source fields the roll message stores (the poolRoll schema's die source). */
const ROLLED_SOURCE_KEYS = Object.freeze(["kind", "actorId", "traitId", "label"]);

/** @returns {boolean} whether value is a plain object, not an array, class instance or null */
function isPlainObject(value) {
  if ( (value === null) || (typeof value !== "object") ) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype) || (proto === null);
}

/** @returns {boolean} whether value is text with something other than spaces in it */
function isName(value) {
  return (typeof value === "string") && (value.trim() !== "");
}

/**
 * A deep copy of plain data that leaves out keys whose value is undefined, as storing does.
 * @param {unknown} value
 * @returns {unknown}
 */
function copyStored(value) {
  if ( Array.isArray(value) ) return value.map(copyStored);
  if ( !isPlainObject(value) ) return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, copyStored(v)]));
}

/** @returns {boolean} whether a pool die is a trait's: kind "trait" with a trait id */
function isTraitDie(die) {
  return isPlainObject(die?.source) && (die.source.kind === "trait") && (typeof die.source.traitId === "string");
}

/** @returns {string|null} the actor a trait die's source belongs to: its reference, else its id */
function actorKeyOf(source) {
  if ( typeof source.actorRef === "string" ) return source.actorRef;
  return (typeof source.actorId === "string") ? source.actorId : null;
}

/** @returns {string} what makes a trait one trait in a pool: set, actor and trait id (RQ-031) */
function traitKeyOf(source) {
  return JSON.stringify([source.setId ?? null, actorKeyOf(source), source.traitId]);
}

/** @returns {boolean} whether value is a pool: a list of objects, each with an id and a source */
function isPool(value) {
  return Array.isArray(value) && value.every(die => isPlainObject(die) && (typeof die.id === "string")
    && isPlainObject(die.source));
}

/** @returns {number} the highest number among a pool's "d<n>" die ids, 0 for none */
function highestDieNumber(pool) {
  return pool.reduce((max, die) => Math.max(max, Number(/^d(\d+)$/.exec(die.id)?.[1] ?? 0)), 0);
}

/**
 * The entry a pool trait id names in a set's stored entries: in a fixed set the entry for the
 * definition with that id, in an open set the entry with that id.
 * @param {unknown} setData - a set of the actor's trait data
 * @param {string} traitId
 * @param {boolean} fixed
 * @returns {object|null}
 */
function entryFor(setData, traitId, fixed) {
  const entries = Array.isArray(setData?.entries) ? setData.entries.filter(isPlainObject) : [];
  return entries.find(entry => (fixed ? entry.defId : entry.id) === traitId) ?? null;
}

/**
 * The key a pool die is grouped and cleared by: a trait die by its trait (set, actor and trait
 * id, RQ-031), so two actors' traits of one name stay apart; any other die by its label.
 * @param {import("./types.mjs").PoolDie} die
 * @returns {string}
 */
export function poolDieGroupKey(die) {
  if ( isTraitDie(die) ) return `trait:${traitKeyOf(die.source)}`;
  return `label:${die?.source?.label ?? ""}`;
}

/**
 * The dice a trait the sheet shows puts into a pool, and the marks the pool keeps with them
 * (Character Sheets behaviours 20 and 21). The trait is resolved from the actor's stored data and
 * the game configuration: in a fixed set by its definition, with the actor's entry for it if there
 * is one; in an open set by its entry. Its dice are effectiveRating's (rule 8 fallback, ADR-037
 * point 5 conflicts) and its pool entries traitPoolEntries' (Hinder, RQ-029; a challenge, rule 16).
 *
 * Hinder needs a set with the Hinder feature (rule 11) and a challenge a set with the statements
 * feature and a trait with a statement (rule 16); otherwise the option doesn't exist for that
 * trait and is refused. A challenge is also refused where the step-down that follows the roll
 * would be (ADR-048): a stored rating of several dice until RQ-033 is decided, or no stored rating.
 * Whether the user may challenge, that is may update the actor afterwards, is the caller's check.
 * @param {import("./types.mjs").CharacterTraitData} system - the actor's stored data
 * @param {import("./types.mjs").GameConfig} config
 * @param {string} setId
 * @param {string} traitId - a fixed set's definition id or an open set's entry id
 * @param {{actorId?: string, option?: "hinder"|"challenge"|null}} [options]
 * @returns {import("./types.mjs").EngineResult<{setId: string, traitId: string,
 *   option: "hinder"|"challenge"|null, ratingConflict: boolean,
 *   entries: ReturnType<typeof traitPoolEntries>["value"]}>} refuses, in this order:
 *   INVALID_TRAIT_DATA (data that can't be read), INVALID_TRAIT_OPTIONS (an option that doesn't
 *   exist), UNKNOWN_TRAIT_SET, UNKNOWN_TRAIT, TRAIT_UNNAMED (an open-set trait without a name, which
 *   a die can't be labelled with), effectiveRating's codes (TRAIT_HAS_NO_DICE, TRAIT_ORPHANED,
 *   INVALID_DIE_SIZE, TRAIT_UNRATED), TRAIT_OPTION_UNAVAILABLE, challengeStatement's codes for a
 *   challenge (STATEMENT_RATING_NOT_ONE_DIE, TRAIT_UNRATED and malformed fields)
 */
export function traitPoolDice(system, config, setId, traitId, options = {}) {
  if ( !isPlainObject(system) || !isPlainObject(config) || !Array.isArray(config.traitSets)
    || (typeof setId !== "string") || (typeof traitId !== "string") || !isPlainObject(options) ) {
    return fail("INVALID_TRAIT_DATA");
  }
  const { actorId, option = null } = options;
  if ( (actorId !== undefined) && (typeof actorId !== "string") ) return fail("INVALID_TRAIT_DATA");
  if ( (option !== null) && !POOL_TRAIT_OPTIONS.includes(option) ) return fail("INVALID_TRAIT_OPTIONS");

  const set = traitSetById(config, setId);
  if ( !isPlainObject(set) ) return fail("UNKNOWN_TRAIT_SET");
  const fixed = set.list === "fixed";
  const def = fixed ? traitDefById(set, traitId) : null;
  const entry = entryFor(system.traits?.[setId], traitId, fixed);
  if ( fixed ? !def : !entry ) return fail("UNKNOWN_TRAIT");
  const label = fixed ? def.name : entry.name;
  if ( !isName(label) ) return fail("TRAIT_UNNAMED");

  const rating = effectiveRating(set, def, entry);
  if ( !rating.ok ) return rating;

  if ( (option === "hinder") && (set.features?.hinder !== true) ) return fail("TRAIT_OPTION_UNAVAILABLE");
  if ( option === "challenge" ) {
    if ( (set.features?.statements !== true) || !isName(entry?.statement) ) return fail("TRAIT_OPTION_UNAVAILABLE");
    const stepDown = challengeStatement(entry);
    if ( !stepDown.ok ) return stepDown;
  }

  const trait = { dice: rating.value.dice, label, traitId };
  if ( actorId !== undefined ) trait.actorId = actorId;
  if ( rating.value.isFallback ) trait.isFallback = true;
  const entries = traitPoolEntries(trait, { hinder: option === "hinder", challenge: option === "challenge" });
  if ( !entries.ok ) return entries;
  return ok({
    setId, traitId, option,
    ratingConflict: rating.value.warnings.some(w => w.code === "RATING_CONFLICTS_WITH_SET"),
    entries: entries.value
  });
}

/**
 * Adds a trait's dice to a pool so that a trait is never in it twice (Character Sheets CS-D8,
 * TS-E05). A trait that isn't in the pool yet goes at the end. A trait that is gets its dice
 * replaced, in their place, by the new choice, for example plain to Hinder; any step or Double
 * applied to the old dice is gone with them. The same choice again changes nothing, so the
 * builder's changes to those dice stay. New dice continue the pool's die ids and have origin
 * "rating"; their sources carry the trait's marks (see the module notes).
 * @param {import("./types.mjs").PoolDie[]} pool
 * @param {ReturnType<typeof traitPoolDice>["value"]} traitDice - from traitPoolDice
 * @param {{actorRef?: string}} [options] - the actor's reference, when its id alone doesn't tell
 *   it apart (an unlinked token's actor)
 * @returns {import("./types.mjs").EngineResult<{pool: import("./types.mjs").PoolDie[],
 *   changed: boolean}>} a new pool; refuses INVALID_TRAIT_DATA for a pool or dice that can't be
 *   read
 */
export function addTraitDice(pool, traitDice, options = {}) {
  if ( !isPool(pool) || !isPlainObject(traitDice) || !Array.isArray(traitDice.entries)
    || (traitDice.entries.length === 0) || !isPlainObject(options) ) return fail("INVALID_TRAIT_DATA");
  const { actorRef } = options;
  if ( (actorRef !== undefined) && (typeof actorRef !== "string") ) return fail("INVALID_TRAIT_DATA");

  const marks = { setId: traitDice.setId };
  if ( actorRef !== undefined ) marks.actorRef = actorRef;
  if ( traitDice.option ) marks.option = traitDice.option;
  if ( traitDice.ratingConflict ) marks.ratingConflict = true;
  const added = traitDice.entries.map(entry => {
    const source = { ...entry.source, ...marks };
    if ( entry.ppGained !== undefined ) source.ppGained = entry.ppGained;
    if ( entry.hint !== undefined ) source.hint = entry.hint;
    if ( entry.isFallback ) source.isFallback = true;
    return { size: entry.size, source };
  });

  const key = traitKeyOf(added[0].source);
  const current = pool.filter(die => isTraitDie(die) && (traitKeyOf(die.source) === key));
  if ( current.length && ((current[0].source.option ?? null) === (traitDice.option ?? null)) ) {
    return ok({ pool: copyStored(pool), changed: false });
  }
  const kept = pool.filter(die => !current.includes(die));
  const insertAt = current.length ? pool.indexOf(current[0]) : pool.length;
  let next = highestDieNumber(pool);
  const dice = added.map(({ size, source }) => ({ id: `d${++next}`, size, source, origin: "rating" }));
  return ok({ pool: copyStored([...kept.slice(0, insertAt), ...dice, ...kept.slice(insertAt)]), changed: true });
}

/**
 * The traits of a pool, each once, in the order their first die appears, with the marks of that
 * die's source and the ids of all its dice (doubled and overflow dice included).
 * @param {import("./types.mjs").PoolDie[]} pool
 * @returns {import("./types.mjs").EngineResult<{key: string, setId: string|null, traitId: string,
 *   actorId: string|null, actorRef: string|null, label: string, option: string|null,
 *   ppGained: number, hint: string|null, isFallback: boolean, ratingConflict: boolean,
 *   dieIds: string[]}[]>} refuses INVALID_TRAIT_DATA for a pool that can't be read
 */
export function poolTraits(pool) {
  if ( !isPool(pool) ) return fail("INVALID_TRAIT_DATA");
  const traits = new Map();
  for ( const die of pool ) {
    if ( !isTraitDie(die) ) continue;
    const { source } = die;
    const key = traitKeyOf(source);
    if ( traits.has(key) ) {
      traits.get(key).dieIds.push(die.id);
      continue;
    }
    traits.set(key, {
      key,
      setId: (typeof source.setId === "string") ? source.setId : null,
      traitId: source.traitId,
      actorId: (typeof source.actorId === "string") ? source.actorId : null,
      actorRef: actorKeyOf(source),
      label: (typeof source.label === "string") ? source.label : "",
      option: POOL_TRAIT_OPTIONS.includes(source.option) ? source.option : null,
      ppGained: Number.isInteger(source.ppGained) ? source.ppGained : 0,
      hint: (typeof source.hint === "string") ? source.hint : null,
      isFallback: source.isFallback === true,
      ratingConflict: source.ratingConflict === true,
      dieIds: [die.id]
    });
  }
  return ok([...traits.values()]);
}

/**
 * What the trait dice of a pool cost and warn of, for the pool builder and the roll message
 * (Character Sheets behaviour 22; rules 6, 7 and 15; RQ-030, RQ-031; ADR-029, ADR-047). Each
 * trait is counted once, with the shut-down flags its actor holds now. A trait whose actor's data
 * isn't given counts without flags.
 *
 * A pool may hold traits of several actors (ADR-049). The missing-prime-set warning (rule 7,
 * RQ-020) is worked out for every actor kind in the pool that uses prime sets, against all the
 * pool's traits, and each missing set is warned of once (Character Sheets CS-D12): a location
 * or a mob adds no such warning, since their kinds have no prime sets. A trait whose
 * stored rating no longer fits its set warns RATING_CONFLICTS_WITH_SET (ADR-037 point 5).
 *
 * The warnings name each trait's actor by the die's `actorId`, as the roll card matches them
 * (RQ-031). Hinder's plot points are summed for display only; nothing is paid (ADR-014, ADR-029).
 * @param {import("./types.mjs").PoolDie[]} pool
 * @param {Record<string, {kindId?: string|null, traits?: object}>} actors - each pool actor's
 *   kind and stored trait data, by the die's `actorRef` (or `actorId` where it has no reference)
 * @param {import("./types.mjs").GameConfig} config
 * @returns {import("./types.mjs").EngineResult<{traitCount: number, ppCost: number,
 *   extraTraits: {setId: string, count: number}[], unpricedTraits: {setId: string,
 *   count: number}[], warnings: {code: string, setId?: string, actorId?: string,
 *   traitId?: string}[], ppGained: number}>} warnings in this order: poolTraitCost's warnings
 *   about traits and sets (pool order), RATING_CONFLICTS_WITH_SET (pool order),
 *   PRIME_SET_MISSING (kinds in pool order, each kind's sets in its order). Refuses
 *   INVALID_TRAIT_DATA or INVALID_GAME_CONFIG
 */
export function poolTraitReport(pool, actors, config) {
  const listed = poolTraits(pool);
  if ( !listed.ok ) return listed;
  if ( !isPlainObject(actors) ) return fail("INVALID_TRAIT_DATA");
  if ( !isPlainObject(config) || !Array.isArray(config.traitSets) ) return fail("INVALID_GAME_CONFIG");
  const traits = listed.value;
  const holderOf = trait => ((trait.actorRef !== null) && isPlainObject(actors[trait.actorRef]) ? actors[trait.actorRef] : null);

  const costTraits = traits.map(trait => {
    const holder = holderOf(trait);
    const setData = (trait.setId !== null) ? holder?.traits?.[trait.setId] : undefined;
    const set = (trait.setId !== null) ? traitSetById(config, trait.setId) : null;
    const entry = entryFor(setData, trait.traitId, set?.list === "fixed");
    const costTrait = { setId: trait.setId, traitId: trait.traitId };
    if ( trait.actorRef !== null ) costTrait.actorId = trait.actorRef;
    costTrait.setShutDown = setData?.shutDown === true;
    costTrait.traitShutDown = isPlainObject(entry?.shutDown);
    costTrait.hinder = trait.option === "hinder";
    return costTrait;
  });
  const base = poolTraitCost(costTraits, config, null);
  if ( !base.ok ) return base;

  const primeWarnings = [];
  const missing = new Set();
  const kinds = [...new Set(traits.map(trait => holderOf(trait)?.kindId).filter(kindId => typeof kindId === "string"))];
  for ( const kindId of kinds ) {
    for ( const warning of poolTraitCost(costTraits, config, kindId).value.warnings ) {
      if ( (warning.code !== "PRIME_SET_MISSING") || missing.has(warning.setId) ) continue;
      missing.add(warning.setId);
      primeWarnings.push(warning);
    }
  }
  const conflicts = traits.filter(trait => trait.ratingConflict).map(trait => {
    const warning = { code: "RATING_CONFLICTS_WITH_SET" };
    if ( trait.setId !== null ) warning.setId = trait.setId;
    if ( trait.actorRef !== null ) warning.actorId = trait.actorRef;
    warning.traitId = trait.traitId;
    return warning;
  });

  // The cost check names an actor by the reference it was given; the card needs the die's actorId.
  const actorIdByRef = new Map(traits.map(trait => [trait.actorRef, trait.actorId]));
  const warnings = [...base.value.warnings, ...conflicts, ...primeWarnings].map(warning => {
    if ( warning.actorId === undefined ) return { ...warning };
    const { actorId, ...rest } = warning;
    const dieActorId = actorIdByRef.get(actorId) ?? null;
    if ( dieActorId === null ) return rest;
    const named = { code: rest.code };
    if ( rest.setId !== undefined ) named.setId = rest.setId;
    named.actorId = dieActorId;
    if ( rest.traitId !== undefined ) named.traitId = rest.traitId;
    return named;
  });

  return ok({
    traitCount: traits.length,
    ppCost: base.value.ppCost,
    extraTraits: base.value.extraTraits,
    unpricedTraits: base.value.unpricedTraits,
    warnings,
    ppGained: traits.reduce((sum, trait) => sum + ((trait.option === "hinder") ? trait.ppGained : 0), 0)
  });
}

/**
 * The pool as it is rolled and stored on the roll message: every die with only the source fields
 * the message keeps (kind, actorId, traitId, label); the trait marks stay in the user's pool.
 * @param {import("./types.mjs").PoolDie[]} pool
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").PoolDie[]>} refuses
 *   INVALID_TRAIT_DATA for a pool that can't be read
 */
export function rollablePool(pool) {
  if ( !isPool(pool) ) return fail("INVALID_TRAIT_DATA");
  return ok(pool.map(die => {
    const source = {};
    for ( const key of ROLLED_SOURCE_KEYS ) if ( die.source[key] !== undefined ) source[key] = die.source[key];
    return { ...copyStored(die), source };
  }));
}

/**
 * The traits a pool adds as challenged statements, whose step-down is written once the pool is
 * rolled (ADR-048).
 * @param {import("./types.mjs").PoolDie[]} pool
 * @returns {import("./types.mjs").EngineResult<{key: string, setId: string|null, traitId: string,
 *   actorId: string|null, actorRef: string|null, label: string}[]>} refuses INVALID_TRAIT_DATA
 */
export function challengedPoolTraits(pool) {
  const listed = poolTraits(pool);
  if ( !listed.ok ) return listed;
  return ok(listed.value.filter(trait => trait.option === "challenge")
    .map(({ key, setId, traitId, actorId, actorRef, label }) => ({ key, setId, traitId, actorId, actorRef, label })));
}

/**
 * The pool without the dice of some traits, for example the challenged ones after the roll, so a
 * re-roll of the kept pool can't reuse the dice from before the step-down (ADR-048 point 2).
 * @param {import("./types.mjs").PoolDie[]} pool
 * @param {string[]} keys - trait keys from poolTraits or challengedPoolTraits
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").PoolDie[]>} refuses
 *   INVALID_TRAIT_DATA
 */
export function withoutPoolTraits(pool, keys) {
  if ( !isPool(pool) || !Array.isArray(keys) ) return fail("INVALID_TRAIT_DATA");
  const remove = new Set(keys);
  return ok(copyStored(pool.filter(die => !(isTraitDie(die) && remove.has(traitKeyOf(die.source))))));
}

/**
 * A set's entries after a challenged statement's roll (rule 16; TS-14, TS-14b, TS-16, TS-16c;
 * ADR-048): the challenged trait as challengeStatement leaves it, every other entry as stored.
 * The whole list is returned because a write replaces a set's entries (ADR-037 point 3).
 * @param {import("./types.mjs").CharacterTraitData} system - the actor's stored data
 * @param {import("./types.mjs").GameConfig} config
 * @param {string} setId
 * @param {string} traitId - a fixed set's definition id or an open set's entry id
 * @returns {import("./types.mjs").EngineResult<object[]>} refuses INVALID_TRAIT_DATA,
 *   UNKNOWN_TRAIT_SET, UNKNOWN_TRAIT (no entry for that trait) or challengeStatement's codes
 */
export function entriesAfterChallenge(system, config, setId, traitId) {
  if ( !isPlainObject(system) || !isPlainObject(config) || !Array.isArray(config.traitSets)
    || (typeof setId !== "string") || (typeof traitId !== "string") ) return fail("INVALID_TRAIT_DATA");
  const set = traitSetById(config, setId);
  if ( !isPlainObject(set) ) return fail("UNKNOWN_TRAIT_SET");
  const setData = system.traits?.[setId];
  const entry = entryFor(setData, traitId, set.list === "fixed");
  if ( !entry ) return fail("UNKNOWN_TRAIT");
  const challenged = challengeStatement(entry);
  if ( !challenged.ok ) return challenged;
  return ok(setData.entries.map(stored => copyStored((stored === entry) ? challenged.value : stored)));
}
