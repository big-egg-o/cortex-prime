/**
 * The pool builder: an ApplicationV2 tool for assembling a dice pool by hand, independent of
 * any sheet (Decisions ADR-012, ADR-015), and the pool the character sheet's roll buttons fill
 * (ADR-016, ADR-049). Building, doubling and stepping dice all go through module/rules/;
 * removing a die or clearing a source is plain list editing, not a rule (nothing in the Dice &
 * Pools spec governs discarding a die that was never rolled).
 *
 * Traits come from character sheets through addTraitToPool: a trait is never in the pool twice,
 * and adding it again with another choice replaces its dice (Character Sheets CS-D8). The builder
 * shows what the pool's traits cost and warn of, works them out again when the pool is rolled and
 * stores them on the roll message (ADR-029, ADR-047), and once a challenged statement is rolled,
 * steps its trait down and takes its dice out of the kept pool (ADR-048). The decisions are the
 * pure functions of module/rules/pool-traits.mjs; this module reads and writes Foundry data.
 * @module apps/pool-builder
 */

import {
  DIE_SIZES, addTraitDice, buildPool, challengedPoolTraits, doubleDie, entriesAfterChallenge, poolDieGroupKey,
  poolTraitReport, poolTraits, rollablePool, stepPoolDie, traitPoolDice, withoutPoolTraits
} from "../rules/index.mjs";
import { getGameConfig } from "../config/settings.mjs";
import { postPoolRoll } from "../dice/post-pool-roll.mjs";
import { prepareNonstandard } from "../dice/pool-roll-card.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const FLAG_SCOPE = "cortex-prime";
const FLAG_KEY = "pool";
const TEMPLATE = "systems/cortex-prime/templates/apps/pool-builder.hbs";

/** @returns {import("../rules/types.mjs").PoolDie[]} the current user's pool (ADR-012) */
function userPool() {
  return game.user.getFlag(FLAG_SCOPE, FLAG_KEY) ?? [];
}

/**
 * The actor a pool trait belongs to: by its reference (the actor's uuid, which tells an unlinked
 * token's actor apart from its base actor), else by its id among the world's actors.
 * @param {{actorRef: string|null, actorId: string|null}} trait - from poolTraits
 * @returns {Actor|null}
 */
function findPoolActor({ actorRef, actorId }) {
  let actor = null;
  if ( actorRef?.includes(".") ) {
    try {
      actor = fromUuidSync(actorRef);
    }
    catch {
      actor = null;
    }
  }
  if ( !actor && actorId ) actor = game.actors.get(actorId) ?? null;
  return (actor?.documentName === "Actor") ? actor : null;
}

/**
 * The kind and stored trait data of every character whose traits are in a pool, by the pool's
 * actor reference, as poolTraitReport reads them. A character that can't be found is left out,
 * and its traits count without flags.
 * @param {import("../rules/types.mjs").PoolDie[]} pool
 * @returns {Record<string, {kindId: string|null, traits: object}>}
 */
function poolActorData(pool) {
  const data = {};
  const listed = poolTraits(pool);
  if ( !listed.ok ) return data;
  for ( const trait of listed.value ) {
    if ( !trait.actorRef || (trait.actorRef in data) ) continue;
    const actor = findPoolActor(trait);
    if ( actor?.type !== "character" ) continue;
    const system = actor.system.toObject();
    data[trait.actorRef] = { kindId: system.kindId, traits: system.traits };
  }
  return data;
}

/**
 * What a pool's traits cost and warn of now (poolTraitReport), or null when that can't be worked
 * out, for example when the game configuration can't be read; the pool can still be rolled, with
 * no warnings stored, and the console says why.
 * @param {import("../rules/types.mjs").PoolDie[]} pool
 * @returns {ReturnType<typeof poolTraitReport>["value"]|null}
 */
