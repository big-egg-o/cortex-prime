import { describe, expect, it } from "vitest";
import { diffCharacterTraits } from "../../module/rules/traits.mjs";

const INVALID = { ok: false, code: "INVALID_TRAIT_DATA" };
const DUPLICATE = { ok: false, code: "DUPLICATE_TRAIT_ID" };

/**
 * A 16-character id built from a short readable name, padded with "x".
 * @param {string} name
 * @returns {string}
 */
function id(name) {
  const value = name.padEnd(16, "x");
  if ( !/^[a-zA-Z0-9]{16}$/.test(value) ) throw new Error(`not a usable test id: ${name}`);
  return value;
}

const KIND = id("kindPC");
const ATTRS = id("setAttrs");
const SKILLS = id("setSkills");
const DISTS = id("setDists");

/** @returns {object} a set entry; its defId is null unless a definition name is given */
function entry(name, dice, defName = null) {
  return { id: id(name), defId: defName === null ? null : id(defName), name, dice };
}

/** @returns {object} a free trait */
function free(name, dice) {
  return { id: id(name), name, dice };
}

/** @returns {object} a character's system data */
function character({ kindId = KIND, traits = {}, freeTraits = [] } = {}) {
  return { schemaVersion: 1, kindId, traits, freeTraits };
}

/**
 * Attributes Physical d8 and Mental d6, the skill Fight d6+d8 (a mixed rating that a same-size set
 * would no longer accept) and the free trait Shotgun d8.
 * @returns {object}
 */
function sample() {
  return character({
    traits: {
      [ATTRS]: { entries: [entry("physical", [8], "defPhysical"), entry("mental", [6], "defMental")] },
      [SKILLS]: { entries: [entry("fight", [6, 8], "defFight")] }
    },
    freeTraits: [free("shotgun", [8])]
  });
}

/**
 * A character whose attribute set holds a legacy duplicate "twin" (defA d6, defB d8) and Mental d6.
 * @param {object[]} [twins] - the copies of "twin" to use instead
 * @returns {object}
 */
function withTwins(twins = [entry("twin", [6], "defA"), entry("twin", [8], "defB")]) {
  return character({
    traits: {
      [ATTRS]: { entries: [...twins, entry("mental", [6], "defMental")] },
      [SKILLS]: { entries: [] }
    }
  });
}

/** @returns {object[]} three copies of "twin" to pass to withTwins: defA d6, defB d8 and defC d10 */
function triplets() {
  return [entry("twin", [6], "defA"), entry("twin", [8], "defB"), entry("twin", [10], "defC")];
}

/**
 * A character holding "twin" d8 without a definition id three times, the same contents in three
 * places: in the attributes, in the skills and as a free trait.
 * @returns {object}
 */
function spread() {
  return character({
    traits: { [ATTRS]: { entries: [entry("twin", [8])] }, [SKILLS]: { entries: [entry("twin", [8])] } },
    freeTraits: [free("twin", [8])]
  });
}

/** @returns {object} a fresh sample with one change applied */
function broken(change) {
  const data = sample();
  change(data);
  return data;
}

/** @returns {object} the expected record for one entry */
function record(setId, name, { entered = false, diceChanged = false, defIdChanged = false, dice, def = null }) {
  return { setId, id: id(name), entered, diceChanged, defIdChanged, dice, defId: def === null ? null : id(def) };
}

/** @returns {object} the value diffCharacterTraits returns when nothing needs checking */
function nothing(kindId = KIND) {
  return { kindChanged: false, kindId, addedSetIds: [], removedSetIds: [], entries: [], removedEntryIds: [] };
}

/** @returns {object} the value of a diff that must succeed */
function diff(current, proposed) {
  const result = diffCharacterTraits(current, proposed);
  expect(result.ok, `refused with ${result.code}`).toBe(true);
  return result.value;
}

