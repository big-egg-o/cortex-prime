/**
 * Quench batch "cortex-prime.migration": poolRoll messages stored before effect dice had ids
 * (schema version 1) load with ids, kinds, consumedDieIds and nextEffectNumber (Decisions
 * ADR-026). The old sources are hand-typed on purpose: the engine no longer produces that shape.
 * @module tests/quench/migration
 */

import { applyResults, buildPool } from "../../module/rules/index.mjs";
import PoolRollData, { POOL_ROLL_SCHEMA_VERSION } from "../../module/data/chat/pool-roll.mjs";
import { preparePoolRollCardContext } from "../../module/dice/pool-roll-card.mjs";

/**
 * A schema-version-1 poolRoll system: d12:3, d10:9, d8:8, total d10 + d8, effect dice d12
 * (rolled) and a d4 default (one extra paid, nothing left over), with the d12 overflowed and the
 * choice still pending at effectIndex 0.
 * @returns {object}
 */
function oldPendingOverflowSystem() {
  const pool = buildPool([12, 10, 8].map(size => ({ size, source: { kind: "trait", label: `Trait d${size}` } })));
  const rolled = applyResults(pool, [3, 9, 8]);
  const [twelveId, tenId, eightId] = pool.map(d => d.id);
  return {
    schemaVersion: 1,
    pool,
    rolled,
    selection: {
      totalIds: [tenId, eightId], effectDieIds: [twelveId], extraResultsPaid: 0, extraEffectDicePaid: 1, keepLimit: 2
    },
    resolution: {
      total: 17,
      totalIds: [tenId, eightId],
      effectDice: [
        { size: 12, dieId: twelveId, isDefault: false },
        { size: 4, dieId: null, isDefault: true }
      ],
      hitchIds: [],
      botch: false,
      takeOut: false,
      overflow: {
        effectIndex: 0,
        cause: "heroic",
        options: { cause: "heroic", leftovers: [], newDie: 6, takeOutAvailable: true }
      }
    },
    state: "resolved"
  };
}

/**
 * A schema-version-1 resolution after an overflow was answered with a new d6.
 * @returns {object}
 */
function oldOverflowD6Resolution() {
  return {
    total: 17,
    totalIds: ["b", "c"],
    effectDice: [
      { size: 12, dieId: "a", isDefault: false },
      { size: 6, dieId: null, isDefault: true }
    ],
    hitchIds: [],
    botch: false,
    takeOut: false,
    overflow: null
  };
}

/**
 * Register the batch with Quench.
 * @param {object} quench
 */
