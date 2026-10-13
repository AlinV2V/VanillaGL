/** Load locally generated runtime metadata from the ignored public/data directory. */
export async function loadRuntimeData<T>(name: string, fallback: T): Promise<T> {
  if (!/^[a-z0-9-]+$/i.test(name)) throw new Error(`invalid runtime data name: ${name}`);
  try {
    const response = await fetch(`/data/${name}.json`, { cache: 'no-cache' });
    if (!response.ok) return fallback;
    return await response.json() as T;
  } catch {
    return fallback;
  }
}
