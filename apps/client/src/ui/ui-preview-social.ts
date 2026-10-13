import type { SocialSnapshot } from '../world';
import { GUILD_RIGHT_ALL } from '../world/guild-administration';
import { SocialFrameController } from './social-frame';

/** Offline Friends/Guild/Raid fixtures kept out of the ratcheted ui-preview.ts coordinator. */
export function showSocialPreview(which: string, root: HTMLElement): boolean {
  const supported = ['social', 'social-prompt', 'raid-roster', 'raid-convert', 'guild-roster', 'guild-control', 'guild-member', 'guild-info'].includes(which);
  if (!supported) return false;
  const raidPreview = which === 'raid-roster' || which === 'raid-convert';
  const guildPreview = which.startsWith('guild-');
  const self = { guid: 'self', name: 'Bolvar', level: 60, classId: 2 };
  const snapshot: SocialSnapshot = {
    friends: [
      { guid: 'friend-1', status: 1, area: 12, level: 12, classId: 1 },
      { guid: 'friend-2', status: 0, area: 0, level: 9, classId: 8 },
    ],
    ignored: [],
    who: [
      { name: 'Bolvar', guild: 'City_01', level: 60, classId: 2, race: 1, zoneId: 1519 },
      { name: 'Tyrion', guild: '', level: 42, classId: 4, race: 1, zoneId: 12 },
    ],
    whoOnline: 2,
    guild: !guildPreview ? [] : [
      { guid: self.guid, online: true, onlineFlags: 1, name: self.name, rankId: 0, level: 60, classId: 2, zoneId: 1519, note: 'Protecting City_01', officerNote: 'Guild Master' },
      { guid: 'jaina', online: true, onlineFlags: 1, name: 'Jaina', rankId: 1, level: 60, classId: 8, zoneId: 1519, note: 'Portal coordinator', officerNote: 'Arcane lead' },
      { guid: 'thrall', online: true, onlineFlags: 1, name: 'Thrall', rankId: 2, level: 60, classId: 7, zoneId: 1637, note: 'Veteran raider', officerNote: '' },
      { guid: 'valeera', online: true, onlineFlags: 3, name: 'Valeera', rankId: 3, level: 60, classId: 4, zoneId: 1519, note: 'On patrol', officerNote: '' },
      { guid: 'rexxar', online: false, onlineFlags: 0, name: 'Rexxar', rankId: 4, level: 60, classId: 3, zoneId: 17, lastOnlineDays: 2.4, note: 'Outland expedition', officerNote: '' },
    ],
    guildMotd: guildPreview ? 'Welcome! Molten Core forms at 19:30 server time.' : '',
    guildInfoText: guildPreview ? 'Knights of Azeroth is a social raiding guild. Be kind, help new members, and sign up before raid night.' : '',
    guildRankRights: guildPreview ? [GUILD_RIGHT_ALL, GUILD_RIGHT_ALL, 0x2043, 0x43, 0x43, 0x43] : [],
    guildName: guildPreview ? 'Knights of Azeroth' : '',
    guildRankNames: guildPreview ? ['Guild Master', 'Officer', 'Veteran', 'Member', 'Initiate', 'Recruit'] : [],
    groupType: which === 'raid-roster' ? 1 : 0,
    group: !raidPreview ? [] : which === 'raid-convert'
      ? [{ guid: 'jaina', name: 'Jaina', online: true, subgroup: 0, assistant: false }]
      : [
          { guid: 'jaina', name: 'Jaina', online: true, subgroup: 0, assistant: true },
          { guid: 'thrall', name: 'Thrall', online: true, subgroup: 1, assistant: false },
          { guid: 'valeera', name: 'Valeera', online: true, subgroup: 1, assistant: false },
          { guid: 'tyrande', name: 'Tyrande', online: true, subgroup: 2, assistant: false },
          { guid: 'malfurion', name: 'Malfurion', online: true, subgroup: 2, assistant: false },
          { guid: 'rexxar', name: 'Rexxar', online: true, subgroup: 3, assistant: false },
          { guid: 'guldan', name: "Gul'dan", online: false, subgroup: 4, assistant: false },
        ],
    groupLeaderGuid: raidPreview ? self.guid : undefined,
    ownSubgroup: 0,
    ownAssistant: false,
    raidTargets: Array(8).fill(undefined),
  };
  const profiles: Record<string, { name: string; classId: number; level: number }> = {
    jaina: { name: 'Jaina', classId: 8, level: 60 },
    thrall: { name: 'Thrall', classId: 7, level: 60 },
    valeera: { name: 'Valeera', classId: 4, level: 60 },
    tyrande: { name: 'Tyrande', classId: 5, level: 60 },
    malfurion: { name: 'Malfurion', classId: 11, level: 60 },
    rexxar: { name: 'Rexxar', classId: 3, level: 60 },
    guldan: { name: "Gul'dan", classId: 9, level: 60 },
  };
  let notify: ((value: SocialSnapshot) => void) | undefined;
  const subgroup = (name: string) => name === self.name
    ? snapshot.ownSubgroup ?? 0
    : snapshot.group.find((member) => member.name === name)?.subgroup;
  const setSubgroup = (name: string, value: number) => {
    if (name === self.name) snapshot.ownSubgroup = value;
    else {
      const member = snapshot.group.find((entry) => entry.name === name);
      if (member) member.subgroup = value;
    }
  };
  const world = {
    onSocial: (callback: (value: SocialSnapshot) => void) => {
      notify = callback;
      callback(snapshot);
      return () => { notify = undefined; };
    },
    getSocial: () => snapshot,
    requestSocialLists: () => {},
    requestWho: () => {},
    requestGuildRoster: () => {},
    addFriend: () => {},
    inviteToParty: () => {},
    guildInvite: () => {},
    guildSetMotd: (motd: string) => { snapshot.guildMotd = motd; notify?.(snapshot); },
    canManageGuildRanks: () => guildPreview,
    guildSaveRank: (rank: number, rights: number, name: string) => { snapshot.guildRankRights[rank] = rights; snapshot.guildRankNames[rank] = name; notify?.(snapshot); },
    guildAddRank: (name: string) => { snapshot.guildRankRights.push(0x43); snapshot.guildRankNames.push(name); notify?.(snapshot); },
    guildDeleteLowestRank: () => { snapshot.guildRankRights.pop(); snapshot.guildRankNames.pop(); notify?.(snapshot); },
    guildSetPublicNote: (name: string, note: string) => { const member = snapshot.guild.find((entry) => entry.name === name); if (member) member.note = note; notify?.(snapshot); },
    guildSetOfficerNote: (name: string, note: string) => { const member = snapshot.guild.find((entry) => entry.name === name); if (member) member.officerNote = note; notify?.(snapshot); },
    guildSetInfoText: (info: string) => { snapshot.guildInfoText = info; notify?.(snapshot); },
    guildPromote: (name: string) => { const member = snapshot.guild.find((entry) => entry.name === name); if (member) member.rankId--; notify?.(snapshot); },
    guildDemote: (name: string) => { const member = snapshot.guild.find((entry) => entry.name === name); if (member) member.rankId++; notify?.(snapshot); },
    guildRemove: (name: string) => { snapshot.guild = snapshot.guild.filter((entry) => entry.name !== name); notify?.(snapshot); },
    getPlayerName: (guid: string) => profiles[guid] ?? { name: guid === 'friend-1' ? 'Marshal' : 'Melindra' },
    queryPlayerName: () => {},
    getEntity: (guid: string) => ({ level: profiles[guid]?.level ?? 60, classId: profiles[guid]?.classId }),
    getPartyVitals: () => undefined,
    canConvertToRaid: () => snapshot.groupType === 0 && snapshot.group.length > 0,
    convertToRaid: () => { snapshot.groupType = 1; notify?.(snapshot); },
    canSetRaidTarget: () => snapshot.groupType === 1,
    canStartReadyCheck: () => snapshot.groupType === 1,
    canManageRaidSubgroups: () => snapshot.groupType === 1,
    startReadyCheck: () => {},
    changeRaidSubgroup: (name: string, value: number) => { setSubgroup(name, value); notify?.(snapshot); },
    swapRaidSubgroups: (name: string, other: string) => {
      const left = subgroup(name);
      const right = subgroup(other);
      if (left === undefined || right === undefined) return;
      setSubgroup(name, right);
      setSubgroup(other, left);
      notify?.(snapshot);
    },
  };
  const controller = new SocialFrameController({
    root,
    getWorld: () => world as never,
    getPlayer: () => self,
    getAreaName: (id) => ({ 17: 'The Zone_06', 1519: 'City_01 City', 1637: 'City_03' })[id],
    initialTab: raidPreview ? 'raid' : guildPreview ? 'guild' : undefined,
    playUi: () => {},
    confirm: (_message, accept) => accept(),
  });
  controller.setOpen(true);
  if (which === 'social-prompt') controller.openAddContactPrompt('friends');
  if (which === 'guild-control') controller.showGuildPreview('control');
  else if (which === 'guild-member') controller.showGuildPreview('member');
  else if (which === 'guild-info') controller.showGuildPreview('info');
  return true;
}
