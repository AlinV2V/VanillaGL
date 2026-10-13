/** Resolve and checksum-install the release asset encoders used by setup and standalone bakers. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { basename, delimiter, extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export type AssetToolName = 'TOKTX' | 'CWEBP' | 'FFMPEG';
type Artifact = {
  version: string;
  url: string;
  sha256: string;
  format: 'archive' | 'gzip' | 'nsis' | 'pkg';
  binary: string;
  companions?: string[];
  versionArgs: string[];
};
type Manifest = {
  schema: string;
  platforms: Record<string, Record<AssetToolName, Artifact>>;
};
export type ResolvedAssetTool = {
  name: AssetToolName;
  path: string;
  version: string;
  source: 'environment' | 'portable' | 'path';
  platform: string;
};

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BIN_ROOT = resolve(process.env.VGL_ASSET_TOOL_BIN_ROOT || join(ROOT, 'tools', 'bin'));
const MANIFEST_PATH = resolve(process.env.VGL_ASSET_TOOL_MANIFEST || join(ROOT, 'tools', 'bin', 'asset-tools.json'));
const TOOL_NAMES: AssetToolName[] = ['TOKTX', 'CWEBP', 'FFMPEG'];
const DEFAULT_COMMANDS: Record<AssetToolName, string> = { TOKTX: 'toktx', CWEBP: 'cwebp', FFMPEG: 'ffmpeg' };

export function assetPlatformKey(platform = process.platform, architecture = process.arch): string {
  if (platform === 'win32') return 'win32-x64';
  if ((platform === 'darwin' || platform === 'linux') && (architecture === 'x64' || architecture === 'arm64')) return `${platform}-${architecture}`;
  return `${platform}-${architecture}`;
}

export function readAssetToolManifest(path = MANIFEST_PATH): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyArtifactBytes(bytes: Uint8Array, expectedSha256: string, label = 'download'): void {
  const actual = sha256(bytes);
  if (actual !== expectedSha256) throw new Error(`${label}: SHA-256 mismatch; expected ${expectedSha256}, got ${actual}`);
}

function artifactFor(name: AssetToolName, platform = assetPlatformKey()): Artifact {
  const manifest = readAssetToolManifest();
  const artifact = manifest.platforms[platform]?.[name];
  if (!artifact) throw new Error(`${name}: no pinned portable artifact for ${platform}`);
  if (!/^https:\/\//.test(artifact.url)) throw new Error(`${name}: portable artifact URL must use HTTPS`);
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error(`${name}: portable artifact has no valid SHA-256`);
  return artifact;
}

function installDir(name: AssetToolName, platform = assetPlatformKey()): string {
  return join(BIN_ROOT, platform, name.toLowerCase());
}

function findOnPath(command: string): string | null {
  if (command.includes('/') || command.includes('\\')) {
    const candidate = resolve(command);
    return existsSync(candidate) && statSync(candidate).isFile() ? candidate : null;
  }
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, process.platform === 'win32' && !extname(command) ? `${command}${extension.toLowerCase()}` : command);
      if (existsSync(candidate) && statSync(candidate).isFile()) return resolve(candidate);
    }
  }
  return null;
}

function probeVersion(path: string, artifact: Artifact): string {
  const result = spawnSync(path, artifact.versionArgs, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${path}: version probe failed (${result.status ?? result.error?.message ?? 'unknown'})`);
  return String(result.stdout || result.stderr).split(/\r?\n/, 1)[0]?.trim() || artifact.version;
}

function portableResolution(name: AssetToolName, platform = assetPlatformKey()): ResolvedAssetTool | null {
  const artifact = artifactFor(name, platform);
  const directory = installDir(name, platform);
  const path = join(directory, artifact.binary);
  const markerPath = join(directory, '.verified.json');
  if (!existsSync(path) || !existsSync(markerPath)) return null;
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { archiveSha256?: string; binarySha256?: string; companionSha256?: Record<string, string>; version?: string };
    if (marker.archiveSha256 !== artifact.sha256 || marker.version !== artifact.version) return null;
    if (marker.binarySha256 !== sha256(readFileSync(path))) return null;
    for (const companion of artifact.companions ?? []) {
      const companionPath = join(directory, companion);
      if (!existsSync(companionPath) || marker.companionSha256?.[companion] !== sha256(readFileSync(companionPath))) return null;
    }
    return { name, path, version: probeVersion(path, artifact), source: 'portable', platform };
  } catch {
    return null;
  }
}

export function resolveAssetTool(name: AssetToolName, options: { required?: boolean; platform?: string } = {}): ResolvedAssetTool | null {
  const platform = options.platform ?? assetPlatformKey();
  const artifact = artifactFor(name, platform);
  const explicit = process.env[name];
  if (explicit) {
    const path = findOnPath(explicit);
    if (path) return { name, path, version: probeVersion(path, artifact), source: 'environment', platform };
    if (options.required) throw new Error(`${name}: explicit executable does not exist: ${explicit}`);
    return null;
  }
  const portable = portableResolution(name, platform);
  if (portable) return portable;
  const path = findOnPath(DEFAULT_COMMANDS[name]);
  if (path) return { name, path, version: probeVersion(path, artifact), source: 'path', platform };
  if (options.required) throw new Error(`${name}: executable unavailable; run npm run tools:install or set ${name}`);
  return null;
}

function findBinary(root: string, fileName: string): string | null {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findBinary(full, fileName);
      if (nested) return nested;
    } else if (entry.name.toLowerCase() === fileName.toLowerCase()) return full;
  }
  return null;
}

function checkedRun(command: string, args: string[], label: string) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr || result.stdout || result.error?.message || result.status}`);
}

function safeRemoveTemp(path: string) {
  const absolute = resolve(path);
  const tempRoot = `${resolve(tmpdir())}${sep}`;
  if (!absolute.startsWith(tempRoot)) throw new Error(`refusing to remove non-temporary path ${absolute}`);
  rmSync(absolute, { recursive: true, force: true });
}

async function verifiedDownload(artifact: Artifact): Promise<Buffer> {
  const response = await fetch(artifact.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${artifact.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyArtifactBytes(bytes, artifact.sha256, basename(artifact.url));
  return bytes;
}

export async function installPortableAssetTool(name: AssetToolName, platform = assetPlatformKey()): Promise<ResolvedAssetTool> {
  const artifact = artifactFor(name, platform);
  console.log(`[tools] downloading verified ${name} ${artifact.version} for ${platform}`);
  // The complete response is hashed before any bytes are written, extracted, installed, or run.
  const verifiedBytes = await verifiedDownload(artifact);
  const temporary = mkdtempSync(join(tmpdir(), 'vanillagl-asset-tool-'));
  const staging = join(temporary, 'staging');
  const destination = installDir(name, platform);
  mkdirSync(staging, { recursive: true });
  mkdirSync(destination, { recursive: true });
  const archivePath = artifact.format === 'nsis'
    ? join(destination, '.verified-installer.exe')
    : join(temporary, `download${artifact.format === 'pkg' ? '.pkg' : artifact.format === 'gzip' ? '.gz' : extname(new URL(artifact.url).pathname)}`);
  writeFileSync(archivePath, verifiedBytes);

  try {
    let sourceBinary: string | null = null;
    if (artifact.format === 'gzip') {
      sourceBinary = join(staging, artifact.binary);
      writeFileSync(sourceBinary, gunzipSync(verifiedBytes));
    } else if (artifact.format === 'archive') {
      checkedRun('tar', ['-xf', archivePath, '-C', staging], `${name} archive extraction`);
      sourceBinary = findBinary(staging, artifact.binary);
    } else if (artifact.format === 'pkg') {
      checkedRun('pkgutil', ['--expand-full', archivePath, staging], `${name} package extraction`);
      sourceBinary = findBinary(staging, artifact.binary);
    } else {
      // NSIS is the publisher's only Windows CLI bundle. It is run only after the
      // downloaded bytes have matched the pinned SHA-256 above.
      const sevenZip = findOnPath('7z') ?? findOnPath('7zz');
      if (sevenZip) checkedRun(sevenZip, ['x', '-y', `-o${staging}`, archivePath], `${name} verified installer extraction`);
      else checkedRun(archivePath, ['/S', `/D=${staging}`], `${name} verified installer`);
      sourceBinary = findBinary(staging, artifact.binary);
    }
    if (!sourceBinary) throw new Error(`${name}: ${artifact.binary} was not found after verified extraction`);

    const target = join(destination, artifact.binary);
    copyFileSync(sourceBinary, target);
    if (process.platform !== 'win32') chmodSync(target, 0o755);
    const binarySha256 = sha256(readFileSync(target));
    const companionSha256: Record<string, string> = {};
    for (const companion of artifact.companions ?? []) {
      const sourceCompanion = findBinary(staging, companion);
      if (!sourceCompanion) throw new Error(`${name}: companion ${companion} was not found after verified extraction`);
      const companionTarget = join(destination, companion);
      copyFileSync(sourceCompanion, companionTarget);
      if (process.platform !== 'win32') chmodSync(companionTarget, 0o755);
      companionSha256[companion] = sha256(readFileSync(companionTarget));
    }
    writeFileSync(join(destination, '.verified.json'), `${JSON.stringify({
      schema: 'vanillagl.asset-tool-install/v1',
      name,
      platform,
      version: artifact.version,
      archiveSha256: artifact.sha256,
      binarySha256,
      companionSha256,
      source: artifact.url,
    }, null, 2)}\n`);
  } finally {
    if (artifact.format === 'nsis' && existsSync(archivePath)) unlinkSync(archivePath);
    safeRemoveTemp(temporary);
  }

  const resolved = portableResolution(name, platform);
  if (!resolved) throw new Error(`${name}: installed binary did not pass its verification marker`);
  console.log(`[tools] ${name} -> ${resolved.path} (${resolved.version})`);
  return resolved;
}

export async function ensureAssetTools(options: { installMissing?: boolean; preferPortable?: boolean } = {}): Promise<Record<AssetToolName, ResolvedAssetTool>> {
  const output = {} as Record<AssetToolName, ResolvedAssetTool>;
  for (const name of TOOL_NAMES) {
    const explicit = process.env[name];
    let resolved = explicit ? resolveAssetTool(name, { required: true }) : portableResolution(name);
    if (!resolved && !options.preferPortable) resolved = resolveAssetTool(name);
    if (!resolved && options.installMissing) resolved = await installPortableAssetTool(name);
    if (!resolved) resolved = resolveAssetTool(name, { required: true });
    output[name] = resolved!;
  }
  return output;
}
