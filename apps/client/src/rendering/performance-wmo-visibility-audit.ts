import * as THREE from 'three';

export const enum WmoVisibilityDecisionReason {
  Disabled,
  NoPortalData,
  OutsideCamera,
  PortalSealed,
  Levitating,
  InteriorComponent,
  OutsideComponent,
  Exempt,
}

const REASON_NAMES = [
  'disabled', 'no-portal-data', 'outside-camera', 'portal-sealed', 'levitating',
  'interior-component', 'outside-component', 'portal-exempt',
] as const;

export type WmoVisibilityAuditOptions = {
  /** Run bounds/frustum classification every N capture frames. Default 30 (about 2 Hz). */
  sampleEveryFrames?: number;
  /** Hard bounds for capture-owned metadata. */
  maxGroups?: number;
  maxBatches?: number;
  frameBuffer?: number;
};

type AuditBatch = {
  object: THREE.Object3D;
  geometry: THREE.BufferGeometry;
  groupId: number;
  lastSubmittedFrame: number;
};

type AuditGroup = {
  id: number;
  root: THREE.Object3D;
  rootLabel: string;
  groupIndex: number;
  flags: number;
  localBounds: THREE.Box3;
  batches: AuditBatch[];
};

export type WmoVisibilityAuditSnapshot = {
  schema: 'vanillagl.wmo-visibility-audit/v1';
  active: boolean;
  frames: number;
  sampledFrames: number;
  limits: { sampleEveryFrames: number; maxGroups: number; maxBatches: number; frameBuffer: number };
  camera: { effectiveFarClip: number | null; minFarClip: number | null; maxFarClip: number | null; nearClip: number | null };
  summary: {
    evaluatedGroups: number; portalVisibleGroups: number; portalHiddenGroups: number;
    submittedGroups: number; submittedDraws: number; submittedBeyondFarGroups: number;
    submittedOutsideFrustumGroups: number; submittedPortalHiddenGroups: number;
    submittedBatchesBeyondFar: number; submittedBatchesOutsideFrustum: number;
    submittedBatchesWithCullingDisabled: number; visibleInFrustumNotSubmittedGroups: number;
    missingGroupBounds: number; missingBatchBounds: number;
  };
  groups: Array<{
    id: number; root: string; groupIndex: number; flags: number; batches: number;
    latestPortalDecision: string; latestCurrentGroup: number; sampledFrames: number;
    portalVisibleFrames: number; portalHiddenFrames: number; submittedFrames: number; submittedDraws: number;
    minNearestDistance: number | null; latestNearestDistance: number | null; latestBoundsRadius: number | null;
    submittedBeyondFarFrames: number; submittedOutsideFrustumFrames: number; submittedPortalHiddenFrames: number;
    submittedBatchesBeyondFar: number; submittedBatchesOutsideFrustum: number; submittedBatchesWithCullingDisabled: number;
  }>;
  frameSamples: Array<{
    id: number; farClip: number; evaluatedGroups: number; portalVisibleGroups: number; portalHiddenGroups: number;
    submittedGroups: number; submittedDraws: number; submittedBeyondFarGroups: number;
    submittedOutsideFrustumGroups: number; submittedPortalHiddenGroups: number;
    submittedBatchesBeyondFar: number; submittedBatchesOutsideFrustum: number;
    visibleInFrustumNotSubmittedGroups: number;
  }>;
  overhead: { sampledEvaluationTotalMs: number; meanSampleMs: number; maxSampleMs: number; timingPerGroupOrDraw: false; note: string };
};

const round = (value: number): number => Number(value.toFixed(3));
let liveAudit: WmoVisibilityAuditSession | null = null;

export const recordPerformanceWmoVisibilityDecision = (
  root: THREE.Object3D,
  groupIndex: number,
  visible: boolean,
  reason: WmoVisibilityDecisionReason,
  currentGroup: number,
): void => { liveAudit?.recordDecision(root, groupIndex, visible, reason, currentGroup); };

export const performanceWmoVisibilityAuditActive = (): boolean => liveAudit !== null;

