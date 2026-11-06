/**
 * The game configuration: the trait sets a game uses and the actor kinds that bundle them
 * (Traits & Trait Sets spec, Decisions ADR-030, ADR-031, ADR-034 and ADR-036). The world setting
 * that stores it is Foundry code; what a valid configuration is, the defaults a new world starts
 * with, and the lookups the other checks need are decided here, without Foundry.
 * @module rules/game-config
 */

import { DIE_SIZES } from "./types.mjs";

/** The current version of the game configuration's shape. */
export const GAME_CONFIG_SCHEMA_VERSION = 1;

/** What a set does in the game (rule 7, rule 10). */
export const TRAIT_SET_ROLES = Object.freeze(["distinctions", "prime", "other"]);

/** Whether the GM defines a set's traits or each actor adds its own (ADR-034). */
export const TRAIT_SET_LISTS = Object.freeze(["fixed", "open"]);

/**
 * Whether a further trait from a set costs a plot point, or the game's rules don't allow one
 * (rule 6). Not allowing it gives a warning; the die stays in the pool (TS-10, ADR-029).
 */
export const EXTRA_TRAIT_RULES = Object.freeze(["pp", "none"]);

/** The per-set switches for what a set's traits carry (rules 11 and 13-20). */
export const TRAIT_SET_FEATURES = Object.freeze([
  "description", "sfx", "statements", "tags", "subTraits", "hinder", "setSfx", "shutDown"
]);

/** The fewest sets in the prime role the Handbook advises (rule 7; Handbook p. 26, p. 47; ADR-041). */
const MIN_PRIME_SETS = 2;

const ID_PATTERN = /^[a-zA-Z0-9]{16}$/;

/** @returns {boolean} whether value is an id in Foundry's 16-character format */
function isId(value) {
  return (typeof value === "string") && ID_PATTERN.test(value);
}

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

/** @returns {boolean} whether value is a die size or null, the "no guidance" value */
function isSizeOrNull(value) {
  return (value === null) || DIE_SIZES.includes(value);
}

/**
 * A deep copy of plain data: objects, arrays and primitives; anything else is kept as it is. The
 * configuration is plain data. An empty slot in an array becomes undefined, so the checks see it
 * instead of skipping it, and each property is read once, so the checks and the returned copy
 * see the same values.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function copyPlain(value) {
  if ( Array.isArray(value) ) return Array.from(value, copyPlain);
  if ( isPlainObject(value) ) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copyPlain(v)]));
  return value;
}

/**
 * The code for a value that should be a die size or null: INVALID_DIE_SIZE for a number that
 * isn't a die size (TS-E01), INVALID_TRAIT_SET for anything that isn't a number, or null if fine.
 * @param {unknown} value
 * @returns {string|null}
 */
function sizeProblem(value) {
  if ( isSizeOrNull(value) ) return null;
  return (typeof value === "number") ? "INVALID_DIE_SIZE" : "INVALID_TRAIT_SET";
}

/**
 * Collects the problems of one trait set, in field order.
 * @param {unknown} set
 * @param {string} path
 * @param {(code: string, path: string) => void} report
 * @param {(id: unknown, path: string, code: string) => void} claimId
 */
