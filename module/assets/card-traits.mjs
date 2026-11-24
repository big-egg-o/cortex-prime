/**
 * Complications and assets on the test and contest card (step 4.8c; Assets & Complications rules 5,
 * 7 and 21 to 24; PA5). Once the card has a consequence, the GM (or the winner's owner when the
 * loser is a GMC) applies its complications, each new by default or as a step-up of one the side
 * already has; and the GM makes an asset from an effect die that can make one: a successful test's,
 * with the cap the GM set, or a contest winner's die not used against the loser. Every change is a
 * request to the GM's store handler (ADR-057), which reads the card again (cardTraitFacts) and
 * writes the store and the card's mark together. Nothing here decides an outcome.
 * @module assets/card-traits
 */

import { contestConsequence, testResult } from "../rules/index.mjs";
import { consequenceComplications, effectAssetDice } from "../rules/trait-store.mjs";
import { DIE_SIZES } from "../rules/types.mjs";
import { contestRecordOf, sideActor } from "../contest/records.mjs";
import { bankSides, contestPpRecord } from "../plot-points/contest-pp.mjs";
import { getTraitStore, notifyTraitStoreResult, sendTraitStoreRequest } from "./trait-store.mjs";

const { DialogV2 } = foundry.applications.api;
const SYSTEM_ID = "cortex-prime";

/** The flag that lists the consequence keys a card has given. */
export const CONSEQUENCE_FLAG = "consequenceKeys";

/** The flag that lists the effect dice of a card that made an asset. */
export const ASSET_EFFECTS_FLAG = "assetEffects";

/** @returns {string[]} a flag's string list, or an empty one */
function listFlag(message, key) {
  const value = message.getFlag?.(SYSTEM_ID, key);
  return Array.isArray(value) ? value.filter(v => typeof v === "string") : [];
}

/**
 * What a test or contest card holds for the store handler (CardFacts), read from the card, or null
 * when the message isn't a contest message a GM wrote. A contest offers nothing before the winner's
 * pick when the winner has effect dice, as staying in does (PP_PICK_FIRST).
 * @param {ChatMessage} message
 * @param {User} user - the sender
 * @returns {import("../rules/trait-store.mjs").CardFacts|null}
 */
export function cardTraitFacts(message, user) {
  const loaded = contestRecordOf(message);
  if ( !loaded ) return null;
  const { record, system } = loaded;
  const state = record.state;
  const sides = system.sides;
  const actorKey = key => sideActor(sides.find(s => s.key === key))?.uuid ?? null;
  const facts = {
    type: record.type, offered: [], holderKey: null, appliedKeys: listFlag(message, CONSEQUENCE_FLAG),
    winnerOwnedBySender: false, loserIsBank: false, assetEffects: [], assetHolderKey: null,
    assetsMade: listFlag(message, ASSET_EFFECTS_FLAG)
  };
  const stayIn = contestPpRecord(message).stayIn;
  if ( record.type === "test" ) {
    const tested = testResult(state);
    if ( !tested.ok ) return facts;
    const offered = consequenceComplications({
      type: "test", success: tested.value.success, stayIn: stayIn ? (stayIn.complications ?? []) : null
    });
    facts.offered = offered.ok ? offered.value : [];
    facts.holderKey = actorKey("roller");
    facts.loserIsBank = bankSides(sides).includes("roller");
    facts.assetEffects = effectAssetDice({ type: "test", success: tested.value.success, effects: tested.value.effects });
    facts.assetHolderKey = facts.holderKey;
    return facts;
  }
  const stored = system.flow.usedAgainstLoser ?? null;
  const consequence = contestConsequence(state, { usedAgainstLoser: stored ?? [] });
  if ( !consequence.ok ) return facts;
  const c = consequence.value;
  const picked = (stored !== null) || (c.ending !== "won") || !c.winnerEffects.length;
  if ( picked ) {
    const offered = consequenceComplications({ type: "contest", consequence: c, stayedIn: Boolean(stayIn) });
    facts.offered = offered.ok ? offered.value : [];
  }
  facts.holderKey = actorKey(c.loser);
  facts.loserIsBank = bankSides(sides).includes(c.loser);
  facts.winnerOwnedBySender = sideActor(sides.find(s => s.key === c.winner))?.testUserPermission(user, "OWNER") === true;
  facts.assetEffects = effectAssetDice({ type: "contest", consequence: c, usedAgainstLoser: stored });
  facts.assetHolderKey = actorKey(c.winner);
  return facts;
}

