import { ensureContentHashScope, versionedAssetUrlSync } from './content-delivery';

export type TextureUsage = 'color' | 'normal' | 'alpha' | 'ui' | 'data';
export type TextureAsset = {
  usage?: TextureUsage;
  colorSpace?: 'srgb' | 'linear';
  variants?: { ktx2?: string; webp?: string; source?: string };
};
export type TextureAssetRegistry = {
  version?: number;
  assets?: Record<string, TextureAsset>;
};

type CatalogShard = { url: string; entries?: number; bytes?: number };
type CatalogIndex = { version?: number; shards?: Record<string, CatalogShard> };

const CATALOG_INDEX_URL = '/data/catalogs/texture-assets/index.json';
const LEGACY_REGISTRY_URL = '/data/texture-assets.json';
const BOOTSTRAP_SCOPES = ['login'] as const;
let assets: Record<string, TextureAsset> = {};
let shards: Record<string, CatalogShard> = {};
let initPromise: Promise<void> | null = null;
let domInstalled = false;
let observer: MutationObserver | null = null;
let catalogMode: 'sharded' | 'legacy' | 'unavailable' = 'unavailable';
let parsedCatalogBytes = 0;
const loadedScopes = new Set<string>();
const scopePromises = new Map<string, Promise<void>>();
const scopeFailures = new Map<string, { attempts: number; retryAt: number; error: Error }>();

type ParsedLogicalUrl = {
  logicalPath: string;
  search: string;
  hash: string;
  sameOrigin: boolean;
};

function parseLogicalUrl(value: string): ParsedLogicalUrl | null {
  if (!value || /^(?:data|blob):/i.test(value)) return null;
  try {
    const base = typeof location !== 'undefined' ? location.href : 'http://localhost/';
    const parsed = new URL(value, base);
    const origin = typeof location !== 'undefined' ? location.origin : parsed.origin;
    return {
      logicalPath: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
      sameOrigin: parsed.origin === origin,
    };
  } catch {
    const [beforeHash, hash = ''] = value.split('#', 2);
    const [path, search = ''] = beforeHash.split('?', 2);
    return {
      logicalPath: path.startsWith('/') ? path : `/${path}`,
      search: search ? `?${search}` : '',
      hash: hash ? `#${hash}` : '',
      sameOrigin: true,
    };
  }
}

function scopeForPath(path: string): string {
  const relative = path.replace(/^\/+/, '');
  return relative.includes('/') ? relative.split('/', 1)[0]!.toLowerCase() : 'root';
}

async function readJson<T>(url: string, cache: RequestCache): Promise<T> {
  const response = await fetch(url, { cache });
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
    pending = readJson<TextureAssetRegistry>(descriptor.url, 'force-cache')
      .then((registry) => {
        Object.assign(assets, registry.assets ?? {});
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

/** Ensure the path's registry shard and immutable-hash shard are ready before network routing. */
export async function ensureTextureAssetScope(value: string): Promise<void> {
  await initializeAssetUrlResolver();
  const parsed = parseLogicalUrl(value);
  if (!parsed?.sameOrigin) return;
  await Promise.all([
    loadScope(scopeForPath(parsed.logicalPath)),
    ensureContentHashScope(value),
  ]);
}

function physicalVariant(value: string, variant: 'webp' | 'ktx2'): string | null {
  const parsed = parseLogicalUrl(value);
  if (!parsed?.sameOrigin) return null;
  const mapped = assets[parsed.logicalPath]?.variants?.[variant];
  return mapped ? `${mapped}${parsed.search}${parsed.hash}` : null;
}

/** Keep source-code URLs logical; DOM/Canvas callers resolve to WebP + immutable digest when baked. */
export function resolveUiAssetUrlSync(value: string): string {
  return versionedAssetUrlSync(physicalVariant(value, 'webp') ?? value);
}

/** Resolve a browser-decodable fallback only when the registry promises one physically exists. */
export function resolveTextureFallbackUrlSync(value: string): string | null {
  const parsed = parseLogicalUrl(value);
  if (!parsed || !parsed.sameOrigin) return versionedAssetUrlSync(value);
  const asset = assets[parsed.logicalPath];
  if (!asset) return versionedAssetUrlSync(value);
  const fallback = asset.variants?.webp ?? asset.variants?.source;
  return fallback ? versionedAssetUrlSync(`${fallback}${parsed.search}${parsed.hash}`) : null;
}

/** GPU callers use this only after KTX2 support has been detected for the renderer. */
export function resolveGpuAssetUrlSync(value: string): string | null {
  const mapped = physicalVariant(value, 'ktx2');
  return mapped ? versionedAssetUrlSync(mapped) : null;
}

export function getTextureAssetSync(value: string): TextureAsset | undefined {
  const parsed = parseLogicalUrl(value);
  return parsed?.sameOrigin ? assets[parsed.logicalPath] : undefined;
}

function rewriteSrcset(value: string): string {
  return value.split(',').map((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return trimmed;
    const firstSpace = trimmed.search(/\s/);
    const url = firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace);
    const descriptor = firstSpace < 0 ? '' : trimmed.slice(firstSpace);
    return `${resolveUiAssetUrlSync(url)}${descriptor}`;
  }).join(', ');
}

function rewriteCssUrls(value: string): string {
  return value.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, (match, quote: string, url: string) => {
    const source = url.trim();
    const mapped = resolveUiAssetUrlSync(source);
    return mapped === source ? match : `url(${quote}${mapped}${quote})`;
  });
}

function rewriteStyle(style: CSSStyleDeclaration): void {
  for (let i = 0; i < style.length; i++) {
    const property = style.item(i);
    const value = style.getPropertyValue(property);
    if (!value || !/url\(/i.test(value)) continue;
    const mapped = rewriteCssUrls(value);
    if (mapped !== value) style.setProperty(property, mapped, style.getPropertyPriority(property));
  }
}

function rewriteRuleList(rules: CSSRuleList): void {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) rewriteStyle(rule.style);
    const nested = (rule as CSSGroupingRule).cssRules;
    if (nested) rewriteRuleList(nested);
    if (rule instanceof CSSImportRule && rule.styleSheet) {
      try { rewriteRuleList(rule.styleSheet.cssRules); } catch { /* cross-origin styles are intentionally untouched */ }
    }
  }
}

