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
const MINOR_GMC_KIND = "cpKindMinorGmc00";
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
 * Lets a render that an update has just started finish: Foundry renders a document's sheets
 * after the update hook, so a test that reads the sheet right after the hook waits for it.
 * @param {CharacterSheet} sheet
 * @returns {Promise<void>}
 */
async function nextRenderOrNow(sheet) {
  await Promise.race([nextRender(sheet).catch(() => {}), new Promise(resolve => setTimeout(resolve, 500))]);
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

        it("shows a fixed set's trait the actor holds no entry for with its fallback die and an input that creates the entry", async () => {
          const actor = await createCharacter(pcSystem().system);
          const sheet = await openSheet(actor);
          const fight = traitRow(sheet, SKILLS, "Fight");
          assert.isNotNull(fight);
          assert.include(fight.textContent, "d4");
          const input = fight.querySelector("select");
          assert.match(input.name, /^newRatings\./);
          assert.equal(input.value, "", "nothing is chosen until the user chooses");
        });

        it("says when the character has no actor kind, and shows no sets", async () => {
          const actor = await createCharacter({});
          const sheet = await openSheet(actor);
          assert.deepEqual(setNames(sheet), []);
          assert.include(sheet.element.querySelector(".notification")?.textContent ?? "",
            game.i18n.localize("CORTEX.Sheet.NoKind"));
        });
      });

      describe("trait management (behaviours 13 and 14, CS-D1, CS-D3)", () => {
        /** Turns the sheet's edit mode on or off through its header button. */
        async function toggleEdit(sheet) {
          const rendered = nextRender(sheet);
          sheet.element.querySelector('button[data-action="toggleEdit"]').click();
          await rendered;
        }

        it("CS-09 choosing a rating for a fixed-set trait without an entry creates the entry, kept after reopening", async () => {
          const { system } = pcSystem();
          const actor = await createCharacter(system);
          const sheet = await openSheet(actor);
          const mental = traitRow(sheet, ATTRIBUTES, "Mental").querySelector("select");
          const updated = nextUpdate(actor);
          mental.value = "10";
          mental.dispatchEvent(new Event("change", { bubbles: true }));
          await updated;

          const entries = storedSystem(actor).traits[ATTRIBUTES].entries;
          assert.lengthOf(entries, 4);
          const created = entries.at(-1);
          assert.deepInclude(created, { defId: "cpAttrMental0000", name: "Mental", dice: [10] });
          assert.match(created.id, /^[a-zA-Z0-9]{16}$/);

          await sheet.close();
          const reopened = await openSheet(actor);
          assert.equal(dieInput(reopened, ATTRIBUTES, created.id, 0).value, "10");
        });

        it("opens in play mode; the edit toggle shows name inputs, remove buttons and Add on open sets only", async () => {
          const actor = await createCharacter(pcSystem().system);
          const sheet = await openSheet(actor);
          const count = selector => sheet.element.querySelectorAll(selector).length;
          assert.equal(count("input.cp-trait-name") + count('[data-action="removeTrait"]') + count('[data-action="addTrait"]'), 0);

          await toggleEdit(sheet);
          assert.equal(count(`fieldset[data-set-id="${DISTINCTIONS}"] input.cp-trait-name`), 1);
          assert.equal(count(`fieldset[data-set-id="${DISTINCTIONS}"] [data-action="addTrait"]`), 1);
          assert.equal(count(`fieldset[data-set-id="${ATTRIBUTES}"] input.cp-trait-name`), 0, "a fixed set's traits aren't renamed");
          assert.equal(count(`fieldset[data-set-id="${ATTRIBUTES}"] [data-action="addTrait"]`), 0);

          await toggleEdit(sheet);
          assert.equal(count("input.cp-trait-name"), 0);
        });

        it("CS-10 adds a distinction at the set's starting rating, renames it and removes it", async () => {
          const { system, distinction } = pcSystem();
          const actor = await createCharacter(system);
          const sheet = await openSheet(actor);
          await toggleEdit(sheet);

          let updated = nextUpdate(actor);
          sheet.element.querySelector(`fieldset[data-set-id="${DISTINCTIONS}"] [data-action="addTrait"]`).click();
          await updated;
          let entries = storedSystem(actor).traits[DISTINCTIONS].entries;
          assert.lengthOf(entries, 2);
          const added = entries[1];
          assert.deepInclude(added, { defId: null, name: game.i18n.localize("CORTEX.Sheet.NewTrait"), dice: [8] });

          await nextRenderOrNow(sheet);
          const nameInput = sheet.element.querySelector(`input[name="names.${DISTINCTIONS}.${added.id}"]`);
          assert.isNotNull(nameInput, "edit mode stays on after the add");
          updated = nextUpdate(actor);
          nameInput.value = "Retired Smuggler";
          nameInput.dispatchEvent(new Event("change", { bubbles: true }));
          await updated;
          entries = storedSystem(actor).traits[DISTINCTIONS].entries;
          assert.deepEqual(entries.map(e => e.name), ["Cult Survivor", "Retired Smuggler"]);
          assert.equal(entries[0].description, "Saw too much", "the other entry is untouched");

          assert.isTrue(await sheet.removeTrait(DISTINCTIONS, distinction));
          assert.deepEqual(storedSystem(actor).traits[DISTINCTIONS].entries.map(e => e.id), [added.id]);
          assert.isTrue(await sheet.removeTrait(DISTINCTIONS, added.id));
          assert.deepEqual(storedSystem(actor).traits[DISTINCTIONS], { shutDown: false, sfx: [], entries: [] },
            "an emptied set keeps its key (ADR-044)");
        });

        it("CS-D3 a character without a kind offers the choice in play mode; choosing one shows its sets", async () => {
          const actor = await createCharacter({});
          const sheet = await openSheet(actor);
          const select = sheet.element.querySelector('select[name="system.kindId"]');
          assert.isNotNull(select);
          assert.equal(select.value, "");
          const updated = nextUpdate(actor);
          select.value = PC_KIND;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          await updated;
          assert.equal(storedSystem(actor).kindId, PC_KIND);
          await nextRenderOrNow(sheet);
          assert.deepEqual(setNames(sheet), ["Distinctions", "Attributes", "Skills"]);
          assert.isNull(sheet.element.querySelector('select[name="system.kindId"]'), "a set kind isn't offered in play mode");
        });

        it("CS-D3 a GM changes a set kind in edit mode, and the stored traits are kept (CS-E02)", async () => {
          const { system } = pcSystem();
          const actor = await createCharacter(system);
          const before = storedSystem(actor).traits;
          const sheet = await openSheet(actor);
          await toggleEdit(sheet);
          const select = sheet.element.querySelector('select[name="system.kindId"]');
          assert.equal(select.value, PC_KIND);
          const updated = nextUpdate(actor);
          select.value = MOB_KIND;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          await updated;
          assert.equal(storedSystem(actor).kindId, MOB_KIND);
          assert.deepEqual(storedSystem(actor).traits, before);
        });

        it("keeps a kind the configuration doesn't have when another field is submitted in edit mode", async () => {
          const unknown = newId();
          const actor = await createCharacter({ kindId: unknown });
          const sheet = await openSheet(actor);
          await toggleEdit(sheet);
          assert.equal(sheet.element.querySelector('select[name="system.kindId"]').value, unknown);
          const updated = nextUpdate(actor);
          const name = sheet.element.querySelector('input[name="name"]');
          name.value = "[Quench] renamed";
          name.dispatchEvent(new Event("change", { bubbles: true }));
          await updated;
          assert.equal(storedSystem(actor).kindId, unknown);
        });
      });

      describe("free traits and other stored traits (behaviours 9 and 10, CS-D5)", () => {
        /** Turns the sheet's edit mode on or off through its header button. */
        async function toggleEdit(sheet) {
          const rendered = nextRender(sheet);
          sheet.element.querySelector('button[data-action="toggleEdit"]').click();
          await rendered;
        }

        /** Clicks a remove button and answers the confirmation that follows. */
        async function clickRemove(button, answer) {
          button.click();
          const started = Date.now();
          let dialog = null;
          while ( !dialog && ((Date.now() - started) < WAIT_MS) ) {
            await new Promise(resolve => setTimeout(resolve, 50));
            dialog = [...foundry.applications.instances.values()]
              .find(app => (app instanceof foundry.applications.api.DialogV2) && app.rendered) ?? null;
          }
          assert.isNotNull(dialog, "the remove button asks first");
          dialog.element.querySelector(`button[data-action="${answer}"]`).click();
        }

        const freeSection = sheet => sheet.element.querySelector("fieldset[data-free-traits]");

        it("CS-11 a minor GMC gets a free-traits section: add, name, rate, kept after reopening, remove", async () => {
          const actor = await createCharacter({ kindId: MINOR_GMC_KIND });
          const sheet = await openSheet(actor);
          assert.deepEqual(setNames(sheet), [game.i18n.localize("CORTEX.Sheet.FreeTraits")], "no set section (TS-22)");
          assert.isNull(sheet.element.querySelector(".notification"), "a kind with only free traits shows no notice");
          assert.isNull(freeSection(sheet).querySelector('[data-action="addTrait"]'), "adding is for edit mode");

          await toggleEdit(sheet);
          let updated = nextUpdate(actor);
          freeSection(sheet).querySelector('[data-action="addTrait"]').click();
          await updated;
          const free = storedSystem(actor).freeTraits;
          assert.lengthOf(free, 1);
          const id = free[0].id;
          assert.deepEqual(free[0], { id, name: game.i18n.localize("CORTEX.Sheet.NewTrait"), dice: [] });

          await nextRenderOrNow(sheet);
          updated = nextUpdate(actor);
          const nameInput = sheet.element.querySelector(`input[name="freeNames.${id}"]`);
          nameInput.value = "Crooked Deputy";
          nameInput.dispatchEvent(new Event("change", { bubbles: true }));
          await updated;
          await nextRenderOrNow(sheet);
          assert.isNull(freeSection(sheet).querySelector('button[data-action="addToPool"]'), "an unrated trait gives no die");

          updated = nextUpdate(actor);
          const die = sheet.element.querySelector(`select[name="freeRatings.${id}.0"]`);
          die.value = "8";
          die.dispatchEvent(new Event("change", { bubbles: true }));
          await updated;
          assert.deepEqual(storedSystem(actor).freeTraits, [{ id, name: "Crooked Deputy", dice: [8] }]);

          await sheet.close();
          const reopened = await openSheet(actor);
          assert.equal(reopened.element.querySelector(`select[name="freeRatings.${id}.0"]`).value, "8");
          assert.include(freeSection(reopened).textContent, "Crooked Deputy");
          assert.isNotNull(freeSection(reopened).querySelector(`[data-pool-trait-id="${id}"] button[data-action="addToPool"]`));

          // The remove button asks first: "no" keeps the trait, "yes" removes it.
          await toggleEdit(reopened);
          await clickRemove(freeSection(reopened).querySelector('[data-action="removeTrait"]'), "no");
          await new Promise(resolve => setTimeout(resolve, 200));
          assert.lengthOf(storedSystem(actor).freeTraits, 1);
          updated = nextUpdate(actor);
          await clickRemove(freeSection(reopened).querySelector('[data-action="removeTrait"]'), "yes");
          await updated;
          assert.deepEqual(storedSystem(actor).freeTraits, []);
        });

        it("a kind without free traits has no free-traits section", async () => {
          const sheet = await openSheet(await createCharacter(pcSystem().system));
          assert.isNull(freeSection(sheet));
        });

        it("CS-D5 edit mode lists the stored traits no section shows; each is removed only by hand", async () => {
          const { system, orphan, physical, social } = pcSystem();
          const thugs = newId();
          const leftOver = newId();
          system.traits[MOB_TRAIT] = { entries: [{ id: thugs, defId: null, name: "Thugs", dice: [6, 6], sfx: [] }] };
          system.freeTraits = [{ id: leftOver, name: "Left over", dice: [6] }];
          const actor = await createCharacter(system);
          const sheet = await openSheet(actor);
          const others = () => sheet.element.querySelector("fieldset.cp-other-traits");
          assert.isNull(others(), "play mode doesn't list them");
          assert.isNull(freeSection(sheet));

          await toggleEdit(sheet);
          const groups = () => [...others().querySelectorAll(".cp-other-group")].map(group => ({
            setId: group.dataset.setId ?? null,
            free: "freeTraits" in group.dataset,
            title: group.querySelector("h4").textContent.trim(),
            traits: [...group.querySelectorAll(".cp-trait")].map(row => row.dataset.entryId)
          }));
          const mobName = traitSetById(getGameConfig(), MOB_TRAIT).name;
          assert.deepEqual(groups(), [
            { setId: ATTRIBUTES, free: false, title: game.i18n.format("CORTEX.Sheet.Others.noDefinition", { set: "Attributes" }), traits: [orphan] },
            { setId: MOB_TRAIT, free: false, title: game.i18n.format("CORTEX.Sheet.Others.notInKind", { set: mobName }), traits: [thugs] },
            { setId: null, free: true, title: game.i18n.localize("CORTEX.Sheet.Others.freeTraits"), traits: [leftOver] }
          ]);
          assert.include(others().textContent, "Gone");
          assert.include(others().textContent, "d6 d6");

          // An unrelated edit keeps all of them (ADR-051: nothing is removed automatically).
          let updated = nextUpdate(actor);
          dieInput(sheet, ATTRIBUTES, physical, 0).value = "10";
          dieInput(sheet, ATTRIBUTES, physical, 0).dispatchEvent(new Event("change", { bubbles: true }));
          await updated;
          let stored = storedSystem(actor);
          assert.deepEqual(stored.traits[ATTRIBUTES].entries.map(e => e.id), [physical, orphan, social]);
          assert.lengthOf(stored.traits[MOB_TRAIT].entries, 1);
          assert.lengthOf(stored.freeTraits, 1);
          await nextRenderOrNow(sheet);

          // Removing through the list's button, after its confirmation.
          updated = nextUpdate(actor);
          await clickRemove(others().querySelector(`[data-entry-id="${orphan}"] [data-action="removeTrait"]`), "yes");
          await updated;
          assert.deepEqual(storedSystem(actor).traits[ATTRIBUTES].entries.map(e => e.id), [physical, social]);

          assert.isTrue(await sheet.removeTrait(MOB_TRAIT, thugs));
          assert.deepEqual(storedSystem(actor).traits[MOB_TRAIT].entries, [], "the set keeps its key, emptied (ADR-044)");
          assert.isTrue(await sheet.removeFreeTrait(leftOver));
          stored = storedSystem(actor);
          assert.deepEqual(stored.freeTraits, []);
          await nextRenderOrNow(sheet);
          assert.isNull(others(), "nothing is left to list");
        });

        it("lists a character's stored traits when it has no kind", async () => {
          const { system, distinction } = pcSystem();
          const actor = await createCharacter({ ...system, kindId: null });
          const sheet = await openSheet(actor);
          await toggleEdit(sheet);
          const rows = sheet.element.querySelectorAll("fieldset.cp-other-traits .cp-trait");
          assert.lengthOf(rows, 4);
          assert.isNotNull(sheet.element.querySelector(`fieldset.cp-other-traits [data-entry-id="${distinction}"]`));
        });
      });

      describe("statements and shut-down flags (behaviours 8, 15 and 17)", () => {
        /** Turns the sheet's edit mode on or off through its header button. */
        async function toggleEdit(sheet) {
          const rendered = nextRender(sheet);
          sheet.element.querySelector('button[data-action="toggleEdit"]').click();
          await rendered;
        }

        /** Stores the defaults with statements turned on for Attributes. */
        async function withStatements() {
          const config = defaultGameConfig();
          traitSetById(config, ATTRIBUTES).features.statements = true;
          await storeConfig(config);
        }

        const row = (sheet, entryId) => sheet.element.querySelector(`fieldset[data-set-id="${ATTRIBUTES}"] [data-entry-id="${entryId}"]`);
        const socialOf = actor => storedSystem(actor).traits[ATTRIBUTES].entries.find(e => e.defId === SOCIAL);

        it("CS-14 shows a challenged statement in play mode and resolves it as rewritten", async () => {
          await withStatements();
          const { system, social } = pcSystem();
          const actor = await createCharacter(system);
          const sheet = await openSheet(actor);
          const socialRow = row(sheet, social);
          assert.equal(socialRow.querySelector(".cp-statement")?.textContent.trim(), "I trust no one");
          assert.isNull(socialRow.querySelector("input.cp-statement-input"), "the text is edited in edit mode");
          assert.include(socialRow.querySelector(".cp-challenged").textContent, game.i18n.localize("CORTEX.Sheet.Statement.Challenged"));
          assert.include(socialRow.textContent, game.i18n.localize("CORTEX.Sheet.ShutDown.manual"), "the shut-down shows its reason");

          const updated = nextUpdate(actor);
          socialRow.querySelector('[data-action="resolveChallenge"][data-rewritten="true"]').click();
          await updated;
          const stored = socialOf(actor);
          assert.deepEqual(stored.dice, [8], "the rating from before the challenge comes back");
          assert.notProperty(stored, "challenged");
          assert.notProperty(stored, "preChallengeDice");
          assert.deepEqual(stored.shutDown, { reason: "manual" }, "a shut-down set by hand stays");
          await nextRenderOrNow(sheet);
          assert.isNull(row(sheet, social).querySelector(".cp-challenged"));
        });

        it("resolves a challenge as kept, and the lowered rating stays", async () => {
          await withStatements();
          const { system, social } = pcSystem();
          const actor = await createCharacter(system);
          const sheet = await openSheet(actor);
          assert.isTrue(await sheet.resolveChallenge(ATTRIBUTES, social, false));
          assert.deepEqual(socialOf(actor).dice, [6]);
          assert.notProperty(socialOf(actor), "challenged");
        });

        it("shows a challenge but no statement where the set has no statements", async () => {
          const { system, social } = pcSystem();
          const sheet = await openSheet(await createCharacter(system));
          assert.isNull(row(sheet, social).querySelector(".cp-statement"));
          assert.isNotNull(row(sheet, social).querySelector(".cp-challenged"), "an open challenge is never hidden");
        });

        it("edits a statement's text in edit mode and keeps the challenge (TS-15c)", async () => {
          await withStatements();
          const { system, social, physical } = pcSystem();
          const actor = await createCharacter(system);
          const sheet = await openSheet(actor);
          await toggleEdit(sheet);
          assert.isNotNull(row(sheet, physical).querySelector("input.cp-statement-input"), "a trait without one can get one");
          const input = row(sheet, social).querySelector("input.cp-statement-input");
          const updated = nextUpdate(actor);
          input.value = "  I trust my crew ";
          input.dispatchEvent(new Event("change", { bubbles: true }));
          await updated;
          const stored = socialOf(actor);
          assert.equal(stored.statement, "I trust my crew");
          assert.isTrue(stored.challenged);
          assert.deepEqual(stored.preChallengeDice, [8]);
        });

        it("sets and clears a trait's and a set's shut-down in edit mode, kept after reopening", async () => {
          const { system, social, physical } = pcSystem();
          const actor = await createCharacter(system);
          const sheet = await openSheet(actor);
          assert.isNull(sheet.element.querySelector('[data-action="toggleShutDown"]'), "play mode has no shut-down toggles");
          await toggleEdit(sheet);

          let updated = nextUpdate(actor);
          row(sheet, physical).querySelector('[data-action="toggleShutDown"]').click();
          await updated;
          const physicalOf = () => storedSystem(actor).traits[ATTRIBUTES].entries.find(e => e.id === physical);
          assert.deepEqual(physicalOf().shutDown, { reason: "manual" });

          await nextRenderOrNow(sheet);
          updated = nextUpdate(actor);
          row(sheet, social).querySelector('[data-action="toggleShutDown"]').click();
          await updated;
          assert.notProperty(socialOf(actor), "shutDown");
          assert.isTrue(socialOf(actor).challenged, "clearing the flag leaves the challenge open");

          await nextRenderOrNow(sheet);
          updated = nextUpdate(actor);
          sheet.element.querySelector(`fieldset[data-set-id="${SKILLS}"] [data-action="toggleSetShutDown"]`).click();
          await updated;
          assert.deepEqual(storedSystem(actor).traits[SKILLS], { shutDown: true, sfx: [], entries: [] },
            "a set the actor held nothing in gets its flag and an empty list");

          await sheet.close();
          const reopened = await openSheet(actor);
          assert.isTrue(reopened.element.querySelector(`fieldset[data-set-id="${SKILLS}"]`).classList.contains("cp-shut-down"));
          assert.isTrue(row(reopened, physical).classList.contains("cp-shut-down"));
          assert.isTrue(await reopened.setSetShutDown(SKILLS, false));
          assert.isFalse(storedSystem(actor).traits[SKILLS].shutDown);
        });

        it("clears a shut-down a challenged d4 left (RQ-034)", async () => {
          const entryId = newId();
          const actor = await createCharacter({ kindId: PC_KIND, traits: { [ATTRIBUTES]: { entries: [
            { id: entryId, defId: SOCIAL, name: "Social", dice: [4], statement: "I trust no one", challenged: true,
              preChallengeDice: [4], sfx: [], shutDown: { reason: "statementChallenged" } }
          ] } } });
          const sheet = await openSheet(actor);
          assert.include(row(sheet, entryId).textContent, game.i18n.localize("CORTEX.Sheet.ShutDown.statementChallenged"));
          assert.isTrue(await sheet.setShutDown(ATTRIBUTES, entryId, false));
          assert.notProperty(socialOf(actor), "shutDown");
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
