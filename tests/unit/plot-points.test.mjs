import { describe, expect, it } from "vitest";
import { PP_REASONS, changeBalance, ppChangeAllowed, startSession } from "../../module/rules/plot-points.mjs";
import * as rules from "../../module/rules/index.mjs";

/** @param {*} value @returns {*} the same value, frozen all the way down */
function deepFreeze(value) {
  if ( value && typeof value === "object" && !Object.isFrozen(value) ) {
    Object.freeze(value);
    for ( const key of Object.keys(value) ) deepFreeze(value[key]);
  }
  return value;
}

const refused = code => ({ ok: false, code });

/** @param {number[]} balances @returns {{actorId: string, balance: number}[]} one PC per balance */
function pcs(...balances) {
  return balances.map((balance, i) => ({ actorId: `pc${i + 1}`, balance }));
}

describe("PP_REASONS (Plot Points spec, implementation notes)", () => {
  it("maps each reason to its direction", () => {
    expect(PP_REASONS).toEqual({
      HINDER: "gain", D4_COMPLICATION: "gain", SFX_GAIN: "gain", HITCH_COMPLICATION: "gain", GIVE_IN: "gain",
      AWARD: "gain", SESSION_START: "gain",
      EXTRA_TRAIT: "spend", EXTRA_RESULT: "spend", EXTRA_EFFECT_DIE: "spend", SFX_SPEND: "spend", STAY_IN: "spend",
      GM_ADJUST: "adjust"
    });
  });

  it("is frozen", () => {
    expect(Object.isFrozen(PP_REASONS)).toBe(true);
  });

  it("is exported from the rules index with the functions", () => {
    expect(rules.PP_REASONS).toBe(PP_REASONS);
    expect(rules.changeBalance).toBe(changeBalance);
    expect(rules.startSession).toBe(startSession);
  });
});

describe("changeBalance (rules 5, 8, 15; P5)", () => {
  it("PP-06 an award of 1 to a player who holds 2 gives 3", () => {
    expect(changeBalance(2, 1)).toEqual({ ok: true, value: { balance: 3 } });
  });

  it("PP-E06 a loser who holds 0 can't pay to stay in", () => {
    expect(changeBalance(0, -1)).toEqual(refused("PP_INSUFFICIENT"));
  });

  it("PP-E07 an empty bank can't keep a GMC in", () => {
    expect(changeBalance(0, -1)).toEqual(refused("PP_INSUFFICIENT"));
  });

  it("a spend that leaves exactly 0 is allowed", () => {
    expect(changeBalance(1, -1)).toEqual({ ok: true, value: { balance: 0 } });
  });

  it("a GM adjustment may move a balance by more than one either way", () => {
    expect(changeBalance(1, 4)).toEqual({ ok: true, value: { balance: 5 } });
    expect(changeBalance(5, -5)).toEqual({ ok: true, value: { balance: 0 } });
    expect(changeBalance(5, -6)).toEqual(refused("PP_INSUFFICIENT"));
  });

  it.each([[1.5], [-0.5], ["2"], [null], [Number.NaN], [undefined], [Infinity]])(
    "PP-E01 a change of %s is INVALID_PP_AMOUNT", delta => {
      expect(changeBalance(2, delta)).toEqual(refused("INVALID_PP_AMOUNT"));
    });

  it("PP-E01 a change of 0 is INVALID_PP_AMOUNT: a change of nothing isn't an entry", () => {
    expect(changeBalance(2, 0)).toEqual(refused("INVALID_PP_AMOUNT"));
  });

  it.each([[-1], [1.5], ["2"], [null], [undefined]])("a stored balance of %s is INVALID_PP_AMOUNT", balance => {
    expect(changeBalance(balance, 1)).toEqual(refused("INVALID_PP_AMOUNT"));
  });

  it("rejects a bad balance even with a change that would be valid", () => {
    expect(changeBalance(-1, 1)).toEqual(refused("INVALID_PP_AMOUNT"));
  });
});

