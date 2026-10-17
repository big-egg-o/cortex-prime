/**
 * The pool builder: an ApplicationV2 tool for assembling a dice pool by hand, independent of
 * any sheet (Decisions ADR-012, ADR-015; M2 adds a roll button on the character sheet).
 * Building, doubling and stepping dice all go through module/rules/; removing a die or
 * clearing a source is plain list editing, not a rule (nothing in the Dice & Pools spec
 * governs discarding a die that was never rolled).
 * @module apps/pool-builder
 */

import { DIE_SIZES, buildPool, doubleDie, stepPoolDie } from "../rules/index.mjs";
import { postPoolRoll } from "../dice/post-pool-roll.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const FLAG_SCOPE = "cortex-prime";
const FLAG_KEY = "pool";
const TEMPLATE = "systems/cortex-prime/templates/apps/pool-builder.hbs";

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
 * Groups a pool by source label, in first-seen order, for display.
 * @param {import("../rules/types.mjs").PoolDie[]} pool
 * @returns {{label: string, dice: import("../rules/types.mjs").PoolDie[]}[]}
 */
function groupBySource(pool) {
  const bySourceLabel = new Map();
  for ( const die of pool ) {
    if ( !bySourceLabel.has(die.source.label) ) bySourceLabel.set(die.source.label, []);
    bySourceLabel.get(die.source.label).push(die);
  }
  return Array.from(bySourceLabel, ([label, dice]) => ({ label, dice }));
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
    window: { title: "CORTEX.Builder.Title", icon: "fa-solid fa-dice-d12" },
    position: { width: 420 },
    actions: {
      addDie: PoolBuilder.#onAddDie,
      removeDie: PoolBuilder.#onRemoveDie,
      clearSource: PoolBuilder.#onClearSource,
      doubleDie: PoolBuilder.#onDoubleDie,
      stepDie: PoolBuilder.#onStepDie,
      rollPool: PoolBuilder.#onRollPool
    }
  };

  /** @override */
  static PARTS = {
    builder: { template: TEMPLATE, root: true }
  };

  /**
   * The pool, read fresh from the user flag every time — there is no cached copy to drift.
   * @returns {import("../rules/types.mjs").PoolDie[]}
   */
  get pool() {
    return game.user.getFlag(FLAG_SCOPE, FLAG_KEY) ?? [];
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
      sizes: DIE_SIZES,
      canRoll: pool.length > 0
    };
  }

  /**
   * Rolls the current pool via postPoolRoll and keeps it — players often roll a similar pool
   * again. `results`, dev/test only, skips Foundry's dice the same way postPoolRoll's own
   * param does; the click action never passes it.
   * @param {number[]} [results]
   * @returns {Promise<ChatMessage|void>} nothing if the pool is empty
   */
  async rollPool(results) {
    if ( this.pool.length === 0 ) return;
    return postPoolRoll({ pool: this.pool, results });
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
   * Removes every die from one source.
   * @param {string} sourceLabel
   * @returns {Promise<void>}
   */
  async clearSource(sourceLabel) {
    await this.#savePool(this.pool.filter(d => d.source.label !== sourceLabel));
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
  static async #onClearSource(_event, target) {
    await this.clearSource(target.dataset.sourceLabel);
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
