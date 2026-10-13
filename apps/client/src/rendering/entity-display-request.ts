import { UnbakedCreatureDisplayError } from './asset-load-failure';

type FetchDisplay = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Keep permanent bake absence distinct from transient delivery failures. */
export async function requestCreatureDisplayJson<T>(
  displayId: number,
  signal?: AbortSignal,
  fetchDisplay: FetchDisplay = fetch,
): Promise<T> {
  const response = await fetchDisplay(`/creatures/display/${displayId}.json`, { signal });
  if (response.status === 404 || response.status === 410) {
    throw new UnbakedCreatureDisplayError(`creature display ${displayId} HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(`creature display ${displayId} HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
