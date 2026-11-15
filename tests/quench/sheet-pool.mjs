/**
 * Quench batch "cortex-prime.sheet-pool": the character sheet's roll buttons and the pool they
 * fill (Roadmap M2; Character Sheets behaviours 20 to 24, CS-12 to CS-16; Decisions ADR-016,
 * ADR-048 and ADR-049). Traits go from a sheet into the current user's pool, the builder shows
 * what they cost and warn of, the roll stores the warnings, and a challenged statement is
 * stepped down on its own actor once rolled. Every actor and scene the batch creates carries a test
 * flag and is deleted after each test, with its sheets, the builder and the test's roll messages;
 * leftovers of an interrupted run are deleted before the batch. The user's own pool and the
 * world's game configuration are put back afterwards.
 * @module tests/quench/sheet-pool
 */

import { addTraitToPool, openPoolBuilder } from "../../module/apps/pool-builder.mjs";
import { GAME_CONFIG_SETTING, getGameConfig } from "../../module/config/settings.mjs";
import GameConfigData from "../../module/data/settings/game-config.mjs";
import { preparePoolRollCardContext } from "../../module/dice/pool-roll-card.mjs";
import { defaultGameConfig, poolDieGroupKey, traitSetById } from "../../module/rules/index.mjs";

// Ids from the ADR-036 defaults, which the batch stores as the world's configuration while it runs.
const PC_KIND = "cpKindPlayerChar";
const LOCATION_KIND = "cpKindLocation00";
const DISTINCTIONS = "cpSetDistinction";
const ATTRIBUTES = "cpSetAttributes0";
const SKILLS = "cpSetSkills00000";
const SCENE = "cpSetSceneDistin";
const PHYSICAL = "cpAttrPhysical00";
const MENTAL = "cpAttrMental0000";
const SOCIAL = "cpAttrSocial0000";
const FIGHT = "cpSkillFight0000";
const SHOOT = "cpSkillShoot0000";

const SYSTEM_ID = "cortex-prime";
const TEST_FLAG = "quenchSheetPool";
const POOL_FLAG = "pool";
const BUILDER_ID = "cortex-prime-pool-builder";

/** How long a test waits for a render it caused. */
const WAIT_MS = 5000;

/** @returns {string} a new id in Foundry's 16-character format */
function newId() {
  return foundry.utils.randomID();
}

/** @returns {object[]} a copy of the current user's pool */
function userPool() {
  return foundry.utils.deepClone(game.user.getFlag(SYSTEM_ID, POOL_FLAG) ?? []);
}

/** @returns {object} a roll message's system data as stored: a JSON round trip drops unset fields */
function storedRoll(message) {
  return JSON.parse(JSON.stringify(message.system.toObject()));
}

/** @returns {Application|null} the pool builder the sheet opens, if it is open */
function builderApp() {
  return foundry.applications.instances.get(BUILDER_ID) ?? null;
}

/** @returns {Promise<void>} stores a game configuration as the world's */
function storeConfig(config) {
  return game.settings.set(SYSTEM_ID, GAME_CONFIG_SETTING, config);
}

/** @returns {object} the defaults with the statements feature on the given sets */
function configWithStatements(...setIds) {
  const config = defaultGameConfig();
  for ( const setId of setIds ) traitSetById(config, setId).features.statements = true;
  return config;
}

/**
 * Closes the builder and this batch's sheets, and deletes its scenes and actors. The batch closes
 * windows without their closing animation: a page in the background never finishes one, so each
 * close would wait a full second and a test or hook could pass Mocha's two-second limit.
 */
async function cleanUp() {
  await builderApp()?.close({ animate: false });
  for ( const actor of game.actors.filter(a => a.getFlag(SYSTEM_ID, TEST_FLAG)) ) {
    for ( const app of Object.values(actor.apps) ) await app.close({ animate: false });
  }
  const sceneIds = game.scenes.filter(s => s.getFlag(SYSTEM_ID, TEST_FLAG)).map(s => s.id);
  if ( sceneIds.length ) await getDocumentClass("Scene").deleteDocuments(sceneIds);
  const actorIds = game.actors.filter(a => a.getFlag(SYSTEM_ID, TEST_FLAG)).map(a => a.id);
  if ( actorIds.length ) await Actor.implementation.deleteDocuments(actorIds);
}

