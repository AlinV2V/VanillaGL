import path from 'node:path';
/** Asset conversion utility. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ClientArchiveSet } from '@vanillagl/assets';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { encodePng } from '../utils/png.ts';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const FRAMEXML_OUT = (process.env.DATA_SOURCE_DIR || path.join(process.cwd(), 'data'));
const UI_OUT = fileURLToPath(new URL('../../apps/client/public/ui/Interface', import.meta.url));
const SOUND_OUT = fileURLToPath(new URL('../../apps/client/public/sounds/Sound/interface', import.meta.url));

const PANEL_ART_DIRS = [
  'BankFrame', 'TradeFrame', 'TradeSkillFrame', 'ChatFrame', 'TalentFrame', 'TaxiFrame',
  // Added for the auction house / stable / guild-charter panels. The partially populated
  // wow_extracted\Interface\AuctionFrame folder only ever had 3 of these BLPs on disk, which is
  // why the panel art had to come straight out of interface.MPQ.
  // NB the stable art folder is `PetStableFrame`, not `PetStable` (which is the .lua/.xml name).
  'AuctionFrame', 'PetStableFrame', 'PetitionFrame', 'TabardFrame', 'PetPaperDollFrame',
  // ItemTextFrame.xml uses four material-specific quadrant overlays in addition to the shared
  // SpellBookFrame base art. Readable books/letters are unreachable without these native skins.
  'ItemTextFrame',
  // Blizzard_RaidUI.xml composes the 323x97 ready-check prompt from this authored frame.
  'RaidFrame',
  // FriendsFrame.xml composes the 297x298 Guild Control popup from MacroPopup quadrants.
  'MacroFrame',
];

async function main() {
  // Build 5875 resolves patch archives before interface.MPQ. Ready-check art and audio are both
  // patch-only in the supplied client, so a base-only extractor silently misses shipped assets.
  const archive = await ClientArchiveSet.open(CACHE, ['interface.MPQ']);
  const list = (mask: string) => {
    const seen = new Set<string>();
    return archive.all.flatMap((owner) => owner.list(mask)).filter((path) => {
      const key = path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  mkdirSync(FRAMEXML_OUT, { recursive: true });
  const frameXml = list('Interface\\FrameXML\\*');
  let wrote = 0;
  let kept = 0;
  for (const path of frameXml) {
    const name = path.split('\\').pop()!;
    const dest = `${FRAMEXML_OUT}\\${name}`;
    if (existsSync(dest)) {
      kept++;
      continue;
    }
    writeFileSync(dest, archive.extract(path));
    wrote++;
  }
  console.log(`FrameXML: ${wrote} extracted, ${kept} already present (${frameXml.length} in archive).`);

  for (const dir of PANEL_ART_DIRS) {
    const files = list(`Interface\\${dir}\\*.blp`);
    if (!files.length) {
      console.warn(`No BLPs found for Interface\\${dir}`);
      continue;
    }
    const outDir = `${UI_OUT}/${dir}`;
    mkdirSync(outDir, { recursive: true });
    let converted = 0;
    for (const path of files) {
      const name = path.split('\\').pop()!.replace(/\.blp$/i, '.png');
      try {
        const blp = new Blp().load(archive.extract(path));
        const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
        writeFileSync(`${outDir}/${name}`, encodePng(img.width, img.height, img.data));
        converted++;
      } catch (error) {
        console.error(`Failed ${path}: ${(error as Error).message}`);
      }
    }
    console.log(`${dir}: ${converted}/${files.length} BLPs converted -> ${outDir}`);
  }
  mkdirSync(SOUND_OUT, { recursive: true });
  writeFileSync(`${SOUND_OUT}/ReadyCheck.wav`, archive.extract('Sound\\interface\\ReadyCheck.wav'));
  console.log(`ReadyCheck.wav extracted -> ${SOUND_OUT}`);
  archive.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
