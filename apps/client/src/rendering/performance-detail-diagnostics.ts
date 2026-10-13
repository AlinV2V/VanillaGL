import * as THREE from 'three';
import { performanceAblations, performanceControlState } from './performance-controls';
import { performanceSubsystemDiagnostics } from './performance-subsystem-metrics';
import { registerPerformanceWmoObject } from './performance-renderer-attribution';
import { wmoBatchedSubmissionMetrics } from './wmo-batched-experiment';
export { recordPick } from './performance-subsystem-metrics';
export { beginCpuScope, CpuScopeId, endCpuScope } from './performance-cpu-scopes';

export { performanceAblations } from './performance-controls';

type WmoVisibilityGroupLike = { index: number; objects: THREE.Object3D[] };
type WmoVisibilityInstanceLike = { model?: { name?: string }; groups: WmoVisibilityGroupLike[]; root: THREE.Object3D };

const requestedWmoVisibility = new WeakMap<THREE.Object3D, boolean>();
const visibleWmoMaterials = new Set<string>();
const visibleWmoGroups = new Set<string>();
let currentWmoVisibility = emptyWmoVisibility();
let currentWmoRender = emptyWmoRender();
let currentEntity = emptyEntity();

const cumulative = {
  wmoVisibilityPasses: 0,
  wmoInstances: 0,
  wmoGroupsEvaluated: 0,
  wmoRequestedVisibilityChanges: 0,
  wmoRenderFrames: 0,
  wmoSubmissions: 0,
  wmoTriangles: 0,
  entityFrames: 0,
  entityLightingLookups: 0,
  entityLightingCacheHits: 0,
  entityLightingCacheMisses: 0,
  entityLightingInstancesTested: 0,
  entityLightingIndoorResults: 0,
  entityLightingOutdoorResults: 0,
  entityLightingMocvSamples: 0,
  entityLightingLocalLights: 0,
  entityLightingTotalMs: 0,
  entityLightingMaxMs: 0,
  entityAnimationSamples: 0,
  entityAnimationTotalMs: 0,
  entityAnimationMaxMs: 0,
};

function emptyWmoVisibility() {
  return {
    instances: 0,
    groupsEvaluated: 0,
    groupsRequestedVisible: 0,
    groupsRequestedHidden: 0,
    batchesRequestedVisible: 0,
    batchesRequestedHidden: 0,
    requestedVisibilityChanges: 0,
  };
}

function emptyWmoRender() {
  return { submissions: 0, triangles: 0, visibleMaterials: 0, visibleGroups: 0 };
}

function emptyEntity() {
  return {
    lightingLookups: 0,
    lightingCacheHits: 0,
    lightingCacheMisses: 0,
    lightingInstancesTested: 0,
    lightingIndoorResults: 0,
    lightingOutdoorResults: 0,
    lightingMocvSamples: 0,
    lightingLocalLights: 0,
    lightingTotalMs: 0,
    lightingMaxMs: 0,
    animationSamples: 0,
    animationTotalMs: 0,
    animationMaxMs: 0,
  };
}

export const beginWmoVisibilityDiagnostics = (instanceCount: number): void => {
  if (!performanceAblations.detail) return;
  currentWmoVisibility = emptyWmoVisibility();
  currentWmoVisibility.instances = instanceCount;
  cumulative.wmoVisibilityPasses++;
  cumulative.wmoInstances += instanceCount;
};

export const recordWmoGroupVisibility = (group: WmoVisibilityGroupLike, visible: boolean): void => {
  if (!performanceAblations.detail) return;
  currentWmoVisibility.groupsEvaluated++;
  cumulative.wmoGroupsEvaluated++;
  if (visible) currentWmoVisibility.groupsRequestedVisible++;
  else currentWmoVisibility.groupsRequestedHidden++;
  for (const object of group.objects) {
    if (object.userData.wmoPick?.kind !== 'wmoBatch') continue;
    if (visible) currentWmoVisibility.batchesRequestedVisible++;
    else currentWmoVisibility.batchesRequestedHidden++;
    const prior = requestedWmoVisibility.get(object);
    requestedWmoVisibility.set(object, visible);
    if (prior !== undefined && prior !== visible) {
      currentWmoVisibility.requestedVisibilityChanges++;
      cumulative.wmoRequestedVisibilityChanges++;
    }
  }
};

export const beginDetailedRenderFrame = (): void => {
  if (!performanceAblations.detail) return;
  currentWmoRender = emptyWmoRender();
  visibleWmoMaterials.clear();
  visibleWmoGroups.clear();
  cumulative.wmoRenderFrames++;
};

