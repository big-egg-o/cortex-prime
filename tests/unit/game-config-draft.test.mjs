import { describe, expect, it } from "vitest";
import {
  addActorKind, addTraitDef, addTraitSet, applyConfigForm, deleteActorKind, deleteTraitDef, deleteTraitSet,
  errorsByPath, moveTraitDef, moveTraitSet, newTraitSet
} from "../../module/config/game-config-draft.mjs";
import { defaultGameConfig, traitSetById, validateGameConfig } from "../../module/rules/game-config.mjs";

const NEW_SET = "newSet0000000001";
const SKILLS = "cpSetSkills00000";
const ATTRIBUTES = "cpSetAttributes0";
const DISTINCTIONS = "cpSetDistinction";
const PC = "cpKindPlayerChar";

/** @returns {object} the object, frozen all the way down */
function deepFreeze(value) {
  if ( value && (typeof value === "object") ) {
    for ( const inner of Object.values(value) ) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

describe("draft editing", () => {
  it("adds a new open set that, named, keeps the configuration valid", () => {
    const draft = addTraitSet(deepFreeze(defaultGameConfig()), NEW_SET, "Powers");
    expect(draft.traitSets.at(-1)).toEqual(newTraitSet(NEW_SET, "Powers"));
    expect(draft.traitSets.at(-1)).toMatchObject({ role: "other", list: "open", hasDice: true, extraTraits: "pp" });
    expect(draft.traitSets.at(-1).features.shutDown).toBe(true);
    expect(validateGameConfig(draft).ok).toBe(true);
  });

  it("deletes a set and takes it out of every kind", () => {
    const draft = deleteTraitSet(deepFreeze(defaultGameConfig()), SKILLS);
    expect(traitSetById(draft, SKILLS)).toBeNull();
    expect(draft.actorKinds.find(k => k.id === PC).traitSetIds).not.toContain(SKILLS);
  });

  it("moves a set up and down within the list, and leaves an unknown id alone", () => {
    const config = deepFreeze(defaultGameConfig());
    expect(moveTraitSet(config, SKILLS, -1).traitSets.map(s => s.id).slice(0, 3)).toEqual([DISTINCTIONS, SKILLS, ATTRIBUTES]);
    expect(moveTraitSet(config, DISTINCTIONS, -1).traitSets.map(s => s.id)).toEqual(config.traitSets.map(s => s.id));
    expect(moveTraitSet(config, "unknown000000000", 1)).toEqual(config);
  });

  it("adds, moves and deletes definitions in a fixed set only", () => {
    const config = deepFreeze(defaultGameConfig());
    const added = addTraitDef(config, ATTRIBUTES, "cpAttrLuck000000", "Luck");
    expect(traitSetById(added, ATTRIBUTES).traits.at(-1)).toEqual({ id: "cpAttrLuck000000", name: "Luck" });
    expect(addTraitDef(config, DISTINCTIONS, "x000000000000000", "X")).toEqual(config);
    const movedUp = moveTraitDef(added, ATTRIBUTES, "cpAttrLuck000000", -10);
    expect(traitSetById(movedUp, ATTRIBUTES).traits[0].id).toBe("cpAttrLuck000000");
    const deleted = deleteTraitDef(added, ATTRIBUTES, "cpAttrLuck000000");
    expect(traitSetById(deleted, ATTRIBUTES).traits).toEqual(traitSetById(config, ATTRIBUTES).traits);
  });

  it("adds and deletes actor kinds", () => {
    const config = deepFreeze(defaultGameConfig());
    const added = addActorKind(config, "kindBoss00000001", "Boss");
    expect(added.actorKinds.at(-1)).toEqual({ id: "kindBoss00000001", name: "Boss", traitSetIds: [], freeTraits: false });
    expect(deleteActorKind(added, "kindBoss00000001")).toEqual(config);
  });
});

describe("applyConfigForm", () => {
  it("reads set fields, features and guidance by position, with die sizes from form strings", () => {
    const config = deepFreeze(defaultGameConfig());
    const draft = applyConfigForm(config, {
      traitSets: {
        1: {
          name: "Approaches", hasDice: true, multiDice: true, usualMin: "", usualMax: "12", startingRating: "6",
          fallbackDie: "", extraTraits: "none", features: { sfx: true, hinder: false }
        }
      }
    });
    expect(draft.traitSets[1]).toMatchObject({
      id: ATTRIBUTES, name: "Approaches", multiDice: true, usualMin: null, usualMax: 12, startingRating: 6,
      fallbackDie: null, extraTraits: "none"
    });
    expect(draft.traitSets[1].features).toMatchObject({ sfx: true, hinder: false, shutDown: true });
    expect(draft.traitSets[0]).toEqual(config.traitSets[0]);
  });

  it("keeps an invalid die size as given, for validateGameConfig to report", () => {
    const draft = applyConfigForm(defaultGameConfig(), { traitSets: { 1: { usualMin: "7" } } });
    expect(draft.traitSets[1].usualMin).toBe("7");
    expect(validateGameConfig(draft).errors).toContainEqual({ code: "INVALID_TRAIT_SET", path: "traitSets.1.usualMin" });
  });

  it("never takes ids, order or membership from the form", () => {
    const config = defaultGameConfig();
    const draft = applyConfigForm(config, { traitSets: { 0: { id: "hacked0000000000", traits: { 0: { id: "x" } } } } });
    expect(draft.traitSets[0].id).toBe(DISTINCTIONS);
    expect(draft.traitSets.length).toBe(config.traitSets.length);
  });

  it("reads definition names and descriptions, and drops an empty description", () => {
    const config = defaultGameConfig();
    config.traitSets[1].traits[0].description = "old";
    const draft = applyConfigForm(config, { traitSets: { 1: { traits: [{ name: "Body", description: "  " }, { name: "Mind", description: "New" }] } } });
    expect(draft.traitSets[1].traits.slice(0, 2)).toEqual([
      { id: "cpAttrPhysical00", name: "Body" }, { id: "cpAttrMental0000", name: "Mind", description: "New" }
    ]);
  });

  it("reads a kind's sets from one checkbox per set, in the configuration's set order", () => {
    const config = defaultGameConfig();
    const draft = applyConfigForm(config, {
      actorKinds: { 0: { name: "Hero", freeTraits: true, sets: { [SKILLS]: false, cpSetSceneDistin: true } } }
    });
    expect(draft.actorKinds[0]).toEqual({
      id: PC, name: "Hero", freeTraits: true, traitSetIds: [DISTINCTIONS, ATTRIBUTES, "cpSetSceneDistin"]
    });
  });

  it("keeps a set switched from fixed to open with its definitions, which validation then reports", () => {
    const draft = applyConfigForm(defaultGameConfig(), { traitSets: { 1: { list: "open" } } });
    expect(draft.traitSets[1].traits).toHaveLength(3);
    expect(validateGameConfig(draft).errors).toContainEqual({ code: "INVALID_TRAIT_SET", path: "traitSets.1.traits" });
  });

  it("ignores values of the wrong type and a form that isn't an object", () => {
    const config = deepFreeze(defaultGameConfig());
    expect(applyConfigForm(config, { traitSets: { 0: { name: 5, hasDice: "on", features: { sfx: "yes" } } } })).toEqual(config);
    expect(applyConfigForm(config, null)).toEqual(config);
  });
});

describe("errorsByPath", () => {
  it("groups codes by their field's path", () => {
    expect(errorsByPath([
      { code: "INVALID_DIE_SIZE", path: "traitSets.1.usualMin" },
      { code: "INVALID_TRAIT_SET", path: "traitSets.1.usualMin" },
      { code: "PRIME_SETS_TOO_FEW", path: "traitSets" }
    ])).toEqual({ "traitSets.1.usualMin": ["INVALID_DIE_SIZE", "INVALID_TRAIT_SET"], traitSets: ["PRIME_SETS_TOO_FEW"] });
    expect(errorsByPath(undefined)).toEqual({});
  });
});
