import { EffectBufferPool, type EffectBufferLease } from './rendering/effect-buffer-pool';
import { SpellModelGeometryCache, type SpellModelGeometryLease } from './rendering/spell-model-geometry-cache';
import { setSphereFromExtents } from './rendering/effect-bounds';
import { sampleScalarTrack, sampleLifeScale, type EmitterFrame } from './rendering/emitter-scalar-track';
import { sceneEffectBudget, type SceneEffectBudget } from './rendering/scene-effect-budget';
import { compactExpiredParticles } from './rendering/compact-expired-particles';
import * as THREE from 'three';
import { advanceRibbonEmission, ribbonEdgeU } from './rendering/ribbon-trail-state';
import { createM2Animator, createM2BoneAnimator, type M2AnimationData, type M2Animator } from './m2-animator';
import { createM2Material } from './m2-material';
import { ByteBudgetPromiseCache } from './platform/byte-budget-promise-cache';
import { SpellVisualTextureCache } from './rendering/spell-visual-cache';
import { makeRoomForInstance } from './rendering/instance-budget';
import { updateDynamicAttributePrefix } from './rendering/dynamic-attribute-prefix';
import { acquireParticleMaterial, clearIdleParticleMaterials, releaseParticleMaterial, setParticleDrawRange } from './rendering/particle-submission';
import {
  clearAnimatedUVs,
  registerAnimatedMaterial,
  registerAnimatedUV,
  type BakedMaterialColor,
  type BakedTrack,
  type BakedTransform,
  type TrackClock,
} from './rendering/m2-texture-animation';
export interface ParticleDef {
  pos: [number, number, number]; bone: number; tex: string | null;
  blend: number; type: number; rows: number; cols: number; flags: number;
  speed: number; speedVar: number; vRange: number; hRange: number; gravity: number;
  life: number; rate: number; areaL: number; areaW: number; zSource: number;
  midpoint?: number;
  colors?: [[number, number, number, number], [number, number, number, number], [number, number, number, number]];
  scales?: [number, number, number];
  headCells?: [number, number];
  tailCells?: [number, number];
  tailLength?: number;
  twinkleSpeed?: number;
  twinklePercent?: number;
  twinkleScale?: [number, number];
  burstMultiplier?: number;
  drag?: number;
  tracks?: ScalarEmitterTrack[];
  /**
   * The M2's own on/off timeline for this emitter (`enabledIn`, particle struct +0x1dc).
   * Step-interpolated uint8 keys — only 0 and 1 occur across the corpus.
   */
  enabled?: ScalarEmitterTrack;
}
export interface ScalarEmitterTrack {
  interpolation: number;
  globalSequence: number;
  ranges: [number, number][];
  timestamps: number[];
  values: number[];
  components: number;
}
export interface RibbonDef {
  pos: [number, number, number]; bone: number; tex: (string | null)[];
  color: [number, number, number]; alpha: number; above: number; below: number;
  edgesPerSec: number; edgeLife: number; gravity: number; rows: number; cols: number;
}
type ModelGeometry = {
  positions: number[]; normals?: number[]; uvs: number[]; indices: number[];
  boneWeights?: number[]; boneIndices?: number[];
  submeshes: Array<{
    start: number; count: number; tex: string | null; blend: number; flags: number;
    xf?: number; mc?: number; mw?: number;
  }>;
  texXf?: BakedTransform[];
  matColor?: BakedMaterialColor[];
  matWeight?: Array<BakedTrack | null>;
  gs?: number[];
};
type SpellModelAnimation = Omit<M2AnimationData, 'positions' | 'boneWeights' | 'boneIndices'>;
export interface SpellModelAsset {
  model: string;
  particles: ParticleDef[];
  ribbons: RibbonDef[];
  geometry: ModelGeometry | null;
  animation?: SpellModelAnimation | null;
  timing?: {
    globalSequences: number[];
    sequences: Array<{ id: number; timeStart: number; timeEnd: number; duration: number }>;
  };
}

export interface SpellVisualHandle {
  /** Stop new emission; already-emitted particles/ribbons finish their authored lifetime. */
  stop(): void;
}

export interface SpawnOptions {
  admitUpdate?: (elapsedDt: number) => number | null; onDispose?: () => void; important?: boolean;
  /** Static world position, or a getter for a moving emitter origin (caster hand / projectile). */
  position?: THREE.Vector3;
  follow?: () => THREE.Vector3 | null;
  /** Static model orientation, or a getter for a moving model orientation. */
  rotation?: THREE.Quaternion;
  followRotation?: () => THREE.Quaternion | null;
  scale?: number;
  /**
   * ms the emitter keeps spawning; particles then live out their lifespan. 0 = one burst.
   * `'authored'` defers to the M2's own sequence length — the only correct answer for a spell
   * effect, since every cast (77/77) and impact (125/125) model in the corpus authors a
   * sequence longer than the 250ms this used to be hardcoded to.
   */
  durationMs: number | 'authored';
  /**
   * AnimationData.dbc id of the sequence to play. 0 = Stand (the default), 144 = InFlight,
   * 158 = Hold, 159 = Decay. Ignored when the model does not ship that sequence.
   */
  sequenceId?: number;
  /** Sky models stay camera-centered, draw behind the world, and are replaced as a single layer. */
  skybox?: boolean;
}

/** AnimationData.dbc ids, read from our own client bytes (tools/probe-anim-names.ts). */
export const SPELL_SEQ_STAND = 0;
export const SPELL_SEQ_IN_FLIGHT = 144;
export const SPELL_SEQ_HOLD = 158;
export const SPELL_SEQ_DECAY = 159;

