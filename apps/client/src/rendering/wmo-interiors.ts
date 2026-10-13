import * as THREE from 'three';

type IndoorMaskSpec = {
  name: string;
  wmoPath: string;
  min: [number, number, number];
  max: [number, number, number];
  maskTerrain: boolean;
  maskClutter?: boolean;
};

export type IndoorMaskVolume = {
  name: string;
  position: THREE.Vector3;
  inverseRotation: THREE.Quaternion;
  min: THREE.Vector3;
  max: THREE.Vector3;
  maskTerrain: boolean;
};

const INDOOR_MASK_SPECS: IndoorMaskSpec[] = [
  {
    name: 'Goldshire Inn Ground Floor',
    wmoPath: 'world\\wmo\\azeroth\\buildings\\goldshireinn\\goldshireinn.wmo',
    min: [-15.2, -12.4, -0.5],
    max: [15.2, 12.4, 4.2],
    // Keep the authored ADT intact: this broad rectangle extends beyond the inn's WMO skirt and
    // created visible voids plus a 200-yard ground drop outside the wall. It remains useful for
    // suppressing grass/clutter beneath the interior floor.
    maskTerrain: false,
    maskClutter: true,
  },
  {
    name: 'Goldshire Inn Basement/Cellar',
    wmoPath: 'world\\wmo\\azeroth\\buildings\\goldshireinn\\goldshireinn.wmo',
    min: [-8.5, -6.2, -4.8],
    max: [8.5, 6.2, -0.5],
    maskTerrain: false,
    maskClutter: true,
  },
  {
    name: 'StartingZone_01 Abbey Main Hall',
    wmoPath: 'world\\wmo\\azeroth\\buildings\\nsabbey\\nsabbey.wmo',
    min: [-25.0, -18.0, -1.0],
    max: [25.0, 18.0, 15.0],
    // StartingZone_01's broad manual mask cuts visible terrain outside the WMO skirt.
    // Keep terrain intact until the WMO is rebaked with precise group bboxes.
    maskTerrain: false,
  },
  {
    name: 'Fargodeep Mine Entrance',
    wmoPath: 'world\\wmo\\azeroth\\dungeons\\fargodeepmine\\fargodeepmine.wmo',
    min: [-10.0, -8.0, -3.0],
    max: [10.0, 8.0, 3.0],
    maskTerrain: true,
  },
  {
    name: 'Fargodeep Mine Entrance',
    wmoPath: 'world\\wmo\\dungeon\\md_goldmine\\md_goldmine.wmo',
    min: [-10.0, -8.0, -3.0],
    max: [10.0, 8.0, 3.0],
    maskTerrain: true,
  },
  {
    name: 'Fargodeep Mine Deep Tunnel',
    wmoPath: 'world\\wmo\\azeroth\\dungeons\\fargodeepmine\\fargodeepmine.wmo',
    min: [-50.0, -30.0, -20.0],
    max: [20.0, 40.0, -5.0],
    maskTerrain: true,
  },
  {
    name: 'Fargodeep Mine Deep Tunnel',
    wmoPath: 'world\\wmo\\dungeon\\md_goldmine\\md_goldmine.wmo',
    min: [-50.0, -30.0, -20.0],
    max: [20.0, 40.0, -5.0],
    maskTerrain: true,
  },
  {
    name: 'Mine Deep Tunnel',
    wmoPath: 'world\\wmo\\dungeon\\md_spidermine\\md_spidermine.wmo',
    min: [-50.0, -30.0, -20.0],
    max: [20.0, 40.0, -5.0],
    maskTerrain: true,
  },
  {
    name: 'Coldridge Valley Anvilmar',
    wmoPath: 'world\\wmo\\dwarf\\buildings\\anvilmar\\anvilmar.wmo',
    min: [-30.0, -25.0, -2.0],
    max: [30.0, 25.0, 12.0],
    // Starter-zone ADTs already author the Anvilmar footprint (19 non-zero
    // hole bytes across the spawn tile). This broad box erased exterior snow
    // and created the same kind of edge void seen at StartingZone_01/Deathknell.
    maskTerrain: false,
  },
  {
    name: 'Shadowglen Aldrassil Hollow',
    wmoPath: 'world\\wmo\\nightelf\\buildings\\aldrassil\\aldrassil.wmo',
    min: [-20.0, -20.0, -1.0],
    max: [20.0, 20.0, 18.0],
    // Never synthesize a rectangular hole under Aldrassil's irregular roots.
    // The ADT/WMO geometry is authoritative for the starter tree transition.
    maskTerrain: false,
  },
  {
    name: 'Deathknell Graves Inn',
    wmoPath: 'world\\wmo\\undead\\buildings\\graveinn\\graveinn.wmo',
    min: [-12.0, -10.0, -0.5],
    max: [12.0, 10.0, 6.0],
    // Preserve authored Tirisfal terrain around the grave-inn skirt. A manual
    // rectangle can expose the void when the building footprint is rotated.
    maskTerrain: false,
  },
];

const normalizeAssetPath = (path: string) => path.replace(/\//g, '\\').toLowerCase();

export const buildIndoorMasks = (wmoData: any): IndoorMaskVolume[] => {
  if (!wmoData?.instances?.length || !wmoData?.models?.length) return [];
  const specsByPath = new globalThis.Map<string, IndoorMaskSpec[]>();
  for (const spec of INDOOR_MASK_SPECS) {
    if (!spec.maskTerrain && !spec.maskClutter) continue;
    const key = normalizeAssetPath(spec.wmoPath);
    const list = specsByPath.get(key);
    if (list) list.push(spec);
    else specsByPath.set(key, [spec]);
  }

  const masks: IndoorMaskVolume[] = [];
  for (const inst of wmoData.instances) {
    const model = wmoData.models[inst.m];
    const q = new THREE.Quaternion(inst.qx ?? 0, inst.qy ?? 0, inst.qz ?? 0, inst.qw ?? 1);
    const inverseRotation = q.clone().invert();
    const position = new THREE.Vector3(inst.x ?? 0, inst.y ?? 0, inst.z ?? 0);
    // MOGP interior bounds are lighting/visibility volumes, not terrain-hole
    // geometry.  Treating their broad AABBs as cutouts removed valid terrain
    // around irregular WMOs (notably Deathknell's crypt and StartingZone_01 Abbey).
    // ADT MCNK hole bits remain the authoritative general-purpose cutout.  The
    // small allow-list below is reserved for locations whose footprint has
    // been checked against the original client.
    const specs = specsByPath.get(normalizeAssetPath(model?.name ?? ''));
    if (!specs?.length) continue;

    for (const spec of specs) {
      masks.push({
        name: spec.name,
        position,
        inverseRotation,
        min: new THREE.Vector3(...spec.min),
        max: new THREE.Vector3(...spec.max),
        maskTerrain: spec.maskTerrain,
      });
    }
  }
  return masks;
};

export const isPointInIndoorMask = (
  point: THREE.Vector3,
  masks: IndoorMaskVolume[],
  scratch: THREE.Vector3,
  xyPadding = 0,
  zPadding = 0,
) => {
  for (const mask of masks) {
    scratch.copy(point).sub(mask.position).applyQuaternion(mask.inverseRotation);
    if (
      scratch.x >= mask.min.x - xyPadding &&
      scratch.x <= mask.max.x + xyPadding &&
      scratch.y >= mask.min.y - xyPadding &&
      scratch.y <= mask.max.y + xyPadding &&
      scratch.z >= mask.min.z - zPadding &&
      scratch.z <= mask.max.z + zPadding
    ) {
      return true;
    }
  }
  return false;
};
