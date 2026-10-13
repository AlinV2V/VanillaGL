import * as THREE from 'three';
import type { BakedCharacterModel } from '../model-loader';
import type { ArmChain } from './xr-avatar';

/** Build 5875 socket → wrist approximates the thumbward axis of a closed fist; model -Y is right.
 * WebXR grip -Z points along the held rod toward the thumb (NOT the aim ray). Bone matrices are skinning
 * deltas in model axes, so copying the controller quaternion directly was incorrect.
 */
export function humanGripCorrection(data: Pick<BakedCharacterModel, 'bones'>, chain: ArmChain) {
  const z = new THREE.Vector3().fromArray(data.bones[chain.socket].pivot)
    .sub(new THREE.Vector3().fromArray(data.bones[chain.wrist].pivot)).normalize();
  const x = new THREE.Vector3(0, -1, 0).addScaledVector(z, z.y).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)).invert();
}
