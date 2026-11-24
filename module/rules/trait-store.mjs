/**
 * The pure half of the GM's handler for the temporary trait store (Decisions ADR-057, step 4.8a).
 * Every asset and complication of the world lives in one store: a revision, the traits, the scene
 * boosts of signature assets, the GM's table-visible notes by trait id, and the actions already
 * done, so a retried request gets its first answer instead of a second change. The Foundry side
 * (module/assets/) receives a request as a user query, builds the plain inputs below, calls
 * dispatchTraitStoreRequest and writes what it returns: the new store and, for an action that
 * costs plot points, one balance change. A refusal writes nothing.
 *
 * Nothing here reads a Foundry document. The handler passes in:
 * - the sender, `{userId, isGM}`, from the user the query came from (never from the request);
 * - the request as sent, `{action, actionId, revision, payload}`;
 * - the store as stored;
 * - for each actor the request names, by actor key (its UUID): whether the sender owns it, whether
 *   it holds its own plot points (a PC, P1) and its balance;
 * - the bank's balance.
 *
 * The checks, in order, stopping at the first that fails (ADR-025):
 * 1. STORE_INVALID: the stored data doesn't pass the engine's checks.
 * 2. MALFORMED_REQUEST: the request's shape.
 * 3. A request whose actionId is already done returns that first answer, `replayed: true`, with
 *    nothing to write; ACTION_ID_REUSED when another user sent it.
 * 4. UNSUPPORTED_ACTION.
 * 5. The sender: GM_ONLY for the tracker's actions; for a player's action TRAIT_NOT_FOUND,
 *    NOT_A_CHARACTER_ASSET, ACTOR_NOT_FOUND, then NOT_YOUR_CHARACTER.
 * 6. STALE_REVISION: the request was made against another revision.
 * 7. The action's own checks and the engine's codes.
 * 8. The payment: PP_GM_ONLY when the bank would pay for a user who isn't a GM, PP_INSUFFICIENT.
 * @module rules/trait-store
 */

import {
  applyComplications, checkTemporaryTrait, createAsset, endScene, endSession, stepTemporaryTrait, upgradeAsset
} from "./assets.mjs";
import { changeBalance } from "./plot-points.mjs";
import { fail, ok } from "./result.mjs";

/** The store's actions and who may send each: "gm" for the tracker, "owner" for a character's owner or a GM. */
export const TRAIT_STORE_ACTIONS = Object.freeze({
  addComplication: "gm",
  addAsset: "gm",
  step: "gm",
  assign: "gm",
  setNote: "gm",
  remove: "gm",
  endScene: "gm",
  endSession: "gm",
  buyAsset: "owner",
  keepAsset: "owner",
  openAsset: "owner"
});

/** The longest table-visible note, in characters. */
export const MAX_NOTE_LENGTH = 500;

/** How many done actions the store remembers for retries. */
export const COMPLETED_ACTIONS_KEPT = 50;

const ACTION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const ID_PATTERN = /^[a-zA-Z0-9]{16}$/;

/**
 * The stored data (ADR-057).
 * @typedef {Object} TraitStore
 * @property {number} revision - raised by one on every write
 * @property {import("./assets.mjs").TemporaryTrait[]} traits
 * @property {import("./assets.mjs").SceneBoost[]} sceneBoosts
 * @property {Object<string, string>} notes - trait id to its table-visible note
 * @property {{actionId: string, userId: string, revision: number}[]} completedActions - oldest first
 */

/**
 * What the handler knows of one actor a request names.
 * @typedef {{ownedBySender: boolean, holdsPlotPoints: boolean, balance: number|null}} StoreActorFacts
 */

/**
 * One balance change a request makes. The account names the actor by its key.
 * @typedef {Object} StorePayment
 * @property {{kind: "actor", actorKey: string}|{kind: "bank"}} account
 * @property {number} delta
 * @property {number} balance - the balance after the change
 * @property {import("./types.mjs").PpLine} line
 */

/** @returns {TraitStore} the store of a world that has none yet */
export function emptyTraitStore() {
  return { revision: 0, traits: [], sceneBoosts: [], notes: {}, completedActions: [] };
}

/** @returns {boolean} whether value is a plain object, not an array, class instance or null */
function isPlainObject(value) {
  if ( (value === null) || (typeof value !== "object") ) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype) || (proto === null);
}

/** @returns {boolean} whether value is a whole number of at least 0 */
function isWhole(value) {
  return Number.isInteger(value) && (value >= 0);
}

