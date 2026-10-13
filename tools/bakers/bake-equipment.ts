/** Asset conversion utility. */
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { ClientArchiveSet, openClientArchive, openClientArchives, DbcFile, MpqArchive, readVanillaM2 } from '@vanillagl/assets';
import { encodePng } from '../utils/png.ts';
import { bakeCapeTexture } from '../utils/equipment-cape-texture.ts';

const BS = String.fromCharCode(92);
const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../../apps/client/public/equipment', import.meta.url));
let patches: MpqArchive[] = [];
let textureSet: ClientArchiveSet;
let modelSet: ClientArchiveSet;

// ItemDisplayInfo component fields -> the texture-component directory in the MPQ.
const COMPONENTS = [
  { field: 14, key: 'armUpper', dir: 'ArmUpperTexture' },
  { field: 15, key: 'armLower', dir: 'ArmLowerTexture' },
  { field: 16, key: 'hand', dir: 'HandTexture' },
  { field: 17, key: 'torsoUpper', dir: 'TorsoUpperTexture' },
  { field: 18, key: 'torsoLower', dir: 'TorsoLowerTexture' },
  { field: 19, key: 'legUpper', dir: 'LegUpperTexture' },
  { field: 20, key: 'legLower', dir: 'LegLowerTexture' },
  { field: 21, key: 'foot', dir: 'FootTexture' },
] as const;

const GENDER_SUFFIX = ['M', 'F'];
const ATTACHMENT_JOINT: Record<string, number> = {
  helmet: 11,
  shoulderL: 6,
  shoulderR: 5,
  mainHand: 1,
  offHand: 2,
  shield: 0,
  holdable: 2,
  ranged: 1,
  projectile: 0,
};
const HELMET_RACES = [
  { race: 1, code: 'Hu' },
  { race: 2, code: 'Or' },
  { race: 3, code: 'Dw' },
  { race: 4, code: 'Ni' },
  { race: 5, code: 'Sc' },
  { race: 6, code: 'Ta' },
  { race: 7, code: 'Gn' },
  { race: 8, code: 'Tr' },
] as const;

function findComponentBlp(texture: MpqArchive, dir: string, name: string, gender: number): string | null {
  // Try gender-specific, then unisex, then bare. Component path: Item\TextureComponents\<dir>\<name>_<g>.blp
  const candidates = [`${name}_${GENDER_SUFFIX[gender]}`, `${name}_U`, name];
  for (const c of candidates) {
    const path = ['Item', 'TextureComponents', dir, `${c}.blp`].join(BS);
    if (textureSet.has(path)) return path;
  }
  return null;
}

