/**
 * Contests between two sides: the exchange of rolls, giving in and declining (Tests & Contests
 * spec, rules 14-16), what the result means for the loser (rules 17-21), and the heroic steps and
 * overflow choices made at the end (rule 21, ADR-028). Every function here returns an EngineResult
 * instead of throwing (Decisions ADR-025). Who acts for each side and the revision number belong
 * to the contest message's data model, not to this engine (ADR-027).
 * @module rules/contest
 */

import { stepDie } from "./dice.mjs";
import { applyHeroicSteps, beats, heroicSteps, isValidTotal } from "./outcome.mjs";
import { fail, ok } from "./result.mjs";
import { OVERFLOW_PENDING, applyOverflowChoice, leftoverEligible } from "./roll.mjs";
import { DIE_SIZES } from "./types.mjs";

/** @type {readonly import("./types.mjs").ContestSide[]} */
const SIDES = Object.freeze(["initiator", "opposition"]);

/** The options for an effect die past d12 (Dice & Pools rule 22). */
const OVERFLOW_KINDS = Object.freeze(["leftover", "new-d6", "take-out"]);

/**
 * @param {import("./types.mjs").ContestSide} side
 * @returns {import("./types.mjs").ContestSide}
 */
function otherSide(side) {
  return side === "initiator" ? "opposition" : "initiator";
}

/**
 * The code of the first problem with a roll's effect dice, or null: a size that isn't a die
 * size, or an effect id used twice.
 * @param {import("./types.mjs").ContestEffect[]} effects
 * @returns {string|null}
 */
function effectsProblem(effects) {
  if ( !Array.isArray(effects) || effects.some(e => !DIE_SIZES.includes(e?.size)) ) return "INVALID_DIE_SIZE";
  if ( new Set(effects.map(e => e.id)).size !== effects.length ) return "DUPLICATE_EFFECT_DIE";
  return null;
}

/**
 * One more than the highest effect number among ids of the form `e<n>`, or 1 with none: the next
 * effect number for a roll added without its pool roll's own (ADR-026, ADR-028). It can't know
 * about ids removed above the highest one, which is why contestRollFromResolution copies the pool
 * roll's number.
 * @param {import("./types.mjs").ContestEffect[]} effects
 * @returns {number}
 */
function nextEffectNumberAfter(effects) {
  const numbers = effects.map(e => /^e(\d+)$/.exec(e.id)).filter(m => m).map(m => Number(m[1]));
  return numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
}

/**
 * @param {import("./types.mjs").ContestOverflow} record
 * @returns {boolean} the record is still waiting for its choice
 */
function isOpen(record) {
  return record.kind == null;
}

/**
 * @param {import("./types.mjs").ContestRoll|null} roll
 * @returns {import("./types.mjs").ContestOverflow[]} the roll's overflow records; none without a roll
 */
function overflowsOf(roll) {
  return roll?.overflows ?? [];
}

/**
 * @param {import("./types.mjs").ContestRoll[]} rolls
 * @param {import("./types.mjs").ContestRoll} roll
 * @param {import("./types.mjs").ContestRoll} updated
 * @returns {import("./types.mjs").ContestRoll[]} a new list with `updated` in place of `roll`
 */
function replaceRoll(rolls, roll, updated) {
  return rolls.map(r => (r === roll ? updated : r));
}

/**
 * Whether the contest still waits for its heroic steps: won with steps earned and not yet applied,
 * and an effect die on the winner's last roll to take them. With no effect die the steps lapse
 * (ADR-028, RQ-025).
 * @param {import("./types.mjs").ContestState} state
 * @param {import("./types.mjs").ContestRoll|null} winnerRoll
 * @returns {boolean}
 */
function heroicPending(state, winnerRoll) {
  return state.status === "won" && state.heroicSteps > 0 && state.heroicAppliedTo == null
    && (winnerRoll?.effects ?? []).length > 0;
}

