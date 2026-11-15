import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_INPUTS, FREE_NAME_INPUTS, FREE_RATING_INPUTS, NAME_INPUTS, NEW_RATING_INPUTS, RATING_INPUTS, SET_SFX_INPUTS,
  SFX_INPUTS, STATEMENT_INPUTS, SUB_NAME_INPUTS, SUB_RATING_INPUTS, TAG_INPUTS, addFreeTrait, addSetSfx, addSubTrait,
  addTraitEntry, addTraitSfx, characterSheetView, freeTraitChanges, removeFreeTrait, removeSetSfx, removeSubTrait,
  removeTraitEntry, removeTraitSfx, resolveTraitChallenge, setShutDownChange, setTraitShutDown, sheetTraitChanges,
  storesNoTraits, traitChangesFromInputs
} from "../../module/apps/character-sheet-data.mjs";
import { defaultGameConfig, traitSetById } from "../../module/rules/game-config.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const lang = JSON.parse(readFileSync(resolve(ROOT, "lang/en.json"), "utf8"));

// Ids from the default configuration (ADR-040).
const PC = "cpKindPlayerChar";
const MINOR_GMC = "cpKindMinorGmc00";
const MOB = "cpKindMob0000000";
const DISTINCTIONS = "cpSetDistinction";
const ATTRIBUTES = "cpSetAttributes0";
const SKILLS = "cpSetSkills00000";
const MOB_TRAIT = "cpSetMobTrait000";
const PHYSICAL = "cpAttrPhysical00";
const SOCIAL = "cpAttrSocial0000";

const ENTRY_PHYSICAL = "entryPhysical000";
const ENTRY_SOCIAL = "entrySocial00000";
const ENTRY_ORPHAN = "entryOrphan00000";
const ENTRY_CULT = "entryCult0000000";
const ENTRY_MOB = "entryMob00000000";

