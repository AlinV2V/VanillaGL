import * as THREE from 'three';
import { bindGroundEffectDetail, groundEffectTier } from './ground-effect-detail';
import {
  clampBuild5875WorldDetail,
  groundEffectInstanceVisibleAtDetail,
} from './ground-effect-detail';
import { instanceRadius, registerDoodadCullBatch } from './doodad-culling';
import {
  buildSpatialDoodadBatchesProgressive,
  selectDoodadBatchPlan,
} from './spatial-doodad-batches';
import {
  applyDoodadGeometryGroups,
  buildDoodadPhysicalLayouts,
  doodadPhysicalMode,
} from './doodad-physical-batches';
import {
  createWorldHydrationCheckpoint,
  scheduleWorldHydrationSlices,
  scheduleWorldHydrationTask,
} from './world-hydration-scheduler';
import { isPointInIndoorMask, type IndoorMaskVolume } from './wmo-interiors';
import { WorldDoodadEffectSpawner } from './world-doodad-effects';
import { createGrassMaterial, grassBatchDrawDistance } from './grass-material';
import type { TerrainLight } from '../terrain-shader';
import { createM2Material } from '../m2-material';
import {
  prepareAnimatedMaterialOwnership,
  registerAnimatedMaterial,
  registerAnimatedMaterialOwner,
  registerAnimatedUV,
  type BakedMaterialColor,
  type BakedTrack,
  type BakedTransform,
} from './m2-texture-animation';
import { loadWorldTexture } from './world-texture-cache';
import { createM2Animator } from '../m2-animator';
import { loadDoodadSkeleton, type DoodadSkeleton } from './doodad-skeletons';
import { createDoodadAnimationActivity, registerDoodadAnimator } from './doodad-skeletal-animation';
import { buildSharedDoodadCollisionMeshes } from './doodad-collision';
import { scheduleCollisionBvh } from './collision-bvh';
import {
  decodeGrassBinary,
  GRASS_BINARY_FILE,
  GRASS_BINARY_FORMAT,
  type DecodedGrassBinary,
  type GrassBinaryCell,
} from './grass-binary-format';
import { measureRuntimeAttribution, recordRuntimeAttribution } from '../platform/runtime-attribution';
import { canonicalizeDoodadMeshGeometry } from './world-model-data-cache';
/** Asset conversion utility. */
const billboardPivotFor = (
  skeleton: DoodadSkeleton | null,
  part: { indices: ArrayLike<number> },
): [number, number, number] | null => {
  if (!skeleton?.bones?.length || !skeleton.boneIndices?.length) return null;
  let bone = -1;
  for (let offset = 0; offset < part.indices.length; offset++) {
    const index = part.indices[offset];
    const b = skeleton.boneIndices[index * 4];
    if (b === undefined) return null;
    if (bone === -1) bone = b;
    else if (bone !== b) return null;
  }
  if (bone < 0) return null;
  const flags = skeleton.bones[bone]?.flags ?? 0;
  if ((flags & 0x08) === 0) return null;
  const pivot = skeleton.bones[bone]?.pivot;
  return pivot ? [pivot[0], pivot[1], pivot[2]] : null;
};

const indexAttribute = (values: ArrayLike<number>) => {
  if (values instanceof Uint16Array || values instanceof Uint32Array) return new THREE.BufferAttribute(values, 1);
  let max = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
  return max <= 65535
    ? new THREE.BufferAttribute(Uint16Array.from(values), 1)
    : new THREE.BufferAttribute(Uint32Array.from(values), 1);
};

const lodAttributes = (part: { indices: ArrayLike<number>; lods?: Array<{ indices?: ArrayLike<number> }> }) => {
  const result = [indexAttribute(part.indices)];
  for (const lod of part.lods ?? []) {
    if (lod.indices?.length && lod.indices.length < part.indices.length) result.push(indexAttribute(lod.indices));
  }
  return result;
};

type PackedGrassCellSelection = {
  cell: GrassBinaryCell;
  /** Null means every instance in the baked contiguous range remains visible. */
  visibleIndices: number[] | null;
};

function compactSourceDiagnostics(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value ?? null;
  const { chunks, ...summary } = value as Record<string, unknown>;
  if (Array.isArray(chunks)) summary.chunkDiagnosticsCount = chunks.length;
  return summary;
}

async function verifyPackedSha256(buffer: ArrayBuffer, expected: unknown): Promise<void> {
  if (typeof expected !== 'string' || !expected || !globalThis.crypto?.subtle) return;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== expected.toLowerCase()) throw new Error('packed grass sha256 mismatch');
}

export type ConfigureWorldTexture = (tex: THREE.Texture, options?: { repeat?: boolean; flipY?: boolean }) => THREE.Texture;

