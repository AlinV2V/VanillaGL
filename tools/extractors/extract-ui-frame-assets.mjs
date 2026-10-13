import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';

const SRC_ROOT = (process.env.EXTRACTED_INTERFACE_DIR || path.join(process.cwd(), 'data/extracted/Interface'));
const DST_ROOT = path.join(process.cwd(), path.join(process.cwd(), 'apps/client/public/ui/Interface'));

const DIRS = [
  'Buttons',
  'CharacterFrame',
  'ClassTrainerFrame',
  'ContainerFrame',
  'Cursor',
  'GossipFrame',
  'Icons',
  'LootFrame',
  'MerchantFrame',
  'MoneyFrame',
  'PaperDoll',
  'PaperDollInfoFrame',
  'QuestFrame',
  'SpellBook',
  'FriendsFrame',
  'MainMenuBar',
  'TargetingFrame',
  'Tooltips',
];

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    src.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (/\.blp$/i.test(entry.name)) out.push(full);
  }
  return out;
}

let converted = 0;
for (const dir of DIRS) {
  const srcDir = path.join(SRC_ROOT, dir);
  if (!existsSync(srcDir)) continue;
  const files = await walk(srcDir);
  for (const file of files) {
    const rel = path.relative(SRC_ROOT, file);
    const dst = path.join(DST_ROOT, rel).replace(/\.blp$/i, '.png');
    const blp = new Blp().load(new Uint8Array(await readFile(file)));
    const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
    await mkdir(path.dirname(dst), { recursive: true });
    await writeFile(dst, encodePng(img.width, img.height, img.data));
    converted++;
  }
}

console.log(`Converted ${converted} Vanilla UI BLP assets to ${DST_ROOT}`);