/** @param {*} value @returns {*} the same value, frozen all the way down */
function deepFreeze(value) {
  if ( value && typeof value === "object" && !Object.isFrozen(value) ) {
    Object.freeze(value);
    for ( const key of Object.keys(value) ) deepFreeze(value[key]);
  }
  return value;
}

describe("diffCharacterTraits: nothing to check", () => {
  it("reports nothing when both states are the same object", () => {
    const data = sample();
    expect(diffCharacterTraits(data, data)).toEqual({ ok: true, value: nothing() });
  });

  it("reports nothing for a resubmitted copy of every entry", () => {
    expect(diffCharacterTraits(sample(), structuredClone(sample()))).toEqual({ ok: true, value: nothing() });
  });

  it("ignores the order of entries within a set and of the set keys", () => {
    const current = sample();
    const copy = structuredClone(current);
    const proposed = character({
      traits: { [SKILLS]: copy.traits[SKILLS], [ATTRS]: { entries: copy.traits[ATTRS].entries.reverse() } },
      freeTraits: copy.freeTraits
    });
    expect(diff(current, proposed)).toEqual(nothing());
  });

  it("compares dice as a multiset: reordered dice are not a change", () => {
    const proposed = sample();
    proposed.traits[SKILLS].entries[0].dice = [8, 6];
    expect(diff(sample(), proposed)).toEqual(nothing());

    const mob = character({ traits: { [SKILLS]: { entries: [entry("mob", [6, 6, 8], "defMob")] } } });
    const reordered = character({ traits: { [SKILLS]: { entries: [entry("mob", [6, 8, 6], "defMob")] } } });
    expect(diff(mob, reordered)).toEqual(nothing());
  });

  it("doesn't report a name-only change", () => {
    const proposed = sample();
    proposed.traits[ATTRS].entries[0].name = "Body";
    proposed.freeTraits[0].name = "Sawn-off";
    expect(diff(sample(), proposed)).toEqual(nothing());
  });

  it("doesn't recheck an unchanged mixed-size rating while another entry changes", () => {
    const proposed = sample();
    proposed.traits[ATTRS].entries[1].dice = [10];
    expect(diff(sample(), proposed).entries).toEqual([
      record(ATTRS, "mental", { diceChanged: true, dice: [10], def: "defMental" })
    ]);
  });

  it("doesn't recheck an unchanged definition id, which may no longer exist", () => {
    // Without a game configuration every defId is as unknown as an orphaned one.
    const proposed = sample();
    proposed.traits[ATTRS].entries[0].name = "Body";
    proposed.traits[SKILLS].entries[0].dice = [6, 10];
    expect(diff(sample(), proposed).entries).toEqual([
      record(SKILLS, "fight", { diceChanged: true, dice: [6, 10], def: "defFight" })
    ]);
  });
});

