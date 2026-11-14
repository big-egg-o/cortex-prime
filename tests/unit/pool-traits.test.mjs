import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPool, doubleDie, stepPoolDie } from "../../module/rules/pool.mjs";
import { defaultGameConfig, traitSetById } from "../../module/rules/game-config.mjs";
import {
  addTraitDice, challengedPoolTraits, entriesAfterChallenge, poolDieGroupKey, poolTraitReport, poolTraits,
  rollablePool, traitPoolDice, withoutPoolTraits
} from "../../module/rules/pool-traits.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const lang = JSON.parse(readFileSync(resolve(ROOT, "lang/en.json"), "utf8"));

// Ids from the default configuration (ADR-040).
const PC = "cpKindPlayerChar";
const LOCATION_KIND = "cpKindLocation00";
const DISTINCTIONS = "cpSetDistinction";
const ATTRIBUTES = "cpSetAttributes0";
const SKILLS = "cpSetSkills00000";
const SCENE = "cpSetSceneDistin";
const PHYSICAL = "cpAttrPhysical00";
const SOCIAL = "cpAttrSocial0000";
const MENTAL = "cpAttrMental0000";
const FIGHT = "cpSkillFight0000";
const SHOOT = "cpSkillShoot0000";

const ACTOR = "actor00000000001";
const REF = `Actor.${ACTOR}`;
const LOCATION = "location00000001";
const LOCATION_REF = `Actor.${LOCATION}`;
const SMUGGLER = "entrySmuggler000";
const OPTIMIST = "entryOptimist000";
const E_PHYSICAL = "entryPhysical000";
const E_SOCIAL = "entrySocial00000";
const E_FIGHT = "entryFight000000";
const CROWD = "entryCrowd000000";

