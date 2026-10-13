import type { PartyVitals, PetSnapshot, SocialSnapshot, WorldEntity } from '../world';
import { VanillaCanvas } from './vanilla-canvas';
import { getInterfaceCvars } from './interface-runtime';
import { showUnitPopup } from './unit-popup';

/** vMaNGOS Group.h:119 — GROUPTYPE_RAID. GROUPTYPE_NORMAL is 0. */
const GROUPTYPE_RAID = 1;
const PORTRAIT_RACES: Record<number, string> = {
  1: 'Human', 2: 'Orc', 3: 'Dwarf', 4: 'NightElf', 5: 'Scourge', 6: 'Tauren', 7: 'Gnome', 8: 'Troll',
};
const POWER_COLORS: Record<number, string> = {
  0: '#0000ff', // mana
  1: '#ff0000', // rage
  2: '#ff8040', // focus
  3: '#ffff00', // energy
  4: '#00ff00', // happiness
};
const STATUS_BAR = '/ui/Interface/TargetingFrame/UI-StatusBar.png';
const portraitUrl = (race?: number, gender?: number) => race
  ? `/ui/Interface/CharacterFrame/TemporaryPortrait-${gender === 1 ? 'Female' : 'Male'}-${PORTRAIT_RACES[race] ?? 'Human'}.png`
  : '/ui/Interface/CharacterFrame/TemporaryPortrait-Monster.png';

export class PartyHudCanvas {
  private readonly surface = new VanillaCanvas(180, 240, 'wow-party-hud-canvas');
  private snapshot?: SocialSnapshot;
  private entityFor: (guid: string) => WorldEntity | undefined = () => undefined;
  private vitalsFor: (guid: string) => PartyVitals | undefined = () => undefined;
  private profileFor: (guid: string) => { race?: number; gender?: number } | undefined = () => undefined;

  constructor(private readonly host: HTMLElement) {
    host.appendChild(this.surface.canvas);
    this.surface.onRender(() => this.paint());
    this.surface.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    this.surface.canvas.addEventListener('pointerup', (event) => {
      if (event.button !== 2) return;
      const member = this.memberAt(event);
      if (member) showUnitPopup(member.guid, event.clientX, event.clientY);
    });
  }

  update(
    snapshot: SocialSnapshot,
    entityFor: (guid: string) => WorldEntity | undefined,
    vitalsFor: (guid: string) => PartyVitals | undefined = () => undefined,
    profileFor: (guid: string) => { race?: number; gender?: number } | undefined = () => undefined,
  ) {
    this.snapshot = snapshot;
    this.entityFor = entityFor;
    this.vitalsFor = vitalsFor;
    this.profileFor = profileFor;
    // Interface Options → "Hide Party Interface in Raid". groupType 1 is GROUPTYPE_RAID
    // (vMaNGOS Group.h:118-119); a raid uses raid frames, so the party frames are redundant.
    const hiddenByRaid = snapshot.groupType === GROUPTYPE_RAID && Number(getInterfaceCvars().hidePartyInRaid) === 1;
    this.host.classList.toggle('is-hidden', snapshot.group.length === 0 || hiddenByRaid);
    this.surface.requestRender();
  }

  clear() { this.host.classList.add('is-hidden'); }

  private memberAt(event: PointerEvent) {
    const point = this.surface.point(event);
    if (point.x < 0 || point.x > 128 || point.y < 0) return undefined;
    const index = Math.floor(point.y / 58);
    if (point.y - index * 58 > 53) return undefined;
    return this.snapshot?.group[index];
  }

  private paint() {
    const s = this.surface;
    s.clear();
    this.snapshot?.group.slice(0, 4).forEach((member, index) => {
      const y = index * 58;
      const entity = this.entityFor(member.guid);
      // Prefer the live entity; fall back to SMSG_PARTY_MEMBER_STATS vitals for members outside
      // visibility range, whose bar would otherwise read 0/1 forever.
      const vitals = entity ? undefined : this.vitalsFor(member.guid);
      const hp = entity?.health ?? vitals?.health ?? 0;
      const maxHp = Math.max(1, entity?.maxHealth ?? vitals?.maxHealth ?? (member.online ? 1 : 0));
      const powerType = entity?.powerType ?? vitals?.powerType ?? 0;
      const power = entity?.powers?.[powerType] ?? vitals?.power ?? 0;
      const maxPower = Math.max(1, entity?.maxPowers?.[powerType] ?? vitals?.maxPower ?? 1);
      const profile = this.profileFor(member.guid);
      s.image(portraitUrl(profile?.race ?? entity?.race, profile?.gender ?? entity?.gender), 7, y + 6, 37, 37, member.online ? 1 : 0.45);
      s.image('/ui/Interface/TargetingFrame/UI-PartyFrame.png', 0, y + 2, 128, 64);
      s.text(member.name, 66, y + 13, { size: 10, color: member.online ? '#ffffff' : '#808080', align: 'center', maxWidth: 95 });
      const ctx = s.ctx;
      ctx.save();
      ctx.fillStyle = '#101010'; ctx.fillRect(47, y + 12, 70, 8);
      ctx.fillStyle = '#101010'; ctx.fillRect(47, y + 21, 70, 8);
      ctx.restore();
      const healthWidth = 70 * Math.max(0, Math.min(1, hp / maxHp));
      const powerWidth = 70 * Math.max(0, Math.min(1, power / maxPower));
      if (healthWidth > 0) s.tintedImage(STATUS_BAR, member.online ? '#00a000' : '#555555', 47, y + 12, healthWidth, 8);
      if (powerWidth > 0) s.tintedImage(STATUS_BAR, member.online ? POWER_COLORS[powerType] ?? POWER_COLORS[0] : '#555555', 47, y + 21, powerWidth, 8);
      if (this.snapshot?.groupLeaderGuid === member.guid) s.image('/ui/Interface/GroupFrame/UI-Group-LeaderIcon.png', 0, y, 16, 16);
      if (this.snapshot?.lootMethod === 2 && this.snapshot.looterGuid === member.guid) {
        s.image('/ui/Interface/GroupFrame/UI-Group-MasterLooter.png', 32, y, 16, 16);
      }
    });
  }
}

