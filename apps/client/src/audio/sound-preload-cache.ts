import { getPerformanceProfile } from '../platform/performance-profile';

export function soundPreloadPolicy() {
  return getPerformanceProfile().device.mobile
    ? { files: 0, concurrent: 0 }
    : { files: 192, concurrent: 4 };
}

type Entry = { audio?: HTMLAudioElement; loading: boolean; cleanup?: () => void };

/** Speculative sounds must not open hundreds of simultaneous browser decoders/network streams. */
export class SoundPreloadCache {
  private entries = new Map<string, Entry>();
  private loading = 0;
  private started = 0;
  private reused = 0;

  constructor(private readonly policy = soundPreloadPolicy) {}

  get size() { return this.entries.size; }

  preload(url: string) {
    const existing = this.entries.get(url);
    if (existing) { this.entries.delete(url); this.entries.set(url, existing); return; }
    const { files } = this.policy();
    if (files <= 0) return;
    while (this.entries.size >= files) {
      // Never cancel an in-flight preload just because another speculative cue arrived.
      const victim = [...this.entries].find(([, entry]) => !entry.loading);
      if (!victim) return;
      this.remove(victim[0], true);
    }
    this.entries.set(url, { loading: false });
    this.pump();
  }

  /** Transfer ownership of a prepared player instead of cloning another decoder. */
  take(url: string): HTMLAudioElement | undefined {
    const audio = this.remove(url, false);
    if (audio) this.reused++;
    this.pump();
    return audio;
  }

  clear() { for (const url of this.entries.keys()) this.remove(url, true); }

  private remove(url: string, release: boolean) {
    const entry = this.entries.get(url);
    if (!entry) return;
    this.entries.delete(url);
    entry.cleanup?.();
    if (entry.loading) this.loading--;
    if (release && entry.audio) { entry.audio.removeAttribute('src'); entry.audio.load(); }
    return entry.audio;
  }

  private pump() {
    const { concurrent } = this.policy();
    for (const [url, entry] of this.entries) {
      if (this.loading >= concurrent) break;
      if (entry.audio) continue;
      const audio = new Audio();
      entry.audio = audio; entry.loading = true; this.loading++; this.started++;
      const finish = (failed: boolean) => {
        if (!entry.loading || this.entries.get(url) !== entry) return;
        entry.cleanup?.(); entry.loading = false; this.loading--;
        if (failed) this.remove(url, true);
        this.pump();
      };
      const ready = () => finish(false), error = () => finish(true);
      const timeout = window.setTimeout(error, 10_000);
      entry.cleanup = () => {
        window.clearTimeout(timeout);
        audio.removeEventListener('canplaythrough', ready);
        audio.removeEventListener('error', error);
      };
      audio.addEventListener('canplaythrough', ready, { once: true });
      audio.addEventListener('error', error, { once: true });
      audio.preload = 'auto'; audio.src = url; audio.load();
    }
  }

  diagnostics() {
    return { ...this.policy(), pending: [...this.entries.values()].filter(e => !e.audio).length,
      loading: this.loading, players: [...this.entries.values()].filter(e => e.audio).length,
      started: this.started, reusedForPlayback: this.reused };
  }
}
