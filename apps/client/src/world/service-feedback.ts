/** Asset conversion utility. */
import { readSocialFeedback, SOCIAL_FEEDBACK_OPCODES } from './social-feedback';
import { readChannelList, type ChannelListPacket } from './channel-list';
import type { ReadGuid, Reader } from './wire';
export { ChannelListResolver } from './channel-list';

export const SERVICE_FEEDBACK_OPCODES = {
  ...SOCIAL_FEEDBACK_OPCODES,
  SMSG_GUILD_DECLINE: 0x0086,
  CMSG_GUILD_INFO: 0x0087,
  SMSG_GUILD_INFO: 0x0088,
  CMSG_CHANNEL_LIST: 0x009a,
  SMSG_CHANNEL_LIST: 0x009b,
  SMSG_OPEN_CONTAINER: 0x0113,
  SMSG_MOUNTRESULT: 0x016e,
  SMSG_DISMOUNTRESULT: 0x016f,
  SMSG_TAXINODE_STATUS: 0x01ab,
  SMSG_NEW_TAXI_PATH: 0x01af,
  SMSG_RAID_GROUP_ONLY: 0x0286,
  CMSG_PET_UNLEARN: 0x02f0,
  SMSG_PET_UNLEARN_CONFIRM: 0x02f1,
  SMSG_PLAY_TIME_WARNING: 0x02f5,
  SMSG_CHAT_RESTRICTED: 0x02fd,
  SMSG_DEFENSE_MESSAGE: 0x033b,
} as const;

export type ServiceFeedback =
  | { kind: 'system'; message: string; guildName?: string; areaId?: number }
  | ({ kind: 'channelList' } & ChannelListPacket)
  | { kind: 'uiError'; message: string }
  | { kind: 'openContainer'; itemGuid: string }
  | { kind: 'petUnlearnConfirm'; petGuid: string; cost: number }
  | { kind: 'raidGroupOnly'; timerMs: number; errorCode: number }
  | { kind: 'taxiNodeStatus'; guid: string; known: boolean }
  | { kind: 'none' };

const MOUNT_RESULT_TEXT: Readonly<Record<number, string>> = {
  0: "You can't mount that unit!",
  1: 'That mount is too far away!',
  2: "You're already mounted!",
  3: "That unit can't be mounted!",
  4: "That mount isn't your pet!",
  5: 'UNKNOWN MOUNT ERROR',
  6: "You can't mount while looting!",
  7: "You can't mount because of your race!",
  8: "You can't mount while shapeshifted!",
  9: 'You dismount before continuing.',
};

const DISMOUNT_RESULT_TEXT: Readonly<Record<number, string>> = {
  0: "INTERNAL ERROR, YOU DON'T HAVE A PET TO DISMOUNT",
  1: "You're not mounted!",
  2: 'INTERNAL ERROR, DISMOUNTING A NON-PET',
};

const plural = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

/** The two-unit English shape used by Build 5875's SecondsToTime helper. */
export function formatServiceTime(totalSeconds: number): string {
  let seconds = Math.max(0, Math.floor(totalSeconds));
  const parts: string[] = [];
  if (seconds > 86400) {
    const days = Math.floor(seconds / 86400);
    parts.push(plural(days, 'Day', 'Days'));
    seconds %= 86400;
  }
  if (seconds > 3600) {
    const hours = Math.floor(seconds / 3600);
    parts.push(plural(hours, 'Hr', 'Hrs'));
    seconds %= 3600;
  }
  if (parts.length < 2 && seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    parts.push(plural(minutes, 'Min', 'Mins'));
    seconds %= 60;
  }
  if (parts.length < 2 && seconds > 0) parts.push(plural(seconds, 'Sec', 'Secs'));
  return parts.join(' ');
}

export function raidGroupErrorMessage(errorCode: number): string {
  return errorCode === 2 ? 'The instance is full' : 'You must be in a raid group to enter this instance';
}

export function instanceBootMessage(bindLocation: string, timerMs: number): string {
  const seconds = Math.max(0, Math.ceil(timerMs / 1000));
  const amount = seconds < 60 ? seconds : Math.ceil(seconds / 60);
  const unit = seconds < 60
    ? (amount === 1 ? 'Second' : 'Seconds')
    : (amount === 1 ? 'Minute' : 'Minutes');
  return `You are not in this instance's group.  You will be teleported to ${bindLocation} in ${amount} ${unit}.`;
}

function expectDone(reader: Reader, label: string) {
  if (reader.remaining !== 0) throw new Error(`${label} left ${reader.remaining} unread bytes`);
}

function playTimeMessage(flag: number, timeLeftSeconds: number): string | undefined {
  const time = formatServiceTime(timeLeftSeconds);
  if (flag === 0x1000) return `You have ${time} until you enter tired time.  Your rewards will be cut in half.`;
  if (flag === 0x2000) {
    return `You have ${time} until you enter unhealthy time, at which point you will no longer receive experience or loot until you have logged out for 5 hours.`;
  }
  if (flag === 0x80000000) return 'Maximum play time exceeded';
  return undefined;
}

