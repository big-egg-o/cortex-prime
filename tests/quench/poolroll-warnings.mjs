/**
 * Quench batch "cortex-prime.poolroll-warnings": a pool's warnings and unpriced traits stored on
 * the poolRoll message when it is rolled, and shown on its card as a nonstandard selection
 * (Decisions ADR-029 consequences; Rules Questions RQ-030), each set named as it was when the
 * pool was rolled (ADR-047). The batch stores the ADR-036 defaults as the world's game
 * configuration while it runs, so set names resolve, and puts the stored one back afterwards;
 * every message and actor it creates is deleted.
 * @module tests/quench/poolroll-warnings
 */

import { applyResults, buildPool, defaultGameConfig, removeTraitSet, resolve, traitSetById } from "../../module/rules/index.mjs";
import { GAME_CONFIG_SETTING, getGameConfig } from "../../module/config/settings.mjs";
import { postPoolRoll } from "../../module/dice/post-pool-roll.mjs";
import { renderPoolRollCard } from "../../module/dice/pool-roll-card.mjs";

// Ids from the ADR-036 defaults.
const PC_KIND = "cpKindPlayerChar";
const SKILLS = "cpSetSkills00000";
const ATTRIBUTES = "cpSetAttributes0";
const FIGHT = "cpSkillFight0000";

const FLAG_SCOPE = "cortex-prime";
const FLAG_KEY = "quenchPoolRollWarnings";

/** @returns {object} data as it is stored: a JSON round trip */
function plain(data) {
  return JSON.parse(JSON.stringify(data));
}

/**
 * A pool of trait dice: Fight d8 from an actor, and Shoot d6 and Sneak d6 from the same skills set.
 * @param {string} actorId
 * @returns {import("../../module/rules/types.mjs").PoolDie[]}
 */
function traitPool(actorId) {
  return buildPool([
    { size: 8, source: { kind: "trait", actorId, traitId: "skillfight000001", label: "Fight" } },
    { size: 6, source: { kind: "trait", actorId, traitId: "skillshoot000001", label: "Shoot" } },
    { size: 6, source: { kind: "trait", actorId, traitId: "skillsneak000001", label: "Sneak" } }
  ]);
}

/**
 * Register the batch with Quench.
 * @param {object} quench
 */
