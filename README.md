# VanillaGL

VanillaGL is an experimental World of Warcraft 1.12.1 (Build 5875) client that runs in the browser, built with TypeScript, Three.js, WebGL2, Canvas and WebAudio. It connects to a [vMaNGOS](https://github.com/vmangos/core) realm through the included WebSocket-to-TCP bridge, and supports desktop, mobile touch and WebXR headsets.

**This repository contains source code and conversion tools only.** It ships no game assets of any kind. You must supply your own World of Warcraft 1.12.1 client; the bundled bakers convert its archives into browser-ready assets on your machine.

**Just want to play?** Follow the step-by-step [install guide](INSTALL.md): double-click `Setup.bat`, answer three questions, then double-click `Play.bat`.

> VanillaGL is an unofficial fan project. It is not affiliated with or endorsed by Blizzard Entertainment. World of Warcraft and Blizzard Entertainment are trademarks or registered trademarks of Blizzard Entertainment, Inc.

## What you need

- **Node.js** 20.19+ or 22.12+, and npm.
- **A World of Warcraft 1.12.1 (Build 5875) client.** Setup reads these archives from its `Data` folder: `base`, `dbc`, `fonts`, `interface`, `misc`, `model`, `sound`, `speech`, `terrain`, `texture` and `wmo` `.MPQ`. Patch archives (`patch.MPQ`, `patch-2.MPQ`, ...) are optional and applied in priority order.
- **A vMaNGOS Build 5875 realm** to log in to, either local or remote. Without one you can still preview the world (see below).
- **Disk space.** A `level40` release bake is roughly 20 GB and takes about an hour with 8 jobs; `full` is substantially larger.

## Quickstart

The one-step way: run `Setup.bat` (Windows) or `bash setup.sh` (macOS/Linux). It checks Node.js, installs dependencies, asks for your client folder, world size and realm, then bakes everything unattended. Afterwards, `Play.bat` / `bash play.sh` starts the realm bridge and the game together and opens your browser. The same flows are available as `npm run wizard` and `npm run play`.

The manual way:

```bash
npm install
npm run setup -- "C:\Games\World of Warcraft 1.12.1" --tier level40 --profile release --jobs 8
npm run proxy
npm run dev
```

Then open `http://localhost:5173` and log in with an account on your realm.

`npm run setup` copies (or links) your MPQs into the ignored `.client-cache/` folder, downloads checksum-pinned `toktx`, `cwebp` and FFmpeg builds for the release profile, then bakes everything into `apps/client/public/`. It is resumable: rerun the same command after a failure and finished outputs are reused.

| Option | Values | Default |
| --- | --- | --- |
| `--tier` | `starter` (six starting regions + capitals), `level40` (zones for levels 1-40 + capitals), `full` (every Azeroth and Kalimdor tile) | `level40` |
| `--profile` | `dev` (fast, source fallbacks), `release` (KTX2/WebP textures, Meshopt geometry, Opus audio, Brotli catalogs, collision trees) | `dev` |
| `--textures` | `off`, `dev`, `fidelity`, `compact` | `off` for dev, `fidelity` for release |
| `--jobs` | number of parallel bake workers | based on CPU count |

After running any individual baker by hand, re-run the release optimisation passes with `npm run bake:performance`.

## Connecting to a realm

`Play` configures the proxy from the realm you entered during setup (saved in `.client-cache/realm.json`). Run manually, the proxy listens on `127.0.0.1:9000` and forwards the browser's binary WebSocket to the realm's auth and world TCP ports. The dev server forwards `/wow-ws` to it automatically. Configure it with environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `REALM_HOST` | `127.0.0.1` | vMaNGOS host |
| `AUTH_PORT` / `WORLD_PORT` | `3724` / `8085` | realmd and mangosd ports |
| `WS_HOST` / `WS_PORT` | `127.0.0.1` / `9000` | where the proxy listens |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | browser origins allowed to connect |
| `WOW_CLIENT_INTEGRITY_HASH` | the Build 5875 value used by vMaNGOS | client integrity digest sent during login |

The in-game Server Settings panel can point the client at a different bridge.

## Previewing without a realm

With assets baked, you can load a terrain tile directly without logging in:

```
http://localhost:5173/?tile=Azeroth_32_48
```

This exercises rendering only; combat, login and realm packets need a live server.

## Other commands

```bash
npm run typecheck      # TypeScript check
npm run build          # production bundle (assets are served separately)
npm run assets:serve   # static asset server with Brotli negotiation and range requests
npm run dev:lan        # dev server on your LAN, with HTTPS for WebXR headsets
npm run tools:install  # install the portable texture/audio encoders only
```

## How it fits together

Protocol bytes from the realm are decoded into deterministic world state; Three.js rendering, the canvas UI and audio consume snapshots of that state. The in-game UI is drawn on canvas following the original FrameXML layouts.

| Area | Location |
| --- | --- |
| Login, SRP6 auth, world protocol | `apps/client/src/auth.ts`, `world.ts`, `world/`, `protocol/`, `login/` |
| Simulation and state | `apps/client/src/simulation/`, `world-entities.ts` |
| Terrain, WMO, M2, particles, lighting | `apps/client/src/rendering/`, `model-loader.ts`, `m2-animator.ts` |
| Movement and collision | `apps/client/src/player/`, `world-collision.ts` |
| Combat, spells, UI | `apps/client/src/combat/`, `ui/` |
| Mobile and VR | `apps/client/src/platform/`, `ui/mobile/`, `xr/` |
| Asset pipeline | `tools/setup-assets.ts`, `tools/bakers/`, `tools/extractors/` |
| Realm bridge and asset server | `server/proxy/`, `server/assets/` |

More detail:

- [Architecture](docs/ARCHITECTURE.md)
- [Setup and baking](docs/SETUP_AND_BAKING.md)
- [Protocol](docs/PROTOCOL.md)
- [World coordinates](docs/WORLD_COORDINATES.md)
- [Formats and DBC layouts](docs/FORMATS_AND_DBC.md)
- [Combat and gameplay](docs/COMBAT_AND_GAMEPLAY.md)
- [Simulation/presentation boundary](docs/architecture/simulation-presentation.md)

## Status

VanillaGL is experimental. Much of the client works against a vMaNGOS realm, but it is not a complete or verified level 1-60 experience, and performance varies widely by device.

## License

The source code is MIT-licensed; see [LICENSE](LICENSE). The license covers only this project's code. It grants no rights to World of Warcraft game data, including anything you generate from your own client.
