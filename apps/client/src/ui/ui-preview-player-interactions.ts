import { InspectFrame } from './inspect-frame';
import { installUnitPopup, showUnitPopup } from './unit-popup';
import { ReadyCheckController } from './ready-check';
import { PartyHudCanvas } from './party-pet-hud';

/** Offline rendered fixtures for interaction panels that normally require a second live player. */
export function showPlayerInteractionPreview(which: string, hud: HTMLElement): boolean {
  if (which === 'party-hud') {
    document.body.style.background = 'linear-gradient(#39532c, #1e341b)';
    const party = new PartyHudCanvas(hud.querySelector<HTMLElement>('#wow-party-hud')!);
    const entities = new Map<string, any>([
      ['leader', { guid: 'leader', typeId: 4, race: 1, gender: 0, powerType: 1, health: 487, maxHealth: 612, powers: [0, 430], maxPowers: [0, 1000] }],
      ['mage', { guid: 'mage', typeId: 4, race: 7, gender: 1, powerType: 0, health: 238, maxHealth: 401, powers: [724], maxPowers: [1100] }],
    ]);
    const profiles = new Map<string, { race: number; gender: number }>([
      ['leader', { race: 1, gender: 0 }], ['mage', { race: 7, gender: 1 }],
    ]);
    party.update({
      groupType: 0, groupLeaderGuid: 'leader', lootMethod: 2, looterGuid: 'mage', lootThreshold: 2,
      group: [
        { guid: 'leader', name: 'Marshal McBride', online: true, subgroup: 0, assistant: false },
        { guid: 'mage', name: 'Millie Oslo', online: true, subgroup: 0, assistant: false },
      ],
    } as never, (guid) => entities.get(guid), () => undefined, (guid) => profiles.get(guid));
    return true;
  }
  if (which === 'inspect') {
    const host = hud.querySelector<HTMLElement>('#wow-inspect-frame')!;
    const panel = new InspectFrame(host, 8, { playUi: () => {} });
    panel.show({
      guid: 'preview-player', title: 'Marshal McBride', subtitle: 'Level 12 Human Warrior',
      slots: [],
    }, {
      guid: 'preview-player', guidBytes: [], name: 'Marshal McBride', race: 1, classId: 1,
      gender: 0, skin: 0, face: 0, hairStyle: 1, hairColor: 1, facialHair: 1, level: 12,
      zone: 12, map: 0, x: 0, y: 0, z: 0, equipment: [],
    });
    let previous = performance.now();
    const update = (now: number) => {
      panel.update(Math.min(0.1, (now - previous) / 1000));
      previous = now;
      requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
    return true;
  }
  if (which === 'unit-popup') {
    document.body.style.background = 'linear-gradient(#39532c, #1e341b)';
    installUnitPopup({
      getWorld: () => ({
        getPlayerName: () => ({ name: 'Marshal McBride' }),
        queryPlayerName: () => {},
      }),
      getPlayerGuid: () => 'preview-player',
    });
    showUnitPopup('target-player', 54, 58);
    return true;
  }
  if (which === 'party-popup') {
    document.body.style.background = 'linear-gradient(#39532c, #1e341b)';
    installUnitPopup({
      getWorld: () => ({
        getPlayerName: () => ({ name: 'Millie Oslo', race: 7, gender: 1 }),
        queryPlayerName: () => {},
        getSocial: () => ({
          group: [{ guid: 'party-member' }], groupLeaderGuid: 'preview-player',
          lootMethod: 2, looterGuid: 'preview-player', lootThreshold: 2,
        }),
        getEntity: (guid) => ({ typeId: 4, duelTeam: guid === 'preview-player' ? 1 : 2 }),
      }),
      getPlayerGuid: () => 'preview-player',
    });
    showUnitPopup('party-member', 54, 58);
    return true;
  }
  if (which === 'raid-target-menu') {
    document.body.style.background = 'linear-gradient(#39532c, #1e341b)';
    installUnitPopup({
      getWorld: () => ({
        getPlayerName: () => ({ name: 'Kobold Geomancer' }), queryPlayerName: () => {},
        canSetRaidTarget: () => true, getRaidTargetIndex: () => 8, setRaidTarget: () => {},
      }),
      getPlayerGuid: () => 'preview-player',
    });
    showUnitPopup('target-creature', 54, 58, true);
    return true;
  }
  if (which === 'ready-check') {
    document.body.style.background = 'linear-gradient(#39532c, #1e341b)';
    const snapshot = { groupType: 1, groupLeaderGuid: 'leader', group: [{ guid: 'leader', name: 'Marshal McBride', online: true }] };
    const controller = new ReadyCheckController(hud, {
      getWorld: () => ({
        getSocial: () => snapshot,
        getPlayerName: () => ({ name: 'Marshal McBride', race: 1, gender: 0 }),
        queryPlayerName: () => {}, confirmReadyCheck: () => {},
      }),
      getPlayerGuid: () => 'preview-player', getPlayerInfo: () => ({ name: 'Marshal McBride', race: 1, gender: 0 }),
      systemMessage: () => {}, playUi: () => {}, setTimer: () => 0, clearTimer: () => {},
    });
    controller.handle({ kind: 'readyCheckRequest' });
    return true;
  }
  return false;
}
