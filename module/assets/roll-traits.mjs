/**
 * Hitches and opportunities on a poolRoll card (step 4.8b; Assets & Complications rules 16 to 20;
 * RQ-045 to RQ-047, RQ-050). The GM turns a player's hitches into complications, or finishes the
 * roll's hitch choice with none, which removes the roller's used d4 complications; a player uses
 * the GM's hitches as opportunities on a complication or an asset, for 1 PP per trait. Every change
 * is a request to the GM's store handler (ADR-057), which writes the store, the card and any
 * payment together. Nothing here decides an outcome.
 * @module assets/roll-traits
 */

import { holdsPlotPoints } from "../plot-points/accounts.mjs";
import { usedD4ComplicationIds } from "../rules/trait-store.mjs";
import {
  HITCHES_DONE_FLAG, actorFromKey, getTraitStore, notifyTraitStoreResult, rollerKeyOf, sendTraitStoreRequest
} from "./trait-store.mjs";

const { DialogV2 } = foundry.applications.api;
const SYSTEM_ID = "cortex-prime";

/** @returns {object[]} the rolled dice that are hitches not yet activated */
function openHitches(message) {
  return message.system.rolled.filter(d => d.hitch && (d.state !== "hitch-activated"));
}

/** @returns {boolean} whether the bank pays for this roll, so its hitches are opportunities */
function bankRoll(message) {
  return message.system.pp?.payer?.kind === "bank";
}

/** @returns {Actor[]} the PCs the current user owns */
function ownedPcs() {
  return game.actors.filter(a => holdsPlotPoints(a) && a.isOwner);
}

/**
 * What the card offers the current user: the GM's hitch choice on a player's roll, and a player's
 * opportunities on the bank's roll. Null when it offers neither and has no finished choice to show.
 * @param {ChatMessage} message - a poolRoll message
 * @returns {{hitches: {count: number, botch: boolean}|null, opportunities: {count: number}|null,
 *   done: boolean}|null}
 */
export function rollTraitContext(message) {
  const done = message.getFlag(SYSTEM_ID, HITCHES_DONE_FLAG) === true;
  const open = openHitches(message);
  const bank = bankRoll(message);
  let hitches = null;
  let opportunities = null;
  if ( game.user.isGM && !bank && !done ) {
    const usedD4 = usedD4ComplicationIds(message.system.pool, rollerKeyOf(message)).length > 0;
    if ( open.length || usedD4 ) {
      hitches = { count: open.length, botch: (open.length > 0) && message.system.rolled.every(d => d.hitch) };
    }
  }
  if ( !game.user.isGM && bank && open.length && ownedPcs().length ) opportunities = { count: open.length };
  if ( !hitches && !opportunities && !done ) return null;
  return { hitches, opportunities, done: done && !bank };
}

/** @returns {string} the escaped options of a select */
function options(entries, selected = null) {
  const esc = foundry.utils.escapeHTML;
  return entries.map(([value, label]) => `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`).join("");
}

/** @returns {string} a checkbox per die, named by its id */
function dieChecks(dice) {
  const esc = foundry.utils.escapeHTML;
  return dice.map(d => `<label class="checkbox"><input type="checkbox" name="die.${esc(d.id)}" checked>
    d${d.size} · ${esc(d.source.label)}</label>`).join("");
}

/** Shows what a done request changed that the table should know: a character taken out. */
function announce(result) {
  if ( !notifyTraitStoreResult(result) ) return false;
  const store = getTraitStore();
  for ( const id of result.value?.takenOut ?? [] ) {
    const name = store.traits.find(t => t.id === id)?.name ?? id;
    ui.notifications.info(game.i18n.format("CORTEX.Assets.TakenOut", { name }));
  }
  return true;
}

/**
 * The GM's hitch choice for a player's roll: the chosen hitches make a new complication for the
 * roller, or step up one of the roller's complications; on a botch every die makes one. "That's
 * all" finishes the choice.
 * @param {ChatMessage} message
 * @returns {Promise<boolean>} whether a request went through
 */
