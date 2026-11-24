import { describe, expect, it } from "vitest";
import {
  AC_PP_REASONS, RULING_PENDING, actThroughOption, applyComplications, applyHitches, applyOpportunities,
  checkTemporaryTrait, contestComplications, createAsset, createSessionRelationship, endScene, endSession,
  loseSignatureAsset, recoverSignatureAsset, removeUsedD4Complications, signatureAssetPoolDice, stepTemporaryTrait,
  temporaryTraitPoolEntry, upgradeAsset
} from "../../module/rules/assets.mjs";
import { rerollableIds, resolve } from "../../module/rules/roll.mjs";

/** @param {*} value @returns {*} the same value, frozen all the way down */
function deepFreeze(value) {
  if ( value && typeof value === "object" && !Object.isFrozen(value) ) {
    Object.freeze(value);
    for ( const key of Object.keys(value) ) deepFreeze(value[key]);
  }
  return value;
}

const refused = code => ({ ok: false, code });
/** @returns {string} a 16-character id made from a name */
const id = name => `${name.replace(/[^a-zA-Z0-9]/g, "")}0000000000000000`.slice(0, 16);
const ANA = id("Ana");
const BEN = id("Ben");
const GMC = id("Gmc");
const ana = { kind: "actor", actorId: ANA };
const ben = { kind: "actor", actorId: BEN };
const gmc = { kind: "actor", actorId: GMC };
const scene = { kind: "scene" };

/** @returns {object} a TemporaryTrait with defaults for its kind */
function asset(name, size, fields = {}) {
  return {
    id: id(name), kind: "asset", name, dice: [size], holder: ana, origin: "pp", duration: "scene", access: "holder",
    sceneSteps: 0, beyondD12: false, startedAtD4: false, borrowedFrom: null, ...fields
  };
}

/** @returns {object} a complication with defaults */
function comp(name, size, fields = {}) {
  return {
    id: id(name), kind: "complication", name, dice: [size], holder: ana, origin: "hitch", duration: null,
    access: "holder", sceneSteps: 0, beyondD12: false, startedAtD4: false, borrowedFrom: null, ...fields
  };
}

/** @returns {object[]} rolled dice from "d8:1"-style strings, ids r0, r1, ... */
function roll(...specs) {
  return specs.map((spec, i) => {
    const [size, result] = spec.slice(1).split(":").map(Number);
    return {
      id: `r${i}`, size, source: { kind: "trait", label: spec }, origin: "rating", result, hitch: result === 1,
      state: "available"
    };
  });
}

const spend = (reason, name) => ({ reason, direction: "spend", amount: 1, label: name, sourceId: id(name) });
const hitchLine = name => ({
  reason: "HITCH_COMPLICATION", direction: "gain", amount: 1, label: name, sourceId: id(name), usableThisRoll: false
});
const newTarget = (name, holder = ana) => ({ kind: "new", id: id(name), name, holder });

describe("constants", () => {
  it("the spec's spend reasons, frozen", () => {
    expect(Object.keys(AC_PP_REASONS)).toEqual([
      "ASSET_CREATE", "ASSET_KEEP_SESSION", "ASSET_OPEN", "ASSET_GIVE", "OPPORTUNITY", "ACT_THROUGH_COMPLICATION",
      "SIGNATURE_ASSET_RECOVER", "RELATIONSHIP_CREATE"
    ]);
    expect(Object.values(AC_PP_REASONS).every(d => d === "spend")).toBe(true);
    expect(Object.isFrozen(AC_PP_REASONS)).toBe(true);
  });
});

