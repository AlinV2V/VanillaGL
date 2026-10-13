import * as THREE from 'three';
import { particleSubmissionEnabled } from './particle-submission';

/** One billboard per instance: center/color/size/atlas cell are uploaded once, not four times. */
export function createParticleGeometry(capacity: number, instanced = particleSubmissionEnabled) {
  const geometry = instanced ? new THREE.InstancedBufferGeometry() : new THREE.BufferGeometry();
  const copies = instanced ? 1 : 4;
  const attribute = (size: number) => {
    const data = new Float32Array(capacity * copies * size);
    return (instanced ? new THREE.InstancedBufferAttribute(data, size) : new THREE.BufferAttribute(data, size))
      .setUsage(THREE.DynamicDrawUsage);
  };
  geometry.setAttribute('position', attribute(3));
  geometry.setAttribute('aColor', attribute(4));
  geometry.setAttribute('aSize', attribute(1));
  geometry.setAttribute('aCell', attribute(2));
  const quads = instanced ? 1 : capacity;
  const corners = new Float32Array(quads * 8), indices = new Uint16Array(quads * 6);
  for (let i = 0; i < quads; i++) {
    corners.set([-1, -1, 1, -1, 1, 1, -1, 1], i * 8);
    const v = i * 4;
    indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
  }
  geometry.setAttribute('aCorner', new THREE.BufferAttribute(corners, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setDrawRange(0, 0);
  if (geometry instanceof THREE.InstancedBufferGeometry) geometry.instanceCount = 0;
  return { geometry, copies };
}
