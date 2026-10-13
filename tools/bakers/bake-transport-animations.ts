/** Asset conversion utility. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DbcFile } from '@vanillagl/assets';

const SOURCE = process.env.DBC_SOURCE_DIR || path.join(process.cwd(), 'data', 'dbcs');
const OUT = fileURLToPath(new URL('../../apps/client/public/data/transport-animations.json', import.meta.url));
const dbc = new DbcFile(new Uint8Array(readFileSync(path.join(SOURCE, 'TransportAnimation.dbc'))));
if (dbc.fieldCount !== 7 || dbc.recordSize !== 28) {
  throw new Error(`TransportAnimation.dbc layout changed: ${dbc.recordCount}x${dbc.fieldCount}/${dbc.recordSize}`);
}

const elevators: Record<string, { totalTime: number; nodes: Array<{ time: number; x: number; y: number; z: number }> }> = {};
for (let row = 0; row < dbc.recordCount; row++) {
  const entry = String(dbc.getUint(row, 1));
  const node = {
    time: dbc.getUint(row, 2),
    x: dbc.getFloat(row, 3),
    y: dbc.getFloat(row, 4),
    z: dbc.getFloat(row, 5),
  };
  const animation = elevators[entry] ??= { totalTime: 0, nodes: [] };
  animation.totalTime = Math.max(animation.totalTime, node.time);
  animation.nodes.push(node);
}
for (const animation of Object.values(elevators)) animation.nodes.sort((a, b) => a.time - b.time);
mkdirSync(fileURLToPath(new URL('../../apps/client/public/data/', import.meta.url)), { recursive: true });
writeFileSync(OUT, JSON.stringify({ version: 1, elevators }, null, 2));
console.log(`transport animations: ${dbc.recordCount} nodes, ${Object.keys(elevators).length} elevators -> ${OUT}`);
