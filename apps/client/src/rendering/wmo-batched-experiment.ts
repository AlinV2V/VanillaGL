import * as THREE from 'three';

export type WmoBatchExperimentMode = 'off' | 'auto' | 'fallback';

export type WmoBatchExperimentConfig = {
  mode: WmoBatchExperimentMode;
  rootNeedles: readonly string[];
};

type Candidate = {
  mesh: THREE.Mesh;
  groupObjects: THREE.Object3D[];
  groupIndex: number;
  mergedBatchCount: number;
};

type RuntimeMetrics = {
  mode: Exclude<WmoBatchExperimentMode, 'off'>;
  logicalRanges: number;
  sourceDraws: number;
  lastVisibleRanges: number;
  lastTriangles: number;
  lastApiSubmissions: number;
};

const diagnostics = {
  schema: 'vanillagl.wmo-batched-experiment/v1' as const,
  rootsConsidered: 0,
  rootsMatched: 0,
  selectedBuckets: 0,
  sourceDrawsPacked: 0,
  logicalRangesPacked: 0,
  packedVertices: 0,
  packedIndices: 0,
  extension: 'unknown' as 'unknown' | 'available' | 'unavailable',
  multiDrawFrames: 0,
  automaticFallbackFrames: 0,
  forcedFallbackFrames: 0,
  lastRoot: null as string | null,
  lastMaterial: null as string | null,
  lastVisibleRanges: 0,
  lastTriangles: 0,
  lastApiSubmissions: 0,
};

const runtimeConfig = (): WmoBatchExperimentConfig => {
  const development = import.meta.env?.DEV === true;
  const search = development && typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  const requested = search?.get('wmobatch')?.toLowerCase();
  const mode: WmoBatchExperimentMode = requested === 'auto' || requested === 'on'
    ? 'auto' : requested === 'fallback' ? 'fallback' : 'off';
  const root = search?.get('wmobatchroot')?.trim().toLowerCase();
  return { mode, rootNeedles: root ? [root] : ['stormwind.wmo', 'city_01.wmo'] };
};

const activeConfig = runtimeConfig();

export const wmoBatchExperimentSnapshot = () => ({
  ...diagnostics,
  enabled: activeConfig.mode !== 'off',
  mode: activeConfig.mode,
  rootNeedles: [...activeConfig.rootNeedles],
  intrusive: activeConfig.mode !== 'off',
  note: 'Development-only settled-frame experiment. Packing increases hydration work and memory; compare repeated captures after loading settles.',
});

declare global {
  // eslint-disable-next-line no-var
  var __vanillaWmoBatchExperiment: (() => ReturnType<typeof wmoBatchExperimentSnapshot>) | undefined;
}

if (activeConfig.mode !== 'off') globalThis.__vanillaWmoBatchExperiment = wmoBatchExperimentSnapshot;

const rangeCount = (geometry: THREE.BufferGeometry): number => {
  const total = geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0;
  return Math.max(0, Math.min(total - geometry.drawRange.start, geometry.drawRange.count));
};

/** Copy one indexed draw range into the compact layout required by BatchedMesh. Loader-time only. */
export function compactWmoBatchGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const sourceIndex = source.getIndex();
  if (!sourceIndex) throw new Error('WMO BatchedMesh experiment requires indexed geometry');
  const start = Math.max(0, source.drawRange.start);
  const count = rangeCount(source);
  const remap = new Map<number, number>();
  const vertices: number[] = [];
  const remapped = new Uint32Array(count);
  for (let offset = 0; offset < count; offset++) {
    const sourceVertex = sourceIndex.getX(start + offset);
    let compactVertex = remap.get(sourceVertex);
    if (compactVertex === undefined) {
      compactVertex = vertices.length;
      remap.set(sourceVertex, compactVertex);
      vertices.push(sourceVertex);
    }
    remapped[offset] = compactVertex;
  }

  const compact = new THREE.BufferGeometry();
  for (const name of Object.keys(source.attributes)) {
    const attribute = source.getAttribute(name) as THREE.BufferAttribute;
    const ArrayType = attribute.array.constructor as new (length: number) => typeof attribute.array;
    const target = new ArrayType(vertices.length * attribute.itemSize);
    for (let vertex = 0; vertex < vertices.length; vertex++) {
      const sourceOffset = vertices[vertex] * attribute.itemSize;
      const targetOffset = vertex * attribute.itemSize;
      for (let component = 0; component < attribute.itemSize; component++) {
        target[targetOffset + component] = attribute.array[sourceOffset + component];
      }
    }
    const copied = new THREE.BufferAttribute(target, attribute.itemSize, attribute.normalized);
    copied.name = attribute.name;
    copied.gpuType = attribute.gpuType;
    compact.setAttribute(name, copied);
  }
  const compactIndex = vertices.length > 65_535 ? remapped : Uint16Array.from(remapped);
  compact.setIndex(new THREE.BufferAttribute(compactIndex, 1));
  compact.setDrawRange(0, count);
  compact.boundingBox = source.boundingBox?.clone() ?? null;
  compact.boundingSphere = source.boundingSphere?.clone() ?? null;
  if (!compact.boundingBox) compact.computeBoundingBox();
  if (!compact.boundingSphere) compact.computeBoundingSphere();
  return compact;
}

