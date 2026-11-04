import { describe, expect, it } from "vitest";
import {
  GAME_CONFIG_SCHEMA_VERSION, actorKindById, defaultGameConfig, kindUsesPrimeSets, ratingOptionsOf, removeTraitSet,
  traitDefById, traitSetById, validateGameConfig
} from "../../module/rules/game-config.mjs";
import { validateRating } from "../../module/rules/traits.mjs";

const ID_PATTERN = /^[a-zA-Z0-9]{16}$/;

/** @returns {object} a set with every field filled, open, with dice */
function openSet(id, overrides = {}) {
  return {
    id,
    name: `Set ${id}`,
    role: "other",
    list: "open",
    hasDice: true,
    multiDice: false,
    sameSizeDice: false,
    usualMin: null,
    usualMax: null,
    startingRating: null,
    fallbackDie: null,
    extraTraits: "pp",
    features: {
      description: false, sfx: false, statements: false, tags: false, subTraits: false, hinder: false, setSfx: false,
      shutDown: true
    },
    ...overrides
  };
}

/** @returns {object} a fixed set holding the given definitions */
function fixedSet(id, traits, overrides = {}) {
  return openSet(id, { list: "fixed", traits, ...overrides });
}

/** A small valid configuration: distinctions, two prime sets and one kind using all three. */
function smallConfig() {
  return {
    schemaVersion: GAME_CONFIG_SCHEMA_VERSION,
    traitSets: [
      openSet("distinctions0000", { role: "distinctions" }),
      fixedSet("attributes000000", [{ id: "physical00000000", name: "Physical" }], { role: "prime" }),
      fixedSet("skills0000000000", [{ id: "fight00000000000", name: "Fight" }], { role: "prime", fallbackDie: 4 })
    ],
    actorKinds: [
      { id: "pc00000000000000", name: "PC", traitSetIds: ["distinctions0000", "attributes000000", "skills0000000000"], freeTraits: false }
    ]
  };
}

/** @returns {string[]} the codes of a failed validation, in order */
function codes(result) {
  expect(result.ok).toBe(false);
  return result.errors.map(e => e.code);
}

