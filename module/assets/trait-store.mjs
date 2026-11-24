/**
 * The temporary trait store in Foundry (Decisions ADR-057, step 4.8a). Every asset and complication
 * of the world is one world setting, written only by the active GM: a user sends a request as a
 * user query (ADR-027), the GM's client checks it with the pure dispatchTraitStoreRequest and writes
 * what it returns. Requests run one at a time, each against the revision it was made for. An action
 * that costs plot points writes the store, the balance and the ledger entry in one
 * foundry.documents.modifyBatch call, so a refused write changes none of them; an action on a roll
 * card (hitches, opportunities; step 4.8b) or on a test or contest card (consequence complications
 * and assets from effect dice; step 4.8c) writes that card's mark in the same batch. A retried action
 * (same action id) gets its first answer back and writes nothing. Nothing here decides an outcome.
 *
 * Foundry 14.369 facts this relies on (read from the install, 2026-11-24):
 * - modifyBatch (client/documents/_module.mjs, client/data/client-backend.mjs) dry-runs every
 *   operation on the client and the server before writing, so validation and permission failures
 *   write nothing; it reports server errors as notifications and leaves failed results out of what
 *   it returns, so the caller checks the result's shape.
 * - A world setting is a Setting document keyed "<namespace>.<key>" whose value is a JSON string
 *   (client/helpers/client-settings.mjs #setWorld); only a user with SETTINGS_MODIFY writes it.
 * @module assets/trait-store
 */

import TraitStoreData, { TRAIT_STORE_SCHEMA_VERSION } from "../data/settings/temporary-traits.mjs";
import { dispatchTraitStoreRequest, emptyTraitStore, usedD4ComplicationIds } from "../rules/trait-store.mjs";
import { holdsPlotPoints, ledgerEntryData } from "../plot-points/accounts.mjs";
import { ASSET_EFFECTS_FLAG, CONSEQUENCE_FLAG, cardTraitFacts } from "./card-traits.mjs";

const SYSTEM_ID = "cortex-prime";

/** The key of the store setting. */
export const TRAIT_STORE_SETTING = "temporaryTraits";

/** The query name, registered in `CONFIG.queries`. */
export const TRAIT_STORE_QUERY = "cortex-prime.traitStore";

/** How long a sender waits for the GM's answer, in milliseconds. */
const QUERY_TIMEOUT = 15000;

/** @returns {{ok: false, code: string}} */
function fail(code) {
  return { ok: false, code };
}

/** @returns {object} the stored data of an empty store */
function emptySource() {
  return { schemaVersion: TRAIT_STORE_SCHEMA_VERSION, ...emptyTraitStore() };
}

/** Registers the setting and the GM's query handler; called from the `init` hook. */
export function registerTraitStore() {
  game.settings.register(SYSTEM_ID, TRAIT_STORE_SETTING, {
    name: "CORTEX.Assets.Store",
    scope: "world",
    config: false,
    type: TraitStoreData,
    default: emptySource(),
    onChange: () => Hooks.callAll("cortexPrimeTraitsChanged")
  });
  CONFIG.queries[TRAIT_STORE_QUERY] = handleTraitStoreQuery;
}

/** @returns {import("../rules/trait-store.mjs").TraitStore} the store as plain data */
export function getTraitStore() {
  return game.settings.get(SYSTEM_ID, TRAIT_STORE_SETTING).toStore();
}

/** @returns {string} a new action id, which a retry of the same action reuses */
export function newActionId() {
  return `${foundry.utils.randomID(16)}${Date.now().toString(36)}`;
}

/**
 * Sends one store action to the active GM and returns the answer. A query that throws (a lost
 * reply, the timeout) is sent once more with the same action id, so an action that was done
 * returns its first answer and isn't done twice. Refuses before sending: GM_REQUIRED without an
 * active GM, QUERY_NOT_PERMITTED without the core "query users" permission.
 * @param {string} action - a key of TRAIT_STORE_ACTIONS
 * @param {object} payload
 * @param {{actionId?: string, revision?: number}} [options]
 * @returns {Promise<{ok: boolean, code?: string, value?: object}>}
 */
