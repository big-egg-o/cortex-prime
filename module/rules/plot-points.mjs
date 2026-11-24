/**
 * Plot point bookkeeping (Plot Points spec, revised draft; Rules Questions RQ-013, RQ-019,
 * RQ-035 to RQ-044; Decisions ADR-056, which accepts the spec's P1 to P15). The engine works out
 * every cost and gain of a pool, a roll, a contest and a test; paying them is the caller's
 * separate Settle action (P4, P11). Only what would leave the books wrong is refused (P5).
 *
 * Every function returns an EngineResult (ADR-025), stops at the first failing check in the order
 * its JSDoc gives, never changes its inputs and returns no object shared with them.
 * @module rules/plot-points
 */

import { AC_PP_REASONS } from "./assets.mjs";
import { fail, ok } from "./result.mjs";
import { DIE_SIZES } from "./types.mjs";
import { CONTEST_SIDES } from "./contest.mjs";

/**
 * Every reason a balance can change, mapped to its direction. Other specs (Assets & Complications)
 * add their own reasons; HITCH_COMPLICATION is here because the timing rule depends on it.
 * @type {Readonly<Record<string, "gain"|"spend"|"adjust">>}
 */
export const PP_REASONS = Object.freeze({
  HINDER: "gain",
  D4_COMPLICATION: "gain",
  SFX_GAIN: "gain",
  HITCH_COMPLICATION: "gain",
  GIVE_IN: "gain",
  AWARD: "gain",
  SESSION_START: "gain",
  EXTRA_TRAIT: "spend",
  EXTRA_RESULT: "spend",
  EXTRA_EFFECT_DIE: "spend",
  SFX_SPEND: "spend",
  STAY_IN: "spend",
  GM_ADJUST: "adjust",
  ...AC_PP_REASONS
});

/** The reasons a roll's lines may carry: the pool, the roll card, and gains other specs add (P10). */
export const ROLL_REASONS = Object.freeze([
  "HINDER", "D4_COMPLICATION", "SFX_GAIN", "HITCH_COMPLICATION", "EXTRA_TRAIT", "EXTRA_RESULT", "EXTRA_EFFECT_DIE",
  "SFX_SPEND"
]);

/** How a character who would be taken out can stay in: their own PP, or the bank for a GMC (RQ-042). */
export const STAY_IN_ROUTES = Object.freeze(["pay", "bank"]);

/** The size suggested to the GM when a failed test has no opposition effect die (RQ-044). */
export const SUGGESTED_GM_COMPLICATION_SIZE = 6;

/** @returns {boolean} whether value is a plain object, not an array, class instance or null */
function isPlainObject(value) {
  if ( (value === null) || (typeof value !== "object") ) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype) || (proto === null);
}

/**
 * @param {unknown} value
 * @param {number} min
 * @returns {boolean} whether value is a whole number of at least min (a number, not a string)
 */
function isWholeFrom(value, min) {
  return Number.isInteger(value) && (value >= min);
}

/** @returns {boolean} whether value is a non-empty string */
function isNonEmptyString(value) {
  return (typeof value === "string") && (value.length > 0);
}

/**
 * One change of a balance outside a roll's settlement: an award, giving in, staying in, a gain
 * from another spec after a roll was settled, or a GM adjustment. The caller records the reason.
 * A balance never goes below zero (P5; spends are limited by what the payer holds).
 *
 * Check order: (1) the balance is a whole number from 0, else INVALID_PP_AMOUNT; (2) the change is
 * a whole number other than 0, else INVALID_PP_AMOUNT; (3) the new balance would be below 0,
 * PP_INSUFFICIENT.
 * @param {number} balance - the stored balance of the player or the bank
 * @param {number} delta - positive for a gain, negative for a spend
 * @returns {import("./types.mjs").EngineResult<{balance: number}>}
 */
export function changeBalance(balance, delta) {
  if ( !isWholeFrom(balance, 0) ) return fail("INVALID_PP_AMOUNT");
  if ( !Number.isInteger(delta) || (delta === 0) ) return fail("INVALID_PP_AMOUNT");
  if ( balance + delta < 0 ) return fail("PP_INSUFFICIENT");
  return ok({ balance: balance + delta });
}