describe("validateGameConfig (ADR-030)", () => {
  it("accepts a configuration with distinctions and two prime sets, returning a copy", () => {
    const config = smallConfig();
    const result = validateGameConfig(config);
    expect(result).toEqual({ ok: true, value: config, errors: [] });
    expect(result.value).not.toBe(config);
    expect(result.value.traitSets[1].traits).not.toBe(config.traitSets[1].traits);
  });

  it("refuses data that isn't a configuration at all with one error", () => {
    for ( const bad of [null, undefined, 3, "config", [], new Map()] ) {
      const result = validateGameConfig(bad);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("INVALID_GAME_CONFIG");
      expect(result.errors).toEqual([{ code: "INVALID_GAME_CONFIG", path: "" }]);
    }
  });

  it("refuses a schema version that isn't a whole number from 1, and stops there", () => {
    for ( const schemaVersion of [0, -1, 1.5, "1", null, undefined] ) {
      const result = validateGameConfig({ ...smallConfig(), schemaVersion, traitSets: "not checked" });
      expect(result.errors).toEqual([{ code: "INVALID_GAME_CONFIG", path: "schemaVersion" }]);
    }
  });

  it("refuses a schema version above the one this code knows, and stops there", () => {
    expect(validateGameConfig({ ...smallConfig(), schemaVersion: GAME_CONFIG_SCHEMA_VERSION + 1 }))
      .toEqual({ ok: false, code: "SCHEMA_VERSION_TOO_NEW", errors: [{ code: "SCHEMA_VERSION_TOO_NEW", path: "schemaVersion" }] });
  });

  it("refuses trait sets or actor kinds that aren't lists", () => {
    expect(validateGameConfig({ ...smallConfig(), traitSets: {} }).errors)
      .toEqual([{ code: "INVALID_GAME_CONFIG", path: "traitSets" }]);
    expect(validateGameConfig({ ...smallConfig(), actorKinds: null }).errors)
      .toEqual([{ code: "INVALID_GAME_CONFIG", path: "actorKinds" }]);
  });

  it("refuses a set, definition or kind that isn't an object, and checks the rest", () => {
    const config = smallConfig();
    config.traitSets.push("not a set");
    config.traitSets[1].traits.push(null);
    config.actorKinds.push([]);
    expect(validateGameConfig(config).errors).toEqual([
      { code: "INVALID_TRAIT_DEFINITION", path: "traitSets.1.traits.1" },
      { code: "INVALID_TRAIT_SET", path: "traitSets.3" },
      { code: "INVALID_ACTOR_KIND", path: "actorKinds.1" }
    ]);
  });

  it("reports the first error's code as the result code, and every error with its path", () => {
    const config = smallConfig();
    config.traitSets[0].name = "";
    config.traitSets[2].usualMin = 7;
    const result = validateGameConfig(config);
    expect(result.code).toBe("INVALID_TRAIT_SET");
    expect(result.errors).toEqual([
      { code: "INVALID_TRAIT_SET", path: "traitSets.0.name" },
      { code: "INVALID_DIE_SIZE", path: "traitSets.2.usualMin" }
    ]);
  });

  it("refuses ids that aren't 16 letters or digits", () => {
    const config = smallConfig();
    config.traitSets[0].id = "short";
    config.traitSets[1].traits[0].id = "has-a-dash-00000";
    config.actorKinds[0].id = 1234567890123456;
    expect(validateGameConfig(config).errors).toEqual([
      { code: "INVALID_TRAIT_SET", path: "traitSets.0.id" },
      { code: "INVALID_TRAIT_DEFINITION", path: "traitSets.1.traits.0.id" },
      { code: "INVALID_ACTOR_KIND", path: "actorKinds.0.id" },
      // the kind still names the set by its old id, which no longer exists
      { code: "UNKNOWN_TRAIT_SET", path: "actorKinds.0.traitSetIds.0" }
    ]);
  });

  it("refuses two sets with one id", () => {
    const config = smallConfig();
    config.traitSets.push(openSet("distinctions0000", { name: "Again" }));
    expect(validateGameConfig(config).errors).toEqual([{ code: "DUPLICATE_CONFIG_ID", path: "traitSets.3.id" }]);
  });

  it("refuses an id used twice anywhere in the configuration", () => {
    const config = smallConfig();
    config.traitSets[2].traits.push({ id: "physical00000000", name: "Physical again" });
    config.actorKinds.push({ ...config.actorKinds[0], name: "Copy" });
    expect(validateGameConfig(config).errors).toEqual([
      { code: "DUPLICATE_CONFIG_ID", path: "traitSets.2.traits.1.id" },
      { code: "DUPLICATE_CONFIG_ID", path: "actorKinds.1.id" }
    ]);
  });

  it("refuses a set or kind with a blank name, and a definition with a blank name", () => {
    const config = smallConfig();
    config.traitSets[1].name = "   ";
    config.traitSets[1].traits[0].name = "";
    config.actorKinds[0].name = 5;
    expect(codes(validateGameConfig(config))).toEqual(["INVALID_TRAIT_SET", "INVALID_TRAIT_DEFINITION", "INVALID_ACTOR_KIND"]);
  });

  it("accepts a definition with a description and refuses one that isn't text", () => {
    const config = smallConfig();
    config.traitSets[1].traits[0].description = "Our own words";
    expect(validateGameConfig(config).ok).toBe(true);
    config.traitSets[1].traits[0].description = 3;
    expect(validateGameConfig(config).errors).toEqual([{ code: "INVALID_TRAIT_DEFINITION", path: "traitSets.1.traits.0.description" }]);
  });

  it("refuses a role, list or extra-trait rule outside its choices (ADR-034, rule 6)", () => {
    const config = smallConfig();
    config.traitSets[0].role = "prime set";
    config.traitSets[1].list = "closed";
    config.traitSets[2].extraTraits = "free";
    expect(validateGameConfig(config).errors).toEqual([
      { code: "INVALID_TRAIT_SET", path: "traitSets.0.role" },
      { code: "INVALID_TRAIT_SET", path: "traitSets.1.list" },
      { code: "INVALID_TRAIT_SET", path: "traitSets.2.extraTraits" },
      // with its role gone, no set fills the distinctions role
      { code: "DISTINCTIONS_SET_MISSING", path: "traitSets" }
    ]);
  });

  it("refuses a fixed set without a list of definitions, and an open set with definitions (ADR-034)", () => {
    const config = smallConfig();
    delete config.traitSets[1].traits;
    config.traitSets[0].traits = [{ id: "stray00000000000", name: "Stray" }];
    expect(validateGameConfig(config).errors).toEqual([
      { code: "INVALID_TRAIT_SET", path: "traitSets.0.traits" },
      { code: "INVALID_TRAIT_SET", path: "traitSets.1.traits" }
    ]);
  });

  it("accepts an open set with an empty definition list, and refuses a null one", () => {
    const config = smallConfig();
    config.traitSets[0].traits = [];
    expect(validateGameConfig(config).ok).toBe(true);
    config.traitSets[0].traits = null;
    expect(validateGameConfig(config).errors).toEqual([{ code: "INVALID_TRAIT_SET", path: "traitSets.0.traits" }]);
  });

  it("refuses empty slots in any list instead of skipping them", () => {
    const holes = smallConfig();
    holes.traitSets.length = 4;
    holes.traitSets[1].traits.length = 2;
    holes.actorKinds[0].traitSetIds.length = 4;
    holes.actorKinds.length = 2;
    expect(validateGameConfig(holes).errors).toEqual([
      { code: "INVALID_TRAIT_DEFINITION", path: "traitSets.1.traits.1" },
      { code: "INVALID_TRAIT_SET", path: "traitSets.3" },
      { code: "UNKNOWN_TRAIT_SET", path: "actorKinds.0.traitSetIds.3" },
      { code: "INVALID_ACTOR_KIND", path: "actorKinds.1" }
    ]);
  });

  it("refuses a kind's set id that isn't text as a set it doesn't know", () => {
    const config = smallConfig();
    config.actorKinds[0].traitSetIds.push(null, 5);
    expect(validateGameConfig(config).errors).toEqual([
      { code: "UNKNOWN_TRAIT_SET", path: "actorKinds.0.traitSetIds.3" },
      { code: "UNKNOWN_TRAIT_SET", path: "actorKinds.0.traitSetIds.4" }
    ]);
  });

  it("accepts objects without a prototype and returns ordinary copies", () => {
    const config = smallConfig();
    config.traitSets[0] = Object.assign(Object.create(null), config.traitSets[0]);
    const result = validateGameConfig(config);
    expect(result.ok).toBe(true);
    expect(Object.getPrototypeOf(result.value.traitSets[0])).toBe(Object.prototype);
  });

  it("keeps fields it doesn't know, so a later version can add some", () => {
    const config = smallConfig();
    config.traitSets[0].later = { a: 1 };
    config.later = true;
    const result = validateGameConfig(config);
    expect(result.value.traitSets[0].later).toEqual({ a: 1 });
    expect(result.value.traitSets[0].later).not.toBe(config.traitSets[0].later);
    expect(result.value.later).toBe(true);
  });

  it("checks and returns the same values when a property would read differently twice", () => {
    let reads = 0;
    const config = smallConfig();
    Object.defineProperty(config.traitSets[0], "name", { enumerable: true, get: () => (reads++ ? "" : "Distinctions") });
    const result = validateGameConfig(config);
    expect(result.ok).toBe(true);
    expect(result.value.traitSets[0].name).toBe("Distinctions");
  });

  it("refuses set-shape options that aren't booleans, without coercing (spec data shapes)", () => {
    const config = smallConfig();
    config.traitSets[0].hasDice = "yes";
    config.traitSets[1].multiDice = 1;
    config.traitSets[2].sameSizeDice = undefined;
    expect(validateGameConfig(config).errors).toEqual([
      { code: "INVALID_TRAIT_SET", path: "traitSets.0.hasDice" },
      { code: "INVALID_TRAIT_SET", path: "traitSets.1.multiDice" },
      { code: "INVALID_TRAIT_SET", path: "traitSets.2.sameSizeDice" }
    ]);
  });

  it("accepts every combination of the set-shape options, with or without guidance (ADR-037, Q2)", () => {
    for ( const hasDice of [true, false] ) for ( const multiDice of [true, false] ) for ( const sameSizeDice of [true, false] ) {
      const config = smallConfig();
      Object.assign(config.traitSets[0], { hasDice, multiDice, sameSizeDice });
      Object.assign(config.traitSets[2], { hasDice, multiDice, sameSizeDice, usualMin: 4, startingRating: 6 });
      expect(validateGameConfig(config).ok).toBe(true);
    }
  });

  it("refuses guidance and fallback dice that aren't die sizes (TS-E01, rule 8, rule 9)", () => {
    const config = smallConfig();
    config.traitSets[1].usualMin = 7;
    config.traitSets[1].usualMax = "12";
    config.traitSets[1].startingRating = 14;
    config.traitSets[2].fallbackDie = 7;
    expect(validateGameConfig(config).errors).toEqual([
      { code: "INVALID_DIE_SIZE", path: "traitSets.1.usualMin" },
      { code: "INVALID_TRAIT_SET", path: "traitSets.1.usualMax" },
      { code: "INVALID_DIE_SIZE", path: "traitSets.1.startingRating" },
      { code: "INVALID_DIE_SIZE", path: "traitSets.2.fallbackDie" }
    ]);
  });

  it("refuses a fallback that is a real die other than d4, and guidance fields that are missing", () => {
    const config = smallConfig();
    config.traitSets[2].fallbackDie = 6;
    delete config.traitSets[1].usualMin;
    delete config.traitSets[1].fallbackDie;
    expect(validateGameConfig(config).errors).toEqual([
      { code: "INVALID_TRAIT_SET", path: "traitSets.1.usualMin" },
      { code: "INVALID_TRAIT_SET", path: "traitSets.1.fallbackDie" },
      { code: "INVALID_TRAIT_SET", path: "traitSets.2.fallbackDie" }
    ]);
  });

  it("accepts any die size as guidance and d4 or none as the fallback", () => {
    const config = smallConfig();
    Object.assign(config.traitSets[1], { usualMin: 6, usualMax: 10, startingRating: 8, fallbackDie: 4 });
    expect(validateGameConfig(config).ok).toBe(true);
  });

  it("refuses a usual minimum above the usual maximum", () => {
    const config = smallConfig();
    Object.assign(config.traitSets[1], { usualMin: 10, usualMax: 6 });
    expect(validateGameConfig(config).errors).toEqual([{ code: "INVALID_TRAIT_SET", path: "traitSets.1.usualMax" }]);
  });

  it("lets a set without dice keep its guidance and fallback unused, so turning dice off loses nothing", () => {
    const config = defaultGameConfig();
    traitSetById(config, "cpSetAttributes0").hasDice = false;
    expect(validateGameConfig(config).ok).toBe(true);
  });

  it("refuses features that are missing or not booleans, and ignores features it doesn't know", () => {
    const config = smallConfig();
    delete config.traitSets[0].features.hinder;
    config.traitSets[1].features.sfx = "on";
    config.traitSets[2].features.later = true;
    expect(validateGameConfig(config).errors).toEqual([
      { code: "INVALID_TRAIT_SET", path: "traitSets.0.features.hinder" },
      { code: "INVALID_TRAIT_SET", path: "traitSets.1.features.sfx" }
    ]);
    config.traitSets[2].features = null;
    expect(validateGameConfig(config).errors.at(-1)).toEqual({ code: "INVALID_TRAIT_SET", path: "traitSets.2.features" });
  });

  it("refuses an actor kind that names a set that doesn't exist, or names one twice", () => {
    const config = smallConfig();
    config.actorKinds[0].traitSetIds.push("missing000000000", "skills0000000000");
    expect(validateGameConfig(config).errors).toEqual([
      { code: "UNKNOWN_TRAIT_SET", path: "actorKinds.0.traitSetIds.3" },
      { code: "INVALID_ACTOR_KIND", path: "actorKinds.0.traitSetIds.4" }
    ]);
  });

  it("refuses an actor kind whose set list or free-trait flag has the wrong type", () => {
    const config = smallConfig();
    config.actorKinds[0].traitSetIds = "skills0000000000";
    config.actorKinds.push({ id: "minor00000000000", name: "Minor", traitSetIds: [], freeTraits: "yes" });
    expect(validateGameConfig(config).errors).toEqual([
      { code: "INVALID_ACTOR_KIND", path: "actorKinds.0.traitSetIds" },
      { code: "INVALID_ACTOR_KIND", path: "actorKinds.1.freeTraits" }
    ]);
  });

  it("accepts a configuration with no actor kinds", () => {
    expect(validateGameConfig({ ...smallConfig(), actorKinds: [] }).ok).toBe(true);
  });

  it("refuses a configuration with fewer than two prime sets (rule 7, Handbook p. 26, p. 47)", () => {
    const config = smallConfig();
    config.traitSets[2].role = "other";
    expect(validateGameConfig(config).errors).toEqual([{ code: "PRIME_SETS_TOO_FEW", path: "traitSets" }]);
  });

  it("refuses a configuration with no set in the distinctions role (rule 10, Handbook p. 26)", () => {
    const config = smallConfig();
    config.traitSets[0].role = "other";
    expect(validateGameConfig(config).errors).toEqual([{ code: "DISTINCTIONS_SET_MISSING", path: "traitSets" }]);
  });

  it("checks the structure after every other error", () => {
    const config = smallConfig();
    config.traitSets = [];
    config.actorKinds[0].traitSetIds = ["distinctions0000"];
    expect(codes(validateGameConfig(config))).toEqual(["UNKNOWN_TRAIT_SET", "DISTINCTIONS_SET_MISSING", "PRIME_SETS_TOO_FEW"]);
  });

  it("works from frozen input and never changes it", () => {
    const config = deepFreeze(smallConfig());
    expect(validateGameConfig(config).ok).toBe(true);
    const bad = deepFreeze({ ...smallConfig(), schemaVersion: 0 });
    expect(validateGameConfig(bad).ok).toBe(false);
  });
});