export type RenderInstancedDoodadsOptions = {
  base: string;
  jsonName: string;
  label: string;
  grass?: boolean;
  tileKey: string;
  effectOwnerKey: string;
  group: THREE.Group;
  textureLoader: THREE.TextureLoader;
  configureTexture: ConfigureWorldTexture;
  indoorMasks: IndoorMaskVolume[];
  tileGroupOffsetX: number;
  tileGroupOffsetY: number;
  effectFocus: THREE.Vector3;
  worldDoodadEffects: WorldDoodadEffectSpawner;
  getActiveLight: () => TerrainLight;
  registerGrassMaterial: (material: THREE.ShaderMaterial) => void;
  /** Receives invisible M2 collision placements sharing one model-space BVH. */
  onCollisionMesh?: (mesh: THREE.Mesh) => void;
  /** Hidden tile-level parent that keeps collision-only meshes out of renderer traversal. */
  collisionGroup?: THREE.Group;
  /** False when a map clear superseded this asynchronous tile build. */
  isCurrent?: () => boolean;
  /**
   * Environment Detail (WorldDetail CVar, 0 Low / 1 Medium / 2 High). Ground clutter is baked at
   * the High count with each clump tagged by the tier that spawns it, so this drops the tiers the
   * client would not have scattered at this setting. See bake-grass.ts FRILL_DENSITY_BY_DETAIL.
   */
  worldDetail?: number; getWorldDetail?: () => number;
  log: (message: string) => void;
  signal?: AbortSignal;
  /** Loading screens own the frame, so cold-world hydration may complete without RAF slicing. */
  cooperativeHydration?: boolean;
};

export function selectGroundEffectInstanceIndices(
  instances: Array<{ d?: number }>,
  worldDetail: number | undefined,
): number[] {
  return instances.flatMap((instance, index) =>
    groundEffectInstanceVisibleAtDetail(instance, worldDetail) ? [index] : [],
  );
}

