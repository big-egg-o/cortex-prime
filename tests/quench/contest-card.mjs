/**
 * Quench batch "cortex-prime.contest-card": the full test or contest card and the exchange on it
 * (Decisions ADR-020 and ADR-027, Step 4.4 S4a proposal review): what the card shows, the controls
 * each user gets, typed totals, give in, decline, high stakes and close through the function the
 * clicks use, the lock on a sent roll card, and a deleted roll card. Run as the active GM in
 * `cp-tests`, which needs two Player users; the batch creates the actors it needs and calls the
 * query handler with those users as senders, the way Foundry passes the querying user.
 * @module tests/quench/contest-card
 */

import { prepareContestCardContext, refreshContestCards, sendCardAction } from "../../module/contest/contest-card.mjs";
import { handleContestQuery } from "../../module/contest/relay.mjs";
import { CONTEST_FLAG, sendRollCard } from "../../module/contest/roll-card.mjs";
import { typedRollPayload } from "../../module/contest/total-dialog.mjs";
import { initialSystem } from "../../module/data/chat/contest-mapping.mjs";
import { POOL_ROLL_SCHEMA_VERSION } from "../../module/data/chat/pool-roll.mjs";
import { applyCardChange } from "../../module/dice/card-actions.mjs";
import { preparePoolRollCardContext } from "../../module/dice/pool-roll-card.mjs";
import { applyResults, buildPool, createContest, resolve, stepEffectDie } from "../../module/rules/index.mjs";

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
export function registerContestCardBatch(quench) {
  quench.registerBatch(
    "cortex-prime.contest-card",
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
        ayla = await create("Ayla (contest-card)", { default: 0, [p1.id]: OWNER });
        bren = await create("Bren (contest-card)", { default: 0, [p2.id]: OWNER });
        brute = await create("Brute (contest-card)", { default: 0 });
      });

      after(async () => {
        const ids = [ayla, bren, brute].filter(actor => actor && game.actors.has(actor.id)).map(actor => actor.id);
        if ( ids.length ) await Actor.implementation.deleteDocuments(ids);
      });

      afterEach(async () => {
        const ids = tracked.splice(0).map(m => m.id).filter(id => game.messages.has(id));
        if ( ids.length ) await ChatMessage.implementation.deleteDocuments(ids);
      });

      /** Skips a test when cp-tests lacks the two Player users it needs. */
      function needPlayers(test) {
        if ( !p1 || !p2 ) test.skip();
      }

      /**
       * Creates a resolved poolRoll card from fixed results: the dice at `totalAt` make the total,
       * those at `effectAt` the effect dice. `overflow` then pushes e1 past d12 with an SFX step,
       * leaving its choice open.
       * @returns {Promise<ChatMessage>}
       */
      async function rollCard({ sizes, results, totalAt, effectAt, author, flag, overflow = false }) {
        const pool = buildPool(sizes.map((size, i) => ({ size, source: { kind: "trait", label: `Die ${i + 1}` } })));
        const rolled = applyResults(pool, results);
        const selection = {
          totalIds: totalAt.map(i => rolled[i].id), effectDieIds: effectAt.map(i => rolled[i].id),
          extraResultsPaid: 0, extraEffectDicePaid: 0, keepLimit: 2
        };
        let resolution = resolve(rolled, selection);
        if ( overflow ) resolution = stepEffectDie(rolled, resolution, "e1", 1, "other");
        const data = {
          type: "poolRoll",
          system: { schemaVersion: POOL_ROLL_SCHEMA_VERSION, pool, rolled, selection, resolution, state: "resolved" }
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

      /** TC-44's card: d10:8, d8:6, d6:4, d4:3; total 14, effect die d6 (e1), the d4 left over. */
      function tc44Card(options = {}) {
        return rollCard({ sizes: [10, 8, 6, 4], results: [8, 6, 4, 3], totalAt: [0, 1], effectAt: [2], ...options });
      }

      /** A card with a d12 effect die pushed past d12 by an SFX: d12:5, d10:7, d8:6; total 13. */
      function pastD12Card(options = {}) {
        return rollCard({ sizes: [12, 10, 8], results: [5, 7, 6], totalAt: [1, 2], effectAt: [0], overflow: true, ...options });
      }

      /**
       * A contest message written by this GM: p1 initiates as Ayla, against p2's Bren or, with
       * `gmSide`, against the GM's Brute.
       */
      async function contest({ gmSide = false } = {}) {
        const sides = [
          { key: "initiator", userId: p1.id, actorUuid: ayla.uuid, label: "Ayla" },
          gmSide ? { key: "opposition", userId: null, actorUuid: brute.uuid, label: "Brute" }
            : { key: "opposition", userId: p2.id, actorUuid: bren.uuid, label: "Bren" }
        ];
        const system = unwrap(initialSystem({ type: "contest", state: createContest().value, startedBy: game.user.id, sides }), "initialSystem");
        const message = await ChatMessage.implementation.create({ type: "contest", system });
        tracked.push(message);
        return message;
      }

      /**
       * Starts a test through the relay, as p1 rolling as Ayla against the GM's difficulty: a typed
       * number, or a roll card with a level.
       * @param {{difficulty?: number, card?: ChatMessage, level?: string}} options
       * @returns {Promise<ChatMessage>}
       */
      async function startTest({ difficulty, card, level }) {
        const request = {
          action: "start", type: "test",
          sides: [
            { key: "roller", userId: p1.id, actorUuid: ayla.uuid, label: "Ayla" },
            { key: "setter", userId: null, actorUuid: null, label: "GM" }
          ]
        };
        if ( card ) Object.assign(request, { difficultyMessageId: card.id, difficultyLevel: level ?? null });
        else request.difficulty = difficulty;
        const result = await handleContestQuery(request, { user: p1 });
        assert.isTrue(result.ok, result.code);
        const message = game.messages.get(result.value.messageId);
        tracked.push(message);
        return message;
      }

      /** One request through the GM's handler as `user`, with the message's current revision. */
      function act(user, message, action, payload = {}) {
        return handleContestQuery({ action, messageId: message.id, revision: message.system.revision, payload }, { user });
      }

      /** A typed total through the handler, failing the test on a refusal. */
      async function typed(user, message, total, effectSizes = []) {
        const result = await act(user, message, "add-roll", { total, effectSizes });
        assert.isTrue(result.ok, `${user.name} ${total}: ${result.code}`);
      }

      /** An effect die as the card lists it. */
      const die = (id, size, overflowOpen = false) => ({ id, size, overflowOpen });

      describe("a test's card", () => {
        it("TC-03 a test from a roll card shows the difficulty, its level, where it came from and the opposition's effect dice", async function() {
          needPlayers(this);
          const card = await tc03Card();
          const message = await startTest({ card, level: "hard" });
          const context = prepareContestCardContext(message, p1);
          assert.isFalse(context.highStakes);
          assert.equal(context.difficulty.total, 13);
          assert.equal(context.difficulty.level.key, "hard");
          assert.equal(context.difficulty.level.label, game.i18n.localize("CORTEX.Contest.DifficultyLevels.hard"));
          assert.equal(context.difficulty.origin, "card");
          assert.equal(context.difficulty.messageId, card.id);
          assert.deepEqual(context.difficulty.effects.map(e => e.size), [10]);
          assert.isFalse(context.difficulty.takeOut);
          assert.deepEqual(context.rolls, []);
          assert.isNull(context.outcome);
          assert.deepEqual(context.sides.map(s => [s.key, s.label, s.expected, s.winner]), [
            ["roller", "Ayla", true, false], ["setter", "GM", false, false]
          ]);
        });

        it("a typed difficulty is shown as entered by hand, with no level and no effect dice (ADR-021)", async function() {
          needPlayers(this);
          const message = await startTest({ difficulty: 9 });
          const { difficulty } = prepareContestCardContext(message, p1);
          assert.deepEqual(difficulty, { total: 9, level: null, origin: "typed", messageId: null, effects: [], takeOut: false });
        });

        it("RQ-035 the setter's take-out, chosen on the difficulty card, is shown to everyone", async function() {
          needPlayers(this);
          const card = await pastD12Card();
          await applyCardChange(card, { action: "overflow-choice", kind: "take-out" });
          assert.isTrue(card.system.resolution.takeOut);
          const message = await startTest({ card });
          for ( const user of [p1, p2, game.user] ) {
            assert.isTrue(prepareContestCardContext(message, user).difficulty.takeOut, user.name);
          }
        });

        it("a deleted difficulty card: the test keeps its total and effect dice, and its card is rendered again", async function() {
          needPlayers(this);
          const card = await tc03Card();
          const message = await startTest({ card, level: "hard" });
          await card.delete();
          const { difficulty } = prepareContestCardContext(message, p1);
          assert.equal(difficulty.origin, "deleted");
          assert.isNull(difficulty.messageId);
          assert.equal(difficulty.total, 13);
          assert.deepEqual(difficulty.effects.map(e => e.size), [10]);
          assert.deepEqual(refreshContestCards(card).map(m => m.id), [message.id]);
        });

        it("TC-44 the roll's row and the outcome: a success by 1, with no button left", async function() {
          needPlayers(this);
          const message = await startTest({ difficulty: 13 });
          const card = await tc44Card({ author: p1, flag: { messageId: message.id, side: "roller", rollIndex: 0 } });
          assert.isTrue((await sendRollCard(card)).ok);
          const context = prepareContestCardContext(message, p1);
          assert.deepEqual(context.rolls, [{
            side: "roller", label: "Ayla", total: 14, effects: [die("e1", 6)], origin: "card", messageId: card.id,
            standing: false
          }]);
          assert.deepEqual(context.outcome, { success: true, margin: 1, heroicSteps: 0, pending: null });
          assert.equal(context.status.key, "decided");
          assert.isNull(context.button);
          assert.isNull(context.controls.total);
        });

        it("TC-46 a heroic success: margin 8 gives one step, already on the only effect die", async function() {
          needPlayers(this);
          const message = await startTest({ difficulty: 8 });
          await typed(p1, message, 16, [6]);
          const context = prepareContestCardContext(message, p2);
          assert.deepEqual(context.outcome, { success: true, margin: 8, heroicSteps: 1, pending: null });
          assert.deepEqual(context.rolls[0].effects, [die("e1", 8)]);
          assert.equal(context.rolls[0].origin, "typed");
          assert.isNull(context.rolls[0].messageId);
        });

        it("TC-13 with two effect dice the heroic step waits for the roller's pick, and the card says so", async function() {
          needPlayers(this);
          const message = await startTest({ difficulty: 7 });
          await typed(p1, message, 14, [6, 6]);
          assert.deepEqual(prepareContestCardContext(message, p1).outcome, {
            success: true, margin: 7, heroicSteps: 1, pending: "heroic"
          });
        });

        it("TC-42 an effect die past d12 is marked on its row, and the card says its choice waits", async function() {
          needPlayers(this);
          const message = await startTest({ difficulty: 10 });
          const card = await pastD12Card({ author: p1, flag: { messageId: message.id, side: "roller", rollIndex: 0 } });
          assert.isTrue((await sendRollCard(card)).ok);
          const context = prepareContestCardContext(message, p1);
          assert.deepEqual(context.rolls[0].effects, [die("e1", 12, true)]);
          assert.deepEqual(context.outcome, { success: true, margin: 3, heroicSteps: 0, pending: "overflow" });
        });

        it("TC-45 a typed 9 against 10 is a failure by 1", async function() {
          needPlayers(this);
          const message = await startTest({ difficulty: 10 });
          await typed(p1, message, 9);
          assert.deepEqual(prepareContestCardContext(message, p1).outcome, {
            success: false, margin: -1, heroicSteps: 0, pending: null
          });
        });
      });

      describe("a contest's card", () => {
        it("TC-17 the exchange, sent by p1 and p2: one row per roll, the standing total marked, then the winner", async function() {
          needPlayers(this);
          const message = await contest();
          await typed(p1, message, 11, [6]);
          await typed(p2, message, 13, [8]);
          await typed(p1, message, 15, [10]);
          let context = prepareContestCardContext(message, p2);
          assert.deepEqual(context.rolls.map(r => [r.side, r.label, r.total, r.standing]), [
            ["initiator", "Ayla", 11, false], ["opposition", "Bren", 13, false], ["initiator", "Ayla", 15, true]
          ]);
          assert.deepEqual(context.sides.map(s => [s.key, s.expected, s.winner]), [
            ["initiator", false, false], ["opposition", true, false]
          ]);
          assert.isNull(context.outcome);
          assert.equal(context.toBeat, 15);

          await typed(p2, message, 12, [6]);
          context = prepareContestCardContext(message, p2);
          assert.deepEqual(context.rolls.map(r => r.standing), [false, false, true, false]);
          assert.deepEqual(context.outcome, {
            winner: "initiator", label: "Ayla", ending: "won", margin: 3, heroicSteps: 0, pending: null
          });
          assert.deepEqual(context.sides.map(s => s.winner), [true, false]);
          assert.equal(context.status.key, "decided");
        });

        it("TC-47 a heroic win: margin 5 gives one step, already on the winner's only effect die", async function() {
          needPlayers(this);
          const message = await contest();
          await typed(p1, message, 17, [8]);
          await typed(p2, message, 12, [8]);
          const context = prepareContestCardContext(message, p1);
          assert.deepInclude(context.outcome, { winner: "initiator", ending: "won", margin: 5, heroicSteps: 1, pending: null });
          assert.deepEqual(context.rolls[0].effects, [die("e1", 10)]);
        });

        it("TC-37 with two effect dice the heroic step waits for the winner's pick, and the card says so", async function() {
          needPlayers(this);
          const message = await contest();
          await typed(p1, message, 17, [8, 6]);
          await typed(p2, message, 12, [8]);
          assert.equal(prepareContestCardContext(message, p1).outcome.pending, "heroic");
        });

        it("a deleted roll card: the row keeps its total and effect dice, and the contest's card is rendered again", async function() {
          needPlayers(this);
          const message = await contest();
          const card = await tc15Card({ author: p1, flag: { messageId: message.id, side: "initiator", rollIndex: 0 } });
          assert.isTrue((await sendRollCard(card)).ok);
          assert.deepInclude(prepareContestCardContext(message, p2).rolls[0], { origin: "card", messageId: card.id });
          await card.delete();
          assert.deepEqual(prepareContestCardContext(message, p2).rolls[0], {
            side: "initiator", label: "Ayla", total: 11, effects: [die("e1", 6)], origin: "deleted", messageId: null,
            standing: true
          });
          assert.deepEqual(refreshContestCards(card).map(m => m.id), [message.id]);
        });
      });

      describe("the controls each user gets", () => {
        it("TC-15 after the initiator's 11: the opposition's user may roll, enter a total or decline; the GM also gets high stakes and close", async function() {
          needPlayers(this);
          const message = await contest();
          await typed(p1, message, 11, [6]);

          const forP2 = prepareContestCardContext(message, p2);
          assert.deepInclude(forP2.button, { side: "opposition", rollIndex: 1, toBeat: 11 });
          assert.deepEqual(forP2.controls.total, { side: "opposition" });
          assert.deepInclude(forP2.controls.giveIn, { side: "opposition", action: "decline" });
          assert.isNull(forP2.controls.highStakes);
          assert.isFalse(forP2.controls.close);

          const forP1 = prepareContestCardContext(message, p1);
          assert.isNull(forP1.button);
          assert.deepEqual(forP1.controls, { total: null, giveIn: null, highStakes: null, close: false });

          const forGM = prepareContestCardContext(message, game.user);
          assert.isNotNull(forGM.button);
          assert.deepEqual(forGM.controls.total, { side: "opposition" });
          assert.deepInclude(forGM.controls.giveIn, { side: "opposition", action: "decline" });
          assert.deepEqual(forGM.controls.highStakes, { value: false });
          assert.isTrue(forGM.controls.close);
        });

        it("TC-E02 the give-in control reads as a decline until the opposition has rolled, then as giving in", async function() {
          needPlayers(this);
          const message = await contest();
          await typed(p1, message, 11, [6]);
          const decline = prepareContestCardContext(message, p2).controls.giveIn;
          assert.equal(decline.label, game.i18n.localize("CORTEX.Contest.Card.Decline"));
          await typed(p2, message, 14, [8]);
          await typed(p1, message, 16, [8]);
          const giveIn = prepareContestCardContext(message, p2).controls.giveIn;
          assert.deepInclude(giveIn, { side: "opposition", action: "give-in" });
          assert.equal(giveIn.label, game.i18n.localize("CORTEX.Contest.Card.GiveIn"));
        });

        it("the GM's side is the GM's: a player gets no control for it", async function() {
          needPlayers(this);
          const message = await contest({ gmSide: true });
          await typed(p1, message, 11, [6]);
          for ( const user of [p1, p2] ) {
            const context = prepareContestCardContext(message, user);
            assert.isNull(context.button, user.name);
            assert.deepEqual(context.controls, { total: null, giveIn: null, highStakes: null, close: false }, user.name);
          }
          assert.deepEqual(prepareContestCardContext(message, game.user).controls.total, { side: "opposition" });
        });

        it("TC-43 a test before its roll: the roller's user may roll or enter a total; a test has no giving in", async function() {
          needPlayers(this);
          const message = await startTest({ difficulty: 13 });
          const forP1 = prepareContestCardContext(message, p1);
          assert.deepInclude(forP1.button, { side: "roller", rollIndex: 0, toBeat: 13 });
          assert.deepEqual(forP1.controls, { total: { side: "roller" }, giveIn: null, highStakes: null, close: false });
          assert.deepEqual(prepareContestCardContext(message, p2).controls, {
            total: null, giveIn: null, highStakes: null, close: false
          });
          assert.isNull(prepareContestCardContext(message, game.user).controls.giveIn);
        });
      });

      describe("the card's actions, through the function the clicks use (sendCardAction)", () => {
        it("TC-18 giving in: the other side wins, with no margin and nothing left to do but the GM's controls", async function() {
          needPlayers(this);
          const message = await contest();
          await typed(p1, message, 11, [6]);
          await typed(p2, message, 14, [8]);
          assert.deepInclude(prepareContestCardContext(message, p1).controls.giveIn, { side: "initiator", action: "give-in" });
          const result = await sendCardAction(message, "give-in", { side: "initiator" });
          assert.isTrue(result.ok, result.code);
          const context = prepareContestCardContext(message, p1);
          assert.deepEqual(context.outcome, {
            winner: "opposition", label: "Bren", ending: "gaveIn", margin: null, heroicSteps: 0, pending: null
          });
          assert.isNull(context.button);
          assert.deepEqual(context.controls, { total: null, giveIn: null, highStakes: null, close: false });
          assert.isTrue(prepareContestCardContext(message, game.user).controls.close);
        });

        it("TC-18b declining after the initiator's roll: the initiator wins by a decline", async function() {
          needPlayers(this);
          const message = await contest();
          await typed(p1, message, 13, [6]);
          const result = await sendCardAction(message, "decline", {});
          assert.isTrue(result.ok, result.code);
          assert.deepInclude(prepareContestCardContext(message, p2).outcome, {
            winner: "initiator", ending: "declined", margin: null
          });
        });

        it("TC-54b typed totals with typed effect dice, built as the dialog builds them", async function() {
          needPlayers(this);
          assert.deepEqual(typedRollPayload("initiator", { total: 12, d10: 1, d6: 2 }), {
            side: "initiator", total: 12, effectSizes: [10, 6, 6]
          });
          assert.deepEqual(typedRollPayload("roller", { total: 9, d4: 0, d6: 0, d8: 0, d10: 0, d12: 0 }), {
            side: "roller", total: 9, effectSizes: []
          });

          const message = await contest({ gmSide: true });
          for ( const [side, data] of [
            ["initiator", { total: 11 }], ["opposition", { total: 13, d8: 1 }], ["initiator", { total: 12, d10: 1 }]
          ] ) {
            const result = await sendCardAction(message, "add-roll", typedRollPayload(side, data));
            assert.isTrue(result.ok, `${side} ${data.total}: ${result.code}`);
          }
          const context = prepareContestCardContext(message, p1);
          assert.deepEqual(context.rolls.map(r => [r.total, r.origin, r.effects.map(e => e.size)]), [
            [11, "typed", []], [13, "typed", [8]], [12, "typed", [10]]
          ]);
          assert.deepInclude(context.outcome, { winner: "opposition", ending: "won", margin: 1 });
        });

        it("TC-E04 a refused action is answered with its code and writes nothing", async function() {
          needPlayers(this);
          const message = await contest();
          assert.deepEqual(await sendCardAction(message, "add-roll", typedRollPayload("initiator", { total: -1 })), {
            ok: false, code: "INVALID_TOTAL"
          });
          assert.equal(message.system.revision, 0);
        });

        it("TC-51 high stakes: the GM turns it on and off, everyone sees the badge, and a player is refused", async function() {
          needPlayers(this);
          const message = await contest();
          assert.deepEqual(await act(p1, message, "set-high-stakes", { highStakes: true }), { ok: false, code: "GM_ONLY" });
          assert.isTrue((await sendCardAction(message, "set-high-stakes", { highStakes: true })).ok);
          assert.isTrue(prepareContestCardContext(message, p1).highStakes);
          assert.deepEqual(prepareContestCardContext(message, game.user).controls.highStakes, { value: true });
          assert.isTrue((await sendCardAction(message, "set-high-stakes", { highStakes: false })).ok);
          assert.isFalse(prepareContestCardContext(message, p2).highStakes);
        });

        it("high stakes stays the GM's to change on a decided card, until it is closed (ADR-022)", async function() {
          needPlayers(this);
          const message = await startTest({ difficulty: 13 });
          await typed(p1, message, 14, [6]);
          assert.deepEqual(prepareContestCardContext(message, game.user).controls.highStakes, { value: false });
          assert.isTrue((await sendCardAction(message, "set-high-stakes", { highStakes: true })).ok);
          assert.isTrue(prepareContestCardContext(message, p1).highStakes);
        });

        it("TC-52 closing: only the GM may; a closed card keeps its outcome and offers nothing", async function() {
          needPlayers(this);
          const message = await startTest({ difficulty: 13 });
          await typed(p1, message, 14, [6]);
          assert.deepEqual(await act(p1, message, "close"), { ok: false, code: "GM_ONLY" });
          assert.isTrue((await sendCardAction(message, "close", {})).ok);
          for ( const user of [p1, game.user] ) {
            const context = prepareContestCardContext(message, user);
            assert.equal(context.status.key, "closed", user.name);
            assert.deepInclude(context.outcome, { success: true, margin: 1 }, user.name);
            assert.isNull(context.button, user.name);
            assert.deepEqual(context.controls, { total: null, giveIn: null, highStakes: null, close: false }, user.name);
          }
          assert.deepEqual(await sendCardAction(message, "close", {}), { ok: false, code: "CONTEST_CLOSED" });
        });

        it("a test closed before its roll (a declined test) offers no roll", async function() {
          needPlayers(this);
          const message = await startTest({ difficulty: 13 });
          assert.isTrue((await sendCardAction(message, "close", {})).ok);
          const context = prepareContestCardContext(message, p1);
          assert.equal(context.status.key, "closed");
          assert.isNull(context.outcome);
          assert.isNull(context.button);
          assert.isNull(context.controls.total);
        });

        it("a request made against an earlier revision of the card is refused with STALE_REVISION", async function() {
          needPlayers(this);
          const message = await contest();
          await typed(p1, message, 11, [6]);
          await typed(p2, message, 14, [8]);
          const stale = { action: "give-in", messageId: message.id, revision: 1, payload: { side: "initiator" } };
          assert.deepEqual(await handleContestQuery(stale, { user: p1 }), { ok: false, code: "STALE_REVISION" });
          assert.equal(message.system.flow.status, "open");
        });
      });

      describe("the lock on a sent roll card", () => {
        it("a held card still steps its effect dice; once sent it refuses the step and shows no step controls", async function() {
          needPlayers(this);
          const message = await contest();
          const card = await tc15Card({ flag: { messageId: message.id, side: "initiator", rollIndex: 0 } });
          assert.isNotNull(preparePoolRollCardContext(card).effectControls);
          await applyCardChange(card, { action: "step-effect-die", effectId: "e1", steps: 1 });
          assert.equal(card.system.resolution.effectDice[0].size, 8);

          assert.isTrue((await sendRollCard(card)).ok);
          assert.equal(message.system.flow.rolls[0].effects[0].size, 8);
          const context = preparePoolRollCardContext(card);
          assert.equal(context.contestHold?.state, "sent");
          assert.isNull(context.effectControls);
          await applyCardChange(card, { action: "step-effect-die", effectId: "e1", steps: 1 });
          assert.equal(card.system.resolution.effectDice[0].size, 8, "the step is refused");
          assert.equal(message.system.flow.rolls[0].effects[0].size, 8);
        });

        it("a sent card stays locked after its contest is closed, and is free again when the contest message is deleted", async function() {
          needPlayers(this);
          const message = await contest();
          const card = await tc15Card({ flag: { messageId: message.id, side: "initiator", rollIndex: 0 } });
          assert.isTrue((await sendRollCard(card)).ok);
          assert.isTrue((await sendCardAction(message, "close", {})).ok);
          assert.isNull(preparePoolRollCardContext(card).effectControls);
          await applyCardChange(card, { action: "step-effect-die", effectId: "e1", steps: 1 });
          assert.equal(card.system.resolution.effectDice[0].size, 6);

          await message.delete();
          assert.isNotNull(preparePoolRollCardContext(card).effectControls);
          await applyCardChange(card, { action: "step-effect-die", effectId: "e1", steps: 1 });
          assert.equal(card.system.resolution.effectDice[0].size, 8);
        });
      });
    },
    { displayName: "Cortex Prime: contest card" }
  );
}