describe("assets (rules 3 to 9)", () => {
  it("AC-01 a bought asset: d6 for the scene, held by its creator, one ASSET_CREATE", () => {
    const result = createAsset({ id: id("Length of Chain"), name: "Length of Chain", holder: ana, origin: "pp" });
    expect(result.value.trait).toEqual(asset("Length of Chain", 6));
    expect(result.value.ppLines).toEqual([spend("ASSET_CREATE", "Length of Chain")]);
  });

  it("AC-02 kept for the session and open at creation: three lines", () => {
    const result = createAsset({
      id: id("Length of Chain"), name: "Length of Chain", holder: ana, origin: "pp", keepForSession: true, open: true
    });
    expect(result.value.trait).toMatchObject({ dice: [6], duration: "session", access: "open" });
    expect(result.value.ppLines.map(l => l.reason)).toEqual(["ASSET_CREATE", "ASSET_KEEP_SESSION", "ASSET_OPEN"]);
  });

  it("AC-03 given to Ben at creation: one line; Ben's pool has no warning, Ana's warns and keeps the d6", () => {
    const created = createAsset({ id: id("Spare Clip"), name: "Spare Clip", holder: ben, origin: "pp" }).value;
    expect(created.ppLines).toEqual([spend("ASSET_CREATE", "Spare Clip")]);
    expect(temporaryTraitPoolEntry(created.trait, { rollerActorId: BEN }).value).toEqual({
      size: 6, source: { kind: "asset", actorId: BEN, traitId: id("Spare Clip"), label: "Spare Clip" }, warnings: []
    });
    expect(temporaryTraitPoolEntry(created.trait, { rollerActorId: ANA }).value)
      .toMatchObject({ size: 6, warnings: ["ASSET_NOT_AVAILABLE"] });
  });

  it("AC-04 keep, keep again; open, open again", () => {
    const chain = asset("Length of Chain", 6);
    const kept = upgradeAsset(chain, { kind: "keep" }).value;
    expect(kept.trait.duration).toBe("session");
    expect(kept.ppLines).toEqual([spend("ASSET_KEEP_SESSION", "Length of Chain")]);
    expect(upgradeAsset(kept.trait, { kind: "keep" })).toEqual(refused("ALREADY_KEPT"));
    const opened = upgradeAsset(chain, { kind: "open" }).value;
    expect(opened.trait.access).toBe("open");
    expect(opened.ppLines).toEqual([spend("ASSET_OPEN", "Length of Chain")]);
    expect(upgradeAsset(opened.trait, { kind: "open" })).toEqual(refused("ALREADY_OPEN"));
  });

  it("AC-05 a stunt is a d8 for the scene with no line of its own", () => {
    const result = createAsset({ id: id("Swirling Fog"), name: "Swirling Fog", holder: ana, origin: "stunt" }).value;
    expect(result.trait).toMatchObject({ dice: [8], origin: "stunt", duration: "scene" });
    expect(result.ppLines).toEqual([]);
  });

  it("AC-06 an asset test's effect die sizes the asset; the GM's cap limits it", () => {
    const rolled = roll("d10:7", "d8:5", "d12:2");
    const resolution = resolve(rolled, { totalIds: ["r0", "r1"], effectDieIds: ["r2"], extraResultsPaid: 0, extraEffectDicePaid: 0 });
    const effect = resolution.effectDice[0].size;
    expect(resolution.total).toBe(12);
    const made = createAsset({ id: id("Wiretap"), name: "Wiretap", holder: ana, origin: "effect", size: effect }).value;
    expect(made.trait.dice).toEqual([12]);
    expect(made.ppLines).toEqual([]);
    const capped = createAsset({ id: id("Wiretap"), name: "Wiretap", holder: ana, origin: "effect", size: effect, cap: 10 });
    expect(capped.value.trait.dice).toEqual([10]);
  });

  it("AC-07 a clue asset from the effect die; keeping it costs a PP; giving it waits on AC-Q5", () => {
    const clue = createAsset({ id: id("Guard Rotation"), name: "Guard Rotation", holder: ana, origin: "clue", size: 8 });
    expect(clue.value.trait).toMatchObject({ dice: [8], origin: "clue", duration: "scene" });
    expect(clue.value.ppLines).toEqual([]);
    const kept = upgradeAsset(clue.value.trait, { kind: "keep" }).value;
    expect(kept.ppLines).toEqual([spend("ASSET_KEEP_SESSION", "Guard Rotation")]);
    expect(upgradeAsset(kept.trait, { kind: "give", holder: ben })).toEqual(refused(RULING_PENDING));
    expect(upgradeAsset(asset("Length of Chain", 6), { kind: "give", holder: ben })).toEqual(refused("NOT_A_CLUE_ASSET"));
  });

  it("AC-08 a free asset after a success: d6, no line; keeping it costs one", () => {
    const free = createAsset({ id: id("Loose Floorboard"), name: "Loose Floorboard", holder: ana, origin: "free" }).value;
    expect(free.trait).toMatchObject({ dice: [6], origin: "free" });
    expect(free.ppLines).toEqual([]);
    expect(upgradeAsset(free.trait, { kind: "keep" }).value.ppLines).toEqual([spend("ASSET_KEEP_SESSION", "Loose Floorboard")]);
  });

  it("AC-09 a contest winner's unused effect die makes an asset of its size", () => {
    const made = createAsset({ id: id("Higher Ground"), name: "Higher Ground", holder: ana, origin: "effect", size: 8 });
    expect(made.value.trait).toMatchObject({ dice: [8], origin: "effect" });
    expect(made.value.ppLines).toEqual([]);
  });

  it("AC-10 pool entries: own asset with a scene step, another's held and open assets, the scene's asset", () => {
    const own = temporaryTraitPoolEntry(asset("Grappling Line", 8, { sceneSteps: 1 }), { rollerActorId: ANA }).value;
    expect(own).toEqual({
      size: 10, source: { kind: "asset", actorId: ANA, traitId: id("Grappling Line"), label: "Grappling Line" }, warnings: []
    });
    const held = temporaryTraitPoolEntry(asset("Bens Rope", 6, { holder: ben }), { rollerActorId: ANA }).value;
    expect(held).toMatchObject({ size: 6, warnings: ["ASSET_NOT_AVAILABLE"] });
    const open = temporaryTraitPoolEntry(asset("Bens Lamp", 6, { holder: ben, access: "open" }), { rollerActorId: ANA });
    expect(open.value.warnings).toEqual([]);
    const crates = createAsset({ id: id("Stacked Crates"), name: "Stacked Crates", holder: scene, origin: "gm", size: 6 });
    expect(crates.value.ppLines).toEqual([]);
    expect(temporaryTraitPoolEntry(crates.value.trait, { rollerActorId: ANA }).value)
      .toEqual({ size: 6, source: { kind: "asset", traitId: id("Stacked Crates"), label: "Stacked Crates" }, warnings: [] });
  });
});