/** @returns {object} the object, frozen all the way down */
function deepFreeze(value) {
  if ( value && (typeof value === "object") ) {
    for ( const inner of Object.values(value) ) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/**
 * A player character's system data under the defaults: Physical and Social stored (Social with a
 * challenged statement and an SFX), an entry whose definition is gone, and one distinction.
 * @returns {object}
 */
function pcSystem() {
  return {
    schemaVersion: 1,
    kindId: PC,
    traits: {
      [ATTRIBUTES]: { shutDown: false, sfx: [], entries: [
        { id: ENTRY_PHYSICAL, defId: PHYSICAL, name: "Physical", dice: [8], sfx: [] },
        { id: ENTRY_ORPHAN, defId: "deletedDef000000", name: "Gone", dice: [6], sfx: [] },
        { id: ENTRY_SOCIAL, defId: SOCIAL, name: "Social", dice: [6], statement: "I trust no one", challenged: true,
          preChallengeDice: [8], sfx: [{ text: "Hard to fool", unlocked: true }], shutDown: { reason: "manual" } }
      ] },
      [DISTINCTIONS]: { shutDown: false, sfx: [], entries: [
        { id: ENTRY_CULT, defId: null, name: "Cult Survivor", dice: [8], description: "Saw too much", sfx: [] }
      ] }
    },
    freeTraits: []
  };
}

/** @returns {object} a mob's system data with a mob trait of two d6 */
function mobSystem() {
  return {
    schemaVersion: 1,
    kindId: MOB,
    traits: { [MOB_TRAIT]: { shutDown: false, sfx: [], entries: [
      { id: ENTRY_MOB, defId: null, name: "Thugs", dice: [6, 6], sfx: [] }
    ] } },
    freeTraits: []
  };
}

describe("characterSheetView", () => {
  it("shows the kind's sets in the kind's order, named as the configuration names them", () => {
    const view = characterSheetView(deepFreeze(pcSystem()), deepFreeze(defaultGameConfig()));
    expect(view.kindStatus).toBe("assigned");
    expect(view.kind).toEqual({ id: PC, name: "Player character" });
    expect(view.sets.map(s => [s.id, s.name])).toEqual([
      [DISTINCTIONS, "Distinctions"], [ATTRIBUTES, "Attributes"], [SKILLS, "Skills"]
    ]);
  });

  it("shows a set the GM added or renamed, without anything else changing", () => {
    const config = defaultGameConfig();
    config.traitSets.push({
      ...traitSetById(config, DISTINCTIONS), id: "valuesSet0000001", name: "Values", features: { ...traitSetById(config, DISTINCTIONS).features }
    });
    config.actorKinds.find(k => k.id === PC).traitSetIds.push("valuesSet0000001");
    traitSetById(config, ATTRIBUTES).name = "Approaches";
    const system = pcSystem();
    system.traits.valuesSet0000001 = { shutDown: false, sfx: [], entries: [
      { id: "entryHonesty0000", defId: null, name: "Honesty", dice: [10], sfx: [] }
    ] };
    const view = characterSheetView(system, config);
    expect(view.sets.map(s => s.name)).toEqual(["Distinctions", "Approaches", "Skills", "Values"]);
    expect(view.sets[3].traits.map(t => [t.entryId, t.name, t.dice])).toEqual([["entryHonesty0000", "Honesty", [10]]]);
  });

  it("lists a fixed set's definitions in configuration order, each with its entry or none", () => {
    const view = characterSheetView(pcSystem(), defaultGameConfig());
    const attributes = view.sets.find(s => s.id === ATTRIBUTES);
    expect(attributes.traits.map(t => [t.name, t.entryId, t.dice, t.editable])).toEqual([
      ["Physical", ENTRY_PHYSICAL, [8], true],
      ["Mental", null, [], false],
      ["Social", ENTRY_SOCIAL, [6], true]
    ]);
  });

  it("names a fixed set's trait by its current definition, not the entry's snapshot (TS-E04)", () => {
    const config = defaultGameConfig();
    traitSetById(config, ATTRIBUTES).traits.find(d => d.id === PHYSICAL).name = "Body";
    const attributes = characterSheetView(pcSystem(), config).sets.find(s => s.id === ATTRIBUTES);
    expect(attributes.traits[0]).toMatchObject({ entryId: ENTRY_PHYSICAL, name: "Body" });
  });

  it("doesn't show an entry whose definition is gone (TS-E03), or sets and free traits outside the kind", () => {
    const system = pcSystem();
    system.traits[MOB_TRAIT] = { shutDown: false, sfx: [], entries: [{ id: ENTRY_MOB, defId: null, name: "Thugs", dice: [6], sfx: [] }] };
    system.freeTraits = [{ id: "freeTrait0000000", name: "Big Shotgun", dice: [8] }];
    const view = characterSheetView(system, defaultGameConfig());
    const shownIds = view.sets.flatMap(s => s.traits.map(t => t.entryId));
    expect(shownIds).not.toContain(ENTRY_ORPHAN);
    expect(shownIds).not.toContain(ENTRY_MOB);
    expect(shownIds).not.toContain("freeTrait0000000");
  });

  it("lists an open set's entries in stored order, by their stored names", () => {
    const distinctions = characterSheetView(pcSystem(), defaultGameConfig()).sets.find(s => s.id === DISTINCTIONS);
    expect(distinctions.traits.map(t => [t.entryId, t.name, t.dice])).toEqual([[ENTRY_CULT, "Cult Survivor", [8]]]);
  });

  it("shows the fallback die of a definition without an entry (rule 8, TS-03), and no input for it", () => {
    const skills = characterSheetView(pcSystem(), defaultGameConfig()).sets.find(s => s.id === SKILLS);
    expect(skills.traits).toHaveLength(12);
    expect(skills.traits[0]).toMatchObject({ name: "Fight", entryId: null, editable: false, slots: [], fallbackDie: 4, unrated: false });
  });

  it("marks an empty rating without fallback as unrated (TS-04) and a set without dice as having none (rule 3)", () => {
    const config = defaultGameConfig();
    const system = pcSystem();
    system.traits[DISTINCTIONS].entries[0].dice = [];
    let trait = characterSheetView(system, config).sets[0].traits[0];
    expect(trait).toMatchObject({ unrated: true, fallbackDie: null, editable: true });
    expect(trait.slots.map(s => [s.index, s.value, s.adds])).toEqual([[0, null, true]]);

    traitSetById(config, DISTINCTIONS).hasDice = false;
    trait = characterSheetView(system, config).sets[0].traits[0];
    expect(trait).toMatchObject({ noDice: true, editable: false, slots: [] });
  });

  it("gives a one-die set one input per stored die, and a several-dice set a further blank one that adds a die", () => {
    const pc = characterSheetView(pcSystem(), defaultGameConfig()).sets.find(s => s.id === ATTRIBUTES).traits[0];
    expect(pc.slots.map(s => [s.inputName, s.value, s.adds])).toEqual([
      [`${RATING_INPUTS}.${ATTRIBUTES}.${ENTRY_PHYSICAL}.0`, 8, false]
    ]);
    expect(pc.slots[0].options.map(o => [o.value, o.label, o.selected])).toEqual([
      [4, "d4", false], [6, "d6", false], [8, "d8", true], [10, "d10", false], [12, "d12", false]
    ]);

    const mob = characterSheetView(mobSystem(), defaultGameConfig()).sets[0].traits[0];
    expect(mob.slots.map(s => [s.index, s.value, s.adds])).toEqual([[0, 6, false], [1, 6, false], [2, null, true]]);
  });

  it("keeps an input for every stored die of a rating its set no longer allows (ADR-037 point 5)", () => {
    const system = pcSystem();
    system.traits[ATTRIBUTES].entries[0].dice = [8, 6];
    const trait = characterSheetView(system, defaultGameConfig()).sets.find(s => s.id === ATTRIBUTES).traits[0];
    expect(trait.slots.map(s => s.value)).toEqual([8, 6]);
    expect(trait.hints).toContain("RATING_CONFLICTS_WITH_SET");
  });

  it("gives every trait with a die the pool's trait id: a fixed set's definition, an open set's entry", () => {
    const view = characterSheetView(pcSystem(), defaultGameConfig());
    const distinctions = view.sets.find(s => s.id === DISTINCTIONS).traits;
    const attributes = view.sets.find(s => s.id === ATTRIBUTES).traits;
    expect(distinctions.map(t => [t.poolTraitId, t.rollable])).toEqual([[ENTRY_CULT, true]]);
    expect(attributes.map(t => [t.poolTraitId, t.rollable])).toEqual([
      ["cpAttrPhysical00", true], ["cpAttrMental0000", true], [SOCIAL, true]
    ]);
    // A trait that gives no die can't be added (rule 3, TS-04).
    const system = pcSystem();
    system.traits[DISTINCTIONS].entries[0].dice = [];
    expect(characterSheetView(system, defaultGameConfig()).sets[0].traits[0]).toMatchObject({ rollable: false });
  });

  it("offers Hinder where the set has it (rule 11) and a challenge where the set has statements and the trait one (rule 16)", () => {
    const config = defaultGameConfig();
    let view = characterSheetView(pcSystem(), config);
    expect(view.sets[0].traits[0]).toMatchObject({ canHinder: true, canChallenge: false });
    expect(view.sets[1].traits.map(t => [t.canHinder, t.canChallenge])).toEqual([[false, false], [false, false], [false, false]]);

    traitSetById(config, ATTRIBUTES).features.statements = true;
    view = characterSheetView(pcSystem(), config);
    // Only Social has a statement.
    expect(view.sets[1].traits.map(t => t.canChallenge)).toEqual([false, false, true]);
  });

  it("shows the guidance hint for a rating outside the set's usual range (rule 9, TS-E07)", () => {
    const system = pcSystem();
    system.traits[ATTRIBUTES].entries[0].dice = [4];
    const trait = characterSheetView(system, defaultGameConfig()).sets.find(s => s.id === ATTRIBUTES).traits[0];
    expect(trait.hints).toEqual(["RATING_OUTSIDE_GUIDANCE"]);
  });

  it("marks a shut-down trait, and every trait of a shut-down set (rule 15)", () => {
    const system = pcSystem();
    let attributes = characterSheetView(system, defaultGameConfig()).sets.find(s => s.id === ATTRIBUTES);
    expect(attributes.traits.map(t => t.shutDown)).toEqual([false, false, true]);
    expect(attributes.shutDown).toBe(false);

    system.traits[ATTRIBUTES].shutDown = true;
    attributes = characterSheetView(system, defaultGameConfig()).sets.find(s => s.id === ATTRIBUTES);
    expect(attributes.shutDown).toBe(true);
    expect(attributes.traits.map(t => t.shutDown)).toEqual([true, true, true]);
  });

  it("says when the character has no kind, or one the configuration doesn't have, and shows no sets", () => {
    const config = defaultGameConfig();
    const unassigned = characterSheetView({ ...pcSystem(), kindId: null }, config);
    expect(unassigned).toMatchObject({ kindStatus: "unassigned", kind: null, sets: [], freeTraits: null });
    expect(characterSheetView({ ...pcSystem(), kindId: "noSuchKind000000" }, config))
      .toMatchObject({ kindStatus: "unknown", kind: null, sets: [], freeTraits: null });
  });

  it("shows a kind without sets as having none", () => {
    const view = characterSheetView({ ...pcSystem(), kindId: MINOR_GMC }, defaultGameConfig());
    expect(view).toMatchObject({ kindStatus: "assigned", kind: { id: MINOR_GMC, name: "Minor GMC" }, sets: [], freeTraits: [] });
  });

  it("shows a set the actor holds nothing in as an open set with no traits", () => {
    const system = pcSystem();
    delete system.traits[DISTINCTIONS];
    expect(characterSheetView(system, defaultGameConfig()).sets[0]).toMatchObject({ id: DISTINCTIONS, traits: [] });
  });
});

describe("traitChangesFromInputs", () => {
  it("replaces only the edited rating and returns the set's whole entries list, fields kept as stored", () => {
    const system = deepFreeze(pcSystem());
    const result = traitChangesFromInputs(system, { [ATTRIBUTES]: { [ENTRY_PHYSICAL]: { 0: "10" }, [ENTRY_SOCIAL]: { 0: "6" } } });
    expect(result.ok).toBe(true);
    expect(Object.keys(result.value)).toEqual([ATTRIBUTES]);
    const expected = pcSystem().traits[ATTRIBUTES].entries;
    expected[0].dice = [10];
    expect(result.value[ATTRIBUTES]).toEqual({ entries: expected });
  });

  it("keeps an entry the sheet doesn't show, such as one whose definition is gone (TS-E03)", () => {
    const result = traitChangesFromInputs(pcSystem(), { [ATTRIBUTES]: { [ENTRY_PHYSICAL]: { 0: "6" } } });
    expect(result.value[ATTRIBUTES].entries.map(e => e.id)).toEqual([ENTRY_PHYSICAL, ENTRY_ORPHAN, ENTRY_SOCIAL]);
  });

  it("leaves out keys whose value is undefined, as a data model's toObject() keeps them", () => {
    const system = pcSystem();
    system.traits[ATTRIBUTES].entries[0].statement = undefined;
    const entry = traitChangesFromInputs(system, { [ATTRIBUTES]: { [ENTRY_PHYSICAL]: { 0: "6" } } }).value[ATTRIBUTES].entries[0];
    expect(Object.hasOwn(entry, "statement")).toBe(false);
  });

  it("returns no change when every input matches what is stored, or when there are no inputs", () => {
    expect(traitChangesFromInputs(pcSystem(), { [ATTRIBUTES]: { [ENTRY_PHYSICAL]: { 0: "8" } } })).toEqual({ ok: true, value: {} });
    expect(traitChangesFromInputs(pcSystem(), undefined)).toEqual({ ok: true, value: {} });
    expect(traitChangesFromInputs(pcSystem(), {})).toEqual({ ok: true, value: {} });
  });

  it("reads numbers as well as text, and a blank input as no die", () => {
    const system = mobSystem();
    expect(traitChangesFromInputs(system, { [MOB_TRAIT]: { [ENTRY_MOB]: { 0: 6, 1: "", 2: null } } })
      .value[MOB_TRAIT].entries[0].dice).toEqual([6]);
    expect(traitChangesFromInputs(system, { [MOB_TRAIT]: { [ENTRY_MOB]: [6, 6, "6"] } })
      .value[MOB_TRAIT].entries[0].dice).toEqual([6, 6, 6]);
  });

  it("keeps the dice in input order, also past ten dice", () => {
    const inputs = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i), i === 10 ? "12" : "6"]));
    const dice = traitChangesFromInputs(mobSystem(), { [MOB_TRAIT]: { [ENTRY_MOB]: inputs } }).value[MOB_TRAIT].entries[0].dice;
    expect(dice).toHaveLength(12);
    expect(dice[10]).toBe(12);
  });

  it("clears a rating when every input is blank", () => {
    const result = traitChangesFromInputs(pcSystem(), { [DISTINCTIONS]: { [ENTRY_CULT]: { 0: "" } } });
    expect(result.value[DISTINCTIONS].entries[0].dice).toEqual([]);
  });

  it("doesn't check the new rating against its set: that is checkCharacterUpdate's job", () => {
    const result = traitChangesFromInputs(mobSystem(), { [MOB_TRAIT]: { [ENTRY_MOB]: { 0: "6", 1: "8" } } });
    expect(result.value[MOB_TRAIT].entries[0].dice).toEqual([6, 8]);
  });

  it("ignores inputs for a set or an entry the actor doesn't hold", () => {
    const result = traitChangesFromInputs(pcSystem(), {
      noSuchSet0000000: { [ENTRY_PHYSICAL]: { 0: "6" } },
      [ATTRIBUTES]: { noSuchEntry00000: { 0: "6" } }
    });
    expect(result).toEqual({ ok: true, value: {} });
  });

  it("refuses a value that isn't a die size, and inputs that aren't shaped as the sheet names them", () => {
    for ( const value of ["7", "d8", 14, "abc", true, {}] ) {
      expect(traitChangesFromInputs(pcSystem(), { [ATTRIBUTES]: { [ENTRY_PHYSICAL]: { 0: value } } }), String(value))
        .toEqual({ ok: false, code: "INVALID_DIE_SIZE" });
    }
    expect(traitChangesFromInputs(pcSystem(), "ratings").code).toBe("INVALID_TRAIT_DATA");
    expect(traitChangesFromInputs(pcSystem(), { [ATTRIBUTES]: "8" }).code).toBe("INVALID_TRAIT_DATA");
    expect(traitChangesFromInputs(pcSystem(), { [ATTRIBUTES]: { [ENTRY_PHYSICAL]: "8" } }).code).toBe("INVALID_TRAIT_DATA");
    expect(traitChangesFromInputs(pcSystem(), { [ATTRIBUTES]: { [ENTRY_PHYSICAL]: { first: "8" } } }).code).toBe("INVALID_TRAIT_DATA");
  });
});

