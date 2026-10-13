import type { Guid } from '../protocol/world-delta';

export type MoveIntent = Readonly<{
  forward: number;
  strafe: number;
  turn: number;
}>;

export type GameCommand =
  | { kind: 'move'; intent: MoveIntent }
  | { kind: 'jump'; pressed: boolean }
  | { kind: 'use-action-slot'; slot: number; pressed: boolean }
  | { kind: 'target-next'; pressed: boolean }
  | { kind: 'cast-spell'; spellId: number; targetGuid?: Guid }
  | { kind: 'select-target'; guid?: Guid }
  | { kind: 'interact'; guid: Guid }
  | { kind: 'stop-cast' }
  | { kind: 'set-facing'; orientation: number };

/** Reused queue: dispatchers append, Simulation drains without allocating a replacement array. */
export class GameCommandQueue {
  private readonly pending: GameCommand[] = [];

  get length() { return this.pending.length; }

  push(command: GameCommand): void {
    this.pending.push(command);
  }

  drain(consumer: (command: GameCommand) => void): void {
    for (let i = 0; i < this.pending.length; i++) consumer(this.pending[i]);
    this.pending.length = 0;
  }

  clear(): void {
    this.pending.length = 0;
  }
}
