/** Asset conversion utility. */
import crypto from 'node:crypto';
import net from 'node:net';
import { WebSocketServer } from 'ws';

const WS_PORT = Number(process.env.WS_PORT || 9000);
const WS_HOST = process.env.WS_HOST || '127.0.0.1';
const REALM_HOST = process.env.REALM_HOST || '127.0.0.1';
const PORTS = {
  auth: Number(process.env.AUTH_PORT || 3724),
  world: Number(process.env.WORLD_PORT || 8085),
};

const positiveInt = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);
// 300-player alpha target plus login/reconnect headroom. Each world session holds one bridge;
// authentication connections are short-lived but overlap during bursts and rolling reconnects.
const MAX_CONNECTIONS = positiveInt('MAX_CONNECTIONS', 512);
// Per-source cap so one client cannot hold every slot and 503 everyone else. Generous enough for
// multi-tab local dev (all sharing 127.0.0.1) while still well below the global ceiling.
const MAX_CONNECTIONS_PER_IP = positiveInt('MAX_CONNECTIONS_PER_IP', 16);
const MAX_WS_PAYLOAD = positiveInt('MAX_WS_PAYLOAD_BYTES', 4 * 1024 * 1024);
const MAX_PENDING_BYTES = positiveInt('MAX_PENDING_BYTES', 512 * 1024);
const MAX_UPSTREAM_QUEUE_BYTES = positiveInt('MAX_UPSTREAM_QUEUE_BYTES', 2 * 1024 * 1024);
const MAX_CLIENT_BUFFERED_BYTES = positiveInt('MAX_CLIENT_BUFFERED_BYTES', 2 * 1024 * 1024);
const MAX_DOWNSTREAM_QUEUE_BYTES = positiveInt('MAX_DOWNSTREAM_QUEUE_BYTES', 8 * 1024 * 1024);
const CLIENT_BACKPRESSURE_TIMEOUT_MS = positiveInt('CLIENT_BACKPRESSURE_TIMEOUT_MS', 15000);
const CLIENT_RESUME_BUFFERED_BYTES = Math.floor(MAX_CLIENT_BUFFERED_BYTES / 2);
const TCP_CONNECT_TIMEOUT_MS = positiveInt('TCP_CONNECT_TIMEOUT_MS', 10000);

const DEFAULT_CLIENT_INTEGRITY_HASH = '95EDB27C7823B363CBDDAB56A392E7CB73FCCA20';
const CLIENT_INTEGRITY_HASH = Buffer.from(
  (process.env.WOW_CLIENT_INTEGRITY_HASH || DEFAULT_CLIENT_INTEGRITY_HASH).replace(/[^0-9a-f]/gi, ''),
  'hex',
);
if (CLIENT_INTEGRITY_HASH.length !== 20) {
  throw new Error('WOW_CLIENT_INTEGRITY_HASH must be a 20-byte SHA1 hex digest');
}

function computeLoginIntegrityHash(checksumSalt, clientPublicKey) {
  // vMaNGOS verifies SHA1(A || allowed_clients.integrity_hash). The salt is still
  // present in the vanilla challenge packet, but this server-side verifier ignores it.
  void checksumSalt;
  return crypto.createHash('sha1').update(clientPublicKey).update(CLIENT_INTEGRITY_HASH).digest();
}

function extractLoginChecksumSalt(packet) {
  if (packet[0] !== 0x00 || packet.length < 3 || packet[2] !== 0x00) return null;

  let offset = 3 + 32;
  if (packet.length <= offset) return null;

  const gLen = packet[offset++];
  offset += gLen;
  if (packet.length <= offset) return null;

  const nLen = packet[offset++];
  offset += nLen + 32;
  if (packet.length < offset + 16) return null;

  return Buffer.from(packet.subarray(offset, offset + 16));
}

function patchLogonProof(packet, authState) {
  if (packet[0] !== 0x01 || packet.length < 75) return packet;

  const clientPublicKey = packet.subarray(1, 33);
  const integrityHash = computeLoginIntegrityHash(authState.checksumSalt, clientPublicKey);
  if (!integrityHash) return packet;

  const patched = Buffer.from(packet);
  integrityHash.copy(patched, 53);
  return patched;
}

