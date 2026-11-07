/*
 * PLAN (Part B: the character schema's remaining entry fields). Removed before the implementation
 * commit.
 *
 * Fields to add, with type, default and source:
 * - Set: `shutDown` boolean, required, default false. Rule 15, TS-12; poolTraitCost reads it as
 *   `setShutDown`.
 * - Set entry (free traits keep id, name and dice):
 *   - `description` string, optional (absent by default). Rule 13 (a distinction's descriptive
 *     line), rule 20 (a talent's description).
 *   - `statement` string, optional. Rule 16 (MOD Trait Statements), TS-14 to TS-16c;
 *     statements.mjs editStatement.
 *   - `challenged` boolean, optional. Rule 16, TS-14, TS-15c; read by statements.mjs.
 *   - `preChallengeDice` die sizes, optional. Rule 16, RQ-022 b, TS-14b, TS-15, TS-16c.
 *   - `sfx` [{text, unlocked}], required, default []. Rules 11 and 13, ADR-035. `text` a string
 *     (blank allowed, "" when missing, like `name`); `unlocked` a boolean that must be given: no
 *     rule says whether a new SFX starts locked, so no default is invented.
 *   - `tags` string[], optional. Rule 18 (resources), rule 20 (abilities). The spec gives no type;
 *     read as a list of plain-text tags.
 *   - `sub` [{id, name, dice}], optional. Rule 19, TS-19 to TS-21. The spec writes `[...]`; read as
 *     the minimum any trait has, the free-trait shape (id, name, rating).
 *   - `shutDown` {reason: "manual" | "statementChallenged"}, optional. Rules 15 and 16, TS-13,
 *     TS-16, RQ-021; the reasons come from statements.mjs SHUT_DOWN_REASONS.
 * - Free traits: no change. Their rating is already a list of dice (ADR-033), so a boss's trait
 *   with several dice fits (ADR-040 consequences, p. 118); covered by tests only.
 * - Optional fields stay absent, not null or "": statements.mjs reads absence as "not challenged"
 *   and "not shut down", and resolveChallengedStatement removes the keys.
 * - Booleans don't cast: Foundry's BooleanField turns "yes" into false, so a strict boolean field
 *   refuses non-booleans, as statements.mjs does (INVALID_TRAIT_DATA).
 *
 * Wiring:
 * - traits.mjs: a new pure validateEntryRatings checks the die sizes of a preChallengeDice or a
 *   sub-trait rating that an edit sets (TS-E01: Foundry drops a d7 in a list without an error, so
 *   the backstop must refuse it visibly; ADR-037 point 2's first code). checkCharacterEdit runs it
 *   after the diff and before validateTraitChanges (die sizes first), so the backstop gets
 *   it. No set-shape check for either: preChallengeDice is a past rating, which may conflict with
 *   its set after a configuration change (point 5); which shape a sub-trait's rating must fit is
 *   unsettled (PARKED), and ADR-029 point 2 and ADR-037 ("schema check only until then") leave an
 *   unsettled edit check at the schema.
 * - Statement, SFX text, tags, description and shut-down flags get no configuration check
 *   (ADR-029; plain text).
 * - statements.mjs, trait-pool.mjs, sheet-hints.mjs: no change. statements.mjs already reads the
 *   spec's shape; pool and sheet callers come with M2 and M3.
 *
 * Schema version and migration: no bump, no migration step. Every new field is optional or has a
 * default that Foundry's cleaning fills on load, and a migration step must never fill defaults
 * (module/data/migration-runner.mjs); old actors load as they are. PARKED for the report: what the first character
 * migration should be.
 */

import { describe, expect, it } from "vitest";
import * as rules from "../../module/rules/index.mjs";
import { defaultGameConfig } from "../../module/rules/game-config.mjs";
import { checkCharacterEdit, checkCharacterUpdate } from "../../module/rules/traits.mjs";
import { challengeStatement, editStatement, resolveChallengedStatement } from "../../module/rules/statements.mjs";

const { validateEntryRatings } = rules;

// Ids from the defaults (ADR-036, ADR-040).
const DISTINCTIONS = "cpSetDistinction";
const ATTRIBUTES = "cpSetAttributes0";
const SKILLS = "cpSetSkills00000";
const SOCIAL = "cpAttrSocial0000";
const SHOOT = "cpSkillShoot0000";
const PC = "cpKindPlayerChar";

const E1 = "entry00000000001";
const E2 = "entry00000000002";
const E3 = "entry00000000003";
const S1 = "subtrait00000001";
const S2 = "subtrait00000002";

/** A PC with a distinction, Social d8 with a statement, and Shoot d12 with the specialty Guns d6. */
function pc() {
  return {
    kindId: PC,
    traits: {
      [DISTINCTIONS]: { shutDown: false, entries: [{
        id: E1, defId: null, name: "Seasoned Smuggler", dice: [8], description: "Knows every port", sfx: [
          { text: "Hinder", unlocked: true }
        ]
      }] },
      [ATTRIBUTES]: { shutDown: false, entries: [{
        id: E2, defId: SOCIAL, name: "Social", dice: [8], statement: "I always keep my word", sfx: []
      }] },
      [SKILLS]: { shutDown: false, entries: [{
        id: E3, defId: SHOOT, name: "Shoot", dice: [12], sfx: [], sub: [{ id: S1, name: "Guns", dice: [6] }]
      }] }
    },
    freeTraits: []
  };
}

