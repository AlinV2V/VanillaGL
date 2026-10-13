import { createRequire } from 'node:module';
import { validateMeshoptCodec, type MeshoptCodecProvenance } from '../../apps/client/src/assets/meshopt-codec-contract';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { getBakeJobCount, runPool, runTsToolAsync } from '../utils/parallel-bake.ts';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PUBLIC = join(ROOT, 'apps', 'client', 'public');
const DATA = join(PUBLIC, 'data');
const MANIFEST = join(DATA, 'meshopt-assets.json');
const MIN_JSON_BYTES = Number(process.env.MESHOPT_MIN_JSON_BYTES || 16 * 1024);
const MIN_STREAM_BYTES = Number(process.env.MESHOPT_MIN_STREAM_BYTES || 2048);
const WORKER_FLAG = '--worker';
const encoderVersion: string = JSON.parse(readFileSync(join(dirname(createRequire(import.meta.url).resolve('meshoptimizer')), 'package.json'), 'utf8')).version;

type Profile = 'lossless' | 'balanced' | 'compact';
type Component = 'f32' | 'u32' | 'u16' | 'u8';
type StreamRef = {
  $vgl: 'meshopt';
  codecVersion: number;
  offset: number;
  byteLength: number;
  count: number;
  stride: number;
  components: number;
  component: Component;
  mode: 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES';
  filter?: 'EXPONENTIAL';
  asArray?: boolean;
};
type AssetReport = {
  codec: MeshoptCodecProvenance;
  source: string;
  meta: string;
  binary: string;
  sourceBytes: number;
  metaBytes: number;
  optimizedBytes: number;
  streams: number;
  lods: number;
};

function argValue(name: string): string | undefined {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const requestedProfile = (argValue('--profile') ?? process.env.MESHOPT_PROFILE ?? 'balanced').toLowerCase();
const profile: Profile = requestedProfile === 'lossless' || requestedProfile === 'compact' ? requestedProfile : 'balanced';
const requestedPrefix = argValue('--path-prefix');

function logical(file: string): string {
  return `/${relative(PUBLIC, file).replaceAll('\\', '/')}`;
}

function sidecarPaths(source: string) {
  const stem = source.replace(/\.json$/i, '');
  return { meta: `${stem}.meshopt.json`, binary: `${stem}.meshopt.bin`, report: `${stem}.meshopt.report.json` };
}

function walk(dir: string, out: string[]) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, out); continue; }
    if (extname(entry.name).toLowerCase() !== '.json') continue;
    if (/\.meshopt(?:\.report)?\.json$/i.test(entry.name)) continue;
    if (full.startsWith(DATA) && entry.name.endsWith('-assets.json')) continue;
    const stat = statSync(full);
    if (stat.size < MIN_JSON_BYTES) continue;
    const probe = readFileSync(full, 'utf8').slice(0, Math.min(stat.size, 256 * 1024));
    if (/"(?:positions|normals|uvs|indices|boneWeights|boneIndices)"\s*:/.test(probe)) out.push(full);
  }
}

function fieldSpec(key: string, values: number[]): { component: Component; components: number; mode: StreamRef['mode']; asArray?: boolean } | null {
  if (key === 'positions' || key === 'normals') return { component: 'f32', components: 3, mode: 'ATTRIBUTES' };
  if (key === 'uvs') return { component: 'f32', components: 2, mode: 'ATTRIBUTES' };
  if (key === 'boneWeights' || key === 'boneIndices') {
    const integerByte = values.every((value) => Number.isInteger(value) && value >= 0 && value <= 255);
    return { component: integerByte ? 'u8' : 'f32', components: 4, mode: 'ATTRIBUTES' };
  }
  if (key === 'indices' || key === 'collisionIndices') return { component: 'u32', components: 1, mode: 'TRIANGLES', asArray: true };
  return null;
}

function componentWidth(component: Component) {
  if (component === 'u8') return 1;
  if (component === 'u16') return 2;
  return 4;
}

function numericBytes(values: number[], component: Component): Uint8Array {
  let view: Uint8Array;
  if (component === 'f32') view = new Uint8Array(Float32Array.from(values).buffer);
  else if (component === 'u32') view = new Uint8Array(Uint32Array.from(values).buffer);
  else if (component === 'u16') view = new Uint8Array(Uint16Array.from(values).buffer);
  else view = Uint8Array.from(values);
  return view;
}

function padAttribute(source: Uint8Array, count: number, packedStride: number): { bytes: Uint8Array; stride: number } {
  const stride = Math.max(4, Math.ceil(packedStride / 4) * 4);
  if (stride === packedStride) return { bytes: source, stride };
  const padded = new Uint8Array(count * stride);
  for (let i = 0; i < count; i++) padded.set(source.subarray(i * packedStride, i * packedStride + packedStride), i * stride);
  return { bytes: padded, stride };
}

