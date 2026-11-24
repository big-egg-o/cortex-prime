/**
 * Assets and complications: temporary traits made during play (Assets & Complications spec, draft
 * of 2026-11-04, as reviewed on 2026-11-24). The engine works out new and changed traits and their
 * plot point lines; writing them and paying the lines is the caller's (Plot Points P4).
 *
 * The spec's seven questions are decided as Rules Questions RQ-045 to RQ-051 (2026-11-24); the JSDoc
 * of each function names the ones it follows. A character holder is named by an actor key: a 16-
 * character id or a Foundry UUID, so two unlinked copies of one opponent stay apart (ADR-057).
 *
 * Every function returns an EngineResult (ADR-025), stops at the first failing check in the order
 * its JSDoc gives, never changes its inputs and returns no object shared with them.
 * @module rules/assets
 */

import { stepDie } from "./dice.mjs";
import { fail, ok } from "./result.mjs";
import { evaluate } from "./roll.mjs";
import { validateRating } from "./traits.mjs";
import { DIE_SIZES } from "./types.mjs";

/**
 * Who a temporary trait belongs to: a character, the current scene, or nobody yet (a
 * complication the GM tracks without a character, Assets & Complications, 2026-11-20 tracker).
 * @typedef {{kind: "actor", actorId: string} | {kind: "scene"} | {kind: "unassigned"}} TraitHolder
 */

/**
 * An asset or a complication.
 * @typedef {Object} TemporaryTrait
 * @property {string} id - 16 letters or digits
 * @property {"asset"|"complication"} kind
 * @property {string} name - not blank
 * @property {import("./types.mjs").DieSize[]} dice - exactly one size; [12] when past d12
 * @property {TraitHolder} holder
 * @property {string} origin - from ASSET_ORIGINS or COMPLICATION_ORIGINS
 * @property {"scene"|"session"|null} duration - assets only; null for a complication
 * @property {"holder"|"open"} access - "holder" for every complication
 * @property {number} sceneSteps - an asset's opportunity steps for this scene; 0 for a complication
 * @property {boolean} beyondD12 - a complication stepped past d12; false for every asset
 * @property {{actorId: string, traitId: string}|null} borrowedFrom - origin "borrowed" only
 */

/**
 * Opportunity steps on a signature asset for this scene.
 * @typedef {{actorId: string, traitId: string, steps: number}} SceneBoost
 */

/**
 * What happened to one trait. `from` and `to` are the dice the pool sees; `to` is null for a
 * removed trait.
 * @typedef {Object} TraitChange
 * @property {string} traitId
 * @property {string} [actorId] - signature assets only
 * @property {boolean} created
 * @property {import("./types.mjs").DieSize|null} from
 * @property {import("./types.mjs").DieSize|null} to
 * @property {boolean} beyondD12
 * @property {number} lostSteps - steps that had nowhere to go
 */

export const TEMP_TRAIT_KINDS = Object.freeze(["asset", "complication"]);
export const ASSET_ORIGINS = Object.freeze(["pp", "borrowed", "stunt", "effect", "clue", "free", "gm"]);
export const COMPLICATION_ORIGINS = Object.freeze(["hitch", "botch", "contest", "stayIn", "failedTest", "effect", "gm"]);
export const ASSET_DURATIONS = Object.freeze(["scene", "session"]);
const HOLDER_KINDS = ["actor", "scene", "unassigned"];

/** The plot point reasons this spec adds, mapped to their direction (HITCH_COMPLICATION is a Plot Points reason). */
export const AC_PP_REASONS = Object.freeze({
  ASSET_CREATE: "spend",
  ASSET_KEEP_SESSION: "spend",
  ASSET_OPEN: "spend",
  ASSET_GIVE: "spend",
  OPPORTUNITY: "spend",
  ACT_THROUGH_COMPLICATION: "spend",
  SIGNATURE_ASSET_RECOVER: "spend",
  RELATIONSHIP_CREATE: "spend"
});

const ID_PATTERN = /^[a-zA-Z0-9]{16}$/;
const ACTOR_KEY_PATTERN = /^(?:[a-zA-Z0-9]{16}|[A-Za-z]+\.[a-zA-Z0-9]{16}(?:\.[A-Za-z]+\.[a-zA-Z0-9]{16})*)$/;
const MAX = DIE_SIZES[DIE_SIZES.length - 1];

/** @returns {boolean} whether value is a plain object, not an array, class instance or null */
function isPlainObject(value) {
  if ( (value === null) || (typeof value !== "object") ) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype) || (proto === null);
}

/** @returns {boolean} whether value is an id in the 16-character format */
function isId(value) {
  return (typeof value === "string") && ID_PATTERN.test(value);
}

/** @returns {boolean} whether value names an actor: a 16-character id or a Foundry UUID */
function isActorKey(value) {
  return (typeof value === "string") && ACTOR_KEY_PATTERN.test(value);
}

/** @returns {boolean} whether value is a string that isn't blank after trimming */
function isName(value) {
  return (typeof value === "string") && (value.trim().length > 0);
}

/** @returns {boolean} whether value is a whole number of at least min */
function isWholeFrom(value, min) {
  return Number.isInteger(value) && (value >= min);
}

/** @returns {TraitHolder|null} a copy of a valid holder, or null */
function copyHolder(holder) {
  if ( !isPlainObject(holder) || !HOLDER_KINDS.includes(holder.kind) ) return null;
  if ( holder.kind !== "actor" ) return { kind: holder.kind };
  return isActorKey(holder.actorId) ? { kind: "actor", actorId: holder.actorId } : null;
}

/** @returns {boolean} whether two holders are the same */
function sameHolder(a, b) {
  return (a.kind === b.kind) && (a.actorId === b.actorId);
}

/** @returns {import("./types.mjs").PpLine} a one-PP spend line for a trait */
function spend(reason, trait) {
  return { reason, direction: "spend", amount: 1, label: trait.name, sourceId: trait.id };
}

/**
 * The die a pool sees for a trait: an asset stepped up by its scene steps, never above d12.
 * @param {TemporaryTrait} trait
 * @returns {import("./types.mjs").DieSize}
 */
function seenSize(trait) {
  if ( trait.kind !== "asset" ) return trait.dice[0];
  return stepDie(trait.dice[0], trait.sceneSteps).size;
}

/** @returns {number} how many steps up a die has before d12 */
function roomBelowMax(size) {
  return DIE_SIZES.indexOf(MAX) - DIE_SIZES.indexOf(size);
}