const assetKey = (p: string) =>
  p.toLowerCase().replace(/\.(m2|mdx|mdl|blp)$/i, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function blending(blend: number): { mode: THREE.Blending; depthWrite: boolean; alphaTest: number } {
  switch (blend) {
    case 0: return { mode: THREE.NormalBlending, depthWrite: true, alphaTest: 0 };
    case 1: return { mode: THREE.NormalBlending, depthWrite: true, alphaTest: 0.5 };
    case 5: case 6: return { mode: THREE.MultiplyBlending, depthWrite: false, alphaTest: 0 };
    case 2: return { mode: THREE.NormalBlending, depthWrite: false, alphaTest: 0 };
    default: return { mode: THREE.AdditiveBlending, depthWrite: false, alphaTest: 0 }; // 3,4
  }
}

const PARTICLE_VERT = /* glsl */ `
  attribute vec4 aColor;
  attribute float aSize;
  attribute vec2 aCell;      // cell origin (u0, v0) in [0,1]
  attribute vec2 aCorner;    // authored quad corner, avoids WebGL point-size clipping
  uniform vec2 uCellSize;
  // Half a texel, in UV space, or zero for a single-frame sprite. Bilinear filtering samples a
  // 2x2 texel footprint, so a cell edge sampled at exactly u0/u1 pulls in the NEIGHBOURING
  // animation frame. Vanilla's flame atlases are 4x4 in a 32x32 texture — 8x8 px per frame — so
  // that bleed is a quarter of a frame wide and reads as a hard-edged flickering square.
  uniform vec2 uCellInset;
  varying vec4 vColor;
  varying vec2 vUv;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    mv.xy += aCorner * aSize * 0.5;
    gl_Position = projectionMatrix * mv;
    vec2 cornerUv = aCorner * 0.5 + 0.5;
    vUv = aCell + uCellInset + vec2(cornerUv.x, 1.0 - cornerUv.y) * (uCellSize - 2.0 * uCellInset);
  }`;

const PARTICLE_FRAG = /* glsl */ `
  precision mediump float;
  uniform sampler2D uMap;
  varying vec4 vColor;
  varying vec2 vUv;
  void main() {
    vec4 t = texture2D(uMap, vUv);
    gl_FragColor = t * vColor;
    if (gl_FragColor.a < 0.01) discard;
  }`;

const DEFAULT_PARTICLE_COLORS = [[1, 1, 1, 0], [1, 1, 1, 1], [1, 1, 1, 0]] as const;
interface Particle { x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; life: number; cell: number }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Vanilla old-particle life tracks have exactly three keys at 0, midpoint, and 1. */
function lifeKey(values: readonly [readonly number[], readonly number[], readonly number[]], midpoint: number, t: number, out: number[]): number[] {
  const middle = Math.max(0.001, Math.min(0.999, Number.isFinite(midpoint) ? midpoint : 0.5));
  const left = t <= middle;
  const f = left ? t / middle : (t - middle) / (1 - middle);
  const a = values[left ? 0 : 1];
  const b = values[left ? 1 : 2];
  for (let i = 0; i < a.length; i++) out[i] = lerp(a[i], b[i], f);
  return out;
}

/** One live particle emitter: CPU sim + camera-facing indexed quads in world space. */
class ParticleEmitter {
  readonly mesh: THREE.Mesh;
  private def: ParticleDef;
  private scale: number;
  private cap: number;
  private readonly vertexCopies: number;
  private parts: Particle[] = [];
  private spawnAcc = 0;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private sizeAttr: THREE.BufferAttribute;
  private cellAttr: THREE.BufferAttribute;
  private material: THREE.ShaderMaterial;
  private localScratch = new THREE.Vector3();
  private dirScratch = new THREE.Vector3();
  private previousSquirtRate: number | undefined;
  private colorScratch = [1, 1, 1, 1];
  private scaleScratch = [1];
  private readonly bounds = new THREE.Sphere();
  /** Atlas texture awaiting its half-texel inset; cleared once the image size is known. */
  private atlasTexture: THREE.Texture | null = null;

  private readonly buffers: EffectBufferLease;
  constructor(def: ParticleDef, tex: THREE.Texture | null, scale: number, private readonly budget: SceneEffectBudget, buffers: EffectBufferPool) {
    this.def = def;
    this.scale = scale;
    const maxRate = Math.max(def.rate, ...(def.tracks?.[6]?.values ?? []), 0);
    const maxLife = Math.max(def.life, ...(def.tracks?.[5]?.values ?? []), 0.1);
    const burstCapacity = (def.flags & 0x8000)
      ? maxRate * Math.max(1, def.burstMultiplier || 1)
      : 0;
    this.cap = Math.max(8, Math.min(600, Math.ceil(Math.max(maxRate * maxLife * 1.4, burstCapacity)) || 32));
    this.buffers = buffers.acquireParticles(this.cap);
    const { geometry: geo, copies } = this.buffers;
    this.vertexCopies = copies;
    this.posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
    this.colAttr = geo.getAttribute('aColor') as THREE.BufferAttribute;
    this.sizeAttr = geo.getAttribute('aSize') as THREE.BufferAttribute;
    this.cellAttr = geo.getAttribute('aCell') as THREE.BufferAttribute;
    geo.boundingSphere = this.bounds;
    const b = blending(def.blend);
    this.material = acquireParticleMaterial(tex, def.blend, def.cols, def.rows, () => {
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: tex },
          uCellSize: { value: new THREE.Vector2(1 / Math.max(1, def.cols), 1 / Math.max(1, def.rows)) },
          uCellInset: { value: new THREE.Vector2(0, 0) },
        },
        vertexShader: PARTICLE_VERT,
        fragmentShader: PARTICLE_FRAG,
        transparent: true,
        blending: b.mode,
        depthWrite: b.depthWrite,
        depthTest: true,
      });
      if (def.blend === 6) {
        // MODULATE2X = src*dst + dst*src, not Three's one-times MultiplyBlending.
        material.blending = THREE.CustomBlending;
        material.blendEquation = THREE.AddEquation;
        material.blendSrc = THREE.DstColorFactor;
        material.blendDst = THREE.SrcColorFactor;
      }
      return material;
    });
    this.mesh = new THREE.Mesh(geo, this.material); this.mesh.userData.vanillaPerfCategory = 'particles';
    setParticleDrawRange(this.mesh, 0);
    this.mesh.frustumCulled = true;
    this.atlasTexture = (def.cols > 1 || def.rows > 1) ? tex : null;
    this.applyAtlasSampling();
    // The inset needs the decoded image size, which TextureLoader fills asynchronously. update()
    // retries, but an emitter that is culled or paused before its first tick would never resolve —
    // so also resolve at draw time, which is the one callback that always runs before it matters.
    if (this.atlasTexture) {
      this.mesh.onBeforeRender = () => this.applyAtlasSampling();
    }
  }

  /**
   * Real atlases disable mipmaps and inset each cell by half a texel to avoid frame bleed.
   * Single-frame sprites retain mipmaps. Retry until TextureLoader supplies the image size.
   */
  private applyAtlasSampling(): void {
    const tex = this.atlasTexture;
    if (!tex) return;
    if (tex.generateMipmaps) {
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
    }
    // three types `Texture.image` as {}; it is an ImageBitmap/HTMLImageElement once loaded.
    const image = tex.image as { width?: number; height?: number } | undefined;
    const width = image?.width, height = image?.height;
    if (!width || !height) return;
    this.material.uniforms.uCellInset.value.set(0.5 / width, 0.5 / height);
    this.atlasTexture = null;
    // Resolved — stop paying for the per-draw retry.
    this.mesh.onBeforeRender = THREE.Mesh.prototype.onBeforeRender;
  }

  private spawn(
    origin: THREE.Vector3,
    rotation: THREE.Quaternion | null,
    boneMatrix: THREE.Matrix4 | null,
    frame: EmitterFrame,
  ) {
    if (this.parts.length >= this.cap) return;
    const d = this.def;
    // Emission area offset (plane emitters spread over a rectangle; sphere emits from a point).
    let ox = 0, oy = 0, oz = 0;
    const value = (index: number, fallback: number) => sampleScalarTrack(d.tracks?.[index], fallback, frame);
    if (d.type === 1) {
      ox = (Math.random() - 0.5) * value(7, d.areaL);
      oy = (Math.random() - 0.5) * value(8, d.areaW);
    }
    const local = this.localScratch.set(d.pos[0] + ox, d.pos[1] + oy, d.pos[2] + oz);
    if (boneMatrix) local.applyMatrix4(boneMatrix);
    local.multiplyScalar(this.scale);
    if (rotation) local.applyQuaternion(rotation);
    // Direction: cone around local +Z by polar vRange, azimuth hRange (sphere => full random).
    let dx: number, dy: number, dz: number;
    if (d.type === 2) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      dx = r * Math.cos(a); dy = r * Math.sin(a); dz = d.flags & 0x100 ? Math.abs(u) : u;
    } else {
      const theta = (Math.random() - 0.5) * Math.min(Math.PI, value(2, d.vRange) || 0.001);
      const phi = (Math.random() - 0.5) * Math.min(Math.PI * 2, value(3, d.hRange) || 0.001);
      dx = Math.sin(theta) * Math.cos(phi); dy = Math.sin(theta) * Math.sin(phi); dz = Math.cos(theta);
    }
    const dir = this.dirScratch.set(dx, dy, dz);
    if (boneMatrix) dir.transformDirection(boneMatrix);
    if (rotation) dir.applyQuaternion(rotation);
    const sp = value(0, d.speed) * (1 + (Math.random() * 2 - 1) * value(1, d.speedVar));
    const cellCount = Math.max(1, d.rows * d.cols);
    const cellStart = Math.max(0, Math.min(cellCount - 1, d.headCells?.[0] ?? 0));
    const cellEnd = Math.max(cellStart, Math.min(cellCount - 1, d.headCells?.[1] ?? (cellCount - 1)));
    this.parts.push({
      x: origin.x + local.x, y: origin.y + local.y, z: origin.z + local.z,
      vx: dir.x * sp, vy: dir.y * sp, vz: dir.z * sp, age: 0,
      life: Math.max(0.05, value(5, d.life)),
      cell: (d.flags & 0x10000)
        ? cellStart + Math.floor(Math.random() * (cellEnd - cellStart + 1))
        : cellStart,
    });
  }

  update(
    dt: number,
    origin: THREE.Vector3 | null,
    rotation: THREE.Quaternion | null,
    emitting: boolean,
    boneMatrix: THREE.Matrix4 | null,
    frame: EmitterFrame, elapsedDt = dt, important = false,
  ) {
    // No-op once the atlas texture has reported its size and the inset is set.
    if (this.atlasTexture) this.applyAtlasSampling();
    const d = this.def, previousParticleCount = this.parts.length;
    // The model decides when each emitter runs. Without this an emitter keyed on at 1000ms
    // (ArcaneExplosion_Impact_Chest p1-p3) fires from t=0, and one keyed off partway through
    // (Blizzard, Flamestrike) keeps emitting for the whole spawn window.
    const authoredOn = d.enabled ? sampleScalarTrack(d.enabled, 1, frame) > 0.5 : true;
    const active = emitting && authoredOn;
    if (active && origin) {
      const rate = Math.max(0, sampleScalarTrack(d.tracks?.[6], d.rate, frame));
      if (d.flags & 0x8000) {
        // M2 "squirt" emitters treat a positive rate key as a count on its rising edge.
        // Blizzard's raw 0 -> 35 -> 0 track otherwise integrates to only 4-5 shards.
        if (rate > 0 && (this.previousSquirtRate === undefined || rate > this.previousSquirtRate)) {
          this.spawnAcc += rate * Math.max(1, d.burstMultiplier || 1);
        }
        this.previousSquirtRate = rate;
      } else {
        this.spawnAcc += rate * dt;
      }
      this.spawnAcc = Math.min(this.spawnAcc, this.cap);
      let budget = this.budget.admitParticles(Math.min(Math.floor(this.spawnAcc), this.cap - this.parts.length), important);
      while (this.spawnAcc >= 1 && budget-- > 0) {
        this.spawnAcc -= 1;
        this.spawn(origin, rotation, boneMatrix, frame);
      }
    } else if (!active) {
      this.previousSquirtRate = undefined;
    }
    const cols = Math.max(1, d.cols);
    const cellCount = Math.max(1, d.rows * d.cols);
    let n = 0;
    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    const size = this.sizeAttr.array as Float32Array;
    const cell = this.cellAttr.array as Float32Array;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    this.budget.releaseParticles(compactExpiredParticles(this.parts, previousParticleCount, elapsedDt, dt));
    const gravity = sampleScalarTrack(d.tracks?.[4], d.gravity, frame);
    const drag = Math.max(0, d.drag ?? 0);
    const velocityScale = drag > 0 ? Math.exp(-drag * dt) : 1;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.vz -= gravity * dt;
      if (drag > 0) {
        p.vx *= velocityScale;
        p.vy *= velocityScale;
        p.vz *= velocityScale;
      }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const t = p.age / p.life;
      // Raw Build-5875 old-particle life keys: start -> midpoint -> end.
      const colors = d.colors ?? DEFAULT_PARTICLE_COLORS;
      const colorNow = lifeKey(colors, d.midpoint ?? 0.5, t, this.colorScratch);
      const particleSize = sampleLifeScale(d.scales, d.midpoint ?? 0.5, t);
      const authoredStart = Math.max(0, Math.min(cellCount - 1, d.headCells?.[0] ?? 0));
      const authoredEnd = Math.max(authoredStart, Math.min(cellCount - 1, d.headCells?.[1] ?? (cellCount - 1)));
      const spriteFrame = (d.flags & 0x10000)
        ? p.cell
        : Math.min(authoredEnd, authoredStart + Math.floor(t * (authoredEnd - authoredStart + 1)));
      const worldSize = Math.max(0, particleSize) * this.scale;
      // The shader expands each center into a camera-facing square. Half its diagonal is the
      // orientation-independent radius needed to enclose that billboard for every camera angle.
      const billboardRadius = worldSize * Math.SQRT1_2;
      minX = Math.min(minX, p.x - billboardRadius);
      minY = Math.min(minY, p.y - billboardRadius);
      minZ = Math.min(minZ, p.z - billboardRadius);
      maxX = Math.max(maxX, p.x + billboardRadius);
      maxY = Math.max(maxY, p.y + billboardRadius);
      maxZ = Math.max(maxZ, p.z + billboardRadius);
      for (let corner = 0; corner < this.vertexCopies; corner++) {
        const vertex = n * this.vertexCopies + corner;
        pos[vertex * 3] = p.x; pos[vertex * 3 + 1] = p.y; pos[vertex * 3 + 2] = p.z;
        col[vertex * 4] = colorNow[0];
        col[vertex * 4 + 1] = colorNow[1];
        col[vertex * 4 + 2] = colorNow[2];
        col[vertex * 4 + 3] = colorNow[3];
        size[vertex] = worldSize;
        cell[vertex * 2] = (spriteFrame % cols) / cols;
        cell[vertex * 2 + 1] = Math.floor(spriteFrame / cols) / Math.max(1, d.rows);
      }
      n++;
    }
    updateDynamicAttributePrefix(this.posAttr, n * this.vertexCopies); updateDynamicAttributePrefix(this.colAttr, n * this.vertexCopies);
    updateDynamicAttributePrefix(this.sizeAttr, n * this.vertexCopies); updateDynamicAttributePrefix(this.cellAttr, n * this.vertexCopies);
    setParticleDrawRange(this.mesh, n * 6);
    setSphereFromExtents(this.bounds, minX, minY, minZ, maxX, maxY, maxZ);
  }

  get aliveCount() { return this.parts.length; }
  get bone() { return this.def.bone; }
  dispose() {
    this.buffers.release();
    this.budget.releaseParticles(this.parts.length); this.parts.length = 0;
    releaseParticleMaterial(this.material);
  }
}

