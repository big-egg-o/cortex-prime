import { describe, expect, it } from "vitest";
import {
  COMPLETED_ACTIONS_KEPT, MAX_NOTE_LENGTH, TRAIT_STORE_ACTIONS, checkTraitStore, dispatchTraitStoreRequest,
  emptyTraitStore, poolTraitChoices, previewEnd, trackerGroups, usedD4ComplicationIds
} from "../../module/rules/trait-store.mjs";
import * as rules from "../../module/rules/index.mjs";

const refused = code => ({ ok: false, code });
const id = name => `${name.replace(/[^a-zA-Z0-9]/g, "")}0000000000000000`.slice(0, 16);
const ANA = "Actor.Ana0000000000000";
const GUARD_1 = "Scene.Dock000000000000.Token.Guard10000000000.Actor.Guard00000000000";
const GUARD_2 = "Scene.Dock000000000000.Token.Guard20000000000.Actor.Guard00000000000";
const holder = actorId => ({ kind: "actor", actorId });
const GM = { userId: "gmUser0000000000", isGM: true };
const PLAYER = { userId: "player0000000000", isGM: false };

/** Facts the handler passes: Ana is a PC the player owns, the guards are GMCs. */
const ACTORS = {
  [ANA]: { ownedBySender: true, holdsPlotPoints: true, balance: 2 },
  [GUARD_1]: { ownedBySender: false, holdsPlotPoints: false, balance: null },
  [GUARD_2]: { ownedBySender: false, holdsPlotPoints: false, balance: null }
};

let counter = 0;
const request = (action, payload, revision = 0) => ({ action, actionId: `action-${++counter}`, revision, payload });
const run = (sender, req, store = emptyTraitStore(), actors = ACTORS, roll = null) => dispatchTraitStoreRequest({
  sender, request: req, store, actors, roll
});
const addComplication = (name, actorId, size = 6, revision = 0) => request("addComplication", {
  id: id(name), name, size, holder: actorId ? holder(actorId) : { kind: "unassigned" }
}, revision);

