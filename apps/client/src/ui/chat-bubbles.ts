/** Asset conversion utility. */
import * as THREE from 'three';
import { getInterfaceCvars } from './interface-runtime';

/** vMaNGOS SharedDefines.h (1.12.1) chat types this layer reacts to. */
export const BUBBLE_CHAT_TYPE = {
  SAY: 0x00,
  PARTY: 0x01,
  YELL: 0x05,
  MONSTER_SAY: 0x0b,
  MONSTER_YELL: 0x0c,
} as const;

/** Longest a bubble stays up, and how much each character adds, both in milliseconds. */
const BUBBLE_BASE_MS = 3200;
const BUBBLE_MS_PER_CHAR = 55;
const BUBBLE_MAX_MS = 12000;
/** Past this the speaker is too far away for their bubble to be legible. */
const BUBBLE_MAX_DISTANCE = 55;

type Bubble = {
  element: HTMLElement;
  guid: string;
  expiresAt: number;
  yell: boolean;
};

export type ChatBubbleDeps = {
  camera: THREE.Camera;
  /** Head position for a speaker in local/world render space, or undefined when not visible. */
  overheadPositionOf: (guid: string) => { x: number; y: number; z: number } | undefined;
};

/**
 * Whether a chat type should raise a bubble at all, before we even look for the speaker.
 * SAY/YELL and their monster equivalents ride "Show Chat Bubbles"; PARTY has its own
 * checkbox because party chat is usually coming from people who are not standing next to you.
 */
export function chatTypeMakesBubble(type: number): boolean {
  const cvars = getInterfaceCvars();
  if (type === BUBBLE_CHAT_TYPE.PARTY) return Number(cvars.chatBubblesParty) === 1;
  if (Number(cvars.chatBubbles) !== 1) return false;
  return type === BUBBLE_CHAT_TYPE.SAY
    || type === BUBBLE_CHAT_TYPE.YELL
    || type === BUBBLE_CHAT_TYPE.MONSTER_SAY
    || type === BUBBLE_CHAT_TYPE.MONSTER_YELL;
}

export class ChatBubbleLayer {
  private readonly layer = document.createElement('div');
  private readonly bubbles = new Map<string, Bubble>();
  private readonly worldPoint = new THREE.Vector3();
  private readonly projected = new THREE.Vector3();
  private readonly cameraPoint = new THREE.Vector3();

  constructor(private readonly deps: ChatBubbleDeps) {
    this.layer.className = 'wow-chat-bubble-layer';
    document.body.appendChild(this.layer);
  }

  /**
   * Raise (or replace) the bubble for a speaker. Silently ignores chat types the options
   * have turned off and messages with no speaker guid, so callers can forward every event.
   */
  speak(guid: string | undefined, message: string, type: number) {
    if (!guid || !message.trim() || !chatTypeMakesBubble(type)) return;
    const yell = type === BUBBLE_CHAT_TYPE.YELL || type === BUBBLE_CHAT_TYPE.MONSTER_YELL;
    const durationMs = Math.min(BUBBLE_MAX_MS, BUBBLE_BASE_MS + message.length * BUBBLE_MS_PER_CHAR);
    let bubble = this.bubbles.get(guid);
    if (!bubble) {
      const element = document.createElement('div');
      element.className = 'wow-chat-bubble';
      this.layer.appendChild(element);
      bubble = { element, guid, expiresAt: 0, yell };
      this.bubbles.set(guid, bubble);
    }
    bubble.expiresAt = performance.now() + durationMs;
    bubble.yell = yell;
    // textContent, never innerHTML: chat is remote player input.
    bubble.element.textContent = message;
    bubble.element.classList.toggle('is-yell', yell);
  }

  /** Project every live bubble and retire the expired ones. Call once per frame. */
  update() {
    if (this.bubbles.size === 0) return;
    const now = performance.now();
    this.deps.camera.getWorldPosition(this.cameraPoint);
    for (const [guid, bubble] of this.bubbles) {
      if (now >= bubble.expiresAt) {
        bubble.element.remove();
        this.bubbles.delete(guid);
        continue;
      }
      const head = this.deps.overheadPositionOf(guid);
      if (!head) {
        // The speaker walked out of visibility. Keep the bubble alive but hidden — they may
        // step back into range before it expires.
        bubble.element.style.display = 'none';
        continue;
      }
      // Sit above the unit name rather than on top of it.
      this.worldPoint.set(head.x, head.y, head.z + 0.95);
      const distance = this.cameraPoint.distanceTo(this.worldPoint);
      if (distance > BUBBLE_MAX_DISTANCE) {
        bubble.element.style.display = 'none';
        continue;
      }
      this.projected.copy(this.worldPoint).project(this.deps.camera);
      if (this.projected.z < -1 || this.projected.z > 1) {
        bubble.element.style.display = 'none';
        continue;
      }
      const x = (this.projected.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-this.projected.y * 0.5 + 0.5) * window.innerHeight;
      bubble.element.style.display = '';
      bubble.element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
      // Fade out over the last 700ms so bubbles do not simply blink away.
      const remaining = bubble.expiresAt - now;
      bubble.element.style.opacity = remaining < 700 ? (remaining / 700).toFixed(2) : '1';
    }
  }

  /** Drop every bubble — used on logout/world change so stale speech cannot survive it. */
  clear() {
    for (const bubble of this.bubbles.values()) bubble.element.remove();
    this.bubbles.clear();
  }
}
