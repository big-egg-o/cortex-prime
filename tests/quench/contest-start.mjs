/**
 * Quench batch "cortex-prime.contest-start": starting a test or contest through the GM relay, the
 * pool builder's difficulty helper and target, the roll flag, what a flagged roll card offers and
 * its Send, and the minimal contest card (Decisions ADR-020, ADR-021 and ADR-027, Step 4.4 S3
 * proposal review). Run as the active GM in `cp-tests`, which needs two Player users; the batch
 * creates the actors it needs, owned by them, and calls the query handler with those users as
 * senders, the way Foundry passes the querying user.
 * @module tests/quench/contest-start
 */

import { openPoolBuilder, openPoolBuilderFor } from "../../module/apps/pool-builder.mjs";
import { prepareContestCardContext } from "../../module/contest/contest-card.mjs";
import { handleContestQuery } from "../../module/contest/relay.mjs";
import { CONTEST_FLAG, holdOf, sendRollCard } from "../../module/contest/roll-card.mjs";
import { initialSystem } from "../../module/data/chat/contest-mapping.mjs";
import { POOL_ROLL_SCHEMA_VERSION } from "../../module/data/chat/pool-roll.mjs";
import { applyCardChange } from "../../module/dice/card-actions.mjs";
import { preparePoolRollCardContext } from "../../module/dice/pool-roll-card.mjs";
import {
  DIFFICULTY_SOURCE_KIND, applyResults, buildPool, createContest, difficultyLevelOfPool, dispatchStartRequest, resolve,
  stepEffectDie
} from "../../module/rules/index.mjs";

const SCOPE = "cortex-prime";

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

/**
 * Register the batch with Quench.
 * @param {object} quench
 */
