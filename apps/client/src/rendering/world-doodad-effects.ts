import * as THREE from 'three';
import { SpellVisuals, type SpellModelAsset, type SpellVisualHandle } from '../spell-visuals';
import type { DoodadSkeleton } from './doodad-skeletons';
import { EnvironmentEffectBudget, environmentEffectRadius } from './environment-effect-budget';
import { qaGlobals } from '../qa-globals';

export type WorldDoodadEffectSpawnerOptions = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  disabled: boolean;
  radius?: number;
  maxPlacements?: number;
};

export class WorldDoodadEffectSpawner {
  private readonly visuals: SpellVisuals;
  private readonly disabled: boolean;
  private readonly radius: number;
  private readonly maxPlacements: number;
  private spawnedPlacements = 0;
  private readonly handlesByOwner = new Map<string, Set<SpellVisualHandle>>();
  private readonly budget = new EnvironmentEffectBudget(typeof location === 'undefined' || new URLSearchParams(location.search).get('effectbudget') !== 'off');
  private readonly camera: THREE.PerspectiveCamera;
  private readonly effectPos = new THREE.Vector3();
  private readonly effectQuat = new THREE.Quaternion();

  constructor(opts: WorldDoodadEffectSpawnerOptions) {
    this.camera = opts.camera;
    qaGlobals.__wowEnvironmentEffects = () => this.diagnostics();
    this.visuals = new SpellVisuals({ scene: opts.scene, camera: opts.camera, assetBase: '' });
    this.disabled = opts.disabled;
    this.radius = opts.radius ?? 220;
    this.maxPlacements = opts.maxPlacements ?? 420;
  }

  spawnForMesh(opts: {
    mesh: any;
    instanceIndices: number[];
    instances: any[];
    label: string;
    ownerKey: string;
    skeleton?: DoodadSkeleton | null;
    tileGroupOffsetX: number;
    tileGroupOffsetY: number;
    focus: THREE.Vector3;
  }) {
    const { mesh, instanceIndices, instances, label, ownerKey, skeleton, tileGroupOffsetX, tileGroupOffsetY, focus } = opts;
    if (this.disabled || !(mesh.particles?.length || mesh.ribbons?.length)) return;
    const asset: SpellModelAsset = {
      model: mesh.source ?? `${label}-effect`,
      particles: mesh.particles ?? [],
      ribbons: mesh.ribbons ?? [],
      geometry: null,
      ...(skeleton ? {
        animation: skeleton,
        timing: {
          globalSequences: skeleton.globalSequences ?? [],
          sequences: skeleton.sequences,
        },
      } : {}),
    };
    for (const idx of instanceIndices) {
      if (this.spawnedPlacements >= this.maxPlacements) break;
      const inst = instances[idx];
      this.effectPos.set(tileGroupOffsetX + inst.x, tileGroupOffsetY + inst.y, inst.z);
      if (this.effectPos.distanceTo(focus) > this.radius) continue;
      this.effectQuat.set(inst.qx ?? 0, inst.qy ?? 0, inst.qz ?? 0, inst.qw ?? 1).normalize();
      const position = this.effectPos.clone();
      const handle = this.visuals.spawnAsset(asset, {
        position,
        rotation: this.effectQuat.clone(),
        scale: inst.s ?? 1,
        durationMs: Number.POSITIVE_INFINITY,
        admitUpdate: this.budget.admission(position, environmentEffectRadius(asset, inst.s ?? 1)),
        onDispose: () => {
          const owned = this.handlesByOwner.get(ownerKey);
          if (owned?.delete(handle)) this.spawnedPlacements = Math.max(0, this.spawnedPlacements - 1);
          if (owned?.size === 0) this.handlesByOwner.delete(ownerKey);
        },
      });
      const owned = this.handlesByOwner.get(ownerKey);
      if (owned) owned.add(handle);
      else this.handlesByOwner.set(ownerKey, new Set([handle]));
      this.spawnedPlacements++;
    }
  }

  removeOwner(ownerKey: string) {
    const handles = this.handlesByOwner.get(ownerKey);
    if (!handles) return 0;
    let removed = 0;
    for (const handle of handles) if (this.visuals.remove(handle)) removed++;
    this.handlesByOwner.delete(ownerKey);
    return removed;
  }

  update(dt: number, elapsedDt = dt) {
    this.budget.prepare(this.camera);
    this.visuals.update(dt, elapsedDt);
  }

  clear() {
    this.visuals.clear();
    this.visuals.clearTextures();
    this.handlesByOwner.clear();
    this.spawnedPlacements = 0;
  }

  get activeCount() {
    return this.visuals.activeCount;
  }
  diagnostics() { return { active: this.activeCount, placements: this.spawnedPlacements, sampled: this.budget.sampled, skipped: this.budget.skipped }; }
}
