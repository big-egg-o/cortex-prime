import { describe, expect, it } from "vitest";
import {
  addContestRoll, applyContestHeroicSteps, applyHeroicSteps, applyOverflowChoice, applyRerolls, applyResults, buildPool,
  chooseContestOverflow, closeContest, contestConsequence, contestRollFromResolution, createContest, doubleDie, giveIn,
  resolve, resolveTest, stepEffectDie, stepPoolDie
} from "../../module/rules/index.mjs";
import {
  addTestRoll, applyTestHeroicSteps, autoApplyContestHeroicSteps, autoApplyTestHeroicSteps, chooseTestOverflow, closeTest,
  contestRollFromTotal, createTest, setContestHighStakes, setTestHighStakes, testResult
} from "../../module/rules/contest.mjs";
import { DIFFICULTY_SOURCE_KIND, difficultyEntry, difficultyLevelOfPool } from "../../module/rules/outcome.mjs";

/** @param {*} value @returns {*} the same value, frozen all the way down */
function deepFreeze(value) {
  if ( value && typeof value === "object" && !Object.isFrozen(value) ) {
    Object.freeze(value);
    for ( const key of Object.keys(value) ) deepFreeze(value[key]);
  }
  return value;
}

/** @returns {{kind: string, label: string}} a minimal DieSource for tests */
function source(label) {
  return { kind: "trait", label };
}