/** Decode one feedback opcode, consuming and validating its complete body. */
export function readServiceFeedback<R extends Reader>(
  opcode: number,
  reader: R,
  readGuid: ReadGuid<R>,
  localPlayerName = '',
): ServiceFeedback | undefined {
  const social = readSocialFeedback(opcode, reader, localPlayerName);
  if (social) {
    expectDone(reader, 'social feedback');
    return { kind: 'system', message: social.message };
  }

  switch (opcode) {
    case SERVICE_FEEDBACK_OPCODES.SMSG_GUILD_DECLINE: {
      const name = reader.cstring();
      expectDone(reader, 'SMSG_GUILD_DECLINE');
      return { kind: 'system', message: `${name} declines your guild invitation.` };
    }
    case SERVICE_FEEDBACK_OPCODES.SMSG_GUILD_INFO: {
      const guildName = reader.cstring();
      const createdDay = reader.u32();
      const createdMonth = reader.u32();
      const createdYear = reader.u32();
      const memberCount = reader.u32();
      const accountCount = reader.u32();
      expectDone(reader, 'SMSG_GUILD_INFO');
      return {
        kind: 'system', guildName,
        message: `Guild created ${createdMonth}-${createdDay}-${createdYear}, ${memberCount} players, ${accountCount} accounts`,
      };
    }
    case SERVICE_FEEDBACK_OPCODES.SMSG_CHANNEL_LIST:
      return { kind: 'channelList', ...readChannelList(reader, readGuid) };
    case SERVICE_FEEDBACK_OPCODES.SMSG_CHAT_RESTRICTED:
      expectDone(reader, 'SMSG_CHAT_RESTRICTED');
      return { kind: 'uiError', message: 'Trial accounts cannot send unlimited tells, you must wait before you can send tells to more players.' };
    case SERVICE_FEEDBACK_OPCODES.SMSG_MOUNTRESULT: {
      const result = reader.u32();
      expectDone(reader, 'SMSG_MOUNTRESULT');
      return result === 10 ? { kind: 'none' } : { kind: 'uiError', message: MOUNT_RESULT_TEXT[result] ?? MOUNT_RESULT_TEXT[5] };
    }
    case SERVICE_FEEDBACK_OPCODES.SMSG_DISMOUNTRESULT: {
      const result = reader.u32();
      expectDone(reader, 'SMSG_DISMOUNTRESULT');
      return result === 3 ? { kind: 'none' } : { kind: 'uiError', message: DISMOUNT_RESULT_TEXT[result] ?? DISMOUNT_RESULT_TEXT[0] };
    }
    case SERVICE_FEEDBACK_OPCODES.SMSG_OPEN_CONTAINER: {
      const itemGuid = readGuid(reader);
      expectDone(reader, 'SMSG_OPEN_CONTAINER');
      return { kind: 'openContainer', itemGuid };
    }
    case SERVICE_FEEDBACK_OPCODES.SMSG_TAXINODE_STATUS: {
      const guid = readGuid(reader);
      const known = reader.u8() !== 0;
      expectDone(reader, 'SMSG_TAXINODE_STATUS');
      return { kind: 'taxiNodeStatus', guid, known };
    }
    case SERVICE_FEEDBACK_OPCODES.SMSG_NEW_TAXI_PATH:
      expectDone(reader, 'SMSG_NEW_TAXI_PATH');
      return { kind: 'uiError', message: 'New flight path discovered!' };
    case SERVICE_FEEDBACK_OPCODES.SMSG_RAID_GROUP_ONLY: {
      const timerMs = reader.u32();
      const errorCode = reader.u32();
      expectDone(reader, 'SMSG_RAID_GROUP_ONLY');
      return { kind: 'raidGroupOnly', timerMs, errorCode };
    }
    case SERVICE_FEEDBACK_OPCODES.SMSG_PET_UNLEARN_CONFIRM: {
      const petGuid = readGuid(reader);
      const cost = reader.u32();
      expectDone(reader, 'SMSG_PET_UNLEARN_CONFIRM');
      return { kind: 'petUnlearnConfirm', petGuid, cost };
    }
    case SERVICE_FEEDBACK_OPCODES.SMSG_PLAY_TIME_WARNING: {
      const flag = reader.u32();
      const timeLeftSeconds = reader.i32();
      expectDone(reader, 'SMSG_PLAY_TIME_WARNING');
      const message = playTimeMessage(flag, timeLeftSeconds);
      return message ? { kind: 'uiError', message } : { kind: 'none' };
    }
    case SERVICE_FEEDBACK_OPCODES.SMSG_DEFENSE_MESSAGE: {
      const areaId = reader.u32();
      const messageLength = reader.u32();
      const before = reader.remaining;
      const message = reader.cstring();
      if (before - reader.remaining !== messageLength) throw new Error(`SMSG_DEFENSE_MESSAGE length ${messageLength} consumed ${before - reader.remaining}`);
      expectDone(reader, 'SMSG_DEFENSE_MESSAGE');
      return { kind: 'system', message, areaId };
    }
    default:
      return undefined;
  }
}
