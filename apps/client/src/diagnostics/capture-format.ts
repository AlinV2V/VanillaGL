export const BROWSERPORT_CAPTURE_SCHEMA = 'browserport.capture/v2' as const;

export type BrowserPortCapturePacket = {
  sequence: number;
  atMs: number;
  direction: 'inbound' | 'outbound';
  opcode: number;
  bodyBase64?: string;
  bodyBytes: number;
};

export type BrowserPortCheckpoint = {
  sequence: number;
  atMs: number;
  name: string;
  state: unknown;
};

export type BrowserPortCapture = {
  schema: typeof BROWSERPORT_CAPTURE_SCHEMA;
  metadata: {
    label: string;
    startedAt: string;
    endedAt: string;
    mode: 'replay' | 'headers-only';
    sensitive: boolean;
    userAgent?: string;
    location?: string;
    viewport?: { width: number; height: number; devicePixelRatio: number };
  };
  packets: BrowserPortCapturePacket[];
  checkpoints: BrowserPortCheckpoint[];
  truncated: boolean;
};

export function redactBrowserPortCapture(capture: BrowserPortCapture): BrowserPortCapture {
  return {
    ...capture,
    metadata: {
      ...capture.metadata,
      label: 'redacted capture',
      mode: 'headers-only',
      sensitive: false,
      location: undefined,
    },
    packets: capture.packets.map(({ bodyBase64: _body, ...packet }) => packet),
    checkpoints: capture.checkpoints.map((checkpoint) => ({
      ...checkpoint,
      state: '[redacted]',
    })),
  };
}

export function validateBrowserPortCapture(value: unknown): BrowserPortCapture {
  if (!value || typeof value !== 'object') throw new Error('capture must be an object');
  const capture = value as Partial<BrowserPortCapture>;
  if (capture.schema !== BROWSERPORT_CAPTURE_SCHEMA) {
    throw new Error(`unsupported capture schema: ${String(capture.schema)}`);
  }
  if (!Array.isArray(capture.packets) || !Array.isArray(capture.checkpoints)) {
    throw new Error('capture packets/checkpoints must be arrays');
  }
  return capture as BrowserPortCapture;
}
