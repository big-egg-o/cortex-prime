/**
 * Quench batch "cortex-prime.contest-model": the contest ChatMessage sub-type and its mapping to
 * the engine's state (Decisions ADR-020, Step 4.4 S1 proposal review).
 * @module tests/quench/contest-model
 */

import ContestData from "../../module/data/chat/contest.mjs";
import CheckedTypedSchemaField from "../../module/data/fields/checked-typed-schema-field.mjs";
import {
  CONTEST_STATE_KEYS, ROLL_KEYS, TEST_STATE_KEYS, engineStateOf, initialSystem, systemChangesAfter
} from "../../module/data/chat/contest-mapping.mjs";
import { POOL_ROLL_SCHEMA_VERSION } from "../../module/data/chat/pool-roll.mjs";
import {
  addContestRoll, addTestRoll, applyResults, buildPool, contestRollFromResolution, contestRollFromTotal,
  createContest, createTest, resolve, testResult
} from "../../module/rules/index.mjs";

/** A player's user id; there is no existence check, so it needn't belong to a real user. */
const PLAYER = "playerOne0000001";

/**
 * @template T
 * @param {{ok: boolean, value?: T, code?: string}} result - an EngineResult
 * @param {string} label
 * @returns {T} the value; throws on a refusal
 */
function unwrap(result, label) {
  if ( !result.ok ) throw new Error(`${label} was refused with ${result.code}`);
  return result.value;
}

/** @returns {object[]} a contest's sides: a player's initiator, the GM's opposition */
function contestSides() {
  return [
    { key: "initiator", userId: PLAYER, actorUuid: "Actor.actorAyla0000001", label: "Ayla" },
    { key: "opposition", userId: null, actorUuid: "Actor.actorBrute000001", label: "Brute" }
  ];
}

/** @returns {object[]} a test's sides: a player's roller, the GM as setter */
function testSides() {
  return [
    { key: "roller", userId: PLAYER, actorUuid: "Actor.actorAyla0000001", label: "Ayla" },
    { key: "setter", userId: null, actorUuid: null, label: "GM" }
  ];
}

/**
 * TC-44's pool roll: d10:8, d8:6, d6:4, d4:3, total 14 (d10 + d8), effect die d6, the d4 left over.
 * @returns {{pool: object[], rolled: object[], selection: object, resolution: object}}
 */
function tc44PoolRoll() {
  const pool = buildPool([10, 8, 6, 4].map((size, i) => ({ size, source: { kind: "trait", label: `Die ${i + 1}` } })));
  const rolled = applyResults(pool, [8, 6, 4, 3]);
  const selection = {
    totalIds: [rolled[0].id, rolled[1].id], effectDieIds: [rolled[2].id], extraResultsPaid: 0, extraEffectDicePaid: 0,
    keepLimit: 2
  };
  return { pool, rolled, selection, resolution: resolve(rolled, selection) };
}

/**
 * The system source of TC-44's test after its roll was added: difficulty 13, a success by 1.
 * @param {string} messageRef - the id of the roll's poolRoll message
 * @returns {{system: object, state: object}}
 */
function tc44Test(messageRef = foundry.utils.randomID()) {
  const { rolled, resolution } = tc44PoolRoll();
  const started = unwrap(createTest({ difficulty: 13 }), "createTest");
  const created = unwrap(initialSystem({ type: "test", state: started, startedBy: game.user.id, sides: testSides() }), "initialSystem");
  const roll = unwrap(contestRollFromResolution("roller", rolled, resolution, messageRef), "contestRollFromResolution");
  const state = unwrap(addTestRoll(started, roll), "addTestRoll");
  return { system: { ...created, ...unwrap(systemChangesAfter(created, state, { rollUserId: PLAYER }), "write") }, state };
}

/**
 * TC-17's exchange, I 11 (d6) → O 13 (d8) → I 15 (d10) → O 12 (d6), written roll by roll.
 * @returns {{states: object[], systems: object[]}} the engine state and the system source after 0
 *   to 4 rolls
 */
