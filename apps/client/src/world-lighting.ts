export type LightColor = [number, number, number];

/** A color keyframe track across the day (times in half-minutes, 0..dayLength). */
export type ColorBand = { t: number[]; v: LightColor[] };
/** A scalar keyframe track across the day. */
export type FloatBand = { t: number[]; v: number[] };

export type BakedLightProfile = {
  param: number;
  skybox?: string | null;
  /** LightParams.dbc field 4; FFXGlow.bls receives this as fullscreen primary.w. */
  glowIntensity?: number;
  bands: {
    sun: ColorBand;
    ambient: ColorBand; // up-facing / sky ambient
    skyTop: ColorBand;
    groundAmbient: ColorBand;
    skyMid: ColorBand;
    skyHorizon: ColorBand;
    fog: ColorBand;
  };
  floats: {
    fogEnd: FloatBand; // yards
    fogStartScale: FloatBand; // fraction of fogEnd where fog begins
  };
};

export type BakedLightRecord = {
  id: number;
  map: number;
  x: number;
  y: number;
  z: number;
  falloffStart: number;
  falloffEnd: number;
  params: number[];
  profile: BakedLightProfile;
  profiles?: BakedLightProfile[];
};

export type BakedLightingData = {
  version: number;
  dayLength: number; // 2880
  defaultTime: number; // 1440 (noon)
  mapCenter: number;
  unitsPerYard: number;
  maps: Record<string, { global: BakedLightRecord; zones: BakedLightRecord[] }>;
};

export type ResolvedLighting = {
  param: number;
  skybox: string | null;
  glowIntensity: number;
  sun: LightColor;
  ambient: LightColor;
  groundAmbient: LightColor;
  skyTop: LightColor;
  skyMid: LightColor;
  skyHorizon: LightColor;
  fog: LightColor;
  fogFar: number;
  fogNear: number;
  contributors: Array<{ id: number; param: number; weight: number }>;
};

export type Build5875SunDirection = [x: number, y: number, z: number];

/** Light.dbc's five profile slots: clear, clear-underwater, storm, storm-underwater, spirit. */
export function selectLightingProfileSlot(spiritWorld: boolean, weatherGrade: number, underwater: boolean): number {
  if (spiritWorld) return 4;
  if (weatherGrade > 0.12) return underwater ? 3 : 2;
  return underwater ? 1 : 0;
}

const lerp = (a: number, b: number, w: number) => a * (1 - w) + b * w;
const lerpColor = (a: LightColor, b: LightColor, w: LightColor[number] | number): LightColor => [
  lerp(a[0], b[0], w),
  lerp(a[1], b[1], w),
  lerp(a[2], b[2], w),
];


export function build5875SunDirection(
  timeHalfMinutes: number,
  dayLength = 2880,
): Build5875SunDirection {
  const day = Math.max(1, dayLength);
  const fraction = (((timeHalfMinutes % day) + day) % day) / day;
  const quarter = Math.floor(fraction * 4);
  const phase = fraction * 4 - quarter;
  const polarDegrees = quarter % 2 === 0
    ? lerp(127, 110, phase)
    : lerp(110, 127, phase);
  const polar = polarDegrees * Math.PI / 180;
  const azimuth = 225 * Math.PI / 180;
  const sinPolar = Math.sin(polar);
  return [
    Math.cos(azimuth) * sinPolar,
    Math.sin(azimuth) * sinPolar,
    Math.cos(polar),
  ];
}

/** Interpolate a color band at `time`, wrapping around the day boundary. */
function sampleColor(band: ColorBand, time: number, day: number): LightColor {
  const { t, v } = band;
  if (!t.length) return [0, 0, 0];
  if (t.length === 1) return v[0];
  const tm = ((time % day) + day) % day;
  for (let i = 0; i < t.length - 1; i++) {
    if (tm >= t[i] && tm <= t[i + 1]) {
      const f = t[i + 1] > t[i] ? (tm - t[i]) / (t[i + 1] - t[i]) : 0;
      return lerpColor(v[i], v[i + 1], f);
    }
  }
  // Wrap segment: from the last keyframe round to the first (+ a full day).
  const last = t.length - 1;
  const span = t[0] + day - t[last];
  const cur = tm >= t[last] ? tm : tm + day;
  const f = span > 0 ? Math.max(0, Math.min(1, (cur - t[last]) / span)) : 0;
  return lerpColor(v[last], v[0], f);
}

function sampleFloat(band: FloatBand, time: number, day: number): number {
  const { t, v } = band;
  if (!t.length) return 0;
  if (t.length === 1) return v[0];
  const tm = ((time % day) + day) % day;
  for (let i = 0; i < t.length - 1; i++) {
    if (tm >= t[i] && tm <= t[i + 1]) {
      const f = t[i + 1] > t[i] ? (tm - t[i]) / (t[i + 1] - t[i]) : 0;
      return lerp(v[i], v[i + 1], f);
    }
  }
  const last = t.length - 1;
  const span = t[0] + day - t[last];
  const cur = tm >= t[last] ? tm : tm + day;
  const f = span > 0 ? Math.max(0, Math.min(1, (cur - t[last]) / span)) : 0;
  return lerp(v[last], v[0], f);
}

