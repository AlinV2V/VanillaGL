import type * as THREE from 'three';
import type { BakedBone } from '../model-loader';

/** Matrices are M2 pivot transforms, not Three.js Bone local transforms. */
export type PlayerPoseModifier = (context: {
  bones: readonly BakedBone[];
  matrices: THREE.Matrix4[];
  rootInverse: THREE.Matrix4;
  dt: number;
}) => void;
