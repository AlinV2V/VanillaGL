import { sha1Digest } from './platform/sha1-digest';

export type RealmInfo = {
  id: number;
  name: string;
  address: string;
  icon: number;
  flags: number;
  locked: boolean;
  population: number;
  characters: number;
  timezone: number;
  build?: number;
  version?: string;
};

export type AuthSession = {
  account: string;
  sessionKey: Uint8Array;
  realms: RealmInfo[];
};

export type AuthProgress = (message: string) => void;

const AUTH_CONNECT_TIMEOUT_MS = 10000;
const AUTH_MESSAGE_TIMEOUT_MS = 15000;

const AUTH_STATUS: Record<number, string> = {
  0x00: 'success',
  0x03: 'account banned',
  0x04: 'account invalid',
  0x05: 'password invalid',
  0x06: 'already online',
  0x07: 'no time',
  0x08: 'database busy',
  0x09: 'build invalid',
  0x0a: 'build update',
};

const text = new TextEncoder();

function bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function sha1(...parts: Uint8Array[]): Promise<Uint8Array> {
  return sha1Digest(...parts);
}

function mod(n: bigint, m: bigint): bigint {
  const r = n % m;
  return r >= 0n ? r : r + m;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = mod(base, modulus);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    e >>= 1n;
    b = (b * b) % modulus;
  }
  return result;
}

function bytesToBigIntLE(input: Uint8Array): bigint {
  let n = 0n;
  for (let i = input.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(input[i]);
  return n;
}

function bigIntToBytesLE(n: bigint, length = 0): Uint8Array {
  const out: number[] = [];
  let v = n;
  while (v > 0n) {
    out.push(Number(v & 0xffn));
    v >>= 8n;
  }
  while (out.length < length) out.push(0);
  if (length > 0 && out.length > length) out.length = length;
  return new Uint8Array(out);
}

function randomBigInt(bytesLength: number): bigint {
  const data = new Uint8Array(bytesLength);
  crypto.getRandomValues(data);
  return bytesToBigIntLE(data);
}

function rev4(s: string): Uint8Array {
  const out = new Uint8Array(4);
  const b = bytes(s).reverse();
  out.set(b.subarray(0, 4), 0);
  return out;
}

function writeU16LE(out: Uint8Array, offset: number, value: number) {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32LE(out: Uint8Array, offset: number, value: number) {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
  out[offset + 2] = (value >>> 16) & 0xff;
  out[offset + 3] = (value >>> 24) & 0xff;
}

function buildLogonChallenge(account: string): Uint8Array {
  const accountBytes = bytes(account);
  const body = concat(
    bytes('WoW\0'),
    new Uint8Array([1, 12, 1]),
    new Uint8Array([0xf3, 0x16]), // build 5875
    rev4('x86'),
    rev4('Win'),
    rev4('enUS'),
    new Uint8Array(4),
    new Uint8Array(4),
    new Uint8Array([accountBytes.length]),
    accountBytes,
  );

  const packet = new Uint8Array(4 + body.length);
  packet[0] = 0x00;
  packet[1] = 0x00;
  writeU16LE(packet, 2, body.length);
  packet.set(body, 4);
  return packet;
}

function readMessage(ws: WebSocket, timeoutMs = AUTH_MESSAGE_TIMEOUT_MS): Promise<Uint8Array> {
  if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
    return Promise.reject(new Error('WebSocket closed'));
  }
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onMessage = (ev: MessageEvent<ArrayBuffer | Blob>) => {
      cleanup();
      if (ev.data instanceof ArrayBuffer) {
        resolve(new Uint8Array(ev.data));
      } else {
        ev.data.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject);
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error('WebSocket error'));
    };
    const onClose = () => {
      cleanup();
      reject(new Error('WebSocket closed'));
    };
    const cleanup = () => {
      ws.removeEventListener('message', onMessage as EventListener);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
      if (timeout) clearTimeout(timeout);
    };
    ws.addEventListener('message', onMessage as EventListener);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error('auth response timed out'));
    }, timeoutMs);
  });
}