function checkTraitSet(set, path, report, claimId) {
  if ( !isPlainObject(set) ) return report("INVALID_TRAIT_SET", path);
  claimId(set.id, `${path}.id`, "INVALID_TRAIT_SET");
  if ( !isName(set.name) ) report("INVALID_TRAIT_SET", `${path}.name`);
  if ( !TRAIT_SET_ROLES.includes(set.role) ) report("INVALID_TRAIT_SET", `${path}.role`);
  if ( !TRAIT_SET_LISTS.includes(set.list) ) report("INVALID_TRAIT_SET", `${path}.list`);

  // A fixed set holds its definitions; an open set has none, because actors name their own.
  if ( set.list === "fixed" ) {
    if ( !Array.isArray(set.traits) ) report("INVALID_TRAIT_SET", `${path}.traits`);
    else set.traits.forEach((def, i) => checkTraitDef(def, `${path}.traits.${i}`, report, claimId));
  }
  else if ( (set.list === "open") && (set.traits !== undefined)
    && !(Array.isArray(set.traits) && (set.traits.length === 0)) ) report("INVALID_TRAIT_SET", `${path}.traits`);

  for ( const option of ["hasDice", "multiDice", "sameSizeDice"] ) {
    if ( typeof set[option] !== "boolean" ) report("INVALID_TRAIT_SET", `${path}.${option}`);
  }

  // Guidance (rule 9) and the fallback (rule 8). A set without dice keeps them unused, so a GM
  // who turns dice off and on again loses nothing (as stored ratings are kept, ADR-037 point 5).
  for ( const key of ["usualMin", "usualMax", "startingRating"] ) {
    const problem = sizeProblem(set[key]);
    if ( problem ) report(problem, `${path}.${key}`);
    else if ( (key === "usualMax") && (set.usualMax !== null) && DIE_SIZES.includes(set.usualMin)
      && (set.usualMin > set.usualMax) ) report("INVALID_TRAIT_SET", `${path}.usualMax`);
  }
  // The fallback is a d4 or none (rule 8): another real size is a wrong choice, not a missing die.
  if ( set.fallbackDie !== 4 ) {
    const problem = sizeProblem(set.fallbackDie);
    if ( problem ) report(problem, `${path}.fallbackDie`);
    else if ( set.fallbackDie !== null ) report("INVALID_TRAIT_SET", `${path}.fallbackDie`);
  }

  if ( !EXTRA_TRAIT_RULES.includes(set.extraTraits) ) report("INVALID_TRAIT_SET", `${path}.extraTraits`);
  if ( !isPlainObject(set.features) ) report("INVALID_TRAIT_SET", `${path}.features`);
  else {
    for ( const feature of TRAIT_SET_FEATURES ) {
      if ( typeof set.features[feature] !== "boolean" ) report("INVALID_TRAIT_SET", `${path}.features.${feature}`);
    }
  }
}

/**
 * Collects the problems of one trait definition in a fixed set.
 * @param {unknown} def
 * @param {string} path
 * @param {(code: string, path: string) => void} report
 * @param {(id: unknown, path: string, code: string) => void} claimId
 */
function checkTraitDef(def, path, report, claimId) {
  if ( !isPlainObject(def) ) return report("INVALID_TRAIT_DEFINITION", path);
  claimId(def.id, `${path}.id`, "INVALID_TRAIT_DEFINITION");
  if ( !isName(def.name) ) report("INVALID_TRAIT_DEFINITION", `${path}.name`);
  if ( (def.description !== undefined) && (typeof def.description !== "string") ) {
    report("INVALID_TRAIT_DEFINITION", `${path}.description`);
  }
}

/**
 * Collects the problems of one actor kind.
 * @param {unknown} kind
 * @param {string} path
 * @param {Set<string>} setIds - the valid ids of the configuration's sets
 * @param {(code: string, path: string) => void} report
 * @param {(id: unknown, path: string, code: string) => void} claimId
 */
function checkActorKind(kind, path, setIds, report, claimId) {
  if ( !isPlainObject(kind) ) return report("INVALID_ACTOR_KIND", path);
  claimId(kind.id, `${path}.id`, "INVALID_ACTOR_KIND");
  if ( !isName(kind.name) ) report("INVALID_ACTOR_KIND", `${path}.name`);
  if ( !Array.isArray(kind.traitSetIds) ) report("INVALID_ACTOR_KIND", `${path}.traitSetIds`);
  else {
    const seen = new Set();
    kind.traitSetIds.forEach((setId, i) => {
      if ( !setIds.has(setId) ) report("UNKNOWN_TRAIT_SET", `${path}.traitSetIds.${i}`);
      else if ( seen.has(setId) ) report("INVALID_ACTOR_KIND", `${path}.traitSetIds.${i}`);
      seen.add(setId);
    });
  }
  if ( typeof kind.freeTraits !== "boolean" ) report("INVALID_ACTOR_KIND", `${path}.freeTraits`);
}

