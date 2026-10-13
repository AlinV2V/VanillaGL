export type UnknownOpcodeContext = {
  opcode: number;
  name?: string;
  bodySize: number;
  sessionGeneration: number;
  worldGeneration: number;
  compressedParent?: number;
  compressedRecordIndex?: number;
  verbose: boolean;
};

type UnknownOpcodeEntry = {
  count: number;
  lastLoggedAt: number;
  name?: string;
  bodySize: number;
};

export type UnknownOpcodeSnapshot = {
  total: number;
  distinct: number;
  opcodes: Array<{ opcode: number; name?: string; count: number; lastBodySize: number }>;
};

/** Always count unhandled packets; only the URL-gated verbose mode writes console metadata. */
export class UnknownOpcodeTelemetry {
  private readonly entries = new Map<number, UnknownOpcodeEntry>();
  private total = 0;
  private readonly now: () => number;
  private readonly warn: (label: string, detail: Record<string, unknown>) => void;

  constructor(
    now: () => number = () => performance.now(),
    warn: (label: string, detail: Record<string, unknown>) => void = console.warn,
  ) {
    this.now = now;
    this.warn = warn;
  }

  record(context: UnknownOpcodeContext) {
    const previous = this.entries.get(context.opcode) ?? {
      count: 0,
      lastLoggedAt: Number.NEGATIVE_INFINITY,
      bodySize: context.bodySize,
    };
    const count = previous.count + 1;
    this.total++;
    const now = this.now();
    const shouldLog = context.verbose && (
      count === 1 || (count & (count - 1)) === 0 || now - previous.lastLoggedAt >= 10_000
    );
    this.entries.set(context.opcode, {
      count,
      lastLoggedAt: shouldLog ? now : previous.lastLoggedAt,
      name: context.name,
      bodySize: context.bodySize,
    });
    if (!shouldLog) return;
    this.warn('[world] unhandled opcode', {
      opcode: context.opcode,
      opcodeHex: `0x${context.opcode.toString(16).padStart(4, '0')}`,
      name: context.name,
      bodySize: context.bodySize,
      occurrenceCount: count,
      sessionGeneration: context.sessionGeneration,
      worldGeneration: context.worldGeneration,
      compressedParent: context.compressedParent,
      compressedRecordIndex: context.compressedRecordIndex,
    });
  }

  snapshot(): UnknownOpcodeSnapshot {
    const opcodes = [...this.entries].map(([opcode, entry]) => ({
      opcode,
      name: entry.name,
      count: entry.count,
      lastBodySize: entry.bodySize,
    })).sort((a, b) => b.count - a.count || a.opcode - b.opcode);
    return { total: this.total, distinct: opcodes.length, opcodes };
  }
}
