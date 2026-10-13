import * as THREE from 'three';
import type { BakedCharacterModel, LoadedPlayerModel } from '../model-loader';
import type { PlayerPoseModifier } from '../rendering/player-pose-modifier';
import { humanGripCorrection } from './xr-hand-basis';

export type ArmChain = { shoulder: number; elbow: number; wrist: number; socket: number; attachment: number };
export function humanArmChain(data: Pick<BakedCharacterModel, 'bones' | 'attachments'>, hand: 'left' | 'right'): ArmChain | null {
  // Derived from raw Build 5875 Human male/female M2 attachment ancestry; see verify-xr-rig.ts.
  const attachment = hand === 'right' ? 1 : 2;
  const socket = data.attachments?.find(a => a.id === attachment)?.bone ?? -1;
  const wrist = data.bones[socket]?.parentIndex ?? -1;
  const elbow = data.bones[wrist]?.parentIndex ?? -1;
  const shoulder = data.bones[elbow]?.parentIndex ?? -1;
  if (socket < 0 || wrist < 0 || elbow < 0 || shoulder < 0
    || data.bones[shoulder].keyBoneId !== (hand === 'right' ? 1 : 0)) return null;
  return { shoulder, elbow, wrist, socket, attachment };
}

/** Analytic elbow with a stable pole; clamps unreachable and singular targets. */
export function solveElbow(shoulder: THREE.Vector3, target: THREE.Vector3, pole: THREE.Vector3,
  upper: number, lower: number, elbow: THREE.Vector3, wrist: THREE.Vector3): void {
  const direction = wrist.copy(target).sub(shoulder);
  const distance = THREE.MathUtils.clamp(direction.length(), Math.abs(upper - lower) + 0.001, upper + lower - 0.001);
  if (direction.lengthSq() < 1e-10) direction.set(1, 0, 0); else direction.normalize();
  const along = (upper * upper - lower * lower + distance * distance) / (2 * distance);
  elbow.copy(pole).sub(shoulder);
  elbow.addScaledVector(direction, -elbow.dot(direction));
  if (elbow.lengthSq() < 1e-8) elbow.set(0, 0, 1).addScaledVector(direction, -direction.z);
  if (elbow.lengthSq() < 1e-8) elbow.set(0, 1, 0);
  elbow.normalize().multiplyScalar(Math.sqrt(Math.max(0, upper * upper - along * along)))
    .addScaledVector(direction, along).add(shoulder);
  wrist.copy(direction).multiplyScalar(distance).add(shoulder);
}

export class XrAvatar {
  private model?: LoadedPlayerModel;
  private chains: Partial<Record<'left' | 'right', ArmChain>> = {};
  private readonly targets = { left: new THREE.Matrix4(), right: new THREE.Matrix4() };
  private readonly weights = { left: 0, right: 0 };
  private readonly tracked = { left: false, right: false };
  private readonly descendants = new Map<number, number[]>();
  private readonly inverse = new THREE.Matrix4();
  private readonly delta = new THREE.Matrix4();
  private readonly rotation = new THREE.Quaternion();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly c = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly elbow = new THREE.Vector3();
  private readonly wrist = new THREE.Vector3();
  private readonly pole = new THREE.Vector3();
  private readonly from = new THREE.Vector3();
  private readonly to = new THREE.Vector3();
  private readonly targetRotation = new THREE.Quaternion();
  private readonly currentRotation = new THREE.Quaternion();
  private readonly identityRotation = new THREE.Quaternion();
  private readonly target = new THREE.Matrix4();
  private readonly root = new THREE.Matrix4();
  private readonly scratchScale = new THREE.Vector3();
  private readonly fixedPivot = new THREE.Vector3();
  private readonly headWorld = new THREE.Matrix4();
  private readonly headDirection = new THREE.Vector3();
  private readonly socketOffset = new THREE.Vector3();
  private readonly corrections: Partial<Record<'left' | 'right', THREE.Quaternion>> = {};
  private readonly calibration = new THREE.Quaternion();
  private readonly calibrationEuler = new THREE.Euler();
  private readonly bodyOffset = new THREE.Vector3();
  private readonly bodyAnchor = new THREE.Vector3();
  private readonly torsoMatrix = new THREE.Matrix4();
  handScale = 0.8;
  gripPitch = 0;
  gripRoll = 0;
  private hasHead = false;
  supportGrip = false;
  enabled = false;

