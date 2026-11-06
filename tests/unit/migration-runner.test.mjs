import { describe, expect, it } from "vitest";
import {
  checkMigrations, defineMigrations, migrateSourceInPlace, runMigrations
} from "../../module/data/migration-runner.mjs";

/**
 * Version 2 renames `hp` to `health`; version 3 turns a `tag` string into a `tags` list. Both are
 * written the way the module requires: they change only what is still in the old shape, never
 * overwrite the new shape, and add nothing to partial data.
 */
const FULL = Object.freeze({ partial: false });
const PARTIAL = Object.freeze({ partial: true });

const MIGRATIONS = defineMigrations([
  {
    version: 2,
    migrate(source) {
      // Only a plain old value is moved; an operator (e.g. a forced deletion in update data) stays.
      if ( typeof source.hp !== "number" ) return source;
      if ( !("health" in source) ) source.health = source.hp;
      delete source.hp;
      return source;
    }
  },
  {
    version: 3,
    migrate(source) {
      if ( typeof source.tag !== "string" ) return source;
      if ( !("tags" in source) ) source.tags = [source.tag];
      delete source.tag;
      return source;
    }
  }
]);

describe("checkMigrations and defineMigrations", () => {
  it("give the current version: the last migration's, or 1 with none", () => {
    expect(checkMigrations(MIGRATIONS)).toEqual({ ok: true, value: 3 });
    expect(checkMigrations([])).toEqual({ ok: true, value: 1 });
  });

  it("refuse a list that doesn't count up from version 2 one at a time", () => {
    const migrate = s => s;
    for ( const list of [
      [{ version: 1, migrate }],
      [{ version: 3, migrate }],
      [{ version: 2, migrate }, { version: 4, migrate }],
      [{ version: 2, migrate }, { version: 2, migrate }],
      [{ version: 2.5, migrate }],
      null, [{ version: 2 }], [null]
    ] ) {
      expect(checkMigrations(list)).toEqual({ ok: false, code: "INVALID_MIGRATIONS" });
      expect(() => defineMigrations(list ?? [{ version: 9, migrate }])).toThrow();
    }
  });

  it("defineMigrations freezes the list and its steps", () => {
    expect(Object.isFrozen(MIGRATIONS)).toBe(true);
    expect(Object.isFrozen(MIGRATIONS[0])).toBe(true);
  });
});

