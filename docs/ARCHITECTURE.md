# VanillaGL architecture

The VanillaGL runtime keeps gameplay truth behind the simulation/protocol boundary described in `docs/architecture/simulation-presentation.md`, while optimized assets remain optional representations of stable logical assets.

## Eight-pillar delivery stack

| Pillar | Source and build stage | Runtime and fallback | Limitations |
|---|---|---|---|
| 1. KTX2 UASTC textures | `tools/bakers/bake-ktx2.ts`, `repair-ktx2-fallbacks.ts`, `apps/client/src/assets/texture-registry.ts` | `rendering/optimized-texture-loader.ts` dynamically loads Three's `KTX2Loader`, selects the browser-supported target format, and hydrates a stable texture object. A registered WebP/source URL is used after an unsupported or failed KTX2 load. | GPU target is capability-dependent. The bake is UASTC, but runtime storage can be BC7, S3TC, ETC2, or ASTC. |
| 2. Lossless WebP browser fallbacks | `tools/bakers/bake-webp.ts`; mappings enter the texture catalog | Canvas/UI and failed KTX2 requests use browser-decodable WebP; original source remains the last development fallback where registered. | Not every source image is safe to rewrite; exact/data textures remain explicitly routed. |
| 3. Meshopt WASM and quantized geometry | `tools/bakers/bake-meshopt.ts` emits typed stream metadata and binary sidecars; `assets/meshopt-runtime.ts` owns decode | Mapped JSON requests route to Meshopt sidecars, worker decode, then frame-budgeted hydration. Source JSON is retained as a fail-safe. | Final WebGL buffers are hydrated by Three.js; this is not a zero-copy WebGPU path. |
| 4. Brotli-compressed sharded catalogs | `bake-content-hashes.ts`, `shard-runtime-catalogs.ts`, `bake-brotli.ts` | `assets/content-delivery.ts` lazy-loads catalog shards. `server/assets/server.mjs` negotiates `.br` sidecars through `Accept-Encoding`; clients request logical names, never `.br`. | Vite development delivery does not model every production cache/encoding behavior. |
| 5. GPU instancing and renderer batching | `rendering/instanced-doodad-renderer.ts`, `spatial-doodad-batches.ts`, `doodad-culling.ts`; Meshopt supplies index-only LODs | Repeated M2/grass instances share geometry/material and are split into conservative spatial cells for frustum, distance, SmallCull, and LOD selection. The Build 5875 Low/Medium/High `SmallCull` table (`0.07/0.04/0.01`) follows the current `WorldDetail` setting. | Cell sizes are a measured CPU/GPU balance, not a Build 5875 constant. Animated/material differences can still fragment batches. |
| 6. WMO BVH physics/collision | `bake-wmos.ts` emits collision triangles and `bake-wmo-bvh.ts` emits versioned v2 trees coupled by hash to the exact WMO binary and serialized tree blob | `world-tile-loader.ts` validates the format, `three-mesh-bvh` version, serialization version, options, hashes, surface shape, and tree bounds before deserializing. Missing or rejected sidecars use the frame-budgeted runtime builder; collision is exposed only after every fallback finishes. | Sidecar hashing and structural checks are still tile-load work. Runtime computation remains the development/emergency fallback. |
| 7. 48 kHz Opus and browser audio | `bake-sounds.ts` extracts the source corpus; `bake-opus.ts` uses FFmpeg at 48 kHz and updates `sound-manifest.json` / `audio-assets.json` | `audio/sound-manager.ts` uses WebAudio for decoded/spatial voices and media elements for long streams; Opus failure retries the source asset. | Browser decode, autoplay, device mixing, and voice limits remain browser/platform dependent. |
| 8. Turnkey tiers and portable tooling | `tools/setup-assets.ts`, `tools/utils/asset-tools.ts`, `install-asset-tools.ts`; tier bakers under `tools/bakers` | Setup mounts local MPQs into `.client-cache`, stages DBC/FrameXML, bakes the requested world, then optionally produces release sidecars. | The default is `level40`, `dev`, textures `off`; optimized release assets require `--profile release` (which defaults textures to `fidelity`). Setup never supplies game data. |

## Runtime boundaries

Protocol bytes become `WorldDelta` values, simulation owns canonical state and fixed time, and presentation consumes render snapshots/events. Rendering, DOM/Canvas, and WebAudio must not mutate simulation truth.

Content optimizations preserve logical names. A missing optional sidecar is recoverable; a malformed authoritative packet, impossible schema, or release-required tool is fail-closed. In development builds, `__vanillaPerf()` in the browser console exposes runtime performance diagnostics.

See `docs/SETUP_AND_BAKING.md` for the supported CLI.
