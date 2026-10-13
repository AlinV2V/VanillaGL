/// <reference lib="webworker" />

import { RenderSnapshotBuffer } from '../simulation/render-snapshot';
import { Simulation } from '../simulation/simulation';
import type {
  SimulationWorkerRequest,
  SimulationWorkerResponse,
  TransferableRenderSnapshot,
} from '../simulation/worker-protocol';
import type { PresentationEvent } from '../simulation/events';

const scope = self as DedicatedWorkerGlobalScope;
const simulation = new Simulation();
const workingSnapshot = new RenderSnapshotBuffer();
const copiedEvents: PresentationEvent[] = [];

function compactSnapshot(source: RenderSnapshotBuffer): TransferableRenderSnapshot {
  const count = source.count;
  return {
    tick: source.tick,
    timeMs: source.timeMs,
    count,
    renderIds: source.renderIds.slice(0, count),
    positions: source.positions.slice(0, count * 3),
    orientations: source.orientations.slice(0, count),
    displayIds: source.displayIds.slice(0, count),
    scales: source.scales.slice(0, count),
    health: source.health.slice(0, count),
    maxHealth: source.maxHealth.slice(0, count),
    unitFlags: source.unitFlags.slice(0, count),
    dynamicFlags: source.dynamicFlags.slice(0, count),
    teleportSequences: source.teleportSequences.slice(0, count),
    transformVersions: source.transformVersions.slice(0, count),
    appearanceVersions: source.appearanceVersions.slice(0, count),
    combatVersions: source.combatVersions.slice(0, count),
  };
}

function transferList(snapshot: TransferableRenderSnapshot): Transferable[] {
  return [
    snapshot.renderIds.buffer,
    snapshot.positions.buffer,
    snapshot.orientations.buffer,
    snapshot.displayIds.buffer,
    snapshot.scales.buffer,
    snapshot.health.buffer,
    snapshot.maxHealth.buffer,
    snapshot.unitFlags.buffer,
    snapshot.dynamicFlags.buffer,
    snapshot.teleportSequences.buffer,
    snapshot.transformVersions.buffer,
    snapshot.appearanceVersions.buffer,
    snapshot.combatVersions.buffer,
  ] as Transferable[];
}

function publishSnapshot(): void {
  simulation.writeRenderSnapshot(workingSnapshot);
  simulation.world.events.copyInto(copiedEvents);
  simulation.world.events.clear();
  const snapshot = compactSnapshot(workingSnapshot);
  const response: SimulationWorkerResponse = { kind: 'snapshot', snapshot, events: copiedEvents.slice() };
  scope.postMessage(response, transferList(snapshot));
}

scope.onmessage = (event: MessageEvent<SimulationWorkerRequest>) => {
  try {
    const request = event.data;
    switch (request.kind) {
      case 'delta':
        simulation.enqueueDelta(request.delta);
        break;
      case 'command':
        simulation.dispatch(request.command);
        break;
      case 'step': {
        const count = Math.max(1, Math.min(120, request.count ?? 1));
        for (let i = 0; i < count; i++) simulation.step();
        publishSnapshot();
        break;
      }
      case 'reset': {
        simulation.reset();
        const response: SimulationWorkerResponse = { kind: 'reset-complete' };
        scope.postMessage(response);
        break;
      }
    }
  } catch (error) {
    const response: SimulationWorkerResponse = {
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
    scope.postMessage(response);
  }
};