function rewriteStylesheets(): void {
  if (typeof document === 'undefined') return;
  for (const sheet of Array.from(document.styleSheets)) {
    try { rewriteRuleList(sheet.cssRules); } catch { /* same-origin runtime assets only */ }
  }
}

function rewriteElement(element: Element): void {
  if (element instanceof HTMLImageElement) {
    const src = element.getAttribute('src');
    if (src) {
      const mapped = resolveUiAssetUrlSync(src);
      if (mapped !== src) element.setAttribute('src', mapped);
    }
    const srcset = element.getAttribute('srcset');
    if (srcset) {
      const mapped = rewriteSrcset(srcset);
      if (mapped !== srcset) element.setAttribute('srcset', mapped);
    }
  } else if (typeof HTMLSourceElement !== 'undefined' && element instanceof HTMLSourceElement) {
    const srcset = element.getAttribute('srcset');
    if (srcset) {
      const mapped = rewriteSrcset(srcset);
      if (mapped !== srcset) element.setAttribute('srcset', mapped);
    }
  } else if (typeof HTMLVideoElement !== 'undefined' && element instanceof HTMLVideoElement) {
    const poster = element.getAttribute('poster');
    if (poster) {
      const mapped = resolveUiAssetUrlSync(poster);
      if (mapped !== poster) element.setAttribute('poster', mapped);
    }
  }
  if (element instanceof HTMLElement && element.style.length) rewriteStyle(element.style);
  for (const child of Array.from(element.children)) rewriteElement(child);
}

function patchImageProperty(property: 'src' | 'srcset'): void {
  if (typeof HTMLImageElement === 'undefined') return;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, property);
  if (!descriptor?.set || !descriptor.get || descriptor.configurable === false) return;
  try {
    Object.defineProperty(HTMLImageElement.prototype, property, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value: string) {
        descriptor.set!.call(this, property === 'srcset' ? rewriteSrcset(String(value)) : resolveUiAssetUrlSync(String(value)));
      },
    });
  } catch {
    // The MutationObserver below still catches attribute-based image writes.
  }
}

function installDomResolver(): void {
  if (domInstalled || typeof document === 'undefined') return;
  domInstalled = true;
  patchImageProperty('src');
  patchImageProperty('srcset');

  rewriteElement(document.documentElement);
  rewriteStylesheets();

  observer = new MutationObserver((mutations) => {
    let stylesMayHaveChanged = false;
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.target instanceof Element) rewriteElement(mutation.target);
      for (const node of Array.from(mutation.addedNodes)) {
        if (node instanceof Element) {
          rewriteElement(node);
          if (node instanceof HTMLStyleElement || node instanceof HTMLLinkElement) stylesMayHaveChanged = true;
        }
      }
    }
    if (stylesMayHaveChanged) queueMicrotask(rewriteStylesheets);
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'poster', 'style'],
  });

  // Vite can inject stylesheet rules after the module graph starts evaluating.
  requestAnimationFrame(rewriteStylesheets);
}

/**
 * Load the logical->physical asset registry before UI/world construction begins.
 * Missing manifests are a supported development state: every logical source URL keeps working.
 */
export function initializeAssetUrlResolver(): Promise<void> {
  if (!initPromise) {
    initPromise = readJson<CatalogIndex>(CATALOG_INDEX_URL, 'no-cache')
      .then(async (index) => {
        shards = index.shards ?? {};
        catalogMode = 'sharded';
        await Promise.allSettled(BOOTSTRAP_SCOPES.map((scope) => loadScope(scope)));
      })
      .catch(async () => {
        try {
          const registry = await readJson<TextureAssetRegistry>(LEGACY_REGISTRY_URL, 'force-cache');
          assets = registry.assets ?? {};
          catalogMode = 'legacy';
        } catch {
          assets = {};
          catalogMode = 'unavailable';
        }
      })
      .then(() => { installDomResolver(); });
  }
  return initPromise;
}

export function assetUrlResolverDiagnostics() {
  return {
    registeredAssets: Object.keys(assets).length,
    availableScopes: Object.keys(shards).length,
    loadedScopes: [...loadedScopes].sort(),
    failedScopes: [...scopeFailures].map(([scope, failure]) => ({ scope, attempts: failure.attempts, retryInMs: Math.max(0, failure.retryAt - performance.now()) })),
    parsedCatalogBytes,
    catalogMode,
  };
}

export function disposeAssetUrlResolver(): void {
  observer?.disconnect();
  observer = null;
  domInstalled = false;
  assets = {};
  shards = {};
  loadedScopes.clear();
  scopePromises.clear();
  scopeFailures.clear();
  parsedCatalogBytes = 0;
  catalogMode = 'unavailable';
  initPromise = null;
}
