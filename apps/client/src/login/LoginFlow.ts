import * as THREE from 'three';
import { restoreRendererViewport } from '../rendering/renderer-viewport';
import { connectWorld } from '../world';
import type { CharacterInfo, RealmWorldClient } from '../world';
import type { AuthSession } from '../auth';
import { GlueOverlay } from './GlueOverlay';
import { GlueBackground } from './GlueBackground';
import { CharacterPreview } from './CharacterPreview';
import { LoginScreen } from './LoginScreen';
import { RealmSelect } from './RealmSelect';
import { CharacterSelect } from './CharacterSelect';
import { CharacterCreate } from './CharacterCreate';
import { glueSceneForRace } from './glue-scene-loader';
import { gluePreviewViewport } from './glue-preview-viewport';

const REFRESH_SESSION_KEY = 'wow-browser-refresh-session';
/** Asset conversion utility. */
export function forgetResumeCharacter() {
  try {
    const raw = sessionStorage.getItem(REFRESH_SESSION_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw) as Partial<RefreshSession>;
    delete stored.characterGuid;
    sessionStorage.setItem(REFRESH_SESSION_KEY, JSON.stringify(stored));
  } catch {
    // A corrupt blob is not worth blocking logout over; the next start() drops it anyway.
    try { sessionStorage.removeItem(REFRESH_SESSION_KEY); } catch { /* locked storage */ }
  }
}

export enum LoginState {
  LOGIN,
  REALM_SELECT,
  CHAR_SELECT,
  CHAR_CREATE,
  ENTERING_WORLD,
}

type RefreshSession = {
  account: string;
  sessionKey: number[];
  realms: AuthSession['realms'];
  proxyUrl: string;
  realmIndex: number;
  characterGuid?: string;
  savedAt: number;
};

export interface LoginFlowOptions {
  renderer: THREE.WebGLRenderer;
  index: any[]; // TileEntry[]
  onEnterWorld: (char: CharacterInfo, worldClient: RealmWorldClient) => Promise<void>;
}

export class LoginFlow {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly overlay: GlueOverlay;
  private readonly background: GlueBackground;
  private readonly preview: CharacterPreview;
  private readonly clock: THREE.Clock;
  private readonly previewSize = new THREE.Vector2();
  private readonly index: any[];
  private readonly onEnterWorldCallback: (char: CharacterInfo, worldClient: RealmWorldClient) => Promise<void>;

  private state = LoginState.LOGIN;
  private authSession: AuthSession | null = null;
  private worldClient: RealmWorldClient | null = null;
  private proxyUrl = '';
  private currentRealmIndex = 0;
  private isDestroyed = false;
  private activeScreen: any = null;
  private loginScreen: LoginScreen | null = null;

  constructor(options: LoginFlowOptions) {
    this.renderer = options.renderer;
    this.index = options.index;
    this.onEnterWorldCallback = options.onEnterWorld;

    const canvas = this.renderer.domElement;
    this.clock = new THREE.Clock();
    const maxAnisotropy = Math.max(1, Math.min(16, this.renderer.capabilities?.getMaxAnisotropy?.() ?? 8));

    // Initialize systems
    const overlayContainer = document.getElementById('glue-overlay')!;
    this.overlay = new GlueOverlay(overlayContainer);
    this.background = new GlueBackground(canvas, maxAnisotropy);
    this.preview = new CharacterPreview(canvas, maxAnisotropy);
  }

  start() {
    this.setupRenderLoop();
    // QA: ?glue=login|realms|charselect|charcreate previews any glue screen with mocked
    // session/world data — no proxy/vMaNGOS needed (same spirit as ?inspect / ?creature / ?tile).
    const glue = new URLSearchParams(location.search).get('glue');
    if (glue) {
      this.applyGluePreview(glue);
      return;
    }
    // A stored session without a character is the post-logout (and refresh-at-char-select) state:
    // resumeRefreshSession reconnects the realm and, finding no character to re-enter, shows
    // character select. Requiring characterGuid here dumped both cases on the account screen.
    const restore = this.loadRefreshSession();
    if (restore) {
      void this.resumeRefreshSession(restore);
      return;
    }
    this.transitionTo(LoginState.LOGIN);
  }

