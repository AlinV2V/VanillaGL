import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const REGISTER_TS_URL = pathToFileURL(join(ROOT, 'tools', 'utils', 'sim', 'register-ts.mjs')).href;

export type AsyncToolOptions = {
  script: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  label?: string;
};

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

export function getBakeJobCount(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): number {
  const inline = argv.find((arg) => arg.startsWith('--jobs='));
  const inlineValue = inline ? inline.slice('--jobs='.length) : undefined;
  const index = argv.indexOf('--jobs');
  const separateValue = index >= 0 ? argv[index + 1] : undefined;
  const requested = parsePositiveInt(inlineValue) ?? parsePositiveInt(separateValue) ?? parsePositiveInt(env.BAKE_JOBS);
  if (requested) return requested;

  const cpu = Math.max(1, availableParallelism());
  return Math.max(1, Math.min(cpu - 1 || 1, 8));
}

export function runTsToolAsync(options: AsyncToolOptions): Promise<void> {
  const scriptPath = resolve(ROOT, options.script);
  const label = options.label ?? options.script;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ['--import', REGISTER_TS_URL, scriptPath, ...(options.args ?? [])],
      {
        cwd: options.cwd ?? ROOT,
        stdio: 'inherit',
        env: { ...process.env, ...options.env },
      },
    );
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${label} failed (${signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`})`));
    });
  });
}

export async function runPool<T>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<void>,
  options: { jobs?: number; onComplete?: (completed: number, total: number, item: T) => void } = {},
): Promise<void> {
  if (!items.length) return;
  const jobs = Math.max(1, Math.min(options.jobs ?? getBakeJobCount(), items.length));
  let next = 0;
  let completed = 0;
  let failure: unknown = null;

  const runner = async () => {
    while (failure === null) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      try {
        await worker(item, index);
        completed++;
        options.onComplete?.(completed, items.length, item);
      } catch (error) {
        failure = error;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: jobs }, () => runner()));
  if (failure !== null) throw failure;
}
