import type { WorldEntity, WorldEntityChange } from '../world-entities';
import type { WorldDelta } from '../protocol/world-delta';

const finite = (value: number | undefined, fallback = 0) => Number.isFinite(value) ? value! : fallback;

// Build-5875 UpdateFields used by the protocol-neutral simulation projection. Keep this list
// intentionally narrow: domains are emitted only when a field represented by EntityState changed.
const OBJECT_FIELD_SCALE_X = 0x04;
const UNIT_FIELD_HEALTH = 0x16;
const UNIT_FIELD_MAXHEALTH = 0x1c;
const UNIT_FIELD_LEVEL = 0x22;
const UNIT_FIELD_FACTIONTEMPLATE = 0x23;
const UNIT_FIELD_FLAGS = 0x2e;
const UNIT_FIELD_AURA = 0x2f;
const UNIT_FIELD_AURASTATE = 0x7d;
const UNIT_FIELD_DISPLAYID = 0x83;
const UNIT_DYNAMIC_FLAGS = 0x8f;

export type WorldDeltaSink = (delta: WorldDelta) => void;

/** Temporary bridge from the legacy packet/update store into the protocol-neutral simulation API. */
export function emitWorldEntityChangeAsDeltas(change: WorldEntityChange, emit: WorldDeltaSink): void {
  if (change.kind === 'none') return;
  if (change.kind === 'remove') {
    emit({ kind: 'entity-remove', guid: change.guid });
    return;
  }

  const entity = change.entity;
  if (change.kind === 'create') {
    emit({
      kind: 'entity-create',
      entity: {
        guid: entity.guid,
        typeId: entity.typeId,
        typeName: entity.typeName,
        position: { x: finite(entity.x), y: finite(entity.y), z: finite(entity.z) },
        orientation: finite(entity.o),
        displayId: entity.displayId,
        scale: entity.scale,
        health: entity.health,
        maxHealth: entity.maxHealth,
        level: entity.level,
        faction: entity.faction,
        unitFlags: entity.unitFlags,
        dynamicFlags: entity.dynamicFlags,
        auraState: entity.auraState,
        auraSpellIds: entity.auraSpellIds ? [...entity.auraSpellIds] : undefined,
        teleportSeq: entity.teleportSeq,
      },
    });
    return;
  }

  emitCurrentEntityProjection(entity, emit, change.discontinuity === 'teleport', change.changedFields);
}

export function emitCurrentEntityProjection(
  entity: WorldEntity,
  emit: WorldDeltaSink,
  teleport = false,
  changedFields?: readonly number[],
): void {
  const position = { x: finite(entity.x), y: finite(entity.y), z: finite(entity.z) };
  if (teleport) {
    emit({
      kind: 'teleport',
      guid: entity.guid,
      position,
      orientation: finite(entity.o),
      sequence: entity.teleportSeq ?? 0,
    });
  } else {
    emit({
      kind: 'transform',
      guid: entity.guid,
      position,
      orientation: finite(entity.o),
    });
  }
  // Direct callers without a field mask request a complete projection. Store callbacks always pass
  // changedFields, including [] for movement-only opcodes, so cold domains stay untouched there.
  const all = changedFields === undefined;
  const changed = (field: number) => all || changedFields.includes(field);
  if (changed(UNIT_FIELD_HEALTH) || changed(UNIT_FIELD_MAXHEALTH)) {
    emit({ kind: 'health', guid: entity.guid, health: entity.health ?? 0, maxHealth: entity.maxHealth });
  }
  if (changed(OBJECT_FIELD_SCALE_X) || changed(UNIT_FIELD_DISPLAYID)) {
    emit({ kind: 'appearance', guid: entity.guid, displayId: entity.displayId, scale: entity.scale });
  }
  if (changed(UNIT_FIELD_FLAGS) || changed(UNIT_DYNAMIC_FLAGS) || changed(UNIT_FIELD_AURASTATE)) {
    emit({
      kind: 'flags',
      guid: entity.guid,
      unitFlags: entity.unitFlags,
      dynamicFlags: entity.dynamicFlags,
      auraState: entity.auraState,
    });
  }
  if (all || changedFields.some((field) => field >= UNIT_FIELD_AURA && field <= UNIT_FIELD_AURASTATE)) {
    emit({ kind: 'auras', guid: entity.guid, spellIds: [...(entity.auraSpellIds ?? [])] });
  }
  if (changed(UNIT_FIELD_LEVEL) || changed(UNIT_FIELD_FACTIONTEMPLATE)) {
    emit({ kind: 'metadata', guid: entity.guid, level: entity.level, faction: entity.faction });
  }
}
