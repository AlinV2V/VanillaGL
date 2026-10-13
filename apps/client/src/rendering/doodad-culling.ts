import * as THREE from 'three';
import { xrIntersectsSphere } from './xr-view-state';
import { setWorldRenderObjectVisible } from './world-render-admission';
import type { DoodadAnimationActivity } from './doodad-skeletal-animation';
import type { DoodadGeometryGroup } from './doodad-physical-batches';
/** Asset conversion utility. */
/** Byte-proven Build 5875 defaults and bounds. */
export const SMALL_CULL_DEFAULT = 0.04;
export const SMALL_CULL_MIN = 0.001;
export const SMALL_CULL_MAX = 2.0;
/** The client rejects a DistCull under 1.0 ("DistCull must be in range 1.0 - %f"). */
export const DIST_CULL_MIN = 1.0;

/** FUN_00488dd0 SetWorldDetail tables: Low, Medium, High. */
export const WORLD_DETAIL_SMALL_CULL = [0.07, 0.04, 0.01] as const;

export const smallCullForWorldDetail = (worldDetail: number): number => {
  const detail = Number.isFinite(worldDetail) ? Math.max(0, Math.min(2, Math.round(worldDetail))) : 1;
  return WORLD_DETAIL_SMALL_CULL[detail];
};

export const clampSmallCull = (value: number): number => {
  if (!Number.isFinite(value)) return SMALL_CULL_DEFAULT;
  return Math.min(SMALL_CULL_MAX, Math.max(SMALL_CULL_MIN, value));
};

export type DoodadCullBatch = {
  readonly mesh: THREE.InstancedMesh;
  /** Batch bounding-sphere centre, in the tile group's local space. */
  readonly centerX: number;
  readonly centerY: number;
  readonly centerZ: number;
  /** Radius of the whole spatial batch — used for frustum and distance tests. */
  readonly batchRadius: number;
  /** Radius of ONE instance — used for the screen-size test. */
  readonly objectRadius: number;
  /** Optional shader visibility limit, measured from the nearest point of the batch sphere. */
  readonly maxDrawDistance?: number;
  /** Index 0 is full geometry; following entries are progressively cheaper Meshopt LODs. */
  readonly lodIndices?: readonly THREE.BufferAttribute[];
  /** Multi-material draw groups paired one-for-one with lodIndices. */
  readonly lodGroups?: readonly (readonly DoodadGeometryGroup[])[];
  /** Switch distances for LOD 1, 2, ... in yards from the nearest point of the batch. */
  readonly lodDistances?: readonly number[];
  /** Shared by every spatial/material part driven by one skeletal animator. */
  readonly animationActivity?: DoodadAnimationActivity;
  currentLod?: number;
};

type CullGroup = {
  batches: DoodadCullBatch[];
  animationActivities: Set<DoodadAnimationActivity>;
  visible: boolean;
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
};
type Registry = Map<THREE.Object3D, CullGroup>;
const registry: Registry = new Map();
const worldCenter = new THREE.Vector3();
const frustumSphere = new THREE.Sphere();
const projectionScreenMatrix = new THREE.Matrix4();
const frustum = new THREE.Frustum();
const cumulativeStats = {
  passes: 0,
  becameVisible: 0,
  becameHidden: 0,
  visibilityChanges: 0,
  lodChanges: 0,
  peakChangesInOnePass: 0,
  hiddenBatchPassesSkipped: 0,
};

export const doodadCullingDiagnostics = () => ({ ...cumulativeStats });

/**
 * Bounding radius of one instance: the largest vertex distance from the mesh origin, scaled by the
 * biggest instance scale in the batch. Overestimating is safe — it only makes the cull later.
 */
export const instanceRadius = (positions: ArrayLike<number>, maxScale: number): number => {
  let maxSquared = 0;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const squared = positions[i] * positions[i] + positions[i + 1] * positions[i + 1] + positions[i + 2] * positions[i + 2];
    if (squared > maxSquared) maxSquared = squared;
  }
  return Math.sqrt(maxSquared) * (maxScale > 0 ? maxScale : 1);
};

/**
 * The distance past which one instance of `objectRadius` projects to less than `smallCull` of the
 * half-viewport height. Returns Infinity when the object can never be culled by size.
 */