describe("the trait store (ADR-057, step 4.8a)", () => {
  it("starts empty and is exported from the rules index", () => {
    expect(emptyTraitStore()).toEqual({ revision: 0, traits: [], sceneBoosts: [], notes: {}, completedActions: [] });
    expect(checkTraitStore(emptyTraitStore()).ok).toBe(true);
    expect(rules.dispatchTraitStoreRequest).toBe(dispatchTraitStoreRequest);
    expect(Object.isFrozen(TRAIT_STORE_ACTIONS)).toBe(true);
  });

  it("the GM adds a complication to one of two unlinked guards; the other is unaffected", () => {
    const made = run(GM, addComplication("Dust Blinded", GUARD_1)).value;
    expect(made.store.revision).toBe(1);
    expect(made.store.traits).toEqual([expect.objectContaining({ dice: [6], holder: holder(GUARD_1), origin: "gm" })]);
    expect(made.payment).toBeNull();
    const groups = trackerGroups(made.store, [{ actorKey: GUARD_1, name: "Guard" }, { actorKey: GUARD_2, name: "Guard" }]).value;
    expect(groups.characters.map(g => g.actorKey)).toEqual([GUARD_1]);
  });

  it("a note survives a step and goes with the trait when it is removed", () => {
    let store = run(GM, addComplication("Dust Blinded", GUARD_1)).value.store;
    store = run(GM, request("setNote", { traitId: id("Dust Blinded"), note: "  Affects sight. " }, 1), store).value.store;
    expect(store.notes).toEqual({ [id("Dust Blinded")]: "Affects sight." });
    store = run(GM, request("step", { traitId: id("Dust Blinded"), steps: 1 }, 2), store).value.store;
    expect(store.traits[0].dice).toEqual([8]);
    expect(store.notes[id("Dust Blinded")]).toBe("Affects sight.");
    const removed = run(GM, request("step", { traitId: id("Dust Blinded"), steps: -3 }, 3), store).value;
    expect(removed.removedIds).toEqual([id("Dust Blinded")]);
    expect(removed.store.traits).toEqual([]);
    expect(removed.store.notes).toEqual({});
  });

  it("an empty note clears it; a long one is refused", () => {
    let store = run(GM, addComplication("Alarm", null)).value.store;
    store = run(GM, request("setNote", { traitId: id("Alarm"), note: "Guards on alert" }, 1), store).value.store;
    store = run(GM, request("setNote", { traitId: id("Alarm"), note: " " }, 2), store).value.store;
    expect(store.notes).toEqual({});
    expect(run(GM, request("setNote", { traitId: id("Alarm"), note: "x".repeat(MAX_NOTE_LENGTH + 1) }, 3), store))
      .toEqual(refused("NOTE_TOO_LONG"));
  });

  it("assigns an unassigned complication, and refuses an asset a player made for the scene", () => {
    let store = run(GM, addComplication("Alarm", null)).value.store;
    store = run(GM, request("assign", { traitId: id("Alarm"), holder: holder(ANA) }, 1), store).value.store;
    expect(store.traits[0].holder).toEqual(holder(ANA));
    expect(run(GM, request("assign", { traitId: id("Alarm"), holder: holder("Actor.Nobody00000000000") }, 2), store))
      .toEqual(refused("ACTOR_NOT_FOUND"));
    const bought = run(PLAYER, request("buyAsset", { id: id("Rope"), name: "Rope", holder: holder(ANA) }, 2), store).value;
    expect(run(GM, request("assign", { traitId: id("Rope"), holder: { kind: "scene" } }, 3), bought.store))
      .toEqual(refused("INVALID_TEMP_TRAIT"));
  });

  it("a player buys a d6 asset for 1 PP from their character", () => {
    const result = run(PLAYER, request("buyAsset", { id: id("Rope"), name: "Rope", holder: holder(ANA) })).value;
    expect(result.store.traits[0]).toMatchObject({ dice: [6], origin: "pp", duration: "scene", holder: holder(ANA) });
    const line = { reason: "ASSET_CREATE", direction: "spend", amount: 1, label: "Rope", sourceId: id("Rope") };
    expect(result.payment).toEqual({ account: { kind: "actor", actorKey: ANA }, delta: -1, balance: 1, line, lines: [line] });
  });

  it("refuses an unaffordable purchase without changing anything", () => {
    const poor = { ...ACTORS, [ANA]: { ...ACTORS[ANA], balance: 0 } };
    const store = emptyTraitStore();
    expect(run(PLAYER, request("buyAsset", { id: id("Rope"), name: "Rope", holder: holder(ANA) }), store, poor))
      .toEqual(refused("PP_INSUFFICIENT"));
    expect(store).toEqual(emptyTraitStore());
  });

  it("a retried action returns its first answer and writes nothing new", () => {
    const req = request("buyAsset", { id: id("Rope"), name: "Rope", holder: holder(ANA) });
    const first = run(PLAYER, req).value;
    const again = run(PLAYER, req, first.store).value;
    expect(again).toEqual({
      store: first.store, payment: null, removedIds: [], replayed: true, warnings: [], changes: [], takenOut: [], roll: null
    });
    expect(run(GM, req, first.store)).toEqual(refused("ACTION_ID_REUSED"));
  });

  it("keeps only the last actions for retries", () => {
    let store = emptyTraitStore();
    for ( let i = 0; i < COMPLETED_ACTIONS_KEPT + 2; i++ ) {
      store = run(GM, addComplication(`C${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`, null, 6, store.revision), store).value.store;
    }
    expect(store.completedActions).toHaveLength(COMPLETED_ACTIONS_KEPT);
    expect(store.completedActions.at(-1).revision).toBe(COMPLETED_ACTIONS_KEPT + 2);
  });

  it("keeping and opening an asset cost 1 PP each, for its owner", () => {
    let store = run(PLAYER, request("buyAsset", { id: id("Rope"), name: "Rope", holder: holder(ANA) })).value.store;
    const kept = run(PLAYER, request("keepAsset", { traitId: id("Rope") }, 1), store).value;
    expect(kept.store.traits[0].duration).toBe("session");
    expect(kept.payment.line.reason).toBe("ASSET_KEEP_SESSION");
    store = kept.store;
    const other = { ...ACTORS, [ANA]: { ...ACTORS[ANA], ownedBySender: false } };
    expect(run(PLAYER, request("openAsset", { traitId: id("Rope") }, 2), store, other)).toEqual(refused("NOT_YOUR_CHARACTER"));
    expect(run(PLAYER, request("keepAsset", { traitId: id("Rope") }, 2), store)).toEqual(refused("ALREADY_KEPT"));
  });

  it("a GM's asset for a GMC costs nothing; buying one has no bank price (RQ-043) and is a GM's", () => {
    const gmAsset = run(GM, request("addAsset", { id: id("Crossbow"), name: "Crossbow", size: 8, holder: holder(GUARD_1) })).value;
    expect(gmAsset.store.traits[0]).toMatchObject({ dice: [8], origin: "gm" });
    expect(gmAsset.payment).toBeNull();
    expect(gmAsset.warnings).toEqual([]);
    const bought = run(GM, request("buyAsset", { id: id("Net"), name: "Net", holder: holder(GUARD_1) })).value;
    expect(bought.store.traits[0]).toMatchObject({ dice: [6], holder: holder(GUARD_1) });
    expect(bought.payment).toBeNull();
    expect(bought.warnings).toEqual(["BANK_SPEND_NOT_LISTED"]);
    const owned = { ...ACTORS, [GUARD_1]: { ...ACTORS[GUARD_1], ownedBySender: true } };
    expect(run(PLAYER, request("buyAsset", { id: id("Net"), name: "Net", holder: holder(GUARD_1) }), emptyTraitStore(), owned))
      .toEqual(refused("PP_GM_ONLY"));
  });

  it("refusals in check order", () => {
    const store = run(GM, addComplication("Alarm", null)).value.store;
    expect(run(GM, request("remove", { traitId: id("Alarm") }), { ...store, revision: -1 })).toEqual(refused("STORE_INVALID"));
    expect(run(GM, { action: "remove", actionId: "x", revision: 1, payload: {} }, store)).toEqual(refused("MALFORMED_REQUEST"));
    expect(run(GM, request("explode", {}, 1), store)).toEqual(refused("UNSUPPORTED_ACTION"));
    expect(run(GM, request("toString", {}, 1), store)).toEqual(refused("UNSUPPORTED_ACTION"));
    expect(run(PLAYER, request("remove", { traitId: id("Alarm") }, 1), store)).toEqual(refused("GM_ONLY"));
    expect(run(PLAYER, request("keepAsset", { traitId: id("Nothing") }, 1), store)).toEqual(refused("TRAIT_NOT_FOUND"));
    expect(run(PLAYER, request("keepAsset", { traitId: id("Alarm") }, 1), store)).toEqual(refused("NOT_A_CHARACTER_ASSET"));
    expect(run(PLAYER, request("buyAsset", { id: id("Rope"), name: "Rope", holder: { kind: "scene" } }, 1), store))
      .toEqual(refused("NOT_A_CHARACTER_ASSET"));
    expect(run(PLAYER, request("buyAsset", { id: id("Rope"), name: "Rope", holder: holder("Actor.Nobody00000000000") }, 1), store))
      .toEqual(refused("ACTOR_NOT_FOUND"));
    expect(run(GM, request("remove", { traitId: id("Alarm") }, 0), store)).toEqual(refused("STALE_REVISION"));
    expect(run(GM, request("remove", { traitId: id("Nothing") }, 1), store)).toEqual(refused("TRAIT_NOT_FOUND"));
    expect(run(GM, addComplication("Alarm", null, 6, 1), store)).toEqual(refused("DUPLICATE_TRAIT_ID"));
    expect(run(GM, request("step", { traitId: id("Alarm"), steps: 0 }, 1), store)).toEqual(refused("INVALID_INPUT"));
  });

  it("two requests made against the same revision: the second is stale", () => {
    const store = run(GM, addComplication("Alarm", null)).value.store;
    const a = request("step", { traitId: id("Alarm"), steps: 1 }, 1);
    const b = request("step", { traitId: id("Alarm"), steps: 1 }, 1);
    const after = run(GM, a, store).value.store;
    expect(run(GM, b, after)).toEqual(refused("STALE_REVISION"));
  });

  it("End scene: scene traits and scene assets end, boosts reset, complications stay for review", () => {
    let store = run(GM, addComplication("Alarm", null)).value.store;
    store = run(GM, request("addAsset", { id: id("Smoke"), name: "Smoke", size: 6, holder: { kind: "scene" } }, 1), store).value.store;
    store = run(PLAYER, request("buyAsset", { id: id("Rope"), name: "Rope", holder: holder(ANA) }, 2), store).value.store;
    store = { ...store, sceneBoosts: [{ actorId: ANA, traitId: id("Sabre"), steps: 1 }] };
    expect(previewEnd(store, "scene").value).toEqual({
      removedIds: [id("Smoke"), id("Rope")], reviewIds: [id("Alarm")], boostsReset: 1
    });
    const ended = run(GM, request("endScene", {}, 3), store).value;
    expect(ended.store.traits.map(t => t.id)).toEqual([id("Alarm")]);
    expect(ended.store.sceneBoosts).toEqual([]);
    expect(ended.removedIds).toEqual([id("Smoke"), id("Rope")]);
  });

  it("End session also ends assets kept for the session", () => {
    let store = run(PLAYER, request("buyAsset", { id: id("Rope"), name: "Rope", holder: holder(ANA) })).value.store;
    store = run(PLAYER, request("keepAsset", { traitId: id("Rope") }, 1), store).value.store;
    expect(run(GM, request("endScene", {}, 2), store).value.store.traits).toHaveLength(1);
    expect(run(GM, request("endSession", {}, 2), store).value.store.traits).toEqual([]);
  });

  it("the tracker groups characters, the scene, the unassigned and traits whose character is gone", () => {
    let store = run(GM, addComplication("Alarm", null)).value.store;
    store = run(GM, addComplication("Winded", ANA, 6, 1), store).value.store;
    store = run(GM, addComplication("Lost Guard", GUARD_2, 6, 2), store).value.store;
    store = run(GM, request("addAsset", { id: id("Smoke"), name: "Smoke", size: 6, holder: { kind: "scene" } }, 3), store).value.store;
    store = run(GM, request("setNote", { traitId: id("Winded"), note: "Until rest" }, 4), store).value.store;
    const groups = trackerGroups(store, [{ actorKey: ANA, name: "Ana" }]).value;
    expect(groups.characters).toEqual([{ actorKey: ANA, name: "Ana", traits: [expect.objectContaining({ id: id("Winded"), note: "Until rest" })] }]);
    expect(groups.scene.map(t => t.id)).toEqual([id("Smoke")]);
    expect(groups.unassigned.map(t => t.id)).toEqual([id("Alarm")]);
    expect(groups.orphaned.map(t => t.id)).toEqual([id("Lost Guard")]);
  });

  it("a note for a trait that isn't stored makes the store invalid", () => {
    expect(checkTraitStore({ ...emptyTraitStore(), notes: { [id("Ghost")]: "boo" } })).toEqual(refused("STORE_INVALID"));
  });

  it("never changes its inputs", () => {
    const store = run(GM, addComplication("Alarm", null)).value.store;
    const before = JSON.parse(JSON.stringify(store));
    run(GM, request("step", { traitId: id("Alarm"), steps: 2 }, 1), store);
    run(GM, request("setNote", { traitId: id("Alarm"), note: "x" }, 1), store);
    run(GM, request("endScene", {}, 1), store);
    expect(store).toEqual(before);
  });
});

