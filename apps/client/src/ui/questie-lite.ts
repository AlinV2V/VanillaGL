import type { QuestLogEntry, QuestLogSnapshot } from '../world';
import { WORLD_MAP_AREAS, type WorldMapAreaMeta } from '../data/world-map';
import { isBuiltInAddonEnabled, onBuiltInAddonSettings } from './builtin-addons';

type QuestTuple = [id: number, title: string, minLevel: number, level: number, classMask: number, raceMask: number, prerequisite: number];
type MarkerTuple = [questId: number, kind: 0 | 1 | 2, objective: number, worldX: number, worldY: number];
type Manifest = { v: number; q: QuestTuple[]; a: Array<[areaId: number, file: string, count: number]> };
type AreaShard = { v: number; m: MarkerTuple[] };

export type QuestieLiteMarker = {
  questId: number;
  kind: 'available' | 'turnin' | 'turnin-incomplete' | 'objective';
  objective: number;
  mapId: number;
  worldX: number;
  worldY: number;
  title: string;
  detail?: string;
};

type PlayerProfile = { key: string; level: number; race: number; classId: number };

const containsWorld = (area: WorldMapAreaMeta, mapId: number, x: number, y: number) => {
  if (area.mapId !== mapId || area.areaId === 0) return false;
  const u = (y - area.left) / (area.right - area.left);
  const v = (x - area.top) / (area.bottom - area.top);
  return u >= 0 && u <= 1 && v >= 0 && v <= 1;
};

class QuestieLiteStore {
  private manifest?: Manifest;
  private manifestPromise?: Promise<void>;
  private readonly questById = new Map<number, QuestTuple>();
  private readonly areaFiles = new Map<number, string>();
  private readonly shards = new Map<number, MarkerTuple[]>();
  private readonly shardPromises = new Map<number, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private entries = new Map<number, QuestLogEntry>();
  private profile?: PlayerProfile;
  private completed = new Set<number>();

