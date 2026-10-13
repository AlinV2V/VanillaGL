export type DeviceKind = 'desktop' | 'tablet' | 'phone';
export type PerformanceTier = 'low' | 'mid' | 'high';

export type DeviceProfile = {
  kind: DeviceKind;
  tier: PerformanceTier;
  mobile: boolean;
  touch: boolean;
  ios: boolean;
  android: boolean;
  width: number;
  height: number;
  dpr: number;
  hardwareConcurrency?: number;
  deviceMemoryGb?: number;
  maxTextureSize?: number;
  maxRenderbufferSize?: number;
  gpuRenderer?: string;
};

export type DeviceSignals = {
  userAgent?: string;
  touchPoints?: number;
  coarsePointer?: boolean;
  width?: number;
  height?: number;
  dpr?: number;
  hardwareConcurrency?: number;
  deviceMemoryGb?: number;
  maxTextureSize?: number;
  maxRenderbufferSize?: number;
  gpuRenderer?: string;
  forceMobile?: boolean;
  forceDesktop?: boolean;
};

const clampPositive = (value: number | undefined, fallback: number) =>
  Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;

export function resolveForcedPerformanceTier(search: string): PerformanceTier | undefined {
  const value = new URLSearchParams(search).get('performancetier');
  return value === 'low' || value === 'mid' || value === 'high' ? value : undefined;
}

export function classifyDeviceProfile(signals: DeviceSignals = {}): DeviceProfile {
  const ua = signals.userAgent ?? '';
  const ios = /iPad|iPhone|iPod/i.test(ua) || (/Macintosh/i.test(ua) && (signals.touchPoints ?? 0) > 1);
  const android = /Android/i.test(ua);
  const touch = (signals.touchPoints ?? 0) > 0 || signals.coarsePointer === true;
  const width = clampPositive(signals.width, 1920);
  const height = clampPositive(signals.height, 1080);
  const shortest = Math.min(width, height);
  const mobileUa = /Mobile|Android|iPhone|iPod/i.test(ua);
  const tabletUa = /iPad|Tablet/i.test(ua) || (android && !/Mobile/i.test(ua));
  const mobile = signals.forceDesktop !== true && (signals.forceMobile === true || mobileUa || tabletUa || (touch && shortest <= 1024));
  const kind: DeviceKind = !mobile ? 'desktop' : tabletUa || (touch && shortest >= 700) ? 'tablet' : 'phone';

  const cores = signals.hardwareConcurrency;
  const memory = signals.deviceMemoryGb;
  const maxTexture = signals.maxTextureSize;
  const maxRenderbuffer = signals.maxRenderbufferSize;
  const gpuRenderer = signals.gpuRenderer?.trim() || undefined;

  let score = 0;
  if ((cores ?? 0) >= 8) score += 2;
  else if ((cores ?? 0) >= 6) score += 1;
  else if (cores !== undefined && cores <= 4) score -= 1;
  if ((memory ?? 0) >= 8) score += 2;
  else if ((memory ?? 0) >= 4) score += 1;
  else if (memory !== undefined && memory <= 2) score -= 2;
  if ((maxTexture ?? 0) >= 16384) score += 1;
  else if (maxTexture !== undefined && maxTexture <= 4096) score -= 1;
  if ((maxRenderbuffer ?? 0) >= 8192) score += 1;
  else if (maxRenderbuffer !== undefined && maxRenderbuffer <= 4096) score -= 1;

  // Safari intentionally exposes less hardware information. Modern iOS hardware should start in
  // the middle rather than being penalized for absent deviceMemory/GPU strings; adaptive quality
  // will move framebuffer scale after real frame-time measurements.
  if (ios && mobile && cores === undefined && memory === undefined) score = Math.max(score, 0);

  const gpu = gpuRenderer?.toLowerCase() ?? '';
  const softwareGpu = /swiftshader|llvmpipe|software rasterizer|microsoft basic render/.test(gpu);
  const discreteGpu = /geforce|quadro|radeon rx|radeon pro|intel.*arc|apple m[1-9]/.test(gpu);
  const integratedGpu = !discreteGpu && /intel|iris|uhd graphics|hd graphics|radeon\(tm\) graphics/.test(gpu);

  // WebGL capability maximums describe what an iPhone can allocate, not what Mobile Safari can
  // sustain thermally. Keep phones on the measured mid baseline; iPads and Android retain scoring.
  // On desktop those maxima are only supporting signals: broad renderer classes distinguish an
  // integrated laptop GPU from a discrete GPU without keying policy to one product string.
  const desktopScore = score + (discreteGpu ? 2 : integratedGpu ? -4 : 0);
  const hasDesktopEvidence = [cores, memory, maxTexture, maxRenderbuffer, gpuRenderer].some((value) => value !== undefined);
  const desktopTier: PerformanceTier = softwareGpu ? 'low'
    : !hasDesktopEvidence ? 'high'
      : desktopScore >= 4 ? 'high' : desktopScore <= -1 ? 'low' : 'mid';
  const tier: PerformanceTier = !mobile ? desktopTier : ios && kind === 'phone' ? 'mid' : score >= 3 ? 'high' : score <= -1 ? 'low' : 'mid';
  return {
    kind,
    tier,
    mobile,
    touch,
    ios,
    android,
    width,
    height,
    dpr: clampPositive(signals.dpr, 1),
    hardwareConcurrency: cores,
    deviceMemoryGb: memory,
    maxTextureSize: maxTexture,
    maxRenderbufferSize: maxRenderbuffer,
    gpuRenderer,
  };
}

export function detectDeviceProfile(gl?: WebGL2RenderingContext | null): DeviceProfile {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return classifyDeviceProfile();
  const params = new URLSearchParams(window.location?.search ?? '');
  const forceMobile = params.get('mobile') === '1' || params.get('mobile') === 'true';
  const forceDesktop = params.get('mobile') === '0' || params.get('mobile') === 'false';
  const forcedTier = resolveForcedPerformanceTier(window.location?.search ?? '');
  const nav = navigator as Navigator & { deviceMemory?: number };
  const debugRenderer = gl?.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null | undefined;
  const gpuRenderer = gl
    ? String(gl.getParameter(debugRenderer?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) ?? '')
    : undefined;
  const detected = classifyDeviceProfile({
    userAgent: navigator.userAgent,
    touchPoints: navigator.maxTouchPoints,
    coarsePointer: window.matchMedia?.('(pointer: coarse)').matches ?? false,
    width: window.screen?.width ?? window.innerWidth,
    height: window.screen?.height ?? window.innerHeight,
    dpr: window.devicePixelRatio,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGb: nav.deviceMemory,
    maxTextureSize: gl ? Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) : undefined,
    maxRenderbufferSize: gl ? Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) : undefined,
    gpuRenderer,
    forceMobile,
    forceDesktop,
  });
  return forcedTier ? { ...detected, tier: forcedTier } : detected;
}
