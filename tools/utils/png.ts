/** Asset conversion utility. */
import { deflateSync, inflateSync } from 'node:zlib';

/** Decode the non-interlaced RGBA8 PNGs written by our terrain baker, including all PNG filters. */
export function decodeRgbaPng(bytes: Buffer): { width: number; height: number; data: Uint8Array } {
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid PNG signature');
  let width = 0, height = 0; const chunks: Buffer[] = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset + length + 12 > bytes.length) throw new Error('Truncated PNG chunk');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('Expected non-interlaced RGBA8 PNG');
    } else if (type === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  if (!width || !height || width * height > 64_000_000) throw new Error('Invalid PNG dimensions');
  const stride = width * 4, raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * height });
  if (raw.length !== (stride + 1) * height) throw new Error('Invalid PNG payload length');
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error('Invalid PNG filter');
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x, left = x >= 4 ? data[i - 4] : 0, up = y ? data[i - stride] : 0;
      const corner = y && x >= 4 ? data[i - stride - 4] : 0, p = left + up - corner;
      const a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3
        ? Math.floor((left + up) / 2) : a <= b && a <= c ? left : b <= c ? up : corner;
      data[i] = raw[y * (stride + 1) + x + 1] + predictor;
    }
  }
  return { width, height, data };
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode 8-bit RGBA pixel data (width*height*4 bytes) into a PNG buffer. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);

  // Prepend a "none" filter byte to each scanline.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    src.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // ihdr[10..12] = 0 (compression/filter/interlace)

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
