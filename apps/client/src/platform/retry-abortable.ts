import { abortableDelay } from './abortable-delay';

export async function retryAbortable<T>(
  task: () => Promise<T>,
  options: {
    attempts?: number;
    delayMs?: number;
    signal?: AbortSignal;
    onRetry?: (error: unknown, nextAttempt: number) => void;
    shouldRetry?: (error: unknown) => boolean;
  } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('retry aborted', 'AbortError');
    try {
      return await task();
    } catch (error) {
      if (attempt >= attempts || options.signal?.aborted || options.shouldRetry?.(error) === false) throw error;
      options.onRetry?.(error, attempt + 1);
      await abortableDelay((options.delayMs ?? 500) * 2 ** (attempt - 1), options.signal);
    }
  }
}