/** Minimal ribbon trail: records recent emitter positions and builds a camera-agnostic quad strip. */
class RibbonTrail {
  readonly mesh: THREE.Mesh;
  private def: RibbonDef;
  private scale: number;
  private history: { x: number; y: number; z: number; nx: number; ny: number; nz: number; age: number }[] = [];
  private maxEdges: number;
  private emitAcc = 0;
  private posAttr: THREE.BufferAttribute; private uvAttr: THREE.BufferAttribute;
  private material: THREE.MeshBasicMaterial;
  private localScratch = new THREE.Vector3();
  private normalScratch = new THREE.Vector3();
  private readonly bounds = new THREE.Sphere();
  private readonly buffers: EffectBufferLease;
  constructor(def: RibbonDef, tex: THREE.Texture | null, scale: number, buffers: EffectBufferPool) {
    this.def = def;
    this.scale = scale;
    this.maxEdges = Math.max(4, Math.min(128, Math.ceil(def.edgesPerSec * Math.max(0.1, def.edgeLife)) + 2));
    this.buffers = buffers.acquireRibbon(this.maxEdges);
    const geo = this.buffers.geometry;
    this.posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
    this.uvAttr = geo.getAttribute('uv') as THREE.BufferAttribute;
    geo.boundingSphere = this.bounds;
    this.material = new THREE.MeshBasicMaterial({
      map: tex ?? null,
      color: new THREE.Color(def.color[0], def.color[1], def.color[2]),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      opacity: Math.max(0.15, def.alpha),
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    setParticleDrawRange(this.mesh, 0);
    this.mesh.frustumCulled = true;
  }
  update(
    dt: number,
    origin: THREE.Vector3 | null,
    rotation: THREE.Quaternion | null,
    emitting: boolean,
    boneMatrix: THREE.Matrix4 | null, elapsedDt = dt,
  ) {
    for (const h of this.history) h.age += elapsedDt;
    while (this.history.length && this.history[0].age > this.def.edgeLife) this.history.shift();
    if (emitting && origin) {
      const emission = advanceRibbonEmission(this.emitAcc, this.def.edgesPerSec, dt);
      this.emitAcc = emission.accumulator;
      if (emission.emit) {
        const local = this.localScratch.set(this.def.pos[0], this.def.pos[1], this.def.pos[2]);
        if (boneMatrix) local.applyMatrix4(boneMatrix);
        local.multiplyScalar(this.scale);
        if (rotation) local.applyQuaternion(rotation);
        // Ribbon height is authored in the emitter's local frame. Preserve the
        // local slash normal at each edge instead of forcing all ribbons onto world Z.
        const normal = this.normalScratch.set(0, 0, 1);
        if (boneMatrix) normal.transformDirection(boneMatrix);
        if (rotation) normal.applyQuaternion(rotation);
        normal.normalize();
        this.history.push({
          x: origin.x + local.x, y: origin.y + local.y, z: origin.z + local.z,
          nx: normal.x, ny: normal.y, nz: normal.z, age: 0,
        });
        if (this.history.length > this.maxEdges) this.history.shift();
      }
    }
    const above = (this.def.above || 0.15) * this.scale;
    const below = (this.def.below || 0.15) * this.scale;
    const pos = this.posAttr.array as Float32Array; const uv = this.uvAttr.array as Float32Array;
    const edges = Math.min(this.history.length, this.maxEdges);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < edges; i++) {
      const h = this.history[i];
      const ax = h.x + h.nx * above, ay = h.y + h.ny * above, az = h.z + h.nz * above;
      const bx = h.x - h.nx * below, by = h.y - h.ny * below, bz = h.z - h.nz * below;
      pos[i * 6] = ax; pos[i * 6 + 1] = ay; pos[i * 6 + 2] = az;
      pos[i * 6 + 3] = bx; pos[i * 6 + 4] = by; pos[i * 6 + 5] = bz;
      const u = ribbonEdgeU(i, edges); uv[i * 4] = u; uv[i * 4 + 1] = 0; uv[i * 4 + 2] = u; uv[i * 4 + 3] = 1;
      minX = Math.min(minX, ax, bx); minY = Math.min(minY, ay, by); minZ = Math.min(minZ, az, bz);
      maxX = Math.max(maxX, ax, bx); maxY = Math.max(maxY, ay, by); maxZ = Math.max(maxZ, az, bz);
    }
    updateDynamicAttributePrefix(this.posAttr, edges * 2); updateDynamicAttributePrefix(this.uvAttr, edges * 2);
    setParticleDrawRange(this.mesh, Math.max(0, (edges - 1) * 6));
    setSphereFromExtents(this.bounds, minX, minY, minZ, maxX, maxY, maxZ);
  }

  get aliveCount() { return this.history.length; }
  get bone() { return this.def.bone; }
  dispose() { this.buffers.release(); this.material.dispose(); }
}

class SpellModelInstance implements SpellVisualHandle {
  private emitters: ParticleEmitter[] = [];
  private ribbons: RibbonTrail[] = [];
  private group: THREE.Group;
  private elapsed = 0;
  private opts: SpawnOptions;
  private core = new THREE.Group();
  private animator: M2Animator | null = null;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly boneMatrices = new Map<number, THREE.Matrix4>();
  private readonly timing: SpellModelAsset['timing'];
  private readonly coreMaterials = new Set<THREE.ShaderMaterial>();
  private readonly geometryLease: SpellModelGeometryLease | null;
  /** Shared M2 sequence index used by animation and emitter track ranges. */
  private readonly sequenceIndex: number;
  /** AnimationData id of that sequence — what M2Animator.update() takes (an id, not an index). */
  private readonly sequenceAnimId: number;
  /** Authored length of that sequence, ms. Never 0 — the frame clock divides by it. */
  private readonly sequenceDurationMs: number;
  /** opts.durationMs with `'authored'` already resolved against the model. */
  private readonly emitDurationMs: number;
  /**
   * True when the caller asked for the model's own authored length — a one-shot burst.
   *
   * Build 5875 authors spell replay counts as zero: hold the final model frame while longer-lived
   * particles finish, avoiding a wrapped mesh replay. Explicit-duration channels/areas keep
   * looping; driving their authored intro/hold/outro sequence triple remains unverified.
   */
  private readonly holdLastFrame: boolean;
  /** When emission actually stopped, so the sustained clock settles instead of looping the tail. */
  private emitEndedAtMs = Number.POSITIVE_INFINITY;
  /**
   * This frame's position on the model timeline, shared by mesh, emitters and MATERIAL tracks.
   * Seeded to the sequence start so the first rendered frame is not sampled at time 0 — vanilla
   * sequences do not begin at 0 (IceBarrier_State's Hold starts at 6667ms).
   */
  private sequenceTimeMs = 0;
  private stopped = false;
  done = false; private disposed = false;

