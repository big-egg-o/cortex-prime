import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "../../module/rules/game-config.mjs";
import {
  checkCharacterEdit, checkCharacterUpdate, diffCharacterTraits, proposedTraitData, validateTraitChanges
} from "../../module/rules/traits.mjs";

// Ids from the defaults (ADR-036).
const DISTINCTIONS = "cpSetDistinction";
const ATTRIBUTES = "cpSetAttributes0";
const SKILLS = "cpSetSkills00000";
const SCENE = "cpSetSceneDistin";
const PHYSICAL = "cpAttrPhysical00";
const FIGHT = "cpSkillFight0000";
const PC = "cpKindPlayerChar";
const LOCATION = "cpKindLocation00";

// Entry ids, 16 letters or digits.
const E1 = "entry00000000001";
const E2 = "entry00000000002";
const E3 = "entry00000000003";
const E4 = "entry00000000004";

/** A PC with a distinction, Physical d8 and Fight d6. */
function pc() {
  return {
    kindId: PC,
    traits: {
      [DISTINCTIONS]: { entries: [{ id: E1, defId: null, name: "Seasoned Smuggler", dice: [8] }] },
      [ATTRIBUTES]: { entries: [{ id: E2, defId: PHYSICAL, name: "Physical", dice: [8] }] },
      [SKILLS]: { entries: [{ id: E3, defId: FIGHT, name: "Fight", dice: [6] }] }
    },
    freeTraits: []
  };
}

/** @returns {object} a deep copy of the PC with changes applied by the callback */
function edited(edit, base = pc()) {
  const copy = structuredClone(base);
  edit(copy);
  return copy;
}

/** Validates an edit from the PC to what the callback makes of it. */
function check(edit, config = defaultGameConfig(), base = pc()) {
  return checkCharacterEdit(base, edited(edit, base), config);
}

const refused = code => ({ ok: false, code });