/**
 * The open overflow record a choice answers on the winner's last roll: the one named by
 * `effectId`, or the only open one when the id is left out (ADR-028, Step 4.3.4 test review).
 * @param {import("./types.mjs").ContestRoll|null} roll
 * @param {string|undefined} effectId
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").ContestOverflow>} refuses with
 *   EFFECT_DIE_NOT_FOUND (not an effect die of the roll), OVERFLOW_NOT_PENDING (no open record for
 *   it, or none at all) or INVALID_OVERFLOW_CHOICE (the id left out while several are open)
 */
function openOverflowFor(roll, effectId) {
  const open = overflowsOf(roll).filter(isOpen);
  if ( effectId == null ) {
    if ( open.length > 1 ) return fail("INVALID_OVERFLOW_CHOICE");
    return open.length === 1 ? ok(open[0]) : fail("OVERFLOW_NOT_PENDING");
  }
  if ( !(roll?.effects ?? []).some(e => e.id === effectId) ) return fail("EFFECT_DIE_NOT_FOUND");
  const record = open.find(o => o.effectId === effectId);
  return record ? ok(record) : fail("OVERFLOW_NOT_PENDING");
}

/**
 * A minimal Resolution and rolled-die list built from a contest roll, so the dice engine's
 * applyHeroicSteps and applyOverflowChoice act on the contest's own copy (ADR-027, ADR-028). The
 * dice list holds only the roll's stored leftovers, as available non-hitch dice, and the
 * Resolution has no total ids and no used-up dice, so the engine's leftover rule offers exactly
 * those leftovers. Only `open` becomes the pending overflow: the other open records stay on the
 * contest roll, so heroic steps aren't refused while one is open (ADR-028, Step 4.3.4
 * clarification).
 * @param {import("./types.mjs").ContestRoll|null} roll - null after a decline before any roll
 * @param {import("./types.mjs").ContestOverflow|null} open
 * @returns {{rolled: import("./types.mjs").RolledDie[], resolution: import("./types.mjs").Resolution}}
 */
function asPoolRoll(roll, open) {
  const leftovers = (roll?.leftovers ?? []).map(({ dieId, size }) => ({ dieId, size }));
  const rolled = /** @type {import("./types.mjs").RolledDie[]} */ (
    leftovers.map(({ dieId, size }) => ({ id: dieId, size, hitch: false, state: "available" }))
  );
  const options = open ? { cause: open.cause, leftovers, newDie: 6, takeOutAvailable: true } : null;
  const resolution = {
    total: roll?.total ?? 0,
    totalIds: [],
    effectDice: (roll?.effects ?? []).map(({ id, size }) => ({ id, kind: "rolled", size, dieId: null, isDefault: false })),
    consumedDieIds: [],
    nextEffectNumber: roll?.nextEffectNumber ?? 1,
    hitchIds: [],
    botch: false,
    takeOut: false,
    overflow: open ? { effectId: open.effectId, cause: open.cause, options } : null
  };
  return { rolled, resolution: /** @type {import("./types.mjs").Resolution} */ (resolution) };
}

/**
 * A new contest: open, nobody has rolled, and the initiator rolls first (rule 14). High stakes
 * is a GM flag, off unless asked for (ADR-022).
 * @param {{highStakes?: boolean}} [options]
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").ContestState>}
 */
export function createContest({ highStakes = false } = {}) {
  return ok({
    highStakes: highStakes === true,
    rolls: [],
    difficulty: null,
    turn: "initiator",
    status: "open",
    winner: null,
    hasRolled: { initiator: false, opposition: false },
    margin: null,
    heroicSteps: 0,
    heroicAppliedTo: null,
    closed: false
  });
}

