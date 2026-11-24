import { describe, expect, it } from "vitest";
import {
  STAY_IN_ROUTES, SUGGESTED_GM_COMPLICATION_SIZE, changeBalance, contestPpOptions, testStayInOption
} from "../../module/rules/plot-points.mjs";

/** @param {*} value @returns {*} the same value, frozen all the way down */
function deepFreeze(value) {
  if ( value && typeof value === "object" && !Object.isFrozen(value) ) {
    Object.freeze(value);
    for ( const key of Object.keys(value) ) deepFreeze(value[key]);
  }
  return value;
}

const refused = code => ({ ok: false, code });

/** A Consequence with only the fields contestPpOptions reads, plus a won contest's defaults. */
function consequence(fields = {}) {
  return {
    winner: "opposition", loser: "initiator", ending: "won", ppEligible: false, takenOut: false, avoidWithPP: null,
    comparisons: [], ...fields
  };
}

const pay = side => [{ route: "pay", changes: [{ target: { kind: "side", side }, delta: -1, reason: "STAY_IN" }] }];
const bank = [{ route: "bank", changes: [{ target: { kind: "bank" }, delta: -1, reason: "STAY_IN" }] }];

describe("constants", () => {
  it("STAY_IN_ROUTES is pay and bank, frozen; the suggested GM size is 6 (RQ-044)", () => {
    expect(STAY_IN_ROUTES).toEqual(["pay", "bank"]);
    expect(Object.isFrozen(STAY_IN_ROUTES)).toBe(true);
    expect(SUGGESTED_GM_COMPLICATION_SIZE).toBe(6);
  });
});

