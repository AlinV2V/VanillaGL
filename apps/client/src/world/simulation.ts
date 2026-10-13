/** Offline WebSocket transport used only by the capture/replay harness. */
export type SimulatedSentPacket = { opcode: number; body: Uint8Array; at: number };

export class SimulatedWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  binaryType: 'arraybuffer' | 'blob' = 'arraybuffer';
  readyState = SimulatedWebSocket.OPEN;
  bufferedAmount = 0;
  readonly outbound: Uint8Array[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: never) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener as (event: unknown) => void);
  }

  removeEventListener(type: string, listener: (event: never) => void) {
    this.listeners.get(type)?.delete(listener as (event: unknown) => void);
  }

  send(data: Uint8Array) {
    if (this.readyState !== SimulatedWebSocket.OPEN) throw new Error('simulated socket is not open');
    this.outbound.push(new Uint8Array(data));
  }

  close(code = 1000, reason = 'simulated socket closed') {
    if (this.readyState === SimulatedWebSocket.CLOSED) return;
    this.readyState = SimulatedWebSocket.CLOSED;
    this.emit('close', { code, reason });
  }

  receive(frame: Uint8Array) {
    const buffer = new ArrayBuffer(frame.length);
    new Uint8Array(buffer).set(frame);
    this.emit('message', { data: buffer });
  }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export class SimulatedRealm {
  readonly socket = new SimulatedWebSocket();
  private drained = 0;

  deliver(opcode: number, body = new Uint8Array()) {
    const size = body.length + 2;
    const frame = new Uint8Array(4 + body.length);
    frame[0] = (size >>> 8) & 0xff;
    frame[1] = size & 0xff;
    frame[2] = opcode & 0xff;
    frame[3] = (opcode >>> 8) & 0xff;
    frame.set(body, 4);
    this.socket.receive(frame);
  }

  deliverTorn(opcode: number, body = new Uint8Array(), splitAt = 3) {
    const size = body.length + 2;
    const frame = new Uint8Array(4 + body.length);
    frame[0] = (size >>> 8) & 0xff;
    frame[1] = size & 0xff;
    frame[2] = opcode & 0xff;
    frame[3] = (opcode >>> 8) & 0xff;
    frame.set(body, 4);
    const cut = Math.max(1, Math.min(frame.length - 1, splitAt));
    this.socket.receive(frame.subarray(0, cut));
    this.socket.receive(frame.subarray(cut));
  }

  allSent(): SimulatedSentPacket[] {
    return this.socket.outbound.map((frame, index) => ({
      opcode: frame[2] | (frame[3] << 8) | (frame[4] << 16) | (frame[5] << 24),
      body: frame.subarray(6),
      at: index,
    }));
  }

  drainSent(): SimulatedSentPacket[] {
    const fresh = this.allSent().slice(this.drained);
    this.drained += fresh.length;
    return fresh;
  }
}