export class WmoVisibilityAuditSession {
  private readonly groups: AuditGroup[] = [];
  private readonly batches: AuditBatch[] = [];
  private readonly byObject = new WeakMap<THREE.Object3D, AuditBatch>();
  private readonly byRoot = new WeakMap<THREE.Object3D, Map<number, number>>();
  private readonly draws: Uint32Array;
  private readonly activeIds: Uint32Array;
  private readonly decisionFrame: Uint32Array;
  private readonly portalVisible: Uint8Array;
  private readonly decisionReason: Uint8Array;
  private readonly currentGroup: Int16Array;
  private readonly sampled: Uint32Array;
  private readonly portalVisibleFrames: Uint32Array;
  private readonly portalHiddenFrames: Uint32Array;
  private readonly submittedFrames: Uint32Array;
  private readonly submittedDraws: Float64Array;
  private readonly beyondFarFrames: Uint32Array;
  private readonly outsideFrustumFrames: Uint32Array;
  private readonly portalHiddenSubmittedFrames: Uint32Array;
  private readonly batchBeyondFar: Uint32Array;
  private readonly batchOutsideFrustum: Uint32Array;
  private readonly batchCullingDisabled: Uint32Array;
  private readonly minDistance: Float64Array;
  private readonly latestDistance: Float64Array;
  private readonly latestRadius: Float64Array;
  private readonly frameData: Float64Array;
  private readonly frameIds: Uint32Array;
  private readonly sampleTotals = new Float64Array(12);
  private readonly sampleEvery: number;
  private readonly maxGroups: number;
  private readonly maxBatches: number;
  private readonly frameBuffer: number;
  private readonly projection = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly cameraSpaceCenter = new THREE.Vector3();
  private readonly worldBox = new THREE.Box3();
  private readonly sphere = new THREE.Sphere();
  private camera: THREE.Camera | null = null;
  private frameId = 0;
  private activeCount = 0;
  private sampleCount = 0;
  private sampleCursor = 0;
  private evaluationTotalMs = 0;
  private evaluationMaxMs = 0;
  private minFar = Infinity;
  private maxFar = 0;
  private lastFar = 0;
  private lastNear = 0;
  private disposed = false;

  constructor(options: WmoVisibilityAuditOptions = {}) {
    this.sampleEvery = Math.max(1, Math.min(300, Math.floor(options.sampleEveryFrames ?? 30)));
    this.maxGroups = Math.max(128, Math.min(16_384, Math.floor(options.maxGroups ?? 8_192)));
    this.maxBatches = Math.max(256, Math.min(32_768, Math.floor(options.maxBatches ?? 16_384)));
    this.frameBuffer = Math.max(8, Math.min(600, Math.floor(options.frameBuffer ?? 120)));
    this.draws = new Uint32Array(this.maxGroups); this.activeIds = new Uint32Array(this.maxGroups);
    this.decisionFrame = new Uint32Array(this.maxGroups); this.portalVisible = new Uint8Array(this.maxGroups);
    this.decisionReason = new Uint8Array(this.maxGroups); this.currentGroup = new Int16Array(this.maxGroups); this.currentGroup.fill(-1);
    this.sampled = new Uint32Array(this.maxGroups); this.portalVisibleFrames = new Uint32Array(this.maxGroups); this.portalHiddenFrames = new Uint32Array(this.maxGroups);
    this.submittedFrames = new Uint32Array(this.maxGroups); this.submittedDraws = new Float64Array(this.maxGroups);
    this.beyondFarFrames = new Uint32Array(this.maxGroups); this.outsideFrustumFrames = new Uint32Array(this.maxGroups); this.portalHiddenSubmittedFrames = new Uint32Array(this.maxGroups);
    this.batchBeyondFar = new Uint32Array(this.maxGroups); this.batchOutsideFrustum = new Uint32Array(this.maxGroups); this.batchCullingDisabled = new Uint32Array(this.maxGroups);
    this.minDistance = new Float64Array(this.maxGroups); this.minDistance.fill(Infinity);
    this.latestDistance = new Float64Array(this.maxGroups); this.latestDistance.fill(NaN);
    this.latestRadius = new Float64Array(this.maxGroups); this.latestRadius.fill(NaN);
    this.frameIds = new Uint32Array(this.frameBuffer); this.frameData = new Float64Array(this.frameBuffer * 12);
    liveAudit = this;
  }

