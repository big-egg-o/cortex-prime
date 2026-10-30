import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_DIR = resolve(import.meta.dirname, "../..");
const RULES_DIR = resolve(ROOT_DIR, "module/rules");

/** Pure files outside module/rules/: they may import only from module/rules/. */
const PURE_FILES = ["module/data/chat/contest-mapping.mjs"].map(path => resolve(ROOT_DIR, path));

/** @param {string} dir @returns {string[]} all .mjs files below dir */
function listModules(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if ( statSync(path).isDirectory() ) return listModules(path);
    return path.endsWith(".mjs") ? [path] : [];
  });
}

const IMPORT_PATTERN = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

describe("module/rules boundary", () => {
  const files = listModules(RULES_DIR);

  it("contains at least the index module", () => {
    expect(files.map(f => relative(RULES_DIR, f))).toContain("index.mjs");
  });

  it.each(files.map(f => [relative(RULES_DIR, f), f]))("%s imports only from module/rules/", (_name, file) => {
    const source = readFileSync(file, "utf8");
    for ( const match of source.matchAll(IMPORT_PATTERN) ) {
      const specifier = match[1] ?? match[2] ?? match[3];
      expect(specifier.startsWith("."), `bare import "${specifier}"`).toBe(true);
      const target = resolve(file, "..", specifier);
      expect(target === RULES_DIR || target.startsWith(RULES_DIR + sep), `"${specifier}" leaves module/rules/`).toBe(true);
    }
  });
});

describe("pure files outside module/rules", () => {
  it.each(PURE_FILES.map(f => [relative(ROOT_DIR, f).split(sep).join("/"), f]))("%s imports only from module/rules/", (_name, file) => {
    const source = readFileSync(file, "utf8");
    for ( const match of source.matchAll(IMPORT_PATTERN) ) {
      const specifier = match[1] ?? match[2] ?? match[3];
      expect(specifier.startsWith("."), `bare import "${specifier}"`).toBe(true);
      const target = resolve(file, "..", specifier);
      expect(target.startsWith(RULES_DIR + sep), `"${specifier}" leaves module/rules/`).toBe(true);
    }
  });
});
