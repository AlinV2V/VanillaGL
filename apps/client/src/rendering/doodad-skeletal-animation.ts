import type * as THREE from 'three';
import type { M2Animator } from '../m2-animator';
import { beginCpuScope, CpuScopeId, endCpuScope } from './performance-cpu-scopes';

export type DoodadAnimationActivity = { cullPass: number; visible: boolean; nearestDistance: number };
type RegisteredDoodadAnimator = {
  animator: M2Animator; root: THREE.Group; activity: DoodadAnimationActivity;
  pendingDt: number; visibleDt: number; wasVisible: boolean;
};
const registered: RegisteredDoodadAnimator[] = [];

export const createDoodadAnimationActivity = (): DoodadAnimationActivity => ({
  cullPass: 0, visible: false, nearestDistance: Number.POSITIVE_INFINITY,
});

export const registerDoodadAnimator = (
  animator: M2Animator, root: THREE.Group, activity: DoodadAnimationActivity,
) => {
  registered.push({ animator, root, activity, pendingDt: 0, visibleDt: 0, wasVisible: false });
};

export const updateDoodadAnimations = (dt: number) => {
  const cpuScope = beginCpuScope(CpuScopeId.DoodadSkeletalAnimation);
  try {
  for (const entry of registered) {
    entry.pendingDt += dt;
    const visible = entry.root.visible && entry.activity.visible;
    if (!visible) { entry.wasVisible = false; continue; }
    const interval = entry.activity.nearestDistance <= 80 ? 0
      : entry.activity.nearestDistance <= 160 ? 1 / 30 : 1 / 15;
    entry.visibleDt += dt;
    if (entry.wasVisible && interval > 0 && entry.visibleDt < interval) continue;
    entry.animator.update(entry.pendingDt, 0);
    entry.pendingDt = 0;
    entry.visibleDt = 0;
    entry.wasVisible = true;
  }
  } finally { endCpuScope(cpuScope); }
};

export const clearDoodadAnimationsForGroup = (root: THREE.Group) => {
  for (let index = registered.length - 1; index >= 0; index--) {
    if (registered[index].root === root) registered.splice(index, 1);
  }
};

export const doodadAnimatorCount = () => registered.length;
