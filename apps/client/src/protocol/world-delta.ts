export type Guid = string;

export type Vec3State = {
  x: number;
  y: number;
  z: number;
};

export type EntitySeed = {
  guid: Guid;
  typeId?: number;
  typeName?: string;
  position?: Vec3State;
  orientation?: number;
  displayId?: number;
  scale?: number;
  health?: number;
  maxHealth?: number;
  level?: number;
  faction?: number;
  unitFlags?: number;
  dynamicFlags?: number;
  auraState?: number;
  auraSpellIds?: readonly number[];
  teleportSeq?: number;
};

/**
 * Protocol-neutral mutations consumed by the simulation. Raw opcodes, packet masks and byte
 * layouts stop at the protocol adapter; replay fixtures and tests can produce the same deltas.
 */
export type WorldDelta =
  | { kind: 'entity-create'; entity: EntitySeed }
  | { kind: 'entity-remove'; guid: Guid }
  | { kind: 'transform'; guid: Guid; position: Vec3State; orientation: number }
  | { kind: 'teleport'; guid: Guid; position: Vec3State; orientation: number; sequence: number }
  | { kind: 'health'; guid: Guid; health: number; maxHealth?: number }
  | { kind: 'appearance'; guid: Guid; displayId?: number; scale?: number }
  | { kind: 'flags'; guid: Guid; unitFlags?: number; dynamicFlags?: number; auraState?: number }
  | { kind: 'auras'; guid: Guid; spellIds: readonly number[] }
  | { kind: 'metadata'; guid: Guid; level?: number; faction?: number };
