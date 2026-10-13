import type { QuestLogEntry, QuestLogSnapshot, QuestProgressEvent } from '../world';
import { levelDifficultyColor, type ConColor } from '../level-difficulty';
import { ensureVanillaFonts, VanillaCanvas } from './vanilla-canvas';
import { getInterfaceCvars, onInterfaceCvars } from './interface-runtime';

export const MAX_WATCHABLE_QUESTS = 5;

type QuestTrackerDeps = {
  characterKey: () => string | undefined;
  playerLevel: () => number;
  itemName: (entry: number) => string | undefined;
  creatureName: (entry: number) => string | undefined;
  playUi: (name: string) => boolean;
  announceError: (message: string) => void;
};

type Toast = { text: string; color: string; expiresAt: number };

/** Canvas implementation of Vanilla's five-slot quest watch list and UIErrorsFrame-style progress text. */
export class QuestWatchCanvasPanel {
  private readonly watch = new VanillaCanvas(240, 330, 'wow-quest-watch-canvas');
  private readonly toast = new VanillaCanvas(520, 100, 'wow-quest-progress-canvas');
  private watched = new Set<number>();
  /** Quest ids from the previous snapshot; undefined until the first one seeds it. */
  private knownQuestIds?: Set<number>;
  private snapshot: QuestLogSnapshot = { capacity: 20, entries: [] };
  private activeCharacterKey?: string;
  private toastState?: Toast;
  private toastTimer?: number;

  constructor(watchHost: HTMLElement, toastHost: HTMLElement, private readonly deps: QuestTrackerDeps) {
    watchHost.append(this.watch.canvas);
    toastHost.append(this.toast.canvas);
    this.watch.onRender(() => this.paintWatch());
    this.toast.onRender(() => this.paintToast());
    void ensureVanillaFonts().then(() => { this.watch.requestRender(); this.toast.requestRender(); });
    // Subscribe rather than being called from main's apply path: this panel is constructed
    // long after the first applyInterfaceCvars() runs, so a push from there would touch an
    // uninitialised binding.
    this.applyTrackerVisibility();
    onInterfaceCvars(() => this.applyTrackerVisibility());
  }

  setSnapshot(snapshot: QuestLogSnapshot) {
    this.syncCharacter();
    const previous = this.knownQuestIds;
    this.snapshot = snapshot;
    const present = new Set(snapshot.entries.map((entry) => entry.questId));
    let changed = false;
    for (const questId of this.watched) if (!present.has(questId)) { this.watched.delete(questId); changed = true; }
    // Interface Options → "Automatic Quest Tracking": a quest that just appeared in the log
    // takes a watch slot on its own. The very first snapshot after login is the existing log,
    // not newly accepted quests, so it only seeds the baseline.
    if (previous && Number(getInterfaceCvars().autoQuestWatch) === 1) {
      for (const entry of snapshot.entries) {
        if (previous.has(entry.questId) || this.watched.has(entry.questId)) continue;
        if (this.watched.size >= MAX_WATCHABLE_QUESTS) break; // silent: the player did not ask for this one
        this.watched.add(entry.questId);
        changed = true;
      }
    }
    this.knownQuestIds = present;
    if (changed) this.save();
    this.applyTrackerVisibility();
    this.watch.requestRender();
  }

  toggle(entry: QuestLogEntry) {
    this.syncCharacter();
    if (this.watched.delete(entry.questId)) {
      this.save();
      this.watch.requestRender();
      return;
    }
    if (this.watched.size >= MAX_WATCHABLE_QUESTS) {
      this.deps.announceError(`You may only watch ${MAX_WATCHABLE_QUESTS} quests.`);
      return;
    }
    this.watched.add(entry.questId);
    this.save();
    this.watch.requestRender();
  }

  handleProgress(event: QuestProgressEvent) {
    const message = this.progressMessage(event);
    if (!message) return;
    this.showToast(message.text, message.complete ? '#40c040' : '#ffd100');
    if (message.complete) this.deps.playUi('QUESTLISTCOMPLETE');
  }

  showAnnouncement(text: string, color = '#ffd100', durationMs = 4500) {
    if (this.toastTimer !== undefined) window.clearTimeout(this.toastTimer);
    this.toastState = { text, color, expiresAt: performance.now() + durationMs };
    this.toast.requestRender();
    this.toastTimer = window.setTimeout(() => { this.toastState = undefined; this.toast.requestRender(); }, durationMs);
  }