describe("trait management (Character Sheets behaviours 13 and 14)", () => {
  const NEW_ID = "newEntry00000001";
  const makeId = () => NEW_ID;

  it("gives a fixed-set trait without an entry an input that creates it, and an open-set trait a name input", () => {
    const view = characterSheetView(pcSystem(), defaultGameConfig());
    const attributes = view.sets.find(s => s.id === ATTRIBUTES);
    expect(attributes.open).toBe(false);
    expect(attributes.traits.map(t => t.newSlot?.inputName ?? null)).toEqual([
      null, `${NEW_RATING_INPUTS}.${ATTRIBUTES}.cpAttrMental0000.0`, null
    ]);
    expect(attributes.traits.map(t => t.nameInput)).toEqual([null, null, null]);
    const distinctions = view.sets.find(s => s.id === DISTINCTIONS);
    expect(distinctions.open).toBe(true);
    expect(distinctions.traits.map(t => [t.nameInput, t.newSlot])).toEqual([[`${NAME_INPUTS}.${DISTINCTIONS}.${ENTRY_CULT}`, null]]);

    // A set without dice has nothing to rate.
    const config = defaultGameConfig();
    traitSetById(config, ATTRIBUTES).hasDice = false;
    expect(characterSheetView(pcSystem(), config).sets.find(s => s.id === ATTRIBUTES).traits[1].newSlot).toBeNull();
  });

  it("CS-09 a rating chosen for Mental creates its entry: new id, definition id, name snapshot, the rating", () => {
    const result = sheetTraitChanges(deepFreeze(pcSystem()), deepFreeze(defaultGameConfig()),
      { newRatings: { [ATTRIBUTES]: { cpAttrMental0000: { 0: "8" } } } }, makeId);
    expect(Object.keys(result.value)).toEqual([ATTRIBUTES]);
    expect(result.value[ATTRIBUTES].entries).toEqual([
      ...pcSystem().traits[ATTRIBUTES].entries,
      { id: NEW_ID, defId: "cpAttrMental0000", name: "Mental", dice: [8], sfx: [] }
    ]);
  });

  it("creates an entry in a set the actor holds nothing in yet, together with a rating change elsewhere", () => {
    const result = sheetTraitChanges(pcSystem(), defaultGameConfig(), {
      ratings: { [ATTRIBUTES]: { [ENTRY_PHYSICAL]: { 0: "10" } } },
      newRatings: { [SKILLS]: { cpSkillFight0000: { 0: 6 } } }
    }, makeId);
    expect(result.value[SKILLS]).toEqual({ entries: [{ id: NEW_ID, defId: "cpSkillFight0000", name: "Fight", dice: [6], sfx: [] }] });
    expect(result.value[ATTRIBUTES].entries[0].dice).toEqual([10]);
  });

  it("ignores a blank choice, a definition the set doesn't have, an open set, and a definition that has an entry by now", () => {
    const form = newRatings => sheetTraitChanges(pcSystem(), defaultGameConfig(), { newRatings }, makeId);
    expect(form({ [ATTRIBUTES]: { cpAttrMental0000: { 0: "" } } })).toEqual({ ok: true, value: {} });
    expect(form({ [ATTRIBUTES]: { noSuchDef0000000: { 0: "8" } } })).toEqual({ ok: true, value: {} });
    expect(form({ [DISTINCTIONS]: { cpAttrMental0000: { 0: "8" } } })).toEqual({ ok: true, value: {} });
    expect(form({ [ATTRIBUTES]: { cpAttrPhysical00: { 0: "8" } } })).toEqual({ ok: true, value: {} });
    expect(form({ [ATTRIBUTES]: { cpAttrMental0000: { 0: "7" } } })).toEqual({ ok: false, code: "INVALID_DIE_SIZE" });
    expect(form("x")).toEqual({ ok: false, code: "INVALID_TRAIT_DATA" });
  });

  it("renames an open-set trait, trimmed, and keeps everything else it holds", () => {
    const result = sheetTraitChanges(deepFreeze(pcSystem()), defaultGameConfig(),
      { names: { [DISTINCTIONS]: { [ENTRY_CULT]: "  Reformed Cultist " } } }, makeId);
    expect(result.value[DISTINCTIONS].entries).toEqual([
      { ...pcSystem().traits[DISTINCTIONS].entries[0], name: "Reformed Cultist" }
    ]);
  });

  it("changes nothing for the same name, a blank name, a name that isn't text, or a fixed set's trait", () => {
    const form = names => sheetTraitChanges(pcSystem(), defaultGameConfig(), { names }, makeId);
    expect(form({ [DISTINCTIONS]: { [ENTRY_CULT]: "Cult Survivor" } })).toEqual({ ok: true, value: {} });
    expect(form({ [DISTINCTIONS]: { [ENTRY_CULT]: "   " } })).toEqual({ ok: true, value: {} });
    expect(form({ [DISTINCTIONS]: { [ENTRY_CULT]: 7 } })).toEqual({ ok: true, value: {} });
    expect(form({ [ATTRIBUTES]: { [ENTRY_PHYSICAL]: "Body" } })).toEqual({ ok: true, value: {} });
    expect(form({ [DISTINCTIONS]: "x" })).toEqual({ ok: false, code: "INVALID_TRAIT_DATA" });
  });

  it("applies a rename and a rating change of one entry together", () => {
    const result = sheetTraitChanges(pcSystem(), defaultGameConfig(), {
      ratings: { [DISTINCTIONS]: { [ENTRY_CULT]: { 0: "10" } } }, names: { [DISTINCTIONS]: { [ENTRY_CULT]: "Reformed" } }
    }, makeId);
    expect(result.value[DISTINCTIONS].entries[0]).toMatchObject({ name: "Reformed", dice: [10], description: "Saw too much" });
  });

  it("CS-10 adds a distinction at the set's starting rating, and a trait without a rating where the set has none", () => {
    const added = addTraitEntry(deepFreeze(pcSystem()), defaultGameConfig(), DISTINCTIONS, NEW_ID, " Retired Smuggler ");
    expect(added.value.entries).toEqual([
      ...pcSystem().traits[DISTINCTIONS].entries,
      { id: NEW_ID, defId: null, name: "Retired Smuggler", dice: [8], sfx: [] }
    ]);
    // The mob trait has no starting rating; the actor holds nothing in that set yet.
    expect(addTraitEntry(pcSystem(), defaultGameConfig(), MOB_TRAIT, NEW_ID, "Thugs").value)
      .toEqual({ entries: [{ id: NEW_ID, defId: null, name: "Thugs", dice: [], sfx: [] }] });
  });

  it("refuses adding to a fixed set, an unknown set, or with a blank name", () => {
    const config = defaultGameConfig();
    expect(addTraitEntry(pcSystem(), config, ATTRIBUTES, NEW_ID, "Luck")).toEqual({ ok: false, code: "TRAIT_SET_NOT_OPEN" });
    expect(addTraitEntry(pcSystem(), config, "noSuchSet0000000", NEW_ID, "Luck")).toEqual({ ok: false, code: "UNKNOWN_TRAIT_SET" });
    expect(addTraitEntry(pcSystem(), config, DISTINCTIONS, NEW_ID, "  ")).toEqual({ ok: false, code: "INVALID_TRAIT_DATA" });
  });

  it("removes one trait and keeps the others; an emptied set keeps an empty list (ADR-044)", () => {
    const removed = removeTraitEntry(deepFreeze(pcSystem()), ATTRIBUTES, ENTRY_ORPHAN);
    expect(removed.value.entries.map(e => e.id)).toEqual([ENTRY_PHYSICAL, ENTRY_SOCIAL]);
    expect(removeTraitEntry(pcSystem(), DISTINCTIONS, ENTRY_CULT)).toEqual({ ok: true, value: { entries: [] } });
    expect(removeTraitEntry(pcSystem(), DISTINCTIONS, "noSuchEntry00000")).toEqual({ ok: false, code: "UNKNOWN_TRAIT" });
    expect(removeTraitEntry(pcSystem(), 5, ENTRY_CULT)).toEqual({ ok: false, code: "INVALID_TRAIT_DATA" });
  });

  it("has a refusal string for every code the trait-management functions return", () => {
    for ( const code of ["INVALID_TRAIT_DATA", "INVALID_DIE_SIZE", "UNKNOWN_TRAIT_SET", "UNKNOWN_TRAIT", "TRAIT_SET_NOT_OPEN"] ) {
      expect(lang.CORTEX.Character.Errors[code], code).toBeTypeOf("string");
    }
  });
});

