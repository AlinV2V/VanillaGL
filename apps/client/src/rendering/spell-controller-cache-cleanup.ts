import * as THREE from 'three';

/** Dispose world-scoped spell templates after every live clone and beam has been removed. */
export function disposeSpellControllerCaches(
  chainTextures: Map<string, Promise<THREE.Texture | null>>,
  ammoTemplates: Map<string, Promise<THREE.Group | null>>,
): void {
  for (const promise of chainTextures.values()) void promise.then((texture) => texture?.dispose());
  chainTextures.clear();
  for (const promise of ammoTemplates.values()) void promise.then((root) => root?.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    if (Array.isArray(mesh.material)) for (const material of mesh.material) material.dispose();
    else mesh.material?.dispose();
  }));
  ammoTemplates.clear();
}