export async function sendTraitStoreRequest(action, payload, { actionId = newActionId(), revision } = {}) {
  const request = { action, actionId, revision: revision ?? getTraitStore().revision, payload };
  const gm = game.users.activeGM;
  if ( !gm ) return fail("GM_REQUIRED");
  if ( gm.isSelf ) return handleTraitStoreQuery(request, { user: game.user });
  if ( !game.user.hasPermission("QUERY_USER") ) return fail("QUERY_NOT_PERMITTED");
  for ( let attempt = 0; attempt < 2; attempt++ ) {
    try {
      return await gm.query(TRAIT_STORE_QUERY, request, { timeout: QUERY_TIMEOUT });
    }
    catch( err ) {
      console.error(err);
    }
  }
  return fail("REQUEST_FAILED");
}

/**
 * Shows a refused store action to the user who sent it (CORTEX.Assets.Errors.<CODE>, or a plot
 * point string); a code without a string is shown as it is. A done action's warnings, such as
 * BANK_SPEND_NOT_LISTED (RQ-043), are shown as information.
 * @param {{ok: boolean, code?: string}} result
 * @returns {boolean} whether the action went through
 */
export function notifyTraitStoreResult(result) {
  if ( result?.ok ) {
    for ( const code of result.value?.warnings ?? [] ) {
      const key = `CORTEX.PlotPoints.Warnings.${code}`;
      ui.notifications.info(game.i18n.has(key) ? game.i18n.localize(key) : code);
    }
    return true;
  }
  const key = [`CORTEX.Assets.Errors.${result?.code}`, `CORTEX.PlotPoints.Errors.${result?.code}`]
    .find(k => game.i18n.has(k));
  ui.notifications.warn(key ? game.i18n.localize(key) : String(result?.code));
  return false;
}

/** The flag that marks a roll card whose hitch choice is finished (rule 18). */
export const HITCHES_DONE_FLAG = "hitchesDone";

/** The tail of the GM's queue: store requests run one after another. */
let queue = Promise.resolve();

/**
 * The GM side's query handler. Requests run one at a time, so each sees the previous write. It
 * never throws: a failure becomes WRITE_FAILED or REQUEST_FAILED, with the error in the console.
 * @param {unknown} request - the query data
 * @param {{user: User}} context - the querying user, as the server reports it
 * @returns {Promise<{ok: boolean, code?: string, value?: object}>}
 */
export function handleTraitStoreQuery(request, { user }) {
  const run = queue.then(() => processRequest(request, user));
  queue = run.catch(() => {});
  return run.catch(err => {
    console.error(err);
    return fail("REQUEST_FAILED");
  });
}

/**
 * The actor keys a request names: the holder of a new trait, the holder of the trait it acts on, the
 * character that pays for opportunities, the character a roll card pays, and the sides a test or
 * contest card gives complications or assets to.
 * @param {unknown} request
 * @param {import("../rules/trait-store.mjs").TraitStore} store
 * @param {import("../rules/trait-store.mjs").RollFacts|null} roll
 * @param {import("../rules/trait-store.mjs").CardFacts|null} card
 * @returns {string[]}
 */
function requestActorKeys(request, store, roll, card) {
  const keys = [];
  const payload = request?.payload;
  if ( typeof payload?.holder?.actorId === "string" ) keys.push(payload.holder.actorId);
  if ( typeof payload?.actorKey === "string" ) keys.push(payload.actorKey);
  const trait = store.traits.find(t => t.id === payload?.traitId);
  if ( trait?.holder.kind === "actor" ) keys.push(trait.holder.actorId);
  if ( roll?.payerKey ) keys.push(roll.payerKey);
  if ( card?.holderKey ) keys.push(card.holderKey);
  if ( card?.assetHolderKey ) keys.push(card.assetHolderKey);
  return [...new Set(keys)];
}

/**
 * The actor key of the character who rolled a card: its speaker's actor, a token's synthetic actor
 * included.
 * @param {ChatMessage} message
 * @returns {string|null}
 */
export function rollerKeyOf(message) {
  return message.speaker ? (ChatMessage.implementation.getSpeakerActor(message.speaker)?.uuid ?? null) : null;
}

/**
 * What a roll card holds, read on the GM's client (RollFacts), or null when the request names no
 * poolRoll card.
 * @param {unknown} request
 * @param {User} user - the sender
 * @returns {{facts: import("../rules/trait-store.mjs").RollFacts, message: ChatMessage, source: object}|null}
 */
