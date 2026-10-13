export type RuntimeAttributionCategory =
  | 'asset-fetch'
  | 'json-parse'
  | 'binary-decode'
  | 'scheduler'
  | 'shader-prewarm'
  | 'texture-admission'
  | 'world-hydration';

type AttributionAggregate = {
  count: number;
  totalMs: number;
  maxMs: number;
  bytes: number;
  over8Ms: number;
  over16Ms: number;
};

const categoryTotals = new Map<string, AttributionAggregate>();
const labelTotals = new Map<string, AttributionAggregate>();
const MAX_LABELS = 128;

const round = (value: number) => Number(value.toFixed(3));

function normalizedLabel(label: string): string {
  return label
    .replace(/:\d+(?=:|$)/g, ':#')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
}

function addSample(target: AttributionAggregate, durationMs: number, bytes: number): void {
  target.count++;
  target.totalMs += durationMs;
  target.maxMs = Math.max(target.maxMs, durationMs);
  target.bytes += bytes;
  if (durationMs >= 8) target.over8Ms++;
  if (durationMs >= 16) target.over16Ms++;
}

function aggregateFor(map: Map<string, AttributionAggregate>, key: string): AttributionAggregate {
  let aggregate = map.get(key);
  if (!aggregate) {
    aggregate = { count: 0, totalMs: 0, maxMs: 0, bytes: 0, over8Ms: 0, over16Ms: 0 };
    map.set(key, aggregate);
  }
  return aggregate;
}

/**
 * Low-overhead attribution for expensive asynchronous pipeline boundaries. This intentionally
 * stores aggregates, not individual samples, so diagnostics can remain enabled in normal play.
 */
export function recordRuntimeAttribution(
  category: RuntimeAttributionCategory,
  label: string,
  durationMs: number,
  bytes = 0,
): void {
  const safeDuration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const safeBytes = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  addSample(aggregateFor(categoryTotals, category), safeDuration, safeBytes);
  const normalized = `${category}:${normalizedLabel(label)}`;
  if (labelTotals.has(normalized) || labelTotals.size < MAX_LABELS) {
    addSample(aggregateFor(labelTotals, normalized), safeDuration, safeBytes);
  }
}

export function measureRuntimeAttribution<T>(
  category: RuntimeAttributionCategory,
  label: string,
  run: () => T,
  bytes = 0,
): T {
  const started = performance.now();
  try {
    return run();
  } finally {
    recordRuntimeAttribution(category, label, performance.now() - started, bytes);
  }
}

function serialized(aggregate: AttributionAggregate) {
  return {
    count: aggregate.count,
    totalMs: round(aggregate.totalMs),
    maxMs: round(aggregate.maxMs),
    bytes: Math.round(aggregate.bytes),
    over8Ms: aggregate.over8Ms,
    over16Ms: aggregate.over16Ms,
  };
}

export function runtimeAttributionDiagnostics() {
  const categories = Object.fromEntries(
    [...categoryTotals.entries()].map(([key, value]) => [key, serialized(value)]),
  );
  const topOperations = [...labelTotals.entries()]
    .map(([label, value]) => ({ label, ...serialized(value) }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 20);
  return { categories, topOperations, trackedLabels: labelTotals.size, labelLimit: MAX_LABELS };
}

export function resetRuntimeAttribution(): void {
  categoryTotals.clear();
  labelTotals.clear();
}
