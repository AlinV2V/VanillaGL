import { OptionsDialog, type OptionRow } from './options-dialog';
import { currentGraphicsRenderScale } from '../platform/graphics-diagnostics';
import { loadGraphicsPreferences } from './vanilla-video-cvars';
import { adaptiveQualityDiagnostics } from '../platform/adaptive-quality';
/** Asset conversion utility. */
import './game-menu.css';
import {
  RENDER_SCALE_MAX,
  RENDER_SCALE_MIN,
  UI_SCALE_EXTENDED_MAX,
  UI_SCALE_VANILLA_MIN,
  gammaCvarFromSlider,
  gammaSliderValue,
  loadVideoCvars,
  restoreVideoDefaults,
  saveVideoCvars,
  type BrowserVideoCvars,
} from './vanilla-video-cvars';
import type { SoundSettings } from '../audio/sound-manager';
import { browserFullscreenElement, browserFullscreenSupported } from '../platform/browser-fullscreen';
import { CanvasPanel, UI_GRAY, type PanelHit } from './panel-kit';
import { DIALOG_EDGE, drawEdgedBox } from './vanilla-canvas';
import { createInterfaceOptions, type InterfaceOptions } from './interface-options';
import type { InterfaceCvars } from './interface-cvars';
import { BUILT_IN_ADDONS, BUILT_IN_ADDON_DEFAULTS, loadBuiltInAddonSettings, saveBuiltInAddonSettings, type BuiltInAddonSettings } from './builtin-addons';

type ApplyReason = 'ok' | 'defaults' | 'initial';

export type GameMenuOptions = {
  onApplyVideo: (cvars: BrowserVideoCvars, reason: ApplyReason) => void;
  onApplyInterface?: (cvars: InterfaceCvars, reason: ApplyReason) => void;
  onLogout?: () => void;
  onExit?: () => void;
  playUi?: (name: string) => boolean;
  getSoundSettings?: () => SoundSettings;
  onApplySound?: (settings: SoundSettings, reason: ApplyReason) => void;
  onOpenKeyBindings?: () => void;
  onOpenMacros?: () => void;
};

export type GameMenuController = {
  openMenu: () => void;
  openVideoOptions: () => void;
  openSoundOptions: () => void;
  openInterfaceOptions: () => void;
  close: () => void;
  handleEscape: () => boolean;
  isOpen: () => boolean;
  applyCurrentVideo: (reason: ApplyReason) => void;
};

const ANISOTROPIC_VALUES = [1, 2, 4, 8, 16];

/**
 * Video Options only lists settings that actually change something in this renderer.
 *
 * Removed from the panel (the cvars are still recorded in VANILLA_VIDEO_CVAR_DEFAULTS as the
 * byte-proven vanilla reference, they simply have no control):
 *
 *  - `gxResolution`, `gxRefresh`, `gxVSync`, `gxTripleBuffer`, `gxFixLag`, `gxMaximize` — the
 *    browser and its compositor own presentation; no web API exposes any of them.
 *  - `desktopGamma` — no API for the hardware gamma ramp. It also used to grey the Gamma slider out,
 *    which is why brightness looked dead by default; Gamma is now always live.
 *  - `movieSubtitle` — there are no cinematics to subtitle.
 *  - `specular` ("Terrain Highlights") — terrain specular is a separate `terrain*_s` shader variant
 *    this renderer does not implement.
 *  - `M2UseShaders` / `M2UsePixelShaders` — the M2 path is shader-only; there is no fixed-function
 *    alternative to switch to.
 *  - `lod` — no LOD meshes are baked, so there is nothing to select between.
 *  - `BaseMip` ("Texture Detail") — needs a per-texture LOD bias. TerrainMip works because it is a
 *    uniform on our own terrain shader; three.js exposes no equivalent for ordinary textures.
 *  - `spellEffectLevel` — no resolvable consumer in the client export and no UI string to anchor
 *    its semantics, so any behaviour would be invented.
 *
 * See docs/audits/ui-scale-minimap-validation-2026-07-31.md.
 */
const checkboxDependencies: Partial<Record<keyof BrowserVideoCvars, keyof BrowserVideoCvars>> = {
  ffxGlow: 'pixelShaders',
  ffxDeath: 'pixelShaders',
};

// --- Escape menu ------------------------------------------------------------

type MenuEntry = { id: string; label: string; disabled?: boolean; gapBefore?: number };

const MENU_FRAME = { x: 30, y: 20, width: 195, height: 246 };

class GameMenuDialog extends CanvasPanel {
  private entries: MenuEntry[] = [];

