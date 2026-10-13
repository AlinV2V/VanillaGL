# Setup and baking

The setup CLI is implemented by `tools/setup-assets.ts`. These flags were verified directly from its parser on 2026-08-25:

```powershell
npm run setup -- "C:\Games\World of Warcraft 1.12.1" --tier level40 --jobs 8 --profile release --textures fidelity
```

`--tier starter|level40|full`, `--jobs N`, `--profile dev|release`, and `--textures off|dev|fidelity|compact` exist. The defaults are `level40`, `dev`, and `off`; release defaults to `fidelity` when `--textures` is omitted. Both `--flag value` and `--flag=value` work. `--textures fidelity` is implemented, but it does not by itself enable Meshopt/Opus/catalog/Brotli passes; those are release-profile work.

## Inputs, cache, and tools

Supply a compatible World of Warcraft 1.12.1 client directory or its `Data` directory. Required archives are `base.MPQ`, `dbc.MPQ`, `fonts.MPQ`, `interface.MPQ`, `misc.MPQ`, `model.MPQ`, `sound.MPQ`, `speech.MPQ`, `terrain.MPQ`, `texture.MPQ`, and `wmo.MPQ`; patch archives are optional and priority-resolved where the consumer supports their schema. Setup links/mounts them below ignored `.client-cache` and records `.client-cache/setup-profile.json`.

Portable, checksum-pinned `toktx`, `cwebp`, and FFmpeg resolution lives in `tools/utils/asset-tools.ts`. Install/check with `npm run tools:install`. Release mode requires these tools and fails when a required executable is absent; development mode may keep source fallbacks.

## Pipeline

All tiers stage the DBCs used by current bakers, extract priority-correct FrameXML/UI, bake characters, equipment, creatures, game objects, spells, talents, maps, lighting, audio, cinematics, transports, minimaps, water, doodad skeletons, and validate runtime metadata.

- `starter`: six Vanilla starter regions plus capital-city coverage.
- `level40`: starter, core level 1–40, completion, and capital coverage.
- `full`: starter metadata plus all Azeroth/Kalimdor ADTs.

Tile output includes 129×129 outer heights, 128×128 inner heights, normals, terrain/splat/shadow products, compact WMO binary/meta, doodads, grass, surface map, and liquid metadata. DBC staging uses `prepare-runtime-dbcs.ts`; note that fixed-field consumers intentionally pin some base schemas while assets can remain patch-priority.

Texture modes run KTX2, fallback repair, and WebP. Release mode additionally runs Meshopt (`balanced`), 48 kHz Opus, content hashes, catalog sharding, and Brotli. Catalog sharding occurs before Brotli generation. The asset server selects `.br` by HTTP negotiation and preserves byte ranges uncompressed.

Setup is resumable where individual bakers support existing-output checks. A required step or final validation failure writes a failed setup profile and exits nonzero. Optional weather/ship-path stages are recorded without converting a required failure into success. Validation checks required manifests, tile products, global WMO cells, UI extraction coverage, sky assets, and release sidecars.

## Development and verification

```powershell
npm install
npm run proxy       # WebSocket-to-TCP bridge on 127.0.0.1:9000 by default
npm run dev         # client on http://localhost:5173
npm run assets:serve
npm run typecheck
npm run build
```

Generated assets remain local and ignored. No proprietary game asset is part of the source repository or license.
