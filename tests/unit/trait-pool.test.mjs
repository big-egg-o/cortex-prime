import { describe, expect, it } from "vitest";
import { buildPool } from "../../module/rules/pool.mjs";
import { defaultGameConfig, traitSetById } from "../../module/rules/game-config.mjs";
import { effectiveRating, poolTraitCost, traitPoolEntries } from "../../module/rules/trait-pool.mjs";

const DISTINCTIONS = "cpSetDistinction";
const ATTRIBUTES = "cpSetAttributes0";
const SKILLS = "cpSetSkills00000";
const PC = "cpKindPlayerChar";
const MINOR = "cpKindMinorGmc00";
const ACTOR = "actor00000000001";
const OTHER_ACTOR = "actor00000000002";
const LOCATION = "location00000001";

/** A set like the defaults' with the given fields changed. */
function setWith(id, fields) {
  return { ...traitSetById(defaultGameConfig(), id), ...fields };
}

/** Two power sets of the "other" role, one die per power, no fallback (Handbook p. 51-52). */
function configWithPowers() {
  const config = defaultGameConfig();
  for ( const id of ["cpSetPowersFire0", "cpSetPowersFlyin"] ) {
    config.traitSets.push({
      ...traitSetById(config, DISTINCTIONS), id, name: `Powers ${id}`, role: "other", startingRating: 6,
      features: { ...traitSetById(config, DISTINCTIONS).features, hinder: false }
    });
  }
  return config;
}

const pick = (setId, traitId, flags = {}) => ({ setId, traitId, ...flags });
const refused = code => ({ ok: false, code });

describe("effectiveRating (rules 1-3, 8)", () => {
  it("TS-01 a distinction rated [8] gives one d8", () => {
    const entry = { id: "e000000000000001", defId: null, name: "Apocalyptic Cult Survivor", dice: [8] };
    expect(effectiveRating(setWith(DISTINCTIONS, {}), null, entry))
      .toEqual({ ok: true, value: { dice: [8], isFallback: false, warnings: [] } });
  });

  it("TS-03 a skill with no value in a set with a d4 fallback gives a d4 marked as fallback", () => {
    const sneak = traitSetById(defaultGameConfig(), SKILLS).traits.find(t => t.name === "Sneak");
    expect(effectiveRating(setWith(SKILLS, {}), sneak, undefined))
      .toEqual({ ok: true, value: { dice: [4], isFallback: true, warnings: [] } });
  });

  it("TS-03 an empty rating counts as no value (ADR-037, Q1)", () => {
    const sneak = traitSetById(defaultGameConfig(), SKILLS).traits.find(t => t.name === "Sneak");
    const entry = { id: "e000000000000001", defId: sneak.id, name: "Sneak", dice: [] };
    expect(effectiveRating(setWith(SKILLS, {}), sneak, entry).value).toEqual({ dice: [4], isFallback: true, warnings: [] });
  });

  it("TS-E03 a value whose definition the GM deleted is orphaned and ignored: TRAIT_ORPHANED", () => {
    const entry = { id: "e000000000000001", defId: "deletedSkill0000", name: "Old skill", dice: [8] };
    expect(effectiveRating(setWith(SKILLS, {}), null, entry)).toEqual(refused("TRAIT_ORPHANED"));
  });

  it("TS-04 a power with no value in a set with no fallback is refused: TRAIT_UNRATED", () => {
    const powers = configWithPowers().traitSets.find(s => s.id === "cpSetPowersFlyin");
    expect(effectiveRating(powers, null, undefined)).toEqual(refused("TRAIT_UNRATED"));
    expect(effectiveRating(powers, null, { id: "e000000000000001", name: "Flight", dice: [] })).toEqual(refused("TRAIT_UNRATED"));
  });

  it("TS-05 a talent, in a set without dice, is refused: TRAIT_HAS_NO_DICE", () => {
    const talents = setWith(DISTINCTIONS, { hasDice: false, startingRating: null });
    expect(effectiveRating(talents, null, { id: "e000000000000001", name: "Hopeless Romantic", dice: [] }))
      .toEqual(refused("TRAIT_HAS_NO_DICE"));
  });

  it("ADR-037 point 5: dice kept after the set lost its dice give no die", () => {
    const talents = setWith(DISTINCTIONS, { hasDice: false, startingRating: null });
    expect(effectiveRating(talents, null, { id: "e000000000000001", name: "Old", dice: [8] }))
      .toEqual(refused("TRAIT_HAS_NO_DICE"));
  });

  it("TS-06 a mob trait's four d6 are used as stored", () => {
    expect(effectiveRating(null, null, { id: "e000000000000001", name: "Thugs", dice: [6, 6, 6, 6] }).value)
      .toEqual({ dice: [6, 6, 6, 6], isFallback: false, warnings: [] });
  });

  it("ADR-037 point 5: a stored rating that no longer fits its set is used, with a warning", () => {
    const entry = { id: "e000000000000001", name: "Split", dice: [6, 6] };
    expect(effectiveRating(setWith(DISTINCTIONS, {}), null, entry).value)
      .toEqual({ dice: [6, 6], isFallback: false, warnings: [{ code: "RATING_CONFLICTS_WITH_SET" }] });
  });

  it("TS-07 the scene distinction split to [6, 6] is used without a warning in its set", () => {
    const scene = traitSetById(defaultGameConfig(), "cpSetSceneDistin");
    const entry = { id: "e000000000000001", defId: null, name: "Panicked Crowd", dice: [6, 6] };
    const rating = effectiveRating(scene, null, entry);
    expect(rating.value).toEqual({ dice: [6, 6], isFallback: false, warnings: [] });
    expect(traitPoolEntries({ label: "Panicked Crowd", dice: rating.value.dice }).value.map(e => e.size)).toEqual([6, 6]);
    expect(entry.dice).toEqual([6, 6]); // the location keeps its rating
  });

  it("a free trait (no set) with no dice is unrated, since free traits have no fallback", () => {
    expect(effectiveRating(null, null, { id: "e000000000000001", name: "Nobody", dice: [] })).toEqual(refused("TRAIT_UNRATED"));
    expect(effectiveRating(null, null, undefined)).toEqual(refused("TRAIT_UNRATED"));
  });

  it("refuses a stored die size that doesn't exist (TS-E01)", () => {
    expect(effectiveRating(setWith(SKILLS, {}), null, { id: "e000000000000001", name: "Bad", dice: [7] }))
      .toEqual(refused("INVALID_DIE_SIZE"));
    expect(effectiveRating(null, null, { id: "e000000000000001", name: "Bad", dice: "8" })).toEqual(refused("INVALID_DIE_SIZE"));
  });

  it("copies the dice and never changes its inputs", () => {
    const entry = Object.freeze({ id: "e000000000000001", name: "Frozen", dice: Object.freeze([8]) });
    const result = effectiveRating(Object.freeze(setWith(DISTINCTIONS, {})), null, entry);
    expect(result.value.dice).toEqual([8]);
    expect(result.value.dice).not.toBe(entry.dice);
  });
});