describe("hitches and botches (rules 16 and 17)", () => {
  const hitches = (rolled, allocations, complications = []) => applyHitches({ rolled, side: "player", allocations, complications });

  it("AC-11 one hitch makes a d6 complication and pays one PP not usable on this roll; the die can't be rerolled", () => {
    const result = hitches(roll("d8:1", "d8:6", "d6:4"), [{ hitchIds: ["r0"], target: newTarget("Twisted Ankle") }]).value;
    expect(result.complications).toEqual([comp("Twisted Ankle", 6)]);
    expect(result.ppLines).toEqual([hitchLine("Twisted Ankle")]);
    expect(result.rolled[0].state).toBe("hitch-activated");
    expect(rerollableIds(result.rolled)).toEqual(["r1", "r2"]);
    expect(result.takenOut).toEqual([]);
  });

  it("AC-12 three hitches on one new complication: d10, one line", () => {
    const result = hitches(roll("d10:1", "d8:1", "d6:1", "d8:5"),
      [{ hitchIds: ["r0", "r1", "r2"], target: newTarget("Twisted Ankle") }]).value;
    expect(result.complications[0].dice).toEqual([10]);
    expect(result.ppLines).toHaveLength(1);
  });

  it("AC-13 four hitches split in different ways: one line per new complication", () => {
    const rolled = roll("d12:1", "d10:1", "d8:1", "d6:1", "d4:3");
    const split = (...groups) => {
      let next = 0;
      const allocations = groups.map((n, i) => ({
        hitchIds: Array.from({ length: n }, () => `r${next++}`), target: newTarget(`Complication ${i}`)
      }));
      const result = hitches(rolled, allocations).value;
      return [result.complications.map(c => c.dice[0]), result.ppLines.length, result.rolled];
    };
    expect(split(4).slice(0, 2)).toEqual([[12], 1]);
    expect(split(2, 2).slice(0, 2)).toEqual([[8, 8], 2]);
    expect(split(1, 3).slice(0, 2)).toEqual([[6, 10], 2]);
    expect(split(1, 1, 2).slice(0, 2)).toEqual([[6, 6, 8], 3]);
    expect(split(1, 1, 1, 1).slice(0, 2)).toEqual([[6, 6, 6, 6], 4]);
    const [sizes, lines, after] = split(2);
    expect([sizes, lines]).toEqual([[8], 1]);
    expect(after.map(d => d.state)).toEqual(["hitch-activated", "hitch-activated", "available", "available", "available"]);
  });

  it("AC-14 a botch makes one complication with every hitch and pays nothing", () => {
    const rolled = roll("d8:1", "d6:1", "d4:1");
    const all = hitches(rolled, [{ hitchIds: ["r0", "r1", "r2"], target: newTarget("Bad Fall") }]).value;
    expect(all.complications[0]).toMatchObject({ dice: [10], origin: "botch" });
    expect(all.ppLines).toEqual([]);
    expect(hitches(rolled, [{ hitchIds: ["r0"], target: newTarget("A") }, { hitchIds: ["r1", "r2"], target: newTarget("B") }]))
      .toEqual(refused("BOTCH_ONE_COMPLICATION"));
    expect(hitches(rolled, [{ hitchIds: ["r0", "r1"], target: newTarget("A") }])).toEqual(refused("BOTCH_ONE_COMPLICATION"));
  });

  it("AC-15 a botch of five hitches passes d12: stored as d12 past d12, taken out, no line", () => {
    const rolled = roll("d12:1", "d10:1", "d8:1", "d6:1", "d6:1");
    const result = hitches(rolled, [{ hitchIds: ["r0", "r1", "r2", "r3", "r4"], target: newTarget("Crushed") }]).value;
    expect(result.complications[0]).toMatchObject({ dice: [12], beyondD12: true, origin: "botch" });
    expect(result.takenOut).toEqual([id("Crushed")]);
    expect(result.changes).toEqual([{ traitId: id("Crushed"), created: true, from: null, to: 12, beyondD12: true, lostSteps: 0 }]);
    expect(result.ppLines).toEqual([]);
  });

  it("AC-16, AC-17, AC-18 hitches onto a complication the character has wait on AC-Q1", () => {
    const wanted = comp("Wanted", 6, { holder: ben });
    expect(hitches(roll("d8:1", "d6:1", "d10:7"), [{ hitchIds: ["r0", "r1"], target: { kind: "existing", traitId: wanted.id } }],
      [wanted])).toEqual(refused(RULING_PENDING));
    const concussed = comp("Concussed", 8, { holder: ben });
    expect(hitches(roll("d10:1", "d8:1", "d6:1", "d12:9", "d8:4"), [
      { hitchIds: ["r0"], target: newTarget("Jammed Rifle", ben) },
      { hitchIds: ["r1", "r2"], target: { kind: "existing", traitId: concussed.id } }
    ], [concussed])).toEqual(refused(RULING_PENDING));
  });

  it("AC-19 hitches on the GM's roll are opportunities", () => {
    expect(applyHitches({ rolled: roll("d8:1"), side: "gm", allocations: [], complications: [] }))
      .toEqual(refused("OPPORTUNITIES_NOT_HITCHES"));
  });
});

