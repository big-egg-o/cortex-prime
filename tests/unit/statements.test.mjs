import { describe, expect, it } from "vitest";
import { challengeStatement, editStatement, resolveChallengedStatement } from "../../module/rules/statements.mjs";
import { traitPoolEntries } from "../../module/rules/trait-pool.mjs";
import { ratingGuidance } from "../../module/rules/sheet-hints.mjs";
import { defaultGameConfig, ratingOptionsOf, traitSetById } from "../../module/rules/game-config.mjs";
import { validateRating } from "../../module/rules/traits.mjs";

const ID = "social0000000001";

/** TS-14's trait: Social rated d8 with a statement (Handbook p. 65's example). */
function social(fields = {}) {
  return { id: ID, defId: null, name: "Social", dice: [8], statement: "I always keep my word", ...fields };
}

const sizes = result => result.value.map(e => e.size);
const refused = code => ({ ok: false, code });

describe("challengeStatement (MOD Trait Statements, rule 16)", () => {
  it("TS-14 a d8 trait challenged: d8 d8 d8 for the roll, then [6], challenged, preChallengeDice [8]", () => {
    const trait = social();
    expect(sizes(traitPoolEntries({ label: "Social", dice: trait.dice }, { challenge: true }))).toEqual([8, 8, 8]);
    expect(challengeStatement(trait)).toEqual({
      ok: true, value: { ...trait, dice: [6], challenged: true, preChallengeDice: [8] }
    });
  });

  it("TS-14b challenged again before resolution: d6 d6 d6, then [4], preChallengeDice stays [8] (RQ-022 a)", () => {
    const once = challengeStatement(social()).value;
    expect(sizes(traitPoolEntries({ label: "Social", dice: once.dice }, { challenge: true }))).toEqual([6, 6, 6]);
    expect(challengeStatement(once).value).toEqual({ ...social(), dice: [4], challenged: true, preChallengeDice: [8] });
  });

  it("TS-16 a trait rated [4] from the start stays [4] and is shut down (RQ-021)", () => {
    const trait = social({ dice: [4] });
    expect(sizes(traitPoolEntries({ label: "Social", dice: trait.dice }, { challenge: true }))).toEqual([4, 4, 4]);
    expect(challengeStatement(trait).value).toEqual({
      ...trait, dice: [4], challenged: true, preChallengeDice: [4], shutDown: { reason: "statementChallenged" }
    });
  });

  it("TS-16c TS-14b's trait challenged a third time: d4 d4 d4, then shut down, preChallengeDice still [8]", () => {
    const twice = challengeStatement(challengeStatement(social()).value).value;
    expect(sizes(traitPoolEntries({ label: "Social", dice: twice.dice }, { challenge: true }))).toEqual([4, 4, 4]);
    expect(challengeStatement(twice).value).toEqual({
      ...social(), dice: [4], challenged: true, preChallengeDice: [8], shutDown: { reason: "statementChallenged" }
    });
  });

  it("keeps a shut-down flag the table set by hand", () => {
    const trait = social({ dice: [4], shutDown: { reason: "manual" } });
    expect(challengeStatement(trait).value.shutDown).toEqual({ reason: "manual" });
  });

  it("refuses a trait with no rating, a rating of several dice (parked) and a die size that doesn't exist", () => {
    expect(challengeStatement(social({ dice: [] }))).toEqual(refused("TRAIT_UNRATED"));
    expect(challengeStatement(social({ dice: [6, 6] }))).toEqual(refused("STATEMENT_RATING_NOT_ONE_DIE"));
    expect(challengeStatement(social({ dice: [7] }))).toEqual(refused("INVALID_DIE_SIZE"));
    expect(challengeStatement(null)).toEqual(refused("INVALID_TRAIT_DATA"));
  });

  it("refuses a challenged trait whose saved rating is missing or not a rating, instead of overwriting it", () => {
    expect(challengeStatement(social({ challenged: true, preChallengeDice: [9] }))).toEqual(refused("INVALID_DIE_SIZE"));
    expect(challengeStatement(social({ dice: [6], challenged: true }))).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(challengeStatement(social({ dice: [6], challenged: true, preChallengeDice: [] }))).toEqual(refused("INVALID_TRAIT_DATA"));
  });

  it("refuses a challenged flag that isn't a boolean, and a shut-down that isn't {reason}", () => {
    for ( const challenged of ["true", 1, null] ) {
      expect(challengeStatement(social({ dice: [6], challenged, preChallengeDice: [8] }))).toEqual(refused("INVALID_TRAIT_DATA"));
    }
    for ( const shutDown of [true, "manual", {}, { reason: "bogus" }, null] ) {
      expect(challengeStatement(social({ dice: [4], shutDown }))).toEqual(refused("INVALID_TRAIT_DATA"));
    }
  });

  it("ignores a stale saved rating on a trait that isn't challenged, and saves the current one", () => {
    expect(challengeStatement(social({ challenged: false, preChallengeDice: null })).value.preChallengeDice).toEqual([8]);
  });

  it("never changes its input and shares no nested data with it", () => {
    const trait = deepFreeze(social({ sfx: [{ text: "Once per scene, reroll", unlocked: true }] }));
    const result = challengeStatement(trait).value;
    expect(result.preChallengeDice).not.toBe(trait.dice);
    expect(result.sfx[0]).not.toBe(trait.sfx[0]);
    expect(result.sfx).toEqual(trait.sfx);
  });

  it("TS-E07 a d6 trait in a d6-to-d12 set challenged drops to d4, which the set's shape accepts", () => {
    const set = { ...traitSetById(defaultGameConfig(), "cpSetSkills00000"), usualMin: 6, usualMax: 12 };
    const challenged = challengeStatement(social({ dice: [6] })).value;
    expect(challenged.dice).toEqual([4]);
    expect(validateRating(challenged.dice, ratingOptionsOf(set))).toEqual({ ok: true, value: [4] });
  });
});