  constructor(
    scene: THREE.Group,
    camera: THREE.PerspectiveCamera,
    asset: SpellModelAsset,
    opts: SpawnOptions,
    texOf: (ref: string | null) => THREE.Texture | null,
    private readonly onDispose: () => void,
    budget: SceneEffectBudget,
    buffers: EffectBufferPool,
    geometryCache: SpellModelGeometryCache,
  ) {
    this.opts = opts;
    this.group = scene;
    this.camera = camera;
    this.timing = asset.timing;
    this.geometryLease = asset.geometry ? geometryCache.acquire(asset.geometry) : null;
    // Resolve the sequence first: the emit window is the length of whatever we actually play.
    const sequences = asset.timing?.sequences ?? [];
    const wanted = opts.sequenceId ?? SPELL_SEQ_STAND;
    const requested = sequences.findIndex((s) => s.id === wanted && s.duration > 0);
    const stand = sequences.findIndex((s) => s.id === SPELL_SEQ_STAND);
    this.sequenceIndex = requested >= 0 ? requested : Math.max(0, stand);
    const sequence = sequences[this.sequenceIndex];
    this.sequenceAnimId = sequence?.id ?? SPELL_SEQ_STAND;
    this.sequenceTimeMs = sequence?.timeStart ?? 0;
    this.sequenceDurationMs = Math.max(1, sequence?.duration ?? 1);
    this.emitDurationMs = opts.durationMs === 'authored'
      ? (sequence?.duration || 0)
      : opts.durationMs;
    this.holdLastFrame = opts.durationMs === 'authored';
    this.core.renderOrder = opts.skybox ? -900 : 0;
    if (asset.geometry || asset.animation) scene.add(this.core);
    if (asset.geometry) {
      const g = asset.geometry;
      const gpuSkinned = !!asset.animation && !!g.boneWeights?.length && !!g.boneIndices?.length;
      const { position, normal, geometries, skinAttributes } = this.geometryLease!;
      for (let index = 0; index < g.submeshes.length; index++) {
        const part = g.submeshes[index], geo = geometries[index];
        const color = part.mc !== undefined && part.mc >= 0 ? g.matColor?.[part.mc] : undefined;
        const weight = part.mw !== undefined && part.mw >= 0 ? g.matWeight?.[part.mw] ?? undefined : undefined;
        const material = createM2Material({
          texture: texOf(part.tex),
          blendMode: part.blend,
          renderFlags: part.flags | (opts.skybox ? 0x12 : 0),
          animatedOpacity: !!(color?.a || weight),
          forceDoubleSided: true,
          gpuSkinning: gpuSkinned,
        });
        if (opts.skybox) {
          material.depthTest = false;
          material.depthWrite = false;
        }
        this.coreMaterials.add(material);
        const localElapsed = () => this.elapsed;
        // Material tracks ride the SAME clock as the mesh and the emitters. Sampling them on a
        // free-running `elapsed % lastTimestamp` instead is what kept Arcane Explosion flashing
        // after the mesh already held: its alpha period is 800ms against a 1767ms lifetime.
        const localClock = (): TrackClock => ({ sequenceMs: this.sequenceTimeMs, globalMs: this.elapsed, sequenceIndex: this.sequenceIndex });
        const transform = part.xf !== undefined && part.xf >= 0 ? g.texXf?.[part.xf] : undefined;
        if (transform) registerAnimatedUV(material, transform, g.gs ?? [], localElapsed, localClock);
        if (color || weight) registerAnimatedMaterial(material, color, weight, g.gs ?? [], localElapsed, localClock);
        const mesh = new THREE.Mesh(geo, material);
        mesh.frustumCulled = false;
        this.core.add(mesh);
      }
      if (asset.animation && g.boneWeights?.length && g.boneIndices?.length) {
        this.animator = createM2Animator({
          ...asset.animation,
          positions: g.positions,
          boneWeights: g.boneWeights,
          boneIndices: g.boneIndices,
        }, position, normal, { holdLastFrame: this.holdLastFrame, skinAttributes });
        this.animator?.bindGroup(this.core);
      }
    }
    if (!this.animator && asset.animation) this.animator = createM2BoneAnimator(asset.animation, { holdLastFrame: this.holdLastFrame });
    const scale = opts.scale ?? 1;
    for (const p of asset.particles) {
      const em = new ParticleEmitter(p, texOf(p.tex), scale, budget, buffers);
      this.emitters.push(em);
      scene.add(em.mesh);
    }
    for (const r of asset.ribbons) {
      const rb = new RibbonTrail(r, texOf(r.tex.find(Boolean) ?? null), scale, buffers);
      this.ribbons.push(rb);
      scene.add(rb.mesh);
    }
  }