describe("opportunities (rules 19 and 20)", () => {
  const opportunities = (rolled, uses, traits = [], sceneBoosts = []) => applyOpportunities({
    rolled, side: "gm", uses, traits, sceneBoosts
  });
  const on = traitId => ({ kind: "temporary", traitId });

  it("AC-20 two opportunities step a complication down twice for one PP; one leaves the other available", () => {
    const rolled = roll("d10:1", "d8:1", "d8:6", "d6:4");
    const ribs = comp("Cracked Ribs", 10);
    const both = opportunities(rolled, [{ opportunityIds: ["r0", "r1"], direction: "down", target: on(ribs.id) }], [ribs]).value;
    expect(both.traits[0].dice).toEqual([6]);
    expect(both.ppLines).toEqual([spend("OPPORTUNITY", "Cracked Ribs")]);
    const one = opportunities(rolled, [{ opportunityIds: ["r0"], direction: "down", target: on(ribs.id) }], [ribs]).value;
    expect(one.traits[0].dice).toEqual([8]);
    expect(one.rolled[1].state).toBe("available");
  });

  it("AC-21 three opportunities on a d6: removed after two steps, one step lost, one line", () => {
    const shaken = comp("Shaken", 6);
    const result = opportunities(roll("d8:1", "d8:1", "d6:1", "d10:8"),
      [{ opportunityIds: ["r0", "r1", "r2"], direction: "down", target: on(shaken.id) }], [shaken]).value;
    expect(result.traits).toEqual([]);
    expect(result.removedIds).toEqual([shaken.id]);
    expect(result.changes[0]).toMatchObject({ from: 6, to: null, lostSteps: 1 });
    expect(result.ppLines).toHaveLength(1);
  });

  it("AC-22 one opportunity on an asset, a signature asset, and a d12 asset", () => {
    const line = asset("Grappling Line", 8);
    const a = opportunities(roll("d8:1"), [{ opportunityIds: ["r0"], direction: "up", target: on(line.id) }], [line]).value;
    expect(a.traits[0]).toMatchObject({ dice: [8], sceneSteps: 1 });
    expect(temporaryTraitPoolEntry(a.traits[0], { rollerActorId: ANA }).value.size).toBe(10);
    const sabre = { kind: "signature", actorId: ANA, traitId: id("Old Sabre"), label: "Old Sabre", dice: [10] };
    const b = opportunities(roll("d8:1", "d6:1"), [
      { opportunityIds: ["r0"], direction: "up", target: sabre }
    ], [], [{ actorId: ANA, traitId: id("Old Sabre"), steps: 0 + 1 }]).value;
    expect(b.sceneBoosts).toEqual([{ actorId: ANA, traitId: id("Old Sabre"), steps: 1 }]);
    expect(b.changes[0]).toMatchObject({ from: 12, to: 12, lostSteps: 1 });
    const fresh = opportunities(roll("d8:1"), [{ opportunityIds: ["r0"], direction: "up", target: sabre }]).value;
    expect(fresh.sceneBoosts).toEqual([{ actorId: ANA, traitId: id("Old Sabre"), steps: 1 }]);
    expect(signatureAssetPoolDice({ dice: [10], lost: null }, fresh.sceneBoosts[0]).value.dice).toEqual([12]);
    const big = asset("Big Gun", 12);
    const c = opportunities(roll("d8:1"), [{ opportunityIds: ["r0"], direction: "up", target: on(big.id) }], [big]).value;
    expect(c.traits[0]).toMatchObject({ dice: [12], sceneSteps: 0 });
    expect(c.changes[0].lostSteps).toBe(1);
    expect(c.ppLines).toEqual([spend("OPPORTUNITY", "Big Gun")]);
  });

  it("AC-22 (b) two opportunities on a signature asset wait on AC-Q2", () => {
    const sabre = { kind: "signature", actorId: ANA, traitId: id("Old Sabre"), label: "Old Sabre", dice: [10] };
    expect(opportunities(roll("d8:1", "d6:1"), [{ opportunityIds: ["r0", "r1"], direction: "up", target: sabre }]))
      .toEqual(refused(RULING_PENDING));
  });

  it("AC-23 a use on a complication and a single opportunity on an asset: one line each", () => {
    const knee = comp("Sprained Knee", 8);
    const battery = asset("Spare Battery", 6);
    const result = opportunities(roll("d10:1", "d8:1", "d6:1", "d12:7", "d8:5"), [
      { opportunityIds: ["r0", "r1"], direction: "down", target: on(knee.id) },
      { opportunityIds: ["r2"], direction: "up", target: on(battery.id) }
    ], [knee, battery]).value;
    expect(result.traits.map(t => t.dice[0])).toEqual([4, 6]);
    expect(result.traits[1].sceneSteps).toBe(1);
    expect(result.ppLines.map(l => l.reason)).toEqual(["OPPORTUNITY", "OPPORTUNITY"]);
  });

  it("AC-23 several opportunities on one asset wait on AC-Q2", () => {
    const battery = asset("Spare Battery", 6);
    expect(opportunities(roll("d10:1", "d8:1"), [{ opportunityIds: ["r0", "r1"], direction: "up", target: on(battery.id) }],
      [battery])).toEqual(refused(RULING_PENDING));
  });

  it("AC-25 an opportunity used again, and opportunities on a player's roll", () => {
    const ribs = comp("Cracked Ribs", 10);
    const first = opportunities(roll("d10:1", "d8:1"), [{ opportunityIds: ["r0"], direction: "down", target: on(ribs.id) }],
      [ribs]).value;
    expect(opportunities(first.rolled, [{ opportunityIds: ["r0"], direction: "down", target: on(ribs.id) }], first.traits))
      .toEqual(refused("HITCH_ALREADY_ACTIVATED"));
    expect(applyOpportunities({ rolled: roll("d8:1"), side: "player", uses: [], traits: [], sceneBoosts: [] }))
      .toEqual(refused("HITCHES_NOT_OPPORTUNITIES"));
  });

  it("AC-26 up on a complication waits on AC-Q3; down on an asset is not a listed use", () => {
    const cornered = comp("Cornered", 10, { holder: gmc });
    expect(opportunities(roll("d8:1", "d10:6", "d6:5"), [{ opportunityIds: ["r0"], direction: "up", target: on(cornered.id) }],
      [cornered])).toEqual(refused(RULING_PENDING));
    const crate = asset("Crate", 8);
    expect(opportunities(roll("d8:1"), [{ opportunityIds: ["r0"], direction: "down", target: on(crate.id) }], [crate]))
      .toEqual(refused("OPPORTUNITY_USE_NOT_LISTED"));
  });

  it("AC-40 opportunities on a complication past d12 wait on AC-Q4", () => {
    const debris = comp("Buried in Debris", 12, { beyondD12: true });
    expect(opportunities(roll("d8:1"), [{ opportunityIds: ["r0"], direction: "down", target: on(debris.id) }], [debris]))
      .toEqual(refused(RULING_PENDING));
  });
});

describe("the end of a scene and of a session", () => {
  it("AC-24 a session asset keeps its die and loses its scene steps; the scene's asset ends", () => {
    const keys = asset("Safehouse Keys", 6, { duration: "session", sceneSteps: 1 });
    const smoke = asset("Smoke Cover", 6, { holder: scene, origin: "gm" });
    const result = endScene({ traits: [keys, smoke], sceneBoosts: [] }).value;
    expect(result.traits).toEqual([{ ...keys, sceneSteps: 0 }]);
    expect(result.removedIds).toEqual([smoke.id]);
  });

  it("AC-47 the end of a scene", () => {
    const smoke = asset("Smoke Cover", 6);
    const keys = asset("Safehouse Keys", 8, { duration: "session", sceneSteps: 1 });
    const ankle = comp("Twisted Ankle", 6);
    const thick = comp("Thick Smoke", 8, { holder: scene, origin: "gm" });
    const boosts = [{ actorId: ANA, traitId: id("Old Sabre"), steps: 1 }];
    const result = endScene({ traits: [smoke, keys, ankle, thick], sceneBoosts: boosts }).value;
    expect(result.removedIds).toEqual([smoke.id, thick.id]);
    expect(result.traits).toEqual([{ ...keys, sceneSteps: 0 }, ankle]);
    expect(result.reviewIds).toEqual([ankle.id]);
    expect(result.sceneBoosts).toEqual([]);
  });

  it("AC-48 the end of the session after AC-47", () => {
    const keys = asset("Safehouse Keys", 8, { duration: "session" });
    const ankle = comp("Twisted Ankle", 6);
    const result = endSession({ traits: [keys, ankle], sceneBoosts: [] }).value;
    expect(result.removedIds).toEqual([keys.id]);
    expect(result.traits).toEqual([ankle]);
    expect(result.reviewIds).toEqual([ankle.id]);
    expect(result.expiredRelationshipIds).toEqual([]);
  });

  it("a complication with no holder stays at the end of a scene and of a session", () => {
    const alarm = comp("Alarm Raised", 8, { holder: { kind: "unassigned" }, origin: "gm" });
    expect(endSession({ traits: [alarm], sceneBoosts: [] }).value.traits).toEqual([alarm]);
  });
});

