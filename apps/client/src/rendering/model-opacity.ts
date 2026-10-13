import * as THREE from 'three';
import { bindM2SelectionUniform } from './m2-per-draw-uniforms.ts';
import { cloneMaterialWithSharedTextures } from './clone-material-shared-textures';

/** Build 5875 uses this duration for SpellVisualKit character-process opacity changes. */
export const SPELL_VISUAL_OPACITY_FADE_MS = 1000;

type OpacityMaterialState = {
  transparent: boolean;
  depthWrite: boolean;
  layers: Map<string, number>;
};

type MaterialWithOpacityState = THREE.ShaderMaterial & {
  userData: THREE.ShaderMaterial['userData'] & { wowOpacityState?: OpacityMaterialState };
};

const MODEL_OPACITY_LAYER = 'model-opacity-controller';

function m2Material(material: THREE.Material): MaterialWithOpacityState | null {
  const shader = material as MaterialWithOpacityState;
  return shader.uniforms?.uGhostAlpha ? shader : null;
}

/**
 * Apply one multiplicative opacity layer to an M2 material.
 *
 * Death ghosting and SpellVisualKit character opacity share uGhostAlpha, so they must compose
 * instead of overwriting each other. Restoring the last layer also restores the material's authored
 * blend/depth flags.
 */
export function setM2MaterialOpacityLayer(
  material: THREE.Material | THREE.Material[],
  layer: string,
  alpha: number,
) {
  for (const candidate of Array.isArray(material) ? material : [material]) {
    const shader = m2Material(candidate);
    if (!shader) continue;
    const clamped = THREE.MathUtils.clamp(alpha, 0, 1);
    let state = shader.userData.wowOpacityState;
    if (!state && clamped >= 1) continue;
    if (!state) {
      state = {
        transparent: shader.transparent,
        depthWrite: shader.depthWrite,
        layers: new Map(),
      };
      shader.userData.wowOpacityState = state;
    }
    if (clamped < 1) state.layers.set(layer, clamped);
    else state.layers.delete(layer);

    let effective = 1;
    for (const value of state.layers.values()) effective *= value;
    shader.uniforms.uGhostAlpha.value = effective;
    if (state.layers.size) {
      shader.transparent = true;
      shader.depthWrite = false;
    } else {
      shader.transparent = state.transparent;
      shader.depthWrite = state.depthWrite;
      shader.userData.wowOpacityState = undefined;
    }
    shader.needsUpdate = true;
  }
}

export type ModelOpacityTarget = {
  root: THREE.Object3D;
  /** Clone M2 materials before fading when the model came from a shared creature cache. */
  isolateMaterials?: boolean;
};

export type AuraModelOpacitySink = {
  setAura: (key: string, guid: string, serial: number, alpha: number | undefined) => void;
  removeAura: (key: string) => void;
  clearEntity: (guid: string) => void;
  clear: () => void;
};

export function playerOpacityTarget(
  guid: string,
  localGuid: string | undefined,
  formRoot: THREE.Object3D | null | undefined,
  playerRoot: THREE.Object3D | null | undefined,
  remoteRoot: THREE.Object3D | undefined,
): ModelOpacityTarget | undefined {
  if (guid === localGuid && formRoot) return { root: formRoot, isolateMaterials: true };
  if (guid === localGuid && playerRoot) return { root: playerRoot };
  return remoteRoot ? { root: remoteRoot } : undefined;
}

type MaterialAssignment = {
  mesh: THREE.Mesh;
  original: THREE.Material | THREE.Material[];
};

type RootBinding = {
  root: THREE.Object3D;
  isolateMaterials: boolean;
  assignments: MaterialAssignment[];
  assignedMeshes: WeakSet<THREE.Mesh>;
  clones: Set<THREE.Material>;
};

type EntityOpacityState = {
  layers: Map<string, number>;
  start: number;
  current: number;
  target: number;
  elapsedMs: number;
  durationMs: number;
  binding?: RootBinding;
};

function rebindPerDrawUniforms(material: THREE.ShaderMaterial) {
  bindM2SelectionUniform(material);
}

function cloneM2Materials(binding: RootBinding) {
  const clonesByOriginal = new Map<THREE.Material, THREE.Material>();
  binding.root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material || binding.assignedMeshes.has(mesh)) return;
    const originals = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    let changed = false;
    const replacements = originals.map((original) => {
      if (!m2Material(original)) return original;
      changed = true;
      let clone = clonesByOriginal.get(original);
      if (!clone) {
        clone = cloneMaterialWithSharedTextures(original);
        rebindPerDrawUniforms(clone as THREE.ShaderMaterial);
        clonesByOriginal.set(original, clone);
        binding.clones.add(clone);
      }
      return clone;
    });
    if (!changed) return;
    binding.assignments.push({ mesh, original: mesh.material });
    binding.assignedMeshes.add(mesh);
    mesh.material = Array.isArray(mesh.material) ? replacements : replacements[0];
  });
}

