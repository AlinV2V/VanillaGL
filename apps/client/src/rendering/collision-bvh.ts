import * as THREE from 'three';
import { MeshBVH, computeBoundsTree, disposeBoundsTree, acceleratedRaycast, validateBounds } from 'three-mesh-bvh';
import { runtimeWorkScheduler } from '../platform/runtime-work-scheduler';
import {
  WMO_BVH_FORMAT,
  WMO_BVH_LIBRARY_VERSION,
  WMO_BVH_OPTIONS,
  WMO_BVH_SERIALIZATION_VERSION,
  type WmoBvhBinaryRef,
  type WmoBvhIndexRef,
  type WmoBvhMeta,
  wmoBvhContractJson,
} from './wmo-bvh-format';

let installed = false;
let runtimeBuiltTrees = 0;
let scheduledTrees = 0;
let pendingTrees = 0;
let deserializedTrees = 0;
let sidecarTiles = 0;
let sidecarFallbacks = 0;
let sourceBytesReleased = 0;
let peakSidecarBytes = 0;
let peakCopiedRootBytes = 0;
let preparedSurfaces = 0;
const hiddenRoots = new WeakMap<THREE.Object3D, THREE.Group>();

/** Collapse collision-only descendants behind one invisible node in the renderer's scene walk. */
export function hiddenCollisionRoot(parent: THREE.Object3D, name: string, attach = true): THREE.Group {
  let root = hiddenRoots.get(parent);
  if (!root) {
    root = new THREE.Group();
    root.name = name;
    root.visible = false;
    hiddenRoots.set(parent, root);
  }
  if (attach && root.parent !== parent) parent.add(root);
  return root;
}

type SerializedTree = ReturnType<typeof MeshBVH.serialize>;
export type WmoBvhLookup = Map<string, SerializedTree>;
const keyFor = (model: number, group: number, surface: number) => `${model}:${group}:${surface}`;

async function sha256Hex(value: ArrayBuffer | string): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sliceRef(buffer: ArrayBuffer, ref: WmoBvhBinaryRef): ArrayBuffer {
  if (!Number.isInteger(ref.offset) || !Number.isInteger(ref.byteLength) || ref.offset < 0 || ref.byteLength <= 0
    || ref.offset + ref.byteLength > buffer.byteLength) throw new Error('BVH binary reference outside blob');
  return buffer.slice(ref.offset, ref.offset + ref.byteLength);
}

function indexRef(buffer: ArrayBuffer, ref: WmoBvhIndexRef): Uint16Array | Uint32Array {
  const width = ref.component === 'u16' ? 2 : ref.component === 'u32' ? 4 : 0;
  if (!width || !Number.isInteger(ref.count) || ref.count < 0 || ref.byteLength !== ref.count * width || ref.offset % width !== 0) {
    throw new Error('malformed BVH index reference');
  }
  if (ref.offset < 0 || ref.offset + ref.byteLength > buffer.byteLength) throw new Error('BVH index reference outside blob');
  return width === 2
    ? new Uint16Array(buffer, ref.offset, ref.count)
    : new Uint32Array(buffer, ref.offset, ref.count);
}

