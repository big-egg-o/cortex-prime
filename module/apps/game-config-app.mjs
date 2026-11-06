/**
 * The GM's configuration app (Decisions ADR-030): edits a draft of the game configuration and
 * saves it to the world setting. Opened from the system's settings menu; only a GM can save,
 * because only a GM may write a world setting. Every edit goes through the pure helpers in
 * module/config/game-config-draft.mjs, and saving through setGameConfig, which runs the pure
 * validateGameConfig and shows every problem next to its field instead of saving.
 * @module apps/game-config-app
 */

import {
  addActorKind, addTraitDef, addTraitSet, applyConfigForm, deleteActorKind, deleteTraitDef, deleteTraitSet,
  errorsByPath, moveTraitDef, moveTraitSet
} from "../config/game-config-draft.mjs";
import { getGameConfig, setGameConfig } from "../config/settings.mjs";
import {
  DIE_SIZES, EXTRA_TRAIT_RULES, TRAIT_SET_FEATURES, TRAIT_SET_LISTS, TRAIT_SET_ROLES, defaultGameConfig,
  validateGameConfig
} from "../rules/index.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TEMPLATE = "systems/cortex-prime/templates/apps/game-config.hbs";

/**
 * The configuration app. The draft lives in the app until Save; every form change is read into
 * it (submitOnChange), so re-rendering after an add or remove keeps what the GM typed.
 * @extends {foundry.applications.api.ApplicationV2}
 * @mixes HandlebarsApplicationMixin
 */