/** @returns {object} a deep copy of the PC with the callback's changes */
function edited(edit, base = pc()) {
  const copy = structuredClone(base);
  edit(copy);
  return copy;
}

const social = state => state.traits[ATTRIBUTES].entries[0];
const shoot = state => state.traits[SKILLS].entries[0];
const refused = code => ({ ok: false, code });

describe("validateEntryRatings (ADR-037 point 2 for the entry's other ratings)", () => {
  it("is exported from the rules index", () => {
    expect(typeof validateEntryRatings).toBe("function");
  });

  it("TS-E01 refuses a d7 in a preChallengeDice the edit sets", () => {
    const proposed = edited(c => Object.assign(social(c), { challenged: true, preChallengeDice: [7] }));
    expect(validateEntryRatings(pc(), proposed)).toEqual(refused("INVALID_DIE_SIZE"));
  });

  it("TS-E01 refuses a d7 or a d14 in a sub-trait's rating the edit sets", () => {
    expect(validateEntryRatings(pc(), edited(c => { shoot(c).sub[0].dice = [7]; }))).toEqual(refused("INVALID_DIE_SIZE"));
    const added = edited(c => { shoot(c).sub.push({ id: S2, name: "Bows", dice: [6, 14] }); });
    expect(validateEntryRatings(pc(), added)).toEqual(refused("INVALID_DIE_SIZE"));
  });

  it("TS-E01 refuses a rating that isn't a list instead of coercing it", () => {
    const proposed = edited(c => Object.assign(social(c), { challenged: true, preChallengeDice: "8" }));
    expect(validateEntryRatings(pc(), proposed)).toEqual(refused("INVALID_DIE_SIZE"));
  });

  it("ADR-037 point 2 doesn't check again a preChallengeDice or sub-trait rating the edit leaves as stored", () => {
    // Stored data that a later check would refuse; an unrelated edit must still pass (point 5).
    const stored = edited(c => {
      Object.assign(social(c), { challenged: true, preChallengeDice: [7] });
      shoot(c).sub[0].dice = [7];
    });
    const proposed = edited(c => { social(c).statement = "I keep my word, mostly"; }, stored);
    expect(validateEntryRatings(stored, proposed)).toEqual({ ok: true, value: { checked: [] } });
  });

  it("ADR-037 point 2 checks a sub-trait's rating again when the entry moves to another set", () => {
    const proposed = edited(c => {
      const [entry] = c.traits[SKILLS].entries.splice(0, 1);
      c.traits[DISTINCTIONS].entries.push({ ...entry, defId: null });
    });
    expect(validateEntryRatings(pc(), proposed)).toEqual({
      ok: true, value: { checked: [{ setId: DISTINCTIONS, entryId: E3, subId: S1, field: "sub" }] }
    });
  });

  it("RQ-022 b and TS-14b: a saved preChallengeDice of [8] passes, and what was checked is listed", () => {
    const proposed = edited(c => Object.assign(social(c), { dice: [4], challenged: true, preChallengeDice: [8] }));
    expect(validateEntryRatings(pc(), proposed)).toEqual({
      ok: true, value: { checked: [{ setId: ATTRIBUTES, entryId: E2, subId: null, field: "preChallengeDice" }] }
    });
  });

  it("TS-19 to TS-21 (MOD Specialties): sub-traits rated [6], [10] and [6, 6] pass", () => {
    const proposed = edited(c => {
      shoot(c).sub = [
        { id: S1, name: "Guns", dice: [6] },
        { id: S2, name: "Motorcycles", dice: [10] },
        { id: "subtrait00000003", name: "Rifles", dice: [6, 6] }
      ];
    });
    const result = validateEntryRatings(pc(), proposed);
    expect(result.ok).toBe(true);
    expect(result.value.checked.map(c => c.subId)).toEqual([S2, "subtrait00000003"]);
  });

  it("doesn't read free traits, whose schema has neither field", () => {
    const proposed = edited(c => {
      c.freeTraits.push({ id: "free000000000001", name: "Boss", dice: [8, 8, 8], preChallengeDice: [7] });
    });
    expect(validateEntryRatings(pc(), proposed)).toEqual({ ok: true, value: { checked: [] } });
  });

  it("refuses data it can't read: INVALID_TRAIT_DATA", () => {
    expect(validateEntryRatings(null, pc())).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(validateEntryRatings(pc(), edited(c => { shoot(c).sub = { id: S1 }; }))).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(validateEntryRatings(pc(), edited(c => { shoot(c).sub = [null]; }))).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(validateEntryRatings(pc(), edited(c => { shoot(c).sub[0].id = "short"; }))).toEqual(refused("INVALID_TRAIT_DATA"));
  });

  it("never changes its inputs", () => {
    const current = Object.freeze(pc());
    const proposed = edited(c => Object.assign(social(c), { challenged: true, preChallengeDice: [8] }));
    const copy = structuredClone(proposed);
    validateEntryRatings(current, proposed);
    expect(proposed).toEqual(copy);
  });
});

