import { CollisionRayCandidates } from './rendering/collision-ray-candidates';
import * as THREE from 'three';
import { beginCpuScope, CpuScopeId, endCpuScope } from './rendering/performance-cpu-scopes';

// Verified WoW 1.12.1 player collision cylinder dimensions. The ray-sampled
// sweep/slide resolver below remains an approximation until the movement-step routine is recovered.
// Evidence: wow_collision_research/collision_controller_evidence.md
export const PLAYER_COLLISION_CYLINDER = {
  radius: 0.5,       // CONFIRMED: file 0x410184, VA 0x00810184 (skin cluster)
  height: 2.0,       // CONFIRMED: file 0x410180, VA 0x00810180 (skin cluster)
  maxStepUp: 0.75,   // CONFIRMED: file 0x4012CC, VA 0x008012CC
  skin: 0.03,        // CONFIRMED: file 0x410174, VA 0x00810174 (first in struct)
} as const;

// Recovered Build 5875 floor/wall split (MovementStep / closestWall): collision is two-sided and
// |normal.z| >= 0.25 is walkable. A stricter signed test rejects authored bevels and ramps.
const WALKABLE_NORMAL_Z = 0.25;
const GROUND_SUPPORT_RADIUS = PLAYER_COLLISION_CYLINDER.radius - PLAYER_COLLISION_CYLINDER.skin;
const GROUND_SUPPORT_DIAGONAL = GROUND_SUPPORT_RADIUS * Math.SQRT1_2;
const GROUND_PROBE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [GROUND_SUPPORT_RADIUS, 0],
  [-GROUND_SUPPORT_RADIUS, 0],
  [0, GROUND_SUPPORT_RADIUS],
  [0, -GROUND_SUPPORT_RADIUS],
  [GROUND_SUPPORT_DIAGONAL, GROUND_SUPPORT_DIAGONAL],
  [GROUND_SUPPORT_DIAGONAL, -GROUND_SUPPORT_DIAGONAL],
  [-GROUND_SUPPORT_DIAGONAL, GROUND_SUPPORT_DIAGONAL],
  [-GROUND_SUPPORT_DIAGONAL, -GROUND_SUPPORT_DIAGONAL],
];
const HORIZONTAL_SWEEP_SIDE_FACTORS = [-0.9, -0.6, 0, 0.6, 0.9] as const;

export type GroundSample = {
  height: number;
  source: 'terrain' | 'wmo';
  terrainType?: number;
};

export type GroundSampleOptions = {
/** Asset conversion utility. */
allowWmoBelowTerrain?: boolean;
};

export type HorizontalCollision = {
  delta: THREE.Vector3;
  blocked: boolean;
};

export type WorldCollisionSource = 'wmo' | 'm2';
type WorldCollisionEntry = {
  mesh: THREE.Mesh;
  bounds: THREE.Box3;
  source: WorldCollisionSource;
  cells: number[] | null;
  queryStamp: number;
};

const COLLISION_GRID_CELL_SIZE = 64;
const MAX_GRID_CELLS_PER_ENTRY = 256;
const gridCoordinate = (value: number): number => Math.floor(value / COLLISION_GRID_CELL_SIZE);
const gridKey = (x: number, y: number): number => {
  const ux = x >= 0 ? x * 2 : -x * 2 - 1;
  const uy = y >= 0 ? y * 2 : -y * 2 - 1;
  const sum = ux + uy;
  return sum * (sum + 1) / 2 + uy;
};

