import { loginToRealm } from '../auth';
import type { AuthSession } from '../auth';
import type { GlueOverlay } from './GlueOverlay';
import { installQuestLoginKeyboard } from './quest-login-keyboard';

// Both local development and deployed clients use their site's /wow-ws bridge.
// Server Settings can override it (localStorage 'vanillagl-auth-proxy').
// The original glue-screen theme has not been extracted into this asset corpus. Keep
// the login screen audible with a verified Vanilla music file instead of requesting a
// nonexistent /login/music asset and silently failing at runtime.
const LOGIN_MUSIC_OPUS_URL = '/audio/theme.opus.ogg';
const LOGIN_MUSIC_SOURCE_URL = '/audio/theme.mp3';
function defaultAuthProxy(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/wow-ws/?target=auth`;
}
function configuredAuthProxy(): string {
  const stored = localStorage.getItem('vanillagl-auth-proxy');
  const formerPageHostDefault = `ws://${window.location.hostname}:9000/?target=auth`;
  return !stored || stored === formerPageHostDefault ? defaultAuthProxy() : stored;
}

export class LoginScreen {
  private form: HTMLFormElement | null = null;
  private accountInput: HTMLInputElement | null = null;
  private passwordInput: HTMLInputElement | null = null;
  private rememberCheckbox: HTMLInputElement | null = null;
  private loginBtn: HTMLButtonElement | null = null;
  private bgAudio: HTMLAudioElement | null = null;
  private startAudioHandler?: () => void;
  private removeQuestKeyboard?: () => void;
  private readonly handleAudioError = () => {
    if (!this.bgAudio || this.bgAudio.src.endsWith(LOGIN_MUSIC_SOURCE_URL)) return;
    this.bgAudio.src = LOGIN_MUSIC_SOURCE_URL;
    this.bgAudio.load();
    if (this.bgAudio.volume > 0) this.bgAudio.play().catch(() => {});
  };

  constructor(
    private readonly overlay: GlueOverlay,
    private readonly onLoginSuccess: (session: AuthSession, proxyUrl: string) => void
  ) {}

  show() {
    const eulaAccepted = localStorage.getItem('vanillagl-eula-accepted') === 'true';
    const tosAccepted = localStorage.getItem('vanillagl-tos-accepted') === 'true';

    if (!eulaAccepted) {
      this.showEULA();
    } else if (!tosAccepted) {
      this.showTOS();
    } else {
      this.showLoginForm();
    }
  }

  private showEULA() {
    const html = `
      <div class="glue-popup-overlay">
        <div class="glue-dialog glue-eula-dialog">
          <div class="glue-dialog-header">End User License Agreement</div>
          <div class="glue-eula-text">
            <strong>VANILLAGL — END USER LICENSE AGREEMENT</strong><br/>
            Last Updated: August 2026<br/><br/>
            IMPORTANT NOTICE:<br/>
            YOU SHOULD READ THE FOLLOWING END USER LICENSE AGREEMENT CAREFULLY BEFORE USING THIS BROWSER ENGINE CLIENT.<br/><br/>
            This End User License Agreement ("EULA") governs your use of the client software ("Software") for VanillaGL. By clicking the "Accept" button below, you agree that you have read, understand, and agree to be bound by the terms and conditions of this Agreement.<br/><br/>
            <strong>1. Grant of a Limited Use License.</strong><br/>
            The contributors hereby grant, and by using you thereby accept, a limited, non-exclusive, open-source license to use the Software in accordance with the project license.<br/><br/>
            <strong>2. Description of Other Rights and Limitations.</strong><br/>
            You may use, copy, modify, and distribute the engine in compliance with the open source license terms accompanying this project.<br/><br/>
            <strong>3. Termination.</strong><br/>
            This License Agreement is effective until terminated. You may terminate the License Agreement at any time by discontinuing use of the Software.<br/><br/>
            <strong>4. Network Connectivity.</strong><br/>
            THE CLIENT CONNECTS TO CONFIGURED WEBSOCKET PROXIES AND GAME REALMS AS SPECIFIED BY THE USER OR OPERATOR.
          </div>
          <div class="glue-dialog-actions" style="display: flex; justify-content: space-between; gap: 15px;">
            <button id="glue-eula-decline" class="glue-button">Decline</button>
            <button id="glue-eula-accept" class="glue-button">Accept</button>
          </div>
        </div>
      </div>
    `;

    const el = this.overlay.showScreen(html);
    el.querySelector('#glue-eula-accept')!.addEventListener('click', () => {
      localStorage.setItem('vanillagl-eula-accepted', 'true');
      this.show();
    });
    el.querySelector('#glue-eula-decline')!.addEventListener('click', () => {
      this.overlay.showError('You must accept the End User License Agreement to use the VanillaGL engine.', () => {
        this.show();
      });
    });
  }

