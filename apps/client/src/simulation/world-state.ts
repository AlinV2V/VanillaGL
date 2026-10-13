import type { Guid, WorldDelta } from '../protocol/world-delta';
import { applyEntityDelta, createEntityState, type EntityState } from './entity-state';
import { PresentationEventQueue } from './events';

/** Canonical renderer-independent entity store. GUIDs stay external; render IDs are dense numeric handles. */
export class WorldState {
  private readonly byGuid = new Map<Guid, EntityState>();
  private readonly byRenderId = new Map<number, EntityState>();
  private nextRenderId = 1;

  constructor(readonly events = new PresentationEventQueue()) {}

  get size() { return this.byGuid.size; }

  get(guid: Guid): EntityState | undefined {
    return this.byGuid.get(guid);
  }

  getByRenderId(renderId: number): EntityState | undefined {
    return this.byRenderId.get(renderId);
  }

  values(): IterableIterator<EntityState> {
    return this.byGuid.values();
  }

  apply(delta: WorldDelta): EntityState | undefined {
    if (delta.kind === 'entity-create') {
      const existing = this.byGuid.get(delta.entity.guid);
      if (existing) return existing;
      const entity = createEntityState(delta.entity, this.nextRenderId++);
      this.byGuid.set(entity.guid, entity);
      this.byRenderId.set(entity.renderId, entity);
      this.events.push({ kind: 'entity-created', renderId: entity.renderId, guid: entity.guid });
      return entity;
    }

    if (delta.kind === 'entity-remove') {
      const entity = this.byGuid.get(delta.guid);
      if (!entity) return undefined;
      this.byGuid.delete(delta.guid);
      this.byRenderId.delete(entity.renderId);
      this.events.push({ kind: 'entity-removed', renderId: entity.renderId, guid: entity.guid });
      return entity;
    }

    const entity = this.byGuid.get(delta.guid);
    if (!entity) return undefined;
    if (!applyEntityDelta(entity, delta)) return entity;

    if (delta.kind === 'teleport') {
      this.events.push({
        kind: 'teleported',
        renderId: entity.renderId,
        guid: entity.guid,
        position: { x: delta.position.x, y: delta.position.y, z: delta.position.z },
        orientation: delta.orientation,
        sequence: delta.sequence,
      });
    }
    return entity;
  }

  clear(): void {
    for (const entity of this.byGuid.values()) {
      this.events.push({ kind: 'entity-removed', renderId: entity.renderId, guid: entity.guid });
    }
    this.byGuid.clear();
    this.byRenderId.clear();
  }
}
