/**
 * Quench batch "cortex-prime.character-sheet": the ApplicationV2 character sheet (Roadmap M2,
 * first slice). It renders the sets of an actor's kind as the game configuration names them, and
 * an edited rating is saved through Actor#update and is there when the sheet is opened again. A
 * rating its set doesn't allow is refused before anything is written (ADR-037 point 3). Every
 * actor it creates carries a test flag and is deleted after each test, with its sheets closed;
 * actors left behind by an interrupted run are deleted before the batch. The batch stores the
 * ADR-036 defaults as the world's game configuration while it runs, changes it where a test needs
 * a set of its own, and puts the stored configuration back afterwards.
 * @module tests/quench/character-sheet
 */

import CharacterSheet from "../../module/apps/character-sheet.mjs";
import { GAME_CONFIG_SETTING, getGameConfig } from "../../module/config/settings.mjs";
import { defaultGameConfig, traitSetById } from "../../module/rules/index.mjs";

// Ids from the ADR-036 defaults, which the batch stores as the world's configuration while it runs.
const PC_KIND = "cpKindPlayerChar";
const MOB_KIND = "cpKindMob0000000";
const DISTINCTIONS = "cpSetDistinction";
const ATTRIBUTES = "cpSetAttributes0";
const SKILLS = "cpSetSkills00000";
const MOB_TRAIT = "cpSetMobTrait000";
const PHYSICAL = "cpAttrPhysical00";
const SOCIAL = "cpAttrSocial0000";

const SYSTEM_ID = "cortex-prime";
const FLAG_KEY = "quenchCharacterSheet";

/** How long a test waits for a render or an update it caused. */
const WAIT_MS = 5000;

/** @returns {string} a new id in Foundry's 16-character format */
function newId() {
  return foundry.utils.randomID();
}

/** @returns {Actor[]} the actors this batch created, including ones left by an interrupted run */
function testActors() {
  return game.actors.filter(a => a.getFlag(SYSTEM_ID, FLAG_KEY));
}

/** Closes the sheets of this batch's actors and deletes the actors. */
async function cleanUp() {
  for ( const actor of testActors() ) {
    for ( const app of Object.values(actor.apps) ) await app.close();
  }
  const ids = testActors().map(a => a.id);
  if ( ids.length ) await Actor.implementation.deleteDocuments(ids);
}

/**
 * Creates a flagged test character.
 * @param {object} system
 * @param {string} [name]
 * @returns {Promise<Actor>}
 */
function createCharacter(system, name = "sheet") {
  return Actor.implementation.create({
    name: `[Quench] ${name}`, type: "character", system, flags: { [SYSTEM_ID]: { [FLAG_KEY]: true } }
  });
}

/** @returns {Promise<void>} stores a game configuration as the world's */
function storeConfig(config) {
  return game.settings.set(SYSTEM_ID, GAME_CONFIG_SETTING, config);
}

/** @returns {object} the stored system data of a character, as plain data */
function storedSystem(actor) {
  return JSON.parse(JSON.stringify(game.actors.get(actor.id).system.toObject()));
}

/**
 * Waits for the next render of a sheet that happens after this call, for renders the sheet
 * starts itself (after an update, a refusal or a configuration change).
 * @param {CharacterSheet} sheet
 * @returns {Promise<void>} rejects after WAIT_MS
 */
function nextRender(sheet) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      Hooks.off("renderCharacterSheet", id);
      reject(new Error("the sheet didn't render again"));
    }, WAIT_MS);
    const id = Hooks.on("renderCharacterSheet", app => {
      if ( app !== sheet ) return;
      clearTimeout(timer);
      Hooks.off("renderCharacterSheet", id);
      resolve();
    });
  });
}

/**
 * Waits for the next stored update of an actor.
 * @param {Actor} actor
 * @returns {Promise<object>} the update's changes; rejects after WAIT_MS
 */