describe("validateTraitChanges (ADR-037 point 2)", () => {
  it("accepts an edit that changes nothing it checks", () => {
    expect(check(() => {})).toMatchObject({ ok: true });
    expect(check(c => { c.traits[SKILLS].entries[0].name = "Brawl"; })).toMatchObject({ ok: true });
  });

  it("TS-E01 refuses a changed rating with a die size that doesn't exist", () => {
    expect(check(c => { c.traits[SKILLS].entries[0].dice = [7]; })).toEqual(refused("INVALID_DIE_SIZE"));
    expect(check(c => { c.traits[SKILLS].entries[0].dice = [14]; })).toEqual(refused("INVALID_DIE_SIZE"));
    expect(check(c => { c.freeTraits.push({ id: E4, name: "Big Shotgun", dice: [8, 7] }); }))
      .toEqual(refused("INVALID_DIE_SIZE"));
  });

  it("TS-E02 refuses mixed sizes where the set needs dice of one size", () => {
    const config = defaultGameConfig();
    Object.assign(config.traitSets.find(s => s.id === SCENE), { sameSizeDice: true });
    const location = { kindId: LOCATION, traits: { [SCENE]: { entries: [] } }, freeTraits: [] };
    const result = checkCharacterEdit(location, edited(c => {
      c.traits[SCENE].entries.push({ id: E4, defId: null, name: "Panicked Crowd", dice: [6, 8] });
    }, location), config);
    expect(result).toEqual(refused("RATING_MIXED_SIZES"));
  });

  it("TS-07 stores [6, 6] in the scene distinctions set, which allows several dice", () => {
    const location = {
      kindId: LOCATION,
      traits: { [SCENE]: { entries: [{ id: E4, defId: null, name: "Panicked Crowd", dice: [8] }] } },
      freeTraits: []
    };
    const result = checkCharacterEdit(location, edited(c => { c.traits[SCENE].entries[0].dice = [6, 6]; }, location),
      defaultGameConfig());
    expect(result.ok).toBe(true);
  });

  it("refuses a second die in a set that allows one die per trait", () => {
    expect(check(c => { c.traits[DISTINCTIONS].entries[0].dice = [6, 6]; })).toEqual(refused("RATING_TOO_MANY_DICE"));
  });

  it("refuses any die in a set without dice", () => {
    const config = defaultGameConfig();
    config.traitSets.find(s => s.id === DISTINCTIONS).hasDice = false;
    config.traitSets.find(s => s.id === DISTINCTIONS).startingRating = null;
    expect(check(c => { c.traits[DISTINCTIONS].entries.push({ id: E4, defId: null, name: "Talent", dice: [6] }); }, config))
      .toEqual(refused("RATING_DICE_NOT_ALLOWED"));
  });

  it("accepts an empty rating whatever the set's shape (ADR-037, Q1)", () => {
    expect(check(c => { c.traits[SKILLS].entries[0].dice = []; })).toMatchObject({ ok: true });
    expect(check(c => { c.traits[DISTINCTIONS].entries.push({ id: E4, defId: null, name: "New", dice: [] }); }))
      .toMatchObject({ ok: true });
    const config = defaultGameConfig();
    Object.assign(config.traitSets.find(s => s.id === DISTINCTIONS), { hasDice: false });
    expect(check(c => { c.traits[DISTINCTIONS].entries.push({ id: E4, defId: null, name: "Talent", dice: [] }); }, config))
      .toMatchObject({ ok: true });
  });

  it("refuses a new kind that the configuration doesn't have", () => {
    expect(check(c => { c.kindId = "noSuchKind000000"; })).toEqual(refused("UNKNOWN_ACTOR_KIND"));
  });

  it("ADR-037 point 1: a stored kind the configuration no longer has doesn't stop an unrelated edit", () => {
    const base = edited(c => { c.kindId = "removedKind00000"; });
    expect(check(c => { c.traits[SKILLS].entries[0].dice = [8]; }, defaultGameConfig(), base)).toMatchObject({ ok: true });
  });

  it("accepts a kind cleared to none and a change to another kind", () => {
    expect(check(c => { c.kindId = null; })).toMatchObject({ ok: true });
    expect(check(c => { c.kindId = LOCATION; })).toMatchObject({ ok: true });
  });

  it("refuses a set the configuration doesn't have, when the edit adds it", () => {
    expect(check(c => { c.traits.noSuchSet0000000 = { entries: [] }; })).toEqual(refused("UNKNOWN_TRAIT_SET"));
  });

  it("accepts a set the configuration has but the actor's kind doesn't use (a hint, not a refusal)", () => {
    expect(check(c => { c.traits[SCENE] = { entries: [] }; })).toMatchObject({ ok: true });
  });

  it("refuses a definition that its fixed set doesn't have", () => {
    expect(check(c => { c.traits[SKILLS].entries[0].defId = "noSuchSkill00000"; }))
      .toEqual(refused("UNKNOWN_TRAIT_DEFINITION"));
    expect(check(c => { c.traits[SKILLS].entries.push({ id: E4, defId: PHYSICAL, name: "Physical", dice: [6] }); }))
      .toEqual(refused("UNKNOWN_TRAIT_DEFINITION"));
  });

  it("refuses a definition id in an open set, which has no definitions (ADR-034)", () => {
    expect(check(c => { c.traits[DISTINCTIONS].entries.push({ id: E4, defId: FIGHT, name: "Fight", dice: [8] }); }))
      .toEqual(refused("UNKNOWN_TRAIT_DEFINITION"));
  });

  it("accepts a definition id cleared to none", () => {
    expect(check(c => { c.traits[SKILLS].entries[0].defId = null; })).toMatchObject({ ok: true });
  });

  it("checks ratings before references, and references in the ADR-037 order", () => {
    // a bad rating and a bad kind: the rating comes first
    expect(check(c => { c.kindId = "noSuchKind000000"; c.traits[SKILLS].entries[0].dice = [7]; }))
      .toEqual(refused("INVALID_DIE_SIZE"));
    // a shape problem and an unknown set: the shape problem comes first
    expect(check(c => {
      c.traits.noSuchSet0000000 = { entries: [] };
      c.traits[DISTINCTIONS].entries[0].dice = [6, 6];
    })).toEqual(refused("RATING_TOO_MANY_DICE"));
    // kind, then set, then definition
    expect(check(c => {
      c.traits[SKILLS].entries[0].defId = "noSuchSkill00000";
      c.traits.noSuchSet0000000 = { entries: [] };
      c.kindId = "noSuchKind000000";
    })).toEqual(refused("UNKNOWN_ACTOR_KIND"));
    expect(check(c => {
      c.traits[SKILLS].entries[0].defId = "noSuchSkill00000";
      c.traits.noSuchSet0000000 = { entries: [] };
    })).toEqual(refused("UNKNOWN_TRAIT_SET"));
  });

  it("reports a die size that doesn't exist in any changed rating before any rating's shape", () => {
    expect(check(c => {
      c.traits[DISTINCTIONS].entries[0].dice = [6, 6];
      c.traits[SKILLS].entries[0].dice = [7];
    })).toEqual(refused("INVALID_DIE_SIZE"));
  });

  it("checks the shapes in proposed order and reports the first", () => {
    const config = defaultGameConfig();
    config.traitSets.find(s => s.id === SKILLS).hasDice = false;
    expect(check(c => {
      c.traits[DISTINCTIONS].entries[0].dice = [6, 6];
      c.traits[SKILLS].entries[0].dice = [8];
    }, config)).toEqual(refused("RATING_TOO_MANY_DICE"));
  });

  it("ADR-037 point 5: an unrelated edit goes through on an actor holding a conflicting rating", () => {
    // stored before the GM made distinctions one die each: [6, 6] conflicts, but isn't checked again
    const base = edited(c => { c.traits[DISTINCTIONS].entries[0].dice = [6, 6]; });
    expect(check(c => { c.traits[SKILLS].entries[0].dice = [8]; }, defaultGameConfig(), base)).toMatchObject({ ok: true });
    expect(check(c => { c.traits[DISTINCTIONS].entries[0].name = "Renamed"; }, defaultGameConfig(), base))
      .toMatchObject({ ok: true });
    // the next edit of that rating must pass
    expect(check(c => { c.traits[DISTINCTIONS].entries[0].dice = [6, 6, 6]; }, defaultGameConfig(), base))
      .toEqual(refused("RATING_TOO_MANY_DICE"));
  });

  it("TS-E03 keeps an orphaned value: an edit elsewhere, or of its dice, needs no definition check", () => {
    const config = defaultGameConfig();
    const skills = config.traitSets.find(s => s.id === SKILLS);
    skills.traits = skills.traits.filter(t => t.id !== FIGHT); // the GM deletes Fight
    expect(check(c => { c.traits[ATTRIBUTES].entries[0].dice = [10]; }, config)).toMatchObject({ ok: true });
    expect(check(c => { c.traits[SKILLS].entries[0].dice = [8]; }, config)).toMatchObject({ ok: true });
  });

  it("TS-E04 a renamed definition keeps its id, so the actor's value needs no check", () => {
    const config = defaultGameConfig();
    config.traitSets.find(s => s.id === SKILLS).traits.find(t => t.id === FIGHT).name = "Brawl";
    expect(check(() => {}, config)).toMatchObject({ ok: true });
    expect(check(c => { c.traits[SKILLS].entries[0].dice = [8]; }, config)).toMatchObject({ ok: true });
  });

  it("refuses an entry added to, or moved into, a set the configuration no longer has (ADR-029 point 2)", () => {
    const base = edited(c => { c.traits.removedSet000000 = { entries: [{ id: E4, defId: null, name: "Old", dice: [8] }] }; });
    expect(check(c => { c.traits.removedSet000000.entries.push({ id: E1.replace("1", "9"), defId: null, name: "New", dice: [6] }); },
      defaultGameConfig(), base)).toEqual(refused("UNKNOWN_TRAIT_SET"));
    expect(check(c => {
      const [fight] = c.traits[SKILLS].entries.splice(0, 1);
      c.traits.removedSet000000.entries.push(fight);
    }, defaultGameConfig(), base)).toEqual(refused("UNKNOWN_TRAIT_SET"));
  });

  it("checks entries of a set the configuration no longer has against die sizes only", () => {
    const base = edited(c => { c.traits.removedSet000000 = { entries: [{ id: E4, defId: "goneDef000000000", name: "Old", dice: [8] }] }; });
    expect(check(c => { c.traits.removedSet000000.entries[0].dice = [6, 8]; }, defaultGameConfig(), base))
      .toMatchObject({ ok: true });
    expect(check(c => { c.traits.removedSet000000.entries[0].defId = "otherDef00000000"; }, defaultGameConfig(), base))
      .toMatchObject({ ok: true });
    expect(check(c => { c.traits.removedSet000000.entries[0].dice = [7]; }, defaultGameConfig(), base))
      .toEqual(refused("INVALID_DIE_SIZE"));
  });

  it("checks free traits against die sizes only (TS-22)", () => {
    expect(check(c => { c.freeTraits.push({ id: E4, name: "Mob", dice: [6, 6, 8] }); })).toMatchObject({ ok: true });
  });

  it("checks an entry moved into another set against that set", () => {
    expect(check(c => {
      const [fight] = c.traits[SKILLS].entries.splice(0, 1);
      c.traits[DISTINCTIONS].entries.push({ ...fight, defId: null, dice: [6, 6] });
    })).toEqual(refused("RATING_TOO_MANY_DICE"));
  });

  it("doesn't count an entry as checked when nothing about it could be checked", () => {
    const base = edited(c => { c.traits.removedSet000000 = { entries: [{ id: E4, defId: "goneDef000000000", name: "Old", dice: [8] }] }; });
    const diff = diffCharacterTraits(base, edited(c => { c.traits.removedSet000000.entries[0].defId = "otherDef00000000"; }, base)).value;
    expect(validateTraitChanges(diff, defaultGameConfig())).toEqual({ ok: true, value: { checkedEntryIds: [] } });
  });

  it("returns the ids of the entries it checked", () => {
    const result = check(c => {
      c.traits[SKILLS].entries[0].dice = [8];
      c.freeTraits.push({ id: E4, name: "Free", dice: [4] });
    });
    expect(result.ok).toBe(true);
    const diff = diffCharacterTraits(pc(), edited(c => {
      c.traits[SKILLS].entries[0].dice = [8];
      c.freeTraits.push({ id: E4, name: "Free", dice: [4] });
    })).value;
    expect(validateTraitChanges(diff, defaultGameConfig())).toEqual({ ok: true, value: { checkedEntryIds: [E3, E4] } });
  });

  it("refuses changes that aren't shaped like a diff, and a configuration without lists", () => {
    expect(validateTraitChanges(null, defaultGameConfig())).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(validateTraitChanges({ entries: "x" }, defaultGameConfig())).toEqual(refused("INVALID_TRAIT_DATA"));
    const good = diffCharacterTraits(pc(), edited(c => { c.traits[SKILLS].entries[0].dice = [8]; })).value;
    for ( const broken of [
      { ...good, entries: "x" },
      { ...good, addedSetIds: [5] },
      { ...good, kindId: 5 },
      { ...good, entries: [{ ...good.entries[0], dice: "8" }] },
      { ...good, entries: [{ ...good.entries[0], setId: undefined }] },
      { ...good, entries: [{ ...good.entries[0], defId: 7 }] },
      { ...good, entries: [{ ...good.entries[0], entered: "no" }] },
      { ...good, entries: [{ ...good.entries[0], diceChanged: 1 }] }
    ] ) expect(validateTraitChanges(broken, defaultGameConfig())).toEqual(refused("INVALID_TRAIT_DATA"));
    const diff = diffCharacterTraits(pc(), pc()).value;
    expect(validateTraitChanges(diff, null)).toEqual(refused("INVALID_GAME_CONFIG"));
    expect(validateTraitChanges(diff, { traitSets: [] })).toEqual(refused("INVALID_GAME_CONFIG"));
  });

  it("works from frozen inputs", () => {
    const diff = deepFreeze(diffCharacterTraits(pc(), edited(c => { c.traits[SKILLS].entries[0].dice = [8]; })).value);
    expect(validateTraitChanges(diff, deepFreeze(defaultGameConfig())).ok).toBe(true);
  });
});

