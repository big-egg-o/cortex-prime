/**
 * Quench batch "cortex-prime.card": posting a poolRoll chat card (Decisions ADR-009, ADR-010).
 * @module tests/quench/card
 */

import { applyResults, buildPool, resolve, twoHighest } from "../../module/rules/index.mjs";
import { postPoolRoll } from "../../module/dice/post-pool-roll.mjs";
import { onRenderPoolRollMessage, renderPoolRollCard } from "../../module/dice/pool-roll-card.mjs";

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
          assert.deepEqual(message.system.toObject().selection, emptySelection());
        });

        it("renders one entry per die; a hitch has no data-action and isn't clickable", async () => {
          const dice = pool([10, 8, 6, 4]);
          const results = [1, 6, 5, 3]; // the d10 is a hitch

          const message = await postPoolRoll({ pool: dice, results });
          messages.push(message);

          const html = foundry.utils.parseHTML(await renderPoolRollCard(message));
          assert.lengthOf(html.querySelectorAll(".die"), 4);

          const hitches = html.querySelectorAll(".die.role-hitch");
          assert.lengthOf(hitches, 1);
          assert.isFalse(hitches[0].classList.contains("clickable"), "a hitch should never be clickable");
          assert.isNull(hitches[0].getAttribute("data-action"), "a hitch should have no data-action");
        });

        it("shows the botch headline for an all-hitches roll (DP-09)", async () => {
          const dice = pool([8, 6, 4]);
          const results = [1, 1, 1]; // every die is a hitch: a botch

          const message = await postPoolRoll({ pool: dice, results });
          messages.push(message);

          const html = foundry.utils.parseHTML(await renderPoolRollCard(message));
          const headline = html.querySelector(".headline.botch");
          assert.isNotNull(headline, "the card should show a botch headline");
          assert.equal(headline.textContent.trim(), game.i18n.localize("CORTEX.Chat.Botch"));
        });

        it("shows the resolved headline's total and effect die (DP-13)", async () => {
          const dice = pool([10, 8, 6]);
          const rolled = applyResults(dice, [7, 5, 3]);
          const totalIds = twoHighest(rolled, 2);
          const effectDieIds = rolled.filter(d => !totalIds.includes(d.id)).map(d => d.id);
          const selection = { ...emptySelection(), totalIds, effectDieIds };
          const resolution = resolve(rolled, selection);

          const message = await ChatMessage.create({
            type: "poolRoll",
            system: { schemaVersion: 1, pool: dice, rolled, selection, resolution, state: "resolved" }
          });
          messages.push(message);

          const html = foundry.utils.parseHTML(await renderPoolRollCard(message));
          const expected = game.i18n.format("CORTEX.Chat.ResolvedHeadline", { total: 12, effect: "d6" });
          assert.equal(html.querySelector(".headline").textContent.trim(), expected);
          assert.isNull(html.querySelector(".pool-selection"), "a resolved card has no controls");
        });

        it("shows a preview headline for a valid, unconfirmed selection (DP-13)", async () => {
          const dice = pool([10, 8, 6]);
          const results = [7, 5, 3];

          const message = await postPoolRoll({ pool: dice, results });
          messages.push(message);

          const [tenId, eightId, sixId] = message.system.pool.map(d => d.id);
          await message.update({
            "system.selection": { ...emptySelection(), totalIds: [tenId, eightId], effectDieIds: [sixId] }
          });

          const html = foundry.utils.parseHTML(await renderPoolRollCard(message));
          const expected = game.i18n.format("CORTEX.Chat.PreviewHeadline", { total: 12, effect: "d6" });
          assert.equal(html.querySelector(".headline").textContent.trim(), expected);
        });

        it('shows "Choosing…" and no controls for a non-interactive viewer', async () => {
          const dice = pool([10, 8]);
          const rolled = applyResults(dice, [7, 5]);
          const stub = {
            type: "poolRoll",
            system: { rolled, selection: emptySelection(), resolution: null, state: "rolled" },
            canUserModify: () => false
          };

          const html = foundry.utils.parseHTML(await renderPoolRollCard(stub));
          assert.isNull(html.querySelector(".pool-selection"));
          assert.equal(html.querySelector(".headline").textContent.trim(), game.i18n.localize("CORTEX.Chat.Choosing"));
        });

        it("hides the shortcuts, counters and Confirm during reroll mode, showing them again on cancel", async () => {
          const dice = pool([10, 8, 6]);
          const results = [7, 5, 3];

          const message = await postPoolRoll({ pool: dice, results });
          messages.push(message);

          const html = document.createElement("div");
          html.innerHTML = '<div class="message-content"></div>';
          onRenderPoolRollMessage(message, html);
          const content = html.querySelector(".message-content");
          const toggle = () => content.querySelector('[data-action="toggle-reroll-mode"]');

          assert.isNotNull(content.querySelector(".pool-selection"), "controls show before reroll mode");
          assert.equal(toggle().textContent.trim(), game.i18n.localize("CORTEX.Chat.Reroll"));

          toggle().click();

          assert.isNull(content.querySelector(".pool-selection"), "shortcuts/counters/Confirm hide in reroll mode");
          assert.isNotNull(content.querySelector('[data-action="reroll"]'), "Reroll Marked shows in reroll mode");
          assert.equal(toggle().textContent.trim(), game.i18n.localize("CORTEX.Chat.CancelReroll"));

          toggle().click();

          assert.isNotNull(content.querySelector(".pool-selection"), "controls show again after cancelling");
          assert.equal(toggle().textContent.trim(), game.i18n.localize("CORTEX.Chat.Reroll"));
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
