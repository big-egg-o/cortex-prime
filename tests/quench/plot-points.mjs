/**
 * Quench batch "cortex-prime.plot-points": PC balances, the GM's bank and the ledger in Foundry
 * (Decisions ADR-056; the Plot Points spec's P1 to P5, P7, P9), and settling a roll card's plot
 * points (P4, P6, P10, P15). Runs as a GM. Every actor and
 * ledger message the batch makes carries a test flag or names a test actor and is deleted after
 * each test, with the batch's roll cards; the bank is put back afterwards.
 * @module tests/quench/plot-points
 */

import {
  BANK_SETTING, changePlotPoints, getBank, payerFor, sessionCharacters, startPlotPointSession
} from "../../module/plot-points/accounts.mjs";
import { rollPpData, settleRollPp, storedLines } from "../../module/plot-points/roll-pp.mjs";
import PlotPointsApp from "../../module/apps/plot-points-app.mjs";
import { applyCardChange } from "../../module/dice/card-actions.mjs";
import { preparePoolRollCardContext } from "../../module/dice/pool-roll-card.mjs";
import { postPoolRoll } from "../../module/dice/post-pool-roll.mjs";
import { prepareContestCardContext } from "../../module/contest/contest-card.mjs";
import { handleContestQuery } from "../../module/contest/relay.mjs";
import { initialSystem } from "../../module/data/chat/contest-mapping.mjs";
import { contestPpRecord } from "../../module/plot-points/contest-pp.mjs";
import { createContest } from "../../module/rules/index.mjs";

const SYSTEM_ID = "cortex-prime";
const TEST_FLAG = "quenchPlotPoints";

/** @returns {Promise<Actor>} a flagged test PC holding `plotPoints` */
function createPc(plotPoints = 0, name = "pc") {
  return Actor.implementation.create({
    name: `[Quench PP] ${name}`, type: "pc", system: { plotPoints }, flags: { [SYSTEM_ID]: { [TEST_FLAG]: true } }
  });
}

/** @returns {ChatMessage[]} the ledger entries made since `since` */
function ledgerSince(since) {
  return game.messages.filter(m => (m.type === "plotPoints") && !since.has(m.id));
}

/** Deletes the batch's actors and every ledger entry not in `keep`. */
async function cleanUp(keep = new Set()) {
  const actors = game.actors.filter(a => a.getFlag(SYSTEM_ID, TEST_FLAG)).map(a => a.id);
  if ( actors.length ) await Actor.implementation.deleteDocuments(actors);
  const messages = game.messages.filter(m => (m.type === "plotPoints") && !keep.has(m.id)).map(m => m.id);
  if ( messages.length ) await ChatMessage.implementation.deleteDocuments(messages);
}

/**
 * Posts a roll of four d8s with fixed results, three of them a total with one paid extra result
 * when `paid` is set, and the given plot points.
 * @param {object} pp - system.pp, over an empty one
 * @returns {Promise<ChatMessage>}
 */
function postRoll(pp) {
  const results = [6, 5, 4, 3];
  const pool = results.map((_r, i) => ({ id: `d${i + 1}`, size: 8, source: { kind: "custom", label: `Die ${i + 1}` }, origin: "rating" }));
  return postPoolRoll({
    pool, results,
    pp: { payer: null, poolLines: [], poolWarnings: [], sfxLines: [], otherLines: [], settled: false, ledgerId: null, ...pp }
  });
}

/** Picks three dice for the total with one paid extra result, and confirms. */
async function confirmWithExtraResult(message) {
  await message.update({ system: { selection: { totalIds: ["d1", "d2", "d3"], effectDieIds: ["d4"], extraResultsPaid: 1 } } });
  await applyCardChange(message, { action: "confirm" });
  assert_(message.system.state === "resolved", "the roll was confirmed");
}

/** @param {boolean} condition @param {string} what */
function assert_(condition, what) {
  if ( !condition ) throw new Error(`setup failed: ${what}`);
}

/**
 * Deletes the ledger entries that refer to the given messages, for the batches whose contests pay
 * plot points for giving in (P8).
 * @param {string[]} messageIds
 * @returns {Promise<void>}
 */