let activeConnections = 0;
const connectionsByIp = new Map();
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY ?? '');
const remoteKey = (req) => {
  if (TRUST_PROXY) {
    const forwarded = req?.headers?.['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req?.socket?.remoteAddress ?? 'unknown';
};

// The request-target arrives from an untrusted peer and is NOT guaranteed to be a parseable URL.
// Node's HTTP parser accepts absolute-form targets verbatim, so a request line such as
// `GET http://[::1 HTTP/1.1` reaches us as a string that `new URL()` throws on. Thrown from the
// 'connection' handler that throw is uncaught and takes the whole proxy process down, dropping
// every other live session with it. Parse defensively and let the caller reject the connection.
function readTarget(rawUrl) {
  try {
    return new URL(rawUrl ?? '/', 'http://localhost').searchParams.get('target');
  } catch {
    return null;
  }
}
const wss = new WebSocketServer({
  host: WS_HOST,
  port: WS_PORT,
  maxPayload: MAX_WS_PAYLOAD,
  verifyClient: ({ origin, req }, done) => {
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      done(false, 403, 'WebSocket origin is not allowed');
      return;
    }
    if (activeConnections >= MAX_CONNECTIONS) {
      done(false, 503, 'WebSocket connection limit reached');
      return;
    }
    if ((connectionsByIp.get(remoteKey(req)) ?? 0) >= MAX_CONNECTIONS_PER_IP) {
      done(false, 503, 'Per-source WebSocket connection limit reached');
      return;
    }
    done(true);
  },
});
console.log(`[proxy] listening ws://${WS_HOST}:${WS_PORT} -> ${REALM_HOST === '127.0.0.1' ? '127.0.0.1' : '***.***.***.***'} (auth ${PORTS.auth} / world ${PORTS.world}); origins=${[...ALLOWED_ORIGINS].join(',')}; max=${MAX_CONNECTIONS}; trustProxy=${TRUST_PROXY}`);

wss.on('connection', (ws, req) => {
  activeConnections++;
  const ipKey = remoteKey(req);
  connectionsByIp.set(ipKey, (connectionsByIp.get(ipKey) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeConnections = Math.max(0, activeConnections - 1);
    const remaining = (connectionsByIp.get(ipKey) ?? 1) - 1;
    if (remaining <= 0) connectionsByIp.delete(ipKey);
    else connectionsByIp.set(ipKey, remaining);
  };

  const target = readTarget(req.url);
  if (target !== 'auth' && target !== 'world') {
    console.warn(`[proxy] rejected ${req.socket.remoteAddress}: invalid target`);
    ws.close(1008, 'target must be auth or world');
    release();
    return;
  }
  const port = PORTS[target];
  const authState = { checksumSalt: null };

  const tcp = net.connect(port, REALM_HOST);
  const id = `${req.socket.remoteAddress} -> ${target}:${port}`;
  console.log(`[proxy] open  ${id}`);

  let closed = false;
  let connected = false;
  let pendingBytes = 0;
  const pending = [];
  let upstreamQueueBytes = 0;
  const upstreamQueue = [];
  let tcpDraining = false;
  let downstreamQueueBytes = 0;
  const downstreamQueue = [];
  let clientBackpressured = false;
  let clientBackpressureSince = 0;
  let clientDrainTimer;
  let connectTimeout;

  const pauseClient = () => ws._socket?.pause();
  const resumeClient = () => ws._socket?.resume();
  const close = (why, code = 1011) => {
    if (closed) return;
    closed = true;
    if (why) console.log(`[proxy] close ${id} (${why})`);
    pending.length = 0;
    upstreamQueue.length = 0;
    downstreamQueue.length = 0;
    pendingBytes = 0;
    upstreamQueueBytes = 0;
    downstreamQueueBytes = 0;
    if (connectTimeout) clearTimeout(connectTimeout);
    if (clientDrainTimer) clearTimeout(clientDrainTimer);
    try { tcp.destroy(); } catch {}
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      try { ws.close(code, String(why ?? '').slice(0, 120)); } catch {}
    }
    release();
  };

  const queueForTcp = (chunk) => {
    if (closed) return;
    if (!connected) {
      pendingBytes += chunk.length;
      if (pendingBytes > MAX_PENDING_BYTES) {
        close('pre-connect buffer limit exceeded', 1009);
        return;
      }
      pending.push(chunk);
      return;
    }
    if (tcpDraining) {
      upstreamQueueBytes += chunk.length;
      if (upstreamQueueBytes > MAX_UPSTREAM_QUEUE_BYTES) {
        close('upstream backpressure limit exceeded', 1013);
        return;
      }
      upstreamQueue.push(chunk);
      return;
    }
    if (!tcp.write(chunk)) {
      tcpDraining = true;
      pauseClient();
    }
  };

  const flushTcpQueue = () => {
    if (closed || !connected) return;
    tcpDraining = false;
    while (upstreamQueue.length) {
      const chunk = upstreamQueue.shift();
      upstreamQueueBytes -= chunk.length;
      if (!tcp.write(chunk)) {
        tcpDraining = true;
        pauseClient();
        return;
      }
    }
    resumeClient();
  };

  const scheduleClientDrain = () => {
    if (closed || clientDrainTimer) return;
    clientDrainTimer = setTimeout(flushClientQueue, 10);
  };

  const sendClientChunk = (data) => {
    if (closed || ws.readyState !== ws.OPEN) return;
    if (clientBackpressured || ws.bufferedAmount + data.length > MAX_CLIENT_BUFFERED_BYTES) {
      downstreamQueueBytes += data.length;
      if (downstreamQueueBytes > MAX_DOWNSTREAM_QUEUE_BYTES) {
        close('sustained client backpressure exceeded hard queue limit', 1013);
        return;
      }
      downstreamQueue.push(data);
      if (!clientBackpressured) {
        clientBackpressured = true;
        clientBackpressureSince = Date.now();
        tcp.pause();
      }
      scheduleClientDrain();
      return;
    }
    ws.send(data, { binary: true }, (error) => {
      if (error) close(`WebSocket send failed: ${error.message}`);
      else if (clientBackpressured) scheduleClientDrain();
    });
  };

  function flushClientQueue() {
    clientDrainTimer = undefined;
    if (closed || ws.readyState !== ws.OPEN) return;
    if (clientBackpressured && Date.now() - clientBackpressureSince > CLIENT_BACKPRESSURE_TIMEOUT_MS) {
      close('sustained client backpressure timed out', 1013);
      return;
    }
    while (downstreamQueue.length) {
      const next = downstreamQueue[0];
      if (ws.bufferedAmount + next.length > MAX_CLIENT_BUFFERED_BYTES) break;
      downstreamQueue.shift();
      downstreamQueueBytes -= next.length;
      ws.send(next, { binary: true }, (error) => {
        if (error) close(`WebSocket send failed: ${error.message}`);
        else if (clientBackpressured) scheduleClientDrain();
      });
    }
    if (!downstreamQueue.length && ws.bufferedAmount <= CLIENT_RESUME_BUFFERED_BYTES) {
      clientBackpressured = false;
      clientBackpressureSince = 0;
      tcp.resume();
      return;
    }
    scheduleClientDrain();
  }

  tcp.on('connect', () => {
    connected = true;
    if (connectTimeout) clearTimeout(connectTimeout);
    const initial = pending.splice(0);
    pendingBytes = 0;
    for (const chunk of initial) queueForTcp(chunk);
  });
  tcp.on('drain', flushTcpQueue);
  connectTimeout = setTimeout(() => {
    if (!connected) close('TCP connection timed out');
  }, TCP_CONNECT_TIMEOUT_MS);

  tcp.on('data', (data) => {
    if (closed) return;
    if (target === 'auth') {
      const checksumSalt = extractLoginChecksumSalt(data);
      if (checksumSalt) authState.checksumSalt = checksumSalt;
      if (data[0] === 0x01 && data.length >= 2) {
        console.log(`[proxy] auth proof response ${id}: status=0x${data[1].toString(16).padStart(2, '0')}`);
      }
      if (data[0] === 0x10) {
        console.log(`[proxy] realm list response ${id}: ${data.length} bytes`);
      }
    }
    sendClientChunk(data);
  });

  ws.on('message', (msg, isBinary) => {
    if (!isBinary) { close('binary WebSocket frames required', 1003); return; }
    const raw = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
    const buf = target === 'auth' ? patchLogonProof(raw, authState) : raw;
    if (target === 'auth' && raw[0] === 0x01 && buf !== raw) {
      console.log(`[proxy] patched auth proof ${id}`);
    }
    queueForTcp(buf);
  });

  ws.on('close', () => close('ws closed', 1000));
  ws.on('error', (error) => close(`ws error: ${error.message}`));
  tcp.on('close', () => close('tcp closed', 1000));
  tcp.on('error', (error) => close(`tcp error: ${error.message}`));
});
