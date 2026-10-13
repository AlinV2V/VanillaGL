/** Build-5875 world notices which need client-side UI or an immediate response packet. */
export const WORLD_NOTICE_OPCODES = {
  CMSG_AREA_SPIRIT_HEALER_QUERY: 0x02e2,
  CMSG_AREA_SPIRIT_HEALER_QUEUE: 0x02e3,
  SMSG_SUMMON_REQUEST: 0x02ab,
  CMSG_SUMMON_RESPONSE: 0x02ac,
} as const;

/** UNIT_NPC_FLAGS_SPIRITHEALER | UNIT_NPC_FLAGS_SPIRITGUIDE (SharedDefines.h). */
export const SPIRIT_SERVICE_NPC_FLAGS = 0x00000060;

/** Spell.dbc / vMaNGOS: the battleground queue aura cancelled by CancelAreaSpiritHeal(). */
export const WAITING_TO_RESURRECT_SPELL_ID = 2584;

/**
 * StaticPopup_OnUpdate rounds the remaining seconds up on each frame, then changes to minutes at
 * 60 seconds. GetAreaSpiritHealerTime() has already truncated the packet's milliseconds to seconds.
 */
export function areaSpiritHealMessage(timeRemainingMs: number) {
  const seconds = Math.max(0, Math.floor(timeRemainingMs / 1000));
  if (seconds < 60) return `Resurrection in ${seconds} ${seconds === 1 ? 'Second' : 'Seconds'}`;
  const minutes = Math.ceil(seconds / 60);
  return `Resurrection in ${minutes} ${minutes === 1 ? 'Minute' : 'Minutes'}`;
}

/** ChatFrame.lua routes ZONE_UNDER_ATTACK through the yellow SYSTEM chat type. */
export function zoneUnderAttackMessage(areaName: string) {
  return `|cffffff00${areaName} is under attack!|r`;
}

/** StaticPopupDialogs["CONFIRM_SUMMON"], including its deliberate double sentence spacing. */
export function summonConfirmMessage(summoner: string, areaName: string, timeRemainingMs: number) {
  const seconds = Math.max(0, Math.floor(timeRemainingMs / 1000));
  const count = seconds < 60 ? seconds : Math.ceil(seconds / 60);
  const unit = seconds < 60
    ? (count === 1 ? 'Second' : 'Seconds')
    : (count === 1 ? 'Minute' : 'Minutes');
  return `${summoner} wants to summon you to ${areaName}.  The spell will be cancelled in ${count} ${unit}.`;
}
