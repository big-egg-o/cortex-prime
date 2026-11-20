/** The shared PC layout and the blocks a GM has put on one GMC (ADR-055). */
export const DEFAULT_PC_KIND = "cpKindPlayerChar";
export const DEFAULT_MOB_SET = "cpSetMobTrait000";
export const GMC_BLOCKS = Object.freeze(["free", "mob", "boss", "sfx"]);

/** Older worlds can already have a renamed or customized PC kind with this stable id. */
export function pcLayoutId(config) {
  return config.pcKindId === undefined ? DEFAULT_PC_KIND : config.pcKindId;
}

/** A view of the layout. Reading an Actor never assigns a kind or writes any blocks. */
export function actorLayout(type, system, config) {
  if ( type === "gmc" ) {
    const blocks = system.blocks ?? [];
    return {
      id: null, name: "", traitSetIds: blocks.filter(id => !GMC_BLOCKS.includes(id)),
      freeTraits: blocks.some(id => ["free", "mob", "boss"].includes(id))
    };
  }
  const id = type === "pc" ? pcLayoutId(config) : system.kindId;
  return config.actorKinds.find(kind => kind.id === id) ?? null;
}

/** A GMC converted by copying keeps the source kind's visible sets, including empty fixed sets. */
export function blocksFromCharacter(system, config) {
  const kind = actorLayout("character", system, config);
  const sets = kind ? kind.traitSetIds : Object.keys(system.traits ?? {});
  return [...sets, ...((kind?.freeTraits ?? Boolean(system.freeTraits?.length)) ? ["free"] : [])];
}

/** Hiding a block changes only membership. Its traits, SFX and shut-down flags survive. */
export function addGmcBlock(system, config, block, makeId, label) {
  if ( system.blocks.includes(block) ) return null;
  if ( !GMC_BLOCKS.includes(block) && !config.traitSets.some(set => set.id === block) ) return null;
  const changes = { blocks: [...system.blocks, block] };
  if ( block === "mob" || block === "boss" ) {
    const field = block + "TraitId";
    if ( !system.freeTraits.some(entry => entry.id === system[field]) ) {
      const id = makeId();
      changes[field] = id;
      changes.freeTraits = [...system.freeTraits, { id, name: label, dice: [] }];
    }
  }
  return changes;
}
