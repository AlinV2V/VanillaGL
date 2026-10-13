import type { WorldDelta } from '../protocol/world-delta';
import type { GameCommand } from '../simulation/commands';
import type { PresentationEvent } from '../simulation/events';
import type {
  SimulationWorkerRequest,
  SimulationWorkerResponse,
  TransferableRenderSnapshot,
} from '../simulation/worker-protocol';

export type SimulationWorkerListener = (
  snapshot: TransferableRenderSnapshot,
  events: readonly PresentationEvent[],
) => void;

/** Browser adapter around the pure Simulation worker protocol. */
export class SimulationWorkerProxy {
  private readonly worker: Worker;
  private readonly listeners = new Set<SimulationWorkerListener>();
  private errorHandler?: (message: string) => void;

  constructor() {
    this.worker = new Worker(new URL('./simulation.worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', (event: MessageEvent<SimulationWorkerResponse>) => {
      const response = event.data;
      if (response.kind === 'snapshot') {
        for (const listener of this.listeners) listener(response.snapshot, response.events);
      } else if (response.kind === 'error') {
        this.errorHandler?.(response.message);
      }
    });
  }

  /**
   * The worker path is opt-in while the legacy packet store remains authoritative.
   * Unsupported browsers and construction failures return null so callers retain
   * the synchronous simulation instead of losing the world session.
   */
  static tryCreate(enabled: boolean): SimulationWorkerProxy | null {
    if (!enabled || typeof Worker !== 'function') return null;
    try {
      return new SimulationWorkerProxy();
    } catch {
      return null;
    }
  }

  enqueueDelta(delta: WorldDelta): void {
    this.post({ kind: 'delta', delta });
  }

  dispatch(command: GameCommand): void {
    this.post({ kind: 'command', command });
  }

  step(count = 1): void {
    this.post({ kind: 'step', count });
  }

  reset(): void {
    this.post({ kind: 'reset' });
  }

  subscribe(listener: SimulationWorkerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onError(handler: (message: string) => void): void {
    this.errorHandler = handler;
  }

  dispose(): void {
    this.listeners.clear();
    this.worker.terminate();
  }

  private post(message: SimulationWorkerRequest): void {
    this.worker.postMessage(message);
  }
}
