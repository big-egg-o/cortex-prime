import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TRAIT_SET_FEATURES } from "../../module/rules/game-config.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const lang = JSON.parse(readFileSync(resolve(ROOT, "lang/en.json"), "utf8"));
const source = readFileSync(resolve(ROOT, "module/rules/game-config.mjs"), "utf8");

/** @returns {Set<string>} the error codes validateGameConfig can report, read from its source */
function errorCodes() {
  const codes = new Set([...source.matchAll(/(?:report|alone)\("([A-Z_]+)"/g)].map(m => m[1]));
  for ( const match of source.matchAll(/sizeProblem[\s\S]*?"(INVALID_[A-Z_]+)"[\s\S]*?"(INVALID_[A-Z_]+)"/g) ) {
    codes.add(match[1]);
    codes.add(match[2]);
  }
  return codes;
}

/** @returns {Set<string>} the warning codes validateGameConfig can report, read from its source */
function warningCodes() {
  return new Set([...source.matchAll(/warnings\.push\(\{ code: "([A-Z_]+)"/g)].map(m => m[1]));
}

describe("configuration app strings", () => {
  it("has an error string for every error code validateGameConfig can report", () => {
    const codes = errorCodes();
    expect(codes.size).toBeGreaterThanOrEqual(8);
    for ( const code of codes ) expect(lang.CORTEX.Config.Errors[code], code).toBeTypeOf("string");
  });

  it("has a warning string for every warning code, and keeps warnings out of the errors (ADR-041)", () => {
    const codes = warningCodes();
    expect([...codes]).toEqual(["DISTINCTIONS_SET_MISSING", "PRIME_SETS_TOO_FEW"]);
    expect(Object.keys(lang.CORTEX.Config.Warnings).sort()).toEqual([...codes].sort());
    for ( const code of codes ) {
      expect(lang.CORTEX.Config.Warnings[code], code).toBeTypeOf("string");
      expect(lang.CORTEX.Config.Errors, code).not.toHaveProperty(code);
      expect(errorCodes().has(code), code).toBe(false);
    }
  });

  it("cites the Handbook pages each warning rests on (ADR-041 points 1 and 2)", () => {
    expect(lang.CORTEX.Config.Warnings.DISTINCTIONS_SET_MISSING).toMatch(/p\. 66(?!\d)/);
    expect(lang.CORTEX.Config.Warnings.PRIME_SETS_TOO_FEW).toMatch(/pp\. 26, 47(?!\d)/);
  });

  it("has a label for every feature switch", () => {
    for ( const feature of TRAIT_SET_FEATURES ) expect(lang.CORTEX.Config.Feature[feature], feature).toBeTypeOf("string");
  });
});
