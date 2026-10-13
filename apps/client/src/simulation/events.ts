import type { Guid, Vec3State } from '../protocol/world-delta';

export type PresentationEvent =
  | { kind: 'entity-created'; renderId: number; guid: Guid }
  | { kind: 'entity-removed'; renderId: number; guid: Guid }
  | { kind: 'teleported'; renderId: number; guid: Guid; position: Vec3State; orientation: number; sequence: number }
  | { kind: 'spell-start'; casterGuid: Guid; spellId: number; targetGuid?: Guid }
  | { kind: 'spell-stop'; casterGuid: Guid; spellId?: number }
  | { kind: 'spell-impact'; casterGuid: Guid; spellId: number; targetGuid?: Guid; position?: Vec3State };

/** Edge-triggered presentation events. Persistent values remain in state/snapshots. */
export class PresentationEventQueue {
  private readonly events: PresentationEvent[] = [];

  get length() { return this.events.length; }

  push(event: PresentationEvent): void {
    this.events.push(event);
  }

  drain(consumer: (event: PresentationEvent) => void): void {
    for (let i = 0; i < this.events.length; i++) consumer(this.events[i]);
    this.events.length = 0;
  }

  copyInto(target: PresentationEvent[]): PresentationEvent[] {
    target.length = 0;
    for (let i = 0; i < this.events.length; i++) target.push(this.events[i]);
    return target;
  }

  clear(): void {
    this.events.length = 0;
  }
}
