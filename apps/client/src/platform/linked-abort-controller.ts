/** Child lifetime that aborts with its parent and can also be cancelled independently. */
export const linkedAbortController = (parent: AbortSignal) => {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent(); else parent.addEventListener('abort', abortFromParent, { once: true });
  return {
    controller,
    dispose: () => parent.removeEventListener('abort', abortFromParent),
  };
};
