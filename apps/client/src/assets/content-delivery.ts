export type ContentHashEntry = {
  hash: string;
  bytes?: number;
};

export type ContentHashManifest = {
  version?: number;
  generatedAt?: string;
  assets?: Record<string, ContentHashEntry>;
};

type CatalogShard = { url: string; entries?: number; bytes?: number };
type CatalogIndex = { version?: number; shards?: Record<string, CatalogShard> };

const CATALOG_INDEX_URL = '/data/catalogs/content-hashes/index.json';
const LEGACY_MANIFEST_URL = '/data/content-hashes.json';
const CATALOG_PREFIX = '/data/catalogs/';
const nativeFetch = globalThis.fetch.bind(globalThis);
let entries: Record<string, ContentHashEntry> = {};
let shards: Record<string, CatalogShard> = {};
let initialized: Promise<void> | null = null;
let fetchPatched = false;
let rewrittenRequests = 0;
let parsedCatalogBytes = 0;
let catalogMode: 'sharded' | 'legacy' | 'unavailable' = 'unavailable';
const loadedScopes = new Set<string>();
const scopePromises = new Map<string, Promise<void>>();
const scopeFailures = new Map<string, { attempts: number; retryAt: number; error: Error }>();

function parseSameOrigin(value: string): URL | null {
  if (!value || /^(?:data|blob):/i.test(value)) return null;
  try {
    const base = typeof location !== 'undefined' ? location.href : 'http://localhost/';
    const url = new URL(value, base);
    if (typeof location !== 'undefined' && url.origin !== location.origin) return null;
    return url;
  } catch {
    return null;
  }
}

function sourceWasAbsolute(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//');
}

function scopeForUrl(url: URL): string {
  const relative = url.pathname.replace(/^\/+/, '');
  return relative.includes('/') ? relative.split('/', 1)[0]!.toLowerCase() : 'root';
}

async function readJson<T>(url: string, cache: RequestCache): Promise<T> {
  const response = await nativeFetch(url, { cache });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const text = await response.text();
  parsedCatalogBytes += new TextEncoder().encode(text).byteLength;
  return JSON.parse(text) as T;
}

function loadScope(scope: string): Promise<void> {
  if (catalogMode !== 'sharded' || loadedScopes.has(scope)) return Promise.resolve();
  const failure = scopeFailures.get(scope);
  if (failure && performance.now() < failure.retryAt) return Promise.reject(failure.error);
  const descriptor = shards[scope];
  if (!descriptor) {
    loadedScopes.add(scope);
    return Promise.resolve();
  }
  let pending = scopePromises.get(scope);
  if (!pending) {
    pending = readJson<ContentHashManifest>(descriptor.url, 'force-cache')
      .then((manifest) => {
        Object.assign(entries, manifest.assets ?? {});
        loadedScopes.add(scope);
        scopeFailures.delete(scope);
      })
      .catch((reason: unknown) => {
        const previous = scopeFailures.get(scope);
        const attempts = (previous?.attempts ?? 0) + 1;
        const error = reason instanceof Error ? reason : new Error(String(reason));
        scopeFailures.set(scope, { attempts, retryAt: performance.now() + Math.min(30_000, 500 * 2 ** Math.min(6, attempts - 1)), error });
        throw error;
      })
      .finally(() => scopePromises.delete(scope));
    scopePromises.set(scope, pending);
  }
  return pending;
}

export async function ensureContentHashScope(value: string): Promise<void> {
  await initializeContentDelivery();
  const url = parseSameOrigin(value);
  if (url) await loadScope(scopeForUrl(url));
}

/**
 * Append the content digest to a stable logical URL. The file name can remain
 * human-readable while the query string becomes an immutable cache identity.
 */
export function versionedAssetUrlSync(value: string): string {
  const url = parseSameOrigin(value);
  if (!url) return value;
  const entry = entries[url.pathname];
  if (!entry?.hash || url.searchParams.has('v')) return value;
  url.searchParams.set('v', entry.hash.slice(0, 16));
  if (sourceWasAbsolute(value)) return url.href;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function contentHashForPath(path: string): string | undefined {
  return entries[path]?.hash;
}

function installFetchRouting(): void {
  if (fetchPatched) return;
  fetchPatched = true;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return nativeFetch(input, init);

    const raw = request?.url ?? String(input);
    const parsed = parseSameOrigin(raw);
    if (!parsed || parsed.pathname.startsWith(CATALOG_PREFIX) || parsed.pathname === LEGACY_MANIFEST_URL || parsed.searchParams.has('nohash')) {
      return nativeFetch(input, init);
    }

    await loadScope(scopeForUrl(parsed));

    const versioned = versionedAssetUrlSync(raw);
    if (versioned === raw) return nativeFetch(input, init);
    rewrittenRequests++;

    if (request) {
      const nextRequest = new Request(versioned, request);
      return nativeFetch(nextRequest, init);
    }
    return nativeFetch(versioned, { cache: init?.cache ?? 'force-cache', ...init });
  }) as typeof fetch;
}

/** Load the generated digest manifest before the rest of the client starts fetching assets. */
export function initializeContentDelivery(): Promise<void> {
  if (!initialized) {
    initialized = readJson<CatalogIndex>(CATALOG_INDEX_URL, 'no-cache')
      .then((index) => {
        shards = index.shards ?? {};
        catalogMode = 'sharded';
      })
      .catch(async () => {
        try {
          const manifest = await readJson<ContentHashManifest>(LEGACY_MANIFEST_URL, 'no-cache');
          entries = manifest.assets ?? {};
          catalogMode = 'legacy';
        } catch {
          entries = {};
          catalogMode = 'unavailable';
        }
      })
      .then(() => installFetchRouting());
  }
  return initialized;
}

export function contentDeliveryDiagnostics() {
  return {
    hashedAssets: Object.keys(entries).length,
    availableScopes: Object.keys(shards).length,
    loadedScopes: [...loadedScopes].sort(),
    failedScopes: [...scopeFailures].map(([scope, failure]) => ({ scope, attempts: failure.attempts, retryInMs: Math.max(0, failure.retryAt - performance.now()) })),
    parsedCatalogBytes,
    catalogMode,
    rewrittenRequests,
    fetchPatched,
  };
}

export function getContentDeliveryBaseFetch(): typeof fetch {
  return nativeFetch;
}