describe("complications as consequence (rules 21 to 24)", () => {
  /** A won contest's Consequence with the fields contestComplications reads. */
  const consequence = fields => ({
    winner: "initiator", loser: "opposition", ending: "won", takenOut: false, avoidWithPP: null, comparisons: [],
    winnerEffects: [], ...fields
  });
  const compared = (effectId, winnerDie, loserDie, complication, takesOut = false) => ({
    effectId, winnerDie, loserDie, steppedDown: false, complication, takesOut
  });

  it("AC-27 TC-17: a d10 complication, new on a loser who holds none", () => {
    const tc17 = consequence({ winnerEffects: [{ id: "e1", size: 10 }], comparisons: [compared("e1", 10, 6, 10)] });
    const sizes = contestComplications(tc17, { stayedIn: false }).value;
    expect(sizes).toEqual([{ effectId: "e1", size: 10, cause: "contest" }]);
    const result = applyComplications([], [{ ...sizes[0], target: newTarget("Outmanoeuvred", gmc) }]).value;
    expect(result.complications).toEqual([comp("Outmanoeuvred", 10, { holder: gmc, origin: "contest" })]);
  });

  it("AC-28 a step-up instead: only onto a complication at least as large", () => {
    const bruised = comp("Bruised", 10);
    const stepped = applyComplications([bruised], [{ size: 8, cause: "contest", target: { kind: "existing", traitId: bruised.id } }]);
    expect(stepped.value.complications[0].dice).toEqual([12]);
    const small = comp("Bruised", 8);
    expect(applyComplications([small], [{ size: 10, cause: "contest", target: { kind: "existing", traitId: small.id } }]))
      .toEqual(refused("COMPLICATION_TOO_SMALL"));
  });

  it("AC-29 TC-24 with the stay-in paid: a d10; stepping a d12 up instead takes the character out after all", () => {
    const tc24 = consequence({
      winnerEffects: [{ id: "e1", size: 10 }], comparisons: [compared("e1", 10, 6, 10, true)], takenOut: true,
      avoidWithPP: [{ effectId: "e1", size: 10 }]
    });
    expect(contestComplications(tc24, { stayedIn: true }).value).toEqual([{ effectId: "e1", size: 10, cause: "stayIn" }]);
    const bleeding = comp("Bleeding", 12);
    const result = applyComplications([bleeding], [{ size: 10, cause: "stayIn", target: { kind: "existing", traitId: bleeding.id } }]);
    expect(result.value.complications[0]).toMatchObject({ dice: [12], beyondD12: true });
    expect(result.value.takenOut).toEqual([bleeding.id]);
  });

  it("AC-30 TC-31 with the stay-in paid: items apply in order", () => {
    const winded = comp("Winded", 8);
    const result = applyComplications([winded], [
      { size: 10, cause: "stayIn", target: newTarget("Gashed Arm") },
      { size: 8, cause: "stayIn", target: { kind: "existing", traitId: winded.id } }
    ]).value;
    expect(result.complications.map(c => [c.name, c.dice[0]])).toEqual([["Winded", 10], ["Gashed Arm", 10]]);
    expect(applyComplications([winded], [{ size: 10, cause: "stayIn", target: { kind: "existing", traitId: winded.id } }]))
      .toEqual(refused("COMPLICATION_TOO_SMALL"));
  });

  it("AC-31 a failed test's d6: new, stepping a d6 up, refused onto a d4", () => {
    const lost = applyComplications([], [{ size: 6, cause: "failedTest", target: newTarget("Lost the Trail") }]).value;
    expect(lost.complications[0]).toMatchObject({ dice: [6], origin: "failedTest" });
    const exhausted = comp("Exhausted", 6);
    expect(applyComplications([exhausted], [{ size: 6, cause: "failedTest", target: { kind: "existing", traitId: exhausted.id } }])
      .value.complications[0].dice).toEqual([8]);
    const scratched = comp("Scratched", 4);
    expect(applyComplications([scratched], [{ size: 6, cause: "failedTest", target: { kind: "existing", traitId: scratched.id } }]))
      .toEqual(refused("COMPLICATION_TOO_SMALL"));
  });

  it("AC-32 a GMC kept in by the GM gets a d10 from the stay-in", () => {
    const result = applyComplications([], [{ size: 10, cause: "stayIn", target: newTarget("Winged", gmc) }]).value;
    expect(result.complications[0]).toMatchObject({ dice: [10], origin: "stayIn", holder: gmc });
  });

  it("AC-33 TC-28c, TC-29b without and with the stay-in", () => {
    const tc28c = consequence({
      winnerEffects: [{ id: "e1", size: 8 }, { id: "e2", size: 4 }],
      comparisons: [compared("e1", 8, 6, 8), compared("e2", 4, 6, null)]
    });
    expect(contestComplications(tc28c, { stayedIn: false }).value).toEqual([{ effectId: "e1", size: 8, cause: "contest" }]);
    const tc29b = consequence({
      winnerEffects: [{ id: "e1", size: 12 }, { id: "e2", size: 6 }], comparisons: [compared("e2", 6, 8, 4)],
      takenOut: true, avoidWithPP: [{ effectId: "e1", size: 12 }]
    });
    expect(contestComplications(tc29b, { stayedIn: false }).value).toEqual([{ effectId: "e2", size: 4, cause: "contest" }]);
    expect(contestComplications(tc29b, { stayedIn: true }).value).toEqual([
      { effectId: "e1", size: 12, cause: "stayIn" }, { effectId: "e2", size: 4, cause: "contest" }
    ]);
  });

  it("AC-E12 a stay-in without a take-out; giving in gives none", () => {
    expect(contestComplications(consequence({}), { stayedIn: true })).toEqual(refused("NO_TAKE_OUT"));
    expect(contestComplications(consequence({ ending: "gaveIn", winnerEffects: [{ id: "e1", size: 8 }] }), { stayedIn: false }))
      .toEqual({ ok: true, value: [] });
  });
});