function appendChunk(chunks: Uint8Array[], chunk: Uint8Array, offset: number) {
  chunks.push(chunk);
  return { offset, nextOffset: offset + chunk.byteLength };
}

function makeLods(node: Record<string, unknown>): number {
  const positions = Array.isArray(node.positions) ? node.positions as number[] : null;
  const parts = Array.isArray(node.parts) ? node.parts as Array<Record<string, unknown>> : null;
  if (!positions?.length || !parts?.length || positions.length % 3 !== 0) return 0;
  const pos = Float32Array.from(positions);
  let generated = 0;

  for (const part of parts) {
    const source = Array.isArray(part.indices) ? part.indices as number[] : null;
    if (!source || source.length < 96 || source.length % 3 !== 0) continue;
    const indices = Uint32Array.from(source);
    const lods: Array<{ ratio: number; error: number; indices: number[] }> = [];
    for (const target of [
      { ratio: 0.5, error: 0.01 },
      { ratio: 0.2, error: 0.03 },
    ]) {
      const targetCount = Math.max(3, Math.floor(indices.length * target.ratio / 3) * 3);
      const [simplified, resultError] = MeshoptSimplifier.simplify(indices, pos, 3, targetCount, target.error);
      if (simplified.length >= indices.length * 0.9 || simplified.length < 3) continue;
      lods.push({ ratio: simplified.length / indices.length, error: resultError, indices: Array.from(simplified) });
      generated++;
    }
    if (lods.length) part.lods = lods;
  }
  return generated;
}

async function encodeOne(source: string): Promise<AssetReport | null> {
  await MeshoptEncoder.ready;
  const text = readFileSync(source, 'utf8');
  const root = JSON.parse(text) as unknown;
  let lods = 0;

  const addLods = (value: unknown) => {
    if (Array.isArray(value)) { for (const item of value) addLods(item); return; }
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    lods += makeLods(object);
    for (const child of Object.values(object)) addLods(child);
  };
  if (profile !== 'lossless') addLods(root);

  const chunks: Uint8Array[] = [];
  let offset = 0;
  let streams = 0;
  const vertexVersions = new Set<number>(), indexVersions = new Set<number>();

  const transform = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) {
      const numeric = value.length > 0 && value.every((item) => typeof item === 'number' && Number.isFinite(item));
      const spec = numeric ? fieldSpec(key, value as number[]) : null;
      if (spec && value.length * componentWidth(spec.component) >= MIN_STREAM_BYTES && value.length % spec.components === 0) {
        const values = value as number[];
        const count = values.length / spec.components;
        const width = componentWidth(spec.component);
        const packedStride = width * spec.components;
        let raw = numericBytes(values, spec.component);
        let stride = packedStride;
        let filter: StreamRef['filter'];

        if (spec.mode === 'ATTRIBUTES') {
          if (spec.component === 'f32' && profile !== 'lossless') {
            const bits = key === 'positions' ? (profile === 'compact' ? 16 : 20) : (profile === 'compact' ? 14 : 18);
            raw = MeshoptEncoder.encodeFilterExp(Float32Array.from(values), count, packedStride, bits);
            stride = packedStride;
            filter = 'EXPONENTIAL';
          }
          const padded = padAttribute(raw, count, stride);
          raw = padded.bytes;
          stride = padded.stride;
        }

        let encoded: Uint8Array;
        let mode = spec.mode;
        if (mode === 'TRIANGLES' && count % 3 !== 0) mode = 'INDICES';
        if (mode === 'TRIANGLES' && stride !== 2 && stride !== 4) mode = 'INDICES';
        if (mode === 'TRIANGLES') encoded = MeshoptEncoder.encodeIndexBuffer(raw, count, stride);
        else if (mode === 'INDICES') encoded = MeshoptEncoder.encodeIndexSequence(raw, count, stride);
        else encoded = MeshoptEncoder.encodeVertexBuffer(raw, count, stride);

        validateMeshoptCodec(mode, encoded);
        const codecVersion = encoded[0] & 15;
        (mode === 'ATTRIBUTES' ? vertexVersions : indexVersions).add(codecVersion);
        const placed = appendChunk(chunks, encoded, offset);
        const ref: StreamRef = {
          $vgl: 'meshopt', codecVersion,
          offset: placed.offset,
          byteLength: encoded.byteLength,
          count,
          stride,
          components: spec.components,
          component: spec.component,
          mode,
          ...(filter ? { filter } : {}),
          ...(spec.asArray ? { asArray: true } : {}),
        };
        offset = placed.nextOffset;
        streams++;
        return ref;
      }
      return value.map((item) => transform(item));
    }
    if (!value || typeof value !== 'object') return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(object).map(([childKey, child]) => [childKey, transform(child, childKey)]));
  };

  const meta = transform(root);
  if (!streams) return null;
  const paths = sidecarPaths(source);
  mkdirSync(dirname(paths.meta), { recursive: true });
  const binary = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), offset);
  const metaText = JSON.stringify(meta);
  writeFileSync(paths.meta, metaText);
  writeFileSync(paths.binary, binary);

  const report: AssetReport = {
    codec: { encoderVersion, vertexVersions: [...vertexVersions].sort(), indexVersions: [...indexVersions].sort() },
    source: logical(source),
    meta: logical(paths.meta),
    binary: logical(paths.binary),
    sourceBytes: Buffer.byteLength(text),
    metaBytes: Buffer.byteLength(metaText),
    optimizedBytes: Buffer.byteLength(metaText) + binary.byteLength,
    streams,
    lods,
  };
  writeFileSync(paths.report, JSON.stringify(report));
  return report;
}

