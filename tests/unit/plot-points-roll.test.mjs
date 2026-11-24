import { describe, expect, it } from "vitest";
import {
  ROLL_REASONS, poolPpFacts, ppTotals, rollPpFacts, settleRoll
} from "../../module/rules/plot-points.mjs";
import { traitPoolEntries } from "../../module/rules/trait-pool.mjs";
import { addTraitDice } from "../../module/rules/pool-traits.mjs";

/** @param {*} value @returns {*} the same value, frozen all the way down */
function deepFreeze(value) {
  if ( value && typeof value === "object" && !Object.isFrozen(value) ) {
    Object.freeze(value);
    for ( const key of Object.keys(value) ) deepFreeze(value[key]);
  }
  return value;
}

const refused = code => ({ ok: false, code });
const PC = { kind: "actor", actorId: "pc1" };
const BANK = { kind: "bank" };

/** @returns {object} a plain trait entry */
const trait = (size, label, extra = {}) => ({ size, source: { kind: "trait", label, ...extra } });

/** @returns {object[]} a trait's entries as traitPoolEntries gives them */
function entriesOf(label, dice, options = {}, extra = {}) {
  return traitPoolEntries({ label, dice, ...extra }, options).value;
}

/** @returns {object} a complication entry held by actorId */
const complication = (size, label, actorId) => ({ size, source: { kind: "complication", label, actorId } });

const gain = (reason, amount, usableThisRoll, extra = {}) => ({ reason, direction: "gain", amount, ...extra, usableThisRoll });
const spend = (reason, amount, extra = {}) => ({ reason, direction: "spend", amount, ...extra });

/** Pool lines, then a settle against balance. */
function poolAndSettle(input, balance) {
  const facts = poolPpFacts(input);
  return { facts, settled: settleRoll({ balance, lines: facts.value.lines }) };
}

describe("ROLL_REASONS", () => {
  it("lists the reasons a roll's lines may carry, frozen", () => {
    expect(ROLL_REASONS).toEqual([
      "HINDER", "D4_COMPLICATION", "SFX_GAIN", "HITCH_COMPLICATION", "EXTRA_TRAIT", "EXTRA_RESULT", "EXTRA_EFFECT_DIE",
      "SFX_SPEND"
    ]);
    expect(Object.isFrozen(ROLL_REASONS)).toBe(true);
  });
});

