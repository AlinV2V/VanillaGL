import { registerLiveWorldRoom,releaseLiveWorldGroup } from './world-live-pages';
import { applyGroundEffectDetail } from './ground-effect-detail';
import { invalidateWmoLightCandidates } from './wmo-light-candidates';
import * as THREE from 'three';
import { registerTerrainSubmission } from './terrain-submission';
import { createTerrainMaterial, updateTerrainMaterialLight, type TerrainLight } from '../terrain-shader';
import { TILE, TILE_HALF, tileByGridCoordinate, tileForCharacter, type TileEntry } from '../tile-utils';
import type { RealmWorldClient } from '../world';
import type { WorldEntityRenderer } from '../world-entity-renderer';
import { WorldCollision } from '../world-collision';
import type { LoadedTile } from '../wow-app-types';
import { renderInstancedDoodads } from './instanced-doodad-renderer';
import { attachWmoBvhSidecar, hiddenCollisionRoot, installCollisionBvh, loadWmoBvhSidecar, scheduleCollisionBvh } from './collision-bvh';
import { updateGrassMaterialLight } from './grass-material';
import { loadWaterSurface } from './water-surface';
import { buildIndoorMasks } from './wmo-interiors';
import { loadWmoBinary } from './wmo-binary';
import { sampleTileHeight } from './sample-tile-height';
import { linkedAbortController } from '../platform/linked-abort-controller';
import { retryAbortable } from '../platform/retry-abortable';
import { isMissingTileAsset, tileReadiness, type TileLoadFailure } from './tile-load-state';
import { validateTileCoreBuffers } from './tile-core-validation';
import { wmoInteriorMaterialCacheKey } from './wmo-material-cache';
import { loadTileCoreFiles } from './tile-core-fetch';
import { StaticWorldGroup } from './static-world-group';
import { createWmoLiquidMesh, sampleAdtLiquid, sampleWmoLiquid, wmoLiquidWorldBounds, type WmoLiquidInstance } from './wmo-liquid-surface';
import { clearAnimatedUVs } from './m2-texture-animation';
import { clearDoodadAnimationsForGroup } from './doodad-skeletal-animation';
import { clearDoodadCullingForGroup } from './doodad-culling';
import { wmoGroupUsesOutdoorLighting, type WmoVisibilityGroup, type WmoVisibilityInstance } from './wmo-visibility';
import type { WorldDoodadEffectSpawner } from './world-doodad-effects';
import { isSharedWorldTexture, loadWorldTexture, releaseWorldTexturesForGroup } from './world-texture-cache';
import { recordRuntimeAttribution } from '../platform/runtime-attribution';
import { tileStreamRadius, tileStreamingDiagnostics, tileWithinRequestedNeighborhood } from './tile-neighborhood';
import { clearWorldRenderAdmissionForGroup, stageWorldRenderAdmission } from './world-render-admission';
import { createWorldHydrationCheckpoint } from './world-hydration-scheduler';
import { buildTerrainGeometry } from './terrain-geometry-builder';
import { canonicalizeWmoModelGeometry } from './world-model-data-cache';
import { prepareWmoRenderBatches, setWmoBatchGeometryBounds } from './wmo-render-batches';
import { createWmoBatchExperimentBuilder } from './wmo-batched-experiment';
import { instrumentWmoBatch } from './performance-detail-diagnostics';
import { SpatialBoundsIndex2D } from '../platform/spatial-index';
type TerrainTuning = { tex: number; detail: number; mip: number; anisotropy: number }; type WorldTileLoaderDeps = {
  scene: THREE.Scene;
  camera: THREE.Camera;
  prewarmObject: (object: THREE.Object3D, signal?: AbortSignal) => Promise<void>;
  tileIndex: TileEntry[];
  textureLoader: THREE.TextureLoader;
  worldCollision: WorldCollision;
  worldDoodadEffects: WorldDoodadEffectSpawner;
  configureTexture: (tex: THREE.Texture, options?: { repeat?: boolean; flipY?: boolean }) => THREE.Texture;
  getActiveLight: () => TerrainLight;
  supportsS3tc: boolean;
  getTerrainTuning: () => TerrainTuning;
  /** Environment Detail (WorldDetail CVar 0..2); selects the baked ground-clutter density tier. */
  getWorldDetail?: () => number;
  getCurrentMap: () => number;
  getActiveWorld: () => RealmWorldClient | undefined;
  getEntityRenderer: () => WorldEntityRenderer | null | undefined;
  getEffectFocus: () => THREE.Vector3;
  getPlayerGuid: () => string | undefined;
  loadingScreenVisible: () => boolean;
  log: (message: string) => void;
};
const WMO_LOCAL_LIGHTS = 8;
/**
 * MOMT material flags (censused across 482 baked tiles / 34530 batches — all of these occur):
 *   0x01 UNLIT (367)  0x02 UNFOGGED  0x04 UNCULLED/two-sided (709)  0x08 EXTLIGHT (309)
 *   0x10 SIDN self-illuminated (417)  0x20 WINDOW (301)  0x40 CLAMP_S (398)  0x80 CLAMP_T (430)
 */
const MOMT_UNLIT = 0x01;
const MOMT_TWO_SIDED = 0x04;
const MOMT_SIDN = 0x10;
const MOMT_WINDOW = 0x20;
/**
 * Self-illumination, from captured program 0001:
 *
 *   base     = tex * primary
 *   selfIllum= primary.rgb * primary.a
 *   final    = base + 4.0 * (selfIllum * tex)      ->  tex * primary * (1.0 + 4.0 * primary.a)
 *
 * `primary.a` is the MOCV vertex-colour alpha, which the bake already uploads (itemSize 4) and
 * which nothing consumed until now. This is the lit-windows / brazier / lamp layer: without it a
 * WMO exterior reads uniformly flat after dark.
 *
 * Gated on MOMT_SIDN so it only touches the 417 batches actually authored for it — applying the
 * 4x boost everywhere would blow out every wall that happens to carry a non-zero MOCV alpha.
 */
/**
 * MOMT_SIDN (0x10) is "self-illuminated at night" and MOMT_WINDOW (0x20) rides with it: lit windows,
 * forge glows, lamp panes. 418 SIDN and 301 WINDOW batches across 75 owner-rendered models.
 *
 * This used to read `lit * (1.0 + 4.0 * mocvAlpha * enabled)`, which could not work. `mocvAlpha` is
 * the OUTPUT alpha of fixVertexColors (bake-wmos.ts), and that is a per-group constant —
 * `isExterior ? 255 : 0`. So the term was exactly 0 on every interior batch, which is where 295 of
 * the 301 WINDOW batches live, and a flat x5 on every exterior one, day and night alike. Measured on
 * StartingZone_01 Abbey: mean MOCV alpha is 0.0 on 9 of its 11 interior groups.
 *
 * `uNight` is 0 in full daylight and 1 at full dark. It rides on TerrainLight and is the same
 * clock-driven curve the celestial system uses (`rendering/wmo-night.ts`) — NOT derived from the sun
 * colour, which stays moonlight-blue at roughly half luminance all night and cannot tell day from
 * night. The 4.0 gain is carried over unchanged from the previous expression, so peak brightness is
 * the value already tuned here; only *when* it applies has changed.
 */
import { WMO_EXTERIOR_VERT, WMO_EXTERIOR_FRAG, WMO_INTERIOR_VERT, WMO_INTERIOR_FRAG } from './wmo-shaders';

