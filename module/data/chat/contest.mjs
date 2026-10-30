/**
 * ChatMessage sub-type "contest": the state of one test or contest, updated in place as it goes on
 * (Decisions ADR-020, Step 4.4 S1 proposal review). `system.flow` is a TypedSchemaField whose
 * variants, `test` and `contest`, each build their own field instances; Foundry adds `flow.type`.
 * The engine fields keep the names of the engine's TestState, ContestState and ContestRoll, and the
 * pure mapping in contest-mapping.mjs converts between the two. The schema version, the revision,
 * who started it and the sides sit outside `flow`, because they aren't engine state.
 *
 * Field options: numbers that come from the engine are checked with a `validate` function instead
 * of `integer` and `min`, so cleaning never rounds or clamps them; die sizes use `choices`, ids use
 * isValidId. Flow fields have no `initial`: on create, a missing field that can't be empty is
 * refused, and Foundry 14.369 fills a missing field that may be empty with null (or a missing list
 * with an empty one), which checkCandidate refuses. Every BooleanField in the flow sets
 * `initial: undefined`, so a missing flag never reads as false. `hasRolled` is keyed by side key; a
 * recursive update can add keys to it but never remove them.
 *
 * validateJoint checks structure only, never an outcome rule: side keys, the turn and the winner,
 * each roll's side, and the ids inside each roll. World load is strict in Foundry 14.369
 * (client/documents/abstract/document-collection.mjs, DocumentCollection#_initialize): a message
 * that fails validation is hidden after a reload but stays in the database. Any later, stricter
 * check therefore needs a schema version bump and a migration in migrateData.
 *
 * In 14.369 an update with an invalid entry in a list keeps that list's old value and saves the
 * rest without an error, so writers run checkCandidate before every create and update.
 * @module data/chat/contest
 */

import { CONTEST_SIDES, DIE_SIZES, DIFFICULTY_LEVELS, TEST_SIDES } from "../../rules/index.mjs";
import CheckedTypedSchemaField from "../fields/checked-typed-schema-field.mjs";
import { CONTEST_SCHEMA_VERSION, FLOW_TYPES } from "./contest-mapping.mjs";

export { CONTEST_SCHEMA_VERSION } from "./contest-mapping.mjs";

const {
  ArrayField, BooleanField, DocumentUUIDField, NumberField, SchemaField, StringField, TypedObjectField
} = foundry.data.fields;
const { isValidId } = foundry.data.validators;

/**
 * An id in Foundry's 16-character format: a user, or a chat message.
 * @param {{nullable?: boolean}} [options]
 * @returns {foundry.data.fields.StringField}
 */
function idField({ nullable = false } = {}) {
  return new StringField({
    required: true, nullable, blank: false, validate: isValidId,
    validationError: "must be a 16-character alphanumeric id"
  });
}

/**
 * A whole number from `min` that comes from the engine. The check is a `validate` function rather
 * than `integer` and `min`, which would round or clamp the value while cleaning.
 * @param {number} min
 * @param {{nullable?: boolean}} [options]
 * @returns {foundry.data.fields.NumberField}
 */
function wholeField(min, { nullable = false } = {}) {
  return new NumberField({
    required: true, nullable, validate: value => Number.isInteger(value) && (value >= min),
    validationError: `must be a whole number of ${min} or more`
  });
}

/**
 * A whole number that may be negative, such as a failed test's margin.
 * @param {{nullable?: boolean}} [options]
 * @returns {foundry.data.fields.NumberField}
 */
function integerField({ nullable = false } = {}) {
  return new NumberField({
    required: true, nullable, validate: value => Number.isInteger(value), validationError: "must be a whole number"
  });
}

/**
 * A flag with no initial value, so a missing one is never read as false.
 * @param {{nullable?: boolean}} [options]
 * @returns {foundry.data.fields.BooleanField}
 */
function flagField({ nullable = false } = {}) {
  return new BooleanField({ required: true, nullable, initial: undefined });
}

/** @returns {foundry.data.fields.NumberField} a die size: 4, 6, 8, 10 or 12 */
function sizeField() {
  return new NumberField({ required: true, nullable: false, choices: DIE_SIZES });
}

/**
 * A non-blank string, such as a side key or an effect id.
 * @param {{nullable?: boolean}} [options]
 * @returns {foundry.data.fields.StringField}
 */
function keyField({ nullable = false } = {}) {
  return new StringField({ required: true, nullable, blank: false });
}

/** @returns {Record<string, foundry.data.fields.DataField>} an effect die as it stands (ContestEffect) */
function effectSchema() {
  return { id: keyField(), size: sizeField() };
}

