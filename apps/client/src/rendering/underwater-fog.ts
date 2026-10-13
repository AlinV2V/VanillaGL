import * as THREE from 'three';
/** Asset conversion utility. */
export type WaterFog = { color: number; near: number; far: number };

const WATER_FOG: Record<number, WaterFog> = {
  1: { color: 0x21534a, near: 1.5, far: 42 }, // river / lake — murky teal-green
  2: { color: 0x123a52, near: 1.5, far: 55 }, // ocean — deep blue
  3: { color: 0x5a1602, near: 0.5, far: 9 }, //  magma — near-opaque red
  4: { color: 0x2c4810, near: 0.5, far: 16 }, // slime — sickly green
};

export function underwaterFogFor(liquidType: number): WaterFog {
  return WATER_FOG[liquidType] ?? WATER_FOG[1];
}

/**
 * Apply or clear submerged fog each frame. Returns the new submerged state. When entering/leaving the
 * water it overrides (or asks the caller, via the returned flag, to restore) scene.fog + background.
 */
export function applyUnderwaterFog(
  scene: THREE.Scene,
  submerged: boolean,
  liquidType: number,
  scratchColor: THREE.Color,
): void {
  const f = underwaterFogFor(liquidType);
  scratchColor.setHex(f.color, THREE.SRGBColorSpace);
  if (scene.fog instanceof THREE.Fog) {
    scene.fog.color.copy(scratchColor);
    scene.fog.near = f.near;
    scene.fog.far = f.far;
  } else {
    scene.fog = new THREE.Fog(scratchColor.getHex(), f.near, f.far);
  }
  // The murky water colour also stands in for the sky/horizon while submerged.
  if (scene.background instanceof THREE.Color) scene.background.copy(scratchColor);
  void submerged;
}