export async function openHitchDialog(message) {
  const i18n = game.i18n;
  const open = openHitches(message);
  const botch = message.system.rolled.every(d => d.hitch);
  const rollerKey = rollerKeyOf(message);
  const existing = getTraitStore().traits.filter(t => (t.kind === "complication") && (t.holder.actorId === rollerKey));
  const content = `
    ${botch ? `<p class="hint">${i18n.localize("CORTEX.Assets.Hitches.BotchHint")}</p>` : `<fieldset><legend>${i18n.localize("CORTEX.Assets.Hitches.Dice")}</legend>${dieChecks(open)}</fieldset>`}
    <div class="form-group"><label>${i18n.localize("CORTEX.Assets.Hitches.Target")}</label>
      <div class="form-fields"><select name="target">${options([
        ["new", i18n.localize("CORTEX.Assets.Hitches.New")],
        ...existing.map(t => [t.id, `${i18n.localize("CORTEX.Assets.StepUp")}: ${t.name} d${t.dice[0]}`])
      ])}</select></div></div>
    <div class="form-group"><label>${i18n.localize("CORTEX.Assets.Name")}</label>
      <div class="form-fields"><input type="text" name="name" autofocus></div></div>
    <div class="form-group"><label>${i18n.localize("CORTEX.Assets.Hitches.Finish")}</label>
      <div class="form-fields"><input type="checkbox" name="finish" checked></div></div>`;
  const data = await DialogV2.input({
    window: { title: "CORTEX.Assets.Hitches.Title" }, content,
    ok: { label: "CORTEX.Assets.Hitches.Activate", icon: "fa-solid fa-bolt" }
  });
  if ( !data || (typeof data !== "object") ) return false;
  const hitchIds = botch ? message.system.rolled.map(d => d.id) : open.filter(d => data[`die.${d.id}`]).map(d => d.id);
  if ( !hitchIds.length ) return false;
  let target;
  if ( data.target === "new" ) {
    const name = String(data.name ?? "").trim();
    if ( !name ) return notifyTraitStoreResult({ ok: false, code: "NAME_REQUIRED" });
    const holder = rollerKey && actorFromKey(rollerKey) ? { kind: "actor", actorId: rollerKey } : { kind: "unassigned" };
    target = { kind: "new", id: foundry.utils.randomID(16), name, holder };
  }
  else target = { kind: "existing", traitId: String(data.target) };
  return announce(await sendTraitStoreRequest("activateHitches", {
    messageId: message.id, allocations: [{ hitchIds, target }], finish: Boolean(data.finish)
  }));
}

/**
 * The GM finishes a roll's hitch choice without activating any (more); the roller's used d4
 * complications are removed (rule 18).
 * @param {ChatMessage} message
 * @returns {Promise<boolean>}
 */
export async function finishHitches(message) {
  return announce(await sendTraitStoreRequest("activateHitches", { messageId: message.id, allocations: [], finish: true }));
}

/**
 * A player uses some of the GM's hitches as opportunities on one temporary trait: down on a
 * complication, up on an asset for the scene, paid by one of their PCs.
 * @param {ChatMessage} message
 * @returns {Promise<boolean>}
 */
export async function openOpportunityDialog(message) {
  const i18n = game.i18n;
  const open = openHitches(message);
  const traits = getTraitStore().traits;
  const targets = traits.map(t => [t.id, `${i18n.localize(t.kind === "complication" ? "CORTEX.Assets.StepDown" : "CORTEX.Assets.StepUp")}: ${t.name} d${t.dice[0]}`]);
  if ( !targets.length ) return notifyTraitStoreResult({ ok: false, code: "NO_TARGETS" });
  const pcs = ownedPcs();
  const content = `
    <fieldset><legend>${i18n.localize("CORTEX.Assets.Opportunities.Dice")}</legend>${dieChecks(open)}</fieldset>
    <div class="form-group"><label>${i18n.localize("CORTEX.Assets.Opportunities.Target")}</label>
      <div class="form-fields"><select name="target">${options(targets)}</select></div></div>
    <div class="form-group"><label>${i18n.localize("CORTEX.Assets.Opportunities.Payer")}</label>
      <div class="form-fields"><select name="payer">${options(pcs.map(a => [a.uuid, a.name]), game.user.character?.uuid)}</select></div>
      <p class="hint">${i18n.localize("CORTEX.Assets.Opportunities.Cost")}</p></div>`;
  const data = await DialogV2.input({
    window: { title: "CORTEX.Assets.Opportunities.Title" }, content,
    ok: { label: "CORTEX.Assets.Opportunities.Use", icon: "fa-solid fa-hand-sparkles" }
  });
  if ( !data || (typeof data !== "object") ) return false;
  const opportunityIds = open.filter(d => data[`die.${d.id}`]).map(d => d.id);
  const trait = traits.find(t => t.id === data.target);
  if ( !opportunityIds.length || !trait ) return false;
  return announce(await sendTraitStoreRequest("useOpportunities", {
    messageId: message.id, actorKey: String(data.payer),
    uses: [{ opportunityIds, direction: trait.kind === "complication" ? "down" : "up", target: { kind: "temporary", traitId: trait.id } }]
  }));
}