  register(object: THREE.Object3D): void {
    if (this.disposed || this.byObject.has(object) || this.batches.length >= this.maxBatches) return;
    let root: THREE.Object3D | null = null; let batchData: Record<string, unknown> | null = null;
    for (let current: THREE.Object3D | null = object; current; current = current.parent) {
      if (current.userData.wmoPick?.kind === 'wmo') root = current;
      if (current.userData.wmoPick?.kind === 'wmoBatch') batchData = current.userData.wmoPick as Record<string, unknown>;
    }
    const mesh = object as THREE.Mesh; const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    const groupIndex = Number(batchData?.groupIndex);
    if (!root || !batchData || !geometry || !Number.isFinite(groupIndex)) return;
    let rootGroups = this.byRoot.get(root); if (!rootGroups) { rootGroups = new Map(); this.byRoot.set(root, rootGroups); }
    let groupId = rootGroups.get(groupIndex);
    if (groupId === undefined) {
      if (this.groups.length >= this.maxGroups) return;
      const pick = root.userData.wmoPick as Record<string, unknown>;
      groupId = this.groups.length;
      this.groups.push({ id: groupId, root, rootLabel: `${String(pick.model ?? 'unknown')}#${String(pick.uniqueId ?? '?')}@${String(pick.tile ?? '?')}`, groupIndex, flags: Number(batchData.groupFlags ?? 0), localBounds: new THREE.Box3(), batches: [] });
      rootGroups.set(groupIndex, groupId);
    }
    const entry = { object, geometry, groupId, lastSubmittedFrame: 0 };
    this.batches.push(entry); this.groups[groupId].batches.push(entry); this.byObject.set(object, entry);
    if (geometry.boundingBox) this.groups[groupId].localBounds.union(geometry.boundingBox);
  }

  beginFrame(): void {
    for (let index = 0; index < this.activeCount; index++) this.draws[this.activeIds[index]] = 0;
    this.activeCount = 0; this.frameId++;
  }

  observeCamera(camera: THREE.Camera): void { this.camera = camera; }

  record(object: THREE.Object3D): void {
    const batch = this.byObject.get(object); if (!batch) return;
    const id = batch.groupId; batch.lastSubmittedFrame = this.frameId;
    if (this.draws[id] === 0 && this.activeCount < this.activeIds.length) this.activeIds[this.activeCount++] = id;
    this.draws[id]++;
  }

  recordDecision(root: THREE.Object3D, groupIndex: number, visible: boolean, reason: WmoVisibilityDecisionReason, currentGroup: number): void {
    const id = this.byRoot.get(root)?.get(groupIndex); if (id === undefined) return;
    this.decisionFrame[id] = this.frameId; this.portalVisible[id] = visible ? 1 : 0; this.decisionReason[id] = reason; this.currentGroup[id] = currentGroup;
  }

