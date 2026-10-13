/** Extract Vanilla audio and build the runtime SoundEntries/world routing manifest. */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientArchiveSet, DbcFile, openClientArchive } from '@vanillagl/assets';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CACHE = join(ROOT, '.client-cache');
const PUBLIC = join(ROOT, 'apps', 'client', 'public');
const SOUNDS = join(PUBLIC, 'sounds');
const MANIFEST = join(SOUNDS, 'sound-manifest.json');
const THEME = join(PUBLIC, 'audio', 'theme.mp3');
const AUDIO_RE = /\.(?:wav|mp3|ogg|oga)$/i;
const LOGIN_THEME = 'Sound\\Music\\GlueScreenMusic\\wow_main_theme.mp3';

type JsonRecord = Record<string, unknown>;

const positive = (value: number) => value > 0 && value < 0x80000000 ? value : 0;
const slash = (value: string) => value.replaceAll('\\', '/').replace(/^\/+/, '');

function assertLayout(name: string, dbc: DbcFile, fields: number) {
  if (dbc.fieldCount !== fields || dbc.recordSize !== fields * 4) {
    throw new Error(`${name} layout changed: ${dbc.recordCount} rows, ${dbc.fieldCount} fields, ${dbc.recordSize} bytes`);
  }
}

function wavDurationMs(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 44 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= bytes.byteLength) {
    const tag = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (tag === 'fmt ' && size >= 12 && offset + 20 <= bytes.byteLength) byteRate = view.getUint32(offset + 16, true);
    if (tag === 'data') { dataBytes = Math.min(size, bytes.byteLength - offset - 8); break; }
    offset += 8 + size + (size & 1);
  }
  return byteRate && dataBytes ? Math.round(dataBytes / byteRate * 1000) : null;
}

function writeIfChanged(file: string, bytes: Uint8Array): boolean {
  if (existsSync(file) && statSync(file).size === bytes.byteLength) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return true;
}