/**
 * Checks one temporary trait and returns a copy. Every function that takes traits runs this on
 * each, in list order, before anything else.
 *
 * Check order: (1) a plain object with an id, a kind, a name that isn't blank and a valid holder,
 * else INVALID_TEMP_TRAIT; (2) the dice are die sizes, else INVALID_DIE_SIZE; (3) exactly one die,
 * else TEMP_TRAIT_ONE_DIE; (4) origin, duration, access, scene steps, beyondD12 and borrowedFrom fit the kind, and an asset a player made is held by a character (rule 9), else
 * INVALID_TEMP_TRAIT.
 * @param {unknown} trait
 * @returns {import("./types.mjs").EngineResult<TemporaryTrait>}
 */
export function checkTemporaryTrait(trait) {
  if ( !isPlainObject(trait) || !isId(trait.id) || !TEMP_TRAIT_KINDS.includes(trait.kind) || !isName(trait.name) ) {
    return fail("INVALID_TEMP_TRAIT");
  }
  const holder = copyHolder(trait.holder);
  if ( !holder ) return fail("INVALID_TEMP_TRAIT");
  const dice = validateRating(trait.dice);
  if ( !dice.ok ) return fail("INVALID_DIE_SIZE");
  if ( dice.value.length !== 1 ) return fail("TEMP_TRAIT_ONE_DIE");

  const isAsset = trait.kind === "asset";
  const size = dice.value[0];
  const valid = isAsset
    ? ASSET_ORIGINS.includes(trait.origin) && ASSET_DURATIONS.includes(trait.duration)
      && ["holder", "open"].includes(trait.access) && isWholeFrom(trait.sceneSteps, 0)
      && (trait.beyondD12 === false)
      && ((trait.origin === "gm") || (holder.kind === "actor"))
    : COMPLICATION_ORIGINS.includes(trait.origin) && (trait.duration === null) && (trait.access === "holder")
      && (trait.sceneSteps === 0) && (typeof trait.beyondD12 === "boolean") && (!trait.beyondD12 || (size === MAX));
  if ( !valid ) return fail("INVALID_TEMP_TRAIT");

  let borrowedFrom = null;
  if ( trait.origin === "borrowed" ) {
    const from = trait.borrowedFrom;
    if ( !isPlainObject(from) || !isActorKey(from.actorId) || !isId(from.traitId) ) return fail("INVALID_TEMP_TRAIT");
    borrowedFrom = { actorId: from.actorId, traitId: from.traitId };
  }
  else if ( trait.borrowedFrom !== null ) return fail("INVALID_TEMP_TRAIT");

  return ok({
    id: trait.id, kind: trait.kind, name: trait.name, dice: dice.value, holder, origin: trait.origin,
    duration: trait.duration, access: trait.access, sceneSteps: trait.sceneSteps, beyondD12: trait.beyondD12,
    borrowedFrom
  });
}

/**
 * Checks a list of temporary traits with distinct ids.
 * @returns {import("./types.mjs").EngineResult<TemporaryTrait[]>}
 */
function checkTraitList(traits) {
  if ( !Array.isArray(traits) ) return fail("INVALID_INPUT");
  const copies = [];
  for ( const trait of traits ) {
    const checked = checkTemporaryTrait(trait);
    if ( !checked.ok ) return checked;
    if ( copies.some(t => t.id === checked.value.id) ) return fail("DUPLICATE_TRAIT_ID");
    copies.push(checked.value);
  }
  return ok(copies);
}

/** @returns {TemporaryTrait} a complication from its parts */
function complication({ id, name, holder }, size, origin, beyondD12 = false) {
  return {
    id, kind: "complication", name, dice: [size], holder, origin, duration: null, access: "holder", sceneSteps: 0,
    beyondD12, borrowedFrom: null
  };
}

/**
 * A complication's die stepped (rule 25, RQ-048): past d12 it stays [12] with beyondD12, and
 * further steps up change nothing. A step down first clears the mark and leaves d12; the next one
 * gives d10. A d4 stepped down is removed, and the steps left over are lost.
 * @param {import("./types.mjs").DieSize} size
 * @param {boolean} beyondD12
 * @param {number} steps - a whole number; 0 changes nothing
 * @returns {{size: import("./types.mjs").DieSize|null, beyondD12: boolean, removed: boolean, lostSteps: number}}
 */
function stepComplication(size, beyondD12, steps) {
  if ( steps === 0 ) return { size, beyondD12, removed: false, lostSteps: 0 };
  if ( steps > 0 ) {
    if ( beyondD12 ) return { size: MAX, beyondD12: true, removed: false, lostSteps: 0 };
    const result = stepDie(size, steps);
    return { size: result.size, beyondD12: (result.beyond ?? 0) > 0, removed: false, lostSteps: 0 };
  }
  let down = -steps;
  if ( beyondD12 ) down -= 1;
  if ( down === 0 ) return { size: MAX, beyondD12: false, removed: false, lostSteps: 0 };
  const result = stepDie(size, -down);
  if ( !result.removed ) return { size: result.size, beyondD12: false, removed: false, lostSteps: 0 };
  return { size: null, beyondD12: false, removed: true, lostSteps: down - (DIE_SIZES.indexOf(size) + 1) };
}

/**
 * Creates an asset (rules 3 to 9 and 13). The die is d6 for a bought, borrowed or free asset, d8
 * for a stunt, the given size for the GM's, and the smaller of size and cap for one sized by an
 * effect die or a clue test. Lines, never for the GM's: ASSET_CREATE for a bought or borrowed
 * asset, then ASSET_KEEP_SESSION and ASSET_OPEN when asked for. Giving the asset to another
 * character at creation is the holder and costs nothing.
 *
 * Check order: (1) the input's shape: a plain object, an origin from ASSET_ORIGINS, keepForSession
 * and open booleans or left out, a size exactly for effect, clue and gm, a cap only for effect and
 * clue, borrowedFrom exactly for borrowed, else INVALID_INPUT; (2) size and cap are die sizes, else
 * INVALID_DIE_SIZE; (3) the built trait through checkTemporaryTrait.
 * @param {{id: string, name: string, holder: TraitHolder, origin: string, size?: number, cap?: number,
 *   borrowedFrom?: {actorId: string, traitId: string}, keepForSession?: boolean, open?: boolean}} input
 * @returns {import("./types.mjs").EngineResult<{trait: TemporaryTrait, ppLines: import("./types.mjs").PpLine[]}>}
 */