describe("poolPpFacts (rules 7, 9, 11)", () => {
  it("PP-01 a distinction with Hinder: HINDER +1 usable; settle 1 → 2", () => {
    const entries = [
      ...entriesOf("Seasoned Smuggler", [8], { hinder: true }, { traitId: "dist1" }),
      trait(8, "Physical"), trait(10, "Pilot")
    ];
    const { facts, settled } = poolAndSettle({ entries, traitCost: { extraTraits: [] }, rollerActorId: "pc1", payer: PC }, 1);
    expect(facts.value).toEqual({
      lines: [gain("HINDER", 1, true, { label: "Seasoned Smuggler", sourceId: "dist1" })],
      warnings: []
    });
    expect(settled.value.balance).toBe(2);
  });

  it("PP-02 a major GMC's Hinder credits the bank: 2 → 3", () => {
    const entries = [...entriesOf("Ruthless", [8], { hinder: true }), trait(8, "Fight")];
    const { facts, settled } = poolAndSettle({ entries, traitCost: null, rollerActorId: "gmc1", payer: BANK }, 2);
    expect(facts.value.lines).toEqual([gain("HINDER", 1, true, { label: "Ruthless" })]);
    expect(settled.value.balance).toBe(3);
  });

  it("PP-03 a scene distinction with Hinder: the PC 0 → 1, the bank 2 → 3", () => {
    const scene = () => entriesOf("Crowded Market", [8], { hinder: true }, { actorId: "loc1" });
    const pc = poolAndSettle({
      entries: [...scene(), trait(8, "Physical"), trait(10, "Pilot")], traitCost: { extraTraits: [] },
      rollerActorId: "pc1", payer: PC
    }, 0);
    expect(pc.facts.value.lines).toEqual([gain("HINDER", 1, true, { label: "Crowded Market" })]);
    expect(pc.settled.value.balance).toBe(1);
    const gmc = poolAndSettle({ entries: scene(), traitCost: { extraTraits: [] }, rollerActorId: "gmc1", payer: BANK }, 2);
    expect(gmc.settled.value.balance).toBe(3);
  });

  it("PP-08 the PC's own d4 complication earns 1: 0 → 1", () => {
    const entries = [complication(4, "Sprained Wrist", "pc1"), trait(8, "Physical"), trait(8, "Fight")];
    const { facts, settled } = poolAndSettle({ entries, traitCost: null, rollerActorId: "pc1", payer: PC }, 0);
    expect(facts.value).toEqual({
      lines: [gain("D4_COMPLICATION", 1, true, { label: "Sprained Wrist" })], warnings: []
    });
    expect(settled.value.balance).toBe(1);
  });

  it("PP-09 a fallback d4 and a skill rated d4 earn nothing", () => {
    const fallback = entriesOf("Sneak", [4], {}, { isFallback: true });
    const rated = entriesOf("Sneak", [4]);
    for ( const entries of [fallback, rated] ) {
      expect(poolPpFacts({ entries, traitCost: null, rollerActorId: "pc1", payer: PC }).value).toEqual({ lines: [], warnings: [] });
    }
  });

  it("PP-10 an opposing GMC's d4 complication earns nothing and warns (RQ-040)", () => {
    const entries = [complication(4, "Winded", "gmc1"), trait(8, "Physical")];
    expect(poolPpFacts({ entries, traitCost: null, rollerActorId: "pc1", payer: PC }).value).toEqual({
      lines: [], warnings: [{ code: "D4_COMPLICATION_NOT_OWN", label: "Winded", actorId: "gmc1" }]
    });
  });

  it("PP-E11 (parked) a location's d4 complication earns nothing and warns", () => {
    const entries = [complication(4, "Smoke-Filled", "loc1"), trait(8, "Physical")];
    expect(poolPpFacts({ entries, traitCost: null, rollerActorId: "pc1", payer: PC }).value).toEqual({
      lines: [], warnings: [{ code: "D4_COMPLICATION_NOT_OWN", label: "Smoke-Filled", actorId: "loc1" }]
    });
  });

  it("PP-10b a major GMC's own d4 complication pays the bank: 2 → 3 (RQ-038, RQ-040)", () => {
    const entries = [complication(4, "Winded", "gmc1"), trait(10, "Fight")];
    const { facts, settled } = poolAndSettle({ entries, traitCost: null, rollerActorId: "gmc1", payer: BANK }, 2);
    expect(facts.value.lines).toEqual([gain("D4_COMPLICATION", 1, true, { label: "Winded" })]);
    expect(settled.value.balance).toBe(3);
  });

  it("PP-11 two extra skills cost 2: 3 → 1 (RQ-019)", () => {
    const entries = [trait(8, "Distinction"), trait(8, "Physical"), trait(8, "Fight"), trait(6, "Shoot"), trait(6, "Throw")];
    const traitCost = { ppCost: 2, extraTraits: [{ setId: "skills", count: 2 }], unpricedTraits: [], warnings: [] };
    const { facts, settled } = poolAndSettle({ entries, traitCost, rollerActorId: "pc1", payer: PC }, 3);
    expect(facts.value.lines).toEqual([spend("EXTRA_TRAIT", 2, { sourceId: "skills" })]);
    expect(settled.value.balance).toBe(1);
  });

  it("PP-23 a GMC's extra skill: no line, BANK_SPEND_NOT_LISTED, nothing debited (RQ-043)", () => {
    const entries = [trait(10, "Fight"), trait(8, "Shoot")];
    const traitCost = { extraTraits: [{ setId: "skills", count: 1 }] };
    expect(poolPpFacts({ entries, traitCost, rollerActorId: "gmc1", payer: BANK }).value).toEqual({
      lines: [], warnings: [{ code: "BANK_SPEND_NOT_LISTED", setId: "skills", count: 1 }]
    });
  });

  it("unpriced traits give no line (RQ-030)", () => {
    const traitCost = { extraTraits: [], unpricedTraits: [{ setId: "powers", count: 1 }] };
    expect(poolPpFacts({ entries: [], traitCost, rollerActorId: "pc1", payer: PC }).value.lines).toEqual([]);
  });

  it("Hinder on a trait already at d4 reports 0 and gains nothing (RQ-029)", () => {
    const entries = entriesOf("Clumsy", [4], { hinder: true });
    expect(entries[0].ppGained).toBe(0);
    expect(poolPpFacts({ entries, traitCost: null, rollerActorId: "pc1", payer: PC }).value.lines).toEqual([]);
  });

  it("Hinder with a challenged statement gains once over its three d4s (RQ-032, RQ-033)", () => {
    const entries = entriesOf("Social", [8], { hinder: true, challenge: true });
    expect(entries.map(e => e.size)).toEqual([4, 4, 4]);
    expect(poolPpFacts({ entries, traitCost: null, rollerActorId: "pc1", payer: PC }).value.lines)
      .toEqual([gain("HINDER", 1, true, { label: "Social" })]);
  });

  it("reads Hinder's gain from a pool die's source, where addTraitDice stores it", () => {
    const added = addTraitDice([], { entries: entriesOf("Ruthless", [8], { hinder: true }), setId: "dist" }).value.pool;
    expect(added[0].source.ppGained).toBe(1);
    expect(poolPpFacts({ entries: added, traitCost: null, rollerActorId: null, payer: BANK }).value.lines)
      .toEqual([gain("HINDER", 1, true, { label: "Ruthless" })]);
  });

  it("a roll without an actor: every d4 complication warns", () => {
    const entries = [complication(4, "Winded", "gmc1")];
    expect(poolPpFacts({ entries, traitCost: null, rollerActorId: null, payer: BANK }).value.warnings)
      .toEqual([{ code: "D4_COMPLICATION_NOT_OWN", label: "Winded", actorId: "gmc1" }]);
  });

  it("a complication larger than d4 earns and warns nothing", () => {
    expect(poolPpFacts({ entries: [complication(6, "Winded", "pc1")], traitCost: null, rollerActorId: "pc1", payer: PC }).value)
      .toEqual({ lines: [], warnings: [] });
  });

  it("lists the extra-trait spends first, then the gains in pool order", () => {
    const entries = [complication(4, "Sore", "pc1"), ...entriesOf("Brave", [8], { hinder: true })];
    const traitCost = { extraTraits: [{ setId: "skills", count: 1 }, { setId: "powers", count: 1 }] };
    expect(poolPpFacts({ entries, traitCost, rollerActorId: "pc1", payer: PC }).value.lines.map(l => l.reason))
      .toEqual(["EXTRA_TRAIT", "EXTRA_TRAIT", "D4_COMPLICATION", "HINDER"]);
  });

  it("never changes its input", () => {
    const input = deepFreeze({
      entries: [complication(4, "Sore", "pc1"), ...entriesOf("Brave", [8], { hinder: true })],
      traitCost: { extraTraits: [{ setId: "skills", count: 1 }] }, rollerActorId: "pc1", payer: PC
    });
    expect(poolPpFacts(input).ok).toBe(true);
  });

  describe("check order", () => {
    const ok = { entries: [], traitCost: null, rollerActorId: "pc1", payer: PC };
    it.each([
      ["entries not an array", { ...ok, entries: null }],
      ["a die size off the ladder", { ...ok, entries: [trait(5, "X")] }],
      ["no source", { ...ok, entries: [{ size: 8 }] }],
      ["an empty label", { ...ok, entries: [trait(8, "")] }],
      ["an actorId that isn't a string", { ...ok, entries: [trait(8, "X", { actorId: 3 })] }]
    ])("(1) %s → INVALID_PP_INPUT", (_n, input) => expect(poolPpFacts(input)).toEqual(refused("INVALID_PP_INPUT")));

    it("(2) a gain of 1.5 → INVALID_PP_AMOUNT", () => {
      expect(poolPpFacts({ ...ok, entries: [{ ...trait(8, "X"), ppGained: 1.5 }] })).toEqual(refused("INVALID_PP_AMOUNT"));
    });

    it("(3) a bad traitCost → INVALID_PP_INPUT, a bad count → INVALID_PP_AMOUNT", () => {
      expect(poolPpFacts({ ...ok, traitCost: { extraTraits: [{ setId: 1, count: 1 }] } })).toEqual(refused("INVALID_PP_INPUT"));
      expect(poolPpFacts({ ...ok, traitCost: { extraTraits: [{ setId: "s", count: 0 }] } })).toEqual(refused("INVALID_PP_AMOUNT"));
    });

    it("(4) an empty rollerActorId → INVALID_PP_INPUT", () => {
      expect(poolPpFacts({ ...ok, rollerActorId: "" })).toEqual(refused("INVALID_PP_INPUT"));
    });

    it.each([[null], [{ kind: "actor" }], [{ kind: "bank", actorId: "x" }], [{ kind: "user", actorId: "u" }]])(
      "(5) payer %j → INVALID_PP_INPUT", payer => expect(poolPpFacts({ ...ok, payer })).toEqual(refused("INVALID_PP_INPUT")));

    it("reports a bad entry before a bad amount", () => {
      expect(poolPpFacts({ ...ok, entries: [{ ...trait(5, "X"), ppGained: 1.5 }] })).toEqual(refused("INVALID_PP_INPUT"));
    });
  });
});

