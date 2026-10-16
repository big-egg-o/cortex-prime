/**
 * Quench batch "cortex-prime.card": posting a poolRoll chat card (Decisions ADR-009, ADR-010).
 * @module tests/quench/card
 */

import { applyResults, buildPool } from "../../module/rules/index.mjs";
import { postPoolRoll } from "../../module/dice/post-pool-roll.mjs";
import { onRenderPoolRollMessage, renderPoolRollCard } from "../../module/dice/pool-roll-card.mjs";

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
export function registerCardBatch(quench) {
  quench.registerBatch(
    "cortex-prime.card",
    ({ describe, it, assert, afterEach }) => {
      /** @type {ChatMessage[]} */
      let messages = [];

      afterEach(async () => {
        for ( const message of messages ) await message.delete();
        messages = [];
      });

      describe("posting a poolRoll card", () => {
        it("creates a poolRoll message with the right system data", async () => {
          const dice = pool([10, 8, 6]);
          const results = [7, 5, 3];

          const message = await postPoolRoll({ pool: dice, results });
          messages.push(message);

          assert.equal(message.type, "poolRoll");
          assert.equal(message.system.state, "rolled");
          assert.equal(message.system.resolution, null);
          assert.deepEqual(message.system.toObject().pool, dice);
          assert.deepEqual(message.system.toObject().rolled, applyResults(dice, results));
          assert.deepEqual(message.system.toObject().selection, {
            totalIds: [], effectDieIds: [], extraResultsPaid: 0, extraEffectDicePaid: 0, keepLimit: 2
          });
        });

        it("renders one entry per die, with hitches apart", async () => {
          const dice = pool([10, 8, 6, 4]);
          const results = [1, 6, 5, 3]; // the d10 is a hitch

          const message = await postPoolRoll({ pool: dice, results });
          messages.push(message);

          const html = foundry.utils.parseHTML(await renderPoolRollCard(message));
          assert.lengthOf(html.querySelectorAll(".die"), 4);
          assert.lengthOf(html.querySelectorAll(".hitches .die.hitch"), 1);
          assert.lengthOf(html.querySelectorAll(".dice-group:not(.hitches) .die.hitch"), 0);
        });

        it("shows the botch line for an all-hitches roll (DP-09)", async () => {
          const dice = pool([8, 6, 4]);
          const results = [1, 1, 1]; // every die is a hitch: a botch

          const message = await postPoolRoll({ pool: dice, results });
          messages.push(message);

          const html = foundry.utils.parseHTML(await renderPoolRollCard(message));
          assert.isNotNull(html.querySelector(".botch"), "the card should show a botch line");
        });

        it("leaves the content untouched for a message the current user can't see", () => {
          const html = document.createElement("div");
          html.innerHTML = '<div class="message-content">unchanged</div>';
          const stub = { type: "poolRoll", isContentVisible: false };

          onRenderPoolRollMessage(stub, html);

          assert.equal(html.querySelector(".message-content").innerHTML, "unchanged");
        });
      });
    },
    { displayName: "Cortex Prime: card" }
  );
}