export function createAsset(input) {
  if ( !isPlainObject(input) || !ASSET_ORIGINS.includes(input.origin) ) return fail("INVALID_INPUT");
  const { origin, size, cap, keepForSession = false, open = false } = input;
  if ( (typeof keepForSession !== "boolean") || (typeof open !== "boolean") ) return fail("INVALID_INPUT");
  const sized = ["effect", "clue", "gm"].includes(origin);
  if ( sized !== (size !== undefined) ) return fail("INVALID_INPUT");
  if ( (cap !== undefined) && !["effect", "clue"].includes(origin) ) return fail("INVALID_INPUT");
  if ( (origin === "borrowed") !== (input.borrowedFrom !== undefined) ) return fail("INVALID_INPUT");
  if ( (size !== undefined) && !DIE_SIZES.includes(size) ) return fail("INVALID_DIE_SIZE");
  if ( (cap !== undefined) && !DIE_SIZES.includes(cap) ) return fail("INVALID_DIE_SIZE");

  const die = origin === "stunt" ? 8 : !sized ? 6 : (cap === undefined) ? size : Math.min(size, cap);
  const checked = checkTemporaryTrait({
    id: input.id, kind: "asset", name: input.name, dice: [die], holder: input.holder, origin,
    duration: keepForSession ? "session" : "scene", access: open ? "open" : "holder", sceneSteps: 0,
    beyondD12: false, borrowedFrom: input.borrowedFrom ?? null
  });
  if ( !checked.ok ) return checked;
  const trait = checked.value;
  const ppLines = [];
  if ( origin !== "gm" ) {
    if ( ["pp", "borrowed"].includes(origin) ) ppLines.push(spend("ASSET_CREATE", trait));
    if ( keepForSession ) ppLines.push(spend("ASSET_KEEP_SESSION", trait));
    if ( open ) ppLines.push(spend("ASSET_OPEN", trait));
  }
  return ok({ trait, ppLines });
}

/**
 * Keeps an asset for the session, opens it to everyone in the scene, or hands a clue asset to
 * another character after it was made (rules 7 to 9; RQ-049): one line each, none for the GM's.
 * Handing a clue over leaves its duration as it is.
 *
 * Check order: (1) checkTemporaryTrait; (2) not an asset, NOT_AN_ASSET; (3) upgrade is
 * `{kind: "keep"}`, `{kind: "open"}` or `{kind: "give", holder}`, else INVALID_INPUT; (4) keep:
 * ALREADY_KEPT; open: ALREADY_OPEN; give: NOT_A_CLUE_ASSET, a holder that isn't a character
 * (INVALID_INPUT), SAME_HOLDER.
 * @param {TemporaryTrait} asset
 * @param {{kind: "keep"|"open"|"give", holder?: TraitHolder}} upgrade
 * @returns {import("./types.mjs").EngineResult<{trait: TemporaryTrait, ppLines: import("./types.mjs").PpLine[]}>}
 */
export function upgradeAsset(asset, upgrade) {
  const checked = checkTemporaryTrait(asset);
  if ( !checked.ok ) return checked;
  const trait = checked.value;
  if ( trait.kind !== "asset" ) return fail("NOT_AN_ASSET");
  if ( !isPlainObject(upgrade) || !["keep", "open", "give"].includes(upgrade.kind) ) return fail("INVALID_INPUT");

  let reason;
  if ( upgrade.kind === "keep" ) {
    if ( trait.duration === "session" ) return fail("ALREADY_KEPT");
    trait.duration = "session";
    reason = "ASSET_KEEP_SESSION";
  }
  else if ( upgrade.kind === "open" ) {
    if ( trait.access === "open" ) return fail("ALREADY_OPEN");
    trait.access = "open";
    reason = "ASSET_OPEN";
  }
  else {
    if ( trait.origin !== "clue" ) return fail("NOT_A_CLUE_ASSET");
    const holder = copyHolder(upgrade.holder);
    if ( holder?.kind !== "actor" ) return fail("INVALID_INPUT");
    if ( sameHolder(holder, trait.holder) ) return fail("SAME_HOLDER");
    trait.holder = holder;
    reason = "ASSET_GIVE";
  }
  return ok({ trait, ppLines: trait.origin === "gm" ? [] : [spend(reason, trait)] });
}

/**
 * Checks the hitch or opportunity ids of one allocation against the roll.
 * @returns {string|null} the first failing code, or null
 */
function idsProblem(ids, byId, used) {
  if ( !Array.isArray(ids) || (ids.length === 0) ) return "EMPTY_ALLOCATION";
  for ( const id of ids ) {
    const die = byId.get(id);
    if ( !die ) return "HITCH_NOT_FOUND";
    if ( !die.hitch ) return "NOT_A_HITCH";
    if ( die.state === "hitch-activated" ) return "HITCH_ALREADY_ACTIVATED";
    if ( used.has(id) ) return "HITCH_REUSED";
    used.add(id);
  }
  return null;
}

/** @returns {import("./types.mjs").RolledDie[]} the roll with the used dice marked hitch-activated */
function markUsed(rolled, used) {
  return rolled.map(die => ({
    ...die, source: { ...die.source }, ...(used.has(die.id) ? { state: "hitch-activated" } : {})
  }));
}

/**
 * The GM activates a player's hitches (rules 16 and 17; RQ-045). Each allocation's hitches make one
 * new complication (d6, stepped up once for each further hitch) or step a complication the character
 * already has up once per hitch, past d12 as in rule 25 and RQ-048. Each allocation pays the roller
 * one HITCH_COMPLICATION, which can't pay for the same roll. On a botch there is one allocation
 * using every die, new or existing, and no line. No allocations means the GM declines.
 *
 * Check order: (1) the input's shape and a side of "player" or "gm", else INVALID_INPUT; (2) side
 * "gm", OPPORTUNITIES_NOT_HITCHES; (3) the complications through checkTemporaryTrait; (4) per
 * allocation in order: EMPTY_ALLOCATION, then per hitch id HITCH_NOT_FOUND, NOT_A_HITCH,
 * HITCH_ALREADY_ACTIVATED, HITCH_REUSED; a new target through checkTemporaryTrait, then
 * DUPLICATE_TRAIT_ID; an existing target TRAIT_NOT_FOUND, NOT_A_COMPLICATION, DUPLICATE_TARGET; a
 * target of another kind INVALID_INPUT; (5) on a botch, more than one allocation or one that
 * doesn't use every die, BOTCH_ONE_COMPLICATION.
 * @param {{rolled: import("./types.mjs").RolledDie[], side: "player"|"gm", allocations: {hitchIds: string[],
 *   target: {kind: "new", id: string, name: string, holder: TraitHolder} | {kind: "existing", traitId: string}}[],
 *   complications: TemporaryTrait[]}} input
 * @returns {import("./types.mjs").EngineResult<{rolled: import("./types.mjs").RolledDie[],
 *   complications: TemporaryTrait[], changes: TraitChange[], takenOut: string[],
 *   ppLines: import("./types.mjs").PpLine[]}>}
 */
