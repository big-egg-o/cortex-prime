import { describe, expect, it } from "vitest";
import { appendToPool, buildPool, doubleDie, stepPoolDie } from "../../module/rules/pool.mjs";

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

  it("DP-E03 numbers ids d1, d2, ... and a fresh buildPool always restarts at d1", () => {
    const entries = [
      { size: 8, source: source("Skill") },
      { size: 6, source: source("Asset", "asset") }
    ];

    expect(buildPool(entries).map(d => d.id)).toEqual(["d1", "d2"]);
    expect(buildPool(entries).map(d => d.id)).toEqual(["d1", "d2"]);
  });

  it("DP-E03 keeps ids unique after a saved pool is reloaded and changed further", () => {
    const skill = source("Skill");
    const built = buildPool([
      { size: 12, source: skill },
      { size: 8, source: source("Distinction") }
    ]);
    const reloaded = structuredClone(built);

    const doubled = doubleDie(reloaded, reloaded[1].id);
    const steppedPastD12 = stepPoolDie(doubled, doubled[0].id, 2);

    const ids = steppedPastD12.map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("appendToPool", () => {
  it("appends dice after the pool's highest id, keeping the dice already there in place", () => {
    const built = buildPool([{ size: 8, source: source("A") }, { size: 4, source: source("B") }, { size: 6, source: source("C") }]);
    const gap = stepPoolDie(built, "d2", -1);
    expect(gap.map(d => d.id)).toEqual(["d1", "d3"]);

    const result = appendToPool(gap, [{ size: 10, source: source("D") }]);
    expect(result).toEqual({
      ok: true,
      value: [...gap, { id: "d4", size: 10, source: source("D"), origin: "rating" }]
    });
  });

  it("takes buildPool's entries: count gives several dice of one source, and origin is kept", () => {
    const pool = buildPool([{ size: 8, source: source("A") }]);
    const result = appendToPool(pool, [{ size: 6, source: source("Asset", "asset"), count: 2 }, { size: 4, source: source("SFX"), origin: "bonus" }]);
    expect(result.value.map(d => [d.id, d.size, d.source.label, d.origin])).toEqual([
      ["d1", 8, "A", "rating"], ["d2", 6, "Asset", "rating"], ["d3", 6, "Asset", "rating"], ["d4", 4, "SFX", "bonus"]
    ]);
  });

  it("on an empty pool it gives what buildPool gives, and no entries give the same dice in a new pool", () => {
    const entries = [{ size: 8, source: source("Skill") }, { size: 6, source: source("Asset", "asset") }];
    expect(appendToPool([], entries)).toEqual({ ok: true, value: buildPool(entries) });

    const pool = buildPool(entries);
    const unchanged = appendToPool(pool, []);
    expect(unchanged).toEqual({ ok: true, value: pool });
    expect(unchanged.value).not.toBe(pool);
  });

  it("ids that aren't d<n> are ignored when continuing the sequence", () => {
    const pool = [{ id: "custom", size: 8, source: source("A"), origin: "rating" }];
    expect(appendToPool(pool, [{ size: 6, source: source("B") }]).value.map(d => d.id)).toEqual(["custom", "d1"]);
  });

  it("a size that isn't a die size is refused with INVALID_DIE_SIZE, and nothing is added", () => {
    const pool = buildPool([{ size: 8, source: source("A") }]);
    for ( const size of [7, 3, 20, "8", null, undefined] ) {
      expect(appendToPool(pool, [{ size, source: source("B") }]), String(size)).toEqual({ ok: false, code: "INVALID_DIE_SIZE" });
    }
    expect(appendToPool(pool, [{ size: 8, source: source("B") }, { size: 7, source: source("C") }]))
      .toEqual({ ok: false, code: "INVALID_DIE_SIZE" });
  });

  it("a frozen pool and frozen entries are left alone", () => {
    const freeze = list => Object.freeze(list.map(item => Object.freeze({ ...item, source: Object.freeze({ ...item.source }) })));
    const pool = freeze(buildPool([{ size: 8, source: source("A") }]));
    const entries = freeze([{ size: 6, source: source("B") }]);
    const before = structuredClone({ pool, entries });
    expect(appendToPool(pool, entries)).toMatchObject({ ok: true });
    expect({ pool, entries }).toEqual(before);
  });
});