  endFrame(): void {
    const camera = this.camera as (THREE.Camera & { near?: number; far?: number }) | null;
    if (this.disposed || !camera || this.frameId % this.sampleEvery !== 0) return;
    const started = performance.now();
    this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); this.frustum.setFromProjectionMatrix(this.projection);
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    const far = Number(camera.far); const near = Number(camera.near);
    this.lastFar = Number.isFinite(far) ? far : 0; this.lastNear = Number.isFinite(near) ? near : 0;
    if (this.lastFar > 0) { this.minFar = Math.min(this.minFar, this.lastFar); this.maxFar = Math.max(this.maxFar, this.lastFar); }
    const totals = this.sampleTotals; totals.fill(0); totals[0] = this.lastFar;
    for (const group of this.groups) this.sampleGroup(group, this.lastFar, totals);
    const slot = this.sampleCursor; this.frameIds[slot] = this.frameId; this.frameData.set(totals, slot * totals.length);
    this.sampleCursor = (slot + 1) % this.frameBuffer; this.sampleCount = Math.min(this.frameBuffer, this.sampleCount + 1);
    const elapsed = performance.now() - started; this.evaluationTotalMs += elapsed; this.evaluationMaxMs = Math.max(this.evaluationMaxMs, elapsed);
  }

  snapshot(): WmoVisibilityAuditSnapshot {
    const summary = new Float64Array(12); for (let index = 0; index < this.sampleCount; index++) {
      const slot = (this.sampleCursor - this.sampleCount + index + this.frameBuffer) % this.frameBuffer;
      for (let metric = 0; metric < summary.length; metric++) summary[metric] += this.frameData[slot * summary.length + metric];
    }
    const frameSamples: WmoVisibilityAuditSnapshot['frameSamples'] = [];
    for (let index = 0; index < this.sampleCount; index++) {
      const slot = (this.sampleCursor - this.sampleCount + index + this.frameBuffer) % this.frameBuffer; const base = slot * 12;
      frameSamples.push({ id: this.frameIds[slot], farClip: this.frameData[base], evaluatedGroups: this.frameData[base + 1], portalVisibleGroups: this.frameData[base + 2], portalHiddenGroups: this.frameData[base + 3], submittedGroups: this.frameData[base + 4], submittedDraws: this.frameData[base + 5], submittedBeyondFarGroups: this.frameData[base + 6], submittedOutsideFrustumGroups: this.frameData[base + 7], submittedPortalHiddenGroups: this.frameData[base + 8], submittedBatchesBeyondFar: this.frameData[base + 9], submittedBatchesOutsideFrustum: this.frameData[base + 10], visibleInFrustumNotSubmittedGroups: this.frameData[base + 11] });
    }
    return {
      schema: 'vanillagl.wmo-visibility-audit/v1', active: !this.disposed, frames: this.frameId, sampledFrames: this.sampleCount,
      limits: { sampleEveryFrames: this.sampleEvery, maxGroups: this.maxGroups, maxBatches: this.maxBatches, frameBuffer: this.frameBuffer },
      camera: { effectiveFarClip: this.lastFar || null, minFarClip: Number.isFinite(this.minFar) ? this.minFar : null, maxFarClip: this.maxFar || null, nearClip: this.lastNear || null },
      summary: { evaluatedGroups: summary[1], portalVisibleGroups: summary[2], portalHiddenGroups: summary[3], submittedGroups: summary[4], submittedDraws: summary[5], submittedBeyondFarGroups: summary[6], submittedOutsideFrustumGroups: summary[7], submittedPortalHiddenGroups: summary[8], submittedBatchesBeyondFar: summary[9], submittedBatchesOutsideFrustum: summary[10], submittedBatchesWithCullingDisabled: this.sum(this.batchCullingDisabled), visibleInFrustumNotSubmittedGroups: summary[11], missingGroupBounds: this.groups.filter((group) => group.localBounds.isEmpty()).length, missingBatchBounds: this.batches.filter((batch) => !batch.geometry.boundingSphere).length },
      groups: this.groups.map((group) => ({ id: group.id, root: group.rootLabel, groupIndex: group.groupIndex, flags: group.flags, batches: group.batches.length, latestPortalDecision: this.decisionFrame[group.id] ? REASON_NAMES[this.decisionReason[group.id]] ?? 'unknown' : 'unknown', latestCurrentGroup: this.currentGroup[group.id], sampledFrames: this.sampled[group.id], portalVisibleFrames: this.portalVisibleFrames[group.id], portalHiddenFrames: this.portalHiddenFrames[group.id], submittedFrames: this.submittedFrames[group.id], submittedDraws: this.submittedDraws[group.id], minNearestDistance: Number.isFinite(this.minDistance[group.id]) ? round(this.minDistance[group.id]) : null, latestNearestDistance: Number.isFinite(this.latestDistance[group.id]) ? round(this.latestDistance[group.id]) : null, latestBoundsRadius: Number.isFinite(this.latestRadius[group.id]) ? round(this.latestRadius[group.id]) : null, submittedBeyondFarFrames: this.beyondFarFrames[group.id], submittedOutsideFrustumFrames: this.outsideFrustumFrames[group.id], submittedPortalHiddenFrames: this.portalHiddenSubmittedFrames[group.id], submittedBatchesBeyondFar: this.batchBeyondFar[group.id], submittedBatchesOutsideFrustum: this.batchOutsideFrustum[group.id], submittedBatchesWithCullingDisabled: this.batchCullingDisabled[group.id] })),
      frameSamples,
      overhead: { sampledEvaluationTotalMs: round(this.evaluationTotalMs), meanSampleMs: round(this.evaluationTotalMs / Math.max(1, this.sampleCount)), maxSampleMs: round(this.evaluationMaxMs), timingPerGroupOrDraw: false, note: 'Bounds/frustum classification is capture-only and sampled at frame boundaries. No timer runs per group or submitted draw; use a clean capture for baseline FPS.' },
    };
  }

  dispose(): void { if (this.disposed) return; this.disposed = true; if (liveAudit === this) liveAudit = null; }

  private sampleGroup(group: AuditGroup, far: number, totals: Float64Array): void {
    const id = group.id; const hasDecision = this.decisionFrame[id] === this.frameId; const submitted = this.draws[id] > 0;
    if (!hasDecision && !submitted) return;
    totals[1]++; this.sampled[id]++; if (hasDecision && this.portalVisible[id]) { totals[2]++; this.portalVisibleFrames[id]++; } else if (hasDecision) { totals[3]++; this.portalHiddenFrames[id]++; }
    let inFrustum = false; let beyondFar = false; let nearest = Infinity;
    if (!group.localBounds.isEmpty()) {
      this.worldBox.copy(group.localBounds).applyMatrix4(group.root.matrixWorld); nearest = this.worldBox.distanceToPoint(this.cameraPosition);
      inFrustum = this.frustum.intersectsBox(this.worldBox); this.worldBox.getBoundingSphere(this.sphere); this.latestRadius[id] = this.sphere.radius;
      this.cameraSpaceCenter.copy(this.sphere.center).applyMatrix4(this.camera!.matrixWorldInverse);
      beyondFar = far > 0 && -this.cameraSpaceCenter.z - this.sphere.radius > far;
      this.latestDistance[id] = nearest; this.minDistance[id] = Math.min(this.minDistance[id], nearest);
    }
    if (submitted) {
      totals[4]++; totals[5] += this.draws[id]; this.submittedFrames[id]++; this.submittedDraws[id] += this.draws[id];
      if (beyondFar) { totals[6]++; this.beyondFarFrames[id]++; }
      if (!inFrustum && !group.localBounds.isEmpty()) { totals[7]++; this.outsideFrustumFrames[id]++; }
      if (hasDecision && !this.portalVisible[id]) { totals[8]++; this.portalHiddenSubmittedFrames[id]++; }
      for (const batch of group.batches) if (batch.lastSubmittedFrame === this.frameId) this.sampleBatch(batch, far, totals);
    } else if (hasDecision && this.portalVisible[id] && inFrustum) totals[11]++;
  }

  private sampleBatch(batch: AuditBatch, far: number, totals: Float64Array): void {
    const bounds = batch.geometry.boundingSphere; if (!bounds) return;
    this.sphere.copy(bounds).applyMatrix4(batch.object.matrixWorld);
    this.cameraSpaceCenter.copy(this.sphere.center).applyMatrix4(this.camera!.matrixWorldInverse);
    if (far > 0 && -this.cameraSpaceCenter.z - this.sphere.radius > far) { totals[9]++; this.batchBeyondFar[batch.groupId]++; }
    if (!this.frustum.intersectsSphere(this.sphere)) { totals[10]++; this.batchOutsideFrustum[batch.groupId]++; }
    if (!batch.object.frustumCulled) this.batchCullingDisabled[batch.groupId]++;
  }

  private sum(values: Uint32Array): number { let total = 0; for (let index = 0; index < this.groups.length; index++) total += values[index]; return total; }
}
