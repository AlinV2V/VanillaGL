export type AssetRequestPriority = 'critical' | 'normal';

type QueuedAssetRequest<T = unknown> = {
  task: () => Promise<T>;
  priority: AssetRequestPriority;
  retriesRemaining: number;
  signal?: AbortSignal;
  ownerId?: string;
  deadlineAt?: number;
  state: 'queued' | 'active' | 'settled';
  abortListener?: () => void;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

export type AssetRequestOptions = {
  priority?: AssetRequestPriority;
  retries?: number;
  signal?: AbortSignal;
  ownerId?: string;
  deadlineMs?: number;
};

export type AssetRequestQueueStats = {
  limit: number;
  active: number;
  queued: number;
  criticalQueued: number;
  normalQueued: number;
  peakActive: number;
  completed: number;
  failed: number;
  retried: number;
  cancelledQueued: number;
  cancelledActive: number;
  staleCompletionsRejected: number;
};

const abortError = (message = 'asset request aborted') => new DOMException(message, 'AbortError');

/**
 * Bounds expensive asset downloads/decodes before they reach Chromium's network and worker pools.
 * A world-entry neighborhood can reference thousands of textures; letting every Promise.all start
 * immediately has produced net::ERR_INSUFFICIENT_RESOURCES on otherwise valid KTX2 and JSON files.
 */
export class AssetRequestQueue {
  private readonly queues: Record<AssetRequestPriority, QueuedAssetRequest[]> = {
    critical: [],
    normal: [],
  };
  private readonly queueHeads: Record<AssetRequestPriority, number> = { critical: 0, normal: 0 };
  private readonly queuedByPriority: Record<AssetRequestPriority, number> = { critical: 0, normal: 0 };
  private active = 0;
  private peakActive = 0;
  private completed = 0;
  private failed = 0;
  private retried = 0;
  private cancelledQueued = 0;
  private cancelledActive = 0;
  private staleCompletionsRejected = 0;

  constructor(readonly limit = 16) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`asset request limit must be a positive integer: ${limit}`);
  }

  run<T>(
    task: () => Promise<T>,
    options: AssetRequestOptions = {},
  ): Promise<T> {
    const priority = options.priority ?? 'normal';
    const retriesRemaining = Math.max(0, Math.min(3, options.retries ?? 0) | 0);
    const promise = new Promise<T>((resolve, reject) => {
      if (options.signal?.aborted) { reject(options.signal.reason ?? abortError()); return; }
      const request: QueuedAssetRequest = {
        task: task as () => Promise<unknown>,
        priority,
        retriesRemaining,
        signal: options.signal,
        ownerId: options.ownerId,
        deadlineAt: options.deadlineMs === undefined ? undefined : performance.now() + Math.max(0, options.deadlineMs),
        state: 'queued',
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      request.abortListener = () => this.cancel(request);
      request.signal?.addEventListener('abort', request.abortListener, { once: true });
      this.queues[priority].push(request);
      this.queuedByPriority[priority]++;
    });
    this.pump();
    return promise;
  }

  stats(): AssetRequestQueueStats {
    const criticalQueued = this.queuedByPriority.critical;
    const normalQueued = this.queuedByPriority.normal;
    return {
      limit: this.limit,
      active: this.active,
      queued: criticalQueued + normalQueued,
      criticalQueued,
      normalQueued,
      peakActive: this.peakActive,
      completed: this.completed,
      failed: this.failed,
      retried: this.retried,
      cancelledQueued: this.cancelledQueued,
      cancelledActive: this.cancelledActive,
      staleCompletionsRejected: this.staleCompletionsRejected,
    };
  }

  private cancel(request: QueuedAssetRequest): void {
    if (request.state === 'settled') return;
    if (request.state === 'active') { this.cancelledActive++; return; }
    request.state = 'settled';
    this.queuedByPriority[request.priority]--;
    this.cancelledQueued++;
    request.reject(request.signal?.reason ?? abortError());
    this.pump();
  }

  private settle(request: QueuedAssetRequest): void {
    request.state = 'settled';
    if (request.abortListener) request.signal?.removeEventListener('abort', request.abortListener);
  }

  private pump(): void {
    while (this.active < this.limit) {
      const request = this.take('critical') ?? this.take('normal');
      if (!request) return;
      if (request.state !== 'queued') continue;
      if (request.signal?.aborted || (request.deadlineAt !== undefined && performance.now() >= request.deadlineAt)) {
        this.settle(request);
        this.cancelledQueued++;
        request.reject(request.signal?.reason ?? abortError('asset request deadline exceeded'));
        continue;
      }
      request.state = 'active';
      this.active++;
      this.peakActive = Math.max(this.peakActive, this.active);
      void Promise.resolve()
        .then(request.task)
        .then((value) => {
          this.active--;
          if (request.signal?.aborted) {
            this.staleCompletionsRejected++;
            this.settle(request);
            request.reject(request.signal.reason ?? abortError());
            this.pump();
            return;
          }
          this.settle(request);
          this.completed++;
          this.pump();
          request.resolve(value);
        }, (error) => {
          this.active--;
          if (!request.signal?.aborted && request.retriesRemaining > 0) {
            request.retriesRemaining--;
            this.retried++;
            request.state = 'queued';
            this.queues[request.priority].push(request);
            this.queuedByPriority[request.priority]++;
          } else {
            this.settle(request);
            this.failed++;
            request.reject(request.signal?.reason ?? error);
          }
          this.pump();
      });
    }
  }

  private take(priority: AssetRequestPriority): QueuedAssetRequest | undefined {
    const queue = this.queues[priority];
    let head = this.queueHeads[priority];
    while (head < queue.length && queue[head].state !== 'queued') head++;
    if (head >= queue.length) {
      queue.length = 0;
      this.queueHeads[priority] = 0;
      return undefined;
    }
    const request = queue[head++];
    this.queueHeads[priority] = head;
    this.queuedByPriority[priority]--;
    if (head >= 1024 && head * 2 >= queue.length) {
      queue.splice(0, head);
      this.queueHeads[priority] = 0;
    }
    return request;
  }
}

export const assetRequestQueue = new AssetRequestQueue(16);
