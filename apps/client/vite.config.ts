import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tlsCert = process.env.VANILLAGL_TLS_CERT, tlsKey = process.env.VANILLAGL_TLS_KEY;
if (!!tlsCert !== !!tlsKey) throw new Error('Set both VANILLAGL_TLS_CERT and VANILLAGL_TLS_KEY for headset HTTPS.');

const buildRevision = (): string => {
  if (process.env.VITE_BUILD_REVISION) return process.env.VITE_BUILD_REVISION;
  try {
    // Quiet stderr: ZIP downloads have no .git, and git's "fatal:" message would look like an error.
    const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const revision = git(['rev-parse', '--short', 'HEAD']).trim();
    const dirty = git(['status', '--porcelain']).trim().length > 0;
    return `${revision}${dirty ? '-dirty' : ''}`;
  } catch { return 'unavailable'; }
};

// stormjs ships an Emscripten WASM module. WebGPU already requires modern browsers,
// so native top-level await with an esnext target avoids an extra transform plugin.
export default defineConfig(({ command }) => ({
  base: './',
  // The game corpus is served separately in production. Copying 3+ GB of public
  // assets into dist on every code build makes CI and local release checks unusable.
  // Keep Vite's public serving for development, but emit only the application bundle.
  publicDir: command === 'serve' ? 'public' : false,
  plugins: [wasm()],
  define: {
    __BP_QA_GLOBALS__: JSON.stringify(command === 'serve' || process.env.VITE_ENABLE_QA_GLOBALS === '1'),
    __VANILLAGL_BUILD_REVISION__: JSON.stringify(buildRevision()),
  },
  build: {
    target: 'esnext',
    manifest: true,
    rolldownOptions: {
      input: { main: 'index.html' },
      output: {
        codeSplitting: {
          groups: [{
            name: 'initial',
            tags: ['$initial'],
            maxSize: 700 * 1024,
            entriesAware: true,
          }],
        },
      },
    },
  },
  // Default 5173 for the normal dev server; PORT env lets the preview/QA harness spin up a second
  // instance on an auto-assigned free port without colliding with a running dev server.
  server: {
    host: tlsCert ? '0.0.0.0' : undefined,
    https: tlsCert && tlsKey ? { cert: readFileSync(tlsCert), key: readFileSync(tlsKey) } : undefined,
    proxy: { '/wow-ws': { target: process.env.VANILLAGL_REALM_PROXY || 'http://127.0.0.1:9000', ws: true,
      rewrite: path => path.replace(/^\/wow-ws\/?/, '/') } },
    port: Number(process.env.PORT) || 5173,
    // The extracted Vanilla corpus is ~142k files / 4 GB. Watching it recursively consumes close
    // to a gigabyte and can stall even the initial HTML request. These are generated immutable
    // assets; source/data rebakes are picked up by an explicit browser reload.
    watch: { ignored: ['**/public/**'] },
  },
  optimizeDeps: { exclude: ['@wowserhq/stormjs'] },
}));