  private origin(): THREE.Vector3 | null {
    return this.opts.follow ? this.opts.follow() : this.opts.position ?? null;
  }

  private rotation(): THREE.Quaternion | null {
    if (this.opts.followRotation) return this.opts.followRotation();
    return this.opts.rotation ?? null;
  }

  /**
   * Mirrors the animator's settle latch (m2-animator.ts) so the emitter tracks and the visible
   * mesh stay on one clock. Infinity while emitting; afterwards the end of the cycle in flight.
   */
  private settleCapMs(duration: number): number {
    if (!Number.isFinite(this.emitEndedAtMs)) return Number.POSITIVE_INFINITY;
    return Math.max(duration - 1, Math.ceil(this.emitEndedAtMs / duration) * duration - 1);
  }

  update(dt: number, elapsedDt = dt) {
    const admitted = this.opts.admitUpdate?.(elapsedDt);
    if (admitted === null) return;
    elapsedDt = admitted ?? elapsedDt;
    this.elapsed += elapsedDt * 1000; // Wall time owns lifetime; dt bounds emission and physics work.
    const emitting = !this.stopped && this.elapsed <= this.emitDurationMs;
    if (!emitting && this.emitEndedAtMs === Number.POSITIVE_INFINITY) this.emitEndedAtMs = this.elapsed;
    const origin = this.origin();
    const rotation = this.rotation();
    if (origin) this.core.position.copy(origin);
    if (rotation) this.core.quaternion.copy(rotation);
    this.core.scale.setScalar(this.opts.scale ?? 1);
    this.animator?.update(elapsedDt, this.sequenceAnimId, this.camera, this.core, !emitting);
    const sequenceIndex = this.sequenceIndex;
    const sequence = this.timing?.sequences[sequenceIndex];
    const duration = this.sequenceDurationMs;
    // Same clock the animator uses, so emitter tracks, material tracks and mesh animation never
    // disagree about where in the sequence we are — settle latch included: once emission stops, a
    // sustained visual finishes the cycle in flight and holds, so nothing re-fires on a tail.
    this.sequenceTimeMs = (sequence?.timeStart ?? 0)
      + (this.holdLastFrame
        ? Math.min(this.elapsed, duration - 1)
        : (Math.min(this.elapsed, this.settleCapMs(duration)) % duration));
    const frame: EmitterFrame = {
      sequenceIndex,
      sequenceTimeMs: this.sequenceTimeMs,
      globalTimeMs: this.elapsed,
      globalSequences: this.timing?.globalSequences ?? [],
    };
    let alive = 0;
    for (const e of this.emitters) {
      const bone = this.boneMatrix(e.bone);
      e.update(dt, origin, rotation, emitting, bone, frame, elapsedDt, this.opts.important ?? (!!origin && origin.distanceToSquared(this.camera.position) < 625));
      alive += e.aliveCount;
    }
    for (const r of this.ribbons) {
      const bone = this.boneMatrix(r.bone);
      r.update(dt, origin, rotation, emitting, bone, elapsedDt);
      alive += r.aliveCount;
    }
    if (!emitting && alive === 0) this.done = true;
  }