export const renderInstancedDoodads = async (opts: RenderInstancedDoodadsOptions) => {
  const {
    base,
    jsonName,
    label,
    grass = false,
    tileKey,
    effectOwnerKey,
    group,
    textureLoader,
    configureTexture,
    indoorMasks,
    tileGroupOffsetX,
    tileGroupOffsetY,
    effectFocus,
    worldDoodadEffects,
    getActiveLight,
    registerGrassMaterial,
    log,
    signal,
  } = opts;

  let hydration: ReturnType<typeof createWorldHydrationCheckpoint> | null = null;
  try {
    const manifestFetchStarted = performance.now();
    const response = await fetch(`${base}/${jsonName}`, { signal });
    if (!response.ok) throw new Error(`${jsonName} HTTP ${response.status}`);
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new Error(`${jsonName} returned ${response.headers.get('content-type') ?? 'no content type'}`);
    }
    // Meshopt's routed Response.json() hydrates typed geometry streams directly. Calling text()
    // would stringify that hydrated object and parsing it again would recreate the old JSON burst.
    const dd: any = await response.json();
    recordRuntimeAttribution(
      'asset-fetch', `${tileKey}:${jsonName}`, performance.now() - manifestFetchStarted,
      Number(response.headers.get('content-length') ?? 0),
    );
    if (opts.isCurrent && !opts.isCurrent()) return;
    if (dd.diagnostics?.status === 'not-applicable') {
      log(`tile ${tileKey}: ${label} not applicable (${dd.diagnostics.reason})`);
      return;
    }
    let legacyInstances: any[] | null = Array.isArray(dd.instances) ? dd.instances : null;
    let packedGrass: DecodedGrassBinary | null = null;
    const forcePackedGrass = grass && typeof location !== 'undefined'
      && new URLSearchParams(location.search).has('packedgrass');
    const packedDescriptor = dd.packedInstances?.format === GRASS_BINARY_FORMAT
      ? dd.packedInstances
      : forcePackedGrass ? { format: GRASS_BINARY_FORMAT, url: GRASS_BINARY_FILE } : null;
    if (grass && packedDescriptor) {
      const binaryName = String(packedDescriptor.url);
      try {
        const binaryFetchStarted = performance.now();
        const binaryResponse = await fetch(`${base}/${binaryName}`, { signal });
        if (!binaryResponse.ok) throw new Error(`${binaryName} HTTP ${binaryResponse.status}`);
        const contentType = binaryResponse.headers.get('content-type') ?? '';
        if (contentType.includes('text/html')) throw new Error(`${binaryName} returned HTML`);
        const binary = await binaryResponse.arrayBuffer();
        recordRuntimeAttribution('asset-fetch', `${tileKey}:${binaryName}`, performance.now() - binaryFetchStarted, binary.byteLength);
        await verifyPackedSha256(binary, packedDescriptor.sha256);
        packedGrass = measureRuntimeAttribution(
          'binary-decode', `${tileKey}:${binaryName}`,
          () => decodeGrassBinary(binary, packedDescriptor), binary.byteLength,
        );
      } catch (error) {
        log(`tile ${tileKey}: packed ${label} unavailable (${(error as Error).message}); using legacy fallback`);
        if (!legacyInstances && dd.packedInstances?.fallbackUrl) {
          const fallback = await fetch(`${base}/${dd.packedInstances.fallbackUrl}`, { signal });
          if (!fallback.ok) throw error;
          const fallbackManifest = await fallback.json();
          legacyInstances = Array.isArray(fallbackManifest.instances) ? fallbackManifest.instances : null;
        }
        if (!legacyInstances) throw error;
      }
    }
    if (!packedGrass && !legacyInstances) throw new Error(`${jsonName} has neither packed nor legacy instances`);
    const manifestInstanceCount = packedGrass?.instanceCount ?? legacyInstances?.length ?? 0;
    if (!manifestInstanceCount) {
      log(`tile ${tileKey}: 0 ${label} (${dd.diagnostics?.status ?? 'legacy manifest'})`);
      return;
    }
    const hydrationPriority = grass ? 'background' : 'normal';
    const cooperativeHydration = opts.cooperativeHydration
      ?? (typeof location === 'undefined' || new URLSearchParams(location.search).get('worldhydration') !== 'sync');
    const hydrationOwnership = { signal, ownerId: effectOwnerKey };
    hydration = createWorldHydrationCheckpoint(`${tileKey}:${jsonName}`, hydrationPriority, 1.1, cooperativeHydration, hydrationOwnership);
    for (let meshIndex = 0; meshIndex < dd.meshes.length; meshIndex++) {
      canonicalizeDoodadMeshGeometry(dd.meshes[meshIndex]);
      if ((meshIndex & 7) === 7) await hydration.checkpoint(meshIndex + 1);
    }
    const texes: (THREE.Texture | null)[] = await Promise.all(
      (dd.textures as string[]).map((u) =>
        // flipY stays FALSE for grass too: the grass PNGs come from the same BLP->PNG
        // pipeline as every other doodad texture (all loaded unflipped and correct).
        loadWorldTexture(textureLoader, configureTexture, `${base}/${u}`, { repeat: true, flipY: false }, group, signal),
      ),
    );
    if (opts.isCurrent && !opts.isCurrent()) return;
    const flat = new THREE.MeshLambertMaterial({ color: 0x55633c, side: THREE.DoubleSide });
    const matCache = new Map<string, THREE.Material>();
    const matFor = (
      part: { tex: number; blendMode?: number; renderFlags?: number; xf?: number; mc?: number; mw?: number },
      animation: { transforms: BakedTransform[]; colors: BakedMaterialColor[]; weights: BakedTrack[]; globalSequences: number[] } | undefined,
      meshKey: number,
      hasInstanceTint: boolean,
      billboardPivot: [number, number, number] | null,
      gpuSkinning: boolean,
    ): THREE.Material => {
      const tex = part.tex;
      if (tex < 0 || !texes[tex]) return flat;
      const blendMode = part.blendMode ?? 1;
      const renderFlags = part.renderFlags ?? 0x04;
      const xf = part.xf !== undefined && animation?.transforms[part.xf] ? part.xf : -1;
      const mc = part.mc !== undefined && animation?.colors[part.mc] ? part.mc : -1;
      const mw = part.mw !== undefined && animation?.weights[part.mw] ? part.mw : -1;
      const key = `${meshKey}:${tex}:${blendMode}:${renderFlags}:${xf}:${mc}:${mw}:${hasInstanceTint ? 1 : 0}:${billboardPivot ? billboardPivot.join(',') : 'x'}:${gpuSkinning ? 1 : 0}`;
      let m = matCache.get(key);
      if (!m) {
        if (grass) {
          const gm = createGrassMaterial(texes[tex]!, getActiveLight());
          registerGrassMaterial(gm);
          m = gm;
        } else {
          m = createM2Material({
            texture: texes[tex]!,
            blendMode,
            renderFlags,
            instanced: true,
            instanceTint: hasInstanceTint,
            animatedOpacity: mw >= 0 || !!animation?.colors[mc]?.a,
            billboardPivot,
            gpuSkinning,
          });
          if (xf >= 0 || mc >= 0 || mw >= 0) prepareAnimatedMaterialOwnership(m as THREE.ShaderMaterial);
          if (xf >= 0 && animation) registerAnimatedUV(m as THREE.ShaderMaterial, animation.transforms[xf], animation.globalSequences);
          if (animation && (mc >= 0 || mw >= 0)) {
            registerAnimatedMaterial(
              m as THREE.ShaderMaterial,
              mc >= 0 ? animation.colors[mc] : undefined,
              mw >= 0 ? animation.weights[mw] : undefined,
              animation.globalSequences,
            );
          }
        }
        matCache.set(key, m);
      }
      return m;
    };

    const suppressOutdoorClutter = indoorMasks.length > 0 && (jsonName === 'grass.json' || jsonName === 'doodads.json');
    const visibleInstanceIndices: number[] = [];
    const packedCellsByMesh: PackedGrassCellSelection[][] | null = packedGrass
      ? dd.meshes.map(() => [])
      : null;
    let maskedInstances = 0;
    const maskPoint = new THREE.Vector3();
    const maskScratch = new THREE.Vector3();
    const detailLevel = clampBuild5875WorldDetail(opts.worldDetail);
    let detailCulled = 0;
    if (packedGrass && packedCellsByMesh) {
      let visited = 0;
      for (const cell of packedGrass.cells) {
        const visible: number[] = [];
        const end = cell.instanceStart + cell.instanceCount;
        for (let index = cell.instanceStart; index < end; index++) {
          if (packedGrass.detailAt(index) > detailLevel) detailCulled++;
          if (suppressOutdoorClutter) {
            const matrixOffset = index * 16;
            maskPoint.set(
              packedGrass.matrices[matrixOffset + 12],
              packedGrass.matrices[matrixOffset + 13],
              packedGrass.matrices[matrixOffset + 14],
            );
            if (isPointInIndoorMask(maskPoint, indoorMasks, maskScratch, 0.6, 8)) maskedInstances++;
            else visible.push(index);
          } else {
            visible.push(index);
          }
          visited++;
          if ((visited & 127) === 0) await hydration.checkpoint(visited);
        }
        if (visible.length && packedCellsByMesh[cell.meshIndex]) {
          packedCellsByMesh[cell.meshIndex].push({
            cell,
            visibleIndices: visible.sort((a, b) => packedGrass.detailAt(a) - packedGrass.detailAt(b)),
          });
        }
      }
    } else {
      for (let i = 0; i < legacyInstances!.length; i++) {
        const inst = legacyInstances![i];
        if (!groundEffectInstanceVisibleAtDetail(inst, detailLevel)) detailCulled++;
        if (suppressOutdoorClutter) {
          maskPoint.set(inst.x ?? 0, inst.y ?? 0, inst.z ?? 0);
          if (isPointInIndoorMask(maskPoint, indoorMasks, maskScratch, 0.6, 8)) maskedInstances++;
          else visibleInstanceIndices.push(i);
        } else {
          visibleInstanceIndices.push(i);
        }
        if ((i & 127) === 127) await hydration.checkpoint(i + 1);
      }
    }
    const visibleInstanceCount = manifestInstanceCount - detailCulled - maskedInstances;
    if (manifestInstanceCount === maskedInstances) {
      if (maskedInstances) log(`tile ${tileKey}: ${maskedInstances} ${label} hidden by indoor masks`);
      return;
    }
    const batchRoot = new THREE.Group();
    batchRoot.name = `${tileKey}:${label}`;
    group.add(batchRoot);

    const byMesh: number[][] = dd.meshes.map(() => []);
    if (legacyInstances) for (let offset = 0; offset < visibleInstanceIndices.length; offset++) {
      const i = visibleInstanceIndices[offset];
      const inst = legacyInstances[i];
      if (inst?.m >= 0 && inst.m < byMesh.length) byMesh[inst.m].push(i);
      if ((offset & 127) === 127) await hydration.checkpoint(offset + 1);
    }
    const dummy = new THREE.Object3D();
    let sceneObjects = 0;
    let submittedInstances = 0;
    let spatialCells = 0;
    const collisionBuilds: Promise<void>[] = [];
    const skeletons = await Promise.all((dd.meshes as any[]).map((mesh) => loadDoodadSkeleton(mesh.source)));
    if (opts.isCurrent && !opts.isCurrent()) return;

    const rawBatchOverride = typeof location !== 'undefined'
      ? new URLSearchParams(location.search).get('doodadbatch')
      : null;
    const batchOverride = rawBatchOverride === 'whole' || rawBatchOverride === 'spatial' ? rawBatchOverride : null;
    const physicalMode = doodadPhysicalMode(typeof location !== 'undefined' ? location.search : '');
    const batchPolicyCounts: Record<string, number> = {};
    let groupedSceneObjects = 0;
    for (let mi = 0; mi < dd.meshes.length; mi++) {
      const m: any = dd.meshes[mi];
      const allInsts = byMesh[mi];
      const packedCells = packedCellsByMesh?.[mi] ?? [];
      if (!allInsts.length && !packedCells.length) continue;
      const skeleton = skeletons[mi];
      if (legacyInstances) {
        worldDoodadEffects.spawnForMesh({
          mesh: m,
          instanceIndices: allInsts,
          instances: legacyInstances,
          label: `${label}-${mi}`,
          ownerKey: effectOwnerKey,
          skeleton,
          tileGroupOffsetX,
          tileGroupOffsetY,
          focus: effectFocus,
        });
      }

      const matrixBySource = new Map<number, THREE.Matrix4>();
      let sourceMaxScale = 1;
      for (let matrixIndex = 0; legacyInstances && matrixIndex < allInsts.length; matrixIndex++) {
        const idx = allInsts[matrixIndex];
        const inst = legacyInstances[idx];
        dummy.position.set(inst.x, inst.y, inst.z);
        dummy.quaternion.set(inst.qx ?? 0, inst.qy ?? 0, inst.qz ?? 0, inst.qw ?? 1);
        dummy.scale.setScalar(inst.s);
        sourceMaxScale = Math.max(sourceMaxScale, Number(inst.s) || 1);
        dummy.updateMatrix();
        matrixBySource.set(idx, dummy.matrix.clone());
        if ((matrixIndex & 127) === 127) await hydration.checkpoint(matrixIndex + 1);
      }
      if (opts.onCollisionMesh && legacyInstances) {
        const collision = buildSharedDoodadCollisionMeshes(
          m.collision,
          allInsts.map((idx) => matrixBySource.get(idx)!),
          flat,
          m.source,
        );
        if (collision) {
          const collisionParent = opts.collisionGroup ?? batchRoot;
          for (const collisionMesh of collision.meshes) collisionParent.add(collisionMesh);
          collisionBuilds.push(scheduleCollisionBvh(collision.geometry, `${tileKey}:${m.source}:m2`, signal).then(() => {
            if (!opts.isCurrent || opts.isCurrent()) {
              for (const collisionMesh of collision.meshes) opts.onCollisionMesh?.(collisionMesh);
            }
          }));
        }
      }
      if (!m.parts?.length) continue;

      const hasAnimation = !!(m.texXf?.length || m.matColor?.length || m.matWeight?.length);
      const meshAnimation = hasAnimation ? {
        transforms: (m.texXf as BakedTransform[]) ?? [],
        colors: (m.matColor as BakedMaterialColor[]) ?? [],
        weights: (m.matWeight as BakedTrack[]) ?? [],
        globalSequences: (m.gs as number[]) ?? [],
      } : undefined;
      const posAttr = new THREE.Float32BufferAttribute(m.positions, 3);
      const normalAttr = skeleton && skeleton.normals.length === m.positions.length
        ? new THREE.Float32BufferAttribute(skeleton.normals, 3)
        : null;
      const sourceNormalAttr = m.normals?.length === m.positions.length
        ? new THREE.Float32BufferAttribute(m.normals, 3)
        : null;
      const animator = skeleton && normalAttr
        ? createM2Animator({ ...skeleton, positions: m.positions }, posAttr, normalAttr)
        : null;
      const animationActivity = animator ? createDoodadAnimationActivity() : undefined;
      const uvAttr = m.uvs?.length ? new THREE.Float32BufferAttribute(m.uvs, 2) : null;
      const grassNormalAttr = grass ? (() => {
        const up = new Float32Array(m.positions.length);
        for (let i = 2; i < up.length; i += 3) up[i] = 1;
        return new THREE.BufferAttribute(up, 3);
      })() : null;
      const partRuntimes = (m.parts as any[]).map((part, partIndex) => {
        const lodIndices = lodAttributes(part);
        let renderNormalAttr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null =
          grassNormalAttr ?? normalAttr ?? sourceNormalAttr;
        if (!renderNormalAttr) {
          const normalGeometry = new THREE.BufferGeometry();
          normalGeometry.setAttribute('position', posAttr);
          normalGeometry.setIndex(lodIndices[0]);
          normalGeometry.computeVertexNormals();
          renderNormalAttr = normalGeometry.getAttribute('normal');
        }
        return {
          part,
          partIndex,
          lodIndices,
          renderNormalAttr,
          billboardPivot: billboardPivotFor(skeleton, part),
        };
      });
      const physicalLayouts = buildDoodadPhysicalLayouts(partRuntimes, physicalMode);
      if (packedGrass && packedCells.length) {
        spatialCells += packedCells.length;
        const packedHydrations = packedCells.map(async (selection, cellIndex) => {
          const label = `${tileKey}:${jsonName}:packed:${mi}:${cellIndex}`;
          const prepared = await scheduleWorldHydrationTask(
            `${label}:prepare`,
            () => {
              if (opts.isCurrent && !opts.isCurrent()) return;
              const { cell, visibleIndices } = selection;
              const count = visibleIndices?.length ?? cell.instanceCount;
              if (!count) return;
              let matrices: Float32Array;
              if (!visibleIndices) {
                matrices = packedGrass.matrices.subarray(
                  cell.instanceStart * 16,
                  (cell.instanceStart + cell.instanceCount) * 16,
                );
              } else {
                matrices = new Float32Array(count * 16);
                for (let index = 0; index < visibleIndices.length; index++) {
                  const packedIndex = visibleIndices[index];
                  matrices.set(packedGrass.matrices.subarray(packedIndex * 16, packedIndex * 16 + 16), index * 16);
                }
              }
              const packedIndices = visibleIndices
                ?? Array.from({ length: cell.instanceCount }, (_, index) => cell.instanceStart + index);
              const sourceIndices = packedIndices.map((index) => packedGrass.sourceIndexAt(index));
              const meshRadius = instanceRadius(m.positions as ArrayLike<number>, cell.maxScale);
              const colors = new Float32Array(count * 3);
              for (let index = 0; index < count; index++) {
                const shadow = packedGrass.shadowAt(packedIndices[index]);
                colors[index * 3] = shadow;
                colors[index * 3 + 1] = shadow;
                colors[index * 3 + 2] = shadow;
              }
              return { cell, count, matrices, sourceIndices, meshRadius, colors, tiers: packedIndices.map((index) => packedGrass.detailAt(index)) };
            },
            hydrationPriority,
            Math.min(0.8, 0.08 + (selection.visibleIndices?.length ?? selection.cell.instanceCount) * 0.001),
            cooperativeHydration,
            hydrationOwnership,
          );
          if (!prepared || !physicalLayouts.length) return;

          // Populate one constructor-owned Three attribute, then share it across all material
          // parts. This removes non-zero-offset view ambiguity without multiplying matrix memory.
          let cellMatrixAttribute: THREE.InstancedBufferAttribute | null = null;
          let nextPhysical = 0;
          await scheduleWorldHydrationSlices(`${label}:parts`, () => {
            const physical = physicalLayouts[nextPhysical++];
            const runtimes = physical.partSlots.map((slot) => partRuntimes[slot]);
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', posAttr);
            if (uvAttr) g.setAttribute('uv', uvAttr);
            g.setIndex(physical.lodIndices[0]);
            applyDoodadGeometryGroups(g, physical.lodGroups?.[0]);
            if (physical.renderNormalAttr) g.setAttribute('normal', physical.renderNormalAttr);
            const materials = runtimes.map(({ part, billboardPivot }) =>
              matFor(part, meshAnimation, mi, false, billboardPivot, !!animator));
            const im = new THREE.InstancedMesh(
              g,
              materials.length === 1 ? materials[0] : materials,
              prepared.count,
            );
            bindGroundEffectDetail(im, prepared.tiers, opts.getWorldDetail?.() ?? opts.worldDetail);
            registerAnimatedMaterialOwner(im.material, im);
            if (!cellMatrixAttribute) {
              (im.instanceMatrix.array as Float32Array).set(prepared.matrices);
              cellMatrixAttribute = im.instanceMatrix;
              cellMatrixAttribute.setUsage(THREE.StaticDrawUsage);
              cellMatrixAttribute.needsUpdate = true;
            } else {
              im.instanceMatrix = cellMatrixAttribute;
            }
            // Visibility is owned by updateDoodadCulling(). Avoid a second Three.js bounds test;
            // it is redundant and can disagree while a progressively hydrated cell is admitted.
            im.frustumCulled = false;
            im.userData.wowDoodad = {
              kind: 'terrainDoodad',
              tileKey,
              source: m.source,
              meshIndex: mi,
              part: runtimes.length === 1 ? runtimes[0].partIndex : undefined,
              parts: runtimes.map((runtime) => runtime.partIndex),
              spatialCell: `${prepared.cell.cellX}:${prepared.cell.cellY}`,
              hasInstanceTint: false,
              sourceIndices: prepared.sourceIndices,
              packedGrass: true,
              grass,
            };
            const lodDistances = physical.lodIndices.slice(1).map((_, index) => index === 0 ? 42 : 82);
            registerDoodadCullBatch(batchRoot, {
              mesh: im,
              centerX: prepared.cell.centerX,
              centerY: prepared.cell.centerY,
              centerZ: prepared.cell.centerZ,
              batchRadius: prepared.cell.radius + prepared.meshRadius, maxDrawDistance: grass ? grassBatchDrawDistance(materials) : undefined,
              // Grass already has a shader-owned 65-95 yard fade. Applying the generic
              // single-object screen-size cutoff to a whole spatial cell can hide every
              // instance in the cell before that fade is reached.
              objectRadius: grass ? Number.POSITIVE_INFINITY : prepared.meshRadius,
              lodIndices: physical.lodIndices,
              lodGroups: physical.lodGroups,
              lodDistances,
              animationActivity,
              currentLod: 0,
            });
            im.instanceColor = new THREE.InstancedBufferAttribute(prepared.colors, 3);
            im.instanceColor.needsUpdate = true;
            batchRoot.add(im);
            animator?.bindGroup(im);
            sceneObjects++;
            if (runtimes.length > 1) groupedSceneObjects++;
            submittedInstances += prepared.count * runtimes.length;
            return nextPhysical >= physicalLayouts.length;
          }, {
            priority: hydrationPriority,
            sliceBudgetMs: 0.8,
            estimatedUnitMs: 0.18,
            maxUnitsPerSlice: 1,
            cooperative: cooperativeHydration,
            isCurrent: opts.isCurrent,
            signal,
            ownerId: effectOwnerKey,
          });
        });
        await Promise.all(packedHydrations);
        if (animator) registerDoodadAnimator(animator, group, animationActivity!);
        continue;
      }
      const batchPlan = selectDoodadBatchPlan({
        kind: grass ? 'grass' : jsonName === 'wmo_doodads.json' ? 'wmo' : 'terrain',
        instanceCount: allInsts.length,
        trianglesPerInstance: partRuntimes.reduce((sum, part) => sum + part.lodIndices[0].count / 3, 0),
        objectRadius: instanceRadius(m.positions as ArrayLike<number>, sourceMaxScale),
        override: rawBatchOverride === 'terrain-spatial' && !grass && jsonName !== 'wmo_doodads.json'
          ? 'spatial' : batchOverride,
      });
      batchPolicyCounts[batchPlan.policy] = (batchPolicyCounts[batchPlan.policy] ?? 0) + 1;
      const batches = await buildSpatialDoodadBatchesProgressive(
        legacyInstances!,
        allInsts,
        batchPlan.cellSize,
        hydration.checkpoint,
        batchPlan.mode,
      );
      spatialCells += batches.length;

      const cellHydrations = batches.map(async (spatial, cellIndex) => {
        const label = `${tileKey}:${jsonName}:${mi}:${cellIndex}`;
        const prepared = await scheduleWorldHydrationTask(
          `${label}:prepare`,
          () => {
            if (opts.isCurrent && !opts.isCurrent()) return null;
            const insts = spatial.indices.sort((a, b) => groundEffectTier(legacyInstances![a].d) - groundEffectTier(legacyInstances![b].d));
            if (!insts.length) return null;
            const hasInstanceTint = insts.some((idx) => Array.isArray(legacyInstances![idx]?.c));
            let maxScale = 0;
            let minX = Infinity, minY = Infinity, minZ = Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            for (const idx of insts) {
              const inst = legacyInstances![idx];
              if (inst.s > maxScale) maxScale = inst.s;
              if (inst.x < minX) minX = inst.x; if (inst.x > maxX) maxX = inst.x;
              if (inst.y < minY) minY = inst.y; if (inst.y > maxY) maxY = inst.y;
              if (inst.z < minZ) minZ = inst.z; if (inst.z > maxZ) maxZ = inst.z;
            }
            const meshRadius = instanceRadius(m.positions as ArrayLike<number>, maxScale);
            let tints: Float32Array | null = null, lightClasses: Float32Array | null = null;
            if (hasInstanceTint) {
              tints = new Float32Array(insts.length * 4);
              lightClasses = new Float32Array(insts.length);
              insts.forEach((idx, instanceIndex) => {
                const tint = legacyInstances![idx]?.c ?? [255, 255, 255, 255];
                for (let channel = 0; channel < 4; channel++) tints![instanceIndex * 4 + channel] = (tint[channel] ?? 255) / 255;
                lightClasses![instanceIndex] = legacyInstances![idx]?.e ?? 0;
              });
            }
            return {
              insts, hasInstanceTint, meshRadius, tints, lightClasses,
              batchBounds: {
                centerX: (minX + maxX) / 2,
                centerY: (minY + maxY) / 2,
                centerZ: (minZ + maxZ) / 2,
                radius: Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2,
              },
            };
          },
          hydrationPriority,
          Math.min(0.8, 0.08 + spatial.indices.length * 0.001),
          cooperativeHydration,
          hydrationOwnership,
        );
        if (!prepared || !physicalLayouts.length) return;
        let nextPhysical = 0;
        await scheduleWorldHydrationSlices(`${label}:parts`, () => {
          const physical = physicalLayouts[nextPhysical++];
          const runtimes = physical.partSlots.map((slot) => partRuntimes[slot]);
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', posAttr);
          if (uvAttr) g.setAttribute('uv', uvAttr);
          g.setIndex(physical.lodIndices[0]);
          applyDoodadGeometryGroups(g, physical.lodGroups?.[0]);
          if (prepared.hasInstanceTint) {
            g.setAttribute('instanceTint', new THREE.InstancedBufferAttribute(prepared.tints!, 4));
            g.setAttribute('instanceLightClass', new THREE.InstancedBufferAttribute(prepared.lightClasses!, 1));
          }
          if (physical.renderNormalAttr) g.setAttribute('normal', physical.renderNormalAttr);

          const materials = runtimes.map(({ part, billboardPivot }) =>
            matFor(part, meshAnimation, mi, prepared.hasInstanceTint, billboardPivot, !!animator));
          const im = new THREE.InstancedMesh(
            g,
            materials.length === 1 ? materials[0] : materials,
            prepared.insts.length,
          );
          bindGroundEffectDetail(im, prepared.insts.map((index) => groundEffectTier(legacyInstances![index].d)), opts.getWorldDetail?.() ?? opts.worldDetail);
          registerAnimatedMaterialOwner(im.material, im);
          im.frustumCulled = false;
          im.userData.wowDoodad = {
            kind: jsonName === 'wmo_doodads.json' ? 'wmoDoodad' : 'terrainDoodad',
            tileKey,
            source: m.source,
            meshIndex: mi,
            part: runtimes.length === 1 ? runtimes[0].partIndex : undefined,
            parts: runtimes.map((runtime) => runtime.partIndex),
            spatialCell: spatial.key,
            hasInstanceTint: prepared.hasInstanceTint,
            sourceIndices: prepared.insts,
            grass,
          };
          for (let k = 0; k < prepared.insts.length; k++) im.setMatrixAt(k, matrixBySource.get(prepared.insts[k])!);
          im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
          im.instanceMatrix.needsUpdate = true;
          const lodDistances = physical.lodIndices.slice(1).map((_, index) => {
            if (grass) return index === 0 ? 42 : 82;
            return index === 0 ? Math.max(70, prepared.meshRadius * 24) : Math.max(150, prepared.meshRadius * 52);
          });
          registerDoodadCullBatch(batchRoot, {
            mesh: im,
            centerX: prepared.batchBounds.centerX,
            centerY: prepared.batchBounds.centerY,
            centerZ: prepared.batchBounds.centerZ,
            batchRadius: prepared.batchBounds.radius + prepared.meshRadius, maxDrawDistance: grass ? grassBatchDrawDistance(materials) : undefined,
            // A grass batch represents many scattered blades, not one object at the cell
            // centre. Keep spatial frustum/distance culling and leave fine fade to the shader.
            objectRadius: grass ? Number.POSITIVE_INFINITY : prepared.meshRadius,
            lodIndices: physical.lodIndices,
            lodGroups: physical.lodGroups,
            lodDistances,
            animationActivity,
            currentLod: 0,
          });
          if (grass) {
            const sh = new THREE.Color();
            prepared.insts.forEach((idx, k) => { const f = legacyInstances![idx].sh ?? 1; im.setColorAt(k, sh.setRGB(f, f, f)); });
            if (im.instanceColor) im.instanceColor.needsUpdate = true;
          }
          batchRoot.add(im);
          animator?.bindGroup(im);
          sceneObjects++;
          if (runtimes.length > 1) groupedSceneObjects++;
          submittedInstances += prepared.insts.length * runtimes.length;
          return nextPhysical >= physicalLayouts.length;
        }, {
          priority: hydrationPriority,
          sliceBudgetMs: 0.8,
          estimatedUnitMs: 0.18,
          maxUnitsPerSlice: 1,
          cooperative: cooperativeHydration,
          isCurrent: opts.isCurrent,
          signal,
          ownerId: effectOwnerKey,
        });
      });
      await Promise.all(cellHydrations);
      if (animator) registerDoodadAnimator(animator, group, animationActivity!);
    }

    await Promise.all(collisionBuilds);
    if (opts.isCurrent && !opts.isCurrent()) return;

    const worldLayerDiagnostics = (group.userData.worldLayerDiagnostics ??= {});
    worldLayerDiagnostics[jsonName] = {
      manifestInstances: manifestInstanceCount,
      detailLevel,
      detailVisible: manifestInstanceCount - detailCulled,
      indoorMasked: maskedInstances,
      sceneInstances: visibleInstanceCount,
      submittedInstances,
      spatialCells,
      hydrationYields: hydration.yieldCount(),
      cooperativeHydration,
      batchMode: rawBatchOverride === 'terrain-spatial' && jsonName === 'doodads.json'
        ? 'terrain-spatial' : batchOverride ?? (packedGrass ? 'packed-spatial' : 'spatial'),
      batchPolicyCounts,
      physicalMode,
      groupedSceneObjects,
      instanceFormat: packedGrass ? GRASS_BINARY_FORMAT : 'json',
      sceneObjects,
      // Per-chunk bake evidence is useful offline but is both immutable and extremely verbose.
      // Retaining it on every live tile made each one-second performance snapshot megabytes large.
      sourceDiagnostics: compactSourceDiagnostics(dd.diagnostics),
    };
    log(`tile ${tileKey}: ${visibleInstanceCount} ${label}, ${spatialCells} spatial cell(s), ${sceneObjects} draw object(s), ${submittedInstances} submitted${packedGrass ? ' (packed)' : ''}${maskedInstances ? ` (${maskedInstances} indoor-masked)` : ''}${detailCulled ? ` (${detailCulled} above detail ${detailLevel})` : ''}`);
  } catch (e) {
    log(`${label} load failed: ${(e as Error).message}`);
    throw e;
  } finally {
    hydration?.finish();
  }
};