export class WorldCollision {
  private readonly rayCandidates = new CollisionRayCandidates();
  private readonly wallResult = { distance: 0, travel: 0, normal: new THREE.Vector3() };
  private readonly entries: WorldCollisionEntry[] = [];
  private readonly spatialEntries = new Map<number, WorldCollisionEntry[]>();
  private readonly globalEntries: WorldCollisionEntry[] = [];
  private readonly candidates: THREE.Mesh[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly queryBox = new THREE.Box3();
  private readonly origin = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly position = new THREE.Vector3();
  private readonly remaining = new THREE.Vector3();
  private readonly applied = new THREE.Vector3();
  private readonly segment = new THREE.Vector3();
  private readonly clampedPoint = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly normalMatrix = new THREE.Matrix3();
  private readonly resolvedDelta = new THREE.Vector3();
  private readonly hits: THREE.Intersection[] = [];
  private triangles = 0;
  private broadphaseQueries = 0;
  private broadphaseCellVisits = 0;
  private broadphaseEntryTests = 0;
  private broadphaseCandidates = 0;
  private maxCandidatesPerQuery = 0;
  private raycasts = 0;
  private intersections = 0;
  private queryStamp = 0;
  lastHorizontalBlock:
    | { distance: number; normal: [number, number, number]; point: [number, number, number]; object?: string }
    | null = null;

  add(mesh: THREE.Mesh, source?: WorldCollisionSource): void {
    mesh.updateWorldMatrix(true, false);
    const resolvedSource = source ?? (mesh.userData.wowCollisionSource === 'm2' ? 'm2' : 'wmo');
    const entry: WorldCollisionEntry = {
      mesh,
      bounds: new THREE.Box3().setFromObject(mesh),
      source: resolvedSource,
      cells: null,
      queryStamp: 0,
    };
    this.entries.push(entry);
    this.rayCandidates.register(mesh, entry.bounds);
    this.indexEntry(entry);
    this.triangles += Math.floor((mesh.geometry.index?.count ?? 0) / 3);
  }

  remove(mesh: THREE.Mesh): void {
    const index = this.entries.findIndex((entry) => entry.mesh === mesh);
    if (index < 0) return;
    const [entry] = this.entries.splice(index, 1);
    this.unindexEntry(entry);
    this.triangles -= Math.floor((entry.mesh.geometry.index?.count ?? 0) / 3);
    if (this.triangles < 0) this.triangles = 0;
  }

  removeMany(meshes: readonly THREE.Mesh[]): void {
    if (!meshes.length) return;
    const removed = new Set(meshes);
    let removedTriangles = 0;
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index];
      if (!removed.has(entry.mesh)) continue;
      removedTriangles += Math.floor((entry.mesh.geometry.index?.count ?? 0) / 3);
      this.unindexEntry(entry);
      this.entries.splice(index, 1);
    }
    this.triangles = Math.max(0, this.triangles - removedTriangles);
  }

  refresh(): void {
    for (const entry of this.entries) {
      entry.mesh.updateWorldMatrix(true, false);
      entry.bounds.setFromObject(entry.mesh);
    }
    this.rebuildSpatialIndex();
  }

  clear(): void {
    this.entries.length = 0;
    this.spatialEntries.clear();
    this.globalEntries.length = 0;
    this.candidates.length = 0;
    this.triangles = 0;
  }

  get stats() {
    let m2Meshes = 0, m2Triangles = 0;
    for (const entry of this.entries) {
      if (entry.source !== 'm2') continue;
      m2Meshes++;
      m2Triangles += Math.floor((entry.mesh.geometry.index?.count ?? 0) / 3);
    }
    return {
      meshes: this.entries.length,
      triangles: this.triangles,
      m2Meshes,
      m2Triangles,
      broadphaseGridCells: this.spatialEntries.size,
      broadphaseGlobalEntries: this.globalEntries.length,
      broadphaseQueries: this.broadphaseQueries,
      broadphaseCellVisits: this.broadphaseCellVisits,
      broadphaseEntryTests: this.broadphaseEntryTests,
      broadphaseCandidates: this.broadphaseCandidates,
      maxCandidatesPerQuery: this.maxCandidatesPerQuery,
      raycasts: this.raycasts,
      rayMeshBoundsTests: this.rayCandidates.tested,
      rayMeshBoundsRejected: this.rayCandidates.rejected,
      intersections: this.intersections,
    };
  }

  sampleGround(
    x: number,
    y: number,
    maxZ: number,
    terrainHeight: number,
    options: GroundSampleOptions = {},
  ): GroundSample {
    if (!this.entries.length) return { height: terrainHeight, source: 'terrain' };

    const skin = PLAYER_COLLISION_CYLINDER.skin;
    const rayDepth = Math.max(100, Math.abs(maxZ - terrainHeight) + 100);
    const minZ = (options.allowWmoBelowTerrain ? maxZ - rayDepth : Math.min(terrainHeight, maxZ)) - skin;
    const maxZBound = Math.max(terrainHeight, maxZ) + skin;
    // Ground is support for the whole collision cylinder, not only its center.
    // A center-only ray can miss a WMO triangle at a model/terrain seam for one
    // frame and make the player fall or snap. Keep the center authoritative when
    // it has a floor, then use reachable perimeter contacts as edge support.
    this.queryBox.min.set(x - GROUND_SUPPORT_RADIUS, y - GROUND_SUPPORT_RADIUS, minZ);
    this.queryBox.max.set(x + GROUND_SUPPORT_RADIUS, y + GROUND_SUPPORT_RADIUS, maxZBound);
    const candidates = this.collectCandidates(this.queryBox);
    if (!candidates.length) return { height: terrainHeight, source: 'terrain' };

    let perimeterSupport: GroundSample | null = null;
    for (const [ox, oy] of GROUND_PROBE_OFFSETS) {
      const sample = this.sampleWmoGroundAt(
        x + ox,
        y + oy,
        maxZ,
        terrainHeight,
        rayDepth,
        candidates,
        options.allowWmoBelowTerrain === true,
      );
      if (!sample) continue;
      if (ox === 0 && oy === 0) return sample;
      if ((ox !== 0 || oy !== 0) && !this.isGroundSupportReachable(x, y, x + ox, y + oy, sample.height, candidates)) {
        continue;
      }
      // A flat collision-cylinder bottom cannot descend below the highest
      // reachable surface under its footprint. Evaluate the complete ring so
      // the result does not depend on the fixed probe order at WMO corners.
      if (!perimeterSupport || sample.height > perimeterSupport.height) perimeterSupport = sample;
    }
    return perimeterSupport ?? { height: terrainHeight, source: 'terrain' };
  }

  resolveHorizontal(position: THREE.Vector3, requestedDelta: THREE.Vector3, out: HorizontalCollision = { delta: new THREE.Vector3(), blocked: false }): HorizontalCollision {
    this.lastHorizontalBlock = null;
    this.position.copy(position);
    this.remaining.copy(requestedDelta);
    this.remaining.z = 0;
    const requestedLength = this.remaining.length();
    const { radius, height } = PLAYER_COLLISION_CYLINDER;
    this.queryBox.min.set(
      Math.min(position.x, position.x + this.remaining.x) - radius,
      Math.min(position.y, position.y + this.remaining.y) - radius,
      position.z,
    );
    this.queryBox.max.set(
      Math.max(position.x, position.x + this.remaining.x) + radius,
      Math.max(position.y, position.y + this.remaining.y) + radius,
      position.z + height,
    );
    const candidates = this.collectCandidates(this.queryBox);
    if (!candidates.length) {
      out.delta.copy(this.remaining); out.blocked = false; return out;
    }
    let blocked = false;

    for (let pass = 0; pass < 3 && this.remaining.lengthSq() > 1e-8; pass++) {
      const distance = this.remaining.length();
      this.direction.copy(this.remaining).multiplyScalar(1 / distance);
      const wall = this.closestWall(candidates, this.position, this.direction, distance);
      if (!wall) {
        this.position.add(this.remaining);
        this.remaining.set(0, 0, 0);
        break;
      }

      blocked = true;
      const allowed = Math.max(0, wall.travel);
      this.applied.copy(this.direction).multiplyScalar(Math.min(distance, allowed));
      this.position.add(this.applied);
      this.remaining.sub(this.applied);

      this.normal.copy(wall.normal);
      this.normal.z = 0;
      if (this.normal.lengthSq() < 1e-8) {
        this.remaining.set(0, 0, 0);
        break;
      }
      this.normal.normalize();
      if (this.normal.dot(this.direction) > 0) this.normal.negate();
      const intoWall = this.remaining.dot(this.normal);
      if (intoWall < 0) this.remaining.addScaledVector(this.normal, -intoWall);
    }

    this.resolvedDelta.copy(this.position).sub(position);
    this.resolvedDelta.z = 0;
    out.delta.copy(this.resolvedDelta);
    out.blocked = blocked || this.resolvedDelta.lengthSq() + 1e-8 < requestedLength * requestedLength;
    return out;
  }

  clampVerticalRise(position: THREE.Vector3, requestedRise: number): number {
    if (!this.entries.length || requestedRise <= 0) return requestedRise;

    const { radius, height, skin } = PLAYER_COLLISION_CYLINDER;
    this.queryBox.min.set(position.x - radius, position.y - radius, position.z + height);
    this.queryBox.max.set(position.x + radius, position.y + radius, position.z + height + requestedRise + skin);
    const candidates = this.collectCandidates(this.queryBox);
    if (!candidates.length) return requestedRise;
    const offsets: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [radius * 0.7, 0],
      [-radius * 0.7, 0],
      [0, radius * 0.7],
      [0, -radius * 0.7],
    ];
    let allowed = requestedRise;

    for (const [ox, oy] of offsets) {
      this.origin.set(position.x + ox, position.y + oy, position.z + height);
      this.direction.set(0, 0, 1);
      this.raycaster.set(this.origin, this.direction);
      this.raycaster.near = 0;
      this.raycaster.far = requestedRise + skin;
      this.intersectCandidates(candidates);
      for (const hit of this.hits) {
        if (!this.surfaceNormal(hit, this.normal) || Math.abs(this.normal.z) < 0.25) continue;
        allowed = Math.min(allowed, Math.max(0, hit.distance - skin));
        break;
      }
    }
    return allowed;
  }

  clampSegment(start: THREE.Vector3, end: THREE.Vector3, padding = 0.2): THREE.Vector3 {
    if (!this.entries.length) return end.clone();

    this.segment.subVectors(end, start);
    const distance = this.segment.length();
    if (distance <= 1e-5) return end.clone();

    this.direction.copy(this.segment).multiplyScalar(1 / distance);
    this.queryBox.min.set(
      Math.min(start.x, end.x) - padding,
      Math.min(start.y, end.y) - padding,
      Math.min(start.z, end.z) - padding,
    );
    this.queryBox.max.set(
      Math.max(start.x, end.x) + padding,
      Math.max(start.y, end.y) + padding,
      Math.max(start.z, end.z) + padding,
    );
    const candidates = this.collectCandidates(this.queryBox);
    if (!candidates.length) return end.clone();

    this.raycaster.set(start, this.direction);
    this.raycaster.near = PLAYER_COLLISION_CYLINDER.skin;
    this.raycaster.far = distance;
    this.intersectCandidates(candidates);
    const hit = this.hits[0];
    if (!hit) return end.clone();

    return this.clampedPoint.copy(start).addScaledVector(this.direction, Math.max(0, hit.distance - padding)).clone();
  }

  /**
   * Tests a camera-to-world segment against WMO collision only. M2 collision remains part of
   * movement, but fences, trees and signposts must not become nameplate visibility blockers.
   * This is read-only and does not allocate a clamped result every frame.
   */
  isWmoSegmentOccluded(start: THREE.Vector3, end: THREE.Vector3, endpointPadding = 0.18): boolean {
    if (!this.entries.length) return false;
    this.segment.subVectors(end, start);
    const distance = this.segment.length();
    if (distance <= endpointPadding * 2) return false;

    this.direction.copy(this.segment).multiplyScalar(1 / distance);
    this.queryBox.min.set(
      Math.min(start.x, end.x) - endpointPadding,
      Math.min(start.y, end.y) - endpointPadding,
      Math.min(start.z, end.z) - endpointPadding,
    );
    this.queryBox.max.set(
      Math.max(start.x, end.x) + endpointPadding,
      Math.max(start.y, end.y) + endpointPadding,
      Math.max(start.z, end.z) + endpointPadding,
    );
    const candidates = this.collectCandidates(this.queryBox, 'wmo');
    if (!candidates.length) return false;

    this.raycaster.set(start, this.direction);
    this.raycaster.near = endpointPadding;
    this.raycaster.far = distance - endpointPadding;
    this.intersectCandidates(candidates);
    return this.hits.length > 0;
  }

  private closestWall(
    candidates: THREE.Mesh[],
    position: THREE.Vector3,
    direction: THREE.Vector3,
    distance: number,
  ): { distance: number; travel: number; normal: THREE.Vector3 } | null {
    const { radius, height, skin } = PLAYER_COLLISION_CYLINDER;
    const heights = [radius, height * 0.5, height - radius];
    let nearestTravel = Number.POSITIVE_INFINITY;
    let nearestDistance = Number.POSITIVE_INFINITY;
    let nearestNormal: THREE.Vector3 | null = null;

    for (const z of heights) {
      for (const sideFactor of HORIZONTAL_SWEEP_SIDE_FACTORS) {
        const lateralOffset = radius * sideFactor;
        const forwardExtent = Math.sqrt(Math.max(0, radius * radius - lateralOffset * lateralOffset));
        this.origin.set(
          position.x - direction.y * lateralOffset,
          position.y + direction.x * lateralOffset,
          position.z + z,
        );
        this.raycaster.set(this.origin, direction);
        this.raycaster.near = 0;
        this.raycaster.far = distance + forwardExtent + skin;
        this.intersectCandidates(candidates);
        for (const hit of this.hits) {
          if (!this.surfaceNormal(hit, this.normal)) continue;
          // Horizontal sweeps should only stop on wall-like faces. Cave ramps and
          // low ceilings can intersect the body rays too, but their normals point
          // mostly up/down and are handled by vertical ground/head checks.
          if (Math.abs(this.normal.z) > WALKABLE_NORMAL_Z) continue;
          if (Math.hypot(this.normal.x, this.normal.y) < 0.25) continue;
          const travel = Math.max(0, hit.distance - forwardExtent - skin);
          if (travel >= nearestTravel) break;
          nearestTravel = travel;
          nearestDistance = hit.distance;
          nearestNormal = this.wallResult.normal.copy(this.normal);
          this.lastHorizontalBlock = {
            distance: hit.distance,
            normal: [this.normal.x, this.normal.y, this.normal.z],
            point: [hit.point.x, hit.point.y, hit.point.z],
            object: String(hit.object.userData?.wowName ?? hit.object.name ?? ''),
          };
          break;
        }
      }
    }

    this.wallResult.distance = nearestDistance; this.wallResult.travel = nearestTravel;
    return nearestNormal ? this.wallResult : null;
  }

  private sampleWmoGroundAt(
    x: number,
    y: number,
    maxZ: number,
    terrainHeight: number,
    rayDepth: number,
    candidates: THREE.Mesh[],
    allowWmoBelowTerrain: boolean,
  ): GroundSample | null {
    const skin = PLAYER_COLLISION_CYLINDER.skin;
    this.origin.set(x, y, maxZ + skin);
    this.direction.set(0, 0, -1);
    this.raycaster.set(this.origin, this.direction);
    this.raycaster.near = 0;
    this.raycaster.far = rayDepth;
    this.intersectCandidates(candidates);

    for (const hit of this.hits) {
      // Collision hulls are two-sided. The recovered Build 5875 floor/wall split uses
      // |normal.z|, so raw faces remain walkable regardless of their stored winding.
      if (!this.surfaceNormal(hit, this.normal) || Math.abs(this.normal.z) < WALKABLE_NORMAL_Z) continue;
      const aboveTerrain = hit.point.z > terrainHeight + skin;
      const validBelowTerrain = allowWmoBelowTerrain && hit.point.z <= maxZ + skin;
      if (aboveTerrain || validBelowTerrain) {
        const terrainType = Number(hit.object.userData?.terrainType);
        return {
          height: hit.point.z,
          source: 'wmo',
          terrainType: Number.isFinite(terrainType) ? terrainType : 2,
        };
      }
      // Intersections are nearest-first. Once the highest walkable face is
      // below outdoor terrain, lower WMO floors cannot be valid outdoors.
      break;
    }
    return null;
  }

  private isGroundSupportReachable(
    centerX: number,
    centerY: number,
    supportX: number,
    supportY: number,
    supportZ: number,
    candidates: THREE.Mesh[],
  ): boolean {
    this.direction.set(supportX - centerX, supportY - centerY, 0);
    const distance = this.direction.length();
    if (distance <= PLAYER_COLLISION_CYLINDER.skin * 2) return true;
    this.direction.multiplyScalar(1 / distance);
    this.origin.set(centerX, centerY, supportZ + PLAYER_COLLISION_CYLINDER.skin * 2);
    this.raycaster.set(this.origin, this.direction);
    this.raycaster.near = PLAYER_COLLISION_CYLINDER.skin;
    this.raycaster.far = Math.max(this.raycaster.near, distance - PLAYER_COLLISION_CYLINDER.skin);
    this.intersectCandidates(candidates);
    for (const hit of this.hits) {
      if (!this.surfaceNormal(hit, this.normal)) continue;
      if (Math.abs(this.normal.z) <= WALKABLE_NORMAL_Z) return false;
    }
    return true;
  }

  private surfaceNormal(hit: THREE.Intersection, target: THREE.Vector3): THREE.Vector3 | null {
    if (!hit.face) return null;
    this.normalMatrix.getNormalMatrix(hit.object.matrixWorld);
    return target.copy(hit.face.normal).applyNormalMatrix(this.normalMatrix).normalize();
  }

  private intersectCandidates(candidates: THREE.Mesh[]): void {
    const cpuScope = beginCpuScope(CpuScopeId.CollisionBvhRaycasts);
    try {
    this.raycasts++;
    this.hits.length = 0;
    this.raycaster.intersectObjects(this.rayCandidates.filter(this.raycaster, candidates), false, this.hits);
    this.intersections += this.hits.length;
    } finally { this.rayCandidates.release(); endCpuScope(cpuScope); }
  }

  private indexEntry(entry: WorldCollisionEntry): void {
    const { min, max } = entry.bounds;
    if (![min.x, min.y, max.x, max.y].every(Number.isFinite)) {
      entry.cells = null;
      this.globalEntries.push(entry);
      return;
    }
    const minX = gridCoordinate(min.x), maxX = gridCoordinate(max.x);
    const minY = gridCoordinate(min.y), maxY = gridCoordinate(max.y);
    const cellCount = (maxX - minX + 1) * (maxY - minY + 1);
    if (cellCount > MAX_GRID_CELLS_PER_ENTRY) {
      entry.cells = null;
      this.globalEntries.push(entry);
      return;
    }
    const cells: number[] = [];
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      const key = gridKey(x, y);
      let bucket = this.spatialEntries.get(key);
      if (!bucket) { bucket = []; this.spatialEntries.set(key, bucket); }
      bucket.push(entry);
      cells.push(key);
    }
    entry.cells = cells;
  }

  private unindexEntry(entry: WorldCollisionEntry): void {
    if (!entry.cells) {
      const index = this.globalEntries.indexOf(entry);
      if (index >= 0) this.globalEntries.splice(index, 1);
      return;
    }
    for (const key of entry.cells) {
      const bucket = this.spatialEntries.get(key);
      if (!bucket) continue;
      const index = bucket.indexOf(entry);
      if (index >= 0) bucket.splice(index, 1);
      if (!bucket.length) this.spatialEntries.delete(key);
    }
  }

  private rebuildSpatialIndex(): void {
    this.spatialEntries.clear();
    this.globalEntries.length = 0;
    for (const entry of this.entries) this.indexEntry(entry);
  }

  private collectCandidates(bounds: THREE.Box3, source?: WorldCollisionSource): THREE.Mesh[] {
    this.broadphaseQueries++;
    this.candidates.length = 0;
    const stamp = ++this.queryStamp;
    const minX = gridCoordinate(bounds.min.x), maxX = gridCoordinate(bounds.max.x);
    const minY = gridCoordinate(bounds.min.y), maxY = gridCoordinate(bounds.max.y);
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      this.broadphaseCellVisits++;
      const bucket = this.spatialEntries.get(gridKey(x, y));
      if (!bucket) continue;
      for (const entry of bucket) {
        if (entry.queryStamp === stamp) continue;
        entry.queryStamp = stamp;
        this.broadphaseEntryTests++;
        if ((!source || entry.source === source) && entry.bounds.intersectsBox(bounds)) this.candidates.push(entry.mesh);
      }
    }
    for (const entry of this.globalEntries) {
      if (entry.queryStamp === stamp) continue;
      entry.queryStamp = stamp;
      this.broadphaseEntryTests++;
      if ((!source || entry.source === source) && entry.bounds.intersectsBox(bounds)) this.candidates.push(entry.mesh);
    }
    this.broadphaseCandidates += this.candidates.length;
    this.maxCandidatesPerQuery = Math.max(this.maxCandidatesPerQuery, this.candidates.length);
    return this.candidates;
  }
}