  constructor(host: HTMLElement, private readonly onAction: (id: string) => void, playUi?: (name: string) => boolean) {
    super(host, 256, 286, 'wow-native-panel-canvas', { playUi });
  }

  setEntries(entries: MenuEntry[]) {
    this.entries = entries;
    this.surface.requestRender();
  }

  protected paint() {
    const s = this.surface;
    s.clear();
    drawEdgedBox(s, MENU_FRAME, DIALOG_EDGE);
    s.image('/ui/Interface/DialogFrame/UI-DialogBox-Header.png', 0, 0, 256, 64);
    s.text('Main Menu', 128, 26, { size: 13, align: 'center', baseline: 'middle' });
    let centerY = MENU_FRAME.y + 37;
    for (const entry of this.entries) {
      centerY += entry.gapBefore ?? 0;
      const rect = { x: MENU_FRAME.x + (MENU_FRAME.width - 144) / 2, y: centerY - 10, width: 144, height: 21 };
      const state = entry.disabled ? 'disabled' : this.buttonState(entry.id);
      s.panelButton('', rect, state);
      s.text(entry.label, rect.x + 72, rect.y + 11 + (state === 'down' ? 1 : 0), {
        size: 12, align: 'center', baseline: 'middle', color: entry.disabled ? UI_GRAY : '#ffffff',
      });
      this.hit(entry.id, rect, { disabled: entry.disabled });
      centerY += 22;
    }
  }

  private buttonState(id: string): 'normal' | 'hover' | 'down' {
    const state = this.state(id);
    return state === 'disabled' ? 'normal' : state;
  }

  protected activate(hit: PanelHit) {
    this.playUi('igMainMenuOptionClick');
    this.onAction(hit.id);
  }
}

// --- Options dialogs ---------------------------------------------------------

// --- Controller ---------------------------------------------------------------

