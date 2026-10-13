import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const port = Number(argument('--port') ?? process.env.PORT ?? 5173);
const startLocalProxy = process.argv.includes('--local-proxy');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid LAN dev port: ${port}`);

const candidates = Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
  (addresses ?? [])
    .filter((address) => address.family === 'IPv4' && !address.internal)
    .map((address) => ({ name, address: address.address })),
);
if (!candidates.length) throw new Error('No non-loopback IPv4 address was found. Connect the PC to Wi-Fi/Ethernet first.');

const score = ({ name, address }) => {
  let value = /^192\.168\./.test(address) ? 6 : /^10\./.test(address) ? 5 : /^172\.(1[6-9]|2\d|3[01])\./.test(address) ? 4 : 0;
  if (/wi-?fi|wireless|ethernet/i.test(name)) value += 4;
  if (/wsl|hyper-v|virtual|vpn|radmin|loopback/i.test(name)) value -= 8;
  return value;
};
candidates.sort((left, right) => score(right) - score(left));
const secureClient = !!process.env.VANILLAGL_TLS_CERT && !!process.env.VANILLAGL_TLS_KEY;
const clientScheme = secureClient ? 'https' : 'http';
const origins = candidates.map(({ address }) => `${clientScheme}://${address}:${port}`);
const allowedOrigins = [...new Set([...origins, `${clientScheme}://localhost:${port}`, `${clientScheme}://127.0.0.1:${port}`])];
const npmCli = process.env.npm_execpath;
const npm = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmArgs = npmCli ? [npmCli] : [];
const children = [];
let stopping = false;

const stop = (exitCode = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  setTimeout(() => process.exit(exitCode), 250).unref();
};
const start = (label, args, env = {}) => {
  const child = spawn(npm, [...npmArgs, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: 'inherit',
    windowsHide: true,
  });
  children.push(child);
  child.on('error', (error) => { console.error(`[lan-dev] ${label} failed: ${error.message}`); stop(1); });
  child.on('exit', (code) => { if (!stopping) { console.error(`[lan-dev] ${label} exited (${code ?? 'signal'}).`); stop(code || 1); } });
};

console.log('[lan-dev] Phone and PC must be on the same Wi-Fi/LAN.');
console.log(`[lan-dev] Open on the phone: ${origins[0]}`);
if (origins.length > 1) console.log(`[lan-dev] Other detected addresses: ${origins.slice(1).join(', ')}`);
console.log(startLocalProxy
  ? '[lan-dev] Local proxy enabled; the browser client and WebSocket bridge bind to the LAN.'
  : '[lan-dev] The browser connects directly to the configured VPS WebSocket bridge.');

if (startLocalProxy) start('realm WebSocket bridge', ['run', 'proxy'], {
  WS_HOST: '0.0.0.0', ALLOWED_ORIGINS: allowedOrigins.join(','),
});
start('Vite client', ['--workspace', '@vanillagl/client', 'run', 'dev', '--', '--host', '0.0.0.0', '--port', String(port), '--strictPort']);

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
process.on('exit', () => { for (const child of children) if (child.exitCode === null) child.kill(); });
