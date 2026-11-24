/**
 * Cortex Prime system entry point.
 *
 * Registers documents, data models, sheets and settings during `init`.
 * @module cortex-prime
 */

import CharacterData, { GmcData, PlayerCharacterData } from "./data/actor/character.mjs";
import ContestData from "./data/chat/contest.mjs";
import PoolRollData from "./data/chat/pool-roll.mjs";
import PlotPointsData from "./data/chat/plot-points.mjs";
import PlotPointsApp from "./apps/plot-points-app.mjs";
import { registerPlotPointSettings } from "./plot-points/accounts.mjs";
import { registerTraitStore } from "./assets/trait-store.mjs";
import TraitTrackerApp from "./apps/trait-tracker-app.mjs";
import { onRenderPoolRollMessage, preloadPoolRollCardTemplate } from "./dice/pool-roll-card.mjs";
import { openPoolBuilder, refreshPoolDestination, togglePoolBuilder } from "./apps/pool-builder.mjs";
import { registerSettings } from "./config/settings.mjs";
import { registerContestQuery } from "./contest/relay.mjs";
import {
  onRenderContestMessage, preloadContestCardTemplate, refreshContestCards, refreshRollCards
} from "./contest/contest-card.mjs";
import { startContestContextOption } from "./contest/start-dialog.mjs";
import GameConfigApp from "./apps/game-config-app.mjs";
import CharacterSheet from "./apps/character-sheet.mjs";

/** The package id, as declared in system.json. */
export const SYSTEM_ID = "cortex-prime";

Hooks.once("init", () => {
  console.log(`${SYSTEM_ID} | Initializing`);

  CONFIG.Actor.dataModels.character = CharacterData;
  CONFIG.Actor.dataModels.pc = PlayerCharacterData;
  CONFIG.Actor.dataModels.gmc = GmcData;
  CONFIG.Actor.defaultType = "pc";
  CONFIG.ChatMessage.dataModels.poolRoll = PoolRollData;
  CONFIG.ChatMessage.dataModels.contest = ContestData;
  CONFIG.ChatMessage.dataModels.plotPoints = PlotPointsData;
  // Core 14.369 registers no Actor sheet, so this one is the only and default sheet for characters.
  foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, SYSTEM_ID, CharacterSheet, {
    types: ["character", "pc", "gmc"], makeDefault: true, label: "CORTEX.Sheet.Character"
  });
  Hooks.on("cortexPrimePoolDestinationChanged", () => CharacterSheet.refreshPoolFooters());
  Hooks.on("controlToken", () => {
    CharacterSheet.refreshPoolFooters();
    const builder = foundry.applications.instances.get("cortex-prime-pool-builder");
    if ( builder?.rendered ) builder.render();
  });
  Hooks.on("updateChatMessage", refreshPoolDestination);
  Hooks.on("deleteChatMessage", refreshPoolDestination);
  Hooks.on("updateUser", (user, changes) => {
    if ( user.id === game.user.id && foundry.utils.hasProperty(changes, "flags.cortex-prime.pool") ) {
      CharacterSheet.refreshPoolFooters();
    }
  });
  registerSettings({ onGameConfigChange: () => CharacterSheet.renderOpenSheets() });
  registerContestQuery();
  registerPlotPointSettings();
  Hooks.on("cortexPrimePlotPointsChanged", () => PlotPointsApp.refresh());
  Hooks.on("updateActor", actor => { if ( actor.type === "pc" ) PlotPointsApp.refresh(); });
  registerTraitStore();
  Hooks.on("cortexPrimeTraitsChanged", () => TraitTrackerApp.refresh());
  game.settings.registerMenu(SYSTEM_ID, "gameConfigMenu", {
    name: "CORTEX.Config.MenuName",
    label: "CORTEX.Config.MenuLabel",
    hint: "CORTEX.Config.MenuHint",
    icon: "fa-solid fa-sliders",
    type: GameConfigApp,
    restricted: true
  });
  Hooks.on("renderChatMessageHTML", onRenderPoolRollMessage);
  preloadPoolRollCardTemplate(); // fire-and-forget: ready well before the first roll in practice
  Hooks.on("renderChatMessageHTML", onRenderContestMessage);
  preloadContestCardTemplate();
  // A held roll card turns sent or free on every client when its test or contest changes or goes.
  Hooks.on("updateChatMessage", refreshRollCards);
  Hooks.on("deleteChatMessage", refreshRollCards);
  // A contest card shows "card deleted" on every client when a roll card it names goes.
  Hooks.on("deleteChatMessage", refreshContestCards);
  Hooks.on("getChatMessageContextOptions", (_app, options) => options.push(startContestContextOption()));

  Hooks.on("getSceneControlButtons", controls => {
    if ( !controls.tokens ) return;
    controls.tokens.tools.cortexPool = {
      name: "cortexPool", title: "CORTEX.Builder.Title", icon: "fa-solid fa-dice-d12",
      order: Object.keys(controls.tokens.tools).length + 1, button: true, control: true,
      onChange: () => openPoolBuilder()
    };
    if ( game.user.isGM ) {
      controls.tokens.tools.cortexPlotPoints = {
        name: "cortexPlotPoints", title: "CORTEX.PlotPoints.Title", icon: "fa-solid fa-coins",
        order: Object.keys(controls.tokens.tools).length + 1, button: true,
        onChange: () => PlotPointsApp.open()
      };
      controls.tokens.tools.cortexTraits = {
        name: "cortexTraits", title: "CORTEX.Assets.Tracker", icon: "fa-solid fa-list-check",
        order: Object.keys(controls.tokens.tools).length + 1, button: true,
        onChange: () => TraitTrackerApp.open()
      };
    }
  });

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
