import * as THREE from 'three';
import type { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import {
  ensureTextureAssetScope,
  initializeAssetUrlResolver,
  resolveGpuAssetUrlSync,
  resolveTextureFallbackUrlSync,
  resolveUiAssetUrlSync,
} from '../assets/asset-url-resolver';
import { assetRequestQueue } from '../assets/asset-request-queue';
import {
  admitTextureUpload,
  configureTextureUploadAdmission,
  texturePayloadBytes,
} from './texture-upload-admission';

let ktx2: KTX2Loader | null = null;
let ktx2Ready: Promise<void> | null = null;
let textureLoaderPatched = false;
const originalTextureLoad = THREE.TextureLoader.prototype.load;
let compressedReady = 0;
let browserReady = 0;
let compressedFallbacks = 0;
let ktx2InitializationFailures = 0;
let adoptedBytes = 0;
let adoptionTotalMs = 0;
let adoptionMaxMs = 0;
const warnedCompressedFallbacks = new Set<string>();

type TextureLoad = THREE.TextureLoader['load'];
type MutableTexture = THREE.Texture & {
  isCompressedTexture?: boolean;
  internalFormat?: THREE.PixelFormatGPU | null;
};

/**
 * TextureLoader callers expect a synchronous texture object and frequently clone it while the
 * optimized payload is still loading. THREE.Texture.copy() intentionally does not copy subtype
 * flags, so a plain placeholder that later adopts compressed mipmaps becomes an ordinary texture
 * again when cloned. Three then sends the compressed mip objects through texSubImage2D.
 *
 * Keep the routed kind as explicit instance state and preserve it across Texture.clone()/copy().
 * This is deliberately not a CompressedTexture subclass: a failed KTX2 request may hydrate the
 * same stable object with a normal WebP/source image instead.
 */
class RoutedTexture extends THREE.Texture {
  isCompressedTexture = false;

  override copy(source: THREE.Texture): this {
    super.copy(source);
    this.isCompressedTexture = (source as MutableTexture).isCompressedTexture === true;
    return this;
  }
}

type TextureSettings = {
  wrapS: THREE.Wrapping;
  wrapT: THREE.Wrapping;
  magFilter: THREE.MagnificationTextureFilter;
  minFilter: THREE.MinificationTextureFilter;
  anisotropy: number;
  colorSpace: string;
  flipY: boolean;
  generateMipmaps: boolean;
  premultiplyAlpha: boolean;
  unpackAlignment: number;
};

function snapshotSettings(texture: THREE.Texture): TextureSettings {
  return {
    wrapS: texture.wrapS,
    wrapT: texture.wrapT,
    magFilter: texture.magFilter,
    minFilter: texture.minFilter,
    anisotropy: texture.anisotropy,
    colorSpace: texture.colorSpace,
    flipY: texture.flipY,
    generateMipmaps: texture.generateMipmaps,
    premultiplyAlpha: texture.premultiplyAlpha,
    unpackAlignment: texture.unpackAlignment,
  };
}

function adoptLoadedTexture(target: THREE.Texture, loaded: THREE.Texture, initial: TextureSettings, compressed: boolean): void {
  const started = performance.now();
  const payloadBytes = texturePayloadBytes(loaded);
  const mutable = target as MutableTexture;
  const source = loaded as MutableTexture;

  // Keep the object identity returned synchronously by TextureLoader.load(), but
  // replace its upload payload once KTX2/image decoding completes. Materials and
  // caches that already captured `target` therefore start using the optimized
  // representation without every legacy caller becoming async.
  target.image = loaded.image;
  target.mipmaps = loaded.mipmaps;
  target.format = loaded.format;
  target.type = loaded.type;
  mutable.internalFormat = source.internalFormat ?? null;
  mutable.isCompressedTexture = compressed;

  // KTX2Loader can choose format-specific defaults. Adopt those only when the
  // caller did not already configure the synchronous placeholder after load().
  const current = snapshotSettings(target);
  const takeLoaded = <K extends keyof TextureSettings>(key: K) => {
    if (current[key] === initial[key]) (target as unknown as Record<K, TextureSettings[K]>)[key] = snapshotSettings(loaded)[key];
  };
  takeLoaded('wrapS');
  takeLoaded('wrapT');
  takeLoaded('magFilter');
  takeLoaded('minFilter');
  takeLoaded('anisotropy');
  takeLoaded('colorSpace');
  takeLoaded('flipY');
  takeLoaded('generateMipmaps');
  takeLoaded('premultiplyAlpha');
  takeLoaded('unpackAlignment');

  // KTX2Loader returns compressed textures with an authored mip chain. WebGL cannot
  // generate mipmaps for compressed internal formats, so a caller-modified synchronous
  // placeholder must never carry generateMipmaps=true into the adopted KTX2 upload.
  if (compressed) {
    target.generateMipmaps = false;
  }

  target.needsUpdate = true;
  const elapsed = performance.now() - started;
  if (compressed) compressedReady++;
  else browserReady++;
  adoptedBytes += payloadBytes;
  adoptionTotalMs += elapsed;
  adoptionMaxMs = Math.max(adoptionMaxMs, elapsed);
}

export function optimizedTextureDiagnostics() {
  return {
    compressedReady,
    browserReady,
    compressedFallbacks,
    ktx2InitializationFailures,
    adoptedBytes,
    adoptionTotalMs: Number(adoptionTotalMs.toFixed(3)),
    adoptionMaxMs: Number(adoptionMaxMs.toFixed(3)),
    note: 'CPU payload adoption is followed by budgeted GPU admission before load completion.',
  };
}

function originalLoadAsync(loader: THREE.TextureLoader, url: string, onProgress?: (event: ProgressEvent) => void): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    originalTextureLoad.call(loader, url, resolve, onProgress, reject);
  });
}