/** A rolled die: a hitch when its result is 1. */
const die = (dieId, size, result, label = "Die") => ({
  id: dieId, size, result, hitch: result === 1, state: "available", origin: "rating", source: { kind: "custom", label }
});
/** What the handler reads from a player's roll card: Ana rolled, the card isn't settled. */
const playerRoll = (rolled, extra = {}) => ({
  rolled, side: "player", hitchesDone: false, settled: false, usedD4Ids: [], payerKey: ANA, senderOwnsCard: false, ...extra
});
const gmRoll = (rolled, extra = {}) => playerRoll(rolled, { side: "gm", payerKey: null, ...extra });
const newTarget = (name, actorId = ANA) => ({ kind: "new", id: id(name), name, holder: holder(actorId) });

describe("hitches and opportunities on the roll card (step 4.8b)", () => {
  it("the GM turns a player's hitch into a d6 complication; the plot point waits on the card", () => {
    const roll = playerRoll([die("d1", 8, 1), die("d2", 6, 5)]);
    const result = run(GM, request("activateHitches", {
      allocations: [{ hitchIds: ["d1"], target: newTarget("Twisted Ankle") }], finish: true
    }), emptyTraitStore(), ACTORS, roll).value;
    expect(result.store.traits).toEqual([expect.objectContaining({
      name: "Twisted Ankle", kind: "complication", dice: [6], origin: "hitch", holder: holder(ANA)
    })]);
    expect(result.roll.rolled.map(d => d.state)).toEqual(["hitch-activated", "available"]);
    expect(result.roll.hitchesDone).toBe(true);
    expect(result.roll.pendingLines).toEqual([{
      reason: "HITCH_COMPLICATION", direction: "gain", amount: 1, label: "Twisted Ankle", sourceId: id("Twisted Ankle"),
      usableThisRoll: false
    }]);
    expect(result.payment).toBeNull();
  });

  it("two hitches step a complication the character has up twice, for one plot point (RQ-045)", () => {
    const store = run(GM, addComplication("Bruised", ANA)).value.store;
    const roll = playerRoll([die("d1", 8, 1), die("d2", 6, 1), die("d3", 10, 7)]);
    const result = run(GM, request("activateHitches", {
      allocations: [{ hitchIds: ["d1", "d2"], target: { kind: "existing", traitId: id("Bruised") } }], finish: false
    }, 1), store, ACTORS, roll).value;
    expect(result.store.traits[0].dice).toEqual([10]);
    expect(result.roll.pendingLines).toHaveLength(1);
    expect(result.roll.hitchesDone).toBe(false);
  });

  it("on a card already settled the hitch's plot point is paid at once", () => {
    const roll = playerRoll([die("d1", 8, 1), die("d2", 6, 4)], { settled: true });
    const result = run(GM, request("activateHitches", {
      allocations: [{ hitchIds: ["d1"], target: newTarget("Lost Footing") }], finish: true
    }), emptyTraitStore(), ACTORS, roll).value;
    expect(result.roll.pendingLines).toEqual([]);
    expect(result.payment).toMatchObject({ account: { kind: "actor", actorKey: ANA }, delta: 1, balance: 3 });
    expect(result.payment.lines).toHaveLength(1);
  });

  it("a botch makes one complication from every die and pays nothing", () => {
    const roll = playerRoll([die("d1", 8, 1), die("d2", 6, 1)]);
    const result = run(GM, request("activateHitches", {
      allocations: [{ hitchIds: ["d1", "d2"], target: newTarget("Disaster") }], finish: true
    }), emptyTraitStore(), ACTORS, roll).value;
    expect(result.store.traits[0]).toMatchObject({ origin: "botch", dice: [8] });
    expect(result.roll.pendingLines).toEqual([]);
    expect(run(GM, request("activateHitches", {
      allocations: [{ hitchIds: ["d1"], target: newTarget("Disaster") }], finish: true
    }), emptyTraitStore(), ACTORS, roll)).toEqual(refused("BOTCH_ONE_COMPLICATION"));
  });

  it("finishing removes the roller's used d4 complication unless a hitch stepped it up (rule 18, RQ-050)", () => {
    const store = run(GM, addComplication("Winded", ANA, 4)).value.store;
    const declined = run(GM, request("activateHitches", { allocations: [], finish: true }, 1), store, ACTORS,
      playerRoll([die("d1", 4, 1)], { usedD4Ids: [id("Winded")] })).value;
    expect(declined.removedIds).toEqual([id("Winded")]);
    expect(declined.store.traits).toEqual([]);
    expect(declined.roll.rolled[0].state).toBe("available");
    const stepped = run(GM, request("activateHitches", {
      allocations: [{ hitchIds: ["d1"], target: { kind: "existing", traitId: id("Winded") } }], finish: true
    }, 1), store, ACTORS, playerRoll([die("d1", 4, 1)], { usedD4Ids: [id("Winded")] })).value;
    expect(stepped.removedIds).toEqual([]);
    expect(stepped.store.traits[0].dice).toEqual([6]);
  });

  it("the card's owner may finish a roll with no hitch to activate; otherwise hitches are the GM's", () => {
    const store = run(GM, addComplication("Winded", ANA, 4)).value.store;
    const finish = request("activateHitches", { allocations: [], finish: true }, 1);
    const noHitch = playerRoll([die("d1", 4, 3)], { usedD4Ids: [id("Winded")], senderOwnsCard: true });
    expect(run(PLAYER, finish, store, ACTORS, noHitch).value.removedIds).toEqual([id("Winded")]);
    const withHitch = playerRoll([die("d1", 4, 1)], { usedD4Ids: [id("Winded")], senderOwnsCard: true });
    expect(run(PLAYER, request("activateHitches", { allocations: [], finish: true }, 1), store, ACTORS, withHitch))
      .toEqual(refused("GM_ONLY"));
    expect(run(PLAYER, request("activateHitches", { allocations: [], finish: true }, 1), store, ACTORS,
      { ...noHitch, senderOwnsCard: false })).toEqual(refused("GM_ONLY"));
  });

  it("finishing the GM's own roll removes its used d4 complication, whatever its opportunities", () => {
    const store = run(GM, addComplication("Limping", GUARD_1, 4)).value.store;
    const roll = gmRoll([die("d1", 4, 1), die("d2", 8, 5)], { usedD4Ids: [id("Limping")], senderOwnsCard: true });
    const done = run(GM, request("activateHitches", { allocations: [], finish: true }, 1), store, ACTORS, roll).value;
    expect(done.removedIds).toEqual([id("Limping")]);
    expect(done.roll.rolled[0].state).toBe("available");
  });

  it("refuses a finished choice, a missing card and the GM's own roll", () => {
    const req = () => request("activateHitches", { allocations: [], finish: true });
    expect(run(GM, req(), emptyTraitStore(), ACTORS, null)).toEqual(refused("ROLL_NOT_FOUND"));
    expect(run(GM, req(), emptyTraitStore(), ACTORS, playerRoll([], { hitchesDone: true }))).toEqual(refused("HITCHES_DONE"));
    expect(run(GM, request("activateHitches", {
      allocations: [{ hitchIds: ["d1"], target: newTarget("Oops", GUARD_1) }], finish: true
    }), emptyTraitStore(), ACTORS, gmRoll([die("d1", 8, 1)]))).toEqual(refused("OPPORTUNITIES_NOT_HITCHES"));
  });

  it("a player uses two opportunities to step a complication down twice, for 1 PP (RQ-046)", () => {
    const store = run(GM, addComplication("Alarm Raised", null, 8)).value.store;
    const roll = gmRoll([die("d1", 8, 1), die("d2", 6, 1), die("d3", 10, 9)]);
    const result = run(PLAYER, request("useOpportunities", {
      actorKey: ANA, uses: [{ opportunityIds: ["d1", "d2"], direction: "down", target: { kind: "temporary", traitId: id("Alarm Raised") } }]
    }, 1), store, ACTORS, roll).value;
    expect(result.store.traits[0].dice).toEqual([4]);
    expect(result.roll.rolled.map(d => d.state)).toEqual(["hitch-activated", "hitch-activated", "available"]);
    expect(result.payment).toMatchObject({ account: { kind: "actor", actorKey: ANA }, delta: -1, balance: 1 });
    expect(result.payment.line.reason).toBe("OPPORTUNITY");
  });

  it("an opportunity steps an asset up for the scene; up on a complication isn't listed (RQ-047)", () => {
    let store = run(PLAYER, request("buyAsset", { id: id("Rope"), name: "Rope", holder: holder(ANA) })).value.store;
    store = run(GM, addComplication("Alarm Raised", null, 8, 1), store).value.store;
    const roll = gmRoll([die("d1", 8, 1)]);
    const up = run(PLAYER, request("useOpportunities", {
      actorKey: ANA, uses: [{ opportunityIds: ["d1"], direction: "up", target: { kind: "temporary", traitId: id("Rope") } }]
    }, 2), store, ACTORS, roll).value;
    expect(up.store.traits.find(t => t.id === id("Rope"))).toMatchObject({ dice: [6], sceneSteps: 1 });
    expect(run(PLAYER, request("useOpportunities", {
      actorKey: ANA, uses: [{ opportunityIds: ["d1"], direction: "up", target: { kind: "temporary", traitId: id("Alarm Raised") } }]
    }, 2), store, ACTORS, roll)).toEqual(refused("OPPORTUNITY_USE_NOT_LISTED"));
  });

  it("opportunities: refusals for the character, the payer, the roll and signature assets", () => {
    const store = run(GM, addComplication("Alarm Raised", null, 8)).value.store;
    const use = (extra = {}) => request("useOpportunities", {
      actorKey: ANA, uses: [{ opportunityIds: ["d1"], direction: "down", target: { kind: "temporary", traitId: id("Alarm Raised") } }],
      ...extra
    }, 1);
    const roll = gmRoll([die("d1", 8, 1)]);
    const notMine = { ...ACTORS, [ANA]: { ...ACTORS[ANA], ownedBySender: false } };
    expect(run(PLAYER, use(), store, notMine, roll)).toEqual(refused("NOT_YOUR_CHARACTER"));
    expect(run(PLAYER, use({ actorKey: undefined }), store, ACTORS, roll)).toEqual(refused("ACTOR_NOT_FOUND"));
    const broke = { ...ACTORS, [ANA]: { ...ACTORS[ANA], balance: 0 } };
    expect(run(PLAYER, use(), store, broke, roll)).toEqual(refused("PP_INSUFFICIENT"));
    expect(run(PLAYER, use(), store, ACTORS, playerRoll([die("d1", 8, 1)]))).toEqual(refused("HITCHES_NOT_OPPORTUNITIES"));
    expect(run(PLAYER, use({ uses: [{ opportunityIds: ["d1"], direction: "up", target: {
      kind: "signature", actorId: ANA, traitId: id("Sword"), label: "Sword", dice: [8]
    } }] }), store, ACTORS, roll)).toEqual(refused("OPPORTUNITY_TARGET_NOT_SUPPORTED"));
    expect(run(PLAYER, use(), store, ACTORS, null)).toEqual(refused("ROLL_NOT_FOUND"));
  });
});

