import path from 'node:path';
import { writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { encodePng } from '../utils/png.ts';

const TARGET_DIR = path.join(process.cwd(), path.join(process.cwd(), 'apps/client/public/login/textures'));

// Directly copy PNGs
const pngCopies = [
  { src: (process.env.DATA_SOURCE_DIR || path.join(process.cwd(), 'data/converted_textures/extract_live_fx/Creature/FireElemental/GlowBall.png')), dst: 'GLOWBALL.png' },
  { src: (process.env.DATA_SOURCE_DIR || path.join(process.cwd(), 'data/converted_textures/extract_live_fx/Particles/Dust3x.png')), dst: 'DUST3X.png' }
];

pngCopies.forEach(({ src, dst }) => {
  if (existsSync(src)) {
    console.log(`Copying PNG: ${src} -> ${dst}`);
    copyFileSync(src, `${TARGET_DIR}/${dst}`);
  } else {
    console.warn(`Source PNG not found: ${src}`);
  }
});

// Convert BLPs
const blpPairs = [
  { src: (process.env.DATA_SOURCE_DIR || path.join(process.cwd(), 'data/textures/World/Generic/Goblin/PassiveDoodads/GoblinMachinery/Dust7Alpha.blp')), dst: 'DUST7ALPHA.png' },
  { src: (process.env.DATA_SOURCE_DIR || path.join(process.cwd(), 'data_login/Interface/Glues/Models/UI_Scourge/MM_clouds_02.blp')), dst: 'MM_CLOUDS_02.png' }
];

blpPairs.forEach(({ src, dst }) => {
  if (existsSync(src)) {
    try {
      console.log(`Converting BLP: ${src} -> ${dst}`);
      const blpData = readFileSync(src);
      const blp = new Blp().load(blpData);
      const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
      writeFileSync(`${TARGET_DIR}/${dst}`, encodePng(img.width, img.height, img.data));
    } catch (err: any) {
      console.error(`Error converting ${src}:`, err.message);
    }
  } else {
    console.warn(`Source BLP not found: ${src}`);
  }
});
