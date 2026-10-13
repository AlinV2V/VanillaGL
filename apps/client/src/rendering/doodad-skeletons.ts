import type { M2AnimationData, M2Bone, M2Sequence, M2Track } from '../m2-animator';

type CompactTrack = { i: number; g: number; r: [number, number][]; t: number[]; v: number[]; c: number };
type CompactAsset = {
  n: number[];
  w: number[];
  j: number[];
  seq: M2Sequence[];
  gs: number[];
  al: number[];
  bones: Array<{
    flags: number;
    parentIndex: number;
    pivot: [number, number, number];
    translation: CompactTrack;
    rotation: CompactTrack;
    scale: CompactTrack;
  }>;
};

export type DoodadSkeleton = Omit<M2AnimationData, 'positions'> & { normals: number[] };

let manifestPromise: Promise<Record<string, string>> | undefined;
const assetCache = new Map<string, Promise<DoodadSkeleton | null>>();

const normalizeSource = (source: string) =>
  source.replace(/\//g, '\\').replace(/\.(mdx|mdl)$/i, '.m2').toLowerCase();
const expandTrack = (value: CompactTrack): M2Track => ({
  interpolation: value.i,
  globalSequence: value.g,
  ranges: value.r,
  timestamps: value.t,
  values: value.v,
  components: value.c,
});

const manifest = () => {
  manifestPromise ??= fetch('/terrain/doodad-anims/manifest.json')
    .then((response) => response.ok ? response.json() as Promise<Record<string, string>> : {})
    .catch(() => ({}));
  return manifestPromise;
};

export const loadDoodadSkeleton = (source: string | undefined): Promise<DoodadSkeleton | null> => {
  if (!source) return Promise.resolve(null);
  const key = normalizeSource(source);
  let pending = assetCache.get(key);
  if (!pending) {
    pending = manifest().then(async (index) => {
      const file = index[key];
      if (!file) return null;
      const response = await fetch(`/terrain/doodad-anims/${file}`);
      if (!response.ok) return null;
      const compact = await response.json() as CompactAsset;
      const bones: M2Bone[] = compact.bones.map((bone) => ({
        flags: bone.flags,
        parentIndex: bone.parentIndex,
        pivot: bone.pivot,
        translation: expandTrack(bone.translation),
        rotation: expandTrack(bone.rotation),
        scale: expandTrack(bone.scale),
      }));
      return {
        normals: compact.n,
        boneWeights: compact.w,
        boneIndices: compact.j,
        sequences: compact.seq,
        globalSequences: compact.gs,
        animLookup: compact.al,
        bones,
      };
    }).catch(() => null);
    assetCache.set(key, pending);
  }
  return pending;
};
