/**
 * Quench batch "cortex-prime.dice": rolling a pool with Foundry's dice (Decisions ADR-009).
 * @module tests/quench/dice
 */

import { buildPool, stepPoolDie } from "../../module/rules/index.mjs";
import { rollPool } from "../../module/dice/roll-pool.mjs";

/** @returns {import("../../module/rules/types.mjs").PoolDie[]} a 7-die pool with an overflow d6 */
function sevenDiePool() {
  const base = buildPool([
    { size: 12, source: { kind: "trait", label: "Mighty" } },
    { size: 10, source: { kind: "trait", label: "Alertness" } },
    { size: 8, source: { kind: "asset", label: "Rifle" }, count: 2 },
    { size: 6, source: { kind: "sfx", label: "Edge" } },
    { size: 4, source: { kind: "complication", label: "Winded" } }
  ]);
  return stepPoolDie(base, base[0].id, 1); // steps the d12 past d12: adds an overflow d6
}

/**
 * Register the batch with Quench.
 * @param {object} quench
 */
export function registerDiceBatch(quench) {
  quench.registerBatch(
    "cortex-prime.dice",
    ({ describe, it, assert }) => {
      describe("rolling a pool with Foundry dice", () => {
        it("rolls a 7-die mixed pool, one term per die, in pool order", async () => {
          const pool = sevenDiePool();
          assert.lengthOf(pool, 7);

          const { roll, rolled } = await rollPool(pool);

          assert.lengthOf(roll.dice, 7);
          for ( let i = 0; i < pool.length; i++ ) {
            assert.equal(roll.dice[i].faces, pool[i].size, `roll.dice[${i}] should be a d${pool[i].size}`);
          }

          assert.lengthOf(rolled, 7);
          for ( let i = 0; i < pool.length; i++ ) {
            assert.equal(rolled[i].id, pool[i].id);
            assert.equal(rolled[i].size, pool[i].size);
            assert.isAtLeast(rolled[i].result, 1);
            assert.isAtMost(rolled[i].result, pool[i].size);
          }
        });

        it("refuses to roll an empty pool", async () => {
          let threw = false;
          try {
            await rollPool([]);
          } catch {
            threw = true;
          }
          assert.isTrue(threw, "an empty pool should be refused");
        });
      });
    },
    { displayName: "Cortex Prime: dice" }
  );
}
