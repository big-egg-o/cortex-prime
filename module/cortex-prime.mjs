/**
 * Cortex Prime system entry point.
 *
 * Registers documents, data models, sheets and settings during `init`.
 * @module cortex-prime
 */

import CharacterData from "./data/actor/character.mjs";
import ContestData from "./data/chat/contest.mjs";
import PoolRollData from "./data/chat/pool-roll.mjs";
import { onRenderPoolRollMessage, preloadPoolRollCardTemplate } from "./dice/pool-roll-card.mjs";
import { togglePoolBuilder } from "./apps/pool-builder.mjs";

/** The package id, as declared in system.json. */
export const SYSTEM_ID = "cortex-prime";

Hooks.once("init", () => {
  console.log(`${SYSTEM_ID} | Initializing`);

  CONFIG.Actor.dataModels.character = CharacterData;
  CONFIG.ChatMessage.dataModels.poolRoll = PoolRollData;
  CONFIG.ChatMessage.dataModels.contest = ContestData;
  Hooks.on("renderChatMessageHTML", onRenderPoolRollMessage);
  preloadPoolRollCardTemplate(); // fire-and-forget: ready well before the first roll in practice

  // "P" isn't used by any core keybinding in 14.369 (checked the whole client bundle) and
  // reads as "Pool" (Decisions ADR-015); rebindable in Configure Controls.
  game.keybindings.register(SYSTEM_ID, "openPoolBuilder", {
    name: "CORTEX.Keybindings.OpenPoolBuilder",
    editable: [{ key: "KeyP" }],
    onDown: () => { togglePoolBuilder(); return true; }
  });
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