/**
 * The start of a session (rules 2 and 3). Each listed character below one PP is raised to one and
 * nobody else gains (RQ-036). The bank keeps what it holds and gains one PP per player (RQ-037).
 * Who counts as a player, and which characters are listed, is the caller's choice (P7); the two
 * are passed separately. The caller records a SESSION_START entry for every gain above 0.
 *
 * Check order: (1) players is an array of plain objects with distinct non-empty string actorIds,
 * else INVALID_PP_INPUT; (2) each balance is a whole number from 0, else INVALID_PP_AMOUNT; (3) so
 * is the bank, else INVALID_PP_AMOUNT; (4) playerCount is a whole number from 0, else
 * INVALID_PP_INPUT.
 * @param {object} input
 * @param {{actorId: string, balance: number}[]} input.players - the characters whose balances start
 *   the session, in the order the result keeps
 * @param {number} input.bank - what the bank holds before the session starts
 * @param {number} input.playerCount - the number of players the bank is paid for
 * @returns {import("./types.mjs").EngineResult<{
 *   players: {actorId: string, balance: number, gained: number}[], bank: number, bankGained: number
 * }>}
 */
export function startSession(input) {
  if ( !isPlainObject(input) || !Array.isArray(input.players) ) return fail("INVALID_PP_INPUT");
  const { players, bank, playerCount } = input;
  const seen = new Set();
  for ( const player of players ) {
    if ( !isPlainObject(player) || !isNonEmptyString(player.actorId) || seen.has(player.actorId) ) {
      return fail("INVALID_PP_INPUT");
    }
    seen.add(player.actorId);
  }
  if ( !players.every(player => isWholeFrom(player.balance, 0)) ) return fail("INVALID_PP_AMOUNT");
  if ( !isWholeFrom(bank, 0) ) return fail("INVALID_PP_AMOUNT");
  if ( !isWholeFrom(playerCount, 0) ) return fail("INVALID_PP_INPUT");

  return ok({
    players: players.map(({ actorId, balance }) => {
      const raised = Math.max(balance, 1);
      return { actorId, balance: raised, gained: raised - balance };
    }),
    bank: bank + playerCount,
    bankGained: playerCount
  });
}

/** @returns {boolean} whether value is left out or a string */
function isOptionalString(value) {
  return (value === undefined) || (typeof value === "string");
}

/**
 * @param {unknown} payer
 * @returns {boolean} whether payer is exactly an actor account with an id, or the bank
 */
function isAccountRef(payer) {
  if ( !isPlainObject(payer) ) return false;
  const keys = Object.keys(payer);
  if ( payer.kind === "bank" ) return keys.length === 1;
  return (payer.kind === "actor") && isNonEmptyString(payer.actorId) && (keys.length === 2);
}

/**
 * Checks one PP line: its shape first (INVALID_PP_INPUT), then its amount (INVALID_PP_AMOUNT). A
 * gain says whether it is usable on the roll; a spend says nothing; a hitch PP is never usable on
 * its own roll (rule 4, PP-E14).
 * @param {unknown} line
 * @param {readonly string[]} allowedReasons
 * @returns {string|null} the code of the failed check, or null
 */
function lineProblem(line, allowedReasons) {
  if ( !isPlainObject(line) || !allowedReasons.includes(line.reason) ) return "INVALID_PP_INPUT";
  if ( line.direction !== PP_REASONS[line.reason] ) return "INVALID_PP_INPUT";
  if ( !isOptionalString(line.label) || !isOptionalString(line.sourceId) ) return "INVALID_PP_INPUT";
  if ( line.direction === "gain" ) {
    if ( typeof line.usableThisRoll !== "boolean" ) return "INVALID_PP_INPUT";
    if ( (line.reason === "HITCH_COMPLICATION") && line.usableThisRoll ) return "INVALID_PP_INPUT";
  }
  else if ( line.usableThisRoll !== undefined ) return "INVALID_PP_INPUT";
  if ( !isWholeFrom(line.amount, 1) ) return "INVALID_PP_AMOUNT";
  return null;
}

