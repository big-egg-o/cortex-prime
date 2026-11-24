/**
 * Quench batch "cortex-prime.plot-points": PC balances, the GM's bank and the ledger in Foundry
 * (Decisions ADR-056; the Plot Points spec's P1 to P3, P5, P7, P9). Runs as a GM. Every actor and
 * ledger message the batch makes carries a test flag or names a test actor and is deleted after
 * each test; the bank is put back afterwards.
 * @module tests/quench/plot-points
 */

import {
  BANK_SETTING, changePlotPoints, getBank, payerFor, sessionCharacters, startPlotPointSession
} from "../../module/plot-points/accounts.mjs";
import PlotPointsApp from "../../module/apps/plot-points-app.mjs";

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
            const updated = new Promise(resolve => Hooks.once("updateActor", resolve));
            sheet.element.querySelector('[data-action="ppGain"]').click();
            await updated;
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
