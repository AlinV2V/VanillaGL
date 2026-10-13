import {
  runtimeWorkScheduler,
  type RuntimeWorkPriority,
} from '../platform/runtime-work-scheduler';
import { recordRuntimeAttribution } from '../platform/runtime-attribution';
import { beginCpuScope, CpuScopeId, endCpuScope } from './performance-cpu-scopes';

export type WorldHydrationCheckpoint = {
  checkpoint: (completed?: number) => Promise<void>;
  finish: () => void;
  yieldCount: () => number;
};
type RuntimeWorkOwnership = { signal?: AbortSignal; ownerId?: string };

let activeHydrations = 0;
let startedHydrations = 0;
let completedHydrations = 0;
let hydrationYields = 0;
let hydrationSlices = 0;
let maxUnitsInSlice = 0;

export const worldHydrationDiagnostics = () => ({
  active: activeHydrations,
  started: startedHydrations,
  completed: completedHydrations,
  yields: hydrationYields,
  slices: hydrationSlices,
  maxUnitsInSlice,
});

/** Yield a large manifest loop once it has consumed its share of the current frame. */
export function createWorldHydrationCheckpoint(
  label: string,
  priority: RuntimeWorkPriority = 'normal',
  sliceBudgetMs = 1.1,
  cooperative = true,
  ownership: RuntimeWorkOwnership = {},
): WorldHydrationCheckpoint {
  const budgetMs = Math.max(0.25, Math.min(2, sliceBudgetMs));
  let sliceStarted = performance.now();
  let yields = 0;
  let finished = false;
  activeHydrations++;
  startedHydrations++;
  const hydrationStarted = performance.now();
  return {
    checkpoint: async () => {
      if (!cooperative || performance.now() - sliceStarted < budgetMs) return;
      await runtimeWorkScheduler.schedule(`${label}:yield`, () => undefined, {
        priority,
        estimatedMs: 0.05,
        ...ownership,
      });
      sliceStarted = performance.now();
      yields++;
      hydrationYields++;
    },
    finish: () => {
      if (finished) return;
      finished = true;
      activeHydrations--;
      completedHydrations++;
      recordRuntimeAttribution('world-hydration', label, performance.now() - hydrationStarted);
    },
    yieldCount: () => yields,
  };
}

/** Admit one bounded unit through the same per-frame budget as other hydration work. */
export function scheduleWorldHydrationTask<T>(
  label: string,
  run: () => T,
  priority: RuntimeWorkPriority,
  estimatedMs: number,
  cooperative = true,
  ownership: RuntimeWorkOwnership = {},
): Promise<T> {
  const attributedRun = () => { const cpuScope = beginCpuScope(CpuScopeId.HydrationAdmissionQueues); try { return run(); } finally { endCpuScope(cpuScope); } };
  if (!cooperative) {
    try { return Promise.resolve(attributedRun()); } catch (error) { return Promise.reject(error); }
  }
  return runtimeWorkScheduler.schedule(label, attributedRun, { priority, estimatedMs, ...ownership });
}

/** Run a synchronous cursor in scheduler-owned slices; `step` returns true after its final unit. */
export function scheduleWorldHydrationSlices(
  label: string,
  step: () => boolean,
  options: {
    priority?: RuntimeWorkPriority;
    sliceBudgetMs?: number;
    estimatedUnitMs?: number;
    maxUnitsPerSlice?: number;
    cooperative?: boolean;
    isCurrent?: () => boolean;
    signal?: AbortSignal;
    ownerId?: string;
  } = {},
): Promise<void> {
  const priority = options.priority ?? 'normal';
  const budgetMs = Math.max(0.25, Math.min(2, options.sliceBudgetMs ?? 0.8));
  const unitLimit = Math.max(1, Math.floor(options.maxUnitsPerSlice ?? 8));
  const current = options.isCurrent ?? (() => true);
  if (options.cooperative === false) {
    while (current()) if (step()) return Promise.resolve();
    return Promise.reject(new Error(`${label}: hydration superseded`));
  }
  return new Promise<void>((resolve, reject) => {
    const enqueue = () => {
      void scheduleWorldHydrationTask(label, () => {
        if (!current()) throw new Error(`${label}: hydration superseded`);
        const started = performance.now();
        let units = 0, done = false;
        do {
          done = step();
          units++;
        } while (!done && units < unitLimit && performance.now() - started < budgetMs && current());
        hydrationSlices++;
        maxUnitsInSlice = Math.max(maxUnitsInSlice, units);
        if (!current()) throw new Error(`${label}: hydration superseded`);
        if (done) resolve();
        else enqueue();
      }, priority, options.estimatedUnitMs ?? 0.15, true, {
        signal: options.signal,
        ownerId: options.ownerId,
      }).catch(reject);
    };
    enqueue();
  });
}
