/** Asset conversion utility. */
export type InterfaceCvars = {
  // --- Basic: Controls ---
  mousespeed: number; // slider 0.5–1.5
  mouseInvertPitch: number;
  cameraSmoothTrackingStyle: string; // Click-to-Move Camera Style dropdown
  autointeract: number; // Click-to-Move
  stickyTargeting: number;
  assistAttack: number; // Attack on assist
  autoClearAFK: number;
  BlockTrades: number;
  autoSelfCast: number;

  // --- Basic: Display ---
  UberTooltips: number; // Enhanced Tooltips
  statusBarText: number; // Status Bar Text
  UnitNamePlayer: number; // Player Names
  UnitNamePlayerGuild: number; // Player Guild Names
  UnitNamePlayerPVPTitle: number; // Player Titles
  UnitNameNPC: number; // NPC Names
  UnitNameOwn: number; // Show Own Name
  showCloak: number;
  showHelm: number;
  showPartyBackground: number;
  instantQuestText: number;
  buffDurations: number;
  hideObjectiveTracker: number; // Hide Zone Objective Tracker
  autoQuestWatch: number; // Automatic Quest Tracking
  profanityFilter: number;

  // --- Basic: Camera ---
  cameraSmoothStyle: string; // Camera Following Style dropdown
  cameraTerrainTilt: number; // Follow Terrain
  cameraBobbing: number; // Head Bob
  cameraYawSmoothSpeed: number; // Auto-Follow Speed slider 90–270
  cameraWaterCollision: number;
  cameraPivot: number; // Smart Pivot
  cameraYawMoveSpeed: number; // Mouse Look Speed slider 90–270
  cameraDistanceMaxFactor: number; // Max Camera Distance slider 1–2

  // --- Basic: Help ---
  showTutorials: number;
  showLoadingScreenTips: number;
  detailedTooltips: number; // Show Detailed Tooltips

  // --- Advanced: Action Bars ---
  lockActionBars: number;
  showBottomLeftActionBar: number;
  alwaysShowActionBars: number;
  showBottomRightActionBar: number;
  showRightActionBar: number;
  showRightActionBar2: number;

  // --- Advanced: Chat ---
  simpleChat: number;
  chatLocked: number; // Lock Chat Settings
  guildMemberNotify: number; // Guild Member Alert
  removeChatDelay: number; // Remove Chat Hover Delay
  chatBubbles: number; // Show Chat Bubbles
  detailedLootInfo: number; // Detailed Loot Information
  chatBubblesParty: number; // Show Party Chat Bubbles
  autoJoinGuildRecruitment: number;
  disableSpamFilter: number;

  // --- Advanced: Raid & Party ---
  hidePartyInRaid: number;
  showPartyPets: number; // Show Party Members' Pets
  showDispelDebuffs: number; // Show Dispellable Debuffs
  showCastableBuffs: number;
  showTargetOfTarget: number;
  targetOfTargetMode: string; // Always / … dropdown

  // --- Advanced: Floating Combat Text ---
  enableFCT: number;
  fctFloatMode: string; // Combat Text Float Mode dropdown
  fctLowManaHealth: number;
  fctAuras: number;
  fctFadingAuras: number;
  fctCombatState: number;
  fctDodgeParryMiss: number;
  fctDamageReduction: number;
  fctReputation: number;
  fctReactives: number; // Reactive Spells and Abilities
  fctFriendlyHealers: number; // Friendly Healer Names
  fctComboPoints: number;
  fctEnergyGains: number;
  fctHonorGained: number;
  fctTargetDamage: number;
  fctPeriodicDamage: number; // depends on fctTargetDamage
  fctPetDamage: number; // depends on fctTargetDamage
};