describe("rollPpFacts (rules 12 to 14)", () => {
  it("PP-07 an SFX gain recorded by hand: settle 1 → 2", () => {
    const sfx = gain("SFX_GAIN", 1, false, { label: "Second Wind" });
    const facts = rollPpFacts({ selection: {}, sfxLines: [sfx], payer: PC });
    expect(facts.value).toEqual({ lines: [sfx], warnings: [] });
    expect(settleRoll({ balance: 1, lines: facts.value.lines }).value.balance).toBe(2);
  });

  it("PP-12 one extra result: EXTRA_RESULT −1; 2 → 1", () => {
    const facts = rollPpFacts({ selection: { extraResultsPaid: 1 }, payer: PC });
    expect(facts.value.lines).toEqual([spend("EXTRA_RESULT", 1)]);
    expect(settleRoll({ balance: 2, lines: facts.value.lines }).value.balance).toBe(1);
  });

  it("PP-13 one extra effect die each: DP-21 2 → 1, DP-22 1 → 0 (RQ-002)", () => {
    const { lines } = rollPpFacts({ selection: { extraEffectDicePaid: 1 }, payer: PC }).value;
    expect(lines).toEqual([spend("EXTRA_EFFECT_DIE", 1)]);
    expect(settleRoll({ balance: 2, lines }).value.balance).toBe(1);
    expect(settleRoll({ balance: 1, lines }).value.balance).toBe(0);
  });

  it("PP-14 an SFX that costs a PP costs again on the next roll: 3 → 2 → 1", () => {
    const { lines } = rollPpFacts({ selection: {}, sfxLines: [spend("SFX_SPEND", 1)], payer: PC }).value;
    const a = settleRoll({ balance: 3, lines }).value.balance;
    expect(a).toBe(2);
    expect(settleRoll({ balance: a, lines }).value.balance).toBe(1);
  });

  it("PP-19 two extra effect dice cost 2: 3 → 1 (RQ-041)", () => {
    const { lines } = rollPpFacts({ selection: { extraEffectDicePaid: 2 }, payer: PC }).value;
    expect(lines).toEqual([spend("EXTRA_EFFECT_DIE", 2)]);
    expect(settleRoll({ balance: 3, lines }).value.balance).toBe(1);
  });

  it("PP-20 a GMC's extra result is paid from the bank: 2 → 1", () => {
    const facts = rollPpFacts({ selection: { extraResultsPaid: 1 }, payer: BANK });
    expect(facts.value).toEqual({ lines: [spend("EXTRA_RESULT", 1)], warnings: [] });
    expect(settleRoll({ balance: 2, lines: facts.value.lines }).value.balance).toBe(1);
  });

  it("PP-22 a difficulty roll's extra result is paid from the bank: 3 → 2", () => {
    const { lines } = rollPpFacts({ selection: { extraResultsPaid: 1 }, payer: BANK }).value;
    expect(settleRoll({ balance: 3, lines }).value.balance).toBe(2);
  });

  it("PP-23 a GMC's extra effect die: no line, BANK_SPEND_NOT_LISTED with the count (RQ-043)", () => {
    expect(rollPpFacts({ selection: { extraEffectDicePaid: 1 }, payer: BANK }).value).toEqual({
      lines: [], warnings: [{ code: "BANK_SPEND_NOT_LISTED", count: 1 }]
    });
  });

  it("PP-E04 a reroll keeps the paid counter: one EXTRA_RESULT −1 from the final selection (P6)", () => {
    const { lines } = rollPpFacts({ selection: { totalIds: ["a", "b", "c"], extraResultsPaid: 1 }, payer: PC }).value;
    expect(lines).toEqual([spend("EXTRA_RESULT", 1)]);
  });

  it("orders the lines: results, effect dice, then the SFX lines", () => {
    const sfx = [spend("SFX_SPEND", 1, { label: "A" }), gain("SFX_GAIN", 1, true, { label: "B" })];
    const { lines } = rollPpFacts({ selection: { extraResultsPaid: 1, extraEffectDicePaid: 1 }, sfxLines: sfx, payer: PC }).value;
    expect(lines.map(l => l.reason)).toEqual(["EXTRA_RESULT", "EXTRA_EFFECT_DIE", "SFX_SPEND", "SFX_GAIN"]);
  });

  it("copies the SFX lines and never changes its input", () => {
    const input = deepFreeze({ selection: { extraResultsPaid: 1 }, sfxLines: [spend("SFX_SPEND", 1)], payer: PC });
    const { lines } = rollPpFacts(input).value;
    expect(lines[1]).not.toBe(input.sfxLines[0]);
  });

  describe("check order", () => {
    it("(1) no selection → INVALID_PP_INPUT", () => {
      expect(rollPpFacts({ payer: PC })).toEqual(refused("INVALID_PP_INPUT"));
    });
    it.each([[-1], [1.5], ["1"]])("(2) a counter of %j → INVALID_PP_AMOUNT", n => {
      expect(rollPpFacts({ selection: { extraResultsPaid: n }, payer: PC })).toEqual(refused("INVALID_PP_AMOUNT"));
      expect(rollPpFacts({ selection: { extraEffectDicePaid: n }, payer: PC })).toEqual(refused("INVALID_PP_AMOUNT"));
    });
    it("(3) an SFX line with another reason → INVALID_PP_INPUT", () => {
      expect(rollPpFacts({ selection: {}, sfxLines: [spend("EXTRA_RESULT", 1)], payer: PC })).toEqual(refused("INVALID_PP_INPUT"));
    });
    it("(4) a bad payer → INVALID_PP_INPUT", () => {
      expect(rollPpFacts({ selection: {}, payer: {} })).toEqual(refused("INVALID_PP_INPUT"));
    });
  });
});

