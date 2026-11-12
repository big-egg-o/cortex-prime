/**
 * Quench batch "cortex-prime.proposed-trait-data": the pure proposedTraitData (module/rules/
 * traits.mjs) compared with Foundry 14.369's own handling of each update shape
 * the ADR-037 backstop can receive, on real characters in the world.
 *
 * For every shape a fresh test character is created, and the update is cleaned as the client
 * backend cleans it before `_preUpdate` (client/data/client-backend.mjs,
 * `#preUpdateDocumentArray`: `cleanData` with migrate, sanitize and partial). Its `system`
 * changes go to proposedTraitData, as the backstop gives them. Foundry's answers:
 * - the backend's own dry run, `actor.updateSource(changes, {clean: true, dryRun: true,
 *   fallback: false})`, which must leave the actor as it was and return an empty diff exactly
 *   when the pure state equals the stored one;
 * - the same changes written straight to an unsaved copy with `updateSource`, a direct write
 *   that Actor#update never makes (ADR-037 point 7): the requesting client applies the server's
 *   response instead, whose operators cleaning rebuilds as proxies;
 * - a real `Actor#update`, after which the trait data the requesting client holds (the server's
 *   response applied) must equal the pure state: that is what the backstop guards.
 * Where Foundry refuses an update, the backstop must refuse it too, visibly. Unlinked token
 * actors get the shapes that remove a set, which a token's delta can't hold; the differences are
 * recorded for the owner. The world's game configuration is the ADR-036 defaults while the batch
 * runs (the backstop runs on the real updates), and the stored one is put back afterwards; every
 * test character and scene is deleted.
 * @module tests/quench/proposed-trait-data
 */

import CharacterData from "../../module/data/actor/character.mjs";
import { GAME_CONFIG_SETTING, getGameConfig } from "../../module/config/settings.mjs";
import { checkCharacterUpdate, defaultGameConfig, proposedTraitData } from "../../module/rules/index.mjs";

// Ids from the ADR-036 defaults.
const PC_KIND = "cpKindPlayerChar";
const MINOR_GMC_KIND = "cpKindMinorGmc00";
const DISTINCTIONS = "cpSetDistinction";
const SKILLS = "cpSetSkills00000";
const SCENE_DISTINCTIONS = "cpSetSceneDistin";
const FIGHT = "cpSkillFight0000";
const SHOOT = "cpSkillShoot0000";

const FLAG_SCOPE = "cortex-prime";
const FLAG_KEY = "quenchProposedTraitData";

/** @returns {object} data as it is stored: a JSON round trip */
function plain(data) {
  return JSON.parse(JSON.stringify(data));
}

/** @returns {{kindId: unknown, traits: unknown, freeTraits: unknown}} the parts the edit checks read */
function traitData(system) {
  return plain({ kindId: system.kindId, traits: system.traits, freeTraits: system.freeTraits });
}

/** The test character: a distinction, Fight d6 and a free trait, under the defaults' PC kind. */
function characterSystem() {
  return {
    kindId: PC_KIND,
    traits: {
      [DISTINCTIONS]: { entries: [{ id: "distinction00001", defId: null, name: "Seasoned Smuggler", dice: [8] }] },
      [SKILLS]: { entries: [{ id: "skillfight000001", defId: FIGHT, name: "Fight", dice: [6] }] }
    },
    freeTraits: [{ id: "freetrait0000001", name: "Big Shotgun", dice: [8] }]
  };
}

/** Fight stepped up and Shoot added: the entries a sheet would send for the skills set. */
function skillEntries() {
  return [
    { id: "skillfight000001", defId: FIGHT, name: "Fight", dice: [8] },
    { id: "skillshoot000001", defId: SHOOT, name: "Shoot", dice: [6] }
  ];
}

/** Deletes every actor this batch created, including ones left by an interrupted run. */
async function deleteTestActors() {
  const ids = game.actors.filter(a => a.getFlag(FLAG_SCOPE, FLAG_KEY)).map(a => a.id);
  if ( ids.length ) await Actor.implementation.deleteDocuments(ids);
}

/**
 * Runs one update shape on a fresh test character: the pure state, the backstop's decision, the
 * dry run, the state of a direct write to a copy, and the stored state and name after a real
 * update. The character is deleted after each test.
 * @param {() => object} update - makes a fresh update object, as passed to Actor#update
 * @returns {Promise<object>} what each side gave
 */