/**
 * Checks the stored data and returns a copy.
 * @param {unknown} store
 * @returns {import("./types.mjs").EngineResult<TraitStore>}
 */
export function checkTraitStore(store) {
  if ( !isPlainObject(store) || !isWhole(store.revision) || !Array.isArray(store.traits)
    || !Array.isArray(store.sceneBoosts) || !isPlainObject(store.notes) || !Array.isArray(store.completedActions) ) {
    return fail("STORE_INVALID");
  }
  const ended = endScene({ traits: store.traits, sceneBoosts: store.sceneBoosts });
  if ( !ended.ok ) return fail("STORE_INVALID");
  const traits = [];
  for ( const trait of store.traits ) traits.push(checkTemporaryTrait(trait).value);
  const notes = {};
  for ( const [id, note] of Object.entries(store.notes) ) {
    if ( !traits.some(t => t.id === id) || (typeof note !== "string") || (note.length > MAX_NOTE_LENGTH) ) {
      return fail("STORE_INVALID");
    }
    notes[id] = note;
  }
  const completedActions = [];
  for ( const done of store.completedActions ) {
    if ( !isPlainObject(done) || !ACTION_ID_PATTERN.test(done.actionId) || (typeof done.userId !== "string")
      || !isWhole(done.revision) ) return fail("STORE_INVALID");
    completedActions.push({ actionId: done.actionId, userId: done.userId, revision: done.revision });
  }
  return ok({
    revision: store.revision, traits, sceneBoosts: store.sceneBoosts.map(b => ({ ...b })), notes, completedActions
  });
}

/** @returns {boolean} whether the request has the shape every request needs */
function requestWellFormed(request) {
  return isPlainObject(request) && (typeof request.action === "string") && (typeof request.actionId === "string")
    && ACTION_ID_PATTERN.test(request.actionId) && isWhole(request.revision) && isPlainObject(request.payload);
}

/** @returns {string|null} the actor key a holder names, or null */
function holderKey(holder) {
  return (isPlainObject(holder) && (holder.kind === "actor") && (typeof holder.actorId === "string")) ? holder.actorId : null;
}

/**
 * The character a player's action is for: the holder of the new asset, or of the asset acted on.
 * @returns {import("./types.mjs").EngineResult<string>} the actor key
 */
function ownerActionActor(action, payload, store) {
  if ( action === "buyAsset" ) {
    const key = holderKey(payload.holder);
    return key ? ok(key) : fail("NOT_A_CHARACTER_ASSET");
  }
  const trait = store.traits.find(t => t.id === payload.traitId);
  if ( !trait ) return fail("TRAIT_NOT_FOUND");
  const key = holderKey(trait.holder);
  return ((trait.kind === "asset") && key) ? ok(key) : fail("NOT_A_CHARACTER_ASSET");
}

/** @returns {import("./types.mjs").EngineResult<true>} ACTOR_NOT_FOUND unless every actor a holder names is known */
function holderKnown(holder, actors) {
  const key = holderKey(holder);
  return ((key === null) || isPlainObject(actors[key])) ? ok(true) : fail("ACTOR_NOT_FOUND");
}

/** @returns {import("./types.mjs").EngineResult<{traits: object[], ppLines: object[], removedIds: string[]}>} */
function changed(traits, ppLines = [], removedIds = []) {
  return ok({ traits, ppLines, removedIds });
}

/**
 * Applies one action to the traits (step 7 of the checks).
 * @returns {import("./types.mjs").EngineResult<{traits: object[], ppLines: object[], removedIds: string[],
 *   sceneBoosts?: object[], note?: {traitId: string, text: string}}>}
 */