describe("free traits (Character Sheets behaviour 9, TS-22)", () => {
  const config = deepFreeze(defaultGameConfig());
  const DEPUTY = "freeDeputy000000";
  const BREATH = "freeBreath000000";
  const gmc = () => deepFreeze({
    schemaVersion: 1, kindId: MINOR_GMC, traits: {},
    freeTraits: [{ id: DEPUTY, name: "Crooked Deputy", dice: [8] }, { id: BREATH, name: "Short of Breath", dice: [] }]
  });

  it("lists a kind's free traits in stored order, each with its name and rating inputs (CS-11)", () => {
    const view = characterSheetView(gmc(), config);
    expect(view.sets).toEqual([]);
    expect(view.freeTraits.map(t => [t.entryId, t.name, t.dice])).toEqual([
      [DEPUTY, "Crooked Deputy", [8]], [BREATH, "Short of Breath", []]
    ]);
    const [deputy, breath] = view.freeTraits;
    expect(deputy).toMatchObject({
      editable: true, rollable: true, poolTraitId: DEPUTY, unrated: false, fallbackDie: null, noDice: false,
      canHinder: false, canChallenge: false, newSlot: null, nameInput: `${FREE_NAME_INPUTS}.${DEPUTY}`
    });
    expect(deputy.slots.map(s => [s.inputName, s.value, s.adds])).toEqual([[`${FREE_RATING_INPUTS}.${DEPUTY}.0`, 8, false]]);
    // No set, so no fallback die: an empty rating is unrated and gives no die to add.
    expect(breath).toMatchObject({ unrated: true, rollable: false, fallbackDie: null });
    expect(breath.slots.map(s => [s.inputName, s.value, s.adds])).toEqual([[`${FREE_RATING_INPUTS}.${BREATH}.0`, null, true]]);
    expect(view.others).toEqual({ sets: [], freeTraits: [], count: 0 });
  });

  it("has no free-trait section for a kind without free traits", () => {
    expect(characterSheetView(pcSystem(), config).freeTraits).toBeNull();
  });

  it("changes a free trait's rating and name and returns the whole list", () => {
    const changed = freeTraitChanges(gmc(), {
      ratings: { [DEPUTY]: { 0: "10" }, [BREATH]: { 0: "4" }, goneTrait0000000: { 0: "6" } },
      names: { [DEPUTY]: "  Honest Deputy ", [BREATH]: "Short of Breath" }
    });
    expect(changed).toEqual({ ok: true, value: [
      { id: DEPUTY, name: "Honest Deputy", dice: [10] }, { id: BREATH, name: "Short of Breath", dice: [4] }
    ] });
  });

  it("reports no change for the stored values, a blank name and missing inputs", () => {
    expect(freeTraitChanges(gmc(), {})).toEqual({ ok: true, value: null });
    expect(freeTraitChanges(gmc(), { ratings: { [DEPUTY]: { 0: "8" }, [BREATH]: { 0: "" } }, names: { [DEPUTY]: "  " } }))
      .toEqual({ ok: true, value: null });
  });

  it("empties a rating when its die is blanked", () => {
    const changed = freeTraitChanges(gmc(), { ratings: { [DEPUTY]: { 0: "" } } });
    expect(changed.value[0]).toEqual({ id: DEPUTY, name: "Crooked Deputy", dice: [] });
  });

  it("refuses inputs it can't read", () => {
    expect(freeTraitChanges(gmc(), null)).toEqual({ ok: false, code: "INVALID_TRAIT_DATA" });
    expect(freeTraitChanges(gmc(), { ratings: [] })).toEqual({ ok: false, code: "INVALID_TRAIT_DATA" });
    expect(freeTraitChanges(gmc(), { names: "x" })).toEqual({ ok: false, code: "INVALID_TRAIT_DATA" });
    expect(freeTraitChanges(gmc(), { ratings: { [DEPUTY]: { 0: "7" } } })).toEqual({ ok: false, code: "INVALID_DIE_SIZE" });
  });

  it("adds a free trait at the end with a trimmed name and no rating", () => {
    const added = addFreeTrait(gmc(), "freeNew000000000", " Sawed-off ");
    expect(added.ok).toBe(true);
    expect(added.value).toHaveLength(3);
    expect(added.value[2]).toEqual({ id: "freeNew000000000", name: "Sawed-off", dice: [] });
    expect(addFreeTrait({ kindId: MINOR_GMC, traits: {} }, "freeNew000000000", "First").value).toHaveLength(1);
    expect(addFreeTrait(gmc(), "freeNew000000000", " ")).toEqual({ ok: false, code: "INVALID_TRAIT_DATA" });
    expect(addFreeTrait(gmc(), 5, "Name")).toEqual({ ok: false, code: "INVALID_TRAIT_DATA" });
  });

  it("removes a free trait by id, and refuses one the actor doesn't hold", () => {
    expect(removeFreeTrait(gmc(), DEPUTY)).toEqual({ ok: true, value: [{ id: BREATH, name: "Short of Breath", dice: [] }] });
    expect(removeFreeTrait(gmc(), "goneTrait0000000")).toEqual({ ok: false, code: "UNKNOWN_TRAIT" });
    expect(removeFreeTrait(gmc(), null)).toEqual({ ok: false, code: "INVALID_TRAIT_DATA" });
  });
});

