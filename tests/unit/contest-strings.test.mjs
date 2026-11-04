import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as rules from "../../module/rules/index.mjs";

const ROOT_DIR = resolve(import.meta.dirname, "../..");

/**
 * The rules modules whose functions a test or contest request reaches: the request checks and the
 * dispatcher, the engine functions they call, and the outcome functions those call. Every code
 * these files can return is one a user may see on the card, so each needs a language string.
 */
const REQUEST_SOURCES = ["module/rules/contest-request.mjs", "module/rules/contest.mjs", "module/rules/outcome.mjs"];

/**
 * Codes the Foundry side of the request adds (ADR-027, Step 4.4 proposal review): no active GM, no
 * "Query Users" permission, a query that threw, and a write that didn't land as sent.
 */
const TRANSPORT_CODES = ["GM_REQUIRED", "QUERY_NOT_PERMITTED", "REQUEST_FAILED", "WRITE_FAILED"];

/** The pure mapping of the contest message: its codes mean a bug and are reported as WRITE_FAILED. */
const MAPPING_SOURCE = "module/data/chat/contest-mapping.mjs";

/** A quoted code: upper-case words joined by underscores, as fail() and the helpers return them. */
const QUOTED_CODE = /["']([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["']/g;

/** A code passed to fail() as a constant, such as OVERFLOW_PENDING from roll.mjs. */
const CONSTANT_CODE = /\bfail\(\s*([A-Z][A-Z0-9_]*)\s*\)/g;

/**
 * Every code a source file can return: quoted codes, and constants passed to fail(), read through
 * the rules index so the test fails if such a constant isn't exported.
 * @param {string} path - relative to the repository root
 * @returns {string[]}
 */
function codesIn(path) {
  const source = readFileSync(resolve(ROOT_DIR, path), "utf8");
  const quoted = [...source.matchAll(QUOTED_CODE)].map(match => match[1]);
  const constants = [...source.matchAll(CONSTANT_CODE)].map(match => {
    expect(rules, `${path}: fail(${match[1]})`).toHaveProperty(match[1]);
    return rules[match[1]];
  });
  return [...quoted, ...constants];
}

/** @returns {Record<string, string>} the contest error strings of lang/en.json */
function contestErrors() {
  const lang = JSON.parse(readFileSync(resolve(ROOT_DIR, "lang/en.json"), "utf8"));
  return lang.CORTEX?.Contest?.Errors ?? {};
}

const REQUEST_CODES = [...new Set(REQUEST_SOURCES.flatMap(codesIn))].sort();

describe("language strings for test and contest codes", () => {
  it("the scan finds the request codes and the four codes carried over from Step 4.3.4", () => {
    for ( const code of [
      "MALFORMED_REQUEST", "CONTEST_NOT_FOUND", "UNSUPPORTED_ACTION", "GM_ONLY", "NOT_YOUR_SIDE", "STALE_REVISION",
      "SIDE_REQUIRED", "POOL_ROLL_NOT_FOUND", "NOT_YOUR_ROLL", "POOL_ROLL_NOT_CONFIRMED", "ROLL_ALREADY_ADDED",
      "DECLINE_AFTER_ROLL", "INVALID_SIDE",
      "CONTEST_OVERFLOW_CHOICE_IN_EXCHANGE", "HEROIC_PENDING", "OVERFLOW_NOT_PENDING", "INVALID_OVERFLOW_CHOICE",
      "OVERFLOW_PENDING", "INVALID_HIGH_STAKES"
    ] ) {
      expect(REQUEST_CODES, code).toContain(code);
    }
  });

  it.each(REQUEST_CODES)("%s has a string", code => {
    const text = contestErrors()[code];
    expect(typeof text, code).toBe("string");
    expect(text.trim().length, code).toBeGreaterThan(0);
  });

  it.each(TRANSPORT_CODES)("%s, from the Foundry side, has a string", code => {
    const text = contestErrors()[code];
    expect(typeof text, code).toBe("string");
    expect(text.trim().length, code).toBeGreaterThan(0);
  });

  it("QUERY_NOT_PERMITTED says that the GM can grant the permission", () => {
    expect(contestErrors().QUERY_NOT_PERMITTED).toMatch(/\bGM\b.*\bgrant\b/);
  });

  it("the mapping's codes have no strings, since they are reported as WRITE_FAILED", () => {
    const mappingCodes = [...new Set(codesIn(MAPPING_SOURCE))];
    expect(mappingCodes.sort()).toEqual([
      "FLOW_TYPE_MISMATCH", "INITIAL_ROLLS_PRESENT", "ROLLS_CHANGED", "ROLL_USER_MISSING", "ROLL_USER_UNUSED",
      "UNKNOWN_FLOW_TYPE"
    ]);
    for ( const code of mappingCodes ) expect(contestErrors(), code).not.toHaveProperty(code);
  });

  it("every contest string belongs to a code that can be returned, so none is left behind", () => {
    const known = new Set([...REQUEST_CODES, ...TRANSPORT_CODES]);
    expect(Object.keys(contestErrors()).filter(code => !known.has(code))).toEqual([]);
  });
});