/**
 * The card's section for the current user: the complications still to give, when this user may
 * give them; the effect dice that can still make an asset, for a GM; and whether any were given.
 * Null when there is nothing to show.
 * @param {ChatMessage} message
 * @param {User} [user=game.user]
 * @returns {{apply: {count: number}|null, asset: {count: number}|null, applied: boolean}|null}
 */
export function cardTraitContext(message, user = game.user) {
  const facts = cardTraitFacts(message, user);
  if ( !facts ) return null;
  const open = facts.offered.filter(o => !facts.appliedKeys.includes(o.key));
  const mayApply = user.isGM || ((facts.type === "contest") && facts.winnerOwnedBySender && facts.loserIsBank);
  const apply = (open.length && mayApply) ? { count: open.length } : null;
  const spare = facts.assetEffects.filter(e => !facts.assetsMade.includes(e.id));
  const asset = (user.isGM && spare.length && facts.assetHolderKey) ? { count: spare.length } : null;
  const applied = facts.appliedKeys.length > 0;
  if ( !apply && !asset && !applied ) return null;
  return { apply, asset, applied };
}

/** @returns {string} the escaped options of a select */
function options(entries, selected = null) {
  const esc = foundry.utils.escapeHTML;
  return entries.map(([value, label]) => `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`).join("");
}

/** @returns {string} a trait's die as a label */
function dieLabel(trait) {
  return trait.beyondD12 ? "d12+" : `d${trait.dice[0]}`;
}

/**
 * Gives the card's complications: one row per complication still to give, each a new complication
 * by default (named in the row) or a step-up of one the side has that is at least as large; the
 * failed test's d6 has a box, unticked means it isn't given (PA5).
 * @param {ChatMessage} message
 * @returns {Promise<boolean>} whether a request went through
 */
export async function openConsequenceDialog(message) {
  const i18n = game.i18n;
  const esc = foundry.utils.escapeHTML;
  const facts = cardTraitFacts(message, game.user);
  const open = facts?.offered.filter(o => !facts.appliedKeys.includes(o.key)) ?? [];
  if ( !open.length ) return notifyTraitStoreResult({ ok: false, code: "NOTHING_TO_APPLY" });
  const held = facts.holderKey
    ? getTraitStore().traits.filter(t => (t.kind === "complication") && (t.holder.actorId === facts.holderKey)) : [];
  const rows = open.map(o => {
    const steps = held.filter(t => t.beyondD12 || (t.dice[0] >= o.size))
      .map(t => [t.id, `${i18n.localize("CORTEX.Assets.StepUp")}: ${t.name} ${dieLabel(t)}`]);
    const cause = i18n.localize(`CORTEX.Assets.Origins.${o.cause}`);
    return `<fieldset><legend>d${o.size} · ${esc(cause)}</legend>
      ${o.required ? "" : `<div class="form-group"><label>${i18n.localize("CORTEX.Assets.Consequence.Give")}</label>
        <div class="form-fields"><input type="checkbox" name="give.${esc(o.key)}" checked></div></div>`}
      <div class="form-group"><label>${i18n.localize("CORTEX.Assets.Hitches.Target")}</label>
        <div class="form-fields"><select name="target.${esc(o.key)}">${options([
          ["new", i18n.localize("CORTEX.Assets.Hitches.New")], ...steps
        ])}</select></div></div>
      <div class="form-group"><label>${i18n.localize("CORTEX.Assets.Name")}</label>
        <div class="form-fields"><input type="text" name="name.${esc(o.key)}"></div></div>
    </fieldset>`;
  }).join("");
  const content = `<p class="hint">${i18n.localize("CORTEX.Assets.Consequence.Hint")}</p>${rows}`;
  const data = await DialogV2.input({
    window: { title: "CORTEX.Assets.Consequence.Title" }, content,
    ok: { label: "CORTEX.Assets.Consequence.Apply", icon: "fa-solid fa-triangle-exclamation" }
  });
  if ( !data || (typeof data !== "object") ) return false;
  const items = [];
  for ( const o of open ) {
    if ( !o.required && !data[`give.${o.key}`] ) continue;
    const choice = String(data[`target.${o.key}`] ?? "new");
    if ( choice !== "new" ) {
      items.push({ key: o.key, target: { kind: "existing", traitId: choice } });
      continue;
    }
    const name = String(data[`name.${o.key}`] ?? "").trim();
    if ( !name ) return notifyTraitStoreResult({ ok: false, code: "NAME_REQUIRED" });
    items.push({ key: o.key, target: { kind: "new", id: foundry.utils.randomID(16), name } });
  }
  if ( !items.length ) return false;
  const result = await sendTraitStoreRequest("applyConsequence", { messageId: message.id, items });
  if ( !notifyTraitStoreResult(result) ) return false;
  const store = getTraitStore();
  for ( const id of result.value?.takenOut ?? [] ) {
    const name = store.traits.find(t => t.id === id)?.name ?? id;
    ui.notifications.info(i18n.format("CORTEX.Assets.TakenOut", { name }));
  }
  return true;
}

