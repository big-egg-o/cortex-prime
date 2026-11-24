import { describe, expect, it } from "vitest";
import { MOD_IDS, checkMods, modEnabled } from "../../module/rules/mods.mjs";
import { defaultGameConfig, validateGameConfig } from "../../module/rules/game-config.mjs";

const TEST_ID = "testOnlyMod";

/** @returns {{code: string, path: string}[]} what checkMods reports for mods against the test id */
function problems(mods) {
  const found = [];
  checkMods(mods, (code, path) => found.push({ code, path }), [TEST_ID]);
  return found;
}

describe("mod switch (M5 · MS-D1 to MS-D3)", () => {
  it("starts with no known mods; one is added only together with its spec", () => {
    expect(MOD_IDS).toEqual([]);
    expect(Object.isFrozen(MOD_IDS)).toBe(true);
  });

  it("MS-01: a configuration without mods is valid and every mod is off", () => {
    const config = defaultGameConfig();
    delete config.mods;
    expect(validateGameConfig(config).ok).toBe(true);
    expect(modEnabled(config, TEST_ID)).toBe(false);
    expect(modEnabled(undefined, TEST_ID)).toBe(false);
  });

  it("MS-02: a known mod switched on is reported on", () => {
    expect(problems({ [TEST_ID]: { enabled: true } })).toEqual([]);
    expect(modEnabled({ mods: { [TEST_ID]: { enabled: true } } }, TEST_ID)).toBe(true);
    expect(modEnabled({ mods: { [TEST_ID]: { enabled: false } } }, TEST_ID)).toBe(false);
  });

  it("MS-03: an unknown mod id is refused", () => {
    const config = { ...defaultGameConfig(), mods: { unknownThing: { enabled: true } } };
    const result = validateGameConfig(config);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({ code: "UNKNOWN_MOD", path: "mods.unknownThing" });
  });

  it("MS-04: a switch that isn't a boolean is refused", () => {
    expect(problems({ [TEST_ID]: { enabled: "yes" } }))
      .toEqual([{ code: "INVALID_GAME_CONFIG", path: `mods.${TEST_ID}.enabled` }]);
    expect(problems({ [TEST_ID]: true })).toEqual([{ code: "INVALID_GAME_CONFIG", path: `mods.${TEST_ID}` }]);
    expect(problems([])).toEqual([{ code: "INVALID_GAME_CONFIG", path: "mods" }]);
  });
});