describe("defaultGameConfig (ADR-036)", () => {
  it("is a valid configuration at the current schema version", () => {
    const config = defaultGameConfig();
    expect(config.schemaVersion).toBe(GAME_CONFIG_SCHEMA_VERSION);
    expect(validateGameConfig(config)).toEqual({ ok: true, value: config, errors: [] });
  });

  it("returns a new, independent object every time", () => {
    const a = defaultGameConfig();
    const b = defaultGameConfig();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.traitSets[0].name = "Changed";
    expect(b.traitSets[0].name).not.toBe("Changed");
  });

  it("uses fixed, 16-character ids, so every new world gets the same ones", () => {
    const config = defaultGameConfig();
    const ids = [
      ...config.traitSets.map(s => s.id), ...config.traitSets.flatMap(s => (s.traits ?? []).map(t => t.id)),
      ...config.actorKinds.map(k => k.id)
    ];
    for ( const id of ids ) expect(id).toMatch(ID_PATTERN);
    expect(new Set(ids).size).toBe(ids.length);
    // pinned: changing one would orphan every actor value stored against it
    expect(ids).toEqual([
      "cpSetDistinction", "cpSetAttributes0", "cpSetSkills00000", "cpSetSceneDistin", "cpSetMobTrait000",
      "cpAttrPhysical00", "cpAttrMental0000", "cpAttrSocial0000",
      "cpSkillFight0000", "cpSkillShoot0000", "cpSkillThrow0000", "cpSkillSneak0000", "cpSkillDrive0000",
      "cpSkillPilot0000", "cpSkillRepair000", "cpSkillHeal00000", "cpSkillPersuade0", "cpSkillDeceive00",
      "cpSkillNotice000", "cpSkillStudy0000",
      "cpKindPlayerChar", "cpKindMajorGmc00", "cpKindMinorGmc00", "cpKindMob0000000", "cpKindLocation00"
    ]);
  });

  it("has distinctions, plus attributes and skills as the prime sets (Handbook p. 26)", () => {
    const config = defaultGameConfig();
    const byRole = role => config.traitSets.filter(s => s.role === role).map(s => s.name);
    expect(byRole("prime")).toEqual(["Attributes", "Skills"]);
    expect(byRole("distinctions")).toEqual(["Distinctions"]);
  });

  it("gives distinctions an open list of one die each, with Hinder and SFX (rules 10, 11, 13)", () => {
    const set = traitSetById(defaultGameConfig(), "cpSetDistinction");
    expect(set).toMatchObject({
      role: "distinctions", list: "open", hasDice: true, multiDice: false, startingRating: 8, fallbackDie: null
    });
    expect(set.features).toMatchObject({ hinder: true, sfx: true, description: true });
  });

  it("gives attributes a fixed list with d8 to start and d6 to d10 as guidance (Handbook pp. 48-49)", () => {
    const set = traitSetById(defaultGameConfig(), "cpSetAttributes0");
    expect(set).toMatchObject({ role: "prime", list: "fixed", usualMin: 6, usualMax: 10, startingRating: 8, fallbackDie: 4 });
    expect(set.traits.map(t => t.name)).toEqual(["Physical", "Mental", "Social"]);
  });

  it("gives skills a fixed list with a d4 fallback and d4 to d12 as guidance (Handbook p. 58)", () => {
    const set = traitSetById(defaultGameConfig(), "cpSetSkills00000");
    expect(set).toMatchObject({ role: "prime", list: "fixed", usualMin: 4, usualMax: 12, startingRating: 4, fallbackDie: 4 });
    expect(set.traits.length).toBeGreaterThanOrEqual(10);
    for ( const name of ["Fight", "Shoot", "Throw", "Sneak", "Drive", "Pilot"] ) {
      expect(set.traits.map(t => t.name)).toContain(name);
    }
    for ( const trait of set.traits ) expect(trait).not.toHaveProperty("description");
  });

  it("keeps scene distinctions in a set that allows several dice, so TS-07's [6, 6] can be stored (ADR-037)", () => {
    const config = defaultGameConfig();
    const set = traitSetById(config, "cpSetSceneDistin");
    expect(set).toMatchObject({ role: "other", list: "open", hasDice: true, multiDice: true });
    expect(set.features.hinder).toBe(true);
    expect(validateRating([6, 6], ratingOptionsOf(set))).toEqual({ ok: true, value: [6, 6] });
    expect(validateRating([6, 6], ratingOptionsOf(traitSetById(config, "cpSetDistinction"))).ok).toBe(false);
  });

  it("has a mob trait set of several same-size dice, so TS-E02's [6, 8] is refused when edited", () => {
    const set = traitSetById(defaultGameConfig(), "cpSetMobTrait000");
    expect(set).toMatchObject({ role: "other", list: "open", hasDice: true, multiDice: true, sameSizeDice: true });
    expect(validateRating([6, 6, 6], ratingOptionsOf(set)).ok).toBe(true);
    expect(validateRating([6, 8], ratingOptionsOf(set))).toEqual({ ok: false, code: "RATING_MIXED_SIZES" });
  });

  it("has PC, major GMC, minor GMC, mob and location kinds (ADR-031; Handbook pp. 114-117)", () => {
    const config = defaultGameConfig();
    const kinds = Object.fromEntries(config.actorKinds.map(k => [k.id, k]));
    expect(kinds.cpKindPlayerChar.traitSetIds).toEqual(["cpSetDistinction", "cpSetAttributes0", "cpSetSkills00000"]);
    expect(kinds.cpKindMajorGmc00.traitSetIds).toEqual(kinds.cpKindPlayerChar.traitSetIds);
    expect(kinds.cpKindMinorGmc00).toMatchObject({ traitSetIds: [], freeTraits: true });
    expect(kinds.cpKindLocation00).toMatchObject({ traitSetIds: ["cpSetSceneDistin"], freeTraits: true });
    expect(kinds.cpKindMob0000000).toMatchObject({ traitSetIds: ["cpSetMobTrait000"], freeTraits: true });
    expect(kinds.cpKindPlayerChar.freeTraits).toBe(false);
  });
});

