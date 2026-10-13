import { TileAssetError } from './tile-load-state';

export type TileCoreFiles = {
  meta: any;
  heights: ArrayBuffer;
  holes: ArrayBuffer | null;
  innerHeights: ArrayBuffer | null;
  normals: ArrayBuffer | null;
  wmoData: any | null;
};

const requiredArrayBuffer = async (url: string, fetcher: typeof fetch) => {
  const started = performance.now();
  const response = await fetcher(url);
  if (!response.ok) throw new TileAssetError(response.status, url);
  const buffer = await response.arrayBuffer();
  recordRuntimeAttribution('asset-fetch', url, performance.now() - started, buffer.byteLength);
  return buffer;
};

const optionalArrayBuffer = async (url: string, fetcher: typeof fetch) => {
  const started = performance.now();
  const response = await fetcher(url);
  // A real 404 and Vite's HTML SPA fallback are the two explicit development-time absence forms.
  if (response.status === 404 || response.headers.get('content-type')?.includes('text/html')) return null;
  if (!response.ok) throw new Error(`optional tile asset failed: ${response.status} ${url}`);
  const buffer = await response.arrayBuffer();
  recordRuntimeAttribution('asset-fetch', url, performance.now() - started, buffer.byteLength);
  return buffer;
};
/** Asset conversion utility. */
export async function loadTileCoreFiles(
  base: string,
  loadWmo: () => Promise<any | null>,
  fetcher: typeof fetch = fetch,
): Promise<TileCoreFiles> {
  const loadWmoWithLegacyFallback = async () => {
    const binary = await loadWmo();
    if (binary) return binary;
    const response = await fetcher(`${base}/wmos.json`);
    if (response.status === 404 || response.headers.get('content-type')?.includes('text/html')) return null;
    if (!response.ok) throw new Error(`optional tile asset failed: ${response.status} ${base}/wmos.json`);
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new Error(`${base}/wmos.json returned ${response.headers.get('content-type') ?? 'no content type'}`);
    }
    return await response.json();
  };

  const [metaResponse, heights, holes, innerHeights, normals, wmoData] = await Promise.all([
    fetcher(`${base}/meta.json`),
    requiredArrayBuffer(`${base}/heights.f32`, fetcher),
    optionalArrayBuffer(`${base}/holes.bin`, fetcher),
    optionalArrayBuffer(`${base}/heights_inner.f32`, fetcher),
    optionalArrayBuffer(`${base}/normals.f32`, fetcher),
    loadWmoWithLegacyFallback(),
  ]);
  if (!metaResponse.ok) throw new TileAssetError(metaResponse.status, `${base}/meta.json`);
  const metaText = await metaResponse.text();
  const meta = measureRuntimeAttribution('json-parse', `${base}/meta.json`, () => JSON.parse(metaText), metaText.length);
  return { meta, heights, holes, innerHeights, normals, wmoData };
}
import { measureRuntimeAttribution, recordRuntimeAttribution } from '../platform/runtime-attribution';