/**
 * Adds the next roll of the exchange. The initiator's opening total is the first difficulty
 * (rule 14). A later roll that beats the difficulty becomes the new one and passes the turn
 * (rule 15); one that doesn't ends the contest with the other side as the winner. The margin is
 * the standing total minus the failed one, and gives heroic steps from 5 up (rules 10-11). A
 * tie doesn't beat the difficulty (rule 8); a botch's 0 is a total like any other (rule 9).
 *
 * An effect die past d12 keeps its choice open until the contest is decided (rule 21, RQ-018):
 * a roll whose overflow records are all open is added as it is, and one with a choice already
 * made is refused. The roll is stored as a copy; a roll without its pool roll's data, such as a
 * typed total (ADR-021), gets no leftovers and the next effect number after its highest effect id
 * (ADR-028, Step 4.3.4 test review).
 * @param {import("./types.mjs").ContestState} state
 * @param {import("./types.mjs").ContestRoll} roll - `effects`, `overflows`, `leftovers` and
 *   `nextEffectNumber` may be left out, as for a typed total
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").ContestState>} refuses,
 *   checked in this order: CONTEST_CLOSED, CONTEST_RESOLVED, INVALID_SIDE, INVALID_TOTAL,
 *   INVALID_DIE_SIZE, DUPLICATE_EFFECT_DIE, EFFECT_DIE_NOT_FOUND (an overflow naming a missing
 *   effect die), CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE, CONTEST_NOT_YOUR_TURN
 */
export function addContestRoll(state, roll) {
  if ( state.closed ) return fail("CONTEST_CLOSED");
  if ( state.status !== "open" ) return fail("CONTEST_RESOLVED");
  if ( !SIDES.includes(roll.side) ) return fail("INVALID_SIDE");
  if ( !isValidTotal(roll.total) ) return fail("INVALID_TOTAL");
  const effects = roll.effects ?? [];
  const problem = effectsProblem(effects);
  if ( problem ) return fail(problem);
  const overflows = roll.overflows ?? [];
  if ( !overflows.every(o => effects.some(e => e.id === o?.effectId)) ) return fail("EFFECT_DIE_NOT_FOUND");
  if ( !overflows.every(isOpen) ) return fail("CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE");
  if ( roll.side !== state.turn ) return fail("CONTEST_NOT_YOUR_TURN");

  const entry = {
    side: roll.side,
    total: roll.total,
    effects: effects.map(({ id, size }) => ({ id, size })),
    overflows: overflows.map(({ effectId, cause }) => ({ effectId, cause: cause ?? "other", kind: null, dieId: null })),
    leftovers: (roll.leftovers ?? []).map(({ dieId, size }) => ({ dieId, size })),
    nextEffectNumber: roll.nextEffectNumber ?? nextEffectNumberAfter(effects),
    messageRef: roll.messageRef ?? null
  };
  const rolls = [...state.rolls, entry];
  const hasRolled = { ...state.hasRolled, [roll.side]: true };

  if ( state.difficulty === null || beats(roll.total, state.difficulty).value ) {
    return ok({ ...state, rolls, hasRolled, difficulty: roll.total, turn: otherSide(roll.side) });
  }

  const margin = state.difficulty - roll.total;
  return ok({
    ...state, rolls, hasRolled, turn: null, status: "won", winner: otherSide(roll.side),
    margin, heroicSteps: heroicSteps(margin).value
  });
}

/**
 * Gives in for a side, so the other side wins with no margin and no heroic steps (rule 16,
 * ADR-023). Only the side whose turn it is may give in. The opposition giving in before its
 * first roll is a decline instead, whether or not the initiator has rolled yet (rules 2 and 14,
 * TC-E02, RQ-014). The initiator can't give in before its first roll.
 * @param {import("./types.mjs").ContestState} state
 * @param {import("./types.mjs").ContestSide} side
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").ContestState>} status
 *   "gaveIn" or "declined"; refuses, checked in this order: CONTEST_CLOSED, CONTEST_RESOLVED,
 *   INVALID_SIDE, CONTEST_NOT_STARTED, CONTEST_NOT_YOUR_TURN
 */
