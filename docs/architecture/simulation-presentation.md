# Simulation / presentation architecture

This boundary is part of the stack described in `docs/ARCHITECTURE.md`.

VanillaGL keeps gameplay truth independent from the browser renderer. This is a dependency rule, not a filename convention.

## Data flow

```text
input adapters ── GameCommand ──┐
                               v
network bytes -> protocol -> WorldDelta -> Simulation -> RenderSnapshot + PresentationEvent
                                                   |             |
                                                   |             +-> Three.js / Canvas / WebAudio
                                                   +-> deterministic replay / Node tests
```

## Ownership

**Protocol** owns byte layouts, packet masks, opcodes and conversion into protocol-neutral `WorldDelta` values.

**Simulation** owns canonical entity state, movement/combat state, fixed simulation time, prediction state, dirty/version counters and gameplay commands. It must be runnable in Node without browser mocks.

**Presentation** owns Three.js objects, materials, textures, animation blend weights, particles, camera shake, audio handles, UI hover/focus state and other visual-only timers.

Presentation never mutates canonical game state. Input that changes game state returns through a `GameCommand`.

## Time

Simulation code never reads wall-clock time. `FixedSimulationClock` is the only domain clock. Browser/worker schedulers decide *when* to call `step()`; the simulation decides what tick/time that represents.

## State changes

Persistent state is read from snapshots and guarded by version/dirty counters. Edge-triggered effects use `PresentationEvent` values. High-frequency transforms are not expanded into a general-purpose JavaScript event bus.

## Render boundary

`RenderSnapshotBuffer` is a reusable structure-of-arrays buffer. Hot entity transforms use numeric render IDs; GUID strings are carried by lifecycle events instead of repeated in every frame snapshot. Teleport sequence changes are explicit discontinuities and must hard-snap rather than interpolate.

## Worker boundary

`Simulation` contains no worker/browser APIs. `platform/simulation.worker.ts` and `SimulationWorkerProxy` are transport adapters around the same command/delta/snapshot contract. The initial Worker adapter uses transferable typed arrays; moving to shared/double-buffered storage is a transport optimization and does not alter simulation rules.

## Migration rule

Legacy packet/entity code is bridged through `migration/legacy-world-entity-adapter.ts`. New simulation/protocol code must not import that legacy module. As packet parsing is moved into `protocol/`, the migration adapter should shrink and eventually disappear.

## Enforcement

The boundary rules are:

- protected simulation/protocol modules cannot import Three.js, rendering, UI, audio, login or platform code;
- protected modules cannot use DOM/WebGL/Audio globals;
- simulation code cannot use ambient wall clocks, randomness, timers, local storage or fetch;
- the same packet sequence must produce identical state on every run;
- render snapshot storage is reusable and teleport interpolation is rejected.

Treat these as architecture rules, not documentation suggestions.
