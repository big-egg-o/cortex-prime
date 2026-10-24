/**
 * Contests between two sides: the exchange of rolls, giving in and declining (Tests & Contests
 * spec, rules 14-16), and what the result means for the loser (rules 17-21). Every function
 * here returns an EngineResult instead of throwing (Decisions ADR-025). Who acts for each side
 * and the revision number belong to the contest message's data model, not to this engine
 * (ADR-027).
 * @module rules/contest
 */

import { stepDie } from "./dice.mjs";
import { beats, heroicSteps, isValidTotal } from "./outcome.mjs";
import { fail, ok } from "./result.mjs";
import { DIE_SIZES } from "./types.mjs";

/** @type {readonly import("./types.mjs").ContestSide[]} */
const SIDES = Object.freeze(["initiator", "opposition"]);

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
 * A roll that already chose the overflow take-out (Dice & Pools rule 22) is refused: nothing
 * says yet what that take-out does during an exchange (RQ-018, proposed).
 * @param {import("./types.mjs").ContestState} state
 * @param {import("./types.mjs").ContestRoll} roll - `effects` and `overflow` may be left out,
 *   as for a typed total (ADR-021)
 * @returns {import("./types.mjs").EngineResult<import("./types.mjs").ContestState>} refuses,
 *   checked in this order: CONTEST_CLOSED, CONTEST_RESOLVED, INVALID_SIDE, INVALID_TOTAL,
 *   INVALID_DIE_SIZE, DUPLICATE_EFFECT_DIE, EFFECT_DIE_NOT_FOUND (an overflow naming a missing
 *   effect die), CONTEST_TAKE_OUT_IN_EXCHANGE, CONTEST_NOT_YOUR_TURN
 */
export function addContestRoll(state, roll) {
  if ( state.closed ) return fail("CONTEST_CLOSED");
  if ( state.status !== "open" ) return fail("CONTEST_RESOLVED");
  if ( !SIDES.includes(roll.side) ) return fail("INVALID_SIDE");
  if ( !isValidTotal(roll.total) ) return fail("INVALID_TOTAL");
  const effects = roll.effects ?? [];
  const problem = effectsProblem(effects);
  if ( problem ) return fail(problem);
  const overflow = roll.overflow ?? null;
  if ( overflow && !effects.some(e => e.id === overflow.effectId) ) return fail("EFFECT_DIE_NOT_FOUND");
  if ( overflow?.kind === "take-out" ) return fail("CONTEST_TAKE_OUT_IN_EXCHANGE");
  if ( roll.side !== state.turn ) return fail("CONTEST_NOT_YOUR_TURN");

  const entry = {
    side: roll.side,
    total: roll.total,
    effects: effects.map(({ id, size }) => ({ id, size })),
    overflow: overflow ? { effectId: overflow.effectId, kind: overflow.kind } : null,
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
 * Won by a failed roll: each effect die used against the loser is compared on its own with the
 * loser's largest effect die (rule 20, RQ-011 c), as it stands after any heroic steps (RQ-011 b).
 * An effect die whose overflow was answered with the take-out takes the loser out in any scene
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
 *   checked in this order: CONTEST_NOT_RESOLVED, DUPLICATE_EFFECT_DIE, EFFECT_DIE_NOT_FOUND,
 *   INVALID_DIE_SIZE (a stored effect die of a size that doesn't exist)
 */
export function contestConsequence(state, { usedAgainstLoser = [] } = {}) {
  if ( state.status === "open" ) return fail("CONTEST_NOT_RESOLVED");
  const { winnerRoll, loserRoll } = decidingRolls(state).value;
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

  const overflowTakeOut = winnerRoll.overflow?.kind === "take-out" ? winnerRoll.overflow.effectId : null;
  const loserSizes = loserRoll.effects.map(e => e.size);
  const loserDie = loserSizes.length > 0 ? Math.max(...loserSizes) : null;

  const comparisons = [];
  const avoidWithPP = [];
  for ( const effect of winnerEffects ) {
    if ( effect.id === overflowTakeOut ) {
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
  const byOverflow = avoidWithPP.some(a => a.effectId === overflowTakeOut);
  return ok({
    ...consequence,
    comparisons,
    takenOut,
    takeOutCause: byOverflow ? "overflow" : takenOut ? "comparison" : null,
    avoidWithPP: takenOut ? avoidWithPP : null
  });
}
