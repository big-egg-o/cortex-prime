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
 * - for an action on a roll card, what the card holds (RollFacts), read from the card, never from
 *   the request; for an action on a test or contest card, likewise (CardFacts).
 *
 * The checks, in order, stopping at the first that fails (ADR-025):
 * 1. STORE_INVALID: the stored data doesn't pass the engine's checks.
 * 2. MALFORMED_REQUEST: the request's shape.
 * 3. A request whose actionId is already done returns that first answer, `replayed: true`, with
 *    nothing to write; ACTION_ID_REUSED when another user sent it.
 * 4. UNSUPPORTED_ACTION.
 * 5. The sender: GM_ONLY for the tracker's actions; for a player's action TRAIT_NOT_FOUND,
 *    NOT_A_CHARACTER_ASSET, ACTOR_NOT_FOUND, then NOT_YOUR_CHARACTER. For an action on a roll card,
 *    ROLL_NOT_FOUND first; activating hitches is the GM's, except that the card's owner may finish
 *    a roll with no hitch left to activate, or the bank's roll, whose hitches are opportunities (it
 *    removes the roller's used d4 complications, rule 18). For an action on a test or contest card,
 *    CARD_NOT_FOUND first; a consequence is applied by a GM, or by the winner's owner when the loser
 *    is a GMC (PA5); an asset from an effect die is made by a GM.
 * 6. STALE_REVISION: the request was made against another revision.
 * 7. The action's own checks and the engine's codes.
 * 8. The payment: a character who holds plot points pays (PP_INSUFFICIENT). No spend on a trait has
 *    a bank price (RQ-043), so for any other character a GM's action costs nothing and warns
 *    BANK_SPEND_NOT_LISTED, and anyone else's is PP_GM_ONLY. A hitch's plot point waits on the roll
 *    card until it is settled; on a card already settled it is paid at once.
 * @module rules/trait-store
 */

import {
  applyComplications, applyHitches, applyOpportunities, checkTemporaryTrait, contestComplications, createAsset, endScene,
  endSession,
  removeUsedD4Complications, stepTemporaryTrait, temporaryTraitPoolEntry, upgradeAsset
} from "./assets.mjs";
import { changeBalance } from "./plot-points.mjs";
import { fail, ok } from "./result.mjs";

/**
 * The store's actions and who may send each: "gm" for the tracker, "owner" for a character's owner
 * or a GM, "roll" for activating hitches on a roll card (see the checks above).
 */
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
  openAsset: "owner",
  activateHitches: "roll",
  useOpportunities: "owner",
  applyConsequence: "card",
  createEffectAsset: "gm"
});

/** The actions that act on a test or contest card and read it (CardFacts). */
const CARD_ACTIONS = ["applyConsequence", "createEffectAsset"];

/**
 * The warnings of a temporary trait in a pool that a roll card stores and shows as a nonstandard
 * selection (ADR-029). A d4 complication that goes to its holder is the card's plot point section's.
 */
export const TEMP_TRAIT_CARD_WARNINGS = Object.freeze(["ASSET_NOT_AVAILABLE", "OWN_COMPLICATION", "COMPLICATION_BEYOND_D12"]);

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
 * What the handler reads from the roll card an action names.
 * @typedef {Object} RollFacts
 * @property {import("./types.mjs").RolledDie[]} rolled
 * @property {"player"|"gm"} side - "gm" for a roll the bank pays for, whose hitches are opportunities
 * @property {boolean} hitchesDone - the GM's hitch choice for this roll is made
 * @property {boolean} settled - the roll's plot points are settled
 * @property {string[]} usedD4Ids - the d4 complications the roller put in the pool from their own
 * @property {string|null} payerKey - the actor key of the character the roll pays, or null
 * @property {boolean} senderOwnsCard - the sender may change the card
 */