describe("ppTotals (P4 preview)", () => {
  it("PP-16 Hinder's PP pays for the same roll's extra result: no warning (RQ-039)", () => {
    const lines = [gain("HINDER", 1, true), spend("EXTRA_RESULT", 1)];
    expect(ppTotals({ balance: 0, lines })).toEqual({
      ok: true, value: { spent: 1, gained: 1, usableGained: 1, net: 0, warnings: [] }
    });
  });

  it("PP-17 only the hitch PP would cover it: PP_NOT_YET_USABLE (rule 4)", () => {
    const lines = [spend("EXTRA_RESULT", 1), gain("HITCH_COMPLICATION", 1, false)];
    expect(ppTotals({ balance: 0, lines })).toEqual({
      ok: true, value: { spent: 1, gained: 1, usableGained: 0, net: 0, warnings: [{ code: "PP_NOT_YET_USABLE" }] }
    });
  });

  it("PP-21 two SFX spends against a bank of 1: PP_SHORT", () => {
    const lines = [spend("SFX_SPEND", 1), spend("SFX_SPEND", 1)];
    expect(ppTotals({ balance: 1, lines }).value.warnings).toEqual([{ code: "PP_SHORT" }]);
  });

  it("PP-E02 TS-09b's pool costs 2 and the player holds 1: PP_SHORT", () => {
    expect(ppTotals({ balance: 1, lines: [spend("EXTRA_TRAIT", 2, { sourceId: "skills" })] }).value.warnings)
      .toEqual([{ code: "PP_SHORT" }]);
  });

  it("PP-E14 a hitch line marked usable → INVALID_PP_INPUT", () => {
    expect(ppTotals({ balance: 0, lines: [gain("HITCH_COMPLICATION", 1, true)] })).toEqual(refused("INVALID_PP_INPUT"));
  });

  it("an empty list: all zero, no warning", () => {
    expect(ppTotals({ balance: 0, lines: [] }).value).toEqual({ spent: 0, gained: 0, usableGained: 0, net: 0, warnings: [] });
  });

  describe("check order", () => {
    it("(1) a bad balance → INVALID_PP_AMOUNT before a bad line", () => {
      expect(ppTotals({ balance: -1, lines: [null] })).toEqual(refused("INVALID_PP_AMOUNT"));
    });
    it.each([
      ["not an array", null],
      ["a reason outside the roll", [spend("STAY_IN", 1)]],
      ["the wrong direction", [{ reason: "HINDER", direction: "spend", amount: 1 }]],
      ["a gain without usableThisRoll", [{ reason: "HINDER", direction: "gain", amount: 1 }]],
      ["a spend with usableThisRoll", [{ ...spend("EXTRA_RESULT", 1), usableThisRoll: true }]],
      ["a label that isn't a string", [spend("EXTRA_RESULT", 1, { label: 3 })]]
    ])("(2) %s → INVALID_PP_INPUT", (_n, lines) => expect(ppTotals({ balance: 0, lines })).toEqual(refused("INVALID_PP_INPUT")));
    it.each([[0], [1.5], ["1"]])("(2) an amount of %j → INVALID_PP_AMOUNT", amount => {
      expect(ppTotals({ balance: 0, lines: [spend("EXTRA_RESULT", amount)] })).toEqual(refused("INVALID_PP_AMOUNT"));
    });
    it("checks each line completely before the next", () => {
      expect(ppTotals({ balance: 0, lines: [spend("EXTRA_RESULT", 0), null] })).toEqual(refused("INVALID_PP_AMOUNT"));
    });
  });
});

