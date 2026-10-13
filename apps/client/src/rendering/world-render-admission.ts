import * as THREE from 'three';
import { beginCpuScope, CpuScopeId, endCpuScope } from './performance-cpu-scopes';

type AdmissionLane = 'doodad' | 'wmo';
type QueuedAdmission = { lane: AdmissionLane; priority: number; order: number; queuedAt: number };

const pendingAdmissions = new Map<THREE.Object3D, QueuedAdmission>();
let nextOrder = 0;
let pendingObjects = 0;
const totals = {
  stagedGroups: 0,
  stagedObjects: 0,
  admittedObjects: 0,
  cancelledRequests: 0,
  abandonedObjects: 0,
  pumps: 0,
  framesWithAdmissions: 0,
  peakQueued: 0,
  maxAdmittedInOnePump: 0,
};

const admissionLane = (object: THREE.Object3D): AdmissionLane | null => {
  if ((object as THREE.InstancedMesh).isInstancedMesh && object.userData.wowDoodad) return 'doodad';
  if ((object as THREE.Mesh).isMesh && object.userData.wmoPick?.kind === 'wmoBatch') return 'wmo';
  return null;
};

const pendingLane = (object: THREE.Object3D): AdmissionLane | null => {
  const lane = object.userData.wowRenderAdmissionPending;
  return lane === 'doodad' || lane === 'wmo' ? lane : null;
};

/**
 * Hide only bulk streamed render objects before a newly built tile enters the live scene. Terrain,
 * water, collision, and already-loaded tiles remain immediate. The normal culling passes then
 * request just the objects that the current camera can see.
 */
export const stageWorldRenderAdmission = (root: THREE.Object3D): number => {
  let staged = 0;
  root.traverse((object) => {
    const lane = admissionLane(object);
    if (!lane || pendingLane(object)) return;
    object.userData.wowRenderAdmissionPending = lane;
    object.visible = false;
    pendingObjects++;
    staged++;
  });
  if (staged > 0) {
    totals.stagedGroups++;
    totals.stagedObjects += staged;
  }
  return staged;
};

/**
 * Admission-aware replacement for direct Object3D visibility writes. Pending objects stay hidden
 * until the bounded per-frame pump selects them; later visibility changes behave normally.
 */
export const setWorldRenderObjectVisible = (
  object: THREE.Object3D,
  visible: boolean,
  priority = 0,
): boolean => {
  const lane = pendingLane(object);
  if (!lane) {
    object.visible = visible;
    return object.visible;
  }

  object.visible = false;
  if (!visible) {
    if (pendingAdmissions.delete(object)) totals.cancelledRequests++;
    return false;
  }

  const normalizedPriority = Number.isFinite(priority) ? priority : Number.MAX_SAFE_INTEGER;
  const queued = pendingAdmissions.get(object);
  if (queued) queued.priority = normalizedPriority;
  else pendingAdmissions.set(object, { lane, priority: normalizedPriority, order: nextOrder++, queuedAt: performance.now() });
  totals.peakQueued = Math.max(totals.peakQueued, pendingAdmissions.size);
  return false;
};

type Candidate = { object: THREE.Object3D; entry: QueuedAdmission };
const compareCandidate = (left: Candidate, right: Candidate) =>
  left.entry.priority - right.entry.priority || left.entry.order - right.entry.order;
const retainBest = (values: Candidate[], candidate: Candidate, limit: number) => {
  if (limit < 1) return;
  const index = values.findIndex((value) => compareCandidate(candidate, value) < 0);
  if (index < 0) values.push(candidate); else values.splice(index, 0, candidate);
  if (values.length > limit) values.pop();
};

const admitSelected = ({ object, entry }: Candidate): boolean => {
  pendingAdmissions.delete(object);
  pendingObjects = Math.max(0, pendingObjects - 1);
  const lane = pendingLane(object);
  delete object.userData.wowRenderAdmissionPending;
  if (!object.parent || lane !== entry.lane) return false;
  object.visible = true;
  totals.admittedObjects++;
  return true;
};

/** Admit a bounded visible set per frame, reserving capacity for both structures and props. */
export const pumpWorldRenderAdmission = (maxObjects = 8): number => {
  const cpuScope = beginCpuScope(CpuScopeId.HydrationAdmissionQueues);
  try {
  totals.pumps++;
  const limit = Math.max(0, Math.floor(maxObjects));
  if (!limit) return 0;
  const reservedPerLane = Math.min(2, Math.ceil(limit / 2));
  const byLane: Record<AdmissionLane, Candidate[]> = { wmo: [], doodad: [] };
  const overall: Candidate[] = [];
  for (const [object, entry] of pendingAdmissions) {
    const candidate = { object, entry };
    retainBest(byLane[entry.lane], candidate, reservedPerLane);
    retainBest(overall, candidate, limit + reservedPerLane * 2);
  }
  const selected = new Set<THREE.Object3D>();
  const admissions: Candidate[] = [];
  for (const lane of ['wmo', 'doodad'] as const) for (const candidate of byLane[lane]) {
    if (admissions.length >= limit || selected.has(candidate.object)) continue;
    admissions.push(candidate); selected.add(candidate.object);
  }
  for (const candidate of overall) {
    if (admissions.length >= limit || selected.has(candidate.object)) continue;
    admissions.push(candidate); selected.add(candidate.object);
  }
  let admitted = 0;
  for (const candidate of admissions) if (admitSelected(candidate)) admitted++;
  if (admitted > 0) totals.framesWithAdmissions++;
  totals.maxAdmittedInOnePump = Math.max(totals.maxAdmittedInOnePump, admitted);
  return admitted;
  } finally { endCpuScope(cpuScope); }
};

/** Remove pending queue references before a streamed tile is disposed. */
export const clearWorldRenderAdmissionForGroup = (root: THREE.Object3D): void => {
  root.traverse((object) => {
    if (!pendingLane(object)) return;
    pendingAdmissions.delete(object);
    delete object.userData.wowRenderAdmissionPending;
    pendingObjects = Math.max(0, pendingObjects - 1);
    totals.abandonedObjects++;
  });
};

export const worldRenderAdmissionDiagnostics = () => {
  let oldestQueuedAt = Number.POSITIVE_INFINITY;
  for (const admission of pendingAdmissions.values()) oldestQueuedAt = Math.min(oldestQueuedAt, admission.queuedAt);
  return {
    ...totals,
    pendingObjects,
    queuedObjects: pendingAdmissions.size,
    oldestQueuedMs: Number.isFinite(oldestQueuedAt) ? performance.now() - oldestQueuedAt : 0,
  };
};
