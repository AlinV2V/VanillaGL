import { getPerformanceProfile } from '../platform/performance-profile';

/** Mobile retains directional attenuation without a convolution processor per positioned voice. */
export const soundPanningModel = (): PanningModelType =>
  getPerformanceProfile().device.mobile ? 'equalpower' : 'HRTF';

let directMobileSfx = typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('mobileAudioDirect') === '1';

export function setMobileDirectSfx(enabled: boolean): void {
  directMobileSfx = enabled;
}

export function mobileDirectSfxEnabled(): boolean {
  return getPerformanceProfile().device.mobile && directMobileSfx;
}

export function shouldRouteVoiceThroughWebAudio(
  category: 'sfx' | 'music',
  options: {
    position?: { x: number; y: number; z: number };
    underwaterAffected?: boolean;
    loop?: boolean;
    key?: string;
  },
  underwater: boolean,
): boolean {
  if (category !== 'sfx' || options.underwaterAffected === false) return false;
  if (!mobileDirectSfxEnabled()) return true;
  return !!options.position || !!options.loop || !!options.key || underwater;
}
