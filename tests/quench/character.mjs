/**
 * Quench batch "cortex-prime.character": the "character" Actor type and its schema (Decisions
 * ADR-031 to ADR-035, ADR-037; the Traits & Trait Sets spec's data shapes). Every actor it creates
 * carries a test flag and is deleted after each test; actors left behind by an interrupted run are
 * deleted before the batch. The batch stores the ADR-036 defaults as the world's game
 * configuration while it runs and puts the stored one back afterwards. The sample data's kind,
 * set and definition ids match nothing in it; the "edit-time checks" tests use the defaults' ids
 * (ADR-037 backstop).
 * @module tests/quench/character
 */

import CharacterData, { CHARACTER_SCHEMA_VERSION } from "../../module/data/actor/character.mjs";
import { GAME_CONFIG_SETTING, getGameConfig } from "../../module/config/settings.mjs";
import {
  challengeStatement, defaultGameConfig, editStatement, resolveChallengedStatement
} from "../../module/rules/index.mjs";

// Ids from the ADR-036 defaults, which the batch stores as the world's configuration while it runs.
const PC_KIND = "cpKindPlayerChar";
const DISTINCTIONS = "cpSetDistinction";
const SCENE_DISTINCTIONS = "cpSetSceneDistin";
const ATTRIBUTES = "cpSetAttributes0";
const SOCIAL = "cpAttrSocial0000";
const SKILLS = "cpSetSkills00000";
const FIGHT = "cpSkillFight0000";
const SHOOT = "cpSkillShoot0000";

const FLAG_SCOPE = "cortex-prime";
const FLAG_KEY = "quenchCharacter";

/** @returns {string} a new id in Foundry's 16-character format */
function newId() {
  return foundry.utils.randomID();
}

/** Deletes every actor this batch created, including ones left by an interrupted run. */
async function deleteTestActors() {
  const ids = game.actors.filter(a => a.getFlag(FLAG_SCOPE, FLAG_KEY)).map(a => a.id);
  if ( ids.length ) await Actor.implementation.deleteDocuments(ids);
}

/**
 * Creates a flagged test character.
 * @param {object} [system]
 * @param {string} [name]
 * @returns {Promise<Actor|undefined>} undefined if Foundry refused the data
 */
function createCharacter(system = {}, name = "character") {
  return Actor.implementation.create({
    name: `[Quench] ${name}`, type: "character", system, flags: { [FLAG_SCOPE]: { [FLAG_KEY]: true } }
  });
}

/**
 * Builds a character the way world loading does (strict), without saving anything.
 * @param {object} system
 * @returns {Actor}
 */
function loadCharacter(system) {
  return Actor.implementation.fromSource(
    { _id: newId(), name: "[Quench] loaded", type: "character", system }, { strict: true }
  );
}

/**
 * Data as it is stored: a JSON round trip. The model's toObject() keeps a key for every optional
 * field it leaves unset, with the value undefined; the database never stores those keys.
 * @param {object} data
 * @returns {object}
 */
function plain(data) {
  return JSON.parse(JSON.stringify(data));
}

/**
 * Runs an update and collects the error notifications it shows instead of showing them.
 * @param {() => Promise<unknown>} run
 * @returns {Promise<string[]>} the messages, in order
 */
async function errorsShownBy(run) {
  const shown = [];
  const showError = ui.notifications.error;
  ui.notifications.error = message => shown.push(message);
  try {
    await run();
  }
  finally {
    ui.notifications.error = showError;
  }
  return shown;
}

/** @returns {string} the notification a refusal with this code shows */
function refusalText(code) {
  return game.i18n.localize(`CORTEX.Character.Errors.${code}`);
}

/** @returns {object} the stored system data of a character, read back from the world collection */
function storedSystem(actor) {
  return plain(game.actors.get(actor.id).system.toObject());
}

/**
 * A character's system data with two trait sets (one entry list as a fixed set would have it,
 * with defIds, one as an open set would, without) and free traits. Sets and entries carry the
 * defaults the schema fills in (a set's shutDown false, a set's and an entry's sfx empty), so the data reads
 * back as it went in.
 * @returns {{system: object, setA: string, setB: string}}
 */
