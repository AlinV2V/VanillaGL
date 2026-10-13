import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const REGISTER_TS_URL = pathToFileURL(
  join(REPO_ROOT, 'tools', 'utils', 'sim', 'register-ts.mjs'),
).href;

export type RunTsToolOptions = {
  /** Repository-relative script path, e.g. `tools/bakers/bake-water.ts`. */
  script: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdio?: SpawnSyncOptions['stdio'];
};

/**
 * Run one repository TypeScript tool under the same loader used by npm scripts.
 *
 * `--import` is deliberately passed a file URL rather than an absolute path. On
 * Windows, `C:\\...` is otherwise parsed by Node's ESM loader as a `C:` URL
 * scheme and fails with ERR_UNSUPPORTED_ESM_URL_SCHEME.
 *
 * Keeping this in one helper also prevents aggregate bakers from accidentally
 * depending on Node's version-specific native TypeScript stripping behavior.
 */
export function runTsTool(options: RunTsToolOptions) {
  const scriptPath = resolve(REPO_ROOT, options.script);
  return spawnSync(
    process.execPath,
    ['--import', REGISTER_TS_URL, scriptPath, ...(options.args ?? [])],
    {
      cwd: options.cwd ?? REPO_ROOT,
      stdio: options.stdio ?? 'inherit',
      env: { ...process.env, ...options.env },
    },
  );
}

export function runTsToolOrThrow(options: RunTsToolOptions, label = options.script): void {
  const result = runTsTool(options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status ?? 'unknown'})`);
  }
}
