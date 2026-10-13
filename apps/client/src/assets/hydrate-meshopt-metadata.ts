/** Copy JSON metadata once; only compressed streams allocate asynchronous work. */
export async function hydrateMeshoptMetadata<T>(
  source: unknown,
  isStream: (value: unknown) => value is T,
  decode: (stream: T) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const pending: Promise<void>[] = [];
  const root: Record<string, unknown> = {};
  const checkAbort = () => { if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError'); };
  const assign = (target: Record<string, unknown> | unknown[], key: string | number, value: unknown) => {
    // JSON can contain an own __proto__ property; preserve it as data.
    if (key === '__proto__') Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
    else (target as unknown as Record<string | number, unknown>)[key] = value;
  };
  function copy(value: unknown, target: Record<string, unknown> | unknown[], key: string | number): void {
    checkAbort();
    if (isStream(value)) {
      pending.push(decode(value).then(decoded => { checkAbort(); assign(target, key, decoded); }));
    } else if (Array.isArray(value)) {
      const out = new Array(value.length); assign(target, key, out);
      for (let i = 0; i < value.length; i++) copy(value[i], out, i);
    } else if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}; assign(target, key, out);
      for (const name of Object.keys(value)) copy((value as Record<string, unknown>)[name], out, name);
    } else assign(target, key, value);
  }
  // Observe already-started decoders even if traversal or another decoder throws synchronously.
  try { copy(source, root, 'value'); } catch (error) {
    void Promise.allSettled(pending); throw error;
  }
  await Promise.all(pending); checkAbort(); return root.value;
}