  bind(model: LoadedPlayerModel, race: number) {
    this.clear(); this.model = model;
    if (race !== 1) return;
    for (const hand of ['left', 'right'] as const) {
      const chain = humanArmChain(model.data, hand);
      if (chain) { this.chains[hand] = chain; this.corrections[hand] = humanGripCorrection(model.data, chain); }
    }
    if (this.chains.left && this.chains.right) model.animator?.setPoseModifier?.(this.modify);
  }
  get supported() { return !!this.chains.left && !!this.chains.right; }
  get eyeForward() { return this.model?.data.attachments?.find(a => a.id === 17)?.position[0] ?? 0.12; }
  clear() {
    this.model?.animator?.setPoseModifier?.(null); this.model = undefined; this.chains = {};
    this.descendants.clear(); this.reset();
  }
  reset() { this.weights.left = this.weights.right = 0; this.tracked.left = this.tracked.right = false; this.hasHead = false; }
  setHead(world: THREE.Matrix4) { this.headWorld.copy(world); this.hasHead = true; }
  setHand(hand: 'left' | 'right', world?: THREE.Matrix4) {
    this.tracked[hand] = !!world;
    if (world && this.model) this.targets[hand].copy(world);
  }
  private subtree(index: number): number[] {
    let children = this.descendants.get(index);
    if (!children) {
      children = [];
      this.model!.data.bones.forEach((_, i) => {
        for (let j = i; j >= 0; j = this.model!.data.bones[j].parentIndex) {
          if (j === index) { children!.push(i); break; }
        }
      });
      this.descendants.set(index, children);
    }
    return children;
  }
  private rotate(index: number, pivot: THREE.Vector3, from: THREE.Vector3, to: THREE.Vector3, matrices: THREE.Matrix4[], weight: number) {
    if (from.lengthSq() < 1e-8 || to.lengthSq() < 1e-8) return;
    this.rotation.setFromUnitVectors(from.normalize(), to.normalize());
    this.rotation.slerp(this.identityRotation, 1 - weight);
    this.delta.makeRotationFromQuaternion(this.rotation);
    // T(p) R T(-p), applied to the entire branch so fingers and item sockets follow.
    this.c.copy(pivot).applyQuaternion(this.rotation).negate().add(pivot); this.delta.setPosition(this.c);
    for (const child of this.subtree(index)) matrices[child].premultiply(this.delta);
  }
  private readonly modify: PlayerPoseModifier = ({ bones, matrices, rootInverse, dt }) => {
    if (!this.enabled || !this.model) return;
    this.model.group.updateWorldMatrix(true, false);
    this.inverse.copy(this.model.group.matrixWorld).invert();
    // Work in the same root-cancelled coordinates used by skinning and attachments.
    for (const matrix of matrices) matrix.premultiply(rootInverse);
    const position = (index: number, out: THREE.Vector3) => out.fromArray(bones[index].pivot).applyMatrix4(matrices[index]);
    if (this.hasHead) {
      this.target.copy(this.headWorld).premultiply(this.inverse);
      this.headDirection.set(0, 0, -1).transformDirection(this.target);
      // Move the visible upper body under small room-scale leans. Feet/server capsule stay fixed.
      const head = bones.findIndex(b => b.keyBoneId === 6);
      if (head >= 0) {
        position(head, this.bodyAnchor); this.bodyOffset.setFromMatrixPosition(this.target);
        this.bodyOffset.x -= this.eyeForward; this.bodyOffset.y -= this.bodyAnchor.y; this.bodyOffset.z = 0;
        this.bodyOffset.clampLength(0, 0.3);
      }
      const spine = bones.findIndex(b => b.keyBoneId === 4);
      if (spine >= 0) {
        this.torsoMatrix.makeTranslation(this.bodyOffset.x, this.bodyOffset.y, 0);
        for (const child of this.subtree(spine)) matrices[child].premultiply(this.torsoMatrix);
        const yaw = THREE.MathUtils.clamp(Math.atan2(this.headDirection.y, this.headDirection.x), -0.7, 0.7) * 0.4;
        position(spine, this.fixedPivot);
        this.from.set(1, 0, 0); this.to.set(Math.cos(yaw), Math.sin(yaw), 0);
        this.rotate(spine, this.fixedPivot, this.from, this.to, matrices, 1);
      }
    }
    for (const hand of ['right', 'left'] as const) {
      const chain = this.chains[hand]; if (!chain) continue;
      const weight = this.weights[hand] = THREE.MathUtils.damp(this.weights[hand], this.tracked[hand] ? 1 : 0, 18, dt);
      if (weight < 0.001) continue;
      const target = this.target.copy(this.targets[hand]).premultiply(this.inverse);
      if (hand === 'left' && this.supportGrip && this.tracked.right) {
        target.copy(this.targets.right).premultiply(this.inverse).multiply(this.root.makeTranslation(0, 0, -0.18));
      }
      position(chain.shoulder, this.a); position(chain.elbow, this.b); position(chain.wrist, this.c);
      const upper = this.a.distanceTo(this.b), lower = this.b.distanceTo(this.c);
      target.decompose(this.desired, this.targetRotation, this.scratchScale);
      this.calibration.setFromEuler(this.calibrationEuler.set(THREE.MathUtils.degToRad(this.gripPitch), 0,
        THREE.MathUtils.degToRad(this.gripRoll) * (hand === 'left' ? -1 : 1), 'XYZ'));
      this.targetRotation.multiply(this.calibration).multiply(this.corrections[hand]!);
      const attachment = this.model.data.attachments?.find(a => a.id === chain.attachment);
      if (attachment) {
        this.currentRotation.setFromRotationMatrix(matrices[chain.wrist]).invert();
        this.socketOffset.fromArray(attachment.position).applyMatrix4(matrices[chain.socket]).sub(this.c)
          .multiplyScalar(this.handScale).applyQuaternion(this.currentRotation).applyQuaternion(this.targetRotation);
        this.desired.sub(this.socketOffset);
      }
      this.pole.set(-0.35, hand === 'left' ? 0.5 : -0.5, -0.5).add(this.a);
      solveElbow(this.a, this.desired, this.pole, upper, lower, this.elbow, this.wrist);
      this.from.copy(this.b).sub(this.a); this.to.copy(this.elbow).sub(this.a);
      this.rotate(chain.shoulder, this.fixedPivot.copy(this.a), this.from, this.to, matrices, weight);
      position(chain.elbow, this.b); position(chain.wrist, this.c);
      this.from.copy(this.c).sub(this.b); this.to.copy(this.wrist).sub(this.b);
      this.rotate(chain.elbow, this.fixedPivot.copy(this.b), this.from, this.to, matrices, weight);
      // Preserve authored item orientation offsets on the socket beneath the wrist.
      const current = this.currentRotation.setFromRotationMatrix(matrices[chain.wrist]);
      this.rotation.copy(this.targetRotation).multiply(current.invert()).slerp(this.identityRotation, 1 - weight);
      position(chain.wrist, this.a); this.delta.makeRotationFromQuaternion(this.rotation);
      this.c.copy(this.a).applyQuaternion(this.rotation).negate().add(this.a); this.delta.setPosition(this.c);
      for (const child of this.subtree(chain.wrist)) matrices[child].premultiply(this.delta);
      // Local presentation only; scale around the wrist, preserving the solved grip position.
      const scale = 1 + (this.handScale - 1) * weight;
      this.delta.makeScale(scale, scale, scale).setPosition(this.a.multiplyScalar(1 - scale));
      for (const child of this.subtree(chain.wrist)) matrices[child].premultiply(this.delta);
    }
    // Hide the local face/hair without hiding the rest of the character or sharing geometry edits.
    const head = bones.findIndex(b => b.keyBoneId === 6);
    if (head >= 0) {
      // Collapse toward the torso rather than leaving a head/neck stump at eye height.
      position(head, this.a); this.a.z -= 0.18;
      this.delta.makeScale(0.001, 0.001, 0.001).setPosition(this.a.multiplyScalar(0.999));
      for (const child of this.subtree(head)) matrices[child].premultiply(this.delta);
    }
    const root = this.root.copy(rootInverse).invert();
    for (const matrix of matrices) matrix.premultiply(root);
  };
}