function currentPoolReport(pool) {
  let config;
  try {
    config = getGameConfig();
  }
  catch( err ) {
    console.error(err);
    return null;
  }
  const report = poolTraitReport(pool, poolActorData(pool), config);
  if ( report.ok ) return report.value;
  console.warn(`cortex-prime | The pool's traits couldn't be costed: ${report.code}`);
  return null;
}

/** Shows why a trait wasn't added or stepped down; always returns false. */
function refusePoolTrait(code) {
  const key = `CORTEX.Builder.Errors.${code}`;
  ui.notifications.warn(game.i18n.has(key) ? game.i18n.localize(key) : code);
  return false;
}

/**
 * Writes the step-down of every challenged statement in a pool that has just been rolled, and
 * takes their dice out of the user's kept pool so a re-roll can't reuse them (ADR-048). Each
 * write goes through Actor#update, where the character model's backstop checks it. A trait whose
 * actor can't be found, or that the user may no longer update, isn't stepped down and the user is
 * told; its dice still leave the pool.
 * @param {import("../rules/types.mjs").PoolDie[]} pool - the pool as it was rolled
 * @returns {Promise<boolean>} whether the pool had challenged traits
 */
async function stepDownChallenges(pool) {
  const challenged = challengedPoolTraits(pool);
  if ( !challenged.ok || !challenged.value.length ) return false;
  const config = getGameConfig();
  for ( const trait of challenged.value ) {
    const actor = findPoolActor(trait);
    if ( !actor ) {
      refusePoolTrait("ACTOR_NOT_FOUND");
      continue;
    }
    if ( !actor.isOwner ) {
      refusePoolTrait("CHALLENGE_NEEDS_OWNER");
      continue;
    }
    const entries = entriesAfterChallenge(actor.system.toObject(), config, trait.setId, trait.traitId);
    if ( !entries.ok ) {
      refusePoolTrait(entries.code);
      continue;
    }
    const updated = await actor.update({ [`system.traits.${trait.setId}.entries`]: entries.value });
    if ( updated ) ui.notifications.info(game.i18n.format("CORTEX.Builder.SteppedDown", { trait: trait.label }));
  }
  const kept = withoutPoolTraits(userPool(), challenged.value.map(trait => trait.key));
  if ( kept.ok ) await game.user.setFlag(FLAG_SCOPE, FLAG_KEY, kept.value);
  return true;
}

/**
 * Adds one custom die to a pool, continuing the pool's own id sequence (buildPool always
 * starts a fresh sequence at d1, which only works for a pool built from nothing at once).
 * @param {import("../rules/types.mjs").PoolDie[]} pool
 * @param {import("../rules/types.mjs").DieSize} size
 * @param {string} label
 * @returns {import("../rules/types.mjs").PoolDie[]}
 */
function appendCustomDie(pool, size, label) {
  const [die] = buildPool([{ size, source: { kind: "custom", label } }]);
  const highest = pool.reduce((max, d) => Math.max(max, Number(d.id.slice(1)) || 0), 0);
  return [...pool, { ...die, id: `d${highest + 1}` }];
}

/**
 * Groups a pool for display, in first-seen order: a trait's dice by their trait (so two actors'
 * traits of one name stay apart, RQ-031), any other dice by their label. A trait's group also
 * shows how it was added (Hinder or a challenge), Hinder's plot point, the hint for a distinction
 * already at d4 and whether its die is a fallback, and, when the pool holds traits of more than
 * one actor, its actor's current name.
 * @param {import("../rules/types.mjs").PoolDie[]} pool
 * @returns {{key: string, label: string, dice: import("../rules/types.mjs").PoolDie[],
 *   actorName?: string|null, option?: string|null, ppGained?: string|null, hint?: string|null,
 *   fallback?: boolean}[]}
 */
