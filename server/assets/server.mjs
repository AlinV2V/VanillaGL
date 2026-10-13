import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PUBLIC = resolve(process.env.VGL_ASSET_ROOT || join(ROOT, 'apps', 'client', 'public'));
const HASH_INDEX = join(PUBLIC, 'data', 'catalogs', 'content-hashes', 'index.json');
const LEGACY_HASH_MANIFEST = join(PUBLIC, 'data', 'content-hashes.json');
const PORT = Number(process.env.ASSET_PORT || 8081);
const HOST = process.env.ASSET_HOST || '127.0.0.1';
const CROSS_ORIGIN_ISOLATED = process.env.VGL_CROSS_ORIGIN_ISOLATED === '1';
const CORS_ORIGIN = process.env.ASSET_CORS_ORIGIN || '*';

const MIME = new Map([
  ['.json', 'application/json; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.bin', 'application/octet-stream'],
  ['.f32', 'application/octet-stream'],
  ['.wasm', 'application/wasm'],
  ['.ktx2', 'image/ktx2'],
  ['.webp', 'image/webp'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.opus', 'audio/ogg; codecs=opus'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ttf', 'font/ttf'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.svg', 'image/svg+xml'],
]);

let hashes = {};
let hashShards = {};
const loadedHashShards = new Map();
function reloadHashes() {
  hashes = {};
  hashShards = {};
  loadedHashShards.clear();
  try { hashShards = JSON.parse(readFileSync(HASH_INDEX, 'utf8')).shards ?? {}; }
  catch {
    try { hashes = JSON.parse(readFileSync(LEGACY_HASH_MANIFEST, 'utf8')).assets ?? {}; }
    catch { hashes = {}; }
  }
}
reloadHashes();

function hashScope(logical) {
  const relative = logical.replace(/^\/+/, '');
  return relative.includes('/') ? relative.split('/', 1)[0].toLowerCase() : 'root';
}

function hashEntry(logical) {
  if (hashes[logical]) return hashes[logical];
  const scope = hashScope(logical);
  if (loadedHashShards.has(scope)) return loadedHashShards.get(scope)[logical];
  const descriptor = hashShards[scope];
  if (!descriptor?.url) {
    loadedHashShards.set(scope, {});
    return undefined;
  }
  try {
    const path = assetPath(new URL(descriptor.url, 'http://localhost').pathname);
    const assets = path ? JSON.parse(readFileSync(path, 'utf8')).assets ?? {} : {};
    loadedHashShards.set(scope, assets);
    return assets[logical];
  } catch {
    loadedHashShards.set(scope, {});
    return undefined;
  }
}

function assetPath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const relative = normalize(decoded.replace(/^\/+/, ''));
  if (!relative || relative === '.' || relative.startsWith(`..${sep}`) || relative === '..') return null;
  const file = resolve(PUBLIC, relative);
  if (file !== PUBLIC && !file.startsWith(`${PUBLIC}${sep}`)) return null;
  return file;
}

function logicalPath(file) {
  return `/${file.slice(PUBLIC.length + 1).split(sep).join('/')}`;
}

function commonHeaders(res, logical, url) {
  const entry = hashEntry(logical);
  const version = url.searchParams.get('v');
  const immutable = !!entry?.hash && !!version && entry.hash.startsWith(version);
  res.setHeader('Vary', 'Accept-Encoding, Origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, If-None-Match, If-Modified-Since, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range, Content-Encoding, ETag');
  res.setHeader('Cache-Control', immutable
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=0, must-revalidate');
  if (entry?.hash) res.setHeader('ETag', `"sha256-${entry.hash.slice(0, 32)}"`);
  if (CROSS_ORIGIN_ISOLATED) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  }
}

function parseRange(header, size) {
  if (!header) return { kind: 'none' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || size <= 0) return { kind: 'invalid' };
  let start = match[1] ? Number(match[1]) : NaN;
  let end = match[2] ? Number(match[2]) : NaN;
  if (Number.isNaN(start) && !Number.isNaN(end)) {
    if (end <= 0 || !Number.isSafeInteger(end)) return { kind: 'invalid' };
    const suffix = Math.min(size, end);
    start = size - suffix;
    end = size - 1;
  } else {
    if (Number.isNaN(start) || !Number.isSafeInteger(start)) return { kind: 'invalid' };
    if (Number.isNaN(end)) end = size - 1;
  }
  if (!Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return { kind: 'invalid' };
  return { kind: 'range', start, end: Math.min(end, size - 1) };
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  commonHeaders(res, url.pathname, url);
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '86400');
    res.writeHead(204); res.end(); return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' }); res.end(); return;
  }
  if (url.pathname === '/__reload-hashes' && process.env.NODE_ENV !== 'production') {
    reloadHashes(); res.writeHead(204); res.end(); return;
  }
  const sourceFile = assetPath(url.pathname);
  if (!sourceFile || !existsSync(sourceFile) || !statSync(sourceFile).isFile()) {
    res.writeHead(404); res.end('Not found'); return;
  }

  const logical = logicalPath(sourceFile);
  commonHeaders(res, logical, url);
  res.setHeader('Content-Type', MIME.get(extname(sourceFile).toLowerCase()) || 'application/octet-stream');

  const sourceSize = statSync(sourceFile).size;
  const range = parseRange(req.headers.range, sourceSize);
  res.setHeader('Accept-Ranges', 'bytes');
  if (range.kind === 'invalid') {
    res.setHeader('Content-Range', `bytes */${sourceSize}`);
    res.setHeader('Content-Length', '0');
    res.writeHead(416); res.end(); return;
  }

  const acceptsBrotli = range.kind === 'none' && /(?:^|,|\s)br(?:\s|,|;|$)/i.test(req.headers['accept-encoding'] || '');
  const encodedFile = `${sourceFile}.br`;
  const servedFile = acceptsBrotli && existsSync(encodedFile) ? encodedFile : sourceFile;
  const stat = statSync(servedFile);

  if (servedFile === encodedFile) {
    res.setHeader('Content-Encoding', 'br');
    res.setHeader('Content-Length', stat.size);
    res.writeHead(200);
    if (req.method === 'HEAD') res.end(); else createReadStream(servedFile).pipe(res);
    return;
  }

  if (range.kind === 'range') {
    const length = range.end - range.start + 1;
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
    res.setHeader('Content-Length', length);
    res.writeHead(206);
    if (req.method === 'HEAD') res.end(); else createReadStream(servedFile, range).pipe(res);
    return;
  }
  res.setHeader('Content-Length', stat.size);
  res.writeHead(200);
  if (req.method === 'HEAD') res.end(); else createReadStream(servedFile).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`[assets] ${PUBLIC}`);
  console.log(`[assets] http://${HOST}:${PORT} (Brotli sidecars + immutable hash routing)`);
});