describe("contestPpOptions (rules 6, 15, 18, 19)", () => {
  it("PP-04 I gives in after rolling: +1 GIVE_IN to I; 0 → 1, the bank unchanged", () => {
    const options = contestPpOptions(consequence({ ending: "gaveIn", ppEligible: true }), { gmcSides: ["opposition"] });
    expect(options.value).toEqual({
      giveIn: { side: "initiator", changes: [{ target: { kind: "side", side: "initiator" }, delta: 1, reason: "GIVE_IN" }] },
      stayIn: null
    });
    expect(changeBalance(0, 1).value.balance).toBe(1);
  });

  it("PP-05 a decline earns nothing", () => {
    expect(contestPpOptions(consequence({ winner: "initiator", loser: "opposition", ending: "declined" })).value)
      .toEqual({ giveIn: null, stayIn: null });
  });

  it("PP-18 the loser with no effect die pays to take a d8: 2 → 1", () => {
    const c = consequence({ takenOut: true, avoidWithPP: [{ effectId: "e1", size: 8 }] });
    expect(contestPpOptions(c).value.stayIn).toEqual({
      side: "initiator", complications: [{ effectId: "e1", size: 8 }], routes: pay("initiator")
    });
    expect(changeBalance(2, -1).value.balance).toBe(1);
  });

  it("PP-28 TC-24: a d10 complication; 1 → 0", () => {
    const c = consequence({ takenOut: true, avoidWithPP: [{ effectId: "e1", size: 10 }] });
    expect(contestPpOptions(c).value.stayIn.complications).toEqual([{ effectId: "e1", size: 10 }]);
    expect(changeBalance(1, -1).value.balance).toBe(0);
  });

  it("PP-29 an overflow take-out: a d12 complication (RQ-013)", () => {
    const c = consequence({ takenOut: true, avoidWithPP: [{ effectId: "e1", size: 12 }] });
    expect(contestPpOptions(c).value.stayIn.complications).toEqual([{ effectId: "e1", size: 12 }]);
  });

  it("PP-30 the comparison's d4 stands either way and isn't repeated (RQ-016)", () => {
    const c = consequence({
      takenOut: true, avoidWithPP: [{ effectId: "e1", size: 12 }],
      comparisons: [{ effectId: "e2", takesOut: false, complication: 4 }]
    });
    expect(contestPpOptions(c).value.stayIn.complications).toEqual([{ effectId: "e1", size: 12 }]);
  });

  it("PP-31 one PP for both take-outs: d10 and d8 (RQ-017); 2 → 1", () => {
    const c = consequence({ takenOut: true, avoidWithPP: [{ effectId: "e1", size: 10 }, { effectId: "e2", size: 8 }] });
    const { stayIn } = contestPpOptions(c).value;
    expect(stayIn.complications).toEqual([{ effectId: "e1", size: 10 }, { effectId: "e2", size: 8 }]);
    expect(stayIn.routes).toEqual(pay("initiator"));
    expect(changeBalance(2, -1).value.balance).toBe(1);
  });

  it("PP-32 give in, then pay that PP in the next contest: 0 → 1 → 0", () => {
    const first = contestPpOptions(consequence({ ending: "gaveIn", ppEligible: true, rematchBlocked: true })).value;
    const after = changeBalance(0, first.giveIn.changes[0].delta).value.balance;
    const second = contestPpOptions(consequence({ takenOut: true, avoidWithPP: [{ effectId: "e1", size: 8 }] })).value;
    expect(second.stayIn.complications).toEqual([{ effectId: "e1", size: 8 }]);
    expect(changeBalance(after, second.stayIn.routes[0].changes[0].delta).value.balance).toBe(0);
  });

  it("PP-33a a GMC loser stays in from the bank only; the winner gains nothing (RQ-042)", () => {
    const c = consequence({
      winner: "initiator", loser: "opposition", takenOut: true, avoidWithPP: [{ effectId: "e1", size: 10 }]
    });
    expect(contestPpOptions(c, { gmcSides: ["opposition"] }).value.stayIn).toEqual({
      side: "opposition", complications: [{ effectId: "e1", size: 10 }], routes: bank
    });
    expect(changeBalance(2, -1).value.balance).toBe(1);
  });

  it("PP-34 a GMC gives in after rolling: +1 GIVE_IN to the bank (RQ-038); 2 → 3", () => {
    const c = consequence({ winner: "initiator", loser: "opposition", ending: "gaveIn", ppEligible: true });
    expect(contestPpOptions(c, { gmcSides: ["opposition"] }).value.giveIn).toEqual({
      side: "opposition", changes: [{ target: { kind: "bank" }, delta: 1, reason: "GIVE_IN" }]
    });
    expect(changeBalance(2, 1).value.balance).toBe(3);
  });

  it("PP-E06 a loser at 0 can't pay; PP-E07 an empty bank can't keep a GMC in", () => {
    expect(changeBalance(0, -1)).toEqual(refused("PP_INSUFFICIENT"));
  });

  it("PP-E13 a GMC beaten by a GMC: the bank route only", () => {
    const c = consequence({ takenOut: true, avoidWithPP: [{ effectId: "e1", size: 8 }] });
    expect(contestPpOptions(c, { gmcSides: ["initiator", "opposition"] }).value.stayIn.routes).toEqual(bank);
  });

  it("PP-E08 staying in is offered only for a take-out the Consequence reports", () => {
    expect(contestPpOptions(consequence({ comparisons: [{ effectId: "e1", takesOut: false, complication: 6 }] })).value.stayIn)
      .toBeNull();
  });

  it("PP-E15 a hitch PP after the roll was settled is a change of its own: 0 → 1", () => {
    expect(changeBalance(0, 1).value.balance).toBe(1);
  });

  it("PP-E16 no take-out: stayIn null", () => {
    expect(contestPpOptions(consequence()).value.stayIn).toBeNull();
  });

  it("never changes its input and shares no object with it", () => {
    const c = deepFreeze(consequence({ takenOut: true, avoidWithPP: [{ effectId: "e1", size: 8 }] }));
    const { stayIn } = contestPpOptions(c, deepFreeze({ gmcSides: [] })).value;
    expect(stayIn.complications[0]).not.toBe(c.avoidWithPP[0]);
  });

  describe("check order", () => {
    it.each([
      ["not an object", null],
      ["the same side twice", consequence({ winner: "initiator" })],
      ["an unknown side", consequence({ loser: "roller" })],
      ["ppEligible missing", consequence({ ppEligible: undefined })],
      ["takenOut without avoidWithPP", consequence({ takenOut: true })],
      ["avoidWithPP without takenOut", consequence({ avoidWithPP: [{ effectId: "e1", size: 8 }] })],
      ["an empty avoidWithPP with takenOut", consequence({ takenOut: true, avoidWithPP: [] })],
      ["a size off the ladder", consequence({ takenOut: true, avoidWithPP: [{ effectId: "e1", size: 7 }] })]
    ])("(1) %s → INVALID_PP_INPUT", (_n, c) => expect(contestPpOptions(c)).toEqual(refused("INVALID_PP_INPUT")));

    it.each([[["roller"]], [["initiator", "initiator"]], ["opposition"]])("(2) gmcSides %j → INVALID_PP_INPUT", gmcSides => {
      expect(contestPpOptions(consequence(), { gmcSides })).toEqual(refused("INVALID_PP_INPUT"));
    });
  });
});