describe("traitPoolEntries (rules 11, 16)", () => {
  const trait = (dice, extra = {}) => ({ actorId: ACTOR, traitId: "e000000000000001", label: "Trait", dice, ...extra });

  it("TS-01 one entry per die, with the trait as its source, in the shape buildPool takes", () => {
    const result = traitPoolEntries(trait([8], { label: "Apocalyptic Cult Survivor" }));
    expect(result).toEqual({
      ok: true,
      value: [{ size: 8, source: { kind: "trait", actorId: ACTOR, traitId: "e000000000000001", label: "Apocalyptic Cult Survivor" } }]
    });
    expect(buildPool(result.value)).toEqual([
      { id: "d1", size: 8, origin: "rating", source: result.value[0].source }
    ]);
  });

  it("TS-02 a distinction used with Hinder gives one d4 that reports ppGained 1", () => {
    const result = traitPoolEntries(trait([8]), { hinder: true });
    expect(result.value).toEqual([{ size: 4, source: expect.objectContaining({ kind: "trait" }), ppGained: 1 }]);
    expect(buildPool(result.value).map(d => d.size)).toEqual([4]);
  });

  it("RQ-029 Hinder turns any one die from d6 to d12 into one d4 and gains 1 PP", () => {
    for ( const size of [6, 8, 10, 12] ) {
      expect(traitPoolEntries(trait([size]), { hinder: true }).value)
        .toEqual([{ size: 4, source: expect.objectContaining({ kind: "trait" }), ppGained: 1 }]);
    }
  });

  it("RQ-029 Hinder turns a split rating such as d6 d6 into one d4 and gains 1 PP", () => {
    for ( const dice of [[6, 6], [6, 8], [4, 4], [6, 6, 6, 6]] ) {
      expect(traitPoolEntries(trait(dice), { hinder: true }).value)
        .toEqual([{ size: 4, source: expect.objectContaining({ kind: "trait" }), ppGained: 1 }]);
    }
  });

  it("RQ-029 Hinder on a trait rated d4 keeps the d4, gains no PP and gives the hint HINDER_ALREADY_D4", () => {
    expect(traitPoolEntries(trait([4]), { hinder: true }).value)
      .toEqual([{ size: 4, source: expect.objectContaining({ kind: "trait" }), ppGained: 0, hint: "HINDER_ALREADY_D4" }]);
    expect(traitPoolEntries(trait([4], { isFallback: true }), { hinder: true }).value).toEqual([{
      size: 4, source: expect.objectContaining({ kind: "trait" }), ppGained: 0, hint: "HINDER_ALREADY_D4", isFallback: true
    }]);
  });

  it("RQ-029 Hinder changes only the roll, never the stored rating", () => {
    const dice = Object.freeze([10]);
    const input = Object.freeze(trait(dice));
    expect(traitPoolEntries(input, { hinder: true }).value.map(e => e.size)).toEqual([4]);
    expect(input.dice).toBe(dice);
    expect(dice).toEqual([10]);
  });

  it("TS-03 a fallback die is marked", () => {
    expect(traitPoolEntries(trait([4], { isFallback: true })).value).toEqual([
      { size: 4, source: expect.objectContaining({ kind: "trait" }), isFallback: true }
    ]);
  });

  it("TS-06 a mob trait gives four d6 entries from one source", () => {
    const entries = traitPoolEntries(trait([6, 6, 6, 6], { label: "Thugs" })).value;
    expect(entries.map(e => e.size)).toEqual([6, 6, 6, 6]);
    expect(new Set(entries.map(e => JSON.stringify(e.source))).size).toBe(1);
    expect(buildPool(entries)).toHaveLength(4);
  });

  it("TS-14 a challenged statement triples the die for the roll", () => {
    expect(traitPoolEntries(trait([8]), { challenge: true }).value.map(e => e.size)).toEqual([8, 8, 8]);
  });

  it("TS-16 a challenged d4 gives three d4", () => {
    expect(traitPoolEntries(trait([4]), { challenge: true }).value.map(e => e.size)).toEqual([4, 4, 4]);
  });

  it("a challenge triples each die of a multi-die rating (spec implementation notes)", () => {
    expect(traitPoolEntries(trait([6, 8]), { challenge: true }).value.map(e => e.size)).toEqual([6, 6, 6, 8, 8, 8]);
  });

  it("refuses Hinder together with a challenged statement until RQ-032 is decided", () => {
    expect(traitPoolEntries(trait([8]), { hinder: true, challenge: true })).toEqual(refused("TRAIT_OPTIONS_CONFLICT"));
  });

  it("refuses a trait that isn't shaped like one, without throwing", () => {
    expect(traitPoolEntries(null)).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(traitPoolEntries({ dice: [8] })).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(traitPoolEntries({ dice: [8], label: " " })).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(traitPoolEntries({ dice: [8], label: 5 })).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(traitPoolEntries(trait([8], { actorId: 7 }))).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(traitPoolEntries(trait([8], { isFallback: "no" }))).toEqual(refused("INVALID_TRAIT_DATA"));
  });

  it("refuses a trait with no dice, a die size that doesn't exist and options that aren't booleans", () => {
    expect(traitPoolEntries(trait([]))).toEqual(refused("TRAIT_UNRATED"));
    expect(traitPoolEntries(trait([7]))).toEqual(refused("INVALID_DIE_SIZE"));
    expect(traitPoolEntries(trait([8]), { hinder: "yes" })).toEqual(refused("INVALID_TRAIT_OPTIONS"));
    expect(traitPoolEntries(trait([8]), null)).toEqual(refused("INVALID_TRAIT_OPTIONS"));
  });

  it("leaves out an actor or trait id that isn't given", () => {
    const [entry] = traitPoolEntries({ label: "Custom", dice: [6] }).value;
    expect(entry.source).toEqual({ kind: "trait", label: "Custom" });
  });

  it("never changes its inputs and shares no objects between entries", () => {
    const input = Object.freeze(trait(Object.freeze([6, 6])));
    const entries = traitPoolEntries(input, Object.freeze({})).value;
    expect(entries[0].source).not.toBe(entries[1].source);
  });
});