const normalizedRoot = (name: string): string => name.replace(/\\/g, '/').toLowerCase();

const createVisibilityHandle = (batched: THREE.BatchedMesh, instanceIds: readonly number[], groupIndex: number): THREE.Object3D => {
  const handle = new THREE.Object3D();
  let visible = true;
  Object.defineProperty(handle, 'visible', {
    configurable: true,
    enumerable: true,
    get: () => visible,
    set: (next: boolean) => {
      visible = next;
      for (const instanceId of instanceIds) batched.setVisibleAt(instanceId, next);
    },
  });
  handle.userData.wmoPick = { kind: 'wmoBatch', groupIndex, experimentVisibilityHandle: true };
  return handle;
};

const suppressMultiDraw = (renderer: THREE.WebGLRenderer): (() => void) | null => {
  const extensions = renderer.extensions as unknown as { get: (name: string) => unknown };
  if (!extensions?.get) return null;
  const original = extensions.get;
  const replacement = function (this: typeof extensions, name: string): unknown {
    return name === 'WEBGL_multi_draw' ? null : original.call(this, name);
  };
  extensions.get = replacement;
  return () => { if (extensions.get === replacement) extensions.get = original; };
};

const installRenderMetrics = (batched: THREE.BatchedMesh, metrics: RuntimeMetrics): void => {
  const originalBefore = batched.onBeforeRender;
  const originalAfter = batched.onAfterRender;
  let restore: (() => void) | null = null;
  batched.onBeforeRender = function (renderer, scene, camera, geometry, material, group) {
    originalBefore.call(this, renderer, scene, camera, geometry, material, group);
    const internal = this as THREE.BatchedMesh & { _multiDrawCount: number; _multiDrawCounts: Int32Array };
    const visibleRanges = internal._multiDrawCount;
    let indexCount = 0;
    for (let index = 0; index < visibleRanges; index++) indexCount += internal._multiDrawCounts[index];
    const extension = !!renderer.extensions.get('WEBGL_multi_draw');
    diagnostics.extension = extension ? 'available' : 'unavailable';
    metrics.lastVisibleRanges = visibleRanges;
    metrics.lastTriangles = Math.floor(indexCount / 3);
    metrics.lastApiSubmissions = visibleRanges === 0 ? 0 : extension && metrics.mode === 'auto' ? 1 : visibleRanges;
    diagnostics.lastVisibleRanges = visibleRanges;
    diagnostics.lastTriangles = metrics.lastTriangles;
    diagnostics.lastApiSubmissions = metrics.lastApiSubmissions;
    if (metrics.mode === 'fallback' && extension) {
      restore = suppressMultiDraw(renderer);
      diagnostics.forcedFallbackFrames++;
      if (restore && typeof queueMicrotask === 'function') queueMicrotask(() => { restore?.(); restore = null; });
    } else if (extension) diagnostics.multiDrawFrames++;
    else diagnostics.automaticFallbackFrames++;
  };
  batched.onAfterRender = function (renderer, scene, camera, geometry, material, group) {
    restore?.(); restore = null;
    originalAfter.call(this, renderer, scene, camera, geometry, material, group);
  };
};

export const wmoBatchedSubmissionMetrics = (object: THREE.Object3D): RuntimeMetrics | null =>
  (object.userData.wmoBatchExperiment as RuntimeMetrics | undefined) ?? null;

export type WmoBatchExperimentResult = {
  mesh: THREE.BatchedMesh;
  label: string;
  logicalRanges: number;
  sourceDraws: number;
  groups: number;
  vertices: number;
  indices: number;
};