export class WorldTileLoader {
  readonly loadedTiles = new Map<string, LoadedTile>();
  readonly loadingTiles = new Map<string, Promise<LoadedTile>>();
  readonly wmoInteriorMaterials = new Set<THREE.ShaderMaterial>();
  readonly wmoExteriorMaterials = new Set<THREE.ShaderMaterial>();
  readonly grassMaterials = new Set<THREE.ShaderMaterial>();
  readonly wmoVisibilityInstances: WmoVisibilityInstance[] = [];
  currentTile: LoadedTile | null = null;
  /** False while the camera is fully enclosed in a WMO interior (GFX-37) — hides ground/liquid meshes. */
  exteriorVisible = true;
  private renderOriginX = 0;
  private renderOriginY = 0;
  private readonly missingNeighbors = new Set<string>();
  private readonly sampleMaskPoint = new THREE.Vector3();
  private readonly sampleMaskScratch = new THREE.Vector3();
  private readonly liquidSpatial = new SpatialBoundsIndex2D<WmoLiquidInstance>(64);
  private readonly liquidCandidates: WmoLiquidInstance[] = [];
  private readonly liquidBounds = new THREE.Box3();
  private requestedNeighborhoodKey = ''; private neighborhoodGeneration = 0;
  private readonly tileFailures = new Map<string, TileLoadFailure>();
  /** Invalidates async tile builds when the world is cleared or a map transfer starts. */
  private loadGeneration = 0;
  private loadAbortController = new AbortController(); private readonly tileAbortControllers = new Map<string, ReturnType<typeof linkedAbortController>>();

  constructor(private readonly deps: WorldTileLoaderDeps) {
    // Install the BVH-accelerated raycast before any WMO collision geometry is built.
    installCollisionBvh();
  }

  getRenderOrigin() {
    return { x: this.renderOriginX, y: this.renderOriginY };
  }

  hasLoadedTile(key: string) {
    return this.loadedTiles.has(key);
  }

  streamingDiagnostics() { return { ...tileStreamingDiagnostics(
      this.deps.tileIndex, this.requestedNeighborhoodKey,
      this.loadedTiles.keys(), this.loadingTiles.keys(),
    ), readiness: tileReadiness(this.loadedTiles.keys(), this.loadingTiles.keys(), this.tileFailures) };
  }

  worldToLocal(wx: number, wy: number) {
    return { x: wx - this.renderOriginX, y: wy - this.renderOriginY };
  }

  localToWorld(rx: number, ry: number) {
    return { x: rx + this.renderOriginX, y: ry + this.renderOriginY };
  }

  clear() {
    this.loadGeneration++;
    this.loadAbortController.abort();
    for (const linked of this.tileAbortControllers.values()) { linked.controller.abort(); linked.dispose(); } this.tileAbortControllers.clear();
    this.loadAbortController = new AbortController();
    this.requestedNeighborhoodKey = ''; this.neighborhoodGeneration++;
    for (const tile of this.loadedTiles.values()) {
      this.deps.scene.remove(tile.group);
      this.disposeGroup(tile.group);
    }
    this.loadedTiles.clear();
    this.tileFailures.clear();
    this.loadingTiles.clear();
    this.wmoInteriorMaterials.clear();
    this.wmoExteriorMaterials.clear();
    this.grassMaterials.clear();
    this.wmoVisibilityInstances.length = 0;
    invalidateWmoLightCandidates(this.wmoVisibilityInstances);
    this.liquidSpatial.clear();
    this.missingNeighbors.clear();
    this.deps.worldDoodadEffects.clear();
    this.deps.worldCollision.clear();
    this.currentTile = null;
    this.deps.getEntityRenderer()?.clear();
  }

  setRenderOrigin(x: number, y: number) {
    invalidateWmoLightCandidates(this.wmoVisibilityInstances);
    this.renderOriginX = x;
    this.renderOriginY = y;
    for (const tile of this.loadedTiles.values()) this.positionTileGroup(tile);
    this.rebuildLiquidSpatialIndex();
    this.deps.worldCollision.refresh();
  }

  /**
   * GFX-37: while the camera sits in a WMO interior whose portal graph reaches no exterior
   * group (mine shafts, crypts), the outdoor ground and liquid must not bleed through the
   * walls. Doorway-connected rooms keep the exterior so open doors never frame a void.
   */
  setExteriorVisible(visible: boolean) {
    if (this.exteriorVisible === visible) return;
    this.exteriorVisible = visible;
    for (const tile of this.loadedTiles.values()) {
      for (const mesh of tile.exteriorMeshes) mesh.visible = visible;
    }
  }

  setWorldDetail(level: number) { for (const tile of this.loadedTiles.values()) applyGroundEffectDetail(tile.group, level); }
  setTerrainMipBias(mip: number) { for (const tile of this.loadedTiles.values()) if (tile.terrainMaterial) tile.terrainMaterial.uniforms.uMipBias.value = mip; }
  applyTerrainTuning(tex: number, detail: number, mip: number) {
    for (const tile of this.loadedTiles.values()) {
      if (!tile.terrainMaterial) continue;
      tile.terrainMaterial.uniforms.uLayerScale.value = tex;
      tile.terrainMaterial.uniforms.uDetail.value = detail;
      tile.terrainMaterial.uniforms.uMipBias.value = mip;
    }
  }

  applyTerrainLighting(light: TerrainLight) {
    for (const tile of this.loadedTiles.values()) {
      if (tile.terrainMaterial) updateTerrainMaterialLight(tile.terrainMaterial, light);
    }
    for (const material of this.grassMaterials) updateGrassMaterialLight(material, light);
    const night = light.night;
    for (const material of this.wmoExteriorMaterials) {
      material.uniforms.uAmbient.value.set(...light.ambient);
      material.uniforms.uSunDir.value.copy(light.sunDir).normalize();
      material.uniforms.uSunColor.value.set(...light.sunColor);
      material.uniforms.uFogColor.value.set(...light.fogColor);
      material.uniforms.uFogNear.value = light.fogNear;
      material.uniforms.uFogFar.value = light.fogFar;
      material.uniforms.uNight.value = night;
    }
  }

  updateWmoInteriorFog(light: TerrainLight) {
    // Interior `uAmbient` stays at the model's static MOHD value on purpose — that is what the
    // format carries. `uNight` is the one time-of-day input an interior surface takes, and it drives
    // only the SIDN/WINDOW self-illum term, so lit windows come up as the sun goes down.
    const night = light.night;
    for (const material of this.wmoInteriorMaterials) {
      material.uniforms.uFogColor.value.set(...light.fogColor);
      material.uniforms.uFogNear.value = light.fogNear;
      material.uniforms.uFogFar.value = light.fogFar;
      material.uniforms.uNight.value = night;
      // Feeds the MOCV-alpha daylight spill only. Deliberately the UNSCALED world sun, not the
      // indoorSunScale-dimmed one: the lit patch inside a doorway must not switch off because the
      // player happened to step across the threshold.
      material.uniforms.uSunDir.value.copy(light.sunDir).normalize();
      material.uniforms.uSunColor.value.set(...light.sunColor);
      material.uniforms.uOutdoorAmbient.value.set(...light.ambient);
    }
  }

  async loadTile(entry: TileEntry) {
    const existing = this.loadedTiles.get(entry.key);
    if (existing) return existing;
    const loading = this.loadingTiles.get(entry.key);
    if (loading) return loading;

    const generation = this.loadGeneration;
    const linked = linkedAbortController(this.loadAbortController.signal); this.tileAbortControllers.set(entry.key, linked);
    const promise = retryAbortable(() => this.loadTileFresh(entry, generation, linked.controller.signal), {
      signal: linked.controller.signal, shouldRetry: error => !isMissingTileAsset(error),
      onRetry: (error, attempt) => this.tileFailures.set(entry.key, { attempt, state: 'retrying', error: String(error) }),
    });
    this.loadingTiles.set(entry.key, promise);
    try {
      const tile = await promise;
      this.tileFailures.delete(entry.key);
      return tile;
    } catch (error) {
      if (!linked.controller.signal.aborted) this.tileFailures.set(entry.key, { attempt: isMissingTileAsset(error) ? 1 : 3, state: isMissingTileAsset(error) ? 'missing' : 'degraded', error: String(error) });
      throw error;
    } finally {
      // An older generation must not delete a newer in-flight promise for the same tile.
      if (this.loadingTiles.get(entry.key) === promise) this.loadingTiles.delete(entry.key);
      if (this.tileAbortControllers.get(entry.key) === linked) { this.tileAbortControllers.delete(entry.key); linked.dispose(); }
    }
  }

