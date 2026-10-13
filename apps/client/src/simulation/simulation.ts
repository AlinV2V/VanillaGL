import type { WorldDelta } from '../protocol/world-delta';
import { FixedSimulationClock } from './clock';
import { GameCommandQueue, type GameCommand } from './commands';
import { RenderSnapshotBuffer } from './render-snapshot';
import { WorldState } from './world-state';
import { PendingWorldDeltas } from './pending-world-deltas';

export type SimulationOptions = {
  fixedDeltaMs?: number;
  onCommand?: (command: GameCommand) => void;
};

/**
 * Browser-independent simulation façade. Input commands and protocol deltas enter here; render
 * snapshots and presentation events leave here. Moving this class to a Worker must not change its API.
 */
export class Simulation {
  readonly clock: FixedSimulationClock;
  readonly world: WorldState;
  readonly commands = new GameCommandQueue();
  private readonly pendingDeltas = new PendingWorldDeltas();
  private stateRevision = 0;
  private readonly onCommand?: (command: GameCommand) => void;
  private readonly consumeDelta = (delta: WorldDelta) => { this.world.apply(delta); this.stateRevision++; };
  private readonly consumeCommand = (command: GameCommand) => {
    this.applyLocalCommand(command);
    this.onCommand?.(command);
  };

  constructor(options: SimulationOptions = {}) {
    this.clock = new FixedSimulationClock(options.fixedDeltaMs);
    this.world = new WorldState();
    this.onCommand = options.onCommand;
  }

  enqueueDelta(delta: WorldDelta): void {
    if (this.pendingDeltas.atCapacity) {
      this.pendingDeltas.drain(this.consumeDelta);
      this.pendingDeltas.noteEmergencyFlush();
    }
    this.pendingDeltas.enqueue(delta);
  }

  dispatch(command: GameCommand): void {
    this.commands.push(command);
  }

  step(): void {
    this.pendingDeltas.drain(this.consumeDelta);
    this.commands.drain(this.consumeCommand);
    this.clock.step();
  }

  writeRenderSnapshot(target: RenderSnapshotBuffer): RenderSnapshotBuffer {
    if (target.matchesState(this.world, this.stateRevision)) {
      // Fixed ticks advance even between packets. Keep time current without copying every entity.
      target.tick = this.clock.tick;
      target.timeMs = this.clock.timeMs;
      return target;
    }
    return target.write(this.world, this.clock.tick, this.clock.timeMs, this.stateRevision);
  }

  reset(): void {
    this.pendingDeltas.clear();
    this.commands.clear();
    this.world.clear();
    this.world.events.clear();
    this.stateRevision++;
    this.clock.reset();
  }

  /** Minimal prediction-facing command effects. The authoritative realm can overwrite them via deltas. */
  private applyLocalCommand(command: GameCommand): void {
    if (command.kind === 'set-facing') {
      // Selection of the local controlled entity is intentionally outside the pure core for now.
      return;
    }
  }

  /** Stable debug/replay fingerprint; intentionally not used in hot paths. */
  deterministicHash(): string {
    const rows: string[] = [];
    for (const entity of this.world.values()) {
      rows.push([
        entity.guid,
        entity.typeId ?? -1,
        entity.position.x,
        entity.position.y,
        entity.position.z,
        entity.orientation,
        entity.displayId,
        entity.scale,
        entity.health,
        entity.maxHealth,
        entity.level,
        entity.faction,
        entity.unitFlags >>> 0,
        entity.dynamicFlags >>> 0,
        entity.auraState >>> 0,
        entity.teleportSeq >>> 0,
        entity.auraSpellIds.join(','),
      ].join('|'));
    }
    rows.sort();
    const text = `${this.clock.tick};${this.clock.timeMs};${rows.join(';')}`;
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  pendingDiagnostics() { return this.pendingDeltas.diagnostics(); }
}