function recordCompressedFallback(url: string, error: unknown): void {
  compressedFallbacks++;
  if (warnedCompressedFallbacks.has(url)) return;
  warnedCompressedFallbacks.add(url);
  console.warn(`KTX2 load failed for ${url}; using the browser-image fallback.`, error);
}

/**
 * Install one process-wide routing point for legacy TextureLoader users.
 * Existing game code may keep logical `.png` URLs: registered GPU assets go
 * through KTX2Loader, registered browser-image assets use WebP, and exact/data
 * textures stay on their source URL.
 */
function installTextureLoaderRouting(): void {
  if (textureLoaderPatched) return;
  textureLoaderPatched = true;

  THREE.TextureLoader.prototype.load = function routedTextureLoad(
    this: THREE.TextureLoader,
    url: string,
    onLoad?: (texture: THREE.Texture) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void,
  ): THREE.Texture {
    // Shards are loaded on first use, so return the same stable placeholder contract for
    // compressed and browser-image routes. Callers may configure or clone it immediately.
    const target = new RoutedTexture();
    const initial = snapshotSettings(target);

    const loadFallback = () => {
      const fallbackUrl = resolveTextureFallbackUrlSync(url);
      if (!fallbackUrl) {
        onError?.(new Error(`No browser-decodable fallback is registered for ${url}`));
        return;
      }
      void assetRequestQueue.run(() => originalLoadAsync(this, fallbackUrl, onProgress), { retries: 1 }).then((loaded) => {
        void admitTextureUpload(target, fallbackUrl, {
          payloadBytes: texturePayloadBytes(loaded),
          prepare: () => adoptLoadedTexture(target, loaded, initial, false),
        }).then(() => onLoad?.(target), (error) => onError?.(error));
      }, (error) => onError?.(error));
    };

    void ensureTextureAssetScope(url).then(async () => {
      const loader = ktx2;
      const compressedUrl = loader ? resolveGpuAssetUrlSync(url) : null;
      if (!loader || !compressedUrl) {
        loadFallback();
        return;
      }
      try {
        const loaded = await assetRequestQueue.run(
          () => loader.loadAsync(compressedUrl, onProgress),
          { retries: 1 },
        );
        await admitTextureUpload(target, compressedUrl, {
          payloadBytes: texturePayloadBytes(loaded),
          prepare: () => adoptLoadedTexture(target, loaded, initial, true),
        });
        onLoad?.(target);
      } catch (error) {
        recordCompressedFallback(url, error);
        loadFallback();
      }
    }, loadFallback);

    return target;
  } as TextureLoad;
}