/**
 * Checks a list of lines in order, each completely before the next.
 * @param {unknown} lines
 * @param {readonly string[]} allowedReasons
 * @returns {string|null}
 */
function linesProblem(lines, allowedReasons) {
  if ( !Array.isArray(lines) ) return "INVALID_PP_INPUT";
  for ( const line of lines ) {
    const problem = lineProblem(line, allowedReasons);
    if ( problem ) return problem;
  }
  return null;
}

/** @param {import("./types.mjs").PpLine} line @returns {import("./types.mjs").PpLine} a copy */
function copyLine(line) {
  const copy = { reason: line.reason, direction: line.direction, amount: line.amount };
  if ( line.label !== undefined ) copy.label = line.label;
  if ( line.sourceId !== undefined ) copy.sourceId = line.sourceId;
  if ( line.usableThisRoll !== undefined ) copy.usableThisRoll = line.usableThisRoll;
  return copy;
}

/**
 * The sums the preview and the settlement work from: S spent, U gained and usable on this roll,
 * L gained and usable only afterwards.
 * @param {import("./types.mjs").PpLine[]} lines - already checked
 * @returns {{S: number, U: number, L: number}}
 */
function sums(lines) {
  let S = 0, U = 0, L = 0;
  for ( const line of lines ) {
    if ( line.direction === "spend" ) S += line.amount;
    else if ( line.usableThisRoll ) U += line.amount;
    else L += line.amount;
  }
  return { S, U, L };
}

/**
 * The plot point a pool entry gains: from the entry as traitPoolEntries gives it, or from its
 * source once addTraitDice has stored it in a pool. A Hinder on a trait already at d4 reports 0,
 * which gains nothing (RQ-029).
 * @param {{ppGained?: unknown, source: {ppGained?: unknown}}} entry
 * @returns {unknown}
 */
function gainOf(entry) {
  return (entry.ppGained !== undefined) ? entry.ppGained : entry.source.ppGained;
}

/**
 * The pool-stage lines (rules 7, 9, 11; RQ-019, RQ-038 to RQ-040, RQ-043). For a character payer:
 * one EXTRA_TRAIT spend per set with extra traits, in poolTraitCost's order. For the bank: no
 * such line, but the warning BANK_SPEND_NOT_LISTED in its place, since a GMC's extra trait has no
 * bank price (RQ-043). Then, in pool order, a usable HINDER gain for each entry that gains a PP,
 * and a usable D4_COMPLICATION gain for each d4 complication the roller holds (RQ-039, RQ-040).
 * Any other d4 complication earns nothing and warns D4_COMPLICATION_NOT_OWN. Unpriced traits
 * (RQ-030) give no line.
 *
 * Check order: (1) entries is an array of plain objects with a size in DIE_SIZES and a plain
 * source whose kind and label are non-empty strings and whose actorId and traitId are absent or
 * strings, else INVALID_PP_INPUT; (2) each gain present is a whole number from 0, else
 * INVALID_PP_AMOUNT; (3) traitCost is null or a plain object whose extraTraits are plain objects
 * with a string setId, else INVALID_PP_INPUT, each count a whole number from 1, else
 * INVALID_PP_AMOUNT; (4) rollerActorId is a non-empty string or null, else INVALID_PP_INPUT;
 * (5) payer is an AccountRef, else INVALID_PP_INPUT.
 * @param {object} input
 * @param {{size: number, source: object, ppGained?: number}[]} input.entries - the pool's entries
 *   before any step or doubling
 * @param {{extraTraits: {setId: string, count: number}[]}|null} input.traitCost - poolTraitCost's
 *   value, or null for a pool without set traits
 * @param {string|null} input.rollerActorId
 * @param {import("./types.mjs").AccountRef} input.payer
 * @returns {import("./types.mjs").EngineResult<{lines: import("./types.mjs").PpLine[],
 *   warnings: import("./types.mjs").PpWarning[]}>}
 */