describe("d4 complications (rule 18)", () => {
  it("AC-34 a d4 complication stepped down to d4 goes into its holder's pool for a PP and is removed after", () => {
    const wrist = comp("Sprained Wrist", 4);
    expect(temporaryTraitPoolEntry(wrist, { rollerActorId: ANA }).value).toEqual({
      size: 4, source: { kind: "complication", actorId: ANA, traitId: wrist.id, label: "Sprained Wrist" }, ppGained: 1,
      warnings: []
    });
    expect(removeUsedD4Complications([wrist], [wrist.id]).value).toEqual({ complications: [], removedIds: [wrist.id] });
  });

  it("AC-35 hitches onto the used d4 complication wait on AC-Q1; one stepped up is kept", () => {
    const wrist = comp("Sprained Wrist", 4);
    expect(applyHitches({
      rolled: roll("d8:6", "d8:5", "d4:1"), side: "player", allocations: [{ hitchIds: ["r2"], target: { kind: "existing", traitId: wrist.id } }],
      complications: [wrist]
    })).toEqual(refused(RULING_PENDING));
    const stepped = comp("Sprained Wrist", 6);
    expect(removeUsedD4Complications([stepped], [stepped.id]).value.removedIds).toEqual([]);
  });

  it("AC-36 another holder's d4 complication in a GMC's pool: a warning and no PP", () => {
    const entry = temporaryTraitPoolEntry(comp("Sprained Wrist", 4), { rollerActorId: GMC }).value;
    expect(entry).toMatchObject({ size: 4, warnings: ["D4_COMPLICATION_GOES_TO_HOLDER"] });
    expect(entry.ppGained).toBeUndefined();
  });

  it("AC-37 a complication made at d4 is marked; where it goes waits on AC-Q6", () => {
    const made = applyComplications([], [{ size: 4, cause: "contest", target: newTarget("Off Balance") }]).value;
    expect(made.complications[0]).toMatchObject({ dice: [4], startedAtD4: true });
    expect(temporaryTraitPoolEntry(made.complications[0], { rollerActorId: ANA })).toEqual(refused(RULING_PENDING));
    expect(removeUsedD4Complications(made.complications, [id("Off Balance")])).toEqual(refused(RULING_PENDING));
    const stepped = stepTemporaryTrait(made.complications[0], 1).value.trait;
    expect(stepped).toMatchObject({ dice: [6], startedAtD4: false });
  });

  it("AC-38 a botch onto the used d4 complication waits on AC-Q1", () => {
    const wrist = comp("Sprained Wrist", 4);
    expect(applyHitches({
      rolled: roll("d4:1", "d6:1"), side: "player", allocations: [{ hitchIds: ["r0", "r1"], target: { kind: "existing", traitId: wrist.id } }],
      complications: [wrist]
    })).toEqual(refused(RULING_PENDING));
  });
});

describe("complications past d12 (rules 25 and 26)", () => {
  it("AC-39 acting through it: one PP and keep 1; its die in a pool waits on AC-Q4", () => {
    const debris = comp("Buried in Debris", 12, { beyondD12: true });
    expect(actThroughOption([debris], ANA).value).toEqual({
      ppLine: spend("ACT_THROUGH_COMPLICATION", "Buried in Debris"), keepLimit: 1, traitIds: [debris.id]
    });
    const kept = resolve(roll("d10:7", "d8:6", "d6:3"), { totalIds: ["r0"], effectDieIds: ["r1"], extraResultsPaid: 0, extraEffectDicePaid: 0, keepLimit: 1 });
    expect(kept.total).toBe(7);
    expect(temporaryTraitPoolEntry(debris, { rollerActorId: GMC })).toEqual(refused(RULING_PENDING));
  });

  it("AC-41 no complication past d12", () => {
    expect(actThroughOption([comp("Concussed", 10, { holder: ben })], BEN)).toEqual(refused("NOT_TAKEN_OUT_BY_COMPLICATION"));
  });
});

describe("signature assets and relationships (rules 12, 13 and 15)", () => {
  const revolver = { id: id("Revolver"), name: "Grandfather's Revolver", dice: [8], lost: null };

  it("AC-42 out of action, in a pool with a warning, recovered for a PP or between sessions", () => {
    const lost = loseSignatureAsset(revolver, { outOfAction: true }).value;
    expect(lost.lost).toEqual({ outOfAction: true, preLossDice: [8] });
    expect(signatureAssetPoolDice(lost, null).value).toEqual({ dice: [8], warnings: ["SIGNATURE_ASSET_LOST"] });
    const paid = recoverSignatureAsset(lost, "pp").value;
    expect(paid.entry).toEqual(revolver);
    expect(paid.ppLines).toEqual([{
      reason: "SIGNATURE_ASSET_RECOVER", direction: "spend", amount: 1, label: "Grandfather's Revolver", sourceId: revolver.id
    }]);
    const free = recoverSignatureAsset(lost, "betweenSessions").value;
    expect(free).toEqual({ entry: revolver, ppLines: [] });
    expect(recoverSignatureAsset(free.entry, "pp")).toEqual(refused("SIGNATURE_ASSET_NOT_LOST"));
  });

  it("AC-43 damage by a step down waits on AC-Q7", () => {
    expect(loseSignatureAsset(revolver, { steps: -1 })).toEqual(refused(RULING_PENDING));
  });

  it("AC-44 borrowing another's signature asset makes an ordinary d6 asset for a PP", () => {
    const borrowed = createAsset({
      id: id("Revolver borrowed"), name: "Grandfather's Revolver (borrowed)", holder: ben, origin: "borrowed",
      borrowedFrom: { actorId: ANA, traitId: revolver.id }
    }).value;
    expect(borrowed.trait).toMatchObject({ dice: [6], holder: ben, borrowedFrom: { actorId: ANA, traitId: revolver.id } });
    expect(borrowed.ppLines.map(l => l.reason)).toEqual(["ASSET_CREATE"]);
  });

  it("AC-45 a scene boost ends with the scene", () => {
    const boost = { actorId: ANA, traitId: id("Old Sabre"), steps: 1 };
    expect(signatureAssetPoolDice({ dice: [10] }, boost).value.dice).toEqual([12]);
    const ended = endScene({ traits: [], sceneBoosts: [boost] }).value;
    expect(ended.sceneBoosts).toEqual([]);
    expect(signatureAssetPoolDice({ dice: [10] }, null).value.dice).toEqual([10]);
  });

  it("AC-46 a session relationship: d6 for a PP, ending with the session", () => {
    const made = createSessionRelationship({ id: id("Dockmaster Ruiz"), name: "Dockmaster Ruiz" }).value;
    expect(made.entry).toEqual({ id: id("Dockmaster Ruiz"), defId: null, name: "Dockmaster Ruiz", dice: [6], sessionOnly: true });
    expect(made.ppLines).toEqual([spend("RELATIONSHIP_CREATE", "Dockmaster Ruiz")]);
    const ended = endSession({ traits: [], sceneBoosts: [] }, [made.entry, { id: id("Old Friend"), dice: [8] }]).value;
    expect(ended.expiredRelationshipIds).toEqual([made.entry.id]);
  });
});