export function applyHitches(input) {
  if ( !isPlainObject(input) || !Array.isArray(input.rolled) || !Array.isArray(input.allocations)
    || !["player", "gm"].includes(input.side) ) return fail("INVALID_INPUT");
  if ( input.side === "gm" ) return fail("OPPORTUNITIES_NOT_HITCHES");
  const list = checkTraitList(input.complications);
  if ( !list.ok ) return list;
  const complications = list.value;
  const byId = new Map(input.rolled.map(die => [die.id, die]));
  const used = new Set();
  const created = [];
  const affected = [];

  for ( const allocation of input.allocations ) {
    if ( !isPlainObject(allocation) || !isPlainObject(allocation.target) ) return fail("INVALID_INPUT");
    const problem = idsProblem(allocation.hitchIds, byId, used);
    if ( problem ) return fail(problem);
    const { target } = allocation;
    const n = allocation.hitchIds.length;
    if ( target.kind === "new" ) {
      const steps = stepComplication(6, false, n - 1);
      const checked = checkTemporaryTrait(complication(target, steps.size, "hitch", steps.beyondD12));
      if ( !checked.ok ) return checked;
      const id = checked.value.id;
      if ( complications.some(c => c.id === id) || created.some(c => c.id === id) ) return fail("DUPLICATE_TRAIT_ID");
      created.push(checked.value);
      affected.push({ trait: checked.value, change: {
        traitId: id, created: true, from: null, to: steps.size, beyondD12: steps.beyondD12, lostSteps: 0
      } });
    }
    else if ( target.kind === "existing" ) {
      const existing = complications.find(c => c.id === target.traitId);
      if ( !existing ) return fail("TRAIT_NOT_FOUND");
      if ( existing.kind !== "complication" ) return fail("NOT_A_COMPLICATION");
      if ( affected.some(a => a.trait.id === existing.id) ) return fail("DUPLICATE_TARGET");
      const from = existing.dice[0];
      const steps = stepComplication(from, existing.beyondD12, n);
      existing.dice = [steps.size];
      existing.beyondD12 = steps.beyondD12;
      affected.push({ trait: existing, change: {
        traitId: existing.id, created: false, from, to: steps.size, beyondD12: steps.beyondD12, lostSteps: 0
      } });
    }
    else return fail("INVALID_INPUT");
  }

  const { botch } = evaluate(input.rolled);
  if ( botch && (input.allocations.length > 0) ) {
    const all = input.allocations.length === 1 && input.allocations[0].hitchIds.length === input.rolled.length;
    if ( !all ) return fail("BOTCH_ONE_COMPLICATION");
    if ( created.length ) created[0].origin = "botch";
  }

  return ok({
    rolled: markUsed(input.rolled, used),
    complications: [...complications, ...created],
    changes: affected.map(a => a.change),
    takenOut: affected.filter(a => a.trait.beyondD12).map(a => a.trait.id),
    ppLines: botch ? [] : affected.map(({ trait }) => ({
      reason: "HITCH_COMPLICATION", direction: "gain", amount: 1, label: trait.name, sourceId: trait.id,
      usableThisRoll: false
    }))
  });
}

/** @returns {boolean} whether value is a SceneBoost */
function isBoost(value) {
  return isPlainObject(value) && isActorKey(value.actorId) && isId(value.traitId) && isWholeFrom(value.steps, 1);
}

/**
 * A player uses opportunities from the GM's roll (rules 19 and 20). One OPPORTUNITY line per use.
 * Down on a complication: one step each, a d4 is removed and the steps left over are lost. Up on an
 * asset or a signature asset: one step each for the scene (scene steps, or a SceneBoost), never
 * above d12; steps that don't fit are lost and the line still counts (RQ-004). One PP per trait
 * however many opportunities it takes (RQ-046). A complication past d12 loses the mark with its
 * first step (RQ-048). Up on a complication and down on an asset are OPPORTUNITY_USE_NOT_LISTED
 * (RQ-047).
 *
 * Check order: (1) the input's shape and side, INVALID_INPUT; (2) side "player",
 * HITCHES_NOT_OPPORTUNITIES; (3) the traits through checkTemporaryTrait, the boosts' shape
 * (INVALID_INPUT); (4) per use: its shape and direction (INVALID_INPUT), then the ids as in
 * applyHitches; the target: TRAIT_NOT_FOUND, or a signature target's shape (INVALID_INPUT) and
 * dice (INVALID_DIE_SIZE, TEMP_TRAIT_ONE_DIE); DUPLICATE_TARGET; OPPORTUNITY_USE_NOT_LISTED.
 * @param {{rolled: import("./types.mjs").RolledDie[], side: "player"|"gm", uses: {opportunityIds: string[],
 *   direction: "down"|"up", target: {kind: "temporary", traitId: string} | {kind: "signature", actorId: string,
 *   traitId: string, label: string, dice: number[]}}[], traits: TemporaryTrait[], sceneBoosts: SceneBoost[]}} input
 * @returns {import("./types.mjs").EngineResult<{rolled: import("./types.mjs").RolledDie[], traits: TemporaryTrait[],
 *   sceneBoosts: SceneBoost[], changes: TraitChange[], removedIds: string[], ppLines: import("./types.mjs").PpLine[]}>}
 */
