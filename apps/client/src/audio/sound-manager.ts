import { normalizeSoundUrl, weightedIndex } from './sound-selection';
import { qaGlobals } from '../qa-globals.ts'; import { ActiveVoiceBudget } from './voice-budget'; import { mobileDirectSfxEnabled, setMobileDirectSfx, shouldRouteVoiceThroughWebAudio, soundPanningModel } from './mobile-audio-policy';
import { SoundPreloadCache } from './sound-preload-cache';
import { AudioContextRecovery } from './audio-context-recovery';
import { updateAudioListener } from './audio-listener';
import { startVoicePlayback } from './voice-playback';
import type { AudioVoice } from './audio-voice';
import { MobileBufferCache } from './mobile-buffer-cache';
import { MobileBufferVoice } from './mobile-buffer-voice';
import { getPerformanceProfile } from '../platform/performance-profile';
export type SoundEntry = {
  id?: number;
  name?: string;
  files: string[];
  weights?: number[];
  durationMs?: (number | null)[];
  volume?: number;
  flags?: number;
  loop?: boolean;
  minDistance?: number;
  distanceCutoff?: number;
};
export type SoundManifest = {
  entries?: Record<string, SoundEntry>;
  ui?: Record<string, number | string>;
  audioVariants?: Record<string, { source: string; opus?: string }>;
  world?: WorldSoundManifest;
};
export type CreatureSoundCue = 'attack' | 'attackCritical' | 'wound' | 'woundCritical' | 'death' | 'deathCritical' | 'aggro' | 'aggroCritical' | 'alert' | 'fidget' | 'customAttack';
export type NpcSoundCue = 'greeting' | 'farewell' | 'pissed';

export type WorldSoundManifest = {
  displays?: Record<string, { footstepId?: number; soundDataId?: number; npcSoundId?: number }>;
  creatures?: Record<string, Partial<Record<CreatureSoundCue, number>>>;
  npcs?: Record<string, Partial<Record<NpcSoundCue, number>>>;
  footsteps?: Record<string, Record<string, { sound?: number; splash?: number }>>;
  defaultFootsteps?: Record<string, { sound?: number; splash?: number }>;
  weaponSwings?: Record<string, number>;
  // Weapon-impact profiles are indexed by subclass, variant column, material flag, and critical state.
  // `material0`/`material1` select the two manifest-defined material variants.
  weaponImpacts?: Record<string, {
    flesh?: number;
    fleshCritical?: number;
    material0?: { normal: number[]; critical: number[] };
    material1?: { normal: number[]; critical: number[] };
  }>;
  /** Material flags keyed by material id; bit 0 selects the alternate impact variant. */
  impactMaterialFlags?: Record<string, number>;
  movement?: Record<string, { jump?: number; land?: number }>;
  vocalErrors?: Record<string, { outOfRange?: number; invalidTarget?: number }>;
  /** Sheathe/unsheathe lookup keyed by "itemClass:subclass". */
  sheathe?: Record<string, { sheathe?: number; unsheathe?: number }>;
  water?: {
    enter?: { small?: number; medium?: number; large?: number };
    underwater?: number;
    surface?: Record<string, number>;
  };
  areas?: Record<string, AreaSoundProfile>;
  weather?: Record<string, string>;
};

export type AreaSoundProfile = {
  ambienceDay?: number;
  ambienceNight?: number;
  musicDay?: number;
  musicNight?: number;
  silenceMinDay?: number;
  silenceMaxDay?: number;
  silenceMinNight?: number;
  silenceMaxNight?: number;
  intro?: number;
};

export type SoundCategory = 'sfx' | 'music';

export type PlaySoundOptions = {
  volume?: number;
  /** Multiplies the manifest-authored volume (used for distance/cue attenuation). */
  volumeScale?: number;
  loop?: boolean;
  key?: string;
  category?: SoundCategory;
  maxDurationMs?: number;
  soundId?: number;
  fadeInMs?: number;
  crossfadeMs?: number;
  onEnded?: () => void;
  /** Environmental/world SFX are muffled below water. UI and music buses opt out. */
  underwaterAffected?: boolean;
  /** Playback-speed pitch variation. Footsteps use 0.95..1.05 for subtle natural variation. */
  playbackRate?: number;
  /** World-space source position. Mobile uses equal-power spatialization; desktop uses HRTF. */
  position?: { x: number; y: number; z: number };
};

export type SoundSettings = {
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  soundEnabled: boolean;
  musicEnabled: boolean;
};

type SoundDebugEvent = {
  at: number;
  action: 'play' | 'ended' | 'error' | 'stopped' | 'timeout';
  soundId?: number;
  key?: string;
  file: string;
};

const DEFAULT_MANIFEST = '/sounds/sound-manifest.json';
const SETTINGS_KEY = 'vanillagl.soundSettings.v1';

const DEFAULT_SETTINGS: SoundSettings = {
  masterVolume: 1,
  sfxVolume: 1,
  musicVolume: 1,
  soundEnabled: true,
  musicEnabled: true,
};