describe("other stored traits (Character Sheets behaviour 10, CS-D5, ADR-051)", () => {
  const config = deepFreeze(defaultGameConfig());

  it("lists an entry no definition matches under its set", () => {
    const { others } = characterSheetView(pcSystem(), config);
    expect(others).toEqual({
      sets: [{ setId: ATTRIBUTES, name: "Attributes", reason: "noDefinition", traits: [
        { entryId: ENTRY_ORPHAN, name: "Gone", dice: [6] }
      ] }],
      freeTraits: [],
      count: 1
    });
  });

  it("lists a second entry for a definition that already has one", () => {
    const system = pcSystem();
    system.traits[ATTRIBUTES].entries.push({ id: "entryPhysical002", defId: PHYSICAL, name: "Physical", dice: [10], sfx: [] });
    const { others } = characterSheetView(system, config);
    expect(others.sets[0].traits.map(t => t.entryId)).toEqual([ENTRY_ORPHAN, "entryPhysical002"]);
  });

  it("lists sets outside the kind, sets the configuration lacks, and free traits of a kind without them", () => {
    const system = pcSystem();
    system.traits[MOB_TRAIT] = { shutDown: false, sfx: [], entries: [{ id: ENTRY_MOB, defId: null, name: "Mob", dice: [6, 6], sfx: [] }] };
    system.traits.goneSet000000000 = { shutDown: false, sfx: [], entries: [{ id: "entryGone0000000", defId: null, name: "Relic", dice: [], sfx: [] }] };
    system.traits[SKILLS] = { shutDown: false, sfx: [], entries: [] };
    system.freeTraits = [{ id: "freeLeft00000000", name: "Left over", dice: [6] }];
    const { others } = characterSheetView(system, config);
    expect(others.sets.map(g => [g.setId, g.name, g.reason, g.traits.map(t => t.name)])).toEqual([
      [ATTRIBUTES, "Attributes", "noDefinition", ["Gone"]],
      [MOB_TRAIT, traitSetById(config, MOB_TRAIT).name, "notInKind", ["Mob"]],
      ["goneSet000000000", null, "unknownSet", ["Relic"]]
    ]);
    expect(others.freeTraits).toEqual([{ entryId: "freeLeft00000000", name: "Left over", dice: [6] }]);
    expect(others.count).toBe(4);
  });

  it("lists everything stored for a character without a known kind", () => {
    for ( const kindId of [null, "noSuchKind000000"] ) {
      const { others } = characterSheetView({ ...pcSystem(), kindId, freeTraits: [{ id: "freeLeft00000000", name: "Left over", dice: [] }] }, config);
      expect(others.sets.map(g => [g.setId, g.reason, g.traits.length])).toEqual([
        [ATTRIBUTES, "notInKind", 3], [DISTINCTIONS, "notInKind", 1]
      ]);
      expect(others.count).toBe(5);
    }
  });

  it("removes a listed entry through removeTraitEntry and keeps the set's key", () => {
    const system = pcSystem();
    system.traits[MOB_TRAIT] = { shutDown: false, sfx: [], entries: [{ id: ENTRY_MOB, defId: null, name: "Mob", dice: [6, 6], sfx: [] }] };
    expect(removeTraitEntry(system, MOB_TRAIT, ENTRY_MOB)).toEqual({ ok: true, value: { entries: [] } });
    expect(removeTraitEntry(system, ATTRIBUTES, ENTRY_ORPHAN).value.entries.map(e => e.id)).toEqual([ENTRY_PHYSICAL, ENTRY_SOCIAL]);
  });
});

