import type { EntitySeed, Guid, Vec3State, WorldDelta } from '../protocol/world-delta';

export const enum EntityDirtyFlag {
  None = 0,
  Transform = 1 << 0,
  Appearance = 1 << 1,
  Combat = 1 << 2,
  Auras = 1 << 3,
  Metadata = 1 << 4,
  Lifecycle = 1 << 5,
  All = Transform | Appearance | Combat | Auras | Metadata | Lifecycle,
}

export type EntityVersions = {
  all: number;
  transform: number;
  appearance: number;
  combat: number;
  auras: number;
  metadata: number;
};

export type EntityState = {
  readonly renderId: number;
  readonly guid: Guid;
  typeId?: number;
  typeName: string;
  position: Vec3State;
  orientation: number;
  displayId: number;
  scale: number;
  health: number;
  maxHealth: number;
  level: number;
  faction: number;
  unitFlags: number;
  dynamicFlags: number;
  auraState: number;
  readonly auraSpellIds: number[];
  teleportSeq: number;
  dirty: number;
  readonly versions: EntityVersions;
};

const finiteOr = (value: number | undefined, fallback: number) => Number.isFinite(value) ? value! : fallback;

export function createEntityState(seed: EntitySeed, renderId: number): EntityState {
  const position = seed.position;
  return {
    renderId,
    guid: seed.guid,
    typeId: seed.typeId,
    typeName: seed.typeName ?? 'OBJECT',
    position: {
      x: finiteOr(position?.x, 0),
      y: finiteOr(position?.y, 0),
      z: finiteOr(position?.z, 0),
    },
    orientation: finiteOr(seed.orientation, 0),
    displayId: Math.max(0, seed.displayId ?? 0),
    scale: finiteOr(seed.scale, 1),
    health: Math.max(0, seed.health ?? 0),
    maxHealth: Math.max(0, seed.maxHealth ?? 0),
    level: Math.max(0, seed.level ?? 0),
    faction: seed.faction ?? 0,
    unitFlags: seed.unitFlags ?? 0,
    dynamicFlags: seed.dynamicFlags ?? 0,
    auraState: seed.auraState ?? 0,
    auraSpellIds: seed.auraSpellIds ? Array.from(seed.auraSpellIds) : [],
    teleportSeq: seed.teleportSeq ?? 0,
    dirty: EntityDirtyFlag.All,
    versions: { all: 1, transform: 1, appearance: 1, combat: 1, auras: 1, metadata: 1 },
  };
}

function bump(entity: EntityState, flag: EntityDirtyFlag, key: keyof Omit<EntityVersions, 'all'>): void {
  entity.dirty |= flag;
  entity.versions.all++;
  entity.versions[key]++;
}

export function clearEntityDirty(entity: EntityState): void {
  entity.dirty = EntityDirtyFlag.None;
}

export function applyEntityDelta(entity: EntityState, delta: Exclude<WorldDelta, { kind: 'entity-create' | 'entity-remove' }>): boolean {
  if (entity.guid !== delta.guid) return false;

  switch (delta.kind) {
    case 'transform': {
      if (
        entity.position.x === delta.position.x && entity.position.y === delta.position.y
        && entity.position.z === delta.position.z && entity.orientation === delta.orientation
      ) return false;
      entity.position.x = delta.position.x;
      entity.position.y = delta.position.y;
      entity.position.z = delta.position.z;
      entity.orientation = delta.orientation;
      bump(entity, EntityDirtyFlag.Transform, 'transform');
      return true;
    }

    case 'teleport': {
      if (
        entity.position.x === delta.position.x && entity.position.y === delta.position.y
        && entity.position.z === delta.position.z && entity.orientation === delta.orientation
        && entity.teleportSeq === delta.sequence
      ) return false;
      entity.position.x = delta.position.x;
      entity.position.y = delta.position.y;
      entity.position.z = delta.position.z;
      entity.orientation = delta.orientation;
      entity.teleportSeq = delta.sequence;
      bump(entity, EntityDirtyFlag.Transform, 'transform');
      return true;
    }

    case 'health': {
      const health = Math.max(0, delta.health);
      const maxHealth = delta.maxHealth === undefined ? entity.maxHealth : Math.max(0, delta.maxHealth);
      if (entity.health === health && entity.maxHealth === maxHealth) return false;
      entity.health = health;
      entity.maxHealth = maxHealth;
      bump(entity, EntityDirtyFlag.Combat, 'combat');
      return true;
    }

    case 'appearance': {
      const displayId = delta.displayId === undefined ? entity.displayId : Math.max(0, delta.displayId);
      const scale = delta.scale === undefined ? entity.scale : delta.scale;
      if (entity.displayId === displayId && entity.scale === scale) return false;
      entity.displayId = displayId;
      entity.scale = scale;
      bump(entity, EntityDirtyFlag.Appearance, 'appearance');
      return true;
    }

    case 'flags': {
      const unitFlags = delta.unitFlags === undefined ? entity.unitFlags : delta.unitFlags >>> 0;
      const dynamicFlags = delta.dynamicFlags === undefined ? entity.dynamicFlags : delta.dynamicFlags >>> 0;
      const auraState = delta.auraState === undefined ? entity.auraState : delta.auraState >>> 0;
      if (entity.unitFlags === unitFlags && entity.dynamicFlags === dynamicFlags && entity.auraState === auraState) return false;
      entity.unitFlags = unitFlags;
      entity.dynamicFlags = dynamicFlags;
      entity.auraState = auraState;
      bump(entity, EntityDirtyFlag.Combat, 'combat');
      return true;
    }

    case 'auras': {
      if (
        entity.auraSpellIds.length === delta.spellIds.length
        && entity.auraSpellIds.every((spellId, index) => spellId === delta.spellIds[index])
      ) return false;
      entity.auraSpellIds.length = 0;
      for (let i = 0; i < delta.spellIds.length; i++) entity.auraSpellIds.push(delta.spellIds[i]);
      bump(entity, EntityDirtyFlag.Auras, 'auras');
      return true;
    }

    case 'metadata': {
      const level = delta.level === undefined ? entity.level : Math.max(0, delta.level);
      const faction = delta.faction === undefined ? entity.faction : delta.faction;
      if (entity.level === level && entity.faction === faction) return false;
      entity.level = level;
      entity.faction = faction;
      bump(entity, EntityDirtyFlag.Metadata, 'metadata');
      return true;
    }
  }
}
