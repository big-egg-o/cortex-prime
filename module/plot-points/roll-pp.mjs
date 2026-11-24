/**
 * A roll's plot points in Foundry (the Plot Points spec's P1, P4, P5, P6, P10, P15 and its
 * implementation notes; Decisions ADR-056). When a pool is rolled, its account and pool-stage lines
 * are stored on the roll card (`system.pp`); the roll-stage lines come from the stored Selection
 * whenever they are needed, so they are never stored twice. The card shows every line and warning,
 * the roller records SFX lines on it, and Settle writes all of them once, after Confirm. Nothing here
 * decides an amount: that is module/rules/plot-points.mjs.
 * @module plot-points/roll-pp
 */

import { poolPpFacts, ppChangeAllowed, ppTotals, rollPpFacts, settleRoll, validateSelection } from "../rules/index.mjs";
import { lineText, payerFor, postLedgerEntry, readAccount, writeBalance } from "./accounts.mjs";

/**
 * The account the lines of a roll with no payer are priced for: a player who rolled with no
 * character (PP-E17). The lines are a player's, so they're shown as a character's would be; there
 * is no account to settle them against.
 */
const NO_PAYER = Object.freeze({ kind: "actor", actorId: "-" });

/** @returns {{payer: null, poolLines: [], poolWarnings: [], sfxLines: [], otherLines: [], settled: false, ledgerId: null}} */
function emptyPp(payer = null) {
  return { payer, poolLines: [], poolWarnings: [], sfxLines: [], otherLines: [], settled: false, ledgerId: null };
}

/**
 * The entries of a pool as poolPpFacts reads them: each die that stands for an entry, with its
 * size and source. A doubled or overflow die repeats its original's source, Hinder's gain included,
 * so it is left out; a trait with several entries (RQ-032) carries its gain on the first only.
 * @param {import("../rules/types.mjs").PoolDie[]} pool - the pool as the builder holds it, with the
 *   trait marks rollablePool strips
 * @returns {{size: number, source: object, ppGained?: number}[]}
 */
export function poolPpEntries(pool) {
  return pool.filter(die => (die.origin !== "doubled") && (die.origin !== "overflow")).map(die => {
    const { kind, label, actorId, traitId, ppGained } = die.source;
    const source = { kind, label };
    if ( typeof actorId === "string" ) source.actorId = actorId;
    if ( typeof traitId === "string" ) source.traitId = traitId;
    const entry = { size: die.size, source };
    if ( Number.isInteger(ppGained) ) entry.ppGained = ppGained;
    return entry;
  });
}

/**
 * @param {{kind: string, actorId?: string|null}|null} stored - `system.pp.payer`
 * @returns {import("../rules/types.mjs").AccountRef|null}
 */
export function payerRef(stored) {
  if ( stored?.kind === "bank" ) return { kind: "bank" };
  if ( (stored?.kind === "actor") && stored.actorId ) return { kind: "actor", actorId: stored.actorId };
  return null;
}

/**
 * Stored lines as the rules read them: only the fields a line has, and usableThisRoll for a gain only.
 * @param {object[]} lines
 * @returns {import("../rules/types.mjs").PpLine[]}
 */
export function storedLines(lines) {
  return (lines ?? []).map(line => {
    const copy = { reason: line.reason, direction: line.direction, amount: line.amount };
    if ( line.label ) copy.label = line.label;
    if ( line.sourceId ) copy.sourceId = line.sourceId;
    if ( line.direction === "gain" ) copy.usableThisRoll = line.usableThisRoll === true;
    return copy;
  });
}

/**
 * What a pool's plot points are when it is rolled, as `system.pp` stores them (P1): the account of
 * the rolling actor, and the pool-stage lines and warnings. A pool the rules can't read gets no lines
 * and the console says why; the roll goes ahead (a roll is never blocked by PP, P5).
 * @param {object} input
 * @param {import("../rules/types.mjs").PoolDie[]} input.pool - the builder's pool, with its trait marks
 * @param {{extraTraits: {setId: string, count: number}[]}|null} input.traitCost - poolTraitReport's
 *   extra traits, or null for a pool without set traits
 * @param {Actor|null} input.actor - the rolling actor, named by its UUID, as a complication's holder is (ADR-057)
 * @returns {ReturnType<typeof emptyPp>}
 */
export function rollPpData({ pool, traitCost, actor }) {
  const payer = payerFor(actor);
  const facts = poolPpFacts({
    entries: poolPpEntries(pool), traitCost: traitCost ?? null, rollerActorId: actor?.uuid ?? null, payer: payer ?? NO_PAYER
  });
  if ( !facts.ok ) {
    console.warn(`cortex-prime | The pool's plot points couldn't be worked out: ${facts.code}`);
    return emptyPp(payer);
  }
  return { ...emptyPp(payer), poolLines: facts.value.lines, poolWarnings: facts.value.warnings };
}

