/**
 * Versioned migrations of stored source data (Development Environment, data safety: every
 * migration is versioned, idempotent and tested). A model lists its migrations, one per schema
 * version from 2 up, and its static migrateData calls migrateSourceInPlace. Pure: no Foundry
 * globals and imports only from module/rules/, like the contest mapping, so it is unit-tested in
 * Node and checked by tests/unit/rules-boundary.test.mjs.
 *
 * How Foundry 14.369 calls migrateData decides what a step must cope with:
 * - It runs on world load (full stored data), on creation and on every update (partial data,
 *   `options.partial` true), and several times per clean (common/data/fields.mjs `TypeDataField`
 *   and `DataModelSchemaField` `_migrate`), so a step also sees data it has already migrated.
 * - It migrates in memory only. An update writes only what differs from the in-memory source,
 *   which already carries the new version, so the stored `schemaVersion` stays old until a full
 *   write, and every later load runs the same steps again on stored data that may now mix old
 *   and new keys.
 * Each step must therefore be idempotent on its own: change only what is still in the old shape,
 * never overwrite a value already in the new shape, and never fill in defaults (partial data
 * must stay partial; cleaning fills defaults). The version only says which steps may apply.
 * Three limits follow: a step that changes what a value means without changing its key or shape
 * can't be written this way; an optional new key that is later removed comes back from a stale
 * old key on the next load; and both stay possible until something writes the whole document
 * with its new version, which nothing here does.
 *
 * A model calls it as `static migrateData(source, options) { return migrateSourceInPlace(source,
 * MIGRATIONS, options); }`, passing Foundry's options on: they say whether the data is partial.
 * @module data/migration-runner
 */

import { fail, ok } from "../rules/result.mjs";

/**
 * One step: turns data of schema version `version - 1` into version `version`. It gets a copy of
 * the plain parts of the data, which it may change, and returns the new data, which the runner
 * copies again. Values that aren't plain objects or arrays (Foundry's update operators, for
 * instance) are shared, not copied: a step must leave them as they are, and change only plain
 * values. The data may be partial, and may already be partly in the new shape (see the module
 * notes). The runner sets `schemaVersion` afterwards.
 * @typedef {{version: number, migrate: (source: object) => object}} Migration
 */

/**
 * A refusal, with the step that failed and the error it threw where there is one.
 * @typedef {{ok: false, code: string, version?: number, cause?: unknown}} MigrationFailure
 */

/** @returns {boolean} whether value is a plain object, not an array, class instance or null */
function isPlainObject(value) {
  if ( (value === null) || (typeof value !== "object") ) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype) || (proto === null);
}

/**
 * A deep copy of plain data: objects and arrays are copied, anything else is shared.
 * @param {unknown} value
 * @returns {unknown}
 */
function copyPlain(value) {
  if ( Array.isArray(value) ) return value.map(copyPlain);
  if ( isPlainObject(value) ) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copyPlain(v)]));
  return value;
}

/**
 * Checks a model's list of migrations: version 1 is the first schema and has none; after that
 * one migration per version, counting up from 2 without gaps.
 * @param {unknown} migrations
 * @returns {import("../rules/types.mjs").EngineResult<number>} the current schema version (the
 *   last migration's, or 1); refuses with INVALID_MIGRATIONS
 */
export function checkMigrations(migrations) {
  if ( !Array.isArray(migrations) ) return fail("INVALID_MIGRATIONS");
  for ( let i = 0; i < migrations.length; i++ ) {
    const step = migrations[i];
    if ( !isPlainObject(step) || (step.version !== i + 2) || (typeof step.migrate !== "function") ) {
      return fail("INVALID_MIGRATIONS");
    }
  }
  return ok(migrations.length + 1);
}

/**
 * Checks a model's list of migrations once, where the model defines it, and freezes it. A list
 * that doesn't count up from version 2 is a programming error, so this throws.
 * @param {Migration[]} migrations
 * @returns {readonly Migration[]}
 */
export function defineMigrations(migrations) {
  if ( !checkMigrations(migrations).ok ) throw new Error("migrations must count up from version 2 without gaps");
  return Object.freeze(migrations.map(step => Object.freeze({ ...step })));
}

/**
 * The stored schema version: a whole number from 1; a string of digits without a leading zero
 * counts as that number (only hand-edited data holds one: Foundry stores numbers); a missing or
 * undefined value is null. Anything else, null included, is refused.
 * @param {object} source
 * @returns {number|null|undefined} null for no version, undefined for one that isn't valid
 */
function storedVersion(source) {
  const value = source.schemaVersion;
  if ( value === undefined ) return null;
  const number = ((typeof value === "string") && /^[1-9]\d*$/.test(value)) ? Number(value) : value;
  return (Number.isInteger(number) && (number >= 1)) ? number : undefined;
}