/** Maps client-only convenience names to authoritative Build 5875 sound names. */
const UI_SOUND_ALIASES: Record<string, string> = {
  // SoundEntries.dbc spells this one "Oepn"; FrameXML and our callers use the readable spelling.
  igInventoryOpen: 'igInventoryOepn',
  igChatScrollButton: 'UChatScrollButton',
  // Our quest button emits a semantic accept cue. Vanilla's accepted-quest event resolves to
  // QUESTADDED / iQuestActivate.wav; there is no SoundEntries row named igQuestAccept.
  igQuestAccept: 'QUESTADDED',
  igQuestComplete: 'igQuestListComplete',
  // FrameXML's loot-frame cue has no UISoundLookups row in the extracted 1.12.1 table. The
  // authoritative sample is SoundEntry 1279 (ChestBounce -> UiLootPickUpItem.wav).
  LOOTFRAMEITEMSOUND: 'ChestBounce',
};

export class WowSoundManager {
  private manifest: SoundManifest = {};
  private loaded = false;
  private settings: SoundSettings = this.loadSettings();
  private readonly activeVoices = new Set<AudioVoice>();
  private readonly keyedVoices = new Map<string, AudioVoice>();
  private readonly preloadedFiles = new SoundPreloadCache();
  private readonly stopTimers = new WeakMap<AudioVoice, number>();
  private readonly fadeFrames = new WeakMap<AudioVoice, number>();
  private readonly voiceErrorHandlers = new WeakMap<AudioVoice, () => void>();
  private readonly history: SoundDebugEvent[] = [];
  private readonly uiSoundRefs = new Map<string, number | string>();
  private desiredWeather: { soundId: number; volume: number } | undefined;
  private desiredZone: { areaId: number; isDay: boolean; indoors: boolean } | undefined;
  private activeZoneKey = '';
  private zoneMusicTimer: number | undefined;
  private readonly playedZoneIntros = new Set<number>();
  private underwater = false;
  private voicesCreated = 0; private voicesReleased = 0; private readonly voiceBudget = new ActiveVoiceBudget();
  // AUD-11: every voice routes through one shared lowpass so submerging muffles ALL playing
  // audio for the underwater effect, not just sounds started after the dive.
  private audioContext: AudioContext | undefined;
  private lowpassNode: BiquadFilterNode | undefined;
  private readonly audioRecovery = new AudioContextRecovery(
    create => create ? this.ensureAudioContext() : this.audioContext, () => this.recoverAudioVoices(), () => this.isMobileAudio());
  private readonly mobileBuffers = new MobileBufferCache();
  private isMobileAudio = () => getPerformanceProfile().device.mobile;
  private playbackFailures = 0;
  private retryEnvironment = false;
  private readonly routedVoices = new WeakMap<AudioVoice, {
    source: MediaElementAudioSourceNode;
    panner?: PannerNode;
  }>();
  private worldReady = true;
  private readonly opusSupported = typeof Audio !== 'undefined'
    && new Audio().canPlayType('audio/ogg; codecs="opus"') !== '';

  constructor(manifestUrl = DEFAULT_MANIFEST) {
    void this.loadManifest(manifestUrl);
    qaGlobals.__wowSound = {
      playSoundId: (id: number, volume?: number) => this.playSoundId(id, { volume }),
      playUi: (name: string, volume?: number) => this.playUi(name, { volume }),
      preloadSoundId: (id: number) => this.preloadSoundId(id),
      stop: (key: string, fadeOutMs?: number) => this.stop(key, fadeOutMs),
      stopLoop: (key: string) => this.stopLoop(key),
      stopAllLoops: () => this.stopAllLoops(),
      setEnabled: (enabled: boolean) => this.setSoundEnabled(enabled),
      setVolume: (volume: number) => this.setMasterVolume(volume),
      settings: () => this.getSettings(),
      setSettings: (settings: Partial<SoundSettings>) => this.setSettings(settings),
      diagnostics: () => this.diagnostics(),
      history: (limit = 50) => this.history.slice(-Math.max(1, Math.min(200, limit))),
      setZone: (areaId: number, isDay: boolean, indoors = false) => this.setZoneAudio(areaId, isDay, indoors),
      setUnderwater: (active: boolean) => this.setUnderwater(active), setMobileDirectSfx,
      updateListener: (position: { x: number; y: number; z: number }, forward: { x: number; y: number; z: number }, up: { x: number; y: number; z: number }) => this.updateListener(position, forward, up),
    };
  }