/**
 * Every line of a roll, in the order the ledger lists them: the pool's, the paid counters', the SFX
 * lines recorded on the card and those other specs add (P10). The paid counters count only for a
 * selection validateSelection accepts (PP-E09); a confirmed roll's selection always is.
 * @param {object} system - a poolRoll's system data
 * @returns {{pool: import("../rules/types.mjs").PpLine[], paid: import("../rules/types.mjs").PpLine[],
 *   sfx: import("../rules/types.mjs").PpLine[], other: import("../rules/types.mjs").PpLine[],
 *   all: import("../rules/types.mjs").PpLine[], warnings: import("../rules/types.mjs").PpWarning[]}|null}
 *   null when the stored lines can't be read
 */
export function rollLines(system) {
  const pp = system.pp;
  if ( !pp ) return null;
  const sfx = storedLines(pp.sfxLines);
  const counted = (system.state === "resolved") || validateSelection(system.rolled, system.selection).valid;
  const { extraResultsPaid = 0, extraEffectDicePaid = 0 } = counted ? system.selection : {};
  const facts = rollPpFacts({
    selection: { extraResultsPaid, extraEffectDicePaid }, sfxLines: sfx, payer: payerRef(pp.payer) ?? NO_PAYER
  });
  if ( !facts.ok ) return null;
  const pool = storedLines(pp.poolLines);
  const other = storedLines(pp.otherLines);
  const paid = facts.value.lines.slice(0, facts.value.lines.length - sfx.length);
  const warnings = [...(pp.poolWarnings ?? []).map(w => ({ ...w })), ...facts.value.warnings];
  return { pool, paid, sfx, other, all: [...pool, ...facts.value.lines, ...other], warnings };
}

/**
 * @param {{code: string, count?: number, label?: string}} warning
 * @returns {string} the warning, localized, with its count or label where it has one
 */
function warningText(warning) {
  const key = `CORTEX.PlotPoints.Warnings.${warning.code}`;
  const text = game.i18n.has(key) ? game.i18n.localize(key) : warning.code;
  return warning.label ? `${text} (${warning.label})` : text;
}

/**
 * The account's name and stored balance, for the pool builder and the card. The bank's balance is
 * shown to GMs only.
 * @param {import("../rules/types.mjs").AccountRef|null} payer
 * @returns {{name: string, balance: number|null, read: ReturnType<typeof readAccount>}|null}
 */
function accountView(payer) {
  const read = payer ? readAccount(payer) : null;
  if ( !read ) return null;
  const name = read.actor?.name ?? game.i18n.localize("CORTEX.PlotPoints.Bank");
  return { name, balance: (read.actor || game.user.isGM) ? read.balance : null, read };
}

/**
 * The pool builder's plot point preview (P4): the payer's balance and what the pool's own lines
 * would change, with the warnings. Nothing is paid here.
 * @param {ReturnType<typeof rollPpData>} pp
 * @returns {{text: string|null, warnings: string[]}|null} null when the pool has no lines or warnings
 */
export function poolPpPreview(pp) {
  const lines = storedLines(pp.poolLines);
  if ( !lines.length && !pp.poolWarnings.length ) return null;
  const warnings = pp.poolWarnings.map(warningText);
  const account = accountView(payerRef(pp.payer));
  let text = null;
  if ( account && (account.balance !== null) ) {
    const totals = ppTotals({ balance: account.read.balance, lines });
    if ( totals.ok ) {
      text = game.i18n.format("CORTEX.PlotPoints.Preview", { name: account.name, balance: account.balance, net: signed(totals.value.net) });
      warnings.push(...totals.value.warnings.map(warningText));
    }
  }
  return { text, warnings };
}

/** @param {number} n @returns {string} n with its sign, such as "+1", "−2" or "0" */
function signed(n) {
  if ( n > 0 ) return `+${n}`;
  return (n < 0) ? `−${-n}` : "0";
}

/**
 * The card's plot point section (P4, P15): every line, the warnings and, before Settle, the
 * preview's warnings PP_SHORT and PP_NOT_YET_USABLE; the SFX lines with their controls for those
 * who may change the card; and Settle once the roll is confirmed, has an account and lines, and
 * isn't settled (PP-E17). Null for a roll with nothing to show or record.
 * @param {ChatMessage} message
 * @param {boolean} canEdit - whether the current user may change the card
 * @returns {object|null}
 */
export function prepareRollPp(message, canEdit) {
  const system = message.system;
  const pp = system.pp;
  const lines = rollLines(system);
  if ( !lines ) return null;
  const payer = payerRef(pp.payer);
  const editable = canEdit && !pp.settled;
  if ( !lines.all.length && !lines.warnings.length && !(editable && payer) ) return null;

  const warnings = lines.warnings.map(warningText);
  const account = accountView(payer);
  let net = null;
  if ( account ) {
    const totals = ppTotals({ balance: account.read.balance, lines: lines.all });
    if ( totals.ok ) {
      net = signed(totals.value.net);
      if ( !pp.settled ) warnings.push(...totals.value.warnings.map(warningText));
    }
  }
  const show = line => ({ text: lineText(line), later: (line.direction === "gain") && !line.usableThisRoll });
  return {
    account: account ? ((account.balance === null) ? account.name : `${account.name} · ${account.balance}`) : null,
    hasLines: lines.all.length > 0,
    lines: [...lines.pool, ...lines.paid, ...lines.other].map(show),
    sfx: lines.sfx.map((line, index) => ({ ...show(line), index, gain: line.direction === "gain", usable: line.usableThisRoll === true })),
    net, warnings, settled: pp.settled, editable,
    canSettle: canEdit && !pp.settled && (system.state === "resolved") && Boolean(account) && (lines.all.length > 0)
  };
}