export function applyOpportunities(input) {
  if ( !isPlainObject(input) || !Array.isArray(input.rolled) || !Array.isArray(input.uses)
    || !Array.isArray(input.sceneBoosts) || !["player", "gm"].includes(input.side) ) return fail("INVALID_INPUT");
  if ( input.side === "player" ) return fail("HITCHES_NOT_OPPORTUNITIES");
  const list = checkTraitList(input.traits);
  if ( !list.ok ) return list;
  if ( !input.sceneBoosts.every(isBoost) ) return fail("INVALID_INPUT");
  const traits = list.value;
  const boosts = input.sceneBoosts.map(b => ({ ...b }));
  const byId = new Map(input.rolled.map(die => [die.id, die]));
  const used = new Set();
  const targeted = new Set();
  const planned = [];

  for ( const use of input.uses ) {
    if ( !isPlainObject(use) || !isPlainObject(use.target) || !["down", "up"].includes(use.direction) ) {
      return fail("INVALID_INPUT");
    }
    const problem = idsProblem(use.opportunityIds, byId, used);
    if ( problem ) return fail(problem);
    const { target } = use;
    let key;
    let trait = null;
    if ( target.kind === "temporary" ) {
      trait = traits.find(t => t.id === target.traitId);
      if ( !trait ) return fail("TRAIT_NOT_FOUND");
      key = trait.id;
    }
    else if ( target.kind === "signature" ) {
      if ( !isActorKey(target.actorId) || !isId(target.traitId) || !isName(target.label) ) {
        return fail("INVALID_INPUT");
      }
      const dice = validateRating(target.dice);
      if ( !dice.ok ) return fail("INVALID_DIE_SIZE");
      if ( dice.value.length !== 1 ) return fail("TEMP_TRAIT_ONE_DIE");
      key = `${target.actorId}.${target.traitId}`;
    }
    else return fail("INVALID_INPUT");
    if ( targeted.has(key) ) return fail("DUPLICATE_TARGET");
    targeted.add(key);

    const onComplication = trait?.kind === "complication";
    if ( (use.direction === "down") !== onComplication ) return fail("OPPORTUNITY_USE_NOT_LISTED");
    planned.push({ use, trait });
  }

  const changes = [];
  const removedIds = [];
  const ppLines = [];
  for ( const { use, trait } of planned ) {
    const n = use.opportunityIds.length;
    const { target } = use;
    if ( trait?.kind === "complication" ) {
      const from = trait.dice[0];
      const stepped = stepComplication(from, trait.beyondD12, -n);
      if ( stepped.removed ) removedIds.push(trait.id);
      else {
        trait.dice = [stepped.size];
        trait.beyondD12 = false;
      }
      changes.push({
        traitId: trait.id, created: false, from, to: stepped.size, beyondD12: false, lostSteps: stepped.lostSteps
      });
      ppLines.push(spend("OPPORTUNITY", trait));
    }
    else if ( trait ) {
      const from = seenSize(trait);
      const applied = Math.min(n, roomBelowMax(from));
      trait.sceneSteps += applied;
      changes.push({ traitId: trait.id, created: false, from, to: seenSize(trait), beyondD12: false, lostSteps: n - applied });
      ppLines.push(spend("OPPORTUNITY", trait));
    }
    else {
      const boost = boosts.find(b => (b.actorId === target.actorId) && (b.traitId === target.traitId));
      const from = stepDie(target.dice[0], boost?.steps ?? 0).size;
      const applied = Math.min(n, roomBelowMax(from));
      if ( boost ) boost.steps += applied;
      else if ( applied > 0 ) boosts.push({ actorId: target.actorId, traitId: target.traitId, steps: applied });
      changes.push({
        traitId: target.traitId, actorId: target.actorId, created: false, from,
        to: stepDie(from, applied).size, beyondD12: false, lostSteps: n - applied
      });
      ppLines.push({ reason: "OPPORTUNITY", direction: "spend", amount: 1, label: target.label, sourceId: target.traitId });
    }
  }

  return ok({
    rolled: markUsed(input.rolled, used),
    traits: traits.filter(t => !removedIds.includes(t.id)),
    sceneBoosts: boosts,
    changes,
    removedIds,
    ppLines
  });
}

/**
 * The complications a finished contest gives the loser (rules 22 and 23), in the order of the
 * winner's effect dice: an effect die that takes the loser out gives its stay-in size (cause
 * "stayIn") only when the loser stayed in; any other compared die that gives a complication gives
 * its size (cause "contest"). Giving in or declining gives none. Whether each is new or steps one
 * up is applyComplications.
 *
 * Check order: (1) a plain consequence with the arrays this reads and stayedIn a boolean, else
 * INVALID_INPUT; (2) stayedIn when the loser isn't taken out, NO_TAKE_OUT.
 * @param {import("./types.mjs").Consequence} consequence
 * @param {{stayedIn: boolean}} options
 * @returns {import("./types.mjs").EngineResult<{effectId: string, size: import("./types.mjs").DieSize,
 *   cause: "contest"|"stayIn"}[]>}
 */
export function contestComplications(consequence, options) {
  if ( !isPlainObject(consequence) || !Array.isArray(consequence.winnerEffects)
    || !Array.isArray(consequence.comparisons) || !isPlainObject(options) || (typeof options.stayedIn !== "boolean") ) {
    return fail("INVALID_INPUT");
  }
  if ( options.stayedIn && !consequence.takenOut ) return fail("NO_TAKE_OUT");
  if ( consequence.ending !== "won" ) return ok([]);
  const avoid = consequence.avoidWithPP ?? [];
  const result = [];
  for ( const effect of consequence.winnerEffects ) {
    const stayIn = avoid.find(a => a.effectId === effect.id);
    if ( stayIn ) {
      if ( options.stayedIn ) result.push({ effectId: effect.id, size: stayIn.size, cause: "stayIn" });
      continue;
    }
    const compared = consequence.comparisons.find(c => c.effectId === effect.id);
    if ( compared && !compared.takesOut && (compared.complication !== null) ) {
      result.push({ effectId: effect.id, size: compared.complication, cause: "contest" });
    }
  }
  return ok(result);
}

const ITEM_CAUSES = ["contest", "stayIn", "failedTest", "effect", "gm"];

