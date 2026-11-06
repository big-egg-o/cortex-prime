/**
 * Editing a draft of the game configuration in the GM's configuration app (Decisions ADR-030):
 * adding, removing and moving trait sets, definitions and actor kinds, and reading the app's
 * form back into the draft. Plain list editing, not rules: whether the result is a valid
 * configuration is validateGameConfig's job when the GM saves. Pure: no Foundry globals and
 * imports only from module/rules/ (checked by tests/unit/rules-boundary.test.mjs); ids are made
 * by the caller. Every function returns a new draft and never changes its inputs.
 * @module config/game-config-draft
 */

import { TRAIT_SET_FEATURES, removeTraitSet, validateGameConfig } from "../rules/game-config.mjs";
import { DIE_SIZES } from "../rules/types.mjs";

/** @returns {boolean} whether value is a plain object, not an array, class instance or null */
function isPlainObject(value) {
  if ( (value === null) || (typeof value !== "object") ) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype) || (proto === null);
}

/**
 * A deep copy of plain data.
 * @param {unknown} value
 * @returns {unknown}
 */
function copyPlain(value) {
  if ( Array.isArray(value) ) return value.map(copyPlain);
  if ( isPlainObject(value) ) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copyPlain(v)]));
  return value;
}

/**
 * Moves the item with an id by `delta` places, staying inside the list.
 * @template {{id: string}} T
 * @param {T[]} list
 * @param {string} id
 * @param {number} delta
 * @returns {T[]}
 */
