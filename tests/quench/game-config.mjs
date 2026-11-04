/**
 * Quench batch "cortex-prime.game-config": the game configuration world setting (Decisions
 * ADR-030, ADR-036). Run as a Gamemaster; the batch puts the stored configuration back as it found
 * it.
 * @module tests/quench/game-config
 */

import GameConfigData from "../../module/data/settings/game-config.mjs";
import { GAME_CONFIG_SETTING, getGameConfig, setGameConfig } from "../../module/config/settings.mjs";
import { defaultGameConfig, validateGameConfig } from "../../module/rules/index.mjs";

/**
 * @param {object} quench  The Quench API object passed to the `quenchReady` hook.
 */
export function registerGameConfigBatch(quench) {
  quench.registerBatch(
    "cortex-prime.game-config",
    ({ describe, it, assert, before, after }) => {
      let stored;
      before(() => { stored = getGameConfig(); });
      after(async () => { await game.settings.set("cortex-prime", GAME_CONFIG_SETTING, stored); });

      describe("registration", () => {
        it("is a world setting typed by GameConfigData and hidden from the core list", () => {
          const setting = game.settings.settings.get(`cortex-prime.${GAME_CONFIG_SETTING}`);
          assert.equal(setting.scope, "world");
          assert.equal(setting.type, GameConfigData);
          assert.isFalse(setting.config);
        });

        it("reads as plain data that the pure check accepts", () => {
          const config = getGameConfig();
          assert.isTrue(validateGameConfig(config).ok, JSON.stringify(validateGameConfig(config).errors));
        });
      });

      describe("the defaults (ADR-036)", () => {
        it("load through the model unchanged apart from empty definition lists on open sets", () => {
          const model = GameConfigData.fromSource(defaultGameConfig(), { strict: true });
          const expected = defaultGameConfig();
          for ( const set of expected.traitSets ) set.traits ??= [];
          // As stored: an omitted optional field is an undefined key in memory, absent in JSON.
          assert.deepEqual(JSON.parse(JSON.stringify(model.toObject())), expected);
        });

        it("keep a stored configuration that fails as stored, marked invalid, instead of emptying lists", () => {
          const broken = defaultGameConfig();
          broken.traitSets[2].traits[0].id = "bad id";
          const model = GameConfigData.fromSource(broken);
          assert.isTrue(model.invalid);
          assert.equal(model.toObject().traitSets[2].traits.length, broken.traitSets[2].traits.length);
        });

        it("are stored once the game is ready, so later changes to the defaults leave this world alone", () => {
          assert.isDefined(game.settings.storage.get("world").getSetting(`cortex-prime.${GAME_CONFIG_SETTING}`));
        });
      });

      describe("writing", () => {
        it("stores a valid configuration and reads it back", async () => {
          const config = defaultGameConfig();
          config.traitSets[0].name = "Quench distinctions";
          const result = await setGameConfig(config);
          assert.isTrue(result.ok);
          assert.equal(getGameConfig().traitSets[0].name, "Quench distinctions");
        });

        it("refuses an invalid configuration before writing, with every problem", async () => {
          const previous = getGameConfig();
          const config = defaultGameConfig();
          config.traitSets[1].usualMin = 7;
          config.actorKinds[0].traitSetIds.push("missingSet000000");
          const result = await setGameConfig(config);
          assert.isFalse(result.ok);
          assert.deepEqual(result.errors.map(e => e.code), ["INVALID_DIE_SIZE", "UNKNOWN_TRAIT_SET"]);
          assert.deepEqual(getGameConfig(), previous);
        });

        it("documents Foundry's behaviour: a direct settings write of an invalid configuration throws", async () => {
          const config = defaultGameConfig();
          config.traitSets = config.traitSets.filter(s => s.role !== "prime");
          let threw = false;
          try { await game.settings.set("cortex-prime", GAME_CONFIG_SETTING, config); }
          catch { threw = true; }
          assert.isTrue(threw);
        });
      });
    },
    { displayName: "Cortex Prime: game configuration setting" }
  );
}