export function giveIn(state, side) {
  if ( state.closed ) return fail("CONTEST_CLOSED");
  if ( state.status !== "open" ) return fail("CONTEST_RESOLVED");
  if ( !SIDES.includes(side) ) return fail("INVALID_SIDE");
  if ( side === "opposition" && !state.hasRolled.opposition ) {
    return ok({ ...state, turn: null, status: "declined", winner: "initiator" });
  }
  if ( state.rolls.length === 0 ) return fail("CONTEST_NOT_STARTED");
  if ( side !== state.turn ) return fail("CONTEST_NOT_YOUR_TURN");
  return ok({ ...state, turn: null, status: "gaveIn", winner: otherSide(side) });
}

/**
 * Closes a contest: every later action is refused (ADR-027). Closing is allowed before the
 * contest has a winner, so a GM can end an exchange that was abandoned.
 * @param {import("./types.mjs").ContestState} state
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").ContestState>}
 *   CONTEST_CLOSED if it is closed already
 */
export function closeContest(state) {
  if ( state.closed ) return fail("CONTEST_CLOSED");
  return ok({ ...state, closed: true });
}

/**
 * The rolls that decide a finished contest (rule 17): the winner's last roll, which set the
 * total nobody beat, and the loser's roll that just failed. After giving in or declining no roll
 * failed, so `loserRoll` is null; `winnerRoll` is null when the opposition declined before the
 * initiator rolled. The returned rolls are the state's own entries.
 * @param {import("./types.mjs").ContestState} state
 * @returns {import("./types.mjs").EngineResult<{winnerRoll: import("./types.mjs").ContestRoll|null,
 *   loserRoll: import("./types.mjs").ContestRoll|null}>} CONTEST_NOT_RESOLVED while open
 */
export function decidingRolls(state) {
  if ( state.status === "open" ) return fail("CONTEST_NOT_RESOLVED");
  const winnerRoll = state.rolls.findLast(r => r.side === state.winner) ?? null;
  const loserRoll = state.status === "won" ? state.rolls.at(-1) : null;
  return ok({ winnerRoll, loserRoll });
}

/**
 * Compares one of the winner's effect dice with the loser's (rules 18-19). Normal scene: a
 * loser's die equal to or larger than the winner's steps the winner's down by one first (RQ-010
 * a), and a d4 stepped down goes away, leaving no complication (RQ-009); otherwise the
 * complication is the winner's die. High stakes: nothing is stepped down; a winner's die larger
 * than the loser's takes the loser out, otherwise the complication is the winner's die (RQ-010
 * b). With no loser's die (`null`), nothing limits the winner: no step-down, and in high stakes
 * the loser is taken out (RQ-015). When `takesOut` is true, `complication` is what the loser
 * takes instead after paying a PP to stay in (rule 19; the spend belongs to Plot Points, M4).
 * @param {import("./types.mjs").DieSize} winnerDie
 * @param {import("./types.mjs").DieSize|null} loserDie - null when the loser has no effect die
 * @param {boolean} highStakes
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").DieComparison>}
 *   INVALID_DIE_SIZE unless `winnerDie` is a die size and `loserDie` a die size or null
 */
export function compareEffectDie(winnerDie, loserDie, highStakes) {
  if ( !DIE_SIZES.includes(winnerDie) ) return fail("INVALID_DIE_SIZE");
  if ( loserDie !== null && !DIE_SIZES.includes(loserDie) ) return fail("INVALID_DIE_SIZE");

  const limited = loserDie !== null && loserDie >= winnerDie;
  const full = { winnerDie, loserDie, steppedDown: false, complication: winnerDie };
  if ( highStakes === true ) return ok({ ...full, takesOut: !limited });
  if ( !limited ) return ok({ ...full, takesOut: false });

  const stepped = stepDie(winnerDie, -1);
  return ok({ ...full, steppedDown: true, complication: stepped.removed ? null : stepped.size, takesOut: false });
}

