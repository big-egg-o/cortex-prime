import { describe, expect, it } from "vitest";
import { nextSfxLines, payerRef, poolPpEntries, rollLines, storedLines } from "../../module/plot-points/roll-pp.mjs";

const trait = (label, extra = {}) => ({ kind: "trait", actorId: "pc1", traitId: label.toLowerCase(), label, ...extra });

/** @returns {object} a rolled die */
function die(id, size, result) {
  return { id, size, result, hitch: result === 1, state: "available", source: trait(id), origin: "rating" };
}

/** @returns {object} poolRoll system data with the given selection and pp */
function system({ selection = {}, pp = {}, state = "rolled" } = {}) {
  return {
    state,
    rolled: [die("a", 8, 6), die("b", 8, 5), die("c", 6, 4), die("d", 6, 3)],
    selection: { totalIds: ["a", "b"], effectDieIds: ["c"], extraResultsPaid: 0, extraEffectDicePaid: 0, keepLimit: 2, ...selection },
    pp: { payer: { kind: "actor", actorId: "pc1" }, poolLines: [], poolWarnings: [], sfxLines: [], otherLines: [], settled: false, ...pp }
  };
}

describe("poolPpEntries", () => {
  it("leaves out doubled and overflow dice, which repeat their original's source", () => {
    const pool = [
      { id: "d1", size: 4, source: trait("Sneaky", { ppGained: 1, setId: "s", actorRef: "x" }), origin: "rating" },
      { id: "d2", size: 4, source: trait("Sneaky", { ppGained: 1 }), origin: "doubled" },
      { id: "d3", size: 6, source: { kind: "custom", label: "Help", actorId: null }, origin: "bonus" },
      { id: "d4", size: 6, source: trait("Fight"), origin: "overflow" }
    ];
    expect(poolPpEntries(pool)).toEqual([
      { size: 4, source: { kind: "trait", label: "Sneaky", actorId: "pc1", traitId: "sneaky" }, ppGained: 1 },
      { size: 6, source: { kind: "custom", label: "Help" } }
    ]);
  });
});

describe("payerRef", () => {
  it("reads a stored payer as an AccountRef", () => {
    expect(payerRef({ kind: "bank", actorId: null })).toEqual({ kind: "bank" });
    expect(payerRef({ kind: "actor", actorId: "pc1" })).toEqual({ kind: "actor", actorId: "pc1" });
    expect(payerRef({ kind: "actor", actorId: null })).toBeNull();
    expect(payerRef(null)).toBeNull();
  });
});

describe("storedLines", () => {
  it("keeps only a line's own fields and usableThisRoll on gains", () => {
    expect(storedLines([
      { reason: "EXTRA_RESULT", direction: "spend", amount: 1, usableThisRoll: false, label: "" },
      { reason: "HINDER", direction: "gain", amount: 1, label: "Sneaky", sourceId: "t1" },
      { reason: "SFX_GAIN", direction: "gain", amount: 1, usableThisRoll: true }
    ])).toEqual([
      { reason: "EXTRA_RESULT", direction: "spend", amount: 1 },
      { reason: "HINDER", direction: "gain", amount: 1, label: "Sneaky", sourceId: "t1", usableThisRoll: false },
      { reason: "SFX_GAIN", direction: "gain", amount: 1, usableThisRoll: true }
    ]);
  });
});

describe("rollLines", () => {
  const hinder = { reason: "HINDER", direction: "gain", amount: 1, label: "Sneaky", usableThisRoll: true };
  const sfx = { reason: "SFX_SPEND", direction: "spend", amount: 1, label: "Bold" };
  const hitch = { reason: "HITCH_COMPLICATION", direction: "gain", amount: 1, usableThisRoll: false };

  it("lists pool, paid, SFX and other lines in that order", () => {
    const lines = rollLines(system({
      selection: { totalIds: ["a", "b", "d"], extraResultsPaid: 1 },
      pp: { poolLines: [hinder], sfxLines: [sfx], otherLines: [hitch] }
    }));
    expect(lines.all.map(l => l.reason)).toEqual(["HINDER", "EXTRA_RESULT", "SFX_SPEND", "HITCH_COMPLICATION"]);
    expect(lines.paid).toEqual([{ reason: "EXTRA_RESULT", direction: "spend", amount: 1 }]);
    expect(lines.sfx).toEqual([sfx]);
  });

  it("PP-E09 counts no paid result for a selection validateSelection refuses", () => {
    const lines = rollLines(system({ selection: { extraResultsPaid: 5 } }));
    expect(lines.all).toEqual([]);
  });

  it("counts the paid counters of a confirmed roll", () => {
    const lines = rollLines(system({ state: "resolved", selection: { extraEffectDicePaid: 1 } }));
    expect(lines.all).toEqual([{ reason: "EXTRA_EFFECT_DIE", direction: "spend", amount: 1 }]);
  });

  it("warns instead of charging the bank for an extra effect die (RQ-043) and keeps the pool's warnings", () => {
    const lines = rollLines(system({
      state: "resolved", selection: { extraEffectDicePaid: 2 },
      pp: { payer: { kind: "bank", actorId: null }, poolWarnings: [{ code: "D4_COMPLICATION_NOT_OWN", label: "Hurt" }] }
    }));
    expect(lines.all).toEqual([]);
    expect(lines.warnings).toEqual([{ code: "D4_COMPLICATION_NOT_OWN", label: "Hurt" }, { code: "BANK_SPEND_NOT_LISTED", count: 2 }]);
  });

  it("PP-E17 prices a roll with no payer as a player's", () => {
    const lines = rollLines(system({ state: "resolved", selection: { extraEffectDicePaid: 1 }, pp: { payer: null } }));
    expect(lines.all).toEqual([{ reason: "EXTRA_EFFECT_DIE", direction: "spend", amount: 1 }]);
  });
});

describe("nextSfxLines (P15)", () => {
  it("adds a gain that is usable only after the roll, and a spend, with the label trimmed", () => {
    const gained = nextSfxLines([], { action: "sfx-add", kind: "gain", label: "  Lucky " });
    expect(gained).toEqual([{ reason: "SFX_GAIN", direction: "gain", amount: 1, label: "Lucky", usableThisRoll: false }]);
    expect(nextSfxLines(gained, { action: "sfx-add", kind: "spend", label: "" })[1])
      .toEqual({ reason: "SFX_SPEND", direction: "spend", amount: 1 });
  });

  it("switches a gain's usability and removes a line by index", () => {
    const lines = [
      { reason: "SFX_GAIN", direction: "gain", amount: 1, usableThisRoll: false },
      { reason: "SFX_SPEND", direction: "spend", amount: 1 }
    ];
    expect(nextSfxLines(lines, { action: "sfx-usable", index: "0" })[0].usableThisRoll).toBe(true);
    expect(nextSfxLines(lines, { action: "sfx-remove", index: "1" })).toEqual([lines[0]]);
  });

  it.each([
    [{ action: "sfx-add", kind: "other" }],
    [{ action: "sfx-usable", index: "1" }],
    [{ action: "sfx-remove", index: "7" }],
    [{ action: "sfx-remove", index: "x" }],
    [{ action: "sfx-nope" }]
  ])("refuses %j", change => {
    expect(nextSfxLines([
      { reason: "SFX_GAIN", direction: "gain", amount: 1, usableThisRoll: false },
      { reason: "SFX_SPEND", direction: "spend", amount: 1 }
    ], change)).toBeNull();
  });
});
