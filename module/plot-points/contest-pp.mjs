/**
 * Plot points on the test and contest card (the Plot Points spec's P8 and P9; rules 6, 15, 18 and
 * 19; RQ-035, RQ-038, RQ-042, RQ-044; Decisions ADR-056). Both run in the GM's contest handler
 * (ADR-027): giving in pays its PP in the same handler call that records the give-in, and staying in
 * is a request of its own, which pays 1 PP and records what it bought on the card. The record is a
 * flag on the contest message, written by the GM, outside the engine state the contest schema holds.
 * Nothing here decides an amount: that is contestPpOptions and testStayInOption.
 * @module plot-points/contest-pp
 */

import { contestConsequence, contestPpOptions, testResult, testStayInOption } from "../rules/index.mjs";
import { sideActor } from "../contest/records.mjs";
import { changePlotPoints, holdsPlotPoints, readAccount } from "./accounts.mjs";

const SYSTEM_ID = "cortex-prime";

/** The end choices that a recorded stay-in fixes: they would change what the PP bought. */
export const LOCKED_BY_STAY_IN = Object.freeze(["apply-heroic-steps", "choose-overflow", "use-against-loser"]);

/**
 * @param {ChatMessage} message - a contest message
 * @returns {{giveIn: object|null, stayIn: object|null}} what the card recorded about plot points
 */
export function contestPpRecord(message) {
  const pp = message?.getFlag?.(SYSTEM_ID, "pp");
  return { giveIn: pp?.giveIn ?? null, stayIn: pp?.stayIn ?? null };
}

/**
 * @param {{key: string, actorUuid?: string|null}[]} sides
 * @returns {string[]} the sides whose PP the bank holds: every side whose actor holds none of its
 *   own (P1), a side with no actor included
 */
export function bankSides(sides) {
  return sides.filter(side => !holdsPlotPoints(sideActor(side))).map(side => side.key);
}

/**
 * @param {import("../rules/types.mjs").PpTarget} target
 * @param {{key: string, actorUuid?: string|null}[]} sides
 * @returns {import("../rules/types.mjs").AccountRef|null}
 */
function accountOf(target, sides) {
  if ( target.kind === "bank" ) return { kind: "bank" };
  const actor = sideActor(sides.find(side => side.key === target.side));
  return holdsPlotPoints(actor) ? { kind: "actor", actorId: actor.id } : null;
}

/**
 * Writes a list of changes, each as one ledger entry referring to the contest card.
 * @param {import("../rules/types.mjs").PpChange[]} changes
 * @param {object[]} sides
 * @param {string} messageId
 * @returns {Promise<{ok: boolean, code?: string}>} the first refusal, if any; the changes before it
 *   stay written (each is one entry of its own)
 */
async function writeChanges(changes, sides, messageId) {
  for ( const change of changes ) {
    const account = accountOf(change.target, sides);
    if ( !account ) return { ok: false, code: "PP_NO_ACCOUNT" };
    const done = await changePlotPoints({ account, delta: change.delta, reason: change.reason, messageRef: messageId });
    if ( !done.ok ) return done;
  }
  return { ok: true };
}

/**
 * After a give-in was written, pays the side that gave in its PP once (rule 6; RQ-038): from the
 * pile to a PC, into the bank for a side the bank holds for. Runs on the GM's client, in the same
 * handler call. A side that declined, or gave in before rolling, earns nothing. A failure is logged
 * and leaves the give-in standing.
 * @param {ChatMessage} message - the contest message, after the write
 * @param {{record: object, system: object}} loaded - contestRecordOf of it
 * @returns {Promise<void>}
 */
export async function payGiveIn(message, loaded) {
  const { record, system } = loaded;
  if ( (record.type !== "contest") || contestPpRecord(message).giveIn ) return;
  const consequence = contestConsequence(record.state, { usedAgainstLoser: [] });
  if ( !consequence.ok || !consequence.value.ppEligible ) return;
  const options = contestPpOptions(consequence.value, { gmcSides: bankSides(system.sides) });
  if ( !options.ok || !options.value.giveIn ) return;
  const { side, changes } = options.value.giveIn;
  const written = await writeChanges(changes, system.sides, message.id);
  if ( !written.ok ) {
    console.warn(`cortex-prime | The plot point for giving in wasn't paid: ${written.code}`);
    return;
  }
  await message.update({ [`flags.${SYSTEM_ID}.pp.giveIn`]: { side, changes } });
}