  async ensureTileNeighborhood(entry: TileEntry, onProgress?: (loaded: number, total: number) => void, options: { activate?: boolean } = {}) {
    this.requestedNeighborhoodKey = entry.key; const neighborhoodGeneration = ++this.neighborhoodGeneration;
    const entries = this.neighborEntries(entry);
    const requestedKeys = new Set(entries.map((candidate) => candidate.key)); for (const [key, linked] of this.tileAbortControllers) if (!requestedKeys.has(key)) linked.controller.abort(`tile ${key} left requested neighborhood`);
    const streamRadius = tileStreamRadius(entry);
    // Reserve at most one diagonal outgoing edge (5 tiles for radius 1), including
    // space for every incoming tile. Repeated/superseded crossings cannot grow residency.
    this.pruneOutside(entry, streamRadius + 1);
    let outgoing = [...this.loadedTiles.values()].filter(tile => !requestedKeys.has(tile.key));
    for (const tile of outgoing) if (outgoing.length > 4 * streamRadius + 1 && tile !== this.currentTile) {
      this.unloadTile(tile.key, tile); outgoing = outgoing.filter(candidate => candidate !== tile);
    }
    for (const key of this.tileFailures.keys()) if (!requestedKeys.has(key)) this.tileFailures.delete(key);
    const loaded = await this.loadTile(entry);
    if (neighborhoodGeneration === this.neighborhoodGeneration) {
      if (options.activate !== false) this.currentTile = loaded;
      // Keep the bounded outgoing edge until the incoming neighborhood commits.
    }
    let completed = 1;
    onProgress?.(completed, entries.length);
    // Await the visible neighborhood, but admit only two tile hydrations at once.
    const neighbors = entries.filter((neighbor) => neighbor.key !== entry.key); let nextNeighbor = 0;
    const streamNext = async () => {
      while (nextNeighbor < neighbors.length && neighborhoodGeneration === this.neighborhoodGeneration) {
        const neighbor = neighbors[nextNeighbor++];
        try {
          await this.loadTile(neighbor);
        } catch (e) {
          this.deps.log(`tile ${neighbor.key}: failed to stream (${(e as Error).message})`);
        } finally {
          completed++;
          onProgress?.(completed, entries.length);
        }
      }
    }; await Promise.all(Array.from({ length: Math.min(2, neighbors.length) }, streamNext));
    const missing = Array.from(this.missingNeighbors).slice(0, 6);
    if (missing.length) {
      this.deps.log(`streaming: ${missing.length} adjacent tile(s) not baked yet (${missing.join(', ')}${this.missingNeighbors.size > 6 ? ', ...' : ''})`);
    }
    if (neighborhoodGeneration === this.neighborhoodGeneration && entries.every(candidate => this.loadedTiles.has(candidate.key))) this.pruneOutside(entry, streamRadius);
    return loaded;
  }
  /** Release terrain/WMO GPU and collision resources outside a Chebyshev tile radius. */
  pruneOutside(center: TileEntry, radius = tileStreamRadius(center)) {
    const coords = this.tileCoords(center);
    if (!coords) return;
    for (const [key, tile] of [...this.loadedTiles]) {
      if (tile.entry.dir !== center.dir) {
        this.unloadTile(key, tile);
        continue;
      }
      const tileCoords = this.tileCoords(tile.entry);
      if (!tileCoords || Math.max(Math.abs(tileCoords.x - coords.x), Math.abs(tileCoords.y - coords.y)) <= radius) continue;
      this.unloadTile(key, tile);
    }
  }

  private unloadTile(key: string, tile: LoadedTile) {
    if (this.currentTile?.key === key) return;
    const effectOwnerKey = tile.group.userData.wowDoodadEffectOwnerKey; if (typeof effectOwnerKey === 'string') this.deps.worldDoodadEffects.removeOwner(effectOwnerKey);
    this.deps.worldCollision.removeMany(tile.collisionMeshes);
    const belongsToTile = (root: THREE.Object3D) => {
      for (let object: THREE.Object3D | null = root; object; object = object.parent) if (object === tile.group) return true;
      return false;
    };
    for (let index = this.wmoVisibilityInstances.length - 1; index >= 0; index--) {
      if (belongsToTile(this.wmoVisibilityInstances[index].root)) this.wmoVisibilityInstances.splice(index, 1);
    }
    this.deps.scene.remove(tile.group);
    this.disposeGroup(tile.group);
    this.loadedTiles.delete(key);
    for (const liquid of tile.wmoLiquids) this.liquidSpatial.remove(liquid.id);
    this.deps.log(`streaming: pruned tile ${key}`);
  }

  sampleWaterLevel(rx: number, ry: number): number {
    return this.sampleLiquidAt(rx, ry).height;
  }

  /** Liquid type at a render-space point (1=river/water, 2=ocean, 3=magma, 4=slime), or -1 if none. */
  sampleWaterTypeAt(rx: number, ry: number): number {
    return this.sampleLiquidAt(rx, ry).type;
  }

  /** Resolve height and type together so camera/environment callers never scan WMO liquids twice. */
  private sampleLiquidAt(rx: number, ry: number): { height: number; type: number } {
    const world = this.localToWorld(rx, ry);
    const tile = this.findTileAtWorld(world.x, world.y);
    let { height, type } = sampleAdtLiquid(tile, world.x, world.y, TILE_HALF);
    for (const liquid of this.liquidSpatial.queryPoint(rx, ry, this.liquidCandidates)) {
      const sample = sampleWmoLiquid(liquid, rx, ry);
      if (sample && sample.height >= height) { height = sample.height; type = sample.type; }
    }
    return { height, type };
  }

  /** Dominant TerrainType.dbc ID under a render-space point (dirt fallback). */
  sampleTerrainType(rx: number, ry: number): number {
    const world = this.localToWorld(rx, ry);
    const tile = this.findTileAtWorld(world.x, world.y) ?? this.currentTile;
    if (!tile?.surfaceMap) return 0;
    const { grid, resolution } = tile.surfaceMap;
    const tileX = world.x - tile.centerX;
    const tileY = world.y - tile.centerY;
    const row = Math.max(0, Math.min(resolution - 1, Math.floor(((TILE_HALF - tileX) / TILE) * resolution)));
    const col = Math.max(0, Math.min(resolution - 1, Math.floor(((TILE_HALF - tileY) / TILE) * resolution)));
    // A foot occupies more than one ~1-yard surface cell. Majority sampling a
    // 3x3 footprint prevents alternating wood/grass cues along splat boundaries.
    const counts = new Uint8Array(10);
    for (let dr = -1; dr <= 1; dr++) {
      const rr = Math.max(0, Math.min(resolution - 1, row + dr));
      for (let dc = -1; dc <= 1; dc++) {
        const cc = Math.max(0, Math.min(resolution - 1, col + dc));
        const soundType = grid[rr * resolution + cc] ?? 1;
        if (soundType < counts.length) counts[soundType]++;
      }
    }
    let best = grid[row * resolution + col] ?? 1;
    for (let soundType = 0; soundType < counts.length; soundType++) {
      if (counts[soundType] > counts[best]) best = soundType;
    }
    return best;
  }

