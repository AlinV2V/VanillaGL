import type { AudioVoice } from './audio-voice';
import { getPerformanceProfile, type PerformanceProfile } from '../platform/performance-profile';

export const MAX_ACTIVE_AUDIO_VOICES = 128;

export function voiceLimitForProfile(profile: PerformanceProfile = getPerformanceProfile()): number {
  if (profile.id === 'mobile-low') return 10;
  if (profile.id === 'mobile-mid') return 10;
  if (profile.device.mobile) return 10;
  if (profile.id === 'desktop-low') return 48;
  if (profile.id === 'desktop-mid') return 64;
  return MAX_ACTIVE_AUDIO_VOICES;
}

/**
 * Hard browser-media budget. Preserve keyed loops/music and retire the oldest disposable one-shot
 * when a high-value voice arrives; otherwise drop the new one-shot before allocating a player.
 */
export class ActiveVoiceBudget {
  dropped = 0;

  constructor(private readonly limit: () => number = () => voiceLimitForProfile(),
    private readonly mobile: () => boolean = () => getPerformanceProfile().device.mobile) {}

  admit(
    active: ReadonlySet<AudioVoice>,
    important: boolean,
    release: (voice: AudioVoice) => void,
  ): boolean {
    const voiceLimit = Math.max(1, Math.round(this.limit()));
    if (active.size < voiceLimit) return true;
    // A long-lived spell/aura must not lock all ten mobile slots until the user mutes audio.
    // Preserve the small environmental bus; other loops can yield to a fresh cue under pressure.
    if (this.mobile()) {
      for (const victim of active) {
        if (victim.dataset.soundCategory === 'music' ||
          ['zone-ambience', 'weather', 'underwater'].includes(victim.dataset.soundKey ?? '')) continue;
        if (!victim.loop && !important) continue;
        release(victim);
        if (active.size < voiceLimit) return true;
      }
    }
    if (important) {
      for (const victim of active) {
        if (victim.loop || victim.dataset.soundKey || victim.dataset.soundCategory === 'music') continue;
        release(victim);
        if (active.size < voiceLimit) return true;
      }
    }
    this.dropped++;
    return false;
  }

  diagnostics() {
    return { voiceLimit: Math.max(1, Math.round(this.limit())), voicesDroppedByBudget: this.dropped };
  }
}