export function poolPpFacts(input) {
  if ( !isPlainObject(input) || !Array.isArray(input.entries) ) return fail("INVALID_PP_INPUT");
  const { entries, traitCost, rollerActorId, payer } = input;
  for ( const entry of entries ) {
    if ( !isPlainObject(entry) || !DIE_SIZES.includes(entry.size) || !isPlainObject(entry.source) ) {
      return fail("INVALID_PP_INPUT");
    }
    const { kind, label, actorId, traitId } = entry.source;
    if ( !isNonEmptyString(kind) || !isNonEmptyString(label) ) return fail("INVALID_PP_INPUT");
    if ( !isOptionalString(actorId) || !isOptionalString(traitId) ) return fail("INVALID_PP_INPUT");
  }
  for ( const entry of entries ) {
    const gain = gainOf(entry);
    if ( (gain !== undefined) && !isWholeFrom(gain, 0) ) return fail("INVALID_PP_AMOUNT");
  }
  if ( traitCost !== null ) {
    if ( !isPlainObject(traitCost) || !Array.isArray(traitCost.extraTraits) ) return fail("INVALID_PP_INPUT");
    if ( !traitCost.extraTraits.every(x => isPlainObject(x) && (typeof x.setId === "string")) ) {
      return fail("INVALID_PP_INPUT");
    }
    if ( !traitCost.extraTraits.every(x => isWholeFrom(x.count, 1)) ) return fail("INVALID_PP_AMOUNT");
  }
  if ( (rollerActorId !== null) && !isNonEmptyString(rollerActorId) ) return fail("INVALID_PP_INPUT");
  if ( !isAccountRef(payer) ) return fail("INVALID_PP_INPUT");

  const lines = [];
  const warnings = [];
  for ( const { setId, count } of traitCost?.extraTraits ?? [] ) {
    if ( payer.kind === "actor" ) lines.push({ reason: "EXTRA_TRAIT", direction: "spend", amount: count, sourceId: setId });
    else warnings.push({ code: "BANK_SPEND_NOT_LISTED", setId, count });
  }
  for ( const entry of entries ) {
    const { source } = entry;
    const gain = gainOf(entry);
    if ( gain > 0 ) {
      const line = { reason: "HINDER", direction: "gain", amount: gain, label: source.label };
      if ( source.traitId !== undefined ) line.sourceId = source.traitId;
      line.usableThisRoll = true;
      lines.push(line);
    }
    if ( (source.kind !== "complication") || (entry.size !== 4) ) continue;
    if ( (rollerActorId !== null) && (source.actorId === rollerActorId) ) {
      lines.push({ reason: "D4_COMPLICATION", direction: "gain", amount: 1, label: source.label, usableThisRoll: true });
    }
    else {
      const warning = { code: "D4_COMPLICATION_NOT_OWN", label: source.label };
      if ( source.actorId !== undefined ) warning.actorId = source.actorId;
      warnings.push(warning);
    }
  }
  return ok({ lines, warnings });
}

/**
 * The roll-stage lines (rules 12 to 14; RQ-041, RQ-043; P15). EXTRA_RESULT for the paid results,
 * for any payer (a bank spend, rule 17). EXTRA_EFFECT_DIE for the paid effect dice when a
 * character pays; for the bank the warning BANK_SPEND_NOT_LISTED with the count instead, and the
 * dice stay. Then copies of the SFX lines recorded on the card. Call it only for a selection
 * validateSelection accepts (PP-E09). Free results from a mod must never be counted in
 * extraResultsPaid.
 *
 * Check order: (1) selection is a plain object, else INVALID_PP_INPUT; (2) both paid counters,
 * read as 0 when missing, are whole numbers from 0, else INVALID_PP_AMOUNT; (3) sfxLines is an
 * array of SFX_SPEND and SFX_GAIN lines; (4) payer is an AccountRef, else INVALID_PP_INPUT.
 * @param {object} input
 * @param {{extraResultsPaid?: number, extraEffectDicePaid?: number}} input.selection
 * @param {import("./types.mjs").PpLine[]} [input.sfxLines]
 * @param {import("./types.mjs").AccountRef} input.payer
 * @returns {import("./types.mjs").EngineResult<{lines: import("./types.mjs").PpLine[],
 *   warnings: import("./types.mjs").PpWarning[]}>}
 */