describe("diffCharacterTraits: ratings, definition ids and kind", () => {
  it("reports a changed rating", () => {
    const proposed = sample();
    proposed.traits[SKILLS].entries[0].dice = [6, 10];
    expect(diffCharacterTraits(sample(), proposed)).toEqual({
      ok: true,
      value: { ...nothing(), entries: [record(SKILLS, "fight", { diceChanged: true, dice: [6, 10], def: "defFight" })] }
    });
  });

  it("reports a change in the number of dice, including a rating that loses or gains all its dice", () => {
    for ( const [before, after] of [[[8], [8, 8]], [[6, 6], [6]], [[8], []], [[], [6]]] ) {
      const current = character({ traits: { [ATTRS]: { entries: [entry("trait", before)] } } });
      const proposed = character({ traits: { [ATTRS]: { entries: [entry("trait", after)] } } });
      expect(diff(current, proposed).entries).toEqual([record(ATTRS, "trait", { diceChanged: true, dice: after })]);
    }
  });

  it("reports a new non-null definition id, but not one cleared to null", () => {
    const changed = sample();
    changed.traits[ATTRS].entries[0].defId = id("defBody");
    expect(diff(sample(), changed).entries).toEqual([
      record(ATTRS, "physical", { defIdChanged: true, dice: [8], def: "defBody" })
    ]);

    const cleared = sample();
    cleared.traits[ATTRS].entries[0].defId = null;
    expect(diff(sample(), cleared)).toEqual(nothing());
    expect(diff(cleared, sample()).entries).toEqual([
      record(ATTRS, "physical", { defIdChanged: true, dice: [8], def: "defPhysical" })
    ]);
  });

  it("reports a new entry as entered, with defIdChanged only when it has a definition id", () => {
    const proposed = sample();
    proposed.traits[SKILLS].entries.push(entry("sneak", [4], "defSneak"), entry("custom", [6]));
    expect(diff(sample(), proposed).entries).toEqual([
      record(SKILLS, "sneak", { entered: true, diceChanged: true, defIdChanged: true, dice: [4], def: "defSneak" }),
      record(SKILLS, "custom", { entered: true, diceChanged: true, dice: [6] })
    ]);
  });

  it("reports whether the kind changed, and always the proposed kind", () => {
    const other = id("kindMob");
    const cases = [[null, KIND, true], [KIND, other, true], [KIND, null, true], [KIND, KIND, false], [null, null, false]];
    for ( const [before, after, changed] of cases ) {
      expect(diff(character({ kindId: before }), character({ kindId: after })))
        .toEqual({ ...nothing(after), kindChanged: changed });
    }
  });

  it("reports a changed [7] without checking die sizes, which the configuration check does later", () => {
    const proposed = sample();
    proposed.traits[ATTRS].entries[0].dice = [7];
    expect(diff(sample(), proposed).entries).toEqual([
      record(ATTRS, "physical", { diceChanged: true, dice: [7], def: "defPhysical" })
    ]);
  });
});

describe("diffCharacterTraits: trait sets", () => {
  it("reports a new empty set", () => {
    const proposed = sample();
    proposed.traits[DISTS] = { entries: [] };
    expect(diff(sample(), proposed)).toEqual({ ...nothing(), addedSetIds: [DISTS] });
  });

  it("reports a new set and each entry in it as entered", () => {
    const proposed = sample();
    proposed.traits[DISTS] = { entries: [entry("cult", [8]), entry("veteran", [8])] };
    expect(diff(sample(), proposed)).toEqual({
      ...nothing(),
      addedSetIds: [DISTS],
      entries: [
        record(DISTS, "cult", { entered: true, diceChanged: true, dice: [8] }),
        record(DISTS, "veteran", { entered: true, diceChanged: true, dice: [8] })
      ]
    });
  });

  it("reports a deleted set and its entries as removed, with nothing to check", () => {
    const proposed = sample();
    delete proposed.traits[SKILLS];
    expect(diff(sample(), proposed)).toEqual({ ...nothing(), removedSetIds: [SKILLS], removedEntryIds: [id("fight")] });
  });

  it("lists added and removed sets in key order", () => {
    const powers = id("setPowers");
    const proposed = character({ traits: { [powers]: { entries: [] }, [DISTS]: { entries: [] } } });
    expect(diff(sample(), proposed)).toEqual({
      ...nothing(),
      addedSetIds: [powers, DISTS],
      removedSetIds: [ATTRS, SKILLS],
      removedEntryIds: [id("physical"), id("mental"), id("fight"), id("shotgun")]
    });
  });
});

