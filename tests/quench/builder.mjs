/**
 * Quench batch "cortex-prime.builder": assembling a dice pool by hand (Step 3.7; Decisions
 * ADR-012, ADR-015; Dice & Pools rules 2-7, DP-04, DP-04b).
 * @module tests/quench/builder
 */

import PoolBuilder from "../../module/apps/pool-builder.mjs";

const FLAG_SCOPE = "cortex-prime";
const FLAG_KEY = "pool";

/**
 * Register the batch with Quench.
 * @param {object} quench
 */
export function registerBuilderBatch(quench) {
  quench.registerBatch(
    "cortex-prime.builder",
    ({ describe, it, assert, afterEach }) => {
      /** @type {PoolBuilder[]} */
      let apps = [];
      /** @type {ChatMessage[]} */
      let messages = [];

      afterEach(async () => {
        for ( const app of apps ) app.close();
        apps = [];
        for ( const message of messages ) await message.delete();
        messages = [];
        await game.user.unsetFlag(FLAG_SCOPE, FLAG_KEY);
      });

      /** @returns {Promise<PoolBuilder>} a rendered builder, tracked for cleanup */
      async function openBuilder() {
        const app = new PoolBuilder();
        apps.push(app);
        await app.render({ force: true });
        return app;
      }

      describe("building a pool by hand", () => {
        it("builds d8 d8 d10 d6 from two sources, doubles one, and steps the d10 up twice " +
          "to d12 plus a d6, checking the stored flag after every change", async () => {
          const app = await openBuilder();

          await app.addDie(8, "Source A");
          let stored = game.user.getFlag(FLAG_SCOPE, FLAG_KEY);
          assert.lengthOf(stored, 1);
          assert.equal(stored[0].size, 8);
          assert.equal(stored[0].source.label, "Source A");

          await app.addDie(8, "Source A");
          stored = game.user.getFlag(FLAG_SCOPE, FLAG_KEY);
          assert.lengthOf(stored, 2);
          assert.equal(stored[1].size, 8);
          assert.equal(stored[1].source.label, "Source A");

          await app.addDie(10, "Source B");
          stored = game.user.getFlag(FLAG_SCOPE, FLAG_KEY);
          assert.lengthOf(stored, 3);
          assert.equal(stored[2].size, 10);
          assert.equal(stored[2].source.label, "Source B");

          await app.addDie(6, "Source B");
          stored = game.user.getFlag(FLAG_SCOPE, FLAG_KEY);
          assert.lengthOf(stored, 4);
          assert.equal(stored[3].size, 6);
          assert.equal(stored[3].source.label, "Source B");

          const firstEightId = stored[0].id;
          const tenId = stored[2].id;

          await app.doubleDie(firstEightId);
          stored = game.user.getFlag(FLAG_SCOPE, FLAG_KEY);
          assert.lengthOf(stored, 5, "doubling adds one die");
          const doubled = stored.find(d => d.origin === "doubled");
          assert.isDefined(doubled, "a doubled die should be stored");
          assert.equal(doubled.size, 8);
          assert.equal(doubled.source.label, "Source A");

          await app.stepDie(tenId, 1); // d10 -> d12, still within the ladder
          stored = game.user.getFlag(FLAG_SCOPE, FLAG_KEY);
          assert.lengthOf(stored, 5, "stepping within the ladder adds no die");
          assert.equal(stored.find(d => d.id === tenId).size, 12);

          await app.stepDie(tenId, 1); // d12 stepped again: overflow d6 (rule 4, DP-04b)
          stored = game.user.getFlag(FLAG_SCOPE, FLAG_KEY);
          assert.lengthOf(stored, 6, "a step past d12 adds an overflow d6");
          assert.equal(stored.find(d => d.id === tenId).size, 12);
          const overflow = stored.find(d => d.origin === "overflow");
          assert.isDefined(overflow, "an overflow die should be stored");
          assert.equal(overflow.size, 6);
          assert.equal(overflow.source.label, "Source B", "the overflow die carries its source");
        });

        it("keeps the pool across a reopen (a fresh builder instance)", async () => {
          const first = await openBuilder();
          await first.addDie(8, "Source A");
          await first.addDie(6, "Source A");
          first.close();

          const second = await openBuilder();
          assert.lengthOf(second.pool, 2);
          assert.sameMembers(second.pool.map(d => d.size), [8, 6]);
        });

        it("rolls the pool with fixed results and posts it, keeping the pool", async () => {
          const app = await openBuilder();
          await app.addDie(8, "Source A");
          await app.addDie(6, "Source A");
          const pool = app.pool;

          const message = await app.rollPool([5, 3]);
          messages.push(message);

          assert.equal(message.type, "poolRoll");
          assert.deepEqual(message.system.toObject().pool, pool);
          assert.equal(message.system.rolled[0].result, 5);
          assert.equal(message.system.rolled[1].result, 3);
          assert.lengthOf(app.pool, 2, "rolling keeps the pool");
        });

        it("can't roll an empty pool", async () => {
          const app = await openBuilder();
          assert.lengthOf(app.pool, 0);

          const before = game.messages.size;
          const result = await app.rollPool();

          assert.isUndefined(result);
          assert.equal(game.messages.size, before, "nothing should be posted");
        });
      });
    },
    { displayName: "Cortex Prime: builder" }
  );
}
