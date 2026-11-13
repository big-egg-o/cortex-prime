import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const lang = JSON.parse(readFileSync(resolve(ROOT, "lang/en.json"), "utf8"));

/**
 * The warning codes a pool's traits can carry, read from module/rules/trait-pool.mjs: those
 * poolTraitCost reports (`{ code: ... }` and traitWarning) and the one effectiveRating reports for
 * a stored rating that no longer fits its set (ADR-037 point 5). A hint on a pool entry, such as
 * HINDER_ALREADY_D4, isn't a warning: Hinder on a d4 is used normally (RQ-029).
 * @returns {string[]}
 */
function poolWarningCodes() {
  const source = readFileSync(resolve(ROOT, "module/rules/trait-pool.mjs"), "utf8");
  return [...new Set([...source.matchAll(/(?:code: |traitWarning\()"([A-Z_]+)"/g)].map(m => m[1]))].sort();
}

/**
 * The game configuration's warnings (ADR-041). They are about the configuration, shown in the GM
 * configuration app, and are never part of a pool, so they can't reach the card.
 * @returns {string[]}
 */
function configWarningCodes() {
  const source = readFileSync(resolve(ROOT, "module/rules/game-config.mjs"), "utf8");
  return [...source.matchAll(/warnings\.push\(\{ code: "([A-Z_]+)"/g)].map(m => m[1]).sort();
}

describe("poolRoll card strings for a nonstandard selection (ADR-029, RQ-030)", () => {
  const nonstandard = lang.CORTEX.Chat.Nonstandard ?? {};

  it("reads the six pool warning codes from trait-pool.mjs", () => {
    expect(poolWarningCodes()).toEqual([
      "EXTRA_TRAIT_NOT_ALLOWED", "PRIME_SET_MISSING", "RATING_CONFLICTS_WITH_SET", "TRAIT_ORPHANED",
      "TRAIT_SET_SHUT_DOWN", "TRAIT_SHUT_DOWN"
    ]);
  });

  it("ADR-029 has a reason for every warning code a pool can carry, and no others", () => {
    expect(Object.keys(nonstandard.Reasons ?? {}).sort()).toEqual(poolWarningCodes());
    for ( const code of poolWarningCodes() ) expect(nonstandard.Reasons[code], code).toBeTypeOf("string");
  });

  it("ADR-041 keeps the configuration's warnings off the card", () => {
    expect(configWarningCodes()).toEqual(["DISTINCTIONS_SET_MISSING", "PRIME_SETS_TOO_FEW"]);
    for ( const code of configWarningCodes() ) expect(nonstandard.Reasons ?? {}, code).not.toHaveProperty(code);
  });

  it("ADR-029 titles the section as a nonstandard selection, with a way to name what a reason is about", () => {
    expect(nonstandard.Title).toMatch(/nonstandard selection/i);
    expect(nonstandard.WithName).toContain("{reason}");
    expect(nonstandard.WithName).toContain("{name}");
  });

  it("RQ-030 words unpriced traits as no standard cost, for one trait and for several", () => {
    expect(nonstandard.UnpricedOne).toMatch(/no standard cost/i);
    expect(nonstandard.UnpricedOne).toMatch(/\b1 trait unpriced/);
    expect(nonstandard.UnpricedMany).toMatch(/no standard cost/i);
    expect(nonstandard.UnpricedMany).toContain("{count} traits unpriced");
  });

  it("RQ-030 never words an unpriced exception as a cost of 0 PP", () => {
    for ( const text of [nonstandard.UnpricedOne, nonstandard.UnpricedMany, ...Object.values(nonstandard.Reasons ?? {})] ) {
      expect(text ?? "").not.toMatch(/cost:?\s*0\s*PP/i);
    }
  });
});