describe("engine functions never mutate their inputs", () => {
  it("buildPool works from frozen entries", () => {
    const entries = deepFreeze([
      { size: 8, source: source("Skill") },
      { size: 6, source: source("Asset"), count: 2 }
    ]);

    const pool = buildPool(entries);
    expect(pool).not.toBe(entries);
    expect(pool.map(d => d.size)).toEqual([8, 6, 6]);
  });

  it("doubleDie works from a frozen pool", () => {
    const pool = deepFreeze(buildPool([
      { size: 8, source: source("Skill") },
      { size: 6, source: source("Asset") }
    ]));

    const doubled = doubleDie(pool, pool[0].id);
    expect(doubled).not.toBe(pool);
    expect(doubled.map(d => d.size)).toEqual([8, 8, 6]);
  });

  it("stepPoolDie works from a frozen pool, including an overflow step", () => {
    const pool = deepFreeze(buildPool([{ size: 12, source: source("Skill") }]));

    const stepped = stepPoolDie(pool, pool[0].id, 1);
    expect(stepped).not.toBe(pool);
    expect(stepped.map(d => d.size)).toEqual([12, 6]);
  });

  it("applyResults works from a frozen pool and a frozen results array", () => {
    const pool = deepFreeze(buildPool([
      { size: 10, source: source("Skill") },
      { size: 8, source: source("Asset") }
    ]));
    const results = deepFreeze([7, 5]);

    const rolled = applyResults(pool, results);
    expect(rolled).not.toBe(pool);
    expect(rolled.map(d => d.result)).toEqual([7, 5]);
  });

  it("resolve works from a frozen roll and a frozen selection", () => {
    const pool = buildPool([
      { size: 10, source: source("Skill") },
      { size: 8, source: source("Asset") },
      { size: 6, source: source("Distinction") }
    ]);
    const rolled = deepFreeze(applyResults(pool, [7, 5, 3]));
    const selection = deepFreeze({
      totalIds: [rolled[0].id, rolled[1].id],
      effectDieIds: [rolled[2].id],
      extraResultsPaid: 0,
      extraEffectDicePaid: 0
    });

    const resolution = resolve(rolled, selection);
    expect(resolution).not.toBe(selection);
    expect(resolution.total).toBe(12);
  });

  it("stepEffectDie and applyOverflowChoice work from a frozen roll and resolution", () => {
    const pool = buildPool([
      { size: 12, source: source("Skill") },
      { size: 10, source: source("Attribute") },
      { size: 8, source: source("Asset") }
    ]);
    const rolled = deepFreeze(applyResults(pool, [3, 9, 8]));
    const selection = {
      totalIds: [rolled[1].id, rolled[2].id],
      effectDieIds: [rolled[0].id],
      extraResultsPaid: 0,
      extraEffectDicePaid: 0
    };
    const resolution = deepFreeze(resolve(rolled, selection));

    const stepped = stepEffectDie(rolled, resolution, "e1", 1, "heroic");
    expect(stepped).not.toBe(resolution);
    expect(stepped.overflow).not.toBeNull();

    const frozenStepped = deepFreeze(stepped);
    const withD6 = applyOverflowChoice(rolled, frozenStepped, { kind: "new-d6" });
    expect(withD6).not.toBe(frozenStepped);
    expect(withD6.effectDice).toHaveLength(2);
  });

  it("stepEffectDie removes a d4 effect die from a frozen roll and resolution (DP-24b)", () => {
    const pool = buildPool([
      { size: 10, source: source("Skill") },
      { size: 8, source: source("Attribute") },
      { size: 4, source: source("Asset") }
    ]);
    const rolled = deepFreeze(applyResults(pool, [7, 5, 3]));
    const selection = {
      totalIds: [rolled[0].id, rolled[1].id],
      effectDieIds: [rolled[2].id],
      extraResultsPaid: 0,
      extraEffectDicePaid: 0
    };
    const resolution = deepFreeze(resolve(rolled, selection));

    const removed = stepEffectDie(rolled, resolution, "e1", -1, "other");
    expect(removed).not.toBe(resolution);
    expect(removed.effectDice).toEqual([]);
    expect(removed.consumedDieIds).toEqual([rolled[2].id]);
    expect(resolution.effectDice).toHaveLength(1);
    expect(resolution.consumedDieIds).toEqual([]);
  });

  it("applyRerolls works from a frozen roll and a frozen results map", () => {
    const pool = buildPool([{ size: 8, source: source("Skill") }, { size: 6, source: source("Asset") }]);
    const rolled = deepFreeze(applyResults(pool, [1, 5]));
    const results = deepFreeze({ [rolled[0].id]: 6 });

    const rerolled = applyRerolls(rolled, results);
    expect(rerolled).not.toBe(rolled);
    expect(rerolled[0].result).toBe(6);
  });

  it("applyHeroicSteps works from a frozen roll, resolution and test outcome", () => {
    const pool = buildPool([
      { size: 10, source: source("Skill") },
      { size: 8, source: source("Attribute") },
      { size: 6, source: source("Asset") }
    ]);
    const rolled = deepFreeze(applyResults(pool, [9, 7, 4]));
    const selection = {
      totalIds: [rolled[0].id, rolled[1].id],
      effectDieIds: [rolled[2].id],
      extraResultsPaid: 0,
      extraEffectDicePaid: 0
    };
    const resolution = deepFreeze(resolve(rolled, selection));
    const outcome = deepFreeze(resolveTest({ total: resolution.total, difficulty: 8 }).value);

    const stepped = applyHeroicSteps(rolled, resolution, outcome, "e1");
    expect(stepped.value.resolution).not.toBe(resolution);
    expect(stepped.value.heroic).not.toBe(outcome);
    expect(stepped.value.resolution.effectDice[0].size).toBe(8);
    expect(resolution.effectDice[0].size).toBe(6);
    expect(outcome.heroicAppliedTo).toBeUndefined();
  });

  it("addContestRoll, giveIn and closeContest work from a frozen contest and roll", () => {
    const opening = deepFreeze({
      side: "initiator", total: 11, effects: [{ id: "e1", size: 6 }], overflows: [], messageRef: "roll-i1"
    });
    const started = deepFreeze(createContest().value);

    const opened = addContestRoll(started, opening);
    expect(opened.value).not.toBe(started);
    expect(opened.value.rolls[0]).not.toBe(opening);
    expect(opened.value.rolls[0].effects).not.toBe(opening.effects);
    expect(started.rolls).toEqual([]);

    const frozenOpened = deepFreeze(opened.value);
    const declined = giveIn(frozenOpened, "opposition");
    expect(declined.value).not.toBe(frozenOpened);
    expect(frozenOpened.status).toBe("open");

    const closed = closeContest(frozenOpened);
    expect(closed.value).not.toBe(frozenOpened);
    expect(frozenOpened.closed).toBe(false);

    const refused = addContestRoll(frozenOpened, { ...opening });
    expect(refused).toEqual({ ok: false, code: "CONTEST_NOT_YOUR_TURN" });
  });

  it("contestConsequence works from a frozen contest and input", () => {
    let state = createContest({ highStakes: true }).value;
    state = addContestRoll(state, {
      side: "initiator", total: 15, effects: [{ id: "e1", size: 10 }, { id: "e2", size: 6 }], overflows: [], messageRef: null
    }).value;
    state = deepFreeze(addContestRoll(state, {
      side: "opposition", total: 12, effects: [{ id: "e1", size: 8 }], overflows: [], messageRef: null
    }).value);
    const input = deepFreeze({ usedAgainstLoser: ["e1", "e2"] });

    const consequence = contestConsequence(state, input);
    expect(consequence.value.takenOut).toBe(true);
    expect(consequence.value.winnerEffects).not.toBe(state.rolls[0].effects);
    expect(consequence.value.winnerEffects[0]).not.toBe(state.rolls[0].effects[0]);
  });

  it("contestRollFromResolution works from a frozen roll and Resolution", () => {
    const rolled = deepFreeze(applyResults(buildPool([
      { size: 10, source: source("Skill") }, { size: 8, source: source("Attribute") },
      { size: 12, source: source("Asset") }, { size: 4, source: source("Distinction") }
    ]), [7, 6, 5, 3]));
    const resolution = resolve(rolled, {
      totalIds: [rolled[0].id, rolled[1].id], effectDieIds: [rolled[2].id], extraResultsPaid: 0, extraEffectDicePaid: 0
    });
    const pastD12 = deepFreeze(stepEffectDie(rolled, resolution, "e1", 1, "other"));

    const roll = contestRollFromResolution("initiator", rolled, pastD12, "roll-i1");
    expect(roll.ok).toBe(true);
    expect(roll.value.effects[0]).not.toBe(pastD12.effectDice[0]);
    expect(roll.value.leftovers).not.toBe(pastD12.overflow.options.leftovers);
    expect(roll.value.leftovers[0]).not.toBe(pastD12.overflow.options.leftovers[0]);
    expect(pastD12.overflow).toMatchObject({ effectId: "e1", cause: "other" });
  });

  it("applyContestHeroicSteps works from a frozen contest", () => {
    let state = createContest().value;
    state = addContestRoll(state, {
      side: "initiator", total: 17, effects: [{ id: "e1", size: 8 }, { id: "e2", size: 6 }], overflows: [],
      leftovers: [], nextEffectNumber: 3, messageRef: null
    }).value;
    state = deepFreeze(addContestRoll(state, {
      side: "opposition", total: 12, effects: [{ id: "e1", size: 8 }], overflows: [],
      leftovers: [], nextEffectNumber: 2, messageRef: null
    }).value);

    const stepped = applyContestHeroicSteps(state, "e1");
    expect(stepped.ok).toBe(true);
    expect(stepped.value).not.toBe(state);
    expect(stepped.value.rolls[0]).not.toBe(state.rolls[0]);
    expect(stepped.value.rolls[0].effects[0].size).toBe(10);
    expect(state.heroicAppliedTo).toBeNull();
    expect(state.rolls[0].effects[0].size).toBe(8);
  });

  it("chooseContestOverflow works from a frozen contest and choice", () => {
    let state = createContest().value;
    state = addContestRoll(state, {
      side: "initiator", total: 15, effects: [{ id: "e1", size: 12 }],
      overflows: [{ effectId: "e1", cause: "other", kind: null, dieId: null }],
      leftovers: [{ dieId: "d4", size: 4 }], nextEffectNumber: 2, messageRef: null
    }).value;
    state = deepFreeze(addContestRoll(state, {
      side: "opposition", total: 12, effects: [{ id: "e1", size: 8 }], overflows: [],
      leftovers: [], nextEffectNumber: 2, messageRef: null
    }).value);
    const choice = deepFreeze({ kind: "leftover", dieId: "d4" });

    const chosen = chooseContestOverflow(state, choice);
    expect(chosen.ok).toBe(true);
    expect(chosen.value).not.toBe(state);
    expect(chosen.value.rolls[0]).not.toBe(state.rolls[0]);
    expect(chosen.value.rolls[0].effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 4 }]);
    expect(state.rolls[0].overflows[0].kind).toBeNull();
    expect(state.rolls[0].effects).toEqual([{ id: "e1", size: 12 }]);
  });
});

