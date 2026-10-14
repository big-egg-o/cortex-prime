/**
 * Cortex Prime system entry point.
 *
 * Registers documents, data models, sheets and settings during `init`.
 * @module cortex-prime
 */

import PoolRollData from "./data/chat/pool-roll.mjs";

/** The package id, as declared in system.json. */
export const SYSTEM_ID = "cortex-prime";

Hooks.once("init", () => {
  console.log(`${SYSTEM_ID} | Initializing`);

  CONFIG.ChatMessage.dataModels.poolRoll = PoolRollData;
});

Hooks.once("ready", () => {
  console.log(`${SYSTEM_ID} | Ready (Foundry ${game.release.version})`);
});

// Dev only: register in-Foundry test batches when the Quench module is active.
// The tests/ folder is not shipped in releases, and Quench is never installed in production.
Hooks.once("quenchReady", async quench => {
  const { registerQuenchBatches } = await import("../tests/quench/index.mjs");
  registerQuenchBatches(quench);
});