describe("testStayInOption (rules 15, 18; RQ-035, RQ-042, RQ-044)", () => {
  const failed = { success: false, margin: 2 };
  const e1 = { id: "e1", size: 8 };
  const e2 = { id: "e2", size: 6 };
  const base = { result: failed, oppositionEffects: [e1], takenOut: true };

  it("PP-35 a failed high-stakes test: a d8 complication for 1 PP; 1 → 0", () => {
    expect(testStayInOption(base)).toEqual({
      ok: true, value: { complications: [{ effectId: "e1", size: 8 }], gmSizeNeeded: null, routes: pay("roller") }
    });
    expect(changeBalance(1, -1).value.balance).toBe(0);
  });

  it("PP-36 two opposition effect dice both acting: one complication at the largest", () => {
    expect(testStayInOption({ ...base, oppositionEffects: [e1, e2] }).value.complications).toEqual([{ effectId: "e1", size: 8 }]);
  });

  it("PP-36b only the dice the GM marks count", () => {
    const both = { ...base, oppositionEffects: [e1, e2] };
    expect(testStayInOption({ ...both, usedAgainst: ["e1"] }).value.complications).toEqual([{ effectId: "e1", size: 8 }]);
    expect(testStayInOption({ ...both, usedAgainst: ["e2"] }).value.complications).toEqual([{ effectId: "e2", size: 6 }]);
  });

  it("takes the first die on a tie", () => {
    const tie = [{ id: "a", size: 8 }, { id: "b", size: 8 }];
    expect(testStayInOption({ ...base, oppositionEffects: tie }).value.complications).toEqual([{ effectId: "a", size: 8 }]);
  });

  it("PP-37 a GMC who fails stays in from the bank (RQ-042); 2 → 1", () => {
    expect(testStayInOption({ ...base, rollerIsGmc: true }).value.routes).toEqual(bank);
    expect(changeBalance(2, -1).value.balance).toBe(1);
  });

  it("PP-38 an applied overflow take-out: a d12 complication (RQ-035, RQ-013)", () => {
    const input = { ...base, oppositionEffects: [{ id: "e1", size: 12 }], oppositionTakeOut: true, overflowApplies: true };
    expect(testStayInOption(input).value.complications).toEqual([{ effectId: null, size: 12 }]);
  });

  it("PP-38b the GM applies no take-out, or the test succeeds: NO_TAKE_OUT", () => {
    const shut = { result: failed, oppositionEffects: [{ id: "e1", size: 12 }], oppositionTakeOut: true, takenOut: false };
    expect(testStayInOption(shut)).toEqual(refused("NO_TAKE_OUT"));
    expect(testStayInOption({ ...shut, result: { success: true }, takenOut: true })).toEqual(refused("NO_TAKE_OUT"));
  });

  it("PP-39 an area attack: each character's own die", () => {
    const both = { ...base, oppositionEffects: [e1, e2] };
    expect(testStayInOption({ ...both, usedAgainst: ["e1"] }).value.complications).toEqual([{ effectId: "e1", size: 8 }]);
    expect(testStayInOption({ ...both, usedAgainst: ["e2"] }).value.complications).toEqual([{ effectId: "e2", size: 6 }]);
  });

  it("PP-E12 no opposition effect die: ask the GM, suggesting d6; then the size, or none", () => {
    const none = { ...base, oppositionEffects: [] };
    expect(testStayInOption(none).value).toEqual({
      complications: null, gmSizeNeeded: { suggestedSize: 6 }, routes: pay("roller")
    });
    expect(testStayInOption({ ...none, gmSize: 6 }).value.complications).toEqual([{ effectId: null, size: 6 }]);
    expect(testStayInOption({ ...none, gmSize: "none" }).value.complications).toEqual([]);
  });

  it("PP-E16 a success, or a failure without the GM's ruling: NO_TAKE_OUT", () => {
    expect(testStayInOption({ ...base, result: { success: true } })).toEqual(refused("NO_TAKE_OUT"));
    expect(testStayInOption({ ...base, takenOut: false })).toEqual(refused("NO_TAKE_OUT"));
  });

  it("PP-E18 an applied overflow without a recorded take-out choice: NO_OVERFLOW_TAKE_OUT", () => {
    expect(testStayInOption({ ...base, oppositionTakeOut: false, overflowApplies: true })).toEqual(refused("NO_OVERFLOW_TAKE_OUT"));
    expect(testStayInOption({ ...base, oppositionTakeOut: null, overflowApplies: true })).toEqual(refused("NO_OVERFLOW_TAKE_OUT"));
    const applied = { ...base, oppositionTakeOut: true, overflowApplies: true };
    expect(testStayInOption({ ...applied, usedAgainst: ["e1"] })).toEqual(refused("INVALID_PP_INPUT"));
    expect(testStayInOption({ ...applied, gmSize: 6 })).toEqual(refused("INVALID_PP_INPUT"));
  });

  it("PP-E19 a GM size with opposition effect dice: INVALID_PP_INPUT", () => {
    expect(testStayInOption({ ...base, gmSize: 6 })).toEqual(refused("INVALID_PP_INPUT"));
  });

  it("refuses repeated, empty and unknown used dice", () => {
    expect(testStayInOption({ ...base, usedAgainst: ["e1", "e1"] })).toEqual(refused("DUPLICATE_EFFECT_DIE"));
    expect(testStayInOption({ ...base, usedAgainst: [] })).toEqual(refused("NO_EFFECT_DIE_USED"));
    expect(testStayInOption({ ...base, usedAgainst: ["x"] })).toEqual(refused("EFFECT_DIE_NOT_FOUND"));
    expect(testStayInOption({ ...base, oppositionEffects: [], usedAgainst: ["x"] })).toEqual(refused("EFFECT_DIE_NOT_FOUND"));
  });

  it("never changes its input", () => {
    const input = deepFreeze({ ...base, oppositionEffects: [e1, e2], usedAgainst: ["e2"] });
    expect(testStayInOption(input).ok).toBe(true);
  });

  describe("check order", () => {
    it.each([
      ["no result", { ...base, result: null }],
      ["takenOut missing", { ...base, takenOut: undefined }],
      ["overflowApplies without takenOut", { ...base, takenOut: false, overflowApplies: true }],
      ["oppositionTakeOut of the wrong type", { ...base, oppositionTakeOut: "yes" }],
      ["repeated effect ids", { ...base, oppositionEffects: [e1, e1] }],
      ["usedAgainst not strings", { ...base, usedAgainst: [1] }],
      ["gmSize a string", { ...base, oppositionEffects: [], gmSize: "d6" }]
    ])("(1) %s → INVALID_PP_INPUT", (_n, input) => expect(testStayInOption(input)).toEqual(refused("INVALID_PP_INPUT")));

    it("(2) a size off the ladder → INVALID_DIE_SIZE, before NO_TAKE_OUT", () => {
      expect(testStayInOption({ ...base, takenOut: false, oppositionEffects: [{ id: "e1", size: 7 }] }))
        .toEqual(refused("INVALID_DIE_SIZE"));
      expect(testStayInOption({ ...base, oppositionEffects: [], gmSize: 5 })).toEqual(refused("INVALID_DIE_SIZE"));
    });
  });
});
