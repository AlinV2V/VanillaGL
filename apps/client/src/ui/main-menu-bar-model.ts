/** Asset conversion utility. */
import type { MultiBarId, MultiBarVisibility } from './multi-action-bars';
export type MainMenuBarSkin = 'dwarf' | 'human' | 'night-elf';
export type MainMenuMicroButton =
  | 'character'
  | 'spellbook'
  | 'talents'
  | 'quest'
  | 'socials'
  | 'world'
  | 'mainmenu'
  | 'help';

export type MainMenuDropState = 'none' | 'valid' | 'invalid';

export type MainMenuActionView = {
  /** The zero-based visible slot. The gameplay action/page offset stays external. */
  slot: number;
  iconUrl?: string;
  hotkey?: string;
  count?: number;
  enabled?: boolean;
  /** Server update-field advice; false dims the icon but never disables authoritative click feedback. */
  usable?: boolean;
  /** A CasterAuraState/TargetAuraState reaction window is currently open. */
  reactive?: boolean;
  queued?: boolean;
  activeAttack?: boolean;
  outOfRange?: boolean;
  dropState?: MainMenuDropState;
  cooldown?: {
    remainingMs: number;
    durationMs: number;
    /** Override the normal ceil(seconds) presentation. */
    text?: string;
  };
};

export type MainMenuMicroView = {
  id: MainMenuMicroButton;
  enabled?: boolean;
  open?: boolean;
};

export type MainMenuBagView = {
  /** Vanilla bag ids are backpack=0, equipped bags=1..4. */
  bagId: number;
  isBackpack?: boolean;
  iconUrl?: string;
  hasBag?: boolean;
  enabled?: boolean;
  open?: boolean;
  dropState?: MainMenuDropState;
  count?: number;
};

export type MainMenuKeyringView = {
  /** SHOW_KEYRING: once a key has been observed, the button remains discoverable. */
  visible: boolean;
  open?: boolean;
  dropState?: MainMenuDropState;
};

export type MainMenuExperienceView = {
  current: number;
  maximum: number;
  /** Remaining rested bonus in XP, rendered after current XP. */
  restedBonus?: number;
  atMaxLevel?: boolean;
  /** Defaults to `current / maximum`; useful for localized or abbreviated text. */
  displayText?: string;
};

/** Per-bar slot views plus which of the two horizontal multibars the player has enabled. */
export type MainMenuMultiBarView = {
  visible: MultiBarVisibility;
  actions: Partial<Record<MultiBarId, readonly MainMenuActionView[]>>;
};

export type MainMenuShapeshiftView = {
  slot: number;
  spellId: number;
  name: string;
  iconUrl: string;
  active: boolean;
  usable: boolean;
  cooldown?: MainMenuActionView['cooldown'];
};

export type MainMenuBarViewModel = {
  skin?: MainMenuBarSkin;
  showEndCaps?: boolean;
  experience: MainMenuExperienceView;
  actionPage: number;
  actionPageCount?: number;
  actions: readonly MainMenuActionView[];
  /** ShapeshiftBarFrame: learned stances/forms, separate from the paged action buttons. */
  shapeshiftForms?: readonly MainMenuShapeshiftView[];
  multiBars?: MainMenuMultiBarView;
  microButtons?: readonly MainMenuMicroView[];
  bags?: readonly MainMenuBagView[];
  keyring?: MainMenuKeyringView;
  /** Round-trip latency in ms for the MainMenuBarPerformanceBar; omitted hides the bar. */
  latencyMs?: number;
  /**
   * Player portrait art for MicroButtonPortrait (MainMenuBarMicroButtons.xml:30-42).
   *
   * Vanilla's `SetPortraitTexture` renders the live 3D model into this texture. The static race
   * portrait remains only while that render target is unavailable.
   */
  portraitSource?: HTMLCanvasElement;
  portraitUrl?: string;
};

export type MainMenuBarTarget =
  | { kind: 'experience' }
  /** `bar` absent = the main ActionButton1..12 row; otherwise the named multibar. */
  | { kind: 'action'; slot: number; bar?: MultiBarId }
  | { kind: 'shapeshift'; slot: number }
  | { kind: 'page'; direction: 'up' | 'down' }
  | { kind: 'micro'; id: MainMenuMicroButton }
  | { kind: 'bag'; bagId: number }
  | { kind: 'keyring' }
  | { kind: 'latency' };

export type MainMenuBarCallbacks = {
  onActivate?: (target: MainMenuBarTarget, event: PointerEvent | KeyboardEvent) => void;
  onPointerDown?: (target: MainMenuBarTarget, event: PointerEvent) => void;
  /** OnDragStart: the pointer left the button while held. Suppresses the pending activation. */
  onDragStart?: (target: MainMenuBarTarget, event: PointerEvent) => void;
  /**
   * The release that ends a drag. `target` is the button under the pointer (OnReceiveDrag) or
   * undefined when the drag ended over nothing, which is a discard. `event` is absent when the drop
   * arrived through `cursor-drop-router` from a drag that started on a different panel.
   */
  onDrop?: (target: MainMenuBarTarget | undefined, event?: PointerEvent) => void;
  onPointerMove?: (target: MainMenuBarTarget | undefined, event: PointerEvent) => void;
  onPointerUp?: (target: MainMenuBarTarget | undefined, event: PointerEvent) => void;
  onContextMenu?: (target: MainMenuBarTarget, event: MouseEvent) => void;
  onHoverChange?: (target: MainMenuBarTarget | undefined, event?: PointerEvent) => void;
};