describe("checkCharacterEdit", () => {
  it("passes on the diff's refusals first", () => {
    expect(check(c => { c.traits[SKILLS].entries.push({ ...c.traits[SKILLS].entries[0] }); }))
      .toEqual(refused("DUPLICATE_TRAIT_ID"));
    expect(checkCharacterEdit(pc(), { kindId: PC }, defaultGameConfig())).toEqual(refused("INVALID_TRAIT_DATA"));
  });

  it("returns the diff when the edit passes", () => {
    const proposed = edited(c => { c.traits[SKILLS].entries[0].dice = [8]; });
    expect(checkCharacterEdit(pc(), proposed, defaultGameConfig())).toEqual(diffCharacterTraits(pc(), proposed));
  });
});

/** Stand-ins for Foundry's ForcedDeletion and ForcedReplacement operators. */
class Deletion {}
class Replacement { constructor(value) { this.value = value; } }
const OPERATORS = {
  operatorOf(value) {
    if ( value instanceof Deletion ) return { deletion: true };
    if ( value instanceof Replacement ) return { replacement: value.value };
    return null;
  }
};

describe("proposedTraitData (an update applied to the stored data)", () => {
  it("returns a copy of the stored data when the update has no system changes", () => {
    for ( const changes of [undefined, null, {}] ) {
      const result = proposedTraitData(pc(), changes);
      expect(result).toEqual({ ok: true, value: pc() });
    }
    const base = pc();
    const value = proposedTraitData(base, {}).value;
    expect(value.traits).not.toBe(base.traits);
    expect(value.traits[SKILLS].entries[0].dice).not.toBe(base.traits[SKILLS].entries[0].dice);
  });

  it("replaces a set's whole entries list and keeps the other sets (ADR-037 point 3)", () => {
    const entries = [{ id: E3, defId: FIGHT, name: "Fight", dice: [8] }];
    const value = proposedTraitData(pc(), { traits: { [SKILLS]: { entries } } }).value;
    expect(value).toEqual(edited(c => { c.traits[SKILLS].entries = entries; }));
  });

  it("adds a set key the stored data doesn't have, with an empty list when none is given", () => {
    const value = proposedTraitData(pc(), { traits: { [SCENE]: {} } }).value;
    expect(value.traits[SCENE]).toEqual({ entries: [] });
    expect(Object.keys(value.traits)).toEqual([DISTINCTIONS, ATTRIBUTES, SKILLS, SCENE]);
  });

  it("replaces the kind and the free traits", () => {
    const freeTraits = [{ id: E4, name: "Corrupt Lawman", dice: [8] }];
    const value = proposedTraitData(pc(), { kindId: LOCATION, freeTraits }).value;
    expect(value).toEqual(edited(c => { c.kindId = LOCATION; c.freeTraits = freeTraits; }));
  });

  it("reads dotted keys as nested ones", () => {
    const entries = [{ id: E3, defId: FIGHT, name: "Fight", dice: [10] }];
    expect(proposedTraitData(pc(), { [`traits.${SKILLS}.entries`]: entries }).value)
      .toEqual(edited(c => { c.traits[SKILLS].entries = entries; }));
    expect(proposedTraitData(pc(), { traits: { [`${SKILLS}.entries`]: entries } }).value)
      .toEqual(edited(c => { c.traits[SKILLS].entries = entries; }));
  });

  it("removes a set whose key is deleted, as Foundry's typed object field does", () => {
    const value = proposedTraitData(pc(), { traits: { [SKILLS]: new Deletion() } }, OPERATORS).value;
    expect(value).toEqual(edited(c => { delete c.traits[SKILLS]; }));
  });

  it("replaces without merging where a forced replacement is given", () => {
    const traits = { [SCENE]: { entries: [] } };
    expect(proposedTraitData(pc(), { traits: new Replacement(traits) }, OPERATORS).value)
      .toEqual(edited(c => { c.traits = traits; }));
    expect(proposedTraitData(pc(), { traits: { [SKILLS]: new Replacement({ entries: [] }) } }, OPERATORS).value)
      .toEqual(edited(c => { c.traits[SKILLS] = { entries: [] }; }));
  });

  it("leaves a field undefined where a forced deletion is given to it, which the diff then refuses", () => {
    const value = proposedTraitData(pc(), { kindId: new Deletion() }, OPERATORS).value;
    expect(value.kindId).toBeUndefined();
    expect(diffCharacterTraits(pc(), value)).toEqual(refused("INVALID_TRAIT_DATA"));
  });

  it("treats an operator as a plain value when no operator reader is given", () => {
    const value = proposedTraitData(pc(), { kindId: new Deletion() }).value;
    expect(value.kindId).toBeInstanceOf(Deletion);
  });

  it("keeps a value that isn't a plain object as given, for the diff to refuse", () => {
    expect(proposedTraitData(pc(), { traits: [] }).value.traits).toEqual([]);
    expect(proposedTraitData(pc(), { traits: { [SKILLS]: null } }).value.traits[SKILLS]).toBeNull();
  });

  it("refuses system changes that aren't a plain object, and stored data that isn't one", () => {
    expect(proposedTraitData(pc(), [])).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(proposedTraitData(pc(), "traits")).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(proposedTraitData(null, {})).toEqual(refused("INVALID_TRAIT_DATA"));
  });

  it("leaves traits, free traits or a set's entries undefined when forcibly deleted, for the diff to refuse", () => {
    for ( const changes of [
      { traits: new Deletion() }, { freeTraits: new Deletion() }, { traits: { [SKILLS]: { entries: new Deletion() } } }
    ] ) {
      const value = proposedTraitData(pc(), changes, OPERATORS).value;
      expect(diffCharacterTraits(pc(), value)).toEqual(refused("INVALID_TRAIT_DATA"));
    }
  });

  it("replaces a set's entries, the free traits and the kind with a forced replacement's value", () => {
    const entries = [{ id: E3, defId: FIGHT, name: "Fight", dice: [10] }];
    const freeTraits = [{ id: E4, name: "Free", dice: [6] }];
    const value = proposedTraitData(pc(), {
      kindId: new Replacement(LOCATION), freeTraits: new Replacement(freeTraits),
      traits: { [SKILLS]: { entries: new Replacement(entries) } }
    }, OPERATORS).value;
    expect(value).toEqual(edited(c => { c.kindId = LOCATION; c.freeTraits = freeTraits; c.traits[SKILLS].entries = entries; }));
    expect(value.freeTraits).not.toBe(freeTraits);
  });

  it("applies the operators inside a forced replacement's value, as Foundry does", () => {
    const traits = { [SCENE]: { entries: [] }, [SKILLS]: new Deletion() };
    expect(proposedTraitData(pc(), { traits: new Replacement(traits) }, OPERATORS).value.traits).toEqual({ [SCENE]: { entries: [] } });
  });

  it("treats a forced replacement of the whole system data as a replacing update (ADR-037 point 4)", () => {
    const replacement = edited(c => { c.traits[SKILLS].entries[0].dice = [7]; });
    const result = proposedTraitData(pc(), new Replacement(replacement), OPERATORS);
    expect(result).toEqual({ ok: true, value: { ...replacement, replaced: true } });
    expect(proposedTraitData(pc(), new Deletion(), OPERATORS)).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(proposedTraitData(pc(), new Replacement(5), OPERATORS)).toEqual(refused("INVALID_TRAIT_DATA"));
  });

  it("keeps entries given as an object instead of a list, for the diff to refuse", () => {
    const value = proposedTraitData(pc(), { traits: { [SKILLS]: { entries: { 0: { id: E3, dice: [8] } } } } }).value;
    expect(value.traits[SKILLS].entries).toEqual({ 0: { id: E3, dice: [8] } });
    expect(diffCharacterTraits(pc(), value)).toEqual(refused("INVALID_TRAIT_DATA"));
  });

  it("starts from no sets when the stored traits aren't an object", () => {
    const base = { ...pc(), traits: null };
    expect(proposedTraitData(base, { traits: { [SKILLS]: { entries: [] } } }).value.traits).toEqual({ [SKILLS]: { entries: [] } });
  });

  it("copies the arrays it takes from the changes", () => {
    const entries = [{ id: E3, defId: FIGHT, name: "Fight", dice: [8] }];
    const value = proposedTraitData(pc(), { traits: { [SKILLS]: { entries } } }).value;
    expect(value.traits[SKILLS].entries).not.toBe(entries);
    expect(value.traits[SKILLS].entries[0].dice).not.toBe(entries[0].dice);
  });

  it("works without an operator reader, even when given null", () => {
    expect(proposedTraitData(pc(), {}, null).ok).toBe(true);
  });

  it("ignores fields outside the trait data", () => {
    const value = proposedTraitData(pc(), { schemaVersion: 2, plotPoints: 3 }).value;
    expect(value).toEqual(pc());
  });

  it("never changes its inputs", () => {
    const base = deepFreeze(pc());
    const changes = deepFreeze({ traits: { [SKILLS]: { entries: [{ id: E3, defId: FIGHT, name: "Fight", dice: [8] }] } } });
    expect(proposedTraitData(base, changes).ok).toBe(true);
  });
});

