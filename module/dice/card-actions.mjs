/**
 * Interactions on a poolRoll chat card: picking total/effect dice and confirming the
 * selection (Decisions ADR-013, ADR-014; Dice & Pools rules 12-23). Each action is a plain
 * function of (message, change) so the click handler in module/dice/pool-roll-card.mjs and
 * Quench call the exact same code path.
 * @module dice/card-actions
 */

import {
  applyOverflowChoice, applyRerolls, largestEligible, rerollableIds, resolve, stepEffectDie,
  twoHighest, validateSelection
} from "../rules/index.mjs";
import { rerollDice } from "./roll-pool.mjs";

/**
 * @typedef {Object} CardChange
 * @property {'cycle-die'|'two-highest'|'biggest-effect'|'increment-extra-results'|
 *   'decrement-extra-results'|'increment-extra-effect-dice'|'decrement-extra-effect-dice'|
 *   'confirm'|'step-effect-die'|'overflow-choice'|'reroll'} action
 * @property {string} [dieId] - required for 'cycle-die', and for 'overflow-choice' with kind
 *   "leftover"
 * @property {string|number} [effectIndex] - required for 'step-effect-die'
 * @property {string|number} [steps] - required for 'step-effect-die'; must be 1 or -1
 * @property {string} [kind] - required for 'overflow-choice'; one of 'leftover'|'new-d6'|
 *   'take-out'
 * @property {string[]} [dieIds] - required for 'reroll'
 * @property {Record<string, number>} [results] - 'reroll', dev/test only: skip Foundry's dice
 *   and use these results directly, the same way postPoolRoll's `results` param does
 */

/**
 * Rule 23 says an effect die can be stepped up or down, but — unlike a pool die (rule 3) —
 * never says what happens to one stepped below d4. Flagged as RQ-009 (open) rather than
 * guessed: the step-down control is hidden at d4, and this is the code a direct call (e.g.
 * Quench) sees if it tries anyway.
 */
export const EFFECT_DIE_D4_STEP_DOWN = "EFFECT_DIE_D4_STEP_DOWN";

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
 * Validates a "step-effect-die" change's own shape: steps must be exactly 1 or -1, and
 * effectIndex a whole number naming a slot that actually exists in the current Resolution.
 * Returns null to refuse silently on anything else — a card-actions-level guard independent
 * of whatever the UI does or doesn't render.
 * @param {import("../data/chat/pool-roll.mjs").default} system
 * @param {CardChange} change
 * @returns {{effectIndex: number, steps: number}|null}
 */
function parseStepEffectDieChange(system, change) {
  const steps = Number(change.steps);
  if ( (steps !== 1) && (steps !== -1) ) return null;
  const effectIndex = Number(change.effectIndex);
  if ( !Number.isInteger(effectIndex) || !system.resolution.effectDice[effectIndex] ) return null;
  return { effectIndex, steps };
}

/**
 * Steps one effect die on a resolved card (rule 23). Cause is always "other" for now — the
 * same options rule 22 offers either way, but the heroic-success label comes with Tests &
 * Contests. Refuses silently while a previous overflow is still pending or on a malformed
 * change; refuses a step down from d4 by throwing EFFECT_DIE_D4_STEP_DOWN (RQ-009) instead,
 * since that's an open rules question rather than an ordinary invalid click.
 * @param {ChatMessage} message
 * @param {CardChange} change
 * @returns {Promise<void>}
 * @throws {Error} EFFECT_DIE_D4_STEP_DOWN, on a step down from a d4 effect die
 */
async function stepEffectDieChange(message, change) {
  const system = message.system;
  if ( (system.state !== "resolved") || system.resolution.overflow ) return;

  const parsed = parseStepEffectDieChange(system, change);
  if ( !parsed ) return;
  const { effectIndex, steps } = parsed;

  if ( (steps === -1) && (system.resolution.effectDice[effectIndex].size === 4) ) {
    throw new Error(EFFECT_DIE_D4_STEP_DOWN);
  }

  const resolution = stepEffectDie(system.rolled, system.resolution, effectIndex, steps, "other");
  await message.update({ "system.resolution": resolution });
}

