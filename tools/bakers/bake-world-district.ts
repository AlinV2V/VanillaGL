/** Bounded offline pilot. Native positions/indices stay authoritative; only proven hidden IDs are emitted. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { prepareWmoRenderBatches } from '../../apps/client/src/rendering/wmo-render-batches';
import { compactWmoBatchGeometry } from '../../apps/client/src/rendering/wmo-batched-experiment';
import { compileWorldVisibility } from '../../apps/client/src/rendering/world-visibility-compiler';
import { prepareCellWall,preparedCellWallHides, districtProjection, type PreparedCellWall } from '../../apps/client/src/rendering/world-cell-proof';
import { districtPartId, districtSourceChecksum, type DistrictCatalog, type DistrictModel } from '../../apps/client/src/rendering/world-district-format';

const args = process.argv.slice(2), tile = args.find(arg => !arg.startsWith('--')) ?? 'Azeroth_30_48';
const option = (name: string, fallback: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const triple = (value: string): [number, number, number] => {
  const parts = value.split(',').map(Number); if (parts.length !== 3 || !parts.every(Number.isFinite)) throw new Error('Expected a finite x,y,z triple');
  return parts as [number, number, number];
};
if (!/^[A-Za-z]+_\d+_\d+$/.test(tile)) throw new Error('Expected one tile key');
const size = triple(option('size', '8,8,8')), eye = triple(option('eye', '0,384,478'));
const span = Number(option('span', '1')), filter = option('model', 'stormwind');
const candidateLimit = Number(option('candidates', '512'));
if (!size.every(v => v > 0 && v <= 64) || !Number.isInteger(span) || span < 0 || span > 4) throw new Error('Pilot limited to 729 cells, size <=64');
if (!Number.isInteger(candidateLimit) || candidateLimit < 16 || candidateLimit > 2048) throw new Error('Candidate limit must be 16..2048');
const input = resolve('apps/client/public/terrain/tiles', tile), output = resolve('apps/client/public/terrain/world-districts', tile);
const metaBytes = readFileSync(join(input, 'wmos.meta.json')), bytes = readFileSync(join(input, 'wmos.bin'));
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), meta = JSON.parse(metaBytes.toString());
if (meta.format !== 'wow-browser-wmo-bin-v1') throw new Error('Unsupported WMO bake');
const read = (ref: any): any => !ref ? [] : ref.$bin === 'f32' ? new Float32Array(buffer, ref.offset, ref.count) :
  ref.$bin === 'u32' ? new Uint32Array(buffer, ref.offset, ref.count) : new Uint8Array(buffer, ref.offset, ref.count);
const catalog: DistrictCatalog = { format: 'vgl-world-district-v1', projection: districtProjection,
  sourceHash: createHash('sha256').update(metaBytes).update(bytes).digest('hex'), models: [] };
type Wall = { id: string; proof: PreparedCellWall; center: THREE.Vector3; area: number };
let proofCount = 0, partCount = 0, wallCount = 0;
const started = performance.now();
for (const [modelIndex, model] of meta.models.entries()) {
  if (!model.name.toLowerCase().includes(filter.toLowerCase())) continue;
  const instance = meta.instances.find((value: any) => value.m === modelIndex); if (!instance) continue;
  const pose = new THREE.Matrix4().compose(new THREE.Vector3(instance.x, instance.y, instance.z),
    new THREE.Quaternion(instance.qx, instance.qy, instance.qz, instance.qw), new THREE.Vector3(1, 1, 1));
  const localOption = option('local-eye', '');
  const localEye = localOption ? new THREE.Vector3(...triple(localOption)) : new THREE.Vector3(...eye).applyMatrix4(pose.invert());
  const origin = localEye.toArray().map((v, i) => v - (span + .5) * size[i]) as [number, number, number];
  const result: DistrictModel = { model: model.name, groups: {}, origin, size, cells: [] }, targets: Array<{ id: string; bounds: THREE.Box3 }> = [], walls: Wall[] = [];
  for (const [group, raw] of model.groups.entries()) {
    const source = { ...raw, positions: read(raw.positions), normals: read(raw.normals), uvs: read(raw.uvs), colors: read(raw.colors), indices: read(raw.indices) };
    result.groups[group] = districtSourceChecksum(source);
    const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(source.positions, 3));
    for (const [ordinal, batch] of prepareWmoRenderBatches(source.indices, raw.batches ?? []).entries()) {
      geometry.setIndex(new THREE.BufferAttribute(batch.mergedIndices ?? source.indices, 1)); geometry.setDrawRange(batch.indexStart, batch.indexCount);
      const part = compactWmoBatchGeometry(geometry); part.computeBoundingBox();
      const id = districtPartId(group, ordinal), bounds = part.boundingBox!;
      if (!bounds.isEmpty()) targets.push({ id, bounds: bounds.clone() });
      if (batch.blendMode === 0) for (const vertices of compileWorldVisibility(part)) {
        const a = new THREE.Vector3(vertices[0], vertices[1], vertices[2]); let area = 0;
        for (let i = 3; i + 5 < vertices.length; i += 3) area += new THREE.Vector3(vertices[i], vertices[i + 1], vertices[i + 2]).sub(a)
          .cross(new THREE.Vector3(vertices[i + 3], vertices[i + 4], vertices[i + 5]).sub(a)).length() / 2;
        const center = new THREE.Vector3(); for (let i = 0; i < vertices.length; i += 3) center.add(new THREE.Vector3(vertices[i], vertices[i + 1], vertices[i + 2])); center.multiplyScalar(3 / vertices.length);
        const proof=prepareCellWall({vertices,doubleSided:!!(batch.flags&4)});if(proof)walls.push({id,proof,center,area});
      }
      part.dispose();
    }
    geometry.dispose();
  }
  for (let x = 0; x <= span * 2; x++) for (let y = 0; y <= span * 2; y++) for (let z = 0; z <= span * 2; z++) {
    const coordinate: [number, number, number] = [x, y, z], min = new THREE.Vector3(...origin).add(new THREE.Vector3(x * size[0], y * size[1], z * size[2]));
    const eyes = new THREE.Box3(min, min.clone().add(new THREE.Vector3(...size))), center = eyes.getCenter(new THREE.Vector3());
    // Bounded candidate set. Omitting a patch only keeps more native draws.
    const tangent = Math.tan(THREE.MathUtils.degToRad(districtProjection.fov / 2));
    const nearRadius = districtProjection.near * Math.sqrt(1 + tangent * tangent * (1 + districtProjection.aspect ** 2));
    const candidates = walls.filter(wall => {
      const n = wall.proof.normal, distance = n.dot(center) - wall.proof.offset;
      const radius = (Math.abs(n.x) * size[0] + Math.abs(n.y) * size[1] + Math.abs(n.z) * size[2]) / 2;
      return (wall.proof.doubleSided ? Math.abs(distance) : distance) - radius > nearRadius + .02;
    }).map(wall => ({ wall, score: wall.area / Math.max(1, wall.center.distanceToSquared(center)) }))
      .sort((a, b) => b.score - a.score).slice(0, candidateLimit).map(value => value.wall);
    const hidden: Array<[string, string]> = [];
    for (const target of targets) {
      const wall = candidates.find(candidate => candidate.id !== target.id && preparedCellWallHides(eyes, target.bounds, candidate.proof));
      if (wall) hidden.push([target.id, wall.id]);
    }
    result.cells.push({ coordinate, hidden }); proofCount += hidden.length;
  }
  partCount += targets.length; wallCount += walls.length; catalog.models.push(result);
}
if (!catalog.models.length) throw new Error('No matching WMO model');
mkdirSync(output, { recursive: true }); const text = JSON.stringify(catalog); writeFileSync(join(output, 'catalog.json'), text);
console.log(JSON.stringify({ tile, models: catalog.models.length, cells: catalog.models.reduce((sum, model) => sum + model.cells.length, 0),
  parts: partCount, patches: wallCount, proofs: proofCount, bytes: Buffer.byteLength(text), elapsedMs: Math.round(performance.now() - started), output }));
