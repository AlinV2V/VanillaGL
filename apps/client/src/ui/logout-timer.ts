/** Asset conversion utility. */
/** GlobalStrings.lua, transcribed. */
const CAMP_TIMER = '%d %s until logout';
const SECONDS = 'Second';
const SECONDS_P1 = 'Seconds';
const MINUTES = 'Minute';
const MINUTES_P1 = 'Minutes';
const CANCEL = 'Cancel';
const ERR_LOGOUT_FAILED = "You can't logout now.";

/** vMaNGOS WorldSession.h:284 — `m_logoutTime + 20`. Also StaticPopupDialogs["CAMP"].timeout. */
export const LOGOUT_WINDOW_SECONDS = 20;

/** Vanilla GetText("SECONDS", nil, n): the _P1 plural for anything that is not exactly 1. */
function unitWord(singular: string, plural: string, count: number): string {
  return count === 1 ? singular : plural;
}

/** StaticPopup.lua:1290,1304-1308 verbatim: ceil, then seconds under a minute, minutes above. */
export function formatCampTimer(secondsRemaining: number): string {
  const left = Math.ceil(Math.max(0, secondsRemaining));
  if (left < 60) return CAMP_TIMER.replace('%d', String(left)).replace('%s', unitWord(SECONDS, SECONDS_P1, left));
  const minutes = Math.ceil(left / 60);
  return CAMP_TIMER.replace('%d', String(minutes)).replace('%s', unitWord(MINUTES, MINUTES_P1, minutes));
}

export interface LogoutPopup {
  forceAction(message: string, label: string, callback: () => void, disabled?: boolean): void;
  setMessage(message: string): void;
  hide(): void;
  isOpen(): boolean;
}

export interface LogoutTimerDeps {
  popup: LogoutPopup;
  /** Send CMSG_LOGOUT_CANCEL. */
  sendCancel: () => void;
  /** The session is over — return to character select. */
  finishLogout: () => void;
  /** Red UI error line, for a refused logout. */
  showError: (message: string) => void;
  log?: (message: string) => void;
}

export interface LogoutTimer {
  /** SMSG_LOGOUT_RESPONSE arrived. */
  handleResponse(event: { reason: number; instant: boolean }): void;
  /** SMSG_LOGOUT_CANCEL_ACK arrived. */
  handleCancelAck(): void;
  /** SMSG_LOGOUT_COMPLETE arrived. */
  handleComplete(): void;
  /** Drive the countdown. Call once per frame with seconds elapsed. */
  update(dt: number): void;
  /** True while the 20s window is running — movement is server-rooted during it. */
  isPending(): boolean;
  /** ESC or an explicit cancel from the game menu. */
  cancel(): void;
}

export function createLogoutTimer(deps: LogoutTimerDeps): LogoutTimer {
  const log = deps.log ?? (() => {});
  let remaining = 0;
  let pending = false;
  let lastShown = -1;

  const closePopup = () => {
    pending = false;
    remaining = 0;
    lastShown = -1;
    deps.popup.hide();
  };

  const cancel = () => {
    if (!pending) return;
    closePopup();
    deps.sendCancel();
    log('logout: cancelled');
  };

  return {
    handleResponse({ reason, instant }) {
      if (reason !== 0) {
        // MiscHandler.cpp:290-296 — in combat / jumping / GM-frozen. Vanilla surfaces this as the
        // plain red error line; there is no dialog for it.
        closePopup();
        deps.showError(ERR_LOGOUT_FAILED);
        log(`logout: refused (reason ${reason})`);
        return;
      }
      if (instant) {
        // Resting, on a taxi, or privileged: the server already called LogoutPlayer(true) and
        // SMSG_LOGOUT_COMPLETE is on its way. No countdown, no dialog. This is the INN case — the
        // inn is where the timer is skipped, not where it appears.
        closePopup();
        log('logout: instant (resting/taxi)');
        return;
      }
      pending = true;
      remaining = LOGOUT_WINDOW_SECONDS;
      lastShown = -1;
      deps.popup.forceAction(formatCampTimer(remaining), CANCEL, cancel);
      lastShown = LOGOUT_WINDOW_SECONDS;
      log(`logout: ${LOGOUT_WINDOW_SECONDS}s window started`);
    },

    handleCancelAck() {
      closePopup();
    },

    handleComplete() {
      closePopup();
      deps.finishLogout();
    },

    update(dt: number) {
      if (!pending) return;
      remaining = Math.max(0, remaining - dt);
      const shown = Math.ceil(remaining);
      if (shown !== lastShown) {
        lastShown = shown;
        deps.popup.setMessage(formatCampTimer(remaining));
      }
      // At zero the dialog goes away (StaticPopupDialogs["CAMP"].timeout = 20) but the session is
      // still the server's to end; SMSG_LOGOUT_COMPLETE does that.
      if (remaining <= 0) {
        pending = false;
        deps.popup.hide();
      }
    },

    isPending() {
      return pending;
    },

    cancel,
  };
}
