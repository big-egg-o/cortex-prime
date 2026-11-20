import { describe, expect, it } from "vitest";
import { actorLayout, addGmcBlock, blocksFromCharacter, DEFAULT_PC_KIND, pcLayoutId } from "../../module/rules/actor-layout.mjs";
import { applyConfigForm, deleteActorKind } from "../../module/config/game-config-draft.mjs";
import { characterSheetView } from "../../module/apps/character-sheet-data.mjs";
import { defaultGameConfig, validateGameConfig } from "../../module/rules/game-config.mjs";
import { addTraitDice, poolTraitReport, traitPoolDice } from "../../module/rules/pool-traits.mjs";

const config = defaultGameConfig();
const system = { kindId: null, traits: {}, freeTraits: [], blocks: [] };

describe("native character layouts", () => {
  it("uses one world layout for every PC, even after renaming or replacing the default kind", () => {
    expect(pcLayoutId(config)).toBe(DEFAULT_PC_KIND);
    const next = applyConfigForm(config, { pcKindId: config.actorKinds[1].id });
    next.actorKinds[1].name = "The crew";
    expect(actorLayout("pc", system, next)).toEqual(next.actorKinds[1]);
    expect(actorLayout("pc", { ...system, kindId: "cpKindMob0000000" }, next)).toEqual(next.actorKinds[1]);
    const removed = deleteActorKind(next, next.pcKindId);
    expect(actorLayout("pc", system, removed)).toBeNull();
    expect(validateGameConfig(removed).ok).toBe(true);
    expect(validateGameConfig({ ...config, pcKindId: "bad" }).ok).toBe(false);
  });

  it("starts GMCs empty, uses the chosen block order, and restores hidden values by id", () => {
    const skills = config.traitSets[2].id;
    const attrs = config.traitSets[1].id;
    expect(actorLayout("gmc", system, config).traitSetIds).toEqual([]);
    const stored = { ...system, blocks: [skills, "free", attrs], freeTraits: [{ id: "desertBandit0001", name: "Lookout", dice: [8] }] };
    const view = characterSheetView(stored, config, actorLayout("gmc", stored, config));
    expect(view.sets.map(s => s.id)).toEqual([skills, attrs]);
    expect(view.freeTraits[0].name).toBe("Lookout");
    const hidden = { ...stored, blocks: [skills] };
    expect(characterSheetView(hidden, config, actorLayout("gmc", hidden, config)).others.freeTraits[0].dice).toEqual([8]);
    const restored = { ...hidden, ...addGmcBlock(hidden, config, "free") };
    expect(characterSheetView(restored, config, actorLayout("gmc", restored, config)).freeTraits[0].entryId).toBe("desertBandit0001");
    expect(addGmcBlock(restored, config, skills)).toBeNull();
    expect(addGmcBlock(restored, config, "missing")).toBeNull();
  });

  it.each(["boss", "mob"])("keeps a %s rating and its pool source when its block is restored", block => {
    const added = { ...system, ...addGmcBlock(system, config, block, () => "threatSource0001", "Threat") };
    added.freeTraits[0].dice = [8, 8];
    const hidden = { ...added, blocks: [] };
    const restored = { ...hidden, ...addGmcBlock(hidden, config, block, () => { throw Error("unexpected new id"); }) };
    expect(restored.freeTraits).toEqual(added.freeTraits);
    expect(restored[block + "TraitId"]).toBe("threatSource0001");
    const view = characterSheetView(restored, config, actorLayout("gmc", restored, config));
    expect(view.freeTraits[0].slots.map(slot => slot.value)).toEqual([8, 8, null]);
    expect(traitPoolDice(restored, config, null, "threatSource0001").value.entries).toHaveLength(2);
  });

  it("counts only prime sets present on the GMC when reporting a mixed actor pool", () => {
    const attributes = config.traitSets[1];
    const skills = config.traitSets[2];
    const dice = traitPoolDice(system, config, attributes.id, attributes.traits[0].id);
    const pool = addTraitDice([], dice.value, { actorRef: "Actor.A" }).value.pool;
    const warnings = traitSetIds => poolTraitReport(pool, { "Actor.A": { traitSetIds } }, config).value.warnings;
    expect(warnings([attributes.id])).toEqual([]);
    expect(warnings([skills.id])).toEqual([{ code: "PRIME_SET_MISSING", setId: skills.id }]);
  });

  it("preserves old kinds and proposes block membership without touching a source actor", () => {
    for ( const kind of config.actorKinds ) {
      const legacy = Object.freeze({ ...system, kindId: kind.id });
      expect(actorLayout("character", legacy, config)).toEqual(kind);
      expect(blocksFromCharacter(legacy, config)).toEqual([...kind.traitSetIds, ...(kind.freeTraits ? ["free"] : [])]);
    }
    const unknown = { ...system, kindId: "unknown", traits: { missing: {} }, freeTraits: [{}] };
    expect(blocksFromCharacter(unknown, config)).toEqual(["missing", "free"]);
  });
});
