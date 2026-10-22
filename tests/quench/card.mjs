/**
 * Quench batch "cortex-prime.card": posting a poolRoll chat card (Decisions ADR-009, ADR-010).
 * @module tests/quench/card
 */

import {
  applyOverflowChoice, applyResults, buildPool, resolve, stepEffectDie, twoHighest
} from "../../module/rules/index.mjs";
import { POOL_ROLL_SCHEMA_VERSION } from "../../module/data/chat/pool-roll.mjs";
import { postPoolRoll } from "../../module/dice/post-pool-roll.mjs";
import { notifyCardError, onRenderPoolRollMessage, renderPoolRollCard } from "../../module/dice/pool-roll-card.mjs";

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
        it("creates a poolRoll message with the suggestion pre-selected (DP-13, ADR-019)", async () => {
          const dice = pool([10, 8, 6]);
          const results = [7, 5, 3];

          const message = await postPoolRoll({ pool: dice, results });
          messages.push(message);

          const [tenId, eightId, sixId] = dice.map(d => d.id);
          assert.equal(message.type, "poolRoll");
          assert.equal(message.system.state, "rolled");
          assert.equal(message.system.resolution, null);
          assert.deepEqual(message.system.toObject().pool, dice);
          assert.deepEqual(message.system.toObject().rolled, applyResults(dice, results));
          assert.deepEqual(message.system.toObject().selection,
            { ...emptySelection(), totalIds: [tenId, eightId], effectDieIds: [sixId] });
        });

        it("pre-selects nothing for a botch and offers no reset (DP-09, ADR-019)", async () => {
          const message = await postPoolRoll({ pool: pool([8, 6]), results: [1, 1] });
          messages.push(message);

          assert.deepEqual(message.system.toObject().selection, emptySelection());
          const html = foundry.utils.parseHTML(await renderPoolRollCard(message));
          assert.isNull(html.querySelector('[data-action="two-highest"]'));
          assert.isNotNull(html.querySelector('[data-action="confirm"]:not([disabled])'), "a botch can be confirmed");
        });

        it("renders core roll markup: one li.roll.dN per die, roles as classes, labels as tooltips", async () => {
          const dice = pool([10, 8, 6, 4]);
          const results = [1, 6, 5, 3]; // the d10 is a hitch

          const message = await postPoolRoll({ pool: dice, results });
          messages.push(message);

          const html = foundry.utils.parseHTML(await renderPoolRollCard(message));
          const rolls = html.querySelectorAll(".dice-roll .dice-tooltip ol.dice-rolls li.roll.die");
          assert.deepEqual([...rolls].map(li => [...li.classList].find(c => /^d\d+$/.test(c))), ["d10", "d8", "d6", "d4"]);
          assert.deepEqual([...rolls].map(li => li.textContent.trim()), ["1", "6", "5", "3"]);
          assert.lengthOf(html.querySelectorAll("li.roll.cp-total"), 2, "d8 and d6 are suggested for the total");
          assert.lengthOf(html.querySelectorAll("li.roll.cp-effect"), 1, "the d4 is the suggested effect die");
          assert.include(rolls[1].dataset.tooltipText, "Trait d8");
          assert.isNotNull(html.querySelector(".dice-formula"));

          const hitches = html.querySelectorAll("li.roll.min");
          assert.lengthOf(hitches, 1);
          assert.isFalse(hitches[0].classList.contains("cp-clickable"), "a hitch should never be clickable");
          assert.isNull(hitches[0].getAttribute("data-action"), "a hitch should have no data-action");
        });

        it("shows the botch headline for an all-hitches roll (DP-09)", async () => {
          const dice = pool([8, 6, 4]);
          const results = [1, 1, 1]; // every die is a hitch: a botch

          const message = await postPoolRoll({ pool: dice, results });
          messages.push(message);

          const html = foundry.utils.parseHTML(await renderPoolRollCard(message));
          const headline = html.querySelector(".dice-total.failure");
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
            system: { schemaVersion: POOL_ROLL_SCHEMA_VERSION, pool: dice, rolled, selection, resolution, state: "resolved" }
          });
          messages.push(message);

          const html = foundry.utils.parseHTML(await renderPoolRollCard(message));
          const expected = game.i18n.format("CORTEX.Chat.ResolvedHeadline", { total: 12, effect: "d6" });
          assert.equal(html.querySelector(".dice-total").textContent.trim(), expected);
          assert.isFalse(html.querySelector(".dice-total").classList.contains("cp-preview"));
          assert.isNull(html.querySelector(".cp-selection"), "a resolved card has no selection controls");
        });

        it("offers a step-down on a d4 effect die and names the die by its effect id (DP-24b, ADR-026)", async () => {
          const dice = pool([10, 8, 4]);
          const rolled = applyResults(dice, [7, 5, 3]);
          const [tenId, eightId, fourId] = dice.map(d => d.id);
          const selection = { ...emptySelection(), totalIds: [tenId, eightId], effectDieIds: [fourId] };
          const resolution = resolve(rolled, selection);

          const message = await ChatMessage.create({
            type: "poolRoll",
            system: { schemaVersion: POOL_ROLL_SCHEMA_VERSION, pool: dice, rolled, selection, resolution, state: "resolved" }
          });
          messages.push(message);

          const html = foundry.utils.parseHTML(await renderPoolRollCard(message));
          const stepDown = html.querySelector('[data-action="step-effect-die"][data-steps="-1"]');
          assert.isNotNull(stepDown, "a d4 effect die can be stepped down");
          assert.equal(stepDown.dataset.effectId, "e1");
          assert.isNull(html.querySelector("[data-effect-index]"), "no index-based controls are left");
        });

        it('shows "no effect die" and the removed die as used up once a d4 effect die is gone (DP-24b, DP-24c)',
          async () => {
            const dice = pool([10, 8, 4]);
            const rolled = applyResults(dice, [7, 5, 3]);
            const [tenId, eightId, fourId] = dice.map(d => d.id);
            const selection = { ...emptySelection(), totalIds: [tenId, eightId], effectDieIds: [fourId] };
            const resolution = stepEffectDie(rolled, resolve(rolled, selection), "e1", -1, "other");

            const message = await ChatMessage.create({
              type: "poolRoll",
              system: {
                schemaVersion: POOL_ROLL_SCHEMA_VERSION, pool: dice, rolled, selection, resolution, state: "resolved"
              }
            });
            messages.push(message);

            const html = foundry.utils.parseHTML(await renderPoolRollCard(message));
            const expected = game.i18n.format("CORTEX.Chat.ResolvedHeadlineNoEffect", { total: 12 });
            assert.notEqual(expected, "CORTEX.Chat.ResolvedHeadlineNoEffect", "the string exists");
            assert.equal(html.querySelector(".dice-total").textContent.trim(), expected);

            const four = html.querySelector(`li.roll[data-die-id="${fourId}"]`);
            assert.isTrue(four.classList.contains("cp-used-up"), "the removed effect die's die is used up");
            assert.isTrue(four.classList.contains("discarded"), "used up is muted like unused");
            const usedUp = game.i18n.localize("CORTEX.Chat.Role.UsedUp");
            assert.notEqual(usedUp, "CORTEX.Chat.Role.UsedUp", "the role string exists");
            assert.include(four.dataset.tooltipText, usedUp);
            assert.include(four.dataset.tooltipText, game.i18n.localize("CORTEX.Chat.Role.UsedUpTooltip"));
            assert.notInclude(four.dataset.tooltipText, game.i18n.localize("CORTEX.Chat.Role.Unused"));
          });

        it('labels only the d4 default as "default d4", not an overflow d6 (ADR-026)', async () => {
          const dice = pool([12, 10, 8]);
          const rolled = applyResults(dice, [3, 9, 8]);
          const [twelveId, tenId, eightId] = dice.map(d => d.id);
          const selection = { ...emptySelection(), totalIds: [tenId, eightId], effectDieIds: [twelveId] };
          const overflowed = stepEffectDie(rolled, resolve(rolled, selection), "e1", 1, "heroic");
          const resolution = applyOverflowChoice(rolled, overflowed, { kind: "new-d6" });

          const message = await ChatMessage.create({
            type: "poolRoll",
            system: { schemaVersion: POOL_ROLL_SCHEMA_VERSION, pool: dice, rolled, selection, resolution, state: "resolved" }
          });
          messages.push(message);

          const html = foundry.utils.parseHTML(await renderPoolRollCard(message));
          const expected = game.i18n.format("CORTEX.Chat.ResolvedHeadline", { total: 17, effect: "d12, d6" });
          assert.equal(html.querySelector(".dice-total").textContent.trim(), expected);
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
          const expected = game.i18n.format("CORTEX.Chat.ResolvedHeadline", { total: 12, effect: "d6" });
          const total = html.querySelector(".dice-total");
          assert.equal(total.textContent.trim(), expected);
          assert.isTrue(total.classList.contains("cp-preview"), "an unconfirmed selection is marked as a preview");
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
          assert.isNull(html.querySelector(".cp-selection"));
          assert.equal(html.querySelector(".dice-total").textContent.trim(), game.i18n.localize("CORTEX.Chat.Choosing"));
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

          assert.isNotNull(content.querySelector(".cp-selection"), "controls show before reroll mode");
          assert.equal(toggle().textContent.trim(), game.i18n.localize("CORTEX.Chat.Reroll"));

          toggle().click();

          assert.isNull(content.querySelector(".cp-selection"), "shortcuts/counters/Confirm hide in reroll mode");
          assert.isNotNull(content.querySelector('[data-action="reroll"]'), "Reroll Marked shows in reroll mode");
          assert.equal(toggle().textContent.trim(), game.i18n.localize("CORTEX.Chat.CancelReroll"));

          toggle().click();

          assert.isNotNull(content.querySelector(".cp-selection"), "controls show again after cancelling");
          assert.equal(toggle().textContent.trim(), game.i18n.localize("CORTEX.Chat.Reroll"));
        });

        it("shows a coded error's own string and a generic one for anything else, never a raw key", () => {
          const shown = [];
          const logged = [];
          const unexpected = new Error("applyRerolls: no die with id x");
          const originalError = ui.notifications.error;
          const originalConsoleError = console.error;
          try {
            ui.notifications.error = text => shown.push(text);
            console.error = err => logged.push(err);

            notifyCardError(Object.assign(new Error("readable message"), { code: "HITCH_SELECTED" }));
            notifyCardError(unexpected);
            notifyCardError(Object.assign(new Error("readable message"), { code: "NO_SUCH_CODE" }));
          } finally {
            ui.notifications.error = originalError;
            console.error = originalConsoleError;
          }

          const generic = game.i18n.localize("CORTEX.Chat.Errors.Unexpected");
          assert.notEqual(generic, "CORTEX.Chat.Errors.Unexpected", "the generic string exists");
          assert.deepEqual(shown, [game.i18n.localize("CORTEX.Chat.Errors.HITCH_SELECTED"), generic, generic]);
          assert.lengthOf(logged, 2, "only the uncoded and unknown-code errors are logged");
          assert.strictEqual(logged[0], unexpected);
          assert.isFalse(shown.some(text => text.startsWith("CORTEX.")), "no raw key on screen");
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