/**
 * Brings source data up to the current schema version: each step whose version is above the
 * stored one runs in order, on a copy, and `schemaVersion` is set to the step's version after it.
 * Data without a version is partial update or creation data when `partial` is true, and is left
 * as it is (cleaning sets the current version on creation); full data without a version
 * (`partial` false, as on world load) predates the field and starts from version 1. Never changes
 * its inputs, and makes no copy when no step applies.
 * @param {unknown} source
 * @param {readonly Migration[]} migrations
 * @param {{partial: boolean}} options - Foundry's cleaning options, as migrateData receives
 *   them; `partial` is required, so a model that forgets to pass them is refused instead of
 *   silently treating full data as partial
 * @returns {import("../rules/types.mjs").EngineResult<{source: object, from: number|null,
 *   to: number, applied: number[]}>|MigrationFailure} `source` is the input itself when
 *   `applied` is empty, otherwise a migrated copy; `from` is null for data without a version.
 *   Refuses, in this order: INVALID_MIGRATIONS, INVALID_MIGRATION_OPTIONS (no boolean
 *   `partial`), INVALID_SOURCE (not a plain object),
 *   INVALID_SCHEMA_VERSION, SCHEMA_VERSION_TOO_NEW (stored by a newer version of the system),
 *   MIGRATION_FAILED (a step threw, with the error as `cause`, or returned something that isn't
 *   a plain object; with the step's `version`)
 */
export function runMigrations(source, migrations, options) {
  const current = checkMigrations(migrations);
  if ( !current.ok ) return current;
  const partial = options?.partial;
  if ( typeof partial !== "boolean" ) return fail("INVALID_MIGRATION_OPTIONS");
  if ( !isPlainObject(source) ) return fail("INVALID_SOURCE");
  const stored = storedVersion(source);
  if ( stored === undefined ) return fail("INVALID_SCHEMA_VERSION");
  if ( (stored === null) && partial ) return ok({ source, from: null, to: current.value, applied: [] });
  const from = stored ?? 1;
  if ( from > current.value ) return fail("SCHEMA_VERSION_TOO_NEW");
  if ( from === current.value ) return ok({ source, from: stored, to: current.value, applied: [] });

  let data = copyPlain(source);
  const applied = [];
  for ( const step of migrations ) {
    if ( step.version <= from ) continue;
    let next;
    try {
      next = step.migrate(data);
    }
    catch( err ) {
      return { ok: false, code: "MIGRATION_FAILED", version: step.version, cause: err };
    }
    if ( !isPlainObject(next) ) return { ok: false, code: "MIGRATION_FAILED", version: step.version };
    data = { ...copyPlain(next), schemaVersion: step.version };
    applied.push(step.version);
  }
  return ok({ source: data, from: stored, to: current.value, applied });
}

/**
 * For a data model's static migrateData, which Foundry expects to change the source it is given
 * and return it: runs runMigrations and writes the result into the same object, removing keys
 * the migration dropped and writing `schemaVersion` last. All or nothing: when the migration is
 * refused, or the source can't take the result (MIGRATION_NOT_WRITABLE: a key to add to an object
 * that can't be extended, a key to remove that can't be deleted, or a key to change that can't be
 * written, as on a sealed or frozen object), the source is left exactly as it was. A refusal goes
 * to `onFailure` when one is given; otherwise this throws an Error with the code and the step's
 * error as its cause, which Foundry's migrateDataSafe catches and logs (once per call, and
 * Foundry calls migrateData more than once per clean). Data a step left behind keeps loading,
 * but cleaning then drops keys the current schema doesn't know.
 *
 * Not covered: an unlinked token's actor delta stores `system` as a plain object field
 * (common/documents/actor-delta.mjs), and the synthetic actor is built from the base actor's data
 * merged with the delta, which carries the base actor's version, so a delta's values in an old
 * shape skip every step and are then dropped by cleaning.
 * @param {object} source
 * @param {readonly Migration[]} migrations
 * @param {{partial: boolean, onFailure?: (failure: MigrationFailure) => void}} options -
 *   Foundry's cleaning options (only `partial` is read) and the failure callback
 * @returns {object} the same source object
 */
export function migrateSourceInPlace(source, migrations, options) {
  const onFailure = options?.onFailure;
  const report = failure => {
    if ( onFailure ) return onFailure(failure);
    throw new Error(`migration refused: ${failure.code}${failure.version ? ` at version ${failure.version}` : ""}`,
      { cause: failure.cause });
  };
  const result = runMigrations(source, migrations, options);
  if ( !result.ok ) {
    report(result);
    return source;
  }
  if ( !result.value.applied.length ) return source;

  const migrated = result.value.source;
  const removed = Object.keys(source).filter(key => !Object.hasOwn(migrated, key));
  const added = Object.keys(migrated).filter(key => !Object.hasOwn(source, key));
  const descriptor = key => Object.getOwnPropertyDescriptor(source, key);
  const writable = Object.keys(migrated).every(key => !Object.hasOwn(source, key) || descriptor(key).writable);
  const deletable = removed.every(key => descriptor(key).configurable);
  if ( (added.length && !Object.isExtensible(source)) || !deletable || !writable ) {
    report({ ok: false, code: "MIGRATION_NOT_WRITABLE", version: result.value.applied.at(-1) });
    return source;
  }
  for ( const key of removed ) delete source[key];
  for ( const [key, value] of Object.entries(migrated) ) if ( key !== "schemaVersion" ) source[key] = value;
  source.schemaVersion = migrated.schemaVersion;
  return source;
}
