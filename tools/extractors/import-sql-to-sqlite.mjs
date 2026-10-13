import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const db = new Database(path.join(process.cwd(), 'data/wow_5875.sqlite'));
const sql = fs.readFileSync(path.join(process.cwd(), '/wow_metadata.sql'), 'utf-8');

console.log('Importing SQL statements into (process.env.DATA_SOURCE_DIR || path.join(process.cwd(), 'data')).sqlite...');
db.exec(sql);
console.log('Successfully imported all 1.12.1 DBC tables into (process.env.DATA_SOURCE_DIR || path.join(process.cwd(), 'data')).sqlite!');
