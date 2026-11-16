/**
 * A total entered by hand for a test or contest (Decisions ADR-021; ADR-020, Step 4.4 S4a proposal
 * review): a dialog with the total and, for effect dice typed by hand, one count per die size. It
 * sends an add-roll request through the card's sendCardAction; the engine checks the values.
 * @module contest/total-dialog
 */

import { DIE_SIZES } from "../rules/index.mjs";
import { sendCardAction } from "./contest-card.mjs";

/**
 * The add-roll payload for a typed total, from the dialog's form data: `total`, and a count under
 * "d4", "d6", "d8", "d10" and "d12". The effect dice are listed largest first; a count that isn't
 * a whole number of 1 or more adds none. The total goes through as entered, for the engine to check.
 * @param {string} side - the side the total is entered for
 * @param {{total?: unknown, d4?: unknown, d6?: unknown, d8?: unknown, d10?: unknown, d12?: unknown}} data
 * @returns {{side: string, total: unknown, effectSizes: number[]}}
 */
export function typedRollPayload(side, data) {
  const effectSizes = [];
  for ( const size of [...DIE_SIZES].sort((a, b) => b - a) ) {
    const count = data?.[`d${size}`];
    if ( Number.isInteger(count) && (count >= 1) ) effectSizes.push(...Array(count).fill(size));
  }
  return { side, total: data?.total, effectSizes };
}

/**
 * Asks for a typed total and its effect dice, and sends them for a side.
 * @param {ChatMessage} message - a contest message
 * @param {string} side - the side expected to roll
 * @returns {Promise<{ok: boolean, code?: string, value?: object}|null>} the relay's answer, or null
 *   when the dialog was dismissed
 */
export async function openTotalDialog(message, side) {
  const counts = DIE_SIZES.map(size => `
    <label class="cp-total-count">d${size}
      <input type="number" name="d${size}" value="0" min="0" step="1">
    </label>`).join("");
  const content = `
    <div class="form-group">
      <label for="cp-typed-total">${game.i18n.localize("CORTEX.Contest.Total.Total")}</label>
      <div class="form-fields">
        <input id="cp-typed-total" type="number" name="total" min="0" step="1" required autofocus>
      </div>
    </div>
    <fieldset class="cp-total-effects">
      <legend>${game.i18n.localize("CORTEX.Contest.Total.EffectDice")}</legend>
      <div class="form-fields">${counts}</div>
      <p class="hint">${game.i18n.localize("CORTEX.Contest.Total.EffectDiceHint")}</p>
    </fieldset>`;
  const data = await foundry.applications.api.DialogV2.input({
    window: { title: "CORTEX.Contest.Total.Title" },
    classes: ["cortex-prime", "contest-total"],
    content,
    ok: { label: "CORTEX.Contest.Total.Submit", icon: "fa-solid fa-check" }
  });
  if ( !data || (typeof data !== "object") ) return null;
  return sendCardAction(message, "add-roll", typedRollPayload(side, data));
}
