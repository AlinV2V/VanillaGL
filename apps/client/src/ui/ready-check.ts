import { containsPoint, VanillaCanvas, type CanvasRect } from './vanilla-canvas';

const WIDTH = 323;
const HEIGHT = 97;
const TIMEOUT_MS = 30_000;
const YES: CanvasRect = { x: 55, y: 55, width: 109, height: 24 };
const NO: CanvasRect = { x: 164, y: 55, width: 109, height: 24 };
const RACES: Record<number, string> = {
  1: 'Human', 2: 'Orc', 3: 'Dwarf', 4: 'NightElf', 5: 'Scourge', 6: 'Tauren', 7: 'Gnome', 8: 'Troll',
};

type RaidMember = { guid: string; name: string; online: boolean };
type ReadySnapshot = {
  groupType: number;
  group: RaidMember[];
  groupLeaderGuid?: string;
};
type ReadyPlayerInfo = { name: string; race?: number; gender?: number };

export type ReadyCheckEvent =
  | { kind: 'readyCheckRequest' }
  | { kind: 'readyCheckResponse'; guid: string; ready: boolean };

export type ReadyCheckWorld = {
  getSocial(): ReadySnapshot;
  getPlayerName(guid: string): { name: string; race?: number; gender?: number } | undefined;
  queryPlayerName(guid: string): void;
  confirmReadyCheck(ready: boolean): void;
};

/** Leader-only retained response set. Vanilla's client, not vMaNGOS, owns the 30s AFK summary. */
export class ReadyCheckSession {
  private readonly pending = new Map<string, string>();
  private running = false;

  begin(members: readonly { guid: string; name: string }[]) {
    this.pending.clear();
    for (const member of members) if (member.guid) this.pending.set(member.guid, member.name || member.guid.slice(-8));
    this.running = true;
  }

  record(guid: string, ready: boolean, name?: string) {
    if (!this.running || !this.pending.has(guid)) return undefined;
    const rosterName = this.pending.get(guid);
    this.pending.delete(guid);
    return ready ? undefined : `${name || rosterName || guid.slice(-8)} is not ready`;
  }

  retain(guids: ReadonlySet<string>) {
    if (!this.running) return;
    for (const guid of this.pending.keys()) if (!guids.has(guid)) this.pending.delete(guid);
  }

  finish() {
    if (!this.running) return undefined;
    this.running = false;
    const names = [...this.pending.values()];
    this.pending.clear();
    return names.length ? `The following players are AFK: ${names.join(', ')}` : 'No players are AFK';
  }

  reset() { this.running = false; this.pending.clear(); }
  get active() { return this.running; }
  get remaining() { return this.pending.size; }
}

type Timer = ReturnType<typeof setTimeout>;

/** Canvas transcription of Blizzard_RaidUI.xml's 323x97 ReadyCheckFrame. */
export class ReadyCheckController {
  readonly surface: VanillaCanvas;
  private visible = false;
  private hover?: 'yes' | 'no';
  private pressed?: 'yes' | 'no';
  private leaderGuid = '';
  private leaderName = 'Raid leader';
  private popupTimer?: Timer;
  private summaryTimer?: Timer;
  private readonly session = new ReadyCheckSession();