describe("poolTraitCost (rules 6, 7, 15; RQ-019, RQ-020, RQ-030, RQ-031, ADR-029)", () => {
  const distinction = pick(DISTINCTIONS, "dist000000000001");
  const physical = pick(ATTRIBUTES, "attr000000000001");
  const fight = pick(SKILLS, "fight00000000001");
  const shoot = pick(SKILLS, "shoot00000000001");
  const throwing = pick(SKILLS, "throw00000000001");

  it("TS-08 one trait from each set costs nothing and warns of nothing", () => {
    expect(poolTraitCost([distinction, physical, fight], defaultGameConfig(), PC))
      .toEqual({ ok: true, value: { ppCost: 0, extraTraits: [], unpricedTraits: [], warnings: [] } });
  });

  it("TS-09 a second skill costs 1 PP", () => {
    expect(poolTraitCost([distinction, physical, fight, shoot], defaultGameConfig(), PC).value)
      .toEqual({ ppCost: 1, extraTraits: [{ setId: SKILLS, count: 1 }], unpricedTraits: [], warnings: [] });
  });

  it("TS-09b three skills cost 2 PP (RQ-019)", () => {
    expect(poolTraitCost([distinction, physical, fight, shoot, throwing], defaultGameConfig(), PC).value)
      .toEqual({ ppCost: 2, extraTraits: [{ setId: SKILLS, count: 2 }], unpricedTraits: [], warnings: [] });
  });

  it("TS-10 a set whose game allows no extra traits warns and refuses nothing; the extra trait has no price (RQ-030)", () => {
    const config = defaultGameConfig();
    traitSetById(config, SKILLS).extraTraits = "none";
    expect(poolTraitCost([fight, shoot], config, MINOR)).toEqual({
      ok: true,
      value: {
        ppCost: 0,
        extraTraits: [],
        unpricedTraits: [{ setId: SKILLS, count: 1 }],
        warnings: [{ code: "EXTRA_TRAIT_NOT_ALLOWED", setId: SKILLS }]
      }
    });
  });

  it("RQ-030 counts every unpriced trait by set and still prices extra traits of the other sets", () => {
    const config = defaultGameConfig();
    traitSetById(config, SKILLS).extraTraits = "none";
    const second = pick(DISTINCTIONS, "dist000000000002");
    expect(poolTraitCost([distinction, second, physical, fight, shoot, throwing], config, PC).value).toEqual({
      ppCost: 1,
      extraTraits: [{ setId: DISTINCTIONS, count: 1 }],
      unpricedTraits: [{ setId: SKILLS, count: 2 }],
      warnings: [{ code: "EXTRA_TRAIT_NOT_ALLOWED", setId: SKILLS }]
    });
  });

  it("TS-11 one power from each of two power sets costs nothing", () => {
    const powers = [pick("cpSetPowersFire0", "fire000000000001"), pick("cpSetPowersFlyin", "flight0000000001")];
    expect(poolTraitCost(powers, configWithPowers(), MINOR).value)
      .toEqual({ ppCost: 0, extraTraits: [], unpricedTraits: [], warnings: [] });
  });

  it("TS-12 powers from a shut-down set warn once and are still counted", () => {
    const power = pick("cpSetPowersFire0", "fire000000000001", { setShutDown: true });
    const second = pick("cpSetPowersFire0", "fire000000000002", { setShutDown: true });
    expect(poolTraitCost([power, second], configWithPowers(), MINOR).value).toEqual({
      ppCost: 1,
      extraTraits: [{ setId: "cpSetPowersFire0", count: 1 }],
      unpricedTraits: [],
      warnings: [{ code: "TRAIT_SET_SHUT_DOWN", setId: "cpSetPowersFire0" }]
    });
  });

  it("warns for a shut-down trait id in each set it occurs in", () => {
    const a = pick(ATTRIBUTES, "same000000000001", { traitShutDown: true });
    const b = pick(SKILLS, "same000000000001", { traitShutDown: true });
    expect(poolTraitCost([a, b], defaultGameConfig(), MINOR).value.warnings).toEqual([
      { code: "TRAIT_SHUT_DOWN", setId: ATTRIBUTES, traitId: "same000000000001" },
      { code: "TRAIT_SHUT_DOWN", setId: SKILLS, traitId: "same000000000001" }
    ]);
  });

  it("TS-13 only the shut-down trait warns", () => {
    const strength = pick(ATTRIBUTES, "strength00000001", { traitShutDown: true });
    expect(poolTraitCost([physical], defaultGameConfig(), MINOR).value.warnings).toEqual([]);
    expect(poolTraitCost([strength], defaultGameConfig(), MINOR).value.warnings)
      .toEqual([{ code: "TRAIT_SHUT_DOWN", setId: ATTRIBUTES, traitId: "strength00000001" }]);
  });

  it("TS-17 a PC pool missing skills warns PRIME_SET_MISSING; a missing distinction doesn't (RQ-020, ADR-029)", () => {
    expect(poolTraitCost([distinction, physical], defaultGameConfig(), PC).value.warnings)
      .toEqual([{ code: "PRIME_SET_MISSING", setId: SKILLS }]);
    expect(poolTraitCost([physical, fight], defaultGameConfig(), PC).value.warnings).toEqual([]);
    expect(poolTraitCost([], defaultGameConfig(), PC).value.warnings).toEqual([
      { code: "PRIME_SET_MISSING", setId: ATTRIBUTES }, { code: "PRIME_SET_MISSING", setId: SKILLS }
    ]);
  });

  it("TS-17b a minor GMC kind has no prime sets, so nothing is missing", () => {
    expect(poolTraitCost([pick(null, "lawman0000000001")], defaultGameConfig(), MINOR).value.warnings).toEqual([]);
  });

  it("an actor without a kind, or with one the configuration lacks, gets no prime-set warning", () => {
    expect(poolTraitCost([physical], defaultGameConfig(), null).value.warnings).toEqual([]);
    expect(poolTraitCost([physical], defaultGameConfig(), "noSuchKind000000").value.warnings).toEqual([]);
  });

  it("TS-22 free traits belong to no set, so there is no one-per-set cost between them", () => {
    const free = ["lawman0000000001", "outofshape000001", "shotgun000000001"].map(id => pick(null, id));
    expect(poolTraitCost(free, defaultGameConfig(), MINOR).value)
      .toEqual({ ppCost: 0, extraTraits: [], unpricedTraits: [], warnings: [] });
  });

  it("TS-E05 the same trait twice is not a second trait from its set", () => {
    expect(poolTraitCost([distinction, physical, fight, fight], defaultGameConfig(), PC).value.ppCost).toBe(0);
  });

  it("TS-E06 a distinction used with Hinder still counts as the one distinction", () => {
    const hindered = pick(DISTINCTIONS, "dist000000000001", { hinder: true });
    const second = pick(DISTINCTIONS, "dist000000000002");
    expect(poolTraitCost([hindered, physical, fight], defaultGameConfig(), PC).value.ppCost).toBe(0);
    expect(poolTraitCost([hindered, second, physical, fight], defaultGameConfig(), PC).value)
      .toEqual({ ppCost: 1, extraTraits: [{ setId: DISTINCTIONS, count: 1 }], unpricedTraits: [], warnings: [] });
  });

  it("warns TRAIT_ORPHANED for traits of a set the configuration no longer has, and doesn't count them (ADR-037 point 6)", () => {
    const orphans = [pick("goneSet000000001", "old0000000000001"), pick("goneSet000000001", "old0000000000002")];
    expect(poolTraitCost(orphans, defaultGameConfig(), MINOR).value).toEqual({
      ppCost: 0,
      extraTraits: [],
      unpricedTraits: [],
      warnings: [
        { code: "TRAIT_ORPHANED", setId: "goneSet000000001", traitId: "old0000000000001" },
        { code: "TRAIT_ORPHANED", setId: "goneSet000000001", traitId: "old0000000000002" }
      ]
    });
  });

  it("RQ-031 counts by set: one scene distinction beside a character's own distinction is free, a second costs 1 PP", () => {
    const scene = pick("cpSetSceneDistin", "crowd00000000001", { actorId: LOCATION });
    const another = pick("cpSetSceneDistin", "market0000000001", { actorId: LOCATION });
    const own = { ...distinction, actorId: ACTOR };
    expect(poolTraitCost([own, scene, physical, fight], defaultGameConfig(), PC).value.ppCost).toBe(0);
    expect(poolTraitCost([own, scene, another, physical, fight], defaultGameConfig(), PC).value).toEqual({
      ppCost: 1, extraTraits: [{ setId: "cpSetSceneDistin", count: 1 }], unpricedTraits: [], warnings: []
    });
  });

  it("RQ-031 counts traits of two actors that share a trait id as two traits", () => {
    const mine = pick(SKILLS, "fight00000000001", { actorId: ACTOR });
    const theirs = pick(SKILLS, "fight00000000001", { actorId: OTHER_ACTOR });
    expect(poolTraitCost([mine, theirs], defaultGameConfig(), MINOR).value)
      .toEqual({ ppCost: 1, extraTraits: [{ setId: SKILLS, count: 1 }], unpricedTraits: [], warnings: [] });
    expect(poolTraitCost([mine, { ...mine }], defaultGameConfig(), MINOR).value.ppCost).toBe(0);
  });

  it("RQ-031 never charges free traits, whichever actor they come from", () => {
    const own = pick(null, "shotgun000000001", { actorId: ACTOR });
    const location = ["fog0000000000001", "rubble0000000001"].map(id => pick(null, id, { actorId: LOCATION }));
    expect(poolTraitCost([distinction, physical, fight, own, ...location], defaultGameConfig(), PC).value)
      .toEqual({ ppCost: 0, extraTraits: [], unpricedTraits: [], warnings: [] });
  });

  it("RQ-031 warns for each actor's shut-down or orphaned trait, naming the actor, when two share a trait id", () => {
    const mine = pick(SKILLS, "fight00000000001", { actorId: ACTOR, traitShutDown: true });
    const theirs = pick(SKILLS, "fight00000000001", { actorId: OTHER_ACTOR, traitShutDown: true });
    const goneMine = pick("goneSet000000001", "old0000000000001", { actorId: ACTOR });
    const goneTheirs = pick("goneSet000000001", "old0000000000001", { actorId: OTHER_ACTOR });
    expect(poolTraitCost([mine, theirs, mine, goneMine, goneTheirs], defaultGameConfig(), MINOR).value.warnings).toEqual([
      { code: "TRAIT_SHUT_DOWN", setId: SKILLS, actorId: ACTOR, traitId: "fight00000000001" },
      { code: "TRAIT_SHUT_DOWN", setId: SKILLS, actorId: OTHER_ACTOR, traitId: "fight00000000001" },
      { code: "TRAIT_ORPHANED", setId: "goneSet000000001", actorId: ACTOR, traitId: "old0000000000001" },
      { code: "TRAIT_ORPHANED", setId: "goneSet000000001", actorId: OTHER_ACTOR, traitId: "old0000000000001" }
    ]);
  });

  it("orders warnings: shut-down set and trait by pool order, then extra traits, then missing prime sets", () => {
    const config = defaultGameConfig();
    traitSetById(config, DISTINCTIONS).extraTraits = "none";
    const traits = [
      pick(DISTINCTIONS, "dist000000000001", { traitShutDown: true }),
      pick(DISTINCTIONS, "dist000000000002", { setShutDown: true }),
      pick(DISTINCTIONS, "dist000000000003", { setShutDown: true })
    ];
    expect(poolTraitCost(traits, config, PC).value.warnings).toEqual([
      { code: "TRAIT_SHUT_DOWN", setId: DISTINCTIONS, traitId: "dist000000000001" },
      { code: "TRAIT_SET_SHUT_DOWN", setId: DISTINCTIONS },
      { code: "EXTRA_TRAIT_NOT_ALLOWED", setId: DISTINCTIONS },
      { code: "PRIME_SET_MISSING", setId: ATTRIBUTES },
      { code: "PRIME_SET_MISSING", setId: SKILLS }
    ]);
  });

  it("refuses a pool list that isn't a list of traits, and a configuration without lists", () => {
    expect(poolTraitCost(null, defaultGameConfig(), PC)).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(poolTraitCost([{ setId: 5, traitId: "x" }], defaultGameConfig(), PC)).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(poolTraitCost([{ ...fight, setShutDown: "false" }], defaultGameConfig(), PC)).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(poolTraitCost([{ ...fight, actorId: 7 }], defaultGameConfig(), PC)).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(poolTraitCost([fight], { traitSets: [null], actorKinds: [] }, PC).ok).toBe(true);
    expect(poolTraitCost([fight], {}, PC)).toEqual(refused("INVALID_GAME_CONFIG"));
  });

  it("never changes its inputs", () => {
    const traits = Object.freeze([Object.freeze(fight), Object.freeze(shoot)]);
    expect(poolTraitCost(traits, Object.freeze(defaultGameConfig()), PC).ok).toBe(true);
  });
});