/**
 * What a finished contest means for the loser (rules 16-21). Everything comes from the contest
 * state, read from the contest's own copy of the deciding rolls (ADR-027), except which of the
 * winner's effect dice are used against the loser.
 *
 * Nothing is answered while the end-of-contest choices are still to be made (ADR-028): heroic
 * steps earned but not applied, unless the winner's last roll has no effect die to take them
 * (RQ-025), and then any open overflow record on that roll, whatever the ending (RQ-018, RQ-024).
 * Open records on any other roll have lapsed and are ignored (RQ-018).
 *
 * Won by a failed roll: each effect die used against the loser is compared on its own with the
 * loser's largest effect die (rule 20, RQ-011 c), as it stands after any heroic steps (RQ-011 b).
 * Each effect die whose overflow was answered with the take-out takes the loser out in any scene
 * without a comparison, whether or not it is listed, and a PP would turn it into a d12
 * complication (rule 21, RQ-013, RQ-016). One PP avoids every take-out (RQ-017): `avoidWithPP`
 * lists the complication each take-out turns into; the other comparisons' complications stand
 * either way. `takeOutCause` is "overflow" whenever an overflow take-out is among them.
 *
 * Given in or declined: nothing is compared and nobody is taken out, and `usedAgainstLoser` is
 * only checked (rules 2, 16, RQ-014). `winnerEffects` still reports the winner's effect dice,
 * empty when the opposition declined before the initiator rolled; the UI then takes the largest
 * die of the initiator's pool (Dice & Pools rule 24). A side that gave in after rolling is
 * eligible for a PP, and an initiator who gave in can't start a new contest against the same
 * opponent straight away (rule 16).
 *
 * Each complication is reported as a size; whether it becomes a new complication or steps up one
 * the loser has belongs to Assets & Complications (M4).
 * @param {import("./types.mjs").ContestState} state
 * @param {{usedAgainstLoser?: string[]}} [input] - effect ids of the winner's last roll
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").Consequence>} refuses,
 *   checked in this order: CONTEST_NOT_RESOLVED, HEROIC_PENDING, OVERFLOW_PENDING,
 *   DUPLICATE_EFFECT_DIE, EFFECT_DIE_NOT_FOUND, INVALID_DIE_SIZE (a stored effect die of a size
 *   that doesn't exist)
 */
export function contestConsequence(state, { usedAgainstLoser = [] } = {}) {
  if ( state.status === "open" ) return fail("CONTEST_NOT_RESOLVED");
  const { winnerRoll, loserRoll } = decidingRolls(state).value;
  if ( heroicPending(state, winnerRoll) ) return fail("HEROIC_PENDING");
  if ( overflowsOf(winnerRoll).some(isOpen) ) return fail(OVERFLOW_PENDING);
  const winnerEffects = (winnerRoll?.effects ?? []).map(({ id, size }) => ({ id, size }));
  if ( new Set(usedAgainstLoser).size !== usedAgainstLoser.length ) return fail("DUPLICATE_EFFECT_DIE");
  if ( !usedAgainstLoser.every(id => winnerEffects.some(e => e.id === id)) ) return fail("EFFECT_DIE_NOT_FOUND");

  const loser = otherSide(state.winner);
  const consequence = {
    winner: state.winner,
    loser,
    ending: state.status,
    margin: state.margin,
    heroicSteps: state.heroicSteps,
    winnerEffects,
    comparisons: [],
    takenOut: false,
    takeOutCause: null,
    avoidWithPP: null,
    ppEligible: state.status === "gaveIn" && state.hasRolled[loser],
    rematchBlocked: state.status === "gaveIn" && loser === "initiator"
  };
  if ( state.status !== "won" ) return ok(consequence);

  const takeOutIds = new Set(overflowsOf(winnerRoll).filter(o => o.kind === "take-out").map(o => o.effectId));
  const loserSizes = loserRoll.effects.map(e => e.size);
  const loserDie = loserSizes.length > 0 ? Math.max(...loserSizes) : null;

  const comparisons = [];
  const avoidWithPP = [];
  for ( const effect of winnerEffects ) {
    if ( takeOutIds.has(effect.id) ) {
      avoidWithPP.push({ effectId: effect.id, size: 12 });
      continue;
    }
    if ( !usedAgainstLoser.includes(effect.id) ) continue;
    const compared = compareEffectDie(effect.size, loserDie, state.highStakes);
    if ( !compared.ok ) return compared;
    comparisons.push({ effectId: effect.id, ...compared.value });
    if ( compared.value.takesOut ) avoidWithPP.push({ effectId: effect.id, size: compared.value.complication });
  }

  const takenOut = avoidWithPP.length > 0;
  const byOverflow = avoidWithPP.some(a => takeOutIds.has(a.effectId));
  return ok({
    ...consequence,
    comparisons,
    takenOut,
    takeOutCause: byOverflow ? "overflow" : takenOut ? "comparison" : null,
    avoidWithPP: takenOut ? avoidWithPP : null
  });
}