export default class GameConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: "cortex-prime-game-config",
    tag: "form",
    classes: ["cortex-prime", "game-config"],
    window: { title: "CORTEX.Config.Title", icon: "fa-solid fa-sliders", contentClasses: ["standard-form"], resizable: true },
    position: { width: 640, height: 720 },
    form: { handler: GameConfigApp.#onChangeForm, submitOnChange: true, closeOnSubmit: false },
    actions: {
      addSet: GameConfigApp.#onAddSet,
      deleteSet: GameConfigApp.#onDeleteSet,
      moveSet: GameConfigApp.#onMoveSet,
      addTrait: GameConfigApp.#onAddTrait,
      deleteTrait: GameConfigApp.#onDeleteTrait,
      moveTrait: GameConfigApp.#onMoveTrait,
      addKind: GameConfigApp.#onAddKind,
      deleteKind: GameConfigApp.#onDeleteKind,
      resetDefaults: GameConfigApp.#onResetDefaults,
      save: GameConfigApp.#onSave
    }
  };

  /** @override */
  static PARTS = {
    body: { template: TEMPLATE, scrollable: [""] },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** The draft being edited; read from the world setting when the app opens. */
  #draft = getGameConfig();

  /** The problems of the last save attempt, by field path. */
  #errors = {};

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const draft = this.#draft;
    const errors = this.#errors;
    const sizes = DIE_SIZES.map(size => ({ value: size, label: `d${size}` }));
    context.buttons = [
      { type: "button", action: "resetDefaults", icon: "fa-solid fa-rotate-left", label: "CORTEX.Config.ResetDefaults" },
      { type: "button", action: "save", icon: "fa-solid fa-floppy-disk", label: "CORTEX.Config.Save",
        disabled: !game.user.isGM }
    ];
    context.roles = TRAIT_SET_ROLES.map(value => ({ value, label: `CORTEX.Config.Role.${value}` }));
    context.lists = TRAIT_SET_LISTS.map(value => ({ value, label: `CORTEX.Config.List.${value}` }));
    context.extraTraitRules = EXTRA_TRAIT_RULES.map(value => ({ value, label: `CORTEX.Config.ExtraTraits.${value}` }));
    context.generalErrors = errors.traitSets ?? [];
    context.sets = draft.traitSets.map((set, i) => ({
      ...set,
      index: i,
      path: `traitSets.${i}`,
      fixed: set.list === "fixed",
      sizes: sizes.map(s => ({ ...s, min: s.value === set.usualMin, max: s.value === set.usualMax, start: s.value === set.startingRating })),
      fallbackD4: set.fallbackDie === 4,
      features: TRAIT_SET_FEATURES.map(feature => ({ key: feature, on: set.features?.[feature] === true,
        label: `CORTEX.Config.Feature.${feature}` })),
      traits: (set.traits ?? []).map((def, j) => ({ ...def, index: j, path: `traitSets.${i}.traits.${j}`,
        errors: [...(errors[`traitSets.${i}.traits.${j}.name`] ?? []), ...(errors[`traitSets.${i}.traits.${j}`] ?? [])] })),
      errors: Object.entries(errors).filter(([path]) => (path === `traitSets.${i}`) || path.startsWith(`traitSets.${i}.`))
        .filter(([path]) => !path.startsWith(`traitSets.${i}.traits.`)).flatMap(([, codes]) => codes)
    }));
    context.kinds = draft.actorKinds.map((kind, i) => ({
      ...kind,
      index: i,
      path: `actorKinds.${i}`,
      sets: draft.traitSets.map(set => ({ id: set.id, name: set.name, on: kind.traitSetIds.includes(set.id) })),
      errors: Object.entries(errors).filter(([path]) => path.startsWith(`actorKinds.${i}`)).flatMap(([, codes]) => codes)
    }));
    return context;
  }

  /**
   * Reads every form change into the draft; nothing is saved until Save.
   * @this {GameConfigApp}
   * @param {SubmitEvent|Event} _event
   * @param {HTMLFormElement} _form
   * @param {foundry.applications.ux.FormDataExtended} formData
   */
  static async #onChangeForm(_event, _form, formData) {
    this.#draft = applyConfigForm(this.#draft, foundry.utils.expandObject(formData.object));
  }

  /** @returns {string} the trait set id of the clicked row */
  static #setIdOf(target) {
    return target.closest("[data-set-id]")?.dataset.setId;
  }

  /** @this {GameConfigApp} */
  static #onAddSet() {
    this.#draft = addTraitSet(this.#draft, foundry.utils.randomID(), game.i18n.localize("CORTEX.Config.NewSet"));
    this.render();
  }

  /** @this {GameConfigApp} */
  static #onDeleteSet(_event, target) {
    this.#draft = deleteTraitSet(this.#draft, GameConfigApp.#setIdOf(target));
    this.render();
  }

  /** @this {GameConfigApp} */
  static #onMoveSet(_event, target) {
    this.#draft = moveTraitSet(this.#draft, GameConfigApp.#setIdOf(target), Number(target.dataset.delta));
    this.render();
  }

  /** @this {GameConfigApp} */
  static #onAddTrait(_event, target) {
    this.#draft = addTraitDef(this.#draft, GameConfigApp.#setIdOf(target), foundry.utils.randomID(),
      game.i18n.localize("CORTEX.Config.NewTrait"));
    this.render();
  }

  /** @this {GameConfigApp} */
  static #onDeleteTrait(_event, target) {
    this.#draft = deleteTraitDef(this.#draft, GameConfigApp.#setIdOf(target), target.closest("[data-trait-id]")?.dataset.traitId);
    this.render();
  }

  /** @this {GameConfigApp} */
  static #onMoveTrait(_event, target) {
    this.#draft = moveTraitDef(this.#draft, GameConfigApp.#setIdOf(target), target.closest("[data-trait-id]")?.dataset.traitId,
      Number(target.dataset.delta));
    this.render();
  }

  /** @this {GameConfigApp} */
  static #onAddKind() {
    this.#draft = addActorKind(this.#draft, foundry.utils.randomID(), game.i18n.localize("CORTEX.Config.NewKind"));
    this.render();
  }

  /** @this {GameConfigApp} */
  static #onDeleteKind(_event, target) {
    this.#draft = deleteActorKind(this.#draft, target.closest("[data-kind-id]")?.dataset.kindId);
    this.render();
  }

  /** @this {GameConfigApp} */
  static async #onResetDefaults() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "CORTEX.Config.ResetTitle" }, content: `<p>${game.i18n.localize("CORTEX.Config.ResetConfirm")}</p>`
    });
    if ( !confirmed ) return;
    this.#draft = defaultGameConfig();
    this.#errors = {};
    this.render();
  }

  /**
   * Saves the draft when the pure check passes; otherwise shows every problem next to its field.
   * Actors are never rewritten by a configuration change (ADR-037 point 5).
   * @this {GameConfigApp}
   */
  static async #onSave() {
    if ( !game.user.isGM ) return;
    const checked = validateGameConfig(this.#draft);
    if ( !checked.ok ) {
      this.#errors = errorsByPath(checked.errors);
      ui.notifications.warn("CORTEX.Config.NotSaved", { localize: true });
      this.render();
      return;
    }
    const result = await setGameConfig(this.#draft);
    this.#errors = result.ok ? {} : errorsByPath(result.errors);
    if ( result.ok ) {
      this.#draft = result.value;
      ui.notifications.info("CORTEX.Config.Saved", { localize: true });
    }
    this.render();
  }
}
