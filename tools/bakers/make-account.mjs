/** Asset conversion utility. */
import crypto from 'node:crypto';

const N = 0x894b645e89e1535bbdad5b8b290650530801b18ebfbf5e8fab3c82872a3e9bb7n;
const g = 7n;

const USER = (process.argv[2] || 'TESTBOT').toUpperCase();
const PASS = (process.argv[3] || 'Test123!').toUpperCase();

const sha1 = (...bufs) => {
  const h = crypto.createHash('sha1');
  for (const b of bufs) h.update(b);
  return h.digest();
};
const leToBig = (buf) => {
  let n = 0n;
  for (let i = buf.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(buf[i]);
  return n;
};
const bigToBE = (n, len) => {
  let h = n.toString(16);
  if (h.length % 2) h = '0' + h;
  let b = Buffer.from(h, 'hex');
  if (len && b.length < len) b = Buffer.concat([Buffer.alloc(len - b.length), b]);
  return b;
};
const modpow = (base, exp, mod) => {
  let r = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return r;
};

// S = the salt bytes the client receives (vMaNGOS BigNumber::AsByteArray = little-endian).
const S = crypto.randomBytes(32);
const sStored = Buffer.from(S).reverse().toString('hex').toUpperCase(); // BigNumber::AsHexStr (big-endian)
const I = sha1(Buffer.from(`${USER}:${PASS}`, 'latin1'));
const x = leToBig(sha1(S, I)); // x = H(salt, H(U:P))
const v = modpow(g, x, N);
const vStored = bigToBE(v, 32).toString('hex').toUpperCase();

console.log('USER     :', USER);
console.log('PASS     :', PASS);
console.log('s (hex)  :', sStored, `(${sStored.length})`);
console.log('v (hex)  :', vStored, `(${vStored.length})`);
console.log('SQL      :');
console.log(
  `REPLACE INTO realmd.account (username, v, s, expansion, locale, gmlevel) VALUES ('${USER}','${vStored}','${sStored}', 0, 0, 0);`,
);