describe("the pool builder's temporary traits (step 4.8b)", () => {
  const build = () => {
    let store = emptyTraitStore();
    const steps = [
      [PLAYER, request("buyAsset", { id: id("Rope"), name: "Rope", holder: holder(ANA) }, 0)],
      [GM, request("addAsset", { id: id("Smoke"), name: "Smoke", size: 8, holder: { kind: "scene" } }, 1)],
      [GM, request("addAsset", { id: id("Crossbow"), name: "Crossbow", size: 8, holder: holder(GUARD_1) }, 2)],
      [GM, addComplication("Winded", ANA, 4, 3)],
      [GM, addComplication("Dust Blinded", GUARD_1, 6, 4)],
      [GM, addComplication("Alarm Raised", null, 8, 5)]
    ];
    for ( const [sender, req] of steps ) store = run(sender, req, store).value.store;
    return store;
  };

  it("offers the roller's traits, the scene's and others' complications, with warnings", () => {
    const choices = poolTraitChoices(build(), ANA).value;
    expect(choices.map(c => [c.group, c.name, c.size])).toEqual([
      ["own", "Rope", 6], ["own", "Winded", 4], ["scene", "Smoke", 8],
      ["complications", "Dust Blinded", 6], ["complications", "Alarm Raised", 8]
    ]);
    expect(choices.find(c => c.name === "Winded")).toMatchObject({ d4Gain: true, warnings: [] });
    expect(choices.find(c => c.name === "Rope").source).toEqual({ kind: "asset", traitId: id("Rope"), label: "Rope", actorId: ANA });
  });

  it("from the guard's side: Ana's d4 complication goes to her, the guard's own complication warns", () => {
    const choices = poolTraitChoices(build(), GUARD_1).value;
    expect(choices.map(c => c.name)).toEqual(["Crossbow", "Dust Blinded", "Smoke", "Winded", "Alarm Raised"]);
    expect(choices.find(c => c.name === "Dust Blinded").warnings).toEqual(["OWN_COMPLICATION"]);
    expect(choices.find(c => c.name === "Winded")).toMatchObject({ warnings: ["D4_COMPLICATION_GOES_TO_HOLDER"], d4Gain: false });
  });

  it("finds the roller's own d4 complications in a rolled pool", () => {
    const d = (size, source) => ({ size, source });
    const pool = [
      d(4, { kind: "complication", traitId: id("Winded"), actorId: ANA, label: "Winded" }),
      d(4, { kind: "complication", traitId: id("Winded"), actorId: ANA, label: "Winded" }),
      d(4, { kind: "complication", traitId: id("Other"), actorId: GUARD_1, label: "Other" }),
      d(6, { kind: "complication", traitId: id("Bruised"), actorId: ANA, label: "Bruised" }),
      d(4, { kind: "trait", traitId: "x", actorId: ANA, label: "Brave" })
    ];
    expect(usedD4ComplicationIds(pool, ANA)).toEqual([id("Winded")]);
    expect(usedD4ComplicationIds(pool, null)).toEqual([]);
  });
});
