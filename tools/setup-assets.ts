/**
 * Interactive one-command setup for a locally supplied 1.12.1 client.
 *
 * The installer mounts the user's MPQs, derives browser runtime data, bakes the
 * requested playable-world tier and validates the result. Generated output stays
 * local and is ignored by Git.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  symlinkSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { printProgress } from './utils/cli-progress.ts';
import { getBakeJobCount } from './utils/parallel-bake.ts';
import { runTsTool } from './utils/run-ts-tool.ts';
import { ensureAssetTools, type AssetToolName, type ResolvedAssetTool } from './utils/asset-tools.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CACHE_DIR = join(ROOT, '.client-cache');
const DATA_DIR = join(ROOT, 'data');
const DBC_STAGE_DIR = join(DATA_DIR, 'dbcs');
const ADT_SCAN_JSON = join(DATA_DIR, 'starter_adt_tiles_chunks_all.json');
const CLIENT_PUBLIC = join(ROOT, 'apps', 'client', 'public');
const RUNTIME_DATA_DIR = join(CLIENT_PUBLIC, 'data');
const TERRAIN_DIR = join(ROOT, 'apps', 'client', 'public', 'terrain');
const TERRAIN_INDEX = join(TERRAIN_DIR, 'index.json');
const LOGIN_MODEL = join(ROOT, 'apps', 'client', 'public', 'login', 'mainmenu.json');
const CHARACTER_GLUE_MODELS = ['human', 'dwarf', 'nightelf', 'orc', 'scourge', 'tauren']
  .map((race) => join(ROOT, 'apps', 'client', 'public', 'login', 'glue-scenes', race, 'model.json'));
const SKY_DIR = join(ROOT, 'apps', 'client', 'public', 'sky');
const AREA_TRIGGERS = join(TERRAIN_DIR, 'area_triggers.json');
const UI_ROOT = join(ROOT, 'apps', 'client', 'public', 'ui');
const ITEM_ICON_MAP = join(ROOT, 'apps', 'client', 'public', 'items', 'item-display-icons.json');
const SETUP_PROFILE = join(CACHE_DIR, 'setup-profile.json');

const TURNKEY_OUTPUTS: readonly [string, string][] = [
  [join(UI_ROOT, 'Interface', 'Cursor', 'Point.png'), 'UI cursor'],
  [join(UI_ROOT, 'Fonts', 'FRIZQT__.TTF'), 'Friz Quadrata UI font'],
  [join(UI_ROOT, 'Fonts', 'MORPHEUS.TTF'), 'Morpheus UI font'],
  [join(UI_ROOT, 'ui-assets-manifest.json'), 'full UI asset manifest'],
  [ITEM_ICON_MAP, 'item display icon map'],
  [join(ROOT, 'apps', 'client', 'public', 'spells', 'spell-visual-models.json'), 'spell visual model manifest'],
  [join(ROOT, 'apps', 'client', 'public', 'equipment', 'manifest.json'), 'equipment manifest'],
  [join(ROOT, 'apps', 'client', 'public', 'creatures', 'manifest.json'), 'creature manifest'],
  [join(ROOT, 'apps', 'client', 'public', 'gameobjects', 'manifest.json'), 'gameobject manifest'],
  [join(TERRAIN_DIR, 'doodad-anims', 'manifest.json'), 'doodad animation manifest'],
  [join(ROOT, 'apps', 'client', 'public', 'taxi', 'taxi.json'), 'taxi data'],
  [join(TERRAIN_DIR, 'world_map_coords.json'), 'world-map coordinate data'],
  [join(TERRAIN_DIR, 'azeroth_zmp.bin'), 'Azeroth zone-map grid'],
  [join(TERRAIN_DIR, 'kalimdor_zmp.bin'), 'Kalimdor zone-map grid'],
  [join(TERRAIN_DIR, 'area_names.json'), 'area names'],
  [join(TERRAIN_DIR, 'area_parents.json'), 'area parent hierarchy'],
  [join(DATA_DIR, 'minimap_tile_index.json'), 'minimap tile index'],
  [join(ROOT, 'apps', 'client', 'public', 'spells', 'spell-tooltips.json'), 'spell tooltips'],
  [join(ROOT, 'apps', 'client', 'public', 'spells', 'beast-training.json'), 'beast training'],
  [join(ROOT, 'apps', 'client', 'public', 'sounds', 'sound-manifest.json'), 'sound manifest'],
  [join(ROOT, 'apps', 'client', 'public', 'audio', 'theme.mp3'), 'login music'],
];

const REQUIRED_MPQS = [
  'base.MPQ',
  'dbc.MPQ',
  'fonts.MPQ',
  'interface.MPQ',
  'misc.MPQ',
  'model.MPQ',
  'sound.MPQ',
  'speech.MPQ',
  'terrain.MPQ',
  'texture.MPQ',
  'wmo.MPQ',
] as const;
const OPTIONAL_MPQS = ['patch.MPQ', 'patch-2.MPQ', 'patch-3.MPQ', 'patch-4.MPQ'] as const;

type SetupTier = 'starter' | 'level40' | 'full';
type SetupProfile = 'dev' | 'release';
type TextureProfile = 'off' | 'dev' | 'fidelity' | 'compact';
type SetupOptions = {
  clientPath?: string;
  tier: SetupTier;
  profile: SetupProfile;
  textures: TextureProfile;
  jobs: number;
};

function parseSetupOptions(argv: readonly string[]): SetupOptions {
  let clientPath: string | undefined;
  let tier: SetupTier = 'level40';
  let profile: SetupProfile = 'dev';
  let textures: TextureProfile | undefined;

  const takeValue = (arg: string, index: number): { value?: string; consumed: number } => {
    const eq = arg.indexOf('=');
    if (eq >= 0) return { value: arg.slice(eq + 1), consumed: 0 };
    return { value: argv[index + 1], consumed: 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run setup -- [client-path] [--tier starter|level40|full] [--jobs N] [--profile dev|release] [--textures off|dev|fidelity|compact]');
      process.exit(0);
    }
    if (arg === '--tier' || arg.startsWith('--tier=')) {
      const { value, consumed } = takeValue(arg, i); i += consumed;
      if (value !== 'starter' && value !== 'level40' && value !== 'full') throw new Error(`Invalid --tier: ${value ?? '<missing>'}`);
      tier = value;
      continue;
    }
    if (arg === '--profile' || arg.startsWith('--profile=')) {
      const { value, consumed } = takeValue(arg, i); i += consumed;
      if (value !== 'dev' && value !== 'release') throw new Error(`Invalid --profile: ${value ?? '<missing>'}`);
      profile = value;
      continue;
    }
    if (arg === '--textures' || arg.startsWith('--textures=')) {
      const { value, consumed } = takeValue(arg, i); i += consumed;
      if (value !== 'off' && value !== 'dev' && value !== 'fidelity' && value !== 'compact') {
        throw new Error(`Invalid --textures: ${value ?? '<missing>'}`);
      }
      textures = value;
      continue;
    }
    if (arg === '--jobs' || arg.startsWith('--jobs=')) {
      if (arg === '--jobs') i++;
      continue;
    }
    if (!arg.startsWith('--') && !clientPath) clientPath = arg;
  }

  const jobs = getBakeJobCount(process.argv);
  return {
    clientPath,
    tier,
    profile,
    textures: textures ?? (profile === 'release' ? 'fidelity' : 'off'),
    jobs,
  };
}

const setup = parseSetupOptions(process.argv.slice(2));

function findDataDirectory(userPath: string): string | null {
  const clean = userPath.trim().replace(/^["']|["']$/g, '');
  if (!existsSync(clean)) return null;
  const containsMpqs = (dir: string) => existsSync(dir) && readdirSync(dir).some((f) => f.toLowerCase().endsWith('.mpq'));
  if (containsMpqs(clean)) return clean;
  const dataSub = join(clean, 'Data');
  if (containsMpqs(dataSub)) return dataSub;
  const dataLower = join(clean, 'data');
  if (containsMpqs(dataLower)) return dataLower;
  return null;
}

function linkArchives(dataDir: string): { linked: number; missingRequired: string[] } {
  mkdirSync(CACHE_DIR, { recursive: true });
  const existingFiles = readdirSync(dataDir);
  const fileMap = new Map(existingFiles.map((name) => [name.toLowerCase(), name]));
  const wanted = [...REQUIRED_MPQS, ...OPTIONAL_MPQS];
  let linked = 0;
  const missingRequired: string[] = [];

  for (const req of wanted) {
    const actualName = fileMap.get(req.toLowerCase());
    if (!actualName) {
      if ((REQUIRED_MPQS as readonly string[]).includes(req)) missingRequired.push(req);
      continue;
    }
    const src = join(dataDir, actualName);
    const dest = join(CACHE_DIR, req);
    if (!existsSync(dest)) {
      try {
        symlinkSync(src, dest, 'file');
      } catch {
        copyFileSync(src, dest);
      }
    }
    linked++;
  }
  return { linked, missingRequired };
}

type PipelineStep = {
  tool: string;
  desc: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  required?: boolean;
};
type StepTiming = { tool: string; desc: string; ms: number; ok: boolean; required: boolean };
const timings: StepTiming[] = [];
const setupStarted = Date.now();
let assetToolResolutions: Partial<Record<AssetToolName, ResolvedAssetTool>> = {};

const commonToolEnv = (): NodeJS.ProcessEnv => ({
  DATA_SOURCE_DIR: DATA_DIR,
  DBC_SOURCE_DIR: DBC_STAGE_DIR,
  WOW_DBC_ROOT: CACHE_DIR,
  ADT_SCAN_JSON,
  BAKE_JOBS: String(setup.jobs),
  RUNTIME_TERRAIN_DIR: TERRAIN_DIR,
  REQUIRE_ASSET_TOOLS: setup.profile === 'release' ? '1' : '0',
  ...(assetToolResolutions.TOKTX ? { TOKTX: assetToolResolutions.TOKTX.path } : {}),
  ...(assetToolResolutions.CWEBP ? { CWEBP: assetToolResolutions.CWEBP.path } : {}),
  ...(assetToolResolutions.FFMPEG ? { FFMPEG: assetToolResolutions.FFMPEG.path } : {}),
});

function runStep(step: PipelineStep, index: number, total: number): boolean {
  printProgress(index, total, step.desc);
  const started = Date.now();
  const result = runTsTool({
    script: step.tool,
    args: step.args,
    env: { ...commonToolEnv(), ...step.env },
  });
  const ms = Date.now() - started;
  const ok = !result.error && result.status === 0;
  timings.push({ tool: step.tool, desc: step.desc, ms, ok, required: step.required !== false });
  if (result.error) {
    console.error(`\n${step.desc} failed: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) return false;
  printProgress(index + 1, total, `${step.desc} complete`);
  return true;
}

const REQUIRED_RUNTIME_DATA = [
  'world-map.json', 'emotes.json', 'faction-templates.json', 'factions.json',
  'skill-lines.json', 'char-start-outfits.json', 'transport-animations.json',
] as const;
const OPTIONAL_RUNTIME_DATA = ['cinematics.json', 'ship-paths.json'] as const;
const LIQUID_TEXTURE_SEQUENCES = [
  ['river', 'lake_a'], ['ocean', 'ocean_h'], ['lava', 'lava'], ['slime', 'slime'],
] as const;

function validateJsonFile(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

function validateRuntimeData(): string[] {
  console.log('\n----------------------------------------------------------');
  console.log('Validating generated runtime data');
  console.log('----------------------------------------------------------');
  const failures: string[] = [];
  for (const name of REQUIRED_RUNTIME_DATA) {
    const file = join(RUNTIME_DATA_DIR, name);
    if (!existsSync(file)) { failures.push(`${name}: missing`); continue; }
    try {
      const value = validateJsonFile(file);
      if (!value || typeof value !== 'object') throw new Error('root value is not an object');
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const name of OPTIONAL_RUNTIME_DATA) {
    const file = join(RUNTIME_DATA_DIR, name);
    if (!existsSync(file)) continue;
    try { validateJsonFile(file); } catch (error) {
      failures.push(`${name}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (!existsSync(LOGIN_MODEL)) failures.push('login/mainmenu.json: missing');
  for (const model of CHARACTER_GLUE_MODELS) {
    if (!existsSync(model)) failures.push(`login glue scene missing: ${model}`);
  }
  if (!existsSync(AREA_TRIGGERS)) failures.push('terrain/area_triggers.json: missing');
  for (const [file, label] of TURNKEY_OUTPUTS) if (!existsSync(file)) failures.push(`${label}: missing`);

  const uiManifestPath = join(UI_ROOT, 'ui-assets-manifest.json');
  if (existsSync(uiManifestPath)) {
    try {
      const manifest = validateJsonFile(uiManifestPath) as { candidates?: number; converted?: number };
      const candidates = Number(manifest.candidates ?? 0);
      const converted = Number(manifest.converted ?? 0);
      if (candidates < 1000 || converted / Math.max(1, candidates) < 0.98) {
        failures.push(`full UI extraction incomplete: ${converted}/${candidates} converted`);
      }
    } catch (error) {
      failures.push(`full UI asset manifest: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (existsSync(ITEM_ICON_MAP)) {
    try {
      const icons = validateJsonFile(ITEM_ICON_MAP) as Record<string, string>;
      if (!icons || typeof icons !== 'object' || Object.keys(icons).length < 100) failures.push('item display icon map: unexpectedly small');
    } catch (error) {
      failures.push(`item display icon map: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const name of ['sun-center.png', 'sun-glare.png', 'moon.png', 'stars.png', 'stars2.png', 'stars-model.json']) {
    if (!existsSync(join(SKY_DIR, name))) failures.push(`sky/${name}: missing`);
  }
  for (const [directory, base] of LIQUID_TEXTURE_SEQUENCES) {
    const missing = Array.from({ length: 30 }, (_, index) => `${base}.${index + 1}.png`)
      .filter((name) => !existsSync(join(CLIENT_PUBLIC, 'XTextures', directory, name)));
    if (missing.length) failures.push(`XTextures/${directory}: missing ${missing.length}/30 animated liquid frames`);
  }
  return failures;
}

const REQUIRED_TILE_FILES = [
  'heights.f32', 'heights_inner.f32', 'normals.f32', 'ground.png',
  'splat_atlas.png', 'tex_array.png', 'chunk_map.png', 'chunk_map.bin',
  'shadow_atlas.png', 'meta.json', 'doodads.json', 'wmos.meta.json', 'wmos.bin',
  'grass.json', 'surface_map.bin', 'water.json',
] as const;

function validationManifests(tier: SetupTier): readonly string[] {
  if (tier === 'starter') return ['starter-completion.json', 'cities.json'];
  if (tier === 'full') return ['full-world.json'];
  return ['starter-completion.json', 'manifest.json', 'level40-completion.json', 'cities.json'];
}

function validateTerrain(tier: SetupTier): string[] {
  const failures: string[] = [];
  if (!existsSync(TERRAIN_INDEX)) return ['terrain/index.json: missing'];
  let index: Array<{ key?: string }> = [];
  try {
    const parsed = validateJsonFile(TERRAIN_INDEX);
    if (!Array.isArray(parsed)) throw new Error('root value is not an array');
    index = parsed as Array<{ key?: string }>;
  } catch (error) {
    return [`terrain/index.json: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (index.length === 0) failures.push('terrain/index.json: contains no baked tiles');
  const globalCounts = {
    DeeprunTram: index.filter((entry) => entry.key?.startsWith('DeeprunTram_')).length,
    WailingCaverns: index.filter((entry) => entry.key?.startsWith('WailingCaverns_')).length,
  };
  if (globalCounts.DeeprunTram !== 21) failures.push(`Deeprun Tram: expected 21 global-WMO cells, found ${globalCounts.DeeprunTram}`);
  if (globalCounts.WailingCaverns !== 6) failures.push(`Wailing Caverns: expected 6 global-WMO cells, found ${globalCounts.WailingCaverns}`);
  for (const key of ['Azeroth_32_44', 'Azeroth_34_37', 'Kalimdor_32_29', 'Kalimdor_39_43']) {
    if (!index.some((entry) => entry.key === key)) failures.push(`${key}: missing legacy parity ADT`);
  }
  for (const owner of ['DeeprunTram_32_29', 'WailingCaverns_32_32']) {
    const ownerDir = join(TERRAIN_DIR, 'tiles', owner);
    if (!existsSync(join(ownerDir, 'wmos.meta.json')) || !existsSync(join(ownerDir, 'wmos.bin'))) {
      failures.push(`${owner}: missing global WMO owner payload`);
    }
  }

  const requiredKeys = new Set<string>();
  for (const name of validationManifests(tier)) {
    const file = join(TERRAIN_DIR, 'alpha-1', name);
    if (!existsSync(file)) { failures.push(`terrain/alpha-1/${name}: missing`); continue; }
    try {
      const parsed = validateJsonFile(file) as { tiles?: Array<{ key?: string }> };
      for (const tile of parsed.tiles ?? []) if (tile.key) requiredKeys.add(tile.key);
    } catch (error) {
      failures.push(`terrain/alpha-1/${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const starterManifest = join(TERRAIN_DIR, 'starter-zones.json');
  if (!existsSync(starterManifest)) failures.push('terrain/starter-zones.json: missing');
  else {
    try {
      const parsed = validateJsonFile(starterManifest) as { zones?: unknown[] };
      if (!Array.isArray(parsed.zones) || parsed.zones.length < 6) failures.push('terrain/starter-zones.json: expected all six Vanilla starter regions');
    } catch (error) {
      failures.push(`terrain/starter-zones.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const indexedKeys = new Set(index.flatMap((entry) => entry.key ? [entry.key] : []));
  for (const key of requiredKeys) {
    if (!indexedKeys.has(key)) failures.push(`${key}: missing from terrain/index.json`);
    const tileDir = join(TERRAIN_DIR, 'tiles', key);
    const missing = REQUIRED_TILE_FILES.filter((name) => !existsSync(join(tileDir, name)));
    if (missing.length) failures.push(`${key}: missing ${missing.join(', ')}`);
    if (failures.length >= 25) break;
  }
  console.log(`Validated ${requiredKeys.size} required ${tier} tiles (${index.length} indexed).`);
  return failures;
}

function validatePerformanceOutputs(): string[] {
  if (setup.profile !== 'release') return [];
  const failures: string[] = [];
  const required: readonly [string, string][] = [
    [join(RUNTIME_DATA_DIR, 'bvh-assets.json'), 'validated WMO BVH manifest'],
    [join(RUNTIME_DATA_DIR, 'meshopt-assets.json'), 'Meshopt geometry manifest'],
    [join(RUNTIME_DATA_DIR, 'catalogs', 'content-hashes', 'index.json'), 'sharded immutable content hash index'],
    [join(RUNTIME_DATA_DIR, 'catalogs', 'texture-assets', 'index.json'), 'sharded texture asset index'],
    [join(RUNTIME_DATA_DIR, 'compression-assets.json'), 'Brotli compression manifest'],
  ];
  for (const [file, label] of required) {
    if (!existsSync(file)) { failures.push(`${label}: missing`); continue; }
    try { validateJsonFile(file); } catch (error) {
      failures.push(`${label}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return failures;
}

function writeSetupProfile(status: 'complete' | 'failed', validationFailures: readonly string[] = []) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const stages = Object.fromEntries(timings.map((entry) => [entry.tool, entry.ms]));
  const assetReports = Object.fromEntries([
    ['ktx2', join(RUNTIME_DATA_DIR, 'ktx2-manifest.json')],
    ['webp', join(RUNTIME_DATA_DIR, 'webp-manifest.json')],
    ['opus', join(RUNTIME_DATA_DIR, 'audio-assets.json')],
  ].flatMap(([name, file]) => {
    if (!existsSync(file)) return [];
    try {
      const report = validateJsonFile(file) as { tool?: unknown; stats?: unknown; encoded?: number; current?: number; skipped?: number; failed?: number };
      return [[name, {
        tool: report.tool,
        stats: report.stats ?? { encoded: report.encoded ?? 0, current: report.current ?? 0, skipped: report.skipped ?? 0, failed: report.failed ?? 0 },
      }]];
    } catch { return []; }
  }));
  writeFileSync(SETUP_PROFILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    status,
    totalMs: Date.now() - setupStarted,
    tier: setup.tier,
    profile: setup.profile,
    textures: setup.textures,
    jobs: setup.jobs,
    stages,
    steps: timings,
    assetTools: assetReports,
    assetToolResolutions,
    validationFailures,
  }, null, 2));
}

function terrainPipeline(): PipelineStep[] {
  const scan: PipelineStep = { tool: 'tools/probes/scan_adt_chunks_all.ts', desc: 'Scanning Vanilla ADTs for playable-zone coverage' };
  if (setup.tier === 'starter') {
    return [
      scan,
      { tool: 'tools/bakers/bake-starter-completion.ts', args: ['--bake'], desc: 'Baking all six starter regions' },
      { tool: 'tools/bakers/bake-alpha-cities.ts', args: ['--bake'], env: { BAKE_SKIP_CORE_VALIDATION: '1' }, desc: 'Baking capital-city coverage for starter flows' },
    ];
  }
  if (setup.tier === 'full') {
    return [
      scan,
      { tool: 'tools/bakers/bake-starter-completion.ts', desc: 'Building starter-zone coverage metadata' },
      { tool: 'tools/bakers/bake-full-world.ts', args: ['--bake'], desc: 'Baking all Azeroth and Kalimdor ADTs' },
    ];
  }
  return [
    scan,
    { tool: 'tools/bakers/bake-starter-completion.ts', args: ['--bake'], desc: 'Baking all six starter regions' },
    { tool: 'tools/bakers/bake-alpha-1.ts', args: ['--bake'], desc: 'Baking the core level 1-40 world set' },
    { tool: 'tools/bakers/bake-level40-completion.ts', args: ['--bake'], desc: 'Completing level 1-40 zone coverage' },
    { tool: 'tools/bakers/bake-alpha-cities.ts', args: ['--bake'], desc: 'Baking Stormwind, Ironforge, Orgrimmar and capital-city coverage' },
  ];
}

async function main() {
  console.log('\n==========================================================');
  console.log('VanillaGL — Local Client Setup & Playable World Baker');
  console.log('==========================================================');
  console.log(`tier=${setup.tier}  profile=${setup.profile}  jobs=${setup.jobs}  textures=${setup.textures}\n`);

  let dataDir: string | null = setup.clientPath ? findDataDirectory(setup.clientPath) : null;
  if (!dataDir) {
    const rl = createInterface({ input, output });
    console.log('Enter the path to your locally installed 1.12.1 client directory.');
    console.log('You can also drag the folder into this terminal.\n');
    const answer = await rl.question('Client directory: ');
    rl.close();
    dataDir = findDataDirectory(answer);
  }
  if (!dataDir) {
    console.error('\nCould not find MPQ archives in the provided directory.');
    writeSetupProfile('failed', ['client data directory not found']);
    process.exit(1);
  }

  console.log(`\nFound client data folder: ${dataDir}`);
  const { linked, missingRequired } = linkArchives(dataDir);
  console.log(`Mounted ${linked} local archives into .client-cache/`);
  if (missingRequired.length) {
    console.error(`\nMissing required archives: ${missingRequired.join(', ')}`);
    writeSetupProfile('failed', missingRequired.map((name) => `missing archive: ${name}`));
    process.exit(1);
  }

  if (setup.profile === 'release') {
    console.log('\nResolving checksum-pinned release asset tools...');
    assetToolResolutions = await ensureAssetTools({ installMissing: true, preferPortable: true });
    for (const [name, tool] of Object.entries(assetToolResolutions)) {
      console.log(`  ${name}: ${tool.path} (${tool.source}; ${tool.version})`);
    }
  }

  mkdirSync(DBC_STAGE_DIR, { recursive: true });
  mkdirSync(TERRAIN_DIR, { recursive: true });

  const formatPipeline: PipelineStep[] = setup.textures === 'off' ? [] : [
    {
      tool: 'tools/bakers/bake-ktx2.ts',
      args: ['--profile', setup.textures],
      desc: `Encoding GPU textures (${setup.textures})`,
      required: setup.profile === 'release',
    },
    {
      tool: 'tools/bakers/repair-ktx2-fallbacks.ts',
      desc: 'Deriving browser-image fallbacks for KTX2-only legacy assets',
      required: setup.profile === 'release',
    },
    {
      tool: 'tools/bakers/bake-webp.ts',
      desc: 'Encoding browser UI/Canvas images (lossless WebP)',
      required: setup.profile === 'release',
    },
  ];

  const performancePipeline: PipelineStep[] = setup.profile === 'release' ? [
    {
      tool: 'tools/bakers/bake-wmo-bvh.ts',
      desc: 'Serializing and validating WMO collision trees',
    },
    {
      tool: 'tools/bakers/bake-meshopt.ts',
      args: ['--profile', 'balanced'],
      desc: 'Encoding typed Meshopt geometry streams and LOD indices',
    },
    ...formatPipeline,
    {
      tool: 'tools/bakers/bake-opus.ts',
      desc: 'Encoding browser audio delivery as Ogg Opus',
    },
    {
      tool: 'tools/bakers/bake-content-hashes.ts',
      desc: 'Hashing immutable runtime content identities',
    },
    {
      tool: 'tools/bakers/shard-runtime-catalogs.ts',
      desc: 'Sharding bootstrap catalogs for path-scoped lazy loading',
    },
    {
      tool: 'tools/bakers/bake-brotli.ts',
      desc: 'Precompressing transferable text and binary assets with Brotli',
    },
  ] : formatPipeline;

  const pipeline: PipelineStep[] = [
    { tool: 'tools/bakers/prepare-runtime-dbcs.ts', desc: 'Staging runtime DBC metadata' },
    { tool: 'tools/extractors/extract-framexml-1121.ts', desc: 'Extracting patch-correct FrameXML and Blizzard UI definitions' },
    { tool: 'tools/extractors/extract-ui-assets.ts', desc: 'Extracting all 2D Interface artwork and icons' },
    { tool: 'tools/bakers/build-item-display-icon-map.mjs', desc: 'Building item display-to-icon lookup' },
    { tool: 'tools/bakers/bake-char-start-outfits.ts', desc: 'Baking character creation outfits' },
    { tool: 'tools/bakers/bake-factions.ts', desc: 'Baking faction/reputation metadata' },
    { tool: 'tools/bakers/bake-skill-lines.ts', desc: 'Baking skill/category metadata' },
    { tool: 'tools/bakers/bake-faction-reaction.ts', desc: 'Baking faction reaction templates' },
    { tool: 'tools/bakers/bake-emotes.ts', desc: 'Baking character emotes' },
    { tool: 'tools/bakers/bake-world-map.ts', desc: 'Baking world-map and zone metadata' },
    { tool: 'tools/extractors/extract_map_data.ts', desc: 'Generating world-map coordinates and minimap index' },
    { tool: 'tools/utils/fetch-alpha-readiness-source.mjs', desc: 'Fetching the official vMaNGOS quest-data snapshot' },
    { tool: 'tools/bakers/bake-questie-lite.ts', desc: 'Baking lazy native Questie-lite map shards' },
    { tool: 'tools/extractors/parse_zmps.ts', desc: 'Extracting continent zone-map grids' },
    { tool: 'tools/bakers/bake-area-names.ts', desc: 'Baking area names and parent hierarchy' },
    { tool: 'tools/bakers/bake-transport-animations.ts', desc: 'Baking transport animation metadata' },
    { tool: 'tools/bakers/bake-mainmenu.ts', desc: 'Extracting and baking the 3D login scene' },
    { tool: 'tools/bakers/bake-sounds.ts', desc: 'Extracting sound.MPQ/speech.MPQ audio and building the sound manifest' },
    { tool: 'tools/bakers/bake-lighting.ts', desc: 'Baking world lighting and sky tables' },
    { tool: 'tools/bakers/bake-celestial-textures.ts', desc: 'Baking sun, moon and authored star assets' },
    { tool: 'tools/bakers/bake-area-triggers.ts', desc: 'Baking area-trigger world metadata' },
    { tool: 'tools/bakers/bake-cinematics.ts', desc: 'Baking cinematic camera metadata' },
    { tool: 'tools/bakers/bake-weather-textures.ts', desc: 'Baking weather textures and particles', required: false },
    { tool: 'tools/bakers/bake-character-models.ts', desc: 'Baking player character models' },
    { tool: 'tools/bakers/bake-equipment.ts', env: { DISPLAY_IDS: 'all' }, desc: 'Baking all equipment, armor and weapon display assets' },
    { tool: 'tools/bakers/bake-creature-assets.ts', env: { DISPLAY_IDS: 'all' }, desc: 'Baking all creature and NPC display assets' },
    { tool: 'tools/bakers/bake-creature-portrait-cameras.ts', desc: 'Baking portrait cameras' },
    { tool: 'tools/bakers/bake-gameobject-assets.ts', env: { DISPLAY_IDS: 'all' }, desc: 'Baking all game-object display assets' },
    { tool: 'tools/bakers/bake-spells.ts', desc: 'Baking spell data and icons' },
    { tool: 'tools/bakers/bake-spell-tooltips.ts', desc: 'Baking spell tooltip formulas and text' },
    { tool: 'tools/bakers/bake-beast-training.ts', desc: 'Baking Hunter beast-training recipes and icons' },
    { tool: 'tools/bakers/bake-spell-visuals.ts', desc: 'Baking spell visual metadata and missile manifest' },
    { tool: 'tools/bakers/bake-spell-models.ts', desc: 'Baking spell missile and impact models' },
    { tool: 'tools/bakers/bake-talents.ts', desc: 'Baking talent-tree data' },
    { tool: 'tools/bakers/bake-minimap.ts', desc: 'Baking minimap tiles' },
    { tool: 'tools/extractors/convert-liquids.ts', desc: 'Extracting animated Vanilla liquid texture frames' },
    ...terrainPipeline(),
    { tool: 'tools/bakers/bake-legacy-gap-tiles.ts', desc: 'Restoring the 4 ordinary ADTs retained by the legacy verifier' },
    { tool: 'tools/bakers/bake-global-deeprun.ts', desc: 'Restoring all 21 Deeprun Tram global-WMO streaming cells' },
    { tool: 'tools/bakers/bake-global-wailing.ts', desc: 'Restoring all 6 Wailing Caverns global-WMO streaming cells' },
    { tool: 'tools/bakers/bake-global-instances.ts', desc: 'Baking global-WMO dungeons (Stockade, Blackfathom, Uldaman, Gnomeregan, Ragefire, Onyxia)', required: false },
    { tool: 'tools/bakers/bake-water.ts', desc: 'Verifying water across all baked terrain' },
    { tool: 'tools/bakers/bake-doodad-skeletons.ts', desc: 'Baking shared animated doodad skeletons' },
    { tool: 'tools/bakers/bake-taxi.ts', desc: 'Baking taxi nodes and routes for baked world coverage' },
    { tool: 'tools/bakers/bake-ship-paths.ts', desc: 'Baking ship transport paths', required: false },
    ...performancePipeline,
    { tool: 'tools/quality/report-assets.ts', desc: 'Reporting final generated asset corpus size' },
  ];

  const optionalFailures: string[] = [];
  for (let index = 0; index < pipeline.length; index++) {
    const step = pipeline[index];
    const ok = runStep(step, index, pipeline.length);
    if (ok) continue;
    if (step.required === false) {
      optionalFailures.push(step.tool);
      console.warn(`Optional step did not complete: ${step.tool}`);
      continue;
    }
    console.error(`\nRequired setup step failed: ${step.tool}`);
    console.error('Setup stopped; fix the reported baker error and rerun npm run setup. Completed outputs are reused.');
    writeSetupProfile('failed', [`required setup step failed: ${step.tool}`]);
    process.exit(1);
  }

  const failures = [...validateRuntimeData(), ...validateTerrain(setup.tier), ...validatePerformanceOutputs()];
  if (failures.length) {
    console.error('\nSetup validation failed:');
    for (const failure of failures.slice(0, 25)) console.error(`  - ${failure}`);
    if (failures.length > 25) console.error(`  ...and ${failures.length - 25} more`);
    writeSetupProfile('failed', failures);
    process.exit(1);
  }

  writeSetupProfile('complete');
  console.log('\n==========================================================');
  console.log('VanillaGL local setup complete.');
  console.log(`World tier:          ${setup.tier}`);
  console.log(`Bake workers:        ${setup.jobs}`);
  console.log(`Texture profile:     ${setup.textures}`);
  console.log(`Performance stack:   ${setup.profile === 'release' ? 'optimized release sidecars' : 'development/source fallbacks'}`);
  console.log('Runtime metadata:    OK');
  console.log('3D login scene:      OK');
  console.log('Playable terrain:    OK');
  console.log('Setup profile:       .client-cache/setup-profile.json');
  console.log('Asset report:        .client-cache/asset-report.json');
  if (optionalFailures.length) console.log(`Optional non-blocking steps: ${optionalFailures.join(', ')}`);
  console.log('==========================================================\n');
  console.log(`Start the game:             ${process.platform === 'win32' ? 'Play.bat' : './play.sh'} (or npm run play)`);
  console.log('Or separately:              npm run proxy, then npm run dev');
  console.log('Production asset server:    npm run assets:serve\n');
}

main().catch((error) => {
  console.error('\nFatal setup error:', error);
  writeSetupProfile('failed', [error instanceof Error ? error.message : String(error)]);
  process.exit(1);
});