describe("statements and shut-down flags (Character Sheets behaviours 8, 15 and 17)", () => {
  /** The defaults with statements turned on for Attributes. */
  function statementsConfig() {
    const config = defaultGameConfig();
    traitSetById(config, ATTRIBUTES).features.statements = true;
    return deepFreeze(config);
  }
  const rowOf = (view, setId, entryId) => view.sets.find(s => s.id === setId).traits.find(t => t.entryId === entryId);

  it("shows a statement, its input and the challenge where the set has statements", () => {
    const view = characterSheetView(pcSystem(), statementsConfig());
    expect(rowOf(view, ATTRIBUTES, ENTRY_SOCIAL)).toMatchObject({
      statement: "I trust no one", statementInput: `${STATEMENT_INPUTS}.${ATTRIBUTES}.${ENTRY_SOCIAL}`, challenged: true,
      shutDown: true, shutDownReason: "manual", canShutDown: true
    });
    // An entry without a statement gets an empty one to fill in; a fixed-set trait without an entry gets none.
    expect(rowOf(view, ATTRIBUTES, ENTRY_PHYSICAL)).toMatchObject({ statement: "", challenged: false, shutDownReason: null });
    const mental = view.sets.find(s => s.id === ATTRIBUTES).traits.find(t => t.entryId === null);
    expect(mental).toMatchObject({ statement: "", statementInput: null, canShutDown: false });
  });

  it("hides the statement in a set without statements, but never an open challenge", () => {
    const view = characterSheetView(pcSystem(), deepFreeze(defaultGameConfig()));
    expect(rowOf(view, ATTRIBUTES, ENTRY_SOCIAL)).toMatchObject({ statement: null, statementInput: null, challenged: true });
  });

  it("offers a shut-down flag to set where the set has the feature, and to clear whenever it is set", () => {
    const config = defaultGameConfig();
    traitSetById(config, ATTRIBUTES).features.shutDown = false;
    const view = characterSheetView(pcSystem(), deepFreeze(config));
    expect(rowOf(view, ATTRIBUTES, ENTRY_PHYSICAL).canShutDown).toBe(false);
    expect(rowOf(view, ATTRIBUTES, ENTRY_SOCIAL).canShutDown, "a stored flag can always be cleared").toBe(true);
    expect(view.sets.find(s => s.id === ATTRIBUTES).canShutDown).toBe(false);
    expect(view.sets.find(s => s.id === DISTINCTIONS).canShutDown).toBe(true);
    const flagged = pcSystem();
    flagged.traits[ATTRIBUTES].shutDown = true;
    expect(characterSheetView(flagged, deepFreeze(config)).sets.find(s => s.id === ATTRIBUTES).canShutDown).toBe(true);
  });

  it("edits a statement's text, trimmed, and keeps the challenge (TS-15c)", () => {
    const system = deepFreeze(pcSystem());
    const changed = sheetTraitChanges(system, statementsConfig(),
      { statements: { [ATTRIBUTES]: { [ENTRY_SOCIAL]: "  I trust my crew  ", [ENTRY_PHYSICAL]: "" } } }, () => "unused");
    expect(changed.ok).toBe(true);
    const entries = changed.value[ATTRIBUTES].entries;
    expect(entries.find(e => e.id === ENTRY_SOCIAL)).toMatchObject({
      statement: "I trust my crew", challenged: true, preChallengeDice: [8], dice: [6]
    });
    expect("statement" in entries.find(e => e.id === ENTRY_PHYSICAL), "a blank input for no statement changes nothing")
      .toBe(false);
  });

  it("reports no change for the stored statement, and refuses inputs it can't read", () => {
    const system = deepFreeze(pcSystem());
    expect(sheetTraitChanges(system, statementsConfig(), { statements: { [ATTRIBUTES]: { [ENTRY_SOCIAL]: "I trust no one" } } },
      () => "unused")).toEqual({ ok: true, value: {} });
    expect(sheetTraitChanges(system, statementsConfig(), { statements: [] }, () => "unused"))
      .toEqual({ ok: false, code: "INVALID_TRAIT_DATA" });
    expect(sheetTraitChanges(system, statementsConfig(), { statements: { [ATTRIBUTES]: "x" } }, () => "unused"))
      .toEqual({ ok: false, code: "INVALID_TRAIT_DATA" });
  });

  it("clears a statement to blank", () => {
    const changed = sheetTraitChanges(deepFreeze(pcSystem()), statementsConfig(),
      { statements: { [ATTRIBUTES]: { [ENTRY_SOCIAL]: " " } } }, () => "unused");
    expect(changed.value[ATTRIBUTES].entries.find(e => e.id === ENTRY_SOCIAL).statement).toBe("");
  });

  it("resolves a challenge as rewritten: the rating before the challenge comes back", () => {
    const resolved = resolveTraitChallenge(deepFreeze(pcSystem()), ATTRIBUTES, ENTRY_SOCIAL, true);
    expect(resolved.ok).toBe(true);
    const social = resolved.value.entries.find(e => e.id === ENTRY_SOCIAL);
    expect(social.dice).toEqual([8]);
    expect("challenged" in social).toBe(false);
    expect("preChallengeDice" in social).toBe(false);
    expect(social.shutDown).toEqual({ reason: "manual" }, "a shut-down set by hand stays");
    expect(resolved.value.entries.map(e => e.id)).toEqual([ENTRY_PHYSICAL, ENTRY_ORPHAN, ENTRY_SOCIAL]);
  });

  it("resolves a challenge as kept: the reduced rating stays", () => {
    const social = resolveTraitChallenge(deepFreeze(pcSystem()), ATTRIBUTES, ENTRY_SOCIAL, false).value.entries
      .find(e => e.id === ENTRY_SOCIAL);
    expect(social.dice).toEqual([6]);
    expect("challenged" in social).toBe(false);
  });

  it("refuses to resolve a trait that isn't challenged or isn't there", () => {
    const system = deepFreeze(pcSystem());
    expect(resolveTraitChallenge(system, ATTRIBUTES, ENTRY_PHYSICAL, true)).toEqual({ ok: false, code: "STATEMENT_NOT_CHALLENGED" });
    expect(resolveTraitChallenge(system, ATTRIBUTES, "nope000000000000", true)).toEqual({ ok: false, code: "UNKNOWN_TRAIT" });
    expect(resolveTraitChallenge(system, ATTRIBUTES, ENTRY_SOCIAL, "yes")).toEqual({ ok: false, code: "INVALID_TRAIT_DATA" });
  });

  it("sets a trait's shut-down by hand, keeps an existing reason, and clears either reason (RQ-034)", () => {
    const system = deepFreeze(pcSystem());
    const config = deepFreeze(defaultGameConfig());
    const on = setTraitShutDown(system, config, ATTRIBUTES, ENTRY_PHYSICAL, true);
    expect(on.value.entries.find(e => e.id === ENTRY_PHYSICAL).shutDown).toEqual({ reason: "manual" });
    const challenged = deepFreeze({ ...pcSystem(), traits: { [ATTRIBUTES]: { shutDown: false, sfx: [], entries: [
      { id: ENTRY_SOCIAL, defId: SOCIAL, name: "Social", dice: [4], statement: "I trust no one", challenged: true,
        preChallengeDice: [4], sfx: [], shutDown: { reason: "statementChallenged" } }
    ] } } });
    expect(setTraitShutDown(challenged, config, ATTRIBUTES, ENTRY_SOCIAL, true).value.entries[0].shutDown)
      .toEqual({ reason: "statementChallenged" });
    const off = setTraitShutDown(challenged, config, ATTRIBUTES, ENTRY_SOCIAL, false).value.entries[0];
    expect("shutDown" in off).toBe(false);
    expect(off.challenged, "clearing the flag leaves the challenge open").toBe(true);
    expect(setTraitShutDown(system, config, ATTRIBUTES, "nope000000000000", true)).toEqual({ ok: false, code: "UNKNOWN_TRAIT" });
    expect(setTraitShutDown(system, config, ATTRIBUTES, ENTRY_PHYSICAL, 1)).toEqual({ ok: false, code: "INVALID_TRAIT_DATA" });
  });

  it("sets a trait's flag only where the set has the shut-down feature, and clears it anywhere", () => {
    const config = defaultGameConfig();
    traitSetById(config, ATTRIBUTES).features.shutDown = false;
    deepFreeze(config);
    const system = deepFreeze(pcSystem());
    expect(setTraitShutDown(system, config, ATTRIBUTES, ENTRY_PHYSICAL, true)).toEqual({ ok: false, code: "SHUT_DOWN_NOT_OFFERED" });
    const off = setTraitShutDown(system, config, ATTRIBUTES, ENTRY_SOCIAL, false);
    expect("shutDown" in off.value.entries.find(e => e.id === ENTRY_SOCIAL)).toBe(false);
  });

  it("offers the toggle to clear a flag that holds no reason, and clears it", () => {
    const system = pcSystem();
    system.traits[ATTRIBUTES].entries[0].shutDown = {};
    deepFreeze(system);
    const row = rowOf(characterSheetView(system, deepFreeze(defaultGameConfig())), ATTRIBUTES, ENTRY_PHYSICAL);
    expect(row).toMatchObject({ ownShutDown: true, shutDownReason: null, canShutDown: true, shutDown: true });
    const off = setTraitShutDown(system, deepFreeze(defaultGameConfig()), ATTRIBUTES, ENTRY_PHYSICAL, false);
    expect("shutDown" in off.value.entries[0]).toBe(false);
  });

  it("decides a set's shut-down change: the flag alone for a held set, with an empty list otherwise", () => {
    const config = defaultGameConfig();
    traitSetById(config, ATTRIBUTES).features.shutDown = false;
    deepFreeze(config);
    const system = deepFreeze(pcSystem());
    expect(setShutDownChange(system, config, DISTINCTIONS, true)).toEqual({ ok: true, value: { shutDown: true } });
    expect(setShutDownChange(system, config, SKILLS, true)).toEqual({ ok: true, value: { shutDown: true, sfx: [], entries: [] } });
    expect(setShutDownChange(system, config, ATTRIBUTES, true)).toEqual({ ok: false, code: "SHUT_DOWN_NOT_OFFERED" });
    expect(setShutDownChange(system, config, ATTRIBUTES, false)).toEqual({ ok: true, value: { shutDown: false } });
    expect(setShutDownChange(system, config, ATTRIBUTES, "yes")).toEqual({ ok: false, code: "INVALID_TRAIT_DATA" });
  });

  it("leaves a stored statement or name with surrounding spaces alone when its input holds the same text", () => {
    const system = pcSystem();
    system.traits[ATTRIBUTES].entries[2].statement = "  I trust no one ";
    system.traits[DISTINCTIONS].entries[0].name = " Cult Survivor ";
    deepFreeze(system);
    expect(sheetTraitChanges(system, statementsConfig(), {
      statements: { [ATTRIBUTES]: { [ENTRY_SOCIAL]: "I trust no one" } },
      names: { [DISTINCTIONS]: { [ENTRY_CULT]: "Cult Survivor" } }
    }, () => "unused")).toEqual({ ok: true, value: {} });
  });
});

