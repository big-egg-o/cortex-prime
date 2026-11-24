/**
 * The GM's tracker of assets and complications (Decisions ADR-057; the Assets & Complications
 * 2026-11-20 tracker direction): every temporary trait of the world in one window that works with
 * every sheet closed, grouped by character, the scene, the unassigned, and traits whose character
 * is gone. Every change is a request to the GM's store handler, so it is checked and recorded like
 * a player's; End scene and End session show what they will do first (PA2).
 * @module apps/trait-tracker-app
 */

import { previewEnd, trackerGroups } from "../rules/trait-store.mjs";
import { DIE_SIZES } from "../rules/types.mjs";
import { holdsPlotPoints } from "../plot-points/accounts.mjs";
import {
  getTraitStore, notifyTraitStoreResult, relationshipActorFacts, sendTraitStoreRequest
} from "../assets/trait-store.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;
const APP_ID = "cortex-prime-trait-tracker";

/**
 * Every character that can hold a trait: world actors, and the synthetic actor of each unlinked
 * token on every scene, named by the token, so two copies of one opponent are told apart.
 * @returns {{actorKey: string, name: string, pc: boolean}[]}
 */
export function knownHolders() {
  const holders = game.actors.contents
    .map(a => ({ actorKey: a.uuid, name: a.name, pc: holdsPlotPoints(a) }))
    .sort((a, b) => (b.pc - a.pc) || a.name.localeCompare(b.name));
  for ( const scene of game.scenes ) {
    for ( const token of scene.tokens ) {
      if ( token.actorLink || !token.actor ) continue;
      holders.push({ actorKey: token.actor.uuid, name: `${token.name} (${scene.name})`, pc: holdsPlotPoints(token.actor) });
    }
  }
  return holders;
}

/** @returns {string} a trait's die as the tracker shows it */
function dieLabel(trait) {
  return trait.beyondD12 ? "d12+" : `d${trait.dice[0]}`;
}

/** @returns {object} a trait as the template shows it */
function traitView(trait) {
  const i18n = game.i18n;
  const badges = [];
  if ( trait.duration === "session" ) badges.push(i18n.localize("CORTEX.Assets.Badges.Session"));
  if ( trait.access === "open" ) badges.push(i18n.localize("CORTEX.Assets.Badges.Open"));
  if ( trait.beyondD12 ) badges.push(i18n.localize("CORTEX.Assets.Badges.BeyondD12"));
  return {
    id: trait.id, name: trait.name, die: dieLabel(trait), note: trait.note, badges,
    kind: i18n.localize(`CORTEX.Assets.Kinds.${trait.kind}`),
    origin: i18n.localize(`CORTEX.Assets.Origins.${trait.origin}`),
    complication: trait.kind === "complication"
  };
}

/** @returns {string} the escaped options of a holder select */
function holderOptions(holders, { scene = true, unassigned = true } = {}) {
  const esc = foundry.utils.escapeHTML;
  const options = [];
  if ( unassigned ) options.push(`<option value="unassigned">${esc(game.i18n.localize("CORTEX.Assets.Unassigned"))}</option>`);
  if ( scene ) options.push(`<option value="scene">${esc(game.i18n.localize("CORTEX.Assets.Scene"))}</option>`);
  for ( const h of holders ) options.push(`<option value="${esc(h.actorKey)}">${esc(h.name)}</option>`);
  return options.join("");
}

/** @returns {object} the holder a select's value names */
function holderFrom(value) {
  if ( (value === "scene") || (value === "unassigned") ) return { kind: value };
  return { kind: "actor", actorId: value };
}

/** @returns {string} the die size select */
function sizeSelect(selected = 6) {
  return `<select name="size">${DIE_SIZES.map(s => `<option value="${s}"${s === selected ? " selected" : ""}>d${s}</option>`).join("")}</select>`;
}

/**
 * @extends {foundry.applications.api.ApplicationV2}
 * @mixes HandlebarsApplicationMixin
 */