/**
 * A player character: the distinctions Retired Smuggler d8 and Hopeless Optimist d4, Physical d8,
 * Social d8 with a statement, and Fight d8. Mental and the other skills have no entry.
 * @returns {{system: object, smuggler: string, optimist: string}}
 */
function pcSystem() {
  const smuggler = newId();
  const optimist = newId();
  const system = {
    kindId: PC_KIND,
    traits: {
      [DISTINCTIONS]: { entries: [
        { id: smuggler, defId: null, name: "Retired Smuggler", dice: [8], sfx: [] },
        { id: optimist, defId: null, name: "Hopeless Optimist", dice: [4], sfx: [] }
      ] },
      [ATTRIBUTES]: { entries: [
        { id: newId(), defId: PHYSICAL, name: "Physical", dice: [8], sfx: [] },
        { id: newId(), defId: SOCIAL, name: "Social", dice: [8], statement: "I trust no one", sfx: [] }
      ] },
      [SKILLS]: { entries: [{ id: newId(), defId: FIGHT, name: "Fight", dice: [8], sfx: [] }] }
    }
  };
  return { system, smuggler, optimist };
}

/**
 * Creates a flagged test character.
 * @param {object} system
 * @param {string} name
 * @param {object} [data] - further actor data, such as a prototype token
 * @returns {Promise<Actor>}
 */
function createCharacter(system, name, data = {}) {
  return Actor.implementation.create({
    name: `[Quench] ${name}`, type: "character", system, flags: { [SYSTEM_ID]: { [TEST_FLAG]: true } }, ...data
  });
}

/** @returns {Promise<Actor>} a location with the scene distinction Panicked Crowd at the given rating */
function createLocation(crowdId, dice = [8], fields = {}) {
  return createCharacter({ kindId: LOCATION_KIND, traits: { [SCENE]: { entries: [
    { id: crowdId, defId: null, name: "Panicked Crowd", dice, sfx: [], ...fields }
  ] } } }, "location");
}

/** @returns {object|undefined} the stored entry of a set that a pool trait id names */
function storedEntry(actor, setId, traitId) {
  const entries = actor.system.toObject().traits[setId]?.entries ?? [];
  return entries.find(e => e.defId === traitId) ?? entries.find(e => e.id === traitId);
}

/** @returns {Promise<foundry.applications.sheets.ActorSheetV2>} the actor's sheet, rendered */
async function openSheet(actor) {
  const sheet = actor.sheet;
  await sheet.render({ force: true });
  return sheet;
}

/** @returns {string[]} the pool buttons of one trait row: "add", "hinder", "challenge" */
function poolButtons(sheet, setId, poolTraitId) {
  const row = sheet.element.querySelector(`fieldset[data-set-id="${setId}"] [data-pool-trait-id="${poolTraitId}"]`);
  return [...(row?.querySelectorAll('button[data-action="addToPool"]') ?? [])].map(b => b.dataset.option ?? "add");
}

/**
 * Waits for the next render of the pool builder after this call.
 * @returns {Promise<void>} rejects after WAIT_MS
 */
function nextBuilderRender() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      Hooks.off("renderPoolBuilder", id);
      reject(new Error("the pool builder didn't render"));
    }, WAIT_MS);
    const id = Hooks.on("renderPoolBuilder", () => {
      clearTimeout(timer);
      Hooks.off("renderPoolBuilder", id);
      resolve();
    });
  });
}

/**
 * Runs something and collects the notifications of one kind it shows instead of showing them.
 * @param {"warn"|"info"} kind
 * @param {() => Promise<unknown>} run
 * @returns {Promise<string[]>}
 */
async function notificationsShownBy(kind, run) {
  const shown = [];
  const show = ui.notifications[kind];
  ui.notifications[kind] = message => shown.push(String(message));
  try {
    await run();
  }
  finally {
    ui.notifications[kind] = show;
  }
  return shown;
}

/**
 * Register the batch with Quench.
 * @param {object} quench
 */
