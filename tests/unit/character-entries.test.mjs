import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "../../module/rules/game-config.mjs";
import { checkCharacterEdit, checkCharacterUpdate, validateEntryFields } from "../../module/rules/traits.mjs";
import * as rules from "../../module/rules/index.mjs";
import { challengeStatement, editStatement, resolveChallengedStatement } from "../../module/rules/statements.mjs";

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

describe("validateEntryFields (ADR-037 point 2 for the entry's other fields)", () => {
  it("is exported from the rules index", () => {
    expect(rules.validateEntryFields).toBe(validateEntryFields);
  });

  it("TS-E01 refuses a d7 in a preChallengeDice the edit sets", () => {
    const proposed = edited(c => Object.assign(social(c), { challenged: true, preChallengeDice: [7] }));
    expect(validateEntryFields(pc(), proposed)).toEqual(refused("INVALID_DIE_SIZE"));
  });

  it("TS-E01 refuses a d7 or a d14 in a sub-trait's rating the edit sets", () => {
    expect(validateEntryFields(pc(), edited(c => { shoot(c).sub[0].dice = [7]; }))).toEqual(refused("INVALID_DIE_SIZE"));
    const added = edited(c => { shoot(c).sub.push({ id: S2, name: "Bows", dice: [6, 14] }); });
    expect(validateEntryFields(pc(), added)).toEqual(refused("INVALID_DIE_SIZE"));
  });

  it("ADR-037 point 2 refuses a saved rating that isn't a list instead of coercing it", () => {
    const unchallenged = edited(c => Object.assign(social(c), { preChallengeDice: "8" }));
    expect(validateEntryFields(pc(), unchallenged)).toEqual(refused("INVALID_DIE_SIZE"));
    // A challenged entry's saved rating is read as statements.mjs reads it.
    const challenged = edited(c => Object.assign(social(c), { challenged: true, preChallengeDice: "8" }));
    expect(validateEntryFields(pc(), challenged)).toEqual(refused("INVALID_TRAIT_DATA"));
  });

  it("RQ-022 refuses a challenge the edit sets without a saved rating, or with an empty one", () => {
    // statements.mjs couldn't resolve such a challenge, and resolving is the only way to clear it.
    for ( const fields of [{ challenged: true }, { challenged: true, preChallengeDice: [] }] ) {
      const proposed = edited(c => Object.assign(social(c), fields));
      expect(validateEntryFields(pc(), proposed), JSON.stringify(fields)).toEqual(refused("INVALID_TRAIT_DATA"));
    }
  });

  it("rule 16 and RQ-021 refuse a non-boolean challenged and an unknown shut-down reason the edit sets", () => {
    const cases = [{ challenged: "yes" }, { shutDown: { reason: "forgotten" } }, { shutDown: {} }, { shutDown: "manual" }];
    for ( const fields of cases ) {
      const proposed = edited(c => Object.assign(social(c), fields));
      expect(validateEntryFields(pc(), proposed), JSON.stringify(fields)).toEqual(refused("INVALID_TRAIT_DATA"));
    }
  });

  it("RQ-021 refuses an unknown shut-down reason even when the stored saved rating holds a d7", () => {
    const stored = edited(c => Object.assign(social(c), { challenged: true, preChallengeDice: [7] }));
    const proposed = edited(c => { social(c).shutDown = { reason: "forgotten" }; }, stored);
    expect(validateEntryFields(stored, proposed)).toEqual(refused("INVALID_TRAIT_DATA"));
  });

  it("ADR-037 point 2 lets an unrelated edit through on a stored challenge without a saved rating, and clearing it", () => {
    const stored = edited(c => { social(c).challenged = true; });
    const unrelated = edited(c => { c.traits[DISTINCTIONS].entries[0].description = "Knows most ports"; }, stored);
    expect(validateEntryFields(stored, unrelated)).toMatchObject({ ok: true });
    const cleared = edited(c => { delete social(c).challenged; }, stored);
    expect(validateEntryFields(stored, cleared)).toMatchObject({ ok: true });
  });

  it("ADR-037 point 3 refuses stored data with a malformed sub-trait list, so the backstop steps aside, and lets the repair through", () => {
    const stored = edited(c => { shoot(c).sub = [{ id: "short", name: "Guns", dice: [6] }]; });
    expect(validateEntryFields(stored, stored)).toEqual(refused("INVALID_TRAIT_DATA"));
    const repaired = edited(c => { shoot(c).sub = [{ id: S1, name: "Guns", dice: [6] }]; }, stored);
    expect(validateEntryFields(stored, repaired)).toMatchObject({ ok: true });
  });

  it("ADR-037 point 2 doesn't check again a preChallengeDice or sub-trait rating the edit leaves as stored", () => {
    // Stored data that a later check would refuse; an unrelated edit must still pass (point 5).
    const stored = edited(c => {
      Object.assign(social(c), { challenged: true, preChallengeDice: [7] });
      shoot(c).sub[0].dice = [7];
    });
    const proposed = edited(c => { social(c).statement = "I keep my word, mostly"; }, stored);
    expect(validateEntryFields(stored, proposed)).toEqual({ ok: true, value: { checked: [] } });
  });

  it("ADR-037 point 2 checks a sub-trait's rating again when the entry moves to another set", () => {
    const proposed = edited(c => {
      const [entry] = c.traits[SKILLS].entries.splice(0, 1);
      c.traits[DISTINCTIONS].entries.push({ ...entry, defId: null });
    });
    expect(validateEntryFields(pc(), proposed)).toEqual({
      ok: true, value: { checked: [{ setId: DISTINCTIONS, entryId: E3, subId: S1, field: "sub" }] }
    });
  });

  it("RQ-022 b and TS-14b: a saved preChallengeDice of [8] passes, and what was checked is listed", () => {
    const proposed = edited(c => Object.assign(social(c), { dice: [4], challenged: true, preChallengeDice: [8] }));
    expect(validateEntryFields(pc(), proposed)).toEqual({
      ok: true, value: { checked: [{ setId: ATTRIBUTES, entryId: E2, subId: null, field: "preChallengeDice" }] }
    });
  });

  it("rule 19: sub-traits rated [6], [10] and [6, 6] (the ratings of TS-19 to TS-21) pass the die-size check", () => {
    const proposed = edited(c => {
      shoot(c).sub = [
        { id: S1, name: "Guns", dice: [6] },
        { id: S2, name: "Motorcycles", dice: [10] },
        { id: "subtrait00000003", name: "Rifles", dice: [6, 6] }
      ];
    });
    const result = validateEntryFields(pc(), proposed);
    expect(result.ok).toBe(true);
    expect(result.value.checked.map(c => c.subId)).toEqual([S2, "subtrait00000003"]);
  });

  it("doesn't read free traits, whose schema has neither field", () => {
    const proposed = edited(c => {
      c.freeTraits.push({ id: "free000000000001", name: "Boss", dice: [8, 8, 8], preChallengeDice: [7] });
    });
    expect(validateEntryFields(pc(), proposed)).toEqual({ ok: true, value: { checked: [] } });
  });

  it("ADR-046 point 4 refuses an SFX the edit sets without a boolean unlocked flag, on an entry and on a set", () => {
    const bad = [[{ text: "Charm" }], [{ text: "Charm", unlocked: "yes" }], [{ text: 5, unlocked: true }], ["Charm"], "Charm"];
    for ( const sfx of bad ) {
      expect(validateEntryFields(pc(), edited(c => { social(c).sfx = sfx; }))).toEqual(refused("INVALID_TRAIT_DATA"));
      expect(validateEntryFields(pc(), edited(c => { c.traits[SKILLS].sfx = sfx; }))).toEqual(refused("INVALID_TRAIT_DATA"));
    }
    const sparse = [{ text: "Charm", unlocked: true }];
    sparse.length = 2;
    expect(validateEntryFields(pc(), edited(c => { social(c).sfx = sparse; }))).toEqual(refused("INVALID_TRAIT_DATA"));
  });

  it("ADR-046 point 4 refuses a tag, name, description, statement or sub-trait name the edit sets that isn't text", () => {
    const edits = [
      c => { social(c).tags = ["Trust", 7]; },
      c => { social(c).tags = "Trust"; },
      c => { social(c).name = 7; },
      c => { social(c).description = { text: "x" }; },
      c => { social(c).statement = null; },
      c => { shoot(c).sub[0].name = 7; },
      c => { shoot(c).sub.push({ id: S2, name: "Bows" }); },
      c => { c.traits[SKILLS].shutDown = "yes"; },
      c => { c.freeTraits.push({ id: "free000000000001", name: 7, dice: [8] }); }
    ];
    for ( const edit of edits ) expect(validateEntryFields(pc(), edited(edit))).toEqual(refused("INVALID_TRAIT_DATA"));
  });

  it("ADR-046 points 2, 3 and 5: text, tags, a locked and an unlocked SFX and a set's own SFX pass", () => {
    const proposed = edited(c => {
      Object.assign(social(c), { tags: ["Trust", ""], description: "", sfx: [{ text: "Charm", unlocked: false }, { unlocked: true }] });
      c.traits[SKILLS].sfx = [{ text: "Overload", unlocked: true }];
      c.freeTraits.push({ id: "free000000000001", name: "Big Shotgun", dice: [8] });
    });
    expect(validateEntryFields(pc(), proposed)).toEqual({ ok: true, value: { checked: [] } });
  });

  it("ADR-037 point 2 doesn't check again a plain field the edit leaves as stored", () => {
    const stored = edited(c => {
      social(c).sfx = [{ text: "Charm" }];
      c.traits[SKILLS].sfx = [{ text: "Overload" }];
      c.freeTraits.push({ id: "free000000000001", name: 7, dice: [8] });
    });
    const proposed = edited(c => { social(c).dice = [10]; c.traits[DISTINCTIONS].entries[0].description = "Knows most ports"; }, stored);
    expect(validateEntryFields(stored, proposed).ok).toBe(true);
    const repaired = edited(c => { social(c).sfx = [{ text: "Charm", unlocked: true }]; }, stored);
    expect(validateEntryFields(stored, repaired).ok).toBe(true);
    const moved = edited(c => { c.traits[DISTINCTIONS].entries.push(c.traits[ATTRIBUTES].entries.pop()); }, stored);
    expect(validateEntryFields(stored, moved)).toEqual(refused("INVALID_TRAIT_DATA"));
  });

  it("refuses data it can't read: INVALID_TRAIT_DATA", () => {
    expect(validateEntryFields(null, pc())).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(validateEntryFields(pc(), edited(c => { shoot(c).sub = { id: S1 }; }))).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(validateEntryFields(pc(), edited(c => { shoot(c).sub = [null]; }))).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(validateEntryFields(pc(), edited(c => { shoot(c).sub[0].id = "short"; }))).toEqual(refused("INVALID_TRAIT_DATA"));
  });

  it("never changes its inputs", () => {
    const current = Object.freeze(pc());
    const proposed = edited(c => Object.assign(social(c), { challenged: true, preChallengeDice: [8] }));
    const copy = structuredClone(proposed);
    validateEntryFields(current, proposed);
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

  it("ADR-046 point 1, rule 19: a sub-trait's rating gets the die-size check only, so [6, 6] passes under a one-die skill", () => {
    // The parent set's rating options don't apply to a sub-trait: [6, 6] is a valid multi-level
    // specialty under a one-die skill (TS-21; Handbook p. 59).
    expect(check(c => { shoot(c).sub[0].dice = [6, 6]; })).toMatchObject({ ok: true });
  });

  it("TS-14 the challenge written back passes: [6], challenged, preChallengeDice [8]", () => {
    expect(check(c => { c.traits[ATTRIBUTES].entries[0] = challengeStatement(social(c)).value; })).toMatchObject({ ok: true });
  });

  it("TS-15c editing a challenged entry's statement, SFX, tags and description keeps the challenge, with no configuration check", () => {
    const challenged = edited(c => { c.traits[ATTRIBUTES].entries[0] = challengeStatement(social(c)).value; });
    const proposed = edited(c => {
      c.traits[ATTRIBUTES].entries[0] = editStatement(social(c), "I keep my word, mostly").value;
      social(c).sfx = [{ text: "Swayed by a friend", unlocked: false }];
      social(c).tags = ["Trust"];
      c.traits[DISTINCTIONS].entries[0].description = "Knows most ports";
    }, challenged);
    expect(checkCharacterEdit(challenged, proposed, defaultGameConfig())).toMatchObject({ ok: true, value: { entries: [] } });
    expect(social(proposed)).toMatchObject({
      statement: "I keep my word, mostly", dice: [6], challenged: true, preChallengeDice: [8]
    });
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
  it("ADR-046 point 4 refuses a sheet submit of a set's entries holding an SFX without its unlocked flag", () => {
    const entries = [{ ...social(pc()), dice: [10], sfx: [{ text: "Charm" }] }];
    const changes = { traits: { [ATTRIBUTES]: { entries } } };
    expect(checkCharacterUpdate(pc(), changes, defaultGameConfig())).toEqual(refused("INVALID_TRAIT_DATA"));
  });

  it("ADR-046 point 5: a set's own SFX sent alone pass and leave the entries as stored", () => {
    const changes = { traits: { [SKILLS]: { sfx: [{ text: "Overload", unlocked: false }] } } };
    expect(checkCharacterUpdate(pc(), changes, defaultGameConfig())).toMatchObject({ ok: true, value: { entries: [] } });
    const bad = { traits: { [SKILLS]: { sfx: [{ text: "Overload" }] } } };
    expect(checkCharacterUpdate(pc(), bad, defaultGameConfig())).toEqual(refused("INVALID_TRAIT_DATA"));
  });

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
