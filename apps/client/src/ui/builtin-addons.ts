export type BuiltInAddonId = 'questHelper' | 'cooldownNumbers' | 'combatTimers' | 'itemTools'
  | 'mapCoordinates' | 'damageMeterLite' | 'bagSearch';
export type BuiltInAddonSettings = Record<BuiltInAddonId, boolean>;

export const BUILT_IN_ADDON_DEFAULTS: Readonly<BuiltInAddonSettings> = {
  questHelper: true,
  cooldownNumbers: true,
  combatTimers: false,
  itemTools: false,
  mapCoordinates: false,
  damageMeterLite: false,
  bagSearch: false,
};

export const BUILT_IN_ADDONS = [
  { id: 'questHelper', label: 'Quest Helper (Questie-lite)', section: 'Quests' },
  { id: 'cooldownNumbers', label: 'Cooldown Numbers', section: 'Action Bars' },
  { id: 'combatTimers', label: 'Combat Timers', section: 'Combat' },
  { id: 'itemTools', label: 'Item Tools', section: 'Items' },
  { id: 'mapCoordinates', label: 'Map Coordinates', section: 'Map' },
  { id: 'damageMeterLite', label: 'Damage Meter Lite', section: 'Combat' },
  { id: 'bagSearch', label: 'Bag Search', section: 'Items' },
] as const;

const STORAGE_KEY = 'vanillagl.builtinAddons.v1';
const listeners = new Set<(settings: BuiltInAddonSettings) => void>();
let cached: BuiltInAddonSettings | undefined;

export function loadBuiltInAddonSettings(): BuiltInAddonSettings {
  if (cached) return { ...cached };
  let stored: Partial<BuiltInAddonSettings> = {};
  try {
    if (typeof localStorage !== 'undefined') stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<BuiltInAddonSettings>;
  } catch { /* Invalid or unavailable browser storage falls back to defaults. */ }
  cached = { ...BUILT_IN_ADDON_DEFAULTS, ...stored };
  return { ...cached };
}

export function saveBuiltInAddonSettings(settings: BuiltInAddonSettings) {
  cached = { ...settings };
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch { /* The current session still receives the updated settings. */ }
  for (const listener of listeners) listener({ ...cached });
}

export function isBuiltInAddonEnabled(id: BuiltInAddonId) {
  return loadBuiltInAddonSettings()[id];
}

export function onBuiltInAddonSettings(listener: (settings: BuiltInAddonSettings) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
