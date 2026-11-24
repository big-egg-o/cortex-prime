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
import { openPoolBuilder } from "../../module/apps/pool-builder.mjs";
import { postPoolRoll } from "../../module/dice/post-pool-roll.mjs";
import { applyCardChange } from "../../module/dice/card-actions.mjs";
import { rollPpData, settleRollPp } from "../../module/plot-points/roll-pp.mjs";
import { ASSET_EFFECTS_FLAG, CONSEQUENCE_FLAG, cardTraitContext, cardTraitFacts } from "../../module/assets/card-traits.mjs";
import ActorTraitsApp from "../../module/apps/actor-traits-app.mjs";
import { handleContestQuery } from "../../module/contest/relay.mjs";
import { initialSystem } from "../../module/data/chat/contest-mapping.mjs";
import { createContest } from "../../module/rules/index.mjs";

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

/** A pool die of a temporary trait, as the builder adds it. */
function traitDie(dieId, size, kind, traitId, label, actorId) {
  return { id: dieId, size, origin: "rating", source: { kind, traitId, label, actorId } };
}

/** A custom pool die. */
function customDie(dieId, size, label = "Edge") {
  return { id: dieId, size, origin: "rating", source: { kind: "custom", label } };
}

/** @returns {Promise<ChatMessage>} a roll card of `pool` with fixed results, paid for by `actor` (or the bank) */
function rollCard(pool, results, actor = null) {
  const speaker = actor ? ChatMessage.getSpeaker({ actor }) : { alias: "GM" };
  return postPoolRoll({ pool, results, speaker, pp: rollPpData({ pool, traitCost: null, actor }) });
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
      let userPool;
      before(() => {
        userPool = foundry.utils.deepClone(game.user.getFlag(SYSTEM_ID, "pool") ?? null);
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
        if ( userPool ) await game.user.setFlag(SYSTEM_ID, "pool", userPool);
        else await game.user.unsetFlag(SYSTEM_ID, "pool");
      });
      after(() => {
        foundry.applications.instances.get("cortex-prime-trait-tracker")?.close();
        for ( const app of foundry.applications.instances.values() ) if ( app instanceof ActorTraitsApp ) app.close();
      });

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

        it("a GMC's bought asset has no bank price (RQ-043): it is made, the bank is unchanged and no entry is posted", async () => {
          await game.settings.set(SYSTEM_ID, BANK_SETTING, 2);
          const gmc = await createActor("gmc", "Boss");
          const result = await sendTraitStoreRequest("buyAsset", {
            id: foundry.utils.randomID(16), name: "Net", holder: { kind: "actor", actorId: gmc.uuid }
          });
          assert.isTrue(result.ok, result.code);
          assert.deepEqual(result.value.warnings, ["BANK_SPEND_NOT_LISTED"]);
          assert.equal(getBank(), 2);
          assert.lengthOf(ledgerSince(messages), 0);
          assert.isTrue(getTraitStore().traits.some(t => t.holder.actorId === gmc.uuid));
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

      describe("hitches on a player's roll (step 4.8b)", () => {
        it("a hitch steps the roller's d4 complication up: it stays, and both plot points wait for one Settle", async () => {
          const pc = await createActor("pc", "Ana", { plotPoints: 1 });
          const winded = foundry.utils.randomID(16);
          await sendTraitStoreRequest("addComplication", { id: winded, name: "Winded", size: 4, holder: { kind: "actor", actorId: pc.uuid } });
          const pool = [traitDie("d1", 4, "complication", winded, "Winded", pc.uuid), customDie("d2", 8), customDie("d3", 6)];
          const message = await rollCard(pool, [1, 5, 4], pc);
          assert.deepEqual(message.system.pp.poolLines.map(l => l.reason), ["D4_COMPLICATION"]);
          const result = await sendTraitStoreRequest("activateHitches", {
            messageId: message.id, allocations: [{ hitchIds: ["d1"], target: { kind: "existing", traitId: winded } }], finish: true
          });
          assert.isTrue(result.ok, result.code);
          assert.deepEqual(getTraitStore().traits.find(t => t.id === winded)?.dice, [6]);
          assert.equal(message.system.rolled[0].state, "hitch-activated");
          assert.deepEqual(message.system.pp.otherLines.map(l => l.reason), ["HITCH_COMPLICATION"]);
          assert.isTrue(message.getFlag(SYSTEM_ID, "hitchesDone"));
          assert.equal(pc.system.plotPoints, 1);
          await applyCardChange(message, { action: "confirm" });
          const settled = await settleRollPp(message);
          assert.isTrue(settled.ok, settled.code);
          assert.equal(pc.system.plotPoints, 3);
          assert.lengthOf(ledgerSince(messages), 1);
          const again = await sendTraitStoreRequest("activateHitches", { messageId: message.id, allocations: [], finish: true });
          assert.deepEqual(again, { ok: false, code: "HITCHES_DONE" });
        });

        it("declining removes the roller's used d4 complication; a new complication from a hitch on a settled card pays at once", async () => {
          const pc = await createActor("pc", "Ana", { plotPoints: 0 });
          const winded = foundry.utils.randomID(16);
          await sendTraitStoreRequest("addComplication", { id: winded, name: "Winded", size: 4, holder: { kind: "actor", actorId: pc.uuid } });
          const pool = [traitDie("d1", 4, "complication", winded, "Winded", pc.uuid), customDie("d2", 8), customDie("d3", 6)];
          const declined = await rollCard(pool, [3, 1, 4], pc);
          const result = await sendTraitStoreRequest("activateHitches", { messageId: declined.id, allocations: [], finish: true });
          assert.isTrue(result.ok, result.code);
          assert.deepEqual(result.value.removedIds, [winded]);
          assert.isFalse(getTraitStore().traits.some(t => t.id === winded));

          const card = await rollCard([customDie("d1", 8), customDie("d2", 6), customDie("d3", 10)], [1, 4, 7], pc);
          await card.update({ "system.pp.settled": true });
          const made = await sendTraitStoreRequest("activateHitches", {
            messageId: card.id, finish: true,
            allocations: [{ hitchIds: ["d1"], target: { kind: "new", id: foundry.utils.randomID(16), name: "Ankle", holder: { kind: "actor", actorId: pc.uuid } } }]
          });
          assert.isTrue(made.ok, made.code);
          assert.equal(pc.system.plotPoints, 1);
          assert.lengthOf(card.system.pp.otherLines, 0);
          const entries = ledgerSince(messages);
          assert.lengthOf(entries, 1);
          assert.equal(entries[0].system.reason, "HITCH_COMPLICATION");
        });
      });

      describe("opportunities on the GM's roll (step 4.8b)", () => {
        it("steps a complication down for 1 PP, writing the store, the balance, the entry and the card together", async () => {
          const pc = await createActor("pc", "Ana", { plotPoints: 2 });
          const alarm = foundry.utils.randomID(16);
          await sendTraitStoreRequest("addComplication", { id: alarm, name: "Alarm Raised", size: 8, holder: { kind: "unassigned" } });
          const card = await rollCard([customDie("d1", 8, "Guards"), customDie("d2", 6, "Guards"), customDie("d3", 10, "Guards")], [1, 1, 6]);
          assert.equal(card.system.pp.payer.kind, "bank");
          const result = await sendTraitStoreRequest("useOpportunities", {
            messageId: card.id, actorKey: pc.uuid,
            uses: [{ opportunityIds: ["d1", "d2"], direction: "down", target: { kind: "temporary", traitId: alarm } }]
          });
          assert.isTrue(result.ok, result.code);
          assert.deepEqual(getTraitStore().traits.find(t => t.id === alarm)?.dice, [4]);
          assert.equal(pc.system.plotPoints, 1);
          assert.deepEqual(card.system.rolled.map(d => d.state), ["hitch-activated", "hitch-activated", "available"]);
          const entries = ledgerSince(messages);
          assert.lengthOf(entries, 1);
          assert.equal(entries[0].system.reason, "OPPORTUNITY");
          assert.equal(entries[0].system.messageRef, card.id);
        });
      });

      describe("the pool builder's temporary traits (step 4.8b)", () => {
        it("lists a complication, adds it once as one die, and the card stores the die as rolled", async () => {
          const pc = await createActor("pc", "Ana", { plotPoints: 1 });
          const id = foundry.utils.randomID(16);
          await sendTraitStoreRequest("addComplication", { id, name: "Dust-Blinded", size: 6, holder: { kind: "actor", actorId: pc.uuid } });
          await game.user.unsetFlag(SYSTEM_ID, "pool");
          const builder = await openPoolBuilder();
          assert.isOk(builder.element.querySelector(`[data-action="addTemporaryTrait"][data-trait-id="${id}"]`));
          assert.isTrue(await builder.addTemporaryTrait(id));
          assert.isFalse(await builder.addTemporaryTrait(id));
          assert.lengthOf(builder.pool, 1);
          assert.deepInclude(builder.pool[0].source, { kind: "complication", traitId: id, actorId: pc.uuid });
          const message = await builder.rollPool([5]);
          await sendTraitStoreRequest("step", { traitId: id, steps: 1 });
          assert.equal(message.system.pool[0].size, 6);
          assert.equal(message.system.rolled[0].source.traitId, id);
          await builder.close();
        });
      });

      describe("the test and contest card (step 4.8c)", () => {
        const act = async (message, action, payload = {}) => {
          const result = await handleContestQuery(
            { action, messageId: message.id, revision: message.system.revision, payload }, { user: game.user }
          );
          assert.isTrue(result.ok, `${action}: ${result.code}`);
        };
        const side = (key, actor) => ({ key, userId: null, actorUuid: actor?.uuid ?? null, label: actor?.name ?? key });
        const newItems = offered => offered.map(o => ({
          key: o.key, target: { kind: "new", id: foundry.utils.randomID(16), name: `Hurt ${o.key}` }
        }));

        async function startTest(pc, difficulty) {
          const started = await handleContestQuery({
            action: "start", type: "test", difficulty, sides: [side("roller", pc), side("setter")]
          }, { user: game.user });
          assert.isTrue(started.ok, started.code);
          return game.messages.get(started.value.messageId);
        }

        it("a PC beats a GMC: the loser's complications are given once; the winner's spare die makes an asset once", async () => {
          const pc = await createActor("pc", "Ana", { plotPoints: 1 });
          const gmc = await createActor("gmc", "Thug");
          const system = initialSystem({
            type: "contest", state: createContest().value, startedBy: game.user.id,
            sides: [side("initiator", pc), side("opposition", gmc)]
          }).value;
          const message = await ChatMessage.implementation.create({ type: "contest", system });
          await act(message, "add-roll", { side: "initiator", total: 15, effectSizes: [10, 8] });
          await act(message, "add-roll", { side: "opposition", total: 12, effectSizes: [6] });
          assert.lengthOf(cardTraitFacts(message, game.user).offered, 0, "nothing before the winner's pick");
          await act(message, "use-against-loser", { effectIds: ["e1"] });
          const facts = cardTraitFacts(message, game.user);
          assert.equal(facts.holderKey, gmc.uuid);
          assert.isAbove(facts.offered.length, 0);
          assert.deepEqual(facts.assetEffects.map(e => e.size), [8]);
          assert.deepInclude(cardTraitContext(message), { applied: false });

          let result = await sendTraitStoreRequest("applyConsequence", { messageId: message.id, items: newItems(facts.offered) });
          assert.isTrue(result.ok, result.code);
          const given = getTraitStore().traits.filter(t => t.holder.actorId === gmc.uuid);
          assert.deepEqual(given.map(t => t.origin), facts.offered.map(o => o.cause));
          assert.deepEqual(given.map(t => t.dice[0]), facts.offered.map(o => o.size));
          assert.deepEqual(message.getFlag(SYSTEM_ID, CONSEQUENCE_FLAG), facts.offered.map(o => o.key));
          assert.isNull(cardTraitContext(message).apply);
          result = await sendTraitStoreRequest("applyConsequence", { messageId: message.id, items: newItems(facts.offered) });
          assert.deepEqual(result, { ok: false, code: "CONSEQUENCE_APPLIED" });

          const effectId = facts.assetEffects[0].id;
          const asset = { messageId: message.id, effectId, id: foundry.utils.randomID(16), name: "Higher Ground", origin: "effect" };
          result = await sendTraitStoreRequest("createEffectAsset", asset);
          assert.isTrue(result.ok, result.code);
          assert.deepInclude(getTraitStore().traits.find(t => t.id === asset.id), { kind: "asset", dice: [8], origin: "effect" });
          assert.equal(getTraitStore().traits.find(t => t.id === asset.id).holder.actorId, pc.uuid);
          assert.deepEqual(message.getFlag(SYSTEM_ID, ASSET_EFFECTS_FLAG), [effectId]);
          result = await sendTraitStoreRequest("createEffectAsset", { ...asset, id: foundry.utils.randomID(16) });
          assert.deepEqual(result, { ok: false, code: "EFFECT_DIE_USED" });
          assert.equal(pc.system.plotPoints, 1);
        });

        it("AC-31 after a failed test the GM steps up the character's d6 complication instead of a new d6", async () => {
          const pc = await createActor("pc", "Ana", { plotPoints: 1 });
          const exhausted = foundry.utils.randomID(16);
          await sendTraitStoreRequest("addComplication", { id: exhausted, name: "Exhausted", size: 6, holder: { kind: "actor", actorId: pc.uuid } });
          const message = await startTest(pc, 12);
          await act(message, "add-roll", { side: "roller", total: 10, effectSizes: [6] });
          const facts = cardTraitFacts(message, game.user);
          assert.deepEqual(facts.offered, [{ key: "failedTest", size: 6, cause: "failedTest", required: false }]);
          assert.deepEqual(facts.assetEffects, []);
          const result = await sendTraitStoreRequest("applyConsequence", {
            messageId: message.id, items: [{ key: "failedTest", target: { kind: "existing", traitId: exhausted } }]
          });
          assert.isTrue(result.ok, result.code);
          assert.deepEqual(getTraitStore().traits.find(t => t.id === exhausted).dice, [8]);
        });

        it("AC-06 a successful asset test makes a clue at the GM's cap, for the roller, at no cost", async () => {
          const pc = await createActor("pc", "Ana", { plotPoints: 1 });
          const message = await startTest(pc, 9);
          await act(message, "add-roll", { side: "roller", total: 12, effectSizes: [12] });
          const facts = cardTraitFacts(message, game.user);
          assert.deepEqual(facts.offered, []);
          assert.equal(facts.assetEffects[0].size, 12);
          const id = foundry.utils.randomID(16);
          const result = await sendTraitStoreRequest("createEffectAsset", {
            messageId: message.id, effectId: facts.assetEffects[0].id, id, name: "Guard Rotation", origin: "clue", cap: 10
          });
          assert.isTrue(result.ok, result.code);
          assert.deepInclude(getTraitStore().traits.find(t => t.id === id), { dice: [10], origin: "clue" });
          assert.equal(pc.system.plotPoints, 1);
        });

        it("a player's view lists their asset and complication; Keep costs 1 PP", async () => {
          const pc = await createActor("pc", "Ana", { plotPoints: 2 });
          const asset = foundry.utils.randomID(16);
          const holder = { kind: "actor", actorId: pc.uuid };
          await sendTraitStoreRequest("buyAsset", { id: asset, name: "Rope", holder });
          await sendTraitStoreRequest("addComplication", { id: foundry.utils.randomID(16), name: "Bruised", size: 8, holder });
          const app = await ActorTraitsApp.open(pc);
          assert.include(app.element.textContent, "Rope");
          assert.include(app.element.textContent, "Bruised");
          assert.isOk(app.element.querySelector(`[data-action="keepAsset"][data-trait-id="${asset}"]`));
          const result = await sendTraitStoreRequest("keepAsset", { traitId: asset });
          assert.isTrue(result.ok, result.code);
          assert.equal(getTraitStore().traits.find(t => t.id === asset).duration, "session");
          assert.equal(pc.system.plotPoints, 0);
          await app.close();
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