  private boneMatrix(index: number | undefined): THREE.Matrix4 | null {
    if (!this.animator?.getBoneMatrix || index === undefined || index < 0) return null;
    let target = this.boneMatrices.get(index);
    if (!target) {
      target = new THREE.Matrix4();
      this.boneMatrices.set(index, target);
    }
    return this.animator.getBoneMatrix(index, target);
  }

  stop() {
    this.stopped = true;
  }

  debugInfo() {
    return {
      emitters: this.emitters.map((e) => ({ alive: e.aliveCount, draw: e.mesh.geometry.drawRange.count })),
      ribbons: this.ribbons.map((r) => r.aliveCount),
      done: this.done,
    };
  }

  dispose() {
    if (this.disposed) return; this.disposed = true;
    this.animator?.dispose();
    this.animator = null;
    clearAnimatedUVs((material) => this.coreMaterials.has(material));
    this.group.remove(this.core);
    for (const child of this.core.children) {
      const mesh = child as THREE.Mesh;
      const material = mesh.material as THREE.Material | undefined;
      material?.dispose();
    }
    this.geometryLease?.release();
    this.coreMaterials.clear();
    for (const e of this.emitters) { this.group.remove(e.mesh); e.dispose(); }
    for (const r of this.ribbons) { this.group.remove(r.mesh); r.dispose(); }
    this.emitters = []; this.ribbons = [];
    this.onDispose(); this.opts.onDispose?.();
  }
}

export class SpellVisuals {
  private readonly effectBudget: SceneEffectBudget;
  private scene: THREE.Group;
  private skyScene: THREE.Group;
  private assetBase: string;
  private assetCache = new ByteBudgetPromiseCache<string, SpellModelAsset | null>(128 * 1024 * 1024, 2048);
  private loader = new THREE.TextureLoader();
  private textureCache: SpellVisualTextureCache;
  private instances: SpellModelInstance[] = [];
  private camera: THREE.PerspectiveCamera;
  private skybox?: SpellModelInstance;
  private skyboxPath: string | null = null;
  private skyboxSerial = 0; private worldEpoch = 1; private worldAbort = new AbortController();
  private readonly buffers: EffectBufferPool;
  private readonly geometryCache: SpellModelGeometryCache;
  constructor(opts: { scene: THREE.Scene; skyScene?: THREE.Scene; camera: THREE.PerspectiveCamera; assetBase?: string; /** Diagnostic baseline; default true. */ reuseBuffers?: boolean }) {
    this.effectBudget = sceneEffectBudget(opts.scene);
    this.scene = new THREE.Group();
    this.scene.name = 'spell-visuals';
    opts.scene.add(this.scene);
    this.skyScene = new THREE.Group();
    this.skyScene.name = 'spell-skybox';
    (opts.skyScene ?? opts.scene).add(this.skyScene);
    this.assetBase = opts.assetBase ?? 'spells/';
    this.textureCache = new SpellVisualTextureCache(this.loader, this.assetBase);
    this.camera = opts.camera;
    this.buffers = opts.reuseBuffers === false ? new EffectBufferPool(0, 0) : new EffectBufferPool();
    this.geometryCache = opts.reuseBuffers === false ? new SpellModelGeometryCache(0, 0) : new SpellModelGeometryCache();
  }