export async function configureKtx2Support(renderer: THREE.WebGLRenderer, workerLimit = 2): Promise<void> {
  configureTextureUploadAdmission(renderer);
  if (ktx2) {
    installTextureLoaderRouting();
    return;
  }
  if (!ktx2Ready) {
    // KTX2Loader and Basis transcoder glue are a cold-path chunk. Keeping this
    // import dynamic removes them from the initial application bundle while the
    // renderer and login UI initialize.
    ktx2Ready = import('three/examples/jsm/loaders/KTX2Loader.js').then(({ KTX2Loader: Loader }) => {
      ktx2 = new Loader();
      ktx2.setTranscoderPath('/basis/');
      ktx2.setWorkerLimit(Math.max(1, Math.min(4, workerLimit | 0)));
      ktx2.detectSupport(renderer);
      installTextureLoaderRouting();
    }).catch((error) => {
      ktx2InitializationFailures++;
      console.warn('KTX2 support initialization failed; using browser-image texture variants.', error);
      ktx2?.dispose();
      ktx2 = null;
      // Even without KTX2 support, TextureLoader still benefits from registered
      // WebP variants for browser-decodable image assets.
      installTextureLoaderRouting();
    });
  }
  await ktx2Ready;
}

export async function loadOptimizedTexture(
  fallback: THREE.TextureLoader,
  url: string,
  options: { signal?: AbortSignal; ownerId?: string } = {},
): Promise<THREE.Texture> {
  // Direct unit/tool callers may reach here without the index.html bootstrap.
  await initializeAssetUrlResolver();
  await ensureTextureAssetScope(url);
  if (ktx2Ready) await ktx2Ready;

  const loader = ktx2;
  const mapped = loader ? resolveGpuAssetUrlSync(url) : null;
  if (loader && mapped) {
    try {
      const compressed = await assetRequestQueue.run(
        () => loader.loadAsync(mapped),
        { retries: 1, signal: options.signal, ownerId: options.ownerId },
      );
      if (options.signal?.aborted) { compressed.dispose(); throw options.signal.reason ?? new DOMException('texture load aborted', 'AbortError'); }
      compressed.generateMipmaps = false;
      return compressed;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('texture load aborted', 'AbortError');
      recordCompressedFallback(url, error);
      // Corrupt/unsupported KTX2 must never make the world disappear. Load the
      // browser image variant with the original TextureLoader implementation so
      // the global routing patch cannot recurse back into the failed KTX2.
    }
  }

  const fallbackUrl = resolveTextureFallbackUrlSync(url);
  if (!fallbackUrl) throw new Error(`No browser-decodable fallback is registered for ${url}`);
  const texture = await assetRequestQueue.run(
    () => originalLoadAsync(fallback, fallbackUrl),
    { retries: 1, signal: options.signal, ownerId: options.ownerId },
  );
  if (options.signal?.aborted) { texture.dispose(); throw options.signal.reason ?? new DOMException('texture load aborted', 'AbortError'); }
  return texture;
}

/** Dedicated array route: arrays must not be adopted into a regular two-dimensional Texture. */
export async function loadPortableTextureArray(url: string): Promise<THREE.CompressedArrayTexture> {
  await ktx2Ready;
  if (!ktx2) throw new Error('KTX2 transcoder is unavailable');
  const texture = await assetRequestQueue.run(() => ktx2!.loadAsync(url), { retries: 1 });
  if (!(texture as THREE.CompressedTexture).isCompressedTexture) {
    texture.dispose(); throw new Error('GPU compressed texture arrays are unavailable');
  }
  // The loader may share concurrent URL tasks. Give each tile its own disposable GPU owner,
  // sharing only immutable compressed bytes. Three also returns a 2D texture for a one-layer array.
  const image = texture.image as { width: number; height: number; depth?: number };
  const array = new THREE.CompressedArrayTexture(texture.mipmaps ?? [], image.width, image.height, image.depth ?? 1, texture.format, texture.type);
  array.colorSpace = THREE.NoColorSpace; texture.dispose(); return array;
}

export function disposeOptimizedTextureLoader(): void {
  ktx2?.dispose();
  ktx2 = null;
  ktx2Ready = null;
  if (textureLoaderPatched) {
    THREE.TextureLoader.prototype.load = originalTextureLoad;
    textureLoaderPatched = false;
  }
  configureTextureUploadAdmission(null);
}