  private loadRefreshSession() {
    try {
      const raw = sessionStorage.getItem(REFRESH_SESSION_KEY);
      if (!raw) return null;
      const stored = JSON.parse(raw) as RefreshSession;
      if (!stored.account || !stored.proxyUrl || !Array.isArray(stored.realms) || !Array.isArray(stored.sessionKey)) return null;
      if (stored.sessionKey.length !== 40) return null;
      return {
        session: {
          account: stored.account,
          sessionKey: new Uint8Array(stored.sessionKey),
          realms: stored.realms,
        } satisfies AuthSession,
        proxyUrl: stored.proxyUrl,
        realmIndex: Math.max(0, Math.min(stored.realmIndex || 0, stored.realms.length - 1)),
        characterGuid: stored.characterGuid,
      };
    } catch {
      sessionStorage.removeItem(REFRESH_SESSION_KEY);
      return null;
    }
  }

  private saveRefreshSession(characterGuid?: string | null) {
    if (!this.authSession || !this.proxyUrl) return;
    const previous = this.loadRefreshSession();
    const stored: RefreshSession = {
      account: this.authSession.account,
      sessionKey: Array.from(this.authSession.sessionKey),
      realms: this.authSession.realms,
      proxyUrl: this.proxyUrl,
      realmIndex: this.currentRealmIndex,
      characterGuid: characterGuid === undefined ? previous?.characterGuid : characterGuid ?? undefined,
      savedAt: Date.now(),
    };
    try {
      sessionStorage.setItem(REFRESH_SESSION_KEY, JSON.stringify(stored));
    } catch {
      // Private browsing / storage quota should not block login.
    }
  }

  private clearRefreshSession() {
    try {
      sessionStorage.removeItem(REFRESH_SESSION_KEY);
    } catch {
      // Ignore storage failures; explicit logout still closes the live socket.
    }
  }

  private async resumeRefreshSession(restore: NonNullable<ReturnType<LoginFlow['loadRefreshSession']>>) {
    this.authSession = restore.session;
    this.proxyUrl = restore.proxyUrl;
    this.currentRealmIndex = restore.realmIndex;
    const realm = this.authSession.realms[this.currentRealmIndex];
    if (!realm) {
      this.clearRefreshSession();
      this.transitionTo(LoginState.LOGIN);
      return;
    }

    this.overlay.showLoading(restore.characterGuid ? `Reconnecting ${realm.name}...` : `Connecting to realm ${realm.name}...`);
    try {
      const worldProxy = new URL(this.proxyUrl);
      worldProxy.searchParams.set('target', 'world');
      this.worldClient = await connectWorld(worldProxy.toString(), this.authSession, realm, (msg) => {
        this.overlay.updateLoading(msg);
      });
      const character = restore.characterGuid
        ? this.worldClient.characters.find((c) => c.guid === restore.characterGuid)
        : undefined;
      this.overlay.hideLoading();
      if (character) {
        await this.enterWorld(character);
        return;
      }
      this.saveRefreshSession(null);
      await this.transitionTo(LoginState.CHAR_SELECT);
    } catch (err) {
      this.overlay.hideLoading();
      this.overlay.showError((err as Error).message, () => {
        this.clearRefreshSession();
        this.transitionTo(LoginState.LOGIN);
      });
    }
  }

