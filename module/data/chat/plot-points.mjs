/**
 * ChatMessage sub-type "plotPoints": one entry of the plot point ledger (Decisions ADR-056, the
 * Plot Points spec's P3). Every change of a PC's or the bank's balance posts one, with the account,
 * the change, the reason and the balance it left. The balances stay the source of truth; this is
 * the record. A GM adjustment is marked so the card can tell it apart from play.
 * @module data/chat/plot-points
 */

import { PP_REASONS } from "../../rules/plot-points.mjs";

const { BooleanField, NumberField, SchemaField, StringField } = foundry.data.fields;

/** The current schema version of a ledger entry. */
export const PLOT_POINTS_SCHEMA_VERSION = 1;

/**
 * @param {number} min
 * @returns {foundry.data.fields.NumberField} a whole number from min
 */
function wholeField(min) {
  return new NumberField({ required: true, nullable: false, integer: true, min, initial: min });
}

/** System data for a ledger entry. */
export default class PlotPointsData extends foundry.abstract.TypeDataModel {
  /** @override */
  static defineSchema() {
    return {
      schemaVersion: new NumberField({
        required: true, nullable: false, integer: true, min: 1, initial: PLOT_POINTS_SCHEMA_VERSION
      }),
      account: new SchemaField({
        kind: new StringField({ required: true, choices: ["actor", "bank"], initial: "actor" }),
        actorId: new StringField({ required: false, nullable: true, blank: false, initial: null }),
        // The actor's name when the entry was made, so a later rename or deletion keeps the record readable.
        name: new StringField({ required: true, blank: true, initial: "" })
      }),
      delta: new NumberField({ required: true, nullable: false, integer: true, initial: 0 }),
      balance: wholeField(0),
      reason: new StringField({ required: true, choices: Object.keys(PP_REASONS), initial: "GM_ADJUST" }),
      label: new StringField({ required: false, blank: true, initial: "" }),
      // The roll card or contest card the change belongs to, if any (PP-E10: kept after it's deleted).
      messageRef: new StringField({ required: false, nullable: true, blank: false, initial: null }),
      adjustment: new BooleanField({ required: true, initial: false })
    };
  }
}