export function rollPpFacts(input) {
  if ( !isPlainObject(input) || !isPlainObject(input.selection) ) return fail("INVALID_PP_INPUT");
  const { selection, sfxLines = [], payer } = input;
  const results = selection.extraResultsPaid ?? 0;
  const effects = selection.extraEffectDicePaid ?? 0;
  if ( !isWholeFrom(results, 0) || !isWholeFrom(effects, 0) ) return fail("INVALID_PP_AMOUNT");
  const problem = linesProblem(sfxLines, ["SFX_SPEND", "SFX_GAIN"]);
  if ( problem ) return fail(problem);
  if ( !isAccountRef(payer) ) return fail("INVALID_PP_INPUT");

  const lines = [];
  const warnings = [];
  if ( results > 0 ) lines.push({ reason: "EXTRA_RESULT", direction: "spend", amount: results });
  if ( effects > 0 ) {
    if ( payer.kind === "actor" ) lines.push({ reason: "EXTRA_EFFECT_DIE", direction: "spend", amount: effects });
    else warnings.push({ code: "BANK_SPEND_NOT_LISTED", count: effects });
  }
  lines.push(...sfxLines.map(copyLine));
  return ok({ lines, warnings });
}

/**
 * The preview of a roll's lines for the pool builder and the card before Confirm (P4). Warns
 * PP_SHORT when even every gain of the roll wouldn't cover its spends, and otherwise
 * PP_NOT_YET_USABLE when only gains that wait for the roll to resolve would (rule 4).
 *
 * Check order: (1) balance is a whole number from 0, else INVALID_PP_AMOUNT; (2) lines is an
 * array of roll lines, each checked in order.
 * @param {{balance: number, lines: import("./types.mjs").PpLine[]}} input
 * @returns {import("./types.mjs").EngineResult<{spent: number, gained: number,
 *   usableGained: number, net: number, warnings: {code: string}[]}>}
 */
export function ppTotals(input) {
  if ( !isPlainObject(input) ) return fail("INVALID_PP_INPUT");
  const { balance, lines } = input;
  if ( !isWholeFrom(balance, 0) ) return fail("INVALID_PP_AMOUNT");
  const problem = linesProblem(lines, ROLL_REASONS);
  if ( problem ) return fail(problem);
  const { S, U, L } = sums(lines);
  const warnings = [];
  if ( S > balance + U + L ) warnings.push({ code: "PP_SHORT" });
  else if ( S > balance + U ) warnings.push({ code: "PP_NOT_YET_USABLE" });
  return ok({ spent: S, gained: U + L, usableGained: U, net: U + L - S, warnings });
}

/**
 * Settles a confirmed roll's lines once (rules 4, 11 to 14; P4, P5, P10). The balance is the
 * payer's stored one, which never holds this roll's own gains yet. A refusal writes nothing and
 * leaves the card's result as confirmed; there is no partial settle.
 *
 * Check order: (1) settled is a boolean, else INVALID_PP_INPUT; (2) settled is true,
 * PP_ALREADY_SETTLED; (3) balance is a whole number from 0, else INVALID_PP_AMOUNT; (4) the lines
 * as in ppTotals; (5) the spends exceed the balance and every gain, PP_INSUFFICIENT; (6) they
 * exceed the balance and the usable gains, PP_NOT_YET_USABLE.
 * @param {{balance: number, lines: import("./types.mjs").PpLine[], settled?: boolean}} input
 * @returns {import("./types.mjs").EngineResult<{balance: number, delta: number, spent: number,
 *   gained: number, lines: import("./types.mjs").PpLine[]}>}
 */
