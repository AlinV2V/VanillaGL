import { MESHOPT_DECODER_VERSION, validateMeshoptCodec, meshoptFallbackReason, type MeshoptCodecProvenance } from './meshopt-codec-contract';
import { hydrateMeshoptMetadata } from './hydrate-meshopt-metadata';
import { MeshoptDecoder as ImportedMeshoptDecoder } from 'meshoptimizer';
import { runtimeWorkScheduler } from '../platform/runtime-work-scheduler';
import { beginCpuScope, CpuScopeId, endCpuScope } from '../rendering/performance-cpu-scopes';

export type MeshoptComponent = 'f32' | 'u32' | 'u16' | 'u8';
export type MeshoptMode = 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES';

export type MeshoptStreamRef = {
  $vgl: 'meshopt';
  codecVersion?: number;
  offset: number;
  byteLength: number;
  count: number;
  stride: number;
  components: number;
  component: MeshoptComponent;
  mode: MeshoptMode;
  filter?: 'OCTAHEDRAL' | 'QUATERNION' | 'EXPONENTIAL' | 'COLOR';
  asArray?: boolean;
};

export type MeshoptAssetEntry = {
  codec?: MeshoptCodecProvenance;
  meta: string;
  binary: string;
  sourceBytes?: number;
  optimizedBytes?: number;
  streams?: number;
  lods?: number;
};

type MeshoptManifest = {
  version?: number;
  generatedAt?: string;
  profile?: string;
  assets?: Record<string, MeshoptAssetEntry>;
};

type MeshoptDecoderApi = {
  ready: Promise<unknown>;
  useWorkers?: (count: number) => void;
  decodeGltfBufferAsync: (
    count: number,
    size: number,
    source: Uint8Array,
    mode: MeshoptMode,
    filter?: MeshoptStreamRef['filter'],
  ) => Promise<Uint8Array>;
};

type SidecarPayload = { meta: unknown; binary: Uint8Array };
type CachedSidecar = { promise: Promise<SidecarPayload>; estimatedBytes: number };

const MANIFEST_URL = '/data/meshopt-assets.json';
const MAX_PAYLOAD_CACHE_BYTES = 128 * 1024 * 1024;
const decoder = ImportedMeshoptDecoder as unknown as MeshoptDecoderApi;
let assets: Record<string, MeshoptAssetEntry> = {};
let initialized: Promise<void> | null = null;
let fetchPatched = false;
let routedFetch: typeof fetch | null = null;
const payloadCache = new Map<string, CachedSidecar>();
let payloadCacheBytes = 0;
let payloadCacheEvictions = 0;
let routedJsonRequests = 0;
let decodedStreams = 0;
let decodedBytes = 0;
let sourceFallbacks = 0;
const fallbackReasons: Record<string, number> = {};
const fallbackExamples: Array<{ source: string; reason: string }> = [];

const workerCount = () => {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
};

function sameOriginPath(value: string): string | null {
  if (!value || /^(?:data|blob):/i.test(value)) return null;
  try {
    const base = typeof location !== 'undefined' ? location.href : 'http://localhost/';
    const url = new URL(value, base);
    if (typeof location !== 'undefined' && url.origin !== location.origin) return null;
    return url.pathname;
  } catch {
    return null;
  }
}

function componentWidth(type: MeshoptComponent): number {
  if (type === 'u8') return 1;
  if (type === 'u16') return 2;
  return 4;
}

function unpackComponents(ref: MeshoptStreamRef, decoded: Uint8Array): Float32Array | Uint32Array | Uint16Array | Uint8Array | number[] {
  const width = componentWidth(ref.component);
  const packedStride = ref.components * width;
  const count = ref.count * ref.components;
  let result: Float32Array | Uint32Array | Uint16Array | Uint8Array;

  if (packedStride === ref.stride) {
    const buffer = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength);
    if (ref.component === 'f32') result = new Float32Array(buffer, 0, count);
    else if (ref.component === 'u32') result = new Uint32Array(buffer, 0, count);
    else if (ref.component === 'u16') result = new Uint16Array(buffer, 0, count);
    else result = new Uint8Array(buffer, 0, count);
  } else {
    const compact = new Uint8Array(ref.count * packedStride);
    for (let element = 0; element < ref.count; element++) {
      compact.set(decoded.subarray(element * ref.stride, element * ref.stride + packedStride), element * packedStride);
    }
    if (ref.component === 'f32') result = new Float32Array(compact.buffer);
    else if (ref.component === 'u32') result = new Uint32Array(compact.buffer);
    else if (ref.component === 'u16') result = new Uint16Array(compact.buffer);
    else result = compact;
  }

  return ref.asArray ? Array.from(result) : result;
}

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Meshopt hydration aborted', 'AbortError');
};

