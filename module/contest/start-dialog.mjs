/**
 * The dialog that starts a test or contest (Decisions ADR-020, ADR-021 and ADR-027, Step 4.4 S3
 * proposal review). It collects the type, the sides with their actors, and for a test the
 * difficulty, a roll card or a typed number, then sends a "start" request through the GM relay,
 * which checks everything again. Opened from the pool builder, and from the chat context menu of a
 * resolved poolRoll card. In a test the GM rolls the opposition first and announces the difficulty
 * (Handbook p. 18); a contest's initiator rolls first (p. 19).
 * @module contest/start-dialog
 */

import { openPoolBuilderFor } from "../apps/pool-builder.mjs";
import { CONTEST_SIDES, DIFFICULTY_LEVELS, TEST_SIDES, difficultyLevelOfPool } from "../rules/index.mjs";
import { notifyContestResult, sendContestRequest } from "./relay.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TEMPLATE = "systems/cortex-prime/templates/contest/start-dialog.hbs";

/**
 * Whether a message can set a test's difficulty: a resolved poolRoll card this user can see, with
 * no overflow choice open (ADR-021, Step 4.4 S3 proposal review).
 * @param {ChatMessage|undefined} message
 * @returns {boolean}
 */
export function isDifficultyCard(message) {
  return (message?.type === "poolRoll") && message.visible && message.isContentVisible
    && (message.system.state === "resolved") && !!message.system.resolution && !message.system.resolution.overflow;
}

/**
 * The entry for the chat log's context menu (14.369 client/applications/sidebar/tabs/chat.mjs,
 * `getChatMessageContextOptions`): "Start a test against this roll" on a card that can set a
 * difficulty.
 * @returns {{label: string, icon: string, visible: Function, onClick: Function}}
 */
export function startContestContextOption() {
  return {
    label: "CORTEX.Contest.Start.FromCard",
    icon: "fa-solid fa-scale-balanced",
    visible: li => isDifficultyCard(game.messages.get(li.dataset.messageId)),
    onClick: (_event, li) => openStartDialog({ cardId: li.dataset.messageId })
  };
}

/**
 * Opens the start dialog.
 * @param {{cardId?: string|null}} [options] - a roll card to pre-select as the difficulty
 * @returns {Promise<StartContestDialog>}
 */
export async function openStartDialog({ cardId = null } = {}) {
  const dialog = new StartContestDialog({ cardId });
  await dialog.render({ force: true });
  return dialog;
}

/**
 * The start dialog: an ApplicationV2 form in the core "standard-form" layout (ADR-019).
 * @extends ApplicationV2
 * @mixes HandlebarsApplicationMixin
 */