describe("startSession (rules 2 and 3; RQ-036, RQ-037; P7)", () => {
  it("PP-24 a new PC holding 0 starts with 1; the bank gets 1 for the one player", () => {
    expect(startSession({ players: pcs(0), bank: 0, playerCount: 1 })).toEqual({
      ok: true,
      value: { players: [{ actorId: "pc1", balance: 1, gained: 1 }], bank: 1, bankGained: 1 }
    });
  });

  it("PP-25 PCs holding 0, 2 and 5 end at 1, 2 and 5; only the first gains (RQ-036)", () => {
    expect(startSession({ players: pcs(0, 2, 5), bank: 0, playerCount: 3 })).toEqual({
      ok: true,
      value: {
        players: [
          { actorId: "pc1", balance: 1, gained: 1 },
          { actorId: "pc2", balance: 2, gained: 0 },
          { actorId: "pc3", balance: 5, gained: 0 }
        ],
        bank: 3,
        bankGained: 3
      }
    });
  });

  it("PP-26 a new world with four players: bank 4, each PC 1", () => {
    const { value } = startSession({ players: pcs(0, 0, 0, 0), bank: 0, playerCount: 4 });
    expect(value.bank).toBe(4);
    expect(value.players.map(p => p.balance)).toEqual([1, 1, 1, 1]);
  });

  it("PP-27 a bank holding 1 keeps it and gains 4 (RQ-037); PCs holding 1 gain nothing", () => {
    const { value } = startSession({ players: pcs(1, 1, 1, 1), bank: 1, playerCount: 4 });
    expect(value.bank).toBe(5);
    expect(value.bankGained).toBe(4);
    expect(value.players.map(p => [p.balance, p.gained])).toEqual([[1, 0], [1, 0], [1, 0], [1, 0]]);
  });

  it("keeps the players in input order", () => {
    const players = [{ actorId: "zed", balance: 3 }, { actorId: "amy", balance: 0 }];
    const { value } = startSession({ players, bank: 0, playerCount: 2 });
    expect(value.players.map(p => p.actorId)).toEqual(["zed", "amy"]);
  });

  it("works with no players and no PCs", () => {
    expect(startSession({ players: [], bank: 2, playerCount: 0 })).toEqual({
      ok: true, value: { players: [], bank: 2, bankGained: 0 }
    });
  });

  it("counts players apart from the PCs it raises (P7: the caller supplies both)", () => {
    const { value } = startSession({ players: pcs(0), bank: 0, playerCount: 3 });
    expect(value.bank).toBe(3);
    expect(value.players).toEqual([{ actorId: "pc1", balance: 1, gained: 1 }]);
  });

  it("never changes its input and returns new player objects", () => {
    const input = deepFreeze({ players: pcs(0, 4), bank: 1, playerCount: 2 });
    const result = startSession(input);
    expect(result.ok).toBe(true);
    expect(result.value.players).not.toBe(input.players);
    result.value.players.forEach((p, i) => expect(p).not.toBe(input.players[i]));
    expect(input.players).toEqual(pcs(0, 4));
  });

  describe("check order", () => {
    it.each([
      ["no argument", undefined],
      ["players missing", { bank: 0, playerCount: 0 }],
      ["players not an array", { players: {}, bank: 0, playerCount: 0 }],
      ["a player that isn't a plain object", { players: [null], bank: 0, playerCount: 1 }],
      ["a player that is an array", { players: [["pc1", 0]], bank: 0, playerCount: 1 }],
      ["an empty actorId", { players: [{ actorId: "", balance: 0 }], bank: 0, playerCount: 1 }],
      ["a non-string actorId", { players: [{ actorId: 7, balance: 0 }], bank: 0, playerCount: 1 }],
      ["a repeated actorId", { players: [{ actorId: "a", balance: 0 }, { actorId: "a", balance: 1 }], bank: 0, playerCount: 2 }]
    ])("(1) %s is INVALID_PP_INPUT", (_name, input) => {
      expect(startSession(input)).toEqual(refused("INVALID_PP_INPUT"));
    });

    it.each([[-1], [1.5], ["1"], [null], [undefined]])("(2) a player balance of %s is INVALID_PP_AMOUNT", balance => {
      expect(startSession({ players: [{ actorId: "a", balance }], bank: 0, playerCount: 1 }))
        .toEqual(refused("INVALID_PP_AMOUNT"));
    });

    it.each([[-1], [0.5], ["3"], [null], [undefined]])("(3) a bank of %s is INVALID_PP_AMOUNT", bank => {
      expect(startSession({ players: pcs(0), bank, playerCount: 1 })).toEqual(refused("INVALID_PP_AMOUNT"));
    });

    it.each([[-1], [1.5], ["2"], [null], [undefined]])("(4) a playerCount of %s is INVALID_PP_INPUT", playerCount => {
      expect(startSession({ players: pcs(0), bank: 0, playerCount })).toEqual(refused("INVALID_PP_INPUT"));
    });

    it("reports a bad player list before a bad balance, and a bad balance before a bad bank", () => {
      expect(startSession({ players: [{ actorId: "", balance: -1 }], bank: -1, playerCount: -1 }))
        .toEqual(refused("INVALID_PP_INPUT"));
      expect(startSession({ players: [{ actorId: "a", balance: -1 }], bank: -1, playerCount: -1 }))
        .toEqual(refused("INVALID_PP_AMOUNT"));
      expect(startSession({ players: pcs(0), bank: -1, playerCount: -1 })).toEqual(refused("INVALID_PP_AMOUNT"));
    });
  });
});

describe("ppChangeAllowed (P9)", () => {
  const ask = (accountKind, reason, isGM, isOwner) => ppChangeAllowed({ accountKind, reason, isGM, isOwner });

  it("lets a GM change anything", () => {
    for ( const kind of ["actor", "bank"] ) {
      for ( const reason of ["AWARD", "GM_ADJUST", "SFX_GAIN", "STAY_IN"] ) expect(ask(kind, reason, true, false).ok).toBe(true);
    }
  });

  it("lets an owner record their PC's own gains and spends", () => {
    expect(ask("actor", "SFX_GAIN", false, true)).toEqual({ ok: true, value: true });
    expect(ask("actor", "SFX_SPEND", false, true).ok).toBe(true);
    expect(ask("actor", "STAY_IN", false, true).ok).toBe(true);
  });

  it("refuses the bank, awards, adjustments and session starts to a player", () => {
    expect(ask("bank", "SFX_GAIN", false, true)).toEqual(refused("PP_GM_ONLY"));
    expect(ask("actor", "AWARD", false, true)).toEqual(refused("PP_GM_ONLY"));
    expect(ask("actor", "GM_ADJUST", false, true)).toEqual(refused("PP_GM_ONLY"));
    expect(ask("actor", "SESSION_START", false, true)).toEqual(refused("PP_GM_ONLY"));
  });

  it("refuses another player's PC", () => {
    expect(ask("actor", "SFX_GAIN", false, false)).toEqual(refused("PP_NOT_OWNER"));
  });

  it.each([[null], [{ accountKind: "user", reason: "AWARD", isGM: true, isOwner: true }],
    [{ accountKind: "actor", reason: "NOPE", isGM: true, isOwner: true }],
    [{ accountKind: "actor", reason: "AWARD", isGM: "yes", isOwner: true }]])("%j → INVALID_PP_INPUT", input => {
    expect(ppChangeAllowed(input)).toEqual(refused("INVALID_PP_INPUT"));
  });
});