export const smallCullDistance = (objectRadius: number, smallCull: number, verticalFovRadians: number): number => {
  const threshold = clampSmallCull(smallCull);
  const halfFovTangent = Math.tan(verticalFovRadians / 2);
  if (!(objectRadius > 0) || !(halfFovTangent > 0)) return Infinity;
  return objectRadius / (threshold * halfFovTangent);
};

/** Register a batch under its tile group, so unloading the tile drops it in one call. */
export const registerDoodadCullBatch = (group: THREE.Object3D, batch: DoodadCullBatch) => {
  let entry = registry.get(group);
  if (!entry) {
    entry = { batches: [], animationActivities: new Set(), visible: true, minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
    registry.set(group, entry);
  }
  entry.batches.push(batch);
  if (batch.animationActivity) entry.animationActivities.add(batch.animationActivity);
  entry.minX = Math.min(entry.minX, batch.centerX - batch.batchRadius);
  entry.minY = Math.min(entry.minY, batch.centerY - batch.batchRadius);
  entry.minZ = Math.min(entry.minZ, batch.centerZ - batch.batchRadius);
  entry.maxX = Math.max(entry.maxX, batch.centerX + batch.batchRadius);
  entry.maxY = Math.max(entry.maxY, batch.centerY + batch.batchRadius);
  entry.maxZ = Math.max(entry.maxZ, batch.centerZ + batch.batchRadius);
};

export const clearDoodadCullingForGroup = (group: THREE.Object3D) => {
  group.traverse((object) => registry.delete(object));
};

export const doodadCullBatchCount = () => {
  let total = 0;
  for (const entry of registry.values()) total += entry.batches.length;
  return total;
};

export type DoodadCullStats = {
  batches: number;
  groups?: number;
  groupsCulled?: number;
  culledBySize: number;
  culledByDistance: number;
  culledByFrustum?: number;
  becameVisible?: number;
  becameHidden?: number;
  visibilityChanges?: number;
  lodChanges?: number;
  lod0?: number;
  lod1?: number;
  lod2?: number;
};

function selectLod(batch: DoodadCullBatch, nearestDistance: number): number {
  if (!batch.lodIndices?.length || !batch.lodDistances?.length) return 0;
  let level = 0;
  for (let i = 0; i < batch.lodDistances.length; i++) {
    if (nearestDistance >= batch.lodDistances[i]) level = i + 1;
  }
  return Math.min(level, batch.lodIndices.length - 1);
}

function applyLod(batch: DoodadCullBatch, level: number): void {
  if (!batch.lodIndices?.length || batch.currentLod === level) return;
  const index = batch.lodIndices[level];
  if (!index) return;
  batch.mesh.geometry.setIndex(index);
  const groups = batch.lodGroups?.[level];
  if (groups) {
    batch.mesh.geometry.clearGroups();
    for (const group of groups) batch.mesh.geometry.addGroup(group.start, group.count, group.materialIndex);
  }
  batch.currentLod = level;
}

function recordAnimationActivity(batch: DoodadCullBatch, pass: number, visible = false, nearest = Infinity): void {
  const activity = batch.animationActivity;
  if (!activity) return;
  if (activity.cullPass !== pass) {
    activity.cullPass = pass;
    activity.visible = false;
    activity.nearestDistance = Number.POSITIVE_INFINITY;
  }
  if (visible) {
    activity.visible = true;
    activity.nearestDistance = Math.min(activity.nearestDistance, nearest);
  }
}

/**
 * Per-frame visibility pass. Batches are spatial cells rather than whole zones: first reject cells
 * outside the camera frustum, then apply Vanilla's distance/screen-size rules, then select a baked
 * Meshopt index-only LOD without touching vertex buffers or instance transforms.
 */
export const updateDoodadCulling = (
  camera: THREE.PerspectiveCamera,
  smallCull: number,
  distCull: number,
): DoodadCullStats => {
  const stats: Required<DoodadCullStats> = {
    batches: 0,
    groups: 0,
    groupsCulled: 0,
    culledBySize: 0,
    culledByDistance: 0,
    culledByFrustum: 0,
    becameVisible: 0,
    becameHidden: 0,
    visibilityChanges: 0,
    lodChanges: 0,
    lod0: 0,
    lod1: 0,
    lod2: 0,
  };
  const fov = (camera.fov * Math.PI) / 180;
  const maxDistance = Math.max(DIST_CULL_MIN, distCull);
  const cullPass = cumulativeStats.passes + 1;
  projectionScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projectionScreenMatrix);

  for (const [group, entry] of registry) {
    stats.groups++;
    const batches = entry.batches;
    worldCenter.set(
      (entry.minX + entry.maxX) / 2,
      (entry.minY + entry.maxY) / 2,
      (entry.minZ + entry.maxZ) / 2,
    ).applyMatrix4(group.matrixWorld);
    frustumSphere.center.copy(worldCenter);
    frustumSphere.radius = Math.hypot(entry.maxX - entry.minX, entry.maxY - entry.minY, entry.maxZ - entry.minZ) / 2;
    const groupNearest = Math.max(0, camera.position.distanceTo(worldCenter) - frustumSphere.radius);
    const groupVisible = xrIntersectsSphere(frustumSphere, frustum) && groupNearest <= maxDistance;
    stats.batches += batches.length;
    if (!groupVisible) {
      stats.groupsCulled++;
      const reason = groupNearest > maxDistance ? 'culledByDistance' : 'culledByFrustum';
      stats[reason] += batches.length;
      for (const activity of entry.animationActivities) {
        activity.cullPass = cullPass; activity.visible = false; activity.nearestDistance = Number.POSITIVE_INFINITY;
      }
      if (entry.visible) {
        for (const batch of batches) {
          if (batch.mesh.visible) { stats.becameHidden++; stats.visibilityChanges++; }
          setWorldRenderObjectVisible(batch.mesh, false);
        }
        entry.visible = false; group.visible = false;
      } else {
        cumulativeStats.hiddenBatchPassesSkipped += batches.length;
      }
      continue;
    }
    if (!entry.visible) { entry.visible = true; group.visible = true; }
    for (const batch of batches) {
      recordAnimationActivity(batch, cullPass);
      const wasVisible = batch.mesh.visible;
      const previousLod = batch.currentLod ?? 0;
      const parent = batch.mesh.parent;
      worldCenter.set(batch.centerX, batch.centerY, batch.centerZ);
      // Tile groups are updated when they are loaded or shifted. Object3D.localToWorld() calls
      // updateWorldMatrix() on every invocation; doing that once per spatial batch redundantly
      // walks the same static parent chain hundreds of times per frame.
      if (parent) worldCenter.applyMatrix4(parent.matrixWorld);
      frustumSphere.center.copy(worldCenter);
      frustumSphere.radius = batch.batchRadius;
      if (!xrIntersectsSphere(frustumSphere, frustum)) {
        setWorldRenderObjectVisible(batch.mesh, false);
        if (wasVisible) { stats.becameHidden++; stats.visibilityChanges++; }
        stats.culledByFrustum++;
        continue;
      }

      const nearest = Math.max(0, camera.position.distanceTo(worldCenter) - batch.batchRadius);
      if (nearest > Math.min(maxDistance, batch.maxDrawDistance ?? Number.POSITIVE_INFINITY)) {
        setWorldRenderObjectVisible(batch.mesh, false);
        if (wasVisible) { stats.becameHidden++; stats.visibilityChanges++; }
        stats.culledByDistance++;
        continue;
      }
      if (nearest > smallCullDistance(batch.objectRadius, smallCull, fov)) {
        setWorldRenderObjectVisible(batch.mesh, false);
        if (wasVisible) { stats.becameHidden++; stats.visibilityChanges++; }
        stats.culledBySize++;
        continue;
      }

      const lod = selectLod(batch, nearest);
      applyLod(batch, lod);
      if (lod !== previousLod) stats.lodChanges++;
      if (lod <= 0) stats.lod0++;
      else if (lod === 1) stats.lod1++;
      else stats.lod2++;
      const isVisible = setWorldRenderObjectVisible(batch.mesh, true, nearest);
      recordAnimationActivity(batch, cullPass, isVisible, nearest);
      if (!wasVisible && isVisible) { stats.becameVisible++; stats.visibilityChanges++; }
    }
  }
  cumulativeStats.passes++;
  cumulativeStats.becameVisible += stats.becameVisible;
  cumulativeStats.becameHidden += stats.becameHidden;
  cumulativeStats.visibilityChanges += stats.visibilityChanges;
  cumulativeStats.lodChanges += stats.lodChanges;
  cumulativeStats.peakChangesInOnePass = Math.max(cumulativeStats.peakChangesInOnePass, stats.visibilityChanges);
  return stats;
};