function clearBinding(binding: RootBinding) {
  if (binding.isolateMaterials) {
    for (const assignment of binding.assignments) assignment.mesh.material = assignment.original;
    for (const clone of binding.clones) clone.dispose();
  } else {
    binding.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && mesh.material) setM2MaterialOpacityLayer(mesh.material, MODEL_OPACITY_LAYER, 1);
    });
  }
}

function applyBinding(binding: RootBinding, alpha: number) {
  if (binding.isolateMaterials) cloneM2Materials(binding);
  binding.root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.material) {
      setM2MaterialOpacityLayer(mesh.material, MODEL_OPACITY_LAYER, alpha);
    }
  });
}


export class ModelOpacityController {
  private readonly states = new Map<string, EntityOpacityState>();
  private readonly auraModifiers = new Map<string, { guid: string; serial: number; alpha: number }>();
  private readonly getTarget: (guid: string) => ModelOpacityTarget | undefined;

  constructor(getTarget: (guid: string) => ModelOpacityTarget | undefined) {
    this.getTarget = getTarget;
  }

  setLayer(guid: string | undefined, layer: string, alpha: number, durationMs: number) {
    if (!guid) return;
    const clamped = THREE.MathUtils.clamp(alpha, 0, 1);
    let state = this.states.get(guid);
    if (!state && clamped >= 1) return;
    if (!state) {
      state = {
        layers: new Map(),
        start: 1,
        current: 1,
        target: 1,
        elapsedMs: 0,
        durationMs: 0,
      };
      this.states.set(guid, state);
    }
    if (clamped < 1) state.layers.set(layer, clamped);
    else state.layers.delete(layer);
    let target = 1;
    for (const value of state.layers.values()) target *= value;
    const duration = Math.max(0, durationMs);

    if (duration === 0 || target !== state.target) {
      state.start = state.current;
      state.target = target;
      state.elapsedMs = 0;
      state.durationMs = duration;
      if (duration === 0) state.current = target;
    }
    this.refreshBinding(guid, state);
    if (duration === 0) this.finishIfOpaque(guid, state);
  }

  setAura(key: string, guid: string, serial: number, alpha: number | undefined) {
    if (alpha === undefined) {
      this.removeAura(key);
      return;
    }
    this.auraModifiers.set(key, { guid, serial, alpha });
    this.reconcileAuras(guid);
  }

  removeAura(key: string) {
    const removed = this.auraModifiers.get(key);
    if (!removed) return;
    this.auraModifiers.delete(key);
    this.reconcileAuras(removed.guid);
  }

  update(dtSeconds: number) {
    const dtMs = Math.max(0, dtSeconds) * 1000;
    for (const [guid, state] of this.states) {
      if (state.durationMs > 0) {
        state.elapsedMs += dtMs;
        const t = Math.min(1, state.elapsedMs / state.durationMs);
        const eased = t * t * t;
        state.current = state.start + (state.target - state.start) * eased;
        if (t >= 1) {
          state.current = state.target;
          state.durationMs = 0;
        }
      }
      this.refreshBinding(guid, state);
      this.finishIfOpaque(guid, state);
    }
  }

  clearEntity(guid: string) {
    for (const [key, aura] of this.auraModifiers) {
      if (aura.guid === guid) this.auraModifiers.delete(key);
    }
    const state = this.states.get(guid);
    if (state?.binding) clearBinding(state.binding);
    this.states.delete(guid);
  }

  clear() {
    this.auraModifiers.clear();
    for (const guid of [...this.states.keys()]) this.clearEntity(guid);
  }

  private reconcileAuras(guid: string) {
    let latest: { serial: number; alpha: number } | undefined;
    for (const aura of this.auraModifiers.values()) {
      if (aura.guid === guid && (!latest || aura.serial > latest.serial)) latest = aura;
    }
    this.setLayer(guid, 'spell-visual', latest?.alpha ?? 1, SPELL_VISUAL_OPACITY_FADE_MS);
  }

  private refreshBinding(guid: string, state: EntityOpacityState) {
    const target = this.getTarget(guid);
    const isolate = !!target?.isolateMaterials;
    if (state.binding && (state.binding.root !== target?.root || state.binding.isolateMaterials !== isolate)) {
      clearBinding(state.binding);
      state.binding = undefined;
    }
    if (!target) return;
    state.binding ??= {
      root: target.root,
      isolateMaterials: isolate,
      assignments: [],
      assignedMeshes: new WeakSet(),
      clones: new Set(),
    };
    applyBinding(state.binding, state.current);
  }

  private finishIfOpaque(guid: string, state: EntityOpacityState) {
    if (state.durationMs || state.layers.size || state.current < 1) return;
    if (state.binding) clearBinding(state.binding);
    this.states.delete(guid);
  }
}