function readRoll(request, user) {
  const messageId = request?.payload?.messageId;
  const message = (typeof messageId === "string") ? game.messages.get(messageId) : null;
  if ( message?.type !== "poolRoll" ) return null;
  const source = message.system.toObject();
  const payer = source.pp?.payer ?? null;
  const payerActor = (payer?.kind === "actor") ? game.actors.get(payer.actorId) : null;
  return {
    message,
    source,
    facts: {
      rolled: source.rolled,
      side: (payer?.kind === "bank") ? "gm" : "player",
      hitchesDone: message.getFlag(SYSTEM_ID, HITCHES_DONE_FLAG) === true,
      settled: source.pp?.settled === true,
      usedD4Ids: usedD4ComplicationIds(source.pool, rollerKeyOf(message)),
      payerKey: payerActor?.uuid ?? null,
      senderOwnsCard: message.canUserModify(user, "update")
    }
  };
}

/**
 * What a test or contest card holds (CardFacts), read on the GM's client, or null when the request
 * names no contest message a GM wrote.
 * @param {unknown} request
 * @param {User} user - the sender
 * @returns {{facts: import("../rules/trait-store.mjs").CardFacts, message: ChatMessage}|null}
 */
function readCard(request, user) {
  if ( !["applyConsequence", "createEffectAsset"].includes(request?.action) ) return null;
  const messageId = request?.payload?.messageId;
  const message = (typeof messageId === "string") ? game.messages.get(messageId) : null;
  const facts = message ? cardTraitFacts(message, user) : null;
  return facts ? { facts, message } : null;
}

/**
 * The update of a test or contest card after an action on it: the consequence keys given, or one
 * more effect die that made an asset.
 * @param {{facts: object, message: ChatMessage}} card
 * @param {{consequenceKeys?: string[], assetEffect?: string}} change
 * @returns {object}
 */
function contestCardUpdate(card, change) {
  const update = { _id: card.message.id };
  if ( change.consequenceKeys ) update[`flags.${SYSTEM_ID}.${CONSEQUENCE_FLAG}`] = change.consequenceKeys;
  if ( change.assetEffect ) update[`flags.${SYSTEM_ID}.${ASSET_EFFECTS_FLAG}`] = [...card.facts.assetsMade, change.assetEffect];
  return update;
}

/**
 * @param {string} key - an actor UUID
 * @returns {Actor|null} the actor, a token's synthetic actor included, or null
 */
export function actorFromKey(key) {
  try {
    const doc = fromUuidSync(key);
    return (doc instanceof Actor) ? doc : null;
  }
  catch {
    return null;
  }
}

/**
 * Checks and applies one request on the GM's client.
 * @param {unknown} request
 * @param {User} user
 * @returns {Promise<{ok: boolean, code?: string, value?: object}>}
 */
async function processRequest(request, user) {
  if ( !game.user.isGM ) return fail("GM_REQUIRED");
  const store = getTraitStore();
  const roll = readRoll(request, user);
  const card = readCard(request, user);
  const actorDocs = {};
  const actors = {};
  for ( const key of requestActorKeys(request, store, roll?.facts, card?.facts) ) {
    const actor = actorFromKey(key);
    if ( !actor ) continue;
    actorDocs[key] = actor;
    actors[key] = {
      ownedBySender: actor.testUserPermission(user, "OWNER"),
      holdsPlotPoints: holdsPlotPoints(actor),
      balance: holdsPlotPoints(actor) ? actor.system.plotPoints : null
    };
  }
  const result = dispatchTraitStoreRequest({
    sender: { userId: user.id, isGM: user.isGM }, request, store, actors, roll: roll?.facts ?? null, card: card?.facts ?? null
  });
  if ( !result.ok ) return result;
  const { store: next, payment, removedIds, replayed, warnings, changes, takenOut } = result.value;
  if ( replayed ) return { ok: true, value: { revision: next.revision, removedIds, replayed, warnings } };
  try {
    let cardUpdate = null;
    if ( result.value.roll ) cardUpdate = rollCardUpdate(roll, result.value.roll);
    else if ( result.value.card ) cardUpdate = contestCardUpdate(card, result.value.card);
    const messageRef = roll?.message.id ?? card?.message.id ?? null;
    const written = (payment || cardUpdate)
      ? await writeBatch(next, payment, actorDocs, cardUpdate, messageRef)
      : await writeStore(next);
    if ( !written ) return fail("WRITE_FAILED");
  }
  catch( err ) {
    console.error(err);
    return fail("WRITE_FAILED");
  }
  return { ok: true, value: { revision: next.revision, removedIds, replayed: false, payment, warnings, changes, takenOut } };
}

