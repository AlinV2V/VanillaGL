import type { VanillaM2Track } from '@vanillagl/assets';

export type BakedM2Track = { i: number; g: number; ts: number[]; v: number[]; r?: [number, number][] };
export type BakedM2Transform = { t?: BakedM2Track; r?: BakedM2Track; s?: BakedM2Track };

const round = (value: number) => Math.round(value * 10_000) / 10_000;

export const bakeM2MaterialTrack = (track: VanillaM2Track | undefined, identity: number): BakedM2Track | undefined => {
  if (!track?.timestamps.length || !track.values.length) return undefined;
  const timestamps = track.timestamps.slice();
  const values = track.values.slice(0, timestamps.length * track.components);
  if (values.length < timestamps.length * track.components) return undefined;
  if (timestamps.length === 1 && values.every((value) => Math.abs(value - identity) < 1e-6)) return undefined;
  const baked: BakedM2Track = {
    i: track.interpolation,
    g: track.globalSequence,
    ts: timestamps,
    v: values.map(round),
  };
  if (track.globalSequence < 0 && track.ranges.length) {
    baked.r = track.ranges.map(([a, b]) => [
      Math.max(0, Math.min(timestamps.length - 1, a)),
      Math.max(0, Math.min(timestamps.length - 1, b)),
    ]);
  }
  return baked;
};

export const bakeM2TextureTransforms = (transforms: Array<{
  translation: VanillaM2Track;
  rotation: VanillaM2Track;
  scaling: VanillaM2Track;
}>): BakedM2Transform[] => transforms.map((transform) => ({
  t: bakeM2MaterialTrack(transform.translation, 0),
  r: bakeM2MaterialTrack(transform.rotation, 0),
  s: bakeM2MaterialTrack(transform.scaling, 1),
}));