describe("removeTraitSet", () => {
  it("removes the set and takes it out of every kind, leaving a valid configuration", () => {
    const config = defaultGameConfig();
    const result = removeTraitSet(config, "cpSetSceneDistin");
    expect(result.traitSets.map(s => s.id)).not.toContain("cpSetSceneDistin");
    expect(actorKindById(result, "cpKindLocation00").traitSetIds).toEqual([]);
    expect(validateGameConfig(result).ok).toBe(true);
    expect(traitSetById(config, "cpSetSceneDistin")).not.toBeNull();
  });

  it("returns an equal copy when no set has the id", () => {
    const config = defaultGameConfig();
    const result = removeTraitSet(config, "nothing000000000");
    expect(result).toEqual(config);
    expect(result).not.toBe(config);
  });

  it("works from frozen input", () => {
    const config = deepFreeze(defaultGameConfig());
    expect(removeTraitSet(config, "cpSetSkills00000").traitSets).toHaveLength(4);
  });
});

describe("configuration lookups", () => {
  it("find sets, definitions and kinds by id, or null", () => {
    const config = defaultGameConfig();
    expect(traitSetById(config, "cpSetSkills00000").name).toBe("Skills");
    expect(traitSetById(config, "nothing000000000")).toBeNull();
    const skills = traitSetById(config, "cpSetSkills00000");
    expect(traitDefById(skills, skills.traits[0].id)).toBe(skills.traits[0]);
    expect(traitDefById(skills, "nothing000000000")).toBeNull();
    expect(traitDefById(traitSetById(config, "cpSetDistinction"), "anything00000000")).toBeNull();
    expect(actorKindById(config, "cpKindLocation00").name).toBe("Location");
    expect(actorKindById(config, null)).toBeNull();
  });

  it("derive whether a kind uses prime sets from its sets (ADR-031; used by TS-17b)", () => {
    const config = defaultGameConfig();
    expect(kindUsesPrimeSets(actorKindById(config, "cpKindPlayerChar"), config)).toBe(true);
    expect(kindUsesPrimeSets(actorKindById(config, "cpKindMajorGmc00"), config)).toBe(true);
    expect(kindUsesPrimeSets(actorKindById(config, "cpKindMinorGmc00"), config)).toBe(false);
    expect(kindUsesPrimeSets(actorKindById(config, "cpKindLocation00"), config)).toBe(false);
    expect(kindUsesPrimeSets(null, config)).toBe(false);
    expect(kindUsesPrimeSets({ id: "x000000000000000", name: "X", traitSetIds: ["gone000000000000"], freeTraits: false }, config))
      .toBe(false);
  });

  it("find nothing in a fixed set without definitions", () => {
    expect(traitDefById(fixedSet("x000000000000000", undefined), "anything00000000")).toBeNull();
  });

  it("give a set's rating options in the shape validateRating takes (ADR-037 point 2)", () => {
    const set = openSet("x000000000000000", { hasDice: false, multiDice: true, sameSizeDice: true });
    expect(ratingOptionsOf(set)).toEqual({ hasDice: false, multiDice: true, sameSizeDice: true });
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