/**
 * What the handler reads from the test or contest card an action names (step 4.8c), never from the
 * request.
 * @typedef {Object} CardFacts
 * @property {"test"|"contest"} type
 * @property {{key: string, size: number, cause: string, required: boolean}[]} offered - the
 *   consequence's complications (consequenceComplications)
 * @property {string|null} holderKey - the actor key of the side that takes them: the loser, or the
 *   test's roller; null for a side with no actor
 * @property {string[]} appliedKeys - the offered keys already given
 * @property {boolean} winnerOwnedBySender - the sender owns the winning side's actor
 * @property {boolean} loserIsBank - the losing side's plot points are the bank's (a GMC, P1)
 * @property {{id: string, size: number}[]} assetEffects - the effect dice that can make an asset (effectAssetDice)
 * @property {string|null} assetHolderKey - the actor key of the side those dice belong to
 * @property {string[]} assetsMade - the effect ids that already made an asset
 */

/**
 * What the handler knows of one actor a request names.
 * @typedef {{ownedBySender: boolean, holdsPlotPoints: boolean, balance: number|null}} StoreActorFacts
 */

/**
 * One balance change a request makes. The account names the actor by its key.
 * @typedef {Object} StorePayment
 * @property {{kind: "actor", actorKey: string}} account
 * @property {number} delta
 * @property {number} balance - the balance after the change
 * @property {import("./types.mjs").PpLine} line - the first line
 * @property {import("./types.mjs").PpLine[]} lines - every line, all of one reason
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
  if ( action === "useOpportunities" ) {
    return (typeof payload.actorKey === "string") ? ok(payload.actorKey) : fail("ACTOR_NOT_FOUND");
  }
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
function applyAction(action, payload, store, actors, roll, card) {
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
    case "activateHitches":
      return activateHitches(payload, traits, roll);
    case "useOpportunities":
      return useOpportunities(payload, store, roll);
    case "applyConsequence":
      return applyConsequence(payload, traits, actors, card);
    case "createEffectAsset":
      return createEffectAsset(payload, traits, actors, card);
    default:
      return fail("UNSUPPORTED_ACTION");
  }
}

/**
 * The GM's hitch choice for a player's roll (rules 16 to 18; RQ-045, RQ-050): applyHitches, then,
 * when the choice is finished, removeUsedD4Complications for the roller's d4 complications that are
 * still stored. HITCHES_DONE once the choice is finished.
 */
function activateHitches(payload, traits, roll) {
  if ( roll.hitchesDone ) return fail("HITCHES_DONE");
  if ( !Array.isArray(payload.allocations) || (typeof payload.finish !== "boolean") ) return fail("INVALID_INPUT");
  // Finishing with no allocations activates nothing, so it suits the GM's own roll too (its d4s).
  const hitched = payload.allocations.length
    ? applyHitches({ rolled: roll.rolled, side: roll.side, allocations: payload.allocations, complications: traits })
    : ok({ rolled: roll.rolled.map(d => ({ ...d, source: { ...d.source } })), complications: traits, ppLines: [], changes: [], takenOut: [] });
  if ( !hitched.ok ) return hitched;
  let next = hitched.value.complications;
  let removedIds = [];
  if ( payload.finish ) {
    const used = [...new Set(roll.usedD4Ids)].filter(id => next.some(t => (t.id === id) && (t.kind === "complication")));
    const removed = removeUsedD4Complications(next, used);
    if ( !removed.ok ) return removed;
    next = removed.value.complications;
    removedIds = removed.value.removedIds;
  }
  return ok({
    traits: next, ppLines: hitched.value.ppLines, removedIds, changes: hitched.value.changes, takenOut: hitched.value.takenOut,
    roll: { rolled: hitched.value.rolled, hitchesDone: payload.finish, pending: !roll.settled }
  });
}

/**
 * A player uses opportunities from the GM's roll on temporary traits (rules 19 and 20; RQ-046,
 * RQ-047). Signature assets wait for step 4.9: OPPORTUNITY_TARGET_NOT_SUPPORTED.
 */
