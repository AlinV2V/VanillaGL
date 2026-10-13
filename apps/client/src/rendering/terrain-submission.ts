import * as THREE from 'three';
import { xrIntersectsBox, xrViewState } from './xr-view-state';
import { qaGlobals } from '../qa-globals';

type Chunk = { bounds: THREE.Box3; indices: Uint16Array | Uint32Array };
type Tile = { mesh: THREE.Mesh; original: THREE.BufferAttribute; compact: THREE.BufferAttribute;
  chunks: Chunk[]; visible: Uint8Array; matrix: THREE.Matrix4; initialized: boolean; compacted: boolean };
const tiles = new Map<THREE.Mesh, Tile>();
const matrix = new THREE.Matrix4(), view = new THREE.Matrix4(), frustum = new THREE.Frustum();
const configured = typeof location === 'undefined' || new URLSearchParams(location.search).get('terrainculling') !== 'off';
let rewrites = 0, uploadedIndexBytes = 0;

/** Preserve the full mesh for collision/picking; compact only its GPU submission index buffer. */
export function registerTerrainSubmission(mesh: THREE.Mesh): void {
  if (tiles.has(mesh)) return;
  const geometry = mesh.geometry, original = geometry.index, position = geometry.getAttribute('position');
  if (!original || !position || !(original.array instanceof Uint16Array || original.array instanceof Uint32Array)) return;
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const box = geometry.boundingBox!, width = Math.max(0.001, box.max.x - box.min.x), height = Math.max(0.001, box.max.y - box.min.y);
  const buckets = Array.from({ length: 256 }, () => ({ bounds: new THREE.Box3(), indices: [] as number[] }));
  const point = new THREE.Vector3();
  for (let i = 0; i < original.count; i += 3) {
    const a = original.getX(i), b = original.getX(i + 1), c = original.getX(i + 2);
    const x = (position.getX(a) + position.getX(b) + position.getX(c)) / 3;
    const y = (position.getY(a) + position.getY(b) + position.getY(c)) / 3;
    const col = Math.max(0, Math.min(15, Math.floor((x - box.min.x) / width * 16)));
    const row = Math.max(0, Math.min(15, Math.floor((y - box.min.y) / height * 16)));
    const chunk = buckets[row * 16 + col]; chunk.indices.push(a, b, c);
    for (const index of [a, b, c]) chunk.bounds.expandByPoint(point.fromBufferAttribute(position, index));
  }
  const ArrayType = original.array instanceof Uint32Array ? Uint32Array : Uint16Array;
  const chunks = buckets.filter((chunk) => chunk.indices.length).map((chunk) => ({
    bounds: chunk.bounds.expandByScalar(0.001), indices: new ArrayType(chunk.indices),
  }));
  const compact = new THREE.BufferAttribute(new ArrayType(original.array), 1).setUsage(THREE.DynamicDrawUsage);
  const tile: Tile = { mesh, original, compact, chunks, visible: new Uint8Array(chunks.length),
    matrix: new THREE.Matrix4(), initialized: false, compacted: false };
  geometry.setIndex(compact); tiles.set(mesh, tile);
  const raycast = mesh.raycast;
  mesh.raycast = function (raycaster, hits) {
    const index = geometry.index, start = geometry.drawRange.start, count = geometry.drawRange.count;
    try { geometry.setIndex(original); geometry.setDrawRange(0, original.count); raycast.call(this, raycaster, hits); }
    finally { geometry.setIndex(index); geometry.setDrawRange(start, count); }
  };
  geometry.addEventListener('dispose', () => { tiles.delete(mesh); mesh.raycast = raycast; });
}

/** Runs BEFORE renderer.render so Three.js uploads changed indices in the same frame. */
export function updateTerrainSubmission(scene: THREE.Scene, camera: THREE.Camera, enabled = configured): void {
  camera.updateWorldMatrix(true, false);
  view.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  for (const tile of tiles.values()) {
    let parent: THREE.Object3D | null = tile.mesh;
    while (parent && parent !== scene && parent.visible) parent = parent.parent;
    if (parent !== scene || !scene.visible) continue;
    const geometry = tile.mesh.geometry;
    if (!enabled) {
      if (tile.compacted) {
        (tile.compact.array as Uint16Array | Uint32Array).set(tile.original.array);
        tile.compact.clearUpdateRanges(); tile.compact.addUpdateRange(0, tile.original.count); tile.compact.needsUpdate = true;
      }
      geometry.setDrawRange(0, tile.original.count); tile.initialized = false; tile.compacted = false;
      continue;
    }
    tile.mesh.updateWorldMatrix(true, false);
    matrix.multiplyMatrices(view, tile.mesh.matrixWorld);
    if (!xrViewState.active && tile.initialized && tile.matrix.equals(matrix)) continue;
    tile.matrix.copy(matrix); frustum.setFromProjectionMatrix(matrix);
    let changed = !tile.initialized;
    for (let i = 0; i < tile.chunks.length; i++) {
      const visible = xrIntersectsBox(tile.chunks[i].bounds, tile.mesh.matrixWorld, frustum) ? 1 : 0;
      if (visible !== tile.visible[i]) { tile.visible[i] = visible; changed = true; }
    }
    tile.initialized = true;
    if (!changed) continue;
    let count = 0;
    for (let i = 0; i < tile.chunks.length; i++) if (tile.visible[i]) {
      (tile.compact.array as Uint16Array | Uint32Array).set(tile.chunks[i].indices, count); count += tile.chunks[i].indices.length;
    }
    geometry.setDrawRange(0, count); tile.compacted = true;
    if (count) { tile.compact.clearUpdateRanges(); tile.compact.addUpdateRange(0, count); tile.compact.needsUpdate = true; }
    rewrites++; uploadedIndexBytes += count * tile.compact.array.BYTES_PER_ELEMENT;
  }
}

export function terrainSubmissionDiagnostics() {
  let sourceTriangles = 0, submittedTriangles = 0;
  for (const tile of tiles.values()) {
    sourceTriangles += tile.original.count / 3;
    submittedTriangles += Math.min(tile.original.count, tile.mesh.geometry.drawRange.count) / 3;
  }
  return { tiles: tiles.size, sourceTriangles, submittedTriangles, rewrites, uploadedIndexBytes };
}
qaGlobals.__wowTerrainSubmission = terrainSubmissionDiagnostics;