function tc17() {
  const rolls = [[11, 6], [13, 8], [15, 10], [12, 6]].map(([total, size], i) => (
    unwrap(contestRollFromTotal(i % 2 ? "opposition" : "initiator", total, [size]), `typed ${total}`)
  ));
  const states = [unwrap(createContest(), "createContest")];
  const systems = [unwrap(initialSystem({
    type: "contest", state: states[0], startedBy: game.user.id, sides: contestSides()
  }), "initialSystem")];
  for ( const [i, roll] of rolls.entries() ) {
    const state = unwrap(addContestRoll(states.at(-1), roll), `${roll.side} ${roll.total}`);
    const changes = unwrap(systemChangesAfter(systems.at(-1), state, { rollUserId: i % 2 ? game.user.id : PLAYER }), "write");
    states.push(state);
    systems.push({ ...systems.at(-1), ...changes });
  }
  return { states, systems };
}

/**
 * Register the batch with Quench.
 * @param {object} quench
 */
export function registerContestModelBatch(quench) {
  quench.registerBatch(
    "cortex-prime.contest-model",
    ({ describe, it, assert, afterEach }) => {
      /** @type {ChatMessage[]} */
      const tracked = [];

      afterEach(async () => {
        for ( const message of tracked ) {
          if ( game.messages.has(message.id) ) await message.delete();
        }
        tracked.length = 0;
      });

      /**
       * Creates a chat message and tracks it for clean-up.
       * @param {string} type
       * @param {object} system
       * @returns {Promise<ChatMessage|undefined>}
       */
      async function create(type, system) {
        const message = await ChatMessage.create({ type, system });
        if ( message ) tracked.push(message);
        return message;
      }

      /**
       * Asserts that contest `system` data is rejected two ways: constructing the Document throws,
       * and going through the database resolves to undefined and stores nothing (the pattern of
       * tests/quench/chat.mjs).
       * @param {object} system
       * @param {string} because
       */
      async function assertRejected(system, because) {
        let threw = false;
        try {
          new ChatMessage({ type: "contest", system });
        } catch {
          threw = true;
        }
        assert.isTrue(threw, `${because}: constructing the Document should throw`);

        const before = game.messages.size;
        const result = await create("contest", system);
        assert.isUndefined(result, `${because}: create() should resolve to undefined`);
        assert.equal(game.messages.size, before, `${because}: nothing should be stored`);
      }

      describe("creating and reading contest messages", () => {
        it("TC-44 a test message is stored and read back unchanged", async () => {
          const { system } = tc44Test();
          const message = await create("contest", system);
          const read = game.messages.get(message.id);
          assert.equal(read.type, "contest");
          assert.equal(read.system.flow.type, "test");
          assert.deepEqual(read.system.toObject(), system);
        });

        it("TC-17 a contest message is stored and read back unchanged, and its flow maps to the engine state", async () => {
          const { states, systems } = tc17();
          const message = await create("contest", systems[4]);
          const source = game.messages.get(message.id).system.toObject();
          assert.deepEqual(source, systems[4]);
          assert.deepEqual(unwrap(engineStateOf(source.flow), "engineStateOf"), states[4]);
        });

        it("checkCandidate accepts both, and refuses a candidate that cleaning would change", () => {
          const contest = tc17().systems[4];
          assert.isNull(ContestData.checkCandidate(tc44Test().system));
          assert.isNull(ContestData.checkCandidate(contest));

          const asString = foundry.utils.deepClone(contest);
          asString.flow.rolls[1].total = "13";
          assert.isString(ContestData.checkCandidate(asString), 'a total of "13"');
          const fraction = foundry.utils.deepClone(contest);
          fraction.flow.rolls[1].total = 2.5;
          assert.isString(ContestData.checkCandidate(fraction), "a total of 2.5");
        });

        it("a flow type other than test or contest is rejected", async () => {
          const { system } = tc44Test();
          system.flow.type = "duel";
          await assertRejected(system, 'flow.type "duel"');
        });

        it("a d7 effect die is rejected", async () => {
          const system = tc17().systems[4];
          system.flow.rolls[0].effects[0].size = 7;
          await assertRejected(system, "a d7 effect die");
        });

        it("a turn that isn't one of the sides is rejected", async () => {
          const system = tc17().systems[4];
          system.flow.turn = "bystander";
          await assertRejected(system, 'turn "bystander"');
        });

        it("contest sides other than initiator and opposition are rejected", async () => {
          const system = tc17().systems[4];
          system.sides[1].key = "interferer";
          await assertRejected(system, 'a side "interferer"');
        });

        // Foundry 14.369 fills a missing field that may be empty with null when a document is created
        // (common/data/fields.mjs, DataField#clean and DataField#getInitialValue), so a test flow without
        // `success` is stored with null, never false. That is acceptable because writers run checkCandidate
        // before every create, and checkCandidate refuses such a source.
        it("Foundry 14.369 fills a missing success with null on create, never false; checkCandidate refuses it first", async () => {
          const { system } = tc44Test();
          delete system.flow.success;
          assert.isString(ContestData.checkCandidate(system));

          const message = await create("contest", system);
          assert.isDefined(message, "Foundry stores the message");
          assert.isNull(game.messages.get(message.id).system.toObject().flow.success);
        });

        it("checkCandidate refuses a side without userId, which would otherwise become the GM's side", () => {
          const system = tc17().systems[4];
          delete system.sides[0].userId;
          assert.isString(ContestData.checkCandidate(system));
        });
      });

      describe("updating contest messages", () => {
        it("an update that changes flow.type from contest to test is refused, leaving the message unchanged", async () => {
          const stored = tc17().systems[4];
          const message = await create("contest", stored);
          const testFlow = tc44Test().system.flow;

          const result = await message.update({ system: { flow: testFlow, revision: stored.revision + 1 } });
          assert.isUndefined(result, "update() should resolve to undefined");
          assert.deepEqual(game.messages.get(message.id).system.toObject(), stored);
        });

        it("TC-17 a whole-flow update with the revision raised by one lands as given", async () => {
          const { states, systems } = tc17();
          const message = await create("contest", systems[3]);
          const changes = unwrap(systemChangesAfter(systems[3], states[4], { rollUserId: game.user.id }), "write");
          const candidate = { ...systems[3], ...changes };
          assert.isNull(ContestData.checkCandidate(candidate));

          const result = await message.update({ system: changes });
          assert.isDefined(result, "update() should resolve to the message");
          assert.deepEqual(game.messages.get(message.id).system.toObject(), candidate);
        });

        // Documents Foundry 14.369, not our code (fields.mjs, ArrayField#_updateDiff): an invalid entry in
        // a list keeps the list's old value and the rest of the update is saved without an error. This is
        // why writers run checkCandidate first. If this test fails after a Foundry upgrade, Foundry changed.
        it("Foundry 14.369 behaviour: a whole-flow update with a d7 in rolls lands with revision + 1 but keeps the old rolls", async () => {
          const { states, systems } = tc17();
          const message = await create("contest", systems[3]);
          const changes = unwrap(systemChangesAfter(systems[3], states[4], { rollUserId: game.user.id }), "write");
          changes.flow.rolls[3].effects[0].size = 7;
          assert.isString(ContestData.checkCandidate({ ...systems[3], ...changes }), "checkCandidate should refuse it");

          const result = await message.update({ system: changes });
          assert.isDefined(result, "Foundry saves the rest of the update");
          const after = game.messages.get(message.id).system.toObject();
          assert.equal(after.revision, systems[3].revision + 1);
          assert.deepEqual(after.flow.rolls, systems[3].flow.rolls);
        });

        it("a whole-flow update with a turn that isn't one of the sides is refused, leaving the message unchanged", async () => {
          const { states, systems } = tc17();
          const message = await create("contest", systems[3]);
          const changes = unwrap(systemChangesAfter(systems[3], states[4], { rollUserId: game.user.id }), "write");
          changes.flow.turn = "bystander";

          const result = await message.update({ system: changes });
          assert.isUndefined(result, "update() should resolve to undefined");
          assert.deepEqual(game.messages.get(message.id).system.toObject(), systems[3]);
        });
      });

      describe("loading and migration", () => {
        it("TC-44 deleting the linked poolRoll message changes nothing in how the contest message reads", async () => {
          const { pool, rolled, selection, resolution } = tc44PoolRoll();
          const poolMessage = await create("poolRoll", {
            schemaVersion: POOL_ROLL_SCHEMA_VERSION, pool, rolled, selection, resolution, state: "resolved"
          });
          const { system, state } = tc44Test(poolMessage.id);
          const message = await create("contest", system);
          const before = message.system.toObject();

          await poolMessage.delete();
          assert.isFalse(game.messages.has(poolMessage.id));
          const after = game.messages.get(message.id).system.toObject();
          assert.deepEqual(after, before);
          const read = unwrap(engineStateOf(after.flow), "engineStateOf");
          assert.deepEqual(read, state);
          assert.equal(read.roll.messageRef, poolMessage.id);
          assert.deepInclude(unwrap(testResult(read), "testResult"), { success: true, margin: 1 });
        });

        it("TC-17 a stored contest message loads strictly from its source, as world load does", async () => {
          const stored = tc17().systems[4];
          const message = await create("contest", stored);
          const loaded = ChatMessage.implementation.fromSource(
            foundry.utils.deepClone(message.toObject()),
            { strict: true, clean: { expand: false } }
          );
          assert.deepEqual(loaded.system.toObject(), stored);
        });

        it("migrateData leaves a current source, a partial update source and an empty source unchanged", () => {
          const full = tc17().systems[4];
          assert.deepEqual(ContestData.migrateData(foundry.utils.deepClone(full)), full);
          const partial = { flow: full.flow, revision: full.revision };
          assert.deepEqual(ContestData.migrateData(foundry.utils.deepClone(partial)), partial);
          assert.deepEqual(ContestData.migrateData({}), {});
        });
      });

      describe("schema and registration", () => {
        it("the schema's fields are the mapping's key lists plus the model-only fields, and the type is registered", () => {
          const sorted = keys => [...keys].sort();
          const fields = ContestData.schema.fields;
          assert.deepEqual(sorted(Object.keys(fields)), ["flow", "revision", "schemaVersion", "sides", "startedBy"]);
          assert.deepEqual(sorted(Object.keys(fields.sides.element.fields)), ["actorUuid", "key", "label", "userId"]);

          const { contest, test } = fields.flow.types;
          assert.deepEqual(sorted(Object.keys(contest.fields)), sorted(["type", ...CONTEST_STATE_KEYS, "usedAgainstLoser"]));
          assert.deepEqual(
            sorted(Object.keys(test.fields)),
            sorted(["type", ...TEST_STATE_KEYS, "difficultyLevel", "difficultyMessageRef", "oppositionEffects"])
          );
          assert.deepEqual(sorted(Object.keys(contest.fields.rolls.element.fields)), sorted([...ROLL_KEYS, "userId"]));
          assert.deepEqual(sorted(Object.keys(test.fields.roll.fields)), sorted([...ROLL_KEYS, "userId"]));

          assert.include(ChatMessage.TYPES, "contest");
          assert.equal(CONFIG.ChatMessage.typeLabels.contest, "TYPES.ChatMessage.contest");
          assert.isTrue(game.i18n.has("TYPES.ChatMessage.contest", false));
        });

        /**
         * A throwaway DataModel whose only field is a one-variant typed schema holding a number that
         * must be 1.
         * @param {typeof foundry.data.fields.TypedSchemaField} FieldClass
         * @returns {typeof foundry.abstract.DataModel}
         */
        function probeModel(FieldClass) {
          const { NumberField } = foundry.data.fields;
          return class extends foundry.abstract.DataModel {
            static defineSchema() {
              return { field: new FieldClass({ only: { value: new NumberField({ required: true, nullable: false, choices: [1] }) } }) };
            }
          };
        }

        // Documents Foundry 14.369, not our code (common/data/fields.mjs, TypedSchemaField#_validateType):
        // validated as part of its parent, the plain field returns its variant's failure instead of throwing
        // it, so an invalid value inside the variant is let through. CheckedTypedSchemaField throws it. If the
        // first half fails after a Foundry upgrade, Foundry refuses the value itself and the subclass can go.
        it("Foundry 14.369 behaviour: a plain TypedSchemaField lets an invalid value inside its variant through; CheckedTypedSchemaField refuses it", () => {
          const invalid = () => ({ field: { type: "only", value: 2 } });
          const Plain = probeModel(foundry.data.fields.TypedSchemaField);
          assert.doesNotThrow(() => new Plain(invalid(), { strict: true }), undefined, undefined, "the plain field lets 2 through");

          const Checked = probeModel(CheckedTypedSchemaField);
          assert.throws(() => new Checked(invalid(), { strict: true }), undefined, undefined, "the checked field refuses 2");
          assert.doesNotThrow(() => new Checked({ field: { type: "only", value: 1 } }, { strict: true }), undefined, undefined,
            "the checked field accepts 1");
        });
      });
    },
    { displayName: "Cortex Prime: contest model" }
  );
}
