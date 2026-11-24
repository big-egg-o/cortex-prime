/**
 * The temporary trait store as a world setting's data model (Decisions ADR-057): every asset and
 * complication of the world, the scene boosts of signature assets, the GM's table-visible notes and
 * the actions already done. The schema mirrors TraitStore in module/rules/trait-store.mjs; what a
 * valid store is (each trait through checkTemporaryTrait, notes only for stored traits) is decided
 * by the pure checkTraitStore, which validateJoint runs. An actor holder is the actor's UUID, so two
 * unlinked copies of one opponent keep separate traits. Nothing here decides an outcome.
 * @module data/settings/temporary-traits
 */

import { checkTraitStore } from "../../rules/trait-store.mjs";
import { DIE_SIZES } from "../../rules/types.mjs";
import { checkMigrations, defineMigrations, migrateSourceInPlace } from "../migration-runner.mjs";

const { ArrayField, BooleanField, NumberField, ObjectField, SchemaField, StringField } = foundry.data.fields;

/** The current schema version of the store. */
export const TRAIT_STORE_SCHEMA_VERSION = 1;

/** Migrations of the stored data; version 1 is the first schema. */
export const TRAIT_STORE_MIGRATIONS = defineMigrations([]);

if ( checkMigrations(TRAIT_STORE_MIGRATIONS).value !== TRAIT_STORE_SCHEMA_VERSION ) {
  throw new Error("TRAIT_STORE_SCHEMA_VERSION must match the last temporary trait store migration");
}

/** @returns {foundry.data.fields.StringField} a string that may be absent (null) */
function optionalString() {
  return new StringField({ required: true, nullable: true, blank: false, initial: null });
}

/** @returns {Record<string, foundry.data.fields.DataField>} one TemporaryTrait (rules/assets.mjs) */
function traitSchema() {
  return {
    id: new StringField({ required: true, blank: false }),
    kind: new StringField({ required: true, blank: false }),
    name: new StringField({ required: true, blank: false }),
    dice: new ArrayField(new NumberField({ required: true, nullable: false, choices: [...DIE_SIZES] })),
    holder: new SchemaField({
      kind: new StringField({ required: true, choices: ["actor", "scene", "unassigned"], initial: "unassigned" }),
      // The holder's actor UUID: Actor.<id> for a world actor, Scene.<id>.Token.<id>.Actor.<id> for an unlinked token.
      actorId: new StringField({ required: false, nullable: false, blank: false, initial: undefined })
    }),
    origin: new StringField({ required: true, blank: false }),
    duration: optionalString(),
    access: new StringField({ required: true, choices: ["holder", "open"], initial: "holder" }),
    sceneSteps: new NumberField({ required: true, nullable: false, integer: true, min: 0, initial: 0 }),
    beyondD12: new BooleanField({ required: true, initial: false }),
    borrowedFrom: new SchemaField({
      actorId: new StringField({ required: true, blank: false }),
      traitId: new StringField({ required: true, blank: false })
    }, { required: true, nullable: true, initial: null })
  };
}

/**
 * The stored store. Read it as plain data with toStore(), which is what the pure functions take.
 */
export default class TraitStoreData extends foundry.abstract.DataModel {

  /**
   * Keeps a stored store that fails a check as stored and marks the model invalid, instead of
   * letting Foundry replace whole lists with their initial values (as GameConfigData does).
   * @override
   */
  static fromSource(source, context = {}) {
    return super.fromSource(source, { fallback: false, ...context });
  }

  /** @override */
  static defineSchema() {
    return {
      schemaVersion: new NumberField({
        required: true, nullable: false, integer: true, min: 1, initial: TRAIT_STORE_SCHEMA_VERSION
      }),
      revision: new NumberField({ required: true, nullable: false, integer: true, min: 0, initial: 0 }),
      traits: new ArrayField(new SchemaField(traitSchema())),
      sceneBoosts: new ArrayField(new SchemaField({
        actorId: new StringField({ required: true, blank: false }),
        traitId: new StringField({ required: true, blank: false }),
        steps: new NumberField({ required: true, nullable: false, integer: true, min: 1, initial: 1 })
      })),
      // Trait id to its table-visible note; checkTraitStore checks the keys and lengths.
      notes: new ObjectField({ required: true, initial: {} }),
      completedActions: new ArrayField(new SchemaField({
        actionId: new StringField({ required: true, blank: false }),
        userId: new StringField({ required: true, blank: false }),
        revision: new NumberField({ required: true, nullable: false, integer: true, min: 0, initial: 0 })
      }))
    };
  }

  /** @override */
  static migrateData(source, options) {
    super.migrateData(source, options);
    return migrateSourceInPlace(source, TRAIT_STORE_MIGRATIONS, { partial: options?.partial === true });
  }

  /**
   * The pure checkTraitStore on the cleaned source; throws so that game.settings.set refuses a
   * store that fails it.
   * @override
   */
  static validateJoint(data) {
    const result = checkTraitStore(toStore(data));
    if ( !result.ok ) throw new Error(`temporary trait store: ${result.code}`);
  }

  /** @returns {import("../../rules/trait-store.mjs").TraitStore} the stored data as the pure functions take it */
  toStore() {
    return toStore(this.toObject());
  }
}

/**
 * The plain store from stored data: holders without an absent actorId key, the schema version left out.
 * @param {object} data
 * @returns {import("../../rules/trait-store.mjs").TraitStore}
 */
export function toStore(data) {
  return {
    revision: data.revision,
    traits: (data.traits ?? []).map(t => ({
      ...t,
      holder: t.holder?.kind === "actor" ? { kind: "actor", actorId: t.holder.actorId } : { kind: t.holder?.kind }
    })),
    sceneBoosts: data.sceneBoosts ?? [],
    notes: data.notes ?? {},
    completedActions: data.completedActions ?? []
  };
}