export class PetHudCanvas {
  private readonly frame = new VanillaCanvas(180, 64, 'wow-pet-hud-canvas');
  private readonly actions = new VanillaCanvas(400, 44, 'wow-pet-action-canvas');
  private snapshot?: PetSnapshot;

  constructor(private readonly frameHost: HTMLElement, private readonly actionHost: HTMLElement, private readonly deps: {
    spellIcon: (spellId: number) => string | undefined;
    action: (petGuid: string, action: number, activeState: number) => void;
    autocast: (petGuid: string, spellId: number, enabled: boolean) => void;
  }) {
    frameHost.appendChild(this.frame.canvas);
    actionHost.appendChild(this.actions.canvas);
    this.frame.onRender(() => this.paintFrame());
    this.actions.onRender(() => this.paintActions());
    this.actions.canvas.addEventListener('pointerup', (event) => this.activate(event));
  }

  update(snapshot: PetSnapshot) {
    this.snapshot = snapshot.guid ? snapshot : undefined;
    const hidden = !this.snapshot;
    this.frameHost.classList.toggle('is-hidden', hidden);
    this.actionHost.classList.toggle('is-hidden', hidden || !snapshot.spellState?.actions.length);
    this.frame.requestRender();
    this.actions.requestRender();
  }

  clear() { this.update({}); }

  /** PetActionBarFrame.lua:170-174 — start after the last form button, otherwise MainMenuBar +36. */
  setShapeshiftFormCount(count: number) {
    const x = count > 0 ? 91 + (Math.min(10, count) - 1) * 37 : 36;
    this.actionHost.style.setProperty('--wow-pet-action-x', `${x}px`);
  }

  private paintFrame() {
    const s = this.frame;
    s.clear();
    const pet = this.snapshot;
    if (!pet) return;
    s.image('/ui/Interface/TargetingFrame/UI-SmallTargetingFrame.png', 0, 0, 128, 64);
    s.text(pet.name ?? 'Pet', 66, 13, { size: 10, color: '#ffffff', align: 'center', maxWidth: 95 });
    const hpRatio = Math.max(0, Math.min(1, (pet.health ?? 0) / Math.max(1, pet.maxHealth ?? 1)));
    const happyRatio = Math.max(0, Math.min(1, (pet.happiness ?? 0) / Math.max(1, pet.maxHappiness ?? 1)));
    const ctx = s.ctx;
    ctx.save();
    ctx.fillStyle = '#101010'; ctx.fillRect(48, 19, 72, 10);
    ctx.fillStyle = '#00a000'; ctx.fillRect(48, 19, 72 * hpRatio, 10);
    ctx.fillStyle = '#101010'; ctx.fillRect(48, 31, 72, 5);
    ctx.fillStyle = pet.happinessLevel === 3 ? '#00c040' : pet.happinessLevel === 2 ? '#e0c000' : '#c02020';
    ctx.fillRect(48, 31, 72 * happyRatio, 5);
    ctx.restore();
    if (pet.level) s.text(String(pet.level), 22, 48, { size: 10, color: '#ffd100', align: 'center' });
  }

  private paintActions() {
    const s = this.actions;
    s.clear();
    const actions = this.snapshot?.spellState?.actions ?? [];
    actions.slice(0, 10).forEach((button, index) => {
      const x = index * 40;
      s.image('/ui/Interface/Buttons/UI-Quickslot.png', x, 0, 40, 40);
      const icon = this.deps.spellIcon(button.action) ?? '/ui/Interface/Icons/INV_Misc_QuestionMark.png';
      s.image(icon, x + 3, 3, 34, 34);
      if ((button.activeState & 0x40) !== 0) s.image('/ui/Interface/Buttons/UI-AutoCastableOverlay.png', x, 0, 40, 40);
    });
  }

  private activate(event: PointerEvent) {
    const pet = this.snapshot;
    if (!pet?.guid || !pet.spellState) return;
    const rect = this.actions.canvas.getBoundingClientRect();
    const slot = Math.floor(((event.clientX - rect.left) * (400 / rect.width)) / 40);
    const button = pet.spellState.actions[slot];
    if (!button) return;
    if (event.button === 2) {
      event.preventDefault();
      this.deps.autocast(pet.guid, button.action, (button.activeState & 0x40) === 0);
    } else this.deps.action(pet.guid, button.action, button.activeState);
  }
}
