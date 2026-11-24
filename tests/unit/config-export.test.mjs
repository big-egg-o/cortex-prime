import { describe, expect, it } from "vitest";
import { CONFIG_EXPORT_FORMAT, buildConfigExport, parseConfigExport } from "../../module/rules/config-export.mjs";
import { GAME_CONFIG_SCHEMA_VERSION, defaultGameConfig } from "../../module/rules/game-config.mjs";

const wrap = config => JSON.stringify({ format: CONFIG_EXPORT_FORMAT, exportedFrom: "0.5.0", config });

describe("configuration import and export (M5 · MS-D5, MS-D6)", () => {
  it("MS-05: an exported default configuration parses back to an equal configuration", () => {
    const text = buildConfigExport(defaultGameConfig(), "0.5.0");
    const parsed = JSON.parse(text);
    expect(parsed.format).toBe(CONFIG_EXPORT_FORMAT);
    expect(parsed.exportedFrom).toBe("0.5.0");
    const result = parseConfigExport(text);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual(defaultGameConfig());
    expect(result.warnings).toEqual([]);
  });

  it("MS-06: text that isn't JSON is refused", () => {
    expect(parseConfigExport("not json {")).toEqual({ ok: false, code: "EXPORT_NOT_JSON", errors: [], warnings: [] });
    expect(parseConfigExport(42).code).toBe("EXPORT_NOT_JSON");
  });

  it("MS-07: JSON without the format marker is refused", () => {
    expect(parseConfigExport(JSON.stringify(defaultGameConfig())).code).toBe("EXPORT_WRONG_FORMAT");
    expect(parseConfigExport("[]").code).toBe("EXPORT_WRONG_FORMAT");
    expect(parseConfigExport(JSON.stringify({ format: "something-else", config: {} })).code).toBe("EXPORT_WRONG_FORMAT");
  });

  it("MS-08: a configuration from a newer schema is refused", () => {
    const config = { ...defaultGameConfig(), schemaVersion: GAME_CONFIG_SCHEMA_VERSION + 1 };
    expect(parseConfigExport(wrap(config)).code).toBe("SCHEMA_VERSION_TOO_NEW");
  });

  it("MS-09: a configuration without a distinctions set imports with its warning", () => {
    const config = defaultGameConfig();
    config.traitSets = config.traitSets.filter(set => set.role !== "distinctions");
    config.actorKinds = config.actorKinds.map(kind => ({
      ...kind, traitSetIds: kind.traitSetIds.filter(id => config.traitSets.some(set => set.id === id))
    }));
    const result = parseConfigExport(wrap(config));
    expect(result.ok).toBe(true);
    expect(result.warnings.map(w => w.code)).toContain("DISTINCTIONS_SET_MISSING");
  });

  it("refuses to export a configuration that isn't valid", () => {
    expect(() => buildConfigExport({ schemaVersion: 1 }, "0.5.0")).toThrow("INVALID_GAME_CONFIG");
  });
});