  private showTOS() {
    const html = `
      <div class="glue-popup-overlay">
        <div class="glue-dialog glue-eula-dialog">
          <div class="glue-dialog-header">Terms of Service</div>
          <div class="glue-eula-text">
            <strong>VANILLAGL — TERMS OF SERVICE</strong><br/>
            Last Updated: August 2026<br/><br/>
            Welcome to VanillaGL. To use this client, you must agree to these Terms of Service. By clicking the "Accept" button below, you agree to be bound by these Terms.<br/><br/>
            <strong>1. Rules of Conduct.</strong><br/>
            You agree that you will use this engine in compliance with applicable laws, third-party server operator terms, and acceptable use policies.<br/><br/>
            <strong>2. Ownership & Open Source.</strong><br/>
            This engine is open-source software provided under the MIT License. All original assets, custom code, and documentation belong to their respective contributors.<br/><br/>
            <strong>3. Disclaimer of Warranty.</strong><br/>
            THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE.
          </div>
          <div class="glue-dialog-actions" style="display: flex; justify-content: space-between; gap: 15px;">
            <button id="glue-tos-decline" class="glue-button">Decline</button>
            <button id="glue-tos-accept" class="glue-button">Accept</button>
          </div>
        </div>
      </div>
    `;

    const el = this.overlay.showScreen(html);
    el.querySelector('#glue-tos-accept')!.addEventListener('click', () => {
      localStorage.setItem('vanillagl-tos-accepted', 'true');
      this.show();
    });
    el.querySelector('#glue-tos-decline')!.addEventListener('click', () => {
      this.overlay.showError('You must accept the Terms of Service to use the VanillaGL engine.', () => {
        this.show();
      });
    });
  }