function groupBySource(pool) {
  const listed = poolTraits(pool);
  const traits = new Map((listed.ok ? listed.value : []).map(trait => [`trait:${trait.key}`, trait]));
  const severalActors = new Set([...traits.values()].map(trait => trait.actorRef)).size > 1;
  const groups = new Map();
  for ( const die of pool ) {
    const key = poolDieGroupKey(die);
    if ( !groups.has(key) ) groups.set(key, { key, label: die.source.label, dice: [] });
    groups.get(key).dice.push(die);
  }
  return Array.from(groups.values(), group => {
    const trait = traits.get(group.key);
    if ( !trait ) return group;
    return {
      ...group,
      actorName: severalActors ? (findPoolActor(trait)?.name ?? null) : null,
      option: trait.option ? game.i18n.localize(`CORTEX.Builder.Option.${trait.option}`) : null,
      ppGained: ((trait.option === "hinder") && (trait.ppGained > 0)) ? `+${trait.ppGained} PP` : null,
      hint: trait.hint ? game.i18n.localize(`CORTEX.Builder.Hints.${trait.hint}`) : null,
      fallback: trait.isFallback
    };
  });
}

/**
 * The builder's summary of what the pool's traits cost and warn of, with the same nonstandard
 * section the roll card will show (ADR-029, RQ-030): the cost in plot points, Hinder's plot points
 * (shown, never paid: ADR-014), and the reasons. A pool of dice from no trait has none, and a
 * pool whose only further traits have no defined price shows no bare "0 PP" (RQ-030).
 * @param {import("../rules/types.mjs").PoolDie[]} pool
 * @returns {{cost: string|null, hinderGain: string|null,
 *   nonstandard: ReturnType<typeof prepareNonstandard>}|null}
 */
function poolSummary(pool) {
  const report = currentPoolReport(pool);
  if ( !report || (report.traitCount === 0) ) return null;
  const unpricedOnly = (report.unpricedTraits.length > 0) && (report.ppCost === 0);
  return {
    cost: unpricedOnly ? null : game.i18n.format("CORTEX.Builder.Cost", { cost: report.ppCost }),
    hinderGain: report.ppGained ? game.i18n.format("CORTEX.Builder.HinderGain", { pp: report.ppGained }) : null,
    nonstandard: prepareNonstandard({ pool, warnings: report.warnings, unpricedTraits: report.unpricedTraits })
  };
}

/**
 * Assembles a dice pool by hand: add a custom die, double or step one, clear a source, then
 * roll it. The pool is kept in a flag on the current user (survives reload) rather than in
 * app state, so every action reads it fresh and writes it back.
 * @extends {foundry.applications.api.ApplicationV2}
 * @mixes HandlebarsApplicationMixin
 */
