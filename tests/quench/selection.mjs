/**
 * Quench batch "cortex-prime.selection": choosing total and effect dice on a poolRoll card
 * (Decisions ADR-013, ADR-014; Dice & Pools rules 12-23).
 * @module tests/quench/selection
 */

import { buildPool, validateSelection } from "../../module/rules/index.mjs";
import { applyCardChange } from "../../module/dice/card-actions.mjs";
import { postPoolRoll } from "../../module/dice/post-pool-roll.mjs";

/**
 * @param {number[]} sizes
 * @returns {import("../../module/rules/types.mjs").PoolDie[]}
 */
function pool(sizes) {
  return buildPool(sizes.map(size => ({ size, source: { kind: "trait", label: `Trait d${size}` } })));
}

/**
 * Register the batch with Quench.
 * @param {object} quench
 */
export function registerSelectionBatch(quench) {
  quench.registerBatch(
    "cortex-prime.selection",
    ({ describe, it, assert, afterEach }) => {
      /** @type {ChatMessage|null} */
      let message = null;

      afterEach(async () => {
        if ( message ) await message.delete();
        message = null;
      });

      describe("choosing total and effect dice", () => {
        it("cycles dice away from the suggestion, refuses an invalid Confirm, and confirms (DP-13)", async () => {
          const dice = pool([10, 8, 6]);
          message = await postPoolRoll({ pool: dice, results: [7, 5, 3] });
          const [tenId, eightId, sixId] = message.system.pool.map(d => d.id);

          await applyCardChange(message, { action: "cycle-die", dieId: sixId }); // effect -> unused
          await applyCardChange(message, { action: "confirm" }); // an effect slot is empty: refused
          assert.equal(game.messages.get(message.id).system.state, "rolled", "an invalid selection isn't confirmed");

          await applyCardChange(message, { action: "cycle-die", dieId: sixId }); // -> total
          await applyCardChange(message, { action: "cycle-die", dieId: sixId }); // -> effect

          // Other viewers would read the same, still-unresolved message and see this.
          const midway = game.messages.get(message.id);
          assert.sameMembers(midway.system.selection.totalIds, [tenId, eightId]);
          assert.sameMembers(midway.system.selection.effectDieIds, [sixId]);
          assert.equal(midway.system.state, "rolled");

          await applyCardChange(message, { action: "confirm" });

          const resolved = game.messages.get(message.id);
          assert.equal(resolved.system.state, "resolved");
          assert.equal(resolved.system.resolution.total, 12);
          assert.lengthOf(resolved.system.resolution.effectDice, 1);
          assert.equal(resolved.system.resolution.effectDice[0].size, 6);
          assert.equal(resolved.system.resolution.effectDice[0].dieId, sixId);
          assert.isFalse(resolved.system.resolution.effectDice[0].isDefault);
        });

        it('fills every effect slot with the "Two highest" shortcut (DP-21)', async () => {
          const dice = pool([12, 10, 8, 6]);
          message = await postPoolRoll({ pool: dice, results: [5, 7, 6, 2] });

          await applyCardChange(message, { action: "increment-extra-effect-dice" });
          await applyCardChange(message, { action: "two-highest" });

          const after = game.messages.get(message.id);
          const { valid } = validateSelection(after.system.rolled, after.system.selection);
          assert.isTrue(valid, "the shortcut's selection should validate");

          const sizesById = new Map(after.system.rolled.map(d => [d.id, d.size]));
          const totalSizes = after.system.selection.totalIds.map(id => sizesById.get(id));
          const effectSizes = after.system.selection.effectDieIds.map(id => sizesById.get(id));
          assert.sameMembers(totalSizes, [10, 8]);
          assert.sameMembers(effectSizes, [12, 6]);

          await applyCardChange(message, { action: "confirm" });
          const resolved = game.messages.get(message.id);
          assert.sameMembers(resolved.system.resolution.effectDice.map(e => e.size), [12, 6]);
        });

        it("refuses to put a hitch in the total and stores nothing (rule 10, DP-18)", async () => {
          const dice = pool([12, 8]);
          message = await postPoolRoll({ pool: dice, results: [1, 5] }); // the d12 is a hitch
          const [hitchId] = message.system.pool.map(d => d.id);
          const before = message.system.toObject().selection;

          await applyCardChange(message, { action: "cycle-die", dieId: hitchId });

          const after = game.messages.get(message.id);
          assert.deepEqual(after.system.toObject().selection, before);
          assert.equal(after.system.state, "rolled");
        });

        it("refuses a change from a user who isn't the owner or the GM (ADR-013)", async () => {
          const dice = pool([10, 8]);
          message = await postPoolRoll({ pool: dice, results: [7, 5] });
          const [tenId] = message.system.pool.map(d => d.id);
          const before = message.system.toObject().selection;

          const stranger = await User.create({ name: "cortex-prime-test-stranger", role: CONST.USER_ROLES.PLAYER });
          const originalUser = game.users.current;
          try {
            game.users.current = stranger;
            await applyCardChange(message, { action: "cycle-die", dieId: tenId });
          } finally {
            game.users.current = originalUser;
            await stranger.delete();
          }

          const after = game.messages.get(message.id);
          assert.deepEqual(after.system.toObject().selection, before);
        });
      });
    },
    { displayName: "Cortex Prime: selection" }
  );
}