async function compare(update) {
  const actor = await Actor.implementation.create({
    name: "[Quench] proposed trait data", type: "character", system: characterSystem(),
    flags: { [FLAG_SCOPE]: { [FLAG_KEY]: true } }
  });
  const clean = () => Actor.implementation.cleanData(update(), { migrate: true, sanitize: true, partial: true },
    { creation: false, model: actor, source: actor._source });
  const operators = { operatorOf: CharacterData.operatorOf };
  const current = actor.system.toObject();
  const pure = proposedTraitData(current, clean().system, operators);
  const backstop = checkCharacterUpdate(current, clean().system, getGameConfig(), operators);

  const before = JSON.stringify(actor.toObject());
  let diff = null;
  let dryRunError = null;
  try {
    diff = actor.updateSource(clean(), { clean: true, dryRun: true, fallback: false });
  }
  catch( err ) {
    dryRunError = err;
  }
  const unchanged = JSON.stringify(actor.toObject()) === before;

  const copy = actor.clone({}, { keepId: true });
  let local;
  try {
    copy.updateSource(clean(), { clean: true, fallback: false });
    local = traitData(copy.system.toObject());
  }
  catch {
    local = null;
  }

  await actor.update(update());
  const after = game.actors.get(actor.id);
  return {
    current: traitData(current), pure, backstop, diff, dryRunError, unchanged, local,
    stored: traitData(after.system.toObject()), storedName: after.name
  };
}

/**
 * Register the batch with Quench.
 * @param {object} quench
 */