  private progressMessage(event: QuestProgressEvent): { text: string; complete: boolean } | undefined {
    if (event.kind === 'questAddKill') {
      const name = this.deps.creatureName(event.entry) ?? `Creature #${event.entry}`;
      const complete = event.required > 0 && event.count >= event.required;
      return { text: `${name} slain: ${Math.min(event.count, event.required)}/${event.required}${complete ? ' (Complete)' : ''}`, complete };
    }
    if (event.kind === 'questAddItem') {
      const objective = this.findItemObjective(event.itemId);
      const name = this.deps.itemName(event.itemId) ?? `Item #${event.itemId}`;
      if (!objective) return { text: `${name}: +${event.count}`, complete: false };
      const current = Math.min(objective.current + event.count, objective.required);
      const complete = objective.required > 0 && current >= objective.required;
      return { text: `${name}: ${current}/${objective.required}${complete ? ' (Complete)' : ''}`, complete };
    }
    if (event.kind === 'questComplete') {
      const title = this.snapshot.entries.find((entry) => entry.questId === event.questId)?.info?.title ?? `Quest #${event.questId}`;
      return { text: `${title} (Complete)`, complete: true };
    }
    return undefined;
  }

  private findItemObjective(itemId: number) {
    for (const entry of this.snapshot.entries) {
      const objectives = entry.info?.requiredObjectives ?? [];
      const index = objectives.findIndex((objective) => objective.itemId === itemId && objective.itemCount > 0);
      if (index >= 0) return { current: entry.objectiveCounts[index] ?? 0, required: objectives[index].itemCount };
    }
    return undefined;
  }

  private paintWatch() {
    const s = this.watch;
    s.clear();
    let y = 4;
    for (const questId of this.watched) {
      const entry = this.snapshot.entries.find((candidate) => candidate.questId === questId);
      if (!entry?.info) continue;
      const done = entry.complete;
      s.text(entry.info.title, 236, y + 12, { size: 13, align: 'right', color: done ? '#40c040' : this.difficulty(entry.info.level), maxWidth: 236 });
      y += 18;
      entry.info.requiredObjectives.forEach((objective, index) => {
        const required = objective.itemId ? objective.itemCount : objective.creatureOrGoCount;
        if (!required) return;
        const current = entry.objectiveCounts[index] ?? 0;
        const complete = current >= required;
        const label = objective.text || (objective.itemId
          ? this.deps.itemName(objective.itemId) ?? `Item #${objective.itemId}`
          : this.deps.creatureName(Math.abs(objective.creatureOrGoId)) ?? `Objective ${index + 1}`);
        s.text(`- ${label}: ${Math.min(current, required)}/${required}${complete ? ' (Complete)' : ''}`, 236, y + 11, {
          size: 11, align: 'right', color: complete ? '#40c040' : '#ffffff', maxWidth: 232,
        });
        y += 15;
      });
      y += 7;
      if (y > 315) break;
    }
  }

  private paintToast() {
    const s = this.toast;
    s.clear();
    if (!this.toastState || this.toastState.expiresAt <= performance.now()) return;
    s.text(this.toastState.text, 260, 36, { size: 16, align: 'center', color: this.toastState.color, maxWidth: 510 });
  }

  private showToast(text: string, color: string) {
    this.showAnnouncement(text, color, 3500);
  }

  private difficulty(level: number) {
    // Use the shared vMaNGOS con-color port (MaNGOS::XP::GetColorCode / GetGrayLevel) instead of a
    // hardcoded -9 gray cutoff, which disagrees with vanilla at almost every level (the gray band is
    // playerLevel - 5 - floor(lvl/10) below 40, then playerLevel - 1 - floor(lvl/5)).
    const COLORS: Record<ConColor, string> = {
      red: '#ff1a1a', orange: '#ff8040', yellow: '#ffd100', green: '#40c040', gray: '#9d9d9d',
    };
    return COLORS[levelDifficultyColor(this.deps.playerLevel(), level)];
  }

  private syncCharacter() {
    const key = this.deps.characterKey();
    if (key === this.activeCharacterKey) return;
    this.activeCharacterKey = key;
    this.watched.clear();
    // A different character's log is not "newly accepted quests" — drop the baseline so the
    // next snapshot re-seeds instead of auto-watching everything they already had.
    this.knownQuestIds = undefined;
    if (!key) return;
    try {
      const values = JSON.parse(localStorage.getItem(`wow.questWatch.${key}`) ?? '[]') as number[];
      for (const value of values.slice(0, MAX_WATCHABLE_QUESTS)) if (Number.isInteger(value) && value > 0) this.watched.add(value);
    } catch { /* Ignore invalid local UI state. */ }
  }

  /**
   * Interface Options → "Hide Zone Objective Tracker". Hides the watch list itself while
   * leaving the progress toasts alone — those are event feedback, not the tracker.
   */
  applyTrackerVisibility() {
    this.watch.canvas.style.display = Number(getInterfaceCvars().hideObjectiveTracker) === 1 ? 'none' : '';
  }

  private save() {
    if (this.activeCharacterKey) localStorage.setItem(`wow.questWatch.${this.activeCharacterKey}`, JSON.stringify([...this.watched]));
  }
}
