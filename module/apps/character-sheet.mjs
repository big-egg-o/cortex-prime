/**
 * The character sheet (Roadmap M2): an ApplicationV2 actor sheet for the "character" actor type
 * (Decisions ADR-031). It shows the trait sets of the actor's kind as the game configuration
 * defines and names them (ADR-030), so a set the GM adds or renames shows without a code change,
 * and lets an owner edit the rating of a trait the actor holds. What is shown and how the inputs
 * become an update is decided by the pure module/apps/character-sheet-data.mjs.
 *
 * Saving goes through Actor#update, like any other edit. Before writing, the sheet runs the same
 * pure checkCharacterUpdate as the character model's backstop and shows a refusal's code instead
 * of writing (ADR-037 point 3), then renders again so the inputs show what is stored. The
 * backstop still runs on the update itself.
 *
 * Every trait that gives a die has buttons that fill the current user's dice pool (ADR-016,
 * ADR-049; Character Sheets behaviours 20 and 21, CS-D10): add it plainly, with Hinder where its
 * set offers Hinder, or as a challenged statement where its set offers statements and it has one.
 * Adding writes nothing to the actor, so a user who can see the sheet but not edit it can still
 * add its traits, such as a location's scene distinction (rule 12). A challenge is offered only to
 * users who can edit the actor, since its step-down is written after the roll (ADR-048).
 *
 * Not in this slice: adding or removing traits, free traits, statements, SFX, tags, sub-traits
 * and shut-down controls, and an edit or play mode.
 * @module apps/character-sheet
 */

import CharacterData from "../data/actor/character.mjs";
import { getGameConfig } from "../config/settings.mjs";
import { checkCharacterUpdate } from "../rules/traits.mjs";
import { RATING_INPUTS, characterSheetView, traitChangesFromInputs } from "./character-sheet-data.mjs";
import { addTraitToPool } from "./pool-builder.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

const TEMPLATE = "systems/cortex-prime/templates/actor/character-sheet.hbs";

/**
 * The sheet for "character" actors.
 * @extends {foundry.applications.sheets.ActorSheetV2}
 * @mixes HandlebarsApplicationMixin
 */