async function main() {
  mkdirSync(SOUNDS, { recursive: true });
  const archives = await ClientArchiveSet.open(CACHE, ['sound.MPQ', 'speech.MPQ']);
  const dbcArchive = await openClientArchive(CACHE, 'dbc.MPQ');
  try {
    const archiveNames = archives.list().filter((name) => AUDIO_RE.test(name));
    const names = new Map(archiveNames.map((name) => [name.toLowerCase(), name]));
    const durationByPath = new Map<string, number | null>();
    let extracted = 0;
    let current = 0;
    let failed = 0;
    let bytesWritten = 0;

    for (let index = 0; index < archiveNames.length; index++) {
      const archiveName = archiveNames[index];
      try {
        const bytes = archives.extract(archiveName);
        const runtimePath = slash(archiveName);
        const output = resolve(SOUNDS, runtimePath);
        if (relative(SOUNDS, output).startsWith('..')) throw new Error('path escaped sounds root');
        if (writeIfChanged(output, bytes)) { extracted++; bytesWritten += bytes.byteLength; } else current++;
        durationByPath.set(runtimePath.toLowerCase(), /\.wav$/i.test(runtimePath) ? wavDurationMs(bytes) : null);
      } catch (error) {
        failed++;
        console.warn(`[sounds] failed ${archiveName}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if ((index + 1) % 500 === 0 || index + 1 === archiveNames.length) console.log(`[sounds] ${index + 1}/${archiveNames.length}`);
    }

    const themeName = names.get(LOGIN_THEME.toLowerCase());
    if (!themeName) throw new Error(`${LOGIN_THEME} is missing from sound.MPQ`);
    const themeBytes = archives.extract(themeName);
    writeIfChanged(THEME, themeBytes);

    const dbc = (name: string, fields: number) => {
      const parsed = new DbcFile(dbcArchive.extract(`DBFilesClient\\${name}.dbc`));
      assertLayout(name, parsed, fields);
      return parsed;
    };
    const soundEntries = dbc('SoundEntries', 29);
    const entries: Record<string, JsonRecord> = {};
    for (let row = 0; row < soundEntries.recordCount; row++) {
      const id = soundEntries.getUint(row, 0);
      const directory = slash(soundEntries.getString(row, 23)).replace(/\/$/, '');
      const files: string[] = [];
      const weights: number[] = [];
      const durations: Array<number | null> = [];
      for (let slot = 0; slot < 10; slot++) {
        const fileName = soundEntries.getString(row, 3 + slot);
        if (!fileName) continue;
        const logical = slash(directory ? `${directory}/${fileName}` : fileName);
        const actual = names.get(logical.replaceAll('/', '\\').toLowerCase());
        if (!actual) continue;
        const runtimePath = slash(actual);
        files.push(runtimePath);
        weights.push(positive(soundEntries.getUint(row, 13 + slot)) || 1);
        durations.push(durationByPath.get(runtimePath.toLowerCase()) ?? null);
      }
      if (!id || !files.length) continue;
      const flags = soundEntries.getUint(row, 25);
      entries[String(id)] = {
        id,
        name: soundEntries.getString(row, 2),
        files,
        weights,
        durationMs: durations,
        volume: soundEntries.getFloat(row, 24),
        flags,
        loop: (flags & 0x200) !== 0,
        minDistance: soundEntries.getFloat(row, 26),
        distanceCutoff: soundEntries.getFloat(row, 27),
      };
    }

    const ui: Record<string, number> = {};
    const uiLookups = dbc('UISoundLookups', 3);
    for (let row = 0; row < uiLookups.recordCount; row++) {
      const key = uiLookups.getString(row, 2);
      const id = positive(uiLookups.getUint(row, 1));
      if (key && id) ui[key] = id;
    }
    // FrameXML's PlaySound strings are normally SoundEntries names (igCharacterInfoOpen), while
    // UISoundLookups carries uppercase semantic keys (CHARACTERINFOOPEN). Preserve both namespaces
    // from the DBCs instead of assigning unrelated low spell IDs as aliases.
    for (const [id, entry] of Object.entries(entries)) {
      const name = typeof entry.name === 'string' ? entry.name : '';
      const files = Array.isArray(entry.files) ? entry.files as string[] : [];
      if (name && files.some((file) => /^Sound\/interface\//i.test(file))) ui[name] ??= Number(id);
    }
    if (ui.QUESTADDED) ui.igQuestAccept = ui.QUESTADDED;
    if (ui.QUESTLISTCOMPLETE) ui.igQuestComplete = ui.QUESTLISTCOMPLETE;

    const creatures: Record<string, JsonRecord> = {};
    const creatureSoundRowById = new Map<number, number>();
    const creatureSound = dbc('CreatureSoundData', 27);
    const cueFields = { attack: 1, attackCritical: 2, wound: 3, woundCritical: 4, death: 6, aggro: 10, alert: 13, fidget: 14, customAttack: 19 };
    for (let row = 0; row < creatureSound.recordCount; row++) {
      const profile: JsonRecord = {};
      for (const [cue, field] of Object.entries(cueFields)) {
        const id = positive(creatureSound.getUint(row, field));
        if (id) profile[cue] = id;
      }
      const id = creatureSound.getUint(row, 0);
      creatureSoundRowById.set(id, row);
      creatures[String(id)] = profile;
    }

    const npcs: Record<string, JsonRecord> = {};
    const npcSounds = dbc('NPCSounds', 5);
    for (let row = 0; row < npcSounds.recordCount; row++) {
      npcs[String(npcSounds.getUint(row, 0))] = {
        greeting: positive(npcSounds.getUint(row, 1)),
        farewell: positive(npcSounds.getUint(row, 2)),
        pissed: positive(npcSounds.getUint(row, 3)),
      };
    }

    const modelSounds = new Map<number, number>();
    const modelData = dbc('CreatureModelData', 16);
    for (let row = 0; row < modelData.recordCount; row++) modelSounds.set(modelData.getUint(row, 0), positive(modelData.getUint(row, 13)));
    const displays: Record<string, JsonRecord> = {};
    const displayInfo = dbc('CreatureDisplayInfo', 12);
    for (let row = 0; row < displayInfo.recordCount; row++) {
      const displayId = displayInfo.getUint(row, 0);
      const soundDataId = positive(displayInfo.getUint(row, 2)) || modelSounds.get(displayInfo.getUint(row, 1)) || 0;
      const soundRow = creatureSoundRowById.get(soundDataId);
      displays[String(displayId)] = {
        footstepId: soundRow === undefined ? 0 : positive(creatureSound.getUint(soundRow, 9)),
        soundDataId,
        npcSoundId: positive(displayInfo.getUint(row, 11)),
      };
    }

    const footsteps: Record<string, Record<string, JsonRecord>> = {};
    const footstepRows = dbc('FootstepTerrainLookup', 5);
    for (let row = 0; row < footstepRows.recordCount; row++) {
      const group = String(footstepRows.getUint(row, 1));
      const terrain = String(footstepRows.getUint(row, 2));
      (footsteps[group] ??= {})[terrain] = {
        sound: positive(footstepRows.getUint(row, 3)),
        splash: positive(footstepRows.getUint(row, 4)),
      };
    }

    const weaponSwings: Record<string, number> = {};
    const swingRows = dbc('WeaponSwingSounds2', 4);
    for (let row = 0; row < swingRows.recordCount; row++) weaponSwings[`${swingRows.getUint(row, 1)}:${swingRows.getUint(row, 2)}`] = positive(swingRows.getUint(row, 3));

    const sheathe: Record<string, JsonRecord> = {};
    const sheatheRows = dbc('SheatheSoundLookups', 7);
    for (let row = 0; row < sheatheRows.recordCount; row++) sheathe[`${sheatheRows.getUint(row, 1)}:${sheatheRows.getUint(row, 2)}`] = {
      sheathe: positive(sheatheRows.getUint(row, 5)), unsheathe: positive(sheatheRows.getUint(row, 6)),
    };

    const ambience = new Map<number, [number, number]>();
    const ambienceRows = dbc('SoundAmbience', 3);
    for (let row = 0; row < ambienceRows.recordCount; row++) ambience.set(ambienceRows.getUint(row, 0), [positive(ambienceRows.getUint(row, 1)), positive(ambienceRows.getUint(row, 2))]);
    const music = new Map<number, number[]>();
    const musicRows = dbc('ZoneMusic', 8);
    for (let row = 0; row < musicRows.recordCount; row++) music.set(musicRows.getUint(row, 0), [2, 3, 4, 5, 6, 7].map((field) => positive(musicRows.getUint(row, field))));
    const intro = new Map<number, number>();
    const introRows = dbc('ZoneIntroMusicTable', 5);
    for (let row = 0; row < introRows.recordCount; row++) intro.set(introRows.getUint(row, 0), positive(introRows.getUint(row, 2)));
    const areas: Record<string, JsonRecord> = {};
    const areaRows = dbc('AreaTable', 21);
    for (let row = 0; row < areaRows.recordCount; row++) {
      const ambient = ambience.get(areaRows.getUint(row, 7)) ?? [0, 0];
      const zone = music.get(areaRows.getUint(row, 8)) ?? [0, 0, 0, 0, 0, 0];
      areas[String(areaRows.getUint(row, 0))] = {
        ambienceDay: ambient[0], ambienceNight: ambient[1], silenceMinDay: zone[0], silenceMaxDay: zone[1],
        silenceMinNight: zone[2], silenceMaxNight: zone[3], musicDay: zone[4], musicNight: zone[5], intro: intro.get(areaRows.getUint(row, 9)) ?? 0,
      };
    }

    const weather = {
      8533: 'Sound/Ambience/Weather/RainLightLoop.wav', 8534: 'Sound/Ambience/Weather/RainMediumLoop.wav', 8535: 'Sound/Ambience/Weather/RainHeavyLoop.wav',
      8536: 'Sound/Ambience/Weather/SnowLight.wav', 8537: 'Sound/Ambience/Weather/SnowMedium.wav', 8538: 'Sound/Ambience/Weather/SnowHeavy.wav',
      8556: 'Sound/Ambience/Weather/SandStormLight.wav', 8557: 'Sound/Ambience/Weather/SandStormMedium.wav', 8558: 'Sound/Ambience/Weather/SandStormHeavy.wav',
    };
    const movement = { '1:0': { jump: 3283, land: 3284 }, '1:1': { jump: 3281, land: 3282 }, '2:0': { jump: 3291, land: 3292 }, '2:1': { jump: 3289, land: 3290 }, '3:0': { jump: 3267, land: 3268 }, '3:1': { jump: 3265, land: 3266 }, '4:0': { jump: 3287, land: 3288 }, '4:1': { jump: 3285, land: 3286 }, '5:0': { jump: 3295, land: 3296 }, '5:1': { jump: 3293, land: 3294 }, '6:0': { jump: 3299, land: 3300 }, '6:1': { jump: 3297, land: 3298 }, '7:0': { jump: 3279, land: 3280 }, '7:1': { jump: 3273, land: 3274 }, '8:0': { jump: 3311, land: 3312 }, '8:1': { jump: 3305, land: 3306 } };
    const vocalErrors = { '1:0': { outOfRange: 1881, invalidTarget: 1882 }, '1:1': { outOfRange: 2005, invalidTarget: 2006 }, '2:0': { outOfRange: 2290, invalidTarget: 2291 }, '2:1': { outOfRange: 2347, invalidTarget: 2348 }, '3:0': { outOfRange: 1588, invalidTarget: 1589 }, '3:1': { outOfRange: 1660, invalidTarget: 1661 }, '4:0': { outOfRange: 2124, invalidTarget: 2125 }, '4:1': { outOfRange: 2235, invalidTarget: 2236 }, '5:0': { outOfRange: 2060, invalidTarget: 2062 }, '5:1': { outOfRange: 2179, invalidTarget: 2180 }, '6:0': { outOfRange: 2408, invalidTarget: 2411 }, '6:1': { outOfRange: 2409, invalidTarget: 2410 }, '7:0': { outOfRange: 1715, invalidTarget: 1716 }, '7:1': { outOfRange: 1770, invalidTarget: 1771 }, '8:0': { outOfRange: 1826, invalidTarget: 1827 }, '8:1': { outOfRange: 1936, invalidTarget: 1937 } };

    const manifest = {
      version: 2,
      generatedAt: new Date().toISOString(),
      extraction: { archives: ['sound.MPQ', 'speech.MPQ'], discovered: archiveNames.length, extracted, current, failed, bytesWritten },
      entries,
      ui,
      audioVariants: {},
      world: {
        displays, creatures, npcs, footsteps, defaultFootsteps: footsteps['8'] ?? {}, weaponSwings, sheathe, movement, vocalErrors, areas, weather,
        water: { enter: { small: 1090, medium: 1096, large: 1097 }, underwater: 4209, surface: { '2:0': 3072, '2:4': 3052, '2:8': 3052, '0:0': 1111, '0:4': 1112, '0:8': 1113, '1:0': 1114, '1:4': 1114, '1:8': 1114, '3:0': 3880, '3:4': 3880, '3:8': 3880 } },
      },
    };
    if (failed) throw new Error(`${failed} sound files failed extraction`);
    if (Object.keys(entries).length < 3800) throw new Error(`SoundEntries manifest unexpectedly small: ${Object.keys(entries).length}`);
    writeFileSync(MANIFEST, JSON.stringify(manifest));
    console.log(`[sounds] ${extracted} extracted, ${current} current, ${failed} failed; ${Object.keys(entries).length} SoundEntries; login theme -> /audio/theme.mp3`);
  } finally {
    archives.close();
    dbcArchive.close();
  }
}

main().catch((error) => { console.error('[sounds] FATAL', error); process.exit(1); });