export class WmoBatchExperimentBuilder {
  private readonly buckets = new Map<THREE.Material, Candidate[]>();

  constructor(
    private readonly rootName: string,
    private readonly root: THREE.Group,
    private readonly config: WmoBatchExperimentConfig,
  ) {}

  consider(candidate: Candidate): void {
    const material = candidate.mesh.material;
    if (Array.isArray(material) || material.transparent) return;
    const bucket = this.buckets.get(material);
    if (bucket) bucket.push(candidate);
    else this.buckets.set(material, [candidate]);
  }

  finalize(): WmoBatchExperimentResult | null {
    let material: THREE.Material | null = null;
    let selected: Candidate[] = [];
    for (const [candidateMaterial, candidates] of this.buckets) {
      if (candidates.length > selected.length) { material = candidateMaterial; selected = candidates; }
    }
    if (!material || selected.length < 2) return null;

    const compact = selected.map((candidate) => compactWmoBatchGeometry(candidate.mesh.geometry));
    const vertices = compact.reduce((sum, geometry) => sum + geometry.getAttribute('position').count, 0);
    const indices = compact.reduce((sum, geometry) => sum + (geometry.index?.count ?? 0), 0);
    const batched = new THREE.BatchedMesh(selected.length, vertices, indices, material);
    batched.name = `WMO batch experiment: ${this.rootName}`;
    batched.sortObjects = false;
    batched.perObjectFrustumCulled = true;
    batched.matrixAutoUpdate = false;
    batched.matrix.identity();
    const identity = new THREE.Matrix4();
    const byGroup = new Map<number, { objects: THREE.Object3D[]; ids: number[] }>();
    for (let index = 0; index < selected.length; index++) {
      const candidate = selected[index];
      const geometryId = batched.addGeometry(compact[index]);
      const instanceId = batched.addInstance(geometryId);
      batched.setMatrixAt(instanceId, identity);
      compact[index].dispose();
      candidate.mesh.removeFromParent();
      candidate.mesh.geometry.dispose();
      const objectIndex = candidate.groupObjects.indexOf(candidate.mesh);
      if (objectIndex >= 0) candidate.groupObjects.splice(objectIndex, 1);
      let group = byGroup.get(candidate.groupIndex);
      if (!group) { group = { objects: candidate.groupObjects, ids: [] }; byGroup.set(candidate.groupIndex, group); }
      group.ids.push(instanceId);
    }
    for (const [groupIndex, group] of byGroup) group.objects.push(createVisibilityHandle(batched, group.ids, groupIndex));
    batched.computeBoundingBox();
    batched.computeBoundingSphere();
    const sourceDraws = selected.reduce((sum, candidate) => sum + candidate.mergedBatchCount, 0);
    const metrics: RuntimeMetrics = {
      mode: this.config.mode as Exclude<WmoBatchExperimentMode, 'off'>,
      logicalRanges: selected.length,
      sourceDraws,
      lastVisibleRanges: 0,
      lastTriangles: 0,
      lastApiSubmissions: 0,
    };
    batched.userData.wmoBatchExperiment = metrics;
    batched.userData.wmoPick = {
      kind: 'wmoBatch', groupIndex: -1, experiment: true, logicalRanges: selected.length,
      sourceDraws, groups: byGroup.size,
    };
    installRenderMetrics(batched, metrics);
    this.root.add(batched);
    diagnostics.selectedBuckets++;
    diagnostics.sourceDrawsPacked += sourceDraws;
    diagnostics.logicalRangesPacked += selected.length;
    diagnostics.packedVertices += vertices;
    diagnostics.packedIndices += indices;
    diagnostics.lastRoot = this.rootName;
    diagnostics.lastMaterial = material.uuid;
    return { mesh: batched, label: material.uuid, logicalRanges: selected.length, sourceDraws, groups: byGroup.size, vertices, indices };
  }
}

export function createWmoBatchExperimentBuilder(
  rootName: string,
  root: THREE.Group,
  config: WmoBatchExperimentConfig = activeConfig,
): WmoBatchExperimentBuilder | null {
  diagnostics.rootsConsidered++;
  if (config.mode === 'off') return null;
  const normalized = normalizedRoot(rootName);
  if (!config.rootNeedles.some((needle) => normalized.includes(needle.toLowerCase()))) return null;
  diagnostics.rootsMatched++;
  return new WmoBatchExperimentBuilder(rootName, root, config);
}