/**
 * Checks a game configuration (ADR-030). Errors are data that can't work: a malformed shape, an
 * id that isn't 16 letters or digits or is used twice anywhere in the configuration, a value
 * outside its choices, a die size that doesn't exist (TS-E01), a usual range whose minimum is
 * above its maximum, and an actor kind that names a set the configuration doesn't have (a broken
 * reference, ADR-029 point 2; removeTraitSet takes a removed set out of the kinds as well).
 *
 * The Handbook's advice on which sets a game has is guidance, shown and not enforced (ADR-041):
 * no set in the distinctions role warns DISTINCTIONS_SET_MISSING (Statements as Distinction
 * Alternates (MOD), p. 66, is one design without such a set), and fewer than two sets in the
 * prime role warns PRIME_SETS_TOO_FEW (rule 7; Handbook p. 26, p. 47). A set that takes the
 * place of distinctions as the game's equivalent descriptive set (p. 26) has the distinctions
 * role too. Every set with a role counts, even one that has errors of its own.
 *
 * Uses the ADR-042 variant of the EngineResult (ADR-025): it lists every problem for the GM's
 * configuration form, and `code` is the first error. `errors` and `warnings` are separate lists
 * of `{code, path}`; `warnings` is there in both outcomes and never affects `ok`. Guidance (usual
 * range, starting rating) is only checked for being dice, never against a trait's rating, and a
 * set without dice may keep it unused. Fields it doesn't know are kept and features it doesn't
 * know are ignored, so a later version can add some. The checks run on a copy, which is what is
 * returned. Pure: no Foundry, and it never changes its input.
 * @param {unknown} input - the configuration to check
 * @returns {{ok: true, value: import("./types.mjs").GameConfig, errors: [],
 *   warnings: {code: string, path: string}[]}
 *   | {ok: false, code: string, errors: {code: string, path: string}[],
 *   warnings: {code: string, path: string}[]}} paths name the field, e.g.
 *   "traitSets.2.usualMin". Errors: INVALID_GAME_CONFIG (the top level isn't an object with a
 *   whole-number schemaVersion from 1 and lists of traitSets and actorKinds) and
 *   SCHEMA_VERSION_TOO_NEW (a schemaVersion above GAME_CONFIG_SCHEMA_VERSION), each reported
 *   alone and with no warnings; otherwise INVALID_TRAIT_SET, INVALID_TRAIT_DEFINITION,
 *   INVALID_ACTOR_KIND, INVALID_DIE_SIZE, DUPLICATE_CONFIG_ID and UNKNOWN_TRAIT_SET. Warnings, in
 *   this order: DISTINCTIONS_SET_MISSING, PRIME_SETS_TOO_FEW
 */
export function validateGameConfig(input) {
  const alone = (code, path) => ({ ok: false, code, errors: [{ code, path }], warnings: [] });
  if ( !isPlainObject(input) ) return alone("INVALID_GAME_CONFIG", "");
  const config = copyPlain(input);
  if ( !Number.isInteger(config.schemaVersion) || (config.schemaVersion < 1) ) {
    return alone("INVALID_GAME_CONFIG", "schemaVersion");
  }
  if ( config.schemaVersion > GAME_CONFIG_SCHEMA_VERSION ) return alone("SCHEMA_VERSION_TOO_NEW", "schemaVersion");
  if ( !Array.isArray(config.traitSets) ) return alone("INVALID_GAME_CONFIG", "traitSets");
  if ( !Array.isArray(config.actorKinds) ) return alone("INVALID_GAME_CONFIG", "actorKinds");

  const errors = [];
  const report = (code, path) => { errors.push({ code, path }); };
  const usedIds = new Set();
  const claimId = (id, path, invalidCode) => {
    if ( !isId(id) ) report(invalidCode, path);
    else if ( usedIds.has(id) ) report("DUPLICATE_CONFIG_ID", path);
    else usedIds.add(id);
  };

  config.traitSets.forEach((set, i) => checkTraitSet(set, `traitSets.${i}`, report, claimId));
  const setIds = new Set(config.traitSets.filter(set => isPlainObject(set) && isId(set.id)).map(set => set.id));
  config.actorKinds.forEach((kind, i) => checkActorKind(kind, `actorKinds.${i}`, setIds, report, claimId));

  const warnings = [];
  const roleCount = role => config.traitSets.filter(set => isPlainObject(set) && (set.role === role)).length;
  if ( roleCount("distinctions") === 0 ) warnings.push({ code: "DISTINCTIONS_SET_MISSING", path: "traitSets" });
  if ( roleCount("prime") < MIN_PRIME_SETS ) warnings.push({ code: "PRIME_SETS_TOO_FEW", path: "traitSets" });

  if ( errors.length ) return { ok: false, code: errors[0].code, errors, warnings };
  return { ok: true, value: config, errors: [], warnings };
}