/** @returns {Record<string, foundry.data.fields.DataField>} an effect die past d12 and its choice (ContestOverflow) */
function overflowSchema() {
  return {
    effectId: keyField(),
    cause: new StringField({ required: true, choices: ["heroic", "other"] }),
    kind: new StringField({ required: true, nullable: true, choices: ["leftover", "new-d6", "take-out"] }),
    dieId: keyField({ nullable: true })
  };
}

/** @returns {Record<string, foundry.data.fields.DataField>} an eligible leftover die of a roll */
function leftoverSchema() {
  return { dieId: keyField(), size: sizeField() };
}

/** @returns {Record<string, foundry.data.fields.DataField>} a stored roll: a ContestRoll plus its sender */
function rollSchema() {
  return {
    side: keyField(),
    total: wholeField(0),
    effects: new ArrayField(new SchemaField(effectSchema())),
    overflows: new ArrayField(new SchemaField(overflowSchema())),
    leftovers: new ArrayField(new SchemaField(leftoverSchema())),
    nextEffectNumber: wholeField(1),
    messageRef: idField({ nullable: true }),
    userId: idField()
  };
}

/** @returns {Record<string, foundry.data.fields.DataField>} one side of a test or contest */
function sideSchema() {
  return {
    key: keyField(),
    userId: idField({ nullable: true }),
    actorUuid: new DocumentUUIDField({ type: "Actor" }),
    label: new StringField({ required: true, blank: true })
  };
}

/** @returns {Record<string, foundry.data.fields.DataField>} the contest variant of the flow (ContestState) */
function contestFlowSchema() {
  return {
    highStakes: flagField(),
    rolls: new ArrayField(new SchemaField(rollSchema())),
    difficulty: wholeField(0, { nullable: true }),
    turn: keyField({ nullable: true }),
    status: new StringField({ required: true, choices: ["open", "won", "gaveIn", "declined"] }),
    winner: keyField({ nullable: true }),
    hasRolled: new TypedObjectField(flagField()),
    margin: integerField({ nullable: true }),
    heroicSteps: wholeField(0),
    heroicAppliedTo: keyField({ nullable: true }),
    closed: flagField(),
    usedAgainstLoser: new ArrayField(keyField(), { nullable: true })
  };
}

/** @returns {Record<string, foundry.data.fields.DataField>} the test variant of the flow (TestState) */
function testFlowSchema() {
  return {
    highStakes: flagField(),
    difficulty: wholeField(0),
    roll: new SchemaField(rollSchema(), { nullable: true }),
    success: flagField({ nullable: true }),
    margin: integerField({ nullable: true }),
    heroicSteps: wholeField(0),
    heroicAppliedTo: keyField({ nullable: true }),
    closed: flagField(),
    difficultyLevel: new StringField({ required: true, nullable: true, choices: DIFFICULTY_LEVELS }),
    difficultyMessageRef: idField({ nullable: true }),
    oppositionEffects: new ArrayField(new SchemaField(effectSchema()))
  };
}

/**
 * Whether two lists of keys hold the same keys, ignoring order.
 * @param {string[]} actual
 * @param {readonly string[]} expected
 * @returns {boolean}
 */
function sameKeys(actual, expected) {
  return (actual.length === expected.length) && expected.every(key => actual.includes(key));
}

/**
 * The first id that appears twice in a list, or undefined.
 * @param {string[]} ids
 * @returns {string|undefined}
 */
function duplicateOf(ids) {
  return ids.find((id, i) => ids.indexOf(id) !== i);
}

/**
 * Structured data for a contest chat message: a test against a difficulty, or a contest between two
 * sides (ADR-020, ADR-027).
 */
export default class ContestData extends foundry.abstract.TypeDataModel {

  /**
   * Top level: schemaVersion, revision, startedBy, sides and flow. A test's flow holds the TestState
   * fields plus difficultyLevel, difficultyMessageRef and oppositionEffects; a contest's flow holds
   * the ContestState fields plus usedAgainstLoser. A stored roll is a ContestRoll plus its sender's
   * userId.
   * @override
   */
  static defineSchema() {
    return {
      schemaVersion: new NumberField({
        required: true, nullable: false, integer: true, min: 1, initial: CONTEST_SCHEMA_VERSION
      }),
      revision: wholeField(0),
      startedBy: idField(),
      sides: new ArrayField(new SchemaField(sideSchema())),
      flow: new CheckedTypedSchemaField({ test: testFlowSchema(), contest: contestFlowSchema() })
    };
  }

