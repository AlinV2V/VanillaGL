/** Asset conversion utility. */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const DBC_DIR = (process.env.DBC_SOURCE_DIR || path.join(process.cwd(), 'data/dbcs'));
const OUT = fileURLToPath(new URL('../../apps/client/public/data/emotes.json', import.meta.url));

type DbcRecord = Record<string, number | string>;
const records = (name: string): DbcRecord[] =>
  JSON.parse(readFileSync(`${DBC_DIR}/${name}.json`, 'utf8')).records ?? [];

function main() {
    const emotes = records('Emotes');
    const emotesText = records('EmotesText');
    const animations: Record<number, [number, number]> = {};
    const commands: Record<string, number> = {};

    for (const row of emotes) {
      const id = Number(row.field_0 ?? 0);
      const name = String(row.field_1_str ?? '');
      const animationId = Number(row.field_2 ?? 0);
      animations[id] = [animationId, name.startsWith('STATE_') ? 1 : 0];
    }
    for (const row of emotesText) {
      const id = Number(row.field_0 ?? 0);
      const command = String(row.field_1_str ?? '').trim().toLowerCase();
      if (id && command) commands[command] = id;
    }

    if (commands.dance !== 34 || commands.wave !== 101 || animations[10]?.[0] !== 69) {
      throw new Error('Emote DBC layout check failed (expected /dance=34, /wave=101, emote 10 anim=69)');
    }

    mkdirSync(fileURLToPath(new URL('../../apps/client/public/data/', import.meta.url)), { recursive: true });
    writeFileSync(OUT, JSON.stringify({ version: 1, emoteAnims: animations, textEmotes: commands }, null, 2), 'utf8');
    console.log(`Wrote ${Object.keys(animations).length} animation rows and ${Object.keys(commands).length} slash commands -> ${OUT}`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