export function settleRoll(input) {
  if ( !isPlainObject(input) ) return fail("INVALID_PP_INPUT");
  const { balance, lines, settled = false } = input;
  if ( typeof settled !== "boolean" ) return fail("INVALID_PP_INPUT");
  if ( settled ) return fail("PP_ALREADY_SETTLED");
  if ( !isWholeFrom(balance, 0) ) return fail("INVALID_PP_AMOUNT");
  const problem = linesProblem(lines, ROLL_REASONS);
  if ( problem ) return fail(problem);
  const { S, U, L } = sums(lines);
  if ( S > balance + U + L ) return fail("PP_INSUFFICIENT");
  if ( S > balance + U ) return fail("PP_NOT_YET_USABLE");
  return ok({ balance: balance - S + U + L, delta: U + L - S, spent: S, gained: U + L, lines: lines.map(copyLine) });
}

/**
 * @param {string} side
 * @param {boolean} isGmc
 * @param {number} delta
 * @param {string} reason
 * @returns {import("./types.mjs").PpChange}
 */
function changeFor(side, isGmc, delta, reason) {
  return { target: isGmc ? { kind: "bank" } : { kind: "side", side }, delta, reason };
}

/**
 * @param {string} side
 * @param {boolean} isGmc
 * @returns {import("./types.mjs").StayInRoute[]} the one way this side stays in: its own PP, or
 *   the bank for a GMC (RQ-042)
 */
function stayInRoutes(side, isGmc) {
  return [{ route: isGmc ? "bank" : "pay", changes: [changeFor(side, isGmc, -1, "STAY_IN")] }];
}

/**
 * The PP actions after a contest (rules 6, 15, 18, 19). Giving in after having rolled earns the
 * side 1 PP, into the bank for a GMC (RQ-038). A loser who would be taken out may stay in for
 * 1 PP and takes the listed complications (RQ-013, RQ-016, RQ-017); a GMC loser can only stay in
 * from the bank, whoever won, and the winner gains nothing (RQ-042). Complications from
 * comparisons that don't take the loser out stand either way and aren't repeated here.
 *
 * Check order: (1) consequence is a plain object with distinct winner and loser sides, boolean
 * ppEligible and takenOut, and avoidWithPP null or a list of {effectId, size} that is non-empty
 * exactly when takenOut, else INVALID_PP_INPUT; (2) gmcSides is a list of distinct sides, else
 * INVALID_PP_INPUT.
 * @param {import("./types.mjs").Consequence} consequence - contestConsequence's value
 * @param {{gmcSides?: string[]}} [options] - the sides GMCs play, which the caller knows
 * @returns {import("./types.mjs").EngineResult<{
 *   giveIn: {side: string, changes: import("./types.mjs").PpChange[]}|null,
 *   stayIn: {side: string, complications: {effectId: string, size: number}[],
 *     routes: import("./types.mjs").StayInRoute[]}|null}>}
 */
export function contestPpOptions(consequence, options = {}) {
  if ( !isPlainObject(consequence) ) return fail("INVALID_PP_INPUT");
  const { winner, loser, ppEligible, takenOut, avoidWithPP } = consequence;
  if ( !CONTEST_SIDES.includes(winner) || !CONTEST_SIDES.includes(loser) || (winner === loser) ) {
    return fail("INVALID_PP_INPUT");
  }
  if ( (typeof ppEligible !== "boolean") || (typeof takenOut !== "boolean") ) return fail("INVALID_PP_INPUT");
  if ( avoidWithPP !== null ) {
    if ( !Array.isArray(avoidWithPP) ) return fail("INVALID_PP_INPUT");
    if ( !avoidWithPP.every(a => isPlainObject(a) && (typeof a.effectId === "string") && DIE_SIZES.includes(a.size)) ) {
      return fail("INVALID_PP_INPUT");
    }
  }
  if ( takenOut !== ((avoidWithPP?.length ?? 0) > 0) ) return fail("INVALID_PP_INPUT");
  if ( !isPlainObject(options) ) return fail("INVALID_PP_INPUT");
  const { gmcSides = [] } = options;
  if ( !Array.isArray(gmcSides) || !gmcSides.every(s => CONTEST_SIDES.includes(s)) ) return fail("INVALID_PP_INPUT");
  if ( new Set(gmcSides).size !== gmcSides.length ) return fail("INVALID_PP_INPUT");

  const loserIsGmc = gmcSides.includes(loser);
  return ok({
    giveIn: ppEligible ? { side: loser, changes: [changeFor(loser, loserIsGmc, 1, "GIVE_IN")] } : null,
    stayIn: takenOut ? {
      side: loser,
      complications: avoidWithPP.map(({ effectId, size }) => ({ effectId, size })),
      routes: stayInRoutes(loser, loserIsGmc)
    } : null
  });
}

