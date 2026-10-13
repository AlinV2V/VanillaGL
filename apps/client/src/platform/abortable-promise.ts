const abortReason = (signal: AbortSignal, message: string) =>
  signal.reason ?? new DOMException(message, 'AbortError');

/** Stop one consumer waiting for shared work without cancelling the shared producer. */
export function awaitAbortable<T>(promise: Promise<T>, signal?: AbortSignal, message = 'operation aborted'): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal, message));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(abortReason(signal, message)); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}
