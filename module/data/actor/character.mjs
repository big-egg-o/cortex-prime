/**
 * Actor sub-type "character" (Decisions ADR-031): every actor is a character, and `kindId` names
 * its actor kind in the game configuration. Traits are plain data grouped by trait-set id
 * (ADR-032), and each rating is a list of dice (ADR-033). Loading checks the schema only
 * (ADR-037): shapes, die sizes and id formats. Nothing here looks up the game configuration, so a
 * kind, set or definition id that matches nothing is kept as stored (TS-E03, TS-E04).
 *
 * This is the first slice of the M1 trait data: an entry holds only id, defId, name and dice.
 * The spec's other entry and set fields (preChallengeDice, challenged, statements, SFX, shut-down
 * flags, tags, sub-traits) need a later schema expansion. Until then Foundry's cleaning drops them
 * from anything written to a character, imports included, and it drops a set key that isn't a
 * 16-character id the same way.
 * @module data/actor/character
 */

import { ratingField } from "../fields/rating-field.mjs";

const { ArrayField, NumberField, SchemaField, StringField, TypedObjectField } = foundry.data.fields;
const { isValidId } = foundry.data.validators;

/** The current character schema version. */
export const CHARACTER_SCHEMA_VERSION = 1;

/**
 * An id in Foundry's 16-character alphanumeric format, as foundry.utils.randomID() makes them. Used
 * for kinds, trait sets, definitions and entries alike.
 * @param {object} [options] - StringField options that replace the defaults
 * @returns {foundry.data.fields.StringField}
 */
function idField(options = {}) {
  return new StringField({
    required: true, blank: false, validate: isValidId, validationError: "must be a 16-character alphanumeric id",
    ...options
  });
}

/** @returns {Record<string, DataField>} one trait in a set */
function traitEntrySchema() {
  return {
    id: idField(),
    // The definition in a fixed set; null in an open set (ADR-034).
    defId: idField({ nullable: true, initial: null }),
    // The trait's name in an open set; in a fixed set a snapshot kept as fallback data.
    name: new StringField({ required: true, blank: true, initial: "" }),
    dice: ratingField()
  };
}

/** @returns {Record<string, DataField>} one free trait, which belongs to no set (TS-22) */
function freeTraitSchema() {
  return {
    id: idField(),
    name: new StringField({ required: true, blank: true, initial: "" }),
    dice: ratingField()
  };
}

/**
 * System data for a "character" actor: its kind, its traits by set, and its free traits.
 */
export default class CharacterData extends foundry.abstract.TypeDataModel {

  /** @override */
  static defineSchema() {
    return {
      schemaVersion: new NumberField({
        required: true, nullable: false, integer: true, min: 1, initial: CHARACTER_SCHEMA_VERSION
      }),
      // Null until a kind is assigned.
      kindId: idField({ nullable: true, initial: null }),
      traits: new TypedObjectField(
        new SchemaField({ entries: new ArrayField(new SchemaField(traitEntrySchema())) }),
        { validateKey: isValidId }
      ),
      freeTraits: new ArrayField(new SchemaField(freeTraitSchema()))
    };
  }
}
