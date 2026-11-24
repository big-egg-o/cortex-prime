import { describe, expect, it } from "vitest";
import {
  COMPLETED_ACTIONS_KEPT, MAX_NOTE_LENGTH, TRAIT_STORE_ACTIONS, checkTraitStore, dispatchTraitStoreRequest,
  emptyTraitStore, previewEnd, trackerGroups
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
const run = (sender, req, store = emptyTraitStore(), actors = ACTORS, bank = 3) => dispatchTraitStoreRequest({
  sender, request: req, store, actors, bank
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
    expect(result.payment).toEqual({
      account: { kind: "actor", actorKey: ANA }, delta: -1, balance: 1,
      line: { reason: "ASSET_CREATE", direction: "spend", amount: 1, label: "Rope", sourceId: id("Rope") }
    });
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
    expect(again).toEqual({ store: first.store, payment: null, removedIds: [], replayed: true });
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

  it("a GM's asset for a GMC costs nothing; a GMC's bought asset is paid from the bank by a GM only", () => {
    const gmAsset = run(GM, request("addAsset", { id: id("Crossbow"), name: "Crossbow", size: 8, holder: holder(GUARD_1) })).value;
    expect(gmAsset.store.traits[0]).toMatchObject({ dice: [8], origin: "gm" });
    expect(gmAsset.payment).toBeNull();
    const bought = run(GM, request("buyAsset", { id: id("Net"), name: "Net", holder: holder(GUARD_1) })).value;
    expect(bought.payment).toMatchObject({ account: { kind: "bank" }, delta: -1, balance: 2 });
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
