/**
 * Quench batch "cortex-prime.effect": stepping effect dice and resolving the past-d12
 * overflow choice on resolved poolRoll cards (Decisions ADR-013; Dice & Pools rule 22, rule
 * 23). Every fixture is built through the real engine path (applyResults -> resolve ->, for
 * the overflow cases, stepEffectDie), never a hand-typed Resolution, so these tests fail if
 * the engine's own output ever changes shape.
 * @module tests/quench/effect
 */

import { applyResults, buildPool, resolve, stepEffectDie } from "../../module/rules/index.mjs";
import { EFFECT_DIE_D4_STEP_DOWN, applyCardChange } from "../../module/dice/card-actions.mjs";
import { POOL_ROLL_SCHEMA_VERSION } from "../../module/data/chat/pool-roll.mjs";

/**
 * @param {number[]} sizes
 * @returns {import("../../module/rules/types.mjs").PoolDie[]}
 */
function pool(sizes) {
  return buildPool(sizes.map(size => ({ size, source: { kind: "trait", label: `Trait d${size}` } })));
}

/** @returns {import("../../module/rules/types.mjs").Selection} an empty selection */
function emptySelection() {
  return { totalIds: [], effectDieIds: [], extraResultsPaid: 0, extraEffectDicePaid: 0, keepLimit: 2 };
}

/**
 * Creates a resolved poolRoll message from a built pool, its rolled results and a Resolution
 * already computed through the engine.
 * @param {import("../../module/rules/types.mjs").PoolDie[]} diePool
 * @param {import("../../module/rules/types.mjs").RolledDie[]} rolled
 * @param {import("../../module/rules/types.mjs").Selection} selection
 * @param {import("../../module/rules/types.mjs").Resolution} resolution
 * @returns {Promise<ChatMessage>}
 */
async function createResolvedMessage(diePool, rolled, selection, resolution) {
  return ChatMessage.create({
    type: "poolRoll",
    system: { schemaVersion: POOL_ROLL_SCHEMA_VERSION, pool: diePool, rolled, selection, resolution, state: "resolved" }
  });
}

/**
 * Register the batch with Quench.
 * @param {object} quench
 */