export default class CharacterSheet extends HandlebarsApplicationMixin(ActorSheetV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["cortex-prime", "character-sheet"],
    position: { width: 520, height: 640 },
    window: { resizable: true, contentClasses: ["standard-form"] },
    form: { submitOnChange: true },
    actions: {
      addToPool: CharacterSheet.#onAddToPool
    }
  };

  /** @override */
  static PARTS = {
    sheet: { template: TEMPLATE, scrollable: [".cp-sheet-body"] }
  };

  /**
   * Renders every open character sheet again, so a change to the game configuration (a set
   * renamed, added to a kind or given other options) shows at once.
   */
  static renderOpenSheets() {
    for ( const app of foundry.applications.instances.values() ) {
      if ( (app instanceof CharacterSheet) && app.rendered ) app.render();
    }
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const view = characterSheetView(this.actor.system.toObject(), getGameConfig());
    const i18n = game.i18n;
    const mayChallenge = this.actor.isOwner;
    const sets = view.sets.map(set => ({
      ...set,
      traits: set.traits.map(trait => ({
        ...trait,
        label: trait.name || i18n.localize("CORTEX.Sheet.Unnamed"),
        canChallenge: trait.canChallenge && mayChallenge,
        poolLabels: {
          add: i18n.format("CORTEX.Sheet.Pool.Add", { trait: trait.name }),
          hinder: i18n.format("CORTEX.Sheet.Pool.Hinder", { trait: trait.name }),
          challenge: i18n.format("CORTEX.Sheet.Pool.Challenge", { trait: trait.name })
        },
        ratingText: CharacterSheet.#ratingText(trait),
        hintTexts: trait.hints.map(code => i18n.localize(`CORTEX.Sheet.Hints.${code}`)),
        slots: trait.slots.map(slot => ({
          ...slot,
          ariaLabel: slot.adds
            ? i18n.format("CORTEX.Sheet.AddDie", { trait: trait.name })
            : i18n.format("CORTEX.Sheet.Die", { trait: trait.name, number: slot.index + 1 })
        }))
      }))
    }));
    return Object.assign(context, {
      actor: this.actor,
      kindName: view.kind?.name ?? null,
      notice: CharacterSheet.#notice(view),
      sets
    });
  }

  /**
   * Foundry disables every control of a sheet the user can't edit, each trait set's fieldset
   * included, which disables everything inside it. The pool buttons only fill the user's own pool,
   * so they are enabled again (ADR-049): the fieldsets are, and the buttons. The rating inputs keep
   * their own disabled state, so they stay read-only.
   * @override
   */
  async _onRender(context, options) {
    await super._onRender(context, options);
    if ( this.isEditable ) return;
    for ( const fieldset of this.element.querySelectorAll("fieldset.cp-trait-set") ) fieldset.disabled = false;
    for ( const button of this.element.querySelectorAll('button[data-action="addToPool"]') ) button.disabled = false;
  }

  /**
   * Adds the clicked trait to the user's pool: plainly, with Hinder or as a challenge, by the
   * button's `data-option`.
   * @this {CharacterSheet}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static async #onAddToPool(_event, target) {
    const setId = target.closest("[data-set-id]")?.dataset.setId;
    const traitId = target.closest("[data-pool-trait-id]")?.dataset.poolTraitId;
    if ( !setId || !traitId ) return;
    await addTraitToPool(this.actor, setId, traitId, target.dataset.option ?? null, { beside: this });
  }

  /**
   * What a trait row shows instead of inputs, or next to them for an empty rating.
   * @param {import("./character-sheet-data.mjs").SheetTrait} trait
   * @returns {string}
   */
  static #ratingText(trait) {
    const i18n = game.i18n;
    if ( trait.noDice ) return i18n.localize("CORTEX.Sheet.NoDice");
    if ( trait.fallbackDie !== null ) return i18n.format("CORTEX.Sheet.Fallback", { die: `d${trait.fallbackDie}` });
    if ( trait.unrated ) return i18n.localize("CORTEX.Sheet.Unrated");
    return trait.dice.map(size => `d${size}`).join(" ");
  }

  /**
   * The notice shown in place of trait sets, if any.
   * @param {import("./character-sheet-data.mjs").SheetView} view
   * @returns {string|null}
   */
  static #notice(view) {
    if ( view.kindStatus === "unassigned" ) return game.i18n.localize("CORTEX.Sheet.NoKind");
    if ( view.kindStatus === "unknown" ) return game.i18n.localize("CORTEX.Sheet.UnknownKind");
    if ( !view.sets.length ) return game.i18n.localize("CORTEX.Sheet.NoSets");
    return null;
  }

  /**
   * Turns the rating inputs into the trait changes of the update, from the data stored when the
   * form is submitted; the other inputs (name, portrait) are read as Foundry reads them. A rating
   * input that can't be read refuses the whole submit (thrown, so the form shows it as an error).
   * @override
   */
  _processFormData(event, form, formData) {
    const { [RATING_INPUTS]: inputs, ...data } = super._processFormData(event, form, formData);
    const traits = traitChangesFromInputs(this.actor.system.toObject(), inputs);
    if ( !traits.ok ) throw new Error(CharacterSheet.#refusalText(traits.code));
    if ( Object.keys(traits.value).length ) data.system = { traits: traits.value };
    return data;
  }

  /**
   * Checks the trait changes against the game configuration before writing (ADR-037 point 3),
   * the same check the character model's backstop runs. A refusal is shown, nothing is written,
   * and the sheet renders again so its inputs show the stored ratings.
   * @override
   */
  async _processSubmitData(event, form, submitData, options = {}) {
    if ( submitData.system ) {
      const checked = checkCharacterUpdate(this.actor.system.toObject(), submitData.system, getGameConfig(), {
        operatorOf: CharacterData.operatorOf, unlinkedToken: this.actor.isToken === true
      });
      if ( !checked.ok ) {
        ui.notifications.error(CharacterSheet.#refusalText(checked.code));
        this.render();
        return {};
      }
    }
    return super._processSubmitData(event, form, submitData, options);
  }

  /** @returns {string} the language string for a refusal code, or the code itself */
  static #refusalText(code) {
    const key = `CORTEX.Character.Errors.${code}`;
    return game.i18n.has(key) ? game.i18n.localize(key) : code;
  }
}