export default class PoolBuilder extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: "cortex-prime-pool-builder",
    tag: "div",
    classes: ["cortex-prime", "pool-builder"],
    window: { title: "CORTEX.Builder.Title", icon: "fa-solid fa-dice-d12", contentClasses: ["standard-form"] },
    position: { width: 400 },
    actions: {
      addDie: PoolBuilder.#onAddDie,
      removeDie: PoolBuilder.#onRemoveDie,
      clearGroup: PoolBuilder.#onClearGroup,
      doubleDie: PoolBuilder.#onDoubleDie,
      stepDie: PoolBuilder.#onStepDie,
      rollPool: PoolBuilder.#onRollPool
    }
  };

  /** @override */
  static PARTS = {
    body: { template: TEMPLATE },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /**
   * The pool, read fresh from the user flag every time — there is no cached copy to drift.
   * @returns {import("../rules/types.mjs").PoolDie[]}
   */
  get pool() {
    return userPool();
  }

  /**
   * Writes a new pool to the user flag, then re-renders.
   * @param {import("../rules/types.mjs").PoolDie[]} pool
   * @returns {Promise<void>}
   */
  async #savePool(pool) {
    await game.user.setFlag(FLAG_SCOPE, FLAG_KEY, pool);
    await this.render();
  }

  /** @override */
  async _prepareContext(_options) {
    const pool = this.pool;
    return {
      groups: groupBySource(pool),
      summary: poolSummary(pool),
      sizes: DIE_SIZES,
      buttons: [{
        type: "button", action: "rollPool", icon: "fa-solid fa-dice", label: "CORTEX.Builder.Roll",
        disabled: pool.length === 0
      }]
    };
  }

  /**
   * Rolls the current pool via postPoolRoll and keeps it — players often roll a similar pool
   * again. `results`, dev/test only, skips Foundry's dice the same way postPoolRoll's own
   * param does; the click action never passes it. What the pool's traits warn of and which have
   * no defined price are worked out from the actors' data now and stored on the message
   * (ADR-029 consequences, RQ-030, ADR-047); the dice are stored without the pool's trait marks
   * (rollablePool). Once the roll is posted, each challenged statement's trait is stepped down
   * and its dice leave the kept pool (ADR-048).
   * @param {number[]} [results]
   * @returns {Promise<ChatMessage|void>} nothing if the pool is empty
   */
  async rollPool(results) {
    const pool = this.pool;
    if ( pool.length === 0 ) return;
    const report = currentPoolReport(pool);
    const rollable = rollablePool(pool);
    const message = await postPoolRoll({
      pool: rollable.ok ? rollable.value : pool, results,
      warnings: report?.warnings ?? [], unpricedTraits: report?.unpricedTraits ?? []
    });
    if ( await stepDownChallenges(pool) ) await this.render();
    return message;
  }

  /**
   * Adds a custom die of the chosen size and label (rule 5; any die not tied to a trait or
   * asset rating is "custom" here). Public, and the only thing #onAddDie does beyond reading
   * the form, so Quench calls the exact code path a click does.
   * @param {import("../rules/types.mjs").DieSize} size
   * @param {string} label
   * @returns {Promise<void>}
   */
  async addDie(size, label) {
    const resolvedLabel = label.trim() || game.i18n.localize("CORTEX.Builder.CustomDieDefaultLabel");
    await this.#savePool(appendCustomDie(this.pool, size, resolvedLabel));
  }

  /**
   * Removes one die. Not a rule: nothing in the spec governs discarding an unrolled die.
   * @param {string} dieId
   * @returns {Promise<void>}
   */
  async removeDie(dieId) {
    await this.#savePool(this.pool.filter(d => d.id !== dieId));
  }

  /**
   * Removes every die of one group: one trait's dice, or the dice of one label (groupBySource).
   * @param {string} groupKey - from poolDieGroupKey
   * @returns {Promise<void>}
   */
  async clearGroup(groupKey) {
    await this.#savePool(this.pool.filter(d => poolDieGroupKey(d) !== groupKey));
  }

  /**
   * Doubles one die (rule 7).
   * @param {string} dieId
   * @returns {Promise<void>}
   */
  async doubleDie(dieId) {
    await this.#savePool(doubleDie(this.pool, dieId));
  }

  /**
   * Steps one die up or down (rule 2; a d4 stepped down is removed, rule 3; a d12 stepped up
   * adds an overflow d6 carrying the same source, rule 4).
   * @param {string} dieId
   * @param {number} steps
   * @returns {Promise<void>}
   */
  async stepDie(dieId, steps) {
    await this.#savePool(stepPoolDie(this.pool, dieId, steps));
  }

  /**
   * Reads the add-die form and delegates to addDie().
   * @this {PoolBuilder}
   */
  static async #onAddDie() {
    const sizeInput = this.element.querySelector('[name="size"]');
    const labelInput = this.element.querySelector('[name="label"]');
    await this.addDie(Number(sizeInput.value), labelInput.value);
    labelInput.value = "";
  }

  /**
   * @this {PoolBuilder}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static async #onRemoveDie(_event, target) {
    await this.removeDie(target.dataset.dieId);
  }

  /**
   * @this {PoolBuilder}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static async #onClearGroup(_event, target) {
    await this.clearGroup(target.dataset.groupKey);
  }

  /**
   * @this {PoolBuilder}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static async #onDoubleDie(_event, target) {
    await this.doubleDie(target.dataset.dieId);
  }

  /**
   * @this {PoolBuilder}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static async #onStepDie(_event, target) {
    await this.stepDie(target.dataset.dieId, Number(target.dataset.steps));
  }

  /**
   * @this {PoolBuilder}
   */
  static async #onRollPool() {
    await this.rollPool();
  }
}

