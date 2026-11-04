import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TRAIT_SET_FEATURES } from "../../module/rules/game-config.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const lang = JSON.parse(readFileSync(resolve(ROOT, "lang/en.json"), "utf8"));
const source = readFileSync(resolve(ROOT, "module/rules/game-config.mjs"), "utf8");

describe("configuration app strings", () => {
  it("has a string for every code validateGameConfig can report", () => {
    const codes = new Set([...source.matchAll(/(?:report|alone)\("([A-Z_]+)"/g)].map(m => m[1]));
    for ( const match of source.matchAll(/sizeProblem[\s\S]*?"(INVALID_[A-Z_]+)"[\s\S]*?"(INVALID_[A-Z_]+)"/g) ) {
      codes.add(match[1]);
      codes.add(match[2]);
    }
    expect(codes.size).toBeGreaterThanOrEqual(10);
    for ( const code of codes ) expect(lang.CORTEX.Config.Errors[code], code).toBeTypeOf("string");
  });

  it("has a label for every feature switch", () => {
    for ( const feature of TRAIT_SET_FEATURES ) expect(lang.CORTEX.Config.Feature[feature], feature).toBeTypeOf("string");
  });
});