  /**
   * Brings stored data up to the current schema. Foundry runs this on world load, on create and on
   * every update, where the source is only the partial change, so a source without schemaVersion
   * is treated as current. Schema version 1 has nothing to migrate.
   * @override
   * @param {object} source
   * @returns {object} the same source
   */
  static migrateData(source) {
    super.migrateData(source);
    return source;
  }

  /**
   * Checks of structure that span fields, each throwing a plain Error: (J1) side keys are unique
   * and, in M3, exactly CONTEST_SIDES or TEST_SIDES; (J2) a contest's turn and winner are null or a
   * side key; (J3) every roll's side is a side key; (J4) a contest's hasRolled keys are exactly the
   * side keys; (J5) within a roll, effect ids and leftover die ids are unique; (J6) within a roll,
   * each overflow names one of its effects, and dieId is set exactly when the choice is a leftover.
   * A flow of an unknown type is skipped: its own field check refuses it.
   * @override
   * @param {object} data - the full system source
   */
  static validateJoint(data) {
    const flow = data.flow;
    if ( !FLOW_TYPES.includes(flow?.type) ) return;
    const isContest = flow.type === "contest";
    const keys = (data.sides ?? []).map(side => side.key);

    // J1: the sides
    const repeated = duplicateOf(keys);
    if ( repeated !== undefined ) throw new Error(`contest: the side key "${repeated}" is used twice`);
    const expected = isContest ? CONTEST_SIDES : TEST_SIDES;
    if ( !sameKeys(keys, expected) ) {
      throw new Error(`contest: a ${flow.type} has the sides ${expected.join(" and ")}, not ${keys.join(", ") || "none"}`);
    }

    // J2: the turn and the winner
    if ( isContest ) {
      for ( const name of ["turn", "winner"] ) {
        const value = flow[name];
        if ( (value !== null) && !keys.includes(value) ) throw new Error(`contest: the ${name} "${value}" is not a side`);
      }
    }

    // J3: each roll's side
    const rolls = isContest ? (flow.rolls ?? []) : (flow.roll ? [flow.roll] : []);
    const nameOf = i => (isContest ? `roll ${i + 1}` : "the test's roll");
    rolls.forEach((roll, i) => {
      if ( !keys.includes(roll.side) ) throw new Error(`contest: ${nameOf(i)} has the side "${roll.side}", which is not a side`);
    });

    // J4: hasRolled
    if ( isContest && !sameKeys(Object.keys(flow.hasRolled ?? {}), keys) ) {
      throw new Error("contest: the keys of hasRolled must be the side keys");
    }

    // J5: unique ids within a roll
    rolls.forEach((roll, i) => {
      const effectId = duplicateOf((roll.effects ?? []).map(effect => effect.id));
      if ( effectId !== undefined ) throw new Error(`contest: ${nameOf(i)} has the effect id "${effectId}" twice`);
      const dieId = duplicateOf((roll.leftovers ?? []).map(leftover => leftover.dieId));
      if ( dieId !== undefined ) throw new Error(`contest: ${nameOf(i)} has the leftover die "${dieId}" twice`);
    });

    // J6: each overflow names one of its roll's effects, and a die only for a leftover
    rolls.forEach((roll, i) => {
      for ( const overflow of roll.overflows ?? [] ) {
        if ( !(roll.effects ?? []).some(effect => effect.id === overflow.effectId) ) {
          throw new Error(`contest: ${nameOf(i)} has an overflow for "${overflow.effectId}", which is not one of its effects`);
        }
        if ( (overflow.kind === "leftover") !== (overflow.dieId !== null) ) {
          throw new Error(`contest: ${nameOf(i)} has an overflow for "${overflow.effectId}" whose die doesn't match its choice`);
        }
      }
    });
  }

  /**
   * Whether `source` would be stored exactly as given: builds a strict throwaway instance from a
   * copy and compares its toObject() with the source (foundry.utils.equals). That catches data the
   * schema or validateJoint refuses, and anything cleaning would change, such as "13" becoming 13 or
   * a missing userId becoming null. Writers run it before every create and update, and report
   * WRITE_FAILED when it gives a reason.
   * @param {object} source - a complete system source, e.g. a stored source with one write's changes
   * @returns {string|null} null when the source is stored unchanged; otherwise the validation error's
   *   message, or "the data would change when stored"
   */
  static checkCandidate(source) {
    let candidate;
    try {
      candidate = new this(foundry.utils.deepClone(source), { strict: true });
    } catch ( err ) {
      return err.message;
    }
    return foundry.utils.equals(candidate.toObject(), source) ? null : "the data would change when stored";
  }
}
