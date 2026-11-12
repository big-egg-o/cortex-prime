/**
 * Quench batch "cortex-prime.character-migration": the versioned migration runner
 * (module/data/migration-runner.mjs) on the character model, inside Foundry (Decisions ADR-045).
 * The character schema has no migration yet, so the batch puts a test-only step in place while it
 * runs: version 2 renames a free trait's `label` to `name`. It then checks the paths on which
 * Foundry 14.369 calls migrateData: building an actor from stored data, as world load does;
 * creating one; and a partial update. The model's own list is put back afterwards, and every
 * actor the batch creates is deleted. The step exists here only; nothing of it ships.
 * @module tests/quench/character-migration
 */

import CharacterData, { CHARACTER_MIGRATIONS, CHARACTER_SCHEMA_VERSION } from "../../module/data/actor/character.mjs";
import { defineMigrations } from "../../module/data/migration-runner.mjs";

const FLAG_SCOPE = "cortex-prime";
const FLAG_KEY = "quenchCharacterMigration";

/**
 * The test-only step. Like every step it changes only what is still in the old shape, never
 * overwrites a value already in the new shape and fills in no defaults.
 */
const TEST_MIGRATIONS = defineMigrations([{
  version: 2,
  migrate: source => {
    if ( !Array.isArray(source.freeTraits) ) return source;
    for ( const trait of source.freeTraits ) {
      if ( !trait || (typeof trait !== "object") || !("label" in trait) ) continue;
      if ( !("name" in trait) ) trait.name = trait.label;
      delete trait.label;
    }
    return source;
  }
}]);

/** @returns {string} a new 16-character id */
function newId() {
  return foundry.utils.randomID();
}

/** @returns {object} data as it is stored: a JSON round trip */
function plain(data) {
  return JSON.parse(JSON.stringify(data));
}

/**
 * Builds an actor from source data strictly, as world loading does, without storing it.
 * @param {object} system
 * @returns {Actor}
 */
function loadCharacter(system) {
  return Actor.implementation.fromSource(
    { _id: newId(), name: "[Quench] loaded", type: "character", system }, { strict: true }
  );
}

/** Deletes every actor this batch created, including ones left by an interrupted run. */
async function deleteTestActors() {
  const ids = game.actors.filter(a => a.getFlag(FLAG_SCOPE, FLAG_KEY)).map(a => a.id);
  if ( ids.length ) await Actor.implementation.deleteDocuments(ids);
}

/**
 * Creates and stores a test character.
 * @param {object} system
 * @returns {Promise<Actor>}
 */
function createCharacter(system) {
  return Actor.implementation.create({
    name: "[Quench] character migration", type: "character", system, flags: { [FLAG_SCOPE]: { [FLAG_KEY]: true } }
  });
}

/** @returns {object} the stored system data of an actor */
function storedSystem(actor) {
  return plain(game.actors.get(actor.id).system.toObject());
}

/**
 * Register the batch with Quench.
 * @param {object} quench
 */
export function registerCharacterMigrationBatch(quench) {
  quench.registerBatch(
    "cortex-prime.character-migration",
    ({ describe, it, assert, before, after, afterEach }) => {
      before(deleteTestActors);
      afterEach(deleteTestActors);

      describe("the model as shipped (ADR-045 points 1 and 2)", () => {
        it("runs the runner with no migration, at schema version 1", () => {
          assert.equal(CHARACTER_SCHEMA_VERSION, 1);
          assert.lengthOf(CHARACTER_MIGRATIONS, 0);
          assert.strictEqual(CharacterData.migrations, CHARACTER_MIGRATIONS);
        });

        it("loads and creates a version-1 character unchanged", async () => {
          const system = { schemaVersion: 1, kindId: null, traits: {}, freeTraits: [{ id: newId(), name: "Big Shotgun", dice: [8] }] };
          assert.deepEqual(plain(loadCharacter(foundry.utils.deepClone(system)).system.toObject()), system);
          const actor = await createCharacter(foundry.utils.deepClone(system));
          assert.deepEqual(storedSystem(actor), system);
        });
      });

      describe("with a test-only step in place (ADR-045 point 3)", () => {
        before(() => {
          CharacterData.migrations = TEST_MIGRATIONS;
        });
        after(() => {
          CharacterData.migrations = CHARACTER_MIGRATIONS;
        });

        /** A character in the test step's old shape: a free trait with a `label`, no `name`. */
        const oldSystem = () => {
          const id = newId();
          return { id, system: { schemaVersion: 1, kindId: null, traits: {}, freeTraits: [{ id, label: "Big Shotgun", dice: [8] }] } };
        };
        const migrated = id => ({ schemaVersion: 2, kindId: null, traits: {}, freeTraits: [{ id, name: "Big Shotgun", dice: [8] }] });

        it("migrates a character stored at the old version when it is built from its source, as on world load", () => {
          const { id, system } = oldSystem();
          assert.deepEqual(plain(loadCharacter(system).system.toObject()), migrated(id));
        });

        it("starts full data without a version from version 1", () => {
          const { id, system } = oldSystem();
          delete system.schemaVersion;
          assert.deepEqual(plain(loadCharacter(system).system.toObject()), migrated(id));
        });

        it("never overwrites a value that is already in the new shape", () => {
          const { id, system } = oldSystem();
          system.freeTraits[0].name = "Kept";
          const loaded = plain(loadCharacter(system).system.toObject());
          assert.deepEqual(loaded.freeTraits, [{ id, name: "Kept", dice: [8] }]);
          assert.equal(loaded.schemaVersion, 2);
        });

        it("migrates a character created at the old version, and stores the new version", async () => {
          const { id, system } = oldSystem();
          const actor = await createCharacter(system);
          assert.deepEqual(storedSystem(actor), migrated(id));
        });

        it("leaves a partial update without a version alone: no step runs, nothing else is filled in or overwritten", async () => {
          const { id, system } = oldSystem();
          const actor = await createCharacter(system);
          // A list sent in the old shape without a version is not migrated: had the step run, the
          // label would have become the name. Cleaning drops the key the schema doesn't know
          // instead, and the name is the field's own empty initial value.
          await actor.update({ "system.freeTraits": [{ id, label: "Old label", dice: [8] }] });
          assert.deepEqual(storedSystem(actor), { ...migrated(id), freeTraits: [{ id, name: "", dice: [8] }] });
        });

        it("migrates a partial update that says it is at the old version, keeps it partial and keeps a value already in the new shape", async () => {
          const { id, system } = oldSystem();
          // A kind id and a set that the update doesn't send: had the update been filled in with
          // defaults, the kind id would be null again.
          system.kindId = newId();
          system.traits = { [newId()]: { entries: [{ id: newId(), defId: null, name: "Kept as stored", dice: [8] }] } };
          const actor = await createCharacter(system);
          const before = storedSystem(actor);
          assert.equal(before.kindId, system.kindId);
          const second = newId();
          await actor.update({ system: { schemaVersion: 1, freeTraits: [
            { id, label: "Sawn-off", dice: [10] },
            { id: second, label: "Old label", name: "Already named", dice: [6] }
          ] } });
          assert.deepEqual(storedSystem(actor), { ...before, freeTraits: [
            { id, name: "Sawn-off", dice: [10] },
            { id: second, name: "Already named", dice: [6] }
          ] });
          assert.equal(before.schemaVersion, 2);
        });
      });

      describe("afterwards", () => {
        it("the model runs its own list again", () => {
          assert.strictEqual(CharacterData.migrations, CHARACTER_MIGRATIONS);
        });
      });
    },
    { displayName: "Cortex Prime: character migrations" }
  );
}
