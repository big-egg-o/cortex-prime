/**
 * The game configuration as a world setting's data model (Decisions ADR-030): trait sets and
 * actor kinds, one schema-validated DataModel with a schema version and migrations. The schema
 * mirrors the GameConfig shape in module/rules/types.mjs; what a valid configuration is (unique
 * ids, references that resolve) is decided by the pure validateGameConfig, which validateJoint
 * runs. Its warnings (no distinctions set, fewer than two prime sets) never make a configuration
 * invalid, so such a configuration saves and loads like any other (ADR-041 point 5). Nothing
 * here decides an outcome.
 * @module data/settings/game-config
 */

import {
  EXTRA_TRAIT_RULES, GAME_CONFIG_SCHEMA_VERSION, TRAIT_SET_FEATURES, TRAIT_SET_LISTS, TRAIT_SET_ROLES, validateGameConfig
} from "../../rules/game-config.mjs";
import { DIE_SIZES } from "../../rules/types.mjs";
import { checkMigrations, defineMigrations, migrateSourceInPlace } from "../migration-runner.mjs";

const { ArrayField, BooleanField, NumberField, SchemaField, StringField } = foundry.data.fields;
const { isValidId } = foundry.data.validators;

/** Migrations of the stored configuration; version 1 is the first schema. */
export const GAME_CONFIG_MIGRATIONS = defineMigrations([]);

// The schema version has two sources, the constant and the list; a step added without bumping
// the constant would make every stored configuration too new, so this fails at load instead.
if ( checkMigrations(GAME_CONFIG_MIGRATIONS).value !== GAME_CONFIG_SCHEMA_VERSION ) {
  throw new Error("GAME_CONFIG_SCHEMA_VERSION must match the last game configuration migration");
}

/** @returns {foundry.data.fields.StringField} a 16-character id */
function idField() {
  return new StringField({
    required: true, blank: false, validate: isValidId, validationError: "must be a 16-character alphanumeric id"
  });
}

/** @returns {foundry.data.fields.StringField} a name that isn't blank */
function nameField() {
  return new StringField({ required: true, blank: false, trim: true });
}

/**
 * @param {number[]} [choices] - the sizes allowed
 * @returns {foundry.data.fields.NumberField} a die size, or null for no value
 */
function sizeOrNullField(choices = DIE_SIZES) {
  return new NumberField({ required: true, nullable: true, initial: null, choices: [...choices] });
}

/** @returns {Record<string, foundry.data.fields.DataField>} one trait set (TraitSetDef) */
function traitSetSchema() {
  return {
    id: idField(),
    name: nameField(),
    role: new StringField({ required: true, choices: [...TRAIT_SET_ROLES], initial: "other" }),
    list: new StringField({ required: true, choices: [...TRAIT_SET_LISTS], initial: "open" }),
    // A fixed set's definitions; an open set keeps the list empty (ADR-034).
    traits: new ArrayField(new SchemaField({
      id: idField(),
      name: nameField(),
      description: new StringField({ required: false, blank: true })
    })),
    hasDice: new BooleanField({ required: true, initial: true }),
    multiDice: new BooleanField({ required: true, initial: false }),
    sameSizeDice: new BooleanField({ required: true, initial: false }),
    usualMin: sizeOrNullField(),
    usualMax: sizeOrNullField(),
    startingRating: sizeOrNullField(),
    fallbackDie: sizeOrNullField([4]),
    extraTraits: new StringField({ required: true, choices: [...EXTRA_TRAIT_RULES], initial: "pp" }),
    features: new SchemaField(Object.fromEntries(
      TRAIT_SET_FEATURES.map(feature => [feature, new BooleanField({ required: true, initial: false })])
    ))
  };
}

/** @returns {Record<string, foundry.data.fields.DataField>} one actor kind (ActorKindDef) */
function actorKindSchema() {
  return {
    id: idField(),
    name: nameField(),
    traitSetIds: new ArrayField(idField()),
    freeTraits: new BooleanField({ required: true, initial: false })
  };
}

/**
 * The stored game configuration. Read it as plain data with `toObject()`, which is what the pure
 * functions take. Keys the schema doesn't define are dropped when it is stored, so a later
 * version that adds a field needs a schema version and a migration.
 */
export default class GameConfigData extends foundry.abstract.DataModel {

  /**
   * Builds the model without Foundry's fallback: a stored configuration that fails a check is
   * kept as stored and the model is marked `invalid`, instead of having whole lists replaced by
   * their initial values (common/abstract/data.mjs constructor, `fallback: options.fallback ??
   * !strict`). A setting is cast with a non-strict fromSource (client/documents/setting.mjs).
   * @override
   */
  static fromSource(source, context = {}) {
    return super.fromSource(source, { fallback: false, ...context });
  }

  /** @override */
  static defineSchema() {
    return {
      schemaVersion: new NumberField({
        required: true, nullable: false, integer: true, min: 1, initial: GAME_CONFIG_SCHEMA_VERSION
      }),
      traitSets: new ArrayField(new SchemaField(traitSetSchema())),
      actorKinds: new ArrayField(new SchemaField(actorKindSchema()))
    };
  }

  /**
   * Brings a stored configuration up to the current schema (module/data/migration-runner.mjs).
   * @override
   * @param {object} source
   * @param {object} [options] - Foundry's cleaning options
   * @returns {object} the same source
   */
  static migrateData(source, options) {
    super.migrateData(source, options);
    // A setting always stores the whole configuration, so data without options is full data.
    return migrateSourceInPlace(source, GAME_CONFIG_MIGRATIONS, { partial: options?.partial === true });
  }

  /**
   * The checks that span fields: the pure validateGameConfig, on the cleaned source. Throws a
   * plain Error naming every error with its path; warnings are ignored here, because they never
   * make a configuration invalid (ADR-041 point 5). A stored configuration that fails loads as
   * stored with `invalid` set (see fromSource), so the GM's app can show its problems, and
   * `game.settings.set` refuses it, because settings assign DataModel values strictly
   * (client/helpers/client-settings.mjs, `#cleanJSON`).
   * @override
   * @param {object} data
   */
  static validateJoint(data) {
    const result = validateGameConfig(data);
    if ( !result.ok ) {
      throw new Error(`game configuration: ${result.errors.map(e => `${e.code} at ${e.path || "(root)"}`).join(", ")}`);
    }
  }
}
