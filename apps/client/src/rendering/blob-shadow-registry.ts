import type * as THREE from 'three';
/** Ownership remains with each entity. Batching only substitutes a draw for the duration of a world pass. */
export const blobShadowMeshes = new Set<THREE.Mesh>();
