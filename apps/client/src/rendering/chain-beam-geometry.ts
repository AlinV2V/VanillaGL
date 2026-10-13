import * as THREE from 'three';

/** Reused geometry scratch; authored beam shape is unchanged. */
export class ChainBeamGeometryWriter {
  private readonly direction = new THREE.Vector3();
  private readonly view = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly centre = new THREE.Vector3();

  update(geometry: THREE.BufferGeometry, effect: { width: number; scrollSpeed: number; noise: number; textureLength: number }, elapsed: number, start: THREE.Vector3, end: THREE.Vector3, camera: THREE.Camera): void {
    const direction = this.direction.subVectors(end, start);
    const length = Math.max(0.001, direction.length());
    direction.divideScalar(length);
    const midpoint = this.centre.copy(start).add(end).multiplyScalar(0.5);
    const bounds = geometry.boundingSphere ??= new THREE.Sphere();
    bounds.center.copy(midpoint); bounds.radius = length * 0.5 + Math.abs(effect.noise) * 2 + Math.abs(effect.width) * 0.5;
    const view = this.view.copy(camera.position).sub(midpoint).normalize();
    const side = this.side.copy(direction).cross(view);
    if (side.lengthSq() < 1e-6) side.set(0, 0, 1).cross(direction);
    side.normalize();
    const up = this.up.copy(side).cross(direction).normalize();
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
    const segments = 8;
    const strands = 3;
    const halfWidth = effect.width * 0.5;
    const scroll = elapsed * effect.scrollSpeed;
    for (let strand = 0; strand < strands; strand++) {
      const strandPhase = strand * (Math.PI * 2 / strands);
      for (let segment = 0; segment <= segments; segment++) {
        const t = segment / segments;
        const envelope = Math.sin(Math.PI * t);
        const wave = elapsed * 13 + segment * 2.17 + strandPhase;
        const centre = this.centre.copy(start).lerp(end, t)
          .addScaledVector(side, Math.sin(wave) * effect.noise * envelope)
          .addScaledVector(up, Math.cos(wave * 0.83) * effect.noise * envelope);
        const strandOffset = (strand - 1) * effect.noise * 0.35 * envelope;
        centre.addScaledVector(up, strandOffset);
        const vertex = strand * (segments + 1) * 2 + segment * 2;
        position.setXYZ(vertex, centre.x - side.x * halfWidth, centre.y - side.y * halfWidth, centre.z - side.z * halfWidth);
        position.setXYZ(vertex + 1, centre.x + side.x * halfWidth, centre.y + side.y * halfWidth, centre.z + side.z * halfWidth);
        const u = t * (length / Math.max(0.001, effect.textureLength)) + scroll;
        uv.setXY(vertex, u, 0);
        uv.setXY(vertex + 1, u, 1);
      }
    }
    position.needsUpdate = true;
    uv.needsUpdate = true;

  }
}