describe("settleRoll (rules 4, 11 to 14; P4, P5, P10)", () => {
  it("PP-15 extra trait, Hinder and extra result: 3 → 2", () => {
    const pool = poolPpFacts({
      entries: [...entriesOf("Brave", [8], { hinder: true }), trait(8, "Physical"), trait(8, "Fight"), trait(6, "Shoot")],
      traitCost: { extraTraits: [{ setId: "skills", count: 1 }] }, rollerActorId: "pc1", payer: PC
    }).value.lines;
    const roll = rollPpFacts({ selection: { extraResultsPaid: 1 }, payer: PC }).value.lines;
    const lines = [...pool, ...roll];
    expect(lines.map(l => l.reason)).toEqual(["EXTRA_TRAIT", "HINDER", "EXTRA_RESULT"]);
    expect(settleRoll({ balance: 3, lines }).value).toEqual({ balance: 2, delta: -1, spent: 2, gained: 1, lines });
  });

  it("PP-16 Hinder's PP pays for the extra result: 0 → 0 (RQ-039)", () => {
    expect(settleRoll({ balance: 0, lines: [gain("HINDER", 1, true), spend("EXTRA_RESULT", 1)] }).value.balance).toBe(0);
  });

  it("PP-17b the hitch PP can't pay for its own roll: PP_NOT_YET_USABLE, nothing written", () => {
    const lines = [spend("EXTRA_RESULT", 1), gain("HITCH_COMPLICATION", 1, false)];
    expect(settleRoll({ balance: 0, lines })).toEqual(refused("PP_NOT_YET_USABLE"));
  });

  it("PP-17c without the extra result the hitch PP settles: 0 → 1", () => {
    expect(settleRoll({ balance: 0, lines: [gain("HITCH_COMPLICATION", 1, false)] }).value).toEqual({
      balance: 1, delta: 1, spent: 0, gained: 1, lines: [gain("HITCH_COMPLICATION", 1, false)]
    });
  });

  it("PP-21 two SFX spends against a bank of 1: PP_INSUFFICIENT; PP-21b one: 1 → 0", () => {
    expect(settleRoll({ balance: 1, lines: [spend("SFX_SPEND", 1), spend("SFX_SPEND", 1)] })).toEqual(refused("PP_INSUFFICIENT"));
    expect(settleRoll({ balance: 1, lines: [spend("SFX_SPEND", 1)] }).value.balance).toBe(0);
  });

  it("PP-E02 short even with every gain: PP_INSUFFICIENT, not PP_NOT_YET_USABLE (review E3)", () => {
    expect(settleRoll({ balance: 1, lines: [spend("EXTRA_TRAIT", 2)] })).toEqual(refused("PP_INSUFFICIENT"));
    expect(settleRoll({ balance: 0, lines: [spend("EXTRA_RESULT", 2), gain("HITCH_COMPLICATION", 1, false)] }))
      .toEqual(refused("PP_INSUFFICIENT"));
  });

  it("PP-E03 a card already settled: PP_ALREADY_SETTLED before anything else", () => {
    expect(settleRoll({ balance: -1, lines: null, settled: true })).toEqual(refused("PP_ALREADY_SETTLED"));
  });

  it("PP-E05 a botch with Hinder still settles the Hinder gain", () => {
    expect(settleRoll({ balance: 0, lines: [gain("HINDER", 1, true)] }).value.balance).toBe(1);
  });

  it("PP-E14 a hitch line marked usable → INVALID_PP_INPUT", () => {
    expect(settleRoll({ balance: 0, lines: [gain("HITCH_COMPLICATION", 1, true)] })).toEqual(refused("INVALID_PP_INPUT"));
  });

  it("an empty list settles with delta 0", () => {
    expect(settleRoll({ balance: 4, lines: [] }).value).toEqual({ balance: 4, delta: 0, spent: 0, gained: 0, lines: [] });
  });

  it("copies the lines for the ledger and never changes its input", () => {
    const input = deepFreeze({ balance: 2, lines: [spend("EXTRA_RESULT", 1, { label: "x" })] });
    const { value } = settleRoll(input);
    expect(value.lines).toEqual(input.lines);
    expect(value.lines[0]).not.toBe(input.lines[0]);
  });

  describe("check order", () => {
    it("(1) settled that isn't a boolean → INVALID_PP_INPUT", () => {
      expect(settleRoll({ balance: 0, lines: [], settled: "no" })).toEqual(refused("INVALID_PP_INPUT"));
    });
    it("(3) a bad balance → INVALID_PP_AMOUNT", () => {
      expect(settleRoll({ balance: 1.5, lines: [] })).toEqual(refused("INVALID_PP_AMOUNT"));
    });
    it("(4) a bad line → INVALID_PP_INPUT", () => {
      expect(settleRoll({ balance: 0, lines: [{}] })).toEqual(refused("INVALID_PP_INPUT"));
    });
  });
});