export function registerProposedTraitDataBatch(quench) {
  quench.registerBatch(
    "cortex-prime.proposed-trait-data",
    ({ describe, it, assert, before, after, afterEach }) => {
      let storedConfig;
      before(async () => {
        storedConfig = getGameConfig();
        await deleteTestActors();
        await game.settings.set("cortex-prime", GAME_CONFIG_SETTING, defaultGameConfig());
      });
      afterEach(deleteTestActors);
      after(async () => {
        await deleteTestActors();
        if ( storedConfig ) await game.settings.set("cortex-prime", GAME_CONFIG_SETTING, storedConfig);
      });

      /** @returns {string} trait data for a failure message */
      const show = data => JSON.stringify(data?.traits);

      /**
       * Asserts that both sides agree on an update Foundry accepts: the dry run leaves the actor
       * alone and its diff is empty exactly when nothing changes, the backstop lets it through,
       * the stored state is the pure state, and so is the state of a direct write unless
       * `directDiffers`.
       */
      const assertSame = (result, label, { directDiffers = false } = {}) => {
        assert.isNull(result.dryRunError, `${label}: Foundry's dry run refused it: ${result.dryRunError?.message}`);
        assert.isTrue(result.unchanged, `${label}: the dry run changed the actor`);
        assert.isTrue(result.pure.ok, `${label}: proposedTraitData refused it with ${result.pure.code}`);
        const pure = traitData(result.pure.value);
        assert.isTrue(result.backstop.ok, `${label}: the backstop refused it with ${result.backstop.code}`);
        assert.deepEqual(result.stored, pure, `${label}: stored ${show(result.stored)}, pure ${show(pure)}`);
        const changes = !foundry.utils.equals(pure, result.current);
        assert.equal(!foundry.utils.isEmpty(result.diff), changes, `${label}: the dry run's diff and the state disagree`);
        if ( !directDiffers ) assert.deepEqual(result.local, pure, `${label}: direct ${show(result.local)}, pure ${show(pure)}`);
      };

      describe("updates Foundry accepts give the same trait data (ADR-037 point 3)", () => {
        it("a sheet submit of a set's entries, as a dotted key", async () => {
          assertSame(await compare(() => ({ [`system.traits.${SKILLS}.entries`]: skillEntries() })), "dotted");
        });

        it("a sheet submit of a set's entries, as form data with numbered keys", async () => {
          // FormDataExtended expands "system.traits.<set>.entries.0.id" into an object keyed 0, 1, ...
          const indexed = () => {
            const entries = Object.fromEntries(skillEntries().map((e, i) => [i, e]));
            return { system: { traits: { [SKILLS]: { entries } } } };
          };
          assertSame(await compare(indexed), "numbered keys");
        });

        it("a sheet submit that changes nothing", async () => {
          const same = () => ({ [`system.traits.${SKILLS}.entries`]: characterSystem().traits[SKILLS].entries });
          assertSame(await compare(same), "no change");
        });

        it("a new set key", async () => {
          const entries = [{ id: "scene00000000001", defId: null, name: "Panicked Crowd", dice: [6, 6] }];
          assertSame(await compare(() => ({ [`system.traits.${SCENE_DISTINCTIONS}`]: { entries } })), "new set");
        });

        it("a new set key without entries", async () => {
          assertSame(await compare(() => ({ [`system.traits.${SCENE_DISTINCTIONS}`]: {} })), "new empty set");
        });

        it("a forced deletion of a set key", async () => {
          const { ForcedDeletion } = foundry.data.operators;
          assertSame(await compare(() => ({ [`system.traits.${SKILLS}`]: new ForcedDeletion() })), "deletion");
        });

        it("a forced replacement of traits; a direct write of `new ForcedReplacement` commits only the removals", async () => {
          // Recorded Foundry behaviour, not ours: TypedObjectField#_updateCommit removes the sets the
          // new value lacks, then walks the diff's own keys, and an operator made with
          // `new ForcedReplacement` hides its value behind a symbol: a set present before and after
          // keeps its old entries and a new set isn't added. Actor#update never commits that way:
          // the client applies the server's response, whose operator cleaning rebuilds with
          // ForcedReplacement.create (a proxy that shows the value's keys), so the stored state is
          // the pure one.
          const { ForcedReplacement } = foundry.data.operators;
          const scene = [{ id: "scene00000000001", defId: null, name: "Panicked Crowd", dice: [6, 6] }];
          const traits = () => ({ [SKILLS]: { entries: skillEntries() }, [SCENE_DISTINCTIONS]: { entries: scene } });
          const result = await compare(() => ({ "system.traits": new ForcedReplacement(traits()) }));
          assertSame(result, "traits", { directDiffers: true });
          // The kept set is compared as it was stored, with whatever defaults the schema gives a set.
          assert.deepEqual(result.local?.traits, { [SKILLS]: result.current.traits[SKILLS] },
            "Foundry's direct commit of a plain ForcedReplacement changed; the directDiffers exception can go");
        });

        it("a forced replacement of traits made with ForcedReplacement.create", async () => {
          const { ForcedReplacement } = foundry.data.operators;
          const traits = () => ({ [SKILLS]: { entries: skillEntries() } });
          assertSame(await compare(() => ({ "system.traits": ForcedReplacement.create(traits()) })), "traits (proxy)");
        });

        it("a forced replacement of traits with a forced deletion inside its value", async () => {
          const { ForcedDeletion, ForcedReplacement } = foundry.data.operators;
          const traits = () => ({ [SKILLS]: { entries: skillEntries() }, [DISTINCTIONS]: new ForcedDeletion() });
          assertSame(await compare(() => ({ "system.traits": ForcedReplacement.create(traits()) })), "nested deletion");
        });

        it("a forced replacement of a set", async () => {
          const { ForcedReplacement } = foundry.data.operators;
          const update = () => ({ [`system.traits.${SKILLS}`]: new ForcedReplacement({ entries: skillEntries() }) });
          assertSame(await compare(update), "set");
        });

        it("a forced replacement of a set's entries", async () => {
          const { ForcedReplacement } = foundry.data.operators;
          const update = () => ({ [`system.traits.${SKILLS}.entries`]: new ForcedReplacement(skillEntries()) });
          assertSame(await compare(update), "entries");
        });

        it("a forced replacement of system, which counts as replacing (ADR-043)", async () => {
          const { ForcedReplacement } = foundry.data.operators;
          const system = () => ({ ...characterSystem(), traits: { [SKILLS]: { entries: skillEntries() } } });
          const result = await compare(() => ({ system: new ForcedReplacement(system()) }));
          assertSame(result, "system");
          assert.isTrue(result.pure.value.replaced);
          assert.deepEqual(result.backstop, { ok: true, value: null });
        });

        it("the legacy \"-=\" key for a set", async () => {
          assertSame(await compare(() => ({ [`system.traits.-=${SKILLS}`]: null })), "-=");
        });

        it("the legacy \"==\" key for traits, a set, entries and system", async () => {
          const traits = () => ({ [SKILLS]: { entries: skillEntries() } });
          assertSame(await compare(() => ({ "system.==traits": traits() })), "==traits");
          assertSame(await compare(() => ({ [`system.traits.==${SKILLS}`]: { entries: skillEntries() } })), "==set");
          assertSame(await compare(() => ({ [`system.traits.${SKILLS}.==entries`]: skillEntries() })), "==entries");
          const result = await compare(() => ({ "==system": { ...characterSystem(), traits: traits() } }));
          assertSame(result, "==system");
          assert.isTrue(result.pure.value.replaced);
        });

        it("a kind and the free traits", async () => {
          const update = () => ({
            "system.kindId": MINOR_GMC_KIND, "system.freeTraits": [{ id: "freetrait0000002", name: "Boss", dice: [8, 8, 8] }]
          });
          assertSame(await compare(update), "kind and free traits");
        });
      });

      describe("updates Foundry refuses or drops: the backstop refuses them visibly", () => {
        // Each update carries a valid name change: a refusal by the backstop cancels it too, where
        // Foundry's own silent drop of a list would keep it (ADR-037 point 3).
        const RENAMED = "[Quench] renamed";

        it("a forced deletion of a set's entries: Foundry refuses it, and the backstop refuses it as malformed", async () => {
          const { ForcedDeletion } = foundry.data.operators;
          const result = await compare(() => ({ name: RENAMED, [`system.traits.${SKILLS}.entries`]: new ForcedDeletion() }));
          assert.isNotNull(result.dryRunError, "Foundry's dry run accepted it");
          assert.isTrue(result.unchanged);
          assert.deepEqual(result.backstop, { ok: false, code: "INVALID_TRAIT_DATA" });
          assert.deepEqual(result.stored, result.current);
          assert.notEqual(result.storedName, RENAMED);
        });

        it("TS-E01 a rating with a d7: the pure state holds it and the backstop refuses it, where Foundry would drop it", async () => {
          const bad = () => ({ name: RENAMED, [`system.traits.${SKILLS}.entries`]: [{ ...skillEntries()[0], dice: [7] }] });
          const result = await compare(bad);
          assert.isTrue(result.unchanged);
          assert.isTrue(result.pure.ok);
          assert.deepEqual(result.pure.value.traits[SKILLS].entries[0].dice, [7]);
          assert.deepEqual(result.backstop, { ok: false, code: "INVALID_DIE_SIZE" });
          assert.deepEqual(result.stored, result.current);
          assert.notEqual(result.storedName, RENAMED);
        });
      });

      describe("unlinked token actors: removing a set (recorded for the owner, ADR-037 point 3)", () => {
        /**
         * Runs an update on a fresh unlinked token's actor: the pure state from the cleaned changes,
         * the backstop's decision, and the token actor's trait data afterwards.
         * @param {() => object} update
         * @returns {Promise<object>}
         */
        const compareOnToken = async update => {
          const actor = await Actor.implementation.create({
            name: "[Quench] proposed trait data (token)", type: "character", system: characterSystem(),
            prototypeToken: { actorLink: false }, flags: { [FLAG_SCOPE]: { [FLAG_KEY]: true } }
          });
          const scene = await getDocumentClass("Scene").create({ name: "[Quench] proposed trait data" });
          try {
            const tokenData = (await actor.getTokenDocument({ x: 0, y: 0 })).toObject();
            const [token] = await scene.createEmbeddedDocuments("Token", [tokenData]);
            const synthetic = token.actor;
            const changes = Actor.implementation.cleanData(update(), { migrate: true, sanitize: true, partial: true },
              { creation: false, model: synthetic, source: synthetic._source });
            const operators = { operatorOf: CharacterData.operatorOf };
            const current = synthetic.system.toObject();
            const pure = proposedTraitData(current, changes.system, operators);
            const backstop = checkCharacterUpdate(current, foundry.utils.deepClone(changes.system), getGameConfig(), operators);
            await synthetic.update(update());
            return { pure, backstop, stored: traitData(token.actor.system.toObject()) };
          }
          finally {
            await scene.delete();
          }
        };

        it("a forced deletion of a set key: the pure state drops the set, the token's actor gets it back from the base actor", async () => {
          // A token's delta stores system as plain data and can't hold a deletion, so the synthetic
          // actor is the base actor's data merged with the delta again. Not decided: see the report.
          const { ForcedDeletion } = foundry.data.operators;
          const result = await compareOnToken(() => ({ [`system.traits.${SKILLS}`]: new ForcedDeletion() }));
          assert.isTrue(result.backstop.ok);
          assert.notProperty(result.pure.value.traits, SKILLS);
          assert.property(result.stored.traits, SKILLS, "the token's actor kept the set: the gap is closed, update the report");
        });

        it("moving an entry out of a deleted set leaves its id twice on the token's actor, past the backstop (ADR-038)", async () => {
          const { ForcedDeletion } = foundry.data.operators;
          const fight = { ...characterSystem().traits[SKILLS].entries[0], defId: null };
          const distinctions = [...characterSystem().traits[DISTINCTIONS].entries, fight];
          const result = await compareOnToken(() => ({
            [`system.traits.${SKILLS}`]: new ForcedDeletion(), [`system.traits.${DISTINCTIONS}.entries`]: distinctions
          }));
          assert.isTrue(result.backstop.ok, "the backstop sees a move");
          const ids = Object.values(result.stored.traits).flatMap(set => set.entries.map(e => e.id));
          assert.equal(ids.filter(id => id === fight.id).length, 2, "the duplicate is gone: the gap is closed, update the report");
        });
      });
    },
    { displayName: "Cortex Prime: proposedTraitData against Foundry's update" }
  );
}
