/** Asset conversion utility. */
/** Standard vanilla M2 key bone handles. */
export const KEY_BONE = {
  SPINE_LOW: 4,
  WAIST: 5,
  HEAD: 6,
  ROOT: 26,
} as const;

export type BoneLike = { parentIndex: number; keyBoneId?: number };

/**
 * Indices of every bone at or below the spine. Empty when the rig exposes no spine key bone, which
 * the caller must read as "no split possible — fall back to a whole-body override" rather than as
 * "overlay nothing".
 */
export function upperBodyBoneIndices(bones: readonly BoneLike[]): Set<number> {
  const root = findSplitBone(bones);
  const upper = new Set<number>();
  if (root < 0) return upper;
  upper.add(root);
  // Bones are stored parent-before-child in M2, so one forward pass closes the subtree.
  for (let index = 0; index < bones.length; index++) {
    const parent = bones[index].parentIndex;
    if (parent >= 0 && upper.has(parent)) upper.add(index);
  }
  // A rig that lists a child before its parent would leak; sweep until stable, bounded by depth.
  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    for (let index = 0; index < bones.length; index++) {
      const parent = bones[index].parentIndex;
      if (parent >= 0 && upper.has(parent) && !upper.has(index)) { upper.add(index); grew = true; }
    }
    if (!grew) break;
  }
  return upper;
}

/**
 * The bone the overlay hangs from: SpineLow, or none.
 *
 * There is deliberately NO fallback to Waist. Measured on the baked HumanMale rig
 * (`characters/1_0/model.json`, 119 bones): SpineLow and Waist are SIBLINGS, both children of Root,
 * and their subtrees are disjoint — SpineLow carries 79 bones including both shoulders, both arms,
 * the head and the jaw, while Waist carries 20, the pelvis and legs. Falling back to Waist would
 * therefore overlay the flinch onto the LEGS and leave the torso running: exactly inverted. A rig
 * with no SpineLow gets a whole-body override instead, which is the current behaviour and merely
 * imperfect rather than wrong.
 */
export function findSplitBone(bones: readonly BoneLike[]): number {
  return bones.findIndex((bone) => bone.keyBoneId === KEY_BONE.SPINE_LOW);
}

/** Native semantic head root (key bone 6); its subtree includes jaw/face children. */
export function findHeadBone(bones: readonly BoneLike[]): number {
  return bones.findIndex((bone) => bone.keyBoneId === KEY_BONE.HEAD);
}

export type LocomotionSequenceSet = {
  stand: number; walk: number; run: number; walkBack: number; turnLeft: number; turnRight: number;
  jumpStart: number; jump: number; jumpEnd: number; swim: number; swimIdle: number;
};

/** Resolve a movement state without borrowing the zero-speed Shuffle sequences for Q/E. */
export function playerLocomotionSequence(state: string, s: LocomotionSequenceSet): number {
  const stand = s.stand >= 0 ? s.stand : 0;
  switch (state) {
    case 'run': return s.run >= 0 ? s.run : s.walk >= 0 ? s.walk : stand;
    case 'walk': return s.walk >= 0 ? s.walk : s.run >= 0 ? s.run : stand;
    case 'walkBack': return s.walkBack >= 0 ? s.walkBack : s.walk >= 0 ? s.walk : stand;
    case 'turnLeft': return s.turnLeft >= 0 ? s.turnLeft : stand;
    case 'turnRight': return s.turnRight >= 0 ? s.turnRight : stand;
    case 'jumpStart': return s.jumpStart >= 0 ? s.jumpStart : s.jump >= 0 ? s.jump : stand;
    case 'jump': return s.jump >= 0 ? s.jump : s.jumpStart >= 0 ? s.jumpStart : stand;
    case 'jumpEnd': return s.jumpEnd >= 0 ? s.jumpEnd : stand;
    case 'swim': return s.swim >= 0 ? s.swim : s.run >= 0 ? s.run : stand;
    case 'swimIdle': return s.swimIdle >= 0 ? s.swimIdle : s.swim >= 0 ? s.swim : stand;
    // AnimationData 92/93 exists, but no 1.12 player bake ships it. Run travels at 6.94;
    // ShuffleLeft/Right are turn-in-place loops authored at moveSpeed 0 and cause foot sliding.
    case 'strafeLeft':
    case 'strafeRight': return s.run >= 0 ? s.run : s.walk >= 0 ? s.walk : stand;
    default: return stand;
  }
}

export const playerStrafeYaw = (state: string) => state === 'strafeLeft'
  ? Math.PI / 2
  : state === 'strafeRight' ? -Math.PI / 2 : 0;

// Vanilla player M2s ship no RunLeft/RunRight sequence, so sideways travel is the Run cycle aligned
// through the skeleton. The torso follows one third of the travel turn while the semantic head root
// receives the remaining counter-rotation and keeps the authoritative facing.
export const STRAFE_TORSO_FOLLOW = 1 / 3;

export function playerStrafePose(state: string) {
  const bodyYaw = playerStrafeYaw(state);
  return {
    bodyYaw,
    torsoCounterYaw: -bodyYaw * (1 - STRAFE_TORSO_FOLLOW),
    headCounterYaw: -bodyYaw * STRAFE_TORSO_FOLLOW,
  };
}

export type UpperBodyLayerClock = { animationId: number; sequence: number; elapsedMs: number };

/** Advance an independently-clocked upper-body one-shot and return its absolute sequence time. */
export function advanceUpperBodyLayer(
  clock: UpperBodyLayerClock,
  animationId: number,
  dt: number,
  pickSequence: (id: number) => number,
  sequences: readonly { duration: number; timeStart: number; timeEnd: number }[],
): { sequence: number; time: number } | undefined {
  if (clock.animationId !== animationId) {
    clock.animationId = animationId;
    clock.sequence = pickSequence(animationId);
    clock.elapsedMs = 0;
  }
  const sequence = sequences[clock.sequence];
  if (!sequence) return undefined;
  clock.elapsedMs += dt * 1000;
  const duration = Math.max(1, sequence.duration || sequence.timeEnd - sequence.timeStart || 1);
  return { sequence: clock.sequence, time: sequence.timeStart + (clock.elapsedMs % duration) };
}
