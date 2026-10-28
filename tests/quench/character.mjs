/**
 * Quench batch "cortex-prime.character": the "character" Actor type and its first schema slice
 * (Decisions ADR-031 to ADR-034, ADR-037). Every actor it creates carries a test flag and is
 * deleted after each test; actors left behind by an interrupted run are deleted before the batch.
 * There is no game configuration yet, so every kind, set and definition id here matches nothing.
 * No edit-time check exists yet (the ADR-037 backstop is a later step): the invalid-update test
 * records Foundry's own behaviour, which drops the rating silently.
 * @module tests/quench/character
 */

import CharacterData, { CHARACTER_SCHEMA_VERSION } from "../../module/data/actor/character.mjs";

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

/** @returns {object} the stored system data of a character, read back from the world collection */
function storedSystem(actor) {
  return game.actors.get(actor.id).system.toObject();
}

/**
 * A character's system data with two trait sets (one entry list as a fixed set would have it,
 * with defIds, one as an open set would, without) and free traits.
 * @returns {{system: object, setA: string, setB: string}}
 */
function sampleSystem() {
  const setA = newId();
  const setB = newId();
  const system = {
    schemaVersion: CHARACTER_SCHEMA_VERSION,
    kindId: newId(),
    traits: {
      [setA]: { entries: [
        { id: newId(), defId: newId(), name: "Fight", dice: [8] },
        { id: newId(), defId: newId(), name: "Sneak", dice: [6] }
      ] },
      [setB]: { entries: [
        { id: newId(), defId: null, name: "Cult Survivor", dice: [8] }
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
    ({ describe, it, assert, before, afterEach }) => {

      before(deleteTestActors);
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
          assert.deepEqual(loadCharacter(foundry.utils.deepClone(system)).system.toObject(), system);

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
          // because the game configuration doesn't exist yet.
          const { system, setA } = sampleSystem();
          const actor = await createCharacter(foundry.utils.deepClone(system));
          const renamed = system.traits[setA].entries.map(e => ({ ...e, name: `${e.name} (renamed)` }));
          await actor.update({ [`system.traits.${setA}.entries`]: renamed });

          const stored = storedSystem(actor).traits[setA].entries;
          assert.deepEqual(stored.map(e => [e.id, e.defId, e.dice]), system.traits[setA].entries.map(e => [e.id, e.defId, e.dice]));
          assert.deepEqual(stored.map(e => e.name), ["Fight (renamed)", "Sneak (renamed)"]);
        });

        it("replacing one set's entries keeps the other sets, the kind and the free traits", async () => {
          const { system, setA, setB } = sampleSystem();
          const actor = await createCharacter(foundry.utils.deepClone(system));
          const replacement = [{ id: newId(), defId: null, name: "Panicked Crowd", dice: [6, 6] }];
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

        it("drops an update with [7] without an error (no edit-time check exists yet)", async () => {
          const { system, setA } = sampleSystem();
          const actor = await createCharacter(foundry.utils.deepClone(system));
          const bad = system.traits[setA].entries.map((e, i) => (i === 0 ? { ...e, dice: [7] } : e));

          // Only the rating changes: Foundry finds no valid change and skips the update.
          assert.isUndefined(await actor.update({ [`system.traits.${setA}.entries`]: bad }));
          assert.deepEqual(storedSystem(actor).traits[setA], system.traits[setA]);

          // Together with a valid change: that change is saved, the rating is not.
          await actor.update({ name: "[Quench] character renamed", [`system.traits.${setA}.entries`]: bad });
          assert.equal(game.actors.get(actor.id).name, "[Quench] character renamed");
          assert.deepEqual(storedSystem(actor).traits[setA], system.traits[setA]);
        });

        it("drops fields this slice doesn't define and set keys that aren't 16-character ids", async () => {
          // A known limitation of this first slice, not approved behaviour: the omitted spec fields
          // need a later schema expansion.
          const setId = newId();
          const entry = { id: newId(), defId: null, name: "Social", dice: [6] };
          const actor = await createCharacter({
            traits: {
              [setId]: { shutDown: true, entries: [{ ...entry, preChallengeDice: [8], challenged: true }] },
              attributes: { entries: [{ id: newId(), defId: null, name: "Physical", dice: [8] }] }
            },
            notInSchema: true
          });

          const stored = storedSystem(actor);
          assert.deepEqual(Object.keys(stored.traits), [setId]);
          assert.deepEqual(stored.traits[setId], { entries: [entry] });
          assert.notProperty(stored, "notInSchema");
        });
      });
    },
    { displayName: "Cortex Prime: character actor" }
  );
}
