import { installGraphicsDiagnostics } from './platform/graphics-diagnostics';
import { rendererPixelRatio } from './platform/renderer-pixel-ratio';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ActionButton, AuraSlot, CharacterInfo, CombatEvent, DeathEvent, HonorSnapshot, InventorySnapshot, InventorySlot, PetSnapshot, RealmWorldClient, ReputationSnapshot, SkillSnapshot, WorldEntity } from './world';
import type { AuthSession } from './auth';
import { applyTerrainMaterialAnisotropy, type TerrainLight } from './terrain-shader';
import { createM2Material, setM2Light, type M2Light } from './m2-material';
import { DEFAULT_UNIT_DRAW_DIST, WorldEntityRenderer } from './world-entity-renderer';
import type { WorldEntityInspection } from './world-entity-renderer';
import { TypeID } from './world-entities';
import { PLAYER_COLLISION_CYLINDER, WorldCollision } from './world-collision';
import { TILE, TILE_HALF, shouldAllowWmoBelowTerrain, tileForCharacter, type TileEntry } from './tile-utils';
import { build5875SunDirection, resolveLighting, selectLightingProfileSlot, type BakedLightingData, type ResolvedLighting } from './world-lighting';
import { dayFactor as computeDayFactor, nightFactor } from './rendering/wmo-night.ts';
import { resolveAnimId } from './combat/anim-fallbacks';
import { DEFENSE_ANIM, meleeSwingAnim, parryAnim, rangedAttackAnim, readyStanceAnim, resolveWeapons, type EquippedWeapons } from './combat/attack-anims';
import { withoutDisarmedMainHand } from './combat/disarm';
import { SpellDebugTracker } from './combat/spell-debug';
import { EMOTE_ANIMS } from './data/emotes';
import { PLAYER_FIELDS, STOCK_PLAYER_FIELDS } from './data/player-field-layout';
import { loadBakedCharacterModel, sheathJointFor, type PlayerAnimState, type PlayerAnimator } from './model-loader';
import { XrRuntime } from './xr/xr-runtime';
import { pickXrWorld } from './xr/xr-world-pick';
import { installWorldEntityEvents } from './player/world-event-listeners';
import { PlayerMovementController, type ServerSpeedKind } from './player/movement-controller';
import { GroundSpellTargetingController } from './player/ground-spell-targeting';
import type { M2Animator } from './m2-animator';
import { resolveExperienceProgress } from './player/experience';
import { CharacterPreview } from './login/CharacterPreview';
import { createGameMenu } from './ui/game-menu';
import { CombatLogController } from './ui/combat-log';
import { StaticPopupPanel } from './ui/static-popup';
import { StackSplitCanvasPanel, type StackSplitAnchor } from './ui/stack-split-frame';
import { inventoryStackSplitIntent } from './ui/stack-split-routing';
import { createLogoutTimer } from './ui/logout-timer';
import { createCinematicFrame } from './ui/cinematic-frame';
import { createCinematicPlayer } from './rendering/cinematic-player';
import { ActionCombatController } from './ui/action-combat';
import { CharacterTabsController } from './ui/character-tabs';
import {
  CHARACTER_EQUIPMENT_LAYOUT,
  CharacterFrameCanvasRenderer,
  type CharacterFrameCanvasViewModel,
} from './ui/character-frame-canvas';
import {
  MainMenuBarCanvas,
  type MainMenuBarTarget,
  type MainMenuMicroButton,
} from './ui/main-menu-bar-canvas';
import type { MultiBarId } from './ui/multi-action-bars';
import { getGameTooltip } from './ui/game-tooltip';
import { itemTooltipLines, textTooltipLines } from './ui/tooltip-content';
import { ChannelMembership } from './ui/channel-membership';
import { ChatUiController } from './ui/chat';
import { INGAME_HUD_TEMPLATE } from './ui/ingame-hud-template';
import { installDraggableFrames, installGameTooltip, installHudKeybindings } from './ui/hud-window-interactions';
import { getIngameHudElements, type CharTab } from './ui/ingame-hud-elements';
import { InventoryCursorController, cursorSlotFromElement, type WowCursorName } from './ui/inventory-cursor';
import { InventoryInteractionController } from './ui/inventory-interactions';
import { InventoryUiController } from './ui/inventory-ui';
import { InventoryContainerCanvasBridge } from './ui/inventory-container-canvas';
import { firstEmptyKeyringSlot, KeyringDiscoveryState } from './ui/keyring-state';
import { KEYRING_CONTAINER_ID } from './data/keyring-layout';
import { chatItemLink, createItemUiHelpers } from './ui/item-ui';
import { createLightingPanel } from './ui/lighting-panel';
import { createMinimap, type MinimapBlip } from './ui/minimap';
import { NpcInteractionController } from './ui/npc-interactions';
import { WorldNoticeController } from './ui/world-notice-controller';
import { QuestLogController } from './ui/quest-log';
import { QuestWatchCanvasPanel } from './ui/quest-tracker';
import { questieLite } from './ui/questie-lite';
import { CombatTimersAddon } from './ui/combat-timers';
import { DamageMeterLiteAddon } from './ui/damage-meter-lite';
import { equippedComparisonLines, itemToolsSellPriceEnabled, junkInventorySlots } from './ui/item-tools';
import { BankCanvasPanel } from './ui/bank-frame';
import { TradeCanvasPanel } from './ui/trade-frame';
import { InspectFrame, type InspectSlotView } from './ui/inspect-frame';
import { TalentFrameController } from './ui/talent-frame';
import { SpellbookController } from './ui/spellbook';
import { SocialFrameController } from './ui/social-frame';
import { TargetingController } from './ui/targeting';
import { UnitFrameController } from './ui/unit-frames';
import { LiveUnitPortrait } from './ui/unit-frame-canvas';
import { createWorldMapFrame } from './ui/world-map';
import { ZoneTracker } from './ui/zone-tracker';
import { createMirrorTimers } from './ui/mirror-timer-select';
import { LootRollCanvas } from './ui/loot-roll-frame';
import { MasterLootCanvasPanel } from './ui/master-loot-frame';
import { PartyHudCanvas, PetHudCanvas } from './ui/party-pet-hud';
import { updateWaterTime, updateWaterLight } from './water-material';
import { updateGrassTime } from './rendering/grass-material';
import { updateTextureAnimations } from './rendering/m2-texture-animation';
import { WeatherRenderer } from './weather-renderer';
import { SpellVisualController } from './rendering/spell-visual-controller';
import { ModelOpacityController, playerOpacityTarget } from './rendering/model-opacity';
import { WowSoundManager } from './audio/sound-manager';
import { WorldAudioController } from './audio/world-audio-controller';
import {
  doodadCullingDiagnostics,
  doodadCullBatchCount,
  smallCullForWorldDetail,
  updateDoodadCulling,
  type DoodadCullStats,
} from './rendering/doodad-culling';
import {
  resolveWmoGroupsAtPoints,
  updateWmoPortalVisibility,
} from './rendering/wmo-visibility';
import { M2WorldLightingResolver } from './rendering/m2-world-lighting';
import { createBlobShadow, setBlobShadowSunScale, updateBlobShadowLod } from './rendering/blob-shadow';
import { applyUnderwaterFog } from './rendering/underwater-fog';
import { WorldDoodadEffectSpawner } from './rendering/world-doodad-effects';
import { terrainCompressionSupported } from './rendering/terrain-compression-support';
import { adjustAmbient, applyWeatherFogColor, applyWeatherSky, createSkyDome, mixColor, scaleColor, type RGB } from './rendering/lighting-utils';
import { createCelestialLayer } from './rendering/celestial';
import { createCloudLayer } from './rendering/clouds';
import { updateDoodadAnimations } from './rendering/doodad-skeletal-animation';
import { initRenderer } from './rendering/init-renderer';
import { installViewportResize, restoreRendererViewport } from './rendering/renderer-viewport';
import {
  beginCpuScope, endCpuScope, endPerformancePhase, CpuScopeId,
  prewarmPerformanceObject,
  setPerformanceLightweightDiagnostics, setPerformancePrimaryScene,
  setPerformanceSupplementalDiagnostics,
  startPerformancePhase,
} from './rendering/performance-runtime';
import { beginDetailedRenderFrame, beginEntityDetailFrame, performanceAblations, performanceDetailDiagnostics, suppressWmoRenderingForAblation } from './rendering/performance-detail-diagnostics';
import { renderSkyThenWorld, VanillaGammaPass } from './rendering/vanilla-gamma-pass';
import { updateTerrainSubmission } from './rendering/terrain-submission';
import { WorldTileLoader } from './rendering/world-tile-loader';
import { pumpWorldRenderAdmission } from './rendering/world-render-admission';
import { loadVideoCvars, loadGraphicsPreferences, type BrowserVideoCvars } from './ui/vanilla-video-cvars';
import { applyBrowserUiScale } from './ui/mobile/mobile-ui-scale';
import { loadInterfaceCvars, type InterfaceCvars } from './ui/interface-cvars';
import { getInterfaceCvars, setInterfaceCvars } from './ui/interface-runtime';
import { fctAllows, fctFloatTravel } from './ui/floating-combat-text';
import { HudFrameCadence } from './ui/hud-frame-cadence';
import { actionBarToggleMask } from './ui/action-bar-visibility';
import { CAMERA_DISTANCE_MAX, CAMERA_FIRST_PERSON_DISTANCE, CAMERA_NEAR_CLIP, cameraMaxDistance, cameraPivotHeight, cameraPolarLimits } from './player/camera-options';
import { installWorldCanvasGestures } from './player/world-canvas-gestures';
import { setBrowserFullscreen } from './platform/browser-fullscreen';
import { getAdaptiveQualityController } from './platform/mobile-bootstrap';
import { effectiveVideoCvars } from './platform/mobile-render-policy';
import { ChatBubbleLayer } from './ui/chat-bubbles';
import { CLASSES, isVanillaRaidMap, MAP_NAMES, RACES } from './wow-static-data';
import { factionIdForTemplate, getUnitReaction } from './faction-reaction';
import { withDuelReaction } from './ui/duel-reaction';
import { showUiError } from './combat/spell-errors';
import type { AreaTriggerManifest, AreaTriggerRecord, StarterZoneCamera, StarterZoneEntry, StarterZoneManifest } from './wow-app-types';
import './ui/ingame-hud.css';
import { KeyBindingCanvasPanel, KeyBindingStore } from './ui/keybinding-frame';
import { ReadyCheckController } from './ui/ready-check';
import { MacroSystem } from './ui/macro-frame';
import { createCraftUi } from './ui/craft-ui';
import { MailCanvasPanel } from './ui/mail-frame';
import { AuctionCanvasPanel } from './ui/auction-frame';
import { PetStableCanvasPanel } from './ui/pet-stable-frame';
import { PetitionCanvasPanel } from './ui/petition-frame';
import { GuildRegistrarCanvasPanel } from './ui/guild-registrar-frame';
import { qaGlobals } from './qa-globals.ts';
import { hideMapLoadingScreen, showMapLoadingScreen, updateMapLoadingProgress, waitForWorldRevealFrames } from './ui/map-loading-screen.ts';
import { retryAbortable } from './platform/retry-abortable';
THREE.ColorManagement.enabled = true;
declare global {
  interface Window {
    __wowAuthSession?: AuthSession;
  }
}
const logEl = document.getElementById('log')!;
const debugLogEnabled = new URLSearchParams(location.search).has('debuglog');
const collisionLogEnabled = new URLSearchParams(location.search).has('collisionlog');
// Developer overlays appear only with ?debugtools; normal gameplay never pays their DOM cost.
const debugToolsEnabled = new URLSearchParams(location.search).has('debugtools');
const entityDebugEl = document.getElementById('entity-debug')!;
const entityDebugTitle = document.getElementById('entity-debug-title')!;
const entityDebugContent = document.getElementById('entity-debug-content')!;
const entityDebugCopy = document.getElementById('entity-debug-copy') as HTMLButtonElement;
const entityDebugClose = document.getElementById('entity-debug-close') as HTMLButtonElement;
const debugLogLines: string[] = [];
const log = (m: string) => {
  if (debugLogEnabled) { debugLogLines.push(m); if (debugLogLines.length > 1000) debugLogLines.shift(); logEl.textContent = debugLogLines.join('\n'); }
  // eslint-disable-next-line no-console
  console.log('[wow-browser]', m);
};
let activeWorld: RealmWorldClient | null = null;
const resolveActiveRenderEntity = (renderId: number) => activeWorld?.getEntityByRenderId(renderId);
let disconnectNoticeShown = false;
function showDisconnectNotice(reason: string) {
  if (disconnectNoticeShown) return;
  disconnectNoticeShown = true;
  const overlay = document.createElement('div');
  overlay.className = 'wow-disconnect-overlay';
  const box = document.createElement('div');
  box.className = 'wow-disconnect-box';
  const title = document.createElement('h2');
  title.textContent = 'Disconnected';
  const detail = document.createElement('p');
  detail.textContent = reason || 'The connection to the server was lost.';
  const actions = document.createElement('div');
  actions.className = 'wow-disconnect-actions';
  const reconnect = document.createElement('button');
  reconnect.type = 'button';
  reconnect.textContent = 'Reconnect';
  // LoginFlow persists the authenticated realm/session and selected character before world entry.
  // Reloading consumes that token, performs a fresh AUTH_SESSION, selects the character, and lets
  // the realm resend the complete owner/combat snapshot instead of trying to resume a partial stream.
  reconnect.addEventListener('click', () => window.location.reload());
  const login = document.createElement('button');
  login.type = 'button';
  login.textContent = 'Return to Login';
  login.addEventListener('click', () => {
    sessionStorage.removeItem('wow-browser-refresh-session');
    window.location.reload();
  });
  actions.append(reconnect, login);
  box.append(title, detail, actions);
  overlay.append(box);
  document.body.append(overlay);
  reconnect.focus();
}