/** @type {PoolBuilder|null} */
let instance = null;

/** Opens the pool builder, bringing it to front if already open, or closes it if it is. */
export function togglePoolBuilder() {
  if ( instance?.rendered ) {
    instance.close();
    return;
  }
  instance ??= new PoolBuilder();
  instance.render({ force: true });
}

/**
 * Where to open the builder so that it doesn't cover a window: to its right if the screen has
 * room, else to its left, else wherever the builder would open anyway.
 * @param {foundry.applications.api.ApplicationV2} app
 * @returns {{left?: number, top?: number}}
 */
function positionBeside(app) {
  const { left, top, width } = app.position;
  const builderWidth = PoolBuilder.DEFAULT_OPTIONS.position.width;
  const gap = 8;
  if ( ![left, top, width].every(Number.isFinite) ) return {};
  if ( left + width + gap + builderWidth <= window.innerWidth ) return { left: left + width + gap, top };
  if ( left - gap - builderWidth >= 0 ) return { left: left - gap - builderWidth, top };
  return {};
}

/**
 * Opens the pool builder, or renders it again and brings it to front if it is open already.
 * Opened from a sheet, it opens beside that sheet, so the sheet's next button stays in reach.
 * @param {{beside?: foundry.applications.api.ApplicationV2}} [options]
 * @returns {Promise<PoolBuilder>}
 */
export async function openPoolBuilder({ beside } = {}) {
  instance ??= new PoolBuilder();
  const options = { force: true };
  if ( !instance.rendered && beside?.rendered ) options.position = positionBeside(beside);
  await instance.render(options);
  instance.bringToFront();
  return instance;
}

/**
 * Adds a trait of an actor to the current user's pool, whichever actor it belongs to, and opens
 * the pool builder (Character Sheets behaviours 20, 21 and 24; ADR-016, ADR-049). The character
 * sheet's add, Hinder and challenge buttons call this. The dice and whether the option exists for
 * the trait come from traitPoolDice; a trait already in the pool is replaced by the new choice,
 * and the same choice again changes nothing (CS-D8). A challenge needs a user who can update the
 * actor, since its step-down is written after the roll (ADR-048). A refusal is shown as a
 * notification and leaves the pool as it was.
 * @param {Actor} actor - a "character" actor, world or unlinked token
 * @param {string} setId
 * @param {string} traitId - a fixed set's definition id or an open set's entry id
 * @param {"hinder"|"challenge"|null} [option]
 * @param {{beside?: foundry.applications.api.ApplicationV2}} [options] - the sheet the builder
 *   opens beside
 * @returns {Promise<boolean>} whether the trait is in the pool afterwards
 */
export async function addTraitToPool(actor, setId, traitId, option = null, { beside } = {}) {
  if ( (option === "challenge") && !actor.isOwner ) return refusePoolTrait("CHALLENGE_NEEDS_OWNER");
  let config;
  try {
    config = getGameConfig();
  }
  catch( err ) {
    console.error(err);
    return refusePoolTrait("INVALID_GAME_CONFIG");
  }
  const dice = traitPoolDice(actor.system.toObject(), config, setId, traitId, { actorId: actor.id, option });
  if ( !dice.ok ) return refusePoolTrait(dice.code);
  const added = addTraitDice(userPool(), dice.value, { actorRef: actor.uuid });
  if ( !added.ok ) return refusePoolTrait(added.code);
  if ( added.value.changed ) await game.user.setFlag(FLAG_SCOPE, FLAG_KEY, added.value.pool);
  await openPoolBuilder({ beside });
  return true;
}
