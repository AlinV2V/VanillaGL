/** Unlock on genuine input, then recover suspended/interrupted iOS contexts on foregrounding. */
export class AudioContextRecovery {
  private pending: Promise<void> | null = null;
  private attempts = 0;
  private failures = 0;
  private armed = true;
  private observed?: AudioContext;
  private readonly stateChanged = () => {
    if (this.observed?.state === 'interrupted' || this.observed?.state === 'suspended') this.armed = true;
    // resume() can finish after the gesture's immediate playback attempt was rejected.
    if (this.mobile() && this.observed?.state === 'running') this.recoverVoices();
  };
  private readonly gesture = (event: Event) => {
    if (!event.isTrusted) return;
    if (this.mobile() && !this.armed && this.context(false)?.state === 'running') return;
    this.resume(true);
    this.armed = !this.context(false);
    // Keep media play() inside the gesture, not a promise continuation.
    this.recoverVoices();
  };
  private readonly foreground = () => {
    if (document.hidden) return;
    this.armed = true;
    this.resume(false);
  };

  constructor(private readonly context: (create: boolean) => AudioContext | undefined,
    private readonly recoverVoices: () => void, private readonly mobile: () => boolean = () => false) {
    for (const name of ['pointerup', 'touchend', 'keydown']) document.addEventListener(name, this.gesture, true);
    document.addEventListener('visibilitychange', this.foreground);
    window.addEventListener?.('pageshow', this.foreground);
  }

  resume(gesture = false) {
    const context = this.context(gesture);
    if (context && context !== this.observed) {
      this.observed?.removeEventListener?.('statechange', this.stateChanged);
      this.observed = context;
      context.addEventListener?.('statechange', this.stateChanged);
    }
    if (!context || context.state === 'running' || context.state === 'closed') return;
    // Some iOS resumes remain pending until input. A real gesture must be allowed to retry.
    if (this.pending && !gesture) return;
    this.attempts++;
    try {
      const attempt = context.resume().catch(() => { this.failures++; this.armed = true; });
      this.pending = attempt;
      void attempt.then(() => { if (this.pending === attempt) this.pending = null; });
    } catch { this.failures++; }
  }

  diagnostics() {
    return { state: this.context(false)?.state ?? 'uninitialized', resumeAttempts: this.attempts,
      resumeFailures: this.failures, resumePending: !!this.pending };
  }

  dispose() {
    this.observed?.removeEventListener?.('statechange', this.stateChanged);
    for (const name of ['pointerup', 'touchend', 'keydown']) document.removeEventListener(name, this.gesture, true);
    document.removeEventListener('visibilitychange', this.foreground);
    window.removeEventListener?.('pageshow', this.foreground);
  }
}