  private loadAsset(modelPath: string): Promise<SpellModelAsset | null> {
    const key = assetKey(modelPath);
    let p = this.assetCache.get(key);
    if (!p) {
      p = fetch(`${this.assetBase}models/${key}.json`, { signal: this.worldAbort.signal })
        .then((r) => {
          if (r.status === 404 || r.headers.get('content-type')?.includes('text/html')) return null;
          if (!r.ok) throw new Error(`spell model ${key} HTTP ${r.status}`);
          return r.json() as Promise<SpellModelAsset>;
        })
        .catch(() => { if (this.assetCache.get(key) === p) this.assetCache.delete(key); return null; });
      this.assetCache.set(key, p);
    }
    return p;
  }

  private createInstance(scene: THREE.Group, asset: SpellModelAsset, opts: SpawnOptions): SpellModelInstance {
    const owned = new Set<string>();
    const instance = new SpellModelInstance(scene, this.camera, asset, opts,
      (ref) => this.textureCache.acquire(ref, owned), () => this.textureCache.release(owned), this.effectBudget, this.buffers, this.geometryCache);
    this.textureCache.retain(owned);
    return instance;
  }

  /** Spawn a baked spell model's emitters. Resolves once the asset is loaded. */
  async spawn(modelPath: string, opts: SpawnOptions): Promise<SpellVisualHandle | null> {
    const epoch = this.worldEpoch, asset = await this.loadAsset(modelPath);
    if (!asset || epoch !== this.worldEpoch) return null;
    return this.spawnAsset(asset, opts);
  }