/**
 * The update of a roll card after hitches or opportunities: its dice, the hitch lines that wait for
 * its settlement, and the mark that the hitch choice is finished.
 * @param {{message: ChatMessage, source: object}} roll
 * @param {{rolled: object[], pendingLines: object[], hitchesDone?: boolean}} change
 * @returns {object}
 */
function rollCardUpdate(roll, change) {
  const update = { _id: roll.message.id, "system.rolled": change.rolled };
  if ( change.pendingLines.length ) update["system.pp.otherLines"] = [...(roll.source.pp?.otherLines ?? []), ...change.pendingLines];
  if ( change.hitchesDone ) update[`flags.${SYSTEM_ID}.${HITCHES_DONE_FLAG}`] = true;
  return update;
}

/**
 * The stored data for a store, checked by the data model (strict, so a store that fails a check
 * throws here rather than being written).
 * @param {import("../rules/trait-store.mjs").TraitStore} store
 * @returns {object}
 */
function storeSource(store) {
  return new TraitStoreData({ schemaVersion: TRAIT_STORE_SCHEMA_VERSION, ...store }, { strict: true }).toObject();
}

/**
 * Writes the store alone.
 * @returns {Promise<boolean>}
 */
async function writeStore(store) {
  await game.settings.set(SYSTEM_ID, TRAIT_STORE_SETTING, storeSource(store));
  return true;
}

/**
 * The batch operation that writes a world setting, as client-settings #setWorld does: an update of
 * the Setting document when one is stored, else its creation.
 * @param {string} key - the setting's key
 * @param {unknown} value - the value to store, before JSON
 * @returns {object}
 */
function settingOperation(key, value) {
  const current = game.settings.get(SYSTEM_ID, key, { document: true });
  const json = JSON.stringify(value);
  if ( current?._id ) return { action: "update", documentName: "Setting", updates: [{ _id: current._id, value: json }] };
  return { action: "create", documentName: "Setting", data: [{ key: `${SYSTEM_ID}.${key}`, value: json }] };
}

/**
 * Writes the store with the payer's balance and its ledger entry, and the roll card, in one
 * modifyBatch call (ADR-057).
 * @param {import("../rules/trait-store.mjs").TraitStore} store
 * @param {import("../rules/trait-store.mjs").StorePayment|null} payment
 * @param {Object<string, Actor>} actorDocs
 * @param {object|null} cardUpdate - a ChatMessage update
 * @param {string|null} messageRef - the roll, test or contest card the change belongs to
 * @returns {Promise<boolean>} whether every operation came back written
 */
async function writeBatch(store, payment, actorDocs, cardUpdate, messageRef) {
  const operations = [settingOperation(TRAIT_STORE_SETTING, storeSource(store))];
  if ( payment ) {
    const actor = actorDocs[payment.account.actorKey];
    const update = { action: "update", documentName: "Actor", updates: [{ _id: actor.id, "system.plotPoints": payment.balance }] };
    if ( actor.isToken ) update.parent = actor.token;
    operations.push(update);
    const several = payment.lines.length > 1;
    operations.push({
      action: "create", documentName: "ChatMessage",
      data: [ledgerEntryData({
        account: { kind: "actor", actorId: actor.id }, actor, delta: payment.delta, balance: payment.balance,
        reason: payment.line.reason, label: several ? "" : (payment.line.label ?? ""), messageRef,
        lines: several ? payment.lines : []
      })]
    });
  }
  if ( cardUpdate ) operations.push({ action: "update", documentName: "ChatMessage", updates: [cardUpdate] });
  const results = await foundry.documents.modifyBatch(operations);
  return Array.isArray(results) && (results.length === operations.length) && results.every(r => r?.length === 1);
}
