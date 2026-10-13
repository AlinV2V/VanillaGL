import { detectDeviceProfile, type DeviceProfile } from './device-profile';

export type PerformanceProfile = {
  id: 'desktop' | 'desktop-mid' | 'desktop-low' | 'tablet' | 'mobile-low' | 'mobile-mid' | 'mobile-high';
  device: DeviceProfile;
  targetFps: number;
  minRenderScale: number;
  maxRenderScale: number;
  maxPixelRatio: number;
  maxPreviewPixelRatio: number;
  allowGlow: boolean;
  tileRadius: number;
  worldTextureLimit: number;
  modelTextureLimit: number;
  appearanceAtlasLimit: number;
  ktxWorkerLimit: number;
  video: {
    renderScale: number;
    farclip: number;
    WorldDetail: number;
    unitDrawDist: number;
    weatherDensity: number;
    spellEffectLevel: number;
    anisotropic: number;
    ffxGlow: number;
  };
};

export function profileForDevice(device: DeviceProfile): PerformanceProfile {
  if (!device.mobile && device.tier === 'low') {
    return {
      id: 'desktop-low', device, targetFps: 60, minRenderScale: 0.5, maxRenderScale: 1,
      maxPixelRatio: 1.25, maxPreviewPixelRatio: 1.25, allowGlow: false,
      tileRadius: 1, worldTextureLimit: 1024, modelTextureLimit: 384, appearanceAtlasLimit: 96, ktxWorkerLimit: 1,
      video: { renderScale: 0.65, farclip: 220, WorldDetail: 1, unitDrawDist: 80, weatherDensity: 1, spellEffectLevel: 1, anisotropic: 1, ffxGlow: 0 },
    };
  }
  if (!device.mobile && device.tier === 'mid') {
    return {
      id: 'desktop-mid', device, targetFps: 60, minRenderScale: 0.55, maxRenderScale: 1,
      maxPixelRatio: 1.5, maxPreviewPixelRatio: 1.5, allowGlow: false,
      tileRadius: 1, worldTextureLimit: 1536, modelTextureLimit: 512, appearanceAtlasLimit: 128, ktxWorkerLimit: 2,
      video: { renderScale: 0.85, farclip: 300, WorldDetail: 1, unitDrawDist: 90, weatherDensity: 2, spellEffectLevel: 2, anisotropic: 2, ffxGlow: 0 },
    };
  }
  if (!device.mobile) {
    return {
      id: 'desktop', device, targetFps: 60, minRenderScale: 0.5, maxRenderScale: 1,
      maxPixelRatio: 2.5, maxPreviewPixelRatio: Number.POSITIVE_INFINITY, allowGlow: true,
      tileRadius: 1, worldTextureLimit: 2048, modelTextureLimit: 768, appearanceAtlasLimit: 256, ktxWorkerLimit: 3,
      video: { renderScale: 1, farclip: 350, WorldDetail: 2, unitDrawDist: 100, weatherDensity: 3, spellEffectLevel: 2, anisotropic: 1, ffxGlow: 1 },
    };
  }
  // Form factor controls layout, while hardware tier controls graphics cost.
  if (device.tier === 'high') {
    return {
      id: device.kind === 'tablet' ? 'tablet' : 'mobile-high', device, targetFps: 60,
      minRenderScale: 0.6, maxRenderScale: 1,
      maxPixelRatio: 1.6, maxPreviewPixelRatio: 1.5, allowGlow: false,
      // A 250-yard far clip fits inside the center tile plus its immediate neighbors. Maps whose
      // baked entry explicitly requires radius 2 still win through tileStreamRadius(center).
      tileRadius: 1, worldTextureLimit: 1024, modelTextureLimit: 512, appearanceAtlasLimit: 128, ktxWorkerLimit: 2,
      video: { renderScale: 0.85, farclip: 250, WorldDetail: 2, unitDrawDist: 100, weatherDensity: 2, spellEffectLevel: 2, anisotropic: 2, ffxGlow: 0 },
    };
  }
  if (device.tier === 'low') {
    return {
      id: 'mobile-low', device, targetFps: 60, minRenderScale: 0.5, maxRenderScale: 1,
      maxPixelRatio: 1.25, maxPreviewPixelRatio: 1, allowGlow: false,
      tileRadius: 1, worldTextureLimit: 512, modelTextureLimit: 256, appearanceAtlasLimit: 64, ktxWorkerLimit: 1,
      video: { renderScale: 0.6, farclip: 160, WorldDetail: 0, unitDrawDist: 70, weatherDensity: 1, spellEffectLevel: 1, anisotropic: 1, ffxGlow: 0 },
    };
  }
  return {
    id: 'mobile-mid', device, targetFps: 60, minRenderScale: 0.55, maxRenderScale: 1,
    maxPixelRatio: 1.5, maxPreviewPixelRatio: 1.25, allowGlow: false,
    tileRadius: 1, worldTextureLimit: 768, modelTextureLimit: 384, appearanceAtlasLimit: 96, ktxWorkerLimit: 1,
    video: { renderScale: 0.7, farclip: 200, WorldDetail: 1, unitDrawDist: 90, weatherDensity: 1, spellEffectLevel: 1, anisotropic: 2, ffxGlow: 0 },
  };
}

let current = profileForDevice(detectDeviceProfile());

export function setPerformanceProfile(profile: PerformanceProfile): void {
  current = profile;
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.vanillaglDevice = profile.device.kind;
    document.documentElement.dataset.vanillaglPerformance = profile.id;
  }
}

export function refreshPerformanceProfile(gl?: WebGL2RenderingContext | null): PerformanceProfile {
  current = profileForDevice(detectDeviceProfile(gl));
  setPerformanceProfile(current);
  return current;
}

export function getPerformanceProfile(): PerformanceProfile {
  return current;
}
