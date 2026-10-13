import { browserPortDiagnosticsEnabled, emitBrowserPortTrace } from './trace-bus';

export type WorldPacketDirection = 'inbound' | 'outbound';

export type ObservedWorldPacket = {
  at: number;
  direction: WorldPacketDirection;
  opcode: number;
  body: Uint8Array;
};

const observers = new Set<(packet: ObservedWorldPacket) => void>();

export function observeWorldPacket(
  direction: WorldPacketDirection,
  opcode: number,
  body: Uint8Array,
): void {
  if (!browserPortDiagnosticsEnabled()) return;
  const at = performance.now();
  emitBrowserPortTrace('protocol', direction, { opcode, bytes: body.byteLength });
  if (!observers.size) return;
  const packet = { at, direction, opcode, body };
  for (const observer of observers) {
    try { observer(packet); } catch { /* an observer cannot break packet processing */ }
  }
}

export function subscribeWorldPackets(listener: (packet: ObservedWorldPacket) => void): () => void {
  observers.add(listener);
  return () => observers.delete(listener);
}