  private showLoginForm() {
    const storedAccount = localStorage.getItem('vanillagl-account') ?? '';
    const isRemembered = localStorage.getItem('vanillagl-remember') !== 'false';
    const storedVolume = localStorage.getItem('vanillagl-music-volume') ?? '98';

    const html = `
      <div class="glue-login-container">
        <!-- Logo container -->
        <div class="glue-logo-container" id="glue-logo"></div>
        <div class="glue-logo-fallback" id="glue-logo-fallback" style="display: none;">
          <h1>VANILLAGL</h1>
          <h2>BROWSER MMORPG CLIENT</h2>
        </div>

        <!-- Floating login fields -->
        <form id="glue-login-form" class="glue-login-fields">
          <div class="glue-field-group">
            <div class="glue-field-label">Account Name</div>
            <div class="glue-field-editbox">
              <input id="glue-account" class="glue-login-editbox" autocomplete="username" spellcheck="false" value="${this.escape(storedAccount)}" required />
            </div>
          </div>
          <div class="glue-field-group">
            <div class="glue-field-label">Account Password</div>
            <div class="glue-field-editbox">
              <input id="glue-password" class="glue-login-editbox" type="password" autocomplete="current-password" required />
            </div>
          </div>
          <!-- Login button -->
          <button type="submit" id="glue-login-btn" class="glue-button glue-login-submit">Login</button>
        </form>

        <!-- Left panel buttons (BOTTOMLEFT) -->
        <div class="glue-login-left-panel">
          <button id="glue-btn-manage" class="glue-button glue-button-small">Manage Account</button>
          <button id="glue-btn-community" class="glue-button glue-button-small">Community Site</button>
          <button id="glue-btn-server-settings" class="glue-button glue-button-small">Server Settings</button>
        </div>

        <!-- Remember Account Name checkbox (below left buttons) -->
        <label class="glue-checkbox-label glue-login-remember-container">
          <input type="checkbox" id="glue-remember" class="glue-checkbox" ${isRemembered ? 'checked' : ''} />
          Remember Account Name
        </label>

        <!-- Right panel buttons (BOTTOMRIGHT) -->
        <div class="glue-login-right-panel">
          <button id="glue-btn-cinematics" class="glue-button glue-button-small">Cinematics</button>
          <button id="glue-btn-credits" class="glue-button glue-button-small">Credits</button>
          <button id="glue-btn-terms" class="glue-button glue-button-small">Terms of Use</button>
          <button id="glue-btn-quit" class="glue-button glue-button-small">Quit</button>
        </div>

        <!-- Music volume slider -->
        <div class="glue-music-slider-container">
          <span>Music</span>
          <input type="range" id="glue-music-slider" min="0" max="100" value="${storedVolume}" />
          <span id="glue-music-val">${storedVolume}</span>
        </div>

        <!-- Bottom row: version + open-source copyright -->
        <div class="glue-login-bottom-row">
          <div class="glue-login-version">VanillaGL<br/>v1.0.0 (WebGL2)</div>
          <div class="glue-login-bottom-center">
            <div class="glue-login-copyright">Open-source software licensed under the MIT License.</div>
          </div>
          <div style="width: 180px;"></div>
        </div>
      </div>
    `;

    const el = this.overlay.showScreen(html);
    this.form = el.querySelector('#glue-login-form') as HTMLFormElement;
    this.accountInput = el.querySelector('#glue-account') as HTMLInputElement;
    this.passwordInput = el.querySelector('#glue-password') as HTMLInputElement;
    this.rememberCheckbox = el.querySelector('#glue-remember') as HTMLInputElement;
    this.loginBtn = el.querySelector('#glue-login-btn') as HTMLButtonElement;
    this.removeQuestKeyboard?.(); this.removeQuestKeyboard = installQuestLoginKeyboard(this.form);

    // Handle logo image load fail
    const logoEl = el.querySelector('#glue-logo') as HTMLElement;
    const fallbackLogo = el.querySelector('#glue-logo-fallback') as HTMLElement;
    const checkLogoImage = new Image();
    checkLogoImage.src = '/ui/Interface/Glues/Common/Glues-WoW-Logo.png';
    checkLogoImage.onerror = () => {
      logoEl.style.display = 'none';
      fallbackLogo.style.display = 'block';
    };

    // Bind login form submission
    this.form.addEventListener('submit', (e) => this.handleSubmit(e));

    // Left Panel Actions
    el.querySelector('#glue-btn-manage')!.addEventListener('click', () => {
      this.overlay.showError('Account management is provided by the configured server operator.');
    });
    el.querySelector('#glue-btn-community')!.addEventListener('click', () => {
      this.overlay.showError('Community links are provided by the configured server operator.');
    });
    el.querySelector('#glue-btn-server-settings')!.addEventListener('click', () => {
      this.showServerSettings();
    });

    // Right Panel Actions
    el.querySelector('#glue-btn-cinematics')!.addEventListener('click', () => {
      this.overlay.showError('Intro Cinematic is currently unavailable in this build.');
    });
    el.querySelector('#glue-btn-credits')!.addEventListener('click', () => {
      this.showCredits();
    });
    el.querySelector('#glue-btn-terms')!.addEventListener('click', () => {
      this.showTOS();
    });
    el.querySelector('#glue-btn-quit')!.addEventListener('click', () => {
      this.showQuitConfirmation();
    });

    // Ambient Music Playback & Volume Control
    this.bgAudio = new Audio();
    const supportsOpus = this.bgAudio.canPlayType('audio/ogg; codecs="opus"') !== '';
    this.bgAudio.src = supportsOpus ? LOGIN_MUSIC_OPUS_URL : LOGIN_MUSIC_SOURCE_URL;
    if (supportsOpus) this.bgAudio.addEventListener('error', this.handleAudioError, { once: true });
    this.bgAudio.loop = true;
    this.bgAudio.volume = Number(storedVolume) / 100;

    const slider = el.querySelector('#glue-music-slider') as HTMLInputElement;
    const valEl = el.querySelector('#glue-music-val')!;
    slider.addEventListener('input', () => {
      const vol = Number(slider.value);
      valEl.textContent = String(vol);
      localStorage.setItem('vanillagl-music-volume', String(vol));
      if (this.bgAudio) {
        this.bgAudio.volume = vol / 100;
        if (this.bgAudio.paused && vol > 0) {
          this.bgAudio.play().catch(() => {});
        }
      }
    });

    // User interaction auto-play trigger for audio
    this.startAudioHandler = () => {
      if (this.bgAudio?.paused && Number(slider.value) > 0) {
        this.bgAudio.play().catch(() => {});
      }
    };
    window.addEventListener('click', this.startAudioHandler);
    window.addEventListener('touchend', this.startAudioHandler);
    window.addEventListener('keydown', this.startAudioHandler);

    // Autofocus password if account is filled
    if (storedAccount) {
      this.passwordInput.focus();
    } else {
      this.accountInput.focus();
    }
  }

