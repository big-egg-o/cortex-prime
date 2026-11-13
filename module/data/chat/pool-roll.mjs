/**
 * ChatMessage sub-type "poolRoll": structured dice-pool roll data (Decisions ADR-010).
 * Field shapes mirror module/rules/types.mjs; this model only adds schema validation and
 * migration of stored data, never game logic.
 * @module data/chat/pool-roll
 */

import { DIE_SIZES } from "../../rules/types.mjs";

const { ArrayField, BooleanField, NumberField, SchemaField, StringField } = foundry.data.fields;

/**
 * The current poolRoll schema version. 2: effect dice have ids and kinds, and the Resolution
 * has consumedDieIds and nextEffectNumber (Decisions ADR-026). 3: the roll stores its pool's
 * warnings and unpriced traits (ADR-029 consequences, RQ-030).
 */
export const POOL_ROLL_SCHEMA_VERSION = 3;

/** Options for a field that stays absent until it is set. */
const OPTIONAL = Object.freeze({ required: false, nullable: false, initial: undefined });

/**
 * @param {unknown} value
 * @returns {boolean} whether value is a whole number from 1, checked without rounding (a
 *   NumberField with `integer` and `min` would round and clamp it while cleaning)
 */
function isCount(value) {
  return Number.isInteger(value) && (value >= 1);
}

/**
 * @returns {Record<string, DataField>} one warning about the pool's traits, as poolTraitCost and
 *   effectiveRating report it: a code and, where the warning has them, the set, actor and trait.
 *   A warning with a set also keeps that set's name as it was when the pool was rolled, so a
 *   later rename or removal of the set doesn't change the card (ADR-047)
 */
function warningSchema() {
  return {
    code: new StringField({ required: true, blank: false }),
    setId: new StringField({ ...OPTIONAL, blank: false }),
    setLabel: new StringField({ ...OPTIONAL, blank: false }),
    actorId: new StringField({ ...OPTIONAL, blank: false }),
    traitId: new StringField({ ...OPTIONAL, blank: false })
  };
}

/** @returns {Record<string, DataField>} the traits of one set with no defined price (RQ-030) */
function unpricedTraitsSchema() {
  return {
    setId: new StringField({ required: true, blank: false }),
    count: new NumberField({ required: true, nullable: false, initial: undefined, validate: isCount,
      validationError: "must be a whole number from 1" })
  };
}

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
 * Schema version 1 to 2 for one Resolution, in place (ADR-026): entries without an id get the
 * next `e<n>` in order, entries without a kind get one from their shape, a pending overflow's
 * effectIndex becomes the effectId of that entry, and missing consumedDieIds and
 * nextEffectNumber are filled in. Never overwrites a value that is already there.
 * @param {object} resolution - poolRoll source data, possibly from before version 2
 */
function migrateResolutionToV2(resolution) {
  const effectDice = resolution.effectDice;
  const numbered = effectDice.map(e => Number(/^e(\d+)$/.exec(e.id ?? "")?.[1] ?? 0));
  // New ids start after both the highest id present and any stored nextEffectNumber, so a
  // removed entry's id is never handed out again.
  let highest = Math.max(0, ...numbered, (resolution.nextEffectNumber ?? 1) - 1);
  for ( const entry of effectDice ) {
    if ( !entry.id ) {
      highest += 1;
      entry.id = `e${highest}`;
    }
    if ( !entry.kind ) {
      if ( entry.dieId ) entry.kind = "rolled";
      else if ( entry.isDefault && (entry.size === 4) ) entry.kind = "default";
      else if ( entry.isDefault ) entry.kind = "overflow";
    }
  }
  resolution.consumedDieIds ??= [];
  resolution.nextEffectNumber ??= highest + 1;

  const overflow = resolution.overflow;
  if ( overflow && (typeof overflow === "object") && !overflow.effectId && ("effectIndex" in overflow) ) {
    const entry = effectDice[overflow.effectIndex];
    if ( entry ) overflow.effectId = entry.id;
    delete overflow.effectIndex;
  }
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
      state: new StringField({ required: true, choices: ["rolled", "resolved"], initial: "rolled" }),
      // What the pool's traits warned of when it was rolled, kept as rolled so later sheet
      // changes don't alter the card (ADR-029 consequences), and the traits of a set that
      // allows no further trait, which have no defined price (RQ-030). Empty for a pool of
      // dice from no trait.
      warnings: new ArrayField(new SchemaField(warningSchema())),
      unpricedTraits: new ArrayField(new SchemaField(unpricedTraitsSchema()))
    };
  }

  /**
   * Brings stored data up to the current schema. Foundry runs this whenever source data is
   * cleaned: on world load, on create, and on every update, where the source is only the
   * partial change. So it goes by shape, never overwrites a value, and running it twice changes
   * nothing. A Resolution is migrated only when its effectDice are present and either an entry
   * has no id or the source says it is from before version 2; a source without schemaVersion
   * (a partial update) is treated as current (ADR-026).
   *
   * Version 2 to 3 (ADR-029 consequences, RQ-030) only raises the version of a source that says
   * it is older: a message rolled before warnings were stored gets empty `warnings` and
   * `unpricedTraits` lists from the schema's initial values when it is cleaned, not from this
   * step, which never fills in defaults: Foundry also runs this on partial update data, which
   * must stay partial, so a step that filled them could overwrite stored lists (see the notes in
   * module/data/migration-runner.mjs).
   * @override
   * @param {object} source
   * @returns {object} the same source, migrated in place
   */
  static migrateData(source) {
    super.migrateData(source);
    const old = (source.schemaVersion !== undefined) && (source.schemaVersion < 2);
    const resolution = source.resolution;
    if ( resolution && (typeof resolution === "object") && Array.isArray(resolution.effectDice)
      && (old || resolution.effectDice.some(e => !e?.id)) ) {
      migrateResolutionToV2(resolution);
    }
    if ( old ) source.schemaVersion = 2;
    if ( (source.schemaVersion !== undefined) && (source.schemaVersion < 3) ) source.schemaVersion = 3;
    return source;
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