/**
 * The next SFX lines for a card change (P15), or null to refuse it: a settled card's lines are
 * fixed. A gain starts as usable only after the roll; the roller may switch it on.
 * @param {object[]} stored - `system.pp.sfxLines`
 * @param {{action: string, kind?: string, label?: string, index?: string|number}} change
 * @returns {import("../rules/types.mjs").PpLine[]|null}
 */
export function nextSfxLines(stored, change) {
  const lines = storedLines(stored);
  const index = Number(change.index);
  switch ( change.action ) {
    case "sfx-add": {
      if ( !["gain", "spend"].includes(change.kind) ) return null;
      const gain = change.kind === "gain";
      const line = { reason: gain ? "SFX_GAIN" : "SFX_SPEND", direction: change.kind, amount: 1 };
      const label = (typeof change.label === "string") ? change.label.trim() : "";
      if ( label ) line.label = label;
      if ( gain ) line.usableThisRoll = false;
      return [...lines, line];
    }
    case "sfx-remove":
      if ( !Number.isInteger(index) || !lines[index] ) return null;
      return lines.filter((_line, i) => i !== index);
    case "sfx-usable":
      if ( !Number.isInteger(index) || (lines[index]?.direction !== "gain") ) return null;
      return lines.map((line, i) => ((i === index) ? { ...line, usableThisRoll: !line.usableThisRoll } : line));
    default:
      return null;
  }
}

/** The cards being settled in this browser, so a double click settles once. */
const settling = new Set();

/**
 * Settles a confirmed roll's plot points once (P4, P5, P9): every line through settleRoll in one
 * change of the payer's balance, then the card is marked settled and one ledger entry lists the
 * lines. A refusal writes nothing and the card keeps offering Settle. If the card can't be marked
 * settled, the balance is put back.
 * @param {ChatMessage} message - a poolRoll message
 * @returns {Promise<{ok: true, value: object}|{ok: false, code: string}|null>} null when this card is
 *   already being settled here
 */
export async function settleRollPp(message) {
  if ( settling.has(message.id) ) return null;
  settling.add(message.id);
  try {
    return await settle(message);
  }
  finally {
    settling.delete(message.id);
  }
}

/** @param {ChatMessage} message @returns {Promise<object>} settleRollPp's result */
async function settle(message) {
  const system = message.system;
  if ( !message.canUserModify(game.user, "update") ) return { ok: false, code: "PP_NOT_OWNER" };
  if ( system.state !== "resolved" ) return { ok: false, code: "PP_NOT_CONFIRMED" };
  const payer = payerRef(system.pp.payer);
  const read = payer ? readAccount(payer) : null;
  if ( !read ) return { ok: false, code: "PP_NO_ACCOUNT" };
  // Every roll reason has the same permission (P9): the PC's owner or a GM, and a GM for the bank.
  const allowed = ppChangeAllowed({
    accountKind: payer.kind, reason: "EXTRA_RESULT", isGM: game.user.isGM, isOwner: read.actor?.isOwner ?? false
  });
  if ( !allowed.ok ) return allowed;
  const lines = rollLines(system);
  if ( !lines ) return { ok: false, code: "INVALID_PP_INPUT" };
  if ( !lines.all.length ) return { ok: false, code: "PP_NO_LINES" };
  const settled = settleRoll({ balance: read.balance, lines: lines.all, settled: system.pp.settled });
  if ( !settled.ok ) return settled;

  const { balance, delta } = settled.value;
  try {
    if ( delta !== 0 ) await writeBalance(read, balance);
  }
  catch( err ) {
    console.error(err);
    return { ok: false, code: "WRITE_FAILED" };
  }
  try {
    await message.update({ "system.pp.settled": true });
  }
  catch( err ) {
    console.error(err);
    if ( delta !== 0 ) await writeBalance(read, read.balance).catch(console.error);
    return { ok: false, code: "WRITE_FAILED" };
  }
  try {
    const entry = await postLedgerEntry({
      account: payer, actor: read.actor, delta, balance, reason: "ROLL", messageRef: message.id, lines: settled.value.lines
    });
    if ( entry ) await message.update({ "system.pp.ledgerId": entry.id });
  }
  catch( err ) {
    // The balance and the card agree; only the record is missing, so the settle stands.
    console.error(err);
  }
  return settled;
}