/** @returns {object} the object, frozen all the way down */
function deepFreeze(value) {
  if ( value && (typeof value === "object") ) {
    for ( const inner of Object.values(value) ) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/**
 * A player character: two distinctions (one at d4), Physical d8 and Social d8 with a statement,
 * and Fight d8; Mental and the other skills have no entry.
 * @returns {object}
 */
function pcSystem() {
  return {
    schemaVersion: 1,
    kindId: PC,
    traits: {
      [DISTINCTIONS]: { shutDown: false, sfx: [], entries: [
        { id: SMUGGLER, defId: null, name: "Retired Smuggler", dice: [8], sfx: [] },
        { id: OPTIMIST, defId: null, name: "Hopeless Optimist", dice: [4], sfx: [] }
      ] },
      [ATTRIBUTES]: { shutDown: false, sfx: [], entries: [
        { id: E_PHYSICAL, defId: PHYSICAL, name: "Physical", dice: [8], sfx: [] },
        { id: E_SOCIAL, defId: SOCIAL, name: "Social", dice: [8], statement: "I trust no one", sfx: [] }
      ] },
      [SKILLS]: { shutDown: false, sfx: [], entries: [
        { id: E_FIGHT, defId: FIGHT, name: "Fight", dice: [8], sfx: [] }
      ] }
    },
    freeTraits: []
  };
}

/** @returns {object} a location with one scene distinction, d8 */
function locationSystem() {
  return {
    schemaVersion: 1,
    kindId: LOCATION_KIND,
    traits: { [SCENE]: { shutDown: false, sfx: [], entries: [
      { id: CROWD, defId: null, name: "Panicked Crowd", dice: [8], sfx: [] }
    ] } },
    freeTraits: []
  };
}

/** @returns {object} the defaults with the statements feature on the given sets */
function configWithStatements(...setIds) {
  const config = defaultGameConfig();
  for ( const setId of setIds ) traitSetById(config, setId).features.statements = true;
  return config;
}

/** @returns {object[]} the pool after adding each [system, setId, traitId, option, actorId, actorRef] */
function poolOf(config, adds, pool = []) {
  for ( const [system, setId, traitId, option = null, actorId = ACTOR, actorRef = REF] of adds ) {
    const dice = traitPoolDice(system, config, setId, traitId, { actorId, option });
    expect(dice.ok, `${traitId}: ${dice.code}`).toBe(true);
    pool = addTraitDice(pool, dice.value, { actorRef }).value.pool;
  }
  return pool;
}

const refused = code => ({ ok: false, code });

describe("traitPoolDice: the dice a trait the sheet shows puts into a pool", () => {
  it("CS-12 a fixed set's trait gives its stored die, named by its definition", () => {
    const result = traitPoolDice(deepFreeze(pcSystem()), deepFreeze(defaultGameConfig()), ATTRIBUTES, PHYSICAL,
      { actorId: ACTOR });
    expect(result).toEqual({ ok: true, value: {
      setId: ATTRIBUTES, traitId: PHYSICAL, option: null, ratingConflict: false,
      entries: [{ size: 8, source: { kind: "trait", actorId: ACTOR, traitId: PHYSICAL, label: "Physical" } }]
    } });
  });

  it("names a fixed set's trait by its current definition name (TS-E04)", () => {
    const config = defaultGameConfig();
    traitSetById(config, ATTRIBUTES).traits.find(d => d.id === PHYSICAL).name = "Body";
    expect(traitPoolDice(pcSystem(), config, ATTRIBUTES, PHYSICAL).value.entries[0].source.label).toBe("Body");
  });

  it("TS-03 a fixed-set trait the actor holds no entry for gives its fallback die, marked as such", () => {
    const result = traitPoolDice(pcSystem(), defaultGameConfig(), ATTRIBUTES, MENTAL, { actorId: ACTOR });
    expect(result.value.entries).toEqual([
      { size: 4, isFallback: true, source: { kind: "trait", actorId: ACTOR, traitId: MENTAL, label: "Mental" } }
    ]);
  });

  it("an open set's trait gives its stored dice, named by its entry", () => {
    const result = traitPoolDice(pcSystem(), defaultGameConfig(), DISTINCTIONS, SMUGGLER, { actorId: ACTOR });
    expect(result.value.entries).toEqual([
      { size: 8, source: { kind: "trait", actorId: ACTOR, traitId: SMUGGLER, label: "Retired Smuggler" } }
    ]);
  });

  it("CS-13, TS-02 a distinction with Hinder gives one d4 and gains 1 PP", () => {
    const result = traitPoolDice(pcSystem(), defaultGameConfig(), DISTINCTIONS, SMUGGLER, { option: "hinder" });
    expect(result.value.option).toBe("hinder");
    expect(result.value.entries).toEqual([
      { size: 4, ppGained: 1, source: { kind: "trait", traitId: SMUGGLER, label: "Retired Smuggler" } }
    ]);
  });

  it("RQ-029 a distinction already at d4 with Hinder keeps its d4, gains nothing and carries the hint", () => {
    const result = traitPoolDice(pcSystem(), defaultGameConfig(), DISTINCTIONS, OPTIMIST, { option: "hinder" });
    expect(result.value.entries).toEqual([{ size: 4, ppGained: 0, hint: "HINDER_ALREADY_D4",
      source: { kind: "trait", traitId: OPTIMIST, label: "Hopeless Optimist" } }]);
  });

  it("refuses Hinder for a set without the Hinder feature (rule 11)", () => {
    expect(traitPoolDice(pcSystem(), defaultGameConfig(), ATTRIBUTES, PHYSICAL, { option: "hinder" }))
      .toEqual(refused("TRAIT_OPTION_UNAVAILABLE"));
  });

  it("CS-14, TS-14 a challenged statement gives its die three times", () => {
    const result = traitPoolDice(pcSystem(), configWithStatements(ATTRIBUTES), ATTRIBUTES, SOCIAL, { option: "challenge" });
    expect(result.value.option).toBe("challenge");
    expect(result.value.entries.map(e => e.size)).toEqual([8, 8, 8]);
  });

  it("refuses a challenge where there is no statement to challenge (rule 16)", () => {
    expect(traitPoolDice(pcSystem(), defaultGameConfig(), ATTRIBUTES, SOCIAL, { option: "challenge" }))
      .toEqual(refused("TRAIT_OPTION_UNAVAILABLE"));
    expect(traitPoolDice(pcSystem(), configWithStatements(ATTRIBUTES), ATTRIBUTES, PHYSICAL, { option: "challenge" }))
      .toEqual(refused("TRAIT_OPTION_UNAVAILABLE"));
    expect(traitPoolDice(pcSystem(), configWithStatements(ATTRIBUTES), ATTRIBUTES, MENTAL, { option: "challenge" }))
      .toEqual(refused("TRAIT_OPTION_UNAVAILABLE"));
  });

  it("refuses a challenge whose step-down would be refused: several dice (RQ-033) or no stored rating", () => {
    const system = locationSystem();
    system.traits[SCENE].entries[0] = { ...system.traits[SCENE].entries[0], dice: [6, 6], statement: "Everyone runs" };
    expect(traitPoolDice(system, configWithStatements(SCENE), SCENE, CROWD, { option: "challenge" }))
      .toEqual(refused("STATEMENT_RATING_NOT_ONE_DIE"));

    const pc = pcSystem();
    pc.traits[ATTRIBUTES].entries[1].dice = [];
    expect(traitPoolDice(pc, configWithStatements(ATTRIBUTES), ATTRIBUTES, SOCIAL, { option: "challenge" }))
      .toEqual(refused("TRAIT_UNRATED"));
  });

  it("refuses what gives no die: a set without dice (rule 3), or an empty rating without fallback (TS-04)", () => {
    const config = defaultGameConfig();
    traitSetById(config, DISTINCTIONS).hasDice = false;
    expect(traitPoolDice(pcSystem(), config, DISTINCTIONS, SMUGGLER)).toEqual(refused("TRAIT_HAS_NO_DICE"));

    const system = pcSystem();
    system.traits[DISTINCTIONS].entries[0].dice = [];
    expect(traitPoolDice(system, defaultGameConfig(), DISTINCTIONS, SMUGGLER)).toEqual(refused("TRAIT_UNRATED"));
  });

  it("marks a stored rating that no longer fits its set and still gives its dice (ADR-037 point 5)", () => {
    const system = pcSystem();
    system.traits[ATTRIBUTES].entries[0].dice = [8, 6];
    const result = traitPoolDice(system, defaultGameConfig(), ATTRIBUTES, PHYSICAL);
    expect(result.value.ratingConflict).toBe(true);
    expect(result.value.entries.map(e => e.size)).toEqual([8, 6]);
  });

  it("refuses a set or trait the configuration or actor doesn't have, and an unnamed open-set trait", () => {
    expect(traitPoolDice(pcSystem(), defaultGameConfig(), "noSuchSet0000000", PHYSICAL)).toEqual(refused("UNKNOWN_TRAIT_SET"));
    expect(traitPoolDice(pcSystem(), defaultGameConfig(), ATTRIBUTES, "noSuchDef0000000")).toEqual(refused("UNKNOWN_TRAIT"));
    expect(traitPoolDice(pcSystem(), defaultGameConfig(), DISTINCTIONS, "noSuchEntry00000")).toEqual(refused("UNKNOWN_TRAIT"));
    // A fixed set's trait is named by its definition id, not by the entry's id.
    expect(traitPoolDice(pcSystem(), defaultGameConfig(), ATTRIBUTES, E_PHYSICAL)).toEqual(refused("UNKNOWN_TRAIT"));
    const system = pcSystem();
    system.traits[DISTINCTIONS].entries[0].name = "  ";
    expect(traitPoolDice(system, defaultGameConfig(), DISTINCTIONS, SMUGGLER)).toEqual(refused("TRAIT_UNNAMED"));
  });

  it("refuses input it can't read and options that don't exist", () => {
    expect(traitPoolDice(null, defaultGameConfig(), ATTRIBUTES, PHYSICAL)).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(traitPoolDice(pcSystem(), {}, ATTRIBUTES, PHYSICAL)).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(traitPoolDice(pcSystem(), defaultGameConfig(), ATTRIBUTES, PHYSICAL, { actorId: 7 })).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(traitPoolDice(pcSystem(), defaultGameConfig(), ATTRIBUTES, PHYSICAL, { option: "double" }))
      .toEqual(refused("INVALID_TRAIT_OPTIONS"));
  });
});

describe("addTraitDice: a trait is never in a pool twice (CS-D8, TS-E05)", () => {
  it("adds a trait's dice at the end, after custom dice, continuing the die ids, with the trait's marks", () => {
    const pool = buildPool([{ size: 6, source: { kind: "custom", label: "Push" } }]);
    const dice = traitPoolDice(pcSystem(), defaultGameConfig(), ATTRIBUTES, PHYSICAL, { actorId: ACTOR }).value;
    const result = addTraitDice(deepFreeze(pool), deepFreeze(dice), { actorRef: REF });
    expect(result).toEqual({ ok: true, value: { changed: true, pool: [
      pool[0],
      { id: "d2", size: 8, origin: "rating", source: {
        kind: "trait", actorId: ACTOR, traitId: PHYSICAL, label: "Physical", setId: ATTRIBUTES, actorRef: REF
      } }
    ] } });
  });

  it("CS-16 the same trait with the same choice again changes nothing, keeping the builder's changes", () => {
    let pool = poolOf(defaultGameConfig(), [[pcSystem(), ATTRIBUTES, PHYSICAL]]);
    pool = stepPoolDie(pool, "d1", 1);
    const again = addTraitDice(pool, traitPoolDice(pcSystem(), defaultGameConfig(), ATTRIBUTES, PHYSICAL,
      { actorId: ACTOR }).value, { actorRef: REF });
    expect(again.value.changed).toBe(false);
    expect(again.value.pool).toEqual(pool);
    expect(again.value.pool[0].size).toBe(10);
  });

  it("CS-16 a different choice replaces the trait's dice in their place, doubled dice included", () => {
    const config = defaultGameConfig();
    let pool = poolOf(config, [[pcSystem(), DISTINCTIONS, SMUGGLER], [pcSystem(), ATTRIBUTES, PHYSICAL]]);
    pool = doubleDie(pool, "d1");
    expect(pool.map(d => [d.id, d.size, d.source.traitId])).toEqual([["d1", 8, SMUGGLER], ["d3", 8, SMUGGLER], ["d2", 8, PHYSICAL]]);

    pool = poolOf(config, [[pcSystem(), DISTINCTIONS, SMUGGLER, "hinder"]], pool);
    expect(pool.map(d => [d.id, d.size, d.source.traitId, d.source.option ?? null, d.source.ppGained ?? null]))
      .toEqual([["d4", 4, SMUGGLER, "hinder", 1], ["d2", 8, PHYSICAL, null, null]]);

    pool = poolOf(config, [[pcSystem(), DISTINCTIONS, SMUGGLER]], pool);
    expect(pool.map(d => [d.size, d.source.traitId, d.source.option ?? null])).toEqual([[8, SMUGGLER, null], [8, PHYSICAL, null]]);
  });

  it("keeps two actors' traits apart, and two unlinked tokens of one actor too (RQ-031)", () => {
    const config = defaultGameConfig();
    const tokenRef = `Scene.scene0000000001.Token.token00000000001.Actor.${ACTOR}`;
    const pool = poolOf(config, [
      [pcSystem(), ATTRIBUTES, PHYSICAL, null, ACTOR, REF],
      [pcSystem(), ATTRIBUTES, PHYSICAL, null, "actor00000000002", "Actor.actor00000000002"],
      [pcSystem(), ATTRIBUTES, PHYSICAL, null, ACTOR, tokenRef]
    ]);
    expect(pool).toHaveLength(3);
    expect(new Set(pool.map(poolDieGroupKey)).size).toBe(3);
  });

  it("refuses a pool or dice it can't read", () => {
    const dice = traitPoolDice(pcSystem(), defaultGameConfig(), ATTRIBUTES, PHYSICAL).value;
    expect(addTraitDice("pool", dice)).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(addTraitDice([{ size: 8 }], dice)).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(addTraitDice([], { ...dice, entries: [] })).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(addTraitDice([], dice, { actorRef: 3 })).toEqual(refused("INVALID_TRAIT_DATA"));
  });
});

describe("poolTraits and poolDieGroupKey", () => {
  it("lists each trait once with its marks and every die id, and groups other dice by label", () => {
    let pool = poolOf(defaultGameConfig(), [
      [pcSystem(), DISTINCTIONS, SMUGGLER, "hinder"], [pcSystem(), ATTRIBUTES, MENTAL]
    ], buildPool([{ size: 6, source: { kind: "custom", label: "Push" } }]));
    pool = doubleDie(pool, "d3");
    const traits = poolTraits(pool).value;
    expect(traits.map(t => [t.label, t.option, t.ppGained, t.isFallback, t.dieIds])).toEqual([
      ["Retired Smuggler", "hinder", 1, false, ["d2"]], ["Mental", null, 0, true, ["d3", "d4"]]
    ]);
    expect(traits[0]).toMatchObject({ setId: DISTINCTIONS, traitId: SMUGGLER, actorId: ACTOR, actorRef: REF });
    expect(poolDieGroupKey(pool[0])).toBe("label:Push");
    expect(poolDieGroupKey(pool[2])).toBe(poolDieGroupKey(pool[3]));
  });
});

describe("poolTraitReport: what a pool's trait dice cost and warn of", () => {
  const actors = { [REF]: pcSystem(), [LOCATION_REF]: locationSystem() };

  it("TS-17 a distinction and Physical: no cost, and the missing skills are warned of", () => {
    const pool = poolOf(defaultGameConfig(), [[pcSystem(), DISTINCTIONS, SMUGGLER], [pcSystem(), ATTRIBUTES, PHYSICAL]]);
    expect(poolTraitReport(deepFreeze(pool), deepFreeze(actors), deepFreeze(defaultGameConfig()))).toEqual({ ok: true, value: {
      traitCount: 2, ppCost: 0, extraTraits: [], unpricedTraits: [], ppGained: 0,
      warnings: [{ code: "PRIME_SET_MISSING", setId: SKILLS }]
    } });
  });

  it("CS-15, TS-09 Fight and Shoot cost 1 PP; TS-10 with skills allowing no further trait: unpriced and warned", () => {
    const adds = [[pcSystem(), ATTRIBUTES, PHYSICAL], [pcSystem(), SKILLS, FIGHT], [pcSystem(), SKILLS, SHOOT]];
    let config = defaultGameConfig();
    let report = poolTraitReport(poolOf(config, adds), actors, config).value;
    expect(report).toMatchObject({ traitCount: 3, ppCost: 1, extraTraits: [{ setId: SKILLS, count: 1 }], unpricedTraits: [] });
    expect(report.warnings).toEqual([]);

    config = defaultGameConfig();
    traitSetById(config, SKILLS).extraTraits = "none";
    report = poolTraitReport(poolOf(config, adds), actors, config).value;
    expect(report).toMatchObject({ ppCost: 0, extraTraits: [], unpricedTraits: [{ setId: SKILLS, count: 1 }] });
    expect(report.warnings).toEqual([{ code: "EXTRA_TRAIT_NOT_ALLOWED", setId: SKILLS }]);
  });

  it("checks every kind in the pool that uses prime sets: a location's scene distinction adds no warning", () => {
    const config = defaultGameConfig();
    const pool = poolOf(config, [
      [locationSystem(), SCENE, CROWD, null, LOCATION, LOCATION_REF],
      [pcSystem(), DISTINCTIONS, SMUGGLER], [pcSystem(), ATTRIBUTES, PHYSICAL]
    ]);
    expect(poolTraitReport(pool, actors, config).value.warnings).toEqual([{ code: "PRIME_SET_MISSING", setId: SKILLS }]);

    const locationOnly = poolOf(config, [[locationSystem(), SCENE, CROWD, null, LOCATION, LOCATION_REF]]);
    expect(poolTraitReport(locationOnly, actors, config).value.warnings).toEqual([]);
  });

  it("warns of each missing prime set once when two kinds that use prime sets share the pool", () => {
    const config = defaultGameConfig();
    const gmc = { ...pcSystem(), kindId: "cpKindMajorGmc00" };
    const pool = poolOf(config, [
      [pcSystem(), DISTINCTIONS, SMUGGLER], [gmc, DISTINCTIONS, OPTIMIST, null, "gmc0000000000001", "Actor.gmc0000000000001"]
    ]);
    const report = poolTraitReport(pool, { ...actors, "Actor.gmc0000000000001": gmc }, config).value;
    expect(report.warnings).toEqual([
      { code: "PRIME_SET_MISSING", setId: ATTRIBUTES }, { code: "PRIME_SET_MISSING", setId: SKILLS }
    ]);
    // Two distinctions from two actors are two traits of one set (RQ-031).
    expect(report.ppCost).toBe(1);
  });

  it("TS-12, TS-13 takes the shut-down flags the actor holds now, and names the trait's actor by its id", () => {
    const config = defaultGameConfig();
    const pool = poolOf(config, [[pcSystem(), ATTRIBUTES, PHYSICAL], [pcSystem(), SKILLS, FIGHT]]);
    const now = pcSystem();
    now.traits[ATTRIBUTES].entries[0].shutDown = { reason: "manual" };
    now.traits[SKILLS].shutDown = true;
    expect(poolTraitReport(pool, { [REF]: now }, config).value.warnings).toEqual([
      { code: "TRAIT_SHUT_DOWN", setId: ATTRIBUTES, actorId: ACTOR, traitId: PHYSICAL },
      { code: "TRAIT_SET_SHUT_DOWN", setId: SKILLS }
    ]);
  });

  it("warns of a stored rating that no longer fits its set, naming the trait (ADR-037 point 5)", () => {
    const system = pcSystem();
    system.traits[ATTRIBUTES].entries[0].dice = [8, 6];
    const config = defaultGameConfig();
    const pool = poolOf(config, [[system, ATTRIBUTES, PHYSICAL], [system, SKILLS, FIGHT]]);
    expect(poolTraitReport(pool, { [REF]: system }, config).value.warnings).toEqual([
      { code: "RATING_CONFLICTS_WITH_SET", setId: ATTRIBUTES, actorId: ACTOR, traitId: PHYSICAL }
    ]);
  });

  it("sums Hinder's plot points for display, none for a distinction already at d4", () => {
    const config = defaultGameConfig();
    const pool = poolOf(config, [[pcSystem(), DISTINCTIONS, SMUGGLER, "hinder"]]);
    expect(poolTraitReport(pool, actors, config).value.ppGained).toBe(1);
    const atD4 = poolOf(config, [[pcSystem(), DISTINCTIONS, OPTIMIST, "hinder"]]);
    expect(poolTraitReport(atD4, actors, config).value.ppGained).toBe(0);
  });

  it("counts a trait whose actor isn't given, without flags or kind", () => {
    const config = defaultGameConfig();
    const pool = poolOf(config, [[pcSystem(), SKILLS, FIGHT], [pcSystem(), SKILLS, SHOOT]]);
    expect(poolTraitReport(pool, {}, config).value).toMatchObject({ ppCost: 1, warnings: [] });
  });

  it("reports nothing for a pool of custom dice, and refuses what it can't read", () => {
    const pool = buildPool([{ size: 8, source: { kind: "custom", label: "Push" } }]);
    expect(poolTraitReport(pool, {}, defaultGameConfig())).toEqual({ ok: true, value: {
      traitCount: 0, ppCost: 0, extraTraits: [], unpricedTraits: [], warnings: [], ppGained: 0
    } });
    expect(poolTraitReport("pool", {}, defaultGameConfig())).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(poolTraitReport(pool, null, defaultGameConfig())).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(poolTraitReport(pool, {}, null)).toEqual(refused("INVALID_GAME_CONFIG"));
  });
});

describe("rolling: the dice as stored, and the challenges that follow the roll (ADR-048)", () => {
  it("rolls every die with only the source fields the roll message keeps", () => {
    const pool = poolOf(defaultGameConfig(), [[pcSystem(), DISTINCTIONS, SMUGGLER, "hinder"]],
      buildPool([{ size: 6, source: { kind: "custom", label: "Push" } }]));
    expect(rollablePool(deepFreeze(pool))).toEqual({ ok: true, value: [
      { id: "d1", size: 6, origin: "rating", source: { kind: "custom", label: "Push" } },
      { id: "d2", size: 4, origin: "rating", source: { kind: "trait", actorId: ACTOR, traitId: SMUGGLER, label: "Retired Smuggler" } }
    ] });
    expect(rollablePool([{ id: "d1" }])).toEqual(refused("INVALID_TRAIT_DATA"));
  });

  it("CS-14 lists the challenged traits, and takes all their dice out of the kept pool", () => {
    const config = configWithStatements(ATTRIBUTES);
    let pool = poolOf(config, [[pcSystem(), ATTRIBUTES, SOCIAL, "challenge"], [pcSystem(), ATTRIBUTES, PHYSICAL]]);
    pool = doubleDie(pool, "d1");
    const challenged = challengedPoolTraits(pool).value;
    expect(challenged.map(t => [t.setId, t.traitId, t.actorId, t.actorRef, t.label]))
      .toEqual([[ATTRIBUTES, SOCIAL, ACTOR, REF, "Social"]]);
    const kept = withoutPoolTraits(deepFreeze(pool), challenged.map(t => t.key)).value;
    expect(kept.map(d => d.source.traitId)).toEqual([PHYSICAL]);
    expect(withoutPoolTraits(pool, "keys")).toEqual(refused("INVALID_TRAIT_DATA"));
  });

  it("TS-14 steps the challenged entry down and keeps the others as stored", () => {
    const config = configWithStatements(ATTRIBUTES);
    const result = entriesAfterChallenge(deepFreeze(pcSystem()), config, ATTRIBUTES, SOCIAL);
    const expected = pcSystem().traits[ATTRIBUTES].entries;
    expected[1] = { ...expected[1], dice: [6], challenged: true, preChallengeDice: [8] };
    expect(result).toEqual({ ok: true, value: expected });
  });

  it("TS-16 a d4 stays a d4 and is shut down; TS-14b a second challenge keeps the first rating", () => {
    const config = configWithStatements(ATTRIBUTES);
    const system = pcSystem();
    system.traits[ATTRIBUTES].entries[1].dice = [4];
    expect(entriesAfterChallenge(system, config, ATTRIBUTES, SOCIAL).value[1]).toMatchObject({
      dice: [4], challenged: true, preChallengeDice: [4], shutDown: { reason: "statementChallenged" }
    });

    const again = pcSystem();
    Object.assign(again.traits[ATTRIBUTES].entries[1], { dice: [6], challenged: true, preChallengeDice: [8] });
    expect(entriesAfterChallenge(again, config, ATTRIBUTES, SOCIAL).value[1]).toMatchObject({
      dice: [4], challenged: true, preChallengeDice: [8]
    });
  });

  it("refuses an entry it can't find and a rating of several dice (RQ-033)", () => {
    const config = configWithStatements(ATTRIBUTES, SCENE);
    expect(entriesAfterChallenge(pcSystem(), config, ATTRIBUTES, MENTAL)).toEqual(refused("UNKNOWN_TRAIT"));
    expect(entriesAfterChallenge(pcSystem(), config, "noSuchSet0000000", SOCIAL)).toEqual(refused("UNKNOWN_TRAIT_SET"));
    const system = locationSystem();
    system.traits[SCENE].entries[0].dice = [6, 6];
    expect(entriesAfterChallenge(system, config, SCENE, CROWD)).toEqual(refused("STATEMENT_RATING_NOT_ONE_DIE"));
    expect(entriesAfterChallenge(null, config, SCENE, CROWD)).toEqual(refused("INVALID_TRAIT_DATA"));
  });
});

describe("pool strings", () => {
  it("has a refusal string for every code adding a trait or stepping one down can return", () => {
    const source = readFileSync(resolve(ROOT, "module/rules/pool-traits.mjs"), "utf8");
    const own = new Set([...source.matchAll(/fail\("([A-Z_]+)"\)/g)].map(m => m[1]));
    const passedOn = ["TRAIT_HAS_NO_DICE", "TRAIT_ORPHANED", "INVALID_DIE_SIZE", "TRAIT_UNRATED",
      "STATEMENT_RATING_NOT_ONE_DIE", "TRAIT_OPTIONS_CONFLICT"];
    const foundry = ["CHALLENGE_NEEDS_OWNER", "ACTOR_NOT_FOUND"];
    expect(own.size).toBeGreaterThanOrEqual(7);
    for ( const code of [...own, ...passedOn, ...foundry] ) {
      expect(lang.CORTEX.Builder.Errors[code], code).toBeTypeOf("string");
    }
  });
});
