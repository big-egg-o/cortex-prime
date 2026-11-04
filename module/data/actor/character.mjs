/**
 * Actor sub-type "character" (Decisions ADR-031): every actor is a character, and `kindId` names
 * its actor kind in the game configuration. Traits are plain data grouped by trait-set id
 * (ADR-032), and each rating is a list of dice (ADR-033). Loading checks the schema only
 * (ADR-037): shapes, die sizes and id formats. Loading never looks up the game configuration, so
 * a kind, set or definition id that matches nothing is kept as stored (TS-E03, TS-E04).
 *
 * Editing checks what changes against the current game configuration (ADR-037 points 2 and 3):
 * `_preUpdate` runs on every `Actor#update`, as the backstop behind our apps, which check before
 * writing themselves. The decision is the pure checkCharacterUpdate; this model only feeds it.
 *
 * This is the first slice of the M1 trait data: an entry holds only id, defId, name and dice.
 * The spec's other entry and set fields (preChallengeDice, challenged, statements, SFX, shut-down
 * flags, tags, sub-traits) need a later schema expansion. Until then Foundry's cleaning drops them
 * from anything written to a character, imports included, and it drops a set key that isn't a
 * 16-character id the same way.
 * @module data/actor/character
 */

import { ratingField } from "../fields/rating-field.mjs";
import { getGameConfig } from "../../config/settings.mjs";
import { checkCharacterUpdate, diffCharacterTraits } from "../../rules/traits.mjs";

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

  /**
   * Tells the pure update builder which values are Foundry's update operators
   * (common/data/operators.mjs).
   * @param {unknown} value
   * @returns {{deletion: true}|{replacement: unknown}|null}
   */
  static operatorOf(value) {
    const { DataFieldOperator, ForcedDeletion, ForcedReplacement } = foundry.data.operators;
    if ( value instanceof ForcedDeletion ) return { deletion: true };
    if ( value instanceof ForcedReplacement ) return { replacement: DataFieldOperator.get(value) };
    return null;
  }

  /**
   * The edit-time backstop (ADR-037 point 3): an update whose trait changes fail the checks
   * against the game configuration is cancelled as a whole, with the code shown as a
   * notification, instead of Foundry's silent drop of an invalid list entry. Foundry calls this
   * for a linked actor's update and for `token.actor.update` on an unlinked token alike
   * (client/documents/abstract/client-document.mjs `_preUpdate`); writes straight to a token's
   * delta don't come here (point 7). Only an operation whose action is "update" is checked;
   * what counts as loading gets no check (point 4): a replacing update (`recursive: false`, or a
   * forced replacement of the whole system data, which is what Foundry turns `recursive: false`
   * into) and the restore of an unlinked token's delta, which Foundry runs as a pre-update with
   * the base actor's data from a delete (client/documents/actor-delta.mjs `_preDelete`). Stored
   * data that is already malformed is left to Foundry's own checks, so a GM can still repair it
   * (`game.actors.getInvalid`); only new problems in a change are refused. Changes made later by
   * other modules' `preUpdateActor` hooks are not seen here (point 7).
   * @override
   * @param {object} changes - the cleaned changes to the actor
   * @param {object} options - the update operation's options
   * @param {foundry.documents.BaseUser} user
   * @returns {Promise<boolean|void>} false to cancel the update
   */
  async _preUpdate(changes, options, user) {
    const allowed = await super._preUpdate(changes, options, user);
    if ( allowed === false ) return false;
    if ( (options.recursive === false) || (options.action !== "update") ) return;
    if ( !("system" in changes) ) return;
    const current = this.toObject();
    if ( !diffCharacterTraits(current, current).ok ) return;
    const result = checkCharacterUpdate(current, changes.system, getGameConfig(), {
      operatorOf: CharacterData.operatorOf
    });
    if ( result.ok ) return;
    const key = `CORTEX.Character.Errors.${result.code}`;
    ui.notifications.error(game.i18n.has(key) ? game.i18n.localize(key) : result.code);
    return false;
  }

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