  sampleHeight(rx: number, ry: number): number {
    const world = this.localToWorld(rx, ry), tile = this.findTileAtWorld(world.x, world.y);
    if (!tile) return Number.NEGATIVE_INFINITY;
    return sampleTileHeight(tile, world.x, world.y, this.sampleMaskPoint, this.sampleMaskScratch);
  }
  sampleLoadedHeight(rx: number, ry: number): number | null { const world = this.localToWorld(rx, ry); return this.findTileAtWorld(world.x, world.y) ? this.sampleHeight(rx, ry) : null; }

  private async loadTileFresh(entry: TileEntry, generation: number, signal: AbortSignal) {
    const tileLoadStarted = performance.now(), base = `/terrain/tiles/${entry.key}`, effectOwnerKey = `${entry.key}@${generation}`;
    const buildIsCurrent = () => generation === this.loadGeneration
      && tileWithinRequestedNeighborhood(this.deps.tileIndex, this.requestedNeighborhoodKey, entry);
    const fetchWithSignal = ((input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, { ...init, signal })) as typeof fetch;
    const core = await loadTileCoreFiles(base, () => loadWmoBinary(base, signal), fetchWithSignal), terrainHydrationStarted = performance.now();
    if (!buildIsCurrent()) throw new Error(`tile ${entry.key}: load superseded before hydration`);
    const meta = core.meta, n: number = meta.n; validateTileCoreBuffers(n, core);
    const heights = new Float32Array(core.heights);
    const holes = core.holes ? new Uint16Array(core.holes) : null;
    const step = TILE / (n - 1);
    const group = new StaticWorldGroup();
    const cooperativeHydration = !this.deps.loadingScreenVisible()
      && new URLSearchParams(location.search).get('worldhydration') !== 'sync';
    let buildCommitted = false, buildDisposed = false;
    const disposeUncommittedBuild = () => {
      if (buildDisposed || buildCommitted) return;
      buildDisposed = true;
      const belongsToBuild = (root: THREE.Object3D) => {
        for (let object: THREE.Object3D | null = root; object; object = object.parent) if (object === group) return true;
        return false;
      };
      for (let index = this.wmoVisibilityInstances.length - 1; index >= 0; index--) {
        if (belongsToBuild(this.wmoVisibilityInstances[index].root)) this.wmoVisibilityInstances.splice(index, 1);
      }
      this.deps.worldDoodadEffects.removeOwner(effectOwnerKey);
      this.disposeGroup(group);
    };
    const rejectIfSuperseded = (stage: string) => {
      if (buildIsCurrent()) return;
      disposeUncommittedBuild();
      throw new Error(`tile ${entry.key}: load superseded ${stage}`);
    };
    try {
    const collisionMeshes: THREE.Mesh[] = [], dbg = new URLSearchParams(location.search);
    const doodadCollisionRoot = hiddenCollisionRoot(group, `${entry.key}:doodad-collision`, !dbg.has('nodoodadcollision'));
    const wmoLiquids: WmoLiquidInstance[] = [];
    // The parallel core loader retains the transitional JSON fallback for newly baked developer
    // tiles. Shipped terrain uses the binary path.
    const wmoDataForTile = core.wmoData;
    for (const model of wmoDataForTile?.models ?? []) canonicalizeWmoModelGeometry(model);
    const clutterMasks = buildIndoorMasks(wmoDataForTile), indoorMasks = clutterMasks.filter((mask) => mask.maskTerrain);
    const innerHeights = core.innerHeights ? new Float32Array(core.innerHeights) : null;
    const terrainHydration = createWorldHydrationCheckpoint(`${entry.key}:terrain-build`, 'normal', 0.8, cooperativeHydration, { signal, ownerId: effectOwnerKey });
    let terrainBuild;
    try {
      terrainBuild = await buildTerrainGeometry({
        n, step, tileHalf: TILE_HALF, heights, innerHeights, holes, indoorMasks, hydration: terrainHydration,
      });
    } finally {
      terrainHydration.finish();
    }
    if (!buildIsCurrent()) terrainBuild.geometry.dispose();
    rejectIfSuperseded('after terrain geometry');
    const geo = terrainBuild.geometry, positions = terrainBuild.positions;
    const maskedTerrainTriangles = terrainBuild.maskedTriangles;
    const holedTerrainTriangles = terrainBuild.holedTriangles;
    const terrainNormals = innerHeights && core.normals ? new Float32Array(core.normals) : null;
    if (terrainNormals && terrainNormals.length === positions.length) geo.setAttribute('normal', new THREE.BufferAttribute(terrainNormals, 3));
    else geo.computeVertexNormals();

    recordRuntimeAttribution('world-hydration', `${entry.key}:terrain-geometry`, performance.now() - terrainHydrationStarted); let material: THREE.Material | null = null;
    let terrainMaterial: THREE.ShaderMaterial | null = null;
    if (meta.shader) {
      try {
        terrainMaterial = await createTerrainMaterial(
          {
            texArrayUrl: `${base}/tex_array.png`, compressedArrayUrl: meta.shader.compressedArrayUrl,
            chunkMapUrl: `${base}/chunk_map.bin`,
            splatUrl: `${base}/splat_atlas.png`,
            shadowUrl: `${base}/shadow_atlas.png`,
            texCount: meta.shader.texCount,
            texSize: meta.shader.texSize,
            layerScale: meta.shader.layerScale,
            compressedMipUrl: `${base}/tex_array_mips.bin`,
            compressedMipFormat: meta.shader.compressedMipFormat,
            mipLevels: meta.shader.mipLevels,
          },
          this.deps.getActiveLight(),
          this.deps.supportsS3tc, this.deps.getTerrainTuning().anisotropy,
        );
        material = terrainMaterial;
      } catch (e) {
        this.deps.log('terrain shader failed, using ground.png: ' + (e as Error).message);
      }
    }
    if (!material) {
      try {
        const tex = await this.deps.textureLoader.loadAsync(`${base}/ground.png`);
        this.deps.configureTexture(tex, { repeat: true });
        material = new THREE.MeshLambertMaterial({ map: tex });
      } catch {
        material = new THREE.MeshLambertMaterial({ color: 0x6a7b54 });
      }
    }
    const terrainMesh = new THREE.Mesh(geo, material); terrainMesh.userData.vanillaPerfCategory = 'terrain'; registerTerrainSubmission(terrainMesh);
    const exteriorMeshes: THREE.Object3D[] = [terrainMesh]; group.add(terrainMesh);
    if (indoorMasks.length) this.deps.log(`tile ${entry.key}: ${indoorMasks.length} indoor terrain mask(s), ${maskedTerrainTriangles} terrain tris culled`);
    if (holedTerrainTriangles) this.deps.log(`tile ${entry.key}: ${holedTerrainTriangles} terrain tris culled by ADT holes`);

    const renderInstanced = async (jsonName: string, label: string, grass = false) => {
      await renderInstancedDoodads({
        base,
        jsonName,
        label,
        grass,
        tileKey: entry.key,
        effectOwnerKey,
        group,
        textureLoader: this.deps.textureLoader,
        configureTexture: this.deps.configureTexture,
        indoorMasks: clutterMasks,
        tileGroupOffsetX: ((meta.originX ?? 0) - TILE_HALF) - this.renderOriginX,
        tileGroupOffsetY: ((meta.originY ?? 0) - TILE_HALF) - this.renderOriginY,
        effectFocus: this.deps.getEffectFocus(),
        worldDoodadEffects: this.deps.worldDoodadEffects,
        getActiveLight: this.deps.getActiveLight,
        registerGrassMaterial: (m) => this.grassMaterials.add(m),
        collisionGroup: doodadCollisionRoot, onCollisionMesh: !dbg.has('nodoodadcollision') && (jsonName === 'doodads.json' || jsonName === 'wmo_doodads.json') ? (mesh) => collisionMeshes.push(mesh) : undefined,
        isCurrent: buildIsCurrent,
        signal,
        cooperativeHydration,
        worldDetail: this.deps.getWorldDetail?.(), getWorldDetail: this.deps.getWorldDetail, log: this.deps.log,
      });
    };

    const renderWmos = async () => {
      const wmoStarted = performance.now();
      const wmoHydration = createWorldHydrationCheckpoint(`${entry.key}:wmo-build`, 'normal', 0.8, cooperativeHydration, { signal, ownerId: effectOwnerKey });
      const checkpointWmo = async () => {
        await wmoHydration.checkpoint();
        if (!buildIsCurrent()) throw new Error('superseded during cooperative WMO build');
      };
      try {
        const wmoData: any = wmoDataForTile;
        if (!wmoData?.instances?.length) return;
        // Resolve ownership first so non-owner tiles avoid wasted WMO fetch, decode, and retained heap.
        const ownsInstance = (inst: any): boolean => {
          if (typeof inst.ownerKey === 'string') return inst.ownerKey === entry.key;
          const owner = tileForCharacter(this.deps.tileIndex, {
            map: this.deps.getCurrentMap(),
            x: ((meta.originX ?? 0) - TILE_HALF) + inst.x,
            y: ((meta.originY ?? 0) - TILE_HALF) + inst.y,
            z: inst.z,
          });
          return !owner || owner.key === entry.key;
        };
        const ownedInstances = (wmoData.instances as any[]).filter(ownsInstance);
        if (!ownedInstances.length) return;
        const collisionSidecarPromise = loadWmoBvhSidecar(base, wmoData, signal);
        const textures: (THREE.Texture | null)[] = await Promise.all(
          (wmoData.textures as string[]).map((u) =>
            loadWorldTexture(this.deps.textureLoader, this.deps.configureTexture, `${base}/${u}`, { repeat: true }, group, signal),
          ),
        );
        const flat = new THREE.MeshLambertMaterial({ color: 0x8a7f70, side: THREE.DoubleSide });
        const collisionBuilds: Promise<void>[] = [];
        const collisionSidecars = await collisionSidecarPromise;
        const matCache = new globalThis.Map<string, THREE.Material>();
        let sourceWmoBatches = 0, submittedWmoBatches = 0;
        const createInteriorMaterial = (
          modelIndex: number,
          tex: number,
          tex2: number,
          shader: number,
          blendMode: number,
          flags: number,
          groupData: any,
          modelData: any,
        ): THREE.Material => {
          const lightRefs = Array.isArray(groupData.lightRefs) ? groupData.lightRefs : [];
          const cacheKey = wmoInteriorMaterialCacheKey({
            modelIndex,
            tex,
            tex2,
            shader,
            blendMode,
            flags,
            hasVertexColors: !!groupData.colors?.length,
            lightRefs,
          });
          const cached = matCache.get(cacheKey);
          if (cached) return cached;

          const texture = tex >= 0 ? textures[tex] : null;
          const localLights = lightRefs
            .map((ref: number) => modelData.lights?.[ref])
            .filter((l: any) => l && l.type === 0 && Array.isArray(l.pos))
            .slice(0, WMO_LOCAL_LIGHTS);
          const lightPos = Array.from({ length: WMO_LOCAL_LIGHTS }, () => new THREE.Vector3());
          const lightColor = Array.from({ length: WMO_LOCAL_LIGHTS }, () => new THREE.Vector3());
          const lightAtten = Array.from({ length: WMO_LOCAL_LIGHTS }, () => new THREE.Vector2());
          localLights.forEach((l: any, i: number) => {
            // MOLT positions stay in WMO model space — the same space as the `position` attribute
            // these uniforms are differenced against. Baking the instance transform in here instead
            // produced a TILE-LOCAL light while the shader's modelMatrix yields render space, so
            // every room away from the render-origin tile was lit from (tileCentre - renderOrigin)
            // yards off. WMO instances carry no scale, so model-space distance == world distance.
            lightPos[i].set(l.pos[0], l.pos[1], l.pos[2]);
            const intensity = Number.isFinite(l.intensity) ? l.intensity : 1;
            const color = (l.color ?? [1, 1, 1]) as [number, number, number];
            lightColor[i].set(color[0] * intensity, color[1] * intensity, color[2] * intensity);
            lightAtten[i].set(l.attenStart ?? 0, l.attenEnd ?? 8);
          });
          const ambient = (modelData.ambient ?? [0, 0, 0]) as [number, number, number];
          const transparent = blendMode >= 2;
          const shaderMaterial = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: WMO_INTERIOR_VERT,
            fragmentShader: WMO_INTERIOR_FRAG,
            uniforms: {
              uMap: { value: texture },
              uHasMap: { value: texture ? 1 : 0 },
              uFallbackColor: { value: new THREE.Vector3(0.54, 0.50, 0.44) },
              uAlphaTest: { value: blendMode === 1 ? 25 / 255 : 0 },
              uUnlit: { value: flags & MOMT_UNLIT ? 1 : 0 },
              uUnfogged: { value: flags & 0x02 ? 1 : 0 },
              uSelfIllum: { value: 0 },
              uNight: { value: this.deps.getActiveLight().night },
              uAmbient: { value: new THREE.Vector3(ambient[0], ambient[1], ambient[2]) },
              uHasVertexColor: { value: groupData.colors?.length ? 1 : 0 },
              uLightCount: { value: localLights.length },
              uLightPos: { value: lightPos },
              uLightColor: { value: lightColor },
              uLightAtten: { value: lightAtten },
              uFogColor: { value: new THREE.Vector3(...this.deps.getActiveLight().fogColor) },
              uFogNear: { value: this.deps.getActiveLight().fogNear },
              uFogFar: { value: this.deps.getActiveLight().fogFar },
              uSunDir: { value: this.deps.getActiveLight().sunDir.clone().normalize() },
              uSunColor: { value: new THREE.Vector3(...this.deps.getActiveLight().sunColor) },
              uOutdoorAmbient: { value: new THREE.Vector3(...this.deps.getActiveLight().ambient) },
            },
            side: (flags & MOMT_TWO_SIDED) ? THREE.DoubleSide : THREE.FrontSide,
            transparent,
            depthWrite: !transparent,
            blending:
              blendMode === 3 || blendMode === 4
                ? THREE.AdditiveBlending
                : blendMode === 5 || blendMode === 6
                  ? THREE.MultiplyBlending
                  : THREE.NormalBlending,
          });
          this.wmoInteriorMaterials.add(shaderMaterial);
          shaderMaterial.userData.wowShader = shader;
          shaderMaterial.userData.wowSecondaryTexture = tex2 >= 0 ? textures[tex2] : null;
          matCache.set(cacheKey, shaderMaterial);
          return shaderMaterial;
        };
        const getMaterial = (tex: number, tex2: number, shader: number, blendMode: number, flags: number, hasVertexColors: boolean, interior: boolean): THREE.Material => {
          const texture = tex >= 0 ? textures[tex] : null;
          const cacheKey = `${tex}_${tex2}_${shader}_${blendMode}_${flags}_${hasVertexColors ? 1 : 0}_${interior ? 1 : 0}`;
          let mat = matCache.get(cacheKey);
          if (!mat) {
            const side = (flags & MOMT_TWO_SIDED) ? THREE.DoubleSide : THREE.FrontSide;
            const transparent = blendMode >= 2;
            const light = this.deps.getActiveLight();
            const shaderMaterial = new THREE.ShaderMaterial({
              glslVersion: THREE.GLSL3,
              vertexShader: WMO_EXTERIOR_VERT,
              fragmentShader: WMO_EXTERIOR_FRAG,
              uniforms: {
                uMap: { value: texture },
                uHasMap: { value: texture ? 1 : 0 },
                uFallbackColor: { value: new THREE.Vector3(0.54, 0.50, 0.44) },
                uAlphaTest: { value: blendMode === 1 ? 25 / 255 : 0 },
                uUnlit: { value: flags & MOMT_UNLIT ? 1 : 0 },
                uUnfogged: { value: flags & 0x02 ? 1 : 0 },
                uAdditive: { value: blendMode === 3 || blendMode === 4 ? 1 : 0 },
                // SIDN, and WINDOW which is authored alongside it on lit-window materials (0x28 =
                // EXTLIGHT|WINDOW is the single most common non-zero combination in the corpus).
                uSelfIllum: { value: flags & (MOMT_SIDN | MOMT_WINDOW) ? 1 : 0 },
              uNight: { value: this.deps.getActiveLight().night },
                uHasVertexColor: { value: hasVertexColors ? 1 : 0 },
                uAmbient: { value: new THREE.Vector3(...light.ambient) },
                uSunDir: { value: light.sunDir.clone().normalize() },
                uSunColor: { value: new THREE.Vector3(...light.sunColor) },
                uFogColor: { value: new THREE.Vector3(...light.fogColor) },
                uFogNear: { value: light.fogNear },
                uFogFar: { value: light.fogFar },
              },
              side,
              transparent,
              depthWrite: !transparent,
              blending:
                blendMode === 3 || blendMode === 4
                  ? THREE.AdditiveBlending
                  : blendMode === 5 || blendMode === 6
                    ? THREE.MultiplyBlending
                    : THREE.NormalBlending,
            });
            this.wmoExteriorMaterials.add(shaderMaterial);
            shaderMaterial.userData.wowShader = shader;
            shaderMaterial.userData.wowSecondaryTexture = tex2 >= 0 ? textures[tex2] : null;
            mat = shaderMaterial;
            matCache.set(cacheKey, mat);
          }
          return mat;
        };

        // Ownership was already resolved above (ownsInstance); a large root overlapping multiple ADTs
        // renders only from its elected owner tile (City_01: 3,029 batches per copy otherwise).
        for (const inst of ownedInstances) {
          const model = wmoData.models[inst.m];
          if (!model) continue;
          const wmoGroup = new THREE.Group();
          wmoGroup.position.set(inst.x, inst.y, inst.z);
          // QA pick metadata (`__wowPick(true)` raycasts and prints this). Cheap: a few fields per
          // WMO instance, not per batch, so it costs nothing at render time.
          wmoGroup.userData.wmoPick = {
            kind: 'wmo',
            tile: entry.key,
            uniqueId: inst.id,
            model: model.name,
            ownerKey: inst.ownerKey ?? null,
            local: { x: inst.x, y: inst.y, z: inst.z },
            quat: { x: inst.qx, y: inst.qy, z: inst.qz, w: inst.qw },
            groupCount: model.groups?.length ?? 0,
          };
          const wmoBatchExperiment = createWmoBatchExperimentBuilder(model.name ?? '', wmoGroup);
          if (new URLSearchParams(location.search).has('wmolog')) {
            const nm = (model.name ?? '').split('\\').pop();
            this.deps.log(`WMO ${nm} render(${inst.x.toFixed(0)},${inst.y.toFixed(0)},${inst.z.toFixed(0)}) q(${inst.qx.toFixed(2)},${inst.qy.toFixed(2)},${inst.qz.toFixed(2)},${inst.qw.toFixed(2)})`);
          }
          const sp = new URLSearchParams(location.search);
          const noInv = sp.get('wmonoinv') !== null;
          const extraYaw = (Number(sp.get('wmoyaw') ?? 0) * Math.PI) / 180;
          const q = new THREE.Quaternion(inst.qx, inst.qy, inst.qz, noInv ? -inst.qw : inst.qw);
          if (extraYaw) q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), extraYaw));
          wmoGroup.quaternion.copy(q);
          const visibilityGroups: WmoVisibilityGroup[] = [];
          for (let groupIndex = 0; groupIndex < (model.groups?.length ?? 0); groupIndex++) {
            const g = model.groups[groupIndex];
            const isInteriorGroup = (g.flags & 0x2000) !== 0;
            // 0x0008 and 0x0040. Large city roots (notably City_01) combine 0x40
            // with 0x2000, but the reversed classification never tests 0x2000.
            const usesOutdoorLighting = wmoGroupUsesOutdoorLighting(g.flags ?? 0);
            const groupObjects: THREE.Object3D[] = [];
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(g.positions, 3));
            if (g.normals?.length) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(g.normals, 3));
            if (g.uvs?.length) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(g.uvs, 2));
            if (g.colors?.length) {
              const floatColors = Float32Array.from(g.colors, (c: number) => c / 255);
              geometry.setAttribute('color', new THREE.Float32BufferAttribute(floatColors, 4));
            } else {
              const count = geometry.getAttribute('position').count;
              // Shaders always bind wmoColor, but uHasVertexColor keeps this zero
              // fallback from entering the lighting equation.
              geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 4), 4));
            }
            // Binary WMO decoding returns typed index arrays while the JSON fallback
            // returns plain arrays. Three only auto-wraps the latter.
            geometry.setIndex(Array.isArray(g.indices) ? g.indices : new THREE.BufferAttribute(g.indices, 1));
            if (!g.normals?.length) geometry.computeVertexNormals();
            if (!g.uvs?.length) {
              geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 2), 2));
            }
            let groupCollisionBoundsReady = false;
            const renderBatches = prepareWmoRenderBatches(g.indices, g.batches ?? []);
            sourceWmoBatches += g.batches?.length ?? 0;
            submittedWmoBatches += renderBatches.length;
            for (const batch of renderBatches) {
              const batchGeometry = new THREE.BufferGeometry();
              batchGeometry.setAttribute('position', geometry.getAttribute('position'));
              batchGeometry.setAttribute('normal', geometry.getAttribute('normal'));
              batchGeometry.setAttribute('uv', geometry.getAttribute('uv'));
              const colorAttribute = geometry.getAttribute('color');
              batchGeometry.setAttribute('color', colorAttribute);
              batchGeometry.setAttribute('wmoColor', colorAttribute);
              batchGeometry.setIndex(batch.mergedIndices
                ? new THREE.BufferAttribute(batch.mergedIndices, 1)
                : geometry.getIndex());
              batchGeometry.setDrawRange(batch.indexStart, batch.indexCount);
              setWmoBatchGeometryBounds(batchGeometry, g.positions, batchGeometry.getIndex()!.array, batch.indexStart, batch.indexCount);
              const material = usesOutdoorLighting
                ? getMaterial(batch.tex, batch.tex2 ?? -1, batch.shader ?? 0, batch.blendMode, batch.flags, !!g.colors?.length, false)
                : createInteriorMaterial(inst.m, batch.tex, batch.tex2 ?? -1, batch.shader ?? 0, batch.blendMode, batch.flags, g, model);
              const pick = {
                kind: 'wmoBatch',
                groupIndex,
                groupFlags: g.flags,
                interiorGroup: isInteriorGroup,
                usesOutdoorLighting,
                tex: batch.tex,
                blendMode: batch.blendMode,
                mergedBatchCount: batch.mergedBatchCount,
              };
              const mesh = new THREE.Mesh(batchGeometry, material);
              mesh.userData.wmoPick = pick;
              wmoGroup.add(mesh); instrumentWmoBatch(mesh, `${entry.key}:${inst.id}:${groupIndex}`);
              groupObjects.push(mesh);
              if (usesOutdoorLighting && batch.blendMode <= 1) wmoBatchExperiment?.consider({ mesh, groupObjects, groupIndex, mergedBatchCount: batch.mergedBatchCount });
              await checkpointWmo();
            }
            await registerLiveWorldRoom(model.name ?? '', groupIndex, wmoGroup, groupObjects, this.deps.camera, g);
            if (g.liquid) {
              const liquidMesh = createWmoLiquidMesh(g.liquid);
              if (liquidMesh) {
                wmoGroup.add(liquidMesh);
                groupObjects.push(liquidMesh);
                wmoLiquids.push({ id: `${entry.key}:${inst.id}:${groupIndex}`, root: wmoGroup, mesh: liquidMesh, liquid: g.liquid });
              }
            }
            const hasExplicitCollisionGroups = Array.isArray(g.collisionGroups) && g.collisionGroups.length;
            const collisionGroups = hasExplicitCollisionGroups
              ? g.collisionGroups
              : [{ terrainType: wmoTerrainType(model.name ?? ''), indices: g.collisionIndices ?? [] }];
            for (let materialIndex = 0; materialIndex < collisionGroups.length; materialIndex++) {
              const collisionGroup = collisionGroups[materialIndex] as { terrainType: number; indices: number[] };
              if (!collisionGroup.indices?.length) continue;
              const collisionGeometry = new THREE.BufferGeometry();
              collisionGeometry.setAttribute('position', geometry.attributes.position);
              collisionGeometry.setIndex(
                Array.isArray(collisionGroup.indices)
                  ? collisionGroup.indices
                  : new THREE.BufferAttribute(collisionGroup.indices, 1),
              );
              if (!groupCollisionBoundsReady) {
                geometry.computeBoundingBox();
                geometry.computeBoundingSphere();
                groupCollisionBoundsReady = true;
              }
              collisionGeometry.boundingBox = geometry.boundingBox?.clone() ?? null;
              collisionGeometry.boundingSphere = geometry.boundingSphere?.clone() ?? null;
              const surfaceIndex = hasExplicitCollisionGroups ? materialIndex : -1;
              if (!attachWmoBvhSidecar(collisionGeometry, collisionSidecars, inst.m, groupIndex, surfaceIndex)) {
                collisionBuilds.push(scheduleCollisionBvh(
                  collisionGeometry,
                  `${entry.key}:${inst.id}:group${groupIndex}:surface${materialIndex}`, signal,
                ));
              }
              const collisionMesh = new THREE.Mesh(collisionGeometry, flat);
              collisionMesh.visible = false;
              Object.assign(collisionMesh.userData, { wowCollision: true, wowCollisionSource: 'wmo' });
              collisionMesh.userData.terrainType = collisionGroup.terrainType;
              collisionMesh.userData.wowName = `${model.name}#group${model.groups.indexOf(g)}#surface${materialIndex}`;
              hiddenCollisionRoot(wmoGroup, `${entry.key}:${inst.id}:wmo-collision`).add(collisionMesh);
              collisionMeshes.push(collisionMesh);
              await checkpointWmo();
            }
            visibilityGroups[groupIndex] = {
              index: groupIndex,
              flags: g.flags ?? 0,
              bbox: Array.isArray(g.bbox) ? g.bbox : null,
              portalStart: Number.isFinite(g.portalStart) ? g.portalStart : 0,
              portalCount: Number.isFinite(g.portalCount) ? g.portalCount : 0,
              objects: groupObjects,
            };
            await checkpointWmo();
          }
          const batchedResult = wmoBatchExperiment?.finalize();
          if (batchedResult) { instrumentWmoBatch(batchedResult.mesh, `${entry.key}:${inst.id}:batched`); this.deps.log(`WMO batch experiment ${model.name}: ${batchedResult.sourceDraws}->${batchedResult.logicalRanges} logical ranges, ${batchedResult.groups} groups, material ${batchedResult.label}`); }
          group.add(wmoGroup);
          // Indoor lighting also consumes the point-to-group resolver. Retain instances without
          // portals too: MOBN/bbox membership remains useful even when visibility draws the model whole.
          if (visibilityGroups.length) {
            this.wmoVisibilityInstances.push({
              root: wmoGroup,
              model,
              groups: visibilityGroups,
              currentGroup: -1,
              lightingGroup: -1,
              localScratch: new THREE.Vector3(),
              lightingScratch: new THREE.Vector3(),
              resolvedCameraPoint: new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN),
              resolutionToken: -1,
            });
          }
          await checkpointWmo();
        }
        await Promise.all(collisionBuilds);
        const collisionTriangles = collisionMeshes.reduce((sum, mesh) => sum + Math.floor((mesh.geometry.index?.count ?? 0) / 3), 0);
        this.deps.log(`tile ${entry.key}: ${wmoData.instances.length} WMO buildings, ${collisionTriangles} collidable faces, ${sourceWmoBatches}->${submittedWmoBatches} render batches`);
      } catch (e) {
        this.deps.log(`WMO buildings load failed: ${(e as Error).message}`);
        throw e;
      } finally {
        wmoHydration.finish();
        recordRuntimeAttribution('world-hydration', `${entry.key}:wmo-buildings`, performance.now() - wmoStarted);
      }
    };

    if (dbg.get('nodoodads') === null && dbg.get('noterraindoodads') === null) {
      await renderInstanced('doodads.json', 'doodads');
      rejectIfSuperseded('after doodads');
    }
    if (dbg.get('nograss') === null) {
      await renderInstanced('grass.json', 'grass', true);
      rejectIfSuperseded('after grass');
    }
    if (dbg.get('nowmo') === null) {
      await renderWmos();
      rejectIfSuperseded('after WMO buildings');
      if (dbg.get('nodoodads') === null && dbg.get('nowmodoodads') === null) {
        await renderInstanced('wmo_doodads.json', 'WMO doodads');
        rejectIfSuperseded('after WMO doodads');
      }
    }

    let water: { grid: Float32Array; type: number } | null = null;
    if (dbg.get('nowater') === null) {
      const waterHydration = createWorldHydrationCheckpoint(`${entry.key}:water-build`, 'background', 0.8, cooperativeHydration, { signal, ownerId: effectOwnerKey });
      let loadedWater;
      try {
        loadedWater = await loadWaterSurface({
          base, n, step, tileHalf: TILE_HALF, signal, checkpoint: waterHydration.checkpoint,
        });
      } finally {
        waterHydration.finish();
      }
      rejectIfSuperseded('after water');
      if (loadedWater.mesh) {
        group.add(loadedWater.mesh);
        exteriorMeshes.push(loadedWater.mesh);
      }
      water = loadedWater.water;
    }

    let surfaceMap: LoadedTile['surfaceMap'] = null;
    const surfaceResolution = Number(meta.shader?.surfaceResolution ?? 0);
    if (surfaceResolution > 0) {
      const surfaceResponse = await fetch(`${base}/surface_map.bin`, { signal });
      const absent = surfaceResponse.status === 404 || surfaceResponse.headers.get('content-type')?.includes('text/html');
      if (!absent && !surfaceResponse.ok) throw new Error(`surface map failed: ${surfaceResponse.status} ${base}/surface_map.bin`);
      if (!absent) {
        const grid = new Uint8Array(await surfaceResponse.arrayBuffer());
        if (grid.length !== surfaceResolution * surfaceResolution) throw new Error(`surface map truncated: ${grid.length}/${surfaceResolution * surfaceResolution}`); surfaceMap = { grid, resolution: surfaceResolution };
      }
    }

    const tile: LoadedTile = {
      key: entry.key,
      entry,
      meta,
      centerX: (meta.originX ?? 0) - TILE_HALF,
      centerY: (meta.originY ?? 0) - TILE_HALF,
      n,
      step,
      heights,
      innerHeights,
      holes,
      indoorMasks,
      group,
      collisionMeshes,
      wmoLiquids,
      terrainMaterial,
      exteriorMeshes,
      surfaceMap,
      water,
    };
    group.userData.wowDoodadEffectOwnerKey = effectOwnerKey;
    for (const mesh of exteriorMeshes) mesh.visible = this.exteriorVisible;
    this.positionTileGroup(tile);
    await this.deps.prewarmObject(group, signal);
    if (this.loadedTiles.size > 0 && !this.deps.loadingScreenVisible()) stageWorldRenderAdmission(group);
    rejectIfSuperseded('before commit'); applyGroundEffectDetail(group, this.deps.getWorldDetail?.() ?? 2);
    for (const collisionMesh of collisionMeshes) this.deps.worldCollision.add(collisionMesh);
    this.deps.scene.add(group);
    this.loadedTiles.set(entry.key, tile);
    invalidateWmoLightCandidates(this.wmoVisibilityInstances);
    for (const liquid of wmoLiquids) this.indexLiquid(liquid);
    buildCommitted = true;
    this.reupsertTileEntities(entry);
    const tuning = this.deps.getTerrainTuning();
    if (terrainMaterial && (tuning.tex !== 128 || tuning.detail !== 1 || tuning.mip !== 0)) {
      terrainMaterial.uniforms.uLayerScale.value = tuning.tex;
      terrainMaterial.uniforms.uDetail.value = tuning.detail;
      terrainMaterial.uniforms.uMipBias.value = tuning.mip;
    }
    this.deps.log(`tile ${entry.key}: loaded`); recordRuntimeAttribution('world-hydration', `${entry.key}:tile-total`, performance.now() - tileLoadStarted);
    return tile;
    } finally {
      disposeUncommittedBuild();
    }
  }
  private reupsertTileEntities(entry: TileEntry) {
    const entityRenderer = this.deps.getEntityRenderer();
    const activeWorld = this.deps.getActiveWorld();
    if (!entityRenderer || !activeWorld) return;
    for (const e of activeWorld.getEntities({
      minX: entry.originX - TILE - 1, minY: entry.originY - TILE - 1,
      maxX: entry.originX + 1, maxY: entry.originY + 1,
    })) {
      if (e.x === undefined || e.y === undefined) continue;
      const owner = tileForCharacter(this.deps.tileIndex, { map: this.deps.getCurrentMap(), x: e.x, y: e.y, z: e.z ?? 0 });
      if (owner?.key === entry.key) entityRenderer.upsert(e);
    }
  }

  private positionTileGroup(tile: LoadedTile) {
    tile.group.position.set(tile.centerX - this.renderOriginX, tile.centerY - this.renderOriginY, 0);
    if (tile.group instanceof StaticWorldGroup) tile.group.refreshStaticWorldMatrices();
    else tile.group.updateMatrixWorld(true);
  }

  private indexLiquid(liquid: WmoLiquidInstance) {
    const bounds = wmoLiquidWorldBounds(liquid, this.liquidBounds);
    if (!bounds.isEmpty()) this.liquidSpatial.update(liquid.id, liquid, bounds.min.x, bounds.min.y, bounds.max.x, bounds.max.y);
  }

  private rebuildLiquidSpatialIndex() {
    this.liquidSpatial.clear();
    for (const tile of this.loadedTiles.values()) for (const liquid of tile.wmoLiquids) this.indexLiquid(liquid);
  }

  private disposeGroup(group: THREE.Group) {
    releaseLiveWorldGroup(group); invalidateWmoLightCandidates(this.wmoVisibilityInstances);
    const disposedGeometries = new Set<THREE.BufferGeometry>();
    const disposedMaterials = new Set<THREE.Material>();
    const disposedTextures = new Set<THREE.Texture>();
    const disposeTextureValue = (value: unknown) => {
      if (value instanceof THREE.Texture) {
        if (isSharedWorldTexture(value)) return;
        if (!disposedTextures.has(value)) {
          disposedTextures.add(value);
          value.dispose();
        }
        return;
      }
      if (Array.isArray(value)) for (const item of value) disposeTextureValue(item);
    };
    group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).dispose(); // Owns its instanced WebGL attributes.
      if (mesh.geometry && !disposedGeometries.has(mesh.geometry)) {
        disposedGeometries.add(mesh.geometry);
        // Free the collision BVH (WMO collision geometries only) so streamed-out tiles don't
        // retain their bounds trees. No-op for geometries without one.
        if (mesh.geometry.boundsTree) mesh.geometry.disposeBoundsTree();
        mesh.geometry.dispose();
      }
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (mat) {
        for (const material of Array.isArray(mat) ? mat : [mat]) {
          if (disposedMaterials.has(material)) continue;
          disposedMaterials.add(material);
          if (material instanceof THREE.ShaderMaterial) {
            this.wmoInteriorMaterials.delete(material);
            this.wmoExteriorMaterials.delete(material);
            this.grassMaterials.delete(material);
          }
          // Water materials and their animated frames are cached globally and
          // remain in use by neighboring tiles.
          if (material.userData.wowSharedMaterial) continue;
          disposeTextureValue((material as THREE.Material & { map?: THREE.Texture }).map);
          if (material instanceof THREE.ShaderMaterial) {
            for (const uniform of Object.values(material.uniforms)) disposeTextureValue(uniform?.value);
          }
          disposeTextureValue(material.userData.wowSecondaryTexture);
          material.dispose();
        }
      }
    });
    // Animated UV/colour registries are global update lists. Disposing a ShaderMaterial does not
    // remove it from those lists, so streamed-out tiles otherwise keep doing per-frame work forever.
    clearAnimatedUVs((material) => disposedMaterials.has(material) && !material.userData.wowSharedMaterial);
    clearDoodadAnimationsForGroup(group);
    clearDoodadCullingForGroup(group);
    clearWorldRenderAdmissionForGroup(group);
    releaseWorldTexturesForGroup(group);
  }

  private tileCoords(entry: TileEntry) {
    const m = /_(\d+)_(\d+)$/.exec(entry.key);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  }

  private entryByCoord(dir: string, x: number, y: number) {
    return tileByGridCoordinate(this.deps.tileIndex, dir, x, y);
  }

  private neighborEntries(entry: TileEntry) {
    const coords = this.tileCoords(entry);
    if (!coords) return [entry];
    const radius = tileStreamRadius(entry); const out: TileEntry[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const next = this.entryByCoord(entry.dir, coords.x + dx, coords.y + dy);
        if (next) out.push(next);
        else this.missingNeighbors.add(`${entry.dir}_${coords.x + dx}_${coords.y + dy}`);
      }
    }
    return out;
  }

  private findTileAtWorld(x: number, y: number) {
    const contains = (tile: LoadedTile) => x <= tile.centerX + TILE_HALF
      && x >= tile.centerX - TILE_HALF
      && y <= tile.centerY + TILE_HALF
      && y >= tile.centerY - TILE_HALF;
    // The active player tile is often the newest insertion. Checking it first prevents every
    // entity/blob-shadow height sample from walking the retained neighborhood on each frame.
    if (this.currentTile && contains(this.currentTile)) return this.currentTile;
    // Iterated directly rather than via `Array.from(...).find(...)`: this runs from `sampleHeight`
    // for the player, every blob shadow (4 extra samples each for slope), and every dead/airborne
    // unit, so the old snapshot array allocated garbage per entity per frame at 60Hz.
    for (const tile of this.loadedTiles.values()) {
      if (tile !== this.currentTile && contains(tile)) return tile;
    }
    return undefined;
  }
}

const wmoTerrainType = (modelName: string) => {
  const name = modelName.toLowerCase();
  if (/metal|iron|steel|goblin|gnome/.test(name)) return 2;
  if (/snow|ice|frost/.test(name)) return 4;
  if (/wood|timber|lumber|barn|farm|inn|tavern|house/.test(name)) return 5;
  return 3;
};