describe("checkCharacterUpdate", () => {
  it("checks the complete state an update would leave", () => {
    const config = defaultGameConfig();
    const update = { traits: { [SKILLS]: { entries: [{ id: E3, defId: FIGHT, name: "Fight", dice: [7] }] } } };
    expect(checkCharacterUpdate(pc(), update, config)).toEqual(refused("INVALID_DIE_SIZE"));
    const ok = { traits: { [SKILLS]: { entries: [{ id: E3, defId: FIGHT, name: "Fight", dice: [8] }] } } };
    expect(checkCharacterUpdate(pc(), ok, config).ok).toBe(true);
  });

  it("passes a set deletion through the operator reader", () => {
    const result = checkCharacterUpdate(pc(), { traits: { [SKILLS]: new Deletion() } }, defaultGameConfig(), OPERATORS);
    expect(result.ok).toBe(true);
    expect(result.value.removedSetIds).toEqual([SKILLS]);
  });

  it("refuses malformed system changes before anything else", () => {
    expect(checkCharacterUpdate(pc(), 5, defaultGameConfig())).toEqual(refused("INVALID_TRAIT_DATA"));
  });

  it("gives a replacing update no edit check: it counts as loading (ADR-037 point 4)", () => {
    const replacement = edited(c => { c.traits[SKILLS].entries[0].dice = [6, 8]; c.kindId = "unknownKind00000"; });
    expect(checkCharacterUpdate(pc(), new Replacement(replacement), defaultGameConfig(), OPERATORS)).toEqual({ ok: true, value: null });
  });
});

/** @returns {object} the object, frozen all the way down */
function deepFreeze(value) {
  if ( value && (typeof value === "object") ) {
    for ( const inner of Object.values(value) ) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}