/**
 * Validates an "overflow-choice" change's own shape: kind must be one of the three options
 * rule 22 allows, and a "leftover" dieId must be one of the pending overflow's own offered
 * leftovers — never a die the engine didn't offer. Returns null to refuse silently on
 * anything else.
 * @param {import("../data/chat/pool-roll.mjs").default} system
 * @param {CardChange} change
 * @returns {import("../rules/types.mjs").OverflowChoice|null}
 */
function parseOverflowChoice(system, change) {
  if ( !["leftover", "new-d6", "take-out"].includes(change.kind) ) return null;
  if ( change.kind !== "leftover" ) return { kind: change.kind };
  const offered = system.resolution.overflow.options.leftovers.some(l => l.dieId === change.dieId);
  return offered ? { kind: "leftover", dieId: change.dieId } : null;
}

/**
 * Applies one of the options from a pending overflow (rule 22). Refuses silently when there's
 * no overflow pending or the change is malformed.
 * @param {ChatMessage} message
 * @param {CardChange} change
 * @returns {Promise<void>}
 */
async function overflowChoiceChange(message, change) {
  const system = message.system;
  if ( (system.state !== "resolved") || !system.resolution.overflow ) return;

  const choice = parseOverflowChoice(system, change);
  if ( !choice ) return;

  const resolution = applyOverflowChoice(system.rolled, system.resolution, choice);
  await message.update({ "system.resolution": resolution });
}

/**
 * Validates a "reroll" change's own shape: there must be at least one id, and every id must
 * be one rerollableIds offers (rule 26, DP-28) — a hitch not yet activated is fine, an
 * activated one or an unknown id isn't. Returns null to refuse silently otherwise.
 * @param {import("../data/chat/pool-roll.mjs").default} system
 * @param {CardChange} change
 * @returns {string[]|null}
 */
function parseRerollChange(system, change) {
  const dieIds = Array.isArray(change.dieIds) ? change.dieIds : [];
  if ( dieIds.length === 0 ) return null;
  const rerollable = new Set(rerollableIds(system.rolled));
  return dieIds.every(id => rerollable.has(id)) ? dieIds : null;
}

/**
 * Rerolls the given dice before confirming (Decisions ADR-017: rerolls only happen while
 * state is "rolled", are free in M3, and clear the selection since the results it referred to
 * changed). Appends the new Roll to message.rolls, the same way postPoolRoll's own Roll is
 * stored. Refuses silently once resolved, or on a malformed change.
 * @param {ChatMessage} message
 * @param {CardChange} change
 * @returns {Promise<void>}
 */
async function rerollChange(message, change) {
  const system = message.system;
  if ( system.state !== "rolled" ) return;

  const dieIds = parseRerollChange(system, change);
  if ( !dieIds ) return;

  let roll = null;
  let results = change.results;
  if ( !results ) {
    const rerolled = await rerollDice(system.rolled, dieIds);
    roll = rerolled.roll;
    results = rerolled.results;
  }

  const rolled = applyRerolls(system.rolled, results);
  const updateData = {
    "system.rolled": rolled,
    "system.selection": { ...system.selection, totalIds: [], effectDieIds: [] }
  };
  if ( roll ) updateData.rolls = [...message.rolls, roll];
  await message.update(updateData);
}

/**
 * Applies one card interaction to a poolRoll message (ADR-013). Refuses outright — no
 * `message.update()` call — when the current user may not edit the card, when a die click
 * targets a hitch or an unavailable die, when "confirm" is attempted on an invalid selection,
 * when a step/overflow/reroll change doesn't name a real slot, step, offered option or
 * rerollable id, or when a reroll or step/overflow change is attempted in the wrong state.
 * Every selection change is stored even while incomplete, so other viewers see picks live as
 * they're made; see stepEffectDieChange for the one change that's refused by throwing instead
 * of silently, because it's an open rules question (RQ-009) rather than an ordinary mistake.
 * @param {ChatMessage} message
 * @param {CardChange} change
 * @returns {Promise<void>}
 */
export async function applyCardChange(message, change) {
  if ( !canEditPoolRollCard(message) ) return;

  if ( change.action === "confirm" ) return confirm(message, message.system);
  if ( change.action === "step-effect-die" ) return stepEffectDieChange(message, change);
  if ( change.action === "overflow-choice" ) return overflowChoiceChange(message, change);
  if ( change.action === "reroll" ) return rerollChange(message, change);

  const selection = nextSelection(message.system, change);
  if ( !selection ) return;
  await message.update({ "system.selection": selection });
}