/**
 * The contest roll for a confirmed pool roll (ADR-028, Step 4.3.4): its total and effect dice,
 * its pending overflow as an open record, a copy of its eligible leftover dice (Dice & Pools
 * rule 22) and its own next effect number (ADR-026), so the contest needn't read the poolRoll
 * message again (ADR-020, ADR-027).
 *
 * A pool roll whose overflow was already answered on its own card is refused, as addContestRoll
 * refuses a choice made before the end (rule 21, RQ-018): the Resolution shows a take-out, or an
 * effect die of kind "overflow" (a new d6). A leftover taken on the card can't be told apart from
 * an extra effect die in the Resolution, so the card mustn't offer the choice while its roll
 * belongs to an open contest (ADR-028, Step 4.3.4 implementation review).
 * @param {import("./types.mjs").ContestSide} side
 * @param {import("./types.mjs").RolledDie[]} rolled
 * @param {import("./types.mjs").Resolution} resolution
 * @param {string|null} messageRef
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").ContestRoll>}
 *   CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE for an overflow already answered on the card; the rest of
 *   the roll is checked by addContestRoll
 */
export function contestRollFromResolution(side, rolled, resolution, messageRef) {
  const answeredOnCard = resolution.takeOut === true || resolution.effectDice.some(e => e.kind === "overflow");
  if ( answeredOnCard ) return fail("CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE");
  const pending = resolution.overflow;
  return ok({
    side,
    total: resolution.total,
    effects: resolution.effectDice.map(({ id, size }) => ({ id, size })),
    overflows: pending ? [{ effectId: pending.effectId, cause: pending.cause, kind: null, dieId: null }] : [],
    leftovers: leftoverEligible(rolled, resolution).map(({ dieId, size }) => ({ dieId, size })),
    nextEffectNumber: resolution.nextEffectNumber,
    messageRef: messageRef ?? null
  });
}

/**
 * Puts all the heroic steps on the effect die the roller picks on the winner's last roll (rules
 * 11-12, RQ-011 a, ADR-023, ADR-028), through applyHeroicSteps. Steps on a die whose overflow is
 * still open join it: the die stays d12 and keeps its record, which gets one choice (RQ-023).
 * Otherwise steps past d12 open a new record with the cause "heroic", after the roll's others.
 * Steps on another die are allowed while a record is open (ADR-028, Step 4.3.4 clarification).
 * @param {import("./types.mjs").ContestState} state
 * @param {string} effectId - an effect die of the winner's last roll (ADR-026)
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").ContestState>} the roll's
 *   `effects` and `overflows` updated and `heroicAppliedTo` set; refuses, checked in this order:
 *   CONTEST_CLOSED, CONTEST_NOT_RESOLVED, HEROIC_NOT_EARNED (giving in, declining, a margin under
 *   5), HEROIC_ALREADY_APPLIED, EFFECT_DIE_NOT_FOUND (including a roll with no effect die, RQ-025)
 */