export function registerEffectBatch(quench) {
  quench.registerBatch(
    "cortex-prime.effect",
    ({ describe, it, assert, afterEach }) => {
      /** @type {ChatMessage[]} */
      let messages = [];

      afterEach(async () => {
        for ( const message of messages ) await message.delete();
        messages = [];
      });

      describe("stepping effect dice", () => {
        it('steps one of two effect dice without touching the other (DP-24; cause "other" per rule 22)',
          async () => {
            const dice = pool([12, 10, 8, 6]);
            const rolled = applyResults(dice, [9, 7, 5, 2]);
            const [twelveId, tenId, eightId, sixId] = dice.map(d => d.id);
            const selection = {
              ...emptySelection(), totalIds: [twelveId, eightId], effectDieIds: [tenId, sixId],
              extraEffectDicePaid: 1
            };
            const resolution = resolve(rolled, selection);

            const message = await createResolvedMessage(dice, rolled, selection, resolution);
            messages.push(message);

            await applyCardChange(message, { action: "step-effect-die", effectId: "e2", steps: 1 });

            const after = game.messages.get(message.id);
            assert.equal(after.system.resolution.effectDice[0].size, 10, "the other effect die stays d10");
            assert.equal(after.system.resolution.effectDice[1].size, 8, "d6 stepped up once is d8");
          });
      });

      describe("the past-d12 overflow (cause \"other\"; rule 22 offers the same options for heroic " +
        "success, SFX or a plain step — the heroic label comes with Tests & Contests)", () => {
        it("offers only new-d6 and take-out with nothing left over (DP-25)", async () => {
          const dice = pool([12, 10, 8]);
          const rolled = applyResults(dice, [3, 9, 8]);
          const [twelveId, tenId, eightId] = dice.map(d => d.id);
          const selection = { ...emptySelection(), totalIds: [tenId, eightId], effectDieIds: [twelveId] };
          const resolved = resolve(rolled, selection);
          const overflowed = stepEffectDie(rolled, resolved, "e1", 1, "other");

          assert.deepEqual(overflowed.overflow.options.leftovers, []);
          assert.equal(overflowed.overflow.options.newDie, 6);
          assert.isTrue(overflowed.overflow.options.takeOutAvailable);

          const message = await createResolvedMessage(dice, rolled, selection, overflowed);
          messages.push(message);

          await applyCardChange(message, { action: "overflow-choice", kind: "new-d6" });

          const after = game.messages.get(message.id);
          assert.isNull(after.system.resolution.overflow);
          assert.lengthOf(after.system.resolution.effectDice, 2);
          assert.equal(after.system.resolution.effectDice[1].size, 6);
          assert.isNull(after.system.resolution.effectDice[1].dieId);
          assert.isTrue(after.system.resolution.effectDice[1].isDefault);
        });

        it("takes the option on a fresh card with nothing left over (DP-25)", async () => {
          const dice = pool([12, 10, 8]);
          const rolled = applyResults(dice, [3, 9, 8]);
          const [twelveId, tenId, eightId] = dice.map(d => d.id);
          const selection = { ...emptySelection(), totalIds: [tenId, eightId], effectDieIds: [twelveId] };
          const resolved = resolve(rolled, selection);
          const overflowed = stepEffectDie(rolled, resolved, "e1", 1, "other");

          const message = await createResolvedMessage(dice, rolled, selection, overflowed);
          messages.push(message);

          await applyCardChange(message, { action: "overflow-choice", kind: "take-out" });

          const after = game.messages.get(message.id);
          assert.isTrue(after.system.resolution.takeOut);
          assert.isNull(after.system.resolution.overflow);
          assert.lengthOf(after.system.resolution.effectDice, 1, "take-out leaves effectDice untouched");
        });

        it("offers the leftover d8 and stores it when chosen (DP-25c)", async () => {
          const dice = pool([12, 10, 8, 8]);
          const rolled = applyResults(dice, [3, 9, 8, 4]);
          const [twelveId, tenId, firstEightId, secondEightId] = dice.map(d => d.id);
          const selection = {
            ...emptySelection(), totalIds: [tenId, firstEightId], effectDieIds: [twelveId]
          };
          const resolved = resolve(rolled, selection);
          const overflowed = stepEffectDie(rolled, resolved, "e1", 1, "other");

          assert.deepEqual(overflowed.overflow.options.leftovers, [{ dieId: secondEightId, size: 8 }]);
          assert.equal(overflowed.overflow.options.newDie, 6);
          assert.isTrue(overflowed.overflow.options.takeOutAvailable);

          const message = await createResolvedMessage(dice, rolled, selection, overflowed);
          messages.push(message);

          await applyCardChange(message, {
            action: "overflow-choice", kind: "leftover", dieId: secondEightId
          });

          const after = game.messages.get(message.id);
          assert.isNull(after.system.resolution.overflow);
          assert.lengthOf(after.system.resolution.effectDice, 2);
          assert.equal(after.system.resolution.effectDice[1].size, 8);
          assert.equal(after.system.resolution.effectDice[1].dieId, secondEightId);
          assert.isFalse(after.system.resolution.effectDice[1].isDefault);
        });

        it('offers the leftover d4 — never a "new" d4 default — and stores it when chosen (DP-25c variant)',
          async () => {
            const dice = pool([12, 10, 8, 4]);
            const rolled = applyResults(dice, [3, 9, 8, 2]);
            const [twelveId, tenId, eightId, fourId] = dice.map(d => d.id);
            const selection = { ...emptySelection(), totalIds: [tenId, eightId], effectDieIds: [twelveId] };
            const resolved = resolve(rolled, selection);
            const overflowed = stepEffectDie(rolled, resolved, "e1", 1, "other");

            assert.deepEqual(overflowed.overflow.options.leftovers, [{ dieId: fourId, size: 4 }]);
            assert.equal(overflowed.overflow.options.newDie, 6, 'the "new die" option is never a d4');
            assert.isTrue(overflowed.overflow.options.takeOutAvailable);

            const message = await createResolvedMessage(dice, rolled, selection, overflowed);
            messages.push(message);

            await applyCardChange(message, { action: "overflow-choice", kind: "leftover", dieId: fourId });

            const after = game.messages.get(message.id);
            assert.equal(after.system.resolution.effectDice[1].size, 4);
            assert.equal(after.system.resolution.effectDice[1].dieId, fourId);
            assert.isFalse(after.system.resolution.effectDice[1].isDefault, "a real d4 leftover, not a default");
          });
      });

      describe("refusals", () => {
        it("refuses a step down from a d4 effect die by throwing EFFECT_DIE_D4_STEP_DOWN (RQ-009, open)",
          async () => {
            const dice = pool([8, 6, 4]);
            const rolled = applyResults(dice, [1, 1, 1]); // all hitches: a botch
            const selection = emptySelection();
            const resolution = resolve(rolled, selection); // valid: an empty selection on a botch

            const message = await createResolvedMessage(dice, rolled, selection, resolution);
            messages.push(message);

            let thrown = null;
            try {
              await applyCardChange(message, { action: "step-effect-die", effectId: "e1", steps: -1 });
            } catch ( err ) {
              thrown = err;
            }
            assert.isNotNull(thrown, "stepping a d4 effect die down should throw");
            assert.equal(thrown.message, EFFECT_DIE_D4_STEP_DOWN);

            const after = game.messages.get(message.id);
            assert.deepEqual(after.system.toObject().resolution.effectDice, [
              { id: "e1", kind: "default", size: 4, dieId: null, isDefault: true }
            ]);
          });

        it("refuses a malformed step-effect-die change and stores nothing", async () => {
          const dice = pool([10, 8, 6]);
          const rolled = applyResults(dice, [7, 5, 3]);
          const [tenId, eightId, sixId] = dice.map(d => d.id);
          const selection = { ...emptySelection(), totalIds: [tenId, eightId], effectDieIds: [sixId] };
          const resolution = resolve(rolled, selection);

          const message = await createResolvedMessage(dice, rolled, selection, resolution);
          messages.push(message);

          await applyCardChange(message, { action: "step-effect-die", effectId: "e1", steps: 2 });
          await applyCardChange(message, { action: "step-effect-die", effectId: "e99", steps: 1 });

          const after = game.messages.get(message.id);
          assert.deepEqual(after.system.toObject().resolution, resolution);
        });

        it("refuses a change from a user who isn't the owner or the GM (ADR-013)", async () => {
          const dice = pool([10, 8, 6]);
          const rolled = applyResults(dice, [7, 5, 3]);
          const [tenId, eightId, sixId] = dice.map(d => d.id);
          const selection = { ...emptySelection(), totalIds: [tenId, eightId], effectDieIds: [sixId] };
          const resolution = resolve(rolled, selection);

          const message = await createResolvedMessage(dice, rolled, selection, resolution);
          messages.push(message);

          const stranger = await User.create({ name: "cortex-prime-test-stranger", role: CONST.USER_ROLES.PLAYER });
          const originalUser = game.users.current;
          try {
            game.users.current = stranger;
            await applyCardChange(message, { action: "step-effect-die", effectId: "e1", steps: 1 });
          } finally {
            game.users.current = originalUser;
            await stranger.delete();
          }

          const after = game.messages.get(message.id);
          assert.deepEqual(after.system.toObject().resolution, resolution);
        });
      });
    },
    { displayName: "Cortex Prime: effect" }
  );
}