function useOpportunities(payload, store, roll) {
  if ( !Array.isArray(payload.uses) ) return fail("INVALID_INPUT");
  if ( payload.uses.some(use => isPlainObject(use) && (use.target?.kind === "signature")) ) {
    return fail("OPPORTUNITY_TARGET_NOT_SUPPORTED");
  }
  const used = applyOpportunities({
    rolled: roll.rolled, side: roll.side, uses: payload.uses, traits: store.traits, sceneBoosts: store.sceneBoosts
  });
  if ( !used.ok ) return used;
  return ok({
    traits: used.value.traits, ppLines: used.value.ppLines, removedIds: used.value.removedIds,
    sceneBoosts: used.value.sceneBoosts, changes: used.value.changes, takenOut: [],
    roll: { rolled: used.value.rolled }
  });
}

/**
 * Gives the consequence's complications to the side that takes them (rules 21 to 24; PA5): each
 * offered complication once, as a new one or a step-up of one that side has, new by default on the
 * card. The required ones still open (a lost contest's, a stay-in's) go together; the failed test's
 * d6 is the GM's choice. The card keeps the keys given, so a stay-in recorded later adds only its own.
 */
function applyConsequence(payload, traits, actors, card) {
  if ( !Array.isArray(payload.items) ) return fail("INVALID_INPUT");
  if ( payload.items.some(item => isPlainObject(item) && card.appliedKeys.includes(item.key)) ) return fail("CONSEQUENCE_APPLIED");
  const open = card.offered.filter(o => !card.appliedKeys.includes(o.key));
  if ( !open.length ) return fail("NOTHING_TO_APPLY");
  const keys = new Set();
  for ( const item of payload.items ) {
    if ( !isPlainObject(item) || keys.has(item.key) || !open.some(o => o.key === item.key) ) return fail("INVALID_INPUT");
    keys.add(item.key);
  }
  if ( !keys.size ) return fail("NOTHING_TO_APPLY");
  if ( open.some(o => o.required && !keys.has(o.key)) ) return fail("CONSEQUENCE_INCOMPLETE");
  const holder = card.holderKey ? { kind: "actor", actorId: card.holderKey } : { kind: "unassigned" };
  const known = holderKnown(holder, actors);
  if ( !known.ok ) return known;
  const items = [];
  for ( const item of payload.items ) {
    const offer = card.offered.find(o => o.key === item.key);
    const target = item.target;
    if ( !isPlainObject(target) ) return fail("INVALID_INPUT");
    if ( target.kind === "existing" ) {
      const existing = traits.find(t => t.id === target.traitId);
      if ( existing && ((card.holderKey === null) || (holderKey(existing.holder) !== card.holderKey)) ) {
        return fail("NOT_HOLDERS_COMPLICATION");
      }
      items.push({ size: offer.size, cause: offer.cause, target: { kind: "existing", traitId: target.traitId } });
    }
    else items.push({ size: offer.size, cause: offer.cause, target: { kind: target.kind, id: target.id, name: target.name, holder } });
  }
  const applied = applyComplications(traits, items);
  if ( !applied.ok ) return applied;
  return ok({
    traits: applied.value.complications, ppLines: [], removedIds: [], changes: applied.value.changes,
    takenOut: applied.value.takenOut, card: { consequenceKeys: [...card.appliedKeys, ...keys] }
  });
}

/**
 * Makes an asset from an effect die of the card for the side it belongs to (rules 5 and 7; AC-06,
 * AC-07, AC-09): a successful test's die, origin "effect" or "clue" and the GM's cap, or a contest
 * winner's die not used against the loser, origin "effect". Each die makes one asset. No lines.
 */
