const MAX_BYTES = 24 * 1024 * 1024;
const MAX_SOUND_BYTES = 8 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024;
type Entry = { buffer: AudioBuffer; bytes: number; users: number };
type Job = { url: string; wanted: Array<() => boolean>; resolve: (entry: Entry) => void; reject: (error: unknown) => void; promise: Promise<Entry>; epoch: number };
export const staleSound = () => new DOMException('Sound is no longer relevant', 'AbortError');

/** On-demand PCM cache. One fetch/decode at a time; retained active buffers count toward budget. */
export class MobileBufferCache {
  private entries = new Map<string, Entry>();
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private failures = new Map<string, number>();
  private bytes = 0;
  private busy = false;
  private epoch = 0;
  private abort?: AbortController;
  private decodes = 0;
  private hits = 0;
  private dropped = 0;

  async acquire(url: string, context: AudioContext, wanted: () => boolean) {
    if (!wanted()) throw staleSound();
    let entry = this.entries.get(url);
    if (entry) {
      this.hits++; this.entries.delete(url); this.entries.set(url, entry);
    } else {
      if ((this.failures.get(url) ?? 0) > performance.now()) throw new Error('Audio asset retry cooldown');
      let job = this.jobs.get(url);
      if (!job) {
        if (this.jobs.size >= 16) { this.dropped++; throw staleSound(); }
        let resolve!: Job['resolve'], reject!: Job['reject'];
        const promise = new Promise<Entry>((yes, no) => { resolve = yes; reject = no; });
        job = { url, wanted: [], resolve, reject, promise, epoch: this.epoch };
        this.jobs.set(url, job); this.queue.push(job);
      }
      job.wanted.push(wanted);
      this.pump(context);
      entry = await job.promise;
    }
    if (!wanted()) throw staleSound();
    entry.users++;
    let released = false;
    return { buffer: entry.buffer, release: () => { if (!released) { released = true; entry.users--; } } };
  }

  clear() {
    this.epoch++; this.abort?.abort();
    for (const job of this.jobs.values()) job.reject(staleSound());
    this.jobs.clear(); this.queue = []; this.entries.clear(); this.bytes = 0; this.failures.clear();
  }

  private async download(url: string, signal: AbortSignal) {
    const response = await fetch(url, { signal });
    if (!response.ok || response.headers.get('content-type')?.includes('text/html')) throw new Error('Audio fetch failed');
    if (Number(response.headers.get('content-length')) > MAX_DOWNLOAD_BYTES) throw new Error('Audio download too large');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Audio response has no body');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_DOWNLOAD_BYTES) { await reader.cancel(); throw new Error('Audio download too large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes.buffer;
  }

  private pump(context: AudioContext) {
    if (this.busy) return;
    const job = this.queue.shift(); if (!job) return;
    this.busy = true;
    const wanted = () => job.epoch === this.epoch && job.wanted.some(fn => fn());
    void (async () => {
      try {
        if (!wanted()) throw staleSound();
        const controller = this.abort = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        let encoded: ArrayBuffer;
        try { encoded = await this.download(job.url, controller.signal); } finally { clearTimeout(timer); }
        if (!wanted()) throw staleSound();
        const buffer = await context.decodeAudioData(encoded); this.decodes++;
        if (job.epoch !== this.epoch) throw staleSound();
        const bytes = buffer.length * buffer.numberOfChannels * 4;
        if (bytes > MAX_SOUND_BYTES || buffer.duration > 30) throw new Error('Effect exceeds mobile decoded audio budget');
        for (const [key, entry] of this.entries) {
          if (this.bytes + bytes <= MAX_BYTES && this.entries.size < 128) break;
          if (entry.users) continue;
          this.entries.delete(key); this.bytes -= entry.bytes;
        }
        if (this.bytes + bytes > MAX_BYTES) throw new Error('Active audio fills mobile cache');
        const entry = { buffer, bytes, users: 0 };
        this.entries.set(job.url, entry); this.bytes += bytes;
        // Cache completed decodes even if the initial one-shot has expired; never play it late.
        job.resolve(entry);
      } catch (error) {
        if (job.epoch === this.epoch && (error as Error).name !== 'AbortError') {
          this.failures.set(job.url, performance.now() + 30_000);
          if (this.failures.size > 64) this.failures.delete(this.failures.keys().next().value!);
        }
        job.reject(error);
      } finally {
        if (this.jobs.get(job.url) === job) this.jobs.delete(job.url);
        this.busy = false; this.abort = undefined;
        // Yield between decodes so a warm network queue cannot monopolize startup.
        setTimeout(() => this.pump(context), 0);
      }
    })();
  }

  diagnostics() {
    return { decodedBytes: this.bytes, maxDecodedBytes: MAX_BYTES, buffers: this.entries.size,
      queued: this.queue.length, loading: Number(this.busy), decodes: this.decodes, cacheHits: this.hits, dropped: this.dropped };
  }
}