/**
 * Gives complications as a consequence (rules 21 to 24): each item makes a new complication of its
 * size, or steps one the character has up by one when that one is at least as large (contest,
 * stay-in and failed test only). Items apply in order, each against the result of the ones before.
 * A step past d12 takes the character out, even after paying to stay in. A complication already
 * past d12 counts as large enough and stays past d12 (RQ-048). No lines: the stay-in PP is Plot
 * Points' STAY_IN, and the rest cost nothing.
 *
 * Check order: (1) the complications through checkTemporaryTrait, items an array (INVALID_INPUT);
 * (2) per item: its shape and cause (INVALID_INPUT), its size (INVALID_DIE_SIZE), a failed test's
 * size other than d6 (INVALID_INPUT); a new target through checkTemporaryTrait, then
 * DUPLICATE_TRAIT_ID; an existing target: cause effect or gm STEP_UP_NOT_OFFERED, TRAIT_NOT_FOUND,
 * NOT_A_COMPLICATION, COMPLICATION_TOO_SMALL.
 * @param {TemporaryTrait[]} complications
 * @param {{size: number, cause: string, target: {kind: "new", id: string, name: string, holder: TraitHolder}
 *   | {kind: "existing", traitId: string}}[]} items
 * @returns {import("./types.mjs").EngineResult<{complications: TemporaryTrait[], changes: TraitChange[],
 *   takenOut: string[]}>}
 */
export function applyComplications(complications, items) {
  const list = checkTraitList(complications);
  if ( !list.ok ) return list;
  if ( !Array.isArray(items) ) return fail("INVALID_INPUT");
  const traits = list.value;
  const changes = [];

  for ( const item of items ) {
    if ( !isPlainObject(item) || !ITEM_CAUSES.includes(item.cause) || !isPlainObject(item.target) ) {
      return fail("INVALID_INPUT");
    }
    if ( !DIE_SIZES.includes(item.size) ) return fail("INVALID_DIE_SIZE");
    if ( (item.cause === "failedTest") && (item.size !== 6) ) return fail("INVALID_INPUT");
    const { target } = item;
    if ( target.kind === "new" ) {
      const checked = checkTemporaryTrait(complication(target, item.size, item.cause));
      if ( !checked.ok ) return checked;
      if ( traits.some(t => t.id === checked.value.id) ) return fail("DUPLICATE_TRAIT_ID");
      traits.push(checked.value);
      changes.push({ traitId: checked.value.id, created: true, from: null, to: item.size, beyondD12: false, lostSteps: 0 });
    }
    else if ( target.kind === "existing" ) {
      if ( ["effect", "gm"].includes(item.cause) ) return fail("STEP_UP_NOT_OFFERED");
      const existing = traits.find(t => t.id === target.traitId);
      if ( !existing ) return fail("TRAIT_NOT_FOUND");
      if ( existing.kind !== "complication" ) return fail("NOT_A_COMPLICATION");
      const from = existing.dice[0];
      if ( !existing.beyondD12 && (from < item.size) ) return fail("COMPLICATION_TOO_SMALL");
      const stepped = stepComplication(from, existing.beyondD12, 1);
      existing.dice = [stepped.size];
      existing.beyondD12 = stepped.beyondD12;
      changes.push({
        traitId: existing.id, created: false, from, to: stepped.size, beyondD12: stepped.beyondD12, lostSteps: 0
      });
    }
    else return fail("INVALID_INPUT");
  }
  return ok({
    complications: traits,
    changes,
    takenOut: traits.filter(t => t.beyondD12 && changes.some(c => c.traitId === t.id)).map(t => t.id)
  });
}

/**
 * Steps a temporary trait by hand or by an SFX. An asset stepped past d12 is refused (no rule says
 * what happens; RQ-004), a d4 stepped down is removed, and a complication stepped past d12 takes
 * its holder out; one already past d12 stays there when stepped up and loses the mark with its first
 * step down (RQ-048). Scene steps don't change. No lines.
 *
 * Check order: (1) checkTemporaryTrait; (2) steps a whole number other than 0, else INVALID_INPUT;
 * (3) an asset past d12, ASSET_STEP_PAST_D12.
 * @param {TemporaryTrait} trait
 * @param {number} steps
 * @returns {import("./types.mjs").EngineResult<{trait: TemporaryTrait|null, removed: boolean, takenOut: boolean}>}
 */
export function stepTemporaryTrait(trait, steps) {
  const checked = checkTemporaryTrait(trait);
  if ( !checked.ok ) return checked;
  if ( !Number.isInteger(steps) || (steps === 0) ) return fail("INVALID_INPUT");
  const copy = checked.value;
  if ( copy.kind === "complication" ) {
    const stepped = stepComplication(copy.dice[0], copy.beyondD12, steps);
    if ( stepped.removed ) return ok({ trait: null, removed: true, takenOut: false });
    copy.dice = [stepped.size];
    copy.beyondD12 = stepped.beyondD12;
    return ok({ trait: copy, removed: false, takenOut: stepped.beyondD12 });
  }
  const stepped = stepDie(copy.dice[0], steps);
  if ( stepped.removed ) return ok({ trait: null, removed: true, takenOut: false });
  if ( (stepped.beyond ?? 0) > 0 ) return fail("ASSET_STEP_PAST_D12");
  copy.dice = [stepped.size];
  return ok({ trait: copy, removed: false, takenOut: false });
}

/**
 * The pool entry for a temporary trait (rules 2, 9, 18 and 26). The die is an asset's die with its
 * scene steps, or a complication's die. Warnings, never refusals (ADR-029), in this order:
 * ASSET_NOT_AVAILABLE (another character's asset that isn't open), OWN_COMPLICATION (the roller's
 * own complication above d4), D4_COMPLICATION_GOES_TO_HOLDER (another character's d4
 * complication), COMPLICATION_BEYOND_D12 (a complication past d12 gives a d12, RQ-048). The
 * roller's own d4 complication, however it got to d4 (RQ-050), reports ppGained 1, which Plot Points
 * pays as D4_COMPLICATION. A trait of the scene or with no holder gets no holder warnings.
 *
 * Check order: (1) checkTemporaryTrait; (2) rollerActorId an actor key or null, else INVALID_INPUT.
 * @param {TemporaryTrait} trait
 * @param {{rollerActorId: string|null}} options
 * @returns {import("./types.mjs").EngineResult<{size: import("./types.mjs").DieSize,
 *   source: import("./types.mjs").DieSource, ppGained?: number, warnings: string[]}>}
 */
