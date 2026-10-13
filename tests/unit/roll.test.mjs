import { describe, expect, it } from "vitest";
import { buildPool } from "../../module/rules/pool.mjs";
import { applyResults, evaluate } from "../../module/rules/roll.mjs";

/** @returns {{kind: string, label: string}} a minimal DieSource for tests */
function source(label, kind = "trait") {
  return { kind, label };
}

describe("applyResults", () => {
  it("DP-12 accepts a result within range and rejects one outside it", () => {
    const pool = buildPool([{ size: 10, source: source("Skill") }]);

    const rolled = applyResults(pool, [10]);

    expect(rolled).toEqual([{ ...pool[0], result: 10, hitch: false, state: "available" }]);
    expect(() => applyResults(pool, [0])).toThrow();
    expect(() => applyResults(pool, [11])).toThrow();
    expect(() => applyResults(pool, [2.5])).toThrow();

    const twoDice = buildPool([
      { size: 8, source: source("Skill") },
      { size: 6, source: source("Asset", "asset") }
    ]);
    expect(() => applyResults(twoDice, [5])).toThrow();
    expect(() => applyResults(twoDice, [5, 3, 1])).toThrow();
  });
});

describe("evaluate", () => {
  it("DP-08 finds the one hitch in a pool, without a botch", () => {
    const pool = buildPool([
      { size: 10, source: source("Attribute") },
      { size: 8, source: source("Distinction") },
      { size: 6, source: source("Skill") },
      { size: 4, source: source("Asset", "asset") }
    ]);
    const rolled = applyResults(pool, [1, 6, 5, 3]);

    expect(evaluate(rolled)).toEqual({ hitchIds: [pool[0].id], botch: false });
  });

  it("DP-09 is a botch when every die shows a hitch", () => {
    const pool = buildPool([
      { size: 8, source: source("Skill") },
      { size: 6, source: source("Asset", "asset") },
      { size: 4, source: source("Distinction") }
    ]);
    const rolled = applyResults(pool, [1, 1, 1]);

    expect(evaluate(rolled)).toEqual({ hitchIds: pool.map(d => d.id), botch: true });
  });

  it("DP-10 isn't a botch when one die escapes the hitch", () => {
    const pool = buildPool([
      { size: 8, source: source("Skill") },
      { size: 6, source: source("Asset", "asset") },
      { size: 4, source: source("Distinction") }
    ]);
    const rolled = applyResults(pool, [1, 1, 2]);

    expect(evaluate(rolled)).toEqual({ hitchIds: [pool[0].id, pool[1].id], botch: false });
  });

  it("DP-11 tells a single non-hitch die apart from a single-die botch", () => {
    const hit = applyResults(buildPool([{ size: 6, source: source("Skill") }]), [4]);
    expect(evaluate(hit)).toEqual({ hitchIds: [], botch: false });

    const botch = applyResults(buildPool([{ size: 6, source: source("Skill") }]), [1]);
    expect(evaluate(botch)).toEqual({ hitchIds: [botch[0].id], botch: true });
  });
});
