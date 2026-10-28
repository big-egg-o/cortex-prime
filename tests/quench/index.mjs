/**
 * Quench test batches for the Cortex Prime system.
 *
 * Loaded dynamically by module/cortex-prime.mjs only when the Quench module is
 * active (dev world `cp-tests`). Not part of release builds.
 * Run from the Quench window, or from the console: `quench.runBatches("cortex-prime.**")`.
 * @module tests/quench
 */

import { registerBuilderBatch } from "./builder.mjs";
import { registerCardBatch } from "./card.mjs";
import { registerCharacterBatch } from "./character.mjs";
import { registerChatBatch } from "./chat.mjs";
import { registerDiceBatch } from "./dice.mjs";
import { registerEffectBatch } from "./effect.mjs";
import { registerMigrationBatch } from "./migration.mjs";
import { registerRatingFieldBatch } from "./rating-field.mjs";
import { registerRerollBatch } from "./reroll.mjs";
import { registerSelectionBatch } from "./selection.mjs";

/**
 * Register all Cortex Prime batches with Quench.
 * @param {object} quench  The Quench API object passed to the `quenchReady` hook.
 */
export function registerQuenchBatches(quench) {
  registerChatBatch(quench);
  registerDiceBatch(quench);
  registerCardBatch(quench);
  registerSelectionBatch(quench);
  registerEffectBatch(quench);
  registerMigrationBatch(quench);
  registerRerollBatch(quench);
  registerBuilderBatch(quench);
  registerRatingFieldBatch(quench);
  registerCharacterBatch(quench);

  quench.registerBatch(
    "cortex-prime.smoke",
    ({ describe, it, assert }) => {
      describe("System bootstrap", () => {
        it("is the active game system", () => {
          assert.equal(game.system.id, "cortex-prime");
        });

        it("runs on the Foundry build the system is verified for", () => {
          assert.equal(game.release.version, game.system.compatibility.verified);
        });
      });
    },
    { displayName: "Cortex Prime: smoke" }
  );
}