function baseName(name: string): string {
  return name.replace(/\//g, BS).split(BS).pop() ?? name;
}

function modelFile(name: string, side?: 'L' | 'R'): string {
  let stem = baseName(name).replace(/\.(mdx|mdl|m2)$/i, '');
  if (side && !/^LShoulder_/i.test(stem) && !/^RShoulder_/i.test(stem) && !/_[LR]$/i.test(stem)) {
    stem = `${stem}_${side}`;
  }
  return `${stem}.m2`;
}

function objectComponentDirs(kind: string): string[] {
  switch (kind) {
    case 'helmet': return ['Head'];
    case 'shoulderL':
    case 'shoulderR':
      return ['Shoulder'];
    case 'shield': return ['Shield'];
    case 'holdable': return ['HeldInOffHand', 'Weapon'];
    case 'projectile': return ['Ammo'];
    case 'mainHand':
    case 'offHand':
    case 'ranged':
      return ['Weapon'];
    default:
      return ['Weapon'];
  }
}

function archiveExtract(archives: MpqArchive[], path: string): Uint8Array | null {
  for (const archive of archives) {
    if (archive.has(path)) return archive.extract(path);
  }
  return null;
}

function findItemBlp(archives: MpqArchive[], dirs: string[], name: string): string | null {
  if (!name) return null;
  const normalized = name.replace(/\//g, BS);
  const stem = normalized.replace(/\.(blp|tga)$/i, '');
  const candidates = normalized.includes(BS)
    ? [`${stem}.blp`]
    : dirs.map((dir) => ['Item', 'ObjectComponents', dir, `${stem}.blp`].join(BS));
  for (const candidate of candidates) {
    if (archives.some((archive) => archive.has(candidate))) return candidate;
  }
  return null;
}

function writeAttachmentTexture(
  archives: MpqArchive[],
  dirs: string[],
  outDir: string,
  prefix: string,
  textureFiles: string[],
  textureCache: Map<string, number>,
  name: string,
): number {
  const path = findItemBlp(archives, dirs, name);
  if (!path) return -1;
  const cached = textureCache.get(path);
  if (cached !== undefined) return cached;
  try {
    const bytes = archiveExtract(archives, path);
    if (!bytes) return -1;
    const blp = new Blp().load(bytes);
    const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
    const file = `${prefix}_tex_${textureFiles.length}.png`;
    writeFileSync(`${outDir}${BS}${file}`, encodePng(img.width, img.height, img.data));
    const index = textureFiles.length;
    textureFiles.push(file);
    textureCache.set(path, index);
    return index;
  } catch {
    return -1;
  }
}

function bakeAttachmentModel(
  kind: keyof typeof ATTACHMENT_JOINT,
  file: string,
  textureNames: string[],
  model: MpqArchive,
  texture: MpqArchive,
  outDir: string,
  assetStem = kind,
  extra: Record<string, number> = {},
): { kind: string; jointId: number; asset: string; source: string; race?: number; gender?: number; inventoryTypes?: number[] } | null {
  const dirs = objectComponentDirs(kind);
  const dir = dirs.find((candidate) => modelSet.has(['Item', 'ObjectComponents', candidate, file].join(BS)));
  if (!dir) return null;
  const path = ['Item', 'ObjectComponents', dir, file].join(BS);

  try {
    const m = readVanillaM2(modelSet.extract(path));
    const textureFiles: string[] = [];
    const textureCache = new Map<string, number>();
    const archives = [...patches, texture, model];
    const slotTex = m.textures.map((slot, index) => {
      const override = textureNames[Math.min(index, textureNames.length - 1)] ?? textureNames[0] ?? '';
      const name = slot.type === 0 && slot.filename ? slot.filename : override;
      return writeAttachmentTexture(archives, dirs, outDir, kind, textureFiles, textureCache, name);
    });
    if (!slotTex.length && textureNames.length) {
      slotTex.push(writeAttachmentTexture(archives, dirs, outDir, kind, textureFiles, textureCache, textureNames[0]));
    }

    const fallbackSubmesh = {
      partId: 0,
      triangleStart: 0,
      triangleCount: m.indices.length,
      textureIndex: 0,
      renderFlags: 0,
      blendMode: 0,
    };
    const parts = (m.submeshes.length ? m.submeshes : [fallbackSubmesh])
      .filter((sub) => sub.triangleCount > 0 && sub.triangleStart + sub.triangleCount <= m.indices.length)
      .map((sub) => ({
        partId: sub.partId,
        textureIndex: sub.textureIndex,
        tex: slotTex[sub.textureIndex] ?? -1,
        blendMode: sub.blendMode ?? 0,
        renderFlags: sub.renderFlags ?? 0,
        indices: Array.from(m.indices.subarray(sub.triangleStart, sub.triangleStart + sub.triangleCount)),
      }));
    if (!parts.length) return null;

    const asset = `${assetStem}.json`;
    writeFileSync(`${outDir}${BS}${asset}`, JSON.stringify({
      kind,
      jointId: ATTACHMENT_JOINT[kind],
      source: path,
      positions: Array.from(m.positions),
      normals: Array.from(m.normals),
      uvs: Array.from(m.uvs),
      textures: textureFiles,
      parts,
    }));
    return { kind, jointId: ATTACHMENT_JOINT[kind], asset, source: path, ...extra };
  } catch {
    return null;
  }
}

function bakeAttachmentModels(
  models: string[],
  modelTextures: string[],
  gender: number,
  model: MpqArchive,
  texture: MpqArchive,
  outDir: string,
): Array<{ kind: string; jointId: number; asset: string; source: string; race?: number; gender?: number; inventoryTypes?: number[] }> {
  const attachments: Array<{ kind: string; jointId: number; asset: string; source: string; race?: number; gender?: number; inventoryTypes?: number[] }> = [];
  const hasShoulder = models.some((name) => /shoulder/i.test(name));
  const firstFile = models[0] ? modelFile(models[0]) : '';
  const secondFile = models[1] ? modelFile(models[1]) : '';
  // Build 5875 ItemDisplayInfo 5996/5998 author their in-flight Arrow/Bullet model in slot 2
  // under Item\ObjectComponents\Ammo. vMaNGOS writes that display id and INVTYPE_AMMO into
  // SMSG_SPELL_START/GO whenever CAST_FLAG_AMMO is set (Spell.cpp::WriteAmmoToPacket).
  const projectileFile = [firstFile, secondFile]
    .find((file) => !!file && modelSet.has(['Item', 'ObjectComponents', 'Ammo', file].join(BS)));
  if (projectileFile) {
    const textureIndex = projectileFile === secondFile ? 1 : 0;
    const projectile = bakeAttachmentModel(
      'projectile',
      projectileFile,
      [modelTextures[textureIndex]].filter(Boolean),
      model,
      texture,
      outDir,
      'projectile',
    );
    if (projectile) attachments.push({ ...projectile, inventoryTypes: [24] });
  } else if (firstFile && modelSet.has(['Item', 'ObjectComponents', 'Shield', firstFile].join(BS))) {
    const shield = bakeAttachmentModel('shield', firstFile, [modelTextures[0], modelTextures[1]].filter(Boolean), model, texture, outDir, 'shield');
    if (shield) attachments.push({ ...shield, inventoryTypes: [14] });
  } else if (firstFile && modelSet.has(['Item', 'ObjectComponents', 'HeldInOffHand', firstFile].join(BS))) {
    const held = bakeAttachmentModel('holdable', firstFile, [modelTextures[0], modelTextures[1]].filter(Boolean), model, texture, outDir, 'holdable');
    if (held) attachments.push({ ...held, inventoryTypes: [23] });
  } else if (firstFile && modelSet.has(['Item', 'ObjectComponents', 'Weapon', firstFile].join(BS))) {
    const weapon = bakeAttachmentModel('mainHand', firstFile, [modelTextures[0], modelTextures[1]].filter(Boolean), model, texture, outDir, 'weapon');
    if (weapon) {
      attachments.push({ ...weapon, kind: 'mainHand', jointId: ATTACHMENT_JOINT.mainHand, inventoryTypes: [13, 17, 21] });
      attachments.push({ ...weapon, kind: 'offHand', jointId: ATTACHMENT_JOINT.offHand, inventoryTypes: [22] });
      attachments.push({ ...weapon, kind: 'ranged', jointId: ATTACHMENT_JOINT.ranged, inventoryTypes: [15, 25, 26] });
    }
  } else if (hasShoulder) {
    const left = models.find((name) => /^LShoulder_/i.test(baseName(name))) ?? models[0];
    const right = models.find((name) => /^RShoulder_/i.test(baseName(name))) ?? models[1] ?? models[0];
    const leftAttachment = bakeAttachmentModel('shoulderL', modelFile(left, 'L'), [modelTextures[0], modelTextures[1]].filter(Boolean), model, texture, outDir);
    const rightAttachment = bakeAttachmentModel('shoulderR', modelFile(right, 'R'), [modelTextures[1] ?? modelTextures[0]].filter(Boolean), model, texture, outDir);
    if (leftAttachment) attachments.push(leftAttachment);
    if (rightAttachment) attachments.push(rightAttachment);
  } else if (models[0]) {
    const stem = baseName(models[0]).replace(/\.(mdx|mdl|m2)$/i, '');
    for (const { race, code } of HELMET_RACES) {
      const suffix = `${code}${GENDER_SUFFIX[gender]}`;
      const helmet = bakeAttachmentModel(
        'helmet',
        `${stem}_${suffix}.m2`,
        [modelTextures[0]].filter(Boolean),
        model,
        texture,
        outDir,
        `helmet_${suffix}`,
        { race, gender },
      );
      if (helmet) attachments.push(helmet);
    }
  }
  return attachments;
}

async function main() {
  mkdirSync(PUBLIC, { recursive: true });
  const dbc = await openClientArchive(CACHE, 'dbc.MPQ');
  const texture = await openClientArchive(CACHE, 'texture.MPQ');
  const model = await openClientArchive(CACHE, 'model.MPQ');
  // Patch archives shadow the base ones (11,470 files in patch.MPQ alone). Array scans get `patches`
  // prepended; direct handle reads go through a patch-first set. See @vanillagl/assets.
  patches = await openClientArchives(CACHE, []);
  // The patched Build-5875 ItemDisplayInfo keeps the base table's exact 23-field/92-byte layout but
  // adds 5,752 records (including Onyxia-era displays above base id 29059). It must therefore use
  // the same patch-first resolution as the referenced models and textures.
  const dbcSet = new ClientArchiveSet([...patches, dbc]);
  textureSet = new ClientArchiveSet([...patches, texture]);
  modelSet = new ClientArchiveSet([...patches, model]);
  const info = new DbcFile(dbcSet.extract(['DBFilesClient', 'ItemDisplayInfo.dbc'].join(BS)));
  const helmetVis = new DbcFile(dbcSet.extract(['DBFilesClient', 'HelmetGeosetVisData.dbc'].join(BS)));
  const helmetVisById = new Map<number, { id: number; hair: number; beard: number; ears: number; horns: number; extra: number }>();
  for (let i = 0; i < helmetVis.recordCount; i++) {
    const id = helmetVis.getUint(i, 0);
    helmetVisById.set(id, {
      id,
      hair: helmetVis.getUint(i, 1),
      beard: helmetVis.getUint(i, 2),
      ears: helmetVis.getUint(i, 3),
      horns: helmetVis.getUint(i, 4),
      extra: helmetVis.getUint(i, 5),
    });
  }

  const raw = (process.env.DISPLAY_IDS ?? '').trim();
  let ids: number[];
  let genders: number[] = process.env.GENDER ? [Number(process.env.GENDER)] : [0, 1];
  if (raw && raw.toLowerCase() === 'all') {
    ids = [];
    for (let i = 0; i < info.recordCount; i++) ids.push(info.getUint(i, 0));
  } else {
    ids = raw.split(',').map((v) => Number(v.trim())).filter(Number.isFinite);
  }
  if (!ids.length) {
    console.log('no DISPLAY_IDS given (use DISPLAY_IDS=389,390 or =all)');
    dbc.close(); texture.close(); model.close();
    return;
  }

  // index records by display id
  const rowById = new Map<number, number>();
  for (let i = 0; i < info.recordCount; i++) rowById.set(info.getUint(i, 0), i);

  const force = process.env.FORCE === '1';
  let baked = 0, skipped = 0, missing = 0;
  for (const id of ids) {
    const row = rowById.get(id);
    if (row === undefined) { missing++; continue; }
    const geosetGroups = [6, 7, 8].map((f) => info.getUint(row, f));
    const geoset = {
      group1: geosetGroups[0],
      group2: geosetGroups[1],
      group3: geosetGroups[2],
      helmetVisMale: info.fieldCount > 12 ? info.getUint(row, 12) : 0,
      helmetVisFemale: info.fieldCount > 13 ? info.getUint(row, 13) : 0,
    };
    const models = [1, 2].map((f) => info.getString(row, f)).filter(Boolean);
    const modelTextures = [3, 4].map((f) => info.getString(row, f)).filter(Boolean);
    for (const gender of genders) {
      const outDir = `${PUBLIC}${BS}${id}_${gender}`;
      if (!force && existsSync(`${outDir}${BS}info.json`)) { skipped++; continue; }
      const components: Record<string, string> = {};
      for (const comp of COMPONENTS) {
        const name = info.getString(row, comp.field);
        if (!name) continue;
        const path = findComponentBlp(texture, comp.dir, name, gender);
        if (!path) continue;
        try {
          const blp = new Blp().load(textureSet.extract(path));
          const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
          mkdirSync(outDir, { recursive: true });
          writeFileSync(`${outDir}${BS}${comp.key}.png`, encodePng(img.width, img.height, img.data));
          components[comp.key] = `${comp.key}.png`;
        } catch { /* skip unreadable component */ }
      }
      mkdirSync(outDir, { recursive: true });
      const capeTexture = !models.length ? bakeCapeTexture([...patches, texture], outDir, modelTextures[0] ?? '') : null;
      const attachments = bakeAttachmentModels(models, modelTextures, gender, model, texture, outDir);
      if (!Object.keys(components).length && !models.length && !attachments.length && !capeTexture) {
        // The mkdirs above run before we know whether this display has any art, so an entry with no
        // components, models or attachments left an empty directory behind — 8599 of 47704 (18%) of
        // them in the last full bake. The client treats a missing info.json as "no custom art" and
        // renders the item plainly, so these were harmless, but they made the corpus look like it
        // had thousands of half-finished bakes. rmdirSync only removes an empty directory, so a
        // directory that legitimately holds art from another pass is left untouched.
        try { rmdirSync(outDir); } catch { /* not empty, or already gone — either way, leave it */ }
        continue;
      }
      const helmetVisId = gender === 0 ? geoset.helmetVisMale : geoset.helmetVisFemale;
      const helmetGeosetVis = helmetVisById.get(helmetVisId) ?? null;
      writeFileSync(`${outDir}${BS}info.json`, JSON.stringify({ displayId: id, gender, geoset, helmetGeosetVis, geosetGroups, models, modelTextures, capeTexture, components, attachments }));
      baked++;
      console.log(`${id}_${gender}: ${Object.keys(components).join(',') || '(no body tex)'} geosets=[${geosetGroups}] models=[${models.join(',')}] attachments=[${attachments.map((a) => a.kind).join(',')}]`);
    }
  }
  // Incremental reruns may bake zero new rows while retaining a complete existing corpus. Reporting
  // only `baked` erased truthful coverage (manifest count 0 beside 39k valid display directories).
  const complete = readdirSync(PUBLIC, { withFileTypes: true }).filter((entry) => entry.isDirectory()
    && /^\d+_[01]$/.test(entry.name) && existsSync(`${PUBLIC}${BS}${entry.name}${BS}info.json`)).length;
  writeFileSync(`${PUBLIC}${BS}manifest.json`, JSON.stringify({ count: complete, baked, skipped, missing }, null, 2));
  console.log(`complete=${complete} baked=${baked} skipped=${skipped} missing=${missing} -> ${PUBLIC}`);
  dbc.close();
  texture.close();
  model.close();
  for (const patch of patches) patch.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
