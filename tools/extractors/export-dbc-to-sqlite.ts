/** Asset conversion utility. */
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { openClientArchive, DbcFile } from '@vanillagl/assets';

const BS = String.fromCharCode(92);
const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const SQL_OUTPUT = fileURLToPath(new URL('../wow_metadata.sql', import.meta.url));

async function main() {
  const dbcMpq = await openClientArchive(CACHE, 'dbc.MPQ');
  
  let sql = `-- WoW 1.12.1 Client Metadata Export\n`;
  sql += `PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n\n`;

  // 1. Export CharSections.dbc
  try {
    const raw = dbcMpq.extract(['DBFilesClient', 'CharSections.dbc'].join(BS));
    const dbc = new DbcFile(raw);
    
    sql += `DROP TABLE IF EXISTS char_sections;\n`;
    sql += `CREATE TABLE char_sections (\n`;
    sql += `  id INTEGER PRIMARY KEY,\n`;
    sql += `  race INTEGER,\n`;
    sql += `  gender INTEGER,\n`;
    sql += `  section_type INTEGER,\n`;
    sql += `  variation_index INTEGER,\n`;
    sql += `  color_index INTEGER,\n`;
    sql += `  texture1 TEXT,\n`;
    sql += `  texture2 TEXT,\n`;
    sql += `  texture3 TEXT,\n`;
    sql += `  flags INTEGER\n`;
    sql += `);\n\n`;

    for (let i = 0; i < dbc.recordCount; i++) {
      const id = dbc.getUint(i, 0);
      const race = dbc.getUint(i, 1);
      const gender = dbc.getUint(i, 2);
      const sectionType = dbc.getUint(i, 3);
      // Build 5875 layout: id/race/gender/section/variation/color/
      // texture1/texture2/texture3/flags. Later schema descriptions put the
      // texture offsets first; using those offsets here produced convincing but
      // completely invalid SQL rows.
      const variationIndex = dbc.getUint(i, 4);
      const colorIndex = dbc.getUint(i, 5);
      const texture1 = dbc.getString(i, 6).replace(/'/g, "''");
      const texture2 = dbc.getString(i, 7).replace(/'/g, "''");
      const texture3 = dbc.getString(i, 8).replace(/'/g, "''");
      const flags = dbc.getUint(i, 9);

      sql += `INSERT INTO char_sections VALUES (${id}, ${race}, ${gender}, ${sectionType}, ${variationIndex}, ${colorIndex}, '${texture1}', '${texture2}', '${texture3}', ${flags});\n`;
    }
    sql += `\n`;
    console.log(`CharSections.dbc exported: ${dbc.recordCount} rows`);
  } catch (e) {
    console.error(`Failed to export CharSections.dbc`, e);
  }

  // 2. Export ItemDisplayInfo.dbc
  try {
    const raw = dbcMpq.extract(['DBFilesClient', 'ItemDisplayInfo.dbc'].join(BS));
    const dbc = new DbcFile(raw);

    sql += `DROP TABLE IF EXISTS item_display_info;\n`;
    sql += `CREATE TABLE item_display_info (\n`;
    sql += `  id INTEGER PRIMARY KEY,\n`;
    sql += `  model_left TEXT,\n`;
    sql += `  model_right TEXT,\n`;
    sql += `  texture_left TEXT,\n`;
    sql += `  texture_right TEXT,\n`;
    sql += `  icon TEXT,\n`;
    sql += `  geoset_group1 INTEGER,\n`;
    sql += `  geoset_group2 INTEGER,\n`;
    sql += `  geoset_group3 INTEGER,\n`;
    sql += `  flags INTEGER,\n`;
    sql += `  spell_visual_id INTEGER,\n`;
    sql += `  helmet_vis_data INTEGER,\n`;
    sql += `  arm_upper_texture TEXT,\n`;
    sql += `  arm_lower_texture TEXT,\n`;
    sql += `  hand_texture TEXT,\n`;
    sql += `  torso_upper_texture TEXT,\n`;
    sql += `  torso_lower_texture TEXT,\n`;
    sql += `  leg_upper_texture TEXT,\n`;
    sql += `  leg_lower_texture TEXT,\n`;
    sql += `  foot_texture TEXT,\n`;
    sql += `  item_visual_id INTEGER,\n`;
    sql += `  helmet_vis_male INTEGER,\n`;
    sql += `  helmet_vis_female INTEGER\n`;
    sql += `);\n\n`;

    for (let i = 0; i < dbc.recordCount; i++) {
      const id = dbc.getUint(i, 0);
      const modelLeft = dbc.getString(i, 1).replace(/'/g, "''");
      const modelRight = dbc.getString(i, 2).replace(/'/g, "''");
      const textureLeft = dbc.getString(i, 3).replace(/'/g, "''");
      const textureRight = dbc.getString(i, 4).replace(/'/g, "''");
      const icon = dbc.getString(i, 5).replace(/'/g, "''");
      const gg1 = dbc.getUint(i, 6);
      const gg2 = dbc.getUint(i, 7);
      const gg3 = dbc.getUint(i, 8);
      const flags = dbc.getUint(i, 9);
      const spellVisual = dbc.getUint(i, 10);
      const helmetVis = dbc.getUint(i, 11);
      
      const armUpper = dbc.getString(i, 12).replace(/'/g, "''");
      const armLower = dbc.getString(i, 13).replace(/'/g, "''");
      const hand = dbc.getString(i, 14).replace(/'/g, "''");
      const torsoUpper = dbc.getString(i, 15).replace(/'/g, "''");
      const torsoLower = dbc.getString(i, 16).replace(/'/g, "''");
      const legUpper = dbc.getString(i, 17).replace(/'/g, "''");
      const legLower = dbc.getString(i, 18).replace(/'/g, "''");
      const foot = dbc.getString(i, 19).replace(/'/g, "''");
      
      const itemVisual = dbc.getUint(i, 20);
      const visMale = dbc.fieldCount > 21 ? dbc.getUint(i, 21) : 0;
      const visFemale = dbc.fieldCount > 22 ? dbc.getUint(i, 22) : 0;

      sql += `INSERT INTO item_display_info VALUES (${id}, '${modelLeft}', '${modelRight}', '${textureLeft}', '${textureRight}', '${icon}', ${gg1}, ${gg2}, ${gg3}, ${flags}, ${spellVisual}, ${helmetVis}, '${armUpper}', '${armLower}', '${hand}', '${torsoUpper}', '${torsoLower}', '${legUpper}', '${legLower}', '${foot}', ${itemVisual}, ${visMale}, ${visFemale});\n`;
    }
    sql += `\n`;
    console.log(`ItemDisplayInfo.dbc exported: ${dbc.recordCount} rows`);
  } catch (e) {
    console.error(`Failed to export ItemDisplayInfo.dbc`, e);
  }

  // 3. Export ItemVisuals.dbc
  try {
    const raw = dbcMpq.extract(['DBFilesClient', 'ItemVisuals.dbc'].join(BS));
    const dbc = new DbcFile(raw);

    sql += `DROP TABLE IF EXISTS item_visuals;\n`;
    sql += `CREATE TABLE item_visuals (\n`;
    sql += `  id INTEGER PRIMARY KEY,\n`;
    sql += `  visual_effect1 INTEGER,\n`;
    sql += `  visual_effect2 INTEGER,\n`;
    sql += `  visual_effect3 INTEGER,\n`;
    sql += `  visual_effect4 INTEGER,\n`;
    sql += `  visual_effect5 INTEGER\n`;
    sql += `);\n\n`;

    for (let i = 0; i < dbc.recordCount; i++) {
      const id = dbc.getUint(i, 0);
      const ve1 = dbc.getUint(i, 1);
      const ve2 = dbc.getUint(i, 2);
      const ve3 = dbc.getUint(i, 3);
      const ve4 = dbc.getUint(i, 4);
      const ve5 = dbc.getUint(i, 5);

      sql += `INSERT INTO item_visuals VALUES (${id}, ${ve1}, ${ve2}, ${ve3}, ${ve4}, ${ve5});\n`;
    }
    sql += `\n`;
    console.log(`ItemVisuals.dbc exported: ${dbc.recordCount} rows`);
  } catch (e) {
    console.error(`Failed to export ItemVisuals.dbc`, e);
  }

  // 4. Export HelmetGeosetVisData.dbc
  try {
    const raw = dbcMpq.extract(['DBFilesClient', 'HelmetGeosetVisData.dbc'].join(BS));
    const dbc = new DbcFile(raw);

    sql += `DROP TABLE IF EXISTS helmet_geoset_vis_data;\n`;
    sql += `CREATE TABLE helmet_geoset_vis_data (\n`;
    sql += `  id INTEGER PRIMARY KEY,\n`;
    sql += `  hair_vis INTEGER,\n`;
    sql += `  facial_hair_vis INTEGER,\n`;
    sql += `  ears_vis INTEGER,\n`;
    sql += `  extra_vis INTEGER\n`;
    sql += `);\n\n`;

    for (let i = 0; i < dbc.recordCount; i++) {
      const id = dbc.getUint(i, 0);
      const hair = dbc.getUint(i, 1);
      const facial = dbc.getUint(i, 2);
      const ears = dbc.getUint(i, 3);
      const extra = dbc.getUint(i, 4);

      sql += `INSERT INTO helmet_geoset_vis_data VALUES (${id}, ${hair}, ${facial}, ${ears}, ${extra});\n`;
    }
    sql += `\n`;
    console.log(`HelmetGeosetVisData.dbc exported: ${dbc.recordCount} rows`);
  } catch (e) {
    console.error(`Failed to export HelmetGeosetVisData.dbc`, e);
  }

  // 5. Export CreatureDisplayInfo.dbc
  try {
    const raw = dbcMpq.extract(['DBFilesClient', 'CreatureDisplayInfo.dbc'].join(BS));
    const dbc = new DbcFile(raw);

    sql += `DROP TABLE IF EXISTS creature_display_info;\n`;
    sql += `CREATE TABLE creature_display_info (\n`;
    sql += `  id INTEGER PRIMARY KEY,\n`;
    sql += `  model_id INTEGER,\n`;
    sql += `  sound_id INTEGER,\n`;
    sql += `  extra_info_id INTEGER,\n`;
    sql += `  scale REAL,\n`;
    sql += `  opacity INTEGER,\n`;
    sql += `  skin1 TEXT,\n`;
    sql += `  skin2 TEXT,\n`;
    sql += `  skin3 TEXT\n`;
    sql += `);\n\n`;

    for (let i = 0; i < dbc.recordCount; i++) {
      const id = dbc.getUint(i, 0);
      const modelId = dbc.getUint(i, 1);
      const soundId = dbc.getUint(i, 2);
      const extraInfoId = dbc.getUint(i, 3);
      const scale = dbc.getFloat(i, 4);
      const opacity = dbc.getUint(i, 5);
      const skin1 = dbc.getString(i, 6).replace(/'/g, "''");
      const skin2 = dbc.getString(i, 7).replace(/'/g, "''");
      const skin3 = dbc.getString(i, 8).replace(/'/g, "''");

      sql += `INSERT INTO creature_display_info VALUES (${id}, ${modelId}, ${soundId}, ${extraInfoId}, ${scale}, ${opacity}, '${skin1}', '${skin2}', '${skin3}');\n`;
    }
    sql += `\n`;
    console.log(`CreatureDisplayInfo.dbc exported: ${dbc.recordCount} rows`);
  } catch (e) {
    console.error(`Failed to export CreatureDisplayInfo.dbc`, e);
  }

  // 6. Export CreatureModelData.dbc
  try {
    const raw = dbcMpq.extract(['DBFilesClient', 'CreatureModelData.dbc'].join(BS));
    const dbc = new DbcFile(raw);

    sql += `DROP TABLE IF EXISTS creature_model_data;\n`;
    sql += `CREATE TABLE creature_model_data (\n`;
    sql += `  id INTEGER PRIMARY KEY,\n`;
    sql += `  flags INTEGER,\n`;
    sql += `  model_path TEXT,\n`;
    sql += `  scale REAL\n`;
    sql += `);\n\n`;

    for (let i = 0; i < dbc.recordCount; i++) {
      const id = dbc.getUint(i, 0);
      const flags = dbc.getUint(i, 1);
      const modelPath = dbc.getString(i, 2).replace(/'/g, "''");
      // Field 3 is SizeClass (a small int, reads as ~0.0 as a float); ModelScale is field 4 — verified
      // against raw bytes: field 4 = 0x3F800000 (1.0f) for the base humanoid/creature models.
      const scale = dbc.getFloat(i, 4);

      sql += `INSERT INTO creature_model_data VALUES (${id}, ${flags}, '${modelPath}', ${scale});\n`;
    }
    sql += `\n`;
    console.log(`CreatureModelData.dbc exported: ${dbc.recordCount} rows`);
  } catch (e) {
    console.error(`Failed to export CreatureModelData.dbc`, e);
  }

  // 7. Export TaxiNodes.dbc
  try {
    const raw = dbcMpq.extract(['DBFilesClient', 'TaxiNodes.dbc'].join(BS));
    const dbc = new DbcFile(raw);

    sql += `DROP TABLE IF EXISTS taxi_nodes;\n`;
    sql += `CREATE TABLE taxi_nodes (\n`;
    sql += `  id INTEGER PRIMARY KEY,\n`;
    sql += `  map_id INTEGER,\n`;
    sql += `  x REAL,\n`;
    sql += `  y REAL,\n`;
    sql += `  z REAL,\n`;
    sql += `  name TEXT,\n`;
    sql += `  mount_creature_id1 INTEGER,\n`;
    sql += `  mount_creature_id2 INTEGER\n`;
    sql += `);\n\n`;

    for (let i = 0; i < dbc.recordCount; i++) {
      const id = dbc.getUint(i, 0);
      const mapId = dbc.getUint(i, 1);
      const x = dbc.getFloat(i, 2);
      const y = dbc.getFloat(i, 3);
      const z = dbc.getFloat(i, 4);
      const name = dbc.getString(i, 5).replace(/'/g, "''");
      const mount1 = dbc.getUint(i, 6);
      const mount2 = dbc.getUint(i, 7);

      sql += `INSERT INTO taxi_nodes VALUES (${id}, ${mapId}, ${x}, ${y}, ${z}, '${name}', ${mount1}, ${mount2});\n`;
    }
    sql += `\n`;
    console.log(`TaxiNodes.dbc exported: ${dbc.recordCount} rows`);
  } catch (e) {
    console.error(`Failed to export TaxiNodes.dbc`, e);
  }

  // 8. Export TaxiPath.dbc
  try {
    const raw = dbcMpq.extract(['DBFilesClient', 'TaxiPath.dbc'].join(BS));
    const dbc = new DbcFile(raw);

    sql += `DROP TABLE IF EXISTS taxi_path;\n`;
    sql += `CREATE TABLE taxi_path (\n`;
    sql += `  id INTEGER PRIMARY KEY,\n`;
    sql += `  from_node INTEGER,\n`;
    sql += `  to_node INTEGER,\n`;
    sql += `  cost INTEGER\n`;
    sql += `);\n\n`;

    for (let i = 0; i < dbc.recordCount; i++) {
      const id = dbc.getUint(i, 0);
      const fromNode = dbc.getUint(i, 1);
      const toNode = dbc.getUint(i, 2);
      const cost = dbc.getUint(i, 3);

      sql += `INSERT INTO taxi_path VALUES (${id}, ${fromNode}, ${toNode}, ${cost});\n`;
    }
    sql += `\n`;
    console.log(`TaxiPath.dbc exported: ${dbc.recordCount} rows`);
  } catch (e) {
    console.error(`Failed to export TaxiPath.dbc`, e);
  }

  sql += `COMMIT;\n`;
  
  writeFileSync(SQL_OUTPUT, sql);
  console.log(`Saved SQL script to ${SQL_OUTPUT}`);
  dbcMpq.close();
}

main().catch(console.error);
