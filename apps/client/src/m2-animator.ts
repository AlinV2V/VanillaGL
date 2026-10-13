import * as THREE from 'three';
// Explicit .ts extension: tools/verify-spell-visual-replay.ts imports this module directly under
// Node's ESM resolver, which does not do extensionless relative resolution.
import { resolveSequenceIndex } from './rendering/gameobject-anim.ts';
import { M2GpuSkinning, type M2StaticSkinAttributes } from './rendering/m2-gpu-skinning.ts';
import { upperBodyBoneIndices } from './rendering/upper-body-bones.ts';
import { createTrackKeyCursor, findTrackKey, type TrackKeyCursor } from './rendering/track-key-search.ts';
import { m2SamplingMode } from './rendering/performance-controls.ts';
import { recordM2Animator, shouldSampleM2AnimatorTiming } from './rendering/performance-subsystem-metrics.ts';
import { beginCpuScope, CpuScopeId, endCpuScope } from './rendering/performance-cpu-scopes.ts';

// Vanilla 1.12.1 M2Bone.flags billboard bits (RE m2_billboard_bone_flags spec): spherical 0x08,
// cylindrical lock-X 0x10, lock-Y 0x20, lock-Z 0x40. Flagged bones (totem glows, spell-effect
// sprites, projectile trails) are turned to face the camera about the world up-axis (Z) — the same
// approach the player animator uses (model-loader.ts), which reads correctly for upright effect bones.
const M2_BONE_BILLBOARD_MASK = 0x08 | 0x10 | 0x20 | 0x40;

export type M2Track = {
  interpolation: number;
  globalSequence: number;
  ranges: [number, number][];
  timestamps: number[];
  values: number[];
  components: number;
};

export type M2Bone = {
  /** Vanilla key-bone semantic id (6 = head). Kept for native-style portrait framing. */
  keyBoneId?: number;
  parentIndex: number;
  flags: number;
  pivot: [number, number, number];
  translation: M2Track;
  rotation: M2Track;
  scale: M2Track;
};

export type M2Attachment = {
  id: number;
  bone: number;
  position: [number, number, number];
};

export type M2Sequence = {
  id: number;
  timeStart: number;
  timeEnd: number;
  duration: number;
  blendTime?: number;
};

export type M2AnimationData = {
  positions: number[];
  boneWeights: number[];
  boneIndices: number[];
  sequences: M2Sequence[];
  globalSequences?: number[];
  animLookup: number[];
  bones: M2Bone[];
  attachments?: M2Attachment[];
};

export type M2Animator = {
  /**
   * `settle`: stop looping at the end of the cycle already in flight and hold there. Used by
   * sustained spell visuals once their emission window closes — see createM2Animator.
   */
  update: (
    dt: number,
    animationId: number,
    camera?: THREE.Camera,
    group?: THREE.Group,
    settle?: boolean,
    /** Optional one-shot sampled only on the SpineLow subtree; locomotion keeps the lower body. */
    upperBodyAnimationId?: number,
  ) => void;
  getAttachmentMatrix?: (attachmentId: number, target?: THREE.Matrix4) => THREE.Matrix4 | null;
  /** Current model-local matrix for an authored M2 bone (particle/ribbon emitter anchors). */
  getBoneMatrix?: (boneIndex: number, target?: THREE.Matrix4) => THREE.Matrix4 | null;
  bindGroup: (group: THREE.Object3D) => void;
  getSkinnedPosition: (vertexIndex: number, target?: THREE.Vector3) => THREE.Vector3;
  dispose: () => void;
};