/** Load and structurally validate an optional v2 sidecar. Any mismatch preserves runtime fallback. */
export async function loadWmoBvhSidecar(base: string, wmo: any, signal?: AbortSignal): Promise<WmoBvhLookup | null> {
  try {
    const [metaResponse, binaryResponse] = await Promise.all([
      fetch(`${base}/wmos.bvh.meta.json`, { signal }),
      fetch(`${base}/wmos.bvh.bin`, { signal }),
    ]);
    if (!metaResponse.ok || !binaryResponse.ok) return null;
    const [meta, binary] = await Promise.all([metaResponse.json() as Promise<WmoBvhMeta>, binaryResponse.arrayBuffer()]);
    if (meta.format !== WMO_BVH_FORMAT || meta.meshBvhVersion !== WMO_BVH_LIBRARY_VERSION
      || meta.serializationVersion !== WMO_BVH_SERIALIZATION_VERSION
      || meta.options?.targetLeafSize !== WMO_BVH_OPTIONS.targetLeafSize) throw new Error('unsupported WMO BVH contract');
    let sourceBinary: ArrayBuffer | undefined = wmo?.__wmoBinarySource;
    if (!(sourceBinary instanceof ArrayBuffer)) throw new Error('WMO source binary unavailable for BVH validation');
    const contract = { ...meta } as any;
    delete contract.generatedAt;
    delete contract.contractSha256;
    if (globalThis.crypto?.subtle) {
      const [sourceHash, binaryHash, contractHash] = await Promise.all([
        sha256Hex(sourceBinary), sha256Hex(binary), sha256Hex(wmoBvhContractJson(contract)),
      ]);
      if (sourceHash !== meta.sourceBinarySha256 || binaryHash !== meta.bvhBinarySha256 || contractHash !== meta.contractSha256) {
        throw new Error('WMO BVH cryptographic validation failed');
      }
    }
    sourceBytesReleased += sourceBinary.byteLength;
    Reflect.deleteProperty(wmo, '__wmoBinarySource');
    sourceBinary = undefined;

    const validateRuntime = typeof location !== 'undefined' && new URLSearchParams(location.search).has('validatebvh');
    const prepared: Array<readonly [string, SerializedTree]> = [];
    const copiedRootBytes = meta.surfaces.reduce((sum, surface) => sum
      + surface.roots.reduce((rootSum, root) => rootSum + root.byteLength, 0), 0);
    peakSidecarBytes = Math.max(peakSidecarBytes, binary.byteLength);
    peakCopiedRootBytes = Math.max(peakCopiedRootBytes, copiedRootBytes);
    // Keep at most one preparation batch queued. Index attributes remain zero-copy views into the
    // monolith; only MeshBVH root buffers are copied because the library contract has no offsets.
    for (let offset = 0; offset < meta.surfaces.length; offset += 32) {
      const surfaces = meta.surfaces.slice(offset, offset + 32);
      const entries = await runtimeWorkScheduler.schedule(
        `bvh-validate:${offset}-${offset + surfaces.length}`,
        () => surfaces.map((surface) => {
        const group = wmo.models?.[surface.model]?.groups?.[surface.group];
        const sourceIndices = surface.surface < 0 ? group?.collisionIndices : group?.collisionGroups?.[surface.surface]?.indices;
        if (!group?.positions || group.positions.length / 3 !== surface.positionCount
          || sourceIndices?.length !== surface.sourceIndexCount || surface.index.count !== surface.sourceIndexCount) {
          throw new Error('WMO BVH surface no longer matches source geometry');
        }
        const serialized = {
          version: WMO_BVH_SERIALIZATION_VERSION,
          roots: surface.roots.map((ref) => sliceRef(binary, ref)),
          index: indexRef(binary, surface.index),
          indirectBuffer: surface.indirect ? indexRef(binary, surface.indirect) : null,
        } as SerializedTree;
        if (validateRuntime) {
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.BufferAttribute(group.positions, 3));
          geometry.setIndex(new THREE.BufferAttribute(serialized.index!, 1));
          const tree = MeshBVH.deserialize(serialized, geometry, { setIndex: false });
          if (!validateBounds(tree)) throw new Error('WMO BVH structural validation failed');
          geometry.dispose();
        }
        return [keyFor(surface.model, surface.group, surface.surface), serialized] as const;
        }),
        {
          priority: 'normal',
          estimatedMs: Math.max(0.05, Math.min(2, surfaces.reduce((sum, surface) => sum + surface.triangles, 0) / 100_000)),
          signal,
          ownerId: `wmo-bvh:${base}`,
        },
      );
      prepared.push(...entries);
    }
    preparedSurfaces += prepared.length;
    const lookup: WmoBvhLookup = new Map(prepared);
    sidecarTiles++;
    return lookup;
  } catch (error) {
    console.warn(`WMO BVH sidecar rejected; using scheduled runtime build: ${(error as Error).message}`);
    sidecarFallbacks++;
    return null;
  }
}

export function attachWmoBvhSidecar(
  geometry: THREE.BufferGeometry,
  lookup: WmoBvhLookup | null,
  model: number,
  group: number,
  surface: number,
): boolean {
  const serialized = lookup?.get(keyFor(model, group, surface));
  if (!serialized?.index) { sidecarFallbacks++; return false; }
  try {
    geometry.setIndex(new THREE.BufferAttribute(serialized.index, 1));
    geometry.boundsTree = MeshBVH.deserialize(serialized, geometry, { setIndex: false });
  } catch { sidecarFallbacks++; return false; }
  deserializedTrees++;
  return true;
}

/** Count emergency/runtime fallback builds performed after hydration. */
function computeBoundsTreeRuntime(this: THREE.BufferGeometry, options?: unknown) {
  runtimeBuiltTrees++;
  return (computeBoundsTree as any).call(this, options);
}

// One-time install of the three-mesh-bvh acceleration onto the shared THREE prototypes.
// WorldCollision fires many raycasts per movement frame against WMO and M2 collision shells.
// acceleratedRaycast takes the BVH path only for geometries carrying a boundsTree and otherwise
// falls back to Three's stock Mesh.raycast, preserving behavior for every non-collision mesh.
//
// We deliberately never set raycaster.firstHitOnly. WorldCollision walks the nearest-first list to
// skip non-walkable faces; keeping the full hit list makes the accelerated path semantically identical.
export function installCollisionBvh(): void {
  if (installed) return;
  installed = true;
  THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTreeRuntime as typeof computeBoundsTree;
  THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
  THREE.Mesh.prototype.raycast = acceleratedRaycast;
}

/**
 * Defer one indivisible BVH build through the measured main-thread frame budget. A tree is still
 * complete before its tile becomes collidable; only the burst of hundreds of independent WMO
 * surfaces is spread across animation frames.
 */
export function scheduleCollisionBvh(geometry: THREE.BufferGeometry, label = 'collision', signal?: AbortSignal): Promise<void> {
  const triangles = Math.floor((geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0) / 3);
  scheduledTrees++;
  pendingTrees++;
  return runtimeWorkScheduler.schedule(
    `bvh:${label}`,
    () => {
      if (signal?.aborted) throw signal.reason ?? new DOMException('BVH build aborted', 'AbortError');
      geometry.computeBoundsTree();
    },
    {
      priority: 'normal',
      estimatedMs: Math.max(0.05, Math.min(2, triangles / 50_000)),
      signal,
    },
  ).finally(() => { pendingTrees--; });
}

export function collisionBvhDiagnostics() {
  return {
    installed,
    runtimeBuiltTrees,
    scheduledTrees,
    pendingTrees,
    deserializedTrees,
    sidecarTiles,
    sidecarFallbacks,
    sourceBytesReleased,
    peakSidecarBytes,
    peakCopiedRootBytes,
    preparedSurfaces,
    architecture: 'validated-sidecar-with-runtime-fallback' as const,
  };
}