function openSocket(url: string, timeoutMs = AUTH_CONNECT_TIMEOUT_MS): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
      if (timeout) clearTimeout(timeout);
    };
    const onOpen = () => {
      cleanup();
      resolve(ws);
    };
    const onError = () => {
      cleanup();
      reject(new Error('WebSocket error'));
    };
    const onClose = () => {
      cleanup();
      reject(new Error('WebSocket closed before connecting'));
    };
    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onError, { once: true });
    ws.addEventListener('close', onClose, { once: true });
    timeout = setTimeout(() => {
      cleanup();
      ws.close();
      reject(new Error('auth WebSocket connection timed out'));
    }, timeoutMs);
  });
}

type Challenge = {
  B: Uint8Array;
  g: Uint8Array;
  N: Uint8Array;
  salt: Uint8Array;
};

function parseChallenge(packet: Uint8Array): Challenge {
  if (packet[0] !== 0x00) throw new Error(`unexpected auth opcode 0x${packet[0].toString(16)}`);
  const status = packet[2];
  if (status !== 0x00) throw new Error(`logon challenge rejected: ${AUTH_STATUS[status] ?? `0x${status.toString(16)}`}`);

  let o = 3;
  const B = packet.slice(o, o + 32);
  o += 32;
  const glen = packet[o++];
  const g = packet.slice(o, o + glen);
  o += glen;
  const nlen = packet[o++];
  const N = packet.slice(o, o + nlen);
  o += nlen;
  const salt = packet.slice(o, o + 32);

  if (B.length !== 32 || !g.length || N.length !== 32 || salt.length !== 32) {
    throw new Error('incomplete SRP challenge');
  }
  return { B, g, N, salt };
}

async function makeProof(challenge: Challenge, account: string, password: string) {
  const N = bytesToBigIntLE(challenge.N);
  const g = bytesToBigIntLE(challenge.g);
  const B = bytesToBigIntLE(challenge.B);
  const k = 3n;

  let a = 0n;
  let A = 0n;
  do {
    a = randomBigInt(19);
    A = modPow(g, a, N);
  } while (A % N === 0n);

  const ABytes = bigIntToBytesLE(A, 32);
  const authHash = await sha1(text.encode(`${account}:${password}`));
  const x = bytesToBigIntLE(await sha1(challenge.salt, authHash));
  const gx = modPow(g, x, N);
  const u = bytesToBigIntLE(await sha1(ABytes, challenge.B));
  const S = modPow(mod(B - k * gx, N), a + u * x, N);
  const SBytes = bigIntToBytesLE(S, 32);

  const even = new Uint8Array(16);
  const odd = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    even[i] = SBytes[i * 2];
    odd[i] = SBytes[i * 2 + 1];
  }

  const evenHash = await sha1(even);
  const oddHash = await sha1(odd);
  const K = new Uint8Array(40);
  for (let i = 0; i < 20; i++) {
    K[i * 2] = evenHash[i];
    K[i * 2 + 1] = oddHash[i];
  }

  const userHash = await sha1(text.encode(account));
  const Nh = await sha1(challenge.N);
  const gh = await sha1(challenge.g);
  const Ngh = new Uint8Array(20);
  for (let i = 0; i < 20; i++) Ngh[i] = Nh[i] ^ gh[i];

  const M1 = await sha1(Ngh, userHash, challenge.salt, ABytes, challenge.B, K);
  const M2 = await sha1(ABytes, M1, K);

  const packet = new Uint8Array(1 + 32 + 20 + 20 + 2);
  packet[0] = 0x01;
  packet.set(ABytes, 1);
  packet.set(M1, 33);
  // CRC hash remains zeroed for now.
  packet[73] = 0x00;
  packet[74] = 0x00;

  return { packet, M2, K };
}