export default class TraitTrackerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @override */
  static DEFAULT_OPTIONS = {
    id: APP_ID,
    classes: ["cortex-prime", "trait-tracker"],
    window: { title: "CORTEX.Assets.Tracker", icon: "fa-solid fa-list-check", resizable: true, contentClasses: ["standard-form"] },
    position: { width: 460, height: 600 },
    actions: {
      stepUp: (_e, t) => TraitTrackerApp.#send("step", { traitId: t.dataset.traitId, steps: 1 }),
      stepDown: (_e, t) => TraitTrackerApp.#send("step", { traitId: t.dataset.traitId, steps: -1 }),
      remove: (_e, t) => TraitTrackerApp.#remove(t.dataset.traitId),
      editNote: (_e, t) => TraitTrackerApp.#editNote(t.dataset.traitId),
      assign: (_e, t) => TraitTrackerApp.#assign(t.dataset.traitId),
      addComplication: () => TraitTrackerApp.#add("complication"),
      addAsset: () => TraitTrackerApp.#add("asset"),
      endScene: () => TraitTrackerApp.#end("scene"),
      endSession: () => TraitTrackerApp.#end("session")
    }
  };

  /** @override */
  static PARTS = { body: { template: "systems/cortex-prime/templates/apps/trait-tracker.hbs", scrollable: [".cp-tracker-groups"] } };

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const groups = trackerGroups(getTraitStore(), knownHolders());
    if ( !groups.ok ) return Object.assign(context, { invalid: groups.code });
    const g = groups.value;
    const i18n = game.i18n;
    const sections = [
      ...g.characters.map(c => ({ title: c.name, traits: c.traits })),
      { title: i18n.localize("CORTEX.Assets.Scene"), traits: g.scene },
      { title: i18n.localize("CORTEX.Assets.Unassigned"), traits: g.unassigned },
      { title: i18n.localize("CORTEX.Assets.Orphaned"), traits: g.orphaned }
    ].filter(s => s.traits.length).map(s => ({ title: s.title, traits: s.traits.map(traitView) }));
    return Object.assign(context, { sections });
  }

  /** Sends one action and shows a refusal. */
  static async #send(action, payload) {
    return notifyTraitStoreResult(await sendTraitStoreRequest(action, payload));
  }

  /** @returns {object|undefined} the stored trait with this id */
  static #trait(traitId) {
    return getTraitStore().traits.find(t => t.id === traitId);
  }

  static async #remove(traitId) {
    const trait = TraitTrackerApp.#trait(traitId);
    if ( !trait ) return;
    const yes = await DialogV2.confirm({
      window: { title: "CORTEX.Assets.Remove" },
      content: `<p>${foundry.utils.escapeHTML(game.i18n.format("CORTEX.Assets.RemoveConfirm", { name: trait.name }))}</p>`
    });
    if ( yes ) await TraitTrackerApp.#send("remove", { traitId });
  }

  static async #editNote(traitId) {
    const note = getTraitStore().notes[traitId] ?? "";
    const data = await DialogV2.input({
      window: { title: "CORTEX.Assets.Note" },
      content: `<div class="form-group"><label>${game.i18n.localize("CORTEX.Assets.Note")}</label>
        <div class="form-fields"><input type="text" name="note" maxlength="500" value="${foundry.utils.escapeHTML(note)}" autofocus></div></div>`,
      ok: { label: "CORTEX.Assets.Save", icon: "fa-solid fa-check" }
    });
    if ( data && (typeof data === "object") ) await TraitTrackerApp.#send("setNote", { traitId, note: String(data.note ?? "") });
  }

  static async #assign(traitId) {
    const data = await DialogV2.input({
      window: { title: "CORTEX.Assets.Assign" },
      content: `<div class="form-group"><label>${game.i18n.localize("CORTEX.Assets.Holder")}</label>
        <div class="form-fields"><select name="holder">${holderOptions(knownHolders())}</select></div></div>`,
      ok: { label: "CORTEX.Assets.Assign", icon: "fa-solid fa-check" }
    });
    if ( data && (typeof data === "object") ) await TraitTrackerApp.#send("assign", { traitId, holder: holderFrom(data.holder) });
  }

  /** Adds a complication, a GM asset, or an asset a PC buys for 1 PP. */
  static async #add(kind) {
    const i18n = game.i18n;
    const asset = kind === "asset";
    const content = `
      <div class="form-group"><label>${i18n.localize("CORTEX.Assets.Name")}</label>
        <div class="form-fields"><input type="text" name="name" required autofocus></div></div>
      <div class="form-group"><label>${i18n.localize("CORTEX.Assets.Die")}</label>
        <div class="form-fields">${sizeSelect(6)}</div></div>
      <div class="form-group"><label>${i18n.localize("CORTEX.Assets.Holder")}</label>
        <div class="form-fields"><select name="holder">${holderOptions(knownHolders(), { unassigned: !asset })}</select></div></div>
      ${asset ? `<div class="form-group"><label>${i18n.localize("CORTEX.Assets.Bought")}</label>
        <div class="form-fields"><input type="checkbox" name="bought"></div>
        <p class="hint">${i18n.localize("CORTEX.Assets.BoughtHint")}</p></div>` : ""}
      ${asset ? `<div class="form-group"><label>${i18n.localize("CORTEX.Assets.KeepForSession")}</label>
        <div class="form-fields"><input type="checkbox" name="keep"></div></div>` : ""}`;
    const data = await DialogV2.input({
      window: { title: asset ? "CORTEX.Assets.AddAsset" : "CORTEX.Assets.AddComplication" },
      content,
      ok: { label: "CORTEX.Assets.Add", icon: "fa-solid fa-plus" }
    });
    if ( !data || (typeof data !== "object") || !String(data.name ?? "").trim() ) return;
    const base = { id: foundry.utils.randomID(16), name: String(data.name).trim(), holder: holderFrom(data.holder) };
    if ( !asset ) return TraitTrackerApp.#send("addComplication", { ...base, size: Number(data.size) });
    if ( data.bought ) return TraitTrackerApp.#send("buyAsset", base);
    return TraitTrackerApp.#send("addAsset", { ...base, size: Number(data.size), keepForSession: Boolean(data.keep) });
  }

  /** End scene or End session, after a preview of what ends and what stays (PA2). */
  static async #end(period) {
    const store = getTraitStore();
    const preview = previewEnd(store, period, period === "session" ? relationshipActorFacts() : {});
    if ( !notifyTraitStoreResult(preview) ) return;
    const name = id => store.traits.find(t => t.id === id)?.name ?? id;
    const esc = foundry.utils.escapeHTML;
    const list = ids => (ids.length ? `<ul>${ids.map(id => `<li>${esc(name(id))}</li>`).join("")}</ul>`
      : `<p class="hint">${game.i18n.localize("CORTEX.Assets.None")}</p>`);
    const i18n = game.i18n;
    const content = `
      <h4>${i18n.localize("CORTEX.Assets.Preview.Ends")}</h4>${list(preview.value.removedIds)}
      <h4>${i18n.localize("CORTEX.Assets.Preview.Review")}</h4>${list(preview.value.reviewIds)}
      <p>${i18n.format("CORTEX.Assets.Preview.Boosts", { count: preview.value.boostsReset })}</p>`
      + (preview.value.expiringRelationships.length ? `<p>${i18n.format("CORTEX.Assets.Relationship.Expiring", {
        names: esc(preview.value.expiringRelationships
          .map(r => `${r.name} (${fromUuidSync(r.actorKey)?.name ?? r.actorKey})`).join(", "))
      })}</p>` : "");
    const title = period === "scene" ? "CORTEX.Assets.EndScene" : "CORTEX.Assets.EndSession";
    const yes = await DialogV2.confirm({ window: { title }, content });
    if ( yes ) await TraitTrackerApp.#send(period === "scene" ? "endScene" : "endSession", {});
  }

  /** Renders the open window again after the store changed. */
  static refresh() {
    const app = foundry.applications.instances.get(APP_ID);
    if ( app?.rendered ) app.render();
  }

  /** Opens the window for a GM. */
  static open() {
    if ( !game.user.isGM ) return;
    const app = foundry.applications.instances.get(APP_ID) ?? new TraitTrackerApp();
    return app.render({ force: true });
  }
}