  /** Spawn an already-loaded emitter asset, used by persistent world doodad effects. */
  spawnAsset(asset: SpellModelAsset, opts: SpawnOptions): SpellVisualHandle {
    makeRoomForInstance(this.instances, 256, (instance) => instance.dispose());
    const inst = this.createInstance(this.scene, asset, opts);
    this.instances.push(inst);
    return inst;
  }

  /** Immediately retire an owned instance without disturbing unrelated spell/world effects. */
  remove(handle: SpellVisualHandle): boolean {
    const index = this.instances.indexOf(handle as SpellModelInstance);
    if (index < 0) return false;
    const [instance] = this.instances.splice(index, 1);
    instance.dispose();
    return true;
  }
  update(dt: number, elapsedDt = dt) {
    this.skybox?.update(dt, elapsedDt);
    for (let i = this.instances.length - 1; i >= 0; i--) {
      const inst = this.instances[i];
      inst.update(dt, elapsedDt);
      if (inst.done) { inst.dispose(); this.instances.splice(i, 1); }
    }
  }

  get activeCount() { return this.instances.length; }

  async setSkybox(modelPath: string | null, follow: () => THREE.Vector3 | null): Promise<void> {
    if (modelPath === this.skyboxPath) return;
    this.skyboxPath = modelPath;
    const serial = ++this.skyboxSerial, epoch = this.worldEpoch;
    this.skybox?.dispose();
    this.skybox = undefined;
    if (!modelPath) return;
    const asset = await this.loadAsset(modelPath);
    if (!asset || serial !== this.skyboxSerial || epoch !== this.worldEpoch) return;
    this.skybox = this.createInstance(this.skyScene, asset, {
      follow, durationMs: Number.POSITIVE_INFINITY, scale: 1, skybox: true,
    });
  }

  clear() {
    this.worldEpoch++; this.skyboxSerial++; this.worldAbort.abort(); this.worldAbort = new AbortController(); this.skybox?.dispose();
    this.skybox = undefined; this.skyboxPath = null; for (const inst of this.instances) inst.dispose(); this.instances = [];
    this.assetCache.clear(); this.buffers.clearUnused(); this.geometryCache.clearUnused();
  }

  clearTextures() {
    this.textureCache.clear();
  }

  clearCaches() { this.assetCache.clear(); this.textureCache.clearUnused(); this.buffers.clearUnused(); this.geometryCache.clearUnused(); }

  debugInfo() {
    return {
      count: this.instances.length,
      instances: this.instances.map((i) => i.debugInfo()),
      assetCache: this.assetCache.diagnostics(), effectBudget: this.effectBudget.diagnostics(),
      effectBuffers: this.buffers.diagnostics(), modelGeometry: this.geometryCache.diagnostics(),
      ...this.textureCache.diagnostics(),
    };
  }

  dispose() {
    this.skybox?.dispose();
    this.skybox = undefined;
    this.clear();
    this.clearTextures(); clearIdleParticleMaterials();
    this.scene.parent?.remove(this.scene);
    this.skyScene.parent?.remove(this.skyScene);
  }
}