  constructor(host: HTMLElement, private readonly deps: {
    getWorld: () => ReadyCheckWorld | undefined;
    getPlayerGuid: () => string | undefined;
    getPlayerInfo: (guid: string) => ReadyPlayerInfo | undefined;
    systemMessage: (message: string) => void;
    playUi: (name: string) => unknown;
    setTimer?: (callback: () => void, delayMs: number) => Timer;
    clearTimer?: (timer: Timer) => void;
  }) {
    this.surface = new VanillaCanvas(WIDTH, HEIGHT, 'wow-ready-check-canvas');
    Object.assign(this.surface.canvas.style, {
      position: 'fixed', left: '50%', top: 'calc(50% + 10px)', transform: 'translate(-50%, -50%)',
      zIndex: '96', display: 'none', pointerEvents: 'auto',
    });
    host.appendChild(this.surface.canvas);
    this.surface.onRender(() => this.paint());
    this.surface.canvas.addEventListener('pointermove', (event) => {
      const point = this.surface.point(event);
      const next = containsPoint(YES, point) ? 'yes' : containsPoint(NO, point) ? 'no' : undefined;
      if (next !== this.hover) { this.hover = next; this.surface.requestRender(); }
    });
    this.surface.canvas.addEventListener('pointerleave', () => { this.hover = undefined; this.surface.requestRender(); });
    this.surface.canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const point = this.surface.point(event);
      this.pressed = containsPoint(YES, point) ? 'yes' : containsPoint(NO, point) ? 'no' : undefined;
      if (this.pressed) { event.preventDefault(); event.stopPropagation(); this.surface.requestRender(); }
    });
    this.surface.canvas.addEventListener('pointerup', (event) => {
      const point = this.surface.point(event);
      const hit = containsPoint(YES, point) ? 'yes' : containsPoint(NO, point) ? 'no' : undefined;
      const pressed = this.pressed;
      this.pressed = undefined;
      if (!hit || hit !== pressed) { this.surface.requestRender(); return; }
      event.preventDefault(); event.stopPropagation(); this.answer(hit === 'yes');
    });
  }

  handle(event: ReadyCheckEvent) {
    if (event.kind === 'readyCheckRequest') this.show();
    else this.receive(event.guid, event.ready);
    return true;
  }

  sync(snapshot: ReadySnapshot) {
    if ((snapshot.groupType & 1) === 0) { this.reset(); return; }
    if (!this.session.active) return;
    const guids = new Set(snapshot.group.map((member) => member.guid));
    const self = this.deps.getPlayerGuid();
    if (self) guids.add(self);
    this.session.retain(guids);
    if (!this.session.remaining) this.finishSummary();
  }

  reset() {
    this.hidePrompt();
    this.clearSummaryTimer();
    this.session.reset();
  }

  isVisible() { return this.visible; }

  refreshPlayer(guid: string) {
    if (!this.visible || guid !== this.leaderGuid) return;
    this.leaderName = this.deps.getPlayerInfo(guid)?.name ?? this.leaderName;
    this.surface.requestRender();
  }

  private show() {
    const world = this.deps.getWorld();
    if (!world) return;
    const snapshot = world.getSocial();
    this.leaderGuid = snapshot.groupLeaderGuid ?? '';
    if (this.leaderGuid) world.queryPlayerName(this.leaderGuid);
    this.leaderName = this.deps.getPlayerInfo(this.leaderGuid)?.name
      ?? snapshot.group.find((member) => member.guid === this.leaderGuid)?.name
      ?? 'Raid leader';
    this.visible = true;
    this.surface.canvas.style.display = 'block';
    this.surface.requestRender();
    this.deps.playUi('ReadyCheck');
    this.clearPopupTimer();
    this.popupTimer = this.setTimer(() => {
      this.popupTimer = undefined;
      if (!this.visible) return;
      this.hidePrompt();
      this.deps.systemMessage('You were AFK for a ready check');
    }, TIMEOUT_MS);
    if (this.leaderGuid === this.deps.getPlayerGuid()) this.beginSummary(snapshot);
  }

  private beginSummary(snapshot: ReadySnapshot) {
    const selfGuid = this.deps.getPlayerGuid();
    const members = snapshot.group.map(({ guid, name }) => ({ guid, name }));
    if (selfGuid) members.push({ guid: selfGuid, name: this.deps.getPlayerInfo(selfGuid)?.name ?? 'You' });
    this.session.begin(members);
    this.clearSummaryTimer();
    this.summaryTimer = this.setTimer(() => { this.summaryTimer = undefined; this.finishSummary(); }, TIMEOUT_MS);
  }

  private receive(guid: string, ready: boolean) {
    const message = this.session.record(guid, ready, this.deps.getPlayerInfo(guid)?.name);
    if (message) this.deps.systemMessage(message);
    if (this.session.active && !this.session.remaining) this.finishSummary();
  }

  private finishSummary() {
    const message = this.session.finish();
    this.clearSummaryTimer();
    if (message) this.deps.systemMessage(message);
  }

  private answer(ready: boolean) {
    this.deps.getWorld()?.confirmReadyCheck(ready);
    this.hidePrompt();
  }

  private hidePrompt() {
    this.visible = false;
    this.hover = undefined;
    this.pressed = undefined;
    this.surface.canvas.style.display = 'none';
    this.clearPopupTimer();
  }

  private clearPopupTimer() {
    if (this.popupTimer === undefined) return;
    this.clearTimer(this.popupTimer);
    this.popupTimer = undefined;
  }

  private clearSummaryTimer() {
    if (this.summaryTimer === undefined) return;
    this.clearTimer(this.summaryTimer);
    this.summaryTimer = undefined;
  }

  private setTimer(callback: () => void, delayMs: number) {
    return (this.deps.setTimer ?? ((run, delay) => setTimeout(run, delay)))(callback, delayMs);
  }

  private clearTimer(timer: Timer) {
    (this.deps.clearTimer ?? ((value) => clearTimeout(value)))(timer);
  }

  private paint() {
    const s = this.surface;
    s.clear();
    if (!this.visible) return;
    const info = this.deps.getPlayerInfo(this.leaderGuid) ?? this.deps.getWorld()?.getPlayerName(this.leaderGuid);
    const portrait = info?.race
      ? `/ui/Interface/CharacterFrame/TemporaryPortrait-${info.gender === 1 ? 'Female' : 'Male'}-${RACES[info.race] ?? 'Human'}.png`
      : '/ui/Interface/CharacterFrame/TemporaryPortrait-Monster.png';
    s.image(portrait, 7, 6, 50, 50);
    s.sprite('/ui/Interface/RaidFrame/UI-ReadyCheckFrame.png', 0, 0, WIDTH, HEIGHT, 0, 0, WIDTH, HEIGHT);
    s.text(`${this.leaderName} has initiated a ready check.`, 176, 27, { size: 12, color: '#ffd100', align: 'center', baseline: 'middle', maxWidth: 245 });
    s.text('Are you ready?', 176, 43, { size: 12, color: '#ffffff', align: 'center', baseline: 'middle' });
    s.panelButton('Yes', YES, this.buttonState('yes'));
    s.panelButton('No', NO, this.buttonState('no'));
  }

  private buttonState(button: 'yes' | 'no') {
    return this.pressed === button ? 'down' : this.hover === button ? 'hover' : 'normal';
  }
}
