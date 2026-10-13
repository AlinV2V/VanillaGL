import { getPerformanceProfile } from '../platform/performance-profile';

export type VanillaVideoCvars = {
  desktopGamma: number;
  specular: number;
  ffxGlow: number;
  trilinear: number;
  gxVSync: number;
  movieSubtitle: number;
  lod: number;
  M2UseShaders: number;
  useUiScale: number;
  gxWindow: number;
  pixelShaders: number;
  ffxDeath: number;
  gxTripleBuffer: number;
  gxCursor: number;
  M2UsePixelShaders: number;
  gxFixLag: number;
  gxMaximize: number;
  useWeatherShaders: number;
  uiscale: number;
  farclip: number;
  WorldDetail: number;
  TerrainMip: number;
  BaseMip: number;
  gamma: number;
  anisotropic: number;
  spellEffectLevel: number;
  weatherDensity: number;
  unitDrawDist: number;
/** Asset conversion utility. */
SmallCull: number;
  /**
   * "Object distance culling", .data 0x008696d0. Optional because its shipped default is NOT
   * confirmed: the default slot at 0x008696f4 is four bytes, so the string is at most three
   * characters, and no extraction in this workspace reads the characters themselves. Leave it
   * unset and the renderer falls back to the active farclip rather than invent a number.
   */
  DistCull?: number;
  gxResolution: string;
  gxRefresh: string;
};

/** Browser-only video controls. Keep these out of the Build 5875 default table below. */
export type BrowserVideoCvars = VanillaVideoCvars & {
  /** Fraction of native device 3D resolution; HUD sizing is independent. */
  renderScale: number;
};

export const VANILLA_VIDEO_CVAR_DEFAULTS: VanillaVideoCvars = {
  // 1.12.1 FrameXML reads defaults through GetCVarDefault()/RestoreVideoDefaults().
  // Values here are the binary-validated defaults supplied from the vanilla client audit.
  desktopGamma: 0,
  specular: 1,
  ffxGlow: 1,
  trilinear: 1,
  gxVSync: 0,
  movieSubtitle: 1,
  lod: 1,
  M2UseShaders: 1,
  useUiScale: 0,
  gxWindow: 0,
  pixelShaders: 1,
  ffxDeath: 1,
  gxTripleBuffer: 0,
  gxCursor: 1,
  M2UsePixelShaders: 1,
  gxFixLag: 1,
  gxMaximize: 0,
  useWeatherShaders: 1,
  uiscale: 1.0,
  farclip: 777.0,
  WorldDetail: 2,
  // Binary/FrameXML validated: 0 keeps mip level 0 (full texture quality), 1 skips it.
  TerrainMip: 0,
  BaseMip: 0,
  gamma: 1.0,
  anisotropic: 1,
  spellEffectLevel: 2,
  weatherDensity: 3,

  unitDrawDist: 300,

  // "0.04" at 0x00869718. DistCull is deliberately absent — its default slot at 0x008696f4 is only
  // four bytes and no extraction reads the characters, so the renderer falls back to farclip
  // instead of shipping a guess. See rendering/doodad-culling.ts.
  SmallCull: 0.04,
  gxResolution: '1024x768',
  gxRefresh: '60',
};


export const UI_SCALE_VANILLA_MIN = 0.64;
export const UI_SCALE_VANILLA_MAX = 1;

/**
 * DELIBERATE DIVERGENCE, opt-in only.
 *
 * The slider is allowed past vanilla's 1.0 so the HUD can be made larger on a 1080p+ display. At a
 * genuine 1920x1080 the client caps the action bar at 1216 physical px (`MainMenuBar.xml`: 1024 wide
 * plus two 128px end caps anchored at +/-544), which is 63% of the screen — correct, and smaller
 * than players used to a lower-resolution client expect.
 *
 * This ceiling applies to the **explicit slider only**. `useUiScale = 0` still returns the
 * byte-exact automatic value and can never exceed `UI_SCALE_VANILLA_MAX`; `verify-player-ui.mjs`
 * asserts that separation.
 */
export const UI_SCALE_EXTENDED_MAX = 2;


export function vanillaUiScale(
  cvars: Pick<VanillaVideoCvars, 'useUiScale' | 'uiscale'>,
  framebufferWidth: number,
  framebufferHeight: number,
) {
  const width = Math.max(1, framebufferWidth);
  const height = Math.max(1, framebufferHeight);
  const aspect = width / height;
  const narrowAspectCap = aspect * 0.75;
  const narrow = aspect * 3 < 4;

  if (Number(cvars.useUiScale) === 1) {
    let scale = Math.max(UI_SCALE_VANILLA_MIN, Math.min(UI_SCALE_EXTENDED_MAX, Number(cvars.uiscale) || 1));
    if (narrow && narrowAspectCap <= scale) scale = narrowAspectCap;
    return Math.max(UI_SCALE_VANILLA_MIN, scale);
  }


  let scale = height > 768 ? 768 / height : 1;
  if (narrow && narrowAspectCap <= scale) scale = narrowAspectCap;
  if (scale <= 0.9) scale = 0.9;
  return Math.max(UI_SCALE_VANILLA_MIN, Math.min(UI_SCALE_VANILLA_MAX, scale));
}


export const BROWSER_VIDEO_CVAR_DEFAULTS: BrowserVideoCvars = {
  ...VANILLA_VIDEO_CVAR_DEFAULTS,
  useUiScale: 1,
  uiscale: 1.1,
  
  farclip: 350,
  /**
   * Unit draw distance. Vanilla registers `"300.0"`, but vMaNGOS only replicates entities within
   * `DEFAULT_VISIBILITY_DISTANCE = 100.0f` on continents (`ObjectDefines.h:30`), so any client-side
   * limit above 100 can never fire against a stock realm. Starting at 100 matches what the server
   * actually sends — nothing a player could see is culled — while making every slider position
   * below it do real work. The slider still reaches 300 for realms that raise visibility.
   */
  unitDrawDist: 100,
  // Deliberate browser-only quality control. One preserves the current/default presentation.
  renderScale: 1,
};