function nextUpdate(actor) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      Hooks.off("updateActor", id);
      reject(new Error("the actor wasn't updated"));
    }, WAIT_MS);
    const id = Hooks.on("updateActor", (doc, changes) => {
      if ( doc.id !== actor.id ) return;
      clearTimeout(timer);
      Hooks.off("updateActor", id);
      resolve(changes);
    });
  });
}

/**
 * Runs something and collects the error notifications it shows instead of showing them.
 * @param {() => Promise<unknown>} run
 * @returns {Promise<string[]>}
 */
async function errorsShownBy(run) {
  const shown = [];
  const showError = ui.notifications.error;
  ui.notifications.error = message => shown.push(String(message));
  try {
    await run();
  }
  finally {
    ui.notifications.error = showError;
  }
  return shown;
}

/** @returns {Promise<CharacterSheet>} the actor's sheet, rendered */
async function openSheet(actor) {
  const sheet = actor.sheet;
  await sheet.render({ force: true });
  return sheet;
}

/** @returns {string[]} the set names a rendered sheet shows, in order */
function setNames(sheet) {
  return [...sheet.element.querySelectorAll("fieldset.cp-trait-set > legend")].map(el => el.textContent.trim());
}

/** @returns {HTMLSelectElement|null} the input of one die of a trait's rating */
function dieInput(sheet, setId, entryId, index) {
  return sheet.element.querySelector(`select[name="ratings.${setId}.${entryId}.${index}"]`);
}

/** @returns {HTMLElement|null} a trait's row, found by its label */
function traitRow(sheet, setId, label) {
  return [...sheet.element.querySelectorAll(`fieldset[data-set-id="${setId}"] .cp-trait`)]
    .find(row => row.querySelector("label")?.textContent.trim() === label) ?? null;
}

/**
 * A player character with Physical d8, a Social entry holding a challenged statement, an SFX and
 * a shut-down reason, an entry whose definition doesn't exist (TS-E03) and one distinction.
 * @returns {{system: object, physical: string, social: string, orphan: string, distinction: string}}
 */
function pcSystem() {
  const physical = newId();
  const social = newId();
  const orphan = newId();
  const distinction = newId();
  const system = {
    kindId: PC_KIND,
    traits: {
      [DISTINCTIONS]: { shutDown: false, sfx: [], entries: [
        { id: distinction, defId: null, name: "Cult Survivor", dice: [8], description: "Saw too much", sfx: [] }
      ] },
      [ATTRIBUTES]: { shutDown: false, sfx: [], entries: [
        { id: physical, defId: PHYSICAL, name: "Physical", dice: [8], sfx: [] },
        { id: orphan, defId: newId(), name: "Gone", dice: [6], sfx: [] },
        { id: social, defId: SOCIAL, name: "Social", dice: [6], statement: "I trust no one", challenged: true,
          preChallengeDice: [8], sfx: [{ text: "Hard to fool", unlocked: true }], shutDown: { reason: "manual" } }
      ] }
    }
  };
  return { system, physical, social, orphan, distinction };
}

/**
 * Register the batch with Quench.
 * @param {object} quench
 */