/**
 * Staying in after a failed high-stakes test that the GM rules a take-out (rules 15, 18; RQ-035,
 * RQ-042, RQ-044). An applied overflow take-out of the setter gives a d12 complication (RQ-013).
 * Otherwise the PP gives one complication at the largest opposition effect die acting on the
 * character, the first listed on a tie. With no opposition effect die the GM gives a size (d6
 * suggested) or "none"; until then the option asks for it and can't be paid.
 *
 * Check order: (1) shapes (result with a boolean success; takenOut, overflowApplies and
 * rollerIsGmc booleans, overflowApplies only with takenOut; oppositionTakeOut boolean or null;
 * oppositionEffects plain objects with distinct non-empty string ids; usedAgainst absent or
 * strings; gmSize absent, a number or "none"), else INVALID_PP_INPUT; (2) a size not on the
 * ladder, INVALID_DIE_SIZE; (3) a success or no take-out ruled, NO_TAKE_OUT; (4) with
 * overflowApplies: no recorded take-out choice, NO_OVERFLOW_TAKE_OUT, and usedAgainst or gmSize
 * given, INVALID_PP_INPUT; (5) without opposition effect dice: usedAgainst naming any,
 * EFFECT_DIE_NOT_FOUND; (6) with them: gmSize given, INVALID_PP_INPUT; a repeated id,
 * DUPLICATE_EFFECT_DIE; none used, NO_EFFECT_DIE_USED; an unknown id, EFFECT_DIE_NOT_FOUND.
 * @param {object} input
 * @param {{success: boolean}} input.result - testResult's value
 * @param {{id: string, size: number}[]} input.oppositionEffects
 * @param {boolean|null} [input.oppositionTakeOut]
 * @param {boolean} input.takenOut - the GM's ruling
 * @param {boolean} [input.overflowApplies] - the GM's ruling on the setter's overflow
 * @param {string[]} [input.usedAgainst] - left out, every opposition effect die
 * @param {number|"none"} [input.gmSize]
 * @param {boolean} [input.rollerIsGmc]
 * @returns {import("./types.mjs").EngineResult<{complications: {effectId: string|null,
 *   size: number}[]|null, gmSizeNeeded: {suggestedSize: number}|null,
 *   routes: import("./types.mjs").StayInRoute[]}>}
 */
