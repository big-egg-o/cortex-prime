/**
 * Plot point accounts in Foundry (Decisions ADR-056; the Plot Points spec's P1 to P3, P7 and P9).
 * A PC's balance is `system.plotPoints` on its actor; the GM's bank is a GM-only world setting.
 * Every change goes through changePlotPoints, which asks the pure rules whether it is allowed and
 * possible, writes the balance and posts a "plotPoints" ledger message. Nothing here decides an
 * amount: that is module/rules/plot-points.mjs.
 * @module plot-points/accounts
 */

import { changeBalance, ppChangeAllowed, startSession } from "../rules/plot-points.mjs";

const SYSTEM_ID = "cortex-prime";

/** The key of the bank setting. */
export const BANK_SETTING = "plotPointBank";

/** Registers the bank setting; called from the `init` hook. */
export function registerPlotPointSettings() {
  game.settings.register(SYSTEM_ID, BANK_SETTING, {
    name: "CORTEX.PlotPoints.Bank",
    scope: "world",
    config: false,
    type: new foundry.data.fields.NumberField({ required: true, nullable: false, integer: true, min: 0, initial: 0 }),
    default: 0,
    onChange: () => Hooks.callAll("cortexPrimePlotPointsChanged")
  });
}

/** @returns {number} what the GM's bank holds */
export function getBank() {
  return game.settings.get(SYSTEM_ID, BANK_SETTING);
}

/**
 * @param {Actor} actor
 * @returns {boolean} whether the actor holds its own plot points (P1, ADR-056: a PC)
 */
export function holdsPlotPoints(actor) {
  return actor?.type === "pc";
}

/**
 * The account a roll by this actor pays from (P1): its own when it holds PP, the bank for any other
 * actor or for a GM rolling with no actor, none for a player rolling with no actor.
 * @param {Actor|null} actor
 * @returns {import("../rules/types.mjs").AccountRef|null}
 */
export function payerFor(actor) {
  if ( holdsPlotPoints(actor) ) return { kind: "actor", actorId: actor.id };
  if ( actor || game.user.isGM ) return { kind: "bank" };
  return null;
}

/**
 * @param {import("../rules/types.mjs").AccountRef} account
 * @returns {{balance: number, actor: Actor|null}|null} the stored balance, or null when the account
 *   names no PC
 */
export function readAccount(account) {
  if ( account?.kind === "bank" ) return { balance: getBank(), actor: null };
  const actor = (account?.kind === "actor") ? game.actors.get(account.actorId) : null;
  if ( !holdsPlotPoints(actor) ) return null;
  return { balance: actor.system.plotPoints, actor };
}

/**
 * Changes one balance and records it (P3, P5, P9).
 * @param {object} change
 * @param {import("../rules/types.mjs").AccountRef} change.account
 * @param {number} change.delta - positive to gain, negative to spend
 * @param {string} change.reason - a key of PP_REASONS
 * @param {string} [change.label]
 * @param {string|null} [change.messageRef] - the roll or contest card it belongs to
 * @returns {Promise<{ok: true, value: {balance: number}}|{ok: false, code: string}>}
 */
export async function changePlotPoints({ account, delta, reason, label = "", messageRef = null }) {
  const read = readAccount(account);
  if ( !read ) return { ok: false, code: "PP_NO_ACCOUNT" };
  const allowed = ppChangeAllowed({
    accountKind: account.kind, reason, isGM: game.user.isGM, isOwner: read.actor?.isOwner ?? false
  });
  if ( !allowed.ok ) return allowed;
  const changed = changeBalance(read.balance, delta);
  if ( !changed.ok ) return changed;
  try {
    await writeBalance(read, changed.value.balance);
    await postLedgerEntry({ account, actor: read.actor, delta, balance: changed.value.balance, reason, label, messageRef });
  }
  catch( err ) {
    console.error(err);
    return { ok: false, code: "WRITE_FAILED" };
  }
  return changed;
}

/**
 * Stores a new balance for an account readAccount found.
 * @param {{actor: Actor|null}} read
 * @param {number} balance
 * @returns {Promise<unknown>}
 */
export function writeBalance(read, balance) {
  if ( read.actor ) return read.actor.update({ "system.plotPoints": balance });
  return game.settings.set(SYSTEM_ID, BANK_SETTING, balance);
}