describe("diffCharacterTraits: moved entries", () => {
  it("treats an entry moved to another set as entering it, its definition id included", () => {
    const proposed = sample();
    const [physical] = proposed.traits[ATTRS].entries.splice(0, 1);
    proposed.traits[SKILLS].entries.push(physical);
    expect(diff(sample(), proposed)).toEqual({
      ...nothing(),
      entries: [
        record(SKILLS, "physical", { entered: true, diceChanged: true, defIdChanged: true, dice: [8], def: "defPhysical" })
      ]
    });
  });

  it("moves an entry without a definition id with defIdChanged false", () => {
    const current = character({ traits: { [DISTS]: { entries: [entry("cult", [8])] }, [ATTRS]: { entries: [] } } });
    const proposed = character({ traits: { [DISTS]: { entries: [] }, [ATTRS]: { entries: [entry("cult", [8])] } } });
    expect(diff(current, proposed).entries).toEqual([record(ATTRS, "cult", { entered: true, diceChanged: true, dice: [8] })]);
  });

  it("treats moves between a set and the free traits as entering the new place", () => {
    const toSet = sample();
    toSet.traits[ATTRS].entries.push({ ...toSet.freeTraits.pop(), defId: null });
    expect(diff(sample(), toSet).entries).toEqual([
      record(ATTRS, "shotgun", { entered: true, diceChanged: true, dice: [8] })
    ]);

    const toFree = sample();
    const [mental] = toFree.traits[ATTRS].entries.splice(1, 1);
    toFree.freeTraits.push(mental); // it still carries its defId, which a free trait ignores
    expect(diff(sample(), toFree).entries).toEqual([
      record(null, "mental", { entered: true, diceChanged: true, dice: [6] })
    ]);
  });
});

describe("diffCharacterTraits: free traits", () => {
  it("reports an added free trait and a free trait whose dice change", () => {
    const proposed = sample();
    proposed.freeTraits[0].dice = [10];
    proposed.freeTraits.push(free("lawman", [8]));
    expect(diff(sample(), proposed).entries).toEqual([
      record(null, "shotgun", { diceChanged: true, dice: [10] }),
      record(null, "lawman", { entered: true, diceChanged: true, dice: [8] })
    ]);
  });

  it("lists a removed free trait in removedEntryIds", () => {
    const proposed = sample();
    proposed.freeTraits = [];
    expect(diff(sample(), proposed)).toEqual({ ...nothing(), removedEntryIds: [id("shotgun")] });
  });

  it("doesn't report renamed or reordered free traits", () => {
    const current = character({ freeTraits: [free("shotgun", [8]), free("outOfShape", [4])] });
    const proposed = character({ freeTraits: [free("outOfShape", [4]), { ...free("shotgun", [8]), name: "Sawn-off" }] });
    expect(diff(current, proposed)).toEqual(nothing());
  });

  it("ignores any defId on a free trait: free traits never carry a definition reference", () => {
    const proposed = sample();
    proposed.freeTraits[0].defId = id("defShotgun");
    expect(diff(sample(), proposed)).toEqual(nothing());
  });
});