async function decodeStream(ref: MeshoptStreamRef, binary: Uint8Array, signal?: AbortSignal) {
  throwIfAborted(signal);
  if (!Number.isInteger(ref.offset) || !Number.isInteger(ref.byteLength) || ref.offset < 0 || ref.byteLength < 0) {
    throw new Error('malformed Meshopt stream reference');
  }
  if (ref.offset + ref.byteLength > binary.byteLength) throw new Error('Meshopt stream outside binary sidecar');
  const source = binary.subarray(ref.offset, ref.offset + ref.byteLength);
  validateMeshoptCodec(ref.mode, source, ref.codecVersion);
  const decoded = await decoder.decodeGltfBufferAsync(ref.count, ref.stride, source, ref.mode, ref.filter);
  throwIfAborted(signal);
  decodedStreams++;
  decodedBytes += decoded.byteLength;
  return runtimeWorkScheduler.schedule(
    `meshopt:${ref.mode}:${ref.count}`,
    () => { throwIfAborted(signal); const cpuScope = beginCpuScope(CpuScopeId.AssetDecodeUpload); try { return unpackComponents(ref, decoded); } finally { endCpuScope(cpuScope); } },
    {
      priority: 'normal',
      estimatedMs: Math.max(0.05, Math.min(2, decoded.byteLength / 2_000_000)),
      signal,
    },
  );
}

function isStreamRef(value: unknown): value is MeshoptStreamRef {
  return !!value && typeof value === 'object' && (value as MeshoptStreamRef).$vgl === 'meshopt';
}

function payloadFor(path: string, entry: MeshoptAssetEntry): Promise<SidecarPayload> {
  const cached = payloadCache.get(path);
  if (cached) {
    // Refresh insertion order so exploration evicts the least recently requested sidecar.
    payloadCache.delete(path);
    payloadCache.set(path, cached);
    return cached.promise;
  }
  const fetcher = routedFetch ?? globalThis.fetch.bind(globalThis);
  const promise = Promise.all([
    fetcher(entry.meta, { cache: 'force-cache' }),
    fetcher(entry.binary, { cache: 'force-cache' }),
  ]).then(async ([metaResponse, binaryResponse]) => {
    if (!metaResponse.ok || !binaryResponse.ok) throw new Error(`Meshopt sidecar unavailable for ${path}`);
    return {
      meta: await metaResponse.json(),
      binary: new Uint8Array(await binaryResponse.arrayBuffer()),
    };
  });
  const record: CachedSidecar = {
    promise,
    estimatedBytes: Math.max(0, Number(entry.optimizedBytes ?? 0)),
  };
  payloadCache.set(path, record);
  payloadCacheBytes += record.estimatedBytes;
  while (payloadCacheBytes > MAX_PAYLOAD_CACHE_BYTES && payloadCache.size > 1) {
    const oldestPath = payloadCache.keys().next().value as string | undefined;
    if (!oldestPath) break;
    const oldest = payloadCache.get(oldestPath);
    payloadCache.delete(oldestPath);
    payloadCacheBytes = Math.max(0, payloadCacheBytes - (oldest?.estimatedBytes ?? 0));
    payloadCacheEvictions++;
  }
  promise.catch(() => {
    if (payloadCache.get(path) !== record) return;
    payloadCache.delete(path);
    payloadCacheBytes = Math.max(0, payloadCacheBytes - record.estimatedBytes);
  });
  return promise;
}