export function registerMigrationBatch(quench) {
  quench.registerBatch(
    "cortex-prime.migration",
    ({ describe, it, assert, afterEach }) => {
      /** @type {ChatMessage[]} */
      let messages = [];

      afterEach(async () => {
        for ( const message of messages ) await message.delete();
        messages = [];
      });

      describe("PoolRollData.migrateData", () => {
        it("gives an old source ids, kinds, consumedDieIds, nextEffectNumber and overflow.effectId", () => {
          const old = oldPendingOverflowSystem();
          const twelveId = old.pool[0].id;
          const migrated = PoolRollData.migrateData(foundry.utils.deepClone(old));

          assert.equal(migrated.schemaVersion, 2);
          assert.equal(POOL_ROLL_SCHEMA_VERSION, 2);
          assert.deepEqual(migrated.resolution.effectDice, [
            { id: "e1", kind: "rolled", size: 12, dieId: twelveId, isDefault: false },
            { id: "e2", kind: "default", size: 4, dieId: null, isDefault: true }
          ]);
          assert.deepEqual(migrated.resolution.consumedDieIds, []);
          assert.equal(migrated.resolution.nextEffectNumber, 3);
          assert.equal(migrated.resolution.overflow.effectId, "e1");
        });

        it("marks an old default d6 as an overflow effect die", () => {
          const migrated = PoolRollData.migrateData({ schemaVersion: 1, resolution: oldOverflowD6Resolution() });
          assert.deepEqual(migrated.resolution.effectDice.map(e => [e.id, e.kind]), [["e1", "rolled"], ["e2", "overflow"]]);
          assert.equal(migrated.resolution.nextEffectNumber, 3);
        });

        it("changes nothing when run again on its own output", () => {
          const once = PoolRollData.migrateData(foundry.utils.deepClone(oldPendingOverflowSystem()));
          const twice = PoolRollData.migrateData(foundry.utils.deepClone(once));
          assert.deepEqual(twice, once);
        });

        it("keeps nextEffectNumber on a v2 source whose effect die was removed", () => {
          const v2 = {
            schemaVersion: 2,
            resolution: {
              total: 16,
              totalIds: ["a", "b"],
              effectDice: [{ id: "e1", kind: "rolled", size: 8, dieId: "c", isDefault: false }],
              consumedDieIds: ["d"],
              nextEffectNumber: 3,
              hitchIds: [],
              botch: false,
              takeOut: false,
              overflow: null
            }
          };
          const migrated = PoolRollData.migrateData(foundry.utils.deepClone(v2));
          assert.deepEqual(migrated, v2);
        });

        it("leaves a resolution without schemaVersion alone when its entries have ids (a partial update)", () => {
          const partial = {
            resolution: { effectDice: [{ id: "e1", kind: "rolled", size: 8, dieId: "c", isDefault: false }] }
          };
          assert.deepEqual(PoolRollData.migrateData(foundry.utils.deepClone(partial)), partial);
        });

        it("copes with no resolution and no schema version", () => {
          assert.deepEqual(PoolRollData.migrateData({ resolution: null, state: "rolled" }), { resolution: null, state: "rolled" });
          assert.deepEqual(PoolRollData.migrateData({}), {});
        });
      });

      describe("loading old messages", () => {
        it("loads an old-format message from source with ids, kinds and a buildable card", () => {
          const old = oldPendingOverflowSystem();
          const message = ChatMessage.implementation.fromSource(
            { type: "poolRoll", system: old },
            { strict: true, clean: { expand: false } }
          );

          const system = message.system.toObject();
          assert.equal(system.schemaVersion, 2);
          assert.deepEqual(system.resolution.effectDice.map(e => [e.id, e.kind]), [["e1", "rolled"], ["e2", "default"]]);
          assert.deepEqual(system.resolution.consumedDieIds, []);
          assert.equal(system.resolution.nextEffectNumber, 3);
          assert.equal(system.resolution.overflow.effectId, "e1");
          assert.notProperty(system.resolution.overflow, "effectIndex");

          const context = preparePoolRollCardContext(message);
          assert.equal(context.headline, game.i18n.localize("CORTEX.Chat.OverflowPending"));
        });

        it("keeps nextEffectNumber and consumedDieIds through a partial resolution update", async () => {
          const old = oldPendingOverflowSystem();
          const message = await ChatMessage.create({
            type: "poolRoll",
            system: {
              ...old,
              schemaVersion: POOL_ROLL_SCHEMA_VERSION,
              resolution: {
                ...old.resolution,
                effectDice: [{ id: "e2", kind: "rolled", size: 12, dieId: old.pool[0].id, isDefault: false }],
                consumedDieIds: [old.pool[1].id],
                nextEffectNumber: 4,
                overflow: null
              }
            }
          });
          messages.push(message);

          await message.update({ "system.resolution.takeOut": true });

          const after = game.messages.get(message.id).system.toObject().resolution;
          assert.isTrue(after.takeOut);
          assert.equal(after.nextEffectNumber, 4);
          assert.deepEqual(after.consumedDieIds, [old.pool[1].id]);
          assert.deepEqual(after.effectDice.map(e => e.id), ["e2"]);
        });

        it("doesn't lower nextEffectNumber when a partial update removes e2 without sending it", async () => {
          const old = oldPendingOverflowSystem();
          const [twelveId, tenId, eightId] = old.pool.map(d => d.id);
          const e1 = { id: "e1", kind: "rolled", size: 12, dieId: twelveId, isDefault: false };
          const message = await ChatMessage.create({
            type: "poolRoll",
            system: {
              ...old,
              schemaVersion: POOL_ROLL_SCHEMA_VERSION,
              resolution: {
                ...old.resolution,
                effectDice: [e1, { id: "e2", kind: "default", size: 4, dieId: null, isDefault: true }],
                consumedDieIds: [],
                nextEffectNumber: 3,
                overflow: null
              }
            }
          });
          messages.push(message);

          await message.update({ "system.resolution.effectDice": [e1] });

          const after = game.messages.get(message.id).system.toObject().resolution;
          assert.deepEqual(after.effectDice.map(e => e.id), ["e1"]);
          assert.equal(after.nextEffectNumber, 3, "not recomputed as 2 from the remaining entries");
          assert.deepEqual(after.totalIds, [tenId, eightId]);
        });
      });
    },
    { displayName: "Cortex Prime: migration" }
  );
}