describe("runMigrations", () => {
  it("brings version-1 data to the current version, one step at a time, recording each", () => {
    expect(runMigrations({ schemaVersion: 1, hp: 5, tag: "a" }, MIGRATIONS, FULL)).toEqual({
      ok: true, value: { source: { schemaVersion: 3, health: 5, tags: ["a"] }, from: 1, to: 3, applied: [2, 3] }
    });
  });

  it("starts from the stored version and skips the steps already applied", () => {
    expect(runMigrations({ schemaVersion: 2, health: 5, tag: "a" }, MIGRATIONS, PARTIAL).value)
      .toEqual({ source: { schemaVersion: 3, health: 5, tags: ["a"] }, from: 2, to: 3, applied: [3] });
  });

  it("returns current data itself, with nothing applied and nothing copied", () => {
    const source = { schemaVersion: 3, health: 5 };
    const result = runMigrations(source, MIGRATIONS, PARTIAL);
    expect(result.value).toEqual({ source, from: 3, to: 3, applied: [] });
    expect(result.value.source).toBe(source);
  });

  it("stored data that mixes old and new keys keeps the new values (the stored version stays old)", () => {
    // Foundry migrates in memory only, so a store that went through an update can hold both shapes.
    const stored = { schemaVersion: 1, hp: 5, health: 6, tag: "a", tags: ["b"] };
    expect(runMigrations(stored, MIGRATIONS, FULL).value.source)
      .toEqual({ schemaVersion: 3, health: 6, tags: ["b"] });
  });

  it("migrating twice gives the same data as once", () => {
    const once = runMigrations({ schemaVersion: 1, hp: 5 }, MIGRATIONS, FULL).value.source;
    expect(runMigrations({ ...once, schemaVersion: 1 }, MIGRATIONS, FULL).value.source).toEqual(once);
  });

  it("leaves partial data without a version alone, because it is update or creation data", () => {
    const partial = { hp: 7 };
    const result = runMigrations(partial, MIGRATIONS, PARTIAL);
    expect(result.value).toEqual({ source: partial, from: null, to: 3, applied: [] });
    expect(result.value.source).toBe(partial);
    expect(runMigrations(partial, MIGRATIONS, {})).toEqual({ ok: false, code: "INVALID_MIGRATION_OPTIONS" });
    expect(runMigrations(partial, MIGRATIONS)).toEqual({ ok: false, code: "INVALID_MIGRATION_OPTIONS" });
  });

  it("migrates full data without a version from version 1, as stored before the field existed", () => {
    expect(runMigrations({ hp: 7 }, MIGRATIONS, FULL).value)
      .toEqual({ source: { schemaVersion: 3, health: 7 }, from: null, to: 3, applied: [2, 3] });
  });

  it("migrates partial data that carries a version without filling in anything", () => {
    expect(runMigrations({ schemaVersion: 2, health: 3 }, MIGRATIONS, PARTIAL).value.source).toEqual({ schemaVersion: 3, health: 3 });
  });

  it("treats an undefined version as missing and a string of digits as its number", () => {
    expect(runMigrations({ schemaVersion: undefined, hp: 1 }, MIGRATIONS, PARTIAL).value.applied).toEqual([]);
    expect(runMigrations({ schemaVersion: "2", tag: "x" }, MIGRATIONS, PARTIAL).value)
      .toEqual({ source: { schemaVersion: 3, tags: ["x"] }, from: 2, to: 3, applied: [3] });
  });

  it("refuses data from a newer version than this code knows, and leaves it to the caller", () => {
    expect(runMigrations({ schemaVersion: 4 }, MIGRATIONS, PARTIAL)).toEqual({ ok: false, code: "SCHEMA_VERSION_TOO_NEW" });
  });

  it("refuses a schema version that isn't a whole number from 1", () => {
    for ( const schemaVersion of [0, -1, 1.5, "1.5", "01", null, true] ) {
      expect(runMigrations({ schemaVersion }, MIGRATIONS, PARTIAL)).toEqual({ ok: false, code: "INVALID_SCHEMA_VERSION" });
    }
  });

  it("refuses source data that isn't a plain object, and an invalid list of migrations", () => {
    expect(runMigrations([], MIGRATIONS, PARTIAL)).toEqual({ ok: false, code: "INVALID_SOURCE" });
    expect(runMigrations(null, MIGRATIONS, PARTIAL)).toEqual({ ok: false, code: "INVALID_SOURCE" });
    expect(runMigrations({ schemaVersion: 1 }, [{ version: 3, migrate: s => s }], PARTIAL))
      .toEqual({ ok: false, code: "INVALID_MIGRATIONS" });
  });

  it("reports the step that threw, with its error, or that returned something other than an object", () => {
    const error = new Error("boom");
    const throwing = [{ version: 2, migrate() { throw error; } }];
    expect(runMigrations({ schemaVersion: 1 }, throwing, PARTIAL))
      .toEqual({ ok: false, code: "MIGRATION_FAILED", version: 2, cause: error });
    const empty = [{ version: 2, migrate: s => s }, { version: 3, migrate: () => undefined }];
    expect(runMigrations({ schemaVersion: 1 }, empty, PARTIAL)).toEqual({ ok: false, code: "MIGRATION_FAILED", version: 3 });
  });

  it("gives each step a copy of the plain data, so a step that changes it never changes the caller's", () => {
    const source = { schemaVersion: 1, hp: 5, nested: { list: [1] } };
    const mutating = [{ version: 2, migrate(s) { s.nested.list.push(2); s.hp = 0; return s; } }];
    expect(runMigrations(source, mutating, PARTIAL).value.source).toEqual({ schemaVersion: 2, hp: 0, nested: { list: [1, 2] } });
    expect(source).toEqual({ schemaVersion: 1, hp: 5, nested: { list: [1] } });
  });

  it("shares values that aren't plain data, such as Foundry's update operators", () => {
    class Operator {}
    const operator = new Operator();
    const result = runMigrations({ schemaVersion: 2, tag: operator }, [
      { version: 2, migrate: s => s }, { version: 3, migrate: s => s }
    ], PARTIAL);
    expect(result.value.source.tag).toBe(operator);
  });

  it("works from frozen data", () => {
    const source = Object.freeze({ schemaVersion: 1, hp: 2, nested: Object.freeze({ a: 1 }) });
    expect(runMigrations(source, MIGRATIONS, FULL).value.source)
      .toEqual({ schemaVersion: 3, health: 2, nested: { a: 1 } });
  });

  it("sets the version after every step, whatever the step returns", () => {
    const forgetful = [{ version: 2, migrate: () => ({ schemaVersion: 1, fresh: true }) }];
    expect(runMigrations({ schemaVersion: 1 }, forgetful, PARTIAL).value.source).toEqual({ schemaVersion: 2, fresh: true });
  });
});

