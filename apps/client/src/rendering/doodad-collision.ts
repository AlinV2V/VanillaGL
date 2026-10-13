import * as THREE from 'three';

type CollisionPositions = number[] | Float32Array;
type CollisionIndices = number[] | Uint16Array | Uint32Array;
export type DoodadCollisionSource = { positions?: CollisionPositions; indices?: CollisionIndices };

const collisionVertexCount = (collision: DoodadCollisionSource | undefined): number => {
  if (!collision?.positions?.length || !collision.indices?.length) return 0;
  const vertices = Math.floor(collision.positions.length / 3);
  if (!vertices) return 0;
  for (let index = 0; index < collision.indices.length; index++) {
    const vertex = collision.indices[index];
    if (vertex < 0 || vertex >= vertices) return 0;
  }
  return vertices;
};

/** Expand one baked M2 collision shell through every visible MDDF placement matrix. */
export function buildDoodadCollisionGeometry(
  collision: DoodadCollisionSource | undefined,
  matrices: readonly THREE.Matrix4[],
): THREE.BufferGeometry | null {
  const sourceVertices = collisionVertexCount(collision);
  if (!sourceVertices || !collision?.positions || !collision.indices || !matrices.length) return null;
  const positions = new Float32Array(sourceVertices * matrices.length * 3);
  const indices = new Uint32Array(collision.indices.length * matrices.length);
  const point = new THREE.Vector3();
  matrices.forEach((matrix, instanceIndex) => {
    const vertexBase = instanceIndex * sourceVertices;
    for (let vertex = 0; vertex < sourceVertices; vertex++) {
      point.fromArray(collision.positions!, vertex * 3).applyMatrix4(matrix);
      point.toArray(positions, (vertexBase + vertex) * 3);
    }
    for (let index = 0; index < collision.indices!.length; index++) {
      indices[instanceIndex * collision.indices!.length + index] = vertexBase + collision.indices![index];
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Build one model-space collision shell and reuse it for every world placement.
 * Each mesh keeps an independent transform while sharing the immutable geometry
 * and its bounds tree, avoiding a copied vertex/index stream per MDDF instance.
 */
export function buildSharedDoodadCollisionMeshes(
  collision: DoodadCollisionSource | undefined,
  matrices: readonly THREE.Matrix4[],
  material: THREE.Material,
  name: string,
): { geometry: THREE.BufferGeometry; meshes: THREE.Mesh[] } | null {
  const sourceVertices = collisionVertexCount(collision);
  if (!sourceVertices || !collision?.positions || !collision.indices || !matrices.length) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(collision.positions, 3));
  geometry.setIndex(collision.indices instanceof Uint16Array || collision.indices instanceof Uint32Array
    ? new THREE.BufferAttribute(collision.indices, 1)
    : collision.indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const meshes = matrices.map((matrix, instanceIndex) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrix);
    mesh.userData.wowCollision = true;
    mesh.userData.wowCollisionSource = 'm2';
    mesh.userData.wowName = `${name}#m2-collision:${instanceIndex}`;
    return mesh;
  });
  return { geometry, meshes };
}