function createEffectAsset(payload, traits, actors, card) {
  const origins = card.type === "test" ? ["effect", "clue"] : ["effect"];
  if ( !origins.includes(payload.origin) || (typeof payload.effectId !== "string") ) return fail("INVALID_INPUT");
  if ( !card.assetHolderKey ) return fail("ACTOR_NOT_FOUND");
  if ( card.assetsMade.includes(payload.effectId) ) return fail("EFFECT_DIE_USED");
  const effect = card.assetEffects.find(e => e.id === payload.effectId);
  if ( !effect ) return fail("EFFECT_DIE_NOT_FOUND");
  const holder = { kind: "actor", actorId: card.assetHolderKey };
  const known = holderKnown(holder, actors);
  if ( !known.ok ) return known;
  if ( traits.some(t => t.id === payload.id) ) return fail("DUPLICATE_TRAIT_ID");
  const input = { id: payload.id, name: payload.name, holder, origin: payload.origin, size: effect.size };
  if ( payload.cap !== undefined ) input.cap = payload.cap;
  const made = createAsset(input);
  if ( !made.ok ) return made;
  return ok({
    traits: [...traits, made.value.trait], ppLines: made.value.ppLines, removedIds: [], card: { assetEffect: effect.id }
  });
}

/**
 * Who pays an action's lines (P1, P9; RQ-043): the character's own balance when it holds plot
 * points. No trait spend has a bank price, so for any other character a GM pays nothing and gets
 * the warning BANK_SPEND_NOT_LISTED; anyone else is refused.
 * @returns {import("./types.mjs").EngineResult<{payment: StorePayment|null, warnings: string[]}>}
 */
function payment(lines, actorKey, actors, sender) {
  if ( !lines.length ) return ok({ payment: null, warnings: [] });
  const facts = actorKey ? actors[actorKey] : null;
  if ( facts?.holdsPlotPoints !== true ) {
    if ( !sender.isGM ) return fail("PP_GM_ONLY");
    return ok({ payment: null, warnings: lines.some(l => l.direction === "spend") ? ["BANK_SPEND_NOT_LISTED"] : [] });
  }
  const delta = lines.reduce((sum, l) => sum + ((l.direction === "spend") ? -l.amount : l.amount), 0);
  const result = changeBalance(facts.balance, delta);
  if ( !result.ok ) return result;
  const copies = lines.map(l => ({ ...l }));
  return ok({
    payment: { account: { kind: "actor", actorKey }, delta, balance: result.value.balance, line: copies[0], lines: copies },
    warnings: []
  });
}

/**
 * Checks and applies one store request (ADR-057). On success the value holds the store to write
 * (revision raised, the action remembered) and the balance change to make with it, if any.
 * For an action on a roll card the value also holds `roll`: the card's dice after the action, the
 * plot point lines to add to it while they wait for its settlement (`pendingLines`), and whether
 * the hitch choice is finished. `changes` and `takenOut` are the engine's.
 * @param {{sender: {userId: string, isGM: boolean}, request: unknown, store: unknown,
 *   actors?: Object<string, StoreActorFacts>, roll?: RollFacts|null, card?: CardFacts|null}} input
 * @returns {import("./types.mjs").EngineResult<{store: TraitStore, payment: StorePayment|null, removedIds: string[],
 *   replayed: boolean, warnings: string[], changes: object[], takenOut: string[],
 *   roll: {rolled: object[], pendingLines: object[], hitchesDone?: boolean}|null,
 *   card: {consequenceKeys?: string[], assetEffect?: string}|null}>} `card` is the mark to write on
 *   the test or contest card an action named
 */
