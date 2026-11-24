/**
 * The GM's plot point overview (ADR-056; the Plot Points spec's 2026-11-20 layout direction): the
 * bank and every PC's balance in one window that works without tokens on a scene, with the
 * Start session action (P7). Every change goes through changePlotPoints and so is recorded.
 * @module apps/plot-points-app
 */

import { changePlotPoints, getBank, holdsPlotPoints, sessionCharacters, startPlotPointSession } from "../plot-points/accounts.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Shows a refused change as a notification. */
function report(result) {
  if ( result.ok ) return;
  const key = `CORTEX.PlotPoints.Errors.${result.code}`;
  ui.notifications.warn(game.i18n.has(key) ? game.i18n.localize(key) : result.code);
}

/**
 * @extends {foundry.applications.api.ApplicationV2}
 * @mixes HandlebarsApplicationMixin
 */
export default class PlotPointsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @override */
  static DEFAULT_OPTIONS = {
    id: "cortex-prime-plot-points",
    classes: ["cortex-prime", "plot-points"],
    window: { title: "CORTEX.PlotPoints.Title", icon: "fa-solid fa-coins", contentClasses: ["standard-form"] },
    position: { width: 340 },
    actions: {
      bankGain: () => changePlotPoints({ account: { kind: "bank" }, delta: 1, reason: "GM_ADJUST" }).then(report),
      bankSpend: () => changePlotPoints({ account: { kind: "bank" }, delta: -1, reason: "GM_ADJUST" }).then(report),
      award: (_e, t) => changePlotPoints({ account: { kind: "actor", actorId: t.dataset.actorId }, delta: 1, reason: "AWARD" })
        .then(report),
      adjustDown: (_e, t) => changePlotPoints({
        account: { kind: "actor", actorId: t.dataset.actorId }, delta: -1, reason: "GM_ADJUST"
      }).then(report),
      startSession: () => startPlotPointSession().then(report)
    }
  };

  /** @override */
  static PARTS = { body: { template: "systems/cortex-prime/templates/apps/plot-points.hbs" } };

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const assigned = new Set(sessionCharacters().map(a => a.id));
    const pcs = game.actors.filter(holdsPlotPoints)
      .map(a => ({ id: a.id, name: a.name, balance: a.system.plotPoints, assigned: assigned.has(a.id) }))
      .sort((a, b) => (b.assigned - a.assigned) || a.name.localeCompare(b.name));
    return Object.assign(context, { bank: getBank(), pcs, playerCount: assigned.size });
  }

  /** Renders the open window again after any balance changed. */
  static refresh() {
    const app = foundry.applications.instances.get("cortex-prime-plot-points");
    if ( app?.rendered ) app.render();
  }

  /** Opens the window for a GM. */
  static open() {
    if ( !game.user.isGM ) return;
    const app = foundry.applications.instances.get("cortex-prime-plot-points") ?? new PlotPointsApp();
    return app.render({ force: true });
  }
}