export function registerContestStartBatch(quench) {
  quench.registerBatch(
    "cortex-prime.contest-start",
    ({ describe, it, assert, before, after, afterEach }) => {
      /** @type {ChatMessage[]} */
      const tracked = [];
      let p1;
      let p2;
      let ayla;
      let bren;
      let brute;

      before(async () => {
        [p1, p2] = game.users.filter(u => !u.isGM);
        if ( !p1 || !p2 ) return;
        // One at a time: createDocuments doesn't promise to return the documents in the order given.
        const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
        const create = (name, ownership) => Actor.implementation.create({ name, type: "character", ownership });
        ayla = await create("Ayla (contest-start)", { default: 0, [p1.id]: OWNER });
        bren = await create("Bren (contest-start)", { default: 0, [p2.id]: OWNER });
        brute = await create("Brute (contest-start)", { default: 0 });
      });

      after(async () => {
        const ids = [ayla, bren, brute].filter(actor => actor && game.actors.has(actor.id)).map(actor => actor.id);
        if ( ids.length ) await Actor.implementation.deleteDocuments(ids);
      });

      afterEach(async () => {
        const ids = tracked.splice(0).map(m => m.id).filter(id => game.messages.has(id));
        if ( ids.length ) await ChatMessage.implementation.deleteDocuments(ids);
        await game.user.unsetFlag(SCOPE, "pool");
      });

      /** Skips a test when cp-tests lacks the two Player users it needs. */
      function needPlayers(test) {
        if ( !p1 || !p2 ) test.skip();
      }

      /** Tracks a message created by the code under test, by id, for clean-up. */
      function track(messageId) {
        const message = game.messages.get(messageId);
        if ( message ) tracked.push(message);
        return message;
      }

      /**
       * Creates a resolved poolRoll card from fixed results: the dice at `totalAt` make the total,
       * those at `effectAt` the effect dice. `overflow` then pushes e1 past d12 with an SFX step,
       * leaving its choice open; `rolledOnly` leaves the card unconfirmed.
       * @returns {Promise<ChatMessage>}
       */
      async function rollCard({ sizes, results, totalAt, effectAt, author, flag, overflow = false, rolledOnly = false }) {
        const pool = buildPool(sizes.map((size, i) => ({ size, source: { kind: "trait", label: `Die ${i + 1}` } })));
        const rolled = applyResults(pool, results);
        const selection = {
          totalIds: totalAt.map(i => rolled[i].id), effectDieIds: effectAt.map(i => rolled[i].id),
          extraResultsPaid: 0, extraEffectDicePaid: 0, keepLimit: 2
        };
        let resolution = rolledOnly ? null : resolve(rolled, selection);
        if ( overflow ) resolution = stepEffectDie(rolled, resolution, "e1", 1, "other");
        const data = {
          type: "poolRoll",
          system: {
            schemaVersion: POOL_ROLL_SCHEMA_VERSION, pool, rolled, selection, resolution,
            state: rolledOnly ? "rolled" : "resolved"
          }
        };
        if ( author ) data.author = author.id;
        if ( flag ) data.flags = { [SCOPE]: { [CONTEST_FLAG]: flag } };
        const message = await ChatMessage.implementation.create(data);
        tracked.push(message);
        return message;
      }

      /** TC-03's card, by the GM: d10:7, d10:3, d8:6, d6:2; d10(7) + d8(6) = 13, the d10 that rolled 3 as effect die. */
      function tc03Card(options = {}) {
        return rollCard({ sizes: [10, 10, 8, 6], results: [7, 3, 6, 2], totalAt: [0, 2], effectAt: [1], ...options });
      }

      /** TC-15's initiator card: d8:6, d8:5, d6:3; total 11, effect die d6. */
      function tc15Card(options = {}) {
        return rollCard({ sizes: [8, 8, 6], results: [6, 5, 3], totalAt: [0, 1], effectAt: [2], ...options });
      }

      /** A card with a d12 effect die pushed past d12 by an SFX: d12:5, d10:7, d8:6; total 13. */
      function pastD12Card(options = {}) {
        return rollCard({ sizes: [12, 10, 8], results: [5, 7, 6], totalAt: [1, 2], effectAt: [0], overflow: true, ...options });
      }

      /**
       * A contest message written by this GM: p1 initiates as Ayla, against the GM's Brute or, with
       * `pvp`, against p2's Bren.
       */
      async function contest({ pvp = false } = {}) {
        const sides = [
          { key: "initiator", userId: p1.id, actorUuid: ayla.uuid, label: "Ayla" },
          pvp ? { key: "opposition", userId: p2.id, actorUuid: bren.uuid, label: "Bren" }
            : { key: "opposition", userId: null, actorUuid: brute.uuid, label: "Brute" }
        ];
        const system = unwrap(initialSystem({ type: "contest", state: createContest().value, startedBy: game.user.id, sides }), "initialSystem");
        const message = await ChatMessage.implementation.create({ type: "contest", system });
        tracked.push(message);
        return message;
      }

      /** A test's sides to start with: p1 rolls as Ayla, the GM sets the difficulty. */
      function testSides({ roller = p1, rollerActor = ayla } = {}) {
        return [
          { key: "roller", userId: roller.id, actorUuid: rollerActor.uuid, label: rollerActor.name },
          { key: "setter", userId: null, actorUuid: null, label: "GM" }
        ];
      }

      /** The contest messages in the chat log, counted. */
      function contestCount() {
        return game.messages.filter(m => m.type === "contest").length;
      }

      describe("starting a test or contest through the relay", () => {
        it("TC-03 p1 starts a test against the GM's card: a public message by the GM, as Ayla, storing exactly the candidate", async function() {
          needPlayers(this);
          const card = await tc03Card();
          const request = {
            action: "start", type: "test", sides: testSides(), difficultyMessageId: card.id, difficultyLevel: "hard"
          };
          const result = await handleContestQuery(request, { user: p1 });
          assert.isTrue(result.ok, result.code);
          const message = track(result.value.messageId);
          assert.isDefined(message);
          assert.isTrue(message.author.isGM);
          assert.lengthOf(message.whisper, 0);
          assert.isFalse(message.blind);
          assert.equal(message.speaker.actor, ayla.id);

          const source = card.system.toObject();
          const expected = unwrap(initialSystem(unwrap(dispatchStartRequest({
            sender: { userId: p1.id, isGM: false }, request,
            difficultyCard: { authorId: card.author.id, rolled: source.rolled, resolution: source.resolution },
            actors: { [ayla.uuid]: { ownedBySender: true } }
          }), "dispatchStartRequest")), "initialSystem");
          assert.deepEqual(message.system.toObject(), expected);
          assert.deepInclude(message.system.flow, {
            difficulty: 13, difficultyLevel: "hard", difficultyMessageRef: card.id, oppositionTakeOut: false
          });
          assert.equal(message.system.revision, 0);
        });

        it("p1 starts a typed test and a contest, each at revision 0 and started by p1", async function() {
          needPlayers(this);
          const typed = await handleContestQuery({ action: "start", type: "test", sides: testSides(), difficulty: 13 }, { user: p1 });
          assert.isTrue(typed.ok, typed.code);
          const test = track(typed.value.messageId);
          assert.deepInclude(test.system.flow, { difficulty: 13, difficultyMessageRef: null, oppositionTakeOut: null });

          const sides = [
            { key: "initiator", userId: p1.id, actorUuid: ayla.uuid, label: "Ayla" },
            { key: "opposition", userId: null, actorUuid: brute.uuid, label: "Brute" }
          ];
          const started = await handleContestQuery({ action: "start", type: "contest", sides }, { user: p1 });
          assert.isTrue(started.ok, started.code);
          const message = track(started.value.messageId);
          assert.equal(message.system.flow.type, "contest");
          assert.equal(message.system.startedBy, p1.id);
          assert.equal(message.system.revision, 0);
          assert.equal(message.speaker.actor, ayla.id);
        });

        it("a starting side without an actor speaks with its label", async function() {
          needPlayers(this);
          const sides = [
            { key: "initiator", userId: p1.id, actorUuid: null, label: "Wanderer" },
            { key: "opposition", userId: null, actorUuid: null, label: "GM" }
          ];
          const result = await handleContestQuery({ action: "start", type: "contest", sides }, { user: game.user });
          assert.isTrue(result.ok, result.code);
          assert.equal(track(result.value.messageId).speaker.alias, "Wanderer");
        });

        it("refused starts create nothing and answer the code", async function() {
          needPlayers(this);
          const unconfirmed = await tc03Card({ rolledOnly: true });
          const pending = await pastD12Card();
          const cases = [
            ["p1 starting for p2's side", { type: "test", sides: testSides({ roller: p2, rollerActor: bren }), difficulty: 9 }, "NOT_YOUR_SIDE"],
            ["p1 asking for high stakes", { type: "test", sides: testSides(), difficulty: 9, highStakes: true }, "GM_ONLY"],
            ["an unconfirmed card", { type: "test", sides: testSides(), difficultyMessageId: unconfirmed.id }, "POOL_ROLL_NOT_CONFIRMED"],
            ["a card with an overflow choice open", { type: "test", sides: testSides(), difficultyMessageId: pending.id }, "OVERFLOW_PENDING"],
            ["an actor p1 doesn't own", { type: "test", sides: testSides({ rollerActor: brute }), difficulty: 9 }, "NOT_YOUR_ACTOR"],
            ["an actor that doesn't exist", {
              type: "test", difficulty: 9,
              sides: [{ ...testSides()[0], actorUuid: "Actor.missingActor0001" }, testSides()[1]]
            }, "ACTOR_NOT_FOUND"]
          ];
          for ( const [label, fields, code] of cases ) {
            const before = contestCount();
            const result = await handleContestQuery({ action: "start", ...fields }, { user: p1 });
            assert.deepEqual(result, { ok: false, code }, label);
            assert.equal(contestCount(), before, `${label}: nothing created`);
          }
        });
      });

      describe("the pool builder", () => {
        it("TC-01 the difficulty helper adds a pair, replaces it, and the level reads back", async () => {
          const builder = await openPoolBuilder();
          try {
            await builder.addDie(8, "Gate guard");
            await builder.setDifficulty("hard");
            let difficulty = builder.pool.filter(d => d.source.kind === DIFFICULTY_SOURCE_KIND);
            assert.deepEqual(difficulty.map(d => d.size), [10, 10]);
            assert.isTrue(difficulty.every(d => (typeof d.source.label === "string") && d.source.label.length > 0));
            assert.deepEqual(difficultyLevelOfPool(builder.pool), { ok: true, value: "hard" });

            await builder.setDifficulty("easy");
            difficulty = builder.pool.filter(d => d.source.kind === DIFFICULTY_SOURCE_KIND);
            assert.deepEqual(difficulty.map(d => d.size), [6, 6]);
            assert.deepEqual(difficultyLevelOfPool(builder.pool), { ok: true, value: "easy" });
            assert.lengthOf(builder.pool, 3, "the GMC die stays");
          } finally {
            await builder.close();
          }
        });

        it("a roll for a target is public, flagged for its turn and spoken by the side's actor, and clears the target", async function() {
          needPlayers(this);
          const message = await contest();
          const target = { messageId: message.id, side: "initiator", rollIndex: 0 };
          const mode = game.settings.get("core", "messageMode");
          await game.settings.set("core", "messageMode", "gm");
          const builder = await openPoolBuilderFor(target);
          try {
            assert.deepEqual(builder.target, target);
            await builder.addDie(8, "Test die");
            const card = await builder.rollPool([5]);
            assert.isDefined(card);
            tracked.push(card);
            assert.deepEqual(card.getFlag(SCOPE, CONTEST_FLAG), target);
            assert.lengthOf(card.whisper, 0, "public whatever the user's message mode");
            assert.isFalse(card.blind);
            assert.equal(card.speaker.actor, ayla.id);
            assert.isNull(builder.target);
            assert.lengthOf(builder.pool, 1, "the pool is kept (ADR-012)");
          } finally {
            await game.settings.set("core", "messageMode", mode);
            await builder.close();
          }
        });

        it("a target that no longer fits rolls nothing and is dropped", async function() {
          needPlayers(this);
          const message = await contest();
          const builder = await openPoolBuilderFor({ messageId: message.id, side: "initiator", rollIndex: 1 });
          try {
            await builder.addDie(8, "Test die");
            const before = game.messages.filter(m => m.type === "poolRoll").length;
            const card = await builder.rollPool([5]);
            assert.isUndefined(card);
            assert.equal(game.messages.filter(m => m.type === "poolRoll").length, before);
            assert.isNull(builder.target);
          } finally {
            await builder.close();
          }
        });
      });

      describe("a roll card flagged for a test or contest", () => {
        it("a held card offers no overflow choice, and applyCardChange refuses one", async function() {
          needPlayers(this);
          const message = await contest();
          const card = await pastD12Card({ flag: { messageId: message.id, side: "initiator", rollIndex: 0 } });
          assert.equal(holdOf(card), "held");
          const context = preparePoolRollCardContext(card);
          assert.isNull(context.overflowChoice);
          assert.equal(context.contestHold?.state, "held");
          assert.isTrue(context.send, "an open overflow goes to the contest with the roll (RQ-018)");

          await applyCardChange(card, { action: "overflow-choice", kind: "take-out" });
          assert.isNotNull(card.system.resolution.overflow);
          assert.isFalse(card.system.resolution.takeOut);
        });

        it("Send, through the function the click uses, adds the roll; the card is then sent", async function() {
          needPlayers(this);
          const message = await contest();
          const card = await tc15Card({ flag: { messageId: message.id, side: "initiator", rollIndex: 0 } });
          assert.isTrue(preparePoolRollCardContext(card).send);
          const result = await sendRollCard(card);
          assert.isTrue(result.ok, result.code);
          assert.equal(message.system.revision, 1);
          assert.equal(message.system.flow.rolls[0].messageRef, card.id);
          assert.equal(message.system.flow.rolls[0].total, 11);
          assert.equal(holdOf(card), "sent");
        });

        it("a sent card offers neither Send nor the overflow choice, and still steps an effect die (the lock comes in S4a)", async function() {
          needPlayers(this);
          const message = await contest();
          const card = await tc15Card({ flag: { messageId: message.id, side: "initiator", rollIndex: 0 } });
          assert.isTrue((await sendRollCard(card)).ok);
          const context = preparePoolRollCardContext(card);
          assert.isFalse(context.send);
          assert.isNull(context.overflowChoice);
          assert.equal(context.contestHold?.state, "sent");

          await applyCardChange(card, { action: "step-effect-die", effectId: "e1", steps: 1 });
          assert.equal(card.system.resolution.effectDice[0].size, 8);
          assert.equal(message.system.flow.rolls[0].effects[0].size, 6, "the contest keeps its own copy (ADR-027)");
        });

        it("a second contest refuses the same card with ROLL_IN_OTHER_CONTEST", async function() {
          needPlayers(this);
          const first = await contest();
          const card = await tc15Card({ flag: { messageId: first.id, side: "initiator", rollIndex: 0 } });
          assert.isTrue((await sendRollCard(card)).ok);
          const second = await contest();
          const request = { action: "add-roll", messageId: second.id, revision: 0, payload: { side: "initiator", poolRollId: card.id } };
          assert.deepEqual(await handleContestQuery(request, { user: game.user }), { ok: false, code: "ROLL_IN_OTHER_CONTEST" });
          assert.equal(second.system.revision, 0);
        });

        it("deleting the contest frees the card", async function() {
          needPlayers(this);
          const message = await contest();
          const card = await tc15Card({ flag: { messageId: message.id, side: "initiator", rollIndex: 0 } });
          assert.equal(holdOf(card), "held");
          await message.delete();
          assert.equal(holdOf(card), "free");
          assert.isFalse(preparePoolRollCardContext(card).send);
        });

        it("a card rolled for an earlier turn is free; one rolled for this turn is held", async function() {
          needPlayers(this);
          const message = await contest();
          const opened = await handleContestQuery(
            { action: "add-roll", messageId: message.id, revision: 0, payload: { total: 11 } }, { user: p1 }
          );
          assert.isTrue(opened.ok, opened.code);
          const earlier = await tc15Card({ flag: { messageId: message.id, side: "initiator", rollIndex: 0 } });
          assert.equal(holdOf(earlier), "free");
          const current = await tc15Card({ flag: { messageId: message.id, side: "opposition", rollIndex: 1 } });
          assert.equal(holdOf(current), "held");
          const unflagged = await tc15Card();
          assert.equal(holdOf(unflagged), "free");
        });
      });

      describe("the minimal contest card", () => {
        it("TC-15 \"Roll\" for the initiator's user first; after the 11, \"Roll to beat 11\" for the opposition's user only", async function() {
          needPlayers(this);
          const message = await contest({ pvp: true });
          assert.deepInclude(prepareContestCardContext(message, p1).button, { side: "initiator", rollIndex: 0, toBeat: null });
          assert.isNull(prepareContestCardContext(message, p2).button);

          const opened = await handleContestQuery(
            { action: "add-roll", messageId: message.id, revision: 0, payload: { total: 11 } }, { user: p1 }
          );
          assert.isTrue(opened.ok, opened.code);
          const forP2 = prepareContestCardContext(message, p2);
          assert.deepInclude(forP2.button, { side: "opposition", rollIndex: 1, toBeat: 11 });
          assert.include(forP2.button.label, "11");
          assert.isNull(prepareContestCardContext(message, p1).button);
          assert.isNotNull(prepareContestCardContext(message, game.user).button, "a GM may act for any side");
        });

        it("TC-15 the card shows the sides, the total to beat and the status; once decided there is no button", async function() {
          needPlayers(this);
          const message = await contest({ pvp: true });
          await handleContestQuery({ action: "add-roll", messageId: message.id, revision: 0, payload: { total: 11 } }, { user: p1 });
          let context = prepareContestCardContext(message, p2);
          assert.deepEqual(context.sides.map(s => [s.key, s.label]), [["initiator", "Ayla"], ["opposition", "Bren"]]);
          assert.equal(context.toBeat, 11);
          assert.equal(context.status.key, "waiting");

          await handleContestQuery({ action: "add-roll", messageId: message.id, revision: 1, payload: { total: 10 } }, { user: p2 });
          context = prepareContestCardContext(message, p2);
          assert.equal(context.status.key, "decided");
          for ( const user of [p1, p2, game.user] ) assert.isNull(prepareContestCardContext(message, user).button, user.name);
        });
      });
    },
    { displayName: "Cortex Prime: contest start" }
  );
}
