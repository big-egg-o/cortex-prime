/**
 * Quench batch "cortex-prime.trait-store": the temporary trait store, its GM handler and the
 * tracker in Foundry (Decisions ADR-057, step 4.8a). Runs as a GM. The store and the bank are put
 * back after each test; every actor, scene and ledger entry the batch makes is deleted.
 * @module tests/quench/trait-store
 */

import {
  TRAIT_STORE_SETTING, getTraitStore, handleTraitStoreQuery, newActionId, sendTraitStoreRequest
} from "../../module/assets/trait-store.mjs";
import { BANK_SETTING, getBank } from "../../module/plot-points/accounts.mjs";
import TraitTrackerApp, { knownHolders } from "../../module/apps/trait-tracker-app.mjs";

const SYSTEM_ID = "cortex-prime";
const TEST_FLAG = "quenchTraitStore";
const PREFIX = "[Quench Traits]";

/** @returns {Promise<Actor>} a flagged test actor */
function createActor(type, name, system = {}) {
  return Actor.implementation.create({ name: `${PREFIX} ${name}`, type, system, flags: { [SYSTEM_ID]: { [TEST_FLAG]: true } } });
}

/** @returns {Promise<{scene: Scene, guards: TokenDocument[]}>} a scene with two unlinked tokens of one GMC */
async function twoGuards() {
  const gmc = await createActor("gmc", "Guard");
  const scene = await getDocumentClass("Scene").create({ name: `${PREFIX} Docks`, flags: { [SYSTEM_ID]: { [TEST_FLAG]: true } } });
  const data = [];
  for ( const [i, name] of ["Guard A", "Guard B"].entries() ) {
    const token = await gmc.getTokenDocument({ x: 100 * (i + 1), y: 100, name, actorLink: false });
    data.push(token.toObject());
  }
  const guards = await scene.createEmbeddedDocuments("Token", data);
  return { scene, guards };
}

/** @returns {ChatMessage[]} the ledger entries not in `keep` */
function ledgerSince(keep) {
  return game.messages.filter(m => (m.type === "plotPoints") && !keep.has(m.id));
}

/** A request made by hand, for retries and races. */
function request(action, payload, revision = getTraitStore().revision, actionId = newActionId()) {
  return { action, actionId, revision, payload };
}