export class StartContestDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @param {{cardId?: string|null}} [options] */
  constructor({ cardId = null, ...options } = {}) {
    super(options);
    this.#cardId = cardId;
  }

  /** @override */
  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["cortex-prime", "start-contest"],
    window: { title: "CORTEX.Contest.Start.Title", icon: "fa-solid fa-scale-balanced", contentClasses: ["standard-form"] },
    position: { width: 460 },
    form: { handler: StartContestDialog.#onSubmit, closeOnSubmit: false }
  };

  /** @override */
  static PARTS = {
    body: { template: TEMPLATE },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** The roll card pre-selected as the difficulty, or null. */
  #cardId;

  /** @override */
  async _prepareContext(_options) {
    const isGM = game.user.isGM;
    const card = this.#cardId ? game.messages.get(this.#cardId) : null;
    const cards = game.messages.contents.filter(isDifficultyCard).reverse().map(m => ({
      value: m.id, label: game.i18n.format("CORTEX.Contest.Start.CardOption", { speaker: m.alias, total: m.system.resolution.total }),
      selected: m.id === card?.id
    }));
    const level = card ? difficultyLevelOfPool(card.system.pool).value : null;
    const controlled = canvas.ready ? canvas.tokens.controlled.map(t => t.actor).filter(Boolean) : [];
    const ownActor = controlled.find(a => a.isOwner) ?? (game.user.character?.isOwner ? game.user.character : null);
    const targeted = [...game.user.targets][0]?.actor ?? null;
    const otherUser = card && !card.author?.isGM ? card.author.id : "";

    const startActors = (isGM ? game.actors.contents : game.actors.filter(a => a.isOwner));
    const otherActors = game.actors.filter(a => a.visible);
    if ( targeted && !otherActors.includes(targeted) ) otherActors.push(targeted);
    const actorOptions = (actors, selected) => [
      { value: "", label: game.i18n.localize("CORTEX.Contest.Start.NoActor"), selected: !selected },
      ...actors.map(a => ({ value: a.uuid, label: a.name, selected: a === selected }))
    ];
    const userOptions = selected => [
      { value: "", label: game.i18n.localize("CORTEX.Contest.Start.GMSide"), selected: !selected },
      ...game.users.filter(u => !u.isGM).map(u => ({ value: u.id, label: u.name, selected: u.id === selected }))
    ];

    return {
      isGM,
      types: [
        { value: "test", label: game.i18n.localize("CORTEX.Contest.Card.Test"), selected: true },
        { value: "contest", label: game.i18n.localize("CORTEX.Contest.Card.Contest"), selected: false }
      ],
      startUsers: isGM ? userOptions("") : null,
      startActors: actorOptions(startActors, isGM ? (controlled[0] ?? null) : ownActor),
      otherUsers: userOptions(otherUser),
      otherActors: actorOptions(otherActors, targeted),
      cards: [{ value: "", label: game.i18n.localize("CORTEX.Contest.Start.TypedDifficulty"), selected: !card }, ...cards],
      levels: [
        { value: "", label: game.i18n.localize("CORTEX.Contest.Start.NoLevel"), selected: !level },
        ...DIFFICULTY_LEVELS.map(l => ({
          value: l, label: game.i18n.localize(`CORTEX.Contest.DifficultyLevels.${l}`), selected: l === level
        }))
      ],
      buttons: [{ type: "submit", icon: "fa-solid fa-scale-balanced", label: "CORTEX.Contest.Start.Submit" }]
    };
  }

  /**
   * Keeps the form in step as it is filled in: the difficulty fields belong to a test only, the
   * typed number only without a card, and picking a card pre-selects the level its pool was built
   * for (difficultyLevelOfPool), which the user may still change.
   * @override
   */
  _onChangeForm(formConfig, event) {
    super._onChangeForm(formConfig, event);
    const form = this.element;
    const isTest = form.querySelector('[name="type"]').value === "test";
    form.querySelector(".cp-test-only").hidden = !isTest;
    const cardId = form.querySelector('[name="cardId"]').value;
    form.querySelector(".cp-typed-only").hidden = !!cardId;
    form.querySelector(".cp-card-only").hidden = !cardId;
    if ( event.target?.name === "cardId" ) {
      const card = game.messages.get(cardId);
      form.querySelector('[name="difficultyLevel"]').value = card ? (difficultyLevelOfPool(card.system.pool).value ?? "") : "";
    }
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    this._onChangeForm(this.options.form, new Event("change"));
  }

  /**
   * One side of the request: the actor's name as its label, otherwise the user's name, otherwise
   * the GM's side.
   * @param {string} key
   * @param {string|null} userId
   * @param {string} actorUuid - "" for none
   * @returns {{key: string, userId: string|null, actorUuid: string|null, label: string}}
   */
  static #side(key, userId, actorUuid) {
    const actor = actorUuid ? fromUuidSync(actorUuid) : null;
    const label = actor?.name ?? game.users.get(userId)?.name ?? game.i18n.localize("CORTEX.Contest.Start.GMSide");
    return { key, userId, actorUuid: actorUuid || null, label };
  }

  /**
   * The "start" request for the form's values. A player's starting side is always their own; the
   * relay checks everything again.
   * @param {object} data - the form's values (FormDataExtended#object)
   * @returns {object}
   */
  static buildRequest(data) {
    const type = data.type === "contest" ? "contest" : "test";
    const [startKey, otherKey] = type === "test" ? TEST_SIDES : CONTEST_SIDES;
    const startUser = game.user.isGM ? (data.startUser || null) : game.user.id;
    const request = {
      action: "start", type,
      sides: [StartContestDialog.#side(startKey, startUser, data.startActor), StartContestDialog.#side(otherKey, data.otherUser || null, data.otherActor)]
    };
    if ( game.user.isGM ) request.highStakes = data.highStakes === true;
    if ( type === "test" ) {
      if ( data.cardId ) {
        request.difficultyMessageId = data.cardId;
        request.difficultyLevel = data.difficultyLevel || null;
      }
      else request.difficulty = data.difficulty ?? null;
    }
    return request;
  }

  /**
   * Sends the request; on success closes the dialog and, when the user acts for the starting side
   * (its user, or a GM for the GM's side), opens the pool builder aimed at its first roll.
   * @this {StartContestDialog}
   * @param {SubmitEvent} _event
   * @param {HTMLFormElement} _form
   * @param {FormDataExtended} formData
   */
  static async #onSubmit(_event, _form, formData) {
    const request = StartContestDialog.buildRequest(formData.object);
    const result = await sendContestRequest(request);
    if ( !notifyContestResult(result) ) return;
    await this.close();
    const starting = request.sides[0];
    const mine = (starting.userId === game.user.id) || ((starting.userId === null) && game.user.isGM);
    if ( mine ) await openPoolBuilderFor({ messageId: result.value.messageId, side: starting.key, rollIndex: 0 });
  }
}