export function dispatchTraitStoreRequest({ sender, request, store, actors = {}, roll = null, card = null } = {}) {
  const checkedStore = checkTraitStore(store);
  if ( !checkedStore.ok ) return checkedStore;
  const current = checkedStore.value;
  if ( !isPlainObject(sender) || (typeof sender.userId !== "string") || !requestWellFormed(request)
    || !isPlainObject(actors) ) return fail("MALFORMED_REQUEST");

  const done = current.completedActions.find(a => a.actionId === request.actionId);
  if ( done ) {
    if ( done.userId !== sender.userId ) return fail("ACTION_ID_REUSED");
    return ok({
      store: current, payment: null, removedIds: [], replayed: true, warnings: [], changes: [], takenOut: [], roll: null, card: null
    });
  }

  const who = TRAIT_STORE_ACTIONS[request.action];
  if ( !Object.hasOwn(TRAIT_STORE_ACTIONS, request.action) ) return fail("UNSUPPORTED_ACTION");
  const isGM = sender.isGM === true;
  let actorKey = null;
  const onRoll = ["activateHitches", "useOpportunities"].includes(request.action);
  if ( onRoll && !isPlainObject(roll) ) return fail("ROLL_NOT_FOUND");
  if ( CARD_ACTIONS.includes(request.action) && !isPlainObject(card) ) return fail("CARD_NOT_FOUND");
  if ( who === "gm" ) {
    if ( !isGM ) return fail("GM_ONLY");
  }
  else if ( who === "roll" ) {
    if ( !isGM && !ownerMayFinish(request.payload, roll) ) return fail("GM_ONLY");
  }
  else if ( who === "card" ) {
    const winnerApplies = (card.type === "contest") && (card.winnerOwnedBySender === true) && (card.loserIsBank === true);
    if ( !isGM && !winnerApplies ) return fail("GM_ONLY");
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

  const applied = applyAction(request.action, request.payload, current, actors, roll, card);
  if ( !applied.ok ) return applied;
  const pending = applied.value.roll?.pending === true;
  const payer = (request.action === "activateHitches") ? roll.payerKey : actorKey;
  const paid = pending ? ok({ payment: null, warnings: [] }) : payment(applied.value.ppLines, payer, actors, { isGM });
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
    payment: paid.value.payment,
    removedIds,
    replayed: false,
    warnings: paid.value.warnings,
    changes: applied.value.changes ?? [],
    takenOut: applied.value.takenOut ?? [],
    roll: applied.value.roll ? {
      rolled: applied.value.roll.rolled,
      pendingLines: pending ? applied.value.ppLines.map(l => ({ ...l })) : [],
      ...(applied.value.roll.hitchesDone === undefined ? {} : { hitchesDone: applied.value.roll.hitchesDone })
    } : null,
    card: applied.value.card ?? null
  });
}

