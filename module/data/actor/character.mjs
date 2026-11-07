/**
 * Actor sub-type "character" (Decisions ADR-031): every actor is a character, and `kindId` names
 * its actor kind in the game configuration. Traits are plain data grouped by trait-set id
 * (ADR-032), and each rating is a list of dice (ADR-033). Loading checks the schema only
 * (ADR-037): shapes, die sizes and id formats. Loading never looks up the game configuration, so
 * a kind, set or definition id that matches nothing is kept as stored (TS-E03, TS-E04).
 *
 * Editing checks what changes against the current game configuration (ADR-037 points 2 and 3):
 * `_preUpdate` runs on every `Actor#update`, as the backstop behind our apps, which check before
 * writing themselves. The decision is the pure checkCharacterUpdate; this model only feeds it. It
 * also refuses a die size that doesn't exist in a preChallengeDice or a sub-trait's rating that
 * the edit sets (TS-E01), which Foundry would otherwise drop without an error.
 *
 * The fields follow the Traits & Trait Sets spec's data shapes. A set holds its shut-down flag and
 * its entries; an entry holds its id, definition id, name and rating, and may hold a description,
 * a statement and its challenge, SFX, tags, sub-traits and a shut-down reason. Free traits hold an
 * id, a name and a rating, which may be several dice (a boss's trait, ADR-040). Fields the spec
 * marks optional stay absent until set, never null or "": the pure statement functions read an
 * absent `challenged` or `shutDown` as "no", and remove them when a challenge is resolved.
 * Booleans are never converted (StrictBooleanField). Foundry's cleaning drops anything else, and a
 * set key that isn't a 16-character id.
 *
 * The fields added after schema version 1 are all optional or have a default that cleaning fills
 * in when an actor loads, so actors stored before them load unchanged and no migration step is
 * needed (a step must never fill defaults: module/data/migration-runner.mjs). The version stays 1.
 * @module data/actor/character
 */

import { ratingField } from "../fields/rating-field.mjs";
import StrictBooleanField from "../fields/strict-boolean-field.mjs";
import { getGameConfig } from "../../config/settings.mjs";
import { SHUT_DOWN_REASONS } from "../../rules/statements.mjs";
import { checkCharacterUpdate, diffCharacterTraits, validateEntryFields } from "../../rules/traits.mjs";

const { ArrayField, NumberField, SchemaField, StringField, TypedObjectField } = foundry.data.fields;
const { isValidId } = foundry.data.validators;

/** Options for a field that stays absent until it is set (the spec's optional fields). */
const OPTIONAL = Object.freeze({ required: false, nullable: false, initial: undefined });

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

/** @returns {Record<string, DataField>} one SFX: text only in M1, locked or unlocked (ADR-035) */
function sfxSchema() {
  return {
    text: new StringField({ required: true, blank: true, initial: "" }),
    // No default: no rule says whether a new SFX starts locked, so the writer must say.
    unlocked: new StrictBooleanField({ required: true, initial: undefined })
  };
}

/** @returns {Record<string, DataField>} a trait attached to a trait, such as a specialty (rule 19) */
function subTraitSchema() {
  return {
    id: idField(),
    name: new StringField({ required: true, blank: true, initial: "" }),
    dice: ratingField()
  };
}

/** @returns {Record<string, DataField>} one trait in a set (the spec's data shapes) */
function traitEntrySchema() {
  return {
    id: idField(),
    // The definition in a fixed set; null in an open set (ADR-034).
    defId: idField({ nullable: true, initial: null }),
    // The trait's name in an open set; in a fixed set a snapshot kept as fallback data.
    name: new StringField({ required: true, blank: true, initial: "" }),
    dice: ratingField(),
    // A distinction's descriptive line, a talent's description (rules 13 and 20).
    description: new StringField({ ...OPTIONAL, blank: true }),
    // (MOD) Trait Statements (rule 16): the statement, whether it is challenged and not yet
    // resolved, and the rating from before the first unresolved challenge (RQ-022).
    statement: new StringField({ ...OPTIONAL, blank: true }),
    challenged: new StrictBooleanField({ ...OPTIONAL }),
    preChallengeDice: ratingField({ ...OPTIONAL }),
    sfx: new ArrayField(new SchemaField(sfxSchema())),
    // Plain-text tags, such as a resource's or an ability's (rules 18 and 20).
    tags: new ArrayField(new StringField({ required: true, blank: true }), { ...OPTIONAL }),
    sub: new ArrayField(new SchemaField(subTraitSchema()), { ...OPTIONAL }),
    // Shut down by hand, or by a challenge of a d4 trait (rule 15, RQ-021).
    shutDown: new SchemaField(
      { reason: new StringField({ required: true, choices: SHUT_DOWN_REASONS }) },
      { ...OPTIONAL }
    )
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
   * into and which counts as replacing under ADR-043, so checkCharacterUpdate passes it; a forced
   * replacement of only part of the system data is an edit and is checked) and the restore of an
   * unlinked token's delta, which Foundry runs as a pre-update with the base actor's data from a
   * delete (client/documents/actor-delta.mjs `_preDelete`). Stored data that is already malformed
   * is left to Foundry's own checks, so a GM can still repair it (`game.actors.getInvalid`); only
   * new problems in a change are refused. Changes made later by other modules' `preUpdateActor`
   * hooks are not seen here (point 7).
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
    if ( !diffCharacterTraits(current, current).ok || !validateEntryFields(current, current).ok ) return;
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
        new SchemaField({
          // The whole set shut down, a flag set and cleared by hand (rule 15).
          shutDown: new StrictBooleanField({ required: true, initial: false }),
          entries: new ArrayField(new SchemaField(traitEntrySchema()))
        }),
        { validateKey: isValidId }
      ),
      freeTraits: new ArrayField(new SchemaField(freeTraitSchema()))
    };
  }
}
