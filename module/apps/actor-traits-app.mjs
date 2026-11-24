/**
 * One character's assets and complications, for its owner (step 4.8c; the Assets & Complications
 * 2026-11-20 direction: the sheet keeps no standing list, and "View my complications" is an
 * inspection opened on demand). Read from the store, so it shows what the GM's tracker shows for
 * this character. An asset offers Keep for the session and Open to everyone, and a clue asset Give
 * to another character, each for 1 PP through the GM's store handler (rules 7 to 9; RQ-049); a
 * complication past d12 shows that it takes the character out (PA6). Changes come only through the handler, which checks the owner and the plot points.
 *
 * Step 4.9 (ADR-058): the character's signature assets, from the sets the game configuration marks,
 * with Lost (damaged and/or out of action) and Recover, for 1 PP or between sessions (rule 12,
 * RQ-051); "New relationship (1 PP)" for each relationships set (rule 15); and the other
 * characters' signature assets, each borrowed as an ordinary d6 asset for 1 PP (rule 13).
 * @module apps/actor-traits-app
 */

import {
  getTraitStore, markedFactsOf, notifyTraitStoreResult, sendTraitStoreRequest
} from "../assets/trait-store.mjs";
import { getGameConfig } from "../config/settings.mjs";
import { knownHolders } from "./trait-tracker-app.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/** @returns {string} the window id for an actor key */
function appId(actorKey) {
  return `cortex-prime-actor-traits-${actorKey.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/**
 * @extends {foundry.applications.api.ApplicationV2}
 * @mixes HandlebarsApplicationMixin
 */
export default class ActorTraitsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {{actor: Actor}} options
   */
  constructor(options) {
    super({ ...options, id: appId(options.actor.uuid) });
    this.#actor = options.actor;
  }

  /** @type {Actor} */
  #actor;

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["cortex-prime", "actor-traits"],
    window: { icon: "fa-solid fa-list-check", resizable: true, contentClasses: ["standard-form"] },
    position: { width: 380, height: "auto" },
    actions: {
      keepAsset: (_e, t) => ActorTraitsApp.#send("keepAsset", t.dataset.traitId),
      openAsset: (_e, t) => ActorTraitsApp.#send("openAsset", t.dataset.traitId),
      giveClue(_e, t) { return this.#giveClue(t.dataset.traitId); },
      loseSignature(_e, t) { return this.#loseSignature(t.dataset.setId, t.dataset.entryId); },
      recoverSignature(_e, t) {
        return this.#sendForActor("recoverSignatureAsset", { setId: t.dataset.setId, entryId: t.dataset.entryId, route: t.dataset.route });
      },
      newRelationship(_e, t) { return this.#newRelationship(t.dataset.setId); },
      borrowSignature(_e, t) { return this.#borrow(t.dataset.actorKey, t.dataset.setId, t.dataset.entryId); }
    }
  };

  /** @override */
  static PARTS = { body: { template: "systems/cortex-prime/templates/apps/actor-traits.hbs" } };

  /** @override */
  get title() {
    return game.i18n.format("CORTEX.Assets.Mine.Title", { name: this.#actor.name });
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const i18n = game.i18n;
    const store = getTraitStore();
    const mine = store.traits.filter(t => (t.holder.kind === "actor") && (t.holder.actorId === this.#actor.uuid));
    const view = t => ({
      id: t.id, name: t.name, die: t.beyondD12 ? "d12+" : `d${t.dice[0]}`, note: store.notes[t.id] ?? "",
      origin: i18n.localize(`CORTEX.Assets.Origins.${t.origin}`),
      session: t.duration === "session", open: t.access === "open", takenOut: t.beyondD12,
      canKeep: (t.kind === "asset") && (t.duration !== "session") && this.#actor.isOwner,
      canOpen: (t.kind === "asset") && (t.access !== "open") && this.#actor.isOwner,
      canGive: (t.kind === "asset") && (t.origin === "clue") && this.#actor.isOwner
    });
    return Object.assign(context, {
      assets: mine.filter(t => t.kind === "asset").map(view),
      complications: mine.filter(t => t.kind === "complication").map(view),
      ...this.#markedContext(store)
    });
  }

  /**
   * The signature assets, relationships sets and borrowable signature assets (ADR-058).
   * @param {import("../rules/trait-store.mjs").TraitStore} store
   * @returns {{signatureAssets: object[], relationshipSets: object[], borrowable: object[]}}
   */
  #markedContext(store) {
    const i18n = game.i18n;
    let config;
    try {
      config = getGameConfig();
    }
    catch {
      return { signatureAssets: [], relationshipSets: [], borrowable: [] };
    }
    const dice = list => list.map(size => `d${size}`).join(" ");
    const marked = markedFactsOf(this.#actor, config);
    const signatureAssets = [];
    const relationshipSets = [];
    for ( const [setId, set] of Object.entries(marked) ) {
      const setName = config.traitSets.find(s => s.id === setId)?.name ?? "";
      if ( set.mark === "sessionRelationships" ) {
        relationshipSets.push({
          setId, setName,
          sessionOnly: set.entries.filter(e => e.sessionOnly === true).map(e => ({ name: e.name, die: dice(e.dice) }))
        });
        continue;
      }
      for ( const entry of set.entries ) {
        const boost = store.sceneBoosts.find(b => (b.actorId === this.#actor.uuid) && (b.traitId === entry.id));
        signatureAssets.push({
          setId, entryId: entry.id, name: entry.name, die: dice(entry.dice),
          boost: boost ? i18n.format("CORTEX.Assets.Signature.Boost", { steps: boost.steps }) : "",
          outOfAction: entry.lost?.outOfAction === true,
          damaged: Boolean(entry.lost) && (entry.lost.outOfAction !== true),
          lost: Boolean(entry.lost),
          before: entry.lost ? dice(entry.lost.preLossDice) : ""
        });
      }
    }
    const borrowable = [];
    if ( this.#actor.isOwner ) {
      for ( const other of game.actors ) {
        if ( other.uuid === this.#actor.uuid ) continue;
        for ( const [setId, set] of Object.entries(markedFactsOf(other, config)) ) {
          if ( set.mark !== "signatureAssets" ) continue;
          for ( const entry of set.entries ) {
            borrowable.push({ actorKey: other.uuid, owner: other.name, setId, entryId: entry.id, name: entry.name });
          }
        }
      }
    }
    return { signatureAssets, relationshipSets, borrowable, canAct: this.#actor.isOwner };
  }

  /** Sends an action for this character and shows a refusal. */
  async #sendForActor(action, payload) {
    return notifyTraitStoreResult(await sendTraitStoreRequest(action, { actorKey: this.#actor.uuid, ...payload }));
  }

  /** Marks a signature asset damaged (steps down), out of action, or both (rule 12, RQ-051). */
  async #loseSignature(setId, entryId) {
    const i18n = game.i18n;
    const data = await DialogV2.input({
      window: { title: "CORTEX.Assets.Signature.Lose" },
      content: `<div class="form-group"><label>${i18n.localize("CORTEX.Assets.Signature.OutOfAction")}</label>
        <div class="form-fields"><input type="checkbox" name="outOfAction" checked></div></div>
        <div class="form-group"><label>${i18n.localize("CORTEX.Assets.Signature.StepsDown")}</label>
        <div class="form-fields"><input type="number" name="steps" value="0" min="0" max="4" step="1"></div></div>`,
      ok: { label: "CORTEX.Assets.Signature.Lose", icon: "fa-solid fa-heart-crack" }
    });
    if ( !data || (typeof data !== "object") ) return false;
    const steps = Math.trunc(Number(data.steps) || 0);
    const payload = { setId, entryId };
    if ( data.outOfAction ) payload.outOfAction = true;
    if ( steps > 0 ) payload.steps = -steps;
    return this.#sendForActor("loseSignatureAsset", payload);
  }

  /** Buys a d6 relationship for the session in one relationships set (rule 15). */
  async #newRelationship(setId) {
    const data = await DialogV2.input({
      window: { title: "CORTEX.Assets.Relationship.New" },
      content: `<div class="form-group"><label>${game.i18n.localize("CORTEX.Assets.Relationship.With")}</label>
        <div class="form-fields"><input type="text" name="name" required autofocus></div></div>`,
      ok: { label: "CORTEX.Assets.Relationship.NewCost", icon: "fa-solid fa-user-group" }
    });
    const name = (data && (typeof data === "object")) ? String(data.name ?? "").trim() : "";
    if ( !data ) return false;
    if ( !name ) {
      ui.notifications.warn(game.i18n.localize("CORTEX.Assets.Errors.RELATIONSHIP_NAME_REQUIRED"));
      return false;
    }
    return this.#sendForActor("createRelationship", { setId, id: foundry.utils.randomID(), name });
  }

  /** Uses another character's signature asset as an ordinary d6 asset for 1 PP (rule 13). */
  async #borrow(fromKey, setId, entryId) {
    const owner = fromUuidSync(fromKey);
    const entry = owner ? markedFactsOf(owner)[setId]?.entries.find(e => e.id === entryId) : null;
    if ( !entry ) return false;
    return this.#sendForActor("borrowSignatureAsset", {
      id: foundry.utils.randomID(), name: game.i18n.format("CORTEX.Assets.Signature.BorrowedName", { name: entry.name }),
      from: { actorKey: fromKey, setId, entryId }
    });
  }

  /** Sends Keep or Open for one asset and shows a refusal. */
  static async #send(action, traitId) {
    return notifyTraitStoreResult(await sendTraitStoreRequest(action, { traitId }));
  }

  /** Hands a clue asset to another character, chosen from the world's characters. */
  async #giveClue(traitId) {
    const esc = foundry.utils.escapeHTML;
    const others = knownHolders().filter(h => h.actorKey !== this.#actor.uuid);
    const data = await DialogV2.input({
      window: { title: "CORTEX.Assets.Mine.Give" },
      content: `<div class="form-group"><label>${game.i18n.localize("CORTEX.Assets.Holder")}</label>
        <div class="form-fields"><select name="holder">${others.map(h => `<option value="${esc(h.actorKey)}">${esc(h.name)}</option>`).join("")}</select></div></div>`,
      ok: { label: "CORTEX.Assets.Mine.Give", icon: "fa-solid fa-hand-holding" }
    });
    if ( !data || (typeof data !== "object") || !data.holder ) return false;
    return notifyTraitStoreResult(await sendTraitStoreRequest("giveClue", {
      traitId, holder: { kind: "actor", actorId: String(data.holder) }
    }));
  }

  /** Renders every open window again after the store changed. */
  static refresh() {
    for ( const app of foundry.applications.instances.values() ) {
      if ( (app instanceof ActorTraitsApp) && app.rendered ) app.render();
    }
  }

  /**
   * Opens the window for an actor its user owns, or for a GM.
   * @param {Actor} actor
   */
  static open(actor) {
    if ( !actor?.isOwner ) return;
    const app = foundry.applications.instances.get(appId(actor.uuid)) ?? new ActorTraitsApp({ actor });
    return app.render({ force: true });
  }
}