export function registerCharacterSheetBatch(quench) {
  quench.registerBatch(
    "cortex-prime.character-sheet",
    ({ describe, it, assert, before, after, afterEach }) => {
      let storedConfig;
      before(async () => {
        storedConfig = getGameConfig();
        await cleanUp();
        await storeConfig(defaultGameConfig());
      });
      after(async () => {
        if ( storedConfig ) await storeConfig(storedConfig);
      });
      afterEach(async () => {
        await cleanUp();
        await storeConfig(defaultGameConfig());
      });

      describe("registration", () => {
        it("is the default sheet of a character, built on ActorSheetV2", async () => {
          const actor = await createCharacter({ kindId: PC_KIND });
          assert.instanceOf(actor.sheet, CharacterSheet);
          assert.instanceOf(actor.sheet, foundry.applications.sheets.ActorSheetV2);
          assert.instanceOf(actor.sheet, foundry.applications.api.ApplicationV2);
        });
      });

      describe("trait sets from the game configuration", () => {
        it("shows the sets of the actor's kind, in the kind's order, by their configured names", async () => {
          const actor = await createCharacter(pcSystem().system);
          const sheet = await openSheet(actor);
          assert.deepEqual(setNames(sheet), ["Distinctions", "Attributes", "Skills"]);
        });

        it("shows a set the GM adds under a name of their own, and its new name after a rename, without a code change", async () => {
          const setId = newId();
          const kindId = newId();
          const entryId = newId();
          const first = `Quench Values ${newId()}`;
          const config = defaultGameConfig();
          config.traitSets.push({
            ...foundry.utils.deepClone(traitSetById(config, DISTINCTIONS)), id: setId, name: first, role: "other"
          });
          config.actorKinds.push({ id: kindId, name: "Quench kind", traitSetIds: [setId], freeTraits: false });
          await storeConfig(config);

          const actor = await createCharacter({ kindId, traits: { [setId]: { entries: [
            { id: entryId, defId: null, name: "Honesty", dice: [10], sfx: [] }
          ] } } });
          let sheet = await openSheet(actor);
          assert.deepEqual(setNames(sheet), [first]);
          assert.equal(dieInput(sheet, setId, entryId, 0)?.value, "10");
          assert.isNotNull(traitRow(sheet, setId, "Honesty"));

          const second = `Quench Virtues ${newId()}`;
          traitSetById(config, setId).name = second;
          await storeConfig(config);
          await sheet.close();
          sheet = await openSheet(actor);
          assert.deepEqual(setNames(sheet), [second]);
          assert.notInclude(sheet.element.textContent, first);
        });

        it("renders an open sheet again when the game configuration changes", async () => {
          const actor = await createCharacter(pcSystem().system);
          const sheet = await openSheet(actor);
          const config = defaultGameConfig();
          traitSetById(config, ATTRIBUTES).name = "Approaches";
          const rendered = nextRender(sheet);
          await storeConfig(config);
          await rendered;
          assert.deepEqual(setNames(sheet), ["Distinctions", "Approaches", "Skills"]);
        });

        it("shows a fixed set's trait the actor holds no entry for with its fallback die and no input", async () => {
          const actor = await createCharacter(pcSystem().system);
          const sheet = await openSheet(actor);
          const fight = traitRow(sheet, SKILLS, "Fight");
          assert.isNotNull(fight);
          assert.isNull(fight.querySelector("select"));
          assert.include(fight.textContent, "d4");
        });

        it("says when the character has no actor kind, and shows no sets", async () => {
          const actor = await createCharacter({});
          const sheet = await openSheet(actor);
          assert.deepEqual(setNames(sheet), []);
          assert.include(sheet.element.querySelector(".notification")?.textContent ?? "",
            game.i18n.localize("CORTEX.Sheet.NoKind"));
        });
      });

      describe("editing a rating", () => {
        it("saves an edited rating through Actor#update, and it is there when the sheet is opened again", async () => {
          const { system, physical, social, orphan } = pcSystem();
          const actor = await createCharacter(system);
          const before = storedSystem(actor);
          const sheet = await openSheet(actor);

          let sent = null;
          const hookId = Hooks.on("preUpdateActor", (doc, changes) => { if ( doc.id === actor.id ) sent = changes; });
          try {
            dieInput(sheet, ATTRIBUTES, physical, 0).value = "10";
            await sheet.submit();
          }
          finally {
            Hooks.off("preUpdateActor", hookId);
          }

          // The write went through Actor#update as a replacement of the set's entries (ADR-037 point 3).
          assert.isNotNull(sent, "Actor#update was not called");
          assert.deepEqual(Object.keys(sent.system.traits), [ATTRIBUTES]);

          // Only Physical's rating changed; the entry the sheet doesn't show and Social's other
          // fields are as they were, and so are the other sets.
          const after = storedSystem(actor);
          const expected = foundry.utils.deepClone(before);
          expected.traits[ATTRIBUTES].entries[0].dice = [10];
          assert.deepEqual(after, expected);
          assert.deepEqual(after.traits[ATTRIBUTES].entries.map(e => e.id), [physical, orphan, social]);

          await sheet.close();
          assert.isFalse(sheet.rendered);
          const reopened = await openSheet(actor);
          assert.equal(dieInput(reopened, ATTRIBUTES, physical, 0).value, "10");

          // A new sheet instance reads it from the actor too, not from the closed sheet.
          const fresh = new CharacterSheet({ document: actor });
          try {
            await fresh.render({ force: true });
            assert.equal(dieInput(fresh, ATTRIBUTES, physical, 0).value, "10");
          }
          finally {
            await fresh.close();
          }
        });

        it("saves as soon as a die input changes", async () => {
          const { system, physical } = pcSystem();
          const actor = await createCharacter(system);
          const sheet = await openSheet(actor);
          const updated = nextUpdate(actor);
          const input = dieInput(sheet, ATTRIBUTES, physical, 0);
          input.value = "6";
          input.dispatchEvent(new Event("change", { bubbles: true }));
          await updated;
          assert.deepEqual(storedSystem(actor).traits[ATTRIBUTES].entries[0].dice, [6]);
        });

        it("adds a die through a several-dice set's blank input, and removes one by blanking it", async () => {
          const entryId = newId();
          const actor = await createCharacter({ kindId: MOB_KIND, traits: { [MOB_TRAIT]: { entries: [
            { id: entryId, defId: null, name: "Thugs", dice: [6, 6], sfx: [] }
          ] } } });
          const sheet = await openSheet(actor);

          let rendered = nextRender(sheet);
          dieInput(sheet, MOB_TRAIT, entryId, 2).value = "6";
          await sheet.submit();
          await rendered;
          assert.deepEqual(storedSystem(actor).traits[MOB_TRAIT].entries[0].dice, [6, 6, 6]);
          assert.isNotNull(dieInput(sheet, MOB_TRAIT, entryId, 3), "a new blank input follows the dice");

          rendered = nextRender(sheet);
          dieInput(sheet, MOB_TRAIT, entryId, 0).value = "";
          await sheet.submit();
          await rendered;
          assert.deepEqual(storedSystem(actor).traits[MOB_TRAIT].entries[0].dice, [6, 6]);
        });

        it("refuses a rating its set doesn't allow before writing, shows why, and shows the stored rating again", async () => {
          const entryId = newId();
          const actor = await createCharacter({ kindId: MOB_KIND, traits: { [MOB_TRAIT]: { entries: [
            { id: entryId, defId: null, name: "Thugs", dice: [6, 6], sfx: [] }
          ] } } });
          const sheet = await openSheet(actor);

          // Actor#update not being called at all shows the sheet's own check refused it; the
          // model's backstop would only refuse inside the update.
          let updateCalled = false;
          const update = actor.update;
          actor.update = function(...args) {
            updateCalled = true;
            return update.apply(this, args);
          };
          const rendered = nextRender(sheet);
          let shown;
          try {
            dieInput(sheet, MOB_TRAIT, entryId, 1).value = "8";
            shown = await errorsShownBy(() => sheet.submit());
            await rendered;
          }
          finally {
            delete actor.update;
          }

          // The mob trait needs dice of one size (TS-E02).
          assert.deepEqual(shown, [game.i18n.localize("CORTEX.Character.Errors.RATING_MIXED_SIZES")]);
          assert.isFalse(updateCalled, "Actor#update was called");
          assert.deepEqual(storedSystem(actor).traits[MOB_TRAIT].entries[0].dice, [6, 6]);
          assert.equal(dieInput(sheet, MOB_TRAIT, entryId, 1).value, "6");
        });
      });
    },
    { displayName: "Cortex Prime: character sheet" }
  );
}
