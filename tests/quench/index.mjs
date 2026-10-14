/**
 * Quench test batches for the Cortex Prime system.
 *
 * Loaded dynamically by module/cortex-prime.mjs only when the Quench module is
 * active (dev world `cp-tests`). Not part of release builds.
 * Run from the Quench window, or from the console: `quench.runBatches("cortex-prime.**")`.
 * @module tests/quench
 */

import { registerChatBatch } from "./chat.mjs";

/**
 * Register all Cortex Prime batches with Quench.
 * @param {object} quench  The Quench API object passed to the `quenchReady` hook.
 */
export function registerQuenchBatches(quench) {
  registerChatBatch(quench);

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