  private applyGluePreview(which: string) {
    const mkChar = (name: string, race: number, classId: number, gender: number, level: number, map: number): CharacterInfo =>
      ({
        guid: name, guidBytes: [0, 0, 0, 0, 0, 0, 0, 0], name, race, classId, gender,
        skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0,
        level, zone: 0, map, x: 0, y: 0, z: 0, equipment: [],
      } as unknown as CharacterInfo);
    const characters = [
      mkChar('Aldric', 1, 1, 0, 14, 0),
      mkChar('Shadowsong', 4, 3, 1, 32, 1),
      mkChar('Zulrokh', 8, 8, 0, 7, 1),
    ];
    this.authSession = {
      username: 'PREVIEW',
      realms: [
        { name: 'ChromWoW', population: 1.2, characters: 3, address: '127.0.0.1:8085' },
        { name: 'Nighthaven PvP', population: 2.4, characters: 0, address: '127.0.0.1:8086' },
        { name: 'Silver Hand RP', population: 0.4, characters: 1, address: '127.0.0.1:8087' },
      ],
    } as unknown as AuthSession;
    this.worldClient = {
      characters,
      deleteCharacter: async () => ({ success: true }),
      createCharacter: async () => ({ success: true }),
      reloadCharacters: async () => {},
      close: () => {},
    } as unknown as RealmWorldClient;
    switch (which) {
      case 'realms': void this.transitionTo(LoginState.REALM_SELECT); break;
      case 'charselect': void this.transitionTo(LoginState.CHAR_SELECT); break;
      case 'charcreate': void this.transitionTo(LoginState.CHAR_CREATE); break;
      default: void this.transitionTo(LoginState.LOGIN);
    }
  }

  private setupRenderLoop() {
    this.renderer.setAnimationLoop(() => {
      if (this.isDestroyed) return;

      const dt = Math.min(this.clock.getDelta(), 0.05);

      // 1. Update systems
      const showPreview = this.state === LoginState.CHAR_SELECT || this.state === LoginState.CHAR_CREATE;
      this.background.update(dt, showPreview);
      if (showPreview) {
        if (this.activeScreen && typeof this.activeScreen.getRotationState === 'function') {
          const rot = this.activeScreen.getRotationState();
          if (rot === 'left') {
            this.preview.rotateLeft(dt);
          } else if (rot === 'right') {
            this.preview.rotateRight(dt);
          }
        }
        this.preview.update(dt);
      }

      // 2. Render background scene
      this.renderer.autoClear = true;
      this.background.render(this.renderer, showPreview);

      // 3. Render character preview on top
      if (showPreview) {
        const size = this.renderer.getSize(this.previewSize);
        const { x, y, w, h } = gluePreviewViewport(size.x, size.y, this.state === LoginState.CHAR_CREATE);

        if (w > 50) { // Only render if there's enough space
          this.preview.render(this.renderer, x, y, w, h);
        }
      }
    });

    // Resize handler
    window.addEventListener('resize', this.handleResize);
  }

  private handleResize = () => {
    const canvas = this.renderer.domElement;
    this.background.resize(canvas.width, canvas.height);
  };

  private async transitionTo(newState: LoginState) {
    this.state = newState;
    this.loginScreen?.destroy();
    this.loginScreen = null;
    this.overlay.clear();
    this.activeScreen = null;

    switch (newState) {
      case LoginState.LOGIN:
        this.showLogin();
        break;

      case LoginState.REALM_SELECT:
        this.showRealmSelect();
        break;

      case LoginState.CHAR_SELECT:
        await this.showCharacterSelect();
        break;

      case LoginState.CHAR_CREATE:
        this.showCharacterCreate();
        break;
    }
  }

  private showLogin() {
    this.background.setScene('mainmenu');
    this.preview.unload();
    if (this.worldClient) {
      this.worldClient.close();
      this.worldClient = null;
    }

    const screen = new LoginScreen(this.overlay, (session, proxy) => {
      this.authSession = session;
      this.proxyUrl = proxy;
      this.saveRefreshSession(null);
      
      if (session.realms.length > 1) {
        this.transitionTo(LoginState.REALM_SELECT);
      } else {
        this.currentRealmIndex = 0;
        this.transitionTo(LoginState.CHAR_SELECT);
      }
    });
    this.loginScreen = screen;
    screen.show();
  }