/**
 * The GM makes an asset from one of the card's effect dice for the side they belong to: on a test,
 * an asset or a clue, with an optional cap (the size of the difficulty dice the GM chose as the cap,
 * rule 5); on a contest, an asset from a die the winner didn't use against the loser.
 * @param {ChatMessage} message
 * @returns {Promise<boolean>}
 */
export async function openEffectAssetDialog(message) {
  const i18n = game.i18n;
  const facts = cardTraitFacts(message, game.user);
  const spare = facts?.assetEffects.filter(e => !facts.assetsMade.includes(e.id)) ?? [];
  if ( !spare.length ) return notifyTraitStoreResult({ ok: false, code: "EFFECT_DIE_NOT_FOUND" });
  const test = facts.type === "test";
  const content = `
    <div class="form-group"><label>${i18n.localize("CORTEX.Assets.EffectAsset.Die")}</label>
      <div class="form-fields"><select name="effectId">${options(spare.map(e => [e.id, `d${e.size}`]))}</select></div></div>
    <div class="form-group"><label>${i18n.localize("CORTEX.Assets.Name")}</label>
      <div class="form-fields"><input type="text" name="name" autofocus></div></div>
    ${test ? `<div class="form-group"><label>${i18n.localize("CORTEX.Assets.EffectAsset.Kind")}</label>
      <div class="form-fields"><select name="origin">${options([
        ["effect", i18n.localize("CORTEX.Assets.EffectAsset.Asset")], ["clue", i18n.localize("CORTEX.Assets.EffectAsset.Clue")]
      ])}</select></div></div>
    <div class="form-group"><label>${i18n.localize("CORTEX.Assets.EffectAsset.Cap")}</label>
      <div class="form-fields"><select name="cap">${options([
        ["none", i18n.localize("CORTEX.Assets.EffectAsset.NoCap")], ...DIE_SIZES.map(s => [String(s), `d${s}`])
      ], "none")}</select></div>
      <p class="hint">${i18n.localize("CORTEX.Assets.EffectAsset.CapHint")}</p></div>` : ""}`;
  const data = await DialogV2.input({
    window: { title: "CORTEX.Assets.EffectAsset.Title" }, content,
    ok: { label: "CORTEX.Assets.EffectAsset.Create", icon: "fa-solid fa-plus" }
  });
  if ( !data || (typeof data !== "object") ) return false;
  const name = String(data.name ?? "").trim();
  if ( !name ) return notifyTraitStoreResult({ ok: false, code: "ASSET_NAME_REQUIRED" });
  const payload = {
    messageId: message.id, effectId: String(data.effectId), id: foundry.utils.randomID(16), name,
    origin: test ? String(data.origin) : "effect"
  };
  if ( test && (data.cap !== "none") ) payload.cap = Number(data.cap);
  return notifyTraitStoreResult(await sendTraitStoreRequest("createEffectAsset", payload));
}
