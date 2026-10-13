export type BrowserPortTraceDetail = Record<string, unknown>;

export type BrowserPortTraceEvent = {
  id: number;
  at: number;
  domain: string;
  name: string;
  parentId?: number;
  detail?: BrowserPortTraceDetail;
};

export type BrowserPortTraceFilter = {
  domain?: string;
  name?: string;
  sinceId?: number;
  limit?: number;
};

const TRACE_LIMIT = 2048;
const traceEvents: BrowserPortTraceEvent[] = [];
const subscribers = new Set<(event: BrowserPortTraceEvent) => void>();
let enabled = false;
let nextId = 1;

export function setBrowserPortDiagnosticsEnabled(value: boolean): void {
  enabled = value;
  if (!value) {
    traceEvents.length = 0;
    subscribers.clear();
  }
}

export function browserPortDiagnosticsEnabled(): boolean {
  return enabled;
}

export function emitBrowserPortTrace(
  domain: string,
  name: string,
  detail?: BrowserPortTraceDetail,
  parentId?: number,
): number | undefined {
  if (!enabled) return undefined;
  const event: BrowserPortTraceEvent = {
    id: nextId++,
    at: performance.now(),
    domain,
    name,
    ...(parentId === undefined ? {} : { parentId }),
    ...(detail === undefined ? {} : { detail }),
  };
  traceEvents.push(event);
  if (traceEvents.length > TRACE_LIMIT) traceEvents.splice(0, traceEvents.length - TRACE_LIMIT);
  for (const subscriber of subscribers) {
    try { subscriber(event); } catch { /* diagnostics must never affect the client */ }
  }
  return event.id;
}

export function browserPortTraceSnapshot(filter: BrowserPortTraceFilter = {}): BrowserPortTraceEvent[] {
  const limit = Math.max(1, Math.min(TRACE_LIMIT, Math.floor(filter.limit ?? 200)));
  return traceEvents
    .filter((event) => (
      (filter.domain === undefined || event.domain === filter.domain)
      && (filter.name === undefined || event.name === filter.name)
      && (filter.sinceId === undefined || event.id > filter.sinceId)
    ))
    .slice(-limit)
    .map((event) => ({ ...event, detail: event.detail ? { ...event.detail } : undefined }));
}

export function clearBrowserPortTrace(): void {
  traceEvents.length = 0;
}

export function subscribeBrowserPortTrace(listener: (event: BrowserPortTraceEvent) => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}
