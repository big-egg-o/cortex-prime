/**
 * Quench batch "cortex-prime.chat": the poolRoll ChatMessage sub-type (Decisions ADR-010).
 * @module tests/quench/chat
 */

import {
  applyResults, buildPool, resolve, stepEffectDie, twoHighest
} from "../../module/rules/index.mjs";

/** @returns {{pool: object[], rolled: object[]}} a plain 3-die pool with fixed, non-hitch results */
function sampleRoll() {
  const pool = buildPool([
    { size: 8, source: { kind: "trait", label: "Agility" }, count: 2 },
    { size: 6, source: { kind: "asset", label: "Grapple Gun" } }
  ]);
  const rolled = applyResults(pool, [5, 3, 2]);
  return { pool, rolled };
}

/**
 * Register the batch with Quench.
 * @param {object} quench
 */
export function registerChatBatch(quench) {
  quench.registerBatch(
    "cortex-prime.chat",
    ({ describe, it, assert, afterEach }) => {
      /** @type {ChatMessage|null} */
      let message = null;

      afterEach(async () => {
        if ( message ) await message.delete();
        message = null;
      });

      describe("poolRoll chat message type", () => {
        it("creates a resolved roll and reads it back unchanged", async () => {
          const { pool, rolled } = sampleRoll();
          const totalIds = twoHighest(rolled, 2);
          const effectDieIds = rolled.filter(d => !totalIds.includes(d.id)).map(d => d.id);
          const selection = { totalIds, effectDieIds, extraResultsPaid: 0, extraEffectDicePaid: 0, keepLimit: 2 };
          const resolution = resolve(rolled, selection);

          message = await ChatMessage.create({
            type: "poolRoll",
            system: { schemaVersion: 1, pool, rolled, selection, resolution, state: "resolved" }
          });

          const read = game.messages.get(message.id);
          assert.deepEqual(read.system.toObject().pool, pool);
          assert.deepEqual(read.system.toObject().rolled, rolled);
          assert.deepEqual(read.system.toObject().selection, selection);
          assert.deepEqual(read.system.toObject().resolution, resolution);
          assert.equal(read.system.state, "resolved");
        });

        it("creates an unresolved roll with a null resolution and reads it back", async () => {
          const { pool, rolled } = sampleRoll();
          const selection = { totalIds: [], effectDieIds: [], extraResultsPaid: 0, extraEffectDicePaid: 0, keepLimit: 2 };

          message = await ChatMessage.create({
            type: "poolRoll",
            system: { schemaVersion: 1, pool, rolled, selection, resolution: null, state: "rolled" }
          });

          const read = game.messages.get(message.id);
          assert.deepEqual(read.system.toObject().pool, pool);
          assert.deepEqual(read.system.toObject().rolled, rolled);
          assert.equal(read.system.resolution, null);
          assert.equal(read.system.state, "rolled");
        });

        it("saves and reads back a resolved roll with a pending overflow intact", async () => {
          const pool = buildPool([
            { size: 12, source: { kind: "trait", label: "Mighty" } },
            { size: 8, source: { kind: "asset", label: "Warhammer" } },
            { size: 6, source: { kind: "trait", label: "Role" } }
          ]);
          const rolled = applyResults(pool, [10, 6, 2]);
          const selection = {
            totalIds: [pool[0].id, pool[1].id], effectDieIds: [pool[2].id],
            extraResultsPaid: 0, extraEffectDicePaid: 0, keepLimit: 2
          };
          const resolved = resolve(rolled, selection);
          const resolution = stepEffectDie(rolled, resolved, 0, 4, "heroic");
          assert.notEqual(resolution.overflow, null, "fixture should produce a pending overflow");

          message = await ChatMessage.create({
            type: "poolRoll",
            system: { schemaVersion: 1, pool, rolled, selection, resolution, state: "resolved" }
          });

          const read = game.messages.get(message.id);
          assert.deepEqual(read.system.toObject().resolution, resolution);
        });

        it("rejects a d7", async () => {
          const pool = buildPool([{ size: 8, source: { kind: "trait", label: "Agility" } }]);
          pool[0].size = 7;
          const rolled = [{ ...pool[0], result: 3, hitch: false, state: "available" }];
          const selection = { totalIds: [], effectDieIds: [], extraResultsPaid: 0, extraEffectDicePaid: 0, keepLimit: 2 };

          let threw = false;
          try {
            message = await ChatMessage.create({
              type: "poolRoll",
              system: { schemaVersion: 1, pool, rolled, selection, resolution: null, state: "rolled" }
            });
          } catch {
            threw = true;
          }
          assert.isTrue(threw, "a d7 pool die should be rejected");
        });

        it("rejects a d6 rolled to 9", async () => {
          const { pool, rolled } = sampleRoll();
          rolled[2].result = 9; // rolled[2] is the d6
          const selection = { totalIds: [], effectDieIds: [], extraResultsPaid: 0, extraEffectDicePaid: 0, keepLimit: 2 };

          let threw = false;
          try {
            message = await ChatMessage.create({
              type: "poolRoll",
              system: { schemaVersion: 1, pool, rolled, selection, resolution: null, state: "rolled" }
            });
          } catch {
            threw = true;
          }
          assert.isTrue(threw, "a result past the die's size should be rejected");
        });

        it('rejects state "resolved" without a resolution', async () => {
          const { pool, rolled } = sampleRoll();
          const selection = { totalIds: [], effectDieIds: [], extraResultsPaid: 0, extraEffectDicePaid: 0, keepLimit: 2 };

          let threw = false;
          try {
            message = await ChatMessage.create({
              type: "poolRoll",
              system: { schemaVersion: 1, pool, rolled, selection, resolution: null, state: "resolved" }
            });
          } catch {
            threw = true;
          }
          assert.isTrue(threw, 'state "resolved" with no resolution should be rejected');
        });
      });
    },
    { displayName: "Cortex Prime: chat" }
  );
}