function moved(list, id, delta) {
  const from = list.findIndex(item => item.id === id);
  if ( from === -1 ) return list;
  const to = Math.min(Math.max(from + delta, 0), list.length - 1);
  const copy = [...list];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

/**
 * A new, empty trait set: open, in the "other" role, one die per trait, further traits for a
 * plot point, every feature off except the shut-down flag (the defaults' choice, ADR-036).
 * @param {string} id
 * @param {string} name
 * @returns {import("../rules/types.mjs").TraitSetDef}
 */
export function newTraitSet(id, name) {
  return {
    id, name, role: "other", list: "open", traits: [], hasDice: true, multiDice: false, sameSizeDice: false,
    usualMin: null, usualMax: null, startingRating: null, fallbackDie: null, extraTraits: "pp",
    features: Object.fromEntries(TRAIT_SET_FEATURES.map(feature => [feature, feature === "shutDown"]))
  };
}

/**
 * @param {import("../rules/types.mjs").GameConfig} draft
 * @param {string} id
 * @param {string} name
 * @returns {import("../rules/types.mjs").GameConfig} the draft with a new set at the end
 */
export function addTraitSet(draft, id, name) {
  const copy = copyPlain(draft);
  copy.traitSets.push(newTraitSet(id, name));
  return copy;
}

/**
 * The draft without a set, also taken out of every actor kind (removeTraitSet).
 * @param {import("../rules/types.mjs").GameConfig} draft
 * @param {string} setId
 * @returns {import("../rules/types.mjs").GameConfig}
 */
export function deleteTraitSet(draft, setId) {
  return removeTraitSet(draft, setId);
}

/**
 * @param {import("../rules/types.mjs").GameConfig} draft
 * @param {string} setId
 * @param {number} delta - -1 up, 1 down
 * @returns {import("../rules/types.mjs").GameConfig}
 */
export function moveTraitSet(draft, setId, delta) {
  const copy = copyPlain(draft);
  copy.traitSets = moved(copy.traitSets, setId, delta);
  return copy;
}

/**
 * Adds a definition to a fixed set (ADR-034); a set that isn't fixed is left as it is.
 * @param {import("../rules/types.mjs").GameConfig} draft
 * @param {string} setId
 * @param {string} id
 * @param {string} name
 * @returns {import("../rules/types.mjs").GameConfig}
 */
export function addTraitDef(draft, setId, id, name) {
  const copy = copyPlain(draft);
  const set = copy.traitSets.find(s => s.id === setId);
  if ( set?.list === "fixed" ) (set.traits ??= []).push({ id, name });
  return copy;
}

/**
 * Removes a definition. Actors keep their values for it, which then show as orphaned (TS-E03).
 * @param {import("../rules/types.mjs").GameConfig} draft
 * @param {string} setId
 * @param {string} defId
 * @returns {import("../rules/types.mjs").GameConfig}
 */
export function deleteTraitDef(draft, setId, defId) {
  const copy = copyPlain(draft);
  const set = copy.traitSets.find(s => s.id === setId);
  if ( Array.isArray(set?.traits) ) set.traits = set.traits.filter(def => def.id !== defId);
  return copy;
}

/**
 * @param {import("../rules/types.mjs").GameConfig} draft
 * @param {string} setId
 * @param {string} defId
 * @param {number} delta
 * @returns {import("../rules/types.mjs").GameConfig}
 */
export function moveTraitDef(draft, setId, defId, delta) {
  const copy = copyPlain(draft);
  const set = copy.traitSets.find(s => s.id === setId);
  if ( Array.isArray(set?.traits) ) set.traits = moved(set.traits, defId, delta);
  return copy;
}

/**
 * @param {import("../rules/types.mjs").GameConfig} draft
 * @param {string} id
 * @param {string} name
 * @returns {import("../rules/types.mjs").GameConfig} the draft with a new kind using no sets
 */
export function addActorKind(draft, id, name) {
  const copy = copyPlain(draft);
  copy.actorKinds.push({ id, name, traitSetIds: [], freeTraits: false });
  return copy;
}

/**
 * Removes a kind. Actors keep it as their kindId, which then matches nothing (ADR-037 point 1).
 * @param {import("../rules/types.mjs").GameConfig} draft
 * @param {string} kindId
 * @returns {import("../rules/types.mjs").GameConfig}
 */
export function deleteActorKind(draft, kindId) {
  const copy = copyPlain(draft);
  copy.actorKinds = copy.actorKinds.filter(kind => kind.id !== kindId);
  return copy;
}

/**
 * Turns a form value into a die size or null: "" and null are no value; a string of a die
 * size's digits is that size; anything else is kept as given, for validateGameConfig to report.
 * @param {unknown} value
 * @returns {unknown}
 */
function sizeFromForm(value) {
  if ( (value === "") || (value === null) || (value === undefined) ) return null;
  const number = (typeof value === "string") ? Number(value) : value;
  return DIE_SIZES.includes(number) ? number : value;
}

/**
 * A list given as an array, or as an object with numeric keys (as expanded form data gives it),
 * each value at its key's position.
 * @param {unknown} value
 * @returns {unknown[]}
 */
function listFromForm(value) {
  if ( Array.isArray(value) ) return value;
  if ( !isPlainObject(value) ) return [];
  const list = [];
  for ( const [key, item] of Object.entries(value) ) if ( /^\d+$/.test(key) ) list[Number(key)] = item;
  return list;
}

const SET_TEXT_FIELDS = ["name", "role", "list", "extraTraits"];
const SET_BOOLEAN_FIELDS = ["hasDice", "multiDice", "sameSizeDice"];
const SET_SIZE_FIELDS = ["usualMin", "usualMax", "startingRating", "fallbackDie"];

/**
 * Reads the configuration app's form into the draft. The form names its fields by position, as
 * expanded form data gives them: `traitSets.<i>.<field>`, `traitSets.<i>.features.<feature>`,
 * `traitSets.<i>.traits.<j>.name`/`description`, `actorKinds.<i>.name`/`freeTraits`, and
 * `actorKinds.<i>.sets.<setId>` (a checkbox per set). Positions refer to the draft the form was
 * rendered from, so ids, order and list membership never come from the form; only the values of
 * fields that exist in the draft are read, and a kind's sets keep the draft's set order. Die-size
 * fields turn "" into null and digits into numbers; values that aren't valid are kept for
 * validateGameConfig to report. A set switched from fixed to open keeps its definitions, so
 * nothing is lost by switching back; validateGameConfig reports them until the GM removes them.
 * @param {import("../rules/types.mjs").GameConfig} draft
 * @param {object} form - the expanded form data
 * @returns {import("../rules/types.mjs").GameConfig}
 */
export function applyConfigForm(draft, form) {
  const copy = copyPlain(draft);
  if ( !isPlainObject(form) ) return copy;
  const setForms = listFromForm(form.traitSets);
  copy.traitSets.forEach((set, i) => {
    const values = setForms[i];
    if ( !isPlainObject(values) ) return;
    for ( const key of SET_TEXT_FIELDS ) if ( typeof values[key] === "string" ) set[key] = values[key];
    for ( const key of SET_BOOLEAN_FIELDS ) if ( typeof values[key] === "boolean" ) set[key] = values[key];
    for ( const key of SET_SIZE_FIELDS ) if ( key in values ) set[key] = sizeFromForm(values[key]);
    if ( isPlainObject(values.features) && isPlainObject(set.features) ) {
      for ( const feature of TRAIT_SET_FEATURES ) {
        if ( typeof values.features[feature] === "boolean" ) set.features[feature] = values.features[feature];
      }
    }
    const defForms = listFromForm(values.traits);
    (set.traits ?? []).forEach((def, j) => {
      const defValues = defForms[j];
      if ( !isPlainObject(defValues) ) return;
      if ( typeof defValues.name === "string" ) def.name = defValues.name;
      if ( typeof defValues.description === "string" ) {
        if ( defValues.description.trim() === "" ) delete def.description;
        else def.description = defValues.description;
      }
    });
  });
  const kindForms = listFromForm(form.actorKinds);
  copy.actorKinds.forEach((kind, i) => {
    const values = kindForms[i];
    if ( !isPlainObject(values) ) return;
    if ( typeof values.name === "string" ) kind.name = values.name;
    if ( typeof values.freeTraits === "boolean" ) kind.freeTraits = values.freeTraits;
    if ( isPlainObject(values.sets) ) {
      kind.traitSetIds = copy.traitSets.map(set => set.id).filter(id => {
        if ( typeof values.sets[id] === "boolean" ) return values.sets[id];
        return kind.traitSetIds.includes(id);
      });
    }
  });
  return copy;
}

/**
 * Groups validateGameConfig's errors by path, for showing each next to its field.
 * @param {{code: string, path: string}[]} errors
 * @returns {Record<string, string[]>} codes by path
 */
export function errorsByPath(errors) {
  const byPath = {};
  for ( const { code, path } of errors ?? [] ) (byPath[path] ??= []).push(code);
  return byPath;
}

/**
 * The warnings of a draft, which the app shows whenever it renders, apart from the errors of the
 * last save (ADR-041 point 4). They come from validateGameConfig and never stop a save: they are
 * the Handbook's guidance on which sets a game has, not refusals.
 * @param {unknown} draft
 * @returns {string[]} the warning codes in validateGameConfig's order; none for a draft it can't
 *   read far enough to check
 */
export function draftWarnings(draft) {
  return validateGameConfig(draft).warnings.map(warning => warning.code);
}

/**
 * The current draft's errors by path (errorsByPath). The app shows them once a save has failed
 * and builds them again on every render, so an error stays on the entry that has it when entries
 * move or are removed, and goes away once it is fixed.
 * @param {unknown} draft
 * @returns {Record<string, string[]>} codes by path; none for a draft without errors
 */
export function draftErrors(draft) {
  return errorsByPath(validateGameConfig(draft).errors);
}

/**
 * What the app's template shows of a draft beyond the values its inputs already hold: the
 * warnings, the errors while they are shown, and whether each set has a fixed or an open list.
 * The app renders again after a form change only when this changes, so what it shows stays
 * current without interrupting typing.
 * @param {unknown} draft
 * @param {{showErrors: boolean}} options - whether the app is showing errors (after a failed save)
 * @returns {string}
 */
export function draftRenderKey(draft, { showErrors }) {
  const lists = Array.isArray(draft?.traitSets) ? draft.traitSets.map(set => set?.list) : [];
  return JSON.stringify([draftWarnings(draft), showErrors ? draftErrors(draft) : {}, lists]);
}