function applyAction(action, payload, store, actors) {
  const { traits } = store;
  const find = () => traits.find(t => t.id === payload.traitId);
  const replace = trait => traits.map(t => (t.id === trait.id ? trait : t));
  switch ( action ) {
    case "addComplication": {
      const known = holderKnown(payload.holder, actors);
      if ( !known.ok ) return known;
      const made = applyComplications(traits, [{
        size: payload.size, cause: "gm", target: { kind: "new", id: payload.id, name: payload.name, holder: payload.holder }
      }]);
      return made.ok ? changed(made.value.complications) : made;
    }
    case "addAsset":
    case "buyAsset": {
      const known = holderKnown(payload.holder, actors);
      if ( !known.ok ) return known;
      if ( traits.some(t => t.id === payload.id) ) return fail("DUPLICATE_TRAIT_ID");
      const input = { id: payload.id, name: payload.name, holder: payload.holder, origin: action === "addAsset" ? "gm" : "pp" };
      if ( action === "addAsset" ) {
        input.size = payload.size;
        input.keepForSession = payload.keepForSession ?? false;
      }
      const made = createAsset(input);
      return made.ok ? changed([...traits, made.value.trait], made.value.ppLines) : made;
    }
    case "keepAsset":
    case "openAsset": {
      const upgraded = upgradeAsset(find(), { kind: action === "keepAsset" ? "keep" : "open" });
      return upgraded.ok ? changed(replace(upgraded.value.trait), upgraded.value.ppLines) : upgraded;
    }
    case "step": {
      const trait = find();
      if ( !trait ) return fail("TRAIT_NOT_FOUND");
      const stepped = stepTemporaryTrait(trait, payload.steps);
      if ( !stepped.ok ) return stepped;
      if ( stepped.value.removed ) return changed(traits.filter(t => t.id !== trait.id), [], [trait.id]);
      return changed(replace(stepped.value.trait));
    }
    case "assign": {
      const trait = find();
      if ( !trait ) return fail("TRAIT_NOT_FOUND");
      const known = holderKnown(payload.holder, actors);
      if ( !known.ok ) return known;
      const checked = checkTemporaryTrait({ ...trait, holder: payload.holder });
      return checked.ok ? changed(replace(checked.value)) : checked;
    }
    case "setNote": {
      if ( !find() ) return fail("TRAIT_NOT_FOUND");
      if ( (typeof payload.note !== "string") ) return fail("INVALID_INPUT");
      const text = payload.note.trim();
      if ( text.length > MAX_NOTE_LENGTH ) return fail("NOTE_TOO_LONG");
      return ok({ traits, ppLines: [], removedIds: [], note: { traitId: payload.traitId, text } });
    }
    case "remove":
      if ( !find() ) return fail("TRAIT_NOT_FOUND");
      return changed(traits.filter(t => t.id !== payload.traitId), [], [payload.traitId]);
    case "endScene":
    case "endSession": {
      const state = { traits, sceneBoosts: store.sceneBoosts };
      const ended = action === "endScene" ? endScene(state) : endSession(state);
      if ( !ended.ok ) return ended;
      return ok({ traits: ended.value.traits, ppLines: [], removedIds: ended.value.removedIds, sceneBoosts: [] });
    }
    default:
      return fail("UNSUPPORTED_ACTION");
  }
}

/**
 * Who pays an action's line (P1, P9): the character's own balance when it holds plot points, else
 * the bank, which only a GM may spend.
 * @returns {import("./types.mjs").EngineResult<StorePayment|null>}
 */
function payment(line, actorKey, actors, bank, sender) {
  if ( !line ) return ok(null);
  const facts = actors[actorKey];
  const own = facts.holdsPlotPoints === true;
  if ( !own && !sender.isGM ) return fail("PP_GM_ONLY");
  const balance = own ? facts.balance : bank;
  const delta = (line.direction === "spend") ? -line.amount : line.amount;
  const result = changeBalance(balance, delta);
  if ( !result.ok ) return result;
  return ok({
    account: own ? { kind: "actor", actorKey } : { kind: "bank" }, delta, balance: result.value.balance, line: { ...line }
  });
}

/**
 * Checks and applies one store request (ADR-057). On success the value holds the store to write
 * (revision raised, the action remembered) and the balance change to make with it, if any.
 * @param {{sender: {userId: string, isGM: boolean}, request: unknown, store: unknown,
 *   actors?: Object<string, StoreActorFacts>, bank?: number}} input
 * @returns {import("./types.mjs").EngineResult<{store: TraitStore, payment: StorePayment|null, removedIds: string[],
 *   replayed: boolean}>}
 */