export const RENDER_SCALE_MIN = 0.1;
export const RENDER_SCALE_MAX = 1;

/** 100% means native DPR. Only renderer allocation limits may reduce it. */
export function browserRenderPixelRatio(devicePixelRatio: number, renderScale: number, _legacyCap = Infinity) {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const scale = Number.isFinite(renderScale) ? Math.max(RENDER_SCALE_MIN, Math.min(RENDER_SCALE_MAX, renderScale)) : 1;
  return dpr * scale;
}

const STORAGE_KEY = 'wow-browser-vanilla-video-cvars';
const STORAGE_SEMANTICS_VERSION = 3;
const numericKeys = new Set(
  Object.keys(BROWSER_VIDEO_CVAR_DEFAULTS).filter(
    (key) => typeof BROWSER_VIDEO_CVAR_DEFAULTS[key as keyof BrowserVideoCvars] === 'number',
  ),
);

export function normalizeVideoCvars(input: Partial<Record<keyof BrowserVideoCvars, unknown>>): BrowserVideoCvars {
  const merged = { ...BROWSER_VIDEO_CVAR_DEFAULTS };
  for (const key of Object.keys(BROWSER_VIDEO_CVAR_DEFAULTS) as Array<keyof BrowserVideoCvars>) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (numericKeys.has(key)) {
      const numberValue = Number(value);
      if (Number.isFinite(numberValue)) (merged as Record<string, number | string>)[key] = numberValue;
    } else {
      (merged as Record<string, number | string>)[key] = String(value);
    }
  }
  return merged;
}

export type GraphicsPreferences = {
  mode: 'recommended' | 'custom';
  dynamicResolution: 'off' | 'target60' | 'target30';
  presetVersion: number;
  detectedPresetId: string;
};
export function recommendedGraphicsPreferences(): GraphicsPreferences {
  return { mode: 'recommended', dynamicResolution: 'off', presetVersion: 1, detectedPresetId: getPerformanceProfile().id };
}
export function recommendedVideoCvars(): BrowserVideoCvars {
  const profile = getPerformanceProfile();
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  // Convert the old capped preset to a visible native fraction without increasing its workload.
  return normalizeVideoCvars({ ...BROWSER_VIDEO_CVAR_DEFAULTS, ...profile.video,
    renderScale: Math.max(RENDER_SCALE_MIN, Math.min(dpr, profile.maxPixelRatio) * profile.video.renderScale / dpr),
    ...(profile.device.mobile ? { useUiScale: 1, uiscale: 1.25 } : {}),
  });
}
type StoredVideo = Partial<Record<keyof BrowserVideoCvars, unknown>> & {
  _semanticsVersion?: number; _devicePreset?: string; _graphics?: Partial<GraphicsPreferences>;
};
let sessionVideo: StoredVideo | null = null;
function storedVideo(): StoredVideo | null {
  try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
  catch { return sessionVideo; }
}
export function loadGraphicsPreferences(): GraphicsPreferences {
  const value = storedVideo()?._graphics;
  return { ...recommendedGraphicsPreferences(),
    mode: value?.mode === 'custom' ? 'custom' : 'recommended',
    dynamicResolution: value?.dynamicResolution === 'target30' || value?.dynamicResolution === 'target60' ? value.dynamicResolution : 'off',
    presetVersion: Number(value?.presetVersion) || 1,
    detectedPresetId: typeof value?.detectedPresetId === 'string' ? value.detectedPresetId : getPerformanceProfile().id,
  };
}
export function loadVideoCvars(): BrowserVideoCvars {
  const saved = storedVideo();
  if (!saved) { const defaults = recommendedVideoCvars(); saveVideoCvars(defaults, recommendedGraphicsPreferences()); return defaults; }
  if ((saved._semanticsVersion ?? 1) < 2) { saved.TerrainMip = 0; saved.BaseMip = 0; }
  if ((saved._semanticsVersion ?? 1) < 3) {
    const profile = getPerformanceProfile();
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    saved.renderScale = Math.max(RENDER_SCALE_MIN, Math.min(dpr, profile.maxPixelRatio) * Math.max(0.5, Math.min(1, Number(saved.renderScale) || profile.video.renderScale)) / dpr);
    const migrated = normalizeVideoCvars({ ...recommendedVideoCvars(), ...saved });
    saveVideoCvars(migrated, { ...recommendedGraphicsPreferences(), mode: saved._devicePreset ? 'recommended' : 'custom' });
    return migrated;
  }
  return normalizeVideoCvars(saved);
}
export function saveVideoCvars(cvars: BrowserVideoCvars, preferences: GraphicsPreferences = { ...loadGraphicsPreferences(), mode: 'custom' }) {
  sessionVideo = { ...cvars, _semanticsVersion: STORAGE_SEMANTICS_VERSION, _graphics: preferences };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sessionVideo)); }
  catch { /* Private browsing may deny storage; the current session still applies the draft. */ }
}
export function restoreVideoDefaults(): BrowserVideoCvars {
  const defaults = recommendedVideoCvars();
  saveVideoCvars(defaults, recommendedGraphicsPreferences());
  return defaults;
}

export function gammaSliderValue(cvars: Pick<VanillaVideoCvars, 'gamma'>) {
  return 1 - cvars.gamma;
}

export function gammaCvarFromSlider(value: number) {
  return 1 - value;
}