  constructor() {
    onBuiltInAddonSettings(() => this.notify());
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setPlayer(profile: PlayerProfile | undefined) {
    const changedCharacter = profile?.key !== this.profile?.key;
    const changed = changedCharacter || profile?.level !== this.profile?.level
      || profile?.race !== this.profile?.race || profile?.classId !== this.profile?.classId;
    this.profile = profile;
    if (changedCharacter) this.loadCompleted();
    if (changed) this.notify();
  }

  setQuestLog(snapshot: QuestLogSnapshot) {
    const next = new Map(snapshot.entries.map((entry) => [entry.questId, entry]));
    let completedChanged = false;
    for (const [questId, entry] of this.entries) {
      if (!next.has(questId) && entry.complete && !entry.failed) {
        this.completed.add(questId);
        completedChanged = true;
      }
    }
    this.entries = next;
    completedChanged = this.inferCompletedPrerequisites() || completedChanged;
    if (completedChanged) this.saveCompleted();
    this.notify();
  }

  areaForWorld(mapId: number, x: number, y: number) {
    return WORLD_MAP_AREAS.filter((area) => containsWorld(area, mapId, x, y))
      .sort((a, b) => Math.abs((a.right - a.left) * (a.bottom - a.top))
        - Math.abs((b.right - b.left) * (b.bottom - b.top)))[0];
  }

  ensureArea(areaId: number) {
    if (!isBuiltInAddonEnabled('questHelper') || this.shards.has(areaId)) return;
    if (!this.manifest) {
      void this.ensureManifest().then(() => this.ensureArea(areaId));
      return;
    }
    const file = this.areaFiles.get(areaId);
    if (!file || this.shardPromises.has(areaId)) return;
    const promise = fetch(`/questie-lite/${file}`)
      .then((response) => {
        if (!response.ok) throw new Error(`Questie-lite area ${areaId}: HTTP ${response.status}`);
        return response.json() as Promise<AreaShard>;
      })
      .then((shard) => { this.shards.set(areaId, shard.m ?? []); this.notify(); })
      .catch((error) => console.warn(error))
      .finally(() => this.shardPromises.delete(areaId));
    this.shardPromises.set(areaId, promise);
  }

  markersForArea(areaId: number): QuestieLiteMarker[] {
    if (!isBuiltInAddonEnabled('questHelper') || !this.profile) return [];
    this.ensureArea(areaId);
    const tuples = this.shards.get(areaId) ?? [];
    const result: QuestieLiteMarker[] = [];
    for (const marker of tuples) {
      const quest = this.questById.get(marker[0]);
      if (!quest) continue;
      const entry = this.entries.get(marker[0]);
      if (marker[1] === 0) {
        if (entry || this.completed.has(marker[0]) || !this.questAvailable(quest)) continue;
        result.push(this.marker(areaId, marker, quest, 'available'));
      } else if (marker[1] === 1) {
        if (!entry) continue;
        result.push(this.marker(areaId, marker, quest, entry.complete && !entry.failed ? 'turnin' : 'turnin-incomplete'));
      } else {
        if (!entry || entry.complete || entry.failed || this.objectiveComplete(entry, marker[2])) continue;
        result.push(this.marker(areaId, marker, quest, 'objective', this.objectiveText(entry, marker[2])));
      }
    }
    return result;
  }

  markersNear(mapId: number, x: number, y: number, radius = 380) {
    const area = this.areaForWorld(mapId, x, y);
    if (!area) return [];
    return this.markersForArea(area.id).filter((marker) => Math.hypot(marker.worldX - x, marker.worldY - y) <= radius);
  }

  private ensureManifest() {
    if (this.manifestPromise) return this.manifestPromise;
    this.manifestPromise = fetch('/questie-lite/manifest.json')
      .then((response) => {
        if (!response.ok) throw new Error(`Questie-lite manifest: HTTP ${response.status}`);
        return response.json() as Promise<Manifest>;
      })
      .then((manifest) => {
        this.manifest = manifest;
        this.questById.clear();
        for (const quest of manifest.q ?? []) this.questById.set(quest[0], quest);
        this.areaFiles.clear();
        for (const area of manifest.a ?? []) this.areaFiles.set(area[0], area[1]);
        if (this.inferCompletedPrerequisites()) this.saveCompleted();
        this.notify();
      })
      .catch((error) => console.warn(error));
    return this.manifestPromise;
  }

  private questAvailable(quest: QuestTuple) {
    if (!this.profile || quest[2] > this.profile.level) return false;
    if (quest[4] && (quest[4] & (1 << (this.profile.classId - 1))) === 0) return false;
    if (quest[5] && (quest[5] & (1 << (this.profile.race - 1))) === 0) return false;
    return !quest[6] || this.completed.has(quest[6]);
  }

  private objectiveComplete(entry: QuestLogEntry, index: number) {
    const objective = entry.info?.requiredObjectives[index];
    if (!objective) return true;
    const required = objective.itemId ? objective.itemCount : objective.creatureOrGoCount;
    return required <= 0 || (entry.objectiveCounts[index] ?? 0) >= required;
  }

  private objectiveText(entry: QuestLogEntry, index: number) {
    const objective = entry.info?.requiredObjectives[index];
    if (!objective) return undefined;
    const required = objective.itemId ? objective.itemCount : objective.creatureOrGoCount;
    return `${objective.text || `Objective ${index + 1}`}: ${Math.min(entry.objectiveCounts[index] ?? 0, required)}/${required}`;
  }

  private marker(areaId: number, tuple: MarkerTuple, quest: QuestTuple, kind: QuestieLiteMarker['kind'], detail?: string): QuestieLiteMarker {
    const area = WORLD_MAP_AREAS.find((candidate) => candidate.id === areaId);
    return { questId: tuple[0], kind, objective: tuple[2], mapId: area?.mapId ?? 0,
      worldX: tuple[3], worldY: tuple[4], title: quest[1], detail };
  }

  private inferCompletedPrerequisites() {
    let changed = false;
    for (const questId of this.entries.keys()) {
      let prerequisite = this.questById.get(questId)?.[6] ?? 0;
      const seen = new Set<number>();
      while (prerequisite && !seen.has(prerequisite)) {
        seen.add(prerequisite);
        if (!this.completed.has(prerequisite)) { this.completed.add(prerequisite); changed = true; }
        prerequisite = this.questById.get(prerequisite)?.[6] ?? 0;
      }
    }
    return changed;
  }

  private loadCompleted() {
    this.completed.clear();
    if (!this.profile) return;
    try {
      const stored = JSON.parse(localStorage.getItem(`wow.questieLite.completed.${this.profile.key}`) ?? '[]') as number[];
      for (const id of stored) if (Number.isInteger(id) && id > 0) this.completed.add(id);
    } catch { /* Ignore invalid local helper history. */ }
  }

  private saveCompleted() {
    if (this.profile) localStorage.setItem(`wow.questieLite.completed.${this.profile.key}`, JSON.stringify([...this.completed]));
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}

export const questieLite = new QuestieLiteStore();