export function createGameMenu(options: GameMenuOptions): GameMenuController {
  let saved = loadVideoCvars();
  let graphicsDraft = loadGraphicsPreferences();
  let draft: BrowserVideoCvars = { ...saved };
  let soundSaved = options.getSoundSettings?.() ?? { masterVolume: 1, sfxVolume: 1, musicVolume: 1, soundEnabled: true, musicEnabled: true };
  let soundDraft: SoundSettings = { ...soundSaved };
  let addonSaved = loadBuiltInAddonSettings();
  let addonDraft: BuiltInAddonSettings = { ...addonSaved };
  let mode: 'closed' | 'menu' | 'video' | 'sound' | 'interface' | 'addons' = 'closed';

  const layer = document.createElement('div');
  layer.className = 'wow-esc-layer is-hidden';
  const menuHost = document.createElement('div');
  menuHost.className = 'wow-esc-dialog wow-esc-dialog--menu';
  const videoHost = document.createElement('div');
  videoHost.className = 'wow-esc-dialog wow-esc-dialog--options wow-esc-dialog--video is-hidden';
  const soundHost = document.createElement('div');
  soundHost.className = 'wow-esc-dialog wow-esc-dialog--options wow-esc-dialog--sound is-hidden';
  const interfaceHost = document.createElement('div');
  interfaceHost.className = 'wow-esc-dialog wow-esc-dialog--options wow-esc-dialog--interface is-hidden';
  const addonHost = document.createElement('div');
  addonHost.className = 'wow-esc-dialog wow-esc-dialog--options wow-esc-dialog--addons is-hidden';
  layer.append(menuHost, videoHost, soundHost, interfaceHost, addonHost);
  document.body.appendChild(layer);

  const showMode = (next: typeof mode) => {
    const previous = mode;
    mode = next;
    layer.classList.toggle('is-hidden', next === 'closed');
    menuHost.classList.toggle('is-hidden', next !== 'menu');
    videoHost.classList.toggle('is-hidden', next !== 'video');
    soundHost.classList.toggle('is-hidden', next !== 'sound');
    interfaceHost.classList.toggle('is-hidden', next !== 'interface');
    addonHost.classList.toggle('is-hidden', next !== 'addons');
    if (previous === next) return;
    if (previous === 'closed' && next !== 'closed') options.playUi?.('igMainMenuOpen');
    else if (previous !== 'closed' && next === 'closed') options.playUi?.('igMainMenuClose');
  };

  const saveAndApply = (reason: ApplyReason) => {
    saved = { ...draft };
    saveVideoCvars(saved, graphicsDraft);
    options.onApplyVideo(saved, reason);
  };

  const interfaceOptions: InterfaceOptions = createInterfaceOptions(interfaceHost, {
    playUi: options.playUi,
    onApply: (cvars, reason) => options.onApplyInterface?.(cvars, reason),
    onClose: () => showMode('menu'),
  });

  const menu = new GameMenuDialog(menuHost, (action) => {
    if (action === 'video') { buildVideoOptions(); showMode('video'); }
    else if (action === 'sound') { buildSoundOptions(); showMode('sound'); }
    else if (action === 'interface') { interfaceOptions.open(); showMode('interface'); }
    else if (action === 'addons') { buildAddonOptions(); showMode('addons'); }
    else if (action === 'keys') { showMode('closed'); options.onOpenKeyBindings?.(); }
    else if (action === 'macros') { showMode('closed'); options.onOpenMacros?.(); }
    else if (action === 'logout') { options.onLogout?.(); showMode('closed'); }
    else if (action === 'exit') { options.onExit?.(); showMode('closed'); }
    else if (action === 'return') showMode('closed');
  }, options.playUi);
  menu.setEntries([
    { id: 'video', label: 'Video Options' },
    { id: 'sound', label: 'Sound Options' },
    { id: 'interface', label: 'Interface Options' },
    { id: 'addons', label: 'AddOns' },
    { id: 'keys', label: 'Key Bindings' },
    { id: 'macros', label: 'Macros' },
    { id: 'logout', label: 'Logout' },
    { id: 'exit', label: 'Exit Game' },
    { id: 'return', label: 'Return to Game', gapBefore: 15 },
  ]);

  const videoDialog = new OptionsDialog(videoHost, {
    onFooter: (action) => {
      if (action === 'ok') { saveAndApply('ok'); showMode('menu'); }
      else if (action === 'cancel') showMode('menu');
      else {
        saved = restoreVideoDefaults();
        draft = { ...saved };
        options.onApplyVideo(saved, 'defaults');
        buildVideoOptions();
      }
    },
    onChanged: () => { graphicsDraft.mode = 'custom'; },
  }, options.playUi);
  window.addEventListener('vanillagl-adaptive-quality', () => { if (mode === 'video') videoDialog.refresh(); });

  const soundDialog = new OptionsDialog(soundHost, {
    onFooter: (action) => {
      if (action === 'ok') {
        soundSaved = { ...soundDraft };
        options.onApplySound?.(soundSaved, 'ok');
        showMode('menu');
      } else if (action === 'cancel') {
        options.onApplySound?.(soundSaved, 'initial');
        showMode('menu');
      } else {
        soundDraft = { masterVolume: 1, sfxVolume: 1, musicVolume: 1, soundEnabled: true, musicEnabled: true };
        options.onApplySound?.(soundDraft, 'defaults');
        buildSoundOptions();
      }
    },
    onChanged: () => options.onApplySound?.(soundDraft, 'initial'),
  }, options.playUi);

  const addonDialog = new OptionsDialog(addonHost, {
    onFooter: (action) => {
      if (action === 'ok') {
        addonSaved = { ...addonDraft };
        saveBuiltInAddonSettings(addonSaved);
        showMode('menu');
      } else if (action === 'cancel') {
        addonDraft = { ...addonSaved };
        showMode('menu');
      } else {
        addonDraft = { ...BUILT_IN_ADDON_DEFAULTS };
        buildAddonOptions(false);
      }
    },
    onChanged: () => {},
  }, options.playUi);

  const check = (key: keyof BrowserVideoCvars, label: string, isDisabled?: () => boolean): OptionRow => ({
    kind: 'check', key, label,
    get: () => Number(draft[key]) === 1,
    set: (value) => { (draft as Record<string, number | string>)[key] = value ? 1 : 0; },
    isDisabled,
  });
  const dependentCheck = (key: keyof BrowserVideoCvars, label: string): OptionRow =>
    check(key, label, () => {
      const parent = checkboxDependencies[key];
      return parent ? Number(draft[parent]) !== 1 : false;
    });
  const slider = (
    key: keyof BrowserVideoCvars | string, label: string, min: number, max: number, step: number,
    get: () => number, set: (value: number) => void, format: (value: number) => string,
    isDisabled?: () => boolean,
  ): OptionRow => ({ kind: 'slider', key: String(key), label, min, max, step, get, set, format, isDisabled });

  const buildVideoOptions = () => {
    graphicsDraft = loadGraphicsPreferences();
    draft = { ...saved };
    const mobile = document.documentElement.classList.contains('vanillagl-mobile');
    const displayMode: OptionRow = mobile ? {
      kind: 'check', key: 'gxWindow', label: 'Full Screen',
      get: () => Number(draft.gxWindow) === 0,
      set: (value) => { draft.gxWindow = value ? 0 : 1; },
      isDisabled: () => !browserFullscreenSupported() && !browserFullscreenElement(),
    } : check('gxWindow', 'Windowed Mode');
    videoDialog.open('Video Options', [
      { kind: 'section', label: '', getLabel: () => graphicsDraft.mode === 'recommended' ? 'Recommended Settings' : 'Custom Settings' },
      { kind: 'choice', key: 'dynamicResolution', label: 'Dynamic Resolution', values: ['Off', 'Target 60 FPS', 'Target 30 FPS'],
        get: () => graphicsDraft.dynamicResolution === 'off' ? 'Off' : graphicsDraft.dynamicResolution === 'target30' ? 'Target 30 FPS' : 'Target 60 FPS',
        set: (value) => { graphicsDraft.dynamicResolution = value === 'Off' ? 'off' : value === 'Target 30 FPS' ? 'target30' : 'target60'; } },
      { kind: 'section', label: '', getLabel: () => `Maximum ${Math.round(draft.renderScale * 100)}% / Current ${Math.round((currentGraphicsRenderScale() ?? adaptiveQualityDiagnostics()?.renderScale ?? saved.renderScale) * 100)}% native` },
      { kind: 'section', label: 'Display' },
      displayMode,
      // Browser-only: scale the 3D framebuffer and full-screen effect targets while the canvas and
      // HUD keep their native CSS size. The 100% default preserves the existing presentation.
      slider('renderScale', 'Render Scale', RENDER_SCALE_MIN, RENDER_SCALE_MAX, 0.05,
        () => draft.renderScale,
        (value) => { draft.renderScale = value; },
        (value) => `${Math.round(value * 100)}%`),
      check('useUiScale', 'Use UI Scale'),
      // Vanilla's own slider is 0.64-1.0 (OptionsFrame.lua:22). The ceiling here is deliberately
      // higher — see UI_SCALE_EXTENDED_MAX — so the HUD can be enlarged past what the 1.12 client
      // allowed. The value reads as a plain number; the divergence is documented in code, not shouted
      // at the player in the options panel.
      slider('uiscale', 'UI Scale', UI_SCALE_VANILLA_MIN, UI_SCALE_EXTENDED_MAX, 0.01, () => draft.uiscale, (value) => { draft.uiscale = value; }, (value) => value.toFixed(2), () => Number(draft.useUiScale) !== 1),
      { kind: 'section', label: 'World Appearance' },
      slider('farclip', 'Terrain Distance', 50, 777, 1, () => draft.farclip, (value) => { draft.farclip = value; }, (value) => String(Math.round(value))),
      slider('WorldDetail', 'Environment Detail', 0, 2, 1, () => draft.WorldDetail, (value) => { draft.WorldDetail = value; }, (value) => ['Low', 'Medium', 'High'][value] ?? String(value)),
      // TerrainMip is a mip INDEX: 0 keeps mip level 0 (full quality), 1 skips it. Presenting the
      // raw cvar put High on the left and Low on the right, backwards for a quality slider — so the
      // track is inverted here while the stored cvar keeps its byte-validated meaning.
      slider('TerrainMip', 'Terrain Texture', 0, 1, 1,
        () => 1 - draft.TerrainMip,
        (value) => { draft.TerrainMip = 1 - value; },
        (value) => (value ? 'High' : 'Low')),
      slider('anisotropic', 'Anisotropic Filtering', 1, ANISOTROPIC_VALUES.length, 1,
        () => Math.max(1, ANISOTROPIC_VALUES.indexOf(draft.anisotropic) + 1),
        (value) => { draft.anisotropic = ANISOTROPIC_VALUES[Math.max(0, Math.min(ANISOTROPIC_VALUES.length - 1, Math.round(value) - 1))]; },
        (value) => `${ANISOTROPIC_VALUES[Math.max(0, Math.min(ANISOTROPIC_VALUES.length - 1, Math.round(value) - 1))]}x`),
      slider('weatherDensity', 'Weather Intensity', 0, 3, 1, () => draft.weatherDensity, (value) => { draft.weatherDensity = value; }, String),
      // `unitDrawDist` is a real 1.12.1 gx cvar (default "300.0") that the shipped options panel
      // never exposed — it was console-only. It is surfaced here because it is the single biggest
      // lever on a weak machine: every unit inside it is fully CPU-skinned every frame.
      // 25..300 on a 25 grid so the shipped 100 lands on a notch. vMaNGOS replicates entities to
      // 100yd (ObjectDefines.h:30), so positions above that are inert on a stock realm but still
      // correct for one that raises Visibility.Distance.
      slider('unitDrawDist', 'Unit Draw Distance', 25, 300, 25, () => draft.unitDrawDist, (value) => { draft.unitDrawDist = value; }, (value) => String(Math.round(value))),
      { kind: 'section', label: 'Brightness' },
      slider('gamma', 'Gamma', -0.5, 0.5, 0.1, () => gammaSliderValue(draft), (value) => { draft.gamma = gammaCvarFromSlider(value); }, (value) => value.toFixed(1)),
      { kind: 'section', label: 'Pixel Shaders' },
      check('pixelShaders', 'Enable All Shader Effects'),
      dependentCheck('ffxGlow', 'Full-Screen Glow Effect'),
      dependentCheck('ffxDeath', 'Death Effect'),
      check('useWeatherShaders', 'Weather Shaders'),
      { kind: 'section', label: 'Miscellaneous' },
      check('trilinear', 'Trilinear Filtering'),
      check('gxCursor', 'Hardware Cursor'),
    ]);
  };

  const buildSoundOptions = () => {
    soundSaved = options.getSoundSettings?.() ?? soundSaved;
    soundDraft = { ...soundSaved };
    const soundSlider = (key: 'masterVolume' | 'sfxVolume' | 'musicVolume', label: string, isDisabled?: () => boolean): OptionRow => ({
      kind: 'slider', key, label, min: 0, max: 1, step: 0.01,
      get: () => soundDraft[key],
      set: (value) => { soundDraft[key] = value; },
      format: (value) => `${Math.round(value * 100)}%`,
      isDisabled,
    });
    soundDialog.open('Sound Options', [
      { kind: 'section', label: 'Volume' },
      soundSlider('masterVolume', 'Master Volume'),
      { kind: 'section', label: 'Sound Effects' },
      { kind: 'check', key: 'soundEnabled', label: 'Enable Sound', get: () => soundDraft.soundEnabled, set: (value) => { soundDraft.soundEnabled = value; } },
      soundSlider('sfxVolume', 'Sound Volume', () => !soundDraft.soundEnabled),
      { kind: 'section', label: 'Music' },
      { kind: 'check', key: 'musicEnabled', label: 'Enable Music', get: () => soundDraft.musicEnabled, set: (value) => { soundDraft.musicEnabled = value; } },
      soundSlider('musicVolume', 'Music Volume', () => !soundDraft.musicEnabled),
    ]);
  };

  const buildAddonOptions = (reset = true) => {
    if (reset) addonDraft = { ...addonSaved };
    const rows: OptionRow[] = [];
    for (const section of ['Quests', 'Action Bars', 'Combat', 'Items', 'Map'] as const) {
      rows.push({ kind: 'section', label: section });
      for (const addon of BUILT_IN_ADDONS.filter((candidate) => candidate.section === section)) rows.push({
        kind: 'check', key: addon.id, label: addon.label,
        get: () => addonDraft[addon.id],
        set: (value) => { addonDraft[addon.id] = value; },
      });
    }
    addonDialog.open('AddOns', rows);
  };

  const controller: GameMenuController = {
    openMenu: () => showMode('menu'),
    openVideoOptions: () => { buildVideoOptions(); showMode('video'); },
    openSoundOptions: () => { buildSoundOptions(); showMode('sound'); },
    openInterfaceOptions: () => { interfaceOptions.open(); showMode('interface'); },
    close: () => showMode('closed'),
    handleEscape: () => {
      if (mode === 'closed') showMode('menu');
      else if (mode === 'interface') {
        // Escape is Cancel: revert live-previewed cvars and return to the menu.
        interfaceOptions.cancel();
        showMode('menu');
      }
      else if (mode === 'sound') {
        // Slider/checkbox changes preview live. Escape is Cancel in FrameXML,
        // so restore the last committed snapshot before returning to the menu.
        soundDraft = { ...soundSaved };
        options.onApplySound?.(soundSaved, 'initial');
        showMode('menu');
      } else if (mode === 'video') {
        draft = { ...saved };
        showMode('menu');
      } else if (mode === 'addons') { addonDraft = { ...addonSaved }; showMode('menu'); }
      else showMode('closed');
      return true;
    },
    isOpen: () => mode !== 'closed',
    applyCurrentVideo: (reason) => options.onApplyVideo(saved, reason),
  };

  return controller;
}