function validateProofResponse(packet: Uint8Array, expectedM2: Uint8Array) {
  if (packet[0] !== 0x01) throw new Error(`unexpected proof opcode 0x${packet[0].toString(16)}`);
  const status = packet[1];
  if (status !== 0x00) throw new Error(`logon proof rejected: ${AUTH_STATUS[status] ?? `0x${status.toString(16)}`}`);
  const M2 = packet.slice(2, 22);
  if (M2.length !== 20 || M2.some((b, i) => b !== expectedM2[i])) throw new Error('server proof mismatch');
}

class Reader {
  offset: number;
  constructor(
    private readonly data: Uint8Array,
    offset = 0,
  ) {
    if (!Number.isInteger(offset) || offset < 0 || offset > data.length) {
      throw new Error(`auth packet reader offset ${offset} outside ${data.length} bytes`);
    }
    this.offset = offset;
  }

  private ensure(length: number) {
    if (this.offset + length > this.data.length) {
      throw new Error(`auth packet truncated at ${this.offset}, need ${length}, have ${this.data.length - this.offset}`);
    }
  }

  u8() {
    this.ensure(1);
    return this.data[this.offset++];
  }

  u16() {
    this.ensure(2);
    const v = this.data[this.offset] | (this.data[this.offset + 1] << 8);
    this.offset += 2;
    return v;
  }

  u32() {
    this.ensure(4);
    const v =
      this.data[this.offset] |
      (this.data[this.offset + 1] << 8) |
      (this.data[this.offset + 2] << 16) |
      (this.data[this.offset + 3] << 24);
    this.offset += 4;
    return v >>> 0;
  }

  f32() {
    this.ensure(4);
    const dv = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 4);
    this.offset += 4;
    return dv.getFloat32(0, true);
  }

  cstring() {
    const start = this.offset;
    while (this.offset < this.data.length && this.data[this.offset] !== 0) this.offset++;
    if (this.offset >= this.data.length) {
      throw new Error(`auth packet truncated at ${start}, unterminated string`);
    }
    const s = new TextDecoder('latin1').decode(this.data.slice(start, this.offset));
    this.offset++;
    return s;
  }
}

function parseRealmList(packet: Uint8Array): RealmInfo[] {
  if (packet[0] !== 0x10) throw new Error(`unexpected realm-list opcode 0x${packet[0].toString(16)}`);
  const r = new Reader(packet, 1);
  r.u16();
  r.u32();
  // 1.12 specification handling.
  // realm type/icon is uint32, and there is no explicit locked byte.
  const count = r.u8();
  const realms: RealmInfo[] = [];
  for (let i = 0; i < count; i++) {
    const icon = r.u32();
    const locked = false;
    const flags = r.u8();
    const name = r.cstring();
    const address = r.cstring();
    const population = r.f32();
    const characters = r.u8();
    const timezone = r.u8();
    const id = r.u8();
    const realm: RealmInfo = { id, name, address, icon, flags, locked, population, characters, timezone };
    realms.push(realm);
  }
  return realms;
}

export async function loginToRealm(
  proxyUrl: string,
  accountInput: string,
  passwordInput: string,
  progress: AuthProgress = () => {},
): Promise<AuthSession> {
  const account = accountInput.trim().toUpperCase();
  const password = passwordInput.toUpperCase();
  if (!account || !password) throw new Error('account and password are required');

  progress('connecting to realmd');
  const ws = await openSocket(proxyUrl);
  try {
    progress('sending challenge');
    ws.send(buildLogonChallenge(account));
    const challenge = parseChallenge(await readMessage(ws));

    progress('computing proof');
    const proof = await makeProof(challenge, account, password);
    ws.send(proof.packet);
    validateProofResponse(await readMessage(ws), proof.M2);

    progress('requesting realms');
    const realmRequest = new Uint8Array(5);
    realmRequest[0] = 0x10;
    ws.send(realmRequest);
    const realms = parseRealmList(await readMessage(ws));

    progress(`authenticated (${realms.length} realm${realms.length === 1 ? '' : 's'})`);
    return { account, sessionKey: proof.K, realms };
  } finally {
    ws.close();
  }
}
