import type { WorldDelta } from '../protocol/world-delta';
import type { GameCommand } from './commands';
import type { PresentationEvent } from './events';

export type SimulationWorkerRequest =
  | { kind: 'delta'; delta: WorldDelta }
  | { kind: 'command'; command: GameCommand }
  | { kind: 'step'; count?: number }
  | { kind: 'reset' };

export type TransferableRenderSnapshot = {
  tick: number;
  timeMs: number;
  count: number;
  renderIds: Uint32Array;
  positions: Float32Array;
  orientations: Float32Array;
  displayIds: Uint32Array;
  scales: Float32Array;
  health: Uint32Array;
  maxHealth: Uint32Array;
  unitFlags: Uint32Array;
  dynamicFlags: Uint32Array;
  teleportSequences: Uint32Array;
  transformVersions: Uint32Array;
  appearanceVersions: Uint32Array;
  combatVersions: Uint32Array;
};

export type SimulationWorkerResponse =
  | { kind: 'snapshot'; snapshot: TransferableRenderSnapshot; events: PresentationEvent[] }
  | { kind: 'reset-complete' }
  | { kind: 'error'; message: string };
