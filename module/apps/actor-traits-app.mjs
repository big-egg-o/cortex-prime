/**
 * One character's assets and complications, for its owner (step 4.8c; the Assets & Complications
 * 2026-11-20 direction: the sheet keeps no standing list, and "View my complications" is an
 * inspection opened on demand). Read from the store, so it shows what the GM's tracker shows for
 * this character. An asset offers Keep for the session and Open to everyone, each for 1 PP through
 * the GM's store handler (rules 8 and 9); a complication past d12 shows that it takes the character
 * out (PA6). Changes come only through the handler, which checks the owner and the plot points.
 * @module apps/actor-traits-app
 */

import { getTraitStore, notifyTraitStoreResult, sendTraitStoreRequest } from "../assets/trait-store.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

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
      openAsset: (_e, t) => ActorTraitsApp.#send("openAsset", t.dataset.traitId)
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
      canOpen: (t.kind === "asset") && (t.access !== "open") && this.#actor.isOwner
    });
    return Object.assign(context, {
      assets: mine.filter(t => t.kind === "asset").map(view),
      complications: mine.filter(t => t.kind === "complication").map(view)
    });
  }

  /** Sends Keep or Open for one asset and shows a refusal. */
  static async #send(action, traitId) {
    return notifyTraitStoreResult(await sendTraitStoreRequest(action, { traitId }));
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