  private showServerSettings() {
    const storedProxy = configuredAuthProxy();

    const html = `
      <div class="glue-popup-overlay">
        <div class="glue-dialog glue-server-settings-dialog">
          <div class="glue-dialog-header">Server Settings</div>
          <div class="glue-dialog-body" style="display: flex; flex-direction: column; gap: 10px;">
            <div class="glue-input-container">
              <label for="glue-modal-proxy">Realmd Proxy URL</label>
              <input id="glue-modal-proxy" class="glue-input" value="${this.escape(storedProxy)}" required />
            </div>
            <div style="display: flex; justify-content: space-between; gap: 15px; margin-top: 15px;">
              <button id="glue-settings-cancel" class="glue-button">Cancel</button>
              <button id="glue-settings-ok" class="glue-button">Okay</button>
            </div>
          </div>
        </div>
      </div>
    `;

    const popup = document.createElement('div');
    popup.innerHTML = html;
    const popupEl = popup.firstElementChild as HTMLElement;
    document.getElementById('glue-overlay')!.appendChild(popupEl);

    const input = popupEl.querySelector('#glue-modal-proxy') as HTMLInputElement;
    popupEl.querySelector('#glue-settings-cancel')!.addEventListener('click', () => {
      popupEl.remove();
    });

    popupEl.querySelector('#glue-settings-ok')!.addEventListener('click', () => {
      const val = input.value.trim();
      if (val) {
        localStorage.setItem('vanillagl-auth-proxy', val);
      }
      popupEl.remove();
    });
  }

  private showCredits() {
    const html = `
      <div class="glue-popup-overlay">
        <div class="glue-dialog glue-credits-dialog">
          <div class="glue-dialog-header">VanillaGL Credits</div>
          <div class="glue-eula-text" style="text-align: center;">
            <strong style="color: #ffd100; font-size: 14px;">VANILLAGL CONTRIBUTORS</strong><br/><br/>
            <strong>Core Development</strong><br/>
            Rigel<br/><br/>
            <strong>Web Interface & Front-End Architecture</strong><br/>
            Zipper<br/><br/>
            <strong>Netcode & SRP6 Auth Proxy Engine</strong><br/>
            Void<br/><br/>
            <hr style="border: 0; border-top: 1px solid rgba(255, 209, 0, 0.25); margin: 15px 0;" />
            Special thanks to the open source projects that made the browser tooling possible.
          </div>
          <div style="text-align: center;">
            <button id="glue-credits-close" class="glue-button">Close</button>
          </div>
        </div>
      </div>
    `;

    const popup = document.createElement('div');
    popup.innerHTML = html;
    const popupEl = popup.firstElementChild as HTMLElement;
    document.getElementById('glue-overlay')!.appendChild(popupEl);

    popupEl.querySelector('#glue-credits-close')!.addEventListener('click', () => {
      popupEl.remove();
    });
  }

  private showQuitConfirmation() {
    const html = `
      <div class="glue-popup-overlay">
        <div class="glue-dialog glue-error-dialog">
          <div class="glue-dialog-header">Quit Game</div>
          <div class="glue-dialog-body" style="text-align: center;">
            <p style="color: #fff; margin-bottom: 15px;">Are you sure you want to exit?</p>
            <div style="display: flex; justify-content: space-between; gap: 15px;">
              <button id="glue-quit-cancel" class="glue-button">Cancel</button>
              <button id="glue-quit-confirm" class="glue-button">Exit</button>
            </div>
          </div>
        </div>
      </div>
    `;

    const popup = document.createElement('div');
    popup.innerHTML = html;
    const popupEl = popup.firstElementChild as HTMLElement;
    document.getElementById('glue-overlay')!.appendChild(popupEl);

    popupEl.querySelector('#glue-quit-cancel')!.addEventListener('click', () => {
      popupEl.remove();
    });

    popupEl.querySelector('#glue-quit-confirm')!.addEventListener('click', () => {
      popupEl.remove();
      // Reload or empty client window
      window.location.reload();
    });
  }