type ProfileAtTime = {
  param: number;
  skybox: string | null;
  glowIntensity: number;
  sun: LightColor;
  ambient: LightColor;
  groundAmbient: LightColor;
  skyTop: LightColor;
  skyMid: LightColor;
  skyHorizon: LightColor;
  fog: LightColor;
  fogFar: number;
  fogStartScale: number;
};

function profileAtTime(record: BakedLightRecord, time: number, day: number, profileSlot = 0): ProfileAtTime {
  const profile = record.profiles?.[profileSlot] ?? record.profile;
  const b = profile.bands;
  return {
    param: profile.param,
    skybox: profile.skybox ?? null,
    glowIntensity: profile.glowIntensity ?? 0.5,
    sun: sampleColor(b.sun, time, day),
    ambient: sampleColor(b.ambient, time, day),
    groundAmbient: sampleColor(b.groundAmbient, time, day),
    skyTop: sampleColor(b.skyTop, time, day),
    skyMid: sampleColor(b.skyMid, time, day),
    skyHorizon: sampleColor(b.skyHorizon, time, day),
    fog: sampleColor(b.fog, time, day),
    fogFar: sampleFloat(profile.floats.fogEnd, time, day),
    fogStartScale: sampleFloat(profile.floats.fogStartScale, time, day),
  };
}

/**
 * Resolve the lit profile at a world position AND game time: interpolate each Light.dbc band by
 * time (day/night cycle), then spatially blend the global baseline with nearby zone lights.
 */
export function resolveLighting(
  data: BakedLightingData | null,
  map: number,
  x: number,
  y: number,
  z: number,
  time: number,
  zoneScale = 1,
  profileSlot = 0,
): ResolvedLighting | null {
  const mapLighting = data?.maps?.[String(map)];
  if (!mapLighting) return null;
  const day = data!.dayLength || 2880;

  const slot = Math.max(0, Math.min(4, Math.trunc(profileSlot)));
  const result = profileAtTime(mapLighting.global, time, day, slot);
  const contributors: ResolvedLighting['contributors'] = [
    { id: mapLighting.global.id, param: result.param, weight: 1 },
  ];

  const zones = mapLighting.zones
    .map((record) => {
      const distance = Math.hypot(x - record.x, y - record.y, z - record.z);
      const denominator = record.falloffEnd - record.falloffStart;
      const raw =
        distance <= record.falloffStart
          ? 1
          : denominator > 0
            ? Math.max(0, Math.min(1, 1 - (distance - record.falloffStart) / denominator))
            : 0;
      // zoneScale lets the client dial how strongly zone lights override the warm global light
      // (0 = global only, 1 = full vanilla blend). See the X5/L5 day-color contradiction.
      return { record, distance, weight: raw * Math.max(0, Math.min(1, zoneScale)) };
    })
    .filter(({ weight }) => weight > 0)

    // farthest first. Sequential interpolation then lets the nearest authored light win last.
    .sort((a, b) => b.distance - a.distance || a.record.id - b.record.id);

  for (const { record, weight } of zones) {
    const zone = profileAtTime(record, time, day, slot);
    result.param = zone.param;
    if (weight >= 0.5) result.skybox = zone.skybox;
    result.glowIntensity = lerp(result.glowIntensity, zone.glowIntensity, weight);
    result.sun = lerpColor(result.sun, zone.sun, weight);
    result.ambient = lerpColor(result.ambient, zone.ambient, weight);
    result.groundAmbient = lerpColor(result.groundAmbient, zone.groundAmbient, weight);
    result.skyTop = lerpColor(result.skyTop, zone.skyTop, weight);
    result.skyMid = lerpColor(result.skyMid, zone.skyMid, weight);
    result.skyHorizon = lerpColor(result.skyHorizon, zone.skyHorizon, weight);
    result.fog = lerpColor(result.fog, zone.fog, weight);
    result.fogFar = lerp(result.fogFar, zone.fogFar, weight);
    result.fogStartScale = lerp(result.fogStartScale, zone.fogStartScale, weight);
    contributors.push({ id: record.id, param: zone.param, weight });
  }

  return {
    param: result.param,
    skybox: result.skybox,
    glowIntensity: result.glowIntensity,
    sun: result.sun,
    ambient: result.ambient,
    groundAmbient: result.groundAmbient,
    skyTop: result.skyTop,
    skyMid: result.skyMid,
    skyHorizon: result.skyHorizon,
    fog: result.fog,
    fogFar: result.fogFar,
    fogNear: result.fogFar * (result.fogStartScale > 0 ? result.fogStartScale : 0.3),
    contributors,
  };
}
