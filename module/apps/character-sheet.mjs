/**
 * ApplicationV2 sheets for native PCs, modular GMCs and classic characters (ADR-055).
 * Native sheets share the user's pool footer and put rating inputs in Edit sheet. Classic
 * characters retain the M2 behavior described below and can be copied into either native type.
 * The classic sheet shows the trait sets of the actor's kind as the game configuration
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
 * set offers Hinder, as a challenged statement where its set offers statements and it has one, or
 * with both where both apply (RQ-032, CS-D14).
 * Adding writes nothing to the actor, so a user who can see the sheet but not edit it can still
 * add its traits, such as a location's scene distinction (rule 12). A challenge is offered only to
 * users who can edit the actor, since its step-down is written after the roll (ADR-048).
 *
 * The sheet opens in play mode. Its edit toggle, for users who can edit the actor, adds what
 * changes the character's structure (Character Sheets CS-D1): renaming, adding and removing the
 * traits of open sets, and, for a GM, changing the actor kind. A character without a kind, or one
 * that stores no traits yet, offers the choice to anyone who can edit it, in either mode (CS-D3),
 * so a wrong first choice doesn't need the GM. A fixed set's trait the actor
 * holds no entry for gets an entry when a rating is chosen for it (behaviour 13).
 *
 * A kind with free traits gets a section for them after its sets: name and dice, in no set
 * (behaviour 9, TS-22). Edit mode also lists what the character stores that no section shows
 * (entries no definition matches, sets outside the kind, free traits of a kind without them)
 * under "Other stored traits", each with a remove button that asks first; nothing is ever removed
 * automatically (CS-D5, ADR-051).
 *
 * Where a set has the statements feature, a trait row shows its statement, editable in edit mode;
 * editing it never resolves a challenge (behaviour 15, TS-15c). A challenged statement is marked
 * on the row whatever the set's features say, and a user who can edit the actor resolves it as
 * rewritten or kept, in either mode (rule 16; RQ-021, RQ-022). A shut-down trait shows its reason
 * (RQ-034). In either mode, like a rating, a user who can edit the actor sets a set's and a
 * trait's shut-down flags where the set has the shut-down feature and clears them whatever their
 * reason, since shutting down and restoring happen in play (behaviour 17, rule 15, CS-D16).
 *
 * The rest of a row follows its set's features (behaviours 8 and 16, rule 13): a description, SFX
 * with their locked or unlocked state, tags and sub-traits, and, under the set's name, the set's own
 * SFX. Play mode shows them; edit mode edits, adds and removes them (CS-D1), a new SFX starting
 * unlocked (CS-D6), and asks before removing one. Sub-traits are shown and edited only: how they go
 * into a pool is mod behaviour (Roadmap M5).
 *
 * A user with limited permission on the actor sees its name and portrait only (CS-D4): the sheet
 * prepares nothing else for them, so no trait reaches the page. An observer sees the whole sheet
 * read-only, with its pool buttons.
 * @module apps/character-sheet
 */

import { changePlotPoints } from "../plot-points/accounts.mjs";
import CharacterData from "../data/actor/character.mjs";
import { getGameConfig } from "../config/settings.mjs";
import { actorLayout, addGmcBlock, blocksFromCharacter, DEFAULT_MOB_SET, GMC_BLOCKS } from "../rules/actor-layout.mjs";
import { checkCharacterUpdate } from "../rules/traits.mjs";
import {
  DESCRIPTION_INPUTS, FREE_NAME_INPUTS, FREE_RATING_INPUTS, NAME_INPUTS, NEW_RATING_INPUTS, RATING_INPUTS, SET_SFX_INPUTS,
  SFX_INPUTS, STATEMENT_INPUTS, SUB_NAME_INPUTS, SUB_RATING_INPUTS, TAG_INPUTS, addFreeTrait, addSetSfx, addSubTrait,
  addTraitEntry, addTraitSfx, characterSheetView, freeTraitChanges, removeFreeTrait, removeSetSfx, removeSubTrait,
  removeTraitEntry, removeTraitSfx, resolveTraitChallenge, setShutDownChange, setTraitShutDown, sheetTraitChanges,
  sfxFromInputs, sfxRows, storesNoTraits
} from "./character-sheet-data.mjs";
import { addTraitToPool, openPoolBuilder, removePoolDie, rollSheetPool, sheetPoolContext } from "./pool-builder.mjs";
import ActorTraitsApp from "./actor-traits-app.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

const TEMPLATE = "systems/cortex-prime/templates/actor/character-sheet.hbs";

/** The list of SFX, a partial the sheet uses for a trait's SFX and a set's own. */
const SFX_LIST = "systems/cortex-prime/templates/actor/sfx-list.hbs";