describe("diffCharacterTraits: duplicate ids", () => {
  it("lets an unchanged duplicate group through and reports only the unrelated edit", () => {
    const proposed = withTwins();
    proposed.traits[ATTRS].entries[2].dice = [10];
    expect(diff(withTwins(), proposed)).toEqual({
      ...nothing(),
      entries: [record(ATTRS, "mental", { diceChanged: true, dice: [10], def: "defMental" })]
    });
  });

  it("lets an unchanged duplicate across two sets through, with its dice and sets in another order", () => {
    const current = character({ traits: {
      [ATTRS]: { entries: [entry("twin", [6, 8], "defA")] },
      [SKILLS]: { entries: [entry("twin", [8], "defB")] }
    } });
    const proposed = character({ traits: {
      [SKILLS]: { entries: [entry("twin", [8], "defB")] },
      [ATTRS]: { entries: [entry("twin", [8, 6], "defA")] }
    } });
    expect(diff(current, proposed)).toEqual(nothing());
  });

  it("refuses a newly introduced duplicate in one set, even an identical copy", () => {
    const proposed = sample();
    proposed.traits[ATTRS].entries.push(entry("mental", [6], "defMental"));
    expect(diffCharacterTraits(sample(), proposed)).toEqual(DUPLICATE);
  });

  it("refuses a newly introduced duplicate across sets and between a set and the free traits", () => {
    const acrossSets = sample();
    acrossSets.traits[SKILLS].entries.push(entry("physical", [8], "defPhysical"));
    expect(diffCharacterTraits(sample(), acrossSets)).toEqual(DUPLICATE);

    const setAndFree = sample();
    setAndFree.freeTraits.push(free("physical", [8]));
    expect(diffCharacterTraits(sample(), setAndFree)).toEqual(DUPLICATE);
  });

  it("refuses the whole edit when a new duplicate comes with an unrelated edit or a repair", () => {
    const unrelated = sample();
    unrelated.traits[SKILLS].entries[0].dice = [6, 10];
    unrelated.freeTraits.push(free("physical", [8]));
    expect(diffCharacterTraits(sample(), unrelated)).toEqual(DUPLICATE);

    const repaired = withTwins([entry("twin", [6], "defA"), entry("twin", [8], "defB")]); // a valid repair
    repaired.traits[ATTRS].entries.push(entry("mental", [6], "defMental"));
    expect(diffCharacterTraits(withTwins(triplets()), repaired)).toEqual(DUPLICATE);
  });

  it("refuses a duplicate group with a changed, moved or extra copy", () => {
    const moved = withTwins([entry("twin", [6], "defA")]);
    moved.traits[SKILLS].entries.push(entry("twin", [8], "defB"));
    const changed = [
      withTwins([entry("twin", [10], "defA"), entry("twin", [8], "defB")]), // one copy's dice
      withTwins([entry("twin", [6], "defA"), entry("twin", [8], "defC")]), // one copy's defId
      withTwins([entry("twin", [6], "defA"), entry("twin", [8], "defB"), entry("twin", [4])]), // a third copy
      withTwins([entry("twin", [6], "defA"), entry("twin", [8], "defB"), entry("twin", [6], "defA")]), // an identical one
      moved // one copy moved to another set
    ];
    for ( const proposed of changed ) expect(diffCharacterTraits(withTwins(), proposed)).toEqual(DUPLICATE);
  });

  it("lets a name-only change inside a duplicate group through", () => {
    const proposed = withTwins([{ ...entry("twin", [6], "defA"), name: "Older twin" }, entry("twin", [8], "defB")]);
    expect(diff(withTwins(), proposed)).toEqual(nothing());
  });

  it("lets a repair remove a copy: a survivor matching one earlier copy completely needs no check", () => {
    for ( const survivor of [entry("twin", [6], "defA"), entry("twin", [8], "defB")] ) {
      expect(diff(withTwins(), withTwins([survivor]))).toEqual(nothing());
    }
  });

  it("checks a survivor that matches no earlier copy completely against the first copy, never property by property", () => {
    // Regression: defA matches the first copy and d8 the second, but no copy had both.
    expect(diff(withTwins(), withTwins([entry("twin", [8], "defA")])).entries).toEqual([
      record(ATTRS, "twin", { diceChanged: true, dice: [8], def: "defA" })
    ]);
    // The same baseline, the first copy (defA d6): here only the definition id differs from it.
    expect(diff(withTwins(), withTwins([entry("twin", [6], "defB")])).entries).toEqual([
      record(ATTRS, "twin", { defIdChanged: true, dice: [6], def: "defB" })
    ]);
  });

  it("lets a repair remove one copy of three when the copies left match earlier ones", () => {
    const [a, b, c] = triplets();
    for ( const left of [[a, b], [a, c], [b, c]] ) {
      // The whole result: nothing to check, and the id isn't in removedEntryIds, as it is still there.
      expect(diffCharacterTraits(withTwins(triplets()), withTwins(left))).toEqual({ ok: true, value: nothing() });
    }
  });

  it("refuses a repair that leaves a copy no earlier copy matches, never property by property", () => {
    const changed = [
      [entry("twin", [6], "defA"), entry("twin", [12], "defC")], // a new rating
      [entry("twin", [6], "defA"), entry("twin", [10], "defD")], // a new definition id
      [entry("twin", [6], "defA"), entry("twin", [8], "defC")] // d8 from one copy, defC from another
    ];
    for ( const left of changed ) expect(diffCharacterTraits(withTwins(triplets()), withTwins(left))).toEqual(DUPLICATE);
  });

  it("matches each earlier copy at most once", () => {
    const six = () => entry("twin", [6], "defA");
    const eight = () => entry("twin", [8], "defB");
    expect(diffCharacterTraits(withTwins(triplets()), withTwins([six(), six()]))).toEqual(DUPLICATE);

    // With two equal earlier copies both may stay, but the third can't be kept twice.
    const current = withTwins([six(), six(), eight()]);
    expect(diff(current, withTwins([six(), six()]))).toEqual(nothing());
    expect(diffCharacterTraits(current, withTwins([eight(), eight()]))).toEqual(DUPLICATE);
  });

  it("tells copies apart by place, the free traits included, when a repair removes one", () => {
    const emptied = spread();
    emptied.traits[SKILLS].entries = [];
    expect(diff(spread(), emptied)).toEqual(nothing());

    const deleted = spread();
    delete deleted.traits[SKILLS];
    expect(diff(spread(), deleted)).toEqual({ ...nothing(), removedSetIds: [SKILLS] });

    const freed = spread();
    freed.freeTraits = [];
    expect(diff(spread(), freed)).toEqual(nothing());
  });

  it("refuses a copy moved to another place while its id stays duplicated", () => {
    const toSet = withTwins([entry("twin", [6], "defA")]); // defB moved to the skills, defC removed
    toSet.traits[SKILLS].entries.push(entry("twin", [8], "defB"));
    expect(diffCharacterTraits(withTwins(triplets()), toSet)).toEqual(DUPLICATE);

    const together = spread(); // the skills copy moved next to the attributes copy, the free copy removed
    together.traits[ATTRS].entries.push(entry("twin", [8]));
    together.traits[SKILLS].entries = [];
    together.freeTraits = [];
    expect(diffCharacterTraits(spread(), together)).toEqual(DUPLICATE);

    const fromFree = spread(); // the free copy moved into a new set, the attributes copy removed
    fromFree.traits[DISTS] = { entries: [{ ...fromFree.freeTraits.pop(), defId: null }] };
    fromFree.traits[ATTRS].entries = [];
    expect(diffCharacterTraits(spread(), fromFree)).toEqual(DUPLICATE);
  });

  it("ignores the order and names of the copies a repair leaves", () => {
    const [first, , third] = triplets();
    const left = [{ ...third, name: "Younger twin" }, { ...first, name: "Older twin" }];
    expect(diff(withTwins(triplets()), withTwins(left))).toEqual(nothing());
  });

  it("judges a repair by what the copies hold, because nothing else tells copies of one id apart", () => {
    const current = withTwins([
      { ...entry("twin", [6], "defA"), name: "Alpha" },
      { ...entry("twin", [8], "defA"), name: "Beta" },
      { ...entry("twin", [6], "defA"), name: "Gamma" }
    ]);
    const proposed = withTwins([
      { ...entry("twin", [8], "defA"), name: "Alpha" },
      { ...entry("twin", [6], "defA"), name: "Gamma" }
    ]);
    // By name, Alpha went from d6 to d8 and Beta was removed; by contents, one d6 copy was removed.
    // Both leave the same copies, so the edit is accepted with no rating to check.
    expect(diff(current, proposed)).toEqual(nothing());
  });

  it("keeps the sole-survivor rule when a repair leaves one copy of three", () => {
    expect(diff(withTwins(triplets()), withTwins([entry("twin", [10], "defC")]))).toEqual(nothing());
    // No earlier copy is defA d10, so it is compared with the first copy here, defA d6.
    expect(diff(withTwins(triplets()), withTwins([entry("twin", [10], "defA")])).entries).toEqual([
      record(ATTRS, "twin", { diceChanged: true, dice: [10], def: "defA" })
    ]);
    // A sole survivor in another place entered it.
    const moved = withTwins([]);
    moved.traits[SKILLS].entries.push(entry("twin", [8], "defB"));
    expect(diff(withTwins(triplets()), moved).entries).toEqual([
      record(SKILLS, "twin", { entered: true, diceChanged: true, defIdChanged: true, dice: [8], def: "defB" })
    ]);
  });

  it("lists a duplicate id as removed once all its copies are gone", () => {
    for ( const current of [withTwins(), withTwins(triplets())] ) {
      expect(diff(current, withTwins([]))).toEqual({ ...nothing(), removedEntryIds: [id("twin")] });
    }
  });

  it("treats a copy given a new id during a repair as a new entry", () => {
    const proposed = withTwins([entry("twin", [6], "defA"), entry("twinB", [8], "defB")]);
    expect(diff(withTwins(), proposed).entries).toEqual([
      record(ATTRS, "twinB", { entered: true, diceChanged: true, defIdChanged: true, dice: [8], def: "defB" })
    ]);
  });
});