/** Coarse march step, yards. ADT heightmap vertices sit ~4.17yd apart, so this samples every cell. */
const HEIGHTFIELD_MARCH_STEP = 1;
/** Bisection passes after the first below-ground sample: 1yd >> 8 lands inside 0.004yd. */
const HEIGHTFIELD_REFINE_STEPS = 8;


export function clampSegmentToHeightfield(
  start: THREE.Vector3,
  end: THREE.Vector3,
  sampleHeight: (x: number, y: number) => number,
  padding = 0,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(length > 1e-5)) return target.copy(end);

  // Positive while the segment is above ground at parameter t.
  const clearanceAt = (t: number) => start.z + dz * t - sampleHeight(start.x + dx * t, start.y + dy * t);
  if (clearanceAt(0) <= 0) return target.copy(end);

  let lastAbove = 0;
  let firstBelow = -1;
  const steps = Math.max(1, Math.ceil(length / HEIGHTFIELD_MARCH_STEP));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (clearanceAt(t) <= 0) {
      firstBelow = t;
      break;
    }
    lastAbove = t;
  }
  if (firstBelow < 0) return target.copy(end);

  for (let i = 0; i < HEIGHTFIELD_REFINE_STEPS; i++) {
    const mid = (lastAbove + firstBelow) / 2;
    if (clearanceAt(mid) <= 0) firstBelow = mid;
    else lastAbove = mid;
  }

  const stopped = Math.max(0, lastAbove * length - padding);
  const scale = stopped / length;
  return target.set(start.x + dx * scale, start.y + dy * scale, start.z + dz * scale);
}