describe("resolveChallengedStatement (rule 16)", () => {
  const twice = () => challengeStatement(challengeStatement(social()).value).value;

  it("TS-15 TS-14b resolved as rewritten: back to [8]; challenged and preChallengeDice cleared", () => {
    const resolved = resolveChallengedStatement(twice(), { rewritten: true });
    expect(resolved).toEqual({ ok: true, value: social() });
    expect(resolved.value).not.toHaveProperty("challenged");
    expect(resolved.value).not.toHaveProperty("preChallengeDice");
  });

  it("TS-15b TS-14b resolved as kept: stays [4]; challenged and preChallengeDice cleared", () => {
    expect(resolveChallengedStatement(twice(), { rewritten: false }).value).toEqual(social({ dice: [4] }));
  });

  it("TS-16 a d4 shut down by its challenge: rewritten clears the shut-down, kept leaves it", () => {
    const shut = challengeStatement(social({ dice: [4] })).value;
    expect(resolveChallengedStatement(shut, { rewritten: true }).value).toEqual(social({ dice: [4] }));
    expect(resolveChallengedStatement(shut, { rewritten: false }).value)
      .toEqual(social({ dice: [4], shutDown: { reason: "statementChallenged" } }));
  });

  it("TS-16c rewritten after three challenges: shut-down cleared, back to [8] (RQ-022 b)", () => {
    const thrice = challengeStatement(twice()).value;
    expect(resolveChallengedStatement(thrice, { rewritten: true }).value).toEqual(social());
  });

  it("never clears a shut-down the table set by hand", () => {
    const trait = challengeStatement(social({ shutDown: { reason: "manual" } })).value;
    expect(resolveChallengedStatement(trait, { rewritten: true }).value.shutDown).toEqual({ reason: "manual" });
  });

  it("keeps a manual shut-down on a d4 through the challenge and either resolution (parked question)", () => {
    const trait = challengeStatement(social({ dice: [4], shutDown: { reason: "manual" } })).value;
    expect(trait.shutDown).toEqual({ reason: "manual" });
    expect(resolveChallengedStatement(trait, { rewritten: false }).value).toEqual(social({ dice: [4], shutDown: { reason: "manual" } }));
    expect(resolveChallengedStatement(trait, { rewritten: true }).value).toEqual(social({ dice: [4], shutDown: { reason: "manual" } }));
  });

  it("refuses a trait whose statement isn't challenged, and a choice that isn't a boolean", () => {
    expect(resolveChallengedStatement(social(), { rewritten: true })).toEqual(refused("STATEMENT_NOT_CHALLENGED"));
    expect(resolveChallengedStatement(twice(), { rewritten: "yes" })).toEqual(refused("INVALID_TRAIT_OPTIONS"));
    expect(resolveChallengedStatement(twice(), {})).toEqual(refused("INVALID_TRAIT_OPTIONS"));
    expect(resolveChallengedStatement(twice())).toEqual(refused("INVALID_TRAIT_OPTIONS"));
  });

  it("refuses a challenged trait without a valid saved rating, rewritten or kept", () => {
    const broken = { ...twice() };
    delete broken.preChallengeDice;
    expect(resolveChallengedStatement(broken, { rewritten: true })).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(resolveChallengedStatement(broken, { rewritten: false })).toEqual(refused("INVALID_TRAIT_DATA"));
    expect(resolveChallengedStatement({ ...twice(), preChallengeDice: [9] }, { rewritten: false })).toEqual(refused("INVALID_DIE_SIZE"));
  });

  it("refuses a rating with a die size that doesn't exist", () => {
    expect(resolveChallengedStatement({ ...twice(), dice: [7] }, { rewritten: false })).toEqual(refused("INVALID_DIE_SIZE"));
    expect(resolveChallengedStatement({ ...twice(), dice: "8" }, { rewritten: false })).toEqual(refused("INVALID_DIE_SIZE"));
  });

  it("never changes its input", () => {
    const trait = deepFreeze(twice());
    expect(resolveChallengedStatement(trait, Object.freeze({ rewritten: true })).ok).toBe(true);
    expect(trait.challenged).toBe(true);
  });
});

