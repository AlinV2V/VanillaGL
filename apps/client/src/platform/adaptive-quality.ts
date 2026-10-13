import { rendererPixelRatio } from './renderer-pixel-ratio';
import type * as THREE from 'three';
import { AdaptiveWorkPressure, setAdaptiveEffectAdmissionScale } from './adaptive-work-pressure';
import { effectiveWorldPixelRatio, type MobileAdaptiveVideoOverride } from './mobile-render-policy';
import type { PerformanceProfile } from './performance-profile';
import { RENDER_SCALE_MIN } from '../ui/vanilla-video-cvars';

export type AdaptiveQualityState = {
  renderScale: number;
  averageFrameMs: number;
  samples: number;
  nonRenderCpuMs: number;
  cpuConstrained: boolean;
  reductions: number;
  increases: number;
  slowFrames: number;
  emergencyFrames: number;
  emergencyStage: number;
};

export type AdaptiveQualityEventDetail = {
  renderScale: number;
  averageFrameMs: number;
  reason: string;
  emergencyStage: number;
  video?: MobileAdaptiveVideoOverride;
};

let activeController: AdaptiveQualityController | null = null;

export function recordAdaptiveQualityFrame(now: number): void {
  activeController?.recordFrame(now);
}

export function recordAdaptiveQualityCpu(callbackMs: number, renderMs: number): void {
  activeController?.recordCpuWork(callbackMs, renderMs);
}

export function resetAdaptiveQualityFrameTiming(): void {
  activeController?.resetFrameTiming();
}

export function adaptiveQualityDiagnostics(): AdaptiveQualityState | null {
  return activeController?.state() ?? null;
}

