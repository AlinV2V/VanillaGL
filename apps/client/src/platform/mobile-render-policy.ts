import type { BrowserVideoCvars } from '../ui/vanilla-video-cvars';
import { browserRenderPixelRatio } from '../ui/vanilla-video-cvars';
import { getPerformanceProfile, type PerformanceProfile } from './performance-profile';

export type MobileAdaptiveVideoOverride = Pick<BrowserVideoCvars, 'farclip' | 'WorldDetail'>;

/** Hardware profiles recommend defaults; saved user values are authoritative. */
export function effectiveVideoCvars(cvars: BrowserVideoCvars, _profile: PerformanceProfile = getPerformanceProfile()): BrowserVideoCvars {
  return cvars;
}

export function effectiveWorldPixelRatio(
  devicePixelRatio: number,
  renderScale: number,
  profile: PerformanceProfile = getPerformanceProfile(),
): number {
  return browserRenderPixelRatio(devicePixelRatio, renderScale);
}

export function effectivePreviewPixelRatio(
  devicePixelRatio: number,
  profile: PerformanceProfile = getPerformanceProfile(),
): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, profile.maxPreviewPixelRatio);
}

export function mobileGlowAllowed(profile: PerformanceProfile = getPerformanceProfile()): boolean {
  return true;
}

/** Dynamic resolution never changes draw distance or clutter density. */
export function mobileAdaptiveVideoOverride(_event: Event, _base?: BrowserVideoCvars): MobileAdaptiveVideoOverride | null { return null; }
