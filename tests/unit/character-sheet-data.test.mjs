import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RATING_INPUTS, characterSheetView, traitChangesFromInputs
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
    expect(characterSheetView({ ...pcSystem(), kindId: null }, config)).toEqual({ kindStatus: "unassigned", kind: null, sets: [] });
    expect(characterSheetView({ ...pcSystem(), kindId: "noSuchKind000000" }, config))
      .toEqual({ kindStatus: "unknown", kind: null, sets: [] });
  });

  it("shows a kind without sets as having none", () => {
    const view = characterSheetView({ ...pcSystem(), kindId: MINOR_GMC }, defaultGameConfig());
    expect(view).toEqual({ kindStatus: "assigned", kind: { id: MINOR_GMC, name: "Minor GMC" }, sets: [] });
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

describe("character sheet strings", () => {
  it("has a refusal string for every code traitChangesFromInputs can return", () => {
    for ( const code of ["INVALID_TRAIT_DATA", "INVALID_DIE_SIZE"] ) {
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
    for ( const path of ["module/apps/character-sheet.mjs", "templates/actor/character-sheet.hbs", "module/cortex-prime.mjs"] ) {
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