function sampleSystem() {
  const setA = newId();
  const setB = newId();
  const system = {
    schemaVersion: CHARACTER_SCHEMA_VERSION,
    kindId: newId(),
    traits: {
      [setA]: { shutDown: false, sfx: [], entries: [
        { id: newId(), defId: newId(), name: "Fight", dice: [8], sfx: [] },
        { id: newId(), defId: newId(), name: "Sneak", dice: [6], sfx: [] }
      ] },
      [setB]: { shutDown: false, sfx: [], entries: [
        { id: newId(), defId: null, name: "Cult Survivor", dice: [8], sfx: [] }
      ] }
    },
    freeTraits: [
      { id: newId(), name: "Big Shotgun", dice: [8] },
      { id: newId(), name: "Out of Shape", dice: [4] }
    ]
  };
  return { system, setA, setB };
}

/**
 * Register the batch with Quench.
 * @param {object} quench
 */
export function registerCharacterBatch(quench) {
  quench.registerBatch(
    "cortex-prime.character",
    ({ describe, it, assert, before, after, afterEach }) => {
      let storedConfig;
      before(async () => {
        storedConfig = getGameConfig();
        await deleteTestActors();
        await game.settings.set("cortex-prime", GAME_CONFIG_SETTING, defaultGameConfig());
      });
      after(async () => {
        if ( storedConfig ) await game.settings.set("cortex-prime", GAME_CONFIG_SETTING, storedConfig);
      });
      afterEach(deleteTestActors);

      describe("character actor type", () => {
        it("is registered and uses CharacterData", async () => {
          assert.include(Actor.TYPES, "character");
          assert.include(game.documentTypes.Actor, "character");
          assert.strictEqual(CONFIG.Actor.dataModels.character, CharacterData);

          const actor = await createCharacter();
          assert.instanceOf(actor.system, CharacterData);
        });

        it("creates a minimal character, reads it back and deletes it", async () => {
          const actor = await createCharacter();
          assert.deepEqual(storedSystem(actor), {
            schemaVersion: CHARACTER_SCHEMA_VERSION, kindId: null, traits: {}, freeTraits: []
          });

          await actor.delete();
          assert.isUndefined(game.actors.get(actor.id));
        });

        it("stores schemaVersion 1 by default; Foundry's cleaning turns null and 0 into 1 instead of refusing them", async () => {
          // Recorded behaviour, not approved input: the same cleaning lets an update with null or 0
          // reset a higher stored version to 1.
          assert.equal(loadCharacter({}).system.schemaVersion, CHARACTER_SCHEMA_VERSION);
          assert.equal(loadCharacter({ schemaVersion: null }).system.schemaVersion, CHARACTER_SCHEMA_VERSION);
          assert.equal(loadCharacter({ schemaVersion: 0 }).system.schemaVersion, CHARACTER_SCHEMA_VERSION);

          const fromNull = await createCharacter({ schemaVersion: null }, "version null");
          assert.equal(storedSystem(fromNull).schemaVersion, CHARACTER_SCHEMA_VERSION);
          const fromZero = await createCharacter({ schemaVersion: 0 }, "version 0");
          assert.equal(storedSystem(fromZero).schemaVersion, CHARACTER_SCHEMA_VERSION);

          const later = await createCharacter({ schemaVersion: 2 }, "version 2");
          assert.equal(storedSystem(later).schemaVersion, 2);
          await later.update({ "system.schemaVersion": null });
          assert.equal(storedSystem(later).schemaVersion, CHARACTER_SCHEMA_VERSION);
        });

        it("stores an unassigned kind as null; Foundry's cleaning turns a blank kind into null too", async () => {
          assert.isNull(loadCharacter({ kindId: null }).system.kindId);
          const actor = await createCharacter({ kindId: "" });
          assert.isNull(storedSystem(actor).kindId);
        });
      });

      describe("persistence", () => {
        it("keeps two trait sets, several entries and free traits through a save", async () => {
          const { system } = sampleSystem();
          const actor = await createCharacter(foundry.utils.deepClone(system));
          assert.deepEqual(storedSystem(actor), system);
        });

        it("keeps kind, set and definition ids that match nothing, on load and through a save", async () => {
          const { system } = sampleSystem();
          assert.deepEqual(plain(loadCharacter(foundry.utils.deepClone(system)).system.toObject()), system);

          const actor = await createCharacter(foundry.utils.deepClone(system));
          assert.deepEqual(storedSystem(actor), system);
        });

        it("keeps valid ratings through a save, including [] and [6, 6, 6, 6]", async () => {
          const setId = newId();
          const ratings = [[], [4], [8], [12], [6, 6, 6, 6], [6, 8]];
          const entries = ratings.map(dice => ({ id: newId(), defId: null, name: `d${dice.join("+")}`, dice }));
          const freeTraits = [{ id: newId(), name: "No die", dice: [] }];
          const actor = await createCharacter({ traits: { [setId]: { entries: foundry.utils.deepClone(entries) } }, freeTraits });
          // [6, 8] is kept because same-size dice (TS-E02) are checked on edit, not by the schema.
          assert.deepEqual(storedSystem(actor).traits[setId].entries.map(e => e.dice), ratings);
          assert.deepEqual(storedSystem(actor).freeTraits[0].dice, []);
        });

        it("keeps entry ids and defIds when a fixed entry's name snapshot is rewritten", async () => {
          // This proves only that rewriting the name snapshot an entry keeps leaves its ids and rating
          // alone. An actual definition rename in the game configuration (TS-E04) is not tested yet,
          // because this test uses ids the configuration doesn't have.
          const { system, setA } = sampleSystem();
          const actor = await createCharacter(foundry.utils.deepClone(system));
          const renamed = system.traits[setA].entries.map(e => ({ ...e, name: `${e.name} (renamed)` }));
          await actor.update({ [`system.traits.${setA}.entries`]: renamed });

          const stored = storedSystem(actor).traits[setA].entries;
          assert.deepEqual(stored.map(e => [e.id, e.defId, e.dice]), system.traits[setA].entries.map(e => [e.id, e.defId, e.dice]));
          assert.deepEqual(stored.map(e => e.name), ["Fight (renamed)", "Sneak (renamed)"]);
        });

        it("replacing one set's entries keeps the other sets, the kind and the free traits", async () => {
          const { system, setA } = sampleSystem();
          // A set the configuration has, so the new entry passes the edit check (ADR-037 point 2).
          const setB = SCENE_DISTINCTIONS;
          system.traits[setB] = { shutDown: false, sfx: [], entries: [{ id: newId(), defId: null, name: "Cult Survivor", dice: [8], sfx: [] }] };
          const actor = await createCharacter(foundry.utils.deepClone(system));
          const replacement = [{ id: newId(), defId: null, name: "Panicked Crowd", dice: [6, 6], sfx: [] }];
          await actor.update({ [`system.traits.${setB}.entries`]: replacement });

          const stored = storedSystem(actor);
          assert.deepEqual(stored.traits[setB].entries, replacement);
          assert.deepEqual(stored.traits[setA], system.traits[setA]);
          assert.equal(stored.kindId, system.kindId);
          assert.deepEqual(stored.freeTraits, system.freeTraits);
        });

        it("duplicating a character keeps its entry ids and ratings", async () => {
          const { system } = sampleSystem();
          const actor = await createCharacter(foundry.utils.deepClone(system));
          const copy = await actor.clone({ name: "[Quench] character copy" }, { save: true });

          assert.notEqual(copy.id, actor.id);
          assert.deepEqual(storedSystem(copy), system);
        });
      });

      describe("invalid data", () => {
        it("refuses [7] in a nested rating when built strictly, and Actor.create stores nothing", async () => {
          const { system, setA } = sampleSystem();
          system.traits[setA].entries[0].dice = [7];
          assert.throws(() => loadCharacter(foundry.utils.deepClone(system)));

          const free = sampleSystem().system;
          free.freeTraits[0].dice = [7];
          assert.throws(() => loadCharacter(free));

          const before = game.actors.size;
          assert.isUndefined(await createCharacter(foundry.utils.deepClone(system), "refused"));
          assert.equal(game.actors.size, before);
        });

        it("refuses an update with [7] visibly, and cancels the update as a whole (ADR-037 point 3)", async () => {
          const { system, setA } = sampleSystem();
          const actor = await createCharacter(foundry.utils.deepClone(system));
          const bad = system.traits[setA].entries.map((e, i) => (i === 0 ? { ...e, dice: [7] } : e));

          assert.isUndefined(await actor.update({ [`system.traits.${setA}.entries`]: bad }));
          assert.deepEqual(storedSystem(actor).traits[setA], system.traits[setA]);

          // Together with a valid change: the backstop's refusal cancels both (ADR-037 consequences).
          await actor.update({ name: "[Quench] character renamed", [`system.traits.${setA}.entries`]: bad });
          assert.equal(game.actors.get(actor.id).name, "[Quench] character");
          assert.deepEqual(storedSystem(actor).traits[setA], system.traits[setA]);
        });

        it("drops fields the schema doesn't define and set keys that aren't 16-character ids, and keeps the spec's fields", async () => {
          const setId = newId();
          const entry = { id: newId(), defId: null, name: "Social", dice: [6], sfx: [] };
          const actor = await createCharacter({
            traits: {
              [setId]: { shutDown: true, notInSchema: 1, entries: [{ ...entry, preChallengeDice: [8], challenged: true, notInSchema: 2 }] },
              attributes: { entries: [{ id: newId(), defId: null, name: "Physical", dice: [8] }] }
            },
            notInSchema: true
          });

          const stored = storedSystem(actor);
          assert.deepEqual(Object.keys(stored.traits), [setId]);
          assert.deepEqual(stored.traits[setId], { shutDown: true, sfx: [], entries: [{ ...entry, preChallengeDice: [8], challenged: true }] });
          assert.notProperty(stored, "notInSchema");
        });
      });

      describe("edit-time checks (ADR-037)", () => {
        /** A PC of the default configuration with one distinction and Fight d6. */
        const pcSystem = () => ({
          kindId: PC_KIND,
          traits: {
            [DISTINCTIONS]: { shutDown: false, sfx: [], entries: [{ id: newId(), defId: null, name: "Seasoned Smuggler", dice: [8], sfx: [] }] },
            [SKILLS]: { shutDown: false, sfx: [], entries: [{ id: newId(), defId: FIGHT, name: "Fight", dice: [6], sfx: [] }] }
          },
          freeTraits: []
        });

        it("accepts an edit that fits the configuration", async () => {
          const system = pcSystem();
          const actor = await createCharacter(foundry.utils.deepClone(system));
          const entries = [{ ...system.traits[SKILLS].entries[0], dice: [8] }];
          await actor.update({ [`system.traits.${SKILLS}.entries`]: entries });
          assert.deepEqual(storedSystem(actor).traits[SKILLS].entries[0].dice, [8]);
        });

        it("refuses a second die in a one-die set, an unknown kind and an unknown definition", async () => {
          const system = pcSystem();
          const actor = await createCharacter(foundry.utils.deepClone(system));
          const twoDice = [{ ...system.traits[DISTINCTIONS].entries[0], dice: [6, 6] }];
          assert.isUndefined(await actor.update({ [`system.traits.${DISTINCTIONS}.entries`]: twoDice }));
          assert.isUndefined(await actor.update({ "system.kindId": newId() }));
          const unknownDef = [{ ...system.traits[SKILLS].entries[0], defId: newId() }];
          assert.isUndefined(await actor.update({ [`system.traits.${SKILLS}.entries`]: unknownDef }));
          assert.deepEqual(storedSystem(actor).traits, system.traits);
          assert.equal(storedSystem(actor).kindId, PC_KIND);
        });

        it("TS-07 stores [6, 6] in the scene distinctions set", async () => {
          const actor = await createCharacter({ traits: { [SCENE_DISTINCTIONS]: { entries: [] } } });
          const entries = [{ id: newId(), defId: null, name: "Panicked Crowd", dice: [6, 6] }];
          await actor.update({ [`system.traits.${SCENE_DISTINCTIONS}.entries`]: entries });
          assert.deepEqual(storedSystem(actor).traits[SCENE_DISTINCTIONS].entries[0].dice, [6, 6]);
        });

        it("lets an unrelated edit through on an actor holding a conflicting rating (point 5)", async () => {
          const system = pcSystem();
          system.traits[DISTINCTIONS].entries[0].dice = [6, 6]; // created that way: creation is loading
          const actor = await createCharacter(foundry.utils.deepClone(system));
          const entries = [{ ...system.traits[SKILLS].entries[0], dice: [10] }];
          await actor.update({ name: "[Quench] still editable", [`system.traits.${SKILLS}.entries`]: entries });
          assert.equal(game.actors.get(actor.id).name, "[Quench] still editable");
          assert.deepEqual(storedSystem(actor).traits[DISTINCTIONS].entries[0].dice, [6, 6]);
        });

        it("imports conflicting data from JSON, a replacing update, without the edit check (point 4)", async () => {
          const system = pcSystem();
          system.traits[DISTINCTIONS].entries[0].dice = [6, 6];
          system.kindId = newId();
          const actor = await createCharacter(pcSystem());
          const json = JSON.stringify({ ...actor.toObject(), system });
          await actor.importFromJSON(json);
          assert.equal(storedSystem(actor).kindId, system.kindId);
          assert.deepEqual(storedSystem(actor).traits[DISTINCTIONS].entries[0].dice, [6, 6]);
        });

        it("refuses the same edits on an unlinked token's actor, and restoring its delta still works", async () => {
          const system = pcSystem();
          system.traits[DISTINCTIONS].entries[0].dice = [6, 6]; // a conflict on the base actor
          const actor = await createCharacter(foundry.utils.deepClone(system));
          await actor.update({ "prototypeToken.actorLink": false });
          const scene = await getDocumentClass("Scene").create({ name: "[Quench] character tokens" });
          try {
            const tokenData = (await actor.getTokenDocument({ x: 0, y: 0 })).toObject();
            const [token] = await scene.createEmbeddedDocuments("Token", [tokenData]);
            // An unknown definition passes the schema, so only the backstop can refuse it; the name
            // change sent with it must be cancelled too.
            const bad = [{ ...system.traits[SKILLS].entries[0], defId: newId() }];
            await token.actor.update({ name: "[Quench] token renamed", [`system.traits.${SKILLS}.entries`]: bad });
            assert.notEqual(token.actor.name, "[Quench] token renamed");
            assert.equal(token.actor.system.toObject().traits[SKILLS].entries[0].defId, FIGHT);
            // The delta repairs the conflicting distinction; restoring it brings the base's [6, 6]
            // back, which the restore's pre-update must not refuse.
            const repaired = [{ ...system.traits[DISTINCTIONS].entries[0], dice: [8] }];
            await token.actor.update({ [`system.traits.${DISTINCTIONS}.entries`]: repaired });
            assert.deepEqual(token.actor.system.toObject().traits[DISTINCTIONS].entries[0].dice, [8]);
            await token.delta.restore();
            assert.deepEqual(token.actor.system.toObject().traits[DISTINCTIONS].entries[0].dice, [6, 6]);
          }
          finally {
            await scene.delete();
          }
        });
      });

      describe("entry and set fields (spec data shapes)", () => {
        /**
         * A set and an entry with every field the spec lists, none at its default, and a boss's free
         * trait with several dice.
         */
        const fullSystem = () => {
          const setId = newId();
          return {
            setId,
            system: {
              schemaVersion: CHARACTER_SCHEMA_VERSION,
              kindId: null,
              traits: {
                [setId]: { shutDown: true, sfx: [{ text: "Overload", unlocked: false }], entries: [{
                  id: newId(), defId: null, name: "Social", dice: [6],
                  description: "Talks people round", statement: "I always keep my word",
                  challenged: true, preChallengeDice: [8],
                  sfx: [{ text: "Hinder", unlocked: true }, { text: "Silver tongue", unlocked: false }],
                  tags: ["Trust", "Charm"],
                  sub: [{ id: newId(), name: "Haggling", dice: [6, 6] }],
                  shutDown: { reason: "manual" }
                }] }
              },
              freeTraits: [{ id: newId(), name: "Boss", dice: [10, 10, 10] }]
            }
          };
        };

        it("stores every field the spec lists on a set and an entry, and reads it back", async () => {
          const { system } = fullSystem();
          const actor = await createCharacter(foundry.utils.deepClone(system));
          assert.deepEqual(storedSystem(actor), system);
        });

        it("builds the same data strictly, as world loading does", () => {
          const { system } = fullSystem();
          assert.deepEqual(plain(loadCharacter(foundry.utils.deepClone(system)).system.toObject()), system);
        });

        it("RQ-021: stores the reason statementChallenged", async () => {
          const { system, setId } = fullSystem();
          system.traits[setId].entries[0].shutDown = { reason: "statementChallenged" };
          const actor = await createCharacter(foundry.utils.deepClone(system));
          assert.deepEqual(storedSystem(actor).traits[setId].entries[0].shutDown, { reason: "statementChallenged" });
        });

        it("fills a set's shutDown with false and a set's and an entry's sfx with [], and leaves the optional fields out", async () => {
          const setId = newId();
          const entry = { id: newId(), defId: null, name: "Cult Survivor", dice: [8] };
          // A copy: creating cleans its data in place.
          const actor = await createCharacter({ traits: { [setId]: { entries: [{ ...entry }] } } });
          assert.deepEqual(storedSystem(actor).traits[setId], { shutDown: false, sfx: [], entries: [{ ...entry, sfx: [] }] });
        });

        it("loads a character stored in the old shape unchanged, apart from those defaults, with no migration step (ADR-037 point 1, ADR-045)", () => {
          // The shape stored before this schema expansion: entries of id, defId, name and dice.
          const setId = newId();
          const old = {
            schemaVersion: 1,
            kindId: newId(),
            traits: { [setId]: { entries: [
              { id: newId(), defId: newId(), name: "Fight", dice: [8] },
              { id: newId(), defId: null, name: "Unrated", dice: [] }
            ] } },
            freeTraits: [{ id: newId(), name: "Big Shotgun", dice: [8] }]
          };
          const loaded = loadCharacter(foundry.utils.deepClone(old));
          assert.equal(CHARACTER_SCHEMA_VERSION, 1);
          assert.deepEqual(plain(loaded.system.toObject()), {
            ...old,
            traits: { [setId]: { shutDown: false, sfx: [], entries: old.traits[setId].entries.map(e => ({ ...e, sfx: [] })) } }
          });
        });

        it("refuses a bad shut-down reason, a non-boolean challenged and a d7 in preChallengeDice when built strictly; Actor.create stores nothing", async () => {
          const cases = {
            "bad reason": entry => { entry.shutDown = { reason: "forgotten" }; },
            "reason missing": entry => { entry.shutDown = {}; },
            "challenged as text": entry => { entry.challenged = "yes"; },
            "challenged as a number": entry => { entry.challenged = 1; },
            "d7 saved before the challenge": entry => { entry.preChallengeDice = [7]; },
            "d7 in a sub-trait": entry => { entry.sub[0].dice = [7]; },
            "SFX without its unlocked flag": entry => { delete entry.sfx[0].unlocked; },
            "SFX unlocked as text": entry => { entry.sfx[0].unlocked = "true"; }
          };
          for ( const [label, spoil] of Object.entries(cases) ) {
            const { system, setId } = fullSystem();
            spoil(system.traits[setId].entries[0]);
            assert.throws(() => loadCharacter(foundry.utils.deepClone(system)), undefined, undefined, label);
            const before = game.actors.size;
            assert.isUndefined(await createCharacter(system, `refused: ${label}`), label);
            assert.equal(game.actors.size, before, label);
          }

          const { system, setId } = fullSystem();
          system.traits[setId].shutDown = "true";
          assert.throws(() => loadCharacter(system), undefined, undefined, "a set's shutDown as text");
        });

        it("ADR-040: a free trait holds several dice, as a boss's trait does, and an edit to four dice passes", async () => {
          const { system } = fullSystem();
          const actor = await createCharacter(foundry.utils.deepClone(system));
          const freeTraits = [{ ...system.freeTraits[0], dice: [10, 10, 10, 10] }];
          await actor.update({ "system.freeTraits": freeTraits });
          assert.deepEqual(storedSystem(actor).freeTraits, freeTraits);
        });
      });

      describe("edit-time checks for the entry fields (ADR-037, TS-E01)", () => {
        /** A PC with Social [8] (a statement) and Shoot [12] with the specialty Guns [6]. */
        const pcSystem = () => ({
          kindId: PC_KIND,
          traits: {
            [ATTRIBUTES]: { shutDown: false, sfx: [], entries: [
              { id: newId(), defId: SOCIAL, name: "Social", dice: [8], statement: "I always keep my word", sfx: [] }
            ] },
            [SKILLS]: { shutDown: false, sfx: [], entries: [
              { id: newId(), defId: SHOOT, name: "Shoot", dice: [12], sfx: [], sub: [{ id: newId(), name: "Guns", dice: [6] }] }
            ] }
          },
          freeTraits: []
        });
        /** The entries of a set as the model reads them, optional fields undefined (what a sheet would edit). */
        const entriesOf = (actor, setId) => game.actors.get(actor.id).system.toObject().traits[setId].entries;

        it("TS-E01 refuses a d7 in preChallengeDice or in a sub-trait's rating visibly, cancelling the whole update", async () => {
          const system = pcSystem();
          const actor = await createCharacter(foundry.utils.deepClone(system));
          const social = [{ ...system.traits[ATTRIBUTES].entries[0], challenged: true, preChallengeDice: [7] }];
          const shoot = [{ ...system.traits[SKILLS].entries[0], sub: [{ ...system.traits[SKILLS].entries[0].sub[0], dice: [7] }] }];
          for ( const [setId, entries] of [[ATTRIBUTES, social], [SKILLS, shoot]] ) {
            const shown = await errorsShownBy(
              () => actor.update({ name: "[Quench] renamed", [`system.traits.${setId}.entries`]: entries })
            );
            assert.deepEqual(shown, [refusalText("INVALID_DIE_SIZE")], setId);
          }

          // A silent drop by Foundry would keep the name change; the backstop cancels it too.
          assert.equal(game.actors.get(actor.id).name, "[Quench] character");
          assert.deepEqual(storedSystem(actor).traits, system.traits);
        });

        it("RQ-021 and RQ-022: refuses a bad shut-down reason, a non-boolean challenged and a challenge without a saved rating visibly", async () => {
          const system = pcSystem();
          const actor = await createCharacter(foundry.utils.deepClone(system));
          const spoils = [{ shutDown: { reason: "forgotten" } }, { challenged: "yes" }, { challenged: true }];
          for ( const spoil of spoils ) {
            const entries = [{ ...system.traits[ATTRIBUTES].entries[0], ...spoil }];
            const shown = await errorsShownBy(
              () => actor.update({ name: "[Quench] renamed", [`system.traits.${ATTRIBUTES}.entries`]: entries })
            );
            assert.deepEqual(shown, [refusalText("INVALID_TRAIT_DATA")], JSON.stringify(spoil));
            // A silent drop by Foundry would keep the name change; the backstop cancels it too.
            assert.equal(game.actors.get(actor.id).name, "[Quench] character", JSON.stringify(spoil));
            assert.deepEqual(storedSystem(actor).traits[ATTRIBUTES], system.traits[ATTRIBUTES], JSON.stringify(spoil));
          }
        });

        it("ADR-046 point 4: refuses an SFX without its unlocked flag visibly, on an entry and on a set, cancelling the whole update", async () => {
          // Without the backstop Foundry drops the list holding it without an error, and with it
          // every other change to that set's entries, while the update's other changes are saved.
          const system = pcSystem();
          const actor = await createCharacter(foundry.utils.deepClone(system));
          const entries = [{ ...system.traits[ATTRIBUTES].entries[0], dice: [10], sfx: [{ text: "Charm" }] }];
          const onEntry = await errorsShownBy(
            () => actor.update({ name: "[Quench] renamed", [`system.traits.${ATTRIBUTES}.entries`]: entries })
          );
          assert.deepEqual(onEntry, [refusalText("INVALID_TRAIT_DATA")], "an entry's SFX");
          assert.equal(game.actors.get(actor.id).name, "[Quench] character", "an entry's SFX");
          const onSet = await errorsShownBy(
            () => actor.update({ name: "[Quench] renamed", [`system.traits.${SKILLS}.sfx`]: [{ text: "Overload" }] })
          );
          assert.deepEqual(onSet, [refusalText("INVALID_TRAIT_DATA")], "a set's SFX");
          assert.equal(game.actors.get(actor.id).name, "[Quench] character", "a set's SFX");
          assert.deepEqual(storedSystem(actor).traits, system.traits);
        });

        it("ADR-046 point 4, documents Foundry's behaviour: a text field that isn't text is cast and stored, not refused", async () => {
          // Cleaning casts these values to text before _preUpdate, so the backstop only ever sees
          // text: nothing is dropped, and nothing is refused.
          const system = pcSystem();
          const actor = await createCharacter(foundry.utils.deepClone(system));
          const entries = [{
            ...system.traits[ATTRIBUTES].entries[0], statement: 5, description: 7, tags: [5, true],
            sfx: [{ text: 9, unlocked: true }]
          }];
          const shown = await errorsShownBy(() => actor.update({ [`system.traits.${ATTRIBUTES}.entries`]: entries }));
          assert.deepEqual(shown, []);
          assert.deepInclude(storedSystem(actor).traits[ATTRIBUTES].entries[0], {
            statement: "5", description: "7", tags: ["5", "true"], sfx: [{ text: "9", unlocked: true }]
          });
        });

        it("ADR-046 point 5: a set's own SFX are stored through Actor#update and leave its entries alone", async () => {
          const system = pcSystem();
          const actor = await createCharacter(foundry.utils.deepClone(system));
          const sfx = [{ text: "Overload", unlocked: false }, { text: "Area attack", unlocked: true }];
          await actor.update({ [`system.traits.${SKILLS}.sfx`]: sfx });
          assert.deepEqual(storedSystem(actor).traits[SKILLS], { ...system.traits[SKILLS], sfx });
        });

        it("TS-14 and TS-14b: challenges written back through Actor#update pass the backstop", async () => {
          const actor = await createCharacter(pcSystem());
          const once = challengeStatement(entriesOf(actor, ATTRIBUTES)[0]).value;
          await actor.update({ [`system.traits.${ATTRIBUTES}.entries`]: [once] });
          assert.deepInclude(storedSystem(actor).traits[ATTRIBUTES].entries[0], { dice: [6], challenged: true, preChallengeDice: [8] });

          const twice = challengeStatement(entriesOf(actor, ATTRIBUTES)[0]).value;
          await actor.update({ [`system.traits.${ATTRIBUTES}.entries`]: [twice] });
          assert.deepInclude(storedSystem(actor).traits[ATTRIBUTES].entries[0], { dice: [4], challenged: true, preChallengeDice: [8] });
        });

        it("TS-16: a d4 challenged and then rewritten, written back through Actor#update", async () => {
          const system = pcSystem();
          system.traits[ATTRIBUTES].entries[0].dice = [4];
          const actor = await createCharacter(system);

          const challenged = challengeStatement(entriesOf(actor, ATTRIBUTES)[0]).value;
          await actor.update({ [`system.traits.${ATTRIBUTES}.entries`]: [challenged] });
          assert.deepInclude(storedSystem(actor).traits[ATTRIBUTES].entries[0], {
            dice: [4], challenged: true, preChallengeDice: [4], shutDown: { reason: "statementChallenged" }
          });

          const rewritten = resolveChallengedStatement(entriesOf(actor, ATTRIBUTES)[0], { rewritten: true }).value;
          await actor.update({ [`system.traits.${ATTRIBUTES}.entries`]: [rewritten] });
          const stored = storedSystem(actor).traits[ATTRIBUTES].entries[0];
          assert.deepEqual(stored.dice, [4]);
          for ( const key of ["challenged", "preChallengeDice", "shutDown"] ) assert.notProperty(stored, key);
        });

        it("TS-15c: editing a challenged entry's statement, SFX and tags keeps the challenge", async () => {
          const actor = await createCharacter(pcSystem());
          const challenged = challengeStatement(entriesOf(actor, ATTRIBUTES)[0]).value;
          await actor.update({ [`system.traits.${ATTRIBUTES}.entries`]: [challenged] });

          const edited = {
            ...editStatement(entriesOf(actor, ATTRIBUTES)[0], "I keep my word, mostly").value,
            sfx: [{ text: "Swayed by a friend", unlocked: false }],
            tags: ["Trust"]
          };
          await actor.update({ [`system.traits.${ATTRIBUTES}.entries`]: [edited] });
          assert.deepInclude(storedSystem(actor).traits[ATTRIBUTES].entries[0], {
            statement: "I keep my word, mostly", challenged: true, preChallengeDice: [8],
            sfx: [{ text: "Swayed by a friend", unlocked: false }], tags: ["Trust"]
          });
        });

        it("rule 15: a set's and an entry's shut-down flags are set and cleared by hand", async () => {
          const system = pcSystem();
          const actor = await createCharacter(foundry.utils.deepClone(system));
          await actor.update({ [`system.traits.${SKILLS}.shutDown`]: true });
          const manual = [{ ...system.traits[ATTRIBUTES].entries[0], shutDown: { reason: "manual" } }];
          await actor.update({ [`system.traits.${ATTRIBUTES}.entries`]: manual });
          assert.isTrue(storedSystem(actor).traits[SKILLS].shutDown);
          assert.deepEqual(storedSystem(actor).traits[ATTRIBUTES].entries[0].shutDown, { reason: "manual" });

          await actor.update({
            [`system.traits.${SKILLS}.shutDown`]: false,
            [`system.traits.${ATTRIBUTES}.entries`]: system.traits[ATTRIBUTES].entries
          });
          assert.deepEqual(storedSystem(actor).traits, system.traits);
        });

        it("ADR-046 point 1, rule 19: a sub-trait rated [6, 6] under a one-die skill passes the edit check (die sizes only)", async () => {
          const system = pcSystem();
          const actor = await createCharacter(foundry.utils.deepClone(system));
          const entry = system.traits[SKILLS].entries[0];
          const shoot = [{ ...entry, sub: [{ ...entry.sub[0], dice: [6, 6] }] }];
          await actor.update({ [`system.traits.${SKILLS}.entries`]: shoot });
          assert.deepEqual(storedSystem(actor).traits[SKILLS].entries[0].sub[0].dice, [6, 6]);
        });
      });
    },
    { displayName: "Cortex Prime: character actor" }
  );
}
