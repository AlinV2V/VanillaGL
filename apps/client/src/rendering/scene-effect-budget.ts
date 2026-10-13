import { adaptiveEffectAdmissionScale } from '../platform/adaptive-work-pressure';
import { getPerformanceProfile } from '../platform/performance-profile';

let frame = 0;
export function beginSceneEffectFrame(): void { frame++; }
const budgets = new WeakMap<object, SceneEffectBudget>();
export function sceneEffectBudget(scene: object): SceneEffectBudget {
  let budget = budgets.get(scene);
  if (!budget) { budget = new SceneEffectBudget(); budgets.set(scene, budget); }
  return budget;
}

/** Browser work limits, independent of the unresolved Vanilla spellEffectLevel CVar. */
export class SceneEffectBudget {
  private frame = -1;
  private spawned = 0;
  private active = 0;
  private beams = 0;
  private denied = 0;
  private maxActive = 8192;
  private maxSpawn = 1024;
  private maxEmitterSpawn = 128;
  private maxBeams = 128;

  private refresh(): void {
    if (this.frame === frame) return;
    this.frame = frame; this.spawned = 0;
    const constrained = getPerformanceProfile().device.mobile;
    this.maxActive = constrained ? 2048 : 8192;
    this.maxSpawn = constrained ? 256 : 1024;
    this.maxEmitterSpawn = constrained ? 64 : 128;
    this.maxBeams = constrained ? 32 : 128;
    const scale = adaptiveEffectAdmissionScale();
    this.maxActive *= scale; this.maxSpawn *= scale; this.maxEmitterSpawn *= scale; this.maxBeams *= scale;
  }

  admitParticles(requested: number, important: boolean): number {
    this.refresh();
    // Reserve the last quarter for nearby/local/target/area effects. Existing particles
    // always finish their authored lifetime; admission only bounds new cosmetic work.
    const reserve = important ? 1 : 0.75;
    const count = Math.max(0, Math.min(Math.floor(requested), this.maxEmitterSpawn,
      Math.floor(this.maxSpawn * reserve) - this.spawned, Math.floor(this.maxActive * reserve) - this.active));
    this.active += count; this.spawned += count; this.denied += Math.max(0, Math.floor(requested) - count);
    return count;
  }

  releaseParticles(count: number): void { this.active = Math.max(0, this.active - count); }
  admitBeam(important: boolean): boolean {
    this.refresh();
    if (this.beams >= this.maxBeams * (important ? 1 : 0.75)) return false;
    this.beams++; return true;
  }
  releaseBeam(): void { this.beams = Math.max(0, this.beams - 1); }
  diagnostics() { return { activeParticles: this.active, spawnedThisFrame: this.spawned, activeBeams: this.beams, deniedParticles: this.denied }; }
}