  async loadManifest(url = DEFAULT_MANIFEST) {
    try {
      // Revalidate on every load: a cached manifest from an older bake silently
      // drops newly-added UI/world mappings (the "C panel has no sound" class of bug).
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) return;
      this.manifest = await res.json() as SoundManifest;
      this.rebuildUiSoundIndex();
      this.loaded = true;
      this.syncWeatherSound();
      this.syncZoneAudio();
      this.syncUnderwaterSound();
    } catch {
      // Missing sound assets are expected until a sound manifest is available.
    }
  }

  getSettings(): SoundSettings {
    return { ...this.settings };
  }

  setSettings(next: Partial<SoundSettings>) {
    const previous = this.settings;
    this.settings = {
      masterVolume: clamp01(next.masterVolume ?? previous.masterVolume),
      sfxVolume: clamp01(next.sfxVolume ?? previous.sfxVolume),
      musicVolume: clamp01(next.musicVolume ?? previous.musicVolume),
      soundEnabled: next.soundEnabled ?? previous.soundEnabled,
      musicEnabled: next.musicEnabled ?? previous.musicEnabled,
    };
    if (previous.musicEnabled !== this.settings.musicEnabled) this.activeZoneKey = '';
    this.saveSettings();
    if (!this.settings.soundEnabled) this.preloadedFiles.clear();
    for (const audio of [...this.activeVoices]) {
      const category = (audio.dataset.soundCategory as SoundCategory | undefined) ?? 'sfx';
      if (!this.categoryEnabled(category)) this.releaseVoice(audio, true);
      else audio.volume = this.effectiveVolume(Number(audio.dataset.baseVolume ?? 1), category);
    }
    if (!this.settings.soundEnabled) this.mobileBuffers.clear();
    this.syncWeatherSound();
    this.syncZoneAudio();
    this.syncUnderwaterSound();
  }

  setSoundEnabled(enabled: boolean) {
    this.setSettings({ soundEnabled: enabled });
  }

  setMusicEnabled(enabled: boolean) {
    this.setSettings({ musicEnabled: enabled });
  }

  setMasterVolume(volume: number) {
    this.setSettings({ masterVolume: volume });
  }

  setSfxVolume(volume: number) {
    this.setSettings({ sfxVolume: volume });
  }

  setMusicVolume(volume: number) {
    this.setSettings({ musicVolume: volume });
  }

  playUi(name: string, options: PlaySoundOptions = {}) {
    const manifestKey = UI_SOUND_ALIASES[name] ?? name;
    const ref = this.uiSoundRefs.get(manifestKey.toLowerCase())
      ?? this.uiSoundRefs.get(name.toLowerCase());
    if (ref === undefined) return false;
    // Interface events are always finite one-shots. A stale manifest once mapped
    // igMainMenuOption to looping Frost precast, so every NPC option/shop click leaked another
    // aura-like loop. Never allow a SoundEntries loop flag to turn a UI cue into an owned loop.
    const uiOptions = { ...options, loop: false, underwaterAffected: false };
    if (typeof ref === 'number') return !!this.playSoundId(ref, uiOptions);
    return !!this.playFile(ref, uiOptions);
  }

  private rebuildUiSoundIndex() {
    this.uiSoundRefs.clear();
    for (const [name, ref] of Object.entries(this.manifest.ui ?? {})) {
      this.uiSoundRefs.set(name.toLowerCase(), ref);
    }
    // FrameXML PlaySound("igCharacterInfoOpen") uses the SoundEntries name, whereas
    // UISoundLookups.dbc exposes uppercase semantic keys such as CHARACTERINFOOPEN. Index both.
    // SoundEntries names deliberately win over stale hand-authored aliases in older manifests.
    for (const [id, entry] of Object.entries(this.manifest.entries ?? {})) {
      if (entry.name) this.uiSoundRefs.set(entry.name.toLowerCase(), Number(id));
    }
  }

  playSoundId(id: number | undefined, options: PlaySoundOptions = {}) {
    if (!id) return null;
    const entry = this.manifest.entries?.[String(id)];
    if (!entry?.files?.length) return null;
    const index = weightedIndex(entry.files.length, entry.weights);
    const file = entry.files[index];
    return this.playFile(file, {
      ...options,
      loop: options.loop ?? entry.loop ?? false,
      volume: options.volume ?? (entry.volume ?? 1) * (options.volumeScale ?? 1),
      soundId: id,
    });
  }

  playCreatureCue(displayId: number | undefined, cue: CreatureSoundCue, options: PlaySoundOptions = {}) {
    const soundDataId = this.manifest.world?.displays?.[String(displayId ?? 0)]?.soundDataId;
    const profile = soundDataId ? this.manifest.world?.creatures?.[String(soundDataId)] : undefined;
    const fallbackCue = cue.endsWith('Critical') ? cue.slice(0, -8) as CreatureSoundCue : cue;
    const soundId = profile?.[cue] || profile?.[fallbackCue];
    return this.playSoundId(soundId, options);
  }

  playNpcCue(displayId: number | undefined, cue: NpcSoundCue, options: PlaySoundOptions = {}) {
    // NPC sound profiles use a separate identifier space from creature sound profiles.
    const npcSoundId = this.manifest.world?.displays?.[String(displayId ?? 0)]?.npcSoundId;
    const soundId = npcSoundId ? this.manifest.world?.npcs?.[String(npcSoundId)]?.[cue] : undefined;
    return this.playSoundId(soundId, options);
  }

  /** Draw/stow sound for the item being sheathed. */
  playSheathe(itemClass: number | undefined, subclass: number | undefined, drawn: boolean, options: PlaySoundOptions = {}) {
    const profile = this.manifest.world?.sheathe?.[`${itemClass ?? 2}:${subclass ?? 0}`]
      ?? this.manifest.world?.sheathe?.['2:0'];
    return this.playSoundId(drawn ? profile?.unsheathe : profile?.sheathe, options);
  }

  playFootstep(displayId: number | undefined, terrainType: number, shallowWater: boolean, options: PlaySoundOptions = {}) {
    const profile = this.manifest.world?.displays?.[String(displayId ?? 0)];
    const explicit = profile?.footstepId
      ? this.manifest.world?.footsteps?.[String(profile.footstepId)]?.[String(terrainType)]
      : undefined;
    const layer = explicit ?? this.manifest.world?.defaultFootsteps?.[String(terrainType)]
      ?? this.manifest.world?.defaultFootsteps?.['0'];
    const playbackRate = options.playbackRate ?? 0.95 + Math.random() * 0.1;
    const ground = this.playSoundId(layer?.sound, { ...options, playbackRate });
    const splash = shallowWater ? this.playSoundId(layer?.splash, { ...options, playbackRate, volumeScale: (options.volumeScale ?? 1) * 0.82 }) : null;
    return !!(ground || splash);
  }

  playWeaponSwing(size: 0 | 1 | 2, critical: boolean, options: PlaySoundOptions = {}) {
    return this.playSoundId(this.manifest.world?.weaponSwings?.[`${size}:${critical ? 1 : 0}`], options);
  }

  
  playWeaponImpact(
    weaponSubclass: number | undefined,
    weaponMaterial: number | undefined,
    critical: boolean,
    contact: { itemClass?: number; material?: number; column?: number } = {},
    options: PlaySoundOptions = {},
  ) {
    const impacts = this.manifest.world?.weaponImpacts;
    const profile = impacts?.[String(weaponSubclass ?? 13)] ?? impacts?.['13'];
    const materialFlags = this.manifest.world?.impactMaterialFlags ?? {};
    const hasFlag = (material: number | undefined) => ((materialFlags[String(material ?? 0)] ?? 0) & 1) !== 0;
    const row = hasFlag(weaponMaterial) ? profile?.material1 : profile?.material0;
    const requestedColumn = Number.isInteger(contact.column)
      ? contact.column!
      : contact.itemClass === 2
        ? (hasFlag(contact.material) ? 5 : 6)
        : contact.itemClass === 4
          ? (hasFlag(contact.material) ? 3 : 4)
          : 0;
    const columnIndex = Math.max(0, Math.min(9, requestedColumn));
    const soundId = critical ? row?.critical?.[columnIndex] : row?.normal?.[columnIndex];
    return this.playSoundId(soundId || (critical ? profile?.fleshCritical : profile?.flesh), options);
  }

  playMovementCue(race: number | undefined, gender: number | undefined, cue: 'jump' | 'land', options: PlaySoundOptions = {}) {
    const soundId = this.manifest.world?.movement?.[`${race ?? 0}:${gender ?? 0}`]?.[cue];
    return this.playSoundId(soundId, options);
  }

  playVocalError(race: number | undefined, gender: number | undefined, cue: 'outOfRange' | 'invalidTarget', options: PlaySoundOptions = {}) {
    const soundId = this.manifest.world?.vocalErrors?.[`${race ?? 0}:${gender ?? 0}`]?.[cue];
    return this.playSoundId(soundId, options);
  }

  playWaterEntry(size: 'small' | 'medium' | 'large' = 'small', options: PlaySoundOptions = {}) {
    return this.playSoundId(this.manifest.world?.water?.enter?.[size], options);
  }

  playServerSound(soundId: number, options: PlaySoundOptions = {}) {
    if (!this.worldReady) return null;
    return this.playSoundId(soundId, options);
  }

  playServerMusic(soundId: number) {
    if (!this.worldReady) return null;
    if (this.zoneMusicTimer !== undefined) window.clearTimeout(this.zoneMusicTimer); this.zoneMusicTimer = undefined; this.activeZoneKey = ''; this.stop('zone-music', 500);
    const cue = this.playSoundId(soundId, { category: 'music', key: 'server-music', crossfadeMs: 800, fadeInMs: 500, onEnded: () => this.syncZoneAudio() });
    return cue ?? (this.syncZoneAudio(), null);
  }
  setUnderwater(active: boolean) {
    if (this.underwater === active) return;
    this.underwater = active;
    this.syncUnderwaterSound();
    this.syncUnderwaterFilter();
  }

  private ensureAudioContext(): AudioContext | undefined {
    if (this.audioContext) return this.audioContext;
    if (!this.settings.soundEnabled && !this.settings.musicEnabled) return;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.audioContext = new Ctx();
      this.lowpassNode = this.audioContext.createBiquadFilter();
      this.lowpassNode.type = 'lowpass';
      this.lowpassNode.frequency.value = 22050;
      this.lowpassNode.connect(this.audioContext.destination);
      this.syncUnderwaterFilter();
      return this.audioContext;
    } catch { return; }
  }

  private recoverAudioVoices() {
    for (const audio of this.activeVoices) {
      if (!audio.paused || (!audio.loop && !audio.dataset.soundKey)) continue;
      void audio.play().catch(error => this.failVoice(audio, error));
    }
    if (!this.retryEnvironment) return;
    this.retryEnvironment = false;
    this.syncWeatherSound(); this.syncZoneAudio(); this.syncUnderwaterSound();
  }

  private trimMobileMusic() {
    const music = [...this.activeVoices].filter(voice => voice.dataset.soundCategory === 'music');
    while (music.length >= 2) this.releaseVoice(music.shift()!, true);
  }

  private failVoice(audio: AudioVoice, error?: unknown) {
    if (!this.activeVoices.has(audio)) return;
    this.playbackFailures++;
    const key = audio.dataset.soundKey, name = (error as { name?: string } | undefined)?.name;
    if ((name === 'NotAllowedError' || name === 'AbortError') && key &&
      ['zone-music', 'zone-ambience', 'weather', 'underwater'].includes(key)) {
      this.retryEnvironment = true;
      if (key === 'zone-music') this.activeZoneKey = '';
    }
    this.releaseVoice(audio, true, 'error');
  }

  /**
   * Route a fresh voice through the shared lowpass (AUD-11). Fails soft: if the
   * AudioContext can't be created or the element was already captured, the element keeps
   * its direct output path and simply doesn't muffle.
   */
  private routeVoiceThroughFilter(audio: AudioVoice, position?: { x: number; y: number; z: number }) {
    let source: MediaElementAudioSourceNode | undefined, panner: PannerNode | undefined;
    try {
      if (!this.ensureAudioContext() || !this.audioContext) return;
      this.audioRecovery.resume();
      source = this.audioContext.createMediaElementSource(audio as HTMLAudioElement);
      if (position) {
        panner = this.audioContext.createPanner();
        panner.panningModel = soundPanningModel();
        panner.distanceModel = 'inverse';
        panner.refDistance = 4;
        panner.maxDistance = 60;
        panner.rolloffFactor = 1;
        panner.coneInnerAngle = 360;
        panner.coneOuterAngle = 360;
        setAudioParamPosition(panner, position, this.audioContext.currentTime);
        source.connect(panner).connect(this.lowpassNode!);
        this.routedVoices.set(audio, { source, panner });
      } else {
        source.connect(this.lowpassNode!);
        this.routedVoices.set(audio, { source });
      }
    } catch {
      // Once captured, an element no longer has direct output. Preserve an audible graph
      // even if allocating/connecting its spatial effect failed.
      if (source && this.audioContext) {
        try {
          panner?.disconnect(); source.disconnect(); source.connect(this.audioContext.destination);
          this.routedVoices.set(audio, { source });
        } catch { /* context/device unavailable; recovery will retry on a later gesture */ }
      }
    }
  }

  /** Keep the WebAudio listener aligned to the active Three.js camera. */
  updateListener(
    position: { x: number; y: number; z: number },
    forward: { x: number; y: number; z: number },
    up: { x: number; y: number; z: number },
  ) {
    updateAudioListener(this.audioContext, position, forward, up);
  }

  private syncUnderwaterFilter() {
    if (!this.audioContext || !this.lowpassNode) return;
    const now = this.audioContext.currentTime;
    this.lowpassNode.frequency.cancelScheduledValues(now);
    // ~700 Hz cutoff reads as vanilla's underwater dullness; 22 kHz is a no-op filter.
    this.lowpassNode.frequency.linearRampToValueAtTime(this.underwater ? 700 : 22050, now + 0.25);
  }

  setWorldReady(ready: boolean) {
    if (this.worldReady === ready) return;
    this.worldReady = ready;
    if (!ready) {
      // No environmental, spell, aura, or accidentally-looping UI voice may cross a loading screen.
      for (const voice of this.activeVoices) if (voice instanceof MobileBufferVoice) this.releaseVoice(voice, true);
      this.stopAllLoops();
      this.stop('weather', 250);
      this.stop('zone-ambience', 250);
      this.stop('zone-music', 250);
      this.stop('server-music', 250);
      this.stop('underwater', 250);
      return;
    }
    this.syncWeatherSound();
    this.syncZoneAudio();
    this.syncUnderwaterSound();
  }

  setZoneAudio(areaId: number, isDay: boolean, indoors: boolean) {
    const next = { areaId, isDay, indoors };
    if (this.desiredZone?.areaId === areaId && this.desiredZone.isDay === isDay && this.desiredZone.indoors === indoors) return;
    this.desiredZone = next;
    this.syncZoneAudio();
  }

  preloadSoundId(id: number | undefined) {
    if (!id || this.isMobileAudio()) return false;
    const entry = this.manifest.entries?.[String(id)];
    if (!entry?.files?.length) return false;
    if (!this.settings.soundEnabled || document.hidden) return false;
    for (const path of entry.files) this.preloadedFiles.preload(normalizeSoundUrl(this.resolveSoundPath(path)));
    return true;
  }

  isLoopingSound(id: number | undefined) {
    if (!id) return false;
    return this.manifest.entries?.[String(id)]?.loop ?? false;
  }

  setWeatherSound(soundId: number, active: boolean, volume = 1) {
    this.desiredWeather = active && soundId ? { soundId, volume } : undefined;
    return this.syncWeatherSound();
  }

  stop(key: string, fadeOutMs = 0) {
    const audio = this.keyedVoices.get(key);
    if (!audio) return;
    if (fadeOutMs > 0) this.fadeOutVoice(audio, fadeOutMs);
    else this.releaseVoice(audio, true);
  }

  stopLoop(key: string) {
    this.stop(key);
  }

  stopAllLoops() {
    for (const audio of [...this.activeVoices]) {
      if (audio.loop) this.releaseVoice(audio, true);
    }
  }

  diagnostics() {
    return {
      loaded: this.loaded,
      enabled: this.settings.soundEnabled,
      entries: Object.keys(this.manifest.entries ?? {}).length,
      ui: Object.keys(this.manifest.ui ?? {}).length,
      worldDisplays: Object.keys(this.manifest.world?.displays ?? {}).length,
      worldCreatureProfiles: Object.keys(this.manifest.world?.creatures ?? {}).length,
      worldAreas: Object.keys(this.manifest.world?.areas ?? {}).length,
      activeVoices: this.activeVoices.size,
      keyedVoices: [...this.keyedVoices.keys()],
      preloadedFiles: this.preloadedFiles.size,
      preloads: this.preloadedFiles.diagnostics(), audioContext: this.audioRecovery.diagnostics(),
      playbackFailures: this.playbackFailures, panningModel: soundPanningModel(),
      // Chromium refuses new playback past ~1000 live media players per frame. `mediaPlayers` is
      // the running estimate of what this manager holds; if it climbs toward that, sound is about
      // to die and `history()` will start showing back-to-back 'error' entries.
      voicesCreated: this.voicesCreated,
      voicesReleased: this.voicesReleased,
      mediaPlayers: [...this.activeVoices].filter(v => !(v instanceof MobileBufferVoice)).length + this.preloadedFiles.diagnostics().players,
      mobileBuffers: this.mobileBuffers.diagnostics(), mobileBufferedAudio: this.isMobileAudio(),
      mediaPlayerLimit: 1000, ...this.voiceBudget.diagnostics(),
      history: this.history.slice(),
      loops: [...this.activeVoices].filter((audio) => audio.loop).map((audio) => audio.dataset.soundKey ?? audio.currentSrc),
      desiredWeather: this.desiredWeather,
      weatherPath: this.desiredWeather
        ? this.manifest.world?.weather?.[String(this.desiredWeather.soundId)]
        : undefined,
      desiredZone: this.desiredZone,
      underwater: this.underwater, mobileDirectSfx: mobileDirectSfxEnabled(),
      spatialVoices: [...this.activeVoices].filter((audio) => !!this.routedVoices.get(audio)?.panner).length,
      worldReady: this.worldReady,
      ...this.settings,
    };
  }

  private playFile(path: string, options: PlaySoundOptions = {}) {
    const category = options.category ?? 'sfx';
    if (!this.categoryEnabled(category) || !path) return null;
    for (const voice of this.activeVoices) if (voice instanceof MobileBufferVoice && voice.expired) this.releaseVoice(voice, true, 'timeout');
    const key = options.key;
    if (key) {
      const previous = this.keyedVoices.get(key);
      if (previous) {
        if ((options.crossfadeMs ?? 0) > 0) this.fadeOutVoice(previous, options.crossfadeMs!);
        else this.releaseVoice(previous, true);
      }
    }
    if (this.isMobileAudio() && category === 'music') this.trimMobileMusic();
    if (!this.voiceBudget.admit(this.activeVoices, !!key || !!options.loop || category === 'music' || (this.isMobileAudio() && !options.position), (voice) => this.releaseVoice(voice, true))) return null;
    const url = normalizeSoundUrl(this.resolveSoundPath(path));
    const sourceUrl = normalizeSoundUrl(this.resolveSourceSoundPath(path));
    const fallbackUrl = sourceUrl !== url ? sourceUrl : null;
    const audio: AudioVoice = this.isMobileAudio() && category === 'sfx'
      ? new MobileBufferVoice(url, this.mobileBuffers, () => this.audioContext,
        () => options.underwaterAffected === false ? this.audioContext?.destination : this.lowpassNode, options.position)
      : this.preloadedFiles.take(url) ?? new Audio(url);
    this.voicesCreated++;
    audio.preload = 'auto';
    audio.loop = !!options.loop;
    if (options.playbackRate !== undefined) {
      audio.playbackRate = Math.max(0.5, Math.min(2, options.playbackRate));
      // Changing playbackRate should alter pitch as well as cadence for short
      // one-shot material variants. Browsers otherwise preserve pitch by default.
      audio.preservesPitch = false;
    }
    const baseVolume = clamp01(options.volume ?? 1);
    audio.dataset.baseVolume = String(baseVolume);
    audio.dataset.soundCategory = category;
    if (key) audio.dataset.soundKey = key;
    if (options.soundId !== undefined) audio.dataset.soundId = String(options.soundId);
    const targetVolume = this.effectiveVolume(baseVolume, category);
    audio.volume = options.fadeInMs ? 0 : targetVolume;
    // Vanilla's underwater DSP belongs to the environmental SFX bus. Interface feedback
    // (bags, CharacterFrame, Esc) and music must remain intelligible while submerged.
    if (!(audio instanceof MobileBufferVoice) && shouldRouteVoiceThroughWebAudio(category, options, this.underwater)) this.routeVoiceThroughFilter(audio, options.position);
    this.activeVoices.add(audio);
    if (key) this.keyedVoices.set(key, audio);
    audio.addEventListener('ended', () => {
      this.releaseVoice(audio, false, 'ended');
      options.onEnded?.();
    }, { once: true });
    if (options.maxDurationMs && options.maxDurationMs > 0) {
      const timer = window.setTimeout(() => this.releaseVoice(audio, true, 'timeout'), options.maxDurationMs);
      this.stopTimers.set(audio, timer);
    }
    this.recordSoundEvent('play', audio);
    const handleError = startVoicePlayback(audio, {
      fallbackUrl, active: () => this.activeVoices.has(audio),
      ready: () => { if (options.fadeInMs) this.fadeInVoice(audio, targetVolume, options.fadeInMs); },
      failed: error => this.failVoice(audio, error),
    });
    this.voiceErrorHandlers.set(audio, handleError);
    return audio;
  }

  private resolveSoundPath(path: string): string {
    const normalized = path.replaceAll('\\', '/').replace(/^\/?sounds\//i, '');
    const variant = this.manifest.audioVariants?.[normalized.toLowerCase()];
    if (!variant) return path;
    return this.opusSupported && variant.opus ? variant.opus : variant.source;
  }

  private resolveSourceSoundPath(path: string): string {
    const normalized = path.replaceAll('\\', '/').replace(/^\/?sounds\//i, '');
    return this.manifest.audioVariants?.[normalized.toLowerCase()]?.source ?? path;
  }

  private categoryEnabled(category: SoundCategory) {
    return category === 'music' ? this.settings.musicEnabled : this.settings.soundEnabled;
  }

  private syncWeatherSound() {
    const key = 'weather';
    const desired = this.desiredWeather;
    if (!this.worldReady || !desired) {
      this.stopLoop(key);
      return false;
    }
    if (!this.loaded) return false;
    const existing = this.keyedVoices.get(key);
    if (existing?.dataset.soundId === String(desired.soundId)) {
      const entryVolume = this.manifest.world?.weather?.[String(desired.soundId)]
        ? 1
        : (this.manifest.entries?.[String(desired.soundId)]?.volume ?? 1);
      const baseVolume = clamp01(entryVolume * desired.volume);
      existing.dataset.baseVolume = String(baseVolume);
      existing.volume = this.effectiveVolume(baseVolume, 'sfx');
      return true;
    }
    // SMSG_WEATHER carries WeatherSoundIds (8533..8558), not SoundEntries.dbc ids. The baker
    // preserves that separate lookup under world.weather; trying playSoundId() alone can never
    // resolve rain, snow, or sandstorm loops because those keys are absent from entries.
    const weatherPath = this.manifest.world?.weather?.[String(desired.soundId)];
    if (weatherPath) {
      return !!this.playFile(weatherPath, {
        key,
        loop: true,
        volume: desired.volume,
        soundId: desired.soundId,
        crossfadeMs: 1200,
        fadeInMs: 900,
      });
    }
    return !!this.playSoundId(desired.soundId, { key, loop: true, volumeScale: desired.volume, crossfadeMs: 1200, fadeInMs: 900 });
  }

  private syncUnderwaterSound() {
    const key = 'underwater';
    if (!this.worldReady || !this.underwater) {
      this.stop(key, 500);
      return;
    }
    const soundId = this.manifest.world?.water?.underwater;
    const existing = this.keyedVoices.get(key);
    if (existing?.dataset.soundId === String(soundId)) return;
    if (soundId) this.playSoundId(soundId, { key, loop: true, volumeScale: 0.72, crossfadeMs: 500, fadeInMs: 500 });
  }

  private syncZoneAudio() {
    const desired = this.desiredZone;
    if (!this.worldReady || !desired || !this.loaded) return;
    const profile = this.manifest.world?.areas?.[String(desired.areaId)];
    if (!profile) return;
    const ambienceId = desired.isDay ? profile.ambienceDay : profile.ambienceNight;
    const ambienceVolume = desired.indoors ? 0.2 : 0.72;
    const existingAmbience = this.keyedVoices.get('zone-ambience');
    if (existingAmbience?.dataset.soundId === String(ambienceId)) {
      this.setVoiceBaseVolume(existingAmbience, ambienceVolume);
    } else if (ambienceId) {
      this.playSoundId(ambienceId, {
        key: 'zone-ambience', loop: true, volumeScale: ambienceVolume, crossfadeMs: 1600, fadeInMs: 1200,
      });
    } else {
      this.stop('zone-ambience', 1000);
    }

    // Key the music on the sound it actually resolves to, not on day/night. 494 of the 928 areas
    // that author both bands use the SAME SoundEntries id for day and night (Zone_01 = 2523), so
    // keying on the band restarted the music at every dusk/dawn crossing. Worse, that id names a
    // POOL — 2523 is DayForest01/02/03 — so the restart re-rolled the variant and two different
    // tracks overlapped through the 800ms crossfade. The ambience above already guards this way.
    // Area still participates in the key, so entering a new zone still cuts its music and still
    // gets its intro; only the day/night half is replaced by what that band actually resolves to.
    const zoneMusicId = desired.isDay ? profile.musicDay : profile.musicNight;
    const zoneKey = `${desired.areaId}:${zoneMusicId ?? 0}`;
    if (zoneKey === this.activeZoneKey) return;
    this.activeZoneKey = zoneKey;
    if (this.zoneMusicTimer !== undefined) window.clearTimeout(this.zoneMusicTimer);
    this.zoneMusicTimer = undefined;
    this.stop('zone-music', 800);
    const playRegular = () => this.playZoneMusic(profile, desired.isDay);
    if (profile.intro && !this.playedZoneIntros.has(desired.areaId) && this.settings.musicEnabled) {
      this.playedZoneIntros.add(desired.areaId);
      this.playSoundId(profile.intro, {
        category: 'music', key: 'zone-music', crossfadeMs: 800, fadeInMs: 450, onEnded: playRegular,
      });
    } else {
      playRegular();
    }
  }

  private playZoneMusic(profile: AreaSoundProfile, isDay: boolean) {
    if (!this.settings.musicEnabled) return;
    const soundId = isDay ? profile.musicDay : profile.musicNight;
    if (!soundId) return;
    this.playSoundId(soundId, {
      category: 'music', key: 'zone-music', crossfadeMs: 800, fadeInMs: 650,
      onEnded: () => {
        const min = Math.max(0, isDay ? profile.silenceMinDay ?? 0 : profile.silenceMinNight ?? 0);
        const max = Math.max(min, isDay ? profile.silenceMaxDay ?? min : profile.silenceMaxNight ?? min);
        const delay = min + Math.random() * (max - min);
        this.zoneMusicTimer = window.setTimeout(() => {
          this.zoneMusicTimer = undefined;
          const current = this.desiredZone;
          if (current?.isDay === isDay) this.playZoneMusic(profile, isDay);
        }, delay);
      },
    });
  }

  private releaseVoice(audio: AudioVoice, stopPlayback: boolean, reason: SoundDebugEvent['action'] = 'stopped') {
    const errorHandler = this.voiceErrorHandlers.get(audio);
    if (errorHandler) audio.removeEventListener('error', errorHandler);
    this.voiceErrorHandlers.delete(audio);
    if (!this.activeVoices.has(audio)) return;
    this.voicesReleased++;
    this.recordSoundEvent(reason, audio);
    const timer = this.stopTimers.get(audio);
    if (timer !== undefined) window.clearTimeout(timer);
    this.stopTimers.delete(audio);
    const frame = this.fadeFrames.get(audio);
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    this.fadeFrames.delete(audio);
    const key = audio.dataset.soundKey;
    if (key && this.keyedVoices.get(key) === audio) this.keyedVoices.delete(key);
    this.activeVoices.delete(audio);
    const routed = this.routedVoices.get(audio);
    if (routed) {
      try { routed.source.disconnect(); } catch { /* already disconnected */ }
      try { routed.panner?.disconnect(); } catch { /* already disconnected */ }
      this.routedVoices.delete(audio);
    }
    if (stopPlayback) audio.pause();
    // Media streams release their decoder; buffer voices release only nodes and their cache lease.
    audio.removeAttribute('src');
    audio.load();
  }

  private fadeOutVoice(audio: AudioVoice, durationMs: number) {
    // Keep the keyed handle while this remains the current voice so a second stop(key) can turn a
    // graceful fade into an immediate stop. A crossfade safely replaces the map entry with its new
    // voice; releaseVoice only deletes the key when it still points at this audio element.
    const startedAt = performance.now();
    const startVolume = audio.volume;
    const tick = (now: number) => {
      if (!this.activeVoices.has(audio)) return;
      // rAF and performance timestamps can momentarily straddle a navigation/HMR
      // time-origin change. Clamp both bounds so HTMLMediaElement never receives
      // an invalid negative volume.
      const progress = clamp01((now - startedAt) / Math.max(1, durationMs));
      audio.volume = startVolume * (1 - progress);
      if (progress >= 1) this.releaseVoice(audio, true);
      else this.fadeFrames.set(audio, window.requestAnimationFrame(tick));
    };
    this.fadeFrames.set(audio, window.requestAnimationFrame(tick));
  }

  private fadeInVoice(audio: AudioVoice, targetVolume: number, durationMs: number) {
    const startedAt = performance.now();
    const tick = (now: number) => {
      if (!this.activeVoices.has(audio)) return;
      const progress = clamp01((now - startedAt) / Math.max(1, durationMs));
      audio.volume = targetVolume * progress;
      if (progress < 1) this.fadeFrames.set(audio, window.requestAnimationFrame(tick));
      else this.fadeFrames.delete(audio);
    };
    this.fadeFrames.set(audio, window.requestAnimationFrame(tick));
  }

  private setVoiceBaseVolume(audio: AudioVoice, baseVolume: number) {
    const category = (audio.dataset.soundCategory as SoundCategory | undefined) ?? 'sfx';
    const normalized = clamp01(baseVolume);
    audio.dataset.baseVolume = String(normalized);
    audio.volume = this.effectiveVolume(normalized, category);
  }

  private recordSoundEvent(action: SoundDebugEvent['action'], audio: AudioVoice) {
    this.history.push({
      at: performance.now(),
      action,
      soundId: audio.dataset.soundId ? Number(audio.dataset.soundId) : undefined,
      key: audio.dataset.soundKey,
      file: audio.currentSrc || audio.src,
    });
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
  }

  private effectiveVolume(baseVolume: number, category: SoundCategory) {
    const categoryVolume = category === 'music' ? this.settings.musicVolume : this.settings.sfxVolume;
    return clamp01(baseVolume * this.settings.masterVolume * categoryVolume);
  }

  private loadSettings(): SoundSettings {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = JSON.parse(raw) as Partial<SoundSettings>;
      return {
        masterVolume: clamp01(parsed.masterVolume ?? DEFAULT_SETTINGS.masterVolume),
        sfxVolume: clamp01(parsed.sfxVolume ?? DEFAULT_SETTINGS.sfxVolume),
        musicVolume: clamp01(parsed.musicVolume ?? DEFAULT_SETTINGS.musicVolume),
        soundEnabled: parsed.soundEnabled ?? DEFAULT_SETTINGS.soundEnabled,
        musicEnabled: parsed.musicEnabled ?? DEFAULT_SETTINGS.musicEnabled,
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // Private browsing / locked storage: settings simply last for this page.
    }
  }
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));

const setAudioParamPosition = (
  panner: PannerNode,
  position: { x: number; y: number; z: number },
  now: number,
) => {
  if (panner.positionX) {
    panner.positionX.setValueAtTime(position.x, now);
    panner.positionY.setValueAtTime(position.y, now);
    panner.positionZ.setValueAtTime(position.z, now);
  } else {
    panner.setPosition(position.x, position.y, position.z);
  }
};