describe("editStatement", () => {
  it("TS-15c editing the text of a challenged statement changes nothing else (RQ-021 amendment)", () => {
    const once = challengeStatement(social()).value;
    expect(editStatement(once, "I keep my word, mostly")).toEqual({ ok: true, value: { ...once, statement: "I keep my word, mostly" } });
  });

  it("refuses a statement that isn't text", () => {
    expect(editStatement(social(), 5)).toEqual(refused("INVALID_TRAIT_DATA"));
  });
});

describe("ratingGuidance (rule 9, TS-E07, ADR-037 point 5)", () => {
  const skills = () => traitSetById(defaultGameConfig(), "cpSetSkills00000");
  const attributes = () => traitSetById(defaultGameConfig(), "cpSetAttributes0");

  it("TS-E07 a d6-to-d12 set holding a d4 after a challenge gives the hint RATING_OUTSIDE_GUIDANCE", () => {
    const set = { ...skills(), usualMin: 6, usualMax: 12 };
    const challenged = challengeStatement(social({ dice: [6] })).value;
    expect(ratingGuidance(set, challenged.dice)).toEqual({ ok: true, value: ["RATING_OUTSIDE_GUIDANCE"] });
    expect(ratingGuidance(set, [6])).toEqual({ ok: true, value: [] });
  });

  it("gives a free trait (no set) no hint", () => {
    expect(ratingGuidance(null, [4, 12])).toEqual({ ok: true, value: [] });
  });

  it("gives a set without dice only the conflict, not the guidance hint", () => {
    expect(ratingGuidance({ ...attributes(), hasDice: false }, [12]).value).toEqual(["RATING_CONFLICTS_WITH_SET"]);
  });

  it("hints above the usual maximum, for any die of a rating, and not at all without guidance", () => {
    expect(ratingGuidance(attributes(), [12]).value).toEqual(["RATING_OUTSIDE_GUIDANCE"]);
    expect(ratingGuidance({ ...attributes(), multiDice: true }, [8, 4]).value).toEqual(["RATING_OUTSIDE_GUIDANCE"]);
    expect(ratingGuidance({ ...attributes(), multiDice: true, usualMin: null, usualMax: null }, [4, 12]).value)
      .toEqual([]);
    expect(ratingGuidance(attributes(), [8, 4]).value).toEqual(["RATING_CONFLICTS_WITH_SET", "RATING_OUTSIDE_GUIDANCE"]);
  });

  it("hints RATING_CONFLICTS_WITH_SET for a rating that no longer fits the set's shape", () => {
    expect(ratingGuidance(attributes(), [8, 8]).value).toEqual(["RATING_CONFLICTS_WITH_SET"]);
    expect(ratingGuidance({ ...attributes(), hasDice: false }, [8]).value).toEqual(["RATING_CONFLICTS_WITH_SET"]);
  });

  it("refuses a set whose shape options aren't booleans instead of reporting a conflict", () => {
    expect(ratingGuidance({ ...attributes(), hasDice: null }, [8])).toEqual(refused("INVALID_RATING_OPTIONS"));
  });

  it("gives no hint for an empty rating (ADR-037, Q1)", () => {
    expect(ratingGuidance(attributes(), []).value).toEqual([]);
  });

  it("refuses a die size that doesn't exist", () => {
    expect(ratingGuidance(attributes(), [7])).toEqual(refused("INVALID_DIE_SIZE"));
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