describe("the Step 4.4 engine functions never mutate their inputs", () => {
  /**
   * @param {number} total
   * @param {import("../../module/rules/types.mjs").ContestEffect[]} effects
   * @param {object} [extra] - fields that replace the defaults, such as overflows or leftovers
   * @returns {import("../../module/rules/types.mjs").ContestRoll} a hand-built roll for a test's roller
   */
  function rollerRoll(total, effects, extra = {}) {
    return {
      side: "roller", total, effects, overflows: [], leftovers: [], nextEffectNumber: effects.length + 1,
      messageRef: null, ...extra
    };
  }

  /**
   * A frozen test against difficulty 8 holding a roll of 17 with effect dice d12 (e1, its overflow
   * open, a d4 "d4" left over) and d6 (e2): margin 9, one heroic step not yet applied.
   */
  function frozenHeroicTest() {
    const started = createTest({ difficulty: 8 }).value;
    return deepFreeze(addTestRoll(started, rollerRoll(17, [{ id: "e1", size: 12 }, { id: "e2", size: 6 }], {
      overflows: [{ effectId: "e1", cause: "other", kind: null, dieId: null }], leftovers: [{ dieId: "d4", size: 4 }]
    })).value);
  }

  /** A frozen test against difficulty 13 holding a roll of 14 with a d6 effect die: no heroic steps. */
  function frozenPlainTest() {
    const started = createTest({ difficulty: 13 }).value;
    return deepFreeze(addTestRoll(started, rollerRoll(14, [{ id: "e1", size: 6 }])).value);
  }

  it("createTest works from frozen options", () => {
    const options = deepFreeze({ difficulty: 13, highStakes: true });
    const started = createTest(options);
    expect(started.value).not.toBe(options);
    expect(started.value).toMatchObject({ difficulty: 13, highStakes: true });
  });

  it("addTestRoll works from a frozen test and roll", () => {
    const started = deepFreeze(createTest({ difficulty: 13 }).value);
    const roll = deepFreeze(rollerRoll(14, [{ id: "e1", size: 6 }], { leftovers: [{ dieId: "d4", size: 4 }] }));

    const added = addTestRoll(started, roll);
    expect(added.value).not.toBe(started);
    expect(added.value.roll).not.toBe(roll);
    expect(added.value.roll.effects).not.toBe(roll.effects);
    expect(added.value.roll.leftovers).not.toBe(roll.leftovers);
    expect(started.roll).toBeNull();
  });

  it("applyTestHeroicSteps works from a frozen test", () => {
    const state = frozenHeroicTest();
    const stepped = applyTestHeroicSteps(state, "e2");
    expect(stepped.value).not.toBe(state);
    expect(stepped.value.roll).not.toBe(state.roll);
    expect(stepped.value.roll.effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 8 }]);
    expect(state.roll.effects[1].size).toBe(6);
    expect(state.heroicAppliedTo).toBeNull();
  });

  it("chooseTestOverflow works from a frozen test and choice", () => {
    const stepped = deepFreeze(applyTestHeroicSteps(frozenHeroicTest(), "e1").value);
    const choice = deepFreeze({ kind: "leftover", dieId: "d4" });

    const chosen = chooseTestOverflow(stepped, choice);
    expect(chosen.value).not.toBe(stepped);
    expect(chosen.value.roll.effects).toEqual([{ id: "e1", size: 12 }, { id: "e2", size: 6 }, { id: "e3", size: 4 }]);
    expect(stepped.roll.overflows[0].kind).toBeNull();
    expect(stepped.roll.leftovers).toEqual([{ dieId: "d4", size: 4 }]);
  });

  it("setTestHighStakes and closeTest work from a frozen test", () => {
    const state = frozenPlainTest();
    const on = setTestHighStakes(state, true);
    expect(on.value).not.toBe(state);
    expect(on.value.highStakes).toBe(true);
    expect(state.highStakes).toBe(false);

    const closed = closeTest(state);
    expect(closed.value).not.toBe(state);
    expect(closed.value.closed).toBe(true);
    expect(state.closed).toBe(false);
  });

  it("testResult works from a frozen test", () => {
    const state = frozenPlainTest();
    const result = testResult(state);
    expect(result.value.effects).toEqual([{ id: "e1", size: 6 }]);
    expect(result.value.effects).not.toBe(state.roll.effects);
    expect(result.value.effects[0]).not.toBe(state.roll.effects[0]);
  });

  it("setContestHighStakes works from a frozen contest", () => {
    let state = createContest().value;
    state = addContestRoll(state, {
      side: "initiator", total: 15, effects: [{ id: "e1", size: 10 }], overflows: [], leftovers: [], nextEffectNumber: 2,
      messageRef: null
    }).value;
    state = deepFreeze(addContestRoll(state, {
      side: "opposition", total: 12, effects: [{ id: "e1", size: 6 }], overflows: [], leftovers: [], nextEffectNumber: 2,
      messageRef: null
    }).value);

    const on = setContestHighStakes(state, true);
    expect(on.value).not.toBe(state);
    expect(on.value.highStakes).toBe(true);
    expect(state.highStakes).toBe(false);
  });

  it("contestRollFromTotal works from a frozen list of typed effect dice", () => {
    const sizes = deepFreeze([10, 6]);
    const roll = contestRollFromTotal("initiator", 12, sizes);
    expect(roll.value.effects).toEqual([{ id: "e1", size: 10 }, { id: "e2", size: 6 }]);
    expect(sizes).toEqual([10, 6]);
  });

  it("autoApplyContestHeroicSteps works from a frozen contest", () => {
    let state = createContest().value;
    state = addContestRoll(state, {
      side: "initiator", total: 17, effects: [{ id: "e1", size: 8 }], overflows: [], leftovers: [], nextEffectNumber: 2,
      messageRef: null
    }).value;
    state = deepFreeze(addContestRoll(state, {
      side: "opposition", total: 12, effects: [{ id: "e1", size: 8 }], overflows: [], leftovers: [], nextEffectNumber: 2,
      messageRef: null
    }).value);

    const stepped = autoApplyContestHeroicSteps(state);
    expect(stepped.value).not.toBe(state);
    expect(stepped.value.rolls[0].effects).toEqual([{ id: "e1", size: 10 }]);
    expect(state.rolls[0].effects[0].size).toBe(8);
    expect(state.heroicAppliedTo).toBeNull();
  });

  it("autoApplyTestHeroicSteps works from a frozen test", () => {
    const started = createTest({ difficulty: 8 }).value;
    const state = deepFreeze(addTestRoll(started, rollerRoll(16, [{ id: "e1", size: 6 }])).value);

    const stepped = autoApplyTestHeroicSteps(state);
    expect(stepped.value).not.toBe(state);
    expect(stepped.value.roll.effects).toEqual([{ id: "e1", size: 8 }]);
    expect(state.roll.effects[0].size).toBe(6);
    expect(state.heroicAppliedTo).toBeNull();
  });

  it("difficultyLevelOfPool works from a frozen pool", () => {
    const pool = deepFreeze(buildPool(difficultyEntry("hard", { kind: DIFFICULTY_SOURCE_KIND, label: "Hard" }).value));
    expect(difficultyLevelOfPool(pool)).toEqual({ ok: true, value: "hard" });
  });
});