export function testStayInOption(input) {
  if ( !isPlainObject(input) ) return fail("INVALID_PP_INPUT");
  const {
    result, oppositionEffects, oppositionTakeOut = null, takenOut, overflowApplies = false, usedAgainst, gmSize,
    rollerIsGmc = false
  } = input;
  if ( !isPlainObject(result) || (typeof result.success !== "boolean") ) return fail("INVALID_PP_INPUT");
  if ( ![takenOut, overflowApplies, rollerIsGmc].every(b => typeof b === "boolean") ) return fail("INVALID_PP_INPUT");
  if ( overflowApplies && !takenOut ) return fail("INVALID_PP_INPUT");
  if ( (oppositionTakeOut !== null) && (typeof oppositionTakeOut !== "boolean") ) return fail("INVALID_PP_INPUT");
  if ( !Array.isArray(oppositionEffects) ) return fail("INVALID_PP_INPUT");
  if ( !oppositionEffects.every(e => isPlainObject(e) && isNonEmptyString(e.id)) ) return fail("INVALID_PP_INPUT");
  if ( new Set(oppositionEffects.map(e => e.id)).size !== oppositionEffects.length ) return fail("INVALID_PP_INPUT");
  if ( (usedAgainst !== undefined) && !(Array.isArray(usedAgainst) && usedAgainst.every(id => typeof id === "string")) ) {
    return fail("INVALID_PP_INPUT");
  }
  if ( (gmSize !== undefined) && (typeof gmSize !== "number") && (gmSize !== "none") ) return fail("INVALID_PP_INPUT");
  if ( !oppositionEffects.every(e => DIE_SIZES.includes(e.size)) ) return fail("INVALID_DIE_SIZE");
  if ( (typeof gmSize === "number") && !DIE_SIZES.includes(gmSize) ) return fail("INVALID_DIE_SIZE");
  if ( result.success || !takenOut ) return fail("NO_TAKE_OUT");

  const option = complications => ok({
    complications, gmSizeNeeded: null, routes: stayInRoutes("roller", rollerIsGmc)
  });
  if ( overflowApplies ) {
    if ( oppositionTakeOut !== true ) return fail("NO_OVERFLOW_TAKE_OUT");
    if ( (usedAgainst !== undefined) || (gmSize !== undefined) ) return fail("INVALID_PP_INPUT");
    return option([{ effectId: null, size: 12 }]);
  }
  if ( oppositionEffects.length === 0 ) {
    if ( usedAgainst?.length ) return fail("EFFECT_DIE_NOT_FOUND");
    if ( gmSize === undefined ) {
      return ok({
        complications: null,
        gmSizeNeeded: { suggestedSize: SUGGESTED_GM_COMPLICATION_SIZE },
        routes: stayInRoutes("roller", rollerIsGmc)
      });
    }
    return option(gmSize === "none" ? [] : [{ effectId: null, size: gmSize }]);
  }
  if ( gmSize !== undefined ) return fail("INVALID_PP_INPUT");
  const used = usedAgainst ?? oppositionEffects.map(e => e.id);
  if ( new Set(used).size !== used.length ) return fail("DUPLICATE_EFFECT_DIE");
  if ( used.length === 0 ) return fail("NO_EFFECT_DIE_USED");
  if ( !used.every(id => oppositionEffects.some(e => e.id === id)) ) return fail("EFFECT_DIE_NOT_FOUND");
  let largest = null;
  for ( const effect of oppositionEffects ) {
    if ( used.includes(effect.id) && ((largest === null) || (effect.size > largest.size)) ) largest = effect;
  }
  return option([{ effectId: largest.id, size: largest.size }]);
}

/** Reasons only a GM may record on a character (rule 8; P9). */
const GM_ONLY_REASONS = Object.freeze(["AWARD", "GM_ADJUST", "SESSION_START"]);

/**
 * Who may change which balance (P9): only a GM touches the bank, and a PC's balance is changed by
 * its owner or a GM; awards, adjustments and the start of a session are a GM's.
 *
 * Check order: (1) the input's shape, else INVALID_PP_INPUT; (2) the bank, or a GM-only reason,
 * for a user who isn't a GM, PP_GM_ONLY; (3) a character neither owned by the user nor changed by
 * a GM, PP_NOT_OWNER.
 * @param {{accountKind: "actor"|"bank", reason: string, isGM: boolean, isOwner: boolean}} input
 * @returns {import("./types.mjs").EngineResult<true>}
 */
export function ppChangeAllowed(input) {
  if ( !isPlainObject(input) ) return fail("INVALID_PP_INPUT");
  const { accountKind, reason, isGM, isOwner } = input;
  if ( !["actor", "bank"].includes(accountKind) || !(reason in PP_REASONS) ) return fail("INVALID_PP_INPUT");
  if ( (typeof isGM !== "boolean") || (typeof isOwner !== "boolean") ) return fail("INVALID_PP_INPUT");
  if ( isGM ) return ok(true);
  if ( (accountKind === "bank") || GM_ONLY_REASONS.includes(reason) ) return fail("PP_GM_ONLY");
  if ( !isOwner ) return fail("PP_NOT_OWNER");
  return ok(true);
}
