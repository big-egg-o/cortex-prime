/**
 * Quench batch "cortex-prime.reroll": rerolling dice before confirming a poolRoll card
 * (Decisions ADR-013, ADR-017; Dice & Pools rules 25-26, DP-27 to DP-29).
 * @module tests/quench/reroll
 */

import { applyResults, buildPool, evaluate, resolve, validateSelection } from "../../module/rules/index.mjs";
import { applyCardChange } from "../../module/dice/card-actions.mjs";
import { POOL_ROLL_SCHEMA_VERSION } from "../../module/data/chat/pool-roll.mjs";
import { postPoolRoll } from "../../module/dice/post-pool-roll.mjs";

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
 * Register the batch with Quench.
 * @param {object} quench
 */
export function registerRerollBatch(quench) {
  quench.registerBatch(
    "cortex-prime.reroll",
    ({ describe, it, assert, afterEach }) => {
      /** @type {ChatMessage[]} */
      let messages = [];

      afterEach(async () => {
        for ( const message of messages ) await message.delete();
        messages = [];
      });

      describe("rerolling before confirming", () => {
        it("rerolls a hitch and re-suggests, then resolves to total 11, effect d6 (DP-27, ADR-019)",
          async () => {
            const dice = pool([8, 6, 6]);
            const message = await postPoolRoll({ pool: dice, results: [1, 5, 4] });
            messages.push(message);
            const [eightId, firstSixId, secondSixId] = message.system.pool.map(d => d.id);
            await applyCardChange(message, { action: "increment-extra-effect-dice" });

            await applyCardChange(message, { action: "reroll", dieIds: [eightId], results: { [eightId]: 6 } });

            const afterReroll = game.messages.get(message.id);
            assert.equal(afterReroll.system.rolled.find(d => d.id === eightId).result, 6);
            assert.isFalse(afterReroll.system.rolled.find(d => d.id === eightId).hitch);
            assert.isFalse(evaluate(afterReroll.system.rolled).botch);
            assert.deepEqual(afterReroll.system.selection.totalIds, [eightId, firstSixId], "the new suggestion");
            assert.deepEqual(afterReroll.system.selection.effectDieIds, [secondSixId]);
            assert.equal(afterReroll.system.selection.extraEffectDicePaid, 1, "a reroll keeps the paid counters");
            assert.equal(afterReroll.system.state, "rolled");

            await applyCardChange(message, { action: "decrement-extra-effect-dice" });
            await applyCardChange(message, { action: "confirm" });

            const resolved = game.messages.get(message.id);
            assert.equal(resolved.system.resolution.total, 11);
            assert.equal(resolved.system.resolution.effectDice[0].size, 6);
          });

        const confirmableAfterReroll = [
          { name: "a d8 hitch rerolled into another 1 leaves two usable dice: total 9, effect d4",
            sizes: [8, 6, 6], results: [1, 5, 4], reroll: [1], total: 9, effect: 4 },
          { name: "a botch rerolled to 4 and 3: total 7, effect d4",
            sizes: [6, 6], results: [1, 1], reroll: [4, 3], total: 7, effect: 4 },
          { name: "a botch rerolled to 1 and 3: total 3, effect d4",
            sizes: [6, 6], results: [1, 1], reroll: [1, 3], total: 3, effect: 4 }
        ];
        for ( const c of confirmableAfterReroll ) {
          it(`reroll, "Two highest", Confirm resolves ${c.name}`, async () => {
            const message = await postPoolRoll({ pool: pool(c.sizes), results: c.results });
            messages.push(message);
            const ids = message.system.pool.map(d => d.id).slice(0, c.reroll.length);
            const results = Object.fromEntries(ids.map((id, i) => [id, c.reroll[i]]));

            await applyCardChange(message, { action: "reroll", dieIds: ids, results });
            await applyCardChange(message, { action: "two-highest" });
            const chosen = game.messages.get(message.id).system;
            assert.isTrue(validateSelection(chosen.rolled, chosen.selection).valid, "the suggestion must be valid");
            const expected = resolve(chosen.rolled, chosen.selection);

            await applyCardChange(message, { action: "confirm" });

            const resolved = game.messages.get(message.id).system;
            assert.equal(resolved.state, "resolved");
            assert.equal(resolved.resolution.total, expected.total);
            assert.equal(resolved.resolution.total, c.total);
            assert.deepEqual(resolved.resolution.effectDice.map(e => e.size), [c.effect]);
          });
        }

        it("refuses to reroll an already-activated hitch and stores nothing (rule 26, DP-28)", async () => {
          const dice = pool([8, 6, 6]);
          const rolled = applyResults(dice, [1, 5, 4]);
          const [eightId] = dice.map(d => d.id);
          rolled[0] = { ...rolled[0], state: "hitch-activated" };

          const message = await ChatMessage.create({
            type: "poolRoll",
            system: {
              schemaVersion: POOL_ROLL_SCHEMA_VERSION, pool: dice, rolled, selection: emptySelection(), resolution: null, state: "rolled"
            }
          });
          messages.push(message);
          const before = message.system.toObject();

          await applyCardChange(message, { action: "reroll", dieIds: [eightId], results: { [eightId]: 6 } });

          const after = game.messages.get(message.id);
          assert.deepEqual(after.system.toObject(), before);
        });

        it("rerolls a botch into a resolvable total 7, effect d4 default (DP-29)", async () => {
          const dice = pool([6, 6]);
          const message = await postPoolRoll({ pool: dice, results: [1, 1] });
          messages.push(message);
          const [firstId, secondId] = message.system.pool.map(d => d.id);

          assert.isTrue(evaluate(message.system.rolled).botch, "fixture should start as a botch");

          await applyCardChange(message, {
            action: "reroll", dieIds: [firstId, secondId], results: { [firstId]: 4, [secondId]: 3 }
          });

          const afterReroll = game.messages.get(message.id);
          assert.isFalse(evaluate(afterReroll.system.rolled).botch);

          await applyCardChange(message, { action: "two-highest" });
          await applyCardChange(message, { action: "confirm" });

          const resolved = game.messages.get(message.id);
          assert.equal(resolved.system.resolution.total, 7);
          assert.lengthOf(resolved.system.resolution.effectDice, 1);
          assert.equal(resolved.system.resolution.effectDice[0].size, 4);
          assert.isTrue(resolved.system.resolution.effectDice[0].isDefault);
        });

        it("appends a real reroll to message.rolls, within range and matching the stored result", async () => {
          const dice = pool([8, 6]);
          const message = await postPoolRoll({ pool: dice, results: [5, 3] });
          messages.push(message);
          const [eightId] = message.system.pool.map(d => d.id);
          const rollCountBefore = message.rolls.length;

          await applyCardChange(message, { action: "reroll", dieIds: [eightId] }); // no fixed results: a real Roll

          const after = game.messages.get(message.id);
          assert.lengthOf(after.rolls, rollCountBefore + 1, "message.rolls should grow by exactly one");

          const newRoll = after.rolls[after.rolls.length - 1];
          const newResult = newRoll.dice[0].results[0].result;
          assert.isAtLeast(newResult, 1);
          assert.isAtMost(newResult, 8);

          const rerolledDie = after.system.rolled.find(d => d.id === eightId);
          assert.equal(rerolledDie.result, newResult, "the stored rolled list should match the new Roll's result");
        });

        it("refuses a reroll on a resolved card", async () => {
          const dice = pool([10, 8, 6]);
          const rolled = applyResults(dice, [7, 5, 3]);
          const [tenId, eightId, sixId] = dice.map(d => d.id);
          const selection = { ...emptySelection(), totalIds: [tenId, eightId], effectDieIds: [sixId] };
          const resolution = resolve(rolled, selection);

          const message = await ChatMessage.create({
            type: "poolRoll",
            system: { schemaVersion: POOL_ROLL_SCHEMA_VERSION, pool: dice, rolled, selection, resolution, state: "resolved" }
          });
          messages.push(message);
          const before = message.system.toObject();

          await applyCardChange(message, { action: "reroll", dieIds: [tenId], results: { [tenId]: 1 } });

          const after = game.messages.get(message.id);
          assert.deepEqual(after.system.toObject(), before);
        });

        it("refuses a change from a user who isn't the owner or the GM (ADR-013)", async () => {
          const dice = pool([8, 6]);
          const message = await postPoolRoll({ pool: dice, results: [5, 3] });
          messages.push(message);
          const [eightId] = message.system.pool.map(d => d.id);
          const before = message.system.toObject();

          const stranger = await User.create({ name: "cortex-prime-test-stranger", role: CONST.USER_ROLES.PLAYER });
          const originalUser = game.users.current;
          try {
            game.users.current = stranger;
            await applyCardChange(message, { action: "reroll", dieIds: [eightId], results: { [eightId]: 1 } });
          } finally {
            game.users.current = originalUser;
            await stranger.delete();
          }

          const after = game.messages.get(message.id);
          assert.deepEqual(after.system.toObject(), before);
        });
      });
    },
    { displayName: "Cortex Prime: reroll" }
  );
}
