import * as THREE from 'three';
import type { M2WorldLight } from './m2-world-lighting.ts';
/** Asset conversion utility. */
export function setM2PerDrawUniform(
  material: THREE.ShaderMaterial,
  uniform: THREE.IUniform,
  value: unknown,
): void {
  uniform.value = value;
  material.uniformsNeedUpdate = true;
}

/** Bind selection and the owning model's WMO light provider for each individual draw. */
export function bindM2SelectionUniform(material: THREE.ShaderMaterial): void {
  const uniforms = material.uniforms;
  const selectedUniform = uniforms?.uSelected;
  if (!selectedUniform) return;
  material.onBeforeRender = (_renderer, _scene, _camera, _geometry, object) => {
    let owner: THREE.Object3D | null = object;
    let selected = false;
    let light: M2WorldLight | null | undefined;
    while (owner) {
      if (owner.userData.wowSelected === true) selected = true;
      if (light === undefined && Object.hasOwn(owner.userData, 'wowM2Light')) {
        light = owner.userData.wowM2Light as M2WorldLight | null;
      }
      owner = owner.parent;
    }
    selectedUniform.value = selected ? 1 : 0;
    if (uniforms.uObjectLight) uniforms.uObjectLight.value = light ? 1 : 0;
    if (uniforms.uObjectAmbient && light) uniforms.uObjectAmbient.value.set(...light.ambient);
    if (uniforms.uObjectDirectional && light) uniforms.uObjectDirectional.value.set(...light.directional);
    if (uniforms.uObjectLightDir && light) uniforms.uObjectLightDir.value.set(...light.direction);
    if (uniforms.uLocalCount) uniforms.uLocalCount.value = Math.min(4, light?.localLights.length ?? 0);
    for (let i = 0; i < (uniforms.uLocalCount?.value ?? 0); i++) {
      const local = light!.localLights[i];
      uniforms.uLocalPos.value[i].set(...local.pos);
      uniforms.uLocalColor.value[i].set(...local.color);
      uniforms.uLocalAtten.value[i].set(local.attenStart, local.attenEnd);
    }
    material.uniformsNeedUpdate = true;
  };
}