export function dispatchTraitStoreRequest({ sender, request, store, actors = {}, bank = 0 } = {}) {
  const checkedStore = checkTraitStore(store);
  if ( !checkedStore.ok ) return checkedStore;
  const current = checkedStore.value;
  if ( !isPlainObject(sender) || (typeof sender.userId !== "string") || !requestWellFormed(request)
    || !isPlainObject(actors) ) return fail("MALFORMED_REQUEST");

  const done = current.completedActions.find(a => a.actionId === request.actionId);
  if ( done ) {
    if ( done.userId !== sender.userId ) return fail("ACTION_ID_REUSED");
    return ok({ store: current, payment: null, removedIds: [], replayed: true });
  }

  const who = TRAIT_STORE_ACTIONS[request.action];
  if ( !Object.hasOwn(TRAIT_STORE_ACTIONS, request.action) ) return fail("UNSUPPORTED_ACTION");
  const isGM = sender.isGM === true;
  let actorKey = null;
  if ( who === "gm" ) {
    if ( !isGM ) return fail("GM_ONLY");
  }
  else {
    const actor = ownerActionActor(request.action, request.payload, current);
    if ( !actor.ok ) return actor;
    actorKey = actor.value;
    const facts = actors[actorKey];
    if ( !isPlainObject(facts) ) return fail("ACTOR_NOT_FOUND");
    if ( !isGM && (facts.ownedBySender !== true) ) return fail("NOT_YOUR_CHARACTER");
  }
  if ( request.revision !== current.revision ) return fail("STALE_REVISION");

  const applied = applyAction(request.action, request.payload, current, actors);
  if ( !applied.ok ) return applied;
  const paid = payment(applied.value.ppLines[0], actorKey, actors, bank, { isGM });
  if ( !paid.ok ) return paid;

  const { removedIds } = applied.value;
  const notes = Object.fromEntries(Object.entries(current.notes).filter(([id]) => !removedIds.includes(id)));
  if ( applied.value.note ) {
    if ( applied.value.note.text ) notes[applied.value.note.traitId] = applied.value.note.text;
    else delete notes[applied.value.note.traitId];
  }
  const revision = current.revision + 1;
  const completedActions = [...current.completedActions, { actionId: request.actionId, userId: sender.userId, revision }]
    .slice(-COMPLETED_ACTIONS_KEPT);
  return ok({
    store: {
      revision,
      traits: applied.value.traits,
      sceneBoosts: applied.value.sceneBoosts ?? current.sceneBoosts,
      notes,
      completedActions
    },
    payment: paid.value,
    removedIds,
    replayed: false
  });
}

/**
 * What End scene or End session would do, for the GM's preview (PA2): the traits that end, the
 * complications that stay for review, and whether scene boosts reset.
 * @param {unknown} store
 * @param {"scene"|"session"} period
 * @returns {import("./types.mjs").EngineResult<{removedIds: string[], reviewIds: string[], boostsReset: number}>}
 */
export function previewEnd(store, period) {
  const checked = checkTraitStore(store);
  if ( !checked.ok ) return checked;
  if ( !["scene", "session"].includes(period) ) return fail("INVALID_INPUT");
  const state = { traits: checked.value.traits, sceneBoosts: checked.value.sceneBoosts };
  const ended = period === "scene" ? endScene(state) : endSession(state);
  if ( !ended.ok ) return ended;
  return ok({
    removedIds: ended.value.removedIds, reviewIds: ended.value.reviewIds, boostsReset: checked.value.sceneBoosts.length
  });
}

/**
 * The GM tracker's groups (ADR-057): characters by holder in the order given, the scene, the
 * unassigned, and traits whose character is no longer in the world. Traits keep store order.
 * @param {unknown} store
 * @param {{actorKey: string, name: string}[]} known - the actors in the world, in display order
 * @returns {import("./types.mjs").EngineResult<{characters: {actorKey: string, name: string, traits: object[]}[],
 *   scene: object[], unassigned: object[], orphaned: object[]}>} each trait with its note
 */
export function trackerGroups(store, known) {
  const checked = checkTraitStore(store);
  if ( !checked.ok ) return checked;
  if ( !Array.isArray(known) || !known.every(k => isPlainObject(k) && (typeof k.actorKey === "string")) ) {
    return fail("INVALID_INPUT");
  }
  const withNote = t => ({ ...t, note: checked.value.notes[t.id] ?? "" });
  const traits = checked.value.traits.map(withNote);
  const keys = new Set(known.map(k => k.actorKey));
  return ok({
    characters: known.map(k => ({
      actorKey: k.actorKey, name: k.name, traits: traits.filter(t => t.holder.actorId === k.actorKey)
    })).filter(group => group.traits.length > 0),
    scene: traits.filter(t => t.holder.kind === "scene"),
    unassigned: traits.filter(t => t.holder.kind === "unassigned"),
    orphaned: traits.filter(t => (t.holder.kind === "actor") && !keys.has(t.holder.actorId))
  });
}

/** @returns {boolean} whether value is a trait id in the 16-character format */
export function isTraitId(value) {
  return (typeof value === "string") && ID_PATTERN.test(value);
}