export function createM2Animator(
  data: M2AnimationData,
  positionAttr: THREE.Float32BufferAttribute | null,
  normalAttr: THREE.Float32BufferAttribute | null,
  /**
   * `holdLastFrame`: play the sequence once and freeze on its final frame instead of wrapping.
   * Build 5875 authors every spell sequence with `replayMin = replayMax = 0` (raw M2Sequence at
   * +24/+28 — see tools/probe-m2-sequence-replay.ts), i.e. play once, do not repeat. Characters
   * keep the default looping behaviour, which is what stand/run/idle need.
   */
  options: { holdLastFrame?: boolean; boneOnly?: boolean; skinAttributes?: M2StaticSkinAttributes } = {},
): M2Animator | null {
  if (!data.bones.length || !data.sequences.length) return null;
  const hasSkinning = !!positionAttr
    && data.boneWeights.length === positionAttr.count * 4
    && data.boneIndices.length === positionAttr.count * 4
    && data.boneWeights.length > 0;
  if (!hasSkinning && !options.boneOnly) return null;

  void normalAttr;
  const matrices = data.bones.map(() => new THREE.Matrix4());
  const gpuSkinning = hasSkinning
    ? new M2GpuSkinning(data.boneWeights, data.boneIndices, data.bones.length, options.skinAttributes)
    : null;
  const attachmentById = new Map((data.attachments ?? []).map((attachment) => [attachment.id, attachment]));
  const rootInv = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  const anim = new THREE.Matrix4();
  const attachmentLocal = new THREE.Matrix4();
  const pivotMat = new THREE.Matrix4();
  const negPivotMat = new THREE.Matrix4();
  const pivot = new THREE.Vector3();
  const trans = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  const quat = new THREE.Quaternion();
  // Billboard scratch (faces flagged bones to the camera; see M2_BONE_BILLBOARD_MASK).
  const bonePos = new THREE.Vector3();
  const boneScale = new THREE.Vector3();
  const billRot = new THREE.Quaternion();
  const camLocal = new THREE.Vector3();
  const billZAxis = new THREE.Vector3(0, 0, 1);
  const zero3: [number, number, number] = [0, 0, 0];
  const one3: [number, number, number] = [1, 1, 1];
  const vectorA = [0, 0, 0];
  const vectorB = [0, 0, 0];
  const sampledTranslation = [0, 0, 0];
  const sampledScale = [1, 1, 1];
  const blendTranslation = [0, 0, 0];
  const blendScale = [1, 1, 1];
  const quatA = [0, 0, 0, 1];
  const quatB = [0, 0, 0, 1];
  const sampledRot = new THREE.Quaternion();
  const blendPrevRot = new THREE.Quaternion();
  const blendTargetRot = new THREE.Quaternion();
  const trackCursors = data.bones.map(() => ({
    translation: [createTrackKeyCursor(), createTrackKeyCursor()],
    rotation: [createTrackKeyCursor(), createTrackKeyCursor()],
    scale: [createTrackKeyCursor(), createTrackKeyCursor()],
  }));
  let cachedSampling = true;
  let active = -1;
  let elapsedMs = 0;
  let globalElapsedMs = 0;
  let blendFromActive = -1;
  let blendFromElapsedMs = 0;
  let blendElapsedMs = 0;
  let blendDurationMs = 0;
  const upperBodyBones = upperBodyBoneIndices(data.bones);
  let upperBodyAnimationId = -1;
  let upperBodyActive = -1;
  let upperBodyElapsedMs = 0;

  const sequenceFor = (id: number) => {
    const lookup = data.animLookup[id];
    if (lookup !== undefined && lookup >= 0 && data.sequences[lookup]) return lookup;
    return data.sequences.findIndex((sequence) => sequence.id === id);
  };


  // Creatures store multiple variations per animation id too (idle fidgets, swing variants).
  // sequenceFor only returns variation 0, so every wolf attacked/idled identically. Group the
  // sequence indices by animation id and roll a variant on state entry (uniform — the creature
  // bake carries no frequency weight).
  const variationsById = new Map<number, number[]>();
  data.sequences.forEach((sequence, i) => {
    const list = variationsById.get(sequence.id);
    if (list) list.push(i);
    else variationsById.set(sequence.id, [i]);
  });
  // Only roll variants for ONE-SHOT animations (attacks etc.). Looping locomotion/idle keeps
  // variation 0: a creature's Stand (id 0) variations 1+ are idle FIDGETS (scratch ear, look
  // around) — rolling those means the wolf fidgets between attack swings, doing non-combat idles
  // mid-fight. (The player animator already does this: it only varies via updateAnimationId.)
  const NO_VARIATION = new Set([0, 4, 5, 11, 12, 13, 41, 42]); // stand, walk, run, turns, swim

  const valueAt = (track: M2Track, valueIndex: number, target: number[]) => {
    const start = valueIndex * track.components;
    for (let i = 0; i < track.components; i++) target[i] = track.values[start + i] ?? target[i];
  };

  const sampleVector = (
    track: M2Track,
    sequence: number,
    time: number,
    fallback: [number, number, number],
    target: number[],
    cursor: TrackKeyCursor,
  ) => {
    target[0] = fallback[0];
    target[1] = fallback[1];
    target[2] = fallback[2];
    const valueCount = Math.floor(track.values.length / track.components);
    if (!track.timestamps.length || valueCount === 0) return target;
    const globalDuration = track.globalSequence >= 0 ? data.globalSequences?.[track.globalSequence] ?? 0 : 0;
    const isGlobal = globalDuration > 0;
    const range = isGlobal ? undefined : track.ranges[sequence];
    if (!isGlobal && !range) {
      // A zero-duration global sequence with one key is a static authored
      // transform. Vanilla uses these on attachment-related bones.
      if (track.globalSequence >= 0 && valueCount === 1) valueAt(track, 0, target);
      return target;
    }
    const start = isGlobal ? 0 : Math.max(0, Math.min(valueCount - 1, range![0]));
    const end = isGlobal ? valueCount - 1 : Math.max(start, Math.min(valueCount - 1, range![1]));
    if (isGlobal) {
      time = globalElapsedMs % globalDuration;
    }
    const ts0 = track.timestamps[start];
    if (ts0 === undefined) return target;
    // Track ranges may intentionally span several Vanilla sequences. Clamp at the ends and choose
    // the key/bracket for the absolute sequence time instead of rejecting the shared range.
    const a = findTrackKey(track.timestamps, start, end, time, cursor, cachedSampling);
    if (start === end || track.interpolation === 0) {
      valueAt(track, a, target);
      return target;
    }
    const b = Math.min(end, a + 1);
    vectorA[0] = fallback[0]; vectorA[1] = fallback[1]; vectorA[2] = fallback[2];
    vectorB[0] = fallback[0]; vectorB[1] = fallback[1]; vectorB[2] = fallback[2];
    valueAt(track, a, vectorA);
    valueAt(track, b, vectorB);
    const ta = track.timestamps[a] ?? time;
    const tb = track.timestamps[b] ?? ta;
    const f = tb > ta ? Math.max(0, Math.min(1, (time - ta) / (tb - ta))) : 0;
    target[0] = vectorA[0] + (vectorB[0] - vectorA[0]) * f;
    target[1] = vectorA[1] + (vectorB[1] - vectorA[1]) * f;
    target[2] = vectorA[2] + (vectorB[2] - vectorA[2]) * f;
    return target;
  };

  const setQuat = (target: THREE.Quaternion, values: number[]) => {
    target.set(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 1);
    return target.lengthSq() > 0.000001 ? target.normalize() : target.identity();
  };

  const sampleQuat = (track: M2Track, sequence: number, time: number, cursor: TrackKeyCursor) => {
    const valueCount = Math.floor(track.values.length / track.components);
    if (!track.timestamps.length || valueCount === 0) return quat.identity();
    const globalDuration = track.globalSequence >= 0 ? data.globalSequences?.[track.globalSequence] ?? 0 : 0;
    const isGlobal = globalDuration > 0;
    const range = isGlobal ? undefined : track.ranges[sequence];
    if (!isGlobal && !range) {
      if (track.globalSequence < 0 || valueCount !== 1) return quat.identity();
      quatA[0] = 0; quatA[1] = 0; quatA[2] = 0; quatA[3] = 1;
      valueAt(track, 0, quatA);
      return setQuat(quat, quatA);
    }
    const start = isGlobal ? 0 : Math.max(0, Math.min(valueCount - 1, range![0]));
    const end = isGlobal ? valueCount - 1 : Math.max(start, Math.min(valueCount - 1, range![1]));
    if (isGlobal) {
      time = globalElapsedMs % globalDuration;
    }
    const ts0 = track.timestamps[start];
    if (ts0 === undefined) return quat.identity();
    const a = findTrackKey(track.timestamps, start, end, time, cursor, cachedSampling);
    quatA[0] = 0; quatA[1] = 0; quatA[2] = 0; quatA[3] = 1;
    valueAt(track, a, quatA);
    setQuat(qa, quatA);
    if (start === end || track.interpolation === 0) return quat.copy(qa);
    const b = Math.min(end, a + 1);
    quatA[0] = 0; quatA[1] = 0; quatA[2] = 0; quatA[3] = 1;
    quatB[0] = 0; quatB[1] = 0; quatB[2] = 0; quatB[3] = 1;
    valueAt(track, a, quatA);
    valueAt(track, b, quatB);
    setQuat(qa, quatA);
    setQuat(qb, quatB);
    const ta = track.timestamps[a] ?? time;
    const tb = track.timestamps[b] ?? ta;
    const f = tb > ta ? Math.max(0, Math.min(1, (time - ta) / (tb - ta))) : 0;
    return quat.slerpQuaternions(qa, qb, f);
  };

  // End of the cycle a settling sequence was in when its emission stopped. Infinity while the
  // visual is still emitting; reset whenever the sequence changes.
  let settleCapMs = Number.POSITIVE_INFINITY;

  const update = (
    dt: number,
    animationId: number,
    camera?: THREE.Camera,
    group?: THREE.Group,
    settle?: boolean,
    requestedUpperBodyAnimationId?: number,
  ) => {
    const cpuScope = beginCpuScope(CpuScopeId.M2AnimationSampling);
    try {
      const samplingMode = m2SamplingMode();
      if (samplingMode === 'off') return;
      cachedSampling = samplingMode === 'cached';
      const samplingStarted = shouldSampleM2AnimatorTiming() ? performance.now() : -1;
      // Rigs without SpineLow cannot be split safely. Preserve the previous whole-body reaction
      // instead of silently dropping it or guessing that Waist is the torso (it is the leg branch).
      if (requestedUpperBodyAnimationId !== undefined && upperBodyBones.size === 0) {
        animationId = requestedUpperBodyAnimationId;
        requestedUpperBodyAnimationId = undefined;
      }
      const variants = NO_VARIATION.has(animationId) ? undefined : variationsById.get(animationId);
      let wanted: number;
      if (variants && variants.length > 1 && !variants.includes(active)) {
        // Entering this animation fresh — roll a variant. While it plays, active stays in the
        // set so the loop/one-shot holds the chosen variant instead of re-rolling every frame.
        wanted = variants[Math.floor(Math.random() * variants.length)];
      } else if (variants && variants.length > 1) {
        wanted = active; // keep the variant we already rolled
      } else {
        wanted = sequenceFor(animationId);
      }
      // Requested id, else Stand, else a resting pose, else index 0. That chain lives in
      // rendering/gameobject-anim.ts so the regression gate runs this exact function over the baked
      // corpus. Falling straight to index 0 lands on a transition for GameObject state models —
      // `Chest03.m2` index 0 is 148 `Open` (666ms) — and the wrap below then replays it forever.
      const sequenceIndex = wanted >= 0
        ? wanted
        : resolveSequenceIndex(data.sequences, data.animLookup, animationId);
      if (sequenceIndex !== active) {
        const wantedBlend = data.sequences[sequenceIndex]?.blendTime ?? 0;
        blendFromActive = active >= 0 && wantedBlend > 0 ? active : -1;
        blendFromElapsedMs = elapsedMs;
        blendElapsedMs = 0;
        blendDurationMs = wantedBlend;
        active = sequenceIndex;
        elapsedMs = 0;
        settleCapMs = Number.POSITIVE_INFINITY;
      }
      const sequence = data.sequences[active];
      if (!sequence) return;
      globalElapsedMs += dt * 1000;
      elapsedMs += dt * 1000;
      if (blendFromActive >= 0) {
        blendElapsedMs += dt * 1000;
        blendFromElapsedMs += dt * 1000;
        if (blendElapsedMs >= blendDurationMs) {
          blendFromActive = -1;
          blendDurationMs = 0;
        }
      }
      const duration = Math.max(1, sequence.duration || sequence.timeEnd - sequence.timeStart || 1);
      // Death (anim id 1) plays once and HOLDS the last frame — looping it makes corpses
      // repeatedly collapse. One-shot spell bursts hold for the same reason: their M2 sequences
      // are authored replayMin=replayMax=0, and wrapping them replayed the visible mesh for as
      // long as the slowest particle stayed alive. Everything else loops as before.
      // A sustained visual (precast glow, channel) legitimately loops while it is emitting: the
      // authored sequence is shorter than the cast bar it has to cover. What it must NOT do is
      // keep looping through the particle tail after emission stops — that tail is up to 1.2s on
      // the precast hands, which replayed a 1000ms sequence another 1.2 times AFTER the cast
      // finished. Latch the end of the cycle in flight and hold there, so the effect finishes the
      // swirl it started instead of either snapping to the final frame or starting over.
      if (settle && settleCapMs === Number.POSITIVE_INFINITY) {
        settleCapMs = Math.max(duration - 1, Math.ceil(elapsedMs / duration) * duration - 1);
      }
      const time = animationId === 1 || options.holdLastFrame
        ? sequence.timeStart + Math.min(elapsedMs, duration - 1)
        : sequence.timeStart + (Math.min(elapsedMs, settleCapMs) % duration);
      let upperBodyTime = 0;
      if (requestedUpperBodyAnimationId !== undefined) {
        if (requestedUpperBodyAnimationId !== upperBodyAnimationId) {
          const variants = variationsById.get(requestedUpperBodyAnimationId);
          upperBodyActive = variants?.length
            ? variants[Math.floor(Math.random() * variants.length)]
            : sequenceFor(requestedUpperBodyAnimationId);
          upperBodyAnimationId = requestedUpperBodyAnimationId;
          upperBodyElapsedMs = 0;
        }
        upperBodyElapsedMs += dt * 1000;
        const upperSequence = data.sequences[upperBodyActive];
        if (upperSequence) {
          const upperDuration = Math.max(1, upperSequence.duration || upperSequence.timeEnd - upperSequence.timeStart || 1);
          upperBodyTime = upperSequence.timeStart + (upperBodyElapsedMs % upperDuration);
        }
      } else {
        upperBodyAnimationId = -1;
        upperBodyActive = -1;
      }
      // Window used to reject keyframes that belong to a different animation (degenerate ranges).
      const blending = blendFromActive >= 0 && blendDurationMs > 0;
      const blendWeight = blending ? Math.max(0, Math.min(1, blendElapsedMs / blendDurationMs)) : 1;
      const blendSequence = blending ? data.sequences[blendFromActive] : undefined;
      const blendSequenceDuration = blendSequence
        ? Math.max(1, blendSequence.duration || blendSequence.timeEnd - blendSequence.timeStart || 1)
        : 1;
      const blendTime = blendSequence
        ? blendSequence.timeStart + (
            // Death is a one-shot held on its final frame. Preserve that held pose while blending
            // into resurrection instead of modulo-wrapping the source back to standing frame zero.
            blendSequence.id === 1
              ? Math.min(blendFromElapsedMs, blendSequenceDuration - 1)
              : blendFromElapsedMs % blendSequenceDuration
          )
        : 0;
      const billboarding = !!camera && !!group;
      if (billboarding) {
        camLocal.copy(camera!.position);
        group!.worldToLocal(camLocal);
      }

      for (let index = 0; index < data.bones.length; index++) {
        const bone = data.bones[index];
        const cursors = trackCursors[index];
        const upperBody = upperBodyActive >= 0 && upperBodyBones.has(index);
        const sampledSequence = upperBody ? upperBodyActive : active;
        const sampledTime = upperBody ? upperBodyTime : time;
        sampleVector(bone.translation, sampledSequence, sampledTime, zero3, sampledTranslation, cursors.translation[0]);
        sampleVector(bone.scale, sampledSequence, sampledTime, one3, sampledScale, cursors.scale[0]);
        sampledRot.copy(sampleQuat(bone.rotation, sampledSequence, sampledTime, cursors.rotation[0]));
        if (blending && !upperBody) {
          sampleVector(bone.translation, blendFromActive, blendTime, zero3, blendTranslation, cursors.translation[1]);
          sampleVector(bone.scale, blendFromActive, blendTime, one3, blendScale, cursors.scale[1]);
          blendTargetRot.copy(sampledRot);
          blendPrevRot.copy(sampleQuat(bone.rotation, blendFromActive, blendTime, cursors.rotation[1]));
          sampledTranslation[0] = blendTranslation[0] + (sampledTranslation[0] - blendTranslation[0]) * blendWeight;
          sampledTranslation[1] = blendTranslation[1] + (sampledTranslation[1] - blendTranslation[1]) * blendWeight;
          sampledTranslation[2] = blendTranslation[2] + (sampledTranslation[2] - blendTranslation[2]) * blendWeight;
          sampledScale[0] = blendScale[0] + (sampledScale[0] - blendScale[0]) * blendWeight;
          sampledScale[1] = blendScale[1] + (sampledScale[1] - blendScale[1]) * blendWeight;
          sampledScale[2] = blendScale[2] + (sampledScale[2] - blendScale[2]) * blendWeight;
          sampledRot.slerpQuaternions(blendPrevRot, blendTargetRot, blendWeight);
        }
        trans.fromArray(sampledTranslation);
        scale.fromArray(sampledScale);
        pivot.fromArray(bone.pivot);
        pivotMat.makeTranslation(pivot.x, pivot.y, pivot.z);
        negPivotMat.makeTranslation(-pivot.x, -pivot.y, -pivot.z);
        anim.compose(trans, sampledRot, scale);
        local.copy(pivotMat).multiply(anim).multiply(negPivotMat);
        if (bone.parentIndex >= 0 && matrices[bone.parentIndex]) matrices[index].multiplyMatrices(matrices[bone.parentIndex], local);
        else matrices[index].copy(local);

        // Billboard: turn flagged bones to face the camera about world-up (Z). Computed in model-local
        // space (camLocal) — the entity group only rotates about Z, so local Z == world up.
        if (billboarding && (bone.flags & M2_BONE_BILLBOARD_MASK) !== 0) {
          bonePos.copy(pivot).applyMatrix4(matrices[index]);
          boneScale.setFromMatrixScale(matrices[index]);
          billRot.setFromAxisAngle(billZAxis, Math.atan2(camLocal.y - bonePos.y, camLocal.x - bonePos.x));
          anim.compose(bonePos, billRot, boneScale);
          matrices[index].copy(anim).multiply(negPivotMat);
        }
      }

      // Do NOT cancel the root bone (bone 0). It was being inverted out of every vertex to "anchor"
      // the model, but that also undoes the root's animated ROTATION — so the death collapse (which
      // lays the body down by rotating the root) was reverted, leaving the corpse standing/contorted
      // and ~0.22 above ground. Bind-pose feet already sit at z≈0, and the server position places the
      // model, so the root needs no cancellation. (Kept as identity so getAttachmentMatrix stays in
      // the same model-local space as the skinned mesh.)
      rootInv.identity();
      gpuSkinning?.update(matrices, rootInv);
      recordM2Animator(samplingStarted >= 0 ? performance.now() - samplingStarted : undefined);
    } finally { endCpuScope(cpuScope); }
  };

  const getAttachmentMatrix = (attachmentId: number, target = new THREE.Matrix4()) => {
    const attachment = attachmentById.get(attachmentId);
    if (!attachment) return null;
    const boneMatrix = matrices[attachment.bone];
    if (!boneMatrix) return null;
    attachmentLocal.makeTranslation(attachment.position[0], attachment.position[1], attachment.position[2]);
    return target.copy(rootInv).multiply(boneMatrix).multiply(attachmentLocal);
  };

  const getBoneMatrix = (boneIndex: number, target = new THREE.Matrix4()) => {
    const boneMatrix = matrices[boneIndex];
    return boneMatrix ? target.copy(rootInv).multiply(boneMatrix) : null;
  };

  return {
    update,
    getAttachmentMatrix,
    getBoneMatrix,
    bindGroup: (group) => gpuSkinning?.bindGroup(group),
    getSkinnedPosition: (vertexIndex, target = new THREE.Vector3()) => gpuSkinning
      ? gpuSkinning.getSkinnedPosition(vertexIndex, data.positions, target)
      : target.set(0, 0, 0),
    dispose: () => gpuSkinning?.dispose(),
  };
}

/** Drive emitter/attachment bones without allocating an unused GPU skinning palette. */
export const createM2BoneAnimator = (
  data: Omit<M2AnimationData, 'positions' | 'boneWeights' | 'boneIndices'>,
  options: { holdLastFrame?: boolean } = {},
) => createM2Animator({
  ...data,
  positions: [],
  boneWeights: [],
  boneIndices: [],
}, null, null, { ...options, boneOnly: true });