  private showRealmSelect() {
    this.background.setScene('mainmenu');
    this.preview.unload();
    if (!this.authSession) return;

    const screen = new RealmSelect(
      this.overlay,
      this.authSession,
      (index) => {
        this.currentRealmIndex = index;
        this.saveRefreshSession(null);
        this.transitionTo(LoginState.CHAR_SELECT);
      },
      () => {
        this.clearRefreshSession();
        this.transitionTo(LoginState.LOGIN);
      }
    );
    screen.show();
  }

  private async showCharacterSelect() {
    if (!this.authSession) return;

    const realm = this.authSession.realms[this.currentRealmIndex];
    if (!realm) return;

    // Connect to the world server if not already connected
    if (!this.worldClient) {
      this.overlay.showLoading(`Connecting to realm ${realm.name}...`);
      try {
        const worldProxy = new URL(this.proxyUrl);
        worldProxy.searchParams.set('target', 'world');

        this.worldClient = await connectWorld(worldProxy.toString(), this.authSession, realm, (msg) => {
          this.overlay.updateLoading(msg);
        });
        this.overlay.hideLoading();
      } catch (err) {
        this.overlay.hideLoading();
        this.overlay.showError((err as Error).message, () => {
          this.transitionTo(LoginState.LOGIN);
        });
        return;
      }
    }

    const initialCharacter = this.worldClient.characters[0];
    this.background.setScene(initialCharacter ? glueSceneForRace(initialCharacter.race) : 'human');
    const screen = new CharacterSelect(
      this.overlay,
      this.preview,
      this.worldClient,
      realm.name,
      (char) => void this.enterWorld(char),
      () => this.transitionTo(LoginState.CHAR_CREATE),
      () => {
        if (this.worldClient) this.worldClient.close();
        this.worldClient = null;
        this.saveRefreshSession(null);
        if (this.authSession && this.authSession.realms.length > 1) {
          this.transitionTo(LoginState.REALM_SELECT);
        } else {
          this.clearRefreshSession();
          this.transitionTo(LoginState.LOGIN);
        }
      },
      () => {
        this.clearRefreshSession();
        this.transitionTo(LoginState.LOGIN);
      },
      (race) => this.background.setScene(glueSceneForRace(race))
    );
    this.activeScreen = screen;
    screen.show();
  }

  private showCharacterCreate() {
    if (!this.worldClient) return;

    const screen = new CharacterCreate(
      this.overlay,
      this.preview,
      this.worldClient,
      () => this.transitionTo(LoginState.CHAR_SELECT),
      () => this.transitionTo(LoginState.CHAR_SELECT),
      (race) => this.background.setScene(glueSceneForRace(race))
    );
    this.activeScreen = screen;
    screen.show();
  }

  private async enterWorld(char: CharacterInfo) {
    const worldClient = this.worldClient;
    if (!worldClient || this.isDestroyed || this.state === LoginState.ENTERING_WORLD) return;
    this.state = LoginState.ENTERING_WORLD;
    this.overlay.showLoading(`Entering world as ${char.name}...`);
    try {
      await this.onEnterWorldCallback(char, worldClient);
      this.saveRefreshSession(char.guid);
      document.documentElement.setAttribute('data-vanillagl-world-state', 'active');
      this.destroy(true);
    } catch (error) {
      worldClient.close({ logout: true });
      if (this.worldClient === worldClient) this.worldClient = null;
      this.clearRefreshSession();
      this.overlay.hideLoading();
      this.overlay.showError(`Unable to enter world: ${(error as Error).message}`, () => {
        void this.transitionTo(LoginState.CHAR_SELECT);
      });
    }
  }

  destroy(keepAnimationLoop = false) {
    this.isDestroyed = true;
    this.loginScreen?.destroy();
    this.loginScreen = null;
    window.removeEventListener('resize', this.handleResize);

    // Character select renders through a reduced viewport/scissor. Restore the
    // complete framebuffer before handing this renderer to the live world.
    restoreRendererViewport(this.renderer);

    if (!keepAnimationLoop) {
      this.renderer.setAnimationLoop(null);
    }
    this.overlay.destroy();
    this.background.destroy();
    this.preview.destroy();
  }
}
