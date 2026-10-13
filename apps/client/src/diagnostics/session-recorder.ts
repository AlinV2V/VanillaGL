import {
  BROWSERPORT_CAPTURE_SCHEMA,
  redactBrowserPortCapture,
  type BrowserPortCapture,
  type BrowserPortCheckpoint,
} from './capture-format';
import { subscribeWorldPackets } from './packet-observer';
import { emitBrowserPortTrace } from './trace-bus';

export type BrowserPortRecorderStart = {
  label?: string;
  sensitive?: boolean;
  maxBytes?: number;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

const serialisable = (value: unknown): unknown => {
  try { return JSON.parse(JSON.stringify(value)); } catch { return '[unserialisable]'; }
};

export class BrowserPortSessionRecorder {
  private packets: BrowserPortCapture['packets'] = [];
  private checkpoints: BrowserPortCheckpoint[] = [];
  private startedAtMs = 0;
  private startedAtIso = '';
  private label = '';
  private sensitive = false;
  private maxBytes = 64 * 1024 * 1024;
  private capturedBytes = 0;
  private truncated = false;
  private unsubscribe?: () => void;

  start(options: BrowserPortRecorderStart = {}) {
    this.unsubscribe?.();
    this.packets = [];
    this.checkpoints = [];
    this.startedAtMs = performance.now();
    this.startedAtIso = new Date().toISOString();
    this.label = String(options.label ?? 'unlabelled session').slice(0, 200);
    this.sensitive = options.sensitive === true;
    this.maxBytes = Math.max(1024, Math.floor(options.maxBytes ?? 64 * 1024 * 1024));
    this.capturedBytes = 0;
    this.truncated = false;
    this.unsubscribe = subscribeWorldPackets((packet) => {
      if (this.truncated) return;
      if (this.capturedBytes + packet.body.byteLength > this.maxBytes) {
        this.truncated = true;
        emitBrowserPortTrace('recorder', 'truncated', { maxBytes: this.maxBytes });
        return;
      }
      this.capturedBytes += packet.body.byteLength;
      this.packets.push({
        sequence: this.packets.length + 1,
        atMs: Math.max(0, Math.round(packet.at - this.startedAtMs)),
        direction: packet.direction,
        opcode: packet.opcode,
        bodyBytes: packet.body.byteLength,
        ...(this.sensitive ? { bodyBase64: bytesToBase64(packet.body) } : {}),
      });
    });
    emitBrowserPortTrace('recorder', 'started', { sensitive: this.sensitive });
    return this.status();
  }

  checkpoint(name: string, state: unknown) {
    if (!this.unsubscribe) throw new Error('recorder is not running');
    const checkpoint = {
      sequence: this.checkpoints.length + 1,
      atMs: Math.max(0, Math.round(performance.now() - this.startedAtMs)),
      name: String(name).slice(0, 120),
      state: serialisable(state),
    };
    this.checkpoints.push(checkpoint);
    emitBrowserPortTrace('recorder', 'checkpoint', { name: checkpoint.name });
    return checkpoint;
  }

  status() {
    return {
      recording: !!this.unsubscribe,
      packets: this.packets.length,
      checkpoints: this.checkpoints.length,
      capturedBytes: this.capturedBytes,
      sensitive: this.sensitive,
      replayable: this.sensitive,
      truncated: this.truncated,
    };
  }

  build(): BrowserPortCapture {
    const browser = typeof window === 'undefined' ? undefined : window;
    return {
      schema: BROWSERPORT_CAPTURE_SCHEMA,
      metadata: {
        label: this.label,
        startedAt: this.startedAtIso,
        endedAt: new Date().toISOString(),
        mode: this.sensitive ? 'replay' : 'headers-only',
        sensitive: this.sensitive,
        userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
        location: browser?.location.href,
        viewport: browser ? {
          width: browser.innerWidth,
          height: browser.innerHeight,
          devicePixelRatio: browser.devicePixelRatio,
        } : undefined,
      },
      packets: this.packets.map((packet) => ({ ...packet })),
      checkpoints: this.checkpoints.map((checkpoint) => ({ ...checkpoint })),
      truncated: this.truncated,
    };
  }

  stop(options: { download?: boolean; redacted?: boolean } = {}) {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const capture = options.redacted ? redactBrowserPortCapture(this.build()) : this.build();
    emitBrowserPortTrace('recorder', 'stopped', { packets: capture.packets.length });
    if (options.download !== false && typeof document !== 'undefined') this.download(capture);
    return capture;
  }

  private download(capture: BrowserPortCapture): void {
    const blob = new Blob([`${JSON.stringify(capture, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `browserport-${Date.now()}.${capture.metadata.sensitive ? 'private.' : ''}bpr.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
