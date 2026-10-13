import { recordRuntimeAttribution } from './runtime-attribution';

export type RuntimeWorkPriority = 'must-run-now' | 'critical' | 'normal' | 'background';

type QueuedWork = {
  id: number;
  label: string;
  priority: RuntimeWorkPriority;
  estimatedMs: number;
  run: () => unknown;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  state: 'queued' | 'active' | 'settled';
  signal?: AbortSignal;
  ownerId?: string;
  abortListener?: () => void;
};

type WorkLane = { values: QueuedWork[]; head: number };

export type RuntimeWorkStats = {
  queued: number;
  critical: number;
  mustRunNow: number;
  normal: number;
  background: number;
  completed: number;
  failed: number;
  hiddenWakeups: number;
  lastPumpMs: number;
  totalPumpMs: number;
  budgetOverrunPumps: number;
  maxBudgetOverrunMs: number;
  cancelled: number;
};

export type RuntimeWorkWakeupEnvironment = {
  isHidden: () => boolean;
  requestFrame: (callback: () => void) => void;
  requestTimer: (callback: () => void) => void;
  subscribeVisibility: (callback: () => void) => void;
};

const defaultWakeupEnvironment: RuntimeWorkWakeupEnvironment = {
  isHidden: () => typeof document !== 'undefined' && document.hidden,
  requestFrame: (callback) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
    else queueMicrotask(callback);
  },
  requestTimer: (callback) => { setTimeout(callback, 0); },
  subscribeVisibility: (callback) => {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', callback);
  },
};

const PRIORITY_ORDER: RuntimeWorkPriority[] = ['must-run-now', 'critical', 'normal', 'background'];

/**
 * Cooperative main-thread scheduler for measured decode and collision hydration work. Meshopt
 * stream unpacking and collision-tree admission are scheduled consumers. New consumers must
 * bring a runtime measurement gate before they are admitted to this frame budget.
 */
export class RuntimeWorkScheduler {
  private nextId = 1;
  private readonly queues: Record<RuntimeWorkPriority, WorkLane> = {
    'must-run-now': { values: [], head: 0 },
    critical: { values: [], head: 0 },
    normal: { values: [], head: 0 },
    background: { values: [], head: 0 },
  };
  private readonly queuedByPriority: Record<RuntimeWorkPriority, number> = {
    'must-run-now': 0, critical: 0, normal: 0, background: 0,
  };
  private readonly owned = new Map<string, Set<QueuedWork>>();
  private completed = 0;
  private failed = 0;
  private hiddenWakeups = 0;
  private lastPumpMs = 0;
  private totalPumpMs = 0;
  private budgetOverrunPumps = 0;
  private maxBudgetOverrunMs = 0;
  private cancelled = 0;
  private wakeupScheduled = false;
  private animationLoopActive = false;

  constructor(private readonly wakeupEnvironment = defaultWakeupEnvironment) {
    this.wakeupEnvironment.subscribeVisibility(() => {
      if (this.wakeupEnvironment.isHidden() && this.peekNext()) this.ensureWakeup();
    });
  }

  /** Loading screens have no WebGL frame to protect, so drain their queue in wider slices. */
  setAnimationLoopActive(active: boolean): void {
    this.animationLoopActive = active;
    if (!active && this.peekNext()) this.ensureWakeup();
  }

  schedule<T>(
    label: string,
    run: () => T,
    options: { priority?: RuntimeWorkPriority; estimatedMs?: number; signal?: AbortSignal; ownerId?: string } = {},
  ): Promise<T> {
    const priority = options.priority ?? 'normal';
    const estimatedMs = Math.max(0.05, Math.min(8, options.estimatedMs ?? 0.25));
    const promise = new Promise<T>((resolve, reject) => {
      if (options.signal?.aborted) { reject(options.signal.reason ?? new DOMException('runtime work aborted', 'AbortError')); return; }
      const work: QueuedWork = {
        id: this.nextId++,
        label,
        priority,
        estimatedMs,
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
        state: 'queued',
        signal: options.signal,
        ownerId: options.ownerId,
      };
      work.abortListener = () => this.cancel(work, work.signal?.reason);
      work.signal?.addEventListener('abort', work.abortListener, { once: true });
      this.queues[priority].values.push(work);
      this.queuedByPriority[priority]++;
      if (work.ownerId) {
        let group = this.owned.get(work.ownerId);
        if (!group) { group = new Set(); this.owned.set(work.ownerId, group); }
        group.add(work);
      }
    });
    this.ensureWakeup();
    return promise;
  }