describe("trait details: descriptions, SFX, tags and sub-traits (behaviours 8 and 16)", () => {
  /** The defaults with tags, sub-traits and set SFX turned on for Distinctions (description and SFX are on). */
  function detailsConfig() {
    const config = defaultGameConfig();
    Object.assign(traitSetById(config, DISTINCTIONS).features, { tags: true, subTraits: true, setSfx: true });
    return deepFreeze(config);
  }
  const SUB = "subSmuggling0000";
  /** A player character whose distinction has an SFX, tags and a sub-trait, and whose set has an SFX. */
  function detailedSystem() {
    const system = pcSystem();
    system.traits[DISTINCTIONS].sfx = [{ text: "Set trick", unlocked: false }];
    Object.assign(system.traits[DISTINCTIONS].entries[0], {
      sfx: [{ text: "Hinder", unlocked: true }, { text: "Old habits", unlocked: false }],
      tags: ["past", "cult"],
      sub: [{ id: SUB, name: "Hiding", dice: [6] }]
    });
    return deepFreeze(system);
  }
  const cultRow = view => view.sets.find(s => s.id === DISTINCTIONS).traits.find(t => t.entryId === ENTRY_CULT);
  const cultEntry = (changes) => changes[DISTINCTIONS].entries.find(e => e.id === ENTRY_CULT);

  it("shows each detail where its set has the feature, with its inputs", () => {
    const view = characterSheetView(detailedSystem(), detailsConfig());
    const row = cultRow(view);
    expect(row.description).toBe("Saw too much");
    expect(row.descriptionInput).toBe(`${DESCRIPTION_INPUTS}.${DISTINCTIONS}.${ENTRY_CULT}`);
    expect(row.sfx).toEqual([
      { index: 0, text: "Hinder", unlocked: true, textInput: `${SFX_INPUTS}.${DISTINCTIONS}.${ENTRY_CULT}.0.text`,
        unlockedInput: `${SFX_INPUTS}.${DISTINCTIONS}.${ENTRY_CULT}.0.unlocked` },
      { index: 1, text: "Old habits", unlocked: false, textInput: `${SFX_INPUTS}.${DISTINCTIONS}.${ENTRY_CULT}.1.text`,
        unlockedInput: `${SFX_INPUTS}.${DISTINCTIONS}.${ENTRY_CULT}.1.unlocked` }
    ]);
    expect(row).toMatchObject({ canAddSfx: true, tags: ["past", "cult"], tagsInput: `${TAG_INPUTS}.${DISTINCTIONS}.${ENTRY_CULT}`,
      canAddSubTrait: true });
    expect(row.subTraits).toHaveLength(1);
    expect(row.subTraits[0]).toMatchObject({ id: SUB, name: "Hiding", dice: [6],
      nameInput: `${SUB_NAME_INPUTS}.${DISTINCTIONS}.${ENTRY_CULT}.${SUB}` });
    expect(row.subTraits[0].slots.map(s => [s.inputName, s.value])).toEqual([[`${SUB_RATING_INPUTS}.${DISTINCTIONS}.${ENTRY_CULT}.${SUB}.0`, 6]]);
    expect(view.sets.find(s => s.id === DISTINCTIONS).sfx).toEqual([
      { index: 0, text: "Set trick", unlocked: false, textInput: `${SET_SFX_INPUTS}.${DISTINCTIONS}.0.text`,
        unlockedInput: `${SET_SFX_INPUTS}.${DISTINCTIONS}.0.unlocked` }
    ]);
  });

  it("shows no detail where the set lacks the feature, and keeps them stored", () => {
    const view = characterSheetView(detailedSystem(), deepFreeze(defaultGameConfig()));
    expect(cultRow(view)).toMatchObject({ tags: null, tagsInput: null, subTraits: null, canAddSubTrait: false });
    expect(view.sets.find(s => s.id === DISTINCTIONS).sfx).toBeNull();
    // Attributes has neither the description nor the SFX feature.
    const physical = view.sets.find(s => s.id === ATTRIBUTES).traits.find(t => t.entryId === ENTRY_PHYSICAL);
    expect(physical).toMatchObject({ description: null, descriptionInput: null, sfx: null, canAddSfx: false });
  });

  it("gives a fixed-set trait without an entry no detail inputs", () => {
    const config = defaultGameConfig();
    Object.assign(traitSetById(config, ATTRIBUTES).features, { description: true, sfx: true, tags: true, subTraits: true });
    const mental = characterSheetView(pcSystem(), deepFreeze(config)).sets.find(s => s.id === ATTRIBUTES).traits
      .find(t => t.entryId === null);
    expect(mental).toMatchObject({ description: "", descriptionInput: null, sfx: [], canAddSfx: false, tags: [],
      tagsInput: null, subTraits: [], canAddSubTrait: false });
  });

  it("changes a description, SFX, tags and a sub-trait from the form, keeping everything else", () => {
    const changed = sheetTraitChanges(detailedSystem(), detailsConfig(), {
      descriptions: { [DISTINCTIONS]: { [ENTRY_CULT]: "  Saw far too much " } },
      sfx: { [DISTINCTIONS]: { [ENTRY_CULT]: { 1: { text: " New habits ", unlocked: true }, 5: { text: "gone", unlocked: true } } } },
      tags: { [DISTINCTIONS]: { [ENTRY_CULT]: ["cult", " past ", "", "cult", "new"] } },
      subNames: { [DISTINCTIONS]: { [ENTRY_CULT]: { [SUB]: "Hiding out" } } },
      subRatings: { [DISTINCTIONS]: { [ENTRY_CULT]: { [SUB]: { 0: "8" } } } },
      setSfx: { [DISTINCTIONS]: { 0: { text: "Set trick", unlocked: true } } }
    }, () => "unused");
    expect(changed.ok).toBe(true);
    expect(cultEntry(changed.value)).toEqual({
      id: ENTRY_CULT, defId: null, name: "Cult Survivor", dice: [8], description: "Saw far too much",
      sfx: [{ text: "Hinder", unlocked: true }, { text: "New habits", unlocked: true }],
      tags: ["cult", "past", "new"], sub: [{ id: SUB, name: "Hiding out", dice: [8] }]
    });
    expect(changed.value[DISTINCTIONS].sfx).toEqual([{ text: "Set trick", unlocked: true }]);
  });

  it("reports no change when the inputs hold what is stored", () => {
    const system = detailedSystem();
    expect(sheetTraitChanges(system, detailsConfig(), {
      descriptions: { [DISTINCTIONS]: { [ENTRY_CULT]: "Saw too much " } },
      sfx: { [DISTINCTIONS]: { [ENTRY_CULT]: [{ text: "Hinder", unlocked: true }, { text: "Old habits", unlocked: false }] } },
      tags: { [DISTINCTIONS]: { [ENTRY_CULT]: "past, cult" } },
      subNames: { [DISTINCTIONS]: { [ENTRY_CULT]: { [SUB]: " " } } },
      subRatings: { [DISTINCTIONS]: { [ENTRY_CULT]: { [SUB]: ["6"] } } },
      setSfx: { [DISTINCTIONS]: [{ text: " Set trick", unlocked: false }] }
    }, () => "unused")).toEqual({ ok: true, value: {} });
  });

  it("splits a tag at its commas, as the tag input shows it, and leaves such a stored tag alone", () => {
    const typed = sheetTraitChanges(detailedSystem(), detailsConfig(), {
      tags: { [DISTINCTIONS]: { [ENTRY_CULT]: ["past", "red, hot", "cult"] } }
    }, () => "unused");
    expect(cultEntry(typed.value).tags).toEqual(["past", "red", "hot", "cult"]);

    const system = structuredClone(detailedSystem());
    system.traits[DISTINCTIONS].entries[0].tags = ["past", "red, hot"];
    expect(sheetTraitChanges(deepFreeze(system), detailsConfig(), {
      tags: { [DISTINCTIONS]: { [ENTRY_CULT]: ["past", "red", "hot"] } }
    }, () => "unused")).toEqual({ ok: true, value: {} });
  });

  it("keeps a set's own SFX change and an entry change of the same set together", () => {
    const changed = sheetTraitChanges(detailedSystem(), detailsConfig(), {
      setSfx: { [DISTINCTIONS]: { 0: { text: "Better trick", unlocked: false } } },
      names: { [DISTINCTIONS]: { [ENTRY_CULT]: "Cult Escapee" } }
    }, () => "unused");
    expect(changed.value[DISTINCTIONS].sfx).toEqual([{ text: "Better trick", unlocked: false }]);
    expect(cultEntry(changed.value).name).toBe("Cult Escapee");
  });

  it("refuses detail inputs it can't read", () => {
    const system = detailedSystem();
    const config = detailsConfig();
    for ( const form of [
      { descriptions: { [DISTINCTIONS]: { [ENTRY_CULT]: 5 } } },
      { sfx: { [DISTINCTIONS]: { [ENTRY_CULT]: "x" } } },
      { sfx: { [DISTINCTIONS]: { [ENTRY_CULT]: { 0: { unlocked: "yes" } } } } },
      { tags: { [DISTINCTIONS]: { [ENTRY_CULT]: [1] } } },
      { subNames: { [DISTINCTIONS]: { [ENTRY_CULT]: "x" } } },
      { setSfx: { [DISTINCTIONS]: { "-1": { text: "x" } } } },
      { tags: [] }
    ] ) expect(sheetTraitChanges(system, config, form, () => "unused"), JSON.stringify(form)).toEqual({ ok: false, code: "INVALID_TRAIT_DATA" });
    expect(sheetTraitChanges(system, config, { subRatings: { [DISTINCTIONS]: { [ENTRY_CULT]: { [SUB]: { 0: "7" } } } } }, () => "unused"))
      .toEqual({ ok: false, code: "INVALID_DIE_SIZE" });
  });

  it("adds and removes a trait's SFX; a new one is unlocked with no text (CS-D6)", () => {
    const system = detailedSystem();
    const added = addTraitSfx(system, detailsConfig(), DISTINCTIONS, ENTRY_CULT);
    expect(added.value.entries[0].sfx.at(-1)).toEqual({ text: "", unlocked: true });
    expect(added.value.entries[0].sfx).toHaveLength(3);
    expect(addTraitSfx(system, detailsConfig(), ATTRIBUTES, ENTRY_PHYSICAL)).toEqual({ ok: false, code: "TRAIT_FEATURE_NOT_OFFERED" });
    expect(removeTraitSfx(system, DISTINCTIONS, ENTRY_CULT, 0).value.entries[0].sfx).toEqual([{ text: "Old habits", unlocked: false }]);
    expect(removeTraitSfx(system, DISTINCTIONS, ENTRY_CULT, 2)).toEqual({ ok: false, code: "UNKNOWN_SFX" });
    expect(removeTraitSfx(system, DISTINCTIONS, ENTRY_CULT, "0")).toEqual({ ok: false, code: "INVALID_TRAIT_DATA" });
  });

  it("adds and removes a set's own SFX", () => {
    const system = detailedSystem();
    expect(addSetSfx(system, detailsConfig(), DISTINCTIONS)).toEqual({ ok: true, value: {
      sfx: [{ text: "Set trick", unlocked: false }, { text: "", unlocked: true }] } });
    const config = defaultGameConfig();
    traitSetById(config, SKILLS).features.setSfx = true;
    expect(addSetSfx(system, deepFreeze(config), SKILLS)).toEqual({ ok: true, value: { sfx: [{ text: "", unlocked: true }], entries: [] } });
    expect(addSetSfx(system, detailsConfig(), ATTRIBUTES)).toEqual({ ok: false, code: "TRAIT_FEATURE_NOT_OFFERED" });
    expect(removeSetSfx(system, DISTINCTIONS, 0)).toEqual({ ok: true, value: { sfx: [] } });
    expect(removeSetSfx(system, DISTINCTIONS, 1)).toEqual({ ok: false, code: "UNKNOWN_SFX" });
  });

  it("adds and removes a sub-trait", () => {
    const system = detailedSystem();
    const added = addSubTrait(system, detailsConfig(), DISTINCTIONS, ENTRY_CULT, "subNew0000000000", " Lying ");
    expect(added.value.entries[0].sub).toEqual([{ id: SUB, name: "Hiding", dice: [6] }, { id: "subNew0000000000", name: "Lying", dice: [] }]);
    expect(addSubTrait(system, detailsConfig(), DISTINCTIONS, ENTRY_CULT, "subNew0000000000", " ")).toEqual({ ok: false, code: "INVALID_TRAIT_DATA" });
    expect(addSubTrait(system, detailsConfig(), ATTRIBUTES, ENTRY_PHYSICAL, "subNew0000000000", "x"))
      .toEqual({ ok: false, code: "TRAIT_FEATURE_NOT_OFFERED" });
    expect(removeSubTrait(system, DISTINCTIONS, ENTRY_CULT, SUB).value.entries[0].sub).toEqual([]);
    expect(removeSubTrait(system, DISTINCTIONS, ENTRY_CULT, "nope000000000000")).toEqual({ ok: false, code: "UNKNOWN_TRAIT" });
  });
});

