/**
 * ChatMessage sub-type "poolRoll": structured dice-pool roll data (Decisions ADR-010).
 * Field shapes mirror module/rules/types.mjs; this model only adds schema validation and
 * (eventually) migration, never game logic.
 * @module data/chat/pool-roll
 */

import { DIE_SIZES } from "../../rules/types.mjs";

const { ArrayField, BooleanField, NumberField, SchemaField, StringField } = foundry.data.fields;

/**
 * The current poolRoll schema version. 2: effect dice have ids and kinds, and the Resolution
 * has consumedDieIds and nextEffectNumber (Decisions ADR-026).
 */
export const POOL_ROLL_SCHEMA_VERSION = 2;

/** @returns {Record<string, import("../../../reference/foundry-14.369/common/data/fields.mjs").DataField>} */
function dieSourceSchema() {
  return {
    kind: new StringField({ required: true, blank: false }),
    actorId: new StringField({ required: false, nullable: true, initial: null, blank: false }),
    traitId: new StringField({ required: false, nullable: true, initial: null, blank: false }),
    label: new StringField({ required: true, blank: false })
  };
}

/** @returns {Record<string, DataField>} fields shared by every unrolled pool die */
function poolDieSchema() {
  return {
    id: new StringField({ required: true, blank: false }),
    size: new NumberField({ required: true, integer: true, choices: DIE_SIZES }),
    source: new SchemaField(dieSourceSchema()),
    origin: new StringField({ required: true, choices: ["rating", "doubled", "bonus", "overflow"] })
  };
}

/** @returns {Record<string, DataField>} a PoolDie plus its rolled result */
function rolledDieSchema() {
  return {
    ...poolDieSchema(),
    result: new NumberField({ required: true, integer: true, min: 1 }),
    hitch: new BooleanField({ required: true, initial: false }),
    state: new StringField({
      required: true, choices: ["available", "unavailable", "hitch-activated"], initial: "available"
    })
  };
}

/** @returns {Record<string, DataField>} the roller's picks for one roll */
function selectionSchema() {
  return {
    totalIds: new ArrayField(new StringField({ blank: false })),
    effectDieIds: new ArrayField(new StringField({ blank: false })),
    extraResultsPaid: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    extraEffectDicePaid: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    keepLimit: new NumberField({ required: true, integer: true, min: 1, initial: 2 })
  };
}

/** @returns {Record<string, DataField>} one effect die in a Resolution */
function effectDieEntrySchema() {
  return {
    id: new StringField({ required: true, blank: false }),
    kind: new StringField({ required: true, choices: ["rolled", "default", "overflow"] }),
    size: new NumberField({ required: true, integer: true, choices: DIE_SIZES }),
    dieId: new StringField({ required: false, nullable: true, initial: null, blank: false }),
    isDefault: new BooleanField({ required: true, initial: false })
  };
}

/** @returns {Record<string, DataField>} the offered choices for an effect die past d12 */
function overflowOptionsSchema() {
  return {
    cause: new StringField({ required: true, choices: ["heroic", "other"] }),
    leftovers: new ArrayField(new SchemaField({
      dieId: new StringField({ required: true, blank: false }),
      size: new NumberField({ required: true, integer: true, choices: DIE_SIZES })
    })),
    newDie: new NumberField({ required: true, choices: [6], initial: 6 }),
    takeOutAvailable: new BooleanField({ required: true, initial: true })
  };
}

/** @returns {Record<string, DataField>} a pending overflow choice for one effect die */
function overflowSignalSchema() {
  return {
    effectId: new StringField({ required: true, blank: false }),
    cause: new StringField({ required: true, choices: ["heroic", "other"] }),
    options: new SchemaField(overflowOptionsSchema())
  };
}

/** @returns {Record<string, DataField>} the outcome of a validated Selection */
function resolutionSchema() {
  return {
    total: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    totalIds: new ArrayField(new StringField({ blank: false })),
    effectDice: new ArrayField(new SchemaField(effectDieEntrySchema())),
    consumedDieIds: new ArrayField(new StringField({ blank: false })),
    nextEffectNumber: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
    hitchIds: new ArrayField(new StringField({ blank: false })),
    botch: new BooleanField({ required: true, initial: false }),
    takeOut: new BooleanField({ required: true, initial: false }),
    overflow: new SchemaField(overflowSignalSchema(), { nullable: true, initial: null })
  };
}

/**
 * Structured data for a poolRoll chat message: the pool, rolled dice, the roller's selection
 * and the Resolution once resolved (Decisions ADR-010). The Foundry Roll objects for the roll
 * record and Dice So Nice stay on the message itself (Decisions ADR-009 points 1-4).
 */
export default class PoolRollData extends foundry.abstract.TypeDataModel {

  /** @override */
  static defineSchema() {
    return {
      schemaVersion: new NumberField({ required: true, integer: true, initial: POOL_ROLL_SCHEMA_VERSION }),
      pool: new ArrayField(new SchemaField(poolDieSchema())),
      rolled: new ArrayField(new SchemaField(rolledDieSchema())),
      selection: new SchemaField(selectionSchema()),
      resolution: new SchemaField(resolutionSchema(), { nullable: true, initial: null }),
      state: new StringField({ required: true, choices: ["rolled", "resolved"], initial: "rolled" })
    };
  }

  /**
   * Checks that span more than one field (rule 1, DP-12): a rolled die's result must not
   * exceed its own size, and a "resolved" state needs a resolution to go with it.
   * @override
   */
  static validateJoint(data) {
    for ( const die of data.rolled ) {
      if ( die.result > die.size ) {
        throw new Error(`pool-roll: rolled die "${die.id}" has result ${die.result} on a d${die.size}`);
      }
    }
    if ( (data.state === "resolved") && (data.resolution === null) ) {
      throw new Error('pool-roll: state "resolved" requires a resolution');
    }
  }
}