/**
 * Character sheets share form processing, permission checks and trait actions.
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
      rollSheetPool(_event, target) { return rollSheetPool(target.dataset.targetKey); },
      reviewPool() { return openPoolBuilder({ beside: this }); },
      removePoolDie(_event, target) { return removePoolDie(target.dataset.dieId); },
      addBlock: CharacterSheet.#onAddBlock,
      hideBlock: CharacterSheet.#onHideBlock,
      loseDie: CharacterSheet.#onLoseDie,
      addGmcSfx: CharacterSheet.#onAddGmcSfx,
      removeGmcSfx: CharacterSheet.#onRemoveGmcSfx,
      copyPc() { return this.copyAs("pc"); },
      copyGmc() { return this.copyAs("gmc"); },
      addToPool: CharacterSheet.#onAddToPool,
      toggleEdit: CharacterSheet.#onToggleEdit,
      addTrait: CharacterSheet.#onAddTrait,
      removeTrait: CharacterSheet.#onRemoveTrait,
      resolveChallenge: CharacterSheet.#onResolveChallenge,
      toggleShutDown: CharacterSheet.#onToggleShutDown,
      toggleSetShutDown: CharacterSheet.#onToggleSetShutDown,
      addSfx: CharacterSheet.#onAddSfx,
      removeSfx: CharacterSheet.#onRemoveSfx,
      addSetSfx: CharacterSheet.#onAddSetSfx,
      removeSetSfx: CharacterSheet.#onRemoveSetSfx,
      addSubTrait: CharacterSheet.#onAddSubTrait,
      removeSubTrait: CharacterSheet.#onRemoveSubTrait,
      viewTraits() { return ActorTraitsApp.open(this.actor); },
      ppGain() { return this.#changePlotPoints(1); },
      ppSpend() { return this.#changePlotPoints(-1); }
    }
  };

  /**
   * Records a gain or spend of this PC's plot points by hand (P3, P9, P15): a GM's gain is an award
   * and a GM's spend an adjustment; a player records an SFX gain or spend, the case the spec leaves
   * to the player (rule 7, rule 14). Refusals are shown, never thrown.
   * @param {1|-1} delta
   * @returns {Promise<void>}
   */
  async #changePlotPoints(delta) {
    const reason = game.user.isGM ? ((delta > 0) ? "AWARD" : "GM_ADJUST") : ((delta > 0) ? "SFX_GAIN" : "SFX_SPEND");
    const result = await changePlotPoints({ account: { kind: "actor", actorId: this.actor.id }, delta, reason });
    if ( result.ok ) return;
    const key = `CORTEX.PlotPoints.Errors.${result.code}`;
    ui.notifications.warn(game.i18n.has(key) ? game.i18n.localize(key) : result.code);
  }

  /** Whether the sheet shows its edit controls; it opens in play mode (CS-D1). */
  #editMode = false;

  /** @returns {boolean} whether the edit controls show: edit mode, for a user who can edit the actor */
  get editMode() {
    return this.#editMode && this.isEditable;
  }

  /**
   * A sheet opened by a user with limited permission shows only a name and a portrait (CS-D4),
   * so its window fits that content instead of the full sheet's height.
   * @override
   */
  _initializeApplicationOptions(options) {
    const initialized = super._initializeApplicationOptions(options);
    if ( ["pc", "gmc"].includes(initialized.document?.type) ) {
      const gmc = initialized.document.type === "gmc";
      initialized.position = {
        ...initialized.position, width: options.position?.width ?? (gmc ? 500 : 680),
        height: options.position?.height ?? (gmc ? "auto" : initialized.position.height)
      };
    }
    if ( initialized.document?.limited ) initialized.position = { ...initialized.position, height: "auto" };
    return initialized;
  }

  /**
   * A sheet that is closed opens in play mode the next time (CS-D1).
   * @override
   */
  _onClose(options) {
    super._onClose(options);
    this.#editMode = false;
  }

  /** @override */
  static PARTS = {
    sheet: { template: TEMPLATE, templates: [SFX_LIST], scrollable: [".cp-sheet-body"] },
    pool: { template: "systems/cortex-prime/templates/actor/pool-footer.hbs", scrollable: [".cp-pool-preview"] }
  };

  _configureRenderParts(options) {
    const parts = super._configureRenderParts(options);
    if ( this.actor.type === "character" ) delete parts.pool;
    return parts;
  }

  _getHeaderControls() {
    const controls = super._getHeaderControls();
    if ( this.actor.isOwner ) {
      controls.push({ action: "viewTraits", icon: "fa-solid fa-list-check", label: "CORTEX.Assets.Mine.View" });
    }
    if ( this.actor.type === "character" && game.user.isGM ) {
      controls.push(
        { action: "copyPc", icon: "fa-solid fa-copy", label: "CORTEX.Sheet.Design.CopyPc" },
        { action: "copyGmc", icon: "fa-solid fa-copy", label: "CORTEX.Sheet.Design.CopyGmc" }
      );
    }
    return controls;
  }

  /** Copy even a synthetic or compendium Actor to a new world Actor, without altering its source or links. */
  async copyAs(type) {
    if ( !game.user.isGM || this.actor.type !== "character" || !["pc", "gmc"].includes(type) ) return;
    const data = this.actor.toObject();
    delete data._id;
    delete data._stats;
    if ( data.flags?.core ) delete data.flags.core.sheetClass;
    if ( this.actor.pack ) {
      data.folder = null;
      delete data.ownership;
    }
    data.type = type;
    data.name = game.i18n.format("CORTEX.Sheet.Design.CopyName", { name: data.name, type: game.i18n.localize(`TYPES.Actor.${type}`) });
    if ( type === "gmc" ) data.system.blocks = blocksFromCharacter(data.system, getGameConfig());
    return Actor.implementation.create(data, { renderSheet: true, keepEmbeddedIds: true });
  }

  /** Update only the footer so choosing dice on another sheet preserves focus and open details. */
  static refreshPoolFooters() {
    for ( const app of foundry.applications.instances.values() ) {
      if ( app instanceof CharacterSheet && app.rendered && !app.actor.limited && app.actor.type !== "character" ) {
        app.render({ parts: ["pool"] });
      }
    }
  }

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
    // A limited user gets the name and portrait only (CS-D4); nothing about the traits is prepared.
    if ( this.actor.limited ) return Object.assign(context, { actor: this.actor, limited: true });
    const native = this.actor.type !== "character";
    if ( native ) context.pool = sheetPoolContext(this.actor.uuid);
    if ( options.parts?.length === 1 && options.parts[0] === "pool" ) return context;
    const config = getGameConfig();
    const system = this.actor.system.toObject();
    const layout = actorLayout(this.actor.type, system, config);
    const view = characterSheetView(system, config, layout);
    const i18n = game.i18n;
    const mayChallenge = this.actor.isOwner && this.isEditable;
    const editMode = this.editMode;
    const play = native && !editMode;
    const row = trait => ({
      ...trait,
      editable: trait.editable && !play,
      playRoll: play && trait.rollable,
      label: trait.name || i18n.localize("CORTEX.Sheet.Unnamed"),
      nameInput: editMode ? trait.nameInput : null,
      statementInput: editMode ? trait.statementInput : null,
      statementLabel: i18n.format("CORTEX.Sheet.Statement.Input", { trait: trait.name }),
      canResolve: trait.challenged && (trait.entryId !== null) && this.isEditable,
      resolveLabels: {
        rewritten: i18n.format("CORTEX.Sheet.Statement.Rewritten", { trait: trait.name }),
        kept: i18n.format("CORTEX.Sheet.Statement.Kept", { trait: trait.name })
      },
      shutDownText: trait.shutDownReason ? i18n.localize(`CORTEX.Sheet.ShutDown.${trait.shutDownReason}`) : null,
      canShutDown: trait.canShutDown && this.isEditable,
      shutDownLabel: i18n.format(trait.ownShutDown ? "CORTEX.Sheet.ShutDown.ClearTrait" : "CORTEX.Sheet.ShutDown.SetTrait",
        { trait: trait.name }),
      removeLabel: i18n.format("CORTEX.Sheet.RemoveTrait", { trait: trait.name }),
      newSlot: (trait.newSlot && this.isEditable && !play)
        ? { ...trait.newSlot, ariaLabel: i18n.format("CORTEX.Sheet.NewRating", { trait: trait.name }) } : null,
      canChallenge: trait.canChallenge && mayChallenge,
      canHinderChallenge: trait.canHinder && trait.canChallenge && mayChallenge,
      poolLabels: {
        hinderChallenge: i18n.format("CORTEX.Sheet.Pool.HinderChallenge", { trait: trait.name }),
        add: i18n.format("CORTEX.Sheet.Pool.Add", { trait: trait.name }),
        hinder: i18n.format("CORTEX.Sheet.Pool.Hinder", { trait: trait.name }),
        challenge: i18n.format("CORTEX.Sheet.Pool.Challenge", { trait: trait.name })
      },
      ratingText: CharacterSheet.#ratingText(trait),
      hintTexts: trait.hints.map(code => i18n.localize(`CORTEX.Sheet.Hints.${code}`)),
      slots: CharacterSheet.#labelledSlots(trait.slots, trait.name),
      descriptionInput: editMode ? trait.descriptionInput : null,
      descriptionLabel: i18n.format("CORTEX.Sheet.Details.DescriptionInput", { trait: trait.name }),
      sfx: CharacterSheet.#sfxContext(trait.sfx, trait.name),
      sfxEdit: editMode && trait.canAddSfx,
      tagsInput: editMode ? trait.tagsInput : null,
      tagsValue: (trait.tags ?? []).join(","),
      tagsLabel: i18n.format("CORTEX.Sheet.Details.TagsInput", { trait: trait.name }),
      subTraits: trait.subTraits?.map(sub => {
        const name = sub.name || i18n.localize("CORTEX.Sheet.Unnamed");
        return {
          ...sub, label: name, ratingText: sub.dice.map(size => `d${size}`).join(" "),
          nameLabel: i18n.format("CORTEX.Sheet.Details.SubName", { trait: trait.name }),
          removeLabel: i18n.format("CORTEX.Sheet.Details.RemoveSub", { sub: name }),
          slots: CharacterSheet.#labelledSlots(sub.slots, name)
        };
      }) ?? null,
      subEdit: editMode && trait.canAddSubTrait,
      addSfxLabel: i18n.format("CORTEX.Sheet.Details.AddSfxTo", { trait: trait.name }),
      addSubLabel: i18n.format("CORTEX.Sheet.Details.AddSubTo", { trait: trait.name })
    });
    // The sheet's sections: the kind's sets, then its free traits, which belong to no set (TS-22).
    const sections = view.sets.map(set => {
      const traits = [];
      const fallbackTraits = [];
      for ( const trait of set.traits ) {
        // An entry the character holds may have its own details or play controls even without dice.
        const group = (play && trait.entryId === null && trait.rollable && trait.fallbackDie !== null)
          ? fallbackTraits : traits;
        group.push(row(trait));
      }
      return {
        ...set, free: false, emptyText: i18n.localize("CORTEX.Sheet.NoTraits"), traits,
        fallback: fallbackTraits.length ? { die: `d${fallbackTraits[0].fallbackDie}`, traits: fallbackTraits } : null,
        canLoseDice: this.actor.type === "gmc" && set.id === DEFAULT_MOB_SET && set.multiDice,
        wide: config.traitSets.some(def => def.id === set.id && (def.role === "distinctions" || def.features?.statements)),
        canShutDown: set.canShutDown && this.isEditable,
        shutDownLabel: i18n.format(set.shutDown ? "CORTEX.Sheet.ShutDown.ClearSet" : "CORTEX.Sheet.ShutDown.SetSet",
          { set: set.name }),
        sfx: CharacterSheet.#sfxContext(set.sfx, set.name),
        sfxEdit: editMode && (set.sfx !== null),
        showSetSfx: (set.sfx !== null) && (editMode || (set.sfx.length > 0)),
        addSetSfxLabel: i18n.format("CORTEX.Sheet.Details.AddSetSfx", { set: set.name })
      };
    });
    const gmc = this.actor.type === "gmc";
    const canBuild = gmc && game.user.isGM && editMode;
    if ( view.freeTraits && (!gmc || system.blocks.includes("free")) ) {
      sections.push({
        id: null, block: "free", name: i18n.localize(gmc ? "CORTEX.Sheet.Design.free" : "CORTEX.Sheet.FreeTraits"),
        free: true, open: true, shutDown: false, emptyText: i18n.localize("CORTEX.Sheet.NoFreeTraits"),
        traits: view.freeTraits.filter(trait => !gmc || ![system.mobTraitId, system.bossTraitId].includes(trait.entryId)).map(row)
      });
    }
    if ( gmc ) {
      for ( const block of ["mob", "boss"] ) {
        if ( !system.blocks.includes(block) ) continue;
        const trait = view.freeTraits?.find(t => t.entryId === system[block + "TraitId"]);
        sections.push({
          block, free: true, threat: true, canLoseDice: true, name: i18n.localize(`CORTEX.Sheet.Design.${block}`),
          traits: trait ? [row(trait)] : [], emptyText: i18n.localize("CORTEX.Sheet.NoTraits")
        });
      }
      if ( system.blocks.includes("sfx") ) {
        const name = i18n.localize("CORTEX.Sheet.Design.sfx");
        sections.push({ block: "sfx", standaloneSfx: true, name, showSetSfx: true, sfxEdit: editMode,
          sfx: CharacterSheet.#sfxContext(sfxRows(system.sfx, "gmcSfx"), name) });
      }
      sections.sort((a, b) => system.blocks.indexOf(a.block ?? a.id) - system.blocks.indexOf(b.block ?? b.id));
    }
    const blockChoices = canBuild ? [
      ...GMC_BLOCKS.map(id => ({ id, name: i18n.localize(`CORTEX.Sheet.Design.${id}`) })),
      ...config.traitSets
    ].filter(block => !system.blocks.includes(block.id)) : [];
    return Object.assign(context, {
      actor: this.actor,
      native, play, gmc, canBuild, blockChoices,
      pc: this.actor.type === "pc", plotPoints: system.plotPoints,
      ppGainLabel: i18n.localize(game.user.isGM ? "CORTEX.PlotPoints.Award" : "CORTEX.PlotPoints.RecordGain"),
      ppSpendLabel: i18n.localize(game.user.isGM ? "CORTEX.PlotPoints.Adjust" : "CORTEX.PlotPoints.RecordSpend"),
      kindName: native ? i18n.localize("TYPES.Actor." + this.actor.type) : view.kind?.name ?? null,
      notice: gmc ? ((!sections.length && !editMode && this.isEditable && game.user.isGM) ? i18n.localize("CORTEX.Sheet.Design.EmptyGmc") : null)
        : (native && !layout) ? i18n.localize("CORTEX.Sheet.Design.NoPcLayout") : CharacterSheet.#notice(view),
      sections,
      others: this.#others(view),
      editMode,
      canEdit: this.isEditable,
      kindPicker: native ? null : this.#kindPicker(view, system, config)
    });
  }

  /**
   * The actor-kind choice, or null where it isn't offered (CS-D3): a character without a kind, or
   * one that stores no traits yet (storesNoTraits), offers it to anyone who can edit it, in either
   * mode; otherwise a kind that is set, known or not, is changed by a GM in edit mode. A kind the
   * configuration doesn't have stays selectable as itself, so submitting another change never
   * clears it.
   * @param {import("./character-sheet-data.mjs").SheetView} view
   * @param {object} system
   * @param {import("../rules/types.mjs").GameConfig} config
   * @returns {{options: {value: string, label: string, selected: boolean}[], unassigned: boolean}|null}
   */
  #kindPicker(view, system, config) {
    if ( !this.isEditable ) return null;
    const unassigned = view.kindStatus === "unassigned";
    const openToEditors = unassigned || storesNoTraits(system);
    if ( !openToEditors && !(this.editMode && game.user.isGM) ) return null;
    const options = config.actorKinds.map(kind => ({ value: kind.id, label: kind.name, selected: kind.id === system.kindId }));
    if ( view.kindStatus === "unknown" ) {
      options.unshift({ value: system.kindId, label: game.i18n.localize("CORTEX.Sheet.UnknownKindOption"), selected: true });
    }
    return { options, unassigned };
  }

  /**
   * Rating slots with the labels the selects carry.
   * @param {import("./character-sheet-data.mjs").RatingSlot[]} slots
   * @param {string} name - the trait's or sub-trait's name
   * @returns {object[]}
   */
  static #labelledSlots(slots, name) {
    return slots.map(slot => ({
      ...slot,
      ariaLabel: slot.adds
        ? game.i18n.format("CORTEX.Sheet.AddDie", { trait: name })
        : game.i18n.format("CORTEX.Sheet.Die", { trait: name, number: slot.index + 1 })
    }));
  }

  /**
   * A list of SFX with the labels the sheet shows, or null where the set lacks the feature.
   * @param {import("./character-sheet-data.mjs").SheetSfx[]|null} sfx
   * @param {string} owner - the trait's or set's name
   * @returns {object[]|null}
   */
  static #sfxContext(sfx, owner) {
    if ( !sfx ) return null;
    const i18n = game.i18n;
    return sfx.map(row => ({
      ...row,
      label: row.text || i18n.localize("CORTEX.Sheet.Details.SfxBlank"),
      stateLabel: i18n.localize(row.unlocked ? "CORTEX.Sheet.Details.Unlocked" : "CORTEX.Sheet.Details.Locked"),
      textLabel: i18n.format("CORTEX.Sheet.Details.SfxText", { owner, number: row.index + 1 }),
      unlockedLabel: i18n.format("CORTEX.Sheet.Details.SfxUnlocked", { owner, number: row.index + 1 }),
      removeLabel: i18n.format("CORTEX.Sheet.Details.RemoveSfx", { owner, number: row.index + 1 })
    }));
  }

  /**
   * The "Other stored traits" list, or null outside edit mode and where there is nothing to list
   * (CS-D5, ADR-051): what the character stores that no section shows, by its stored names.
   * @param {import("./character-sheet-data.mjs").SheetView} view
   * @returns {{groups: {setId: string|null, free: boolean, label: string, traits: object[]}[]}|null}
   */
  #others(view) {
    if ( !this.editMode || !view.others.count ) return null;
    const i18n = game.i18n;
    const trait = other => {
      const name = other.name || i18n.localize("CORTEX.Sheet.Unnamed");
      return {
        ...other, label: name, ratingText: other.dice.map(size => `d${size}`).join(" "),
        removeLabel: i18n.format("CORTEX.Sheet.RemoveTrait", { trait: name })
      };
    };
    const groups = view.others.sets.map(group => ({
      setId: group.setId,
      free: false,
      label: (group.reason === "unknownSet")
        ? i18n.format("CORTEX.Sheet.Others.unknownSet", { id: group.setId })
        : i18n.format(`CORTEX.Sheet.Others.${group.reason}`, { set: group.name }),
      traits: group.traits.map(trait)
    }));
    if ( view.others.freeTraits.length ) {
      groups.push({
        setId: null, free: true, label: i18n.localize("CORTEX.Sheet.Others.freeTraits"),
        traits: view.others.freeTraits.map(trait)
      });
    }
    return { groups };
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
    for ( const button of this.element.querySelectorAll('button[data-action="addToPool"], button[data-action="reviewPool"], button[data-action="removePoolDie"], button[data-action="rollSheetPool"]') ) {
      button.disabled = false;
    }
  }

  /** Keep keyboard focus in the pool when the focused die disappears. */
  _preSyncPartState(partId, newElement, priorElement, state) {
    super._preSyncPartState(partId, newElement, priorElement, state);
    if ( partId !== "pool" ) return;
    const focused = priorElement.querySelector(".cp-pool-die:focus");
    if ( !focused ) return;
    const selectorFor = button => `.cp-pool-die[data-die-id="${CSS.escape(button.dataset.dieId)}"]`;
    const sameDie = selectorFor(focused);
    const index = [...priorElement.querySelectorAll(".cp-pool-die")].indexOf(focused);
    const remaining = newElement.querySelectorAll(".cp-pool-die");
    const next = remaining[Math.min(index, remaining.length - 1)];
    state.focus = newElement.querySelector(sameDie) ? sameDie
      : next ? selectorFor(next) : 'button[data-action="reviewPool"]';
  }

  _onChangeForm(formConfig, event) {
    if ( event.target.matches(".cp-block-choice") ) return;
    return super._onChangeForm(formConfig, event);
  }

  /**
   * Adds the clicked trait to the user's pool: plainly, with Hinder or as a challenge, by the
   * button's `data-option`.
   * @this {CharacterSheet}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static async #onAddToPool(_event, target) {
    const setId = CharacterSheet.#setIdOf(target);
    const traitId = target.closest("[data-pool-trait-id]")?.dataset.poolTraitId;
    if ( (setId === undefined) || !traitId ) return;
    await addTraitToPool(this.actor, setId, traitId, target.dataset.option ?? null, { beside: this, open: this.actor.type === "character" });
  }

  /**
   * Which of the sheet's sections a control is in.
   * @param {HTMLElement} target
   * @returns {string|null|undefined} a set's id, null for free traits, undefined for neither
   */
  static #setIdOf(target) {
    const section = target.closest("[data-set-id], [data-free-traits]");
    if ( !section ) return undefined;
    return ("freeTraits" in section.dataset) ? null : section.dataset.setId;
  }

  /**
   * The set and the stored entry of a control on a set trait's row.
   * @param {HTMLElement} target
   * @returns {{setId: string|null|undefined, entryId: string|undefined}}
   */
  static #setEntryOf(target) {
    return { setId: CharacterSheet.#setIdOf(target), entryId: target.closest("[data-entry-id]")?.dataset.entryId };
  }

  /**
   * Resolves the clicked trait's challenged statement as rewritten or kept, by the button's
   * `data-rewritten`.
   * @this {CharacterSheet}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static async #onResolveChallenge(_event, target) {
    const { setId, entryId } = CharacterSheet.#setEntryOf(target);
    if ( setId && entryId ) await this.resolveChallenge(setId, entryId, target.dataset.rewritten === "true");
  }

  /**
   * Sets or clears the clicked trait's own shut-down flag.
   * @this {CharacterSheet}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static async #onToggleShutDown(_event, target) {
    const { setId, entryId } = CharacterSheet.#setEntryOf(target);
    if ( setId && entryId ) await this.setShutDown(setId, entryId, target.dataset.shutDown !== "true");
  }

  /**
   * Sets or clears the clicked set's shut-down flag.
   * @this {CharacterSheet}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static async #onToggleSetShutDown(_event, target) {
    const setId = CharacterSheet.#setIdOf(target);
    if ( setId ) await this.setSetShutDown(setId, target.dataset.shutDown !== "true");
  }

  /**
   * Turns edit mode on or off and renders again.
   * @this {CharacterSheet}
   */
  static #onToggleEdit() {
    this.#editMode = !this.#editMode;
    this.render();
  }

  static async #onAddBlock() {
    if ( this.actor.type !== "gmc" || !this.editMode || !game.user.isGM ) return;
    const block = this.element.querySelector(".cp-block-choice")?.value;
    if ( !block ) return;
    const change = addGmcBlock(this.actor.system.toObject(), getGameConfig(), block, () => foundry.utils.randomID(),
      GMC_BLOCKS.includes(block) ? game.i18n.localize(`CORTEX.Sheet.Design.${block}`) : "");
    if ( change ) await this.#writeSystem(change);
  }

  static async #onHideBlock(_event, target) {
    if ( this.actor.type !== "gmc" || !this.editMode || !game.user.isGM ) return;
    const block = target.closest("[data-block]")?.dataset.block;
    const blocks = this.actor.system.blocks.filter(id => id !== block);
    if ( blocks.length !== this.actor.system.blocks.length ) await this.#writeSystem({ blocks });
  }

  /** The GM or owner chooses which die was lost, particularly for a mixed boss rating (pp. 117–118). */
  static async #onLoseDie(_event, target) {
    if ( this.actor.type !== "gmc" || !this.isEditable ) return;
    const system = this.actor.system.toObject();
    const block = target.closest("[data-block]")?.dataset.block;
    if ( !system.blocks.includes(block) ) return;
    const set = block === DEFAULT_MOB_SET ? system.traits[block] : null;
    const id = target.closest("[data-entry-id]")?.dataset.entryId;
    if ( !set && (!["mob", "boss"].includes(block) || id !== system[block + "TraitId"]) ) return;
    const trait = (set?.entries ?? system.freeTraits).find(entry => entry.id === id);
    const index = Number(target.dataset.index);
    if ( !trait || !Number.isInteger(index) || trait.dice[index] !== Number(target.dataset.size) ) return;
    trait.dice.splice(index, 1);
    await this.#writeSystem(set ? { traits: { [block]: { entries: set.entries } } } : { freeTraits: system.freeTraits });
  }

  static async #onAddGmcSfx() {
    if ( this.actor.type !== "gmc" || !this.editMode || !this.actor.system.blocks.includes("sfx") ) return;
    await this.#writeSystem({ sfx: [...this.actor.system.toObject().sfx, { text: "", unlocked: true }] });
  }

  static async #onRemoveGmcSfx(_event, target) {
    if ( this.actor.type !== "gmc" || !this.editMode ) return;
    const index = Number(target.dataset.index);
    const before = this.actor.system.toObject().sfx;
    if ( !before[index] || !await CharacterSheet.#confirmRemoval("CORTEX.Sheet.Details.RemoveSfxTitle", target.dataset.tooltip) ) return;
    const current = this.actor.system.toObject().sfx;
    if ( JSON.stringify(current) !== JSON.stringify(before) ) return this.render();
    await this.#writeSystem({ sfx: current.filter((_sfx, i) => i !== index) });
  }

  /**
   * Adds a trait to the clicked open set, or a free trait.
   * @this {CharacterSheet}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static async #onAddTrait(_event, target) {
    const setId = CharacterSheet.#setIdOf(target);
    if ( setId === null ) await this.addFreeTrait();
    else if ( setId ) await this.addTrait(setId);
  }

  /**
   * Removes the clicked trait after the user confirms.
   * @this {CharacterSheet}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static async #onRemoveTrait(_event, target) {
    const setId = CharacterSheet.#setIdOf(target);
    const row = target.closest("[data-entry-id]");
    if ( (setId === undefined) || !row ) return;
    const name = row.querySelector("input.cp-trait-name")?.value || row.dataset.traitName
      || game.i18n.localize("CORTEX.Sheet.Unnamed");
    if ( !await CharacterSheet.#confirmRemoval("CORTEX.Sheet.RemoveTitle",
      game.i18n.format("CORTEX.Sheet.RemoveConfirm", { trait: name })) ) return;
    if ( setId === null ) await this.removeFreeTrait(row.dataset.entryId);
    else await this.removeTrait(setId, row.dataset.entryId);
  }

  /**
   * Asks before something is removed.
   * @param {string} title - a language key
   * @param {string} text - the question, already localized
   * @returns {Promise<boolean>} whether the user confirmed
   */
  static async #confirmRemoval(title, text) {
    return Boolean(await foundry.applications.api.DialogV2.confirm({
      window: { title }, content: `<p>${foundry.utils.escapeHTML(text)}</p>`
    }));
  }

  /**
   * Adds an SFX to the clicked trait.
   * @this {CharacterSheet}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static async #onAddSfx(_event, target) {
    const { setId, entryId } = CharacterSheet.#setEntryOf(target);
    if ( setId && entryId ) await this.addSfx(setId, entryId);
  }

  /**
   * Removes the clicked SFX of a trait, after the user confirms.
   * @this {CharacterSheet}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static async #onRemoveSfx(_event, target) {
    const { setId, entryId } = CharacterSheet.#setEntryOf(target);
    const index = Number(target.dataset.index);
    if ( !setId || !entryId || !Number.isInteger(index) ) return;
    if ( !await CharacterSheet.#confirmRemoval("CORTEX.Sheet.Details.RemoveSfxTitle", target.dataset.tooltip ?? "") ) return;
    await this.removeSfx(setId, entryId, index);
  }

  /**
   * Adds an SFX of its own to the clicked set.
   * @this {CharacterSheet}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static async #onAddSetSfx(_event, target) {
    const setId = CharacterSheet.#setIdOf(target);
    if ( setId ) await this.addSetSfx(setId);
  }

  /**
   * Removes the clicked SFX of a set, after the user confirms.
   * @this {CharacterSheet}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static async #onRemoveSetSfx(_event, target) {
    const setId = CharacterSheet.#setIdOf(target);
    const index = Number(target.dataset.index);
    if ( !setId || !Number.isInteger(index) ) return;
    if ( !await CharacterSheet.#confirmRemoval("CORTEX.Sheet.Details.RemoveSfxTitle", target.dataset.tooltip ?? "") ) return;
    await this.removeSetSfx(setId, index);
  }

  /**
   * Adds a sub-trait to the clicked trait.
   * @this {CharacterSheet}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static async #onAddSubTrait(_event, target) {
    const { setId, entryId } = CharacterSheet.#setEntryOf(target);
    if ( setId && entryId ) await this.addSubTrait(setId, entryId);
  }

  /**
   * Removes the clicked sub-trait, after the user confirms.
   * @this {CharacterSheet}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static async #onRemoveSubTrait(_event, target) {
    const { setId, entryId } = CharacterSheet.#setEntryOf(target);
    const subId = target.closest("[data-sub-id]")?.dataset.subId;
    if ( !setId || !entryId || !subId ) return;
    if ( !await CharacterSheet.#confirmRemoval("CORTEX.Sheet.Details.RemoveSubTitle", target.dataset.tooltip ?? "") ) return;
    await this.removeSubTrait(setId, entryId, subId);
  }

  /**
   * Adds a new trait to an open set, named "New trait" and rated as CS-D9 says, then renders.
   * @param {string} setId
   * @returns {Promise<boolean>} whether it was written
   */
  async addTrait(setId) {
    if ( !this.isEditable ) return false;
    return this.#writeSetChange(setId, addTraitEntry(this.actor.system.toObject(), getGameConfig(), setId, foundry.utils.randomID(),
      game.i18n.localize("CORTEX.Sheet.NewTrait")));
  }

  /**
   * Resolves a trait's challenged statement (rule 16; TS-15, TS-16).
   * @param {string} setId
   * @param {string} entryId
   * @param {boolean} rewritten - the statement was rewritten, which brings back the rating from
   *   before the challenge; otherwise it is kept
   * @returns {Promise<boolean>} whether it was written
   */
  async resolveChallenge(setId, entryId, rewritten) {
    if ( !this.isEditable ) return false;
    return this.#writeSetChange(setId, resolveTraitChallenge(this.actor.system.toObject(), setId, entryId, rewritten));
  }

  /**
   * Sets a trait's own shut-down flag, by hand, or clears it whatever its reason (rule 15, RQ-034).
   * @param {string} setId
   * @param {string} entryId
   * @param {boolean} shutDown
   * @returns {Promise<boolean>} whether it was written
   */
  async setShutDown(setId, entryId, shutDown) {
    if ( !this.isEditable ) return false;
    return this.#writeSetChange(setId, setTraitShutDown(this.actor.system.toObject(), getGameConfig(), setId, entryId, shutDown));
  }

  /**
   * Sets or clears a whole set's shut-down flag (rule 15); setShutDownChange decides what is
   * written.
   * @param {string} setId
   * @param {boolean} shutDown
   * @returns {Promise<boolean>} whether it was written
   */
  async setSetShutDown(setId, shutDown) {
    if ( !this.isEditable ) return false;
    return this.#writeSetChange(setId, setShutDownChange(this.actor.system.toObject(), getGameConfig(), setId, shutDown));
  }

  /**
   * Adds an SFX to a trait: no text yet, unlocked (CS-D6).
   * @param {string} setId
   * @param {string} entryId
   * @returns {Promise<boolean>} whether it was written
   */
  async addSfx(setId, entryId) {
    if ( !this.isEditable ) return false;
    return this.#writeSetChange(setId, addTraitSfx(this.actor.system.toObject(), getGameConfig(), setId, entryId));
  }

  /**
   * Removes one SFX of a trait, without asking: the click handler asks first.
   * @param {string} setId
   * @param {string} entryId
   * @param {number} index
   * @returns {Promise<boolean>} whether it was written
   */
  async removeSfx(setId, entryId, index) {
    if ( !this.isEditable ) return false;
    return this.#writeSetChange(setId, removeTraitSfx(this.actor.system.toObject(), setId, entryId, index));
  }

  /**
   * Adds an SFX of its own to a set: no text yet, unlocked (CS-D6).
   * @param {string} setId
   * @returns {Promise<boolean>} whether it was written
   */
  async addSetSfx(setId) {
    if ( !this.isEditable ) return false;
    return this.#writeSetChange(setId, addSetSfx(this.actor.system.toObject(), getGameConfig(), setId));
  }

  /**
   * Removes one of a set's own SFX, without asking: the click handler asks first.
   * @param {string} setId
   * @param {number} index
   * @returns {Promise<boolean>} whether it was written
   */
  async removeSetSfx(setId, index) {
    if ( !this.isEditable ) return false;
    return this.#writeSetChange(setId, removeSetSfx(this.actor.system.toObject(), setId, index));
  }

  /**
   * Adds a sub-trait to a trait, named "New trait" and with no rating yet (rule 19).
   * @param {string} setId
   * @param {string} entryId
   * @returns {Promise<boolean>} whether it was written
   */
  async addSubTrait(setId, entryId) {
    if ( !this.isEditable ) return false;
    return this.#writeSetChange(setId, addSubTrait(this.actor.system.toObject(), getGameConfig(), setId, entryId, foundry.utils.randomID(),
      game.i18n.localize("CORTEX.Sheet.NewTrait")));
  }

  /**
   * Removes a sub-trait, without asking: the click handler asks first.
   * @param {string} setId
   * @param {string} entryId
   * @param {string} subId
   * @returns {Promise<boolean>} whether it was written
   */
  async removeSubTrait(setId, entryId, subId) {
    if ( !this.isEditable ) return false;
    return this.#writeSetChange(setId, removeSubTrait(this.actor.system.toObject(), setId, entryId, subId));
  }

  /**
   * Adds a new free trait, named "New trait" and with no rating yet, then renders.
   * @returns {Promise<boolean>} whether it was written
   */
  async addFreeTrait() {
    if ( !this.isEditable ) return false;
    const added = addFreeTrait(this.actor.system.toObject(), foundry.utils.randomID(),
      game.i18n.localize("CORTEX.Sheet.NewTrait"));
    if ( !added.ok ) return this.#refuse(added.code);
    return this.#writeSystem({ freeTraits: added.value });
  }

  /**
   * Removes a free trait, without asking: the click handler asks first.
   * @param {string} entryId
   * @returns {Promise<boolean>} whether it was written
   */
  async removeFreeTrait(entryId) {
    if ( !this.isEditable ) return false;
    const removed = removeFreeTrait(this.actor.system.toObject(), entryId);
    if ( !removed.ok ) return this.#refuse(removed.code);
    return this.#writeSystem({ freeTraits: removed.value });
  }

  /**
   * Removes a trait from a set, without asking: the click handler asks first.
   * @param {string} setId
   * @param {string} entryId
   * @returns {Promise<boolean>} whether it was written
   */
  async removeTrait(setId, entryId) {
    if ( !this.isEditable ) return false;
    return this.#writeSetChange(setId, removeTraitEntry(this.actor.system.toObject(), setId, entryId));
  }

  /**
   * Writes trait changes through Actor#update after the same check the form submit runs
   * (ADR-037 point 3).
   * @param {{traits?: Record<string, {entries: object[]}>, freeTraits?: object[]}} system - the
   *   changed sets by id, or the whole list of free traits
   * @returns {Promise<boolean>} whether the update was made
   */
  async #writeSystem(system) {
    const checked = checkCharacterUpdate(this.actor.system.toObject(), system, getGameConfig(), {
      operatorOf: CharacterData.operatorOf, unlinkedToken: this.actor.isToken === true
    });
    if ( !checked.ok ) return this.#refuse(checked.code);
    return Boolean(await this.actor.update({ system }));
  }

  /**
   * Writes one set's change from a pure function, or shows why there is none.
   * @param {string} setId
   * @param {import("../rules/types.mjs").EngineResult<object>} changed - the set's change
   * @returns {Promise<boolean>} whether it was written
   */
  async #writeSetChange(setId, changed) {
    if ( !changed.ok ) return this.#refuse(changed.code);
    return this.#writeSystem({ traits: { [setId]: changed.value } });
  }

  /** Shows a refusal's text and renders the stored state again; always returns false. */
  #refuse(code) {
    ui.notifications.error(CharacterSheet.#refusalText(code));
    this.render();
    return false;
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
    if ( !view.sets.length && !view.freeTraits ) return game.i18n.localize("CORTEX.Sheet.NoSets");
    return null;
  }

  /**
   * Turns the trait inputs (ratings, new ratings and names, and the free traits' ratings and
   * names) into the trait changes of the update, from the data stored when the form is submitted; the other inputs (name, portrait, kind) are
   * read as Foundry reads them. A rating
   * input that can't be read refuses the whole submit (thrown, so the form shows it as an error).
   * @override
   */
  _processFormData(event, form, formData) {
    // Autosaving one field must not replay stale values from another owner's edit.
    // A rating is the one composite input: its selects together represent the dice list.
    if ( this.actor.type !== "character" && event?.type === "change" ) {
      const name = event.target.closest("[name]")?.name;
      if ( name && Object.hasOwn(formData.object, name) ) {
        const isRating = [RATING_INPUTS, FREE_RATING_INPUTS, NEW_RATING_INPUTS, SUB_RATING_INPUTS].includes(name.split(".")[0]);
        const prefix = name.slice(0, name.lastIndexOf(".") + 1);
        const fields = Object.entries(formData.object).filter(([key]) => key === name || (isRating && key.startsWith(prefix)));
        formData = { object: Object.fromEntries(fields) };
      }
    }
    const {
      [RATING_INPUTS]: ratings, [NEW_RATING_INPUTS]: newRatings, [NAME_INPUTS]: names, [STATEMENT_INPUTS]: statements,
      [DESCRIPTION_INPUTS]: descriptions, [SFX_INPUTS]: sfx, [TAG_INPUTS]: tags, [SUB_NAME_INPUTS]: subNames,
      [SUB_RATING_INPUTS]: subRatings, [SET_SFX_INPUTS]: setSfx,
      [FREE_RATING_INPUTS]: freeRatings, [FREE_NAME_INPUTS]: freeNames, gmcSfx, ...data
    } = super._processFormData(event, form, formData);
    const stored = this.actor.system.toObject();
    const traits = sheetTraitChanges(stored, getGameConfig(), {
      ratings, newRatings, names, statements, descriptions, sfx, tags, subNames, subRatings, setSfx
    },
      () => foundry.utils.randomID());
    if ( !traits.ok ) throw new Error(CharacterSheet.#refusalText(traits.code));
    const freeTraits = freeTraitChanges(stored, { ratings: freeRatings, names: freeNames });
    if ( !freeTraits.ok ) throw new Error(CharacterSheet.#refusalText(freeTraits.code));
    // The kind select submits "system.kindId"; the trait changes go beside it.
    if ( Object.keys(traits.value).length ) data.system = { ...data.system, traits: traits.value };
    if ( freeTraits.value ) data.system = { ...data.system, freeTraits: freeTraits.value };
    if ( gmcSfx && this.actor.type === "gmc" && this.editMode ) {
      const changed = sfxFromInputs(stored.sfx, gmcSfx);
      if ( !changed.ok ) throw new Error(CharacterSheet.#refusalText(changed.code));
      if ( changed.value ) data.system = { ...data.system, sfx: changed.value };
    }
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