export const instrumentWmoBatch = (mesh: THREE.Mesh, groupKey: string): void => {
  registerPerformanceWmoObject(mesh);
  if (!performanceAblations.detail) return;
  const original = mesh.onBeforeRender;
  mesh.onBeforeRender = function (...args: Parameters<THREE.Object3D['onBeforeRender']>) {
    original.apply(this, args);
    const geometry = args[3] as THREE.BufferGeometry;
    const material = args[4] as THREE.Material;
    const batched = wmoBatchedSubmissionMetrics(this);
    if (batched) {
      currentWmoRender.submissions += batched.lastApiSubmissions;
      currentWmoRender.triangles += batched.lastTriangles;
      visibleWmoMaterials.add(material.uuid); visibleWmoGroups.add(groupKey);
      currentWmoRender.visibleMaterials = visibleWmoMaterials.size; currentWmoRender.visibleGroups = visibleWmoGroups.size;
      cumulative.wmoSubmissions += batched.lastApiSubmissions; cumulative.wmoTriangles += batched.lastTriangles;
      return;
    }
    const renderGroup = args[5] as { count: number } | null;
    const drawCount = renderGroup?.count
      ?? (Number.isFinite(geometry.drawRange.count) ? geometry.drawRange.count : geometry.index?.count)
      ?? geometry.getAttribute('position')?.count
      ?? 0;
    const triangles = Math.max(0, Math.floor(drawCount / 3));
    currentWmoRender.submissions++;
    currentWmoRender.triangles += triangles;
    visibleWmoMaterials.add(material.uuid);
    visibleWmoGroups.add(groupKey);
    currentWmoRender.visibleMaterials = visibleWmoMaterials.size;
    currentWmoRender.visibleGroups = visibleWmoGroups.size;
    cumulative.wmoSubmissions++;
    cumulative.wmoTriangles += triangles;
  };
};

export const suppressWmoRenderingForAblation = (instances: readonly WmoVisibilityInstanceLike[]): void => {
  if (!performanceAblations.wmoRenderOff) return;
  for (const instance of instances) for (const group of instance.groups) {
    for (const object of group.objects) object.visible = false;
  }
};

export const beginEntityDetailFrame = (): void => {
  if (!performanceAblations.detail) return;
  currentEntity = emptyEntity();
  cumulative.entityFrames++;
};

export const recordEntityLightingLookup = (sample: {
  cacheHit: boolean;
  instancesTested: number;
  indoor: boolean;
  mocv: boolean;
  localLights: number;
  startedAt: number;
}): void => {
  if (!performanceAblations.detail) return;
  const elapsedMs = performance.now() - sample.startedAt;
  currentEntity.lightingLookups++;
  cumulative.entityLightingLookups++;
  const cacheField = sample.cacheHit ? 'lightingCacheHits' : 'lightingCacheMisses';
  currentEntity[cacheField]++;
  cumulative[sample.cacheHit ? 'entityLightingCacheHits' : 'entityLightingCacheMisses']++;
  currentEntity.lightingInstancesTested += sample.instancesTested;
  cumulative.entityLightingInstancesTested += sample.instancesTested;
  if (sample.indoor) { currentEntity.lightingIndoorResults++; cumulative.entityLightingIndoorResults++; }
  else { currentEntity.lightingOutdoorResults++; cumulative.entityLightingOutdoorResults++; }
  if (sample.mocv) { currentEntity.lightingMocvSamples++; cumulative.entityLightingMocvSamples++; }
  currentEntity.lightingLocalLights += sample.localLights;
  cumulative.entityLightingLocalLights += sample.localLights;
  currentEntity.lightingTotalMs += elapsedMs;
  currentEntity.lightingMaxMs = Math.max(currentEntity.lightingMaxMs, elapsedMs);
  cumulative.entityLightingTotalMs += elapsedMs;
  cumulative.entityLightingMaxMs = Math.max(cumulative.entityLightingMaxMs, elapsedMs);
};

export const recordEntityAnimationSample = (elapsedMs: number): void => {
  if (!performanceAblations.detail) return;
  currentEntity.animationSamples++;
  currentEntity.animationTotalMs += elapsedMs;
  currentEntity.animationMaxMs = Math.max(currentEntity.animationMaxMs, elapsedMs);
  cumulative.entityAnimationSamples++;
  cumulative.entityAnimationTotalMs += elapsedMs;
  cumulative.entityAnimationMaxMs = Math.max(cumulative.entityAnimationMaxMs, elapsedMs);
};

export const performanceDetailDiagnostics = () => ({
  enabled: performanceAblations.detail,
  ablations: {
    detail: performanceAblations.detail,
    wmoRenderOff: performanceAblations.wmoRenderOff,
    entityLightingOff: performanceAblations.entityLightingOff,
    entityAnimationOff: performanceAblations.entityAnimationOff,
  },
  controls: performanceControlState(),
  subsystemCosts: performanceSubsystemDiagnostics(),
  wmoVisibility: { ...currentWmoVisibility },
  wmoRender: { ...currentWmoRender },
  entities: { ...currentEntity },
  cumulative: { ...cumulative },
});