describe("migrateSourceInPlace (for a data model's migrateData)", () => {
  it("rewrites the given object with the migrated data and returns it", () => {
    const source = { schemaVersion: 1, hp: 5, nested: { a: [1] } };
    const returned = migrateSourceInPlace(source, MIGRATIONS, FULL);
    expect(returned).toBe(source);
    expect(source).toEqual({ schemaVersion: 3, health: 5, nested: { a: [1] } });
    expect("hp" in source).toBe(false);
  });

  it("returns current and partial data untouched, the same object", () => {
    const current = { schemaVersion: 3, health: 1 };
    expect(migrateSourceInPlace(current, MIGRATIONS, PARTIAL)).toBe(current);
    expect(current).toEqual({ schemaVersion: 3, health: 1 });
    const partial = { hp: 1 };
    expect(migrateSourceInPlace(partial, MIGRATIONS, PARTIAL)).toBe(partial);
    expect(partial).toEqual({ hp: 1 });
  });

  it("leaves the source exactly as it was when a later step fails, and reports why", () => {
    const failures = [];
    const steps = [
      { version: 2, migrate(s) { s.renamed = true; return s; } },
      { version: 3, migrate() { throw new Error("no"); } }
    ];
    const source = { schemaVersion: 1, value: 1 };
    migrateSourceInPlace(source, steps, { partial: true, onFailure: f => failures.push(f) });
    expect(source).toEqual({ schemaVersion: 1, value: 1 });
    expect(failures).toEqual([{ ok: false, code: "MIGRATION_FAILED", version: 3, cause: new Error("no") }]);
  });

  it("reports data from a newer version and leaves it alone", () => {
    const failures = [];
    const tooNew = { schemaVersion: 9, hp: 1 };
    expect(migrateSourceInPlace(tooNew, MIGRATIONS, { partial: true, onFailure: f => failures.push(f) })).toEqual({ schemaVersion: 9, hp: 1 });
    expect(failures).toEqual([{ ok: false, code: "SCHEMA_VERSION_TOO_NEW" }]);
  });

  it("throws with the code and the step's error when no failure callback is given, for migrateDataSafe to log", () => {
    const error = new Error("boom");
    const source = { schemaVersion: 1 };
    let thrown;
    try { migrateSourceInPlace(source, [{ version: 2, migrate() { throw error; } }], PARTIAL); }
    catch( err ) { thrown = err; }
    expect(thrown.message).toContain("MIGRATION_FAILED");
    expect(thrown.cause).toBe(error);
    expect(source).toEqual({ schemaVersion: 1 });
  });

  it("refuses to half-write a sealed source that would need keys added or removed", () => {
    const failures = [];
    const sealed = Object.seal({ schemaVersion: 1, hp: 5 });
    migrateSourceInPlace(sealed, MIGRATIONS, { partial: true, onFailure: f => failures.push(f) });
    expect(sealed).toEqual({ schemaVersion: 1, hp: 5 });
    expect(failures).toEqual([{ ok: false, code: "MIGRATION_NOT_WRITABLE", version: 3 }]);
  });

  it("writes into a sealed source when the keys stay the same", () => {
    const sealed = Object.seal({ schemaVersion: 1, value: 1 });
    migrateSourceInPlace(sealed, [{ version: 2, migrate(s) { s.value = 2; return s; } }], PARTIAL);
    expect(sealed).toEqual({ schemaVersion: 2, value: 2 });
  });

  it("refuses a frozen source that needs any change", () => {
    const failures = [];
    const frozen = Object.freeze({ schemaVersion: 1, value: 1 });
    migrateSourceInPlace(frozen, [{ version: 2, migrate: s => s }], { partial: true, onFailure: f => failures.push(f) });
    expect(failures).toEqual([{ ok: false, code: "MIGRATION_NOT_WRITABLE", version: 2 }]);
  });

  it("refuses a source with a key to remove that can't be deleted, leaving it as it was", () => {
    const failures = [];
    const source = { schemaVersion: 1, a: 1 };
    Object.defineProperty(source, "hp", { value: 5, enumerable: true, writable: true, configurable: false });
    migrateSourceInPlace(source, MIGRATIONS, { partial: true, onFailure: f => failures.push(f) });
    expect(source).toEqual({ schemaVersion: 1, a: 1, hp: 5 });
    expect(failures).toEqual([{ ok: false, code: "MIGRATION_NOT_WRITABLE", version: 3 }]);
  });

  it("removes keys from an object that can't be extended, when nothing needs adding", () => {
    const source = Object.preventExtensions({ schemaVersion: 1, old: 1, keep: 2 });
    migrateSourceInPlace(source, [{ version: 2, migrate(s) { delete s.old; return s; } }], PARTIAL);
    expect(source).toEqual({ schemaVersion: 2, keep: 2 });
  });

  it("migrates full data without a version and writes the version, with Foundry-like frozen options", () => {
    const source = { hp: 5 };
    migrateSourceInPlace(source, MIGRATIONS, Object.freeze({ partial: false, strict: true }));
    expect(source).toEqual({ health: 5, schemaVersion: 3 });
  });

  it("never puts objects shared with the step's own state into the source", () => {
    const EMPTY = [];
    const shared = { a: 1 };
    const source = { schemaVersion: 1 };
    migrateSourceInPlace(source, [{ version: 2, migrate: s => ({ ...s, list: EMPTY, x: shared, y: shared }) }], PARTIAL);
    expect(source.list).not.toBe(EMPTY);
    expect(source.x).not.toBe(source.y);
  });

  it("leaves Foundry's update operators alone in partial data that carries a version", () => {
    class ForcedDeletion {}
    const operator = new ForcedDeletion();
    const source = { schemaVersion: 2, tag: operator };
    migrateSourceInPlace(source, MIGRATIONS, PARTIAL);
    expect(source).toEqual({ schemaVersion: 3, tag: operator });
    expect(source.tag).toBe(operator);
  });
});