describe("edge cases", () => {
  it("AC-E01 malformed traits", () => {
    expect(checkTemporaryTrait(comp("X", 7))).toEqual(refused("INVALID_DIE_SIZE"));
    expect(checkTemporaryTrait({ ...comp("X", 6), dice: [6, 6] })).toEqual(refused("TEMP_TRAIT_ONE_DIE"));
    expect(checkTemporaryTrait({ ...comp("X", 6), dice: [] })).toEqual(refused("TEMP_TRAIT_ONE_DIE"));
    for ( const bad of [
      comp(" ", 6, { id: id("X") }), { ...comp("X", 6), kind: "stress" }, asset("X", 12, { beyondD12: true }),
      comp("X", 10, { beyondD12: true }), comp("X", 6, { sceneSteps: 1 }), asset("X", 6, { sceneSteps: -1 }),
      asset("X", 6, { sceneSteps: 1.5 }), asset("X", 6, { duration: null }), comp("X", 6, { access: "open" }),
      asset("X", 6, { borrowedFrom: { actorId: ANA, traitId: id("Y") } }), comp("X", 6, { startedAtD4: true }),
      asset("X", 6, { holder: scene }), comp("X", 6, { holder: { kind: "actor", actorId: "short" } }), null
    ] ) expect(checkTemporaryTrait(bad)).toEqual(refused("INVALID_TEMP_TRAIT"));
  });

  it("AC-E02 applyHitches refusals in check order", () => {
    const rolled = roll("d8:1", "d6:3", "d6:1");
    const twisted = comp("Twisted", 6);
    const run = (allocations, complications = [twisted]) => applyHitches({ rolled, side: "player", allocations, complications });
    expect(run([{ hitchIds: ["r9"], target: newTarget("A") }])).toEqual(refused("HITCH_NOT_FOUND"));
    expect(run([{ hitchIds: ["r1"], target: newTarget("A") }])).toEqual(refused("NOT_A_HITCH"));
    const used = applyHitches({ rolled, side: "player", allocations: [{ hitchIds: ["r0"], target: newTarget("A") }], complications: [] });
    expect(applyHitches({ rolled: used.value.rolled, side: "player", allocations: [{ hitchIds: ["r0"], target: newTarget("B") }],
      complications: [] })).toEqual(refused("HITCH_ALREADY_ACTIVATED"));
    expect(run([{ hitchIds: ["r0"], target: newTarget("A") }, { hitchIds: ["r0"], target: newTarget("B") }]))
      .toEqual(refused("HITCH_REUSED"));
    expect(run([{ hitchIds: [], target: newTarget("A") }])).toEqual(refused("EMPTY_ALLOCATION"));
    expect(run([{ hitchIds: ["r0"], target: newTarget("Twisted") }])).toEqual(refused("DUPLICATE_TRAIT_ID"));
    expect(run([{ hitchIds: ["r0"], target: { kind: "existing", traitId: id("Nothing") } }])).toEqual(refused("TRAIT_NOT_FOUND"));
    const crate = asset("Crate", 6);
    expect(run([{ hitchIds: ["r0"], target: { kind: "existing", traitId: crate.id } }], [crate]))
      .toEqual(refused("NOT_A_COMPLICATION"));
  });

  it("AC-E03 the GM declines: nothing changes", () => {
    const rolled = roll("d8:1", "d6:3");
    const twisted = comp("Twisted", 6);
    const result = applyHitches({ rolled, side: "player", allocations: [], complications: [twisted] }).value;
    expect(result).toEqual({ rolled, complications: [twisted], changes: [], takenOut: [], ppLines: [] });
    expect(result.rolled).not.toBe(rolled);
  });

  it("AC-E04 every function works from frozen inputs", () => {
    const wrist = deepFreeze(comp("Sprained Wrist", 4));
    const ribs = deepFreeze(comp("Cracked Ribs", 10));
    const line = deepFreeze(asset("Grappling Line", 8));
    const rolled = deepFreeze(roll("d8:1", "d6:1", "d10:5"));
    expect(applyHitches({ rolled, side: "player", allocations: deepFreeze([{ hitchIds: ["r0"], target: newTarget("A") }]),
      complications: [ribs] }).ok).toBe(true);
    expect(applyOpportunities(deepFreeze({ rolled, side: "gm", uses: [
      { opportunityIds: ["r0"], direction: "down", target: { kind: "temporary", traitId: ribs.id } },
      { opportunityIds: ["r1"], direction: "up", target: { kind: "temporary", traitId: line.id } }
    ], traits: [ribs, line], sceneBoosts: [] })).ok).toBe(true);
    expect(applyComplications([ribs], deepFreeze([{ size: 8, cause: "contest", target: { kind: "existing", traitId: ribs.id } }])).ok)
      .toBe(true);
    expect(upgradeAsset(line, { kind: "keep" }).ok).toBe(true);
    expect(stepTemporaryTrait(ribs, 2).ok).toBe(true);
    expect(removeUsedD4Complications([wrist], [wrist.id]).ok).toBe(true);
    expect(endSession(deepFreeze({ traits: [line, ribs], sceneBoosts: [{ actorId: ANA, traitId: id("S"), steps: 1 }] })).ok).toBe(true);
    const revolver = deepFreeze({ id: id("Revolver"), dice: [8], lost: null });
    const lost = loseSignatureAsset(revolver, deepFreeze({ outOfAction: true }));
    expect(recoverSignatureAsset(deepFreeze(lost.value), "pp").ok).toBe(true);
    expect(revolver.lost).toBe(null);
  });

  it("AC-E05 a consequence step onto a complication past d12 waits on AC-Q4", () => {
    const debris = comp("Buried", 12, { beyondD12: true });
    expect(applyComplications([debris], [{ size: 8, cause: "contest", target: { kind: "existing", traitId: debris.id } }]))
      .toEqual(refused(RULING_PENDING));
  });

  it("AC-E07 stepTemporaryTrait", () => {
    expect(stepTemporaryTrait(asset("A", 10), 2)).toEqual(refused("ASSET_STEP_PAST_D12"));
    expect(stepTemporaryTrait(asset("A", 4), -1).value).toEqual({ trait: null, removed: true, takenOut: false });
    expect(stepTemporaryTrait(comp("C", 12), 1).value).toMatchObject({ trait: { dice: [12], beyondD12: true }, takenOut: true });
    expect(stepTemporaryTrait(comp("C", 12, { beyondD12: true }), 1)).toEqual(refused(RULING_PENDING));
    expect(stepTemporaryTrait(comp("C", 12, { beyondD12: true }), -1)).toEqual(refused(RULING_PENDING));
    expect(stepTemporaryTrait(asset("A", 6), 0)).toEqual(refused("INVALID_INPUT"));
    expect(stepTemporaryTrait(asset("A", 6), 1.5)).toEqual(refused("INVALID_INPUT"));
    expect(stepTemporaryTrait(asset("A", 6, { sceneSteps: 1 }), 1).value.trait).toMatchObject({ dice: [8], sceneSteps: 1 });
  });

  it("AC-E08 upgradeAsset refusals; the GM's asset upgrades with no line", () => {
    expect(upgradeAsset(comp("C", 6), { kind: "keep" })).toEqual(refused("NOT_AN_ASSET"));
    const clue = asset("Clue", 8, { origin: "clue" });
    expect(upgradeAsset(clue, { kind: "give", holder: ana })).toEqual(refused("SAME_HOLDER"));
    expect(upgradeAsset(clue, { kind: "give", holder: scene })).toEqual(refused("INVALID_INPUT"));
    expect(upgradeAsset(clue, { kind: "share" })).toEqual(refused("INVALID_INPUT"));
    const crates = asset("Crates", 6, { origin: "gm", holder: scene });
    expect(upgradeAsset(crates, { kind: "keep" }).value.ppLines).toEqual([]);
    expect(upgradeAsset(crates, { kind: "open" }).value.ppLines).toEqual([]);
  });

  it("AC-E09 createAsset refusals and caps", () => {
    const base = { id: id("A"), name: "A", holder: ana };
    expect(createAsset({ ...base, origin: "effect" })).toEqual(refused("INVALID_INPUT"));
    expect(createAsset({ ...base, origin: "effect", size: 7 })).toEqual(refused("INVALID_DIE_SIZE"));
    expect(createAsset({ ...base, origin: "effect", size: 8, cap: 5 })).toEqual(refused("INVALID_DIE_SIZE"));
    expect(createAsset({ ...base, origin: "effect", size: 8, cap: 12 }).value.trait.dice).toEqual([8]);
    expect(createAsset({ ...base, origin: "pp", size: 8 })).toEqual(refused("INVALID_INPUT"));
    expect(createAsset({ ...base, origin: "pp", cap: 8 })).toEqual(refused("INVALID_INPUT"));
    expect(createAsset({ ...base, origin: "pp", holder: scene })).toEqual(refused("INVALID_TEMP_TRAIT"));
    expect(createAsset({ ...base, origin: "borrowed" })).toEqual(refused("INVALID_INPUT"));
    expect(createAsset({ ...base, origin: "pp", open: "yes" })).toEqual(refused("INVALID_INPUT"));
    expect(createAsset({ ...base, origin: "gm", size: 8, holder: { kind: "unassigned" } }).value.trait.holder)
      .toEqual({ kind: "unassigned" });
  });

  it("AC-E10 opportunity refusals mirror the hitch ones", () => {
    const ribs = comp("Ribs", 10);
    const run = uses => applyOpportunities({ rolled: roll("d8:1", "d6:4"), side: "gm", uses, traits: [ribs], sceneBoosts: [] });
    const on = { kind: "temporary", traitId: ribs.id };
    expect(run([{ opportunityIds: [], direction: "down", target: on }])).toEqual(refused("EMPTY_ALLOCATION"));
    expect(run([{ opportunityIds: ["r9"], direction: "down", target: on }])).toEqual(refused("HITCH_NOT_FOUND"));
    expect(run([{ opportunityIds: ["r1"], direction: "down", target: on }])).toEqual(refused("NOT_A_HITCH"));
    expect(run([{ opportunityIds: ["r0"], direction: "down", target: { kind: "temporary", traitId: id("None") } }]))
      .toEqual(refused("TRAIT_NOT_FOUND"));
    const sig = { kind: "signature", actorId: ANA, traitId: id("Sabre"), label: "Sabre", dice: [6, 6] };
    expect(run([{ opportunityIds: ["r0"], direction: "up", target: sig }])).toEqual(refused("TEMP_TRAIT_ONE_DIE"));
    expect(applyOpportunities({ rolled: roll("d8:1", "d6:1"), side: "gm", traits: [ribs], sceneBoosts: [], uses: [
      { opportunityIds: ["r0"], direction: "down", target: on }, { opportunityIds: ["r1"], direction: "down", target: on }
    ] })).toEqual(refused("DUPLICATE_TARGET"));
  });

  it("AC-E11 removeUsedD4Complications refusals", () => {
    const crate = asset("Crate", 6);
    expect(removeUsedD4Complications([crate], [id("None")])).toEqual(refused("TRAIT_NOT_FOUND"));
    expect(removeUsedD4Complications([crate], [crate.id])).toEqual(refused("NOT_A_COMPLICATION"));
    expect(removeUsedD4Complications([crate], ["x", "x"])).toEqual(refused("INVALID_INPUT"));
  });

  it("AC-E13 loseSignatureAsset refusals", () => {
    expect(loseSignatureAsset({ dice: [8] }, {})).toEqual(refused("INVALID_INPUT"));
    expect(loseSignatureAsset({ dice: [] }, { outOfAction: true })).toEqual(refused("INVALID_INPUT"));
    expect(loseSignatureAsset({ dice: [7] }, { outOfAction: true })).toEqual(refused("INVALID_DIE_SIZE"));
    const twice = loseSignatureAsset(loseSignatureAsset({ dice: [8] }, { outOfAction: true }).value, { outOfAction: true });
    expect(twice.value.lost).toEqual({ outOfAction: true, preLossDice: [8] });
  });
});