export function applyContestHeroicSteps(state, effectId) {
  if ( state.closed ) return fail("CONTEST_CLOSED");
  if ( state.status === "open" ) return fail("CONTEST_NOT_RESOLVED");
  const { winnerRoll } = decidingRolls(state).value;
  const { rolled, resolution } = asPoolRoll(winnerRoll, null);
  const stepped = applyHeroicSteps(rolled, resolution, state, effectId);
  if ( !stepped.ok ) return stepped;

  const joinsOpen = overflowsOf(winnerRoll).some(o => o.effectId === effectId && isOpen(o));
  const signal = stepped.value.resolution.overflow;
  const updated = joinsOpen ? winnerRoll : {
    ...winnerRoll,
    effects: stepped.value.resolution.effectDice.map(({ id, size }) => ({ id, size })),
    overflows: signal
      ? [...winnerRoll.overflows, { effectId: signal.effectId, cause: signal.cause, kind: null, dieId: null }]
      : winnerRoll.overflows
  };
  return ok({ ...stepped.value.heroic, rolls: replaceRoll(state.rolls, winnerRoll, updated) });
}

/**
 * Records the choice for an open overflow on the winner's last roll (rules 12, 21, RQ-018,
 * ADR-028), through applyOverflowChoice: an eligible leftover or a new d6 as a further effect
 * die, with the id `e<nextEffectNumber>` (ADR-026), or the take-out. The overflowing die stays a
 * d12, and a leftover that is taken leaves the roll's leftovers. After giving in or declining
 * only a further effect die can be chosen (RQ-024). Heroic steps come first (RQ-023).
 * @param {import("./types.mjs").ContestState} state
 * @param {import("./types.mjs").ContestOverflowChoice} choice
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").ContestState>} the roll's
 *   `effects`, `overflows`, `leftovers` and `nextEffectNumber` updated; refuses, checked in this
 *   order: CONTEST_CLOSED, CONTEST_NOT_RESOLVED, HEROIC_PENDING, then for the record
 *   EFFECT_DIE_NOT_FOUND, OVERFLOW_NOT_PENDING or INVALID_OVERFLOW_CHOICE (no effect id while
 *   several are open), then INVALID_OVERFLOW_CHOICE for the option (an unknown kind, a leftover
 *   that wasn't offered, or the take-out after giving in or declining)
 */
export function chooseContestOverflow(state, choice) {
  if ( state.closed ) return fail("CONTEST_CLOSED");
  if ( state.status === "open" ) return fail("CONTEST_NOT_RESOLVED");
  const { winnerRoll } = decidingRolls(state).value;
  if ( heroicPending(state, winnerRoll) ) return fail("HEROIC_PENDING");
  const { effectId, kind, dieId } = choice ?? {};
  const found = openOverflowFor(winnerRoll, effectId);
  if ( !found.ok ) return found;
  const record = found.value;
  if ( !OVERFLOW_KINDS.includes(kind) ) return fail("INVALID_OVERFLOW_CHOICE");
  if ( kind === "leftover" && !winnerRoll.leftovers.some(l => l.dieId === dieId) ) return fail("INVALID_OVERFLOW_CHOICE");
  if ( kind === "take-out" && state.status !== "won" ) return fail("INVALID_OVERFLOW_CHOICE");

  const { rolled, resolution } = asPoolRoll(winnerRoll, record);
  const answered = applyOverflowChoice(rolled, resolution, kind === "leftover" ? { kind, dieId } : { kind });
  const takenDieId = kind === "leftover" ? dieId : null;
  const updated = {
    ...winnerRoll,
    effects: answered.effectDice.map(({ id, size }) => ({ id, size })),
    overflows: winnerRoll.overflows.map(o => (o === record ? { ...o, kind, dieId: takenDieId } : o)),
    leftovers: takenDieId === null ? winnerRoll.leftovers : winnerRoll.leftovers.filter(l => l.dieId !== takenDieId),
    nextEffectNumber: answered.nextEffectNumber
  };
  return ok({ ...state, rolls: replaceRoll(state.rolls, winnerRoll, updated) });
}