/**
 * What staying in would buy and cost for a contest card's loser (rule 15; RQ-013, RQ-015 to RQ-017,
 * RQ-042), or why it can't: the winner's pick must be made first when its roll has effect dice.
 * @param {{record: object, system: object}} loaded
 * @returns {{ok: true, value: object}|{ok: false, code: string}} `stayIn` of contestPpOptions
 */
function contestStayIn(loaded) {
  const { record, system } = loaded;
  const stored = system.flow.usedAgainstLoser ?? null;
  const consequence = contestConsequence(record.state, { usedAgainstLoser: stored ?? [] });
  if ( !consequence.ok ) return consequence;
  if ( (stored === null) && (consequence.value.ending === "won") && consequence.value.winnerEffects.length ) {
    return { ok: false, code: "PP_PICK_FIRST" };
  }
  const options = contestPpOptions(consequence.value, { gmcSides: bankSides(system.sides) });
  if ( !options.ok ) return options;
  return options.value.stayIn ? { ok: true, value: options.value.stayIn } : { ok: false, code: "NO_TAKE_OUT" };
}

/**
 * What staying in after a failed high-stakes test buys, from the GM's answers (rule 15; RQ-035,
 * RQ-042, RQ-044). Pressing Stay in is the GM's ruling that the character is taken out.
 * @param {{record: object, system: object}} loaded
 * @param {{overflowApplies?: boolean, usedAgainst?: string[], gmSize?: number|"none"}} answers
 * @returns {{ok: true, value: object}|{ok: false, code: string}} testStayInOption's value, with the
 *   side "roller"
 */
function testStayIn(loaded, answers) {
  const { record, system } = loaded;
  if ( record.state.highStakes !== true ) return { ok: false, code: "NO_TAKE_OUT" };
  const result = testResult(record.state);
  if ( !result.ok ) return result;
  const input = {
    result: result.value, oppositionEffects: system.flow.oppositionEffects ?? [],
    oppositionTakeOut: system.flow.oppositionTakeOut ?? null, takenOut: true,
    overflowApplies: answers?.overflowApplies === true, rollerIsGmc: bankSides(system.sides).includes("roller")
  };
  if ( answers?.usedAgainst !== undefined ) input.usedAgainst = answers.usedAgainst;
  if ( answers?.gmSize !== undefined ) input.gmSize = answers.gmSize;
  const option = testStayInOption(input);
  if ( !option.ok ) return option;
  if ( option.value.complications === null ) return { ok: false, code: "PP_GM_SIZE_NEEDED" };
  return { ok: true, value: { side: "roller", ...option.value } };
}

/**
 * @param {{record: object, system: object}} loaded
 * @param {object} [answers] - a test's answers
 * @returns {{ok: true, value: {side: string, complications: object[]|null, routes: object[]}}|{ok: false, code: string}}
 */
function stayInFor(loaded, answers) {
  return (loaded.record.type === "test") ? testStayIn(loaded, answers) : contestStayIn(loaded);
}

/**
 * Whether the sender may pay for this side to stay in (P9): the bank route and every test answer are
 * the GM's; the pay route is the side's owner's or a GM's.
 * @param {User} user
 * @param {object} loaded
 * @param {{side: string, routes: {route: string}[]}} stayIn
 * @returns {string|null} a refusal code, or null
 */
function stayInRefusal(user, loaded, stayIn) {
  if ( user.isGM ) return null;
  if ( (loaded.record.type === "test") || (stayIn.routes[0].route === "bank") ) return "PP_GM_ONLY";
  const actor = sideActor(loaded.system.sides.find(side => side.key === stayIn.side));
  return actor?.testUserPermission(user, "OWNER") ? null : "PP_NOT_OWNER";
}

/**
 * The "stay-in" request on the GM's client (P8): checks it, pays 1 PP from the loser's account (the
 * bank for a GMC, RQ-042) and records the complications it bought on the card. Once recorded, the
 * end choices that would change them are refused (LOCKED_BY_STAY_IN).
 * @param {ChatMessage} message
 * @param {{record: object, system: object}} loaded
 * @param {{revision: number, payload?: object}} request - a test's payload holds the GM's answers
 * @param {User} user - the sender
 * @returns {Promise<{ok: boolean, code?: string, value?: object}>}
 */