  /**
   * Execute queued synchronous work until the time budget is consumed. Every lane is budgeted
   * except the explicit must-run-now lane, reserved for correctness work that cannot wait a frame.
   */
  pump(budgetMs = 1.5): number {
    const budget = Math.max(0.1, Math.min(8, budgetMs));
    const started = performance.now();
    let ran = 0;

    while (true) {
      const elapsed = performance.now() - started;
      const next = this.peekNext();
      if (!next) break;
      if (ran > 0 && elapsed + next.estimatedMs > budget && next.priority !== 'must-run-now') break;
      const work = this.takeNext(next.priority)!;
      const workStarted = performance.now();
      work.state = 'active';
      try {
        work.resolve(work.run());
        this.completed++;
      } catch (error) {
        this.failed++;
        work.reject(error);
      }
      this.settle(work);
      recordRuntimeAttribution('scheduler', work.label, performance.now() - workStarted);
      ran++;
      if (performance.now() - started >= budget && this.queuedByPriority['must-run-now'] === 0) break;
    }

    this.lastPumpMs = performance.now() - started;
    const overrun = Math.max(0, this.lastPumpMs - budget);
    if (overrun > 0) { this.budgetOverrunPumps++; this.maxBudgetOverrunMs = Math.max(this.maxBudgetOverrunMs, overrun); }
    this.totalPumpMs += this.lastPumpMs;
    if (this.peekNext()) this.ensureWakeup();
    return ran;
  }

  clear(reason = new Error('runtime work queue cleared')): void {
    for (const priority of PRIORITY_ORDER) {
      const lane = this.queues[priority];
      for (let index = lane.head; index < lane.values.length; index++) this.cancel(lane.values[index], reason);
      lane.values.length = 0;
      lane.head = 0;
    }
  }

  /** Cancel all queued work owned by a world/tile/session without scanning unrelated lanes. */
  cancelOwner(ownerId: string, reason = new DOMException('runtime work owner released', 'AbortError')): number {
    const group = this.owned.get(ownerId);
    if (!group) return 0;
    let count = 0;
    for (const work of Array.from(group)) if (this.cancel(work, reason)) count++;
    return count;
  }

  stats(): RuntimeWorkStats {
    const critical = this.queuedByPriority.critical;
    const mustRunNow = this.queuedByPriority['must-run-now'];
    const normal = this.queuedByPriority.normal;
    const background = this.queuedByPriority.background;
    return {
      queued: mustRunNow + critical + normal + background,
      mustRunNow,
      critical,
      normal,
      background,
      completed: this.completed,
      failed: this.failed,
      hiddenWakeups: this.hiddenWakeups,
      lastPumpMs: this.lastPumpMs,
      totalPumpMs: this.totalPumpMs,
      budgetOverrunPumps: this.budgetOverrunPumps,
      maxBudgetOverrunMs: this.maxBudgetOverrunMs,
      cancelled: this.cancelled,
    };
  }

  private ensureWakeup(): void {
    // The renderer-owned animation loop pumps queued work once per frame. Scheduling a second RAF
    // while visible doubled the hydration allowance during gameplay and defeated the transition
    // budget. Hidden tabs receive no RAF, so required loading work gets one bounded timer wakeup.
    const hidden = this.wakeupEnvironment.isHidden();
    if ((this.animationLoopActive && !hidden) || this.wakeupScheduled || !this.peekNext()) return;
    this.wakeupScheduled = true;
    const wake = () => {
      this.wakeupScheduled = false;
      if (hidden) this.hiddenWakeups++;
      this.pump(8);
    };
    if (hidden) this.wakeupEnvironment.requestTimer(wake);
    else this.wakeupEnvironment.requestFrame(wake);
  }

  private peekNext(): QueuedWork | undefined {
    for (const priority of PRIORITY_ORDER) {
      const item = this.peekLane(priority);
      if (item) return item;
    }
    return undefined;
  }

  private peekLane(priority: RuntimeWorkPriority): QueuedWork | undefined {
    const lane = this.queues[priority];
    while (lane.head < lane.values.length && lane.values[lane.head].state !== 'queued') lane.head++;
    if (lane.head >= lane.values.length) { lane.values.length = 0; lane.head = 0; return undefined; }
    return lane.values[lane.head];
  }

  private takeNext(priority: RuntimeWorkPriority): QueuedWork | undefined {
    const work = this.peekLane(priority);
    if (!work) return undefined;
    const lane = this.queues[priority];
    lane.head++;
    this.queuedByPriority[priority]--;
    if (lane.head >= 1024 && lane.head * 2 >= lane.values.length) {
      lane.values.splice(0, lane.head);
      lane.head = 0;
    }
    return work;
  }

  private cancel(work: QueuedWork, reason?: unknown): boolean {
    if (work.state !== 'queued') return false;
    work.state = 'settled';
    this.queuedByPriority[work.priority]--;
    this.cancelled++;
    work.reject(reason ?? new DOMException('runtime work aborted', 'AbortError'));
    this.releaseOwnership(work);
    return true;
  }

  private settle(work: QueuedWork): void {
    work.state = 'settled';
    this.releaseOwnership(work);
  }

  private releaseOwnership(work: QueuedWork): void {
    if (work.abortListener) work.signal?.removeEventListener('abort', work.abortListener);
    if (!work.ownerId) return;
    const group = this.owned.get(work.ownerId);
    group?.delete(work);
    if (group?.size === 0) this.owned.delete(work.ownerId);
  }
}

export const runtimeWorkScheduler = new RuntimeWorkScheduler();
