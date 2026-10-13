/** Asset conversion utility. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { ClientArchiveSet, DbcFile, MpqArchive, openClientArchive, openClientArchives, readVanillaM2 } from '@vanillagl/assets';
import { encodePng } from '../utils/png.ts';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const OUT = fileURLToPath(new URL('../../apps/client/public/characters', import.meta.url));

const RACES: Record<number, string> = {
  1: 'Human',
  2: 'Orc',
  3: 'Dwarf',
  4: 'NightElf',
  5: 'Scourge',
  6: 'Tauren',
  7: 'Gnome',
  8: 'Troll',
};

const GENDERS: Record<number, string> = { 0: 'Male', 1: 'Female' };

type SectionRow = {
  base: number;
  variation: number;
  color: number;
  textures: (string | null)[];
};

type HairGeoset = {
  variation: number;
  geoset: number;
  showsScalp: boolean;
};

type FacialHairGeoset = {
  variation: number;
  geosets: number[];
};

function modelPath(race: string, gender: string) {
  return `Character\\${race}\\${gender}\\${race}${gender}.m2`;
}

function keyFor(race: number, gender: number) {
  return `${race}_${gender}`;
}

function cleanPath(name: string) {
  return name.replace(/\//g, '\\').replace(/\0/g, '').trim();
}

function decodeBlp(mpq: MpqArchive, name: string) {
  const blp = new Blp().load(mpq.extract(name));
  return blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
}

function resolveTextureFile(
  name: string,
  archives: MpqArchive[],
  outDir: string,
  prefix: string,
  files: string[],
  cache: Map<string, string>,
): string | null {
  const clean = cleanPath(name);
  if (!clean || !clean.toLowerCase().endsWith('.blp')) return null;

  const cached = cache.get(clean);
  if (cached) return cached;

  for (const mpq of archives) {
    if (!mpq.has(clean)) continue;
    try {
      const img = decodeBlp(mpq, clean);
      const rel = `${prefix}/${files.length}.png`;
      writeFileSync(`${outDir}/${rel}`, encodePng(img.width, img.height, img.data));
      files.push(rel);
      cache.set(clean, rel);
      return rel;
    } catch {
      return null;
    }
  }

  return null;
}

function resolveEmbeddedTexture(name: string, archives: MpqArchive[], outDir: string, files: string[]) {
  const resolved = resolveTextureFile(name, archives, outDir, 'tex', files, new Map());
  return resolved ? files.indexOf(resolved) : -1;
}

function readSections(dbc: DbcFile, race: number, gender: number, archives: MpqArchive[], outDir: string): SectionRow[] {
  // Character section fields use the build-specific layout expected by this baker.
  const FIELD = { section: 3, variation: 4, color: 5, texture1: 6 } as const;
  const files: string[] = [];
  const fileCache = new Map<string, string>();
  mkdirSync(`${outDir}/components`, { recursive: true });

  const rows: SectionRow[] = [];
  for (let i = 0; i < dbc.recordCount; i++) {
    if (dbc.getUint(i, 1) !== race || dbc.getUint(i, 2) !== gender) continue;

    const base = dbc.getUint(i, FIELD.section);
    if (base > 4) continue;

    rows.push({
      base,
      variation: dbc.getUint(i, FIELD.variation),
      color: dbc.getUint(i, FIELD.color),
      textures: [FIELD.texture1, FIELD.texture1 + 1, FIELD.texture1 + 2].map((field) => resolveTextureFile(dbc.getString(i, field), archives, outDir, 'components', files, fileCache)),
    });
  }

  return rows;
}

function readHairGeosets(dbc: DbcFile, race: number, gender: number): HairGeoset[] {
  const rows: HairGeoset[] = [];
  for (let i = 0; i < dbc.recordCount; i++) {
    if (dbc.getUint(i, 1) !== race || dbc.getUint(i, 2) !== gender) continue;
    rows.push({
      variation: dbc.getUint(i, 3),
      geoset: dbc.getUint(i, 4),
      showsScalp: dbc.getUint(i, 5) !== 0,
    });
  }
  return rows;
}

function readFacialHairGeosets(dbc: DbcFile, race: number, gender: number): FacialHairGeoset[] {
  const rows: FacialHairGeoset[] = [];
  for (let i = 0; i < dbc.recordCount; i++) {
    if (dbc.getUint(i, 0) !== race || dbc.getUint(i, 1) !== gender) continue;

    // Geoset columns use the non-sequential group order [100, 300, 200] to preserve valid geometry.
    const groups = [100, 300, 200];
    const geosets = [6, 7, 8]
      .map((field, index) => ({ value: dbc.getUint(i, field), group: groups[index] }))
      .filter(({ value }) => value > 0 && value < 100)
      .map(({ value, group }) => group + value);

    rows.push({ variation: dbc.getUint(i, 2), geosets });
  }
  return rows;
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  // Resolve archives patch-first so updated assets override their base versions.
  const archives = await openClientArchives(CACHE, ['model.MPQ', 'texture.MPQ', 'dbc.MPQ']);
  const client = new ClientArchiveSet(archives);
  // Read schema tables from the base archive while model and texture assets remain patch-aware.
  const dbcBase = await openClientArchive(CACHE, 'dbc.MPQ');

  const charSections = new DbcFile(dbcBase.extract('DBFilesClient\\CharSections.dbc'));
  const charHairGeosets = new DbcFile(dbcBase.extract('DBFilesClient\\CharHairGeosets.dbc'));
  const facialHairStyles = new DbcFile(dbcBase.extract('DBFilesClient\\CharacterFacialHairStyles.dbc'));

  for (const [raceIdText, raceName] of Object.entries(RACES)) {
    for (const [genderIdText, genderName] of Object.entries(GENDERS)) {
      const raceId = Number(raceIdText);
      const genderId = Number(genderIdText);
      const key = keyFor(raceId, genderId);
      const outDir = `${OUT}/${key}`;
      mkdirSync(outDir, { recursive: true });
      mkdirSync(`${outDir}/tex`, { recursive: true });

      const path = modelPath(raceName, genderName);
      if (!client.has(path)) {
        console.log(`missing ${path}`);
        continue;
      }

      const m = readVanillaM2(client.extract(path));
      const textureFiles: string[] = [];
      const textureSlots = m.textures.map((slot) => ({
        type: slot.type,
        flags: slot.flags,
        filename: slot.filename,
        file: slot.type === 0 ? resolveEmbeddedTexture(slot.filename, archives, outDir, textureFiles) : -1,
      }));

      const fallbackSubmesh = {
        partId: 0,
        triangleStart: 0,
        triangleCount: m.indices.length,
        textureIndex: 0,
        boneCount: 0,
        boneComboIndex: 0,
        boneInfluences: 0,
        centerBoneIndex: 0,
        renderFlags: 0,
        blendMode: 0,
      };
      const parts = (m.submeshes.length ? m.submeshes : [fallbackSubmesh])
        .filter((sub) => sub.triangleCount > 0 && sub.triangleStart + sub.triangleCount <= m.indices.length)
        .map((sub) => {
          const slot = textureSlots[sub.textureIndex];
          return {
            partId: sub.partId,
            boneCount: sub.boneCount,
            boneComboIndex: sub.boneComboIndex,
            boneInfluences: sub.boneInfluences,
            centerBoneIndex: sub.centerBoneIndex,
            textureIndex: sub.textureIndex,
            textureType: slot?.type ?? -1,
            tex: slot?.file ?? -1,
            blendMode: sub.blendMode,
            renderFlags: sub.renderFlags,
            indices: Array.from(m.indices.subarray(sub.triangleStart, sub.triangleStart + sub.triangleCount)),
          };
        });

      const json = {
        race: raceId,
        gender: genderId,
        source: path,
        positions: Array.from(m.positions),
        normals: Array.from(m.normals),
        uvs: Array.from(m.uvs),
        boneWeights: Array.from(m.boneWeights),
        boneIndices: Array.from(m.boneIndices),
        parts,
        textures: textureFiles,
        textureSlots,
        appearance: {
          sections: readSections(charSections, raceId, genderId, archives, outDir),
          hairGeosets: readHairGeosets(charHairGeosets, raceId, genderId),
          facialHairGeosets: readFacialHairGeosets(facialHairStyles, raceId, genderId),
        },
        sequences: m.sequences,
        globalSequences: m.globalSequences,
        animLookup: Array.from(m.animLookup),
        bones: m.bones,
        attachments: m.attachments,
        cameras: m.cameras,
      };

      writeFileSync(`${outDir}/model.json`, JSON.stringify(json));
      console.log(
        `${key}: ${path} verts=${m.vertexCount} parts=${parts.length} slots=${textureSlots.length} ` +
          `sections=${json.appearance.sections.length} bones=${m.bones.length} anims=${m.sequences.length}`,
      );
    }
  }

  client.close();
  dbcBase.close();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
