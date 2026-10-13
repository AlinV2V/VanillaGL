/** Asset conversion utility. */
export const SOCIAL_FEEDBACK_OPCODES = {
  SMSG_GROUP_DECLINE: 0x0074,
  SMSG_GROUP_UNINVITE: 0x0077,
  SMSG_GROUP_SET_LEADER: 0x0079,
  SMSG_GROUP_DESTROYED: 0x007c,
  SMSG_CHAT_WRONG_FACTION: 0x0219,
  SMSG_CHAT_PLAYER_NOT_FOUND: 0x02a9,
} as const;

export type SocialFeedbackReader = {
  readonly remaining: number;
  cstring(): string;
};

export type SocialFeedback = {
  kind: 'decline' | 'uninvite' | 'leader' | 'destroyed' | 'wrongFaction' | 'playerNotFound';
  message: string;
  leaderName?: string;
};

/** PartyResult codes from vMaNGOS WorldSession.h; exact Build-5875 GlobalStrings text. */
export const PARTY_RESULT_TEXT: Readonly<Record<number, string>> = {
  1: "Cannot find '%s'.",
  2: '%s is not in your party.',
  3: 'Your party is full.',
  4: '%s is already in a group.',
  5: "You aren't in a party.",
  6: 'You are not the party leader.',
  7: 'Target is not part of your alliance.',
  8: '%s is ignoring you.',
};

/** Guild CommandErrors from vMaNGOS Guild.h; exact Build-5875 GlobalStrings text. */
export const GUILD_RESULT_TEXT: Readonly<Record<number, string>> = {
  0x01: 'Internal guild error.',
  0x02: 'You are already in a guild.',
  0x03: '%s is already in a guild.',
  0x05: '%s has already been invited to a guild.',
  0x06: 'That name contains invalid characters,  Enter a new name.',
  0x07: 'There is already a guild named "%s".',
  0x08: "You don't have permission to do that.",
  0x09: 'You are not in a guild.',
  0x0a: '%s is not in your guild.',
  0x0b: '"%s" not found.',
  0x0c: 'You cannot invite players from the opposing alliance into your guild',
};

const fill = (template: string, params: readonly string[]) => {
  let index = 0;
  return template.replace(/%s/g, () => params[index++] ?? '');
};

/** GuildEvents ids from vMaNGOS Guild.h, with parameter order from GuildHandler.cpp. */
export function guildEventMessage(event: number, params: readonly string[]): string | undefined {
  switch (event) {
    case 0x03: return fill('%s has joined the guild.', params);
    case 0x04: return fill('%s has left the guild.', params);
    case 0x05: return fill('%s has been kicked out of the guild by %s.', params);
    case 0x00: return fill('%s has promoted %s to %s.', params);
    case 0x01: return fill('%s has demoted %s to %s.', params);
    case 0x02: return fill('Guild Message of the Day: %s', params);
    default: return undefined;
  }
}

function expectEmpty(reader: SocialFeedbackReader, label: string) {
  if (reader.remaining !== 0) throw new Error(`${label} expected an empty body, got ${reader.remaining} bytes`);
}

/** Decode one non-SMSG_MESSAGECHAT feedback packet into its stock system-chat line. */
export function readSocialFeedback(
  opcode: number,
  reader: SocialFeedbackReader,
  localPlayerName = '',
): SocialFeedback | undefined {
  switch (opcode) {
    case SOCIAL_FEEDBACK_OPCODES.SMSG_GROUP_DECLINE: {
      const name = reader.cstring();
      return { kind: 'decline', message: `${name} declines your group invitation.` };
    }
    case SOCIAL_FEEDBACK_OPCODES.SMSG_GROUP_UNINVITE:
      expectEmpty(reader, 'SMSG_GROUP_UNINVITE');
      return { kind: 'uninvite', message: 'You have been removed from the group.' };
    case SOCIAL_FEEDBACK_OPCODES.SMSG_GROUP_SET_LEADER: {
      const leaderName = reader.cstring();
      const self = !!localPlayerName && leaderName.toLocaleLowerCase() === localPlayerName.toLocaleLowerCase();
      return { kind: 'leader', leaderName, message: self ? 'You are now the group leader.' : `${leaderName} is now the group leader.` };
    }
    case SOCIAL_FEEDBACK_OPCODES.SMSG_GROUP_DESTROYED:
      expectEmpty(reader, 'SMSG_GROUP_DESTROYED');
      return { kind: 'destroyed', message: 'Your group has been disbanded.' };
    case SOCIAL_FEEDBACK_OPCODES.SMSG_CHAT_WRONG_FACTION:
      expectEmpty(reader, 'SMSG_CHAT_WRONG_FACTION');
      return { kind: 'wrongFaction', message: 'You can only whisper to members of your alliance.' };
    case SOCIAL_FEEDBACK_OPCODES.SMSG_CHAT_PLAYER_NOT_FOUND: {
      const name = reader.cstring();
      return { kind: 'playerNotFound', message: `No player named '${name}' is currently playing.` };
    }
    default:
      return undefined;
  }
}
