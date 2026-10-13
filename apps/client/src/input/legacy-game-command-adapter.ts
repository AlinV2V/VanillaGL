import type { GameCommand, MoveIntent } from '../simulation/commands';

type MovementCode = 'KeyW' | 'KeyA' | 'KeyS' | 'KeyD';

const emitKey = (code: string, down: boolean) => {
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
    code,
    key: code.startsWith('Digit') ? code.slice(5) : code === 'Space' ? ' ' : code,
    bubbles: true,
    cancelable: true,
  }));
};

/**
 * Transitional presentation/input adapter. New touch/VR/etc. code emits semantic commands while
 * the existing desktop controller still consumes keyboard events. Delete this after the main input
 * controller consumes GameCommand directly.
 */
export class LegacyGameCommandAdapter {
  private readonly heldMovement = new Set<MovementCode>();

  dispatch(command: GameCommand): void {
    switch (command.kind) {
      case 'move':
        this.applyMoveIntent(command.intent);
        break;
      case 'jump':
        emitKey('Space', command.pressed);
        break;
      case 'use-action-slot':
        if (command.slot >= 1 && command.slot <= 9) emitKey(`Digit${command.slot}`, command.pressed);
        break;
      case 'target-next':
        emitKey('Tab', command.pressed);
        break;
      default:
        window.dispatchEvent(new CustomEvent<GameCommand>('vanillagl-game-command', { detail: command }));
        break;
    }
  }

  releaseAll(): void {
    for (const code of this.heldMovement) emitKey(code, false);
    this.heldMovement.clear();
    emitKey('Space', false);
    emitKey('Tab', false);
    for (let slot = 1; slot <= 9; slot++) emitKey(`Digit${slot}`, false);
  }

  private setMovementKey(code: MovementCode, down: boolean): void {
    const held = this.heldMovement.has(code);
    if (held === down) return;
    if (down) this.heldMovement.add(code);
    else this.heldMovement.delete(code);
    emitKey(code, down);
  }

  private applyMoveIntent(intent: MoveIntent): void {
    this.setMovementKey('KeyW', intent.forward > 0.2);
    this.setMovementKey('KeyS', intent.forward < -0.2);
    this.setMovementKey('KeyA', intent.strafe < -0.2);
    this.setMovementKey('KeyD', intent.strafe > 0.2);
  }
}
