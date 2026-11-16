/**
 * Quench batch "cortex-prime.contest-ending": the end of a test or contest on its card (Decisions
 * ADR-020 and ADR-027, Step 4.4 S4b proposal review): the die for the heroic steps, the choice for
 * an effect die past d12, the effect dice used against the loser, the consequence and its preview,
 * a card closed before its end choices, and which dice past d12 are still marked. Run as the active
 * GM in `cp-tests`, which needs two Player users; the batch creates the actors it needs and calls
 * the query handler with those users as senders, the way Foundry passes the querying user.
 * @module tests/quench/contest-ending
 */

import { prepareContestCardContext, sendCardAction } from "../../module/contest/contest-card.mjs";
import { handleContestQuery } from "../../module/contest/relay.mjs";
import { CONTEST_FLAG, sendRollCard } from "../../module/contest/roll-card.mjs";
import { initialSystem } from "../../module/data/chat/contest-mapping.mjs";
import { POOL_ROLL_SCHEMA_VERSION } from "../../module/data/chat/pool-roll.mjs";
import { applyResults, buildPool, createContest, resolve, stepEffectDie } from "../../module/rules/index.mjs";

const SCOPE = "cortex-prime";

/** What a user with no end choice to make gets. */
const NO_END = { heroic: null, overflows: [], pick: null };

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
export function registerContestEndingBatch(quench) {
  quench.registerBatch(
    "cortex-prime.contest-ending",
    ({ describe, it, assert, before, after, afterEach }) => {
      /** @type {ChatMessage[]} */
      const tracked = [];
      let p1;
      let p2;
      let ayla;
      let bren;

      before(async () => {
        [p1, p2] = game.users.filter(u => !u.isGM);
        if ( !p1 || !p2 ) return;
        // One at a time: createDocuments doesn't promise to return the documents in the order given.
        const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
        const create = (name, ownership) => Actor.implementation.create({ name, type: "character", ownership });
        ayla = await create("Ayla (contest-ending)", { default: 0, [p1.id]: OWNER });
        bren = await create("Bren (contest-ending)", { default: 0, [p2.id]: OWNER });
      });

      after(async () => {
        const ids = [ayla, bren].filter(actor => actor && game.actors.has(actor.id)).map(actor => actor.id);
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
       * Creates a resolved poolRoll card by p1 from fixed results, flagged for a test or contest:
       * the dice at `totalAt` make the total, those at `effectAt` the effect dice. `overflow` then
       * pushes e1 past d12 with an SFX step, leaving its choice open.
       * @returns {Promise<ChatMessage>}
       */
      async function rollCard({ sizes, results, totalAt, effectAt, flag, extraEffectDicePaid = 0, overflow = false }) {
        const pool = buildPool(sizes.map((size, i) => ({ size, source: { kind: "trait", label: `Die ${i + 1}` } })));
        const rolled = applyResults(pool, results);
        const selection = {
          totalIds: totalAt.map(i => rolled[i].id), effectDieIds: effectAt.map(i => rolled[i].id),
          extraResultsPaid: 0, extraEffectDicePaid, keepLimit: 2
        };
        let resolution = resolve(rolled, selection);
        if ( overflow ) resolution = stepEffectDie(rolled, resolution, "e1", 1, "other");
        const message = await ChatMessage.implementation.create({
          type: "poolRoll", author: p1.id, flags: { [SCOPE]: { [CONTEST_FLAG]: flag } },
          system: { schemaVersion: POOL_ROLL_SCHEMA_VERSION, pool, rolled, selection, resolution, state: "resolved" }
        });
        tracked.push(message);
        return message;
      }

      /** A contest message written by this GM: p1 initiates as Ayla against p2's Bren. */
      async function contest() {
        const sides = [
          { key: "initiator", userId: p1.id, actorUuid: ayla.uuid, label: "Ayla" },
          { key: "opposition", userId: p2.id, actorUuid: bren.uuid, label: "Bren" }
        ];
        const system = unwrap(initialSystem({ type: "contest", state: createContest().value, startedBy: game.user.id, sides }), "initialSystem");
        const message = await ChatMessage.implementation.create({ type: "contest", system });
        tracked.push(message);
        return message;
      }

      /** Starts a test with a typed difficulty through the relay: p1 rolls as Ayla, the GM sets it. */
      async function startTest(difficulty) {
        const result = await handleContestQuery({
          action: "start", type: "test", difficulty,
          sides: [
            { key: "roller", userId: p1.id, actorUuid: ayla.uuid, label: "Ayla" },
            { key: "setter", userId: null, actorUuid: null, label: "GM" }
          ]
        }, { user: p1 });
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

      /** One card action as this GM, failing the test on a refusal. */
      async function choose(message, action, payload) {
        const result = await sendCardAction(message, action, payload);
        assert.isTrue(result.ok, `${action}: ${result.code}`);
      }

      /** A contest p1 wins with typed totals: p1's total and effect dice, then p2's failing roll. */
      async function wonContest(total, effectSizes, loserTotal, loserSizes) {
        const message = await contest();
        await typed(p1, message, total, effectSizes);
        await typed(p2, message, loserTotal, loserSizes);
        return message;
      }

      /**
       * TC-36's contest: p1's card (d10:8, d8:7, d12:5, d4:3; total 15, e1 past d12, the d4 left
       * over) is sent, and p2's 12 with a d8 fails.
       */
      async function tc36() {
        const message = await contest();
        const card = await rollCard({
          sizes: [10, 8, 12, 4], results: [8, 7, 5, 3], totalAt: [0, 1], effectAt: [2], overflow: true,
          flag: { messageId: message.id, side: "initiator", rollIndex: 0 }
        });
        assert.isTrue((await sendRollCard(card)).ok);
        await typed(p2, message, 12, [8]);
        return message;
      }

      /** The sizes of the effect dice the card lists for a roll. */
      const sizesOf = (context, index = 0) => context.rolls[index].effects.map(e => e.size);

      /** The complications a consequence lists, one per comparison. */
      const complications = consequence => consequence.comparisons.map(c => c.complication);

      describe("the heroic steps", () => {
        it("TC-37 with two effect dice the winner's user and the GM pick the die; nobody sees a consequence yet", async function() {
          needPlayers(this);
          const message = await wonContest(17, [8, 6], 12, [8]);
          for ( const user of [p1, game.user] ) {
            const context = prepareContestCardContext(message, user);
            assert.deepEqual(context.end, {
              heroic: { steps: 1, dice: [{ effectId: "e1", size: 8 }, { effectId: "e2", size: 6 }] }, overflows: [], pick: null
            }, user.name);
            assert.isNull(context.consequence, user.name);
          }
          assert.deepEqual(prepareContestCardContext(message, p2).end, NO_END);
          assert.deepEqual(await act(p2, message, "apply-heroic-steps", { effectId: "e1" }), { ok: false, code: "NOT_YOUR_SIDE" });
        });

        it("TC-37 the steps on e1: d10 and d6, then a preview with both dice used against the loser", async function() {
          needPlayers(this);
          const message = await wonContest(17, [8, 6], 12, [8]);
          await choose(message, "apply-heroic-steps", { effectId: "e1" });
          const context = prepareContestCardContext(message, p1);
          assert.deepEqual(sizesOf(context), [10, 6]);
          assert.isNull(context.outcome.pending);
          assert.deepEqual(context.end, {
            heroic: null, overflows: [],
            pick: { dice: [{ effectId: "e1", size: 10, checked: true }, { effectId: "e2", size: 6, checked: true }] }
          });
          assert.isTrue(context.consequence.preview);
          assert.deepEqual(complications(context.consequence), [10, 4]);
          assert.isTrue(prepareContestCardContext(message, p2).consequence.preview, "everyone sees the preview");
        });

        it("TC-13 a test's step waits for the roller's pick; once placed, the result shows the dice as they stand", async function() {
          needPlayers(this);
          const message = await startTest(7);
          await typed(p1, message, 14, [6, 6]);
          let context = prepareContestCardContext(message, p1);
          assert.deepEqual(context.end.heroic, { steps: 1, dice: [{ effectId: "e1", size: 6 }, { effectId: "e2", size: 6 }] });
          assert.isNull(context.result);
          await choose(message, "apply-heroic-steps", { effectId: "e2" });
          context = prepareContestCardContext(message, p1);
          assert.deepEqual(context.end, NO_END);
          assert.deepEqual(context.result, { effects: [{ id: "e1", size: 6 }, { id: "e2", size: 8 }], takeOut: false });
          assert.isNull(context.consequence, "a test has no consequence");
        });
      });

      describe("an effect die past d12", () => {
        it("TC-36 the winner's user is offered the leftover d4, a new d6 and the take-out; the die is marked", async function() {
          needPlayers(this);
          const message = await tc36();
          const context = prepareContestCardContext(message, p1);
          assert.lengthOf(context.end.overflows, 1);
          const [overflow] = context.end.overflows;
          assert.deepInclude(overflow, { effectId: "e1", newDie: 6, takeOut: true });
          assert.deepEqual(overflow.leftovers.map(l => l.size), [4]);
          assert.isNull(context.end.pick);
          assert.isNull(context.consequence);
          assert.isTrue(context.rolls[0].effects[0].overflowOpen);
          assert.deepEqual(prepareContestCardContext(message, p2).end, NO_END);
        });

        it("TC-36 the take-out: taken out by the overflowed die, which isn't compared; a PP would give a d12 complication", async function() {
          needPlayers(this);
          const message = await tc36();
          await choose(message, "choose-overflow", { effectId: "e1", kind: "take-out" });
          const context = prepareContestCardContext(message, p2);
          assert.deepInclude(context.consequence, { takenOut: true, takeOutCause: "overflow" });
          assert.deepEqual(context.consequence.avoidWithPP, [{ effectId: "e1", size: 12 }]);
          assert.deepEqual(context.consequence.comparisons, []);
          assert.isFalse(context.rolls[0].effects[0].overflowOpen);
        });

        it("TC-36 the leftover d4 as a second effect die: a d12 complication, and the d4 is stepped away", async function() {
          needPlayers(this);
          const message = await tc36();
          const { dieId } = prepareContestCardContext(message, p1).end.overflows[0].leftovers[0];
          await choose(message, "choose-overflow", { effectId: "e1", kind: "leftover", dieId });
          const context = prepareContestCardContext(message, p1);
          assert.deepEqual(sizesOf(context), [12, 4]);
          assert.deepEqual(complications(context.consequence), [12, null]);
          assert.isFalse(context.consequence.takenOut);
        });

        it("TC-39 the heroic steps come first; put on the die past d12 they join its one choice", async function() {
          needPlayers(this);
          const message = await contest();
          const card = await rollCard({
            sizes: [10, 8, 12, 6], results: [9, 8, 2, 3], totalAt: [0, 1], effectAt: [2, 3], extraEffectDicePaid: 1,
            overflow: true, flag: { messageId: message.id, side: "initiator", rollIndex: 0 }
          });
          assert.isTrue((await sendRollCard(card)).ok);
          await typed(p2, message, 12, [8]);
          let context = prepareContestCardContext(message, p1);
          assert.lengthOf(context.end.heroic.dice, 2);
          assert.deepEqual(context.end.overflows, []);

          await choose(message, "apply-heroic-steps", { effectId: "e1" });
          context = prepareContestCardContext(message, p1);
          assert.isNull(context.end.heroic);
          assert.deepEqual(context.end.overflows, [{ effectId: "e1", leftovers: [], newDie: 6, takeOut: true }]);
          assert.deepEqual(sizesOf(context), [12, 6]);
        });

        it("TC-42 a test's overflow is chosen on its card: a new d6, or the take-out or victory", async function() {
          needPlayers(this);
          for ( const [kind, sizes, takeOut] of [["new-d6", [12, 6], false], ["take-out", [12], true]] ) {
            const message = await startTest(10);
            const card = await rollCard({
              sizes: [12, 10, 8], results: [5, 7, 6], totalAt: [1, 2], effectAt: [0], overflow: true,
              flag: { messageId: message.id, side: "roller", rollIndex: 0 }
            });
            assert.isTrue((await sendRollCard(card)).ok);
            let context = prepareContestCardContext(message, p1);
            assert.deepEqual(context.end.overflows, [{ effectId: "e1", leftovers: [], newDie: 6, takeOut: true }]);
            assert.isNull(context.result);
            await choose(message, "choose-overflow", { effectId: "e1", kind });
            context = prepareContestCardContext(message, p1);
            assert.deepEqual(context.result.effects.map(e => e.size), sizes, kind);
            assert.equal(context.result.takeOut, takeOut, kind);
            assert.deepEqual(context.end, NO_END);
          }
        });

        it("TC-34 an overflow on a beaten roll is no longer marked", async function() {
          needPlayers(this);
          const message = await contest();
          const card = await rollCard({
            sizes: [10, 8, 12, 4], results: [7, 6, 5, 3], totalAt: [0, 1], effectAt: [2], overflow: true,
            flag: { messageId: message.id, side: "initiator", rollIndex: 0 }
          });
          assert.isTrue((await sendRollCard(card)).ok);
          assert.isTrue(prepareContestCardContext(message, p2).rolls[0].effects[0].overflowOpen, "the standing roll");
          await typed(p2, message, 15, [8]);
          assert.isFalse(prepareContestCardContext(message, p2).rolls[0].effects[0].overflowOpen, "beaten");
        });

        it("TC-55 a failed test's overflow has lapsed: no mark, nothing offered, and the die counts as a d12", async function() {
          needPlayers(this);
          const message = await startTest(15);
          const card = await rollCard({
            sizes: [12, 10, 8], results: [5, 7, 6], totalAt: [1, 2], effectAt: [0], overflow: true,
            flag: { messageId: message.id, side: "roller", rollIndex: 0 }
          });
          assert.isTrue((await sendRollCard(card)).ok);
          const context = prepareContestCardContext(message, p1);
          assert.isFalse(context.outcome.success);
          assert.isFalse(context.rolls[0].effects[0].overflowOpen);
          assert.deepEqual(context.end, NO_END);
          assert.deepEqual(context.result, { effects: [{ id: "e1", size: 12 }], takeOut: false });
        });
      });

      describe("the effect dice used against the loser, and the consequence", () => {
        it("TC-27 one effect die: the heroic step comes first, so d10 against d8 is a d10 complication", async function() {
          needPlayers(this);
          const message = await wonContest(17, [8], 12, [8]);
          const { consequence, end } = prepareContestCardContext(message, p1);
          assert.deepEqual(consequence.comparisons, [{
            effectId: "e1", winnerDie: 10, loserDie: 8, steppedDown: false, complication: 10, takesOut: false
          }]);
          assert.deepInclude(consequence, { preview: true, ending: "won", takenOut: false, avoidWithPP: null });
          assert.deepEqual(end.pick, { dice: [{ effectId: "e1", size: 10, checked: true }] });
        });

        it("TC-28 the pick: a preview with both dice, then only the picked ones, and it can be made again", async function() {
          needPlayers(this);
          const message = await wonContest(15, [10, 6], 12, [8]);
          let context = prepareContestCardContext(message, p1);
          assert.isTrue(context.consequence.preview);
          assert.deepEqual(complications(context.consequence), [10, 4]);

          await choose(message, "use-against-loser", { effectIds: ["e1"] });
          context = prepareContestCardContext(message, p1);
          assert.isFalse(context.consequence.preview);
          assert.deepEqual(complications(context.consequence), [10]);
          assert.deepEqual(context.end.pick.dice.map(d => d.checked), [true, false]);

          await choose(message, "use-against-loser", { effectIds: ["e1", "e2"] });
          context = prepareContestCardContext(message, p2);
          assert.isFalse(context.consequence.preview);
          assert.deepEqual(complications(context.consequence), [10, 4]);
          assert.deepEqual(await act(p2, message, "use-against-loser", { effectIds: [] }), { ok: false, code: "NOT_YOUR_SIDE" });
        });

        it("TC-28b and TC-51 high stakes changes the consequence: taken out by the d10, a d6 complication not stepped down", async function() {
          needPlayers(this);
          const message = await wonContest(15, [10, 6], 12, [8]);
          await choose(message, "set-high-stakes", { highStakes: true });
          let { consequence } = prepareContestCardContext(message, p2);
          assert.deepInclude(consequence, { takenOut: true, takeOutCause: "comparison" });
          assert.deepEqual(consequence.avoidWithPP, [{ effectId: "e1", size: 10 }]);
          assert.deepEqual(complications(consequence), [10, 6]);

          await choose(message, "set-high-stakes", { highStakes: false });
          ({ consequence } = prepareContestCardContext(message, p2));
          assert.isFalse(consequence.takenOut);
          assert.deepEqual(complications(consequence), [10, 4]);
        });

        it("TC-31 two dice would take the loser out: one take-out, and one PP would give both complications", async function() {
          needPlayers(this);
          const message = await wonContest(15, [10, 8], 12, [6]);
          await choose(message, "set-high-stakes", { highStakes: true });
          const { consequence } = prepareContestCardContext(message, p1);
          assert.isTrue(consequence.takenOut);
          assert.deepEqual(consequence.avoidWithPP, [{ effectId: "e1", size: 10 }, { effectId: "e2", size: 8 }]);
        });

        it("TC-18 giving in after rolling: no complication, a PP may be earned, and the initiator can't start again straight away", async function() {
          needPlayers(this);
          const message = await contest();
          await typed(p1, message, 11, [6]);
          await typed(p2, message, 14, [8]);
          await choose(message, "give-in", { side: "initiator" });
          const context = prepareContestCardContext(message, p1);
          assert.deepInclude(context.consequence, {
            preview: false, ending: "gaveIn", takenOut: false, ppEligible: true, rematchBlocked: true
          });
          assert.deepEqual(context.consequence.comparisons, []);
          assert.deepEqual(context.end, NO_END);
        });

        it("TC-18 the opposition giving in after rolling may earn a PP too, with no rematch note", async function() {
          needPlayers(this);
          const message = await contest();
          await typed(p1, message, 11, [6]);
          await typed(p2, message, 14, [8]);
          await typed(p1, message, 16, [8]);
          await choose(message, "give-in", { side: "opposition" });
          assert.deepInclude(prepareContestCardContext(message, p2).consequence, {
            ending: "gaveIn", ppEligible: true, rematchBlocked: false
          });
        });

        it("TC-18b a decline after the initiator's roll shows its effect dice; before it, that no die was rolled", async function() {
          needPlayers(this);
          const rolled = await contest();
          await typed(p1, rolled, 13, [6]);
          await choose(rolled, "decline", {});
          assert.deepInclude(prepareContestCardContext(rolled, p1).consequence, {
            ending: "declined", ppEligible: false, unrolled: false
          });
          assert.deepEqual(prepareContestCardContext(rolled, p1).consequence.winnerEffects, [{ id: "e1", size: 6 }]);

          const unrolled = await contest();
          await choose(unrolled, "decline", {});
          const { consequence } = prepareContestCardContext(unrolled, p1);
          assert.deepInclude(consequence, { ending: "declined", unrolled: true });
          assert.deepEqual(consequence.winnerEffects, []);
        });
      });

      describe("a closed card", () => {
        it("closed while the heroic steps wait: it says so, shows no consequence and offers nothing", async function() {
          needPlayers(this);
          const message = await wonContest(17, [8, 6], 12, [8]);
          await choose(message, "close", {});
          for ( const user of [p1, game.user] ) {
            const context = prepareContestCardContext(message, user);
            assert.isTrue(context.closedEarly, user.name);
            assert.isNull(context.consequence, user.name);
            assert.deepEqual(context.end, NO_END, user.name);
            assert.deepInclude(context.outcome, { winner: "initiator", heroicSteps: 1 }, user.name);
          }
        });

        it("closed after its end choices: the consequence stays, and the pick can't be changed", async function() {
          needPlayers(this);
          const message = await wonContest(17, [8], 12, [8]);
          await choose(message, "use-against-loser", { effectIds: ["e1"] });
          await choose(message, "close", {});
          const context = prepareContestCardContext(message, p1);
          assert.isFalse(context.closedEarly);
          assert.deepEqual(complications(context.consequence), [10]);
          assert.deepEqual(context.end, NO_END);
        });
      });
    },
    { displayName: "Cortex Prime: contest ending" }
  );
}