export class AdaptiveQualityController {
  private readonly workPressure = new AdaptiveWorkPressure();
  private previous = 0;
  private sampleCount = 0;
  private lastDecisionAt = 0;
  private goodSince = 0;
  private slowFrames = 0;
  private emergencyFrames = 0;
  private emergencyStage = 0;
  private running = false;
  private dynamicMode: 'off' | 'target60' | 'target30' = 'off';
  private renderScale: number;
  private renderScaleFloor: number;
  private renderScaleCeiling: number;
  private requestedCeiling = 1;
  private reductions = 0;
  private increases = 0;
  private averageFrameMs: number;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private profile: PerformanceProfile,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.renderScale = profile.video.renderScale;
    this.renderScaleFloor = profile.minRenderScale;
    this.renderScaleCeiling = profile.maxRenderScale;
    this.averageFrameMs = 1000 / profile.targetFps;
  }

  configureDynamicResolution(mode: 'off' | 'target60' | 'target30', ceiling: number): boolean {
    if (mode === this.dynamicMode && ceiling === this.requestedCeiling && ceiling === this.renderScale && !this.running) return false;
    if (mode === this.dynamicMode && ceiling === this.requestedCeiling && this.running) return false;
    this.dynamicMode = mode;
    this.stop();
    this.profile = { ...this.profile, targetFps: mode === 'target30' ? 30 : 60 };
    this.synchronizeRenderScale(ceiling);
    if (mode !== 'off') this.start();
    return true;
  }

  updateProfile(profile: PerformanceProfile): void {
    this.profile = { ...profile, targetFps: this.dynamicMode === 'target30' ? 30 : 60 };
    this.renderScaleCeiling = this.requestedCeiling;
    this.renderScale = Math.max(RENDER_SCALE_MIN, Math.min(this.renderScaleCeiling, this.renderScale));
    this.renderScaleFloor = Math.max(RENDER_SCALE_MIN, this.requestedCeiling * 0.5);
    if (!profile.device.mobile) this.emergencyStage = 0;
    if (typeof window !== 'undefined') {
      this.renderer.setPixelRatio(rendererPixelRatio(this.renderer, window.devicePixelRatio, this.renderScale, window.innerWidth, window.innerHeight));
      this.renderer.setSize(window.innerWidth, window.innerHeight, false);
      this.dispatchQualityChange('performance profile changed');
    }
  }

  synchronizeRenderScale(renderScale: number, options: { resetTiming?: boolean; maxRenderScale?: number } = {}): number {
    const requested = Number.isFinite(renderScale) ? renderScale : this.profile.video.renderScale;
    const requestedCeiling = Number.isFinite(options.maxRenderScale) ? Number(options.maxRenderScale) : requested;
    this.requestedCeiling = Math.max(RENDER_SCALE_MIN, Math.min(1, requestedCeiling));
    this.renderScaleCeiling = Math.max(RENDER_SCALE_MIN, Math.min(1, requestedCeiling));
    this.renderScale = Math.max(RENDER_SCALE_MIN, Math.min(this.renderScaleCeiling, requested));
    this.renderScaleFloor = Math.max(RENDER_SCALE_MIN, this.renderScale * 0.5);
    if (options.resetTiming !== false) {
      this.workPressure.reset(); setAdaptiveEffectAdmissionScale(1);
      this.previous = 0;
      this.lastDecisionAt = 0;
      this.goodSince = 0;
      this.slowFrames = 0;
      this.emergencyFrames = 0;
      this.emergencyStage = 0;
      this.averageFrameMs = 1000 / this.profile.targetFps;
    }
    return this.renderScale;
  }

  recordCpuWork(callbackMs: number, renderMs: number): void {
    if (!this.running) return;
    this.workPressure.record(callbackMs, renderMs);
    // CPU pressure gates resolution decisions; it does not change effect quality.
  }

  private cpuConstrained(): boolean { return this.workPressure.constrained(1000 / Math.max(30, this.profile.targetFps)); }

  state(): AdaptiveQualityState {
    return {
      nonRenderCpuMs: this.workPressure.averageMs, cpuConstrained: this.cpuConstrained(),
      renderScale: this.renderScale,
      averageFrameMs: this.averageFrameMs,
      samples: this.sampleCount,
      reductions: this.reductions,
      increases: this.increases,
      slowFrames: this.slowFrames,
      emergencyFrames: this.emergencyFrames,
      emergencyStage: this.emergencyStage,
    };
  }

  start(): void {
    if (this.running || typeof window === 'undefined') return;
    this.running = true;
    this.resetFrameTiming();
    activeController = this;
  }

  stop(): void {
    this.workPressure.reset(); setAdaptiveEffectAdmissionScale(1);
    this.running = false;
    if (activeController === this) activeController = null;
  }

  resetFrameTiming(): void {
    this.workPressure.reset(); setAdaptiveEffectAdmissionScale(1);
    this.previous = 0;
    this.emergencyFrames = 0;
  }

  recordFrame(now: number): void {
    if (!this.running || document.hidden) {
      this.previous = 0;
      return;
    }
    if (!this.previous) {
      this.previous = now;
      this.lastDecisionAt = now;
      return;
    }
    const dt = now - this.previous;
    this.previous = now;
    if (!(dt > 0) || dt > 1000) return;
    const targetMs = 1000 / Math.max(30, this.profile.targetFps);
    this.averageFrameMs = this.averageFrameMs * 0.9 + Math.min(dt, 1000) * 0.1;
    this.sampleCount++;
    this.slowFrames = dt > targetMs * 1.5 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 1);
    this.emergencyFrames = dt > 100 ? this.emergencyFrames + 1 : 0;

    if (this.emergencyFrames >= 3) {
      this.emergencyFrames = 0;
      this.lastDecisionAt = now;
      this.goodSince = 0;
      if (this.cpuConstrained()) { this.escalateEmergencyQuality('measured non-render CPU pressure'); return; }
      if (!this.setRenderScale(this.renderScale - 0.15, 'emergency frame pressure')) {
        this.escalateEmergencyQuality('continued emergency frame pressure');
      }
      return;
    }
    if (now - this.lastDecisionAt >= 2000) {
      this.lastDecisionAt = now;
      this.considerAdjustment(now);
    }
  }

  private considerAdjustment(now: number): void {
    const targetMs = 1000 / Math.max(30, this.profile.targetFps);
    const slowThreshold = targetMs * 1.12;
    // Presentation intervals cannot expose spare GPU time at vsync. A long stable interval
    // permits a small quality probe, not a claim of measured CPU/GPU headroom.
    const stableThreshold = targetMs * 1.02;

    if (this.slowFrames >= 8 || this.averageFrameMs > slowThreshold) {
      this.goodSince = 0;
      if (this.cpuConstrained()) { this.escalateEmergencyQuality('sustained non-render CPU pressure'); return; }
      const severe = this.slowFrames >= 8 || this.averageFrameMs > slowThreshold * 1.75;
      const changed = this.setRenderScale(this.renderScale - (severe ? 0.1 : 0.05), severe ? 'severe frame pressure' : 'frame pressure');
      if (severe && !changed) this.escalateEmergencyQuality('sustained severe frame pressure');
      return;
    }
    if (this.slowFrames === 0 && this.averageFrameMs <= stableThreshold) {
      if (!this.goodSince) this.goodSince = now;
      if (now - this.goodSince >= 30_000) {
        if (this.emergencyStage > 0) {
          this.emergencyStage--;
          this.dispatchQualityChange('stable frame cadence emergency recovery');
        } else this.setRenderScale(this.renderScale + 0.05, 'stable frame cadence quality probe');
        this.goodSince = now;
      }
      return;
    }
    this.goodSince = 0;
  }

  private setRenderScale(next: number, reason: string): boolean {
    const clamped = Math.max(this.renderScaleFloor, Math.min(this.renderScaleCeiling, Math.round(next * 20) / 20));
    if (Math.abs(clamped - this.renderScale) < 0.001) return false;
    const old = this.renderScale;
    const ratio = rendererPixelRatio(this.renderer, window.devicePixelRatio, clamped, window.innerWidth, window.innerHeight);
    if (Math.abs(ratio - effectiveWorldPixelRatio(window.devicePixelRatio, old, this.profile)) < 0.001) return false;
    this.renderScale = clamped;
    if (clamped < old) this.reductions++;
    else this.increases++;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.dispatchQualityChange(reason);
    this.log(`adaptive quality: renderScale ${old.toFixed(2)} -> ${clamped.toFixed(2)} (${reason}, ${this.averageFrameMs.toFixed(1)} ms)`);
    return true;
  }

  private escalateEmergencyQuality(reason: string): void {
    // At the resolution floor, preserve the user's other graphics settings.
    void reason;
  }

  private dispatchQualityChange(reason: string): void {
    const detail: AdaptiveQualityEventDetail = {
      renderScale: this.renderScale, averageFrameMs: this.averageFrameMs,
      reason, emergencyStage: 0,
    };
    window.dispatchEvent(new CustomEvent<AdaptiveQualityEventDetail>('vanillagl-adaptive-quality', { detail }));
  }
}