export function registerSheetPoolBatch(quench) {
  quench.registerBatch(
    "cortex-prime.sheet-pool",
    ({ describe, it, assert, before, after, afterEach }) => {
      let storedConfig;
      let storedPool;
      /** @type {ChatMessage[]} */
      let messages = [];

      /** Rolls the user's pool with fixed results through the builder and keeps the message for cleanup. */
      async function roll(results) {
        const builder = await openPoolBuilder();
        const message = await builder.rollPool(results);
        messages.push(message);
        return message;
      }

      before(async () => {
        storedConfig = getGameConfig();
        storedPool = game.user.getFlag(SYSTEM_ID, POOL_FLAG);
        await cleanUp();
        await game.user.unsetFlag(SYSTEM_ID, POOL_FLAG);
        await storeConfig(defaultGameConfig());
      });
      after(async () => {
        if ( storedConfig ) await storeConfig(storedConfig);
        if ( storedPool ) await game.user.setFlag(SYSTEM_ID, POOL_FLAG, storedPool);
      });
      afterEach(async () => {
        await cleanUp();
        for ( const message of messages ) await message?.delete();
        messages = [];
        await game.user.unsetFlag(SYSTEM_ID, POOL_FLAG);
        await storeConfig(defaultGameConfig());
      });

      describe("the sheet's pool buttons", () => {
        it("offer add on every trait with a die, Hinder on distinctions, and a challenge only on a statement", async () => {
          await storeConfig(configWithStatements(ATTRIBUTES));
          const { system, smuggler } = pcSystem();
          const bare = newId();
          system.traits[DISTINCTIONS].entries.push({ id: bare, defId: null, name: "Bare", dice: [], sfx: [] });
          const sheet = await openSheet(await createCharacter(system, "buttons"));

          assert.deepEqual(poolButtons(sheet, DISTINCTIONS, smuggler), ["add", "hinder"]);
          assert.deepEqual(poolButtons(sheet, ATTRIBUTES, PHYSICAL), ["add"]);
          assert.deepEqual(poolButtons(sheet, ATTRIBUTES, SOCIAL), ["add", "challenge"]);
          assert.deepEqual(poolButtons(sheet, ATTRIBUTES, MENTAL), ["add"], "a fallback die can be added (TS-03)");
          assert.deepEqual(poolButtons(sheet, DISTINCTIONS, bare), [], "a trait without a die has no button (TS-04)");
        });

        it("stay usable on a sheet the user can't edit, whose rating inputs stay read-only (ADR-049)", async () => {
          // A location the user may only observe; its scene distinction is anyone's to use (rule 12).
          const crowd = newId();
          const location = await createLocation(crowd);
          const sheet = new location.sheet.constructor({ document: location });
          Object.defineProperty(sheet, "isEditable", { get: () => false });
          try {
            await sheet.render({ force: true });
            const button = sheet.element.querySelector(`[data-pool-trait-id="${crowd}"] button[data-action="addToPool"]`);
            assert.isFalse(button.matches(":disabled"), "the add button can be used");
            assert.isTrue(sheet.element.querySelector("select.cp-die").matches(":disabled"), "the rating stays read-only");

            const rendered = nextBuilderRender();
            button.click();
            await rendered;
            assert.deepEqual(userPool().map(d => d.source.traitId), [crowd]);
          }
          finally {
            await sheet.close({ animate: false });
          }
        });

        it("CS-12 a click puts the trait's die into the user's pool and opens the builder, which shows its cost", async () => {
          const actor = await createCharacter(pcSystem().system, "click");
          const sheet = await openSheet(actor);
          const rendered = nextBuilderRender();
          sheet.element.querySelector(`[data-pool-trait-id="${PHYSICAL}"] button[data-action="addToPool"]`).click();
          await rendered;

          const pool = userPool();
          assert.lengthOf(pool, 1);
          assert.equal(pool[0].size, 8);
          assert.deepEqual(pool[0].source, {
            kind: "trait", actorId: actor.id, traitId: PHYSICAL, label: "Physical", setId: ATTRIBUTES, actorRef: actor.uuid
          });
          const text = builderApp().element.textContent;
          assert.include(text, game.i18n.format("CORTEX.Builder.Cost", { cost: 0 }));
          assert.notInclude(text, actor.name, "a pool of one actor's traits doesn't repeat its name");
        });
      });

      describe("free traits (TS-22)", () => {
        it("a free trait's add button puts its die into the pool, in no set and at no cost", async () => {
          const deputy = newId();
          const actor = await createCharacter({
            kindId: "cpKindMinorGmc00", freeTraits: [{ id: deputy, name: "Crooked Deputy", dice: [8] }]
          }, "free trait");
          const sheet = await openSheet(actor);
          const buttons = sheet.element.querySelectorAll(`fieldset[data-free-traits] [data-pool-trait-id="${deputy}"] button[data-action="addToPool"]`);
          assert.lengthOf(buttons, 1, "a free trait has neither Hinder nor a challenge");
          const rendered = nextBuilderRender();
          buttons[0].click();
          await rendered;

          const pool = userPool();
          assert.lengthOf(pool, 1);
          assert.equal(pool[0].size, 8);
          assert.deepEqual(pool[0].source, {
            kind: "trait", actorId: actor.id, traitId: deputy, label: "Crooked Deputy", actorRef: actor.uuid
          });
          assert.include(builderApp().element.textContent, game.i18n.format("CORTEX.Builder.Cost", { cost: 0 }));
          assert.isFalse(await addTraitToPool(actor, null, deputy, "hinder"), "Hinder is a set's feature");
        });
      });

      describe("adding traits to the pool", () => {
        it("CS-13 Hinder adds one d4, and the builder shows the plot point it gains, unpaid", async () => {
          const { system, smuggler, optimist } = pcSystem();
          const actor = await createCharacter(system, "hinder");
          assert.isTrue(await addTraitToPool(actor, DISTINCTIONS, smuggler, "hinder"));
          const pool = userPool();
          assert.deepEqual(pool.map(d => [d.size, d.source.option, d.source.ppGained]), [[4, "hinder", 1]]);
          assert.include(builderApp().element.textContent, game.i18n.format("CORTEX.Builder.HinderGain", { pp: 1 }));
          assert.deepEqual(storedEntry(actor, DISTINCTIONS, smuggler).dice, [8], "Hinder never changes the stored rating");

          await builderApp().clearGroup(poolDieGroupKey(pool[0]));
          assert.isTrue(await addTraitToPool(actor, DISTINCTIONS, optimist, "hinder"));
          const text = builderApp().element.textContent;
          assert.include(text, game.i18n.localize("CORTEX.Builder.Hints.HINDER_ALREADY_D4"));
          assert.notInclude(text, game.i18n.format("CORTEX.Builder.HinderGain", { pp: 0 }));
        });

        it("CS-16 a trait is never in the pool twice: the same choice changes nothing, another replaces its dice", async () => {
          const { system, smuggler } = pcSystem();
          const actor = await createCharacter(system, "twice");
          await addTraitToPool(actor, ATTRIBUTES, PHYSICAL);
          await builderApp().stepDie(userPool()[0].id, 1);
          await addTraitToPool(actor, ATTRIBUTES, PHYSICAL);
          assert.deepEqual(userPool().map(d => [d.size, d.source.traitId]), [[10, PHYSICAL]], "the builder's step stays");

          await addTraitToPool(actor, DISTINCTIONS, smuggler);
          await addTraitToPool(actor, DISTINCTIONS, smuggler, "hinder");
          assert.deepEqual(userPool().map(d => [d.size, d.source.traitId, d.source.option ?? null]),
            [[10, PHYSICAL, null], [4, smuggler, "hinder"]]);
        });

        it("keeps two actors' traits of one name apart, and clears one without the other (RQ-031)", async () => {
          const first = await createCharacter(pcSystem().system, "first");
          const second = await createCharacter(pcSystem().system, "second");
          await addTraitToPool(first, ATTRIBUTES, PHYSICAL);
          await addTraitToPool(second, ATTRIBUTES, PHYSICAL);
          const pool = userPool();
          assert.lengthOf(pool, 2);
          assert.lengthOf(builderApp().element.querySelectorAll("fieldset.cp-source"), 2);
          assert.deepEqual([...builderApp().element.querySelectorAll(".cp-source-actor")].map(el => el.textContent.trim()),
            [first.name, second.name], "a pool of several actors' traits names each trait's actor");

          await builderApp().clearGroup(poolDieGroupKey(pool[0]));
          assert.deepEqual(userPool().map(d => d.source.actorId), [second.id]);
        });

        it("refuses a challenge on a rating of several dice (RQ-033) and adds nothing", async () => {
          await storeConfig(configWithStatements(SCENE));
          const crowd = newId();
          const location = await createLocation(crowd, [6, 6], { statement: "Everyone runs" });
          let added;
          const shown = await notificationsShownBy("warn", async () => {
            added = await addTraitToPool(location, SCENE, crowd, "challenge");
          });
          assert.isFalse(added);
          assert.deepEqual(shown, [game.i18n.localize("CORTEX.Builder.Errors.STATEMENT_RATING_NOT_ONE_DIE")]);
          assert.deepEqual(userPool(), []);
        });
      });

      describe("Hinder with a challenge, and challenges of several dice (RQ-032, RQ-033, ADR-053)", () => {
        it("offers a fourth button where a trait has Hinder and a statement, and rolls three d4s, then steps d8 down to d6", async () => {
          await storeConfig(configWithStatements(DISTINCTIONS));
          const { system, smuggler, optimist } = pcSystem();
          system.traits[DISTINCTIONS].entries[0].statement = "I owe nobody";
          const actor = await createCharacter(system, "hinder and challenge");
          const sheet = await openSheet(actor);
          assert.deepEqual(poolButtons(sheet, DISTINCTIONS, smuggler), ["add", "hinder", "challenge", "hinderChallenge"]);
          assert.deepEqual(poolButtons(sheet, DISTINCTIONS, optimist), ["add", "hinder"], "no statement, no challenge");

          const rendered = nextBuilderRender();
          sheet.element.querySelector(`[data-pool-trait-id="${smuggler}"] button[data-option="hinderChallenge"]`).click();
          await rendered;
          assert.deepEqual(userPool().map(d => [d.size, d.source.option]),
            [[4, "hinderChallenge"], [4, "hinderChallenge"], [4, "hinderChallenge"]]);
          assert.include(builderApp().element.textContent, game.i18n.format("CORTEX.Builder.HinderGain", { pp: 1 }));

          const message = await roll([2, 3, 4]);
          assert.deepEqual(message.system.pool.map(d => d.size), [4, 4, 4]);
          assert.deepInclude(storedEntry(actor, DISTINCTIONS, smuggler), { dice: [6], challenged: true, preChallengeDice: [8] });
          assert.deepEqual(userPool(), [], "the challenged dice leave the kept pool");
        });

        it("TS-23 with the set's option on, 2d8 rolls six d8 and steps down to 2d6; rolled again, 2d4", async () => {
          const config = configWithStatements(SCENE);
          traitSetById(config, SCENE).features.multiDiceChallenges = true;
          await storeConfig(config);
          const crowd = newId();
          const location = await createLocation(crowd, [8, 8], { statement: "Everyone runs" });

          assert.isTrue(await addTraitToPool(location, SCENE, crowd, "challenge"));
          assert.deepEqual(userPool().map(d => d.size), [8, 8, 8, 8, 8, 8]);
          await roll([5, 5, 5, 5, 5, 5]);
          assert.deepInclude(storedEntry(location, SCENE, crowd), { dice: [6, 6], challenged: true, preChallengeDice: [8, 8] });

          assert.isTrue(await addTraitToPool(location, SCENE, crowd, "challenge"));
          await roll([5, 5, 5, 5, 5, 5]);
          assert.deepInclude(storedEntry(location, SCENE, crowd), { dice: [4, 4], preChallengeDice: [8, 8] });
        });

        it("TS-24 with the set's option on, 2d4 with Hinder and a challenge: three d4s, then 2d4 kept and shut down", async () => {
          const config = configWithStatements(SCENE);
          traitSetById(config, SCENE).features.multiDiceChallenges = true;
          await storeConfig(config);
          const crowd = newId();
          const location = await createLocation(crowd, [4, 4], { statement: "Everyone runs" });
          assert.isTrue(await addTraitToPool(location, SCENE, crowd, "hinderChallenge"));
          assert.deepEqual(userPool().map(d => [d.size, d.source.ppGained ?? null]), [[4, 1], [4, null], [4, null]]);
          await roll([2, 3, 4]);
          assert.deepInclude(storedEntry(location, SCENE, crowd),
            { dice: [4, 4], challenged: true, shutDown: { reason: "statementChallenged" } });
        });

        it("TS-26 refuses a challenge of mixed sizes even with the option on, and adds nothing", async () => {
          const config = configWithStatements(SCENE);
          traitSetById(config, SCENE).features.multiDiceChallenges = true;
          await storeConfig(config);
          const crowd = newId();
          const location = await createLocation(crowd, [8, 4], { statement: "Everyone runs" });
          let added;
          const shown = await notificationsShownBy("warn", async () => {
            added = await addTraitToPool(location, SCENE, crowd, "challenge");
          });
          assert.isFalse(added);
          assert.deepEqual(shown, [game.i18n.localize("CORTEX.Builder.Errors.STATEMENT_RATING_MIXED_SIZES")]);
          assert.deepEqual(userPool(), []);
        });

        it("loads a configuration stored before the option existed with it off, and valid", () => {
          const old = defaultGameConfig();
          for ( const set of old.traitSets ) delete set.features.multiDiceChallenges;
          const model = GameConfigData.fromSource(old);
          assert.notEqual(model.invalid, true);
          assert.isTrue(model.toObject().traitSets.every(set => set.features.multiDiceChallenges === false));
        });
      });

      describe("rolling the pool", () => {
        it("CS-15 stores the pool's warnings and unpriced traits, and the dice without the pool's marks", async () => {
          const config = defaultGameConfig();
          traitSetById(config, SKILLS).extraTraits = "none";
          await storeConfig(config);
          const { system, smuggler } = pcSystem();
          const actor = await createCharacter(system, "unpriced");
          for ( const [setId, traitId] of [[DISTINCTIONS, smuggler], [ATTRIBUTES, PHYSICAL], [SKILLS, FIGHT], [SKILLS, SHOOT]] ) {
            assert.isTrue(await addTraitToPool(actor, setId, traitId));
          }
          assert.notInclude(builderApp().element.textContent, game.i18n.format("CORTEX.Builder.Cost", { cost: 0 }),
            "no bare 0 PP for a pool whose further trait has no price (RQ-030)");

          const message = await roll([2, 2, 2, 2]);
          assert.deepEqual(storedRoll(message).warnings,
            [{ code: "EXTRA_TRAIT_NOT_ALLOWED", setId: SKILLS, setLabel: "Skills" }]);
          assert.deepEqual(storedRoll(message).unpricedTraits, [{ setId: SKILLS, count: 1 }]);
          for ( const die of storedRoll(message).pool ) {
            assert.sameMembers(Object.keys(die.source), ["kind", "actorId", "traitId", "label"]);
          }
          assert.lengthOf(userPool(), 4, "the pool is kept after the roll");
        });

        it("warns of the character's missing prime sets when a location's scene distinction shares the pool", async () => {
          const { system, smuggler } = pcSystem();
          const actor = await createCharacter(system, "with location");
          const crowd = newId();
          const location = await createLocation(crowd);
          await addTraitToPool(location, SCENE, crowd);
          await addTraitToPool(actor, DISTINCTIONS, smuggler);

          const message = await roll([3, 3]);
          assert.deepEqual(storedRoll(message).warnings.map(w => [w.code, w.setId]),
            [["PRIME_SET_MISSING", ATTRIBUTES], ["PRIME_SET_MISSING", SKILLS]]);
          assert.deepEqual(storedRoll(message).unpricedTraits, []);
        });

        it("TS-13 warns of a trait shut down after it was added, named on the card", async () => {
          const { system, smuggler } = pcSystem();
          const actor = await createCharacter(system, "shut down");
          for ( const [setId, traitId] of [[DISTINCTIONS, smuggler], [ATTRIBUTES, PHYSICAL], [SKILLS, FIGHT]] ) {
            await addTraitToPool(actor, setId, traitId);
          }
          const entries = actor.system.toObject().traits[ATTRIBUTES].entries
            .map(e => (e.defId === PHYSICAL ? { ...e, shutDown: { reason: "manual" } } : e));
          await actor.update({ [`system.traits.${ATTRIBUTES}.entries`]: JSON.parse(JSON.stringify(entries)) });

          const message = await roll([3, 3, 3]);
          assert.deepEqual(storedRoll(message).warnings, [
            { code: "TRAIT_SHUT_DOWN", setId: ATTRIBUTES, setLabel: "Attributes", actorId: actor.id, traitId: PHYSICAL }
          ]);
          const reasons = preparePoolRollCardContext(message).nonstandard.reasons;
          assert.include(reasons[0], "Physical");
        });

        it("CS-14 a challenged statement rolls its die three times, then steps down and leaves the kept pool (ADR-048)", async () => {
          await storeConfig(configWithStatements(ATTRIBUTES));
          const actor = await createCharacter(pcSystem().system, "challenge");
          await addTraitToPool(actor, ATTRIBUTES, SOCIAL, "challenge");
          await addTraitToPool(actor, ATTRIBUTES, PHYSICAL);
          assert.deepEqual(userPool().map(d => [d.size, d.source.traitId]),
            [[8, SOCIAL], [8, SOCIAL], [8, SOCIAL], [8, PHYSICAL]]);

          let message;
          const shown = await notificationsShownBy("info", async () => {
            message = await roll([5, 5, 5, 5]);
          });
          assert.lengthOf(message.system.pool, 4, "the roll had the three challenged dice");
          assert.deepInclude(storedEntry(actor, ATTRIBUTES, SOCIAL), { dice: [6], challenged: true, preChallengeDice: [8] });
          assert.deepEqual(storedEntry(actor, ATTRIBUTES, PHYSICAL).dice, [8]);
          assert.deepEqual(userPool().map(d => d.source.traitId), [PHYSICAL]);
          assert.include(shown, game.i18n.format("CORTEX.Builder.SteppedDown", { trait: "Social" }));
        });

        it("ADR-048 a challenge cleared from the pool before the roll changes nothing", async () => {
          await storeConfig(configWithStatements(ATTRIBUTES));
          const actor = await createCharacter(pcSystem().system, "cleared");
          await addTraitToPool(actor, ATTRIBUTES, SOCIAL, "challenge");
          await addTraitToPool(actor, ATTRIBUTES, PHYSICAL);
          await builderApp().clearGroup(poolDieGroupKey(userPool()[0]));
          await roll([4]);
          assert.deepEqual(storedEntry(actor, ATTRIBUTES, SOCIAL).dice, [8]);
          assert.isUndefined(storedEntry(actor, ATTRIBUTES, SOCIAL).challenged);
        });

        it("steps an unlinked token's challenged trait down on the token's actor, not its base actor", async () => {
          await storeConfig(configWithStatements(ATTRIBUTES));
          const actor = await createCharacter(pcSystem().system, "token base", { prototypeToken: { actorLink: false } });
          const scene = await getDocumentClass("Scene").create({
            name: "[Quench] sheet pool", flags: { [SYSTEM_ID]: { [TEST_FLAG]: true } }
          });
          const tokenData = (await actor.getTokenDocument({ x: 0, y: 0 })).toObject();
          const [token] = await scene.createEmbeddedDocuments("Token", [tokenData]);
          assert.isTrue(token.actor.isToken);

          await addTraitToPool(token.actor, ATTRIBUTES, SOCIAL, "challenge");
          assert.equal(userPool()[0].source.actorRef, token.actor.uuid);
          assert.equal(userPool()[0].source.actorId, actor.id, "a token's actor has its base actor's id");

          await roll([5, 5, 5]);
          assert.deepEqual(storedEntry(token.actor, ATTRIBUTES, SOCIAL).dice, [6]);
          assert.deepEqual(storedEntry(game.actors.get(actor.id), ATTRIBUTES, SOCIAL).dice, [8]);
        });

        it("ADR-054 writes one update per actor when a roll challenges two of its traits", async () => {
          await storeConfig(configWithStatements(ATTRIBUTES, DISTINCTIONS));
          const { system, smuggler } = pcSystem();
          system.traits[DISTINCTIONS].entries[0].statement = "I know every back road";
          const actor = await createCharacter(system, "two challenges");
          await addTraitToPool(actor, ATTRIBUTES, SOCIAL, "challenge");
          await addTraitToPool(actor, DISTINCTIONS, smuggler, "challenge");

          const updates = [];
          const hookId = Hooks.on("preUpdateActor", (doc, changes) => {
            if ( doc.id === actor.id ) updates.push(changes);
          });
          let shown;
          try {
            shown = await notificationsShownBy("info", () => roll([5, 5, 5, 5, 5, 5]));
          }
          finally {
            Hooks.off("preUpdateActor", hookId);
          }

          // Foundry 14.369 keeps only the last update of an unlinked token whose delta has no name,
          // so one roll writes one update per actor.
          assert.lengthOf(updates, 1, "both step-downs went into one update");
          assert.sameMembers(Object.keys(updates[0].system.traits), [ATTRIBUTES, DISTINCTIONS]);
          assert.deepInclude(storedEntry(actor, ATTRIBUTES, SOCIAL), { dice: [6], challenged: true, preChallengeDice: [8] });
          assert.deepInclude(storedEntry(actor, DISTINCTIONS, smuggler), { dice: [6], challenged: true, preChallengeDice: [8] });
          for ( const trait of ["Social", "Retired Smuggler"] ) {
            assert.include(shown, game.i18n.format("CORTEX.Builder.SteppedDown", { trait }));
          }
          assert.lengthOf(userPool(), 0, "the challenged dice left the kept pool");
        });
      });
    },
    { displayName: "Cortex Prime: sheet and pool" }
  );
}