/**
 * The configuration without one trait set, and without that set in any actor kind, so the
 * result has no broken reference (ADR-029 point 2). Actors keep their entries in the removed
 * set as stored (ADR-037 point 5); this only changes the configuration.
 * @param {import("./types.mjs").GameConfig} config
 * @param {string} setId
 * @returns {import("./types.mjs").GameConfig} a new object; the same content when no set has
 *   that id
 */
export function removeTraitSet(config, setId) {
  const copy = copyPlain(config);
  copy.traitSets = copy.traitSets.filter(set => set?.id !== setId);
  for ( const kind of copy.actorKinds ) {
    if ( Array.isArray(kind?.traitSetIds) ) kind.traitSetIds = kind.traitSetIds.filter(id => id !== setId);
  }
  return copy;
}

/**
 * @param {import("./types.mjs").GameConfig} config
 * @param {unknown} setId
 * @returns {import("./types.mjs").TraitSetDef|null}
 */
export function traitSetById(config, setId) {
  return config.traitSets.find(set => set?.id === setId) ?? null;
}

/**
 * @param {import("./types.mjs").TraitSetDef} set
 * @param {unknown} defId
 * @returns {import("./types.mjs").TraitDef|null} the definition, or null; an open set has none
 */
export function traitDefById(set, defId) {
  return (set.list === "fixed" ? set.traits?.find(def => def?.id === defId) : null) ?? null;
}

/**
 * @param {import("./types.mjs").GameConfig} config
 * @param {unknown} kindId
 * @returns {import("./types.mjs").ActorKindDef|null}
 */
export function actorKindById(config, kindId) {
  return config.actorKinds.find(kind => kind?.id === kindId) ?? null;
}

/**
 * Whether an actor kind uses prime sets, derived from its sets rather than stored (Traits &
 * Trait Sets implementation notes): only such kinds get the missing-prime-set hint (rule 7,
 * TS-17b). No kind uses none; a set id the configuration doesn't have (which
 * validateGameConfig refuses) counts as no prime set.
 * @param {import("./types.mjs").ActorKindDef|null} kind
 * @param {import("./types.mjs").GameConfig} config
 * @returns {boolean}
 */
export function kindUsesPrimeSets(kind, config) {
  if ( !kind ) return false;
  return kind.traitSetIds.some(setId => traitSetById(config, setId)?.role === "prime");
}

/**
 * A set's shape options in the form validateRating takes (ADR-037 point 2).
 * @param {import("./types.mjs").TraitSetDef} set
 * @returns {{hasDice: boolean, multiDice: boolean, sameSizeDice: boolean}}
 */
export function ratingOptionsOf(set) {
  return { hasDice: set.hasDice, multiDice: set.multiDice, sameSizeDice: set.sameSizeDice };
}

/** @returns {Record<string, boolean>} every feature, all off, with the given ones on */
function features(...on) {
  return Object.fromEntries(TRAIT_SET_FEATURES.map(feature => [feature, on.includes(feature)]));
}