export async function handleStayIn(message, loaded, request, user) {
  if ( request.revision !== loaded.record.revision ) return { ok: false, code: "STALE_REVISION" };
  if ( contestPpRecord(message).stayIn ) return { ok: false, code: "PP_ALREADY_SETTLED" };
  const answers = (loaded.record.type === "test") ? (request.payload ?? {}) : undefined;
  const stayIn = stayInFor(loaded, answers);
  if ( !stayIn.ok ) return stayIn;
  const refusal = stayInRefusal(user, loaded, stayIn.value);
  if ( refusal ) return { ok: false, code: refusal };
  const route = stayIn.value.routes[0];
  const written = await writeChanges(route.changes, loaded.system.sides, message.id);
  if ( !written.ok ) return written;
  const recorded = { side: stayIn.value.side, route: route.route, complications: stayIn.value.complications, userId: user.id };
  if ( answers ) {
    recorded.answers = { overflowApplies: answers.overflowApplies === true };
    if ( answers.usedAgainst !== undefined ) recorded.answers.usedAgainst = answers.usedAgainst;
    if ( answers.gmSize !== undefined ) recorded.answers.gmSize = answers.gmSize;
  }
  await message.update({ [`flags.${SYSTEM_ID}.pp.stayIn`]: recorded });
  return { ok: true, value: { stayIn: recorded } };
}

/**
 * @param {{effectId: string|null, size: number}[]|null} complications
 * @returns {string} "a d8 complication", "d8 and d6 complications" or "no complication"
 */
function complicationText(complications) {
  if ( !complications?.length ) return game.i18n.localize("CORTEX.PlotPoints.StayIn.NoComplication");
  const sizes = complications.map(c => `d${c.size}`).join(", ");
  return game.i18n.format(complications.length === 1 ? "CORTEX.PlotPoints.StayIn.One" : "CORTEX.PlotPoints.StayIn.Many", { sizes });
}

/**
 * The PP_SHORT hint for a stay-in offer whose payer holds less than the 1 PP it costs.
 * @param {string} sideKey - the side that would stay in
 * @param {object[]} sides
 * @returns {string|null}
 */
function shortHint(sideKey, sides) {
  const target = bankSides(sides).includes(sideKey) ? { kind: "bank" } : { kind: "side", side: sideKey };
  const account = accountOf(target, sides);
  const read = account ? readAccount(account) : null;
  return (read && (read.balance < 1)) ? game.i18n.localize("CORTEX.PlotPoints.Warnings.PP_SHORT") : null;
}

/**
 * The card's plot point section for one user: what was paid for giving in and staying in, and the
 * Stay in offer to those who may take it. A test's offer is the GM's form: the opposition's effect
 * dice to mark (all marked to start), the size when there is none (d6 suggested, or none; RQ-044),
 * and whether the setter's take-out applies when one was chosen (RQ-035).
 * @param {ChatMessage} message
 * @param {{record: object, system: object}} loaded
 * @param {(key: string) => string} sideLabel
 * @param {User} [user=game.user]
 * @returns {object|null}
 */
export function prepareContestPp(message, loaded, sideLabel, user = game.user) {
  const { record, system } = loaded;
  const done = contestPpRecord(message);
  const giveIn = done.giveIn ? game.i18n.format("CORTEX.PlotPoints.GaveIn", { side: sideLabel(done.giveIn.side) }) : null;
  const stayed = done.stayIn ? game.i18n.format("CORTEX.PlotPoints.StayedIn", {
    side: sideLabel(done.stayIn.side), complications: complicationText(done.stayIn.complications)
  }) : null;

  let offer = null;
  if ( !done.stayIn && !record.state.closed ) {
    if ( record.type === "contest" ) {
      const stayIn = contestStayIn(loaded);
      if ( stayIn.ok && !stayInRefusal(user, loaded, stayIn.value) ) {
        offer = {
          side: sideLabel(stayIn.value.side), text: complicationText(stayIn.value.complications), test: null,
          short: shortHint(stayIn.value.side, system.sides)
        };
      }
      else if ( stayIn.code === "PP_PICK_FIRST" ) offer = { waiting: game.i18n.localize("CORTEX.PlotPoints.Errors.PP_PICK_FIRST") };
    }
    else if ( user.isGM && (record.state.highStakes === true) && (record.state.success === false) && testResult(record.state).ok ) {
      const effects = (system.flow.oppositionEffects ?? []).map(({ id, size }) => ({ id, size }));
      offer = {
        side: sideLabel("roller"), text: null, short: shortHint("roller", system.sides),
        test: {
          effects, sizes: [4, 6, 8, 10, 12].map(size => ({ size, selected: size === 6 })),
          overflow: system.flow.oppositionTakeOut === true
        }
      };
    }
  }
  if ( !giveIn && !stayed && !offer ) return null;
  return { giveIn, stayed, offer };
}
