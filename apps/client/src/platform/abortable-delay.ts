/** Resolve after the delay or immediately when the owning async generation is cancelled. */
export const abortableDelay = (delayMs: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener('abort', finish, { once: true });
  });
};