async function workerMain(file: string) {
  await Promise.all([MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  const report = await encodeOne(resolve(file));
  if (report) console.log(`[meshopt] ${relative(PUBLIC, resolve(file))}: ${report.streams} streams, ${report.lods} LODs`);
}

async function parentMain() {
  const candidates: string[] = [];
  walk(PUBLIC, candidates);
  if (requestedPrefix) {
    const logicalPrefix = requestedPrefix.startsWith('/') ? requestedPrefix : `/${requestedPrefix}`;
    const matching = candidates.filter((file) => logical(file).startsWith(logicalPrefix));
    candidates.splice(0, candidates.length, ...matching);
  }
  const jobs = Math.max(1, getBakeJobCount());
  console.log(`[meshopt] profile=${profile}, candidates=${candidates.length}, jobs=${jobs}`);

  await runPool(candidates, async (file) => {
    await runTsToolAsync({
      script: 'tools/bakers/bake-meshopt.ts',
      args: [WORKER_FLAG, file, '--profile', profile],
      label: `meshopt ${relative(PUBLIC, file)}`,
    });
  }, {
    jobs,
    onComplete: (done, total) => { if (done === total || done % 25 === 0) console.log(`[meshopt] ${done}/${total}`); },
  });

  const reports: AssetReport[] = [];
  for (const source of candidates) {
    const path = sidecarPaths(source).report;
    if (!existsSync(path)) continue;
    try { reports.push(JSON.parse(readFileSync(path, 'utf8')) as AssetReport); } catch { /* ignore incomplete sidecar */ }
  }
  let assets: Record<string, Omit<AssetReport, 'source' | 'metaBytes'>> = {};
  if (requestedPrefix && existsSync(MANIFEST)) {
    try {
      const prior = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { assets?: typeof assets };
      assets = { ...(prior.assets ?? {}) };
    } catch {
      // Replace a malformed prior manifest rather than preserving invalid data.
    }
    const logicalPrefix = requestedPrefix.startsWith('/') ? requestedPrefix : `/${requestedPrefix}`;
    for (const source of Object.keys(assets)) {
      if (source.startsWith(logicalPrefix)) delete assets[source];
    }
  }
  for (const report of reports) {
    assets[report.source] = {
      codec: report.codec,
      meta: report.meta,
      binary: report.binary,
      sourceBytes: report.sourceBytes,
      optimizedBytes: report.optimizedBytes,
      streams: report.streams,
      lods: report.lods,
    };
  }
  const allReports = Object.values(assets);
  mkdirSync(DATA, { recursive: true });
  writeFileSync(MANIFEST, `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    profile,
    jobs,
    assets,
    totals: {
      assets: allReports.length,
      streams: allReports.reduce((sum, item) => sum + item.streams, 0),
      lods: allReports.reduce((sum, item) => sum + item.lods, 0),
      sourceBytes: allReports.reduce((sum, item) => sum + item.sourceBytes, 0),
      optimizedBytes: allReports.reduce((sum, item) => sum + item.optimizedBytes, 0),
    },
  })}\n`);
  const sourceBytes = allReports.reduce((sum, item) => sum + item.sourceBytes, 0);
  const optimizedBytes = allReports.reduce((sum, item) => sum + item.optimizedBytes, 0);
  const reduction = sourceBytes ? (1 - optimizedBytes / sourceBytes) * 100 : 0;
  console.log(`[meshopt] ${allReports.length} cataloged assets, ${reduction.toFixed(1)}% sidecar reduction before Brotli.`);
}

const workerIndex = process.argv.indexOf(WORKER_FLAG);
if (workerIndex >= 0) await workerMain(process.argv[workerIndex + 1]);
else await parentMain();