export const INTERFACE_CVAR_DEFAULTS: InterfaceCvars = {
  // Basic: Controls
  mousespeed: 1.0,
  mouseInvertPitch: 0,
  cameraSmoothTrackingStyle: 'Smart',
  autointeract: 0,
  stickyTargeting: 0,
  assistAttack: 0,
  autoClearAFK: 1,
  BlockTrades: 0,
  autoSelfCast: 1,

  // Basic: Display
  UberTooltips: 1,
  statusBarText: 1,
  UnitNamePlayer: 1,
  UnitNamePlayerGuild: 1,
  UnitNamePlayerPVPTitle: 1,
  UnitNameNPC: 1,
  UnitNameOwn: 1,
  showCloak: 1,
  showHelm: 1,
  showPartyBackground: 0,
  instantQuestText: 1,
  buffDurations: 1,
  hideObjectiveTracker: 0,
  autoQuestWatch: 1,
  profanityFilter: 0,

  // Basic: Camera
  cameraSmoothStyle: 'Smart',
  cameraTerrainTilt: 0,
  cameraBobbing: 0,
  cameraYawSmoothSpeed: 180,
  cameraWaterCollision: 1,
  cameraPivot: 1,
  cameraYawMoveSpeed: 180,
  cameraDistanceMaxFactor: 1.9,

  // Basic: Help
  showTutorials: 0,
  showLoadingScreenTips: 0,
  detailedTooltips: 1,

  // Advanced: Action Bars
  lockActionBars: 0,
  showBottomLeftActionBar: 0,
  alwaysShowActionBars: 1,
  showBottomRightActionBar: 0,
  showRightActionBar: 0,
  showRightActionBar2: 0,

  // Advanced: Chat
  simpleChat: 0,
  chatLocked: 0,
  guildMemberNotify: 0,
  removeChatDelay: 0,
  chatBubbles: 1,
  detailedLootInfo: 1,
  chatBubblesParty: 0,
  autoJoinGuildRecruitment: 1,
  disableSpamFilter: 0,

  // Advanced: Raid & Party
  hidePartyInRaid: 0,
  showPartyPets: 1,
  showDispelDebuffs: 0,
  showCastableBuffs: 0,
  showTargetOfTarget: 0,
  targetOfTargetMode: 'Always',

  // Advanced: Floating Combat Text
  enableFCT: 1,
  fctFloatMode: 'Scroll Up',
  fctLowManaHealth: 1,
  fctAuras: 1,
  fctFadingAuras: 1,
  fctCombatState: 1,
  fctDodgeParryMiss: 1,
  fctDamageReduction: 1,
  fctReputation: 1,
  fctReactives: 1,
  fctFriendlyHealers: 1,
  fctComboPoints: 1,
  fctEnergyGains: 1,
  fctHonorGained: 1,
  fctTargetDamage: 1,
  fctPeriodicDamage: 1,
  fctPetDamage: 1,
};

const STORAGE_KEY = 'wowBrowser.interfaceCvars.v1';

const numericKeys = new Set(
  Object.keys(INTERFACE_CVAR_DEFAULTS).filter(
    (key) => typeof INTERFACE_CVAR_DEFAULTS[key as keyof InterfaceCvars] === 'number',
  ),
);

export function normalizeInterfaceCvars(
  input: Partial<Record<keyof InterfaceCvars, unknown>>,
): InterfaceCvars {
  const merged = { ...INTERFACE_CVAR_DEFAULTS };
  for (const key of Object.keys(INTERFACE_CVAR_DEFAULTS) as Array<keyof InterfaceCvars>) {
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

export function loadInterfaceCvars(): InterfaceCvars {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...INTERFACE_CVAR_DEFAULTS };
    return normalizeInterfaceCvars(JSON.parse(raw) as Partial<Record<keyof InterfaceCvars, unknown>>);
  } catch {
    return { ...INTERFACE_CVAR_DEFAULTS };
  }
}

export function saveInterfaceCvars(cvars: InterfaceCvars) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cvars));
}

export function restoreInterfaceDefaults(): InterfaceCvars {
  const defaults = { ...INTERFACE_CVAR_DEFAULTS };
  saveInterfaceCvars(defaults);
  return defaults;
}