async function main() {
  const globalThis = qaGlobals;
  // A game surface owns right-click semantics; suppress Chrome's image/link/Inspect menu without
  // stopping propagation to targeting, unit popups, bags, maps, or other custom context handlers.
  document.addEventListener('contextmenu', (event) => event.preventDefault());
  // --- UI fidelity harness: ?ui=<panel> renders an in-world HUD panel with mock data (no login,
  // no world init) so loot/bag/character frames can be screenshotted against the extracted 1.12
  // FrameXML. Must run before any world/renderer setup so nothing else mounts a competing HUD. ---
  const uiPreviewParam = new URLSearchParams(location.search).get('ui');
  if (uiPreviewParam) {
    void import('./ui/ui-preview').then(({ runUiPreview }) => runUiPreview(uiPreviewParam));
    return;
  }

  // Realm protocol/auth code is not needed by the static UI harness and is a
  // distinct production chunk. It remains awaited before any login callbacks are
  // installed, so this changes transport boundaries without changing lifecycle.
  const { LoginFlow, forgetResumeCharacter } = await import('./login/LoginFlow');

  logEl.textContent = 'WoW Browser — world';

  const index: TileEntry[] = await fetch('/terrain/index.json', { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : []))
    .catch(() => []);
  const starterZones: StarterZoneManifest | null = await fetch('/terrain/starter-zones.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const lightingData: BakedLightingData | null = await fetch('/terrain/lighting.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const areaTriggerManifest: AreaTriggerManifest | null = await fetch('/terrain/area_triggers.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const areaTriggersByMap = new Map<number, AreaTriggerRecord[]>();
  for (const trigger of areaTriggerManifest?.triggers ?? []) {
    const list = areaTriggersByMap.get(trigger.mapId);
    if (list) list.push(trigger);
    else areaTriggersByMap.set(trigger.mapId, [trigger]);
  }
  const { renderer, api } = await initRenderer(log);
  if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
  if ('toneMapping' in renderer) renderer.toneMapping = THREE.NoToneMapping;
  if ('toneMappingExposure' in renderer) renderer.toneMappingExposure = 1;
  const maxAnisotropy = Math.max(1, Math.min(16, renderer.capabilities?.getMaxAnisotropy?.() ?? 8));
  const initialVideoCvars = effectiveVideoCvars(loadVideoCvars());
  const initialRenderScale = getAdaptiveQualityController()?.synchronizeRenderScale(initialVideoCvars.renderScale, { resetTiming: false }) ?? initialVideoCvars.renderScale;
  // gxCursor defaults to 1 in Build 5875. Apply it immediately so the browser
  // never falls back to the host OS arrow while the world UI is mounting.
  document.body.classList.toggle('wow-custom-cursor', Number(initialVideoCvars.gxCursor) !== 0);
  let appliedVideoCvars = initialVideoCvars;
  let videoFarclip = Number(initialVideoCvars.farclip) || 777;
  // Last frame's doodad-cull result, surfaced through __wowDoodadCull() for live QA.
  let lastDoodadCullStats: DoodadCullStats = { batches: 0, culledBySize: 0, culledByDistance: 0 };
  let textureAnisotropy = Math.max(1, Math.min(maxAnisotropy, Number(initialVideoCvars.anisotropic) || 1));
  // Environment Detail slider, 0 Low / 1 Medium / 2 High. Drives ground-clutter density the way
  // SetWorldDetail drives frillDensity in the client (16/32/48) — see bake-grass.ts.
  let worldDetail = Math.max(0, Math.min(2, Number(initialVideoCvars.WorldDetail ?? 2)));
  if (renderer.setPixelRatio) {
    renderer.setPixelRatio(rendererPixelRatio(renderer as THREE.WebGLRenderer, window.devicePixelRatio, initialRenderScale, window.innerWidth, window.innerHeight));
  }
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  setPerformancePrimaryScene(scene);
  const skyScene = new THREE.Scene();
  const gammaPass = api === 'WebGL2' ? new VanillaGammaPass(renderer as THREE.WebGLRenderer, window.innerWidth, window.innerHeight) : null;
  const resizeWorldRenderer = () => {
    const adaptiveScale = getAdaptiveQualityController()?.state().renderScale;
    if (renderer.setPixelRatio) {
      renderer.setPixelRatio(rendererPixelRatio(renderer as THREE.WebGLRenderer, window.devicePixelRatio, adaptiveScale ?? appliedVideoCvars.renderScale, window.innerWidth, window.innerHeight));
    }
    renderer.setSize(window.innerWidth, window.innerHeight);
    gammaPass?.setSize(window.innerWidth, window.innerHeight);
  };
  const renderWorld = (renderScene: THREE.Scene, renderCamera: THREE.Camera) => {
    pumpWorldRenderAdmission(); if (renderScene === scene) { suppressWmoRenderingForAblation(tileLoader?.wmoVisibilityInstances ?? []); beginDetailedRenderFrame(); updateTerrainSubmission(renderScene, renderCamera); }
    const background = renderScene === scene ? skyScene : null;
    if (gammaPass) gammaPass.render(renderScene, renderCamera, background);
    else renderSkyThenWorld(renderer as THREE.WebGLRenderer, renderScene, renderCamera, background);
  };
  log(`render API: ${api}`);
  log(`world tiles baked: ${index.map((t) => t.key).join(', ')}`);
  // Build marker - if you don't see "build R37" in this log you're on a cached/stale bundle
  // (hard-refresh the tab; if serving dist/, run `npm run build` first).
  log('build R37 - combat phase 1+2a: targeting, auto-attack (right-click/T), action bar (keys 1-0,-,=)');

  (globalThis as Record<string, unknown>).__wowScene = scene; // QA (removed after graphics-layer batch)
  (globalThis as Record<string, unknown>).__wowSkyScene = skyScene; // QA
  const sky = new THREE.Color(0x8fb7e0);
  skyScene.background = sky;
  scene.fog = new THREE.Fog(sky, TILE * 0.9, TILE * 2.4);
  const SKY_RADIUS = TILE * 3.5;
  const skyDome = createSkyDome(SKY_RADIUS);
  skyScene.add(skyDome.mesh);
  const celestial = createCelestialLayer(SKY_RADIUS); // sun / moon / stars
  (globalThis as Record<string, unknown>).__wowCelestial = celestial; // QA: opacity/layer/texture diagnostics
  skyScene.add(celestial.group);
  const clouds = createCloudLayer(SKY_RADIUS); // scrolling cloud layer
  skyScene.add(clouds.mesh);

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.9);
  scene.add(ambientLight);
  // Sky/ground fill so characters in tree shade (e.g. dark-furred Tauren) stay visible.
  const hemiLight = new THREE.HemisphereLight(0xbcd2ff, 0x4a3a28, 0.35);
  scene.add(hemiLight);
  const sun = new THREE.DirectionalLight(0xfff2d8, 1.0);
  // Captured Vanilla direction is the direction the rays travel. Three positions the light source.
  sun.position.set(0, 0.687, 0.688).multiplyScalar(TILE);
  scene.add(sun);

  const LIGHTING_DAY_LENGTH = lightingData?.dayLength ?? 2880;
  const computeSunDirection = (timeHalfMinutes: number, dayLength = LIGHTING_DAY_LENGTH) => {
    const [x, y, z] = build5875SunDirection(timeHalfMinutes, dayLength);
    return new THREE.Vector3(x, y, z);
  };

  // Position-aware lighting from the real Vanilla Light DBC chain.
  const DEFAULT_LIGHT: TerrainLight = {
    fogColor: [0.56, 0.72, 0.88], fogNear: TILE * 0.9, fogFar: TILE * 2.4,
    sunDir: computeSunDirection(lightingData?.defaultTime ?? 1440), sunColor: [1, 0.95, 0.85], ambient: [0.45, 0.5, 0.55],
    groundAmbient: [0.22, 0.21, 0.18],
    night: nightFactor(lightingData?.defaultTime ?? 1440),
  };
  let activeLight: TerrainLight = DEFAULT_LIGHT;
  let lastLightingMap = -1;
  let lastLightingProfileSlot = -1;
  let spiritWorldLighting = false;
  const lastLightingPosition = new THREE.Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  // Player environment exposure: drives non-M2 scene light, weather/audio and shadows. M2 models
  // bind their own WMO provider per draw, so this must never rewrite the shared M2 world block.
  let indoorSunScale = 1;
  let lastIndoorSunScale = 1;
  let weatherAtmosphereGrade = 0;
  let submerged = false; // camera below a liquid surface -> underwater fog
  const underwaterScratch = new THREE.Color();
  let lastWeatherAtmosphereGrade = 0;
  let tileLoader!: WorldTileLoader;
  let m2WorldLighting!: M2WorldLightingResolver;
  const disableWmoPortals = new URLSearchParams(location.search).has('nowmoportals');
  const disableWorldDoodadEffects = new URLSearchParams(location.search).has('noworldfx');
  // --- live lighting tuning knobs (so the world can be dialed to match the real client) ---
  // amb/sun = brightness multipliers; exp = overall exposure (scales both); ambSat = ambient
  // saturation (1 = DBC, <1 de-blues shadows); fog = fog-distance multiplier. Set via URL
  // (?amb=0.8&sun=1.1&ambsat=0.5&exp=1&fog=1) or live in the console: wowTune({amb:0.8}).
  const DAY_LENGTH = LIGHTING_DAY_LENGTH;
  // time = game time of day in half-minutes (0..2880); 1440 = noon. Drives the day/night cycle.

  // detail = strength of the upper terrain layers (highlight/dirt/road); 1 = raw data, lower = softer/greener.
  const tuning = { amb: 1, sun: 1, ambSat: 1, exp: 1, fog: 1, zone: 1, tex: 128, mip: 0, detail: 1, time: lightingData?.defaultTime ?? 1440 };
  // Day/night: when true the server clock drives tuning.time; the time slider flips it off so a dev
  // can freeze/scrub. lastDayNightStep gates the (forced) lighting re-resolve to actual step changes.
  let dayNightAuto = true;
  let lastDayNightStep = -1;
  // Lighting is applied while the initial video CVars are restored, before the
  // world/entity setup below. Keep the binding out of the temporal-dead-zone so
  // offline inspectors and the login scene can resolve their first light pass.
  let playerEntity: WorldEntity | undefined;
  {
    const tq = new URLSearchParams(location.search);
    const num = (k: string, d: number) => {
      const raw = tq.get(k);
      const v = Number(raw);
      return raw !== null && Number.isFinite(v) ? v : d;
    };
    tuning.amb = num('amb', 1);
    tuning.sun = num('sun', 1);
    tuning.ambSat = num('ambsat', 1);
    tuning.exp = num('exp', 1);
    tuning.fog = num('fog', 1);
    tuning.zone = num('zone', 1);
    tuning.tex = num('tex', 128);
    tuning.mip = num('mip', 0);
    tuning.detail = num('detail', 1);
    tuning.time = num('time', tuning.time);
  }
  // Apply the live terrain texture scale + detail strength to all loaded tiles.
  const applyTerrainTuning = () => {
    tileLoader?.applyTerrainTuning(tuning.tex, tuning.detail, tuning.mip);
  };
  const applyFarclipToLight = (light: TerrainLight): TerrainLight => {
    const fogFar = Math.max(1, Math.min(light.fogFar, videoFarclip));
    return {
      ...light,
      fogFar,
      // Preserve the LightFloatBand fog start. The old 82% clamp collapsed many
      // authored fog profiles into a thin wall at the far clip. (Note: with a LOW
      // farclip video setting the authored 25% start reads as heavy near fog —
      // fogNear=125/fogFar=500 in Zone_01 — which is expected; raise the terrain
      // distance setting rather than clamping the fog start.)
      fogNear: Math.min(light.fogNear, Math.max(0, fogFar - 1)),
    };
  };

  const applyLighting = (map: number, worldX = Number.POSITIVE_INFINITY, worldY = Number.POSITIVE_INFINITY, worldZ = 0, force = false) => {
    const profileSlot = selectLightingProfileSlot(spiritWorldLighting, weatherAtmosphereGrade, submerged);
    if (
      !force &&
      map === lastLightingMap &&
      profileSlot === lastLightingProfileSlot &&
      indoorSunScale === lastIndoorSunScale &&
      Math.abs(weatherAtmosphereGrade - lastWeatherAtmosphereGrade) < 0.005 &&
      ((lastLightingPosition.x - worldX) ** 2 + (lastLightingPosition.y - worldY) ** 2 + (lastLightingPosition.z - worldZ) ** 2) < 25
    ) return;
    // Light.dbc provides five parameter slots per light record: clear,
    // clear-underwater, storm, storm-underwater, and death/spirit world.
    const p = resolveLighting(lightingData, map, worldX, worldY, worldZ, tuning.time, tuning.zone, profileSlot);

    // spatially blended LightParams field 4 from the active environment structure.
    gammaPass?.setGlowIntensity(p?.glowIntensity ?? 0.5);
    spellVisuals?.setSkybox(p?.skybox ?? null);
    const weatherFogScale = 1 - 0.75 * weatherAtmosphereGrade;
    activeLight = applyFarclipToLight(p
      ? {
          fogColor: applyWeatherFogColor(p.fog as RGB, weatherAtmosphereGrade),
          fogNear: p.fogNear * tuning.fog * weatherFogScale,
          fogFar: p.fogFar * tuning.fog * weatherFogScale,
          sunDir: computeSunDirection(tuning.time, DAY_LENGTH),
          sunColor: scaleColor(p.sun as RGB, tuning.sun * tuning.exp),
          ambient: adjustAmbient(p.ambient as RGB, tuning.ambSat, tuning.amb * tuning.exp),
          groundAmbient: adjustAmbient((p.groundAmbient ?? DEFAULT_LIGHT.groundAmbient) as RGB, tuning.ambSat, tuning.amb * tuning.exp),
          night: nightFactor(tuning.time),
        }
      : { ...DEFAULT_LIGHT, night: nightFactor(tuning.time) });
    const skyTop = applyWeatherSky((p?.skyTop ?? [0.43, 0.62, 0.86]) as RGB, weatherAtmosphereGrade);
    const skyMid = applyWeatherSky((p?.skyMid ?? [0.56, 0.72, 0.88]) as RGB, weatherAtmosphereGrade);
    const skyHorizon = applyWeatherSky((p?.skyHorizon ?? [0.70, 0.78, 0.82]) as RGB, weatherAtmosphereGrade);
    // Day factor from the clock, not the sun colour: the resolved directional "sun" stays a moderate
    // dusk-blue well into the night (lum ~0.46 at midnight in Zone_01), so it can't tell day from
    // night. Time can: sun owns ~08:00-17:00, fades through dawn/dusk, off at night -> moon + stars
    // take over. Lives in rendering/wmo-night.ts so lit windows use this same curve, not a second one.
    const dayFactor = computeDayFactor(tuning.time);
    const twilight = 4 * dayFactor * (1 - dayFactor);
    skyDome.update(
      skyTop,
      skyMid,
      skyHorizon,
      activeLight.fogColor,
      activeLight.sunDir,
      activeLight.sunColor,
      twilight,
    );
    celestial.update(activeLight.sunDir, dayFactor);
    // Clouds tinted lighter than the horizon haze (warm at sunset, grey at night).
    clouds.update(mixColor(skyHorizon, [1, 1, 1], 0.5), dayFactor);
    if (!(skyScene.background instanceof THREE.Color)) skyScene.background = new THREE.Color();
    skyScene.background.setRGB(skyMid[0], skyMid[1], skyMid[2], THREE.SRGBColorSpace);
    if (!(scene.fog instanceof THREE.Fog)) scene.fog = new THREE.Fog(0, 0, 1);
    scene.fog.color.setRGB(activeLight.fogColor[0], activeLight.fogColor[1], activeLight.fogColor[2], THREE.SRGBColorSpace);
    scene.fog.near = activeLight.fogNear; scene.fog.far = activeLight.fogFar;
    ambientLight.color.setRGB(activeLight.ambient[0], activeLight.ambient[1], activeLight.ambient[2], THREE.SRGBColorSpace);
    ambientLight.intensity = 1.0;
    hemiLight.intensity = 0.2;
    sun.color.setRGB(activeLight.sunColor[0], activeLight.sunColor[1], activeLight.sunColor[2], THREE.SRGBColorSpace);
    sun.intensity = indoorSunScale; // 0 indoors (WMO interior) -> props lit by ambient + MOLT, not sun
    sun.position.copy(activeLight.sunDir).normalize().multiplyScalar(-TILE);
    // Drive every M2 model (player, NPCs, mobs) from the same resolved Light.dbc profile as the terrain.
    const m2Light: M2Light = {
      sunDir: activeLight.sunDir,
      sunColor: activeLight.sunColor,
      skyAmbient: activeLight.ambient,
      groundAmbient: activeLight.groundAmbient,
      fogColor: activeLight.fogColor,
      fogNear: activeLight.fogNear,
      fogFar: activeLight.fogFar,
    };
    setM2Light(m2Light);
    tileLoader?.applyTerrainLighting(activeLight);
    tileLoader?.updateWmoInteriorFog(activeLight);
    updateWaterLight(activeLight);
    lastLightingMap = map;
    lastLightingProfileSlot = profileSlot;
    lastIndoorSunScale = indoorSunScale;
    lastWeatherAtmosphereGrade = weatherAtmosphereGrade;
    lastLightingPosition.set(worldX, worldY, worldZ);
    (globalThis as Record<string, unknown>).__wowLighting = { resolved: p, weatherAtmosphereGrade };
  };

  // Which interior claimed the player this frame — read by __wowEnv() so "why is it dark here"
  // has an answer instead of a guess.
  let interiorSource: { tile: string; wmo: string; group: number } | null = null;
  let wmoResolutionToken = 0;
  // Each frame resolve camera portals and the player's own light provider. Other M2s resolve from
  // their model positions in WorldEntityRenderer; entering a room cannot relight the whole scene.
  const updateInteriorLighting = () => {
    interiorSource = null;
    wmoResolutionToken++;
    for (const inst of tileLoader?.wmoVisibilityInstances ?? []) {
      resolveWmoGroupsAtPoints(inst, camera.position, charPos, wmoResolutionToken);
    }
    const objectLight = m2WorldLighting.update(playerRoot, charPos, true);
    interiorSource = objectLight?.source ?? null;
    indoorSunScale = objectLight ? 0 : 1;
  };

  const tuningValues = () => ({ amb: tuning.amb, sun: tuning.sun, ambsat: tuning.ambSat, exp: tuning.exp, fog: tuning.fog, zone: tuning.zone, tex: tuning.tex, mip: tuning.mip, detail: tuning.detail, time: tuning.time });
  const reapplyTuning = () => {
    const pos = lastLightingPosition;
    applyLighting(lastLightingMap < 0 ? currentMap : lastLightingMap, pos.x, pos.y, pos.z, true);
  };
  const setTuning = (partial: Record<string, number>) => {
    if (partial.amb !== undefined) tuning.amb = partial.amb;
    if (partial.sun !== undefined) tuning.sun = partial.sun;
    if (partial.ambsat !== undefined) tuning.ambSat = partial.ambsat;
    if (partial.exp !== undefined) tuning.exp = partial.exp;
    if (partial.fog !== undefined) tuning.fog = partial.fog;
    if (partial.zone !== undefined) tuning.zone = partial.zone;
    if (partial.tex !== undefined) { tuning.tex = partial.tex; applyTerrainTuning(); }
    if (partial.mip !== undefined) { tuning.mip = partial.mip; applyTerrainTuning(); }
    if (partial.detail !== undefined) { tuning.detail = partial.detail; applyTerrainTuning(); }
    if (partial.time !== undefined) tuning.time = partial.time;
    reapplyTuning();
  };
  // Live tuning from the browser console: wowTune({amb:0.8, sun:1.1, ambsat:0.5, exp:1, fog:1}).
  (window as unknown as { wowTune: (partial?: Record<string, number>) => Record<string, number> }).wowTune = (partial) => {
    if (partial) setTuning(partial);
    const values = tuningValues();
    log(`wowTune ${JSON.stringify(values)} — paste these back to me to bake in`);
    return values;
  };

  if (debugToolsEnabled) {
    createLightingPanel({
      dayLength: DAY_LENGTH,
      values: () => tuningValues() as unknown as Record<string, number>,
      setTuning,
      onManualTime: () => { dayNightAuto = false; },
      log,
    });
  }

  // near = the client's own `nearclip` default (0.1yd; its accepted range is 0.01-0.33, per the
  // "NearClip must be in range 0.01 - 0.33" validator at 0x00869abc). The old value of 1.0 was the
  // single cause of both close-zoom symptoms: the near plane ate the character from a yard out, and
  // it reached a full yard past the camera's collision stop, which is what let you see through walls.
  //
  // The FOV stays at this repo's long-standing 60 and remains UNVERIFIED: the client ships no fov
  // cvar, and the per-model `fov` in the baked M2 `cameras[]` array belongs to the portrait /
  // character-info cameras, not the gameplay one.
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, CAMERA_NEAR_CLIP, TILE * 6);
  camera.up.set(0, 0, 1);
  camera.position.set(0, TILE * 0.72, 400);
  // ?debuglight — ALT+CLICK any object to dump its full lighting state as JSON. Read-only, and only
  // installed when the flag is present, so it costs nothing in a normal session.
  if (new URLSearchParams(location.search).has('debuglight')) {
    void import('./rendering/debug-light-picker').then(({ installDebugLightPicker }) => {
      installDebugLightPicker({
        scene,
        camera,
        renderer,
        domElement: renderer.domElement,
        environment: () => ({
          indoorSunScale,
          interiorSource,
          charPos: [charPos.x, charPos.y, charPos.z].map((value) => +value.toFixed(2)),
        }),
      });
    });
  }
  // Keep the general WMO QA picker out of this core file, and arm the safer click-to-probe tool
  // only for an explicit ?falldebug session. Its callbacks read live coordinates at click time.
  void import('./rendering/debug-world-picker').then(({ installDebugWorldPicker }) => {
    installDebugWorldPicker({
      scene,
      camera,
      domElement: renderer.domElement,
      fallDebug: new URLSearchParams(location.search).has('falldebug'),
      probe: (x, y, visualZ, currentTerrainZ) => {
        const world = localToWorld(x, y);
        const terrainHeight = sampleHeight(x, y);
        const support = worldCollision.sampleGround(x, y, visualZ + PLAYER_COLLISION_CYLINDER.maxStepUp, terrainHeight, {
          allowWmoBelowTerrain: shouldAllowWmoBelowTerrain(visualZ, currentTerrainZ ?? terrainHeight),
        });
        const tile = tileForCharacter(index, { map: currentMap, x: world.x, y: world.y, z: visualZ });
        return {
          map: currentMap,
          tile: tile?.key ?? tileLoader.currentTile?.key ?? null,
          world,
          renderOrigin: tileLoader.getRenderOrigin(),
          terrainHeight,
          support,
          player: qaGlobals.__wowPlayer,
          collisionStats: worldCollision.stats,
        };
      },
    });
  });
  // The sky is camera-centred and represents infinity, so its authored angular shape is invariant
  // under a uniform scale. Keep it just inside the active Vanilla farclip instead of leaving the
  // original 1,866-yard QA radius beyond the default 777-yard camera plane, which clipped the
  // gradient, sun, moon, clouds and every Stars.m2 layer before their materials could render.
  const fitSkyToFarClip = () => {
    const scale = Math.max(0.01, (camera.far * 0.98) / SKY_RADIUS);
    skyDome.mesh.scale.setScalar(scale);
    celestial.group.scale.setScalar(scale);
    clouds.mesh.scale.setScalar(scale);
  };
  const controls = new OrbitControls(camera, renderer.domElement);
  (globalThis as Record<string, unknown>).__wowCamera = camera; // QA
  (globalThis as Record<string, unknown>).__wowControls = controls; // QA
  // QA freecam: `__wowFreeCam(true)` detaches the camera from the character and unclamps the orbit
  // limits so the world can be inspected from any distance/angle; `__wowFreeCam(false)` restores the
  // shipped values. Needed because updateCameraFollow() collision-clamps the camera every frame.
  const freeCamDefaults = {
    maxDistance: controls.maxDistance,
    minDistance: controls.minDistance,
    minPolarAngle: controls.minPolarAngle,
    maxPolarAngle: controls.maxPolarAngle,
    enablePan: controls.enablePan,
  };
  (globalThis as Record<string, unknown>).__wowFreeCam = (on = true) => {
    (globalThis as Record<string, unknown>).__wowFreeCamEnabled = on;
    controls.maxDistance = on ? 4000 : freeCamDefaults.maxDistance;
    controls.minDistance = on ? 0.5 : freeCamDefaults.minDistance;
    // Free-cam unclamps the pitch entirely; switching it off restores the shipped ±89° band.
    controls.minPolarAngle = on ? 0 : freeCamDefaults.minPolarAngle;
    controls.maxPolarAngle = on ? Math.PI : freeCamDefaults.maxPolarAngle;
    controls.enablePan = on ? true : freeCamDefaults.enablePan;
    // Third-person zoom is owned by the movement controller (vanilla 1-yard notches); free-cam
    // wants OrbitControls' own multiplicative dolly so the world can be flown out to 4000yd.
    controls.enableZoom = on;
    controls.update();
    return on ? 'freecam ON — scroll to zoom, left-drag orbit, right-drag pan' : 'freecam OFF';
  };

  // QA: flip face culling on every WMO batch at runtime. `__wowWmoSide(2)` = DoubleSide (does the
  // near wall reappear?), `1` = FrontSide (shipped), `0` = BackSide (is our winding simply inverted?).
  // City_01 has ZERO two-sided materials (0 of 194 MOMT entries carry 0x04), so every wall depends
  // on winding being right — this is the fastest way to tell a culling bug from a data bug.
  (globalThis as Record<string, unknown>).__wowWmoSide = (side = 2) => {
    let n = 0;
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.userData?.wmoPick) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) { (mat as THREE.Material).side = side as THREE.Side; (mat as THREE.Material).needsUpdate = true; }
      n++;
    });
    return `side=${side} applied to ${n} WMO meshes`;
  };

  // QA: run the real portal-visibility pass at an arbitrary point and report what it decided.
  // `__wowWmoVis()` uses the live camera; `__wowWmoVis(x, y, z)` probes a spot you are not standing
  // in. Reports the resolved group per WMO, its flags, how much of the model survives the cull, and
  // whether the exterior world stays lit — the numbers needed to tell "camera thinks it is indoors"
  // apart from "interiors are drawn from outdoors".
  (globalThis as Record<string, unknown>).__wowWmoVis = (x?: number, y?: number, z?: number) => {
    const probe = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
      ? new THREE.Vector3(x as number, y as number, z as number)
      : camera.position.clone();
    const { exteriorVisible } = updateWmoPortalVisibility({
      instances: tileLoader.wmoVisibilityInstances,
      cameraPosition: probe,
      camera,
      disabled: false,
    });
    const perInstance = tileLoader.wmoVisibilityInstances.map((inst) => {
      const current = inst.currentGroup;
      const group = current >= 0 ? inst.groups[current] : null;
      let visibleGroups = 0;
      for (const g of inst.groups) if (g.objects.some((o) => o.visible)) visibleGroups++;
      return {
        model: (inst.model?.name ?? '').split('\\').pop(),
        groups: inst.groups.length,
        resolvedGroup: current,
        resolvedFlags: group ? `0x${(group.flags >>> 0).toString(16)}` : null,
        resolvedInterior: group ? (group.flags & 0x2000) !== 0 : null,
        resolvedExteriorLit: group ? (group.flags & 0x0040) !== 0 : null,
        visibleGroups,
        culledGroups: inst.groups.length - visibleGroups,
      };
    });
    const report = { probe: probe.toArray().map((v) => +v.toFixed(1)), exteriorVisible, perInstance };
    console.log('[wmovis]', report);
    return report;
  };
  controls.target.set(0, 0, 100);
  const soundManager = new WowSoundManager(), audioForward = new THREE.Vector3(), audioUp = new THREE.Vector3();
  const modelOpacity = new ModelOpacityController((guid) => playerOpacityTarget(guid, playerGuid ?? currentCharacter?.guid ?? '0',
    playerForm?.group, playerModelGroup, entityRenderer?.portraitModel(guid, TypeID.PLAYER)));
  // Spell visual renderer (vanilla M2 particle/ribbon emitters). The chain manifest maps spellId ->
  // which baked effect models to spawn for precast/cast/missile/impact/channel/area stages.
  const spellVisuals = new SpellVisualController({
    scene,
    skyScene,
    camera,
    getControls: () => controls,
    getPlayerGuid: () => controlledMoverGuid ?? playerGuid ?? currentCharacter?.guid,
    getSelectedTargetGuid: () => selectedTargetGuid,
    getCharPos: () => {
      const moverGuid = controlledMoverGuid;
      return moverGuid && moverGuid !== playerGuid
        ? entityRenderer?.controlFrame(moverGuid)?.position ?? charPos
        : charPos;
    },
    getPlayerAnimator: () => playerAnimator ?? undefined,
    getPlayerModelGroup: () => playerModelGroup ?? undefined,
    getEntityRenderer: () => entityRenderer ?? undefined,
    getMaxAnisotropy: () => textureAnisotropy,
    worldToLocal: (worldX, worldY) => worldToLocal(worldX, worldY),
    // playServerSound, not playSoundId: it is the same call behind a `worldReady` check, and spell
    // sounds MUST have one. Entities stream in and cast while the map loading screen is still up
    // (worldReady goes false in onEnterWorld and true at spawn), and an ungated cast sound plays
    // over the loading screen as if it came from the player. Captured live: a creature GUID
    // (0xF130.. = HIGHGUID_UNIT) firing sound 2560 ShadowCast.wav 8.3s before zone audio started.
    // Desktop preloads warm during loading; the mobile sound backend fetches effects only on demand.
    playSoundId: (soundId, key) => soundManager.playServerSound(soundId, { key }),
    preloadSoundId: (soundId) => soundManager.preloadSoundId(soundId),
    stopSound: (key, fadeOutMs) => soundManager.stop(key, fadeOutMs),
    isLoopingSound: (soundId) => soundManager.isLoopingSound(soundId),
    modelOpacity,
  });
  const worldDoodadEffects = new WorldDoodadEffectSpawner({ scene, camera, disabled: disableWorldDoodadEffects });
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.6;

  // which in OrbitControls' polar convention is the 1°..179° band. Both ends matter: the ceiling is
  // what lets the camera drop to ground level and sight up at the treetops.
  ({ min: controls.minPolarAngle, max: controls.maxPolarAngle } = cameraPolarLimits());
  // cameraDistanceMax "15.0" and cameraDistanceMoveSpeed "8.33", both read off the registration in

  // person threshold instead, because OrbitControls needs a non-degenerate offset to keep its basis.
  controls.minDistance = CAMERA_FIRST_PERSON_DISTANCE;
  controls.maxDistance = CAMERA_DISTANCE_MAX;
  controls.zoomSpeed = 1.2;
  controls.rotateSpeed = 0.5;
  controls.dampingFactor = 0.12;
  // WoW-style: BOTH left- and right-drag turn the camera around the character; never pan.
  // (default OrbitControls maps right-drag to pan, which is why right-click "didn't turn".)
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.enablePan = false;
  // Wheel zoom belongs to the movement controller, not OrbitControls. three.js r176 applies a
  // wheel dolly synchronously inside its own listener and clears `_scale` before the next frame,
  // so the follow camera's per-frame radius restore silently discarded every notch. The follow
  // camera also has to zoom in *yards* (vanilla CameraZoomIn(1.0)) rather than by a multiplier,
  // and has to keep working while the collision clamp is holding the camera against a wall.
  // Free-cam re-enables this in __wowFreeCam.
  controls.enableZoom = false;
  controls.update();

  const weatherRenderer = new WeatherRenderer(scene);
  (globalThis as Record<string, unknown>).__wowWeather = weatherRenderer; // QA: force weather in harnesses
  // QA: "is the doodad cull actually doing anything from here?" in one call.
  //
  // This RUNS the pass rather than reporting the previous frame, because `setAnimationLoop` is
  // driven by requestAnimationFrame and a headless/backgrounded tab never ticks it — a report-only
  // hook reads zero in exactly the harness you want to measure in. Optional overrides let a tester
  // sweep thresholds without touching the saved CVars.
  (globalThis as Record<string, unknown>).__wowDoodadCull = (smallCull?: number, distCull?: number) => {
    const small = smallCull ?? smallCullForWorldDetail(worldDetail);
    const dist = distCull ?? (Number(appliedVideoCvars.DistCull) || videoFarclip);
    lastDoodadCullStats = updateDoodadCulling(camera, small, dist);
    let visibleInstances = 0;
    let culledInstances = 0;
    scene.traverse((object) => {
      const instanced = object as THREE.InstancedMesh;
      if (!instanced.isInstancedMesh) return;
      if (instanced.visible) visibleInstances += instanced.count;
      else culledInstances += instanced.count;
    });
    return {
      ...lastDoodadCullStats,
      registeredBatches: doodadCullBatchCount(),
      smallCull: small,
      distCull: dist,
      distCullSource: distCull !== undefined ? 'override' : appliedVideoCvars.DistCull ? 'cvar' : 'farclip fallback',
      visibleInstances,
      culledInstances,
      percentCulled: visibleInstances + culledInstances > 0
        ? Number(((100 * culledInstances) / (visibleInstances + culledInstances)).toFixed(1))
        : 0,
    };
  };
  // QA: settles which PLAYER_FIELD_BYTES index this realm uses for combo points. Build a combo
  // point on a Rogue/Druid, then call __wowComboDebug() — the candidate whose byte 1 matches the
  // on-screen point count is the live one. See handoff §17.
  (globalThis as Record<string, unknown>).__wowComboDebug = () => activeWorld?.comboPointDebug();
  // QA: dump every visible player's weapon sheath so we can see, per player, the sheath value the
  // remote render actually resolved and the socket sheathJointFor maps it to. Run it with two
  // clients in view of each other and paste the output.
  (globalThis as Record<string, unknown>).__wowSheathDebug = () => {
    const rows = (activeWorld?.getEntities() ?? [])
      .filter((e) => e.typeId === 4 /* PLAYER */)
      .map((e) => {
        const name = e.guid === playerGuid ? '(self)' : (activeWorld?.getPlayerName(e.guid)?.name ?? e.guid);
        const weapons = (e.visibleEquipment ?? [])
          .filter((it) => [13, 14, 17, 21, 22, 23, 25, 26].includes(it.inventoryType))
          .map((it) => ({
            displayInfoId: it.displayInfoId,
            inventoryType: it.inventoryType,
            sheath: it.sheath,
            // Both carrying hands so we see the socket regardless of which side it took.
            socketMainHand: sheathJointFor(1, it.inventoryType, it.sheath),
            socketOffHand: sheathJointFor(2, it.inventoryType, it.sheath),
          }));
        // Raw non-zero fields across the VISIBLE_ITEM region (stock 0xFE / this realm's shifted
        // 0x104), so we can see exactly where the item ENTRY ids land vs where the client reads.
        const rawVisible: Record<string, number> = {};
        for (let index = 0xf0; index <= 0x1e6; index++) {
          const value = e.fields.get(index);
          if (value) rawVisible[`0x${index.toString(16)}`] = value;
        }
        return { name, sheathState: e.sheathState, entries: e.visibleItemEntries, weapons, rawVisible };
      });
    // eslint-disable-next-line no-console
    console.log('[wowSheathDebug]', JSON.stringify(rows, null, 2));
    return rows;
  };
  weatherRenderer.setCvars(initialVideoCvars.useWeatherShaders, initialVideoCvars.weatherDensity);

  const marker = new THREE.Mesh(
    new THREE.CapsuleGeometry(1.4, 4, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0xffd34d, emissive: 0x4a3700, roughness: 0.5 }),
  );
  marker.rotation.x = Math.PI / 2; // stand upright in WoW's Z-up space
  marker.visible = false;
  scene.add(marker);

  const textureLoader = new THREE.TextureLoader();
  const configureTexture = (tex: THREE.Texture, options: { repeat?: boolean; flipY?: boolean } = {}) => {
    // Vanilla world textures are multiplied by lighting in gamma space. Keep the
    // non-shader world paths in raw byte space too, so terrain fallback, grass,
    // doodads, and WMO do not get a separate sRGB decode from terrain/M2 models.
    if ('colorSpace' in tex) (tex as any).colorSpace = THREE.NoColorSpace;
    tex.anisotropy = textureAnisotropy;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = (tex as THREE.Texture & { isCompressedTexture?: boolean }).isCompressedTexture !== true;
    if (options.flipY !== undefined) tex.flipY = options.flipY;
    if (options.repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
  };
  const playerRoot = new THREE.Group();
  playerRoot.visible = false;
  const playerBlobShadow = createBlobShadow(0.55); // vanilla blob shadow under the player's feet
  playerRoot.add(playerBlobShadow);
  scene.add(playerRoot);
  let currentMap = index[0]?.map ?? 0;
  const worldCollision = new WorldCollision(); setPerformanceLightweightDiagnostics(() => ({ collision: worldCollision.stats }));
  let entityRenderer: WorldEntityRenderer | null = null;
  tileLoader = new WorldTileLoader({
    scene, camera,
    prewarmObject: (object, signal) => prewarmPerformanceObject(object, camera, scene, signal),
    tileIndex: index,
    textureLoader,
    worldCollision,
    worldDoodadEffects,
    configureTexture,
    getActiveLight: () => activeLight,
    // Enable authored arrays only after a real layer/mip pixel test on this renderer.
    supportsS3tc: terrainCompressionSupported(renderer),
    getTerrainTuning: () => ({ tex: tuning.tex, detail: tuning.detail, mip: tuning.mip, anisotropy: textureAnisotropy }),
    getWorldDetail: () => worldDetail,
    getCurrentMap: () => currentMap,
    getActiveWorld: () => activeWorld ?? undefined,
    getEntityRenderer: () => entityRenderer,
    getEffectFocus: () => {
      if (!playerGuid) return camera.position;
      return controlledMoverGuid && controlledMoverGuid !== playerGuid
        ? entityRenderer?.controlFrame(controlledMoverGuid)?.position ?? charPos
        : charPos;
    },
    getPlayerGuid: () => controlledMoverGuid ?? playerGuid, loadingScreenVisible: () => !!document.getElementById('map-loading-screen'),
    log,
  });
  m2WorldLighting = new M2WorldLightingResolver(() => tileLoader.wmoVisibilityInstances);
  const loadedTiles = tileLoader.loadedTiles;
  const loadingTiles = tileLoader.loadingTiles;
  setPerformanceSupplementalDiagnostics(() => {
    const audio = soundManager.diagnostics();
    return {
      doodadCulling: {
        currentFrame: { ...lastDoodadCullStats },
        cumulative: doodadCullingDiagnostics(),
        registeredBatches: doodadCullBatchCount(),
      },
      tiles: {
        current: tileLoader.currentTile?.key ?? null,
        ...tileLoader.streamingDiagnostics(),
        wmoInstances: tileLoader.wmoVisibilityInstances.length,
        exteriorVisible: tileLoader.exteriorVisible, layers: Object.fromEntries([...loadedTiles].map(([key, tile]) => [key, tile.group.userData.worldLayerDiagnostics ?? null])),
      },
      entities: {
        worldEntities: activeWorld?.getEntities().length ?? 0,
        renderer: entityRenderer?.performanceDiagnostics() ?? null,
      },
      audio: {
        activeVoices: audio.activeVoices,
        preloadedFiles: audio.preloadedFiles,
        voicesCreated: audio.voicesCreated,
        voicesReleased: audio.voicesReleased,
        mediaPlayers: audio.mediaPlayers,
        spatialVoices: audio.spatialVoices,
      },
      connection: activeWorld?.getConnectionDiagnostics() ?? null, performanceDetail: performanceDetailDiagnostics(),
      video: {
        farclip: videoFarclip,
        renderScale: appliedVideoCvars.renderScale,
        smallCull: smallCullForWorldDetail(worldDetail),
        distCull: Number(appliedVideoCvars.DistCull) || videoFarclip,
        doodadBatchMode: new URLSearchParams(location.search).get('doodadbatch') === 'whole' ? 'whole' : 'spatial',
        worldDetail,
      },
      camera: {
        x: Number(camera.position.x.toFixed(2)),
        y: Number(camera.position.y.toFixed(2)),
        z: Number(camera.position.z.toFixed(2)),
      },
    };
  });
  let playerAnimator: PlayerAnimator | null = null;
  let xrRuntime: XrRuntime | undefined;
  let playerModelGroup: THREE.Group | null = null;
  let playerModelDispose: (() => void) | null = null;
  let playerEquipmentAttachmentRoot: ((slot: number) => THREE.Group | undefined) | null = null;
  let playerGetHeadCentroid: (() => { x: number; y: number; z: number }) | null = null;
  const playerOverheadPoint = new THREE.Vector3();
  // Local player mount (UNIT_FIELD_MOUNTDISPLAYID on our own unit): the mount rig
  // renders under playerRoot, the character sits on its attachment-0 seat with the
  // Mount pose (91), and locomotion anims play on the mount instead of the rider.
  let playerMount: { group: THREE.Group; animator: M2Animator | null; dispose: () => void; displayId: number } | null = null;
  let playerMountLoadingId = 0;
  const playerMountSeat = new THREE.Matrix4();
  // Local shapeshift/transform rig. The authoritative switch is DISPLAYID != NATIVEDISPLAYID,
  // matching vMaNGOS SpellAuras.cpp for both SPELL_AURA_MOD_SHAPESHIFT and SPELL_AURA_TRANSFORM.
  let playerForm: {
    group: THREE.Group;
    animator: { update: (dt: number, animationId: number, camera?: THREE.Camera, group?: THREE.Group) => void } | null;
    dispose: () => void;
    displayId: number;
    animationIds: number[];
  } | null = null;
  let playerFormLoadingId = 0;
  let playerModelLoadGeneration = 0;
  let playerModelLoading = false;
  let playerAnimIds: number[] = [];
  // Weapons the local player has equipped, split main hand / off hand / ranged. Every combat pose
  // (swing kit, ready stance, parry) is picked from these — see combat/attack-anims.ts.
  let playerWeapons: EquippedWeapons = { mainHand: undefined, offHand: undefined, ranged: undefined };
  let playerCombatAnimId: number | undefined;
  let playerCombatUntil = 0;
  let playerCombatKind: 'melee' | 'cast' | 'reaction' | 'emoteState' | 'loot' | undefined;
  let activeLootAnimationGuid: string | undefined;
  // UNIT_FIELD_BYTES_2 byte 0 for the local player. Vanilla characters spawn with
  // weapons SHEATHED (state 0) and only draw on attack or the Z toggle — weapons
  // permanently in hand was the "always in combat mode" look.
  let playerSheathState: 0 | 1 | 2 = 0;
  let playerSetWeaponsSheathed: ((sheathState: number) => void) | null = null;
  // Deliberately separate from UNIT_FLAG_IN_COMBAT: a hostile creature noticing the
  // player sets that broad server flag, but Vanilla does not draw the player's weapon
  // until the player actually attacks/casts. It remains true across multi-mob fights.
  let playerActivelyEngaged = false;
  let playerWasServerInCombat = false;
  /** UNIT_FLAG_DISARMED edge tracking — a disarm changes the model, not the inventory. */
  let playerWasDisarmed = false;
  /** Last UNIT_NPC_EMOTESTATE seen per unit, so the looping emote is (re)started only on a change. */
  const npcEmoteStates = new Map<string, number>();
  // Floating Combat Text edge detectors. Each category only fires on a transition, so a
  // value that merely stays low (or an entity update that repeats unchanged fields) does
  // not spam the same label every packet.
  let fctLowHealthLatched = false;
  let fctLowManaLatched = false;
  let fctLastComboPoints = 0;
  let fctLastHonorPoints: number | undefined;
  const fctLastReputation = new Map<number, number>();
  const fctKnownAuras = new Map<string, Set<number>>();
  /** Vanilla's UIErrorsFrame low-vitals warning fires crossing 20% downward. */
  const FCT_LOW_VITALS_FRACTION = 0.2;
  // Last CMSG_SET_ACTIONBAR_TOGGLES byte pushed to the server. Undefined until world entry
  // resends it, because the panel's first apply happens before a realm connection exists.
  let lastActionBarMask: number | undefined;
  /** "showHelm/showCloak" digits from the last apply, so a change can force a model rebuild. */
  let lastEquipVisibility: string | undefined;

  const applyTextureAnisotropyToScene = () => {
    const textureKeys = ['map', 'alphaMap', 'aoMap', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'specularMap', 'envMap'];
    // `trilinear` picks how the two nearest mip levels are combined: on = interpolate between them
    // (trilinear), off = snap to the nearer mip (bilinear), which is the visible mip seam the option
    // exists to trade away. Only the mip term changes; in-plane filtering stays linear either way.
    const minFilter = Number(appliedVideoCvars.trilinear) === 0
      ? THREE.LinearMipmapNearestFilter
      : THREE.LinearMipmapLinearFilter;
    const visited = new Set<THREE.Texture>();
    for (const root of [scene, skyScene]) {
      root.traverse((object) => {
        const material = (object as THREE.Mesh).material;
        const materials = Array.isArray(material) ? material : material ? [material] : [];
        for (const mat of materials) {
          const bag = mat as THREE.Material & Record<string, unknown>;
          for (const key of textureKeys) {
            const tex = bag[key];
            if (tex instanceof THREE.Texture && !visited.has(tex)) {
              visited.add(tex);
              if (tex.anisotropy === textureAnisotropy && (tex.generateMipmaps === false || tex.minFilter === minFilter)) continue;
              tex.anisotropy = textureAnisotropy;
              // Only touch mipmapped textures — forcing a mip filter onto one built without mipmaps
              // renders it black.
              if (tex.generateMipmaps !== false && tex.minFilter !== minFilter) tex.minFilter = minFilter;
              tex.needsUpdate = true;
            }
          }
        }
      });
    }
  };

  /** True while the player is a ghost, independent of whether ffxDeath is drawing the wash. */
  let ghostWorldRequested = false;

  /**
   * Paint (or remove) the ghost wash from the current death state and the `ffxDeath` cvar.
   * Split out so toggling the option mid-session takes effect without waiting for a death.
   *
   * Declared here rather than next to setGhostWorld because applyVideoCvars calls it and runs during
   * module init — a `const` defined further down is still in its temporal dead zone at that point,
   * which threw "Cannot access 'applyGhostWorldFilter' before initialization" and blocked world entry.
   */
  /** "Enable All Shader Effects" — vanilla's master gate over the full-screen effect cvars. */
  const shaderEffectsEnabled = (cvars: BrowserVideoCvars) => Number(cvars.pixelShaders) !== 0;

  const applyGhostWorldFilter = () => {
    const wanted = ghostWorldRequested
      && shaderEffectsEnabled(appliedVideoCvars)
      && Number(appliedVideoCvars.ffxDeath) !== 0;
    renderer.domElement.classList.toggle('wow-ghost-world', wanted);
  };

  const applyVideoCvars = (savedCvars: BrowserVideoCvars, reason: 'ok' | 'defaults' | 'initial') => {
    const cvars = effectiveVideoCvars(savedCvars);
    const previous = appliedVideoCvars; appliedVideoCvars = cvars;
    videoFarclip = Math.max(50, Math.min(777, Number(cvars.farclip) || 777));
    textureAnisotropy = Math.max(1, Math.min(maxAnisotropy, Number(cvars.anisotropic) || 1));
    const previousWorldDetail = worldDetail;
    worldDetail = Math.max(0, Math.min(2, Number(cvars.WorldDetail ?? 2)));

    camera.far = videoFarclip;
    camera.updateProjectionMatrix();
    fitSkyToFarClip();
    if (reason === 'initial' || previous.anisotropic !== cvars.anisotropic || previous.trilinear !== cvars.trilinear) applyTextureAnisotropyToScene(); for (const tile of tileLoader?.loadedTiles.values() ?? []) applyTerrainMaterialAnisotropy(tile.terrainMaterial, textureAnisotropy);
    weatherRenderer.setCvars(Number(cvars.useWeatherShaders), Number(cvars.weatherDensity));
    // `gxCursor` is vanilla's hardware-cursor toggle; here it selects the drawn WoW cursor art vs
    // letting the OS draw its own pointer. Item-drag art is unaffected either way.
    document.body.classList.toggle('wow-custom-cursor', Number(cvars.gxCursor) !== 0);
    // Re-evaluate the ghost wash so toggling ffxDeath applies immediately, not on the next death.
    applyGhostWorldFilter();

    gammaPass?.setGamma(Number(cvars.gamma) || 1);
    // ffxGlow ships enabled in vanilla (Config.wtf ffxGlow="1"); the CVar is on/off,
    // intensity lives in the pass (tunable live via __wowGlowTune). "Enable All Shader Effects"
    // (pixelShaders) is vanilla's master over the ffx* pair, and the panel already greys them out
    // beneath it — this is the half that makes the greying mean something.
    const glowOn = (cvars.ffxGlow === undefined || Number(cvars.ffxGlow) !== 0);
    gammaPass?.setGlow(shaderEffectsEnabled(cvars) && glowOn ? 1 : 0);
    // Terrain layer alpha is authored data; TerrainMip changes only sampler bias.
    tuning.mip = Math.max(0, Math.min(1, Number(cvars.TerrainMip) || 0));
    tileLoader?.setTerrainMipBias(tuning.mip);

    applyBrowserUiScale(cvars);

    if (reason !== 'initial' && getAdaptiveQualityController()?.configureDynamicResolution(loadGraphicsPreferences().dynamicResolution, cvars.renderScale)) resizeWorldRenderer();

    if (reason !== 'initial' && worldDetail !== previousWorldDetail) tileLoader.setWorldDetail(worldDetail);

    if (reason !== 'initial') {
      void setBrowserFullscreen(Number(cvars.gxWindow) === 0).catch(() => undefined);
    }
  };
  applyVideoCvars(initialVideoCvars, 'initial');
  if (api === 'WebGL2') installGraphicsDiagnostics(renderer as THREE.WebGLRenderer, () => ({ ...appliedVideoCvars, anisotropic: textureAnisotropy, farclip: videoFarclip, WorldDetail: worldDetail }));

  // Interface Options cvars. The store persists every panel toggle; only the
  // options with a live subsystem are applied here. Camera reach and turn speed
  // map onto the OrbitControls the follow camera drives (base pull-out 15yd,
  // base rotateSpeed 0.5 at the 180 mid slider). Options without a subsystem
  // (chat bubbles, floating combat text, action-bar visibility) are persisted
  // for future wiring and intentionally not touched here.
  const CAMERA_BASE_ROTATE_SPEED = 0.5;
  const CAMERA_MIDPOINT_YAW = 180;

  /**
   * "Invert Mouse" (mouseInvertPitch).
   *
   * OrbitControls funnels every pitch input — mouse drag, touch drag and the arrow keys —
   * through the single `_rotateUp(angle)` method, so wrapping it once flips them all
   * consistently. It is underscore-private by convention: guard the patch so a three.js
   * upgrade that renames it degrades to "the option does nothing" rather than a crash.
   */
  let invertPitch = false;
  const setInvertPitch = (enabled: boolean) => { invertPitch = enabled; };
  {
    const orbit = controls as unknown as { _rotateUp?: (angle: number) => void };
    const baseRotateUp = orbit._rotateUp;
    if (typeof baseRotateUp === 'function') {
      orbit._rotateUp = function patchedRotateUp(angle: number) {
        baseRotateUp.call(this, invertPitch ? -angle : angle);
      };
    } else {
      log('camera: OrbitControls._rotateUp missing — Invert Mouse is inert on this three.js build');
    }
  }
  const applyInterfaceCvars = (cvars: InterfaceCvars, _reason: 'ok' | 'defaults' | 'initial') => {
    // Publish to the runtime accessor first so read-on-paint subsystems (unit-frame
    // status text, overhead-name toggles) pick up the change and preview live.
    setInterfaceCvars(cvars);
    if (!(globalThis as Record<string, unknown>).__wowFreeCamEnabled) {
      controls.maxDistance = cameraMaxDistance(cvars);
    }
    // Mouse Look Speed and the raw mouse sensitivity multiply: both scale the same
    // pointer-delta → orbit-angle conversion, which is exactly controls.rotateSpeed.
    const yaw = Math.max(90, Math.min(270, Number(cvars.cameraYawMoveSpeed) || CAMERA_MIDPOINT_YAW));
    const sensitivity = Math.max(0.5, Math.min(1.5, Number(cvars.mousespeed) || 1));
    controls.rotateSpeed = CAMERA_BASE_ROTATE_SPEED * (yaw / CAMERA_MIDPOINT_YAW) * sensitivity;
    // cameraYawSmoothSpeed drives the movement controller's real follow-yaw step; OrbitControls
    // damping only smooths raw mouse input and must not impersonate auto-follow.


    // frame regardless. Re-assert it here anyway so a stray writer cannot leave it drifted.
    if (!(globalThis as Record<string, unknown>).__wowFreeCamEnabled) {
      ({ min: controls.minPolarAngle, max: controls.maxPolarAngle } = cameraPolarLimits());
    }
    setInvertPitch(Number(cvars.mouseInvertPitch) === 1);
    controls.update();
    // Show Helm / Show Cloak change which items are composited into the character atlas, so
    // the model has to be rebuilt — nothing about it is updated in place. Remote players are
    // rebuilt by the entity renderer for the same reason.
    const equipVisibility = `${Number(cvars.showHelm) === 1 ? 1 : 0}${Number(cvars.showCloak) === 1 ? 1 : 0}`;
    if (lastEquipVisibility !== undefined && equipVisibility !== lastEquipVisibility) {
      if (currentCharacter) void loadPlayerModel(currentCharacter);
      entityRenderer?.refreshPlayerAppearances?.();
    }
    lastEquipVisibility = equipVisibility;
    // The action-bar toggle byte is server-persisted state, so only push it when it
    // actually changes — an unchanged apply (Okay with nothing touched) must not emit a packet.
    const barMask = actionBarToggleMask(cvars);
    if (barMask !== lastActionBarMask) {
      lastActionBarMask = barMask;
      activeWorld?.setActionBarToggles(barMask);
    }
  };
  applyInterfaceCvars(loadInterfaceCvars(), 'initial');

  const clearPlayerModel = (invalidatePendingLoad = true) => {
    xrRuntime?.clearModel();
    if (invalidatePendingLoad) playerModelLoadGeneration++;
    const previousGroup = playerModelGroup;
    const disposePrevious = playerModelDispose;
    playerAnimator = null;
    playerModelGroup = null;
    playerModelDispose = null;
    playerEquipmentAttachmentRoot = null;
    playerGetHeadCentroid = null;
    playerAnimIds = [];
    playerWeapons = { mainHand: undefined, offHand: undefined, ranged: undefined };
    playerSetWeaponsSheathed = null;
    playerCombatAnimId = undefined;
    playerCombatUntil = 0;
    playerCombatKind = undefined;
    (window as any).__headCentroid = undefined;
    (window as any).__getHeadCentroid = undefined;
    if (previousGroup) playerRoot.remove(previousGroup);
    disposePrevious?.();
  };

  const equipmentSignature = (equipment: CharacterInfo['equipment'] = []) =>
    equipment.map((item) => `${item.displayInfoId}:${item.inventoryType}:${item.sheath ?? ''}`).join(',');

  const loadPlayerModel = async (character: CharacterInfo) => {
    const generation = ++playerModelLoadGeneration;
    playerModelLoading = true;
    try {
      const model = await loadBakedCharacterModel(character, textureAnisotropy);
      if (generation !== playerModelLoadGeneration) {
        model.dispose();
        return false;
      }
      // Keep the currently-rendered body alive while an uncached equipment composition loads.
      // Removing it before the await made the local player disappear for roughly one network/
      // decode round trip the first time an item was equipped. Swap only once the replacement is
      // ready, so the old and new appearances change atomically between rendered frames.
      clearPlayerModel(false);
      playerAnimator = model.animator;
      xrRuntime?.bindModel(model, character.race);
      playerModelGroup = model.group;
      playerModelDispose = model.dispose;
      playerEquipmentAttachmentRoot = model.getEquipmentAttachmentRoot;
      playerGetHeadCentroid = model.getHeadCentroid;
      playerAnimIds = Array.from(new Set(model.data.sequences.map((sequence) => sequence.id))).sort((a, b) => a - b);
      // Swing kit, ready stance and parry pose all come from the equipped weapons. The model-load
      // equipment list is the char-enum/starter fallback; once the player entity's VISIBLE_ITEM
      // fields resolve to real items, currentPlayerWeapons() prefers those (they carry the
      // ItemPrototype subclass, which is what AttackAnimKits keys on).
      playerWeapons = resolveWeapons(character.equipment);

      // and adds 0.097222224. A night elf lands at 2.29yd and a gnome at 0.88, which is why a fixed
      // height read as "the camera sits too low" against the real client.
      movement?.setCameraPivotHeight(cameraPivotHeight(model.data));
      playerSetWeaponsSheathed = model.setWeaponsSheathed;
      model.setWeaponsSheathed(playerSheathState);
      model.group.visible = !playerForm;
      playerRoot.add(model.group);

      (window as any).__headCentroid = model.headCentroid;
      (window as any).__getHeadCentroid = model.getHeadCentroid;
      playerRoot.visible = true;
      // A model rebuilt while still a ghost (e.g. gear change mid-death) gets fresh, opaque materials;
      // re-apply the ghost fade so the body does not pop solid.
      if (deathPhase === 'ghost') setPlayerModelGhost(true);
      marker.visible = false;
      playerModelLoading = false;
      log(`character model: ${model.data.source} (${model.data.bones.length} bones, ${model.data.sequences.length} animations)`);
      return true;
    } catch (e) {
      if (generation !== playerModelLoadGeneration) return false;
      playerModelLoading = false;
      if (!playerModelGroup) {
        playerRoot.visible = false;
        marker.visible = true;
      }
      log(`character model unavailable (${(e as Error).message}); keeping the current appearance`);
      return false;
    }
  };

  // Rebuild the player model when the equipped set changes (equip/unequip armor, weapons, cloak).
  // Sourced from the now-correct inventory snapshot (equipment slots 0-18). Debounced 250ms.
  const refreshPlayerEquipmentModel = (snapshot: InventorySnapshot) => {
    if (!currentCharacter) return;
    const equipment = (snapshot.equipment ?? []).map((slot) => ({
      displayInfoId: slot.item?.info?.displayInfoId ?? 0,
      inventoryType: slot.item?.info?.inventoryType ?? 0,
      sheath: slot.item?.info?.sheath,
      slot: slot.index,
    }));
    // Disarm hides the local player's main hand too. The equipment signature drives the model
    // rebuild, so filtering here is what makes the weapon vanish and reappear with the aura.
    const visible = withoutDisarmedMainHand(equipment, playerEntity?.disarmed);
    const sig = equipmentSignature(visible);
    const changed = sig !== lastEquipSig;
    lastEquipSig = sig;
    // Inventory packets can arrive while the async enter-world model is still
    // loading. Preserve their authoritative sheath metadata for that first
    // build instead of discarding it until an unequip/equip event occurs.
    currentCharacter = { ...currentCharacter, equipment: visible };
    if (!changed || (!playerModelGroup && !playerModelLoading)) return;
    clearTimeout(equipReloadTimer);
    // Item queries can complete while the initial character model is still composing.
    // Invalidate that stale build and re-run with the authoritative sheath metadata;
    // previously this update was dropped until the user unequipped/re-equipped the item.
    equipReloadTimer = setTimeout(() => { if (currentCharacter) void loadPlayerModel(currentCharacter); }, 250);
  };

  const clearTiles = () => tileLoader.clear();
  const setRenderOrigin = (x: number, y: number) => tileLoader.setRenderOrigin(x, y);

  const loadTile = (entry: TileEntry) => tileLoader.loadTile(entry);

  const ensureTileNeighborhood = (entry: TileEntry, onProgress?: (loaded: number, total: number) => void) => { const terrainScope = beginCpuScope(CpuScopeId.TerrainStreaming); try { return tileLoader.ensureTileNeighborhood(entry, onProgress); } finally { endCpuScope(terrainScope); } };

  const sampleWaterLevel = (rx: number, ry: number) => tileLoader.sampleWaterLevel(rx, ry);

  const sampleHeight = (rx: number, ry: number) => tileLoader.sampleHeight(rx, ry);
  const sampleLoadedHeight = (rx: number, ry: number) => tileLoader.sampleLoadedHeight(rx, ry);
  const sampleTerrainType = (rx: number, ry: number) => tileLoader.sampleTerrainType(rx, ry);
  // Rain patter is emitted sparsely and resolves its surface only at spawn time.
  // This keeps splashes on terrain, WMO roofs, bridges, and exterior steps without
  // adding a collision query for every falling streak.
  weatherRenderer.setGroundSampler((x, y, fromZ) => {
    const terrainZ = sampleHeight(x, y);
    return worldCollision.sampleGround(x, y, fromZ, terrainZ).height;
  });

  const worldToLocal = (wx: number, wy: number) => tileLoader.worldToLocal(wx, wy);

  const localToWorld = (rx: number, ry: number) => tileLoader.localToWorld(rx, ry);

  const areaTriggerAt = (mapId: number, x: number, y: number, z: number): AreaTriggerRecord | null => {
    const triggers = areaTriggersByMap.get(mapId);
    if (!triggers?.length) return null;
    for (const trigger of triggers) {
      if (trigger.radius > 0) {
        const dx = x - trigger.x;
        const dy = y - trigger.y;
        const dz = z - trigger.z;
        if (dx * dx + dy * dy + dz * dz <= trigger.radius * trigger.radius) return trigger;
        continue;
      }

      const rotation = Math.PI * 2 - trigger.boxOrientation;
      const sinVal = Math.sin(rotation);
      const cosVal = Math.cos(rotation);
      const playerBoxDistX = x - trigger.x;
      const playerBoxDistY = y - trigger.y;
      const dx = playerBoxDistX * cosVal - playerBoxDistY * sinVal;
      const dy = playerBoxDistY * cosVal + playerBoxDistX * sinVal;
      const dz = z - trigger.z;
      if (
        Math.abs(dx) <= trigger.boxX / 2 &&
        Math.abs(dy) <= trigger.boxY / 2 &&
        Math.abs(dz) <= trigger.boxZ / 2
      ) {
        return trigger;
      }
    }
    return null;
  };

  let lastAreaTriggerId = 0;
  let lastAreaTriggerSentAt = 0;
  const updateAreaTriggers = (worldX: number, worldY: number, worldZ: number) => {
    const trigger = areaTriggerAt(currentMap, worldX, worldY, worldZ);
    if (!trigger) {
      lastAreaTriggerId = 0;
      return;
    }

    const now = performance.now();
    if (trigger.id === lastAreaTriggerId && now - lastAreaTriggerSentAt < 10_000) return;
    lastAreaTriggerId = trigger.id;
    lastAreaTriggerSentAt = now;
    activeWorld?.areaTrigger(trigger.id);
  };

  entityRenderer = new WorldEntityRenderer({
    scene,
    worldToLocal,
    sampleHeight,
    // WMO-aware ground for both entity settles — a body that dies on a bridge, a stair or an upper
    // storey lands on that surface instead of the terrain far below it, and a living NPC standing
    // on one is not dragged down through it. Same call shape the player ground resolution uses
    // above, including the allowWmoBelowTerrain rule.
    sampleGroundZ: (x, y, z) => {
      const terrainZ = sampleHeight(x, y);
      return worldCollision.sampleGround(x, y, z + PLAYER_COLLISION_CYLINDER.maxStepUp, terrainZ, {
        allowWmoBelowTerrain: shouldAllowWmoBelowTerrain(z, terrainZ),
      }).height;
    },
    // charPos is declared below but only read during the render loop (long after init);
    // it drives distance-based animation LOD so far NPCs skin at a reduced rate.
    getViewPosition: () => charPos,
    getUnitDrawDist: () => Number(appliedVideoCvars.unitDrawDist) || DEFAULT_UNIT_DRAW_DIST, forceFullRateCreatureAnimations: () => isVanillaRaidMap(currentMap),
    getTextureAnisotropy: () => textureAnisotropy,
    updateM2Light: performanceAblations.entityLightingOff ? undefined : (owner, point) => { m2WorldLighting.update(owner, point); },
    canRender: (entity) => {
      if (entity.x === undefined || entity.y === undefined) return false;
      const entry = tileForCharacter(index, { map: currentMap, x: entity.x, y: entity.y, z: entity.z ?? 0 });
      return !!entry && loadedTiles.has(entry.key);
    },
  });
  (globalThis as Record<string, unknown>).__wowEntityRenderer = entityRenderer;

  const inspectionPayload = (inspection: WorldEntityInspection) => {
    const entity = inspection.entity;
    const spline = entity.spline;
    const elapsedMs = spline?.startedAt === undefined ? undefined : Math.max(0, performance.now() - spline.startedAt);
    const progress = spline?.fullTime && elapsedMs !== undefined ? Math.min(1, elapsedMs / spline.fullTime) : undefined;
    return {
      identity: {
        guid: entity.guid,
        typeId: entity.typeId,
        typeName: entity.typeName,
        entry: entity.entry,
        displayId: entity.displayId,
        nativeDisplayId: entity.nativeDisplayId,
        mountDisplayId: entity.mountDisplayId,
      },
      render: inspection.render,
      worldPosition: { x: entity.x, y: entity.y, z: entity.z, orientation: entity.o },
      unit: {
        level: entity.level,
        health: entity.health,
        maxHealth: entity.maxHealth,
        faction: entity.faction,
        race: entity.race,
        classId: entity.classId,
        gender: entity.gender,
        powerType: entity.powerType,
        boundingRadius: entity.boundingRadius,
        combatReach: entity.combatReach,
      },
      flags: {
        movement: entity.flags === undefined ? undefined : `0x${entity.flags.toString(16).padStart(8, '0')}`,
        unit: entity.unitFlags === undefined ? undefined : `0x${entity.unitFlags.toString(16).padStart(8, '0')}`,
        dynamic: entity.dynamicFlags === undefined ? undefined : `0x${entity.dynamicFlags.toString(16).padStart(8, '0')}`,
        npc: entity.npcFlags === undefined ? undefined : `0x${entity.npcFlags.toString(16).padStart(8, '0')}`,
      },
      movement: {
        speeds: entity.speeds,
        spline: spline
          ? {
              id: spline.id,
              flags: `0x${spline.flags.toString(16).padStart(8, '0')}`,
              elapsedMs,
              fullTimeMs: spline.fullTime,
              progress,
              cyclic: (spline.flags & 0x00100000) !== 0,
              points: spline.points.length,
              start: [spline.startX, spline.startY, spline.startZ],
              end: [spline.endX, spline.endY, spline.endZ],
            }
          : undefined,
      },
      rawUpdateFields: Object.fromEntries(
        Array.from(entity.fields.entries())
          .sort(([a], [b]) => a - b)
          .map(([index, value]) => [`0x${index.toString(16).padStart(3, '0')}`, `0x${value.toString(16).padStart(8, '0')} (${value})`]),
      ),
    };
  };

  let targeting!: TargetingController;
  const updateEntityDebug = () => targeting.updateEntityDebug();

  // ===== Combat phase 1: targeting + auto-attack =====
  let playerGuid: string | undefined;
  let controlledMoverGuid: string | undefined;
  let controlledMovementAllowed = true;
  let controlledMoverBoundGuid: string | undefined;
  let selectedTargetGuid: string | undefined;
  let autoAttacking = false;
  let currentCharacter: CharacterInfo | undefined;
  const currentPlayerEntity = () => playerEntity
    ?? (playerGuid ? activeWorld?.getEntity(playerGuid) : undefined);
  // Live equipment re-composite: when the equipped set changes, rebuild the player model so newly
  // equipped armor/cloaks/weapons actually appear. Debounced so a multi-piece change rebuilds once.
  let lastEquipSig: string | null = null;
  let equipReloadTimer: ReturnType<typeof setTimeout> | undefined;
  let spawned = false;
  let actionCombat!: ActionCombatController;

  /**
   * Equipped weapons for the local player, preferring the live PLAYER_VISIBLE_ITEM resolution
   * (those entries carry the ItemPrototype subclass that AttackAnimKits keys on) and falling back
   * to the char-enum/starter list captured at model load.
   */
  const currentPlayerWeapons = (): EquippedWeapons => {
    const visible = playerEntity?.visibleEquipment;
    if (visible?.some((item) => item.subclass !== undefined)) return resolveWeapons(visible);
    return playerWeapons;
  };

  /** Equipped weapons for any unit; creatures and unresolved players come back empty. */
  const weaponsForGuid = (guid: string): EquippedWeapons => {
    if (guid === playerGuid) return currentPlayerWeapons();
    return resolveWeapons(entityRenderer?.inspect(guid)?.entity?.visibleEquipment);
  };

  // CharacterFrame sub-frames (CharacterFrame.lua CHARACTERFRAME_SUBFRAMES):
  // Character/PaperDoll, Pet, Reputation, Skills, Honor.
  const ingameHud = document.createElement('div');
  ingameHud.className = 'wow-ingame-hud';
  ingameHud.innerHTML = INGAME_HUD_TEMPLATE;
  document.body.appendChild(ingameHud);
  const mirrorTimers = createMirrorTimers(ingameHud.querySelector<HTMLElement>('#wow-mirror-timers')!);
  const tradeSkillPanel = createCraftUi({ hud: ingameHud,
    getKnownSpells: () => activeWorld?.getKnownSpells() ?? [],
    getSkills: () => lastSkills ?? activeWorld?.getSkills(),
    getInventory: () => lastInventory,
    getPet: () => lastPet ?? activeWorld?.getPet(),
    getItemInfo: (entry) => activeWorld?.getItemInfo(entry),
    requestItemInfo: (entry) => activeWorld?.requestItemInfo(entry),
    itemIconUrl: (displayInfoId, entry) => itemIconUrl(displayInfoId, entry),
    castTradeSpell: (spellId) => actionCombat.useSpell(spellId),
    castTrainingSpell: (spellId) => activeWorld?.castSpell(spellId),
    getPlayerPortraitSource: () => unitFrames.playerPortraitSource(), playUi: (name) => soundManager.playUi(name),
  });
  void tradeSkillPanel.initialize();
  const mailHost = document.createElement('section');
  mailHost.className = 'wow-mail-frame is-hidden';
  ingameHud.appendChild(mailHost);
  const auctionHost = document.createElement('section');
  auctionHost.className = 'wow-auction-frame is-hidden';
  ingameHud.appendChild(auctionHost);
  const petStableHost = document.createElement('section');
  petStableHost.className = 'wow-pet-stable-frame is-hidden';
  ingameHud.appendChild(petStableHost);
  const petitionHost = document.createElement('section');
  petitionHost.className = 'wow-petition-frame is-hidden';
  ingameHud.appendChild(petitionHost);
  const guildRegistrarHost = document.createElement('section');
  guildRegistrarHost.className = 'wow-guild-registrar-frame is-hidden';
  ingameHud.appendChild(guildRegistrarHost);

  // Circular minimap (top-right). Baked tiles live under /minimap/<MapDir>/ (tools/bake-minimap.ts).
  const minimap = createMinimap();
  ingameHud.appendChild(minimap.element);
  const worldMap = createWorldMapFrame();
  ingameHud.appendChild(worldMap.element);
  // vMaNGOS numeric map id -> minimap tile directory (matches minimap_tile_index.json + bake-minimap).
  //
  // 36/189 are the two Alpha 1.0 dungeons whose minimap art is laid out on the ADT grid, exactly
  // like an outdoor map: md5translate.trs ships `DeadminesInstance\map30_30..map35_35` (36 tiles)
  // and `MonasteryInstances\map28_27..map33_32` (36), and both coordinate sets match our baked
  // terrain cells one-for-one. Without these rows setMap(null) left the disc blank in both.
  //
  // Map 43 (Wailing Caverns) is deliberately absent and must stay absent. It is a WDT global-WMO
  // instance, so the .trs ships it a single placeholder `WailingCavernsInstance\map00_00.blp` at
  // grid (0,0) while the player streams cells 31_31..33_32 — an ADT-grid lookup can never hit it.
  // Its real minimap art is per-WMO-group under `wmo\Dungeon\KL_Wailing\wailingcaverns_NNN_x_y.blp`
  // and needs the group-keyed lookup path, which this table cannot express. Adding 43 here would
  // bake one tile nothing ever fetches and make the gate green over a still-blank minimap.
  const MINIMAP_DIR: Record<number, string> = {
    0: 'Azeroth', 1: 'Kalimdor', 30: 'Pvpzone01', 33: 'Shadowfang',
    36: 'Deadminesinstance', 189: 'Monasteryinstances',
  };
  // Zone-name banner: ZMP grid -> AreaTable id -> name (area_names.json), with parent-climb fallback.
  const zoneTracker = new ZoneTracker(ingameHud);
  const channelMembership = new ChannelMembership({ getWorld: () => activeWorld ?? undefined });
  let areaNames: Record<number, string> = {};
  let hudAreaId = 0; // current zone area id, tracked for the quest-log zone fallback
  void zoneTracker.init().catch(() => {});
  void fetch('/terrain/area_names.json').then((r) => (r.ok ? r.json() : {})).then((n) => { areaNames = n; }).catch(() => {});
  // QA: `__wowEnv()` answers "why is it dark/quiet HERE" in one call — it prints the two verdicts
  // that gate the outdoor look and the ambience mix (indoor containment, resolved Light.dbc
  // contributors) together with what the sound manager actually decided, plus the media-player
  // budget whose exhaustion silences every new voice. `__wowEnv.watch()` logs only on change, so
  // walking a suspect stretch shows exactly where a verdict flips and what flipped it.
  const envSnapshot = () => {
    const world = localToWorld(charPos.x, charPos.y);
    const areaId = hudAreaId;
    const lighting = (globalThis as Record<string, unknown>).__wowLighting as
      { resolved: ResolvedLighting | null; weatherAtmosphereGrade: number } | undefined;
    const audio = soundManager.diagnostics();
    return {
      position: {
        world: { x: +world.x.toFixed(2), y: +world.y.toFixed(2), z: +charPos.z.toFixed(2) },
        render: { x: +charPos.x.toFixed(2), y: +charPos.y.toFixed(2) },
        map: currentMap,
        tile: tileLoader?.currentTile?.key ?? null,
        renderOrigin: tileLoader?.getRenderOrigin() ?? null,
      },
      area: { areaId, name: areaNames[areaId] ?? null, zone: zoneTracker.resolveZone(currentMap, areaId)?.zoneName ?? null },
      // indoors drives BOTH the sun cut and the ambience duck (0.72 outdoors -> 0.2 indoors), so a
      // false positive reads as "lighting vanished and the birds went quiet" at the same step.
      indoors: {
        active: indoorSunScale < 0.5,
        sunScale: indoorSunScale,
        claimedBy: interiorSource,
      },
      lighting: {
        timeHalfMinutes: tuning.time,
        param: lighting?.resolved?.param ?? null,
        skybox: lighting?.resolved?.skybox ?? null,
        fogNear: lighting?.resolved?.fogNear ?? null,
        fogFar: lighting?.resolved?.fogFar ?? null,
        weatherGrade: lighting?.weatherAtmosphereGrade ?? 0,
        contributors: lighting?.resolved?.contributors ?? [],
      },
      audio: {
        zone: audio.desiredZone,
        loops: audio.loops,
        activeVoices: audio.activeVoices,
        mediaPlayers: audio.mediaPlayers,
        mediaPlayerLimit: audio.mediaPlayerLimit,
        exhausted: audio.mediaPlayers >= audio.mediaPlayerLimit,
        worldReady: audio.worldReady,
        underwater: audio.underwater,
      },
    };
  };
  let envWatchTimer: number | undefined;
  (globalThis as Record<string, unknown>).__wowEnv = Object.assign(envSnapshot, {
    watch: (on = true, intervalMs = 250) => {
      if (envWatchTimer !== undefined) { window.clearInterval(envWatchTimer); envWatchTimer = undefined; }
      if (!on) return 'env watch off';
      let last = '';
      envWatchTimer = window.setInterval(() => {
        const s = envSnapshot();
        const key = `${s.area.areaId}|${s.indoors.active}|${s.indoors.claimedBy?.wmo ?? ''}|${s.lighting.contributors.map((c) => c.id).join(',')}|${s.audio.exhausted}`;
        if (key === last) return;
        last = key;
        // eslint-disable-next-line no-console
        console.log('[env]', s.position.world, s.area.name ?? s.area.areaId,
          s.indoors.active ? `INDOORS via ${s.indoors.claimedBy?.wmo} (${s.indoors.claimedBy?.tile})` : 'outdoors',
          `lights=[${s.lighting.contributors.map((c) => `${c.id}@${c.weight.toFixed(2)}`).join(' ')}]`,
          s.audio.exhausted ? `MEDIA BUDGET EXHAUSTED (${s.audio.mediaPlayers})` : `players=${s.audio.mediaPlayers}`);
      }, Math.max(100, intervalMs));
      return `env watch on (${intervalMs}ms, logs on change only)`;
    },
  });

  // Minimap chrome (perf/zone/time) is refreshed off the 60Hz loop — DOM updates don't need every frame.
  let mmSmoothMs = 0;
  let mmChromeAt = 0;
  let mmBlipsAt = 0; // last minimap blip-array rebuild (throttled to ~150ms; see render loop)

  const keyBindings = new KeyBindingStore();
  const keyBindingLayer = document.createElement('div');
  keyBindingLayer.className = 'wow-keybinding-layer is-hidden';
  document.body.appendChild(keyBindingLayer);
  const keyBindingPanel = new KeyBindingCanvasPanel(keyBindingLayer, keyBindings, (name) => soundManager.playUi(name));
  const macroLayer = document.createElement('div');
  macroLayer.className = 'wow-macro-layer is-hidden';
  document.body.appendChild(macroLayer);
  const macroSystem = new MacroSystem(macroLayer, {
    getCharacterGuid: () => currentCharacter?.guid,
    getKnownSpells: () => activeWorld?.getKnownSpells() ?? [],
    assignMacro: (index) => { actionCombat.assignMacro(index); },
    executeLine: async (line) => {
      const cast = line.match(/^\/cast\s+(.+)$/i);
      if (cast) { await actionCombat.castSpellByName(cast[1]); return; }
      const use = line.match(/^\/use\s+(.+)$/i);
      if (use) {
        const wanted = use[1].trim().toLowerCase();
        const slots = lastInventory ? [...lastInventory.equipment, ...lastInventory.bags.flatMap((bag) => bag.slots)] : [];
        const slot = slots.find((candidate) => candidate.item?.info?.name.toLowerCase() === wanted);
        if (slot) activateInventorySlot(slot);
        else showUiError(`You do not have ${use[1]}.`);
        return;
      }
      const target = line.match(/^\/target\s+(.+)$/i);
      if (target) {
        const wanted = target[1].trim().toLowerCase();
        const entry = entityRenderer?.nameplateEntries().find((candidate) => nameForEntity(candidate.guid, candidate.entity).toLowerCase() === wanted);
        if (entry) setTarget(entry.guid);
        return;
      }
      if (/^\/startattack$/i.test(line)) { if (!autoAttacking) actionCombat.toggleAttack(); return; }
      if (/^\/stopattack$/i.test(line)) { stopAttack(); return; }
      if (/^\/stopcasting$/i.test(line)) { activeWorld?.cancelCast(); return; }
      const say = line.match(/^\/(?:s|say)\s+(.+)$/i);
      if (say) { activeWorld?.sendChat(say[1], 0x00); return; }
      const yell = line.match(/^\/(?:y|yell)\s+(.+)$/i);
      if (yell) { activeWorld?.sendChat(yell[1], 0x05); return; }
      showUiError(`Unknown macro command: ${line.split(/\s+/)[0]}`);
    },
    playUi: (name) => soundManager.playUi(name),
  });

  // Vanilla's Logout returns to CHARACTER SELECT, not to the account screen. `LoginFlow` is
  // permanently destroyed on world entry and has no revive path, so this goes through a reload —
  // but it forgets only the selected character and keeps the authenticated session, so
  // LoginFlow.start() reconnects the realm and stops at character select.
  const returnToCharacterSelect = () => {
    forgetResumeCharacter();
    tradeSkillPanel.close();
    activeWorld?.close();
    setTimeout(() => window.location.reload(), 150);
  };

  const gameMenu = createGameMenu({
    onApplyVideo: applyVideoCvars,
    onApplyInterface: applyInterfaceCvars,
    onLogout: () => {
      // Ask the server rather than tearing the page down. vMaNGOS answers SMSG_LOGOUT_RESPONSE and,
      // outside an inn/city, sits + roots the player for 20 seconds before SMSG_LOGOUT_COMPLETE
      // (MiscHandler.cpp:284-341, WorldSession.h:282-285). Closing the socket here would skip the
      // whole sequence the CAMP dialog exists to show.
      if (!activeWorld) {
        returnToCharacterSelect();
        return;
      }
      activeWorld.requestLogout();
      log('main menu: logout requested');
    },
    onExit: () => {
      sessionStorage.removeItem('wow-browser-refresh-session');
      activeWorld?.close({ logout: true });
      window.close();
      log('main menu: exit requested');
    },
    playUi: (name) => soundManager.playUi(name),
    getSoundSettings: () => soundManager.getSettings(),
    onApplySound: (settings) => soundManager.setSettings(settings),
    onOpenKeyBindings: () => keyBindingPanel.open(),
    onOpenMacros: () => { void macroSystem.open(); },
  });
  ingameHud.querySelector('.wow-micro-button--mainmenu')?.addEventListener('click', () => gameMenu.openMenu());

  const {
    playerFrame,
    pfName,
    pfLevel,
    pfHp,
    pfHpText,
    pfPower,
    pfPowerText,
    pfPvp,
    targetFrame,
    tfName,
    tfLevel,
    tfHp,
    tfHpText,
    tfPower,
    tfPowerText,
    tfPvp,
    tfSkull,
    tfArt,
    totFrame,
    UNIT_BYTE2_FLAG_PVP,
    UNIT_BYTE2_FLAG_FFA_PVP,
    ALLIANCE_RACES,
    HORDE_RACES,
    PVP_ICON_BASE,
    TARGET_NAME_BG,
    TAPPED_NAME_BG,
    applyPvpBadge,
    TARGET_FRAME_ART,
    ELITE_FRAME_ART,
    buffsEl,
    castBar,
    castSpellName,
    castFill,
    questWatch,
    questProgress,
    chatBox,
    chatMessages,
    chatInput,
    mainMenuBar,
    actionBar,
    characterFrame,
    characterName,
    characterSubtitle,
    characterPortrait,
    characterClose,
    paperdollSlots,
    characterStats,
    characterModelEl,
    ensurePaperdoll,
    renderPaperdoll,
    rotatePaperdoll,
    characterTabButtons,
    charPages,
    microCharacter,
    microWorld,
    containerLayer,
    bagSlotButtons,
    backpackButton,
    lootFrame,
    questLogFrame,
    microQuest,
    merchantFrame,
    trainerFrame,
    gossipFrame,
    questFrame,
    talentFrame,
    taxiFrame,
    bankFrame,
    tradeFrame,
    inspectFrame,
    interactionPanel,
    logoutPopup,
    gameTooltip,
  } = getIngameHudElements(ingameHud, {
    renderer,
    worldMap,
    getCurrentCharacter: () => currentCharacter,
  });
  const logoutPopupPanel = new StaticPopupPanel(logoutPopup, { playUi: (name) => soundManager.playUi(name) });
  const stackSplitPanel = new StackSplitCanvasPanel(ingameHud, { playUi: (name) => soundManager.playUi(name) });
  const logoutTimer = createLogoutTimer({
    popup: logoutPopupPanel,
    sendCancel: () => activeWorld?.cancelLogout(),
    finishLogout: returnToCharacterSelect,
    showError: (message) => showUiError(message),
    log,
  });

  // CinematicFrame is a fullscreen letterbox over everything, so it lives on <body>, not the HUD.
  const CINEMATIC_NARRATION_KEY = 'cinematic-narration';
  const cinematicFrame = createCinematicFrame();
  let completeCinematic: (() => void) | null = null;
  let pendingCinematic: { cinematicId: number; complete: () => void } | null = null;
  const cinematicPlayer = createCinematicPlayer({
    camera,
    worldToLocal: (wx, wy) => worldToLocal(wx, wy),
    onCameraWorldPosition: (wx, wy) => {
      // The path travels up to ~1800 yards from the spawn, well outside the neighbourhood loaded at
      // world entry, so terrain has to stream around the CAMERA while the flythrough runs.
      const entry = tileForCharacter(index, { map: currentMap, x: wx, y: wy, z: 0 });
      if (entry) void tileLoader.ensureTileNeighborhood(entry, undefined, { activate: false });
    },
    playNarration: (soundId) => {
      // Keyed so ESC can cut the voice line off mid-sentence, the way vanilla's StopCinematic does.
      // Category 'music' keeps the voice out of the sfx bus that gets ducked below, so the narration
      // stays at full level while the birds and ambience drop back.
      const voice = soundManager.playSoundId(soundId, { key: CINEMATIC_NARRATION_KEY, category: 'music' });
      return voice ? { stop: () => soundManager.stop(CINEMATIC_NARRATION_KEY) } : null;
    },
    onFinished: () => {
      cinematicFrame.hide();
      endCinematicPresentation();
      // Hand the camera back seated behind the character, the way world entry seats it. The follow
      // camera rebuilds its orbit from `camera.position - controls.target`, so it has to be given a
      // sane pair — otherwise the first frame after the flythrough reads a delta of several hundred
      // yards and throws the camera across the zone.
      const facing = playerRoot.rotation.z;
      const back = 6.5;
      controls.target.set(charPos.x, charPos.y, charPos.z + movement.getCameraPivotHeight());
      camera.position.set(charPos.x - Math.cos(facing) * back, charPos.y - Math.sin(facing) * back, charPos.z + 3.2);
      controls.update(); const playerTile = tileLoader.currentTile?.entry; if (playerTile) void tileLoader.ensureTileNeighborhood(playerTile);
      const complete = completeCinematic;
      completeCinematic = null;
      complete?.();
    },
    log,
  });

  /**
   * Start a queued race intro, once the world is genuinely on screen.
   *
   * Two things have to be true before the first frame, and neither was true where
   * SMSG_TRIGGER_CINEMATIC arrives:
   *  - the loading screen must be gone, or the letterbox just draws over it;
   *  - the terrain under the OPENING SHOT must be streamed in. A race intro does not open at the
   *    spawn: the Human camera opens over Stormwind City, two tiles outside the neighbourhood loaded
   *    at world entry, so it used to fly over empty space — which reads as a camera that is barely
   *    moving, because there is nothing in view to move against.
   */
  /**
   * Cinematic presentation: the world is the only thing on screen.
   *
   * Vanilla hides the entire interface for the duration — `CinematicFrame_OnEvent` calls
   * `ShowUIPanel(this, 1)` on CINEMATIC_START, and the frame is fullscreen with `enableMouse`, so
   * nothing behind it is visible or clickable. The ambience is pulled back so the narration carries;
   * the voice line itself plays on the music bus and is not ducked.
   */
  const CINEMATIC_SFX_DUCK = 0.25;
  let duckedSfxVolume: number | null = null;
  const beginCinematicPresentation = () => {
    document.body.classList.add('wow-cinematic-active');
    if (duckedSfxVolume === null) {
      duckedSfxVolume = soundManager.getSettings().sfxVolume;
      soundManager.setSettings({ sfxVolume: duckedSfxVolume * CINEMATIC_SFX_DUCK });
    }
  };
  const endCinematicPresentation = () => {
    document.body.classList.remove('wow-cinematic-active');
    if (duckedSfxVolume !== null) {
      soundManager.setSettings({ sfxVolume: duckedSfxVolume });
      duckedSfxVolume = null;
    }
  };

  const beginPendingCinematic = async () => {
    const queued = pendingCinematic;
    pendingCinematic = null;
    if (!queued) return;
    try {
      const start = cinematicPlayer.startWorldPosition(queued.cinematicId);
      if (start) {
        const entry = tileForCharacter(index, { map: currentMap, x: start.x, y: start.y, z: start.z });
        if (entry) {
          log(`cinematic: preloading ${entry.key} for the opening shot`);
          await tileLoader.ensureTileNeighborhood(entry, undefined, { activate: false });
        }
      }
      if (!cinematicPlayer.start(queued.cinematicId)) {
        queued.complete();
        return;
      }
      completeCinematic = queued.complete;
      beginCinematicPresentation();
      cinematicFrame.show();
    } catch (e) {
      // Never leave the player frozen: vMaNGOS ignores movement until the ack arrives.
      log(`cinematic: start failed (${(e as Error).message})`);
      cinematicFrame.hide();
      endCinematicPresentation();
      queued.complete();
    }
  };

  // QA: replay any race intro in-world without rerolling a character.
  //   __wowCinematic()     -> list the sequence ids
  //   __wowCinematic(81)   -> play the Human intro from the top (81 Human, 41 Dwarf, 101 Gnome,
  //                           2 Undead, 61 NightElf, 21 Orc, 121 Troll, 141 Tauren)
  (globalThis as Record<string, unknown>).__wowCinematic = (sequenceId?: number) => {
    if (sequenceId === undefined) {
      return { Human: 81, Dwarf: 41, Gnome: 101, Undead: 2, NightElf: 61, Orc: 21, Troll: 121, Tauren: 141 };
    }
    if (!cinematicPlayer.canPlay(sequenceId)) return `no baked data for sequence ${sequenceId}`;
    pendingCinematic = { cinematicId: sequenceId, complete: () => {} };
    void beginPendingCinematic();
    return `playing sequence ${sequenceId} — opens at ${JSON.stringify(cinematicPlayer.startWorldPosition(sequenceId))}`;
  };

  const spellbookFrame = ingameHud.querySelector<HTMLElement>('#wow-spellbook-frame')!;
  const socialFrame = ingameHud.querySelector<HTMLElement>('#wow-social-frame')!;
  const characterNativeCanvas = ingameHud.querySelector<HTMLCanvasElement>('.wow-character-native-background')!;
  const characterFrameCanvas = new CharacterFrameCanvasRenderer(characterNativeCanvas);
  const microSpellbook = ingameHud.querySelector<HTMLButtonElement>('.wow-micro-button--spellbook')!;
  const microSocial = ingameHud.querySelector<HTMLButtonElement>('.wow-micro-button--socials')!;

  let characterOpen = false;
  let currentCharTab: CharTab = 'character';
  const draggedFramePositions = new Map<string, { left: number; top: number }>();
  let lastInventory: InventorySnapshot | undefined;
  let lastSkills: SkillSnapshot | undefined;
  let lastHonor: HonorSnapshot | undefined;
  let lastReputation: ReputationSnapshot | undefined;
  let lastPet: PetSnapshot | undefined;
  let questLogController: QuestLogController | undefined;
  let npcInteraction: NpcInteractionController | undefined;
  let deathPhase: 'alive' | 'dead' | 'ghost' = 'alive';
  let corpseReclaimAvailableAt = 0;
  let corpseLocation: Extract<DeathEvent, { kind: 'corpseLocation'; found: true }> | undefined;
  let pendingResurrect: Extract<DeathEvent, { kind: 'resurrectRequest' }> | undefined;
  let lastDeathUiSignature = '';
  let itemDisplayIcons: Record<string, string> = {};
  void fetch('/items/item-display-icons.json')
    .then((r) => (r.ok ? r.json() : {}))
    .then((data) => { itemDisplayIcons = data; renderInventory(lastInventory); npcInteraction?.rerender(); })
    .catch(() => {});

  const {
    escapeHtml,
    formatMoney,
    itemIconMarkup,
    itemIconStyle,
    itemIconUrl,
    itemLabel,
    itemName,
    itemTooltipText,
    renderSmallMoneyFrame,
    slotTooltipText,
  } = createItemUiHelpers({
    getItemInfo: (entry) => activeWorld?.getItemInfo(entry),
    getItemIconName: (displayInfoId) => itemDisplayIcons[String(displayInfoId)],
  });

  const portraitRaceName = (race: number) => ({
    1: 'Human',
    2: 'Orc',
    3: 'Dwarf',
    4: 'NightElf',
    5: 'Scourge',
    6: 'Tauren',
    7: 'Gnome',
    8: 'Troll',
  })[race] ?? 'Human';

  const UNIT_DYNFLAG_TAPPED = 0x0004; // vMaNGOS UnitDynFlags: tapped (claimed) by someone
  const UNIT_DYNFLAG_TAPPED_BY_PLAYER = 0x0008; // tapped by the local player specifically

  let refreshMainMenuCanvas = () => {};
  let refreshBagCanvasViews = () => {};
  let syncCharacterCanvas = (_snapshot?: InventorySnapshot) => {};
  let inventoryInteractions!: InventoryInteractionController;
  const inventoryCursor = new InventoryCursorController({
    ingameHud,
    worldCanvas: renderer.domElement,
    actionBar,
    backpackButton,
    bagSlotButtons,
    getInventory: () => lastInventory ?? activeWorld?.getInventory(),
    getItemInfo: (entry) => activeWorld?.getItemInfo(entry),
    findInventorySlot: (ref) => inventoryInteractions.findInventorySlot(ref),
    isBagContainerItem: (item, info, ref) => inventoryInteractions.isBagContainerItem(item, info, ref),
    canPlaceItemOnActionButton: (item, info, ref, forcedBag) => inventoryInteractions.canPlaceItemOnActionButton(item, info, ref, forcedBag),
    onChange: () => {
      refreshMainMenuCanvas();
      refreshBagCanvasViews();
      syncCharacterCanvas(lastInventory);
    },
  });

  inventoryInteractions = new InventoryInteractionController({
    cursor: inventoryCursor,
    getWorld: () => activeWorld ?? undefined,
    getInventory: () => lastInventory ?? activeWorld?.getInventory(),
    getActiveMerchantGuid: () => npcInteraction?.activeMerchantGuid(), repairMerchantItem: (itemGuid) => npcInteraction?.repairInventoryItem(itemGuid) ?? false,
    useInventoryItem: (slot) => actionCombat?.useInventoryItem(slot) ?? false,
    itemIconUrl,
    log,
    playUi: (name) => soundManager.playUi(name),
  });

  const findInventorySlot = inventoryInteractions.findInventorySlot.bind(inventoryInteractions);
  const findFirstItemByEntry = inventoryInteractions.findFirstItemByEntry.bind(inventoryInteractions);
  const isBagContainerItem = inventoryInteractions.isBagContainerItem;
  const canPlaceItemOnActionButton = inventoryInteractions.canPlaceItemOnActionButton;
  const getUnitPortraitSource = (() => {
    let portrait: LiveUnitPortrait | undefined;
    const detachedHost = document.createElement('div');
    return (guid: string) => {
      const model = entityRenderer?.portraitModel(guid);
      if (!model) return undefined;
      portrait ??= new LiveUnitPortrait(detachedHost, 'player');
      return portrait.render(model) ? portrait.canvas : undefined;
    };
  })();
  const mailPanel = new MailCanvasPanel(mailHost, {
    closeMailbox: () => activeWorld?.closeMailbox(),
    sendMail: (params) => activeWorld?.sendMail(params),
    takeMoney: (id) => activeWorld?.mailTakeMoney(id),
    takeItem: (id) => activeWorld?.mailTakeItem(id),
    markRead: (id) => activeWorld?.mailMarkRead(id),
    returnMail: (id) => activeWorld?.mailReturn(id),
    deleteMail: (id) => activeWorld?.mailDelete(id),
    queryBody: (id, textId) => activeWorld?.queryMailBody(id, textId),
    senderName: (guid, entry) => guid ? activeWorld?.getPlayerName(guid)?.name ?? 'Unknown' : entry ? `Sender ${entry}` : 'Unknown',
    getItemInfo: (entry) => activeWorld?.getItemInfo(entry),
    itemIconUrl,
    heldItem: () => inventoryCursor.heldCursor?.kind === 'item' ? inventoryCursor.heldCursor : undefined,
    clearHeld: () => inventoryCursor.clearHeldCursor(),
    playUi: (name) => soundManager.playUi(name),
  });
  const auctionPanel = new AuctionCanvasPanel(auctionHost, {
    playUi: (name) => { soundManager.playUi(name); },
    getItemInfo: (entry) => activeWorld?.getItemInfo(entry),
    itemIconUrl,
    getPlayerMoney: () => (lastInventory ?? activeWorld?.getInventory())?.money ?? 0,
    getPlayerName: (guid) => activeWorld?.getPlayerName(guid)?.name,
    getUnitPortraitSource,
    heldItem: () => {
      const held = inventoryCursor.heldCursor;
      // CMSG_AUCTION_SELL_ITEM addresses the item by its object GUID, so a cursor entry without
      // one (a synthetic/preview item) cannot be auctioned.
      return held?.kind === 'item' && held.guid
        ? { itemGuid: held.guid, entry: held.entry, count: held.count }
        : undefined;
    },
    clearHeld: () => inventoryCursor.clearHeldCursor(),
    search: (filters) => activeWorld?.auctionListItems({
      name: filters.name,
      minLevel: filters.minLevel,
      maxLevel: filters.maxLevel,
      usableOnly: filters.usableOnly,
      itemClass: filters.itemClass,
      itemSubClass: filters.itemSubClass,
      page: filters.page,
    }),
    listOwn: (page) => activeWorld?.auctionListOwnerItems(page),
    listBids: (page) => activeWorld?.auctionListBidderItems(page),
    placeBid: (auctionId, price) => activeWorld?.auctionPlaceBid(auctionId, price),
    cancelAuction: (auctionId) => activeWorld?.auctionRemoveItem(auctionId),
    sellItem: (itemGuid, bid, buyout, minutes) => activeWorld?.auctionSellItem(itemGuid, bid, buyout, minutes),
    onClose: () => activeWorld?.closeAuctionHouse(),
  });
  const guildRegistrarPanel = new GuildRegistrarCanvasPanel(guildRegistrarHost, {
    playUi: (name) => { soundManager.playUi(name); },
    // `unitNameByGuid` is declared further down this file, so calling it lazily keeps the panel
    // out of its temporal dead zone.
    getUnitName: (guid) => unitNameByGuid(guid),
    getUnitPortraitSource,
    getPlayerMoney: () => (lastInventory ?? activeWorld?.getInventory())?.money ?? 0,
    buyCharter: (npcGuid, name, index) => activeWorld?.petitionBuy(npcGuid, name, index),
    onClose: () => activeWorld?.closePetition(),
  });
  const petitionPanel = new PetitionCanvasPanel(petitionHost, {
    playUi: (name) => { soundManager.playUi(name); },
    getPlayerName: (guid) => activeWorld?.getPlayerName(guid)?.name,
    getPlayerGuid: () => playerGuid ?? currentCharacter?.guid,
    sign: (itemGuid) => activeWorld?.petitionSign(itemGuid),
    decline: (itemGuid) => activeWorld?.petitionDecline(itemGuid),
    turnIn: (itemGuid) => activeWorld?.petitionTurnIn(itemGuid),
    rename: (itemGuid, name) => activeWorld?.petitionRename(itemGuid, name),
    onClose: () => activeWorld?.closePetition(),
  });
  const petStablePanel = new PetStableCanvasPanel(petStableHost, {
    playUi: (name) => { soundManager.playUi(name); },
    getUnitPortraitSource,
    creatureIconUrl: () => undefined,
    getPlayerMoney: () => (lastInventory ?? activeWorld?.getInventory())?.money ?? 0,
    stableCurrentPet: () => activeWorld?.stableCurrentPet(),
    unstablePet: (petNumber) => activeWorld?.unstablePet(petNumber),
    swapPet: (petNumber) => activeWorld?.stableSwapPet(petNumber),
    buySlot: () => activeWorld?.buyStableSlot(),
    onClose: () => activeWorld?.closeStable(),
  });
  const pickupItemFromSlot = inventoryInteractions.pickupItemFromSlot.bind(inventoryInteractions);
  const pickupEquippedBag = inventoryInteractions.pickupEquippedBag.bind(inventoryInteractions);
  const activateInventorySlot = inventoryInteractions.activateInventorySlot.bind(inventoryInteractions);
  const dropHeldItemOnSlot = inventoryInteractions.dropHeldItemOnSlot.bind(inventoryInteractions);
  const dropHeldItemOnBagButton = inventoryInteractions.dropHeldItemOnBagButton.bind(inventoryInteractions);
  merchantFrame.addEventListener('pointerup', (event) => {
    if (event.button !== 0 || inventoryCursor.heldCursor?.kind !== 'item') return;
    const vendorGuid = npcInteraction?.activeMerchantGuid();
    if (!vendorGuid || !inventoryInteractions.sellHeldItemTo(vendorGuid)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });
  const handleInventorySlotAction = (slot: InventorySlot, button: number, modifiers: {
    shiftKey?: boolean; ctrlKey?: boolean; anchor?: StackSplitAnchor;
  } = {}) => {
    const vendorGuid = npcInteraction?.activeMerchantGuid();
    const intent = inventoryStackSplitIntent({
      container: slot.container, button,
      shiftKey: modifiers.shiftKey ?? false, ctrlKey: modifiers.ctrlKey ?? false,
      chatOpen: chatUi.isInputOpen(), merchantOpen: !!vendorGuid,
    });
    if (intent === 'chat-link') { chatUi.insertInputText(chatItemLink(slot)); return; }
    if (intent === 'suppress') return;
    if (intent === 'split') {
      if (!slot.item?.entry) return;
      stackSplitPanel.show(slot.item.count, (count) => pickupItemFromSlot(slot, count), modifiers.anchor);
      return;
    }
    if (intent === 'split-sell') {
      if (vendorGuid && slot.item?.entry) stackSplitPanel.show(slot.item.count,
        (count) => inventoryInteractions.sellSlotToVendor(vendorGuid, slot, count), modifiers.anchor);
      return;
    }
    if (button === 2) {
      stackSplitPanel.hide();
      if (
        !inventoryCursor.heldCursor
        && !vendorGuid
        && !actionCombat?.useInventoryItem(slot)
      ) activateInventorySlot(slot);
      else if (!inventoryCursor.heldCursor && vendorGuid) activateInventorySlot(slot);
      return;
    }
    if (button !== 0) return;
    stackSplitPanel.hide();
    if (actionCombat?.targetPendingInventoryItem(slot)) return;
    if (inventoryCursor.heldCursor?.kind === 'item') {
      dropHeldItemOnSlot(slot);
      return;
    }
    pickupItemFromSlot(slot);
  };
  let onBagFramesRendered = (_snapshot: InventorySnapshot | undefined, _visibleBagIds: readonly number[]) => {};

  const inventoryUi = new InventoryUiController({
    elements: {
      characterName,
      characterSubtitle,
      characterPortrait,
      paperdollSlots,
      characterStats,
      containerLayer,
      backpackButton,
      bagSlotButtons,
    },
    cursor: inventoryCursor,
    getInventory: () => lastInventory ?? activeWorld?.getInventory(),
    getCurrentCharacter: () => currentCharacter,
    getPlayerEntity: currentPlayerEntity,
    getDraggedFramePosition: (frameId) => draggedFramePositions.get(frameId),
    setLastInventory: (snapshot) => { lastInventory = snapshot; },
    escapeHtml,
    itemIconStyle,
    itemName,
    portraitRaceName,
    raceName: (race) => RACES[race] ?? `Race ${race}`,
    className: (classId) => CLASSES[classId] ?? `Class ${classId}`,
    renderSmallMoneyFrame,
    slotTooltipText,
    onBagFramesRendered: (snapshot, visibleBagIds) => onBagFramesRendered(snapshot, visibleBagIds),
  });

  const chatUi = new ChatUiController({
    elements: {
      chatBox,
      chatMessages,
      chatInput,
    },
    getWorld: () => activeWorld ?? undefined,
    getCurrentCharacter: () => currentCharacter,
    getPlayerGuid: () => playerGuid,
    getSelectedTargetGuid: () => selectedTargetGuid,
    // GetSlashCmdTarget only falls back to the target when UnitIsPlayer("target"); getPlayerName
    // resolves players only, so an NPC selection correctly yields nothing.
    getSelectedTargetName: () => (selectedTargetGuid ? activeWorld?.getPlayerName(selectedTargetGuid)?.name : undefined),
  });

  const wmoSightStart = new THREE.Vector3();
  const isWorldPointBlockedByWmo = (target: THREE.Vector3) => {
    camera.getWorldPosition(wmoSightStart);
    return worldCollision.isWmoSegmentOccluded(wmoSightStart, target);
  };

  // Speech bubbles sit above whatever head the unit-name layer is already tracking: the
  // animated-model centroid for yourself (the equipment-inclusive Box3 floats too high), and
  // the renderer's head-height point for everyone else.
  const chatBubbles = new ChatBubbleLayer({
    camera,
    overheadPositionOf: (guid) => {
      if (guid === playerGuid) {
        const head = playerGetHeadCentroid?.();
        if (!head || !playerModelGroup) return { x: charPos.x, y: charPos.y, z: charPos.z + 2.2 };
        playerOverheadPoint.set(head.x, head.y, head.z);
        playerModelGroup.updateWorldMatrix(true, false);
        playerModelGroup.localToWorld(playerOverheadPoint);
        return playerOverheadPoint;
      }
      return entityRenderer?.localPositionOf(guid) ?? undefined;
    },
  });

  const unitFrames = new UnitFrameController({
    elements: {
      playerFrame,
      pfName,
      pfLevel,
      pfHp,
      pfHpText,
      pfPower,
      pfPowerText,
      pfPvp,
      targetFrame,
      tfName,
      tfLevel,
      tfHp,
      tfHpText,
      tfPower,
      tfPowerText,
      tfPvp,
      tfSkull,
      tfArt,
      totFrame,
    },
    camera,
    getEntityRenderer: () => entityRenderer,
    // GROUPTYPE_RAID (vMaNGOS Group.h:119) drives the "In Raids" Target-of-Target mode.
    isInRaid: () => (activeWorld?.getSocial().groupType ?? 0) === 1,
    getWorld: () => activeWorld ?? undefined,
    getPlayerGuid: () => playerGuid,
    getPlayerModelGroup: () => playerModelGroup ?? undefined,
    getPlayerOverheadPosition: () => {
      const head = playerGetHeadCentroid?.();
      if (!head || !playerModelGroup) return undefined;
      playerOverheadPoint.set(head.x, head.y, head.z);
      playerModelGroup.updateWorldMatrix(true, false);
      playerModelGroup.localToWorld(playerOverheadPoint);
      return playerOverheadPoint;
    },
    getCurrentCharacter: () => currentCharacter,
    getPlayerEntity: currentPlayerEntity,
    getSelectedTargetGuid: () => selectedTargetGuid,
    getPlayerLocalPosition: () => movement.charPos,
    isNameplateBlockedByWmo: isWorldPointBlockedByWmo,
    applyPvpBadge,
    escapeHtml,
    raceName: (race) => RACES[race] ?? `Race ${race}`,
    className: (classId) => CLASSES[classId] ?? `Class ${classId}`,
    targetNameBg: TARGET_NAME_BG,
    tappedNameBg: TAPPED_NAME_BG,
    targetFrameArt: TARGET_FRAME_ART,
    eliteFrameArt: ELITE_FRAME_ART, playUi: (name) => soundManager.playUi(name),
    startWhisper: (name) => chatUi.openInput(`/w ${name} `),
  });
  unitFrames.playerPortraitSource(false)?.addEventListener('portrait-rendered', () => { syncCharacterCanvas(lastInventory); refreshMainMenuCanvas(); mainMenuCanvas.requestRender(); });
  let spellbook: SpellbookController | undefined;
  let socialFrameController: SocialFrameController | undefined;
  let worldAudio!: WorldAudioController;
  const pickupActionButton = (slot: number, bar?: MultiBarId) => actionCombat.pickupActionButton(slot, bar);
  const placeHeldOnActionButton = (slot: number, bar?: MultiBarId) => actionCombat.placeHeldOnActionButton(slot, bar);
  const useItemAction = (entry: number) => actionCombat.useItemAction(entry);

  const setInteractionOpen = (open: boolean) => {
    interactionPanel.classList.toggle('is-hidden', !open);
  };

  const renderCharacterFrame = (snapshot = activeWorld?.getInventory()) => {
    inventoryUi.renderCharacterFrame(snapshot);
    syncCharacterCanvas(snapshot);
  };
  let onCharacterTabRequested: (tab: CharTab) => void = () => {};

  const characterTabs = new CharacterTabsController({
    characterFrame,
    characterTabButtons,
    charPages,
    getWorld: () => activeWorld ?? undefined,
    getCurrentCharacter: () => currentCharacter,
    getPet: () => lastPet ?? activeWorld?.getPet(),
    getReputation: () => lastReputation ?? activeWorld?.getReputation(),
    getSkills: () => lastSkills ?? activeWorld?.getSkills(),
    getHonor: () => lastHonor ?? activeWorld?.getHonor(),
    escapeHtml,
    onTabRequested: (tab) => onCharacterTabRequested(tab),
  });

  const characterCanvasView = (snapshot = lastInventory ?? activeWorld?.getInventory()): CharacterFrameCanvasViewModel => {
    const character = currentCharacter;
    const entity = playerEntity;
    const stat = (value?: number) => value === undefined ? '-' : String(value);
    const damage = (low?: number, high?: number) => low === undefined || high === undefined
      ? 'N/A'
      : `${Math.round(low)} - ${Math.round(high)}`;
    return {
      title: character?.name ?? 'Character',
      subtitle: character
        ? `Level ${entity?.level ?? character.level} ${RACES[character.race] ?? `Race ${character.race}`} ${CLASSES[character.classId] ?? `Class ${character.classId}`}`
        : '',
      livePortraitCanvas: unitFrames.playerPortraitSource(),
      portraitUrl: character
        ? `/ui/Interface/CharacterFrame/TemporaryPortrait-${character.gender === 1 ? 'Female' : 'Male'}-${portraitRaceName(character.race)}.png`
        : undefined,
      equipment: CHARACTER_EQUIPMENT_LAYOUT.map((layout) => {
        if (layout.inventoryIndex === undefined) {
          // Vanilla ammo is not part of InventorySnapshot.equipment. The legacy fake
          // slot aliased Head (255:0), so it must stay display-only until modeled.
          return { id: layout.id, label: layout.label, disabled: true, tooltip: layout.label };
        }
        const inventorySlot = snapshot?.equipment.find((slot) => slot.index === layout.inventoryIndex)
          ?? snapshot?.equipment[layout.inventoryIndex];
        const item = inventorySlot?.item;
        return {
          id: layout.id,
          label: layout.label,
          iconUrl: item ? itemIconUrl(item.info?.displayInfoId, item.entry) || undefined : undefined,
          count: item?.count,
          quality: item?.info?.quality,
          durability: item?.durability,
          maxDurability: item?.maxDurability,
          tooltip: inventorySlot ? slotTooltipText(inventorySlot) : layout.label,
          data: inventorySlot,
        };
      }),
      statColumns: [[
        { label: 'Strength', value: stat(entity?.strength) },
        { label: 'Agility', value: stat(entity?.agility) },
        { label: 'Stamina', value: stat(entity?.stamina) },
        { label: 'Intellect', value: stat(entity?.intellect) },
        { label: 'Spirit', value: stat(entity?.spirit) },
        { label: 'Armor', value: stat(entity?.armor) },
      ], [
        { label: 'Melee Attack', value: '-' },
        { label: 'Power', value: stat(entity?.attackPower) },
        { label: 'Damage', value: damage(entity?.minDamage, entity?.maxDamage) },
        { label: 'Ranged Attack', value: entity?.rangedAttackPower ? '-' : 'N/A' },
        { label: 'Power', value: entity?.rangedAttackPower ? stat(entity.rangedAttackPower) : 'N/A' },
        { label: 'Damage', value: entity?.rangedAttackPower ? damage(entity.minRangedDamage, entity.maxRangedDamage) : 'N/A' },
      ]],
      pages: characterTabs.getCanvasPages(),
      disabledTabs: lastPet?.guid ? [] : ['pet'],
    };
  };

  syncCharacterCanvas = (snapshot = lastInventory ?? activeWorld?.getInventory()) => {
    characterFrameCanvas.render(currentCharTab, characterCanvasView(snapshot));
  };

  const setCharTab = (tab: CharTab) => {
    if (tab !== currentCharTab && characterOpen) soundManager.playUi('CHARACTERINFOTAB');
    currentCharTab = tab;
    characterTabs.setTab(tab);
    syncCharacterCanvas(lastInventory);
  };
  onCharacterTabRequested = setCharTab;

  const setCharacterOpen = (open: boolean) => {
    const changed = characterOpen !== open;
    characterOpen = open;
    characterFrame.classList.toggle('is-hidden', !open);
    microCharacter.classList.toggle('is-open', open);
    if (open) {
      setCharTab(currentCharTab);
      renderCharacterFrame(lastInventory ?? activeWorld?.getInventory());
      characterTabs.renderPet();
      characterTabs.renderReputation();
      ensurePaperdoll();
    }
    refreshMainMenuCanvas();
    if (changed) soundManager.playUi(open ? 'CHARACTERINFOOPEN' : 'CHARACTERINFOCLOSE');
  };

  characterFrame.classList.add('has-canvas-ui');
  characterFrameCanvas.setCallbacks({
    onClose: () => setCharacterOpen(false),
    onTabChange: setCharTab,
    onRotate: rotatePaperdoll,
    onSlotClick: (slot, event) => {
      const inventorySlot = slot.data as InventorySlot | undefined;
      if (inventorySlot) handleInventorySlotAction(inventorySlot, event.button, { shiftKey: event.shiftKey, ctrlKey: event.ctrlKey });
    },
    onSlotHover: (slot, point) => {
      const tooltip = getGameTooltip();
      if (!slot) {
        tooltip.hide();
        return;
      }
      const rect = characterNativeCanvas.getBoundingClientRect();
      const clientX = rect.left + point.x * rect.width / 384;
      const clientY = rect.top + point.y * rect.height / 512;
      const inventorySlot = slot.data as InventorySlot | undefined;
      const item = inventorySlot?.item;
      tooltip.show(item?.entry
        ? [...itemTooltipLines(item.info, item.entry, {
            count: item.count,
            durability: item.durability,
            maxDurability: item.maxDurability,
            durationSeconds: item.durationSeconds,
            enchantments: item.enchantments,
          }), ...equippedComparisonLines(item.info, lastInventory ?? activeWorld?.getInventory())]
        : textTooltipLines(slot.label ?? 'Equipment'), clientX, clientY);
    },
  });

  const bagButtonForId = (bagId: number) => (bagId === 0 ? backpackButton : bagSlotButtons[bagId - 1]);

  const setBagOpen = (bagId: number, open: boolean, playSound = true) => {
    const wasOpen = inventoryUi.isBagOpen(bagId);
    inventoryUi.setBagOpen(bagId, open);
    const isOpen = inventoryUi.isBagOpen(bagId);
    if (playSound && wasOpen !== isOpen) soundManager.playUi(isOpen ? 'igBackpackOpen' : 'igBackpackClose');
    refreshMainMenuCanvas();
  };

  const toggleBag = (bagId: number) => setBagOpen(bagId, !inventoryUi.isBagOpen(bagId));

  const setAllBagsOpen = (open: boolean) => {
    const wasAnyOpen = [backpackButton, ...bagSlotButtons].some((button) => button.classList.contains('is-open'));
    inventoryUi.setAllBagsOpen(open);
    const isAnyOpen = [backpackButton, ...bagSlotButtons].some((button) => button.classList.contains('is-open'));
    if (wasAnyOpen !== isAnyOpen) soundManager.playUi(isAnyOpen ? 'igBackpackOpen' : 'igBackpackClose');
    refreshMainMenuCanvas();
  };

  /** One semantic backpack action shared by the B/Shift-B keybinds and the clickable bag UI. */
  const toggleBackpack = (allBags: boolean) => {
    if (!allBags) {
      // Vanilla B closes every open container when the backpack is already open.
      if (inventoryUi.isBagOpen(0)) setAllBagsOpen(false);
      else setBagOpen(0, true);
      return;
    }
    const available = (lastInventory ?? activeWorld?.getInventory())?.bags
      .filter((bag) => bag.isBackpack || !!bag.itemGuid) ?? [];
    setAllBagsOpen(!available.length || !available.every((bag) => inventoryUi.isBagOpen(bag.index)));
  };

  const keyringDiscovery = new KeyringDiscoveryState(window.localStorage);
  const inventoryCanvas = new InventoryContainerCanvasBridge({
    containerLayer, ingameHud, draggedFramePositions,
    getSnapshot: () => lastInventory ?? activeWorld?.getInventory(), itemIconUrl,
    itemTooltip: (slot) => [...itemTooltipLines(slot.item?.info, slot.item?.entry ?? 0, {
      count: slot.item?.count, durability: slot.item?.durability, maxDurability: slot.item?.maxDurability,
      durationSeconds: slot.item?.durationSeconds, enchantments: slot.item?.enchantments, sellPrice: itemToolsSellPriceEnabled(),
    }), ...equippedComparisonLines(slot.item?.info, lastInventory ?? activeWorld?.getInventory())],
    bagTooltip: (bag) => bag.item?.entry ? itemTooltipLines(bag.item.info, bag.item.entry, {
      count: bag.item.count, durationSeconds: bag.item.durationSeconds, enchantments: bag.item.enchantments,
    }) : textTooltipLines(bag.isKeyring ? 'Keyring' : bag.isBackpack ? 'Backpack' : bag.label),
    emptyTooltip: (slot, index) => textTooltipLines(slot?.label ?? `Slot ${index + 1}`),
    heldSourceMatches: (slot) => inventoryCursor.heldSourceMatches(slot),
    onSlotAction: (slot, button, action) => handleInventorySlotAction(slot, button, action),
    onClose: (id) => setBagOpen(id, false),
    onPortraitActivate: (id) => { if (id > 0 && !inventoryCursor.heldCursor) pickupEquippedBag(id); },
    playUi: (name) => soundManager.playUi(name),
  });
  refreshBagCanvasViews = () => inventoryCanvas.refresh();
  onBagFramesRendered = (snapshot, visibleBagIds) => inventoryCanvas.render(snapshot, visibleBagIds);

  const activateKeyringButton = () => {
    const snapshot = lastInventory ?? activeWorld?.getInventory();
    if (!snapshot) return;
    if (inventoryCursor.heldCursor?.kind === 'item') {
      const target = firstEmptyKeyringSlot(snapshot, inventoryCursor.heldCursor.source);
      if (!target) { showUiError('Your keyring is full.'); return; }
      dropHeldItemOnSlot(target);
    } else toggleBag(KEYRING_CONTAINER_ID);
    refreshMainMenuCanvas();
  };

  const renderInventory = (snapshot = activeWorld?.getInventory()) => {
    keyringDiscovery.observe(snapshot);
    inventoryUi.render(snapshot);
    refreshMainMenuCanvas();
    syncCharacterCanvas(snapshot);
  };

  // Quest text uses Vanilla escape tokens: $B/$b line break, $N name, $C class,
  // $R race, $Gmale:female; gender. Canvas panels consume the plain text with
  // real newlines — no HTML escaping in the pixel-space pipeline.
  const formatQuestText = (text: string): string => {
    const female = currentCharacter?.gender === 1;
    return text
      .replace(/\$[Gg]\s*([^:]*):([^;]*);/g, (_m, m, f) => (female ? f : m).trim())
      .replace(/\$[Bb]/g, '\n')
      .replace(/\$[Nn]/g, currentCharacter?.name ?? '')
      .replace(/\$[Cc]/g, currentCharacter ? CLASSES[currentCharacter.classId] ?? '' : '')
      .replace(/\$[Rr]/g, currentCharacter ? RACES[currentCharacter.race] ?? '' : '');
  };

  // Resolve a unit's display name for panel headers (players via name cache,
  // creatures via their template name).
  const unitNameByGuid = (guid: string): string | undefined => {
    if (guid === (playerGuid ?? currentCharacter?.guid) && currentCharacter?.name) return currentCharacter.name;
    if (!activeWorld) return undefined;
    const player = activeWorld.getPlayerName(guid)?.name;
    if (player) return player;
    const groupMember = activeWorld.getSocial().group.find((member) => member.guid === guid);
    if (groupMember?.name) return groupMember.name;
    const entity = guid === playerGuid ? playerEntity : entityRenderer?.inspect(guid)?.entity;
    return entity?.entry !== undefined ? activeWorld.getCreatureName(entity.entry)?.name : undefined;
  };

  // Vanilla's Combat Log: a second, locked, tabless scrollback pane (ChatFrame2) fed by the same
  // packets the floating combat text already consumes.
  const combatLog = new CombatLogController({
    resolveName: unitNameByGuid,
    resolveSpellName: (spellId) => actionCombat?.getSpellName(spellId),
    getPlayerGuid: () => playerGuid,
    playUi: (name) => soundManager.playUi(name),
  });

  const spellIconUrl = (spellId: number): string | undefined => {
    const meta = actionCombat?.getSpellMetaEntry(spellId);
    return meta?.[2] ? `/spells/icons/${meta[2]}.png` : undefined;
  };

  const partyHud = new PartyHudCanvas(ingameHud.querySelector<HTMLElement>('#wow-party-hud')!);
  const readyCheck = new ReadyCheckController(ingameHud, {
    getWorld: () => activeWorld ?? undefined, getPlayerGuid: () => playerGuid ?? currentCharacter?.guid,
    getPlayerInfo: (guid) => guid === (playerGuid ?? currentCharacter?.guid) ? currentCharacter : activeWorld?.getPlayerName(guid), systemMessage: (message) => chatUi.system(message),
    playUi: (name) => soundManager.playUi(name),
  });
  const petHud = new PetHudCanvas(
    ingameHud.querySelector<HTMLElement>('#wow-pet-hud')!,
    ingameHud.querySelector<HTMLElement>('#wow-pet-action-bar')!,
    {
      spellIcon: spellIconUrl,
      action: (petGuid, action, activeState) => activeWorld?.petAction(petGuid, action, activeState, selectedTargetGuid),
      autocast: (petGuid, spellId, enabled) => activeWorld?.petSpellAutocast(petGuid, spellId, enabled),
    },
  );
  const lootRolls = new LootRollCanvas(ingameHud.querySelector<HTMLElement>('#wow-loot-rolls')!, {
    itemIconUrl: (entry) => itemIconUrl(activeWorld?.getItemInfo(entry)?.displayInfoId, entry),
    itemName: (entry) => activeWorld?.getItemInfo(entry)?.name ?? `Item #${entry}`,
    vote: (lootGuid, itemSlot, vote) => activeWorld?.lootRoll(lootGuid, itemSlot, vote),
    announce: (message) => showUiError(message),
  });
  const masterLootPanel = new MasterLootCanvasPanel(ingameHud.querySelector<HTMLElement>('#wow-master-loot-frame')!, {
    playUi: (name) => soundManager.playUi(name),
    playerName: (guid) => activeWorld?.getPlayerName(guid)?.name ?? (guid === playerGuid ? currentCharacter?.name : undefined) ?? `Player-${guid.slice(-4)}`,
    itemName: (entry) => activeWorld?.getItemInfo(entry)?.name ?? `Item #${entry}`,
    assign: (lootGuid, itemSlot, playerGuid) => activeWorld?.masterLootGive(lootGuid, itemSlot, playerGuid),
  });

  const questWatchPanel = new QuestWatchCanvasPanel(questWatch, questProgress, {
    characterKey: () => currentCharacter?.guid,
    playerLevel: () => playerEntity?.level ?? currentCharacter?.level ?? 1,
    itemName: (entry) => activeWorld?.getItemInfo(entry)?.name,
    creatureName: (entry) => activeWorld?.getCreatureName(entry)?.name,
    playUi: (name) => soundManager.playUi(name),
    announceError: showUiError,
  });

  questLogController = new QuestLogController({
    frame: questLogFrame,
    microButton: microQuest,
    getWorld: () => activeWorld ?? undefined,
    getCurrentCharacter: () => currentCharacter,
    getPlayerLevel: () => playerEntity?.level,
    getAreaName: (areaId) => areaNames[areaId],
    getCurrentAreaName: () => areaNames[hudAreaId],
    questText: formatQuestText,
    getItemInfo: (entry) => activeWorld?.getItemInfo(entry),
    itemIconUrl,
    getItemName: (entry) => activeWorld?.getItemInfo(entry)?.name,
    confirmAbandon: (message, onConfirm) => npcInteraction?.confirm(message, onConfirm),
    playUi: (name) => soundManager.playUi(name),
    onToggleWatch: (entry) => questWatchPanel.toggle(entry),
  });

  npcInteraction = new NpcInteractionController({
    hosts: {
      gossipFrame,
      questFrame,
      merchantFrame,
      trainerFrame,
      taxiFrame,
      lootFrame,
      interactionPanel,
    },
    getWorld: () => activeWorld ?? undefined,
    getItemInfo: (entry) => activeWorld?.getItemInfo(entry),
    itemIconUrl,
    getItemName: (entry) => activeWorld?.getItemInfo(entry)?.name,
    getSpellName: (spellId) => actionCombat?.getSpellName(spellId) ?? `Spell #${spellId}`,
    getSpellIconUrl: spellIconUrl,
    getUnitName: unitNameByGuid,
    getUnitPortraitSource,
    getPlayerMoney: () => (lastInventory ?? activeWorld?.getInventory())?.money ?? 0, requestStackSplit: (max, onSplit, anchor) => stackSplitPanel.show(max, onSplit, anchor),
    questText: formatQuestText,
    playUi: (name) => soundManager.playUi(name),
    junkCount: () => junkInventorySlots(lastInventory ?? activeWorld?.getInventory()).length,
    sellJunk: (vendorGuid) => junkInventorySlots(lastInventory ?? activeWorld?.getInventory())
      .forEach((slot) => inventoryInteractions.sellSlotToVendor(vendorGuid, slot)),
    masterLootItem: (lootGuid, slot, entry) => {
      const eligible = activeWorld?.getMasterLootEligible() ?? [];
      if (!eligible.length) {
        showUiError('No eligible group members are in range.');
        return;
      }
      masterLootPanel.show(lootGuid, slot, entry, eligible);
    },
  });
  const worldNotices = new WorldNoticeController({
    areaName: (id) => areaNames[id], systemMessage: (text) => chatUi.system(text),
    queueSpiritHeal: (guid) => activeWorld?.queueAreaSpiritHeal(guid), cancelAuraSpell: (id) => activeWorld?.cancelAuraSpell(id),
    queryPlayerName: (guid) => activeWorld?.queryPlayerName(guid), playerName: (guid) => activeWorld?.getPlayerName(guid)?.name,
    acceptSummon: (guid) => activeWorld?.acceptSummon(guid), inCombat: () => ((playerEntity?.unitFlags ?? 0) & 0x00080000) !== 0,
    showAction: (text, label, action) => npcInteraction?.forceAction(text, label, action), showNotice: (text) => npcInteraction?.forceNotice(text),
    showConfirm: (text, accept, decline, disabled) => npcInteraction?.forceConfirm(text, accept, decline, 'Accept', 'Cancel', disabled), uiError: showUiError,
    updateActionMessage: (text) => npcInteraction?.setPopupMessage(text), setActionDisabled: (disabled) => npcInteraction?.setPopupPrimaryDisabled(disabled), hideAction: () => npcInteraction?.hidePopup(),
  });

  // Optional, more-faithful ghost filter, injected once and ready to enable. The active spirit-world
  // tint lives in the .wow-ghost-world CSS (filter functions, reliably GPU-composited). This
  // feColorMatrix is the exact reverse-backed version: BT.601 luminance (captured ARB shader 0022 =
  // 0.299/0.587/0.114) folded with a blue gradient — white -> pale cyan (~0.60,0.80,1.0), black ->
  // deep navy (~0.03,0.06,0.15). To use it, point .wow-ghost-world at `url(#wow-ghost-filter)`.
  if (!document.getElementById('wow-ghost-filter-svg')) {
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.id = 'wow-ghost-filter-svg';
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.position = 'absolute';
    const filter = document.createElementNS(svgNs, 'filter');
    filter.id = 'wow-ghost-filter';
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    const matrix = document.createElementNS(svgNs, 'feColorMatrix');
    matrix.setAttribute('type', 'matrix');
    matrix.setAttribute('values', [
      0.170, 0.335, 0.065, 0, 0.03,
      0.221, 0.434, 0.084, 0, 0.06,
      0.254, 0.499, 0.097, 0, 0.15,
      0, 0, 0, 1, 0,
    ].join(' '));
    filter.appendChild(matrix);
    svg.appendChild(filter);
    document.body.appendChild(svg);
  }
  // Fade the local player's own model to an ethereal ghost. The world CSS filter already blues +
  // desaturates the whole canvas (body included); this adds the see-through translucency so the
  // player reads as a spirit rather than a solid, tinted character. (Night-elf wisp swap and remote
  // ghosts are separate follow-ups — this covers the local player, which is what the camera shows.)
  const setPlayerModelGhost = (enabled: boolean) =>
    modelOpacity.setLayer(playerGuid ?? currentCharacter?.guid, 'death-ghost', enabled ? 0.5 : 1, 0);
  const setGhostWorld = (enabled: boolean) => {
    // Vanilla desaturates the 3D world in ghost form while leaving FrameXML/UI
    // art in full color. The renderer canvas is separate from the HUD canvases.
    //
    // `ffxDeath` is the cvar that owns this full-screen effect ("ffx" = full-screen effects), and it
    // is disabled by the same `pixelShaders` dependency the options panel already models. With it
    // off the player is still a ghost — only the screen tint goes away.
    // Being a ghost and *tinting the screen* are two different things: the model translucency is
    // part of the death state, the full-screen wash is the effect ffxDeath owns. Only the wash is
    // gated, so switching the option off still leaves you visibly a ghost.
    ghostWorldRequested = enabled;
    spiritWorldLighting = enabled;
    const modelChanged = renderer.domElement.dataset.ghost !== String(enabled);
    renderer.domElement.dataset.ghost = String(enabled);
    if (modelChanged) setPlayerModelGhost(enabled);
    applyGhostWorldFilter();
    if (modelChanged && lastDeathDebugSig !== 'muted') console.info(`[death] ghost-world ${enabled ? 'ON' : 'off'}`);
  };

  const removePlayerCorpseRender = () => {
    const corpse = activeWorld?.getEntities().find(
      (entity) => entity.typeName === 'corpse' && entity.ownerGuid === playerGuid,
    );
    if (corpse) entityRenderer?.remove(corpse.guid);
  };

  // Death/ghost pipeline diagnostics. The whole ghost cluster (grayscale, ghost speed, corpse
  // minimap blip, corpse reclaim prompt) keys off PLAYER_FLAGS_GHOST (0x10) reaching playerEntity and
  // deathPhase becoming 'ghost'. Offsets/formats are all verified against vMaNGOS, so if the cluster
  // fails the answer is in the live wire values — capture them here rather than guessing.
  // Transitions log automatically (change-gated, low noise). __wowDeathState() dumps a full snapshot
  // on demand — run it while dead and again while a ghost at the graveyard.
  let lastDeathDebugSig = '';
  globalThis.__wowDeathDebug = (on = true) => {
    lastDeathDebugSig = on === false ? 'muted' : '';
    return `death debug ${on === false ? 'muted' : 'on'}`;
  };
  const describeCorpse = () => {
    const corpse = activeWorld?.getEntities().find((e) => e.typeName === 'corpse' && e.ownerGuid === playerGuid);
    if (!corpse) return { present: false };
    const here = localToWorld(charPos.x, charPos.y);
    const dist = corpse.x !== undefined && corpse.y !== undefined && here
      ? Math.hypot(corpse.x - here.x, corpse.y - here.y) : undefined;
    return { present: true, guid: corpse.guid, x: corpse.x, y: corpse.y, distance: dist };
  };
  const deathStateSnapshot = () => ({
    deathPhase,
    health: playerEntity?.health,
    maxHealth: playerEntity?.maxHealth,
    playerFlags: `0x${(playerEntity?.playerFlags ?? 0).toString(16).padStart(8, '0')}`,
    isGhostFlag: ((playerEntity?.playerFlags ?? 0) & 0x10) !== 0,
    visFlags: `0x${(playerEntity?.visFlags ?? 0).toString(16).padStart(2, '0')}`,
    isGhostVis: ((playerEntity?.visFlags ?? 0) & 0x01) !== 0,
    hasGhostAura: !!playerEntity?.auraSpellIds?.some((id) => id === 8326 || id === 20584),
    auras: playerEntity?.auraSpellIds?.filter((id) => id) ?? [],
    unitFlags: `0x${(playerEntity?.unitFlags ?? 0).toString(16).padStart(8, '0')}`,
    ghostWorldClass: renderer.domElement.classList.contains('wow-ghost-world'),
    corpseLocation,
    corpseEntity: describeCorpse(),
    currentMap,
  });
  globalThis.__wowDeathState = () => {
    const snap = deathStateSnapshot();
    console.info('[death] snapshot', snap);
    return snap;
  };
  const logDeathDebug = (entity: WorldEntity) => {
    if (lastDeathDebugSig === 'muted') return;
    const ghost = ((entity.playerFlags ?? 0) & 0x10) !== 0;
    const sig = `hp=${entity.health}/${entity.maxHealth} ghost=${ghost} `
      + `playerFlags=0x${(entity.playerFlags ?? 0).toString(16)} unitFlags=0x${(entity.unitFlags ?? 0).toString(16)} phase=${deathPhase}`;
    if (sig === lastDeathDebugSig) return;
    lastDeathDebugSig = sig;
    console.info(`[death] ${sig}`);
  };

  const teardownCombatState = (clearCooldowns = true) => {
    autoAttacking = false;
    playerActivelyEngaged = false;
    updateAttackIndicator();
    actionCombat?.teardownCombatState({ clearCooldowns });
    spellVisuals.stopAllCasterSounds();
    clearPlayerCombatAnim();
  };

  const syncDeathUi = () => {
    if (!npcInteraction || !activeWorld || !playerEntity || !playerGuid) return;
    // vMaNGOS ApplyGhostForm (Player.cpp) enters ghost form in ONE step: it casts the Ghost aura
    // (SPELL_GHOST 8326; night-elf wisp 20584, whose HandleAuraGhost sets PLAYER_FLAGS_GHOST) AND
    // relies on that flag. Accepting either signal makes the client robust to a dropped or late
    // PLAYER_FLAGS update — the aura and the flag are applied together and no living player has
    // either, so there are no false positives.
    const ghostFlag = ((playerEntity.playerFlags ?? 0) & 0x00000010) !== 0;
    const ghostVis = ((playerEntity.visFlags ?? 0) & 0x01) !== 0; // UNIT_VIS_FLAGS_GHOST — the client's own signal
    const ghostAura = !!playerEntity.auraSpellIds?.some((id) => id === 8326 || id === 20584);
    const isGhost = ghostFlag || ghostVis || ghostAura;
    const isDeadBody = !isGhost && (playerEntity.health ?? 1) === 0;

    if (!isGhost && !isDeadBody) {
      if (deathPhase !== 'alive' || pendingResurrect) {
        deathPhase = 'alive';
        pendingResurrect = undefined;
        corpseLocation = undefined;
        corpseReclaimAvailableAt = 0;
        lastDeathUiSignature = '';
        npcInteraction.hidePopup();
        setGhostWorld(false);
        movement.setInputLocked(false);
        // Resurrection consumes the corpse server-side (ConvertCorpseForPlayer). Drop the local
        // player's corpse render immediately so a stale placeholder never lingers at the death spot
        // if the destroy update is delayed or arrives while it is outside the streamed neighborhood.
        removePlayerCorpseRender();
      }
      return;
    }

    if (pendingResurrect) {
      const request = pendingResurrect;
      const remainingSeconds = request.useTimer
        ? Math.max(0, Math.ceil((corpseReclaimAvailableAt - Date.now()) / 1000))
        : 0;
      const resolvedName = request.resurrectorName || unitNameByGuid(request.resurrectorGuid) || 'Someone';
      const message = request.sickness
        ? `${resolvedName} wants to resurrect you.  You will be afflicted with resurrection sickness.`
        : remainingSeconds > 0
          ? `${resolvedName} wants to resurrect you and will be able to in ${remainingSeconds} seconds`
          : `${resolvedName} wants to resurrect you`;
      const signature = `resurrect:${request.resurrectorGuid}:${resolvedName}:${request.sickness}:${remainingSeconds}`;
      if (signature !== lastDeathUiSignature) {
        lastDeathUiSignature = signature;
        npcInteraction.forceConfirm(
          message,
          () => {
            activeWorld?.respondResurrect(request.resurrectorGuid, true);
            pendingResurrect = undefined;
            lastDeathUiSignature = '';
          },
          () => {
            activeWorld?.respondResurrect(request.resurrectorGuid, false);
            pendingResurrect = undefined;
            lastDeathUiSignature = '';
          },
          'Accept',
          'Decline',
          remainingSeconds > 0,
        );
      }
      return;
    }

    if (isDeadBody) {
      if (deathPhase !== 'dead') {
        deathPhase = 'dead';
        teardownCombatState();
        setTarget(undefined);
        setGhostWorld(false);
        // A corpse is rooted server-side (SetDeathState(JUST_DIED) -> SetRooted(true)); lock input
        // so the body cannot be walked around until the player releases and becomes a ghost.
        movement.setInputLocked(true);
        lastDeathUiSignature = 'release';
        npcInteraction.forceAction(
          'You have died. Release to the nearest graveyard?',
          'Release Spirit',
          () => activeWorld?.releaseSpirit(),
        );
      }
      return;
    }

    if (deathPhase !== 'ghost') {
      deathPhase = 'ghost';
      lastDeathUiSignature = '';
      npcInteraction.hidePopup();
      setGhostWorld(true);
      // Ghosts are un-rooted (BuildPlayerRepop -> SetRooted(false)) and run back to their corpse.
      movement.setInputLocked(false);
      activeWorld?.queryCorpse();
    }

    const corpse = activeWorld.getEntities().find((entity) => entity.typeName === 'corpse' && entity.ownerGuid === playerGuid);
    const playerWorld = localToWorld(charPos.x, charPos.y);
    const inRange = corpse?.x !== undefined && corpse.y !== undefined
      && Math.hypot(corpse.x - playerWorld.x, corpse.y - playerWorld.y) <= 39;
    if (!corpse || !inRange) {
      if (lastDeathUiSignature.startsWith('corpse:')) {
        npcInteraction.hidePopup();
        lastDeathUiSignature = '';
      }
      return;
    }

    const remainingSeconds = Math.max(0, Math.ceil((corpseReclaimAvailableAt - Date.now()) / 1000));
    const signature = `corpse:${corpse.guid}:${remainingSeconds}`;
    if (signature === lastDeathUiSignature) return;
    lastDeathUiSignature = signature;
    npcInteraction.forceAction(
      remainingSeconds > 0 ? `${remainingSeconds} seconds until resurrection` : 'Resurrect now?',
      'Accept',
      () => activeWorld?.reclaimCorpse(corpse.guid),
      remainingSeconds > 0,
    );
  };

  const bankPanel = new BankCanvasPanel(bankFrame, {
    playUi: (name) => soundManager.playUi(name),
    getItemInfo: (entry) => activeWorld?.getItemInfo(entry),
    itemIconUrl,
    getUnitPortraitSource,
    onPurchaseSlot: () => activeWorld?.buyBankSlot(),
    onClose: () => activeWorld?.closeBank(),
    onSlotClick: (kind, index) => {
      const world = activeWorld;
      const state = world?.getBankState();
      if (!world || !state) return;
      const protocolSlot = kind === 'slot' ? 39 + index : 63 + index;
      const held = inventoryCursor.heldCursor;
      if (held?.kind === 'item') {
        if (held.source.protocolBag === 255) world.swapInventoryItem(held.source.protocolSlot, protocolSlot);
        else world.swapItem(held.source.protocolBag, held.source.protocolSlot, 255, protocolSlot);
        inventoryCursor.clearHeldCursor();
        soundManager.playUi('CURSORDROPOBJECT');
        return;
      }
      const item = kind === 'slot' ? state.slots[index] : state.bags[index];
      if (!item?.entry) return;
      inventoryCursor.setHeldCursor({
        kind: 'item',
        source: { container: 'bank', index, protocolBag: 255, protocolSlot },
        guid: item.guid,
        entry: item.entry,
        count: item.count,
        isBag: kind === 'bag',
        name: world.getItemInfo(item.entry)?.name ?? `Item #${item.entry}`,
        iconUrl: itemIconUrl(item.displayInfoId, item.entry),
      });
      soundManager.playUi('CURSORGRABOBJECT');
    },
  });
  const tradePanel = new TradeCanvasPanel(tradeFrame, {
    playUi: (name) => soundManager.playUi(name),
    getItemInfo: (entry) => activeWorld?.getItemInfo(entry),
    itemIconUrl,
    getAvailableMoney: () => activeWorld?.getInventory().money ?? 0,
    onMoneyChange: (copper) => activeWorld?.setTradeGold(copper),
    onSlotClick: (side, index) => {
      if (side !== 'player' || !activeWorld) return;
      const held = inventoryCursor.heldCursor;
      if (held?.kind === 'item') {
        activeWorld.setTradeItem(index, held.source.protocolBag, held.source.protocolSlot);
        inventoryCursor.clearHeldCursor();
        soundManager.playUi('CURSORDROPOBJECT');
      } else if (activeWorld.getTradeState()?.playerItems[index]) {
        activeWorld.clearTradeItem(index);
      }
    },
    onAccept: () => activeWorld?.acceptTrade(),
    onCancel: () => activeWorld?.cancelTrade(),
  });
  const inspectPanel = new InspectFrame(inspectFrame, maxAnisotropy, { playUi: (name) => soundManager.playUi(name) });
  // Build the read-only inspect view from a target's VISIBLE_ITEM entries + resolved item info.
  const inspectSlotsFor = (guid: string): InspectSlotView[] => {
    const entries = activeWorld?.visibleItemEntries(guid) ?? [];
    const slots: InspectSlotView[] = [];
    entries.forEach((entry, index) => {
      if (!entry) return;
      const info = activeWorld?.getItemInfo(entry);
      slots.push({
        index,
        iconUrl: itemIconUrl(info?.displayInfoId, entry) || undefined,
        quality: info?.quality,
        tooltip: itemTooltipLines(info, entry),
      });
    });
    return slots;
  };
  const openInspect = (guid: string) => {
    const entity = entityRenderer?.inspect(guid)?.entity;
    const subtitle = entity
      ? `Level ${entity.level ?? '??'} ${RACES[entity.race ?? -1] ?? ''} ${CLASSES[entity.classId ?? -1] ?? ''}`.trim()
      : '';
    inspectPanel.show(
      { guid, title: unitNameByGuid(guid) ?? 'Unknown', subtitle, slots: inspectSlotsFor(guid) },
      entityRenderer?.characterInfoFor(guid) ?? null,
    );
  };
  globalThis.__wowShowBank = (view: unknown) => bankPanel.show(view as Parameters<BankCanvasPanel['show']>[0]);
  globalThis.__wowShowTrade = (view: unknown) => tradePanel.show(view as Parameters<TradeCanvasPanel['show']>[0]);

  let suppressNextBagButtonClick = false;
  const releaseHeldItemOnBagButton = (bagId: number, event: PointerEvent) => {
    if (event.button !== 0 || inventoryCursor.heldCursor?.kind !== 'item') return;
    event.preventDefault();
    event.stopPropagation();
    if (dropHeldItemOnBagButton(bagId)) suppressNextBagButtonClick = true;
  };

  characterClose.addEventListener('click', () => setCharacterOpen(false));
  microCharacter.addEventListener('click', () => {
    if (currentCharacter) setCharacterOpen(!characterOpen);
  });
  // The world map is a UIPanelWindows `area = "full"` panel, and ShowUIPanel hands those to
  // SetFullScreenFrame, which calls UIParent:Hide() before showing the frame
  // (UIParent.lua:32, 391-395, 551-565). The whole interface goes away for as long as the map is
  // up — that, not the backdrop colour, is why an open map looks nothing like the client if the
  // HUD keeps drawing around it.
  const syncWorldMapFullScreen = () => ingameHud.classList.toggle('world-map-open', worldMap.isOpen());
  const toggleWorldMap = () => {
    if (!currentCharacter) return;
    if (!worldMap.isOpen()) worldMap.setExploredZones(activeWorld?.getExploredZones().bits ?? []);
    worldMap.toggle();
    syncWorldMapFullScreen();
    microWorld.classList.toggle('is-open', worldMap.isOpen());
    soundManager.playUi(worldMap.isOpen() ? 'MINIMAPOPEN' : 'MINIMAPCLOSE');
  };
  microWorld.addEventListener('click', toggleWorldMap);
  backpackButton.addEventListener('pointerup', (event) => releaseHeldItemOnBagButton(0, event));
  backpackButton.addEventListener('click', (event) => {
    event.preventDefault();
    if (suppressNextBagButtonClick) {
      suppressNextBagButtonClick = false;
      return;
    }
    if (inventoryCursor.heldCursor?.kind === 'item') dropHeldItemOnBagButton(0);
    else toggleBag(0);
  });
  bagSlotButtons.forEach((button, index) => {
    const bagId = index + 1;
    button.addEventListener('pointerup', (event) => releaseHeldItemOnBagButton(bagId, event));
    // Right-click an equipped bag to pick it up (unequip). Left-click stays open/close.
    button.addEventListener('pointerdown', (event) => {
      if (event.button === 2 && !inventoryCursor.heldCursor && pickupEquippedBag(bagId)) event.preventDefault();
    });
    button.addEventListener('contextmenu', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      if (suppressNextBagButtonClick) {
        suppressNextBagButtonClick = false;
        return;
      }
      if (inventoryCursor.heldCursor?.kind === 'item') dropHeldItemOnBagButton(bagId);
      else toggleBag(bagId);
    });
  });

  const setInventoryOpen = (open: boolean) => {
    setCharacterOpen(open);
    setAllBagsOpen(open);
  };

  installDraggableFrames({
    ingameHud,
    panels: [characterFrame, spellbookFrame, socialFrame, lootFrame, merchantFrame, trainerFrame, gossipFrame, questFrame, questLogFrame, bankFrame, tradeFrame, inspectFrame, talentFrame, ...tradeSkillPanel.hosts, mailHost, auctionHost, petStableHost, petitionHost, guildRegistrarHost],
    containerLayer,
    draggedFramePositions,
  });

  const handleInventorySlotPointer = (event: PointerEvent) => {
    const slotButton = (event.target as HTMLElement).closest<HTMLButtonElement>('.wow-item-slot[data-item-bag]');
    if (!slotButton) return;
    event.preventDefault();
    const ref = cursorSlotFromElement(slotButton);
    if (!ref) return;
    const slot = findInventorySlot(ref);
    if (!slot) return;
    const rect = slotButton.getBoundingClientRect();
    handleInventorySlotAction(slot, event.button, {
      shiftKey: event.shiftKey, ctrlKey: event.ctrlKey,
      anchor: { left: rect.left, right: rect.right, top: rect.top, align: 'right' },
    });
  };

  paperdollSlots.addEventListener('pointerdown', handleInventorySlotPointer);
  paperdollSlots.addEventListener('contextmenu', (event) => event.preventDefault());
  containerLayer.addEventListener('pointerdown', handleInventorySlotPointer);
  containerLayer.addEventListener('contextmenu', (event) => {
    if ((event.target as HTMLElement).closest('.wow-item-slot')) event.preventDefault();
  });

  containerLayer.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const close = target.closest<HTMLButtonElement>('[data-bag-close]');
    if (close) {
      setBagOpen(Number(close.dataset.bagClose ?? 0), false);
      return;
    }
  });

  const { positionTooltip } = installGameTooltip({ ingameHud, gameTooltip, escapeHtml });

  installHudKeybindings({
    isBlocked: (target) => gameMenu.isOpen() || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement,
    hasCharacter: () => !!currentCharacter,
    toggleCharacter: () => setCharacterOpen(!characterOpen),
    toggleBackpack,
    toggleKeyring: activateKeyringButton,
    toggleWorldMap: () => {
      toggleWorldMap();
    },
    toggleSpellbook: () => spellbook?.toggle(),
    toggleSocial: () => socialFrameController?.toggle(),
    commandFor: (event) => {
      if (keyBindings.matches(event, 'OPEN_CHARACTER')) return 'character';
      if (keyBindings.matches(event, 'TOGGLEBACKPACK')) return 'backpack';
      if (keyBindings.matches(event, 'TOGGLEKEYRING')) return 'keyring';
      if (keyBindings.matches(event, 'TOGGLEWORLDMAP')) return 'world';
      if (keyBindings.matches(event, 'OPEN_SPELLBOOK')) return 'spellbook';
      if (keyBindings.matches(event, 'OPEN_SOCIAL')) return 'social';
      return undefined;
    },
  });

  const closeTransientWorldUi = () => {
    npcInteraction?.closeAll();
    bankPanel.hide();
    mailPanel.close();
    auctionPanel.hide();
    guildRegistrarPanel.hide();
    petitionPanel.hide();
    petStablePanel.hide();
    tradePanel.hide();
    masterLootPanel.hide();
    readyCheck.reset();
  };

  const refreshPlayerFrame = () => {
    if (!currentCharacter) {
      unitFrames.hidePlayerFrame();
      mainMenuBar.classList.add('is-hidden');
      setInventoryOpen(false);
      npcInteraction?.closeAll();
      worldMap.close();
      syncWorldMapFullScreen();
      microWorld.classList.remove('is-open');
      spellbook?.setOpen(false);
      socialFrameController?.setOpen(false);
      return;
    }
    mainMenuBar.classList.remove('is-hidden');
    unitFrames.refreshPlayerFrame();
  };

  const renderExperienceBar = (entity: WorldEntity) => {
    const xpBar = ingameHud.querySelector<HTMLElement>('#wow-experience-bar');
    if (!xpBar) return;
    const renderedCurrent = Number(xpBar.dataset.currentXp);
    const { current, maximum, rested, isRested, percent, restedPercent } = resolveExperienceProgress({
      // Raw-field fallbacks must use the REALM-resolved indices. Stock 0x2C6/0x2C7/0x491 hold
      // unrelated data in this layout (0x2C6 falls inside the shifted COMBO_TARGET GUID), so a
      // stock literal here silently fed the XP bar someone else's bytes.
      currentXp: entity.experience ?? entity.fields.get(PLAYER_FIELDS.PLAYER_XP),
      nextLevelXp: entity.nextLevelExperience ?? entity.fields.get(PLAYER_FIELDS.PLAYER_NEXT_LEVEL_XP),
      restedXp: entity.restedExperience ?? entity.fields.get(PLAYER_FIELDS.PLAYER_REST_STATE_EXPERIENCE),
      restState: entity.restState,
      level: (entity.level ?? 0) > 0 ? entity.level : currentCharacter?.level,
      renderedCurrentXp: Number.isFinite(renderedCurrent) ? renderedCurrent : 0,
    });
    xpBar.classList.toggle('is-rested', isRested);
    const fill = xpBar.querySelector<HTMLElement>('.wow-experience-fill');
    const bonus = xpBar.querySelector<HTMLElement>('.wow-experience-rested');
    const text = xpBar.querySelector<HTMLElement>('.wow-experience-text');
    if (fill) fill.style.width = `${percent}%`;
    if (bonus) bonus.style.width = `${isRested ? restedPercent : 0}%`;
    if (text) text.textContent = `${current.toLocaleString()} / ${maximum.toLocaleString()}${isRested ? `  (${rested.toLocaleString()} rested)` : ''}`;
    xpBar.dataset.tooltip = `Experience\n${current.toLocaleString()} / ${maximum.toLocaleString()}${rested > 0 ? `\n${rested.toLocaleString()} rested XP` : ''}`;
    xpBar.dataset.currentXp = String(current);
    xpBar.dataset.nextLevelXp = String(maximum);
    xpBar.dataset.restedXp = String(rested);
    refreshMainMenuCanvas();
  };

  const fctContainer = document.createElement('div');
  fctContainer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:29;overflow:hidden;';
  document.body.appendChild(fctContainer);

  const updateAttackIndicator = () => unitFrames.updateAttackIndicator(autoAttacking);

  let refreshCombatTimers = () => {}; const refreshTargetFrame = () => { unitFrames.refreshTargetFrame(); refreshCombatTimers(); };

  const nameForEntity = (guid: string, entity: WorldEntity) => unitFrames.nameForEntity(guid, entity);

  const updateNameplates = () => unitFrames.updateNameplates(spawned);

  const stopAttack = () => {
    if (autoAttacking) activeWorld?.attackStop();
    autoAttacking = false;
    // Stopping swings is not the same as leaving combat. Preserve engagement while
    // any mob remains on the authoritative combat list so a second attacker keeps
    // the weapon drawn. If combat never started, cancel the tentative draw now.
    if (!playerWasServerInCombat) {
      playerActivelyEngaged = false;
      setPlayerSheathState(0);
    }
    updateAttackIndicator();
  };

  const setTarget = (guid: string | undefined) => targeting.setTarget(guid);

  /** Weapon (or shield) driving the SheatheSoundLookups draw/stow sound. */
  const playerSheatheSoundItem = () => {
    const equipment = lastInventory?.equipment ?? [];
    return equipment.find((slot) => slot.index === 15)?.item?.info
      ?? equipment.find((slot) => slot.index === 16)?.item?.info;
  };

  const setPlayerSheathState = (
    state: 0 | 1 | 2,
    sendToServer = true,
    forceServerSync = false,
  ) => {
    if (playerSheathState === state) {
      // The local visual cache can already say "sheathed" while vMaNGOS still has state 1 from an
      // earlier melee swing. Duel teardown needs one authoritative correction in that case.
      if (sendToServer && forceServerSync) activeWorld?.setSheathed(state);
      return;
    }
    const wasSheathed = playerSheathState === 0;
    playerSheathState = state;
    playerSetWeaponsSheathed?.(state);
    if (wasSheathed !== (state === 0)) {
      const item = playerSheatheSoundItem();
      soundManager.playSheathe(item?.classId, item?.subclass, state !== 0, { volumeScale: 0.9 });
    }
    if (sendToServer) activeWorld?.setSheathed(state);
  };

  const attackTarget = (guid: string) => {
    const entity = activeWorld?.getEntity(guid) ?? entityRenderer?.inspect(guid)?.entity;
    if (!entity || (entity.health ?? 1) <= 0) return;
    // Friendly units can never be auto-attacked (vanilla shows the red error
    // text instead of entering combat); neutral targets remain attackable when
    // the player explicitly starts an attack.
    const player = currentPlayerEntity();
    const forcedReaction = activeWorld?.getForcedReaction(factionIdForTemplate(entity.faction) ?? 0);
    const reaction = withDuelReaction(
      player,
      entity,
      getUnitReaction(player?.faction, entity.faction, forcedReaction),
    );
    if (reaction === 'friendly') {
      showUiError('You cannot attack that target.');
      return;
    }
    playerActivelyEngaged = true;
    setPlayerSheathState(1); // vanilla draws weapons when you start attacking
    activeWorld?.attackSwing(guid); // server confirms with SMSG_ATTACKSTART
  };

  const spawnDamageText = (guid: string, text: string, color: string, opts: { critical?: boolean; small?: boolean; prominent?: boolean } = {}) => {
    const p = entityRenderer?.localPositionOf(guid) ?? (guid === playerGuid ? { x: charPos.x, y: charPos.y, z: charPos.z + 2.2 } : null);
    if (!p) return;
    const v = new THREE.Vector3(p.x, p.y, p.z).project(camera);
    if (v.z > 1) return; // behind the camera
    const x = (v.x * 0.5 + 0.5) * window.innerWidth + (Math.random() - 0.5) * 34;
    const y = (-v.y * 0.5 + 0.5) * window.innerHeight - (opts.critical ? 8 : 0);
    const size = opts.prominent ? 27 : opts.critical ? 23 : opts.small ? 13 : 17;
    // Interface Options → Combat Text Float Mode. "Scroll Down" mirrors the travel so the
    // label falls away from the unit instead of rising.
    const travel = fctFloatTravel(opts.critical === true);
    const div = document.createElement('div');
    div.textContent = text;
    div.style.cssText =
      `position:absolute;left:${x.toFixed(0)}px;top:${y.toFixed(0)}px;transform:translate(-50%,${travel.from});` +
      `color:${color};font:bold ${size}px 'Friz Quadrata',Georgia,serif;text-shadow:1px 1px 2px #000,0 0 5px #000;` +
      `transition:transform ${opts.prominent ? 1.45 : 1.1}s ease-out,opacity ${opts.prominent ? 1.45 : 1.1}s ease-in;opacity:1;will-change:transform,opacity;`;
    fctContainer.appendChild(div);
    requestAnimationFrame(() => {
      div.style.transform = `translate(-50%,${travel.to})`;
      div.style.opacity = '0';
    });
    window.setTimeout(() => div.remove(), opts.prominent ? 1550 : 1200);
  };

  /**
   * FCT "Show Low Mana and Health". Latched on the downward crossing of 20% and released
   * once the bar recovers past the threshold, so a long fight at low health produces one
   * warning rather than one per health packet.
   */
  const announceLowVitals = (entity: WorldEntity) => {
    const maxHealth = entity.maxHealth ?? 0;
    if (maxHealth > 0) {
      const low = (entity.health ?? maxHealth) / maxHealth < FCT_LOW_VITALS_FRACTION;
      if (low && !fctLowHealthLatched && fctAllows('lowManaHealth')) {
        spawnDamageText(entity.guid, 'Low Health', '#ff4d4d');
      }
      fctLowHealthLatched = low;
    }
    // Only mana-using classes get the mana warning; rage/energy sit at zero by design.
    if (entity.powerType === 0) {
      const maxMana = entity.maxPowers?.[0] ?? 0;
      if (maxMana > 0) {
        const low = (entity.powers?.[0] ?? maxMana) / maxMana < FCT_LOW_VITALS_FRACTION;
        if (low && !fctLowManaLatched && fctAllows('lowManaHealth')) {
          spawnDamageText(entity.guid, 'Low Mana', '#5a9bff');
        }
        fctLowManaLatched = low;
      }
    }
  };

  /**
   * FCT "Show Auras" / "Show Fading Auras". SMSG_AURA_UPDATE_ALL resends the whole slot
   * table, so the gain/fade events are the set difference against the previous list for
   * that unit rather than anything on the packet itself. Only the player's own auras are
   * announced — vanilla's FCT frame is personal, and every nearby unit's buffs churning
   * through it would bury the combat numbers.
   */
  const announceAuraChanges = (unitGuid: string, auras: readonly AuraSlot[]) => {
    if (unitGuid !== playerGuid) return;
    const next = new Set(auras.map((aura) => aura.spellId).filter((spellId) => spellId > 0));
    const previous = fctKnownAuras.get(unitGuid);
    fctKnownAuras.set(unitGuid, next);
    if (!previous) return; // first snapshot seeds the baseline
    if (fctAllows('auras')) {
      for (const spellId of next) {
        if (!previous.has(spellId)) spawnDamageText(unitGuid, actionCombat.getSpellName(spellId), '#d6c27a', { small: true });
      }
    }
    if (fctAllows('fadingAuras')) {
      for (const spellId of previous) {
        if (!next.has(spellId)) spawnDamageText(unitGuid, `-${actionCombat.getSpellName(spellId)}`, '#9a8f72', { small: true });
      }
    }
  };

  const clearPlayerCombatAnim = () => {
    playerCombatAnimId = undefined;
    playerCombatUntil = 0;
    playerCombatKind = undefined;
  };

  const playPlayerOneShot = (animationId: number, durationMs = 700, kind: 'melee' | 'cast' | 'reaction' | 'emoteState' | 'loot' = 'reaction') => {
    if (!playerAnimator?.updateAnimationId && !playerForm?.animator) return;
    // A hit-reaction (flinch) is the lowest priority: don't let getting struck mid-swing cancel
    // your own attack/cast animation. When a wolf hits you while you're auto-attacking, the incoming
    // 'reaction' must NOT clobber the in-progress 'melee'/'cast' one-shot (that read as the wolf
    // "interrupting" your attack — the swing just vanished). A new melee/cast still overrides freely.
    if (kind === 'reaction'
      && playerCombatAnimId !== undefined
      && (playerCombatKind === 'melee' || playerCombatKind === 'cast')
      && performance.now() < playerCombatUntil) {
      return;
    }
    playerCombatAnimId = resolveAnimId(animationId, playerForm?.animationIds ?? playerAnimIds);
    const naturalDuration = playerAnimator?.getAnimationDurationMs?.(playerCombatAnimId) ?? 0;
    // Hard-coded 600/700ms windows truncated several Special1H/2H race variants before their
    // contact/recovery frames. Hold the override for the actual baked M2 sequence duration.
    // The Loot sequence is a state while LootFrame is open, not a timed one-shot. The animator
    // advances into the kneel and clamps its final pose until SMSG_LOOT_RELEASE_RESPONSE closes it.
    playerCombatUntil = kind === 'loot'
      ? Number.POSITIVE_INFINITY
      : performance.now() + Math.max(durationMs, naturalDuration + 35);
    playerCombatKind = kind;
  };

  const playEntityOrPlayer = (
    guid: string,
    animationId: number,
    durationMs = 700,
    kind: 'melee' | 'cast' | 'reaction' | 'emoteState' = 'reaction',
  ) => {
    if (guid && guid === playerGuid) playPlayerOneShot(animationId, durationMs, kind);
    else entityRenderer?.playOneShot(guid, animationId, durationMs, kind);
  };

  const groundSpellTargeting = new GroundSpellTargetingController({
    scene,
    camera,
    canvas: renderer.domElement,
    getPlayerPosition: () => movement.charPos,
    // Terrain-only, for draping the reticle mesh over slopes (one read per grid node).
    sampleTerrainHeight: (localX, localY) => sampleHeight(localX, localY),
    resolveGround: (localX, localY, probeZ) => {
      const terrainZ = sampleHeight(localX, localY);
      return worldCollision.sampleGround(
        localX,
        localY,
        probeZ,
        terrainZ,
        { allowWmoBelowTerrain: shouldAllowWmoBelowTerrain(movement.charPos.z, terrainZ) },
      ).height;
    },
    localToWorld,
    confirm: (spellId, destination) => activeWorld?.castSpellAtLocation(spellId, destination),
    showError: showUiError,
    log,
  });

  actionCombat = new ActionCombatController({
    elements: {
      actionBar,
      buffsEl,
      castBar,
      castSpellName,
      castFill,
    },
    cursor: inventoryCursor,
    getWorld: () => activeWorld ?? undefined,
    getPlayerGuid: () => playerGuid ?? currentCharacter?.guid,
    getSelectedTargetGuid: () => selectedTargetGuid,
    getPlayerEntity: currentPlayerEntity,
    getPlayerClassId: () => playerEntity?.classId ?? currentCharacter?.classId,
    getPlayerLevel: () => playerEntity?.level ?? currentCharacter?.level,
    getInventory: () => lastInventory ?? activeWorld?.getInventory(),
    getProficiencyMask: (itemClass) => activeWorld?.getProficiencyMask(itemClass),
    getSelectedTargetEntity: () => selectedTargetGuid
      ? activeWorld?.getEntity(selectedTargetGuid) ?? entityRenderer?.inspect(selectedTargetGuid)?.entity
      : undefined,
    getSelectedTargetPosition: () => selectedTargetGuid ? entityRenderer?.localPositionOf(selectedTargetGuid) : undefined,
    getPlayerLocalPosition: () => movement.charPos,
    worldToLocalPosition: (position) => {
      const local = worldToLocal(position.x, position.y);
      return { x: local.x, y: local.y, z: position.z };
    },
    getPlayerFacing: () => {
      const moverGuid = controlledMoverGuid ?? playerGuid;
      return moverGuid && moverGuid !== playerGuid
        ? entityRenderer?.controlFrame(moverGuid)?.root.rotation.z ?? movement.getServerOrientation()
        : playerRoot.rotation.z;
    },
    isSwimming: () => movement.isSwimming(),
    getEntityRenderer: () => entityRenderer,
    getAutoAttacking: () => autoAttacking,
    setAutoAttacking: (value) => { autoAttacking = value; },
    updateAttackIndicator,
    updateAttackBlocked: (blocked) => unitFrames.updateAttackBlocked(autoAttacking, blocked),
    stopAttack,
    attackTarget,
    log,
    itemIconUrl,
    findInventorySlot,
    findFirstItemByEntry,
    activateInventorySlot,
    isBagContainerItem,
    canPlaceItemOnActionButton,
    playEntityOrPlayer,
    // AttackAnimKits.dbc swing kit for whichever hand the server says swung. `offHand` is
    // HITINFO_LEFTSWING off SMSG_ATTACKERSTATEUPDATE, so a dual-wielder's left swing plays
    // AttackOff/AttackOffPierce instead of repeating the main-hand animation.
    getMeleeAttackAnim: (attackerGuid: string, offHand = false) => {
      const weapons = weaponsForGuid(attackerGuid);
      return meleeSwingAnim(offHand ? weapons.offHand : weapons.mainHand, offHand);
    },
    // Ranged auto-attack (Auto Shot / Shoot / Throw) carries no SpellVisual in 1.12 — Spell.dbc
    // column SpellVisual is 0 for spell 75 — so the pose comes from the equipped ranged weapon.
    getRangedAttackAnim: (attackerGuid: string) => rangedAttackAnim(weaponsForGuid(attackerGuid).ranged),
    // Weapon-aware defensive poses. Block resolves to ShieldBlock (0x18): AnimationData's plain
    // Block (0x24) exists but ships on none of the 16 baked player models.
    getDefenseAnim: (guid: string, kind: 'dodge' | 'parry' | 'block') =>
      kind === 'dodge' ? DEFENSE_ANIM.DODGE
        : kind === 'block' ? DEFENSE_ANIM.SHIELD_BLOCK
          : parryAnim(weaponsForGuid(guid).mainHand),
    clearPlayerCombatAnim,
    spawnDamageText,
    getPetGuid: () => lastPet?.guid,
    castSpellVisual: spellVisuals.castSpellVisual.bind(spellVisuals),
    beginGroundTargeting: (request) => groundSpellTargeting.begin(request),
    requestTextInput: (message, onAccept) => logoutPopupPanel.forceInput(message, '', onAccept),
    getSpellCastAnim: spellVisuals.getCastAnim.bind(spellVisuals),
    refreshTargetFrame,
    renderInventory,
    rerenderNpcInteractions: () => npcInteraction?.rerender(),
    executeMacro: (index) => { void macroSystem.execute(index); },
    openTradeSkill: (spellId) => tradeSkillPanel.tryOpen(spellId),
  });
  actionCombat.installDebugHooks();
  const combatTimers = new CombatTimersAddon(ingameHud, {
    getPlayerGuid: () => playerGuid ?? currentCharacter?.guid, getTargetGuid: () => selectedTargetGuid,
    getPlayerEntity: currentPlayerEntity, getTargetAuras: () => selectedTargetGuid ? activeWorld?.getAuras(selectedTargetGuid) ?? [] : [],
    getSpellMeta: (spellId) => actionCombat.getSpellMetaEntry(spellId),
    isAutoRepeatSpell: (spellId) => ((Number(actionCombat.getSpellMetaEntry(spellId)?.[12]) || 0) & 0x20) !== 0,
  }); refreshCombatTimers = () => combatTimers.refreshTarget();
  const damageMeterLite = new DamageMeterLiteAddon(ingameHud, {
    resolveName: unitNameByGuid, getPlayerGuid: () => playerGuid ?? currentCharacter?.guid, getPlayerEntity: currentPlayerEntity,
    getEntity: (guid) => activeWorld?.getEntity(guid) ?? entityRenderer?.inspect(guid)?.entity,
    resolveClassId: (guid) => guid === (playerGuid ?? currentCharacter?.guid) ? currentCharacter?.classId
      : activeWorld?.getPlayerName(guid)?.classId ?? activeWorld?.getEntity(guid)?.classId,
    resolveSpellName: (spellId) => actionCombat.getSpellName(spellId),
    isTrackedActor: (guid) => guid === (playerGuid ?? currentCharacter?.guid) || guid === lastPet?.guid
      || !!activeWorld?.getSocial().group.some((member) => member.guid === guid),
    normalizeActorGuid: (guid) => guid === lastPet?.guid ? (playerGuid ?? currentCharacter?.guid ?? guid) : guid,
  });

  const talentFrameController = new TalentFrameController(talentFrame, {
    playUi: (name) => soundManager.playUi(name),
    getClassId: () => currentCharacter?.classId,
    getKnownSpells: () => activeWorld?.getKnownSpells() ?? [],
    getUnspentPoints: () => playerEntity?.unspentTalentPoints ?? 0,
    learnTalent: (talentId, requestedRank) => activeWorld?.learnTalent(talentId, requestedRank),
    getSpellName: (spellId) => actionCombat?.getSpellName(spellId) ?? `Spell #${spellId}`,
    getSpellIconUrl: spellIconUrl,
  });
  const microTalents = ingameHud.querySelector<HTMLButtonElement>('.wow-micro-button--talents');
  microTalents?.addEventListener('click', () => { if (currentCharacter) talentFrameController.toggle(); });
  window.addEventListener('keydown', (event) => {
    if (!keyBindings.matches(event, 'OPEN_TALENTS') || !currentCharacter) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    event.preventDefault();
    talentFrameController.toggle();
  });

  const microElements: Record<MainMenuMicroButton, HTMLButtonElement | null> = {
    character: microCharacter,
    spellbook: microSpellbook,
    talents: ingameHud.querySelector<HTMLButtonElement>('.wow-micro-button--talents'),
    quest: microQuest,
    socials: microSocial,
    world: microWorld,
    mainmenu: ingameHud.querySelector<HTMLButtonElement>('.wow-micro-button--mainmenu'),
    help: ingameHud.querySelector<HTMLButtonElement>('.wow-micro-button--help'),
  };
  const microLabels: Record<MainMenuMicroButton, string> = {
    character: 'Character Info',
    spellbook: 'Spellbook & Abilities',
    talents: 'Talents',
    quest: 'Quest Log',
    socials: 'Social',
    world: 'World Map',
    mainmenu: 'Game Menu',
    help: 'Help Request',
  };
  const canvasTooltip = getGameTooltip();
  const mainMenuCanvas = new MainMenuBarCanvas({
    onPointerDown: (target, event) => {
      // Casting fires on RELEASE in onActivate; the hold stays free for OnDragStart (:108-109).
      if (target.kind !== 'action') return;
      if (event.button === 0 && inventoryCursor.heldCursor) placeHeldOnActionButton(target.slot, target.bar);
      else if (event.button === 0 && event.shiftKey) pickupActionButton(target.slot, target.bar);
      refreshMainMenuCanvas();
    },
    // ActionBarFrame.xml:23-30 — OnDragStart PickupAction, gated on LOCK_ACTIONBAR.
    onDragStart: (target) => {
      if (target.kind === 'action' && !inventoryCursor.heldCursor) pickupActionButton(target.slot, target.bar);
      refreshMainMenuCanvas();
    },
    // OnReceiveDrag (ActionBarFrame.xml:31-34) when the release lands on a button; releasing over
    // anything else throws the action away, which is how vanilla clears a slot.
    onDrop: (target) => {
      if (target?.kind === 'action') placeHeldOnActionButton(target.slot, target.bar);
      else if (inventoryCursor.heldCursor?.kind === 'action') inventoryCursor.clearHeldCursor();
      refreshMainMenuCanvas();
    },
    onActivate: (target, event) => {
      // Release, not press — RegisterForClicks("LeftButtonUp"). Keyboard arrives here too.
      if (target.kind === 'action' || target.kind === 'shapeshift') return target.kind === 'shapeshift' ? actionCombat.shapeshift.use(target.slot) : actionCombat.useAction(target.slot, target.bar);
      if (target.kind === 'page') return void actionCombat.changeActionPage(target.direction).then(refreshMainMenuCanvas);
      if (target.kind === 'micro') { microElements[target.id]?.click(); return void requestAnimationFrame(refreshMainMenuCanvas); }
      if (target.kind === 'keyring') return activateKeyringButton();
      if (target.kind !== 'bag') return;
      if (inventoryCursor.heldCursor?.kind === 'item') dropHeldItemOnBagButton(target.bagId); else toggleBag(target.bagId);
      refreshMainMenuCanvas();
    },
    onContextMenu: (target) => {
      if (target.kind === 'action') actionCombat.useAction(target.slot, target.bar);
      else if (target.kind === 'keyring') activateKeyringButton();
      else if (target.kind === 'bag' && target.bagId > 0 && !inventoryCursor.heldCursor) pickupEquippedBag(target.bagId);
      refreshMainMenuCanvas(); },
    onHoverChange: (target, event) => {
      if (!target || !event) { canvasTooltip.hide(); return; }
      let lines;
      if (target.kind === 'experience') {
        const xp = ingameHud.querySelector<HTMLElement>('#wow-experience-bar');
        lines = textTooltipLines('Experience', ...(xp?.dataset.tooltip?.split('\n').slice(1) ?? []));
      } else if (target.kind === 'action' || target.kind === 'shapeshift') {
        lines = (target.kind === 'shapeshift' ? actionCombat.shapeshift.tooltip(target.slot) : actionCombat.actionTooltipLines(target.slot, target.bar))
          ?? textTooltipLines((actionBar.children[target.slot] as HTMLElement | undefined)?.title || `Action ${target.slot + 1}`);
      } else if (target.kind === 'micro') {
        lines = textTooltipLines(microLabels[target.id]);
      } else if (target.kind === 'bag') {
        lines = textTooltipLines(bagButtonForId(target.bagId)?.title || (target.bagId === 0 ? 'Backpack' : `Bag Slot ${target.bagId}`));
      } else if (target.kind === 'keyring') {
        const binding = keyBindings.code('TOGGLEKEYRING');
        lines = textTooltipLines(`Keyring${binding ? ` (${binding.replace(/^Key/, '')})` : ''}`);
      } else {
        lines = textTooltipLines(`Action Page ${actionCombat.getActionPage()}`);
      }
      canvasTooltip.show(lines, event.clientX, event.clientY);
    },
  });
  mainMenuBar.classList.add('has-canvas-ui');
  mainMenuBar.appendChild(mainMenuCanvas.canvas);
  const targetDropState = (button: HTMLElement | undefined) => button?.classList.contains('is-drop-valid')
    ? 'valid' as const : button?.classList.contains('is-drop-invalid') ? 'invalid' as const : 'none' as const;
  refreshMainMenuCanvas = () => {
    const xpBar = ingameHud.querySelector<HTMLElement>('#wow-experience-bar');
    const current = Math.max(0, Number(xpBar?.dataset.currentXp) || 0);
    const maximum = Math.max(1, Number(xpBar?.dataset.nextLevelXp) || 1);
    const rested = Math.max(0, Number(xpBar?.dataset.restedXp) || 0);
    const inventory = lastInventory ?? activeWorld?.getInventory();
    keyringDiscovery.observe(inventory);
    const microOpen = (id: MainMenuMicroButton) => id === 'character' ? characterOpen
      : id === 'spellbook' ? !spellbookFrame.classList.contains('is-hidden')
      : id === 'talents' ? talentFrameController.isOpen()
      : id === 'quest' ? (questLogController?.isOpen() ?? false)
      : id === 'socials' ? !socialFrame.classList.contains('is-hidden')
      : id === 'world' ? worldMap.isOpen()
      : id === 'mainmenu' ? gameMenu.isOpen() : false;
    const shapeshiftForms = actionCombat.shapeshift.views(); petHud.setShapeshiftFormCount(shapeshiftForms.length);
    mainMenuCanvas.setViewModel({
      skin: currentCharacter?.race === 3 ? 'dwarf' : currentCharacter?.race === 4 ? 'night-elf' : 'human',
      showEndCaps: true,
      experience: {
        current,
        maximum,
        restedBonus: rested,
        atMaxLevel: (playerEntity?.level ?? currentCharacter?.level ?? 0) >= 60,
        displayText: xpBar?.querySelector<HTMLElement>('.wow-experience-text')?.textContent ?? `${current} / ${maximum}`,
      },
      actionPage: actionCombat.getActionPage(),
      actionPageCount: 6,
      actions: actionCombat.getCanvasActionViews(), shapeshiftForms,
      multiBars: actionCombat.getCanvasMultiBarViews(),
      latencyMs: activeWorld ? Math.round(activeWorld.getClockDiagnostics().rttMs) : undefined,
      portraitSource: unitFrames.playerPortraitSource(),
      portraitUrl: currentCharacter && `/ui/Interface/CharacterFrame/TemporaryPortrait-${currentCharacter.gender === 1 ? 'Female' : 'Male'}-${portraitRaceName(currentCharacter.race)}.png` || undefined,
      microButtons: (['character', 'spellbook', 'talents', 'quest', 'socials', 'world', 'mainmenu', 'help'] as MainMenuMicroButton[]).map((id) => ({
        id,
        enabled: !!currentCharacter && id !== 'help',
        open: microOpen(id),
      })),
      bags: Array.from({ length: 5 }, (_, bagId) => {
        const bag = inventory?.bags[bagId];
        const button = bagButtonForId(bagId);
        const hasBag = bagId === 0 || !!bag?.itemGuid;
        return {
          bagId,
          isBackpack: bagId === 0,
          iconUrl: bagId === 0 ? undefined : itemIconUrl(bag?.item?.info?.displayInfoId, bag?.item?.entry) || undefined,
          hasBag,
          enabled: bagId === 0 || hasBag || inventoryCursor.heldCursor?.kind === 'item',
          open: inventoryUi.isBagOpen(bagId),
          dropState: targetDropState(button),
        };
      }),
      keyring: {
        visible: keyringDiscovery.isDiscovered(),
        open: inventoryUi.isBagOpen(KEYRING_CONTAINER_ID),
        dropState: inventoryCursor.heldCursor?.kind === 'item' ? 'valid' : 'none',
      },
    });
  };
  refreshMainMenuCanvas();

  spellbook = new SpellbookController({
    root: spellbookFrame,
    getWorld: () => activeWorld ?? undefined,
    getPlayer: () => playerEntity,
    actionCombat: () => actionCombat,
    playUi: (name) => soundManager.playUi(name),
    clearHeldCursor: () => inventoryCursor.clearHeldCursor(),
  });
  socialFrameController = new SocialFrameController({
    root: socialFrame,
    getWorld: () => activeWorld ?? undefined,
    getPlayer: () => currentCharacter,
    getAreaName: (areaId) => areaNames[areaId],
    playUi: (name) => soundManager.playUi(name),
    startWhisper: (name) => chatUi.openInput(`/w ${name} `),
    confirm: (message, accept) => npcInteraction?.forceConfirm(message, accept, () => {}, 'Yes', 'No'),
  });
  microSpellbook.addEventListener('click', () => spellbook?.toggle());
  microSocial.addEventListener('click', () => socialFrameController?.toggle());

  const toggleAttack = () => actionCombat.toggleAttack();
  const useAction = (slot: number) => actionCombat.useAction(slot);
  const renderActionBar = async (override?: readonly ActionButton[]) => {
    await actionCombat.renderActionBar(override);
    refreshMainMenuCanvas();
  };
  const renderBuffs = (guid = playerGuid) => actionCombat.renderBuffs(guid);
  const hideCastBar = () => actionCombat.hideCastBar();
  const updateCastBar = () => actionCombat.updateCastBar();
  const updateAuraTimers = () => actionCombat.updateAuraTimers();
  const updateCooldowns = () => actionCombat.updateCooldowns();
  const updateActionStates = () => actionCombat.updateActionStates();
  const hudFrameCadence = new HudFrameCadence();
  // ALPHA QA: per-spell chain tracing (__wowSpellDebug / __wowKnownSpellsDebug / __wowActionBarDebug).
  const spellDebug = new SpellDebugTracker({
    getWorld: () => activeWorld ?? undefined,
    getSpellName: (spellId) => actionCombat.getSpellName(spellId),
    getSpellMetaEntry: (spellId) => actionCombat.getSpellMetaEntry(spellId),
    getBarActions: () => actionCombat.getBarActions(),
    getSpellVisualSummary: (spellId) => spellVisuals.getVisualSummary(spellId),
  });
  spellDebug.install();

  const handleCombatEvent = (ev: CombatEvent) => {
    if (ev.kind === 'meleeDamage' && ev.attackerGuid === playerGuid && ev.totalDamage > 0) xrRuntime?.haptic();
    worldNotices.handle(ev);
    if (ev.kind === 'playerNameResponse') { readyCheck.refreshPlayer(ev.guid); chatUi.resolvePlayerName(ev.guid, ev.name); }
    if (ev.kind === 'xpGain' && playerEntity) {
      // Build 5875 has a hardcoded world-space XP announcement in addition to
      // CHAT_MSG_COMBAT_XP_GAIN: "XP: <amount>" above the victim, or above the player for
      // quest/exploration XP where SMSG_LOG_XPGAIN carries an empty victim GUID.
      const xpAnchorGuid = /^0+$/.test(ev.victimGuid) ? playerGuid : ev.victimGuid;
      if (xpAnchorGuid) spawnDamageText(xpAnchorGuid, `XP: ${ev.totalXp}`, '#94008c', { critical: true, prominent: true });
      const xpBar = ingameHud.querySelector<HTMLElement>('#wow-experience-bar');
      const rendered = Number(xpBar?.dataset.currentXp);
      const current = playerEntity.experience ?? playerEntity.fields.get(PLAYER_FIELDS.PLAYER_XP)
        ?? (Number.isFinite(rendered) ? rendered : 0);
      playerEntity.experience = Math.max(0, current + ev.totalXp);
      renderExperienceBar(playerEntity);
      log(`experience: +${ev.totalXp} XP`);
    }
    if (ev.kind === 'levelUp') {
      if (playerEntity) playerEntity.level = ev.level;
      if (playerGuid) spellVisuals.spawnLevelUp(playerGuid);
      questWatchPanel.showAnnouncement(`You have reached level ${ev.level}!`, '#ffd100', 6000);
      refreshPlayerFrame();
      renderInventory();
      talentFrameController.requestRender();
    }
    spellDebug.record(ev);
    spellVisuals.handleCombatEvent(ev);
    worldAudio.handleCombatEvent(ev);
    combatTimers.handleCombatEvent(ev);
    damageMeterLite.handleCombatEvent(ev);
    // Feed the Combat Log. These are exactly the packets vanilla's client turns into
    // CHAT_MSG_COMBAT_* lines; everything else on this event union belongs elsewhere.
    switch (ev.kind) {
      case 'meleeDamage':
        combatLog.handleMeleeDamage(ev);
        break;
      case 'spellDamage':
        combatLog.handleSpellDamage(ev);
        break;
      case 'spellMiss':
        combatLog.handleSpellMiss(ev);
        break;
      case 'spellHeal':
        combatLog.handleSpellHeal(ev);
        break;
      case 'spellEnergize':
        combatLog.handleSpellEnergize(ev);
        break;
      case 'periodicAura':
        combatLog.handlePeriodicAura(ev);
        break;
      case 'xpGain':
        combatLog.handleXpGain(ev);
        break;
      default:
        break;
    }
    // Server-confirmed melee engagement (covers abilities that start auto-attack): draw weapons.
    if (ev.kind === 'attackStart' && ev.attackerGuid === playerGuid) {
      playerActivelyEngaged = true;
      setPlayerSheathState(1);
    }
    if (ev.kind === 'attackStop' && ev.attackerGuid === playerGuid && ev.attackerDead
      && ((playerEntity?.unitFlags ?? 0) & 0x00080000) === 0) {
      autoAttacking = false;
      playerActivelyEngaged = false;
      updateAttackIndicator();
      setPlayerSheathState(0);
    }
    if (ev.kind === 'combatCancelled') {
      autoAttacking = false;
      playerActivelyEngaged = false;
      updateAttackIndicator();
      clearPlayerCombatAnim();
      // This is a server-to-client cancellation. Update the local pose without echoing
      // CMSG_SETSHEATHED back to the realm.
      setPlayerSheathState(0, false);
    }
    // SOC-04: state emotes persist until movement/another action, rather than expiring after an
    // arbitrary ten seconds. One-shots retain their short reaction window.
    if (ev.kind === 'emote') {
      const [emoteAnimId, isStateEmote] = EMOTE_ANIMS[ev.emoteId] ?? [0, 0];
      if (emoteAnimId > 0) {
        // vMaNGOS fires EMOTE_ONESHOT_EAT (Emotes.dbc 7 -> EmoteEat 61; no-sheathe variant
        // Emotes.dbc 92 -> EmoteEatNoSheathe 199) on EVERY food/drink aura tick (SpellAuras.cpp:6305
        // SPELL_AURA_MOD_REGEN / :6321 MOD_POWER_REGEN), while the same aura apply forces
        // UNIT_STAND_STATE_SIT (SpellAuras.cpp:6761). EmoteEat 61 is authored STANDING; our
        // single-sequence animator has no seated-eat variant and no additive blend, so overlaying it
        // popped the character upright for each bite/sip and dropped them back to SitGround between
        // ticks. Vanilla eating is a continuous seated pose that only ends when the aura ends and the
        // server restores UNIT_STAND_STATE_STAND. So while the unit is seated, drop the eat one-shot
        // and let the stand-state SitGround idle hold; other emotes still play normally.
        const standStateOf = (guid: string) => (guid === playerGuid
          ? playerEntity?.standState
          : activeWorld?.getEntity(guid)?.standState) ?? 0;
        const isEatEmote = emoteAnimId === 61 || emoteAnimId === 199;
        const play = () => playEntityOrPlayer(
          ev.guid,
          emoteAnimId,
          isStateEmote ? Number.POSITIVE_INFINITY : 1600,
          isStateEmote ? 'emoteState' : 'reaction',
        );
        if (!isEatEmote) {
          play();
        } else if (standStateOf(ev.guid) === 0) {
          // ORDERING RACE. The food/drink aura sets UNIT_STAND_STATE_SIT on apply
          // (SpellAuras.cpp:6760-6761), but that is an update FIELD batched to the end of the world
          // tick, while SMSG_EMOTE is a direct send — so the first tick's eat emote reliably beats
          // the sit state to the client. Deciding on `standState` at arrival therefore saw 0 and
          // played the STANDING drink/eat once before the character sat down, which is the
          // "sips while standing, then sits" report. Re-check after one server-update window
          // instead; a genuine standing /eat text emote is merely delayed imperceptibly.
          // (Same class of bug as the SMSG_PET_SPELLS possession-flag race.)
          setTimeout(() => { if (standStateOf(ev.guid) === 0) play(); }, 300);
        }
      }
    }
    if (ev.kind === 'swingError') {
      const race = playerEntity?.race ?? currentCharacter?.race;
      const gender = playerEntity?.gender ?? currentCharacter?.gender;
      soundManager.playVocalError(race, gender, ev.reason === 'notInRange' ? 'outOfRange' : 'invalidTarget');
    }
    actionCombat.handleCombatEvent(ev);
    tradeSkillPanel.handleCombatEvent(ev, playerGuid);
  };

  targeting = new TargetingController({
    canvas: renderer.domElement,
    camera,
    cursor: inventoryCursor,
    debugToolsEnabled,
    elements: {
      gameTooltip,
      entityDebug: entityDebugEl,
      entityDebugTitle,
      entityDebugContent,
      entityDebugCopy,
      entityDebugClose,
    },
    getEntityRenderer: () => entityRenderer,
    isWorldPointBlockedByWmo,
    getWorld: () => activeWorld ?? undefined,
    getPlayerEntity: currentPlayerEntity,
    getPlayerLocalPosition: () => charPos,
    getSelectedTargetGuid: () => selectedTargetGuid,
    setSelectedTargetGuid: (guid) => { selectedTargetGuid = guid; },
    getAutoAttacking: () => autoAttacking,
    stopAttack,
    attackTarget,
    targetPendingSpell: (entity) => actionCombat.targetPendingWorldEntity(entity),
    refreshTargetFrame,
    escapeHtml,
    nameForEntity,
    raceName: (race) => RACES[race] ?? '',
    className: (classId) => CLASSES[classId] ?? '',
    inspectionPayload,
    playUi: (name) => soundManager.playUi(name),
  });

  const cycleTabTarget = () => targeting.cycleTabTarget();

  window.addEventListener('keydown', (event) => {
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    if (event.key === 'Enter' && currentCharacter && activeWorld) {
      event.preventDefault();
      chatUi.openInput();
      return;
    }
    // Bindings.xml:105 — TOGGLECOMBATLOG runs ToggleCombatLog(), which shows/hides ChatFrame2 and
    // CombatLogButtons together (CombatLog.lua:2-15). Vanilla ships it unbound, so this only fires
    // once the player assigns a key in the Key Bindings panel.
    if (keyBindings.matches(event, 'TOGGLECOMBATLOG') && currentCharacter && !gameMenu.isOpen()) {
      event.preventDefault();
      const shown = combatLog.toggle();
      log(`combat log: ${shown ? 'shown' : 'hidden'}`);
      return;
    }
    if (keyBindings.matches(event, 'TOGGLESHEATH') && currentCharacter && activeWorld && !gameMenu.isOpen()) {
      event.preventDefault();
      setPlayerSheathState(playerSheathState === 0 ? 1 : 0); // vanilla Z: toggle sheathed <-> melee
      return;
    }
    if (event.code === 'Escape') {
      // CinematicFrame.xml binds ESCAPE straight to StopCinematic() and sits above every other
      // frame, so it wins the key before the world map or the game menu ever see it.
      if (cinematicPlayer.isPlaying()) {
        event.preventDefault();
        cinematicPlayer.skip();
        return;
      }
      // StaticPopupDialogs["CAMP"] has hideOnEscape = 1, and its OnHide runs CancelLogout() while
      // timeleft > 0 (StaticPopup.lua:375-379) — so ESC during the window aborts the logout.
      if (logoutTimer.isPending()) {
        event.preventDefault();
        logoutTimer.cancel();
        return;
      }
      if (worldMap.isOpen()) {
        event.preventDefault();
        worldMap.close();
        syncWorldMapFullScreen();
        microWorld.classList.remove('is-open');
        soundManager.playUi('MINIMAPCLOSE');
        return;
      }
      if (currentCharacter || gameMenu.isOpen()) {
        event.preventDefault();
        gameMenu.handleEscape();
        return;
      }
      setTarget(undefined);
      updateEntityDebug();
      return;
    }
    const raidTargetKey = keyBindings.raidTargetIndex(event);
    if (gameMenu.isOpen()) {
      event.preventDefault();
      return;
    } else if (raidTargetKey !== undefined) {
      event.preventDefault();
      if (selectedTargetGuid) activeWorld?.setRaidTarget(selectedTargetGuid, raidTargetKey);
    } else if (keyBindings.matches(event, 'TARGETNEARESTENEMY')) {
      event.preventDefault(); // keep focus in the game, vanilla-style target cycling
      cycleTabTarget();
      updateEntityDebug();
    } else if (keyBindings.matches(event, 'ATTACKTARGET')) {
      toggleAttack(); // vanilla "Attack Target" keybind
    } else {
      const slot = keyBindings.actionSlot(event);
      if (slot >= 0) useAction(slot);
    }
  });
  log('debug: click = select, right-click/T = attack, Tab = cycle, 1-9/0/-/= = action bar, Esc = main menu');

  const isLocalInTile = (rx: number, ry: number) => Math.abs(rx) <= TILE_HALF + 3 && Math.abs(ry) <= TILE_HALF + 3;

  const overview = () => {
    const cur = tileLoader.currentTile;
    if (!cur) return;
    // ?eye=x,y,z&look=x,y,z — place the preview camera in render space (QA, e.g. framing a building).
    const sp = new URLSearchParams(location.search);
    const eye = sp.get('eye'), look = sp.get('look');
    if (eye && look) {
      const [ex, ey, ez] = eye.split(',').map(Number);
      const [lx, ly, lz] = look.split(',').map(Number);
      controls.autoRotate = false;
      camera.near = 0.1; camera.updateProjectionMatrix();
      camera.position.set(ex, ey, ez);
      controls.target.set(lx, ly, lz);
      controls.update();
      return;
    }
    controls.autoRotate = true;
    camera.position.set(0, TILE * 0.72, cur.meta.maxHeight + TILE * 0.55);
    controls.target.set(0, 0, (cur.meta.minHeight + cur.meta.maxHeight) / 2);
    controls.update();
  };

  // --- input + walk controllers ---
  const clock = new THREE.Clock();
  const charPos = new THREE.Vector3();
  const movement = new PlayerMovementController({
    camera,
    controls,
    marker,
    playerRoot,
    worldCollision,
    tileIndex: index,
    loadedTiles,
    loadingTiles,
    charPos,
    getWorld: () => activeWorld ?? undefined,
    getCurrentMap: () => currentMap,
    getCurrentTile: () => tileLoader.currentTile,
    setCurrentTile: (tile) => { tileLoader.currentTile = tile; },
    // A running cinematic swallows movement keys the same way vanilla does: CinematicStart parks the
    // player and the server discards movement until CMSG_COMPLETE_CINEMATIC, so letting WASD through
    // would only desync the local position against a server that ignored every step.
    isInputBlocked: (target) => cinematicPlayer.isPlaying() || gameMenu.isOpen() || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement,
    isCameraExternallyOwned: () => cinematicPlayer.isPlaying(),
    sampleHeight,
    sampleLoadedHeight,
    sampleTerrainType,
    sampleWaterLevel,
    localToWorld,
    worldToLocal,
    getTransportFrame: () => {
      const moverGuid = activeWorld?.getControlledMover()?.moverGuid ?? playerGuid;
      const rider = moverGuid === playerGuid
        ? playerEntity
        : moverGuid
          ? activeWorld?.getEntity(moverGuid)
          : undefined;
      if (!rider?.transportGuid || ((rider.flags ?? 0) & 0x02000000) === 0) return undefined;
      const transport = activeWorld?.getEntity(rider.transportGuid);
      const frame = entityRenderer?.transportFrame(rider.transportGuid) ?? transport;
      if (frame?.x === undefined || frame.y === undefined || frame.z === undefined) return undefined;
      return {
        guid: rider.transportGuid,
        x: frame.x,
        y: frame.y,
        z: frame.z,
        o: frame.o ?? 0,
        localX: rider.transportX ?? 0,
        localY: rider.transportY ?? 0,
        localZ: rider.transportZ ?? 0,
        localO: rider.transportO ?? 0,
      };
    },
    ensureTileNeighborhood,
    updateInteriorLighting,
    applyLighting,
    updateAreaTriggers,
    log,
    collisionLogEnabled: () => collisionLogEnabled,
  });
  installWorldCanvasGestures(
    renderer.domElement,
    (steps) => movement.zoomCameraSteps(steps),
    () => !!(globalThis as Record<string, unknown>).__wowFreeCamEnabled,
  );
  (globalThis as Record<string, unknown>).__wowZoomDebug = () => movement.getCameraZoomState(); // QA
  const applyControlledMover = () => {
    const moverGuid = controlledMoverGuid ?? playerGuid;
    const isPlayer = !moverGuid || moverGuid === playerGuid;
    entityRenderer?.setLocallyControlledMover(isPlayer ? undefined : moverGuid);
    const frame = !isPlayer && moverGuid ? entityRenderer?.controlFrame(moverGuid) ?? undefined : undefined;
    movement.setControlledMover(isPlayer ? undefined : moverGuid, frame);
    controlledMoverBoundGuid = frame ? moverGuid : undefined;
    // If the server selected a non-player mover before its create/update reached visibility, keep
    // input locked until onEntity can bind the real render root. Never move the player as fallback.
    movement.setClientControlAllowed(controlledMovementAllowed && (isPlayer || !!frame));
    const entity = moverGuid
      ? moverGuid === playerGuid ? playerEntity : activeWorld?.getEntity(moverGuid)
      : undefined;
    if (entity?.speeds) {
      for (const kind of ['walk', 'run', 'runBack', 'swim', 'swimBack', 'turnRate'] as const) {
        movement.setServerSpeed(kind, entity.speeds[kind]);
      }
    }
    movement.setServerRooted(entity?.rooted ?? false);
    movement.setStunned(((entity?.unitFlags ?? 0) & 0x00040000) !== 0); movement.setFeatherFalling(entity?.featherFalling ?? false);
    movement.setTaxiFlight(isPlayer && !!entity?.taxiFlight, isPlayer ? entity?.spline : undefined);
  };
  const normalizeYaw = (angle: number) => movement.normalizeYaw(angle);
  const sendHeartbeat = (force = false) => movement.sendHeartbeat(force);
  worldAudio = new WorldAudioController({
    sound: soundManager,
    getPlayerGuid: () => controlledMoverGuid ?? playerGuid,
    getPlayerPosition: () => movement.charPos,
    getEntity: (guid) => guid === playerGuid ? playerEntity : entityRenderer?.inspect(guid)?.entity,
    getEntityPosition: (guid) => guid === playerGuid ? charPos : entityRenderer?.localPositionOf(guid) ?? undefined,
    sampleTerrainType,
    sampleWaterLevel,
    getWeaponInfo: (guid) => {
      if (guid === playerGuid) {
        const info = lastInventory?.equipment.find((slot) => slot.index === 15)?.item?.info;
        return info ? { subclass: info.subclass, material: info.material } : undefined;
      }
      // Every other attacker used to return undefined and collapse onto impact profile '13', which
      // plays the SAME sound id for a normal and a critical hit — one sound for every NPC and
      // remote player in the game. Creatures publish their weapon in UNIT_VIRTUAL_ITEM_INFO
      // (subclass byte) and remote players in PLAYER_VISIBLE_ITEM.
      const entity = activeWorld?.getEntity(guid);
      if (entity?.weaponSubclass !== undefined || entity?.weaponMaterial !== undefined) {
        return { subclass: entity.weaponSubclass, material: entity.weaponMaterial };
      }
      const mainHand = resolveWeapons(entity?.visibleEquipment).mainHand;
      return mainHand ? { subclass: mainHand.subclass, material: mainHand.material } : undefined;
    },
  });
  const updateMovement = (dt: number) => movement.updateFly(dt);
  const updateWalk = (dt: number) => {
    movement.updateWalk(dt);
    const moverGuid = controlledMoverGuid ?? playerGuid;
    const moverEntity = moverGuid === playerGuid
      ? playerEntity
      : moverGuid
        ? activeWorld?.getEntity(moverGuid)
        : undefined;
    worldAudio.updateMovement({
      position: movement.charPos,
      animation: movement.getPlayerAnimState(),
      grounded: movement.isGrounded(),
      swimming: movement.isSwimming(),
      groundSource: movement.getGroundSource(),
      terrainType: movement.getGroundTerrainType(),
      waterLevel: sampleWaterLevel(movement.charPos.x, movement.charPos.y),
      displayId: moverEntity?.displayId,
      race: moverEntity?.race ?? currentCharacter?.race,
      gender: moverEntity?.gender ?? currentCharacter?.gender,
    });
  };

  const clearPlayerForm = () => {
    if (playerForm) {
      playerRoot.remove(playerForm.group);
      playerForm.dispose();
      playerForm = null;
      log('player transform: restored native display');
    }
    playerFormLoadingId = 0;
    if (playerModelGroup) playerModelGroup.visible = true;
    if (playerMount) playerMount.group.visible = true;
  };

  // DISPLAYID/NATIVEDISPLAYID is the shared render contract for druid forms, Ghost Wolf,
  // Polymorph and arbitrary SPELL_AURA_TRANSFORM effects. Keep the normal composited character
  // loaded but hidden so aura removal can restore it immediately without an async visual pop.
  const syncPlayerForm = () => {
    const displayId = playerEntity?.displayId ?? 0;
    const nativeDisplayId = playerEntity?.nativeDisplayId ?? 0;
    const formDisplayId = displayId && nativeDisplayId && displayId !== nativeDisplayId ? displayId : 0;
    if (!formDisplayId) {
      if (playerForm || playerFormLoadingId) clearPlayerForm();
      return;
    }
    if (playerForm?.displayId === formDisplayId || playerFormLoadingId === formDisplayId) return;
    playerFormLoadingId = formDisplayId;
    void entityRenderer?.createDisplayRig(formDisplayId).then((rig) => {
      if (playerFormLoadingId !== formDisplayId) { rig?.dispose(); return; }
      playerFormLoadingId = 0;
      if (!rig) {
        log(`player transform display ${formDisplayId}: no baked display asset`);
        return;
      }
      if (playerForm) {
        playerRoot.remove(playerForm.group);
        playerForm.dispose();
      }
      rig.group.userData.isPlayerForm = true;
      // OBJECT_FIELD_SCALE_X carries vMaNGOS's authoritative transform scale (0.8 for Cat,
      // Travel, Aqua and Ghost Wolf). Fall back to the raw display scale only if the field has not
      // arrived yet.
      rig.group.scale.setScalar(playerEntity?.scale ?? rig.scale);
      playerForm = {
        group: rig.group,
        animator: rig.animator,
        dispose: rig.dispose,
        displayId: formDisplayId,
        animationIds: rig.animationIds,
      };
      if (playerModelGroup) playerModelGroup.visible = false;
      if (playerMount) playerMount.group.visible = false;
      playerRoot.add(rig.group);
      log(`player transform: display ${formDisplayId}`);
    });
  };

  // Track our own UNIT_FIELD_MOUNTDISPLAYID: build/tear down the mount rig under
  // playerRoot. Called once per frame from updatePlayerAnimation (cheap when idle).
  const syncPlayerMount = () => {
    const mountId = playerEntity?.mountDisplayId ?? 0;
    if (!mountId) {
      if (playerMount) {
        playerRoot.remove(playerMount.group);
        playerMount.dispose();
        playerMount = null;
        if (playerModelGroup) {
          playerModelGroup.matrixAutoUpdate = true;
          playerModelGroup.position.set(0, 0, 0);
          playerModelGroup.quaternion.identity();
          playerModelGroup.updateMatrix();
        }
        log('dismounted');
      }
      playerMountLoadingId = 0;
      return;
    }
    if (playerMount?.displayId === mountId || playerMountLoadingId === mountId) return;
    playerMountLoadingId = mountId;
    void entityRenderer?.createCreatureRig(mountId).then((rig) => {
      if (playerMountLoadingId !== mountId) { rig?.dispose(); return; }
      playerMountLoadingId = 0;
      if (!rig) { log(`mount display ${mountId}: no creature asset`); return; }
      if (playerMount) { playerRoot.remove(playerMount.group); playerMount.dispose(); }
      rig.group.userData.isPlayerMount = true;
      playerMount = { ...rig, displayId: mountId };
      playerRoot.add(rig.group);
      log(`mounted: creature display ${mountId}`);
    });
  };

  // Mount locomotion: the mount plays the movement anims the rider would have used.
  const MOUNT_ANIM_BY_STATE: Record<string, number> = {
    stand: 0, walk: 4, run: 5, jump: 38, walkBack: 13, turnLeft: 11, turnRight: 12, strafeLeft: 5, strafeRight: 5,
  };

  // UNIT_FIELD_BYTES_1 byte 0 (UnitStandStateType, UnitDefines.h) -> the idle AnimationData sequence.
  // vMaNGOS forces UNIT_STAND_STATE_SIT on any AURA_INTERRUPT_STANDING_CANCELS aura apply
  // (SpellAuras.cpp) — i.e. eating and drinking sit you down — and on /sit. 97 SitGround, 100 Sleep,
  // 102/103/104 SitChair Low/Med/High, 115 KneelLoop; all baked on every 1.12 player model.
  const STAND_STATE_ANIM: Record<number, number> = { 1: 97, 2: 97, 3: 100, 4: 102, 5: 103, 6: 104, 8: 115 };

  // Conversation talk gestures (AnimationData: 60 EmoteTalk, 64 EmoteTalkExclamation, 65
  // EmoteTalkQuestion). Derived from the wall clock so it is stateless: a 4.2s cycle that talks for
  // the first 2.8s then pauses (Stand) for 1.4s, rotating the variant each cycle. Returns 0 for the
  // pause beat so the player briefly settles between gestures instead of gesticulating nonstop.
  const CONVERSATION_TALK_ANIMS = [60, 64, 65];
  const conversationTalkAnim = (nowMs: number): number => {
    const cycleMs = 4200;
    const talkMs = 2800;
    if (nowMs % cycleMs >= talkMs) return 0;
    return CONVERSATION_TALK_ANIMS[Math.floor(nowMs / cycleMs) % CONVERSATION_TALK_ANIMS.length];
  };

  // Blob shadows are SUN shadows: they project onto the ground, not onto the unit's feet, and there
  // is nothing to cast them once the sun is zeroed inside a WMO interior. Publish the shared sun
  // scale (same value that drives the M2 sun term) and re-seat the player's own disc on the terrain
  // so it stays on the ground through jumps and falls instead of riding up with the body.
  const updateBlobShadows = () => {
    setBlobShadowSunScale(indoorSunScale);
    updateBlobShadowLod(playerBlobShadow, charPos.x, charPos.y, charPos.z, 0, true, sampleHeight);
  };

  const updatePlayerAnimation = (dt: number) => {
    syncPlayerForm();
    if (!playerAnimator && !playerForm?.animator) return;
    const now = performance.now();
    if (playerCombatAnimId !== undefined && now >= playerCombatUntil) clearPlayerCombatAnim();

    const playerDead = (playerEntity?.health ?? 1) <= 0 && !!playerEntity?.maxHealth;
    if (playerForm) {
      const formAnim = playerDead
        ? 1
        : playerCombatAnimId !== undefined
          ? playerCombatAnimId
          : MOUNT_ANIM_BY_STATE[movement.getPlayerAnimState()] ?? 0;
      playerForm.animator?.update(
        dt,
        resolveAnimId(formAnim, playerForm.animationIds),
        camera,
        playerForm.group,
      );
      return;
    }
    if (!playerAnimator) return;

    if (playerDead && playerAnimator.updateAnimationId) {
      playerAnimator.updateAnimationId(dt, 1, camera, playerRoot);
      return;
    }

    syncPlayerMount();
    if (playerMount) {
      const mountAnimId = MOUNT_ANIM_BY_STATE[movement.getPlayerAnimState()] ?? 0;
      playerMount.animator?.update(dt, mountAnimId, camera, playerMount.group);
      if (playerAnimator.updateAnimationId) {
        playerAnimator.updateAnimationId(dt, resolveAnimId(91, playerAnimIds), camera, playerRoot); // 91 = Mount pose
      }
      if (playerModelGroup && playerMount.animator?.getAttachmentMatrix?.(0, playerMountSeat)) {
        playerModelGroup.matrixAutoUpdate = false;
        playerModelGroup.matrix.copy(playerMountSeat);
      }
      return;
    }
    if (!movement.isGrounded() && playerCombatAnimId !== undefined) clearPlayerCombatAnim();
    if (movement.getPlayerMoving()) {
      // Moving interrupts a pending cast in vanilla. This is driven by the AUTHORITATIVE cast state
      // (isCasting), not by whether a body pose happens to be set: some spells have no precast anim
      // (getCastAnim -> null) yet still run a cast bar + a sustained cast sound, and an item cast
      // (e.g. Hearthstone) only pins its pose to the player after the SMSG_SPELL_START caster-GUID
      // fix. Clearing the local pose alone left the sustained sound and bar running after you walked
      // out of the cast — the "sound gets stuck" bug. Tear the whole cast down: tell the server
      // (CMSG_CANCEL_CHANNELLING for channels, CMSG_CANCEL_CAST otherwise), stop the local sustain
      // sound and hide the bar. hideCastBar() flips isCasting() false, so this only fires once.
      const interruptedAuthoritativeCast = actionCombat.isCasting();
      if (interruptedAuthoritativeCast) {
        if (actionCombat.isChannelling()) activeWorld?.cancelChanneling();
        else activeWorld?.cancelCast();
        if (playerGuid) spellVisuals.stopCasterSounds(playerGuid);
        actionCombat.hideCastBar();
      }
      // Preserve successful instant SPELL_GO torso/arm poses; discard only interrupted casts and state emotes.
      if ((playerCombatKind === 'emoteState' || (interruptedAuthoritativeCast && playerCombatKind === 'cast')) && playerCombatAnimId !== undefined) {
        clearPlayerCombatAnim();
      }
    }
    const animState = movement.getPlayerAnimState();
    if (playerCombatAnimId !== undefined && playerAnimator.updateAnimationId) {
      if ((playerCombatKind === 'reaction' || playerCombatKind === 'cast') && movement.getPlayerMoving() && playerAnimator.updateUpperBody) playerAnimator.updateUpperBody(dt, animState, playerCombatAnimId, camera, playerRoot);
      else playerAnimator.updateAnimationId(dt, playerCombatAnimId, camera, playerRoot);
      return;
    }
    // Sitting / sleeping / kneeling from the server stand state (UNIT_FIELD_BYTES_1). Eating and
    // drinking sit you down (vMaNGOS forces SIT on the food/drink aura apply), as does /sit. Render
    // the seated idle instead of Stand when not moving; an eat one-shot above overlays the chewing
    // and clears back to this between ticks. Moving clears the state server-side (animState leaves
    // 'stand'), so this never fights locomotion.
    const standAnim = animState === 'stand' ? STAND_STATE_ANIM[playerEntity?.standState ?? 0] : undefined;
    if (standAnim !== undefined && playerAnimator.updateAnimationId) {
      playerAnimator.updateAnimationId(dt, resolveAnimId(standAnim, playerAnimIds), camera, playerRoot);
      return;
    }
    // Talking to an NPC: while a face-to-face dialogue window is open (gossip/quest/vendor/trainer)
    // and the player is standing idle, loop talk-gesture emotes like the real client, which also
    // turns the NPC to face you (see the interaction handler). AnimationData: EmoteTalk 60,
    // EmoteTalkExclamation 64, EmoteTalkQuestion 65 — all baked on every 1.12 player model. A
    // combat/cast/emote one-shot or any locomotion already took precedence and returned above, so
    // this only fires when genuinely idle in conversation; it stops on its own when the window closes
    // or the player moves (which drops animState off 'stand').
    if (animState === 'stand' && npcInteraction?.isConversing() && playerAnimator.updateAnimationId) {
      const talkAnim = conversationTalkAnim(now);
      if (talkAnim > 0) {
        playerAnimator.updateAnimationId(dt, resolveAnimId(talkAnim, playerAnimIds), camera, playerRoot);
        return;
      }
      // talkAnim === 0 is a deliberate pause beat — fall through to the normal idle pose below.
    }
    // Combat-ready idle only while weapons are drawn or fighting — sheathed characters stand with
    // the plain Stand pose like vanilla. The pose follows the drawn weapon set: sheath state 1
    // picks ReadyUnarmed/Ready1H/Ready2H/Ready2HL from the main hand, state 2 picks
    // ReadyBow/ReadyRifle/ReadyThrown from the ranged slot (combat/attack-anims.ts).
    if (animState === 'stand' && playerAnimator.updateAnimationId) {
      const weapons = currentPlayerWeapons();
      const ready = readyStanceAnim(playerSheathState, weapons.mainHand, weapons.ranged);
      if (ready !== undefined) {
        playerAnimator.updateAnimationId(dt, resolveAnimId(ready, playerAnimIds), camera, playerRoot);
        return;
      }
    }
    playerAnimator.update(dt, animState, camera, playerRoot);
  };

  installWorldEntityEvents({
    upsert: entity => { entityRenderer?.upsert(entity); worldAudio.handleEntity(entity); },
    remove: guid => { entityRenderer?.remove(guid); worldAudio.removeEntity(guid); spellVisuals.stopCasterSounds(guid); spellVisuals.removeEntityAuraStates(guid); },
    speed: (guid, kind, speed) => { if (guid === (controlledMoverGuid ?? playerGuid)) movement.setServerSpeed(kind, speed); },
  });
  if (api === 'WebGL2') xrRuntime = new XrRuntime({ renderer: renderer as THREE.WebGLRenderer, scene, camera, controls, movement, playerRoot, collision: worldCollision,
    ready: () => !!activeWorld && !!currentCharacter && spawned && !cinematicPlayer.isPlaying(),
    avatarAllowed: () => !playerForm && (playerEntity?.health ?? 1) > 0, eyeHeight: () => movement.getCameraPivotHeight() + (playerMount && playerModelGroup ? Math.max(0, playerModelGroup.matrix.elements[14]) : 0), twoHanded: () => currentPlayerWeapons().mainHand?.inventoryType === 17, resetClock: () => { clock.getDelta(); },
    attack: () => { if (selectedTargetGuid && !autoAttacking) attackTarget(selectedTargetGuid); }, toggleAttack, cycleTarget: cycleTabTarget,
    pick: (pickCamera, interact) => pickXrWorld(pickCamera, interact, { renderer: entityRenderer, collision: worldCollision, player: charPos,
      select: setTarget, pendingSpell: entity => actionCombat.targetPendingWorldEntity(entity), interact: guid => activeWorld?.interact(guid) }), log,
  });

  window.addEventListener('vanillagl-adaptive-quality', resizeWorldRenderer);
  installViewportResize(() => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    resizeWorldRenderer();
    applyBrowserUiScale(appliedVideoCvars);
  });
  window.addEventListener('pagehide', () => activeWorld?.close({ logout: true }));
  const releaseMovementInput = () => {
    if (!movement.clearInput()) return;
    try {
      sendHeartbeat(true);
    } catch (e) {
      log(`world: movement stop failed (${(e as Error).message})`);
    }
  };
  const resumeWorldNetwork = () => {
    if (!activeWorld) return;
    try {
      activeWorld.resumeNetwork();
      // Chrome can throttle hidden tabs heavily after a few minutes. When the game becomes active
      // again, publish one authoritative position heartbeat so the world and other clients catch up.
      sendHeartbeat(true);
    } catch (e) {
      log(`world: resume failed (${(e as Error).message})`);
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseMovementInput();
    else resumeWorldNetwork();
  });
  window.addEventListener('blur', releaseMovementInput);
  window.addEventListener('focus', resumeWorldNetwork);

  // --- standalone tile preview: ?tile=<key> (QA, no login) — verifies baked terrain, doodads,
  // grass and WMOs for one tile (+ neighbors). Auto-orbit overview, or ?eye=x,y,z&look=x,y,z. ---
  // --- starter-zone preview: ?zone=elwynn-forest[&scope=preview|complete][&camera=0|camera-slug]
  // Loads manifest-validated starter zone tiles without requiring a live world login.
  const query = new URLSearchParams(location.search);

  // --- spell-visual QA harness: ?spelltest=<modelPath[,modelPath...]>[&dur=ms] ---
  // Minimal isolated scene (no terrain/WMO load) to verify the M2 particle/ribbon renderer.
  const spellTestParam = query.get('spelltest');
  if (spellTestParam) {
    skyScene.background = new THREE.Color(0x0a0d14);
    scene.fog = null;
    const grid = new THREE.GridHelper(24, 24, 0x2a4a6a, 0x1a2a3a);
    grid.rotation.x = Math.PI / 2; // default grid is XZ (Y-up); rotate into XY for our Z-up world
    scene.add(grid);
    const models = spellTestParam.split(',').map((s) => s.trim()).filter(Boolean);
    const dur = Number(query.get('dur') ?? 4000);
    camera.position.set(5, -5, 3);
    controls.target.set(0, 0, 1.2);
    controls.autoRotate = false;
    controls.update();
    let lastSpawn = -1e9;
    const stClock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      const dt = Math.min(stClock.getDelta(), 0.05);
      const now = performance.now();
      if (now - lastSpawn > dur + 800) {
        lastSpawn = now;
        void Promise.all(models.map((m, i) => {
          const x = (i - (models.length - 1) / 2) * 2.5;
          return spellVisuals.spawnDebug(m, x, dur);
        })).then(() => { document.documentElement.dataset.spellTestReady = 'true'; });
      }
      spellVisuals.update(dt);
      modelOpacity.update(dt);
      worldDoodadEffects.update(dt);
      updateTextureAnimations(dt);
      controls.update();
      renderWorld(scene, camera);
    });
    log(`spell test: ${models.join(', ')} (dur=${dur}ms)`);
    return;
  }

  const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const selectStarterZone = (value: string) => {
    if (!starterZones) return null;
    const wanted = slugify(value);
    return (
      starterZones.zones.find((zone) => zone.slug === wanted || slugify(zone.name) === wanted || String(zone.zoneId) === value) ??
      null
    );
  };
  const selectStarterCamera = (zone: StarterZoneEntry, value: string | null) => {
    const cameras = zone.validationCameras ?? [];
    if (!cameras.length) return null;
    if (!value) return cameras[0];
    const byIndex = Number(value);
    if (Number.isInteger(byIndex) && byIndex >= 0 && byIndex < cameras.length) return cameras[byIndex];
    const wanted = slugify(value);
    return cameras.find((cam) => cam.slug === wanted || slugify(cam.name) === wanted || slugify(cam.zone) === wanted) ?? cameras[0];
  };
  const applyStarterCamera = (cam: StarterZoneCamera) => {
    const [wx, wy, wz] = cam.position;
    const local = worldToLocal(wx, wy);
    const pitch = cam.pitch ?? 0;
    const yaw = cam.yaw ?? 0;
    const forward = new THREE.Vector3(Math.cos(yaw), Math.sin(yaw), 0).normalize();
    const groundZ = sampleHeight(local.x, local.y);
    const subjectZ = Math.max(wz, groundZ) + 2;
    const eyeDistance = 18;
    const lookDistance = 55;
    camera.near = 0.05;
    camera.updateProjectionMatrix();
    camera.position.set(local.x - forward.x * eyeDistance, local.y - forward.y * eyeDistance, subjectZ + 8);
    controls.target.set(
      local.x + forward.x * lookDistance,
      local.y + forward.y * lookDistance,
      subjectZ + Math.sin(pitch) * 20,
    );
    controls.autoRotate = false;
    controls.update();
  };

  const zoneParam = query.get('zone') ?? query.get('starter-zone');
  if (zoneParam) {
    const zone = selectStarterZone(zoneParam);
    if (!zone) {
      log(`starter zone preview: "${zoneParam}" not found in /terrain/starter-zones.json`);
      return;
    }
    const scope = query.get('scope') === 'complete' ? 'complete' : 'preview';
    const tileIds = scope === 'complete' ? zone.completeZoneRequiredTiles : zone.previewRequiredTiles;
    const tileKeys = tileIds.map((tileId) => `${zone.mapDir}_${tileId}`);
    const entries = tileKeys.map((key) => index.find((entry) => entry.key === key)).filter((entry): entry is TileEntry => !!entry);
    const missing = tileKeys.filter((key) => !index.some((entry) => entry.key === key));
    const starterCamera = selectStarterCamera(zone, query.get('camera'));
    const cameraTile = starterCamera
      ? tileForCharacter(index, {
          map: zone.mapId,
          x: starterCamera.position[0],
          y: starterCamera.position[1],
          z: starterCamera.position[2],
        })
      : undefined;
    if (cameraTile && !entries.some((entry) => entry.key === cameraTile.key)) entries.unshift(cameraTile);
    const anchor = cameraTile ?? entries[Math.floor(entries.length / 2)] ?? entries[0];
    if (!anchor) {
      log(`starter zone preview: no baked tiles available for ${zone.name} (${scope})`);
      return;
    }

    currentMap = zone.mapId;
    applyLighting(anchor.map, anchor.originX, anchor.originY, (anchor.minHeight + anchor.maxHeight) / 2, true);
    setRenderOrigin(anchor.originX - TILE_HALF, anchor.originY - TILE_HALF);
    const loadedAnchor = await loadTile(anchor);
    tileLoader.currentTile = loadedAnchor;
    await Promise.all(
      entries
        .filter((entry) => entry.key !== anchor.key)
        .map((entry) =>
          loadTile(entry).catch((e) => {
            log(`starter zone ${zone.name}: failed to load ${entry.key} (${(e as Error).message})`);
          }),
        ),
    );
    if (starterCamera) applyStarterCamera(starterCamera);
    else overview();
    const zoneClock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      const dt = Math.min(zoneClock.getDelta(), 0.05);
      entityRenderer?.update(dt, camera);
      spellVisuals.update(dt);
      modelOpacity.update(dt);
      worldDoodadEffects.update(dt);
      controls.update();
      renderWorld(scene, camera);
    });
    if (missing.length) {
      log(`starter zone ${zone.name}: ${missing.length} manifest tile(s) not baked yet (${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', ...' : ''})`);
    }
    log(`starter zone preview: ${zone.name} (${scope}) loaded ${entries.length}/${tileKeys.length} baked tile(s)`);
    if (starterCamera) log(`starter camera: ${starterCamera.zone} - ${starterCamera.name}`);
    return;
  }

  const tileParam = query.get('tile');
  if (tileParam) {
    const entry = index.find((e) => e.key === tileParam);
    if (!entry) {
      log(`tile preview: "${tileParam}" not in terrain index`);
      return;
    }
    currentMap = entry.map;
    applyLighting(entry.map, entry.originX, entry.originY, (entry.minHeight + entry.maxHeight) / 2, true);
    setRenderOrigin(entry.originX - TILE_HALF, entry.originY - TILE_HALF);
    await ensureTileNeighborhood(entry);
    overview(); document.documentElement.dataset.tilePreviewReady = entry.key;
    const tileClock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      const dt = Math.min(tileClock.getDelta(), 0.05);
      spellVisuals.update(dt);
      modelOpacity.update(dt);
      worldDoodadEffects.update(dt);
      updateWaterTime(dt);
      updateGrassTime(dt);
      updateTextureAnimations(dt);
      weatherRenderer.update(dt, camera);
      entityRenderer?.update(dt, camera); // QA: synthetic entities (e.g. mount rigs) animate in the harness
      // The preview has to cull like the game does, or ?tile= silently measures a different
      // renderer than the one players get — which is how the missing doodad cull went unnoticed.
      lastDoodadCullStats = updateDoodadCulling(
        camera,
        smallCullForWorldDetail(worldDetail),
        Number(appliedVideoCvars.DistCull) || videoFarclip,
      );
      controls.update();
      // A no-login tile preview has no movement controller to update charPos. Use the preview
      // camera as its observer so ?eye=... can exercise the exact WMO interior membership path
      // and catch sun leaks in enclosed rooms instead of silently remaining outdoors forever.
      charPos.copy(camera.position);
      updateInteriorLighting();
      const previewWorld = localToWorld(charPos.x, charPos.y);
      applyLighting(currentMap, previewWorld.x, previewWorld.y, charPos.z);
      renderWorld(scene, camera);
    });
    log(`tile preview: ${entry.key}`);
    return;
  }

  // --- isolated creature inspector: ?creature=<displayId> (QA, no login) — verifies the deduped
  // creatures/{display,models,tex} format renders + animates a single mob standalone. ?canim=N. ---
  const creatureParam = new URLSearchParams(location.search).get('creature');
  if (creatureParam) {
    scene.fog = null;
    skyScene.background = new THREE.Color(0x2a3038);
    const previewRenderer = new WorldEntityRenderer({
      scene,
      worldToLocal: () => ({ x: 0, y: 0 }),
      sampleHeight: () => 0,
      getTextureAnisotropy: () => textureAnisotropy,
    });
    const fakeMob = {
      guid: 'preview', typeId: 3 /* UNIT */, typeName: 'preview', x: 0, y: 0, z: 0, o: 0,
      // scale deliberately unset: the renderer then falls back to the baked
      // modelScale×displayScale product, i.e. the creature's NATIVE in-game size.
      displayId: Number(creatureParam), fields: new Map(), updatedAt: 0,
    } as unknown as WorldEntity;
    previewRenderer.upsert(fakeMob);
    const portraitPreview = query.get('portrait') === '1';
    let portrait: LiveUnitPortrait | undefined;
    if (portraitPreview) {
      const portraitHost = document.createElement('div');
      portraitHost.style.cssText =
        'position:fixed;left:24px;top:24px;width:148px;height:148px;z-index:50;' +
        'border-radius:50%;background:#05070a;box-shadow:0 0 0 3px #9b7a26,0 0 0 5px #17120a;';
      document.body.appendChild(portraitHost);
      portrait = new LiveUnitPortrait(portraitHost, 'player');
      portrait.canvas.style.cssText += ';left:42px;top:42px;';
    }
    camera.near = 0.05;
    camera.updateProjectionMatrix();
    camera.position.set(0, -4, 2);
    controls.target.set(0, 0, 1);
    controls.autoRotate = new URLSearchParams(location.search).get('rot') === null;
    controls.autoRotateSpeed = 2;
    controls.update();
    const cclock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      previewRenderer.update(Math.min(cclock.getDelta(), 0.05));
      portrait?.render(previewRenderer.portraitModel('preview'));
      controls.update();
      renderWorld(scene, camera);
    });
    log(`creature preview: display ${creatureParam}`);
    return;
  }

  // --- isolated model inspector: ?inspect=<race>_<gender>[&anim=N] (QA, no login/world) ---
  const inspectParam = new URLSearchParams(location.search).get('inspect');
  if (inspectParam) {
    const inspectQs = new URLSearchParams(location.search);
    const inspectNumber = (name: string, fallback: number) => {
      const raw = inspectQs.get(name);
      if (raw === null) return fallback;
      const value = Number(raw);
      return Number.isFinite(value) ? value : fallback;
    };
    const [race, gender] = inspectParam.split('_').map(Number);
    // ?equip=684,1184 -> composite those ItemDisplayInfo armor items (verify clothes without login).
    const equipParam = inspectQs.get('equip');
    // `equip=684,1184` composites armor; `equip=1542:21,18730:14` also passes inventoryType so held
    // items (weapon=21, shield=14) mount via the attachment filter (QA the sword/shield render).
    const equipment = equipParam
      ? equipParam.split(',').map((v) => {
          const [id, inv, sheath] = v.trim().split(':');
          const parsedSheath = sheath === undefined ? undefined : Number(sheath);
          return {
            displayInfoId: Number(id),
            inventoryType: Number(inv ?? 0) || 0,
            sheath: parsedSheath !== undefined && Number.isFinite(parsedSheath) ? parsedSheath : undefined,
          };
        }).filter((e) => Number.isFinite(e.displayInfoId))
      : [];
    const fake = {
      guid: '0', name: `inspect ${inspectParam}`, race, classId: 1, gender,
      level: 1, zone: 0, map: 0, x: 0, y: 0, z: 0,
      skin: inspectNumber('skin', 0),
      face: inspectNumber('faceId', 0),
      hairStyle: inspectNumber('hair', 0),
      hairColor: inspectNumber('hairColor', 0),
      facialHair: inspectNumber('facial', 0),
      equipment,
    } as unknown as CharacterInfo;
    // Visual QA helper: inspect the same equipment in-hand without logging into a realm.
    // The default remains sheathed so existing model captures are unchanged.
    if (inspectQs.has('drawn')) playerSheathState = 1;
    scene.fog = null; skyScene.background = new THREE.Color(0x2a3038);
    const ok = await loadPlayerModel(fake);
    modelOpacity.setLayer(fake.guid, 'qa-inspect', inspectNumber('opacity', 1), 0);
    // debug: ?atlas draws the composed 256x256 body canvas full-screen (768px, 32px grid) so the
    // overlay placement is directly inspectable instead of inferred from the rendered head.
    if (new URLSearchParams(location.search).get('atlas') !== null) {
      const src = (window as unknown as { __bodyCanvas?: HTMLCanvasElement }).__bodyCanvas;
      const big = document.createElement('canvas');
      big.width = 768;
      big.height = 768;
      big.style.cssText = 'position:fixed;left:8px;top:8px;z-index:9999;image-rendering:pixelated;background:#000;border:2px solid #0f0';
      document.body.appendChild(big);
      const bctx = big.getContext('2d')!;
      bctx.imageSmoothingEnabled = false;
      if (src) bctx.drawImage(src, 0, 0, 768, 768);
      bctx.strokeStyle = 'rgba(0,255,0,0.35)';
      bctx.fillStyle = '#0f0';
      bctx.font = '11px monospace';
      for (let i = 0; i <= 256; i += 32) {
        const p = (i / 256) * 768;
        bctx.beginPath();
        bctx.moveTo(0, p); bctx.lineTo(768, p);
        bctx.moveTo(p, 0); bctx.lineTo(p, 768);
        bctx.stroke();
        bctx.fillText(`y${i}`, 2, p + 11);
        bctx.fillText(`x${i}`, p + 1, 11);
      }
      if (inspectQs.get('capture') !== null) {
        const atlasCapture = document.createElement('img');
        atlasCapture.id = 'model-atlas-capture';
        atlasCapture.alt = `Character appearance atlas ${inspectParam}`;
        atlasCapture.src = big.toDataURL('image/png');
        atlasCapture.style.cssText = 'position:fixed;inset:0;z-index:10000;width:100vw;height:100vh;object-fit:contain;background:#111';
        document.body.appendChild(atlasCapture);
      }
      log(`atlas ${inspectParam} ${ok ? '' : '(load failed)'}`);
      return;
    }
    playerRoot.position.set(0, 0, 0);
    playerRoot.rotation.z = 0;
    marker.visible = false;
    if (inspectQs.get('portrait') === '1') {
      const portraitHost = document.createElement('div');
      portraitHost.style.cssText =
        'position:fixed;left:24px;top:24px;width:148px;height:148px;z-index:50;' +
        'border-radius:50%;background:#05070a;box-shadow:0 0 0 3px #9b7a26,0 0 0 5px #17120a;';
      document.body.appendChild(portraitHost);
      const portrait = new LiveUnitPortrait(portraitHost, 'player');
      portrait.canvas.style.cssText += ';left:42px;top:42px;';
      portrait.render(playerRoot);
    }
    const inspectAnim = Number(inspectQs.get('anim') ?? 0);
    const inspectState: PlayerAnimState =
      inspectAnim === 5 ? 'run' :
      inspectAnim === 4 ? 'walk' :
      inspectAnim === 11 ? 'turnLeft' :
      inspectAnim === 12 ? 'turnRight' :
      inspectAnim === 13 ? 'walkBack' :
      inspectAnim === 37 ? 'jumpStart' :
      inspectAnim === 38 ? 'jump' :
      inspectAnim === 39 ? 'jumpEnd' :
      'stand';
    const captureTimeMs = Math.max(0, Number(inspectQs.get('captureTime') ?? 0) || 0);
    const bindPose = inspectQs.get('bindpose') !== null;
    if (!bindPose) {
      const captureStepMs = 1000 / 60;
      if (inspectQs.get('capture') !== null && captureTimeMs > 0) {
        for (let elapsed = 0; elapsed < captureTimeMs; elapsed += captureStepMs) {
          const step = Math.min(captureStepMs, captureTimeMs - elapsed);
          (playerAnimator as PlayerAnimator | null)?.update(step / 1000, inspectState, camera, playerRoot);
        }
      } else {
        (playerAnimator as PlayerAnimator | null)?.update(0, inspectState, camera, playerRoot);
      }
    }
    // ?face present -> tight head close-up framed on the actual head centroid (robust to any race's
    // posture/snout/hunch); else full-body. ?tz overrides target Z, ?zoom the distance, ?rot the model spin.
    if (new URLSearchParams(location.search).get('face') !== null) {
      const debugWindow = window as unknown as {
        __headCentroid?: { x: number; y: number; z: number };
        __getHeadCentroid?: () => { x: number; y: number; z: number };
      };
      const hc = debugWindow.__getHeadCentroid?.() ?? debugWindow.__headCentroid ?? { x: 0, y: 0, z: 1.7 };
      const rot = Number(new URLSearchParams(location.search).get('rot') ?? 0);
      const cosr = Math.cos(rot), sinr = Math.sin(rot);
      const tx = hc.x * cosr - hc.y * sinr;
      const ty = hc.x * sinr + hc.y * cosr;
      const tz = Number(new URLSearchParams(location.search).get('tz') ?? hc.z); // ?tz nudge
      camera.near = 0.05;
      camera.updateProjectionMatrix();
      const camDist = Number(new URLSearchParams(location.search).get('zoom') ?? 0.85);
      const side = new URLSearchParams(location.search).get('back') !== null ? -1 : 1; // ?back = view from behind
      camera.position.set(tx + cosr * camDist * side, ty + sinr * camDist * side, tz);
      controls.target.set(tx, ty, tz);
    } else {
      camera.position.set(0, -4.2, 1.15);
      controls.target.set(0, 0, 1.0);
    }
    const rotParam = new URLSearchParams(location.search).get('rot');
    if (rotParam !== null) {
      playerRoot.rotation.z = Number(rotParam);
      controls.autoRotate = false;
    } else {
      controls.autoRotate = true;
    }
    controls.autoRotateSpeed = 2.0;
    controls.minDistance = 0.5;
    controls.maxPolarAngle = Math.PI;
    controls.update();
    log(`inspect ${inspectParam}: ${ok ? 'loaded' : 'FAILED'}`);
    // Deterministic visual-regression capture for model QA. WebGL's drawing
    // buffer is transient, so copy the single rendered frame into an image
    // immediately; normal inspector sessions keep their interactive loop.
    if (inspectQs.get('capture') !== null) {
      // ?captureTime=<ms> lets model QA sample deterministic global-loop phases (notably
      // eyelid blinks) instead of always freezing every independent M2 timeline at t=0.
      controls.update();
      renderWorld(scene, camera);
      const capture = document.createElement('img');
      capture.id = 'model-inspector-capture';
      capture.alt = `Character model inspector ${inspectParam}`;
      capture.src = renderer.domElement.toDataURL('image/png');
      capture.style.cssText = 'position:fixed;inset:0;z-index:10000;width:100vw;height:100vh;object-fit:contain;background:#2a3038';
      document.body.appendChild(capture);
      return;
    }
    renderer.setAnimationLoop(() => {
      const dt = Math.min(clock.getDelta(), 0.05);
      playerAnimator?.update(dt, inspectState, camera, playerRoot);
      controls.update();
      renderWorld(scene, camera);
    });
    return;
  }

  // Same-map ("near") teleport relocation. The destination arrives on MSG_MOVE_TELEPORT_ACK
  // (world.onNearTeleport) — graveyard spirit-release routes through here. Cross-map teleports use
  // SMSG_NEW_WORLD instead and are handled by onWorldTransfer, so this never changes currentMap.
  let relocating = false;
  const relocateLocalPlayer = async (worldX: number, worldY: number, worldZ: number, o: number) => {
    // Never disturb the login / world-transfer sequence. A fresh character's first login also
    // triggers a near-teleport (a same-position settle) which must remain a no-op here.
    if (!spawned || relocating) return;
    const here = localToWorld(charPos.x, charPos.y);
    if (here && Math.hypot(here.x - worldX, here.y - worldY) < 2 && Math.abs(charPos.z - worldZ) < 3) return;
    const tile = tileForCharacter(index, { map: currentMap, x: worldX, y: worldY, z: worldZ });
    if (!tile) {
      log(`near-teleport target on unbaked tile (map ${currentMap} @ ${worldX.toFixed(0)}, ${worldY.toFixed(0)}) — skipped`);
      return;
    }
    relocating = true;
    try {
      let local = worldToLocal(worldX, worldY);
      if (!isLocalInTile(local.x, local.y)) {
        // Destination is outside the streamed neighborhood: recenter render origin and load it,
        // mirroring the same-map reposition the world-transfer handler performs.
        showMapLoadingScreen(currentMap);
        updateMapLoadingProgress(15);
        clearTiles();
        setRenderOrigin(tile.originX - TILE_HALF, tile.originY - TILE_HALF);
        applyLighting(currentMap, worldX, worldY, worldZ, true);
        await ensureTileNeighborhood(tile, (loaded, total) =>
          updateMapLoadingProgress(15 + Math.round((loaded / Math.max(1, total)) * 75)));
        local = worldToLocal(worldX, worldY);
        updateMapLoadingProgress(100);
        hideMapLoadingScreen();
      }
      const terrainZ = sampleHeight(local.x, local.y);
      const ground = worldCollision.sampleGround(
        local.x, local.y, worldZ + PLAYER_COLLISION_CYLINDER.maxStepUp, terrainZ,
        { allowWmoBelowTerrain: shouldAllowWmoBelowTerrain(worldZ, terrainZ) },
      );
      charPos.set(local.x, local.y, ground.height);
      playerRoot.position.copy(charPos);
      playerRoot.rotation.z = normalizeYaw(o);
      marker.position.set(charPos.x, charPos.y, charPos.z + 3);
      movement.resetForSpawn(o);
      controls.target.set(charPos.x, charPos.y, charPos.z + movement.getCameraPivotHeight());
      camera.position.set(charPos.x - Math.cos(o) * 6.5, charPos.y - Math.sin(o) * 6.5, charPos.z + 3.2);
      controls.update();
      sendHeartbeat(true);
      log(`near-teleport relocate -> world (${worldX.toFixed(1)}, ${worldY.toFixed(1)}, ${worldZ.toFixed(1)})`);
    } catch (e) {
      log(`near-teleport relocate failed: ${(e as Error).message}`);
    } finally {
      relocating = false;
    }
  };

  // --- Login flow bootstrap ---
  const loginFlow = new LoginFlow({
    renderer,
    index,
    onEnterWorld: async (c, client) => {
      // LoginFlow's character preview uses a reduced viewport/scissor. setSize()
      // restores framebuffer dimensions; the explicit state reset prevents the
      // first live-world frame from inheriting the character-select rectangle.
      resizeWorldRenderer();
      restoreRendererViewport(renderer);
      document.body.classList.toggle('wow-custom-cursor', Number(appliedVideoCvars.gxCursor) !== 0);

      showMapLoadingScreen(c.map);
      updateMapLoadingProgress(10);
      worldAudio.setWorldReady(false);
      teardownCombatState();

      logEl.style.display = debugLogEnabled ? 'block' : 'none';
      const lp = document.getElementById('lighting-panel');
      if (lp) lp.style.display = 'block';
      activeWorld = client;
      playerGuid = c.guid;
      controlledMoverGuid = c.guid;
      controlledMovementAllowed = true;
      controlledMoverBoundGuid = undefined;
      currentCharacter = c;
      lastEquipSig = equipmentSignature(c.equipment ?? []);
      playerEntity = undefined;
      deathPhase = 'alive';
      corpseReclaimAvailableAt = 0;
      corpseLocation = undefined;
      pendingResurrect = undefined;
      lastDeathUiSignature = '';
      setGhostWorld(false);
      playerActivelyEngaged = false;
      playerWasServerInCombat = false;
      autoAttacking = false;
      setPlayerSheathState(0, false);
      refreshPlayerFrame();
      hideCastBar();
      void renderBuffs();

      activeWorld.onStats((stats) => {
        // Stats update log
      });
      activeWorld.onControlledMover((event) => {
        controlledMoverGuid = event.moverGuid;
        controlledMovementAllowed = event.allowMove;
        applyControlledMover();
        // Casts, auto-repeat and queued next-swing state belong to the subject that owned input
        // when they were created. Never let them leak across player <-> possession/charm changes,
        // or survive an allowMove=false revocation. Realm cooldowns remain character-owned and are
        // rebuilt by their normal packets, so a control switch does not discard them.
        if (event.previousMoverGuid !== event.moverGuid || !event.allowMove) {
          teardownCombatState(false);
        }
      });
      activeWorld.onEntity((entity, change) => {
        spellVisuals.syncEntityChannel(entity);
        spellVisuals.upsertDynamicObject(entity);
        change ? entityRenderer?.applyEntityChange(change) : entityRenderer?.upsert(entity);
        if (entity.typeId === TypeID.PLAYER) {
          spellVisuals.syncEntityWeaponEnchants(
            entity,
            entity.guid === playerGuid
              ? (slot) => playerEquipmentAttachmentRoot?.(slot)
              : undefined,
          );
        }
        worldAudio.handleEntity(entity);
        // UNIT_NPC_EMOTESTATE is the emote a unit STANDS in — innkeepers wiping the bar, guards
        // saluting, a mob clearing its emote the moment it aggroes. It is an Emotes.dbc id, the
        // same table SMSG_EMOTE uses, so it resolves through EMOTE_ANIMS. Only the edges matter:
        // this callback fires on every field update for every visible unit.
        const emoteState = entity.npcEmoteState ?? 0;
        if (emoteState !== (npcEmoteStates.get(entity.guid) ?? 0)) {
          npcEmoteStates.set(entity.guid, emoteState);
          const animId = EMOTE_ANIMS[emoteState]?.[0] ?? 0;
          // Emote 0 (and any id with no animation) means "stand normally" — clear the loop.
          playEntityOrPlayer(entity.guid, animId, animId > 0 ? Number.POSITIVE_INFINITY : 0, 'emoteState');
        }
        if (
          entity.guid === controlledMoverGuid
          && entity.guid !== playerGuid
          && controlledMoverBoundGuid !== entity.guid
        ) {
          applyControlledMover();
        }
        if (entity.guid === (controlledMoverGuid ?? playerGuid)) {
          movement.setServerRooted(entity.rooted ?? false);
          movement.setStunned(((entity.unitFlags ?? 0) & 0x00040000) !== 0); movement.setFeatherFalling(entity.featherFalling ?? false);
          movement.setTaxiFlight(entity.guid === playerGuid && !!entity.taxiFlight, entity.spline);
          if (entity.speeds) {
            for (const kind of ['walk', 'run', 'runBack', 'swim', 'swimBack', 'turnRate'] as const) {
              movement.setServerSpeed(kind, entity.speeds[kind]);
            }
          }
        }
        // Refresh the inspect paper doll when the inspected target's gear/item info updates.
        if (inspectPanel.isOpen() && inspectPanel.guid() === entity.guid) {
          inspectPanel.setSlots(inspectSlotsFor(entity.guid));
        }
        if (entity.guid === playerGuid) {
          playerEntity = entity;
          logDeathDebug(entity);
          const serverInCombat = ((entity.unitFlags ?? 0) & 0x00080000) !== 0;
          // The falling edge is authoritative proof that no engaged enemy remains. Do
          // not react to the rising edge: pass-by aggro must leave the player sheathed.
          if (playerWasServerInCombat && !serverInCombat && playerActivelyEngaged) {
            autoAttacking = false;
            playerActivelyEngaged = false;
            updateAttackIndicator();
            setPlayerSheathState(0);
          }
          // FCT "Show Combat State": both edges, unlike the sheath logic above which
          // deliberately ignores the rising edge.
          if (serverInCombat !== playerWasServerInCombat && fctAllows('combatState')) {
            spawnDamageText(entity.guid, serverInCombat ? '+Combat' : '-Combat', serverInCombat ? '#ff6a4d' : '#9ad5ff', { small: true });
          }
          playerWasServerInCombat = serverInCombat;
          announceLowVitals(entity);
          // Server-authoritative sheath echo (our own CMSG_SETSHEATHED round-trips here;
          // forced changes — e.g. logging in already drawn — apply without re-sending).
          // A disarm lands as a UNIT_FIELD_FLAGS change, not an inventory change, so the model
          // rebuild has to be kicked from here. refreshPlayerEquipmentModel is signature-guarded,
          // so re-running it on an unchanged look is a no-op.
          if (!!entity.disarmed !== playerWasDisarmed) {
            playerWasDisarmed = !!entity.disarmed;
            if (lastInventory) refreshPlayerEquipmentModel(lastInventory);
          }
          if (entity.sheathState !== undefined && entity.sheathState !== playerSheathState) {
            const echoed = entity.sheathState as 0 | 1 | 2;
            // Ignore a stale/non-player-initiated drawn state at login or after combat.
            // Manual Z changes are already applied locally before their echo arrives.
            if (echoed === 0 || playerActivelyEngaged) setPlayerSheathState(echoed, false);
          }
          refreshPlayerFrame();
          renderExperienceBar(entity);
          if (characterOpen) syncCharacterCanvas(lastInventory);
          const xpBar = ingameHud.querySelector<HTMLElement>('#wow-experience-bar');
          if (xpBar && entity.nextLevelExperience === undefined && !xpBar.dataset.missingFieldLogged) {
            xpBar.dataset.missingFieldLogged = '1';
            const nearby = [...entity.fields.entries()]
              .filter(([index]) => index >= STOCK_PLAYER_FIELDS.PLAYER_XP - 0x26 && index <= STOCK_PLAYER_FIELDS.PLAYER_XP + 0x1a)
              .map(([index, value]) => `0x${index.toString(16)}=${value}`);
            const indices = [...entity.fields.keys()].sort((a, b) => a - b);
            console.warn(
              `[xp] PLAYER_NEXT_LEVEL_XP missing; using Vanilla level curve. fields=${indices.length} max=0x${(indices.at(-1) ?? 0).toString(16)} nearby=[${nearby.join(',')}]`,
            );
          }
          void renderBuffs(entity.guid);
        }
        // Combo points live on the PLAYER entity (PLAYER_FIELD_BYTES) but render on the target
        // frame, so a player-field update has to repaint the target frame too or points would
        // only appear on the next target switch.
        if (entity.guid === selectedTargetGuid || (entity.guid === playerGuid && selectedTargetGuid)) refreshTargetFrame();
        // FCT "Show Combo Points": announce each gain. A finisher drops the count to zero,
        // which is a spend rather than a gain, so only the rising edge produces a label.
        if (entity.guid === playerGuid) {
          const combo = activeWorld?.getComboPoints?.() ?? 0;
          if (combo > fctLastComboPoints && fctAllows('comboPoints')) {
            spawnDamageText(entity.guid, `${combo} Combo`, '#ffb347', { small: true });
          }
          fctLastComboPoints = combo;
        }
        if (activeWorld?.getSocial().group.some((member) => member.guid === entity.guid)) {
          partyHud.update(activeWorld.getSocial(), (guid) => activeWorld?.getEntity(guid), (guid) => activeWorld?.getPartyVitals(guid), (guid) => activeWorld?.getPlayerName(guid));
        }
        if (entity.guid === lastPet?.guid) petHud.update(activeWorld?.getPet() ?? {});
        syncDeathUi();
      });
      activeWorld.onRootState(({ guid, rooted }) => {
        if (guid === (controlledMoverGuid ?? playerGuid)) movement.setServerRooted(rooted);
      });
      activeWorld.onKnockback((event) => {
        // Only our own mover flies locally; a knocked-back remote unit is carried by the ordinary
        // movement/extrapolation path off the MovementInfo the server already broadcast with it.
        if (!event.self || event.guid !== (controlledMoverGuid ?? playerGuid)) return;
        movement.applyKnockback(event.cosAngle, event.sinAngle, event.speedXY, event.speedZ);
      });
      activeWorld.onEntityRemove((guid) => {
        const removedTarget = guid === selectedTargetGuid;
        const removedControlledSubject = guid === controlledMoverGuid && guid !== playerGuid;
        spellVisuals.removeDynamicObject(guid);
        spellVisuals.removeEntityAuraStates(guid);
        entityRenderer?.remove(guid);
        worldAudio.removeEntity(guid);
        spellVisuals.stopCasterSounds(guid);
        npcEmoteStates.delete(guid);
        if (guid === playerGuid) {
          playerEntity = undefined;
          refreshPlayerFrame();
        }
        if (removedTarget) {
          setTarget(undefined);
          teardownCombatState(false);
        } else if (removedControlledSubject) {
          teardownCombatState(false);
        }
        syncDeathUi();
      });
      activeWorld.onCombat(handleCombatEvent);
      activeWorld.onDeath((event) => {
        if (event.kind === 'corpseReclaimDelay') {
          corpseReclaimAvailableAt = event.availableAt;
        } else if (event.kind === 'corpseLocation') {
          corpseLocation = event.found ? event : undefined;
        } else if (event.kind === 'resurrectRequest') {
          pendingResurrect = event;
          lastDeathUiSignature = '';
        } else if (event.kind === 'resurrectFailed') {
          pendingResurrect = undefined;
          lastDeathUiSignature = '';
          showUiError('Resurrection failed.');
        } else if (event.kind === 'spiritHealerConfirm') {
          // Server asked us to confirm the graveyard (spirit-healer) resurrect. Vanilla shows the
          // XP_LOSS StaticPopup; accepting calls AcceptXPLoss() -> CMSG_SPIRIT_HEALER_ACTIVATE.
          const healerGuid = event.healerGuid;
          lastDeathUiSignature = '';
          npcInteraction?.forceConfirm(
            'If you find your corpse, you can resurrect for no penalty.  If I resurrect you all of '
            + 'your items will take 25% durability damage (equipped and inventory) and you will be '
            + 'afflicted by Resurrection Sickness.',
            () => { activeWorld?.spiritHealerActivate(healerGuid); },
            () => {},
            'Yes',
            'No',
          );
          return;
        }
        syncDeathUi();
      });
      activeWorld.onNearTeleport((dest) => {
        void relocateLocalPlayer(dest.x, dest.y, dest.z, dest.o);
      });
      activeWorld.onSound((event) => worldAudio.handleWorldSound(event));
      activeWorld.onLogoutResponse((event) => logoutTimer.handleResponse(event));
      activeWorld.onLogoutCancelled(() => logoutTimer.handleCancelAck());
      activeWorld.onLogoutComplete(() => logoutTimer.handleComplete());
      activeWorld.onCinematic((event) => {
        // Claim known sequences for playback after the loading screen; world.ts acks unknown ones.
        if (!cinematicPlayer.canPlay(event.cinematicId)) return false;
        pendingCinematic = event;
        log(`cinematic: sequence ${event.cinematicId} queued until the world is ready`);
        return true;
      });
      activeWorld.onLootRoll((event) => lootRolls.handle(event));
      activeWorld.onMirrorTimer((event) => mirrorTimers.handle(event));
      activeWorld.onDisconnect((reason) => {
        closeTransientWorldUi();
        // Freeze the stale world; reconnect reloads a fresh realm/login snapshot.
        teardownCombatState();
        setTarget(undefined);
        movement.setInputLocked(true);
        // The server dropped every channel membership with the session.
        channelMembership.reset();
        const socket = activeWorld?.getConnectionDiagnostics()?.socket;
        log(`world: disconnected (${reason})`);
        if (socket) {
          log(
            `world: close code=${socket.closeCode ?? 'none'} reason="${socket.closeReason || ''}" ` +
              `lastReceived=${socket.lastReceivedAgoMs}ms ago lastSent=${socket.lastSentAgoMs}ms ago ` +
              `buffered=${socket.bufferedBytes}B queued=${socket.queuedPackets}`,
          );
        }
        showUiError('Disconnected from the server.');
        showDisconnectNotice(reason);
      });
      let transferSerial = 0, transferAbort = new AbortController();
      activeWorld.onWorldTransfer(async (event) => {
        if (event.kind !== 'aborted') closeTransientWorldUi();
        if (event.kind !== 'aborted') { transferAbort.abort(); transferAbort = new AbortController(); movement.setInputLocked(true); }
        if (event.kind === 'pending') {
          transferSerial++;
          showMapLoadingScreen(event.map);
          updateMapLoadingProgress(8);
          spawned = false;
          worldAudio.setWorldReady(false);
          teardownCombatState();
          soundManager.setUnderwater(false);
          mirrorTimers.clear();
          lootRolls.clear();
          masterLootPanel.hide();
          partyHud.clear();
          petHud.clear();
          playerEntity = undefined;
          entityRenderer?.clear();
          chatBubbles.clear(); // speakers do not survive a map change
          setTarget(undefined);
          hideCastBar();
          log(`world transfer pending: map ${event.map}${event.transportEntry ? ` via transport ${event.transportEntry}` : ''}`);
          return;
        }

        if (event.kind === 'aborted') {
          transferAbort.abort(); movement.setInputLocked(false);
          // vMaNGOS decides an abort before SMSG_TRANSFER_PENDING, so no UI was torn down.
          log(`world transfer aborted (reason ${event.reason})`);
          return;
        }

        const serial = ++transferSerial;
        const transferSignal = transferAbort.signal;
        const position = event.position;
        if (!document.getElementById('map-loading-screen')) showMapLoadingScreen(position.map);
        updateMapLoadingProgress(20);
        worldAudio.setWorldReady(false);
        teardownCombatState();
        spawned = false;

        const tile = tileForCharacter(index, position);
        if (!tile) {
          log(`world transfer reached unbaked map ${position.map} at (${position.x.toFixed(0)}, ${position.y.toFixed(0)}, ${position.z.toFixed(0)})`);
          updateMapLoadingProgress(100);
          hideMapLoadingScreen(); movement.setInputLocked(false);
          return;
        }

        currentMap = position.map;
        minimap.setMap(MINIMAP_DIR[currentMap] ?? null);
        minimap.show();
        applyLighting(currentMap, position.x, position.y, position.z, true);
        clearTiles();
        setRenderOrigin(tile.originX - TILE_HALF, tile.originY - TILE_HALF);
        updateMapLoadingProgress(30);
        try {
          await retryAbortable(() => ensureTileNeighborhood(tile, (loaded, total) => {
            if (serial === transferSerial) updateMapLoadingProgress(30 + Math.round((loaded / Math.max(1, total)) * 35));
          }), { signal: transferSignal, attempts: 3, onRetry: (error, attempt) => log(`tile ${tile.key}: transfer retry ${attempt}/3 after ${(error as Error).message}`) });
        } catch (error) {
          if (transferSignal.aborted) return;
          hideMapLoadingScreen(); movement.setInputLocked(false); showUiError(`World assets failed to load: ${(error as Error).message}`);
          throw error;
        }
        if (serial !== transferSerial) return;

        const local = worldToLocal(position.x, position.y);
        const terrainZ = sampleHeight(local.x, local.y);
        const ground = worldCollision.sampleGround(
          local.x,
          local.y,
          position.z + PLAYER_COLLISION_CYLINDER.maxStepUp,
          terrainZ,
          { allowWmoBelowTerrain: shouldAllowWmoBelowTerrain(position.z, terrainZ) },
        );
        charPos.set(local.x, local.y, ground.height);
        playerRoot.position.copy(charPos);
        playerRoot.rotation.z = normalizeYaw(position.o);
        marker.position.set(charPos.x, charPos.y, charPos.z + 3);
        movement.resetForSpawn(position.o);
        controls.target.set(charPos.x, charPos.y, charPos.z + movement.getCameraPivotHeight());
        camera.position.set(
          charPos.x - Math.cos(position.o) * 6.5,
          charPos.y - Math.sin(position.o) * 6.5,
          charPos.z + 3.2,
        );
        controls.update();
        updateMapLoadingProgress(70);

        // Keep entity presentation detached; world.ts has already ACKed at the protocol boundary.
        window.setTimeout(() => void (async () => {
          const visibilityDeadline = performance.now() + 10_000;
          while (
            serial === transferSerial &&
            activeWorld === client &&
            !transferSignal.aborted &&
            !client.getEntities().some((entity) => entity.guid === playerGuid) &&
            performance.now() < visibilityDeadline
          ) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
          }
          if (serial !== transferSerial || activeWorld !== client) return;
          for (const entity of client.getEntities()) entityRenderer?.upsert(entity);
          const readiness = await entityRenderer?.waitForSettled({
            timeoutMs: 30_000,
            stableMs: 600,
            signal: transferSignal,
            onProgress: (pending, total) => {
              if (serial !== transferSerial) return;
              const ready = total > 0 ? (total - pending) / total : 1;
              updateMapLoadingProgress(72 + Math.round(ready * 23));
            },
          });
          if (serial !== transferSerial || activeWorld !== client) return;
          if (readiness && !readiness.settled) log(`world transfer readiness timed out: ${readiness.pending}/${readiness.total} models pending`);
          spawned = true;
          worldAudio.setWorldReady(true, charPos);
          sendHeartbeat(true);
          updateMapLoadingProgress(97);
          await waitForWorldRevealFrames();
          if (serial !== transferSerial || transferSignal.aborted) return;
          updateMapLoadingProgress(100);
          hideMapLoadingScreen();
          movement.setInputLocked(false);
          log(`world transfer complete: map ${position.map} (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})`);
        })().catch((e) => {
          if (serial !== transferSerial || activeWorld !== client) return;
          log(`world transfer finalization failed: ${(e as Error).message}`);
        }), 0);
      });
      activeWorld.onChat((event) => {
        chatUi.handleEvent(event);
        // Speech bubbles read the same packet as the chat window. chatBubbles /
        // chatBubblesParty gating and the type filter both live in the layer.
        chatBubbles.speak(event.senderGuid, event.message, event.type);
      });
      activeWorld.onChannelNotify((event) => chatUi.handleChannelNotify(event));
      activeWorld.onExploration((event) => {
        // ERR_ZONE_EXPLORED = "Discovered: %s" / ERR_ZONE_EXPLORED_XP = "Discovered %s: %d
        // experience gained" (GlobalStrings.lua:1603-1604). The short form is what a max-level
        // character sees, because the server sends experience == 0 there.
        const areaName = areaNames[event.areaId] ?? `Area ${event.areaId}`;
        chatUi.system(event.experience > 0
          ? `Discovered ${areaName}: ${event.experience} experience gained`
          : `Discovered: ${areaName}`);
      });
      activeWorld.onMinimapPing((event) => {
        const world = activeWorld;
        if (!world) return;
        minimap.setPing({ worldX: event.x, worldY: event.y, guid: event.guid, at: performance.now() });
      });
      activeWorld.onWeather((event) => {
        weatherRenderer.setWeather(event);
        soundManager.setWeatherSound(event.soundId, event.type !== 0 && event.grade > 0.02, Math.max(0.15, Math.min(1, event.grade)));
        log(`weather: type ${event.type}, grade ${event.grade.toFixed(2)}, sound ${event.soundId}`);
      });
      activeWorld.onInventoryData((snapshot) => {
        renderInventory(snapshot);
        refreshPlayerEquipmentModel(snapshot);
        tradeSkillPanel.refresh();
        actionCombat.updateActionStates();
      });
      activeWorld.onSkillData((snapshot) => {
        lastSkills = snapshot;
        characterTabs.renderSkills(snapshot);
        syncCharacterCanvas(lastInventory);
      });
      activeWorld.onHonorData((snapshot) => {
        // FCT "Show Honor Gained". Vanilla honor is weekly contribution points, so the
        // delta on that counter is the gain to announce. The first snapshot only seeds
        // the baseline — announcing it would dump your whole week's total at login.
        const contribution = snapshot.thisWeekContribution ?? 0;
        if (fctLastHonorPoints !== undefined && contribution > fctLastHonorPoints && fctAllows('honorGained')) {
          spawnDamageText(playerGuid ?? '', `+${contribution - fctLastHonorPoints} Honor`, '#ffd45e', { small: true });
        }
        fctLastHonorPoints = contribution;
        lastHonor = snapshot;
        characterTabs.renderHonor(snapshot);
        syncCharacterCanvas(lastInventory);
      });
      activeWorld.onReputationData((snapshot) => {
        // FCT "Show Reputation": one line per faction whose standing rose. Same
        // seed-then-diff rule as honor above.
        const seeding = fctLastReputation.size === 0;
        for (const faction of snapshot.factions) {
          const previous = fctLastReputation.get(faction.reputationListId);
          if (!seeding && previous !== undefined && faction.standing > previous && fctAllows('reputation')) {
            spawnDamageText(playerGuid ?? '', `+${faction.standing - previous} Reputation`, '#b9f27c', { small: true });
          }
          fctLastReputation.set(faction.reputationListId, faction.standing);
        }
        lastReputation = snapshot;
        characterTabs.renderReputation(snapshot);
        syncCharacterCanvas(lastInventory);
      });
      activeWorld.onPetData((snapshot) => {
        lastPet = snapshot;
        characterTabs.renderPet(snapshot);
        petHud.update(snapshot);
        syncCharacterCanvas(lastInventory);
        tradeSkillPanel.refresh();
      });
      activeWorld.onSocial((snapshot) => {
        partyHud.update(snapshot, (guid) => activeWorld?.getEntity(guid), (guid) => activeWorld?.getPartyVitals(guid), (guid) => activeWorld?.getPlayerName(guid));
        readyCheck.sync(snapshot); unitFrames.refreshTargetFrame();
      });
      // StaticPopupDialogs["PARTY_INVITE"] (StaticPopup.lua:338): Accept -> AcceptGroup(),
      // Decline -> DeclineGroup(), sound "igPlayerInvite". Text is ERR_INVITED_TO_GROUP_S.
      activeWorld.onPartyInvite((event) => {
        soundManager.playUi('igPlayerInvite');
        npcInteraction?.forceConfirm(
          `${event.inviterName} has invited you to join a group.`,
          () => activeWorld?.acceptPartyInvite(),
          () => activeWorld?.declinePartyInvite(),
        );
      });
      // Result 0 is ERR_PARTY_RESULT_OK and is sent on success too, so only surface real errors.
      activeWorld.onPartyCommandResult((event) => {
        if (event.result !== 0 && event.message) showUiError(event.message);
      });
      // GUILD_INVITE popup (StaticPopup.lua:352): Accept -> AcceptGuild, Decline -> DeclineGuild.
      // Text is ERR_INVITED_TO_GUILD_SS "%s invites you join %s."
      activeWorld.onGuildInvite((event) => {
        npcInteraction?.forceConfirm(
          `${event.inviterName} invites you join ${event.guildName}.`,
          () => activeWorld?.acceptGuildInvite(),
          () => activeWorld?.declineGuildInvite(),
        );
      });
      activeWorld.onGuildCommandResult((event) => {
        if (event.message) showUiError(event.message);
      });
      // Guild join/leave/promote/motd events surface as guild-coloured chat lines.
      activeWorld.onGuildEvent((event) => {
        // Interface Options → "Guild Member Alert" governs only the sign-on/sign-off spam
        // (GE_SIGNED_ON 0x0C / GE_SIGNED_OFF 0x0D, vMaNGOS Guild.h:135-136). Joins, demotions,
        // MOTD and the rest are guild business and always print.
        const isPresenceNotice = event.event === 0x0c || event.event === 0x0d;
        if (isPresenceNotice && Number(getInterfaceCvars().guildMemberNotify) !== 1) return;
        chatUi.system(event.message, 'wow-chat-line--guild');
      });
      // Duel challenge popup — DUEL_REQUESTED "%s has challenged you to a duel."
      // Tracks whether the duel challenge prompt is the popup currently awaiting an answer, so a
      // COMPLETE (e.g. the challenger cancelled first) dismisses that stale prompt and nothing else.
      let duelPromptActive = false;
      activeWorld.onDuelRequest((event) => {
        const challenger = unitNameByGuid(event.challengerGuid) ?? 'A player';
        duelPromptActive = true;
        npcInteraction?.forceConfirm(
          `${challenger} has challenged you to a duel.`,
          () => { duelPromptActive = false; activeWorld?.acceptDuel(); },
          () => { duelPromptActive = false; activeWorld?.cancelDuel(); },
        );
      });
      activeWorld.onDuelNotice((notice) => {
        if (notice.kind === 'countdown') showUiError(`Duel starting: ${notice.seconds}`);
        else if (notice.kind === 'winner') chatUi.system(notice.message);
        // OUTOFBOUNDS starts the server's 10s forfeit timer; without a warning the duel just ends.
        else if (notice.kind === 'outOfBounds') showUiError('You have left the duel area. You will forfeit the duel in 10 seconds.');
        else if (notice.kind === 'inBounds') chatUi.system('You have reentered the duel area.');
        else if (notice.kind === 'complete') {
          const hadDuelPrompt = duelPromptActive;
          duelPromptActive = false;
          // The popup surface is shared with NPC confirmations. Only close it when it still belongs
          // to the incoming duel request; DUEL_FINISHED must not dismiss an unrelated later popup.
          if (hadDuelPrompt) npcInteraction?.hidePopup();
          // vMaNGOS sends started=false when an invite/countdown is interrupted, without stopping
          // combat. Do not let another player's cancelled challenge interrupt unrelated PvE combat.
          if (!notice.started) return;
          teardownCombatState(false);
          // Duel damage and spell paths can leave the local cache at 0 while the server still
          // advertises SHEATH_STATE_MELEE. Force exactly one CMSG_SETSHEATHED(0) for remote clients.
          setPlayerSheathState(0, true, true);
        }
      });
      // SMSG_INSPECT is the server's go-ahead — open the read-only paper doll for the target.
      activeWorld.onInspect((event) => openInspect(event.guid));
      activeWorld.onInteraction((event) => {
        if (event.kind === 'readyCheckRequest' || event.kind === 'readyCheckResponse') { readyCheck.handle(event); return; } else if (event.kind === 'uiError') { showUiError(event.message); return; } else if (event.kind === 'openContainer') { const bag = activeWorld?.getInventory().bags.find((entry) => entry.itemGuid === event.itemGuid); if (bag) setBagOpen(bag.index, true); return; } else if (event.kind === 'gossipPoi') { worldMap.setGossipPoi({ ...event.poi, mapId: currentMap }); return; } else if (event.kind === 'loot') {
          if (activeLootAnimationGuid !== event.state.guid) {
            activeLootAnimationGuid = event.state.guid;
            // AnimationData.dbc id 50 is the native Loot kneel/reach sequence. It remains the
            // active state until LootFrame closes, matching the 1.12 client interaction lifetime.
            playPlayerOneShot(50, 0, 'loot');
          }
        } else if (event.kind === 'lootClose') {
          activeLootAnimationGuid = undefined;
          if (playerCombatKind === 'loot') clearPlayerCombatAnim();
        }
        if (event.kind === 'bank') {
          bankPanel.show({
            bankerGuid: event.state.guid,
            bankerName: unitNameByGuid(event.state.guid) ?? 'Azeroth',
            slots: event.state.slots,
            bags: event.state.bags,
            purchasedBagSlots: event.state.purchasedBagSlots,
            nextSlotCost: event.state.nextSlotCost,
            playerMoney: event.state.playerMoney,
          });
          return;
        }
        if (event.kind === 'bankMessage') {
          if (event.reason) showUiError(event.message);
          return;
        }
        if (event.kind === 'itemPush') {
          chatUi.system(event.message);
          return;
        }
        if (event.kind === 'taxiReply') {
          showUiError(event.message);
          return;
        }
        if (event.kind === 'tradeRequest') {
          const name = activeWorld?.getPlayerName(event.guid)?.name ?? 'Another player';
          // Interface Options → "Block Trades": decline without ever showing the popup, which
          // is the point of the option (it exists so trade spam cannot interrupt you).
          if (Number(getInterfaceCvars().BlockTrades) === 1) {
            activeWorld?.cancelTrade();
            log(`trade: auto-declined request from ${name} (Block Trades)`);
            return;
          }
          npcInteraction?.confirm(`${name} has requested to trade with you.`, () => activeWorld?.beginTrade());
          return;
        }
        if (event.kind === 'trade') {
          tradePanel.show({
            playerName: currentCharacter?.name ?? 'You',
            targetName: event.state.partnerGuid ? activeWorld?.getPlayerName(event.state.partnerGuid)?.name ?? 'Player' : 'Player',
            playerMoney: event.state.playerMoney,
            targetMoney: event.state.targetMoney,
            playerItems: event.state.playerItems,
            targetItems: event.state.targetItems,
            playerAccepted: event.state.playerAccepted,
            targetAccepted: event.state.targetAccepted,
          });
          return;
        }
        if (event.kind === 'tradeClose') {
          tradePanel.hide();
          if (event.message && event.message !== 'Trade complete.' && event.message !== 'Trade closed.') showUiError(event.message);
          return;
        }
        if (event.kind === 'mail') {
          mailPanel.show(event.state);
          if (event.state.result?.error) showUiError(`Mail operation failed (${event.state.result.error}).`);
          return;
        }
        if (event.kind === 'auction') {
          if (auctionPanel.isOpen()) auctionPanel.update(event.state);
          else auctionPanel.show(event.state);
          return;
        }
        if (event.kind === 'auctionMessage') {
          // ERR_AUCTION_* are UIErrorsFrame messages in vanilla, not popups; successes go to chat.
          if (event.error) showUiError(event.message);
          else chatUi.system(event.message);
          auctionPanel.setNotice(event.message);
          return;
        }
        if (event.kind === 'stable') {
          if (petStablePanel.isOpen()) petStablePanel.update(event.state);
          else petStablePanel.show(event.state);
          return;
        }
        if (event.kind === 'stableMessage') {
          // Only 0x08/0x09/0x0a are successes (NPCHandler.cpp:40-48).
          if (event.result === 0x08 || event.result === 0x09 || event.result === 0x0a) chatUi.system(event.message);
          else showUiError(event.message);
          return;
        }
        if (event.kind === 'petition') {
          if (petitionPanel.isOpen()) petitionPanel.update(event.state);
          else petitionPanel.show(event.state);
          return;
        }
        if (event.kind === 'petitionVendor') {
          // SMSG_PETITION_SHOWLIST opens GuildRegistrarFrame, whose purchase pane collects the
          // guild name in an EditBox and sends CMSG_PETITION_BUY.
          guildRegistrarPanel.show(event.state.guid, event.state.offers);
          return;
        }
        if (event.kind === 'petitionMessage') {
          // ERR_PETITION_* are UIErrorsFrame lines; the two successes read better in chat.
          if (event.result === 0) chatUi.system(event.message);
          else showUiError(event.message);
          return;
        }
        if (event.kind === 'bindPointUpdate') {
          // ERR_DEATHBIND_SUCCESS_S = "%s is now your home." (GlobalStrings.lua:1262); the %s is
          // the AREA name, which is why this resolves through the same table the zone banner uses.
          const areaName = areaNames[event.areaId];
          chatUi.system(`${areaName ?? 'This inn'} is now your home.`);
          return;
        }
        if (event.kind === 'masterLootList') return;
        npcInteraction?.render(event);
        if (event.kind === 'gossip' || event.kind === 'questList' || event.kind === 'vendor' || event.kind === 'trainer') {
          worldAudio.handleInteraction(event.state.guid);
          // Vanilla swings the NPC round to look at you when the window opens; ours kept its spawn
          // facing and talked sideways. Render-side only — the server's next orientation wins.
          entityRenderer?.faceToward(event.state.guid, charPos.x, charPos.y);
        }
      });
      activeWorld.onQuestLog((snapshot) => {
        (globalThis as Record<string, unknown>).__wowQuestLogSnapshot = snapshot;
        questWatchPanel.setSnapshot(snapshot);
        questieLite.setQuestLog(snapshot);
        if (questLogController?.isOpen()) questLogController.render(snapshot);
      });
      activeWorld.onQuestProgress((event) => {
        (globalThis as Record<string, unknown>).__wowQuestProgress = event;
        questWatchPanel.handleProgress(event);
        if (event.kind === 'questComplete') log(`quest: objectives complete for ${event.questId}`);
        else if (event.kind === 'questFailed') log(`quest: failed ${event.questId}${event.timer ? ' (timer)' : ''}`);
        else if (event.kind === 'questAddKill') log(`quest: kill progress ${event.questId} ${event.count}/${event.required}`);
        else if (event.kind === 'questAddItem') log(`quest: item progress ${event.itemId} x${event.count}`);
        else if (event.kind === 'questLogFull') log('quest: log full');
      });
      activeWorld.onAura((unitGuid, auras) => {
        spellVisuals.syncEntityAuras(unitGuid, auras);
        announceAuraChanges(unitGuid, auras);
        if (unitGuid === playerGuid) {
          void renderBuffs(unitGuid);
          void renderActionBar(); // stance/form changes select a different Vanilla bonus page
        }
      });
      // The login visibility burst can finish before listeners are attached. Seed the same
      // authoritative aura diff once so existing Ice Block/shield/state effects are not missed.
      for (const entity of activeWorld.getEntities()) {
        if (entity.typeId === TypeID.UNIT || entity.typeId === TypeID.PLAYER) {
          spellVisuals.syncEntityAuras(entity.guid, activeWorld.getAuras(entity.guid));
        }
      }
      activeWorld.onActionData(() => {
        const allButtons = activeWorld?.getActionButtons() ?? [];
        const buttons = allButtons.filter(Boolean).length;
        const occupied = allButtons
          .map((button, slot) => button ? `${slot}:${button.action}/${button.type}` : '')
          .filter(Boolean);
        const spells = activeWorld?.getKnownSpells().length ?? 0;
        log(`action bar: ${buttons} buttons [${occupied.join(', ')}], ${spells} known spells received`);
        void renderActionBar();
        void renderBuffs();
        talentFrameController.requestRender();
      });
      questWatchPanel.setSnapshot(activeWorld.getQuestLog());
      // The panel's first apply ran before this connection existed, so the server has not
      // seen our action-bar toggle byte yet. Push it once on entry.
      lastActionBarMask = actionBarToggleMask(getInterfaceCvars());
      activeWorld.setActionBarToggles(lastActionBarMask);
      void renderActionBar(); // initial spells/buttons may already have arrived during enterWorld
      void renderBuffs();
      renderInventory(activeWorld.getInventory());
      lastSkills = activeWorld.getSkills();
      lastHonor = activeWorld.getHonor();
      lastReputation = activeWorld.getReputation();
      lastPet = activeWorld.getPet();
      petHud.update(lastPet);
      partyHud.update(activeWorld.getSocial(), (guid) => activeWorld?.getEntity(guid), (guid) => activeWorld?.getPartyVitals(guid), (guid) => activeWorld?.getPlayerName(guid));
      characterTabs.renderSkills(lastSkills);
      characterTabs.renderHonor(lastHonor);
      characterTabs.renderReputation(lastReputation);
      characterTabs.renderPet(lastPet);
      (globalThis as Record<string, unknown>).__wowWorld = activeWorld; // QA: inspect packets/spells from console
      (globalThis as Record<string, unknown>).__wowXpDebug = () => {
        const bar = ingameHud.querySelector<HTMLElement>('#wow-experience-bar');
        return {
          decoded: {
            xp: playerEntity?.experience,
            next: playerEntity?.nextLevelExperience,
            rested: playerEntity?.restedExperience,
            restState: playerEntity?.restState,
          },
          raw: {
            xp: playerEntity?.fields.get(PLAYER_FIELDS.PLAYER_XP),
            next: playerEntity?.fields.get(PLAYER_FIELDS.PLAYER_NEXT_LEVEL_XP),
            rested: playerEntity?.fields.get(PLAYER_FIELDS.PLAYER_REST_STATE_EXPERIENCE),
          },
          // The commented (OBJECT_END-less) indices, for confirming the +6 gap is still uniform.
          rawStock: {
            xp: playerEntity?.fields.get(STOCK_PLAYER_FIELDS.PLAYER_XP),
            next: playerEntity?.fields.get(STOCK_PLAYER_FIELDS.PLAYER_NEXT_LEVEL_XP),
            rested: playerEntity?.fields.get(STOCK_PLAYER_FIELDS.PLAYER_REST_STATE_EXPERIENCE),
          },
          rendered: bar ? {
            text: bar.querySelector<HTMLElement>('.wow-experience-text')?.textContent,
            fill: bar.querySelector<HTMLElement>('.wow-experience-fill')?.style.width,
            restedFill: bar.querySelector<HTMLElement>('.wow-experience-rested')?.style.width,
            visible: getComputedStyle(bar).display !== 'none',
          } : null,
        };
      };
      (globalThis as Record<string, unknown>).__wowInventoryDebug = () => activeWorld?.inventoryDebug(); // QA: dump raw bag/container state
      (globalThis as Record<string, unknown>).__wowQuestLog = {
        get: () => activeWorld?.getQuestLog(),
        query: (questId: number) => activeWorld?.queryQuestInfo(questId),
        abandon: (slot: number) => activeWorld?.removeQuestLogSlot(slot),
        swap: (slot1: number, slot2: number) => activeWorld?.swapQuestLogSlots(slot1, slot2),
      };
      (globalThis as Record<string, unknown>).__wowReputation = {
        get: () => activeWorld?.getReputation(),
        watch: (reputationListId: number | null) => activeWorld?.setWatchedFaction(reputationListId),
        atWar: (reputationListId: number, enabled: boolean) => activeWorld?.setFactionAtWar(reputationListId, enabled),
        inactive: (reputationListId: number, enabled: boolean) => activeWorld?.setFactionInactive(reputationListId, enabled),
      };
      (globalThis as Record<string, unknown>).__wowPet = {
        get: () => activeWorld?.getPet(),
        action: (petGuid: string, action: number, activeState: number, targetGuid?: string) => activeWorld?.petAction(petGuid, action, activeState, targetGuid),
        cast: (petGuid: string, spellId: number, targetGuid?: string) => activeWorld?.petCastSpell(petGuid, spellId, targetGuid),
        autocast: (petGuid: string, spellId: number, enabled: boolean) => activeWorld?.petSpellAutocast(petGuid, spellId, enabled),
      };

      entityRenderer?.setPlayerGuid(c.guid);
      entityRenderer?.clear();
      chatBubbles.clear();
      let position: Pick<CharacterInfo, 'map' | 'x' | 'y' | 'z'> & { o?: number } = c;
      const abortWorldEntry = () => {
        // A queued intro must not outlive a failed entry, and the letterbox must not linger.
        pendingCinematic = null;
        cinematicPlayer.cancel();
        cinematicFrame.hide();
        endCinematicPresentation();
        worldAudio.setWorldReady(false);
        teardownCombatState();
        setTarget(undefined);
        movement.setInputLocked(true);
        if (activeWorld === client) {
          try {
            activeWorld.close({ logout: true });
          } catch {
            // A failed entry may already have closed the transport.
          }
          activeWorld = null;
        }
        playerGuid = undefined;
        currentCharacter = undefined;
        playerEntity = undefined;
        entityRenderer?.clear();
        chatBubbles.clear();
        refreshPlayerFrame();
        hideCastBar();
        mirrorTimers.clear();
        void renderBuffs();
      };

      updateMapLoadingProgress(25);
      try {
        const entered = await activeWorld.enterWorld(c);
        position = entered;
        log(
          `server entered "${c.name}" at map ${entered.map} (${entered.x.toFixed(1)}, ${entered.y.toFixed(1)}, ${entered.z.toFixed(1)}) ` +
            `with ${entered.stats.updateBlocks} update blocks`,
        );
      } catch (e) {
        const message = `world enter failed for "${c.name}": ${(e as Error).message}`;
        log(message);
        abortWorldEntry();
        hideMapLoadingScreen();
        throw new Error(message);
      }

      updateMapLoadingProgress(50);
      const t = tileForCharacter(index, position);
      if (!t) {
        log(
          `"${c.name}" is at ${MAP_NAMES[position.map] ?? `map ${position.map}`} (${position.x.toFixed(0)}, ${position.y.toFixed(0)}, ${position.z.toFixed(0)}) — no tile baked there yet. Bake it:  ` +
            `BAKE_MAP=${position.map} BAKE_WX=${position.x.toFixed(0)} BAKE_WY=${position.y.toFixed(0)} node tools/bake-tile.ts && node tools/bake-doodads.ts`,
        );
        abortWorldEntry();
        hideMapLoadingScreen();
        throw new Error(`No baked tile is available for ${MAP_NAMES[position.map] ?? `map ${position.map}`}`);
      }

      currentMap = position.map;
      minimap.setMap(MINIMAP_DIR[currentMap] ?? null);
      minimap.show();
      applyLighting(currentMap, position.x, position.y, position.z, true);
      clearTiles();
      setRenderOrigin(t.originX - TILE_HALF, t.originY - TILE_HALF);
      log(`loading ${t.key} for "${c.name}"...`);

      updateMapLoadingProgress(55);
      await ensureTileNeighborhood(t, (loaded, total) => {
        updateMapLoadingProgress(55 + Math.round((loaded / Math.max(1, total)) * 20));
      });
      for (const entity of activeWorld?.getEntities() ?? []) entityRenderer?.upsert(entity);
      const { x: rx, y: ry } = worldToLocal(position.x, position.y);
      const terrainZ = sampleHeight(rx, ry);
      const spawnGround = worldCollision.sampleGround(
        rx,
        ry,
        position.z + PLAYER_COLLISION_CYLINDER.maxStepUp,
        terrainZ,
        { allowWmoBelowTerrain: shouldAllowWmoBelowTerrain(position.z, terrainZ) },
      );
      charPos.set(rx, ry, spawnGround.height);
      const equipIds = (c.equipment ?? []).map((e) => e.displayInfoId).filter((id) => id > 0);
      if (equipIds.length) log(`equipment display IDs (bake these): ${equipIds.join(',')}  gender=${c.gender}`);

      updateMapLoadingProgress(78);
      const [, entityReadiness] = await Promise.all([
        loadPlayerModel(currentCharacter ?? c),
        entityRenderer?.waitForSettled({
          timeoutMs: 30_000,
          stableMs: 600,
          onProgress: (pending, total) => {
            const ready = total > 0 ? (total - pending) / total : 1;
            updateMapLoadingProgress(78 + Math.round(ready * 15));
          },
        }),
      ]);
      if (entityReadiness && !entityReadiness.settled) {
        log(`loading readiness: timed out with ${entityReadiness.pending}/${entityReadiness.total} entity models pending`);
      }
      playerRoot.position.set(charPos.x, charPos.y, charPos.z);
      playerRoot.rotation.z = normalizeYaw(position.o ?? 0);
      marker.position.set(charPos.x, charPos.y, charPos.z + 3);
      marker.visible = !playerRoot.visible;

      spawned = true;
      movement.resetForSpawn(position.o ?? 0);
      worldAudio.setWorldReady(true, charPos);
      controls.autoRotate = false;

      {
        const o = position.o ?? 0;
        const back = 6.5;
        controls.target.set(rx, ry, charPos.z + movement.getCameraPivotHeight());
        camera.position.set(rx - Math.cos(o) * back, ry - Math.sin(o) * back, charPos.z + 3.2);
        controls.update();
      }
      sendHeartbeat(true);
      log(`spawned "${c.name}" in ${t.dir} at world (${position.x.toFixed(0)}, ${position.y.toFixed(0)}, ${position.z.toFixed(0)}) — WASD now sends MSG_MOVE_HEARTBEAT`);

      renderer.setAnimationLoop(() => {
        const measuredDt = clock.getDelta(); const dt = Math.min(measuredDt, 0.05); let phaseStarted = startPerformancePhase(CpuScopeId.WorldUpdate);
        logoutTimer.update(dt); const networkScope = beginCpuScope(CpuScopeId.NetworkSnapshot); try { activeWorld?.advanceSimulation(dt * 1000); } finally { endCpuScope(networkScope); }
        endPerformancePhase('world-update', phaseStarted); phaseStarted = startPerformancePhase(CpuScopeId.EntityHydrationPresentation);
        if (activeWorld && entityRenderer) {
          entityRenderer.applyRenderSnapshot(activeWorld.getRenderSnapshot(), resolveActiveRenderEntity);
        }
        endPerformancePhase('entity-snapshot+hydration', phaseStarted);
        phaseStarted = startPerformancePhase(CpuScopeId.InputCamera);
        spellVisuals.prepareCameraFrame();
        // A cinematic owns the camera outright: the follow camera and player movement are both
        // suppressed, matching vanilla, where CinematicStart parks the player and ignores input
        // until CinematicEnd. `controls.update()` must not run or it would fight for the camera.
        const cinematicOwnsCamera = cinematicPlayer.update(dt);
        if (!cinematicOwnsCamera && !xrRuntime?.active) {
          movement.prepareCameraControls(dt);
          controls.update();
        }
        endPerformancePhase('input+camera', phaseStarted); phaseStarted = startPerformancePhase(CpuScopeId.MovementCollisionStreaming);
        if (spawned) updateWalk(dt);
        else updateMovement(dt);
        endPerformancePhase('movement+collision+streaming', phaseStarted);
        phaseStarted = startPerformancePhase(CpuScopeId.PlayerAnimation);
        xrRuntime?.syncPose();
        updatePlayerAnimation(dt);
        endPerformancePhase('player-animation', phaseStarted);
        phaseStarted = startPerformancePhase(CpuScopeId.BlobShadowsGroundSampling);
        updateBlobShadows(); // must precede entityRenderer.update — it publishes the shared sun scale
        endPerformancePhase('blob-shadows', phaseStarted);
        phaseStarted = startPerformancePhase(CpuScopeId.EntityHydrationPresentation);
        beginEntityDetailFrame(); entityRenderer?.update(dt, camera);
        endPerformancePhase('entity-animation', phaseStarted);
        phaseStarted = startPerformancePhase(CpuScopeId.Ui);
        unitFrames.updatePortraits();
        npcInteraction?.updatePortraits();
        auctionPanel.updatePortrait(); bankPanel.updatePortrait(); guildRegistrarPanel.updatePortrait(); petStablePanel.updatePortrait();
        updateNameplates();
        chatBubbles.update();
        endPerformancePhase('unit-ui+nameplates', phaseStarted);
        phaseStarted = startPerformancePhase(CpuScopeId.SpellModelEffects);
        spellVisuals.update(dt, measuredDt);
        modelOpacity.update(dt);
        endPerformancePhase('spell+model-effects', phaseStarted);
        phaseStarted = startPerformancePhase(CpuScopeId.WorldDoodadEffects);
        worldDoodadEffects.update(dt, measuredDt);
        endPerformancePhase('world-doodad-effects', phaseStarted);
        phaseStarted = startPerformancePhase();
        updateWaterTime(dt);
        updateGrassTime(dt);
        updateTextureAnimations(dt);
        endPerformancePhase('animated-materials', phaseStarted);
        phaseStarted = startPerformancePhase();
        updateDoodadAnimations(dt);
        endPerformancePhase('doodad-skeletal-animation', phaseStarted);
        phaseStarted = startPerformancePhase(CpuScopeId.Weather);
        weatherRenderer.setExteriorExposure(indoorSunScale);
        const nextWeatherAtmosphereGrade = weatherRenderer.update(dt, camera);
        if (Math.abs(nextWeatherAtmosphereGrade - weatherAtmosphereGrade) > 0.005) {
          weatherAtmosphereGrade = nextWeatherAtmosphereGrade;
          const litWorld = localToWorld(charPos.x, charPos.y);
          applyLighting(currentMap, litWorld.x, litWorld.y, charPos.z, true);
        }
        endPerformancePhase('weather', phaseStarted);
        phaseStarted = startPerformancePhase(CpuScopeId.Ui);
        updateCastBar();
        const hudTicks = hudFrameCadence.take(performance.now());
        if (hudTicks.actionStates) updateActionStates();
        if (hudTicks.auras) updateAuraTimers();
        if (hudTicks.cooldowns) {
          updateCooldowns();
          refreshMainMenuCanvas();
        }
        tradeSkillPanel.update(movement.getPlayerMoving(), ((playerEntity?.unitFlags ?? 0) & 0x00080000) !== 0);
        updateEntityDebug();
        const mmWorld = localToWorld(charPos.x, charPos.y);
        questieLite.setPlayer(currentCharacter ? { key: currentCharacter.guid,
          level: playerEntity?.level ?? currentCharacter.level, race: currentCharacter.race, classId: currentCharacter.classId } : undefined);
        syncDeathUi();
        const heading = movement.getServerOrientation();
        minimap.update(mmWorld.x, mmWorld.y, heading, currentMap);
        // Blip REBUILD is throttled: doing the Set + filter/map allocation at 60Hz churned
        // thousands of short-lived objects/sec in entity-dense areas (GC hitches). The minimap
        // keeps the last array between setBlips calls and recenters it per-frame around the
        // player, so entity blips only advance at ~6-7Hz — under a pixel of drift at run speed,
        // and in line with how chunky vanilla blips read anyway.
        const nowBlipMs = performance.now();
        if (nowBlipMs - mmBlipsAt > 150) {
          mmBlipsAt = nowBlipMs;
          const partyGuids = new Set((activeWorld?.getSocial().group ?? []).filter((member) => member.online).map((member) => member.guid));
          // Vanilla 1.12 keeps the minimap clean: NO arbitrary NPCs, mobs or the current
          // target appear on it. The only unit blips are party/raid members and — when a tracking
          // ability is active — creatures of the tracked type (the yellow dots). Quest availability is
          // shown by the overhead ! / ? marker in the 3D world, not on the minimap. Questie-lite is
          // the explicit opt-in exception; its map notes are appended below.
          const trackedMask = activeWorld?.getTrackedCreatureMask() ?? 0; minimap.setTrackingActive(trackedMask !== 0 || (activeWorld?.getTrackedResourceMask() ?? 0) !== 0);
          const UNIT_DYNFLAG_TRACK_UNIT = 0x0002; // Track Stealthed flags individual units (vMaNGOS SharedDefines.h)
          const isTracked = (entity: WorldEntity): boolean => {
            if (entity.typeId !== TypeID.UNIT) return false;
            if (((entity.dynamicFlags ?? 0) & UNIT_DYNFLAG_TRACK_UNIT) !== 0) return true;
            if (trackedMask === 0 || entity.entry === undefined) return false;
            const creatureType = activeWorld?.getCreatureName(entity.entry)?.type ?? 0;
            return creatureType > 0 && (trackedMask & (1 << (creatureType - 1))) !== 0;
          };
          const minimapBlips: MinimapBlip[] = (entityRenderer?.nameplateEntries() ?? [])
            .filter((entry) => partyGuids.has(entry.guid) || isTracked(entry.entity))
            .map((entry) => {
              const world = localToWorld(entry.localPosition.x, entry.localPosition.y);
              const kind = partyGuids.has(entry.guid) ? 'party' as const : 'tracking' as const;
              return { guid: entry.guid, worldX: world.x, worldY: world.y, heading: entry.entity.o, kind };
            });
          for (const [index, marker] of questieLite.markersNear(currentMap, mmWorld.x, mmWorld.y).entries()) minimapBlips.push({
            guid: `questie:${marker.questId}:${marker.kind}:${marker.objective}:${index}`,
            worldX: marker.worldX, worldY: marker.worldY, kind: 'quest', questKind: marker.kind,
            title: marker.title, detail: marker.detail ?? (marker.kind === 'available' ? 'Available Quest'
              : marker.kind === 'turnin' ? 'Quest Complete' : marker.kind === 'turnin-incomplete' ? 'Quest Turn-in' : 'Quest Objective'),
          });
          if (deathPhase === 'ghost' && corpseLocation?.mapId === currentMap) {
            minimapBlips.push({
              guid: 'player-corpse',
              worldX: corpseLocation.x,
              worldY: corpseLocation.y,
              heading: 0,
              kind: 'corpse',
            });
          }
          minimap.setBlips(minimapBlips);
        }
        const currentAreaId = zoneTracker.getAreaId(currentMap, mmWorld.x, mmWorld.y);
        hudAreaId = currentAreaId; zoneTracker.updateBanner(currentMap, currentAreaId, areaNames[currentAreaId], currentCharacter?.race);
        // CMSG_ZONEUPDATE. The server keys rested state, PvP rules and the auction house a player
        // can reach off the zone it believes you are in, and 1.12 has no server-side position→zone
        // lookup for players — the client is the only thing that reports it. `sendZoneUpdate`
        // dedupes, so calling it every frame only emits a packet on an actual transition.
        activeWorld?.sendZoneUpdate(currentAreaId);
        // Wait for the server clock before choosing day or night ambience. `tuning.time` starts at
        // Light.dbc's defaultTime (noon), so starting zone audio on frame 1 picks DAY, and ~500ms
        // later SMSG_LOGIN_SETTIMESPEED flips it — which restarted both the ambience bed and the
        // zone music on top of themselves at every evening/night login. Measured from a live
        // __wowSound.history(): ForestNormalDay at t+0ms, ForestNormalNight at t+502ms.
        // Free-scrubbing the tuner slider (dayNightAuto=false) is authoritative and needs no wait.
        if (!dayNightAuto || lastDayNightStep >= 0) {
          soundManager.setZoneAudio(currentAreaId, tuning.time >= 720 && tuning.time < 2160, indoorSunScale < 0.5);
        }
        worldMap.setCurrentWorld({
          mapId: currentMap,
          x: mmWorld.x,
          y: mmWorld.y,
          heading,
          areaId: currentAreaId,
        });
        endPerformancePhase('hud+minimap+zone', phaseStarted);
        phaseStarted = startPerformancePhase(CpuScopeId.Lighting);
        mmSmoothMs = mmSmoothMs > 0 ? mmSmoothMs * 0.9 + measuredDt * 1000 * 0.1 : measuredDt * 1000;
        const nowMs = performance.now();
        if (nowMs - mmChromeAt > 250) {
          mmChromeAt = nowMs;
          if (worldMap.isOpen()) worldMap.setExploredZones(activeWorld?.getExploredZones().bits ?? []);
          minimap.setPerf(1000 / Math.max(0.001, mmSmoothMs), mmSmoothMs);
          minimap.setTimeOfDay(tuning.time);
          const zoneName = areaNames[currentAreaId] || zoneTracker.resolveZone(currentMap, currentAreaId)?.zoneName || '';
          if (zoneName) minimap.setZone(zoneName);
          // Zone chat channels ride the same throttled resolve. The Trade test needs the
          // parent-resolved ZONE id, so it comes from resolveZone rather than currentAreaId —
          // standing in the Trade District must count as City_01 (1519), not as the district.
          const zone = zoneTracker.resolveZone(currentMap, currentAreaId);
          if (zone?.zoneName) channelMembership.syncZone(zone.areaTableId, zone.zoneName);
        }
        // Day/night: drive lighting time-of-day from the server clock (SMSG_LOGIN_SETTIMESPEED).
        // Vanilla day = 24h real time, so the half-minute step advances ~every 30s — only re-resolve
        // lighting when it actually changes. The lighting tuner's time slider sets dayNightAuto=false
        // so a dev can still freeze/scrub the time of day.
        if (dayNightAuto) {
          const step = activeWorld?.gameTimeHalfMinutes() ?? null;
          if (step !== null && step !== lastDayNightStep) {
            lastDayNightStep = step;
            tuning.time = step;
            applyLighting(currentMap, mmWorld.x, mmWorld.y, charPos.z, true);
          }
        }
        camera.getWorldDirection(audioForward);
        audioUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
        const audioScope = beginCpuScope(CpuScopeId.AudioSynchronization); try { soundManager.updateListener(camera.position, audioForward, audioUp); } finally { endCpuScope(audioScope); }
        skyDome.mesh.position.copy(camera.position);
        celestial.group.position.copy(camera.position);
        clouds.mesh.position.copy(camera.position);
        clouds.tick(dt);
        // Underwater lighting comes from the position-aware Light.dbc underwater
        // profile (slot 1, or slot 3 during storms). Magma/slime retain their
        // liquid-specific emergency fog because those are not ordinary water profiles.
        const camWaterZ = tileLoader.sampleWaterLevel(camera.position.x, camera.position.y);
        const nowSubmerged = Number.isFinite(camWaterZ) && camera.position.z < camWaterZ - 0.25;
        soundManager.setUnderwater(nowSubmerged);
        if (nowSubmerged !== submerged) {
          submerged = nowSubmerged;
          applyLighting(currentMap, mmWorld.x, mmWorld.y, charPos.z, true);
        }
        if (nowSubmerged) {
          const liquidType = tileLoader.sampleWaterTypeAt(camera.position.x, camera.position.y);
          if (liquidType === 3 || liquidType === 4) {
            applyUnderwaterFog(scene, true, liquidType, underwaterScratch);
          }
        }
        endPerformancePhase('lighting+audio+environment', phaseStarted);
        // Vanilla SmallCull/DistCull for ground clutter and props. Runs per draw batch (~1.7k in
        // the worst streamed neighbourhood), not per instance, so it costs nothing next to the
        // 722k instance submissions it removes. DistCull has no confirmed vanilla default, so it
        // falls back to the active farclip — see rendering/doodad-culling.ts for what is
        // byte-proven here and what is interpretation.
        phaseStarted = startPerformancePhase(CpuScopeId.DoodadCulling);
        lastDoodadCullStats = updateDoodadCulling(
          camera,
          smallCullForWorldDetail(worldDetail),
          Number(appliedVideoCvars.DistCull) || videoFarclip,
        );
        endPerformancePhase('doodad-culling', phaseStarted);
        phaseStarted = startPerformancePhase(CpuScopeId.WmoPortalGroupVisibility);
        const { exteriorVisible } = updateWmoPortalVisibility({
          instances: tileLoader.wmoVisibilityInstances,
          cameraPosition: camera.position,
          camera,
          disabled: disableWmoPortals,
          resolutionToken: wmoResolutionToken,
        });
        // GFX-37: fully enclosed interior (no portal path to an exterior group) — the outdoor
        // sky/terrain/water must not bleed through walls. Doorway rooms keep everything.
        tileLoader.setExteriorVisible(exteriorVisible);
        skyDome.mesh.visible = exteriorVisible;
        celestial.group.visible = exteriorVisible;
        clouds.mesh.visible = exteriorVisible;
        endPerformancePhase('wmo-portal-visibility', phaseStarted);
        phaseStarted = startPerformancePhase();
        renderWorld(scene, camera);
        endPerformancePhase('world-render-submit', phaseStarted);
        phaseStarted = startPerformancePhase(CpuScopeId.Auxiliary3dUi);
        // Paper-doll: draw the 3D character into its own canvas layered inside the
        // model box (the Vanilla PaperDoll art has an opaque centre, so the doll
        // must sit on top of it rather than behind the HUD).
        renderPaperdoll(dt, characterOpen && characterFrame.classList.contains('tab-character'));
        // The inspect frame drives its own CharacterPreview the same way.
        inspectPanel.update(dt);
        endPerformancePhase('auxiliary-3d-ui', phaseStarted);
      });
      // Do not reveal the world until the new animation loop has produced two
      // complete frames with the final camera, entities, terrain, and audio state.
      updateMapLoadingProgress(94);
      // Start the flythrough BEHIND the loading screen. It needs a built world to fly over, which is
      // true by now, but it must already be running when the screen lifts — otherwise the player
      // sees their character standing in the starting zone for a few seconds first, which is not
      // how vanilla hands over.
      await beginPendingCinematic();
      updateMapLoadingProgress(97);
      await waitForWorldRevealFrames();
      updateMapLoadingProgress(100);
      hideMapLoadingScreen();
    },
  });

  // Clean glue (login/realm/char) screens like the real client: the dev log + lighting tuner are
  // in-world tools, so keep them hidden behind the login flow and reveal them only on enter-world.
  logEl.style.display = 'none';
  const lightingPanelEl = document.getElementById('lighting-panel');
  if (lightingPanelEl) lightingPanelEl.style.display = 'none';

  loginFlow.start();
}

main().catch((e) => {
  log('FATAL ' + (e as Error).message);
  // eslint-disable-next-line no-console
  console.error(e);
});
