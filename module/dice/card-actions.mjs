/**
 * Interactions on a poolRoll chat card: picking total/effect dice and confirming the
 * selection (Decisions ADR-013, ADR-014; Dice & Pools rules 12-23). Each action is a plain
 * function of (message, change) so the click handler in module/dice/pool-roll-card.mjs and
 * Quench call the exact same code path.
 * @module dice/card-actions
 */

import { largestEligible, resolve, twoHighest, validateSelection } from "../rules/index.mjs";

/**
 * @typedef {Object} CardChange
 * @property {'cycle-die'|'two-highest'|'biggest-effect'|'increment-extra-results'|
 *   'decrement-extra-results'|'increment-extra-effect-dice'|'decrement-extra-effect-dice'|
 *   'confirm'} action
 * @property {string} [dieId] - required for 'cycle-die'
 */

/**
 * Whether `user` may change a poolRoll card: the same rule the server enforces on
 * `message.update()` (ADR-013) — the message's author as OWNER, or a GM, under the
 * ChatMessage document's default "update" permission.
 * @param {ChatMessage} message
 * @param {User} [user=game.user]
 * @returns {boolean}
 */
export function canEditPoolRollCard(message, user = game.user) {
  return message.canUserModify(user, "update");
}

/**
 * The die's current role in a selection, used to decide what a click cycles it to.
 * @param {import("../rules/types.mjs").Selection} selection
 * @param {string} dieId
 * @returns {'total'|'effect'|'unused'}
 */
function roleOf(selection, dieId) {
  if ( selection.totalIds.includes(dieId) ) return "total";
  if ( selection.effectDieIds.includes(dieId) ) return "effect";
  return "unused";
}

/**
 * Cycles one die unused -> total -> effect -> unused. Refuses (returns null, nothing stored)
 * a hitch or a die that isn't available (rules 10, 19): the only clicks that are refused
 * outright rather than merely left for validateSelection to flag.
 * @param {import("../rules/types.mjs").RolledDie[]} rolled
 * @param {import("../rules/types.mjs").Selection} selection
 * @param {string} dieId
 * @returns {import("../rules/types.mjs").Selection|null}
 */
function cycleDie(rolled, selection, dieId) {
  const die = rolled.find(d => d.id === dieId);
  if ( !die || die.hitch || (die.state !== "available") ) return null;

  const nextRole = { unused: "total", total: "effect", effect: "unused" }[roleOf(selection, dieId)];

  const totalIds = selection.totalIds.filter(id => id !== dieId);
  const effectDieIds = selection.effectDieIds.filter(id => id !== dieId);
  if ( nextRole === "total" ) totalIds.push(dieId);
  if ( nextRole === "effect" ) effectDieIds.push(dieId);

  return { ...selection, totalIds, effectDieIds };
}

/**
 * Fills every effect-die slot (1 + extraEffectDicePaid), each with the next largest eligible
 * die not already used by an earlier slot or by `excludeIds`; a slot with nothing eligible
 * left stays empty, defaulted to a d4 by resolve() (rule 20, rule 21, DP-22).
 * @param {import("../rules/types.mjs").RolledDie[]} rolled
 * @param {import("../rules/types.mjs").Selection} selection
 * @param {string[]} excludeIds
 * @returns {string[]}
 */
function fillEffectSlots(rolled, selection, excludeIds) {
  const effectSlots = 1 + selection.extraEffectDicePaid;
  const effectDieIds = [];
  for ( let i = 0; i < effectSlots; i++ ) {
    const next = largestEligible(rolled, [...excludeIds, ...effectDieIds]);
    if ( next === null ) break;
    effectDieIds.push(next);
  }
  return effectDieIds;
}

/**
 * The GM's shortcut (rule 12, DP-13, DP-19, DP-21): the highest results for the total, then
 * the largest eligible die for each effect slot.
 * @param {import("../rules/types.mjs").RolledDie[]} rolled
 * @param {import("../rules/types.mjs").Selection} selection
 * @returns {import("../rules/types.mjs").Selection}
 */
function applyTwoHighest(rolled, selection) {
  const totalIds = twoHighest(rolled, selection.keepLimit + selection.extraResultsPaid);
  const effectDieIds = fillEffectSlots(rolled, selection, totalIds);
  return { ...selection, totalIds, effectDieIds };
}

/**
 * The "biggest effect" shortcut (rule 18, DP-22): the largest eligible die(s) go to the
 * effect slots first, then the highest results among what's left form the total.
 * @param {import("../rules/types.mjs").RolledDie[]} rolled
 * @param {import("../rules/types.mjs").Selection} selection
 * @returns {import("../rules/types.mjs").Selection}
 */
function applyBiggestEffect(rolled, selection) {
  const effectDieIds = fillEffectSlots(rolled, selection, []);
  const remaining = rolled.filter(d => !effectDieIds.includes(d.id));
  const totalIds = twoHighest(remaining, selection.keepLimit + selection.extraResultsPaid);
  return { ...selection, totalIds, effectDieIds };
}

/**
 * Computes the next Selection for every action except "confirm", or null to refuse the
 * change (nothing stored).
 * @param {import("../data/chat/pool-roll.mjs").default} system
 * @param {CardChange} change
 * @returns {import("../rules/types.mjs").Selection|null}
 */
function nextSelection(system, change) {
  const { rolled, selection } = system;
  switch ( change.action ) {
    case "cycle-die": return cycleDie(rolled, selection, change.dieId);
    case "two-highest": return applyTwoHighest(rolled, selection);
    case "biggest-effect": return applyBiggestEffect(rolled, selection);
    case "increment-extra-results":
      return { ...selection, extraResultsPaid: selection.extraResultsPaid + 1 };
    case "decrement-extra-results":
      return { ...selection, extraResultsPaid: Math.max(0, selection.extraResultsPaid - 1) };
    case "increment-extra-effect-dice":
      return { ...selection, extraEffectDicePaid: selection.extraEffectDicePaid + 1 };
    case "decrement-extra-effect-dice":
      return { ...selection, extraEffectDicePaid: Math.max(0, selection.extraEffectDicePaid - 1) };
    default:
      throw new Error(`card-actions: unknown action "${change.action}"`);
  }
}

/**
 * Confirms the current selection: refuses (nothing stored) unless validateSelection accepts
 * it, otherwise resolves it and sets state "resolved" (ADR-013). A botch's selection is
 * always empty and always valid, so confirming one just records the DP-09 total-0/default-d4
 * Resolution.
 * @param {ChatMessage} message
 * @param {import("../data/chat/pool-roll.mjs").default} system
 * @returns {Promise<void>}
 */
async function confirm(message, system) {
  const { valid } = validateSelection(system.rolled, system.selection);
  if ( !valid ) return;
  const resolution = resolve(system.rolled, system.selection);
  await message.update({ "system.resolution": resolution, "system.state": "resolved" });
}

/**
 * Applies one card interaction to a poolRoll message (ADR-013). Refuses outright — no
 * `message.update()` call — when the current user may not edit the card, when a die click
 * targets a hitch or an unavailable die, or when "confirm" is attempted on an invalid
 * selection. Every other change is stored even while incomplete, so other viewers see picks
 * live as they're made.
 * @param {ChatMessage} message
 * @param {CardChange} change
 * @returns {Promise<void>}
 */
export async function applyCardChange(message, change) {
  if ( !canEditPoolRollCard(message) ) return;

  if ( change.action === "confirm" ) return confirm(message, message.system);

  const selection = nextSelection(message.system, change);
  if ( !selection ) return;
  await message.update({ "system.selection": selection });
}