function meshoptResponse(
  sourcePath: string,
  entry: MeshoptAssetEntry,
  sidecarResponse: Response,
  fetchSource: () => Promise<Response>,
  signal?: AbortSignal,
): Response {
  const decodeSidecar = async () => {
    throwIfAborted(signal);
    const payload = await payloadFor(sourcePath, entry);
    throwIfAborted(signal);
    return hydrateMeshoptMetadata(payload.meta, isStreamRef, ref => decodeStream(ref, payload.binary, signal), signal);
  };
  const sourceResponse = async (error: unknown) => {
    sourceFallbacks++;
    const reason = meshoptFallbackReason(error); fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1;
    if (fallbackExamples.length < 8) fallbackExamples.push({ source: sourcePath, reason });
    const response = await fetchSource();
    if (!response.ok) throw new Error(`Meshopt fallback source unavailable for ${sourcePath}: HTTP ${response.status}`);
    return response;
  };
  const decodeJson = async () => {
    try { return await decodeSidecar(); }
    catch (error) { throwIfAborted(signal); return (await sourceResponse(error)).json(); }
  };
  const decodeText = async () => {
    try { return JSON.stringify(await decodeSidecar()); }
    catch (error) { throwIfAborted(signal); return (await sourceResponse(error)).text(); }
  };
  const decodeArrayBuffer = async () => {
    try { return new TextEncoder().encode(JSON.stringify(await decodeSidecar())).buffer; }
    catch (error) { throwIfAborted(signal); return (await sourceResponse(error)).arrayBuffer(); }
  };
  const decodeBlob = async () => {
    try { return new Blob([JSON.stringify(await decodeSidecar())], { type: 'application/json' }); }
    catch (error) { throwIfAborted(signal); return (await sourceResponse(error)).blob(); }
  };

  return new Proxy(sidecarResponse, {
    get(target, property) {
      if (property === 'json') return decodeJson;
      if (property === 'text') return decodeText;
      if (property === 'arrayBuffer') return decodeArrayBuffer;
      if (property === 'blob') return decodeBlob;
      if (property === 'clone') return () => meshoptResponse(sourcePath, entry, target.clone(), fetchSource, signal);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function installFetchRouting(): void {
  if (fetchPatched || !routedFetch) return;
  fetchPatched = true;
  const baseFetch = routedFetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const signal = init?.signal ?? request?.signal ?? undefined;
    const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') return baseFetch(input, init);
    const raw = request?.url ?? String(input);
    const path = sameOriginPath(raw);
    const entry = path ? assets[path] : undefined;
    if (!path || !entry) return baseFetch(input, init);

    try {
      const probe = await baseFetch(entry.meta, { cache: 'force-cache', signal });
      if (!probe.ok) return baseFetch(input, init);
      routedJsonRequests++;
      return meshoptResponse(path, entry, probe, () => baseFetch(input, init), signal);
    } catch {
      return baseFetch(input, init);
    }
  }) as typeof fetch;
}

/**
 * Install transparent logical JSON -> Meshopt sidecar routing. Existing model loaders keep
 * requesting their normal `.json` URL; only assets present in the generated manifest are rerouted.
 */
export function initializeMeshoptRuntime(): Promise<void> {
  if (!initialized) {
    routedFetch = globalThis.fetch.bind(globalThis);
    initialized = Promise.all([
      decoder.ready,
      routedFetch(MANIFEST_URL, { cache: 'no-cache' })
        .then(async (response) => response.ok ? await response.json() as MeshoptManifest : { assets: {} })
        .catch(() => ({ assets: {} } as MeshoptManifest)),
    ]).then(([, manifest]) => {
      assets = manifest.assets ?? {};
      if (Object.keys(assets).length && decoder.useWorkers) decoder.useWorkers(workerCount());
      installFetchRouting();
    });
  }
  return initialized;
}

export function meshoptRuntimeDiagnostics() {
  return {
    mappedAssets: Object.keys(assets).length,
    cachedSidecars: payloadCache.size,
    cachedSidecarBytes: payloadCacheBytes,
    sidecarCacheLimitBytes: MAX_PAYLOAD_CACHE_BYTES,
    sidecarCacheEvictions: payloadCacheEvictions,
    routedJsonRequests,
    decodedStreams,
    decodedBytes,
    sourceFallbacks,
    decoderVersion: MESHOPT_DECODER_VERSION, fallbackReasons: { ...fallbackReasons }, fallbackExamples: fallbackExamples.slice(),
    workerCount: workerCount(),
  };
}