export async function deleteLedgerFor(messageIds) {
  const ids = game.messages.filter(m => (m.type === "plotPoints") && messageIds.includes(m.system.messageRef)).map(m => m.id);
  if ( ids.length ) await ChatMessage.implementation.deleteDocuments(ids);
}

/** @param {object} quench */
export function registerPlotPointsBatch(quench) {
  quench.registerBatch(
    "cortex-prime.plot-points",
    ({ describe, it, assert, before, after, afterEach }) => {
      let bank;
      let before_;
      before(async () => {
        before_ = new Set(game.messages.filter(m => m.type === "plotPoints").map(m => m.id));
        await cleanUp(before_);
        bank = getBank();
      });
      afterEach(async () => {
        const rolls = game.messages.filter(m => (m.type === "poolRoll") && m.system.pool.some(d => d.source.label === "Die 1")
          && (m.system.pp.payer !== null || m.system.pp.poolLines.length > 0)).map(m => m.id);
        if ( rolls.length ) await ChatMessage.implementation.deleteDocuments(rolls);
        const contests = game.messages.filter(m => (m.type === "contest") && m.system.sides.some(side => side.label.startsWith("[Quench PP]")));
        if ( contests.length ) await ChatMessage.implementation.deleteDocuments(contests.map(m => m.id));
        await cleanUp(before_);
        await game.settings.set(SYSTEM_ID, BANK_SETTING, bank);
      });
      after(() => foundry.applications.instances.get("cortex-prime-plot-points")?.close());

      describe("changePlotPoints", () => {
        it("PP-06 an award of 1 to a PC holding 2 gives 3 and posts one ledger entry", async () => {
          const pc = await createPc(2, "award");
          const result = await changePlotPoints({ account: { kind: "actor", actorId: pc.id }, delta: 1, reason: "AWARD" });
          assert.deepEqual(result, { ok: true, value: { balance: 3 } });
          assert.equal(pc.system.plotPoints, 3);
          const entries = ledgerSince(before_);
          assert.lengthOf(entries, 1);
          const { system } = entries[0];
          assert.deepInclude(system.account.toObject?.() ?? system.account, { kind: "actor", actorId: pc.id, name: pc.name });
          assert.equal(system.delta, 1);
          assert.equal(system.balance, 3);
          assert.equal(system.reason, "AWARD");
          assert.isFalse(system.adjustment);
        });

        it("PP-E06 a spend below zero is refused; nothing is written or posted", async () => {
          const pc = await createPc(0, "short");
          const result = await changePlotPoints({ account: { kind: "actor", actorId: pc.id }, delta: -1, reason: "STAY_IN" });
          assert.deepEqual(result, { ok: false, code: "PP_INSUFFICIENT" });
          assert.equal(pc.system.plotPoints, 0);
          assert.lengthOf(ledgerSince(before_), 0);
        });

        it("a GM adjustment of the bank is stored in the setting and marked as an adjustment", async () => {
          await game.settings.set(SYSTEM_ID, BANK_SETTING, 2);
          const result = await changePlotPoints({ account: { kind: "bank" }, delta: -1, reason: "GM_ADJUST" });
          assert.isTrue(result.ok);
          assert.equal(getBank(), 1);
          const [entry] = ledgerSince(before_);
          assert.equal(entry.system.account.kind, "bank");
          assert.isTrue(entry.system.adjustment);
        });

        it("a GMC holds no plot points of its own: PP_NO_ACCOUNT", async () => {
          const gmc = await Actor.implementation.create({
            name: "[Quench PP] gmc", type: "gmc", flags: { [SYSTEM_ID]: { [TEST_FLAG]: true } }
          });
          const result = await changePlotPoints({ account: { kind: "actor", actorId: gmc.id }, delta: 1, reason: "AWARD" });
          assert.deepEqual(result, { ok: false, code: "PP_NO_ACCOUNT" });
        });

        it("a ledger entry outlives its PC with the name it had (PP-E10)", async () => {
          const pc = await createPc(0, "gone");
          await changePlotPoints({ account: { kind: "actor", actorId: pc.id }, delta: 1, reason: "AWARD" });
          await pc.delete();
          const [entry] = ledgerSince(before_);
          assert.equal(entry.system.account.name, "[Quench PP] gone");
        });
      });

      describe("payerFor (P1)", () => {
        it("a PC pays itself; a GMC and a GM's roll without an actor pay from the bank", async () => {
          const pc = await createPc(0, "payer");
          const gmc = await Actor.implementation.create({
            name: "[Quench PP] gmc payer", type: "gmc", flags: { [SYSTEM_ID]: { [TEST_FLAG]: true } }
          });
          assert.deepEqual(payerFor(pc), { kind: "actor", actorId: pc.id });
          assert.deepEqual(payerFor(gmc), { kind: "bank" });
          assert.deepEqual(payerFor(null), { kind: "bank" });
        });
      });

      describe("startPlotPointSession (P7; RQ-036, RQ-037)", () => {
        it("raises assigned PCs below 1 to 1 and adds 1 per player to the bank", async function() {
          const player = game.users.find(u => !u.isGM);
          if ( !player ) return this.skip();
          const previous = player.character;
          const pc = await createPc(0, "session");
          await player.update({ character: pc.id });
          try {
            await game.settings.set(SYSTEM_ID, BANK_SETTING, 1);
            const expectedPlayers = sessionCharacters().length;
            const result = await startPlotPointSession();
            assert.isTrue(result.ok);
            assert.equal(pc.system.plotPoints, 1);
            assert.equal(getBank(), 1 + expectedPlayers);
            const reasons = ledgerSince(before_).map(m => m.system.reason);
            assert.include(reasons, "SESSION_START");
          }
          finally {
            await player.update({ character: previous?.id ?? null });
          }
        });
      });

      describe("settling a roll (P4)", () => {
        const actorPayer = pc => ({ kind: "actor", actorId: pc.id });

        it("rollPpData stores the rolling PC as payer and Hinder's usable gain (P1, RQ-039)", async () => {
          const pc = await createPc(0, "hinder");
          const pool = [{ id: "d1", size: 4, origin: "rating", source: { kind: "trait", actorId: pc.id, traitId: "t1", label: "Sneaky", ppGained: 1 } }];
          const pp = rollPpData({ pool, traitCost: null, actor: pc });
          assert.deepEqual(pp.payer, actorPayer(pc));
          assert.deepEqual(pp.poolLines, [{ reason: "HINDER", direction: "gain", amount: 1, label: "Sneaky", sourceId: "t1", usableThisRoll: true }]);
          assert.deepEqual(rollPpData({ pool, traitCost: null, actor: null }).payer, { kind: "bank" }, "a GM with no actor pays from the bank");
        });

        it("offers Settle once confirmed, writes every line once and records them on one ledger entry", async () => {
          const pc = await createPc(2, "settle");
          const message = await postRoll({ payer: actorPayer(pc) });
          assert.isFalse(preparePoolRollCardContext(message).pp.canSettle, "not before Confirm");
          await confirmWithExtraResult(message);
          assert.isTrue(preparePoolRollCardContext(message).pp.canSettle);

          const result = await settleRollPp(message);
          assert.isTrue(result.ok);
          assert.equal(pc.system.plotPoints, 1);
          assert.isTrue(message.system.pp.settled);
          const entries = ledgerSince(before_);
          assert.lengthOf(entries, 1);
          assert.equal(entries[0].system.reason, "ROLL");
          assert.equal(entries[0].system.delta, -1);
          assert.equal(entries[0].system.messageRef, message.id);
          // Optional fields a line doesn't have may be kept as empty values; storedLines reads them as the rules do.
          assert.deepEqual(storedLines(entries[0].system.toObject().lines), [{ reason: "EXTRA_RESULT", direction: "spend", amount: 1 }]);
          assert.equal(message.system.pp.ledgerId, entries[0].id);
          assert.isFalse(preparePoolRollCardContext(message).pp.canSettle, "not twice");

          assert.deepEqual(await settleRollPp(message), { ok: false, code: "PP_ALREADY_SETTLED" });
          assert.equal(pc.system.plotPoints, 1);
          assert.lengthOf(ledgerSince(before_), 1);
        });

        it("PP-E04 a reroll before Confirm keeps the paid counter, and the roll is charged once", async () => {
          const pc = await createPc(3, "reroll");
          const message = await postRoll({ payer: actorPayer(pc) });
          await applyCardChange(message, { action: "increment-extra-results" });
          await applyCardChange(message, { action: "reroll", dieIds: ["d1"], results: { d1: 7 } });
          assert.equal(message.system.selection.extraResultsPaid, 1, "the counter is kept (P6)");
          await confirmWithExtraResult(message);
          assert.isTrue((await settleRollPp(message)).ok);
          assert.equal(pc.system.plotPoints, 2);
        });

        it("P5 a refused settle writes nothing and keeps offering Settle", async () => {
          const pc = await createPc(0, "refused");
          const message = await postRoll({ payer: actorPayer(pc) });
          await confirmWithExtraResult(message);
          assert.deepEqual(await settleRollPp(message), { ok: false, code: "PP_INSUFFICIENT" });
          assert.equal(pc.system.plotPoints, 0);
          assert.isFalse(message.system.pp.settled);
          assert.lengthOf(ledgerSince(before_), 0);
          assert.isTrue(preparePoolRollCardContext(message).pp.canSettle);
          assert.include(preparePoolRollCardContext(message).pp.warnings,
            game.i18n.localize("CORTEX.PlotPoints.Warnings.PP_SHORT"));
        });

        it("P10 a gain from the roll's own dice can't pay for it: PP_NOT_YET_USABLE", async () => {
          const pc = await createPc(0, "later");
          const message = await postRoll({
            payer: actorPayer(pc), otherLines: [{ reason: "HITCH_COMPLICATION", direction: "gain", amount: 1, usableThisRoll: false }]
          });
          await confirmWithExtraResult(message);
          assert.deepEqual(await settleRollPp(message), { ok: false, code: "PP_NOT_YET_USABLE" });
          assert.equal(pc.system.plotPoints, 0);
        });

        it("P15 an SFX gain switched to usable pays for the roll; a net change of 0 is still recorded", async () => {
          const pc = await createPc(0, "sfx");
          const message = await postRoll({ payer: actorPayer(pc) });
          await applyCardChange(message, { action: "sfx-add", kind: "gain", label: "Lucky" });
          await applyCardChange(message, { action: "sfx-usable", index: "0" });
          await confirmWithExtraResult(message);
          const result = await settleRollPp(message);
          assert.isTrue(result.ok);
          assert.equal(result.value.delta, 0);
          assert.equal(pc.system.plotPoints, 0);
          assert.isTrue(message.system.pp.settled);
          assert.lengthOf(ledgerSince(before_)[0].system.lines, 2);
          await applyCardChange(message, { action: "sfx-add", kind: "spend" });
          assert.lengthOf(message.system.pp.sfxLines, 1, "a settled card's lines are fixed");
        });

        it("a GM settles a bank payment from the bank (rule 17)", async () => {
          await game.settings.set(SYSTEM_ID, BANK_SETTING, 2);
          const message = await postRoll({ payer: { kind: "bank", actorId: null } });
          await confirmWithExtraResult(message);
          assert.isTrue((await settleRollPp(message)).ok);
          assert.equal(getBank(), 1);
        });

        it("PP-E17 a roll with no payer shows its lines but offers no Settle", async () => {
          const message = await postRoll({ poolLines: [{ reason: "EXTRA_TRAIT", direction: "spend", amount: 1, sourceId: "s" }] });
          await confirmWithExtraResult(message);
          const pp = preparePoolRollCardContext(message).pp;
          assert.lengthOf(pp.lines, 2);
          assert.isFalse(pp.canSettle);
          assert.deepEqual(await settleRollPp(message), { ok: false, code: "PP_NO_ACCOUNT" });
        });
      });

      describe("the test and contest card (P8)", () => {
        const gm = () => game.user;
        const act = (message, action, payload = {}) => handleContestQuery(
          { action, messageId: message.id, revision: message.system.revision, payload }, { user: gm() }
        );
        const ok = async (message, action, payload) => {
          const result = await act(message, action, payload);
          assert.isTrue(result.ok, `${action}: ${result.code}`);
        };
        const side = (key, actor) => ({ key, userId: null, actorUuid: actor?.uuid ?? null, label: actor?.name ?? `[Quench PP] ${key}` });

        /** A contest between a PC and a side the bank holds for, the PC initiating or opposing. */
        async function contest(pc, { pcInitiates = true } = {}) {
          const sides = pcInitiates ? [side("initiator", pc), side("opposition")] : [side("initiator"), side("opposition", pc)];
          const system = initialSystem({ type: "contest", state: createContest().value, startedBy: gm().id, sides }).value;
          return ChatMessage.implementation.create({ type: "contest", system });
        }

        /** High stakes, the initiator 15 with a d10, the opposition fails with 12 and a d6: the opposition is taken out. */
        async function takenOut(message) {
          await ok(message, "set-high-stakes", { highStakes: true });
          await ok(message, "add-roll", { side: "initiator", total: 15, effectSizes: [10] });
          await ok(message, "add-roll", { side: "opposition", total: 12, effectSizes: [6] });
        }

        it("PP-04 a PC who gives in after rolling gains 1 PP in the same action; the bank doesn't change", async () => {
          const pc = await createPc(0, "gives in");
          await game.settings.set(SYSTEM_ID, BANK_SETTING, 3);
          const message = await contest(pc);
          await ok(message, "add-roll", { side: "initiator", total: 11, effectSizes: [6] });
          await ok(message, "add-roll", { side: "opposition", total: 14, effectSizes: [8] });
          await ok(message, "give-in", { side: "initiator" });
          assert.equal(pc.system.plotPoints, 1);
          assert.equal(getBank(), 3);
          assert.equal(contestPpRecord(message).giveIn.side, "initiator");
          const entry = ledgerSince(before_).find(m => m.system.reason === "GIVE_IN");
          assert.equal(entry?.system.messageRef, message.id);
        });

        it("RQ-038 a GMC side that gives in after rolling earns into the bank; PP-05 a decline earns nothing", async () => {
          const pc = await createPc(0, "opponent");
          await game.settings.set(SYSTEM_ID, BANK_SETTING, 0);
          const message = await contest(pc);
          await ok(message, "add-roll", { side: "initiator", total: 11, effectSizes: [6] });
          await ok(message, "add-roll", { side: "opposition", total: 14, effectSizes: [8] });
          await ok(message, "add-roll", { side: "initiator", total: 16, effectSizes: [6] });
          await ok(message, "give-in", { side: "opposition" });
          assert.equal(getBank(), 1);
          assert.equal(pc.system.plotPoints, 0);

          const declined = await contest(pc);
          await ok(declined, "add-roll", { side: "initiator", total: 11, effectSizes: [6] });
          await ok(declined, "decline", {});
          assert.isNull(contestPpRecord(declined).giveIn);
          assert.equal(getBank(), 1);
        });

        it("PP-28 a taken-out PC pays 1 PP to stay in, for the winner's die; the end choices are then fixed", async () => {
          const pc = await createPc(1, "stays in");
          const message = await contest(pc, { pcInitiates: false });
          await takenOut(message);
          assert.deepEqual(await act(message, "stay-in"), { ok: false, code: "PP_PICK_FIRST" });
          await ok(message, "use-against-loser", { effectIds: ["e1"] });
          assert.equal(prepareContestCardContext(message).pp.offer?.text, game.i18n.format("CORTEX.PlotPoints.StayIn.One", { sizes: "d10" }));

          await ok(message, "stay-in");
          assert.equal(pc.system.plotPoints, 0);
          assert.deepInclude(contestPpRecord(message).stayIn, { side: "opposition", route: "pay" });
          assert.deepEqual(contestPpRecord(message).stayIn.complications, [{ effectId: "e1", size: 10 }]);
          assert.deepEqual(await act(message, "use-against-loser", { effectIds: ["e1"] }), { ok: false, code: "PP_STAYED_IN" });
          assert.deepEqual(await act(message, "stay-in"), { ok: false, code: "PP_ALREADY_SETTLED" });
          assert.isNull(prepareContestCardContext(message).pp.offer);
        });

        it("PP-E06 a PC holding 0 can't stay in; nothing is written", async () => {
          const pc = await createPc(0, "broke");
          const message = await contest(pc, { pcInitiates: false });
          await takenOut(message);
          await ok(message, "use-against-loser", { effectIds: ["e1"] });
          assert.deepEqual(await act(message, "stay-in"), { ok: false, code: "PP_INSUFFICIENT" });
          assert.isNull(contestPpRecord(message).stayIn);
        });

        it("RQ-042 a GMC stays in from the bank and the winning PC gains nothing; PP-E07 an empty bank can't", async () => {
          const pc = await createPc(2, "winner");
          await game.settings.set(SYSTEM_ID, BANK_SETTING, 1);
          const message = await contest(pc);
          await takenOut(message);
          await ok(message, "use-against-loser", { effectIds: ["e1"] });
          await ok(message, "stay-in");
          assert.equal(getBank(), 0);
          assert.equal(pc.system.plotPoints, 2);
          assert.equal(contestPpRecord(message).stayIn.route, "bank");

          const again = await contest(pc);
          await takenOut(again);
          await ok(again, "use-against-loser", { effectIds: ["e1"] });
          assert.deepEqual(await act(again, "stay-in"), { ok: false, code: "PP_INSUFFICIENT" });
        });

        it("RQ-044 after a failed high-stakes test with no opposition die, the GM sizes the complication", async () => {
          const pc = await createPc(1, "tested");
          const started = await handleContestQuery({
            action: "start", type: "test", difficulty: 12,
            sides: [side("roller", pc), side("setter")]
          }, { user: gm() });
          assert.isTrue(started.ok, started.code);
          const message = game.messages.get(started.value.messageId);
          await ok(message, "set-high-stakes", { highStakes: true });
          await ok(message, "add-roll", { side: "roller", total: 10, effectSizes: [6] });
          assert.deepEqual(prepareContestCardContext(message).pp.offer.test.effects, []);

          assert.deepEqual(await act(message, "stay-in", {}), { ok: false, code: "PP_GM_SIZE_NEEDED" });
          await ok(message, "stay-in", { gmSize: 6 });
          assert.equal(pc.system.plotPoints, 0);
          assert.deepEqual(contestPpRecord(message).stayIn.complications, [{ effectId: null, size: 6 }]);
          assert.deepEqual(contestPpRecord(message).stayIn.answers, { overflowApplies: false, gmSize: 6 });
        });
      });

      describe("the GM's overview and the sheet", () => {
        it("the overview lists the bank and a PC's balance", async () => {
          await game.settings.set(SYSTEM_ID, BANK_SETTING, 4);
          const pc = await createPc(2, "overview");
          const app = await PlotPointsApp.open();
          const text = app.element.textContent;
          assert.include(text, "[Quench PP] overview");
          assert.equal(app.element.querySelector(".cp-pp-bank .cp-pp-balance").textContent.trim(), "4");
          assert.exists(app.element.querySelector(`[data-action="award"][data-actor-id="${pc.id}"]`));
        });

        it("the sheet's + button awards 1 PP and records it", async () => {
          const pc = await createPc(1, "sheet");
          const sheet = await pc.sheet.render({ force: true });
          try {
            // The ledger entry is posted after the balance is written, so wait for it, not the update.
            const recorded = new Promise(resolve => {
              const id = Hooks.on("createChatMessage", message => {
                if ( message.type !== "plotPoints" ) return;
                Hooks.off("createChatMessage", id);
                resolve();
              });
            });
            sheet.element.querySelector('[data-action="ppGain"]').click();
            await recorded;
            assert.equal(pc.system.plotPoints, 2);
            assert.equal(ledgerSince(before_)[0]?.system.reason, "AWARD");
          }
          finally {
            await sheet.close({ animate: false });
          }
        });
      });
    },
    { displayName: "Cortex Prime: plot points" }
  );
}
