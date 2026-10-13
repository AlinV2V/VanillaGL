export const OUTBOUND_LOW_WATER_BYTES = 512 * 1024;
export const OUTBOUND_HIGH_WATER_BYTES = 8 * 1024 * 1024;
export const OUTBOUND_HIGH_WATER_TIMEOUT_MS = 10_000;

export type OutboundAdmission = 'send' | 'drop-replaceable' | 'disconnect';

/** Bounds browser-owned WebSocket send memory without reordering transactional realm packets. */
export class OutboundBackpressure {
  private highWaterSince: number | undefined;
  private peakBufferedBytes = 0;
  private droppedReplaceablePackets = 0;
  private disconnects = 0;

  admit(bufferedBytes: number, replaceable: boolean, now = performance.now()): OutboundAdmission {
    this.peakBufferedBytes = Math.max(this.peakBufferedBytes, bufferedBytes);
    if (bufferedBytes < OUTBOUND_HIGH_WATER_BYTES) this.highWaterSince = undefined;
    else {
      this.highWaterSince ??= now;
      if (now - this.highWaterSince >= OUTBOUND_HIGH_WATER_TIMEOUT_MS) {
        this.disconnects++;
        return 'disconnect';
      }
    }
    if (replaceable && bufferedBytes >= OUTBOUND_LOW_WATER_BYTES) {
      this.droppedReplaceablePackets++;
      return 'drop-replaceable';
    }
    return 'send';
  }

  diagnostics(bufferedBytes: number, now = performance.now()) {
    return {
      bufferedBytes,
      peakBufferedBytes: Math.max(this.peakBufferedBytes, bufferedBytes),
      droppedReplaceablePackets: this.droppedReplaceablePackets,
      disconnects: this.disconnects,
      highWaterForMs: this.highWaterSince === undefined ? 0 : Math.max(0, now - this.highWaterSince),
      lowWaterBytes: OUTBOUND_LOW_WATER_BYTES,
      highWaterBytes: OUTBOUND_HIGH_WATER_BYTES,
    };
  }
}
