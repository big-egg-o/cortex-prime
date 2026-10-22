import { describe, expect, it } from "vitest";
import { buildPool } from "../../module/rules/pool.mjs";
import { applyOverflowChoice, applyResults, resolve, stepEffectDie } from "../../module/rules/roll.mjs";

/** @returns {{kind: string, label: string}} a minimal DieSource for tests */
function source(label) {
  return { kind: "trait", label };
}

/**
 * @param {number[]} sizes
 * @param {number[]} results
 * @returns {import("../../module/rules/types.mjs").RolledDie[]}
 */
function rollPool(sizes, results) {
  const pool = buildPool(sizes.map((size, i) => ({ size, source: source(`Die ${i + 1}`) })));
  return applyResults(pool, results);
}

/** @returns {import("../../module/rules/types.mjs").Selection} a Selection with sensible defaults */
function selection({
  totalIds = [], effectDieIds = [], extraResultsPaid = 0, extraEffectDicePaid = 0, keepLimit
} = {}) {
  const sel = { totalIds, effectDieIds, extraResultsPaid, extraEffectDicePaid };
  if ( keepLimit !== undefined ) sel.keepLimit = keepLimit;
  return sel;
}

describe("effect ids", () => {
  it("resolve numbers the effect dice e1, e2 in order and marks rolled dice as kind rolled", () => {
    const rolled = rollPool([12, 10, 8, 6], [5, 7, 6, 2]);
    const resolution = resolve(rolled, selection({
      totalIds: [rolled[1].id, rolled[2].id],
      effectDieIds: [rolled[0].id, rolled[3].id],
      extraEffectDicePaid: 1
    }));

    expect(resolution.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 12, dieId: rolled[0].id, isDefault: false },
      { id: "e2", kind: "rolled", size: 6, dieId: rolled[3].id, isDefault: false }
    ]);
    expect(resolution.consumedDieIds).toEqual([]);
    expect(resolution.nextEffectNumber).toBe(3);
  });

  it("resolve marks a d4 default as kind default (DP-22)", () => {
    const rolled = rollPool([8, 6], [5, 4]);
    const resolution = resolve(rolled, selection({
      totalIds: [rolled[0].id, rolled[1].id],
      extraEffectDicePaid: 1
    }));

    expect(resolution.effectDice).toEqual([
      { id: "e1", kind: "default", size: 4, dieId: null, isDefault: true },
      { id: "e2", kind: "default", size: 4, dieId: null, isDefault: true }
    ]);
    expect(resolution.nextEffectNumber).toBe(3);
  });

  it("refuses a step on an unknown effect id", () => {
    const rolled = rollPool([10, 8, 6], [7, 5, 3]);
    const resolution = resolve(rolled, selection({
      totalIds: [rolled[0].id, rolled[1].id],
      effectDieIds: [rolled[2].id]
    }));

    expect(() => stepEffectDie(rolled, resolution, "e2", 1, "other")).toThrow();
    expect(() => stepEffectDie(rolled, resolution, 0, 1, "other")).toThrow();
    expect(() => stepEffectDie(rolled, resolution, rolled[2].id, 1, "other")).toThrow();
  });
});

describe("stepEffectDie", () => {
  it("DP-24 steps a chosen effect die, and a multi-die step touches only the chosen one", () => {
    const rolled = rollPool([10, 6, 8], [7, 5, 6]);
    const resolution = resolve(rolled, selection({
      totalIds: [rolled[0].id, rolled[1].id],
      effectDieIds: [rolled[2].id]
    }));

    const stepped = stepEffectDie(rolled, resolution, "e1", 1, "other");
    expect(stepped.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 10, dieId: rolled[2].id, isDefault: false }
    ]);
    expect(stepped.overflow).toBeNull();

    const twoEffectDice = rollPool([12, 10, 8, 6], [5, 7, 6, 2]);
    const twoEffectResolution = resolve(twoEffectDice, selection({
      totalIds: [twoEffectDice[0].id, twoEffectDice[2].id],
      effectDieIds: [twoEffectDice[1].id, twoEffectDice[3].id],
      extraEffectDicePaid: 1
    }));

    const steppedFirst = stepEffectDie(twoEffectDice, twoEffectResolution, "e1", 1, "other");
    expect(steppedFirst.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 12, dieId: twoEffectDice[1].id, isDefault: false },
      { id: "e2", kind: "rolled", size: 6, dieId: twoEffectDice[3].id, isDefault: false }
    ]);

    const steppedSecond = stepEffectDie(twoEffectDice, twoEffectResolution, "e2", 1, "other");
    expect(steppedSecond.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 10, dieId: twoEffectDice[1].id, isDefault: false },
      { id: "e2", kind: "rolled", size: 8, dieId: twoEffectDice[3].id, isDefault: false }
    ]);
  });
});