  showPinPad(digits: string[], callback: (pin: string) => void) {
    let enteredPin = '';
    const xOffset = Math.floor(Math.random() * 60) - 30;
    const yOffset = Math.floor(Math.random() * 60) - 30;

    const html = `
      <div class="glue-popup-overlay">
        <div class="glue-dialog glue-pin-dialog" style="transform: translate(${xOffset}px, ${yOffset}px);">
          <div class="glue-dialog-header">Enter PIN</div>
          <div class="glue-dialog-body">
            <div id="glue-pin-stars" class="glue-pin-display"></div>
            <div class="glue-pin-grid">
              ${digits.map((d) => `<button class="glue-button glue-pin-btn" data-val="${d}">${d}</button>`).join('')}
              <button class="glue-button glue-pin-btn" data-action="backspace">&lt;</button>
              <button class="glue-button glue-pin-btn" data-action="clear">Clear</button>
            </div>
            <div style="display: flex; gap: 10px; justify-content: space-between; margin-top: 15px;">
              <button id="glue-pin-cancel" class="glue-button">Cancel</button>
              <button id="glue-pin-ok" class="glue-button" disabled>Okay</button>
            </div>
          </div>
        </div>
      </div>
    `;

    const popup = document.createElement('div');
    popup.innerHTML = html;
    const popupEl = popup.firstElementChild as HTMLElement;
    document.getElementById('glue-overlay')!.appendChild(popupEl);

    const starsEl = popupEl.querySelector('#glue-pin-stars')!;
    const okBtn = popupEl.querySelector('#glue-pin-ok') as HTMLButtonElement;

    const updateDisplay = () => {
      starsEl.textContent = '*'.repeat(enteredPin.length);
      okBtn.disabled = enteredPin.length === 0;
    };

    popupEl.querySelectorAll('.glue-pin-btn[data-val]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (enteredPin.length < 10) {
          enteredPin += (btn as HTMLElement).dataset.val;
          updateDisplay();
        }
      });
    });

    popupEl.querySelector('.glue-pin-btn[data-action="backspace"]')!.addEventListener('click', () => {
      enteredPin = enteredPin.slice(0, -1);
      updateDisplay();
    });

    popupEl.querySelector('.glue-pin-btn[data-action="clear"]')!.addEventListener('click', () => {
      enteredPin = '';
      updateDisplay();
    });

    popupEl.querySelector('#glue-pin-cancel')!.addEventListener('click', () => {
      popupEl.remove();
    });

    popupEl.querySelector('#glue-pin-ok')!.addEventListener('click', () => {
      popupEl.remove();
      callback(enteredPin);
    });
  }

  private async handleSubmit(e: Event) {
    e.preventDefault();
    if (!this.form || !this.accountInput || !this.passwordInput || !this.loginBtn) return;

    const account = this.accountInput.value.trim().toUpperCase();
    const password = this.passwordInput.value;
    const proxy = configuredAuthProxy();
    const remember = this.rememberCheckbox?.checked ?? true;

    this.loginBtn.disabled = true;
    this.overlay.showLoading('Connecting to realm...');

    try {
      if (remember) {
        localStorage.setItem('vanillagl-account', account);
      } else {
        localStorage.removeItem('vanillagl-account');
      }
      localStorage.setItem('vanillagl-remember', String(remember));

      const session = await loginToRealm(proxy, account, password, (msg) => {
        this.overlay.updateLoading(msg);
      });

      this.overlay.hideLoading();

      // Stop audio playback on successful login transition
      if (this.bgAudio) {
        this.bgAudio.pause();
      }

      this.onLoginSuccess(session, proxy);
    } catch (err) {
      this.overlay.hideLoading();
      this.loginBtn.disabled = false;
      this.overlay.showError((err as Error).message);
    }
  }

  destroy() {
    this.removeQuestKeyboard?.(); this.removeQuestKeyboard = undefined;
    if (this.startAudioHandler) {
      window.removeEventListener('click', this.startAudioHandler);
      window.removeEventListener('touchend', this.startAudioHandler);
      window.removeEventListener('keydown', this.startAudioHandler);
      this.startAudioHandler = undefined;
    }
    if (this.bgAudio) {
      this.bgAudio.removeEventListener('error', this.handleAudioError);
      this.bgAudio.pause();
      this.bgAudio.removeAttribute('src');
      this.bgAudio.load();
      this.bgAudio = null;
    }
  }

  private escape(value: string) {
    return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
  }
}