describe("diffCharacterTraits: malformed data", () => {
  /** @param {(data: object) => void} change @returns {void} expects INVALID_TRAIT_DATA in both positions */
  function expectInvalid(change) {
    expect(diffCharacterTraits(broken(change), sample())).toEqual(INVALID);
    expect(diffCharacterTraits(sample(), broken(change))).toEqual(INVALID);
  }

  it("refuses a state that isn't a plain object, in either position", () => {
    for ( const bad of [null, undefined, [], "character", 8, new (class Character {})()] ) {
      expect(diffCharacterTraits(bad, sample())).toEqual(INVALID);
      expect(diffCharacterTraits(sample(), bad)).toEqual(INVALID);
    }
  });

  it("refuses traits, a set or free traits of the wrong shape", () => {
    const changes = [
      d => { d.traits = []; }, d => { d.traits = null; }, d => { delete d.traits; },
      d => { d.traits[ATTRS] = null; }, d => { d.traits[ATTRS] = []; }, d => { d.traits[ATTRS] = {}; },
      d => { d.traits[ATTRS] = { entries: {} }; },
      d => { d.freeTraits = {}; }, d => { d.freeTraits = null; }, d => { delete d.freeTraits; }
    ];
    for ( const change of changes ) expectInvalid(change);
  });

  it("refuses an entry that isn't a plain object, and a gap in a list of entries", () => {
    const changes = [
      d => { d.traits[ATTRS].entries[0] = null; }, d => { d.traits[ATTRS].entries[0] = "physical"; },
      d => { d.traits[ATTRS].entries[0] = [8]; }, d => { d.freeTraits[0] = null; },
      d => { d.traits[ATTRS].entries.length = 3; } // leaves an empty slot at index 2
    ];
    for ( const change of changes ) expectInvalid(change);
  });

  it("refuses an entry id that isn't 16 letters or digits", () => {
    for ( const bad of [undefined, null, "", 16, "physical", `${id("physical")}x`, "physical-xxxxxxx", "physical xxxxxxx"] ) {
      expectInvalid(d => { d.traits[ATTRS].entries[0].id = bad; });
      expectInvalid(d => { d.freeTraits[0].id = bad; });
    }
  });

  it("refuses a set key that isn't 16 letters or digits", () => {
    for ( const bad of ["attributes", "", "16", `${id("setAttrs")}x`, "set-attrsxxxxxxx"] ) {
      expectInvalid(d => { d.traits = { [bad]: { entries: [] } }; });
    }
  });

  it("refuses a kindId that is neither null nor 16 letters or digits", () => {
    expectInvalid(d => { delete d.kindId; });
    for ( const bad of ["", 16, "pc", `${KIND}x`, "kind-xxxxxxxxxxx"] ) expectInvalid(d => { d.kindId = bad; });
  });

  it("refuses dice that aren't an array; the die sizes themselves are checked later", () => {
    for ( const bad of ["8", 8, undefined, null, { 0: 8 }] ) {
      expectInvalid(d => { d.traits[ATTRS].entries[0].dice = bad; });
      expectInvalid(d => { d.freeTraits[0].dice = bad; });
    }
  });

  it("refuses a set entry's defId that is neither null nor 16 letters or digits, and reads a missing one as null", () => {
    for ( const bad of ["", "defPhysical", 16, `${id("defPhysical")}x`] ) {
      expectInvalid(d => { d.traits[ATTRS].entries[0].defId = bad; });
    }

    const missing = { id: id("cult"), name: "Cult", dice: [8] };
    expect(diff(character({ traits: { [ATTRS]: { entries: [missing] } } }),
      character({ traits: { [ATTRS]: { entries: [entry("cult", [8])] } } }))).toEqual(nothing());
    expect(diff(character({ traits: { [ATTRS]: { entries: [] } } }),
      character({ traits: { [ATTRS]: { entries: [missing] } } })).entries)
      .toEqual([record(ATTRS, "cult", { entered: true, diceChanged: true, dice: [8] })]);
  });

  it("reports malformed data before duplicate ids, in current or proposed", () => {
    const both = sample();
    both.traits[ATTRS].entries.push(entry("mental", [6], "defMental")); // a new duplicate
    both.freeTraits = null; // and malformed data
    expect(diffCharacterTraits(sample(), both)).toEqual(INVALID);
    expect(diffCharacterTraits(both, sample())).toEqual(INVALID);
  });
});

