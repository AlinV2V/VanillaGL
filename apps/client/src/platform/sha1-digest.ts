function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

const rotateLeft = (value: number, bits: number) => (value << bits) | (value >>> (32 - bits));

/** SHA-1 used only when WebCrypto is unavailable, notably Safari on an HTTP LAN origin. */
export function sha1DigestFallback(data: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil((data.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(data);
  padded[data.byteLength] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(data.byteLength / 0x20000000), false);
  view.setUint32(paddedLength - 4, (data.byteLength << 3) >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Uint32Array(80);

  for (let block = 0; block < paddedLength; block += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(block + i * 4, false);
    for (let i = 16; i < 80; i++) words[i] = rotateLeft(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1) >>> 0;

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const next = (rotateLeft(a, 5) + f + e + k + words[i]) >>> 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30) >>> 0;
      b = a;
      a = next;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const digest = new Uint8Array(20);
  const digestView = new DataView(digest.buffer);
  [h0, h1, h2, h3, h4].forEach((value, index) => digestView.setUint32(index * 4, value, false));
  return digest;
}

export async function sha1Digest(...parts: Uint8Array[]): Promise<Uint8Array> {
  const data = concatenate(parts);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      return new Uint8Array(await subtle.digest('SHA-1', Uint8Array.from(data)));
    } catch {
      // A few WebViews expose subtle but reject digest on an insecure origin.
    }
  }
  return sha1DigestFallback(data);
}
