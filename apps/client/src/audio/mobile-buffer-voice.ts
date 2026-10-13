import type { AudioVoice } from './audio-voice';
import { MobileBufferCache, staleSound } from './mobile-buffer-cache';

/** A lifecycle handle, not an HTML element: no media player or MediaElementSource is allocated. */
export class MobileBufferVoice extends EventTarget implements AudioVoice {
  readonly dataset: DOMStringMap = {};
  loop = false; preload: HTMLAudioElement['preload'] = ''; playbackRate = 1; preservesPitch = false;
  paused = true; error = null;
  private gain?: GainNode;
  private panner?: PannerNode;
  private source?: AudioBufferSourceNode;
  private releaseBuffer?: () => void;
  private stopped = false;
  private starting?: Promise<void>;
  private level = 1;
  private readonly requested = performance.now();
  private endsAt = Infinity;
  constructor(public src: string, private readonly cache: MobileBufferCache,
    private readonly context: () => AudioContext | undefined,
    private readonly output: () => AudioNode | undefined,
    private readonly position?: { x: number; y: number; z: number }) { super(); }
  get currentSrc() { return this.src; }
  get expired() {
    return this.source ? !this.loop && (this.context()?.currentTime ?? 0) > this.endsAt + 1
      : performance.now() - this.requested > 10_000;
  }
  get volume() { return this.level; }
  set volume(value: number) {
    this.level = value;
    if (this.gain) this.gain.gain.value = value;
  }
  private wanted = () => !this.stopped && !document.hidden &&
    (this.loop || performance.now() - this.requested < 350);

  play(): Promise<void> {
    if (this.source) return Promise.resolve();
    if (this.starting) return this.starting;
    const context = this.context();
    if (!context || context.state !== 'running') return Promise.reject(new DOMException('Audio needs user activation', 'NotAllowedError'));
    const run = async () => {
      const lease = await this.cache.acquire(this.src, context, this.wanted);
      if (!this.wanted() || context.state !== 'running') { lease.release(); throw staleSound(); }
      this.releaseBuffer = lease.release;
      try {
        this.gain = context.createGain(); this.gain.gain.value = this.level;
        this.gain.connect(this.output() ?? context.destination);
        const source = this.source = context.createBufferSource();
        source.buffer = lease.buffer; source.loop = this.loop; source.playbackRate.value = this.playbackRate;
        if (this.position) {
          const panner = this.panner = context.createPanner(); panner.panningModel = 'equalpower';
          panner.distanceModel = 'inverse'; panner.refDistance = 4; panner.maxDistance = 60; panner.rolloffFactor = 1;
          panner.positionX.value = this.position.x; panner.positionY.value = this.position.y; panner.positionZ.value = this.position.z;
          source.connect(panner).connect(this.gain);
        } else source.connect(this.gain);
        source.onended = () => { this.cleanup(); this.dispatchEvent(new Event('ended')); };
        source.start(); this.endsAt = context.currentTime + lease.buffer.duration / this.playbackRate; this.paused = false;
      } catch (error) { this.cleanup(); throw error; }
    };
    this.starting = run().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  pause() { this.stopped = true; this.cleanup(); }
  removeAttribute(name: string) { if (name === 'src') { this.pause(); this.src = ''; } }
  load() { /* Source fallback changes the URL; buffers never invoke HTMLMediaElement.load(). */ }
  private cleanup() {
    if (this.source) { this.source.onended = null; try { this.source.stop(); } catch { /* already ended */ } this.source.disconnect(); }
    this.source = undefined; this.panner?.disconnect(); this.panner = undefined;
    this.gain?.disconnect(); this.gain = undefined; this.releaseBuffer?.(); this.releaseBuffer = undefined; this.paused = true;
  }
}