export function temporaryTraitPoolEntry(trait, options) {
  const checked = checkTemporaryTrait(trait);
  if ( !checked.ok ) return checked;
  const rollerActorId = options?.rollerActorId;
  if ( (rollerActorId !== null) && !isActorKey(rollerActorId) ) return fail("INVALID_INPUT");
  const t = checked.value;

  const source = { kind: t.kind, traitId: t.id, label: t.name };
  const holderId = t.holder.kind === "actor" ? t.holder.actorId : null;
  if ( holderId ) source.actorId = holderId;
  const size = seenSize(t);
  const own = (holderId !== null) && (holderId === rollerActorId);
  const other = (holderId !== null) && !own;
  const warnings = [];
  if ( (t.kind === "asset") && (t.access === "holder") && other ) warnings.push("ASSET_NOT_AVAILABLE");
  if ( (t.kind === "complication") && (size !== 4) && own ) warnings.push("OWN_COMPLICATION");
  if ( (t.kind === "complication") && (size === 4) && other ) warnings.push("D4_COMPLICATION_GOES_TO_HOLDER");
  if ( t.beyondD12 ) warnings.push("COMPLICATION_BEYOND_D12");
  const entry = { size, source, warnings };
  if ( (t.kind === "complication") && (size === 4) && own ) entry.ppGained = 1;
  return ok(entry);
}

/**
 * The dice a signature asset adds to a pool (rules 12 and 14): each die stepped up by the scene
 * boost, never above d12, with the warning SIGNATURE_ASSET_LOST while it is out of action.
 *
 * Check order: (1) entry a plain object whose dice are die sizes, else INVALID_DIE_SIZE (INVALID_INPUT
 * for an entry that isn't an object); (2) boost null or a SceneBoost, else INVALID_INPUT.
 * @param {{dice: number[], lost?: {outOfAction: boolean, preLossDice: number[]}|null}} entry
 * @param {SceneBoost|null} boost
 * @returns {import("./types.mjs").EngineResult<{dice: import("./types.mjs").DieSize[], warnings: string[]}>}
 */
export function signatureAssetPoolDice(entry, boost) {
  if ( !isPlainObject(entry) ) return fail("INVALID_INPUT");
  const dice = validateRating(entry.dice);
  if ( !dice.ok ) return fail("INVALID_DIE_SIZE");
  if ( (boost !== null) && !isBoost(boost) ) return fail("INVALID_INPUT");
  const steps = boost?.steps ?? 0;
  return ok({
    dice: dice.value.map(size => stepDie(size, Math.min(steps, roomBelowMax(size))).size),
    warnings: entry.lost?.outOfAction ? ["SIGNATURE_ASSET_LOST"] : []
  });
}

/**
 * After a roll that used d4 complications in their holders' pools (rule 18): each one still at d4
 * is removed. One the GM stepped up with the roll's hitches is kept. Call it once the GM's hitch
 * choice for the roll is made or declined. One made at d4 is removed the same way (RQ-050).
 *
 * Check order: (1) checkTemporaryTrait on each; (2) usedIds an array of distinct strings, else
 * INVALID_INPUT; (3) per id: TRAIT_NOT_FOUND, NOT_A_COMPLICATION.
 * @param {TemporaryTrait[]} complications
 * @param {string[]} usedIds
 * @returns {import("./types.mjs").EngineResult<{complications: TemporaryTrait[], removedIds: string[]}>}
 */
export function removeUsedD4Complications(complications, usedIds) {
  const list = checkTraitList(complications);
  if ( !list.ok ) return list;
  if ( !Array.isArray(usedIds) || !usedIds.every(id => typeof id === "string")
    || (new Set(usedIds).size !== usedIds.length) ) return fail("INVALID_INPUT");
  const removedIds = [];
  for ( const id of usedIds ) {
    const trait = list.value.find(t => t.id === id);
    if ( !trait ) return fail("TRAIT_NOT_FOUND");
    if ( trait.kind !== "complication" ) return fail("NOT_A_COMPLICATION");
    if ( (trait.dice[0] === 4) && !trait.beyondD12 ) removedIds.push(id);
  }
  return ok({ complications: list.value.filter(t => !removedIds.includes(t.id)), removedIds });
}

/**
 * A character taken out by a complication past d12 may act in one test or contest anyway for a PP,
 * keeping only one result (rule 26; Dice & Pools rule 15, RQ-001).
 *
 * Check order: (1) checkTemporaryTrait on each; (2) actorId an id, else INVALID_INPUT; (3) no
 * complication past d12 held by that character, NOT_TAKEN_OUT_BY_COMPLICATION.
 * @param {TemporaryTrait[]} complications
 * @param {string} actorId
 * @returns {import("./types.mjs").EngineResult<{ppLine: import("./types.mjs").PpLine, keepLimit: 1, traitIds: string[]}>}
 */
export function actThroughOption(complications, actorId) {
  const list = checkTraitList(complications);
  if ( !list.ok ) return list;
  if ( !isActorKey(actorId) ) return fail("INVALID_INPUT");
  const out = list.value.filter(t => t.beyondD12 && (t.holder.actorId === actorId));
  if ( out.length === 0 ) return fail("NOT_TAKEN_OUT_BY_COMPLICATION");
  return ok({
    ppLine: { reason: "ACT_THROUGH_COMPLICATION", direction: "spend", amount: 1, label: out[0].name, sourceId: out[0].id },
    keepLimit: 1,
    traitIds: out.map(t => t.id)
  });
}

/** @returns {*} a deep copy of plain data (arrays, plain objects and primitives) */
function copyData(value) {
  if ( Array.isArray(value) ) return value.map(copyData);
  if ( isPlainObject(value) ) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copyData(v)]));
  return value;
}

/** @returns {import("./types.mjs").EngineResult<import("./types.mjs").DieSize[]>} an entry's non-empty dice */
function entryDice(entry) {
  if ( !isPlainObject(entry) ) return fail("INVALID_INPUT");
  const dice = validateRating(entry.dice);
  if ( !dice.ok ) return fail("INVALID_DIE_SIZE");
  if ( dice.value.length === 0 ) return fail("INVALID_INPUT");
  return dice;
}

/**
 * A signature asset is damaged (stepped down), put out of action, or both (rule 12, RQ-051).
 * `lost.preLossDice` keeps the dice from before the first loss, so later losses don't change it;
 * `lost.outOfAction` stays true once set. Scene boosts aren't part of the entry's dice.
 *
 * Check order: (1) the entry's dice (INVALID_INPUT for an entry that isn't an object or has none,
 * INVALID_DIE_SIZE); (2) loss `{outOfAction: true}` and/or a negative whole `steps`, else
 * INVALID_INPUT; (3) a die stepped below d4, SIGNATURE_ASSET_STEP_BELOW_D4.
 * @param {{dice: number[], lost?: {outOfAction: boolean, preLossDice: number[]}|null}} entry
 * @param {{outOfAction?: boolean, steps?: number}} loss
 * @returns {import("./types.mjs").EngineResult<object>} a copy of the entry with `lost` set
 */
