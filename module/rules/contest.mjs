/**
 * Contests between two sides: the exchange of rolls, giving in and declining (Tests & Contests
 * spec, rules 14-16). Every function here returns an EngineResult instead of throwing
 * (Decisions ADR-025). Who acts for each side and the revision number belong to the contest
 * message's data model, not to this engine (ADR-027).
 * @module rules/contest
 */

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