describe("diffCharacterTraits: purity and order", () => {
  it("never changes its inputs, frozen or not, and returns arrays of its own", () => {
    const current = sample();
    const proposed = sample();
    proposed.traits[ATTRS].entries[0].dice = [10];
    const snapshot = structuredClone(proposed);

    expect(diff(current, proposed).entries).toHaveLength(1);
    expect(current).toEqual(sample());
    expect(proposed).toEqual(snapshot);

    const result = diff(deepFreeze(current), deepFreeze(proposed));
    expect(result.entries[0].dice).not.toBe(proposed.traits[ATTRS].entries[0].dice);
    result.entries[0].dice.push(12);
    expect(proposed.traits[ATTRS].entries[0].dice).toEqual([10]);
  });

  it("lists entries and removed ids in a fixed order, and gives the same result every time", () => {
    const current = character({
      traits: {
        [ATTRS]: { entries: [entry("physical", [8], "defPhysical"), entry("mental", [6], "defMental")] },
        [SKILLS]: { entries: [entry("fight", [6, 8], "defFight"), entry("sneak", [4], "defSneak")] }
      },
      freeTraits: [free("shotgun", [8]), free("rope", [6])]
    });
    const proposed = character({
      traits: {
        [SKILLS]: { entries: [entry("fight", [10], "defFight")] },
        [ATTRS]: { entries: [entry("mental", [12], "defMental"), entry("physical", [10], "defPhysical")] }
      },
      freeTraits: [free("shotgun", [10])]
    });

    const result = diff(current, proposed);
    // Proposed order: sets in key order, entries in array order, then free traits.
    expect(result.entries.map(e => e.id)).toEqual([id("fight"), id("mental"), id("physical"), id("shotgun")]);
    // Current order of first appearance.
    expect(result.removedEntryIds).toEqual([id("sneak"), id("rope")]);
    expect(diff(current, proposed)).toEqual(result);
  });
});