export function loseSignatureAsset(entry, loss) {
  const dice = entryDice(entry);
  if ( !dice.ok ) return dice;
  if ( !isPlainObject(loss) ) return fail("INVALID_INPUT");
  const hasSteps = loss.steps !== undefined;
  if ( hasSteps && !(Number.isInteger(loss.steps) && (loss.steps < 0)) ) return fail("INVALID_INPUT");
  if ( ![true, undefined].includes(loss.outOfAction) || (!loss.outOfAction && !hasSteps) ) return fail("INVALID_INPUT");
  const stepped = hasSteps ? dice.value.map(size => stepDie(size, loss.steps)) : null;
  if ( stepped?.some(result => result.removed) ) return fail("SIGNATURE_ASSET_STEP_BELOW_D4");
  const preLossDice = entry.lost ? [...entry.lost.preLossDice] : [...dice.value];
  const outOfAction = Boolean(entry.lost?.outOfAction || loss.outOfAction);
  return ok({
    ...copyData(entry),
    dice: stepped ? stepped.map(result => result.size) : [...dice.value],
    lost: { outOfAction, preLossDice }
  });
}

/**
 * A lost signature asset comes back (rule 12): its dice from before the loss, and `lost` null. For
 * a PP at the start of a scene (one SIGNATURE_ASSET_RECOVER line), or between sessions for free;
 * the system doesn't know when a scene starts, so the table picks the route.
 *
 * Check order: (1) the entry's dice as in loseSignatureAsset; (2) route "pp" or "betweenSessions",
 * else INVALID_INPUT; (3) not lost, SIGNATURE_ASSET_NOT_LOST.
 * @param {{id?: string, name?: string, dice: number[], lost?: {outOfAction: boolean, preLossDice: number[]}|null}} entry
 * @param {"pp"|"betweenSessions"} route
 * @returns {import("./types.mjs").EngineResult<{entry: object, ppLines: import("./types.mjs").PpLine[]}>}
 */
export function recoverSignatureAsset(entry, route) {
  const dice = entryDice(entry);
  if ( !dice.ok ) return dice;
  if ( !["pp", "betweenSessions"].includes(route) ) return fail("INVALID_INPUT");
  if ( !entry.lost ) return fail("SIGNATURE_ASSET_NOT_LOST");
  const recovered = { ...copyData(entry), dice: [...entry.lost.preLossDice], lost: null };
  const ppLines = route === "pp" ? [{
    reason: "SIGNATURE_ASSET_RECOVER", direction: "spend", amount: 1, label: entry.name ?? "", sourceId: entry.id
  }] : [];
  return ok({ entry: recovered, ppLines });
}

/**
 * A d6 relationship for this session, bought for a PP (rule 15). The caller adds the entry to the
 * game's relationships set.
 *
 * Check order: id an id and name not blank, else INVALID_INPUT.
 * @param {{id: string, name: string}} input
 * @returns {import("./types.mjs").EngineResult<{entry: {id: string, defId: null, name: string, dice: [6],
 *   sessionOnly: true}, ppLines: import("./types.mjs").PpLine[]}>}
 */
export function createSessionRelationship(input) {
  if ( !isPlainObject(input) || !isId(input.id) || !isName(input.name) ) return fail("INVALID_INPUT");
  const entry = { id: input.id, defId: null, name: input.name, dice: [6], sessionOnly: true };
  return ok({ entry, ppLines: [spend("RELATIONSHIP_CREATE", entry)] });
}

/**
 * @returns {import("./types.mjs").EngineResult<{traits: TemporaryTrait[], removedIds: string[],
 *   reviewIds: string[], sceneBoosts: []}>}
 */
function endPeriod(state, durations) {
  if ( !isPlainObject(state) || !Array.isArray(state.sceneBoosts) ) return fail("INVALID_INPUT");
  const list = checkTraitList(state.traits);
  if ( !list.ok ) return list;
  if ( !state.sceneBoosts.every(isBoost) ) return fail("INVALID_INPUT");
  const ends = t => (t.holder.kind === "scene") || ((t.kind === "asset") && durations.includes(t.duration));
  const removedIds = list.value.filter(ends).map(t => t.id);
  const traits = list.value.filter(t => !ends(t)).map(t => ({ ...t, sceneSteps: 0 }));
  return ok({
    traits,
    sceneBoosts: [],
    removedIds,
    reviewIds: traits.filter(t => t.kind === "complication").map(t => t.id)
  });
}

/**
 * The end of a scene (rules 1, 8, 14 and 20): assets that last the scene and every trait of the
 * scene are removed, opportunity steps and scene boosts end, and the complications kept are listed
 * for the GM to look over. Nothing ends by itself; the GM's action calls this.
 *
 * Check order: (1) state a plain object with a sceneBoosts array, else INVALID_INPUT; (2) the traits
 * through checkTemporaryTrait; (3) the boosts' shape, INVALID_INPUT.
 * @param {{traits: TemporaryTrait[], sceneBoosts: SceneBoost[]}} state
 * @returns {import("./types.mjs").EngineResult<{traits: TemporaryTrait[], removedIds: string[], reviewIds: string[],
 *   sceneBoosts: []}>}
 */
export function endScene(state) {
  return endPeriod(state, ["scene"]);
}

/**
 * The end of a session: as endScene, and assets kept for the session end too, as do relationships
 * bought for the session (rule 15). Checks as endScene, then the relationship entries are plain
 * objects with an id (INVALID_INPUT).
 * @param {{traits: TemporaryTrait[], sceneBoosts: SceneBoost[]}} state
 * @param {{id: string, sessionOnly?: boolean}[]} [relationshipEntries]
 * @returns {import("./types.mjs").EngineResult<{traits: TemporaryTrait[], removedIds: string[], reviewIds: string[],
 *   sceneBoosts: [], expiredRelationshipIds: string[]}>}
 */
export function endSession(state, relationshipEntries = []) {
  const ended = endPeriod(state, ["scene", "session"]);
  if ( !ended.ok ) return ended;
  if ( !Array.isArray(relationshipEntries) || !relationshipEntries.every(e => isPlainObject(e) && isId(e.id)) ) {
    return fail("INVALID_INPUT");
  }
  return ok({ ...ended.value, expiredRelationshipIds: relationshipEntries.filter(e => e.sessionOnly).map(e => e.id) });
}