export function registerPoolRollWarningsBatch(quench) {
  quench.registerBatch(
    "cortex-prime.poolroll-warnings",
    ({ describe, it, assert, before, after, afterEach }) => {
      let storedConfig;
      /** @type {ChatMessage[]} */
      let messages = [];
      /** @type {Actor[]} */
      let actors = [];
      const actorId = foundry.utils.randomID();

      before(async () => {
        storedConfig = getGameConfig();
        await game.settings.set("cortex-prime", GAME_CONFIG_SETTING, defaultGameConfig());
      });
      after(async () => {
        if ( storedConfig ) await game.settings.set("cortex-prime", GAME_CONFIG_SETTING, storedConfig);
      });
      afterEach(async () => {
        for ( const message of messages ) await message.delete();
        for ( const actor of actors ) await actor.delete();
        messages = [];
        actors = [];
      });

      /** Posts a roll of the trait pool with fixed results and keeps it for clean-up. */
      const post = async params => {
        const message = await postPoolRoll({ pool: traitPool(actorId), results: [5, 4, 3], ...params });
        messages.push(message);
        return message;
      };

      /** @returns {object} a warning as it is stored: with its set's name in the defaults, where it names a set */
      const labelled = warning => {
        const name = warning.setId ? traitSetById(defaultGameConfig(), warning.setId)?.name : null;
        return name ? { ...warning, setLabel: name } : warning;
      };

      /** @returns {Promise<HTMLElement>} the card's rendered body */
      const card = async message => foundry.utils.parseHTML(`<div>${await renderPoolRollCard(message)}</div>`);

      describe("storing them with the roll (ADR-029 consequences, RQ-030)", () => {
        it("postPoolRoll stores the warnings and unpriced traits it is given, adding only each set's name (ADR-047)", async () => {
          const warnings = [
            { code: "TRAIT_SHUT_DOWN", setId: SKILLS, actorId, traitId: "skillfight000001" },
            { code: "TRAIT_SET_SHUT_DOWN", setId: SKILLS },
            { code: "EXTRA_TRAIT_NOT_ALLOWED", setId: SKILLS },
            { code: "PRIME_SET_MISSING", setId: ATTRIBUTES },
            { code: "RATING_CONFLICTS_WITH_SET" }
          ];
          const unpricedTraits = [{ setId: SKILLS, count: 2 }];
          const message = await post({ warnings: foundry.utils.deepClone(warnings), unpricedTraits: foundry.utils.deepClone(unpricedTraits) });
          const stored = plain(game.messages.get(message.id).system.toObject());
          assert.deepEqual(stored.warnings, warnings.map(labelled));
          assert.deepEqual(stored.unpricedTraits, unpricedTraits);
        });

        it("ADR-047: keeps a set label the caller gives, and gives no label to a set the configuration lacks", async () => {
          const unknown = foundry.utils.randomID();
          const message = await post({ warnings: [
            { code: "TRAIT_SET_SHUT_DOWN", setId: SKILLS, setLabel: "Old skills" },
            { code: "TRAIT_ORPHANED", setId: unknown },
            { code: "PRIME_SET_MISSING", setId: ATTRIBUTES }
          ] });
          assert.deepEqual(plain(game.messages.get(message.id).system.toObject()).warnings, [
            { code: "TRAIT_SET_SHUT_DOWN", setId: SKILLS, setLabel: "Old skills" },
            { code: "TRAIT_ORPHANED", setId: unknown },
            { code: "PRIME_SET_MISSING", setId: ATTRIBUTES, setLabel: "Attributes" }
          ]);
        });

        it("postPoolRoll stores empty lists when it is given none", async () => {
          const message = await post({});
          const stored = plain(game.messages.get(message.id).system.toObject());
          assert.deepEqual(stored.warnings, []);
          assert.deepEqual(stored.unpricedTraits, []);
        });

        it("refuses a warning without a code and an unpriced count that isn't a whole number from 1", async () => {
          const bad = [
            { warnings: [{ setId: SKILLS }] },
            { warnings: [{ code: "" }] },
            { unpricedTraits: [{ setId: SKILLS, count: 0 }] },
            { unpricedTraits: [{ setId: SKILLS, count: 1.5 }] },
            { unpricedTraits: [{ count: 1 }] }
          ];
          for ( const params of bad ) {
            const countBefore = game.messages.size;
            let error = null;
            try {
              const message = await postPoolRoll({ pool: traitPool(actorId), results: [5, 4, 3], ...params });
              if ( message ) messages.push(message);
            }
            catch( err ) {
              error = err;
            }
            assert.isNotNull(error, JSON.stringify(params));
            assert.equal(game.messages.size, countBefore, JSON.stringify(params));
          }
        });

        it("ADR-029: a stored message keeps its warnings after the actor changes", async () => {
          const actor = await Actor.implementation.create({
            name: "[Quench] warnings", type: "character", flags: { [FLAG_SCOPE]: { [FLAG_KEY]: true } },
            system: { kindId: PC_KIND, traits: { [SKILLS]: { entries: [
              { id: "skillfight000001", defId: FIGHT, name: "Fight", dice: [8] }
            ] } } }
          });
          actors.push(actor);
          const pool = traitPool(actor.id);
          const warnings = [{ code: "TRAIT_SHUT_DOWN", setId: SKILLS, actorId: actor.id, traitId: "skillfight000001" }];
          const message = await postPoolRoll({ pool, results: [5, 4, 3], warnings: foundry.utils.deepClone(warnings) });
          messages.push(message);

          await actor.update({
            name: "[Quench] warnings changed",
            [`system.traits.${SKILLS}.entries`]: [{ id: "skillfight000001", defId: FIGHT, name: "Brawl", dice: [10] }]
          });

          const stored = game.messages.get(message.id);
          assert.deepEqual(plain(stored.system.toObject()).warnings, warnings.map(labelled));
          const reasons = [...(await card(stored)).querySelectorAll(".cp-nonstandard li")].map(li => li.textContent.trim());
          assert.deepEqual(reasons, [game.i18n.format("CORTEX.Chat.Nonstandard.WithName", {
            reason: game.i18n.localize("CORTEX.Chat.Nonstandard.Reasons.TRAIT_SHUT_DOWN"), name: "Fight"
          })], "the reason names the trait as it was rolled");
        });
      });

      describe("the card (ADR-029, RQ-030)", () => {
        const reason = (code, name) => {
          const text = game.i18n.localize(`CORTEX.Chat.Nonstandard.Reasons.${code}`);
          return name ? game.i18n.format("CORTEX.Chat.Nonstandard.WithName", { reason: text, name }) : text;
        };

        it("shows a nonstandard selection with one reason per warning, naming the trait or set", async () => {
          const message = await post({ warnings: [
            { code: "TRAIT_SHUT_DOWN", setId: SKILLS, actorId, traitId: "skillfight000001" },
            { code: "TRAIT_SET_SHUT_DOWN", setId: SKILLS },
            { code: "EXTRA_TRAIT_NOT_ALLOWED", setId: SKILLS },
            { code: "PRIME_SET_MISSING", setId: ATTRIBUTES },
            { code: "TRAIT_ORPHANED", setId: foundry.utils.randomID(), actorId, traitId: "skillsneak000001" },
            { code: "RATING_CONFLICTS_WITH_SET" }
          ] });
          const html = await card(message);
          const section = html.querySelector(".cp-nonstandard");
          assert.isNotNull(section);
          assert.include(section.textContent, game.i18n.localize("CORTEX.Chat.Nonstandard.Title"));
          assert.deepEqual([...section.querySelectorAll("li")].map(li => li.textContent.trim()), [
            reason("TRAIT_SHUT_DOWN", "Fight"),
            reason("TRAIT_SET_SHUT_DOWN", "Skills"),
            reason("EXTRA_TRAIT_NOT_ALLOWED", "Skills"),
            reason("PRIME_SET_MISSING", "Attributes"),
            reason("TRAIT_ORPHANED", "Sneak"),
            reason("RATING_CONFLICTS_WITH_SET")
          ]);
        });

        it("RQ-030: shows unpriced traits as no standard cost, never as Cost: 0 PP, with no approve or charge control", async () => {
          const one = await card(await post({
            warnings: [{ code: "EXTRA_TRAIT_NOT_ALLOWED", setId: SKILLS }], unpricedTraits: [{ setId: SKILLS, count: 1 }]
          }));
          assert.equal(one.querySelector(".cp-nonstandard .cp-unpriced")?.textContent.trim(),
            game.i18n.localize("CORTEX.Chat.Nonstandard.UnpricedOne"));
          assert.include(one.querySelector(".cp-unpriced").textContent, "1 trait unpriced");

          const two = await card(await post({
            warnings: [{ code: "EXTRA_TRAIT_NOT_ALLOWED", setId: SKILLS }, { code: "EXTRA_TRAIT_NOT_ALLOWED", setId: ATTRIBUTES }],
            unpricedTraits: [{ setId: SKILLS, count: 1 }, { setId: ATTRIBUTES, count: 1 }]
          }));
          assert.equal(two.querySelector(".cp-unpriced")?.textContent.trim(),
            game.i18n.format("CORTEX.Chat.Nonstandard.UnpricedMany", { count: 2 }));

          for ( const html of [one, two] ) {
            assert.notMatch(html.textContent, /cost:?\s*0\s*PP/i);
            assert.lengthOf(html.querySelectorAll(".cp-nonstandard button, .cp-nonstandard [data-action]"), 0);
          }
        });

        it("RQ-031: names a trait only from its own actor's die, and never by its set's name", async () => {
          const message = await post({ warnings: [
            // No actor id: the pool's dice all come from an actor, so no die is this trait's.
            { code: "TRAIT_SHUT_DOWN", setId: SKILLS, traitId: "skillfight000001" },
            // Another actor's trait with the same id.
            { code: "TRAIT_SHUT_DOWN", setId: SKILLS, actorId: foundry.utils.randomID(), traitId: "skillfight000001" },
            // A trait whose die isn't in the pool.
            { code: "TRAIT_ORPHANED", setId: SKILLS, actorId, traitId: "skillgone0000001" }
          ] });
          assert.deepEqual([...(await card(message)).querySelectorAll(".cp-nonstandard li")].map(li => li.textContent.trim()), [
            reason("TRAIT_SHUT_DOWN"), reason("TRAIT_SHUT_DOWN"), reason("TRAIT_ORPHANED")
          ]);
        });

        it("ADR-047: names a set as it was when the pool was rolled, after the set is renamed and after it is removed", async () => {
          const message = await post({ warnings: [{ code: "TRAIT_SET_SHUT_DOWN", setId: SKILLS }, { code: "PRIME_SET_MISSING", setId: ATTRIBUTES }] });
          const reasons = async () => [...(await card(game.messages.get(message.id))).querySelectorAll(".cp-nonstandard li")].map(li => li.textContent.trim());
          const asRolled = [reason("TRAIT_SET_SHUT_DOWN", "Skills"), reason("PRIME_SET_MISSING", "Attributes")];
          try {
            const renamed = defaultGameConfig();
            traitSetById(renamed, SKILLS).name = "Talents";
            await game.settings.set("cortex-prime", GAME_CONFIG_SETTING, renamed);
            assert.deepEqual(await reasons(), asRolled, "after a rename");

            await game.settings.set("cortex-prime", GAME_CONFIG_SETTING, removeTraitSet(defaultGameConfig(), SKILLS));
            assert.deepEqual(await reasons(), asRolled, "after the set is removed");
          }
          finally {
            await game.settings.set("cortex-prime", GAME_CONFIG_SETTING, defaultGameConfig());
          }
        });

        it("ADR-047: a warning stored without a label names its set as the configuration has it now, or not at all", async () => {
          const message = await post({});
          await message.update({ "system.warnings": [{ code: "TRAIT_SET_SHUT_DOWN", setId: SKILLS }] });
          const reasons = async () => [...(await card(game.messages.get(message.id))).querySelectorAll(".cp-nonstandard li")].map(li => li.textContent.trim());
          assert.notProperty(plain(game.messages.get(message.id).system.toObject()).warnings[0], "setLabel");
          assert.deepEqual(await reasons(), [reason("TRAIT_SET_SHUT_DOWN", "Skills")]);
          try {
            await game.settings.set("cortex-prime", GAME_CONFIG_SETTING, removeTraitSet(defaultGameConfig(), SKILLS));
            assert.deepEqual(await reasons(), [reason("TRAIT_SET_SHUT_DOWN")]);
          }
          finally {
            await game.settings.set("cortex-prime", GAME_CONFIG_SETTING, defaultGameConfig());
          }
        });

        it("shows no nonstandard section for a standard selection", async () => {
          const html = await card(await post({}));
          assert.isNull(html.querySelector(".cp-nonstandard"));
        });

        it("keeps showing the section once the roll is confirmed", async () => {
          const message = await post({ warnings: [{ code: "TRAIT_SET_SHUT_DOWN", setId: SKILLS }] });
          const rolled = message.system.toObject().rolled;
          // The suggestion postPoolRoll pre-selects is a valid selection (ADR-019).
          const selection = message.system.toObject().selection;
          await message.update({ "system.resolution": resolve(rolled, selection), "system.state": "resolved" });
          const html = await card(game.messages.get(message.id));
          assert.deepEqual([...html.querySelectorAll(".cp-nonstandard li")].map(li => li.textContent.trim()),
            [reason("TRAIT_SET_SHUT_DOWN", "Skills")]);
        });

        it("still shows a standard card for a pool of dice from no trait", async () => {
          const dice = buildPool([{ size: 8, source: { kind: "custom", label: "Custom" } }]);
          const message = await postPoolRoll({ pool: dice, results: [5] });
          messages.push(message);
          assert.deepEqual(plain(message.system.toObject().rolled), plain(applyResults(dice, [5])));
          assert.isNull((await card(message)).querySelector(".cp-nonstandard"));
        });
      });
    },
    { displayName: "Cortex Prime: poolRoll warnings" }
  );
}