describe("storesNoTraits (Character Sheets CS-D3)", () => {
  const emptySet = () => ({ shutDown: false, sfx: [], entries: [] });

  it("is true for a character without traits, and for sets kept with empty lists", () => {
    expect(storesNoTraits(deepFreeze({ kindId: null }))).toBe(true);
    expect(storesNoTraits(deepFreeze({ kindId: PC, traits: {}, freeTraits: [] }))).toBe(true);
    expect(storesNoTraits(deepFreeze({ kindId: PC, traits: { [DISTINCTIONS]: emptySet(), [SKILLS]: emptySet() } })))
      .toBe(true);
  });

  it("is false once a set holds an entry, whether or not the kind includes the set", () => {
    const entry = { id: ENTRY_PHYSICAL, defId: PHYSICAL, name: "Physical", dice: [8], sfx: [] };
    expect(storesNoTraits(deepFreeze({ kindId: PC, traits: { [ATTRIBUTES]: { ...emptySet(), entries: [entry] } } })))
      .toBe(false);
    expect(storesNoTraits(deepFreeze({ kindId: PC, traits: { [MOB_TRAIT]: { ...emptySet(), entries: [entry] } } })))
      .toBe(false);
  });

  it("is false for a set's own SFX, a set's shut-down flag and a free trait", () => {
    expect(storesNoTraits(deepFreeze({ kindId: PC, traits: {
      [DISTINCTIONS]: { ...emptySet(), sfx: [{ text: "", unlocked: true }] } } }))).toBe(false);
    expect(storesNoTraits(deepFreeze({ kindId: PC, traits: { [SKILLS]: { ...emptySet(), shutDown: true } } })))
      .toBe(false);
    expect(storesNoTraits(deepFreeze({ kindId: MINOR_GMC, freeTraits: [{ id: ENTRY_CULT, name: "Cult", dice: [8] }] })))
      .toBe(false);
  });

  it("counts a set value it can't read as stored", () => {
    expect(storesNoTraits(deepFreeze({ kindId: PC, traits: { [SKILLS]: "broken" } }))).toBe(false);
  });
});

describe("character sheet strings", () => {
  it("has a refusal string for every code traitChangesFromInputs can return", () => {
    for ( const code of ["INVALID_TRAIT_DATA", "INVALID_DIE_SIZE", "UNKNOWN_TRAIT", "STATEMENT_NOT_CHALLENGED",
      "SHUT_DOWN_NOT_OFFERED", "TRAIT_FEATURE_NOT_OFFERED", "UNKNOWN_SFX"] ) {
      expect(lang.CORTEX.Character.Errors[code], code).toBeTypeOf("string");
    }
  });

  it("has a hint string for every code ratingGuidance can return", () => {
    const source = readFileSync(resolve(ROOT, "module/rules/sheet-hints.mjs"), "utf8");
    const codes = new Set([...source.matchAll(/hints\.push\("([A-Z_]+)"\)/g)].map(m => m[1]));
    expect([...codes].sort()).toEqual(["RATING_CONFLICTS_WITH_SET", "RATING_OUTSIDE_GUIDANCE"]);
    expect(Object.keys(lang.CORTEX.Sheet.Hints).sort()).toEqual([...codes].sort());
  });

  it("has every string the sheet and its template use", () => {
    const used = new Set();
    for ( const path of ["module/apps/character-sheet.mjs", "templates/actor/character-sheet.hbs", "templates/actor/sfx-list.hbs",
      "module/cortex-prime.mjs"] ) {
      const source = readFileSync(resolve(ROOT, path), "utf8");
      for ( const match of source.matchAll(/"(CORTEX\.Sheet\.[A-Za-z.]+)"/g) ) used.add(match[1]);
    }
    expect(used.size).toBeGreaterThanOrEqual(10);
    for ( const key of used ) {
      const value = key.split(".").reduce((node, part) => node?.[part], lang);
      expect(value, key).toBeTypeOf("string");
    }
  });
});
