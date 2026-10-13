import { describe, expect, it } from "vitest";
import { buildPool, doubleDie, stepPoolDie } from "../../module/rules/pool.mjs";

/** @returns {{kind: string, label: string}} a minimal DieSource for tests */
function source(label, kind = "trait") {
  return { kind, label };
}

describe("buildPool", () => {
  it("DP-05 builds a pool from four single-die traits, each keeping its source", () => {
    const attribute = source("Attribute");
    const distinction = source("Distinction");
    const skill = source("Skill");
    const asset = source("Asset", "asset");

    const pool = buildPool([
      { size: 8, source: attribute },
      { size: 8, source: distinction },
      { size: 8, source: skill },
      { size: 6, source: asset }
    ]);

    expect(pool.map(d => d.size)).toEqual([8, 8, 8, 6]);
    expect(pool.map(d => d.source)).toEqual([attribute, distinction, skill, asset]);
    expect(pool.every(d => d.origin === "rating")).toBe(true);
  });

  it("DP-06 expands a multi-die rating into one pool die per die", () => {
    const traitA = source("Trait A");
    const traitB = source("Trait B");

    const pool = buildPool([
      { size: 6, source: traitA, count: 2 },
      { size: 10, source: traitB }
    ]);

    expect(pool.map(d => d.size)).toEqual([6, 6, 10]);
    expect(pool.map(d => d.source)).toEqual([traitA, traitA, traitB]);
  });
});

describe("doubleDie", () => {
  it("DP-07 adds a second die of the same size and source, marked as doubled", () => {
    const skill = source("Skill");
    const asset = source("Asset", "asset");
    const pool = buildPool([
      { size: 8, source: skill },
      { size: 6, source: asset }
    ]);
    const skillId = pool[0].id;

    const doubled = doubleDie(pool, skillId);

    expect(doubled.map(d => d.size)).toEqual([8, 8, 6]);
    expect(doubled[1].source).toEqual(skill);
    expect(doubled[1].origin).toBe("doubled");
    expect(doubled[1].id).not.toBe(skillId);
  });
});

describe("stepPoolDie", () => {
  it("DP-04 (pool part) steps a d12 pool die up, adding an overflow d6 after it", () => {
    const skill = source("Skill");
    const distinction = source("Distinction");
    const pool = buildPool([
      { size: 12, source: skill },
      { size: 8, source: distinction }
    ]);
    const skillId = pool[0].id;

    const stepped = stepPoolDie(pool, skillId, 1);

    expect(stepped.map(d => d.size)).toEqual([12, 6, 8]);
    expect(stepped[0].id).toBe(skillId);
    expect(stepped[1].source).toEqual(skill);
    expect(stepped[1].origin).toBe("overflow");
  });

  it("DP-04b steps past d12 as many times as asked, one overflow d6 per step", () => {
    const skill = source("Skill");
    const poolFromD12 = buildPool([{ size: 12, source: skill }]);
    const steppedTwiceFromD12 = stepPoolDie(poolFromD12, poolFromD12[0].id, 2);

    const poolFromD10 = buildPool([{ size: 10, source: skill }]);
    const steppedThriceFromD10 = stepPoolDie(poolFromD10, poolFromD10[0].id, 3);

    expect(steppedTwiceFromD12.map(d => d.size)).toEqual([12, 6, 6]);
    expect(steppedTwiceFromD12.slice(1).every(d => d.origin === "overflow")).toBe(true);
    expect(steppedTwiceFromD12.slice(1).map(d => d.source)).toEqual([skill, skill]);
    expect(steppedThriceFromD10.map(d => d.size)).toEqual([12, 6, 6]);
    expect(steppedThriceFromD10.slice(1).every(d => d.origin === "overflow")).toBe(true);
    expect(steppedThriceFromD10.slice(1).map(d => d.source)).toEqual([skill, skill]);
  });

  it("DP-04c steps an asset's pool die up for one roll without touching its source", () => {
    const asset = source("Grappling Hook", "asset");
    const before = structuredClone(asset);
    const pool = buildPool([{ size: 12, source: asset }]);
    const poolBefore = structuredClone(pool);
    const assetId = pool[0].id;

    const stepped = stepPoolDie(pool, assetId, 1);

    expect(stepped.map(d => d.size)).toEqual([12, 6]);
    expect(stepped[0].id).toBe(assetId);
    expect(stepped[1].origin).toBe("overflow");
    expect(stepped[1].source).toEqual(asset);
    expect(asset).toEqual(before);
    expect(pool).toEqual(poolBefore);
  });

  it("DP-E01 empties the pool when its only d4 is stepped down", () => {
    const pool = buildPool([{ size: 4, source: source("Skill") }]);
    const dieId = pool[0].id;

    const stepped = stepPoolDie(pool, dieId, -1);

    expect(stepped).toEqual([]);
  });
});

describe("die identity", () => {
  it("DP-E03 gives every die its own id even when size and source are shared", () => {
    const traitA = source("Trait A");
    const pool = buildPool([{ size: 6, source: traitA, count: 2 }]);

    expect(pool[0].id).not.toBe(pool[1].id);
  });
});