describe("checkCharacterEdit with the new entry fields (ADR-037)", () => {
  const check = edit => checkCharacterEdit(pc(), edited(edit), defaultGameConfig());

  it("TS-E01 refuses a d7 in a preChallengeDice before a shape error in a rating (die sizes before set shapes)", () => {
    const result = check(c => {
      Object.assign(social(c), { challenged: true, preChallengeDice: [7] });
      c.traits[DISTINCTIONS].entries[0].dice = [6, 6];
    });
    expect(result).toEqual(refused("INVALID_DIE_SIZE"));
  });

  it("TS-E01 refuses a d7 in a sub-trait's rating", () => {
    expect(check(c => { shoot(c).sub[0].dice = [7]; })).toEqual(refused("INVALID_DIE_SIZE"));
  });

  it("PARKED rule 19: a sub-trait's rating gets the die-size check only, so [6, 6] passes under a one-die skill", () => {
    // Which set shape a sub-trait's rating must fit is not settled; ADR-029 point 2 refuses only
    // data that can't exist, and [6, 6] is a valid multi-level specialty (TS-21).
    expect(check(c => { shoot(c).sub[0].dice = [6, 6]; })).toMatchObject({ ok: true });
  });

  it("TS-14 the challenge written back passes: [6], challenged, preChallengeDice [8]", () => {
    expect(check(c => { c.traits[ATTRIBUTES].entries[0] = challengeStatement(social(c)).value; })).toMatchObject({ ok: true });
  });

  it("TS-15c editing the statement, SFX, tags and description needs no configuration check", () => {
    const result = check(c => {
      Object.assign(social(c), editStatement(social(c), "I keep my word, mostly").value);
      social(c).sfx = [{ text: "Swayed by a friend", unlocked: false }];
      social(c).tags = ["Trust"];
      c.traits[DISTINCTIONS].entries[0].description = "Knows most ports";
    });
    expect(result).toMatchObject({ ok: true, value: { entries: [] } });
  });

  it("rule 15: setting a set's or an entry's shut-down flag needs no configuration check", () => {
    const result = check(c => {
      c.traits[SKILLS].shutDown = true;
      social(c).shutDown = { reason: "manual" };
    });
    expect(result).toMatchObject({ ok: true, value: { entries: [] } });
  });
});

describe("checkCharacterUpdate with the new entry fields (the backstop's path)", () => {
  it("TS-E01 refuses a d7 in a preChallengeDice sent with a sheet submit of a set's entries", () => {
    const entries = [{ ...social(pc()), challenged: true, preChallengeDice: [7] }];
    const result = checkCharacterUpdate(pc(), { traits: { [ATTRIBUTES]: { entries } } }, defaultGameConfig());
    expect(result).toEqual(refused("INVALID_DIE_SIZE"));
  });

  it("rule 15: a set's shut-down flag sent alone passes and leaves the entries as stored", () => {
    const result = checkCharacterUpdate(pc(), { traits: { [SKILLS]: { shutDown: true } } }, defaultGameConfig());
    expect(result).toMatchObject({ ok: true, value: { entries: [] } });
  });
});

describe("statements on entries shaped like the model's data (rule 16)", () => {
  /** A d4 entry as the model reads it: the optional fields undefined, sfx empty. */
  const modelEntry = () => ({
    id: E2, defId: SOCIAL, name: "Social", dice: [4], description: undefined, statement: "I always keep my word",
    challenged: undefined, preChallengeDice: undefined, sfx: [], tags: undefined, sub: undefined, shutDown: undefined
  });

  it("TS-16 challenges such an entry: [4], challenged, preChallengeDice [4], shut down by the challenge", () => {
    const result = challengeStatement(modelEntry());
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({
      dice: [4], challenged: true, preChallengeDice: [4], shutDown: { reason: "statementChallenged" }, sfx: []
    });
  });

  it("TS-16 rewritten: the shut-down and the challenge fields are removed, not set to null", () => {
    const resolved = resolveChallengedStatement(challengeStatement(modelEntry()).value, { rewritten: true }).value;
    expect(resolved.dice).toEqual([4]);
    for ( const key of ["challenged", "preChallengeDice", "shutDown"] ) expect(Object.hasOwn(resolved, key)).toBe(false);
  });

  it("TS-14 keeps the entry's SFX, tags, description and sub-traits through a challenge", () => {
    const entry = {
      ...modelEntry(), dice: [8], description: "Warm", sfx: [{ text: "Charm", unlocked: true }], tags: ["Trust"],
      sub: [{ id: S1, name: "Haggling", dice: [6] }]
    };
    const result = challengeStatement(entry).value;
    expect(result).toMatchObject({
      dice: [6], description: "Warm", sfx: [{ text: "Charm", unlocked: true }], tags: ["Trust"],
      sub: [{ id: S1, name: "Haggling", dice: [6] }]
    });
  });
});