/**
 * The configuration a new world starts with (ADR-036 as amended by ADR-040): distinctions, plus
 * attributes and skills as the two prime sets, the pairing the Handbook's examples use (p. 26).
 * Trait names are plain single words of our own choosing (ADR-040 point 3): a name may be a word
 * the Handbook also uses, but no Handbook list is reproduced as a whole and no Handbook
 * description is used; the definitions have no descriptions. Ids are fixed, so every world's
 * defaults share them.
 *
 * - Distinctions: an open list, one die each, d8 to start (rule 10, p. 50), with Hinder and
 *   SFX (rule 11, p. 50, p. 61) and a short descriptive line (rule 13).
 * - Attributes: Physical, Mental and Social; d8 to start, d6 to d10 as guidance (pp. 48-49); a
 *   d4 fallback, as for any prime set with no rating noted (p. 47).
 * - Skills: twelve skills; d4 to start, d4 to d12 as guidance, and a d4 fallback, since everyone
 *   has at least d4 in each skill (p. 58).
 * - Scene distinctions: a location's distinctions, in their own open set (RQ-031) that allows
 *   several dice, so a scene distinction an SFX splits into two dice can be stored (TS-07;
 *   p. 116; ADR-037 consequences). Hinder and SFX are on, as for any distinction (p. 116). Its
 *   role is "other": it belongs to locations and doesn't take the place of the characters'
 *   distinctions.
 * - Mob trait: an open set whose ratings are several dice of one size, so a mixed rating is
 *   refused when edited (rule 22, p. 117; TS-E02).
 * - Kinds: PC; major GMC, which uses the PC's sets (p. 114); minor GMC, free traits only
 *   (p. 115); mob, with the mob trait and free traits for what its members share (p. 117);
 *   location, with scene distinctions and free traits (p. 116). Extras and bosses can use the
 *   minor GMC kind (pp. 115, 118) until a GM adds kinds; free traits belong to no set, so they
 *   can hold several dice, as a boss's trait does (p. 118).
 *
 * Every set allows further traits for a plot point (rule 6) and offers the shut-down flag
 * (rule 15). Rating guidance is a hint on the sheet, never a refusal (rule 9).
 * @returns {import("./types.mjs").GameConfig} a new object every call
 */
export function defaultGameConfig() {
  const set = fields => ({
    traits: undefined, hasDice: true, multiDice: false, sameSizeDice: false, usualMin: null, usualMax: null,
    startingRating: null, fallbackDie: null, extraTraits: "pp", ...fields
  });
  const defs = (prefix, names) => names.map(name => ({ id: `${prefix}${name}`.padEnd(16, "0"), name }));
  const sets = [
    set({
      id: "cpSetDistinction", name: "Distinctions", role: "distinctions", list: "open", startingRating: 8,
      features: features("description", "sfx", "hinder", "shutDown")
    }),
    set({
      id: "cpSetAttributes0", name: "Attributes", role: "prime", list: "fixed",
      traits: defs("cpAttr", ["Physical", "Mental", "Social"]),
      usualMin: 6, usualMax: 10, startingRating: 8, fallbackDie: 4, features: features("shutDown")
    }),
    set({
      id: "cpSetSkills00000", name: "Skills", role: "prime", list: "fixed",
      traits: defs("cpSkill", [
        "Fight", "Shoot", "Throw", "Sneak", "Drive", "Pilot", "Repair", "Heal", "Persuade", "Deceive", "Notice", "Study"
      ]),
      usualMin: 4, usualMax: 12, startingRating: 4, fallbackDie: 4, features: features("shutDown")
    }),
    set({
      id: "cpSetSceneDistin", name: "Scene distinctions", role: "other", list: "open", multiDice: true,
      startingRating: 8, features: features("sfx", "hinder", "shutDown")
    }),
    set({
      id: "cpSetMobTrait000", name: "Mob trait", role: "other", list: "open", multiDice: true, sameSizeDice: true,
      features: features("shutDown")
    })
  ];
  for ( const s of sets ) if ( s.traits === undefined ) delete s.traits;
  const pcSets = ["cpSetDistinction", "cpSetAttributes0", "cpSetSkills00000"];
  return {
    schemaVersion: GAME_CONFIG_SCHEMA_VERSION,
    traitSets: sets,
    actorKinds: [
      { id: "cpKindPlayerChar", name: "Player character", traitSetIds: [...pcSets], freeTraits: false },
      { id: "cpKindMajorGmc00", name: "Major GMC", traitSetIds: [...pcSets], freeTraits: false },
      { id: "cpKindMinorGmc00", name: "Minor GMC", traitSetIds: [], freeTraits: true },
      { id: "cpKindMob0000000", name: "Mob", traitSetIds: ["cpSetMobTrait000"], freeTraits: true },
      { id: "cpKindLocation00", name: "Location", traitSetIds: ["cpSetSceneDistin"], freeTraits: true }
    ]
  };
}
