import { cameraBobProfile } from './locomotion-input';
import type { PlayerAnimState } from '../model-loader';

export class FollowCameraBob {
  private phase = 0;
  sample(enabled: boolean, grounded: boolean, swimming: boolean, state: PlayerAnimState, dt: number): number {
    if (!enabled || !grounded || swimming) return 0;
    const profile = cameraBobProfile(state); if (!profile) return 0;
    this.phase = (this.phase + profile.rate * dt) % (Math.PI * 2);
    return Math.sin(this.phase) * profile.amplitude;
  }
}