/** @param {object} quench */
export function registerTraitStoreBatch(quench) {
  quench.registerBatch(
    "cortex-prime.trait-store",
    ({ describe, it, assert, before, afterEach, after }) => {
      let stored;
      let bank;
      let messages;
      before(() => {
        stored = foundry.utils.deepClone(game.settings.get(SYSTEM_ID, TRAIT_STORE_SETTING).toObject());
        bank = getBank();
        messages = new Set(game.messages.map(m => m.id));
      });
      afterEach(async () => {
        await game.settings.set(SYSTEM_ID, TRAIT_STORE_SETTING, stored);
        await game.settings.set(SYSTEM_ID, BANK_SETTING, bank);
        const actors = game.actors.filter(a => a.getFlag(SYSTEM_ID, TEST_FLAG)).map(a => a.id);
        if ( actors.length ) await Actor.implementation.deleteDocuments(actors);
        const scenes = game.scenes.filter(s => s.getFlag(SYSTEM_ID, TEST_FLAG)).map(s => s.id);
        if ( scenes.length ) await getDocumentClass("Scene").deleteDocuments(scenes);
        const made = game.messages.filter(m => !messages.has(m.id)).map(m => m.id);
        if ( made.length ) await ChatMessage.implementation.deleteDocuments(made);
      });
      after(() => foundry.applications.instances.get("cortex-prime-trait-tracker")?.close());

      describe("two unlinked copies of one opponent", () => {
        it("a complication on one guard leaves the other alone; its note survives a step", async () => {
          const { guards } = await twoGuards();
          const [a, b] = guards.map(t => t.actor.uuid);
          assert.notEqual(a, b);
          const id = foundry.utils.randomID(16);
          let result = await sendTraitStoreRequest("addComplication", {
            id, name: "Dust-Blinded", size: 6, holder: { kind: "actor", actorId: a }
          });
          assert.isTrue(result.ok, result.code);
          result = await sendTraitStoreRequest("setNote", { traitId: id, note: "Affects sight." });
          assert.isTrue(result.ok, result.code);
          result = await sendTraitStoreRequest("step", { traitId: id, steps: 1 });
          assert.isTrue(result.ok, result.code);
          const store = getTraitStore();
          const trait = store.traits.find(t => t.id === id);
          assert.deepEqual(trait.dice, [8]);
          assert.equal(store.notes[id], "Affects sight.");
          assert.isFalse(store.traits.some(t => t.holder.actorId === b));
          const holders = knownHolders().map(h => h.actorKey);
          assert.include(holders, a);
          assert.include(holders, b);
          result = await sendTraitStoreRequest("step", { traitId: id, steps: -4 });
          assert.deepEqual(result.value.removedIds, [id]);
          assert.isUndefined(getTraitStore().notes[id]);
        });
      });

      describe("the GM handler", () => {
        it("refuses a tracker action from a player and a player's action for a character they don't own", async () => {
          const player = { id: "quenchPlayer0000", isGM: false, name: "Player" };
          const pc = await createActor("pc", "Ana", { plotPoints: 2 });
          const before = getTraitStore().revision;
          let result = await handleTraitStoreQuery(request("addComplication", {
            id: foundry.utils.randomID(16), name: "Winded", size: 6, holder: { kind: "unassigned" }
          }), { user: player });
          assert.deepEqual(result, { ok: false, code: "GM_ONLY" });
          result = await handleTraitStoreQuery(request("buyAsset", {
            id: foundry.utils.randomID(16), name: "Rope", holder: { kind: "actor", actorId: pc.uuid }
          }), { user: player });
          assert.deepEqual(result, { ok: false, code: "NOT_YOUR_CHARACTER" });
          assert.equal(getTraitStore().revision, before);
          assert.equal(pc.system.plotPoints, 2);
        });

        it("two requests made against the same revision: one is done, the other is stale", async () => {
          const revision = getTraitStore().revision;
          const make = name => request("addComplication", {
            id: foundry.utils.randomID(16), name, size: 6, holder: { kind: "unassigned" }
          }, revision);
          const results = await Promise.all([
            handleTraitStoreQuery(make("First"), { user: game.user }),
            handleTraitStoreQuery(make("Second"), { user: game.user })
          ]);
          assert.deepEqual(results.map(r => r.ok), [true, false]);
          assert.equal(results[1].code, "STALE_REVISION");
          assert.equal(getTraitStore().revision, revision + 1);
        });
      });

      describe("buying an asset (one batch write)", () => {
        it("writes the asset, the balance and one ledger entry; a retry changes nothing", async () => {
          const pc = await createActor("pc", "Ana", { plotPoints: 2 });
          const req = request("buyAsset", { id: foundry.utils.randomID(16), name: "Rope", holder: { kind: "actor", actorId: pc.uuid } });
          const first = await handleTraitStoreQuery(req, { user: game.user });
          assert.isTrue(first.ok, first.code);
          assert.equal(pc.system.plotPoints, 1);
          assert.lengthOf(getTraitStore().traits.filter(t => t.id === req.payload.id), 1);
          const entries = ledgerSince(messages);
          assert.lengthOf(entries, 1);
          assert.equal(entries[0].system.reason, "ASSET_CREATE");
          assert.equal(entries[0].system.balance, 1);
          const again = await handleTraitStoreQuery(req, { user: game.user });
          assert.isTrue(again.ok);
          assert.isTrue(again.value.replayed);
          assert.equal(pc.system.plotPoints, 1);
          assert.lengthOf(ledgerSince(messages), 1);
          assert.lengthOf(getTraitStore().traits.filter(t => t.id === req.payload.id), 1);
        });

        it("refuses an unaffordable purchase without changing the store, the balance or the ledger", async () => {
          const pc = await createActor("pc", "Broke", { plotPoints: 0 });
          const before = getTraitStore();
          const result = await sendTraitStoreRequest("buyAsset", {
            id: foundry.utils.randomID(16), name: "Rope", holder: { kind: "actor", actorId: pc.uuid }
          });
          assert.deepEqual(result, { ok: false, code: "PP_INSUFFICIENT" });
          assert.deepEqual(getTraitStore(), before);
          assert.equal(pc.system.plotPoints, 0);
          assert.lengthOf(ledgerSince(messages), 0);
        });

        it("works as the first write in a world with no stored store", async () => {
          const doc = game.settings.get(SYSTEM_ID, TRAIT_STORE_SETTING, { document: true });
          if ( doc?._id ) await doc.delete();
          assert.equal(getTraitStore().revision, 0);
          const pc = await createActor("pc", "First", { plotPoints: 1 });
          const result = await sendTraitStoreRequest("buyAsset", {
            id: foundry.utils.randomID(16), name: "Lantern", holder: { kind: "actor", actorId: pc.uuid }
          });
          assert.isTrue(result.ok, result.code);
          assert.equal(getTraitStore().revision, 1);
          assert.equal(pc.system.plotPoints, 0);
          assert.isOk(game.settings.get(SYSTEM_ID, TRAIT_STORE_SETTING, { document: true })?._id);
        });

        it("a GMC's bought asset is paid from the bank", async () => {
          await game.settings.set(SYSTEM_ID, BANK_SETTING, 2);
          const gmc = await createActor("gmc", "Boss");
          const result = await sendTraitStoreRequest("buyAsset", {
            id: foundry.utils.randomID(16), name: "Net", holder: { kind: "actor", actorId: gmc.uuid }
          });
          assert.isTrue(result.ok, result.code);
          assert.equal(getBank(), 1);
          assert.equal(ledgerSince(messages)[0].system.account.kind, "bank");
        });
      });

      describe("End scene", () => {
        it("ends the scene's traits and keeps an unassigned complication for review", async () => {
          const alarm = foundry.utils.randomID(16);
          const smoke = foundry.utils.randomID(16);
          await sendTraitStoreRequest("addComplication", { id: alarm, name: "Alarm Raised", size: 8, holder: { kind: "unassigned" } });
          await sendTraitStoreRequest("addAsset", { id: smoke, name: "Smoke", size: 6, holder: { kind: "scene" } });
          const result = await sendTraitStoreRequest("endScene", {});
          assert.isTrue(result.ok, result.code);
          assert.deepEqual(result.value.removedIds, [smoke]);
          const ids = getTraitStore().traits.map(t => t.id);
          assert.include(ids, alarm);
          assert.notInclude(ids, smoke);
        });
      });

      describe("the tracker", () => {
        it("opens with every sheet closed and lists an unassigned complication with its note", async () => {
          const id = foundry.utils.randomID(16);
          await sendTraitStoreRequest("addComplication", { id, name: "Alarm Raised", size: 8, holder: { kind: "unassigned" } });
          await sendTraitStoreRequest("setNote", { traitId: id, note: "Whole district" });
          for ( const app of foundry.applications.instances.values() ) {
            if ( app instanceof foundry.applications.api.DocumentSheetV2 ) await app.close();
          }
          const app = await TraitTrackerApp.open();
          const row = app.element.querySelector(`[data-trait-id="${id}"]`);
          assert.isOk(row);
          assert.include(row.textContent, "Alarm Raised");
          assert.include(row.textContent, "Whole district");
        });
      });
    },
    { displayName: "Cortex Prime: temporary trait store" }
  );
}