/**
 * @param {import("../rules/types.mjs").PpLine} line
 * @returns {string} the line as the ledger and the roll card show it, such as "−1 Extra result" or
 *   "+1 Hinder: Sneaky"
 */
export function lineText(line) {
  const sign = (line.direction === "spend") ? "\u2212" : "+";
  const reason = game.i18n.localize(`CORTEX.PlotPoints.Reasons.${line.reason}`);
  return `${sign}${line.amount} ${line.label ? `${reason}: ${line.label}` : reason}`;
}

/**
 * Posts one ledger entry (P3).
 * @param {object} entry
 * @param {import("../rules/types.mjs").AccountRef} entry.account
 * @param {Actor|null} entry.actor
 * @param {number} entry.delta
 * @param {number} entry.balance - the balance the change left
 * @param {string} entry.reason - a key of PP_REASONS, or ROLL for a roll's settlement
 * @param {string} [entry.label]
 * @param {string|null} [entry.messageRef]
 * @param {import("../rules/types.mjs").PpLine[]} [entry.lines] - a settled roll's lines
 * @returns {Promise<ChatMessage>}
 */
export function postLedgerEntry(entry) {
  return ChatMessage.implementation.create(ledgerEntryData(entry));
}

/**
 * The ChatMessage data of one ledger entry (P3), for postLedgerEntry or a batch write that commits
 * the entry with the change it records (ADR-057).
 * @param {object} entry - as postLedgerEntry
 * @returns {object}
 */
export function ledgerEntryData({ account, actor, delta, balance, reason, label = "", messageRef = null, lines = [] }) {
  const i18n = game.i18n;
  const name = actor?.name ?? i18n.localize("CORTEX.PlotPoints.Bank");
  const reasonText = i18n.localize(`CORTEX.PlotPoints.Reasons.${reason}`);
  const text = i18n.format("CORTEX.PlotPoints.Entry", {
    name, delta: (delta > 0) ? `+${delta}` : String(delta), reason: label ? `${reasonText}: ${label}` : reasonText, balance
  });
  const adjustment = reason === "GM_ADJUST";
  let content = `<p class="cp-pp-entry${adjustment ? " cp-pp-adjustment" : ""}">${foundry.utils.escapeHTML(text)}</p>`;
  if ( lines.length ) content += `<ul class="cp-pp-lines">${lines.map(line => `<li>${foundry.utils.escapeHTML(lineText(line))}</li>`).join("")}</ul>`;
  return {
    type: "plotPoints",
    content,
    speaker: actor ? ChatMessage.implementation.getSpeaker({ actor }) : { alias: name },
    system: {
      account: { kind: account.kind, actorId: actor?.id ?? null, name },
      delta, balance, reason, label, messageRef, adjustment, lines
    }
  };
}

/**
 * The players and PCs a session start counts (P7): every user who isn't a GM and has a PC assigned.
 * @returns {Actor[]}
 */
export function sessionCharacters() {
  const actors = game.users.filter(u => !u.isGM && holdsPlotPoints(u.character)).map(u => u.character);
  return [...new Set(actors)];
}

/**
 * The GM's Start session action (rules 2 and 3; RQ-036, RQ-037; P7): raises each assigned PC
 * below one PP to one and adds one PP per player to the bank, recording each gain.
 * @returns {Promise<{ok: true, value: object}|{ok: false, code: string}>}
 */
export async function startPlotPointSession() {
  if ( !game.user.isGM ) return { ok: false, code: "PP_GM_ONLY" };
  const actors = sessionCharacters();
  const playerCount = game.users.filter(u => !u.isGM && holdsPlotPoints(u.character)).length;
  const result = startSession({
    players: actors.map(a => ({ actorId: a.id, balance: a.system.plotPoints })), bank: getBank(), playerCount
  });
  if ( !result.ok ) return result;
  for ( const { actorId, gained } of result.value.players ) {
    if ( gained > 0 ) {
      const done = await changePlotPoints({ account: { kind: "actor", actorId }, delta: gained, reason: "SESSION_START" });
      if ( !done.ok ) return done;
    }
  }
  if ( result.value.bankGained > 0 ) {
    const done = await changePlotPoints({ account: { kind: "bank" }, delta: result.value.bankGained, reason: "SESSION_START" });
    if ( !done.ok ) return done;
  }
  return result;
}