/** @returns {boolean} whether a card's owner may finish its hitch choice: no allocations, none left to activate */
function ownerMayFinish(payload, roll) {
  return (roll.senderOwnsCard === true) && (payload.finish === true) && Array.isArray(payload.allocations)
    && (payload.allocations.length === 0) && Array.isArray(roll.rolled)
    && ((roll.side === "gm") || !roll.rolled.some(die => die.hitch && (die.state !== "hitch-activated")));
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

/**
 * The temporary traits the pool builder offers a roller (step 4.8b): the roller's own traits, the
 * scene's, other characters' open assets, other characters' complications and the unassigned
 * complications, each with temporaryTraitPoolEntry's die and warnings. Another character's asset
 * that isn't open, and an unassigned asset, aren't offered. Groups and traits keep store order.
 * @param {unknown} store
 * @param {string|null} rollerKey - the rolling character's actor key, or null
 * @returns {import("./types.mjs").EngineResult<{group: "own"|"scene"|"open"|"complications",
 *   traitId: string, name: string, kind: string, size: number, source: object, warnings: string[],
 *   d4Gain: boolean, inPool?: boolean}[]>}
 */
export function poolTraitChoices(store, rollerKey) {
  const checked = checkTraitStore(store);
  if ( !checked.ok ) return checked;
  if ( (rollerKey !== null) && (typeof rollerKey !== "string") ) return fail("INVALID_INPUT");
  const groupOf = t => {
    const holderKey = t.holder.kind === "actor" ? t.holder.actorId : null;
    if ( (holderKey !== null) && (holderKey === rollerKey) ) return "own";
    if ( t.holder.kind === "scene" ) return "scene";
    if ( t.kind === "complication" ) return "complications";
    if ( (holderKey !== null) && (t.access === "open") ) return "open";
    return null;
  };
  const order = ["own", "scene", "open", "complications"];
  const choices = [];
  for ( const group of order ) {
    for ( const trait of checked.value.traits.filter(t => groupOf(t) === group) ) {
      const entry = temporaryTraitPoolEntry(trait, { rollerActorId: rollerKey });
      if ( !entry.ok ) return entry;
      choices.push({
        group, traitId: trait.id, name: trait.name, kind: trait.kind, size: entry.value.size,
        source: entry.value.source, warnings: entry.value.warnings, d4Gain: entry.value.ppGained === 1
      });
    }
  }
  return ok(choices);
}

/**
 * The d4 complications a roller put in a pool from their own (rule 18): the trait ids of the
 * pool's complication dice of size 4 whose holder is the roller, each once, in pool order.
 * @param {{size: number, source: {kind?: string, actorId?: string, traitId?: string}}[]} pool
 * @param {string|null} rollerKey
 * @returns {string[]}
 */
export function usedD4ComplicationIds(pool, rollerKey) {
  if ( !Array.isArray(pool) || (typeof rollerKey !== "string") ) return [];
  const ids = pool.filter(d => isPlainObject(d?.source) && (d.source.kind === "complication") && (d.size === 4)
    && (d.source.actorId === rollerKey) && (typeof d.source.traitId === "string")).map(d => d.source.traitId);
  return [...new Set(ids)];
}

/**
 * The complications a test or contest card gives as its consequence (rules 21 to 23), each keyed by
 * its cause and effect die so the card can record which were given: a lost contest's through contestComplications (required); a test's stay-in complications
 * (required); a failed test with no stay-in, the GM's optional d6 (rule 21). A stay-in after a
 * failed test replaces the d6: the card offers one consequence for one failure, and the GM adds
 * anything more in the tracker.
 * @param {{type: "contest", consequence: import("./types.mjs").Consequence, stayedIn: boolean}
 *   | {type: "test", success: boolean, stayIn: {size: number}[]|null}} input
 * @returns {import("./types.mjs").EngineResult<{key: string, size: number, cause: string, required: boolean}[]>}
 */
export function consequenceComplications(input) {
  if ( !isPlainObject(input) ) return fail("INVALID_INPUT");
  let list;
  if ( input.type === "contest" ) {
    const given = contestComplications(input.consequence, { stayedIn: input.stayedIn === true });
    if ( !given.ok ) return given;
    list = given.value.map(c => ({ key: `${c.cause}:${c.effectId}`, size: c.size, cause: c.cause, required: true }));
  }
  else if ( input.type === "test" ) {
    if ( typeof input.success !== "boolean" ) return fail("INVALID_INPUT");
    if ( input.success ) list = [];
    else if ( Array.isArray(input.stayIn) ) {
      list = input.stayIn.map((c, i) => ({ key: `stayIn:${c.effectId ?? i}`, size: c.size, cause: "stayIn", required: true }));
    }
    else list = [{ key: "failedTest", size: 6, cause: "failedTest", required: false }];
  }
  else return fail("INVALID_INPUT");
  return ok(list);
}

/**
 * The effect dice of a card that can make an asset (rule 5; RQ-011 c): a successful test's, and a
 * won contest's winner dice that weren't used against the loser, once the winner has picked. A die
 * whose overflow took the loser out counts as used. Giving in and declining offer none.
 * @param {{type: "test", success: boolean, effects: {id: string, size: number}[]}
 *   | {type: "contest", consequence: import("./types.mjs").Consequence|null, usedAgainstLoser: string[]|null}} input
 * @returns {{id: string, size: number}[]}
 */
export function effectAssetDice(input) {
  if ( !isPlainObject(input) ) return [];
  if ( input.type === "test" ) {
    return (input.success === true) && Array.isArray(input.effects) ? input.effects.map(({ id, size }) => ({ id, size })) : [];
  }
  const { consequence, usedAgainstLoser } = input;
  if ( (input.type !== "contest") || !isPlainObject(consequence) || (consequence.ending !== "won")
    || !Array.isArray(usedAgainstLoser) ) return [];
  const used = new Set([...usedAgainstLoser, ...(consequence.avoidWithPP ?? []).map(a => a.effectId)]);
  return consequence.winnerEffects.filter(e => !used.has(e.id)).map(({ id, size }) => ({ id, size }));
}