describe("effect die overflow", () => {
  it("DP-25 offers a new d6 or a take-out when a heroic success overflows with nothing left", () => {
    const rolled = rollPool([12, 10, 8], [3, 9, 8]);
    const resolution = resolve(rolled, selection({
      totalIds: [rolled[1].id, rolled[2].id],
      effectDieIds: [rolled[0].id]
    }));

    const stepped = stepEffectDie(rolled, resolution, "e1", 1, "heroic");
    expect(stepped.effectDice).toEqual(resolution.effectDice);
    expect(stepped.overflow).toEqual({
      effectId: "e1",
      cause: "heroic",
      options: { cause: "heroic", leftovers: [], newDie: 6, takeOutAvailable: true }
    });

    const withD6 = applyOverflowChoice(rolled, stepped, { kind: "new-d6" });
    expect(withD6.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 12, dieId: rolled[0].id, isDefault: false },
      { id: "e2", kind: "overflow", size: 6, dieId: null, isDefault: true }
    ]);
    expect(withD6.overflow).toBeNull();
    expect(withD6.takeOut).toBe(false);
    expect(withD6.nextEffectNumber).toBe(3);

    const withTakeOut = applyOverflowChoice(rolled, stepped, { kind: "take-out" });
    expect(withTakeOut.takeOut).toBe(true);
    expect(withTakeOut.overflow).toBeNull();
    expect(withTakeOut.effectDice).toEqual(stepped.effectDice);

    expect(() => applyOverflowChoice(rolled, stepped, { kind: "leftover", dieId: "anything" })).toThrow();
    expect(() => applyOverflowChoice(rolled, stepped, { kind: "new-d4" })).toThrow();
  });

  it("DP-25a offers the same two options after several heroic steps past d12", () => {
    const rolled = rollPool([12, 10, 8], [3, 9, 8]);
    const resolution = resolve(rolled, selection({
      totalIds: [rolled[1].id, rolled[2].id],
      effectDieIds: [rolled[0].id]
    }));

    const stepped = stepEffectDie(rolled, resolution, "e1", 2, "heroic");
    expect(stepped.overflow).toEqual({
      effectId: "e1",
      cause: "heroic",
      options: { cause: "heroic", leftovers: [], newDie: 6, takeOutAvailable: true }
    });

    const withD6 = applyOverflowChoice(rolled, stepped, { kind: "new-d6" });
    expect(withD6.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 12, dieId: rolled[0].id, isDefault: false },
      { id: "e2", kind: "overflow", size: 6, dieId: null, isDefault: true }
    ]);
  });

  it("DP-25b offers an SFX overflow the same options, with or without a leftover die", () => {
    const noLeftover = rollPool([12, 10, 8], [3, 9, 8]);
    const noLeftoverResolution = resolve(noLeftover, selection({
      totalIds: [noLeftover[1].id, noLeftover[2].id],
      effectDieIds: [noLeftover[0].id]
    }));
    const noLeftoverStepped = stepEffectDie(noLeftover, noLeftoverResolution, "e1", 1, "other");
    expect(noLeftoverStepped.overflow).toEqual({
      effectId: "e1",
      cause: "other",
      options: { cause: "other", leftovers: [], newDie: 6, takeOutAvailable: true }
    });
    const noLeftoverD6 = applyOverflowChoice(noLeftover, noLeftoverStepped, { kind: "new-d6" });
    expect(noLeftoverD6.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 12, dieId: noLeftover[0].id, isDefault: false },
      { id: "e2", kind: "overflow", size: 6, dieId: null, isDefault: true }
    ]);
    const noLeftoverTakeOut = applyOverflowChoice(noLeftover, noLeftoverStepped, { kind: "take-out" });
    expect(noLeftoverTakeOut.takeOut).toBe(true);

    const withLeftover = rollPool([12, 10, 8, 8], [3, 9, 8, 4]);
    const withLeftoverResolution = resolve(withLeftover, selection({
      totalIds: [withLeftover[1].id, withLeftover[2].id],
      effectDieIds: [withLeftover[0].id]
    }));
    const withLeftoverStepped = stepEffectDie(withLeftover, withLeftoverResolution, "e1", 1, "other");
    expect(withLeftoverStepped.overflow).toEqual({
      effectId: "e1",
      cause: "other",
      options: {
        cause: "other",
        leftovers: [{ dieId: withLeftover[3].id, size: 8 }],
        newDie: 6,
        takeOutAvailable: true
      }
    });

    const withLeftoverPick = applyOverflowChoice(withLeftover, withLeftoverStepped, {
      kind: "leftover", dieId: withLeftover[3].id
    });
    expect(withLeftoverPick.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 12, dieId: withLeftover[0].id, isDefault: false },
      { id: "e2", kind: "rolled", size: 8, dieId: withLeftover[3].id, isDefault: false }
    ]);

    const withLeftoverD6 = applyOverflowChoice(withLeftover, withLeftoverStepped, { kind: "new-d6" });
    expect(withLeftoverD6.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 12, dieId: withLeftover[0].id, isDefault: false },
      { id: "e2", kind: "overflow", size: 6, dieId: null, isDefault: true }
    ]);

    const withLeftoverTakeOut = applyOverflowChoice(withLeftover, withLeftoverStepped, { kind: "take-out" });
    expect(withLeftoverTakeOut.takeOut).toBe(true);

    expect(() => applyOverflowChoice(withLeftover, withLeftoverStepped, {
      kind: "leftover", dieId: "not-the-leftover"
    })).toThrow();
  });

  it("DP-25c offers the leftover die at its own size, for both a d8 and a d4 leftover", () => {
    const withD8Leftover = rollPool([12, 10, 8, 8], [3, 9, 8, 4]);
    const d8Resolution = resolve(withD8Leftover, selection({
      totalIds: [withD8Leftover[1].id, withD8Leftover[2].id],
      effectDieIds: [withD8Leftover[0].id]
    }));
    const d8Stepped = stepEffectDie(withD8Leftover, d8Resolution, "e1", 1, "heroic");
    expect(d8Stepped.overflow.options).toEqual({
      cause: "heroic",
      leftovers: [{ dieId: withD8Leftover[3].id, size: 8 }],
      newDie: 6,
      takeOutAvailable: true
    });

    const d8Leftover = applyOverflowChoice(withD8Leftover, d8Stepped, {
      kind: "leftover", dieId: withD8Leftover[3].id
    });
    expect(d8Leftover.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 12, dieId: withD8Leftover[0].id, isDefault: false },
      { id: "e2", kind: "rolled", size: 8, dieId: withD8Leftover[3].id, isDefault: false }
    ]);

    const d8NewD6 = applyOverflowChoice(withD8Leftover, d8Stepped, { kind: "new-d6" });
    expect(d8NewD6.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 12, dieId: withD8Leftover[0].id, isDefault: false },
      { id: "e2", kind: "overflow", size: 6, dieId: null, isDefault: true }
    ]);

    const withD4Leftover = rollPool([12, 10, 8, 4], [3, 9, 8, 2]);
    const d4Resolution = resolve(withD4Leftover, selection({
      totalIds: [withD4Leftover[1].id, withD4Leftover[2].id],
      effectDieIds: [withD4Leftover[0].id]
    }));
    const d4Stepped = stepEffectDie(withD4Leftover, d4Resolution, "e1", 1, "heroic");
    expect(d4Stepped.overflow.options).toEqual({
      cause: "heroic",
      leftovers: [{ dieId: withD4Leftover[3].id, size: 4 }],
      newDie: 6,
      takeOutAvailable: true
    });

    const d4Leftover = applyOverflowChoice(withD4Leftover, d4Stepped, {
      kind: "leftover", dieId: withD4Leftover[3].id
    });
    expect(d4Leftover.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 12, dieId: withD4Leftover[0].id, isDefault: false },
      { id: "e2", kind: "rolled", size: 4, dieId: withD4Leftover[3].id, isDefault: false }
    ]);

    const d4NewD6 = applyOverflowChoice(withD4Leftover, d4Stepped, { kind: "new-d6" });
    expect(d4NewD6.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 12, dieId: withD4Leftover[0].id, isDefault: false },
      { id: "e2", kind: "overflow", size: 6, dieId: null, isDefault: true }
    ]);

    const d4TakeOut = applyOverflowChoice(withD4Leftover, d4Stepped, { kind: "take-out" });
    expect(d4TakeOut.takeOut).toBe(true);

    const severalLeft = rollPool([12, 10, 8, 8, 6, 4], [3, 9, 8, 4, 5, 1]);
    const severalResolution = resolve(severalLeft, selection({
      totalIds: [severalLeft[1].id, severalLeft[2].id],
      effectDieIds: [severalLeft[0].id]
    }));
    const severalStepped = stepEffectDie(severalLeft, severalResolution, "e1", 1, "heroic");
    expect(severalStepped.overflow.options).toEqual({
      cause: "heroic",
      leftovers: [
        { dieId: severalLeft[3].id, size: 8 },
        { dieId: severalLeft[4].id, size: 6 }
      ],
      newDie: 6,
      takeOutAvailable: true
    });

    const severalD6Leftover = applyOverflowChoice(severalLeft, severalStepped, {
      kind: "leftover", dieId: severalLeft[4].id
    });
    expect(severalD6Leftover.effectDice).toEqual([
      { id: "e1", kind: "rolled", size: 12, dieId: severalLeft[0].id, isDefault: false },
      { id: "e2", kind: "rolled", size: 6, dieId: severalLeft[4].id, isDefault: false }
    ]);

    expect(() => applyOverflowChoice(severalLeft, severalStepped, {
      kind: "leftover", dieId: severalLeft[5].id
    })).toThrow();
  });
});
