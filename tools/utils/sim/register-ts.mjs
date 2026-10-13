/** Transpile and resolve TypeScript graph for Node-based capture replay. */
import { registerHooks } from 'node:module';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

let transformSync = null;
try {
  const esbuild = await import('esbuild');
  transformSync = esbuild.transformSync;
} catch {
  // esbuild not installed
}

const suffixes = ['.ts', '.tsx', '/index.ts', '.js'];
const unresolved = (path) => !existsSync(path) || statSync(path).isDirectory();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const base = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (unresolved(base)) {
        for (const suffix of suffixes) {
          if (existsSync(base + suffix)) {
            return { url: pathToFileURL(base + suffix).href, shortCircuit: true, format: 'module' };
          }
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !/\.tsx?$/.test(url) || !transformSync) return nextLoad(url, context);
    const path = fileURLToPath(url);
    const raw = readFileSync(path, 'utf8');
    const { code } = transformSync(raw, {
      loader: url.endsWith('.tsx') ? 'tsx' : 'ts',
      format: 'esm',
      target: 'node22',
      sourcefile: path,
      sourcemap: 'inline',
    });
    return { format: 'module', source: code, shortCircuit: true };
  },
});
