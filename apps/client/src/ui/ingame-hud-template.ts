export const INGAME_HUD_TEMPLATE = `
    <div id="wow-player-frame" class="wow-unit-frame wow-unit-frame--player is-hidden">
      <div class="wow-unit-background"></div>
      <div class="wow-unit-portrait" data-pf="portrait"></div>
      <div class="wow-unit-status wow-unit-status--health">
        <div class="wow-unit-status-fill wow-unit-status-fill--health" data-pf="hp"></div>
        <div class="wow-unit-status-text" data-pf="hpText"></div>
      </div>
      <div class="wow-unit-status wow-unit-status--power">
        <div class="wow-unit-status-fill wow-unit-status-fill--mana" data-pf="power"></div>
        <div class="wow-unit-status-text" data-pf="powerText"></div>
      </div>
      <div class="wow-unit-art"></div>
      <div class="wow-unit-attack"></div>
      <div class="wow-unit-pvp is-hidden" data-pf="pvp"></div>
      <div class="wow-unit-name" data-pf="name"></div>
      <div class="wow-unit-level" data-pf="level"></div>
    </div>
    <div id="wow-target-frame" class="wow-unit-frame wow-unit-frame--target is-hidden">
      <div class="wow-unit-background"></div>
      <div class="wow-unit-portrait" data-tf="portrait"></div>
      <div class="wow-unit-status wow-unit-status--health">
        <div class="wow-unit-status-fill wow-unit-status-fill--health" data-tf="hp"></div>
        <div class="wow-unit-status-text" data-tf="hpText"></div>
      </div>
      <div class="wow-unit-status wow-unit-status--power">
        <div class="wow-unit-status-fill wow-unit-status-fill--mana" data-tf="power"></div>
        <div class="wow-unit-status-text" data-tf="powerText"></div>
      </div>
      <div class="wow-unit-art"></div>
      <div class="wow-unit-dead">DEAD</div>
      <div class="wow-unit-pvp is-hidden" data-tf="pvp"></div>
      <div class="wow-unit-name" data-tf="name"></div>
      <div class="wow-unit-level" data-tf="level"></div>
      <div class="wow-unit-skull is-hidden" data-tf="skull"></div>
    </div>
    <div id="wow-tot-frame" class="wow-tot-frame is-hidden"></div>
    <div id="wow-buffs" class="wow-buffs is-hidden"></div>
    <div id="wow-cast-bar" class="wow-cast-bar is-hidden">
      <div class="wow-cast-spell-name"></div>
      <div class="wow-cast-track">
        <div class="wow-cast-fill"></div>
      </div>
    </div>
    <div id="wow-mirror-timers" class="wow-mirror-timers is-hidden"></div>
    <div id="wow-quest-watch" class="wow-quest-watch"></div>
    <div id="wow-quest-progress" class="wow-quest-progress"></div>
    <div id="wow-party-hud" class="wow-party-hud is-hidden"></div>
    <div id="wow-pet-hud" class="wow-pet-hud is-hidden"></div>
    <div id="wow-pet-action-bar" class="wow-pet-action-bar is-hidden"></div>
    <div id="wow-loot-rolls" class="wow-loot-rolls is-hidden"></div>
    <div id="wow-chat-box" class="wow-chat-box">
      <div id="wow-chat-messages" class="wow-chat-messages"></div>
      <input id="wow-chat-input" class="wow-chat-input is-hidden" type="text" maxlength="255" autocomplete="off" spellcheck="false" />
    </div>
    <div id="wow-main-menu-bar" class="wow-main-menu-bar is-hidden">
      <div id="wow-experience-bar" class="wow-experience-bar" data-tooltip="Experience">
        <div class="wow-experience-rested"></div>
        <div class="wow-experience-fill"></div>
        <span class="wow-experience-text">0 / 0</span>
      </div>
      <div class="wow-mainbar-art" aria-hidden="true">
        <span class="wow-mainbar-slice wow-mainbar-slice--0"></span>
        <span class="wow-mainbar-slice wow-mainbar-slice--1"></span>
        <span class="wow-mainbar-slice wow-mainbar-slice--2"></span>
        <span class="wow-mainbar-slice wow-mainbar-slice--3"></span>
        <span class="wow-mainbar-endcap wow-mainbar-endcap--left"></span>
        <span class="wow-mainbar-endcap wow-mainbar-endcap--right"></span>
      </div>
      <div id="wow-action-bar" class="wow-action-bar"></div>
      <div class="wow-action-page">
        <button class="wow-action-page-button wow-action-page-button--up" type="button"></button>
        <span>1</span>
        <button class="wow-action-page-button wow-action-page-button--down" type="button"></button>
      </div>
      <div class="wow-micro-buttons">
        <button class="wow-micro-button wow-micro-button--character" type="button"></button>
        <button class="wow-micro-button wow-micro-button--spellbook" type="button"></button>
        <button class="wow-micro-button wow-micro-button--talents" type="button"></button>
        <button class="wow-micro-button wow-micro-button--quest" type="button"></button>
        <button class="wow-micro-button wow-micro-button--socials" type="button"></button>
        <button class="wow-micro-button wow-micro-button--world" type="button"></button>
        <button class="wow-micro-button wow-micro-button--mainmenu" type="button"></button>
        <button class="wow-micro-button wow-micro-button--help" type="button"></button>
      </div>
      <div class="wow-bag-buttons">
        <button class="wow-bag-button" type="button"></button>
        <button class="wow-bag-button" type="button"></button>
        <button class="wow-bag-button" type="button"></button>
        <button class="wow-bag-button" type="button"></button>
        <button class="wow-backpack-button" type="button"></button>
      </div>
    </div>
    <div id="wow-character-frame" class="wow-character-frame tab-character is-hidden">
      <canvas class="wow-character-native-background" width="384" height="512" aria-hidden="true"></canvas>
      <div class="wow-character-title">
        <span id="wow-character-name">Character</span>
        <button id="wow-character-close" class="wow-frame-close" type="button">x</button>
      </div>
      <div id="wow-character-subtitle" class="wow-character-subtitle"></div>
      <div id="wow-character-portrait" class="wow-character-portrait"></div>
      <div class="wow-paperdoll-frame">
        <div class="wow-char-page wow-char-page--character is-active">
          <div class="wow-character-model" aria-hidden="true"><canvas class="wow-character-model-canvas"></canvas></div>
          <div id="wow-paperdoll-slots" class="wow-paperdoll-slots"></div>
          <div id="wow-character-stats" class="wow-character-stats"></div>
        </div>
        <div id="wow-char-page-pet" class="wow-char-page wow-char-page--pet"></div>
        <div id="wow-char-page-reputation" class="wow-char-page wow-char-page--reputation"></div>
        <div id="wow-char-page-skills" class="wow-char-page wow-char-page--skills"></div>
        <div id="wow-char-page-honor" class="wow-char-page wow-char-page--honor"></div>
        <div class="wow-character-tabs">
          <button class="wow-character-tab is-active" type="button" data-char-tab="character">Character</button>
          <button class="wow-character-tab" type="button" data-char-tab="pet">Pet</button>
          <button class="wow-character-tab" type="button" data-char-tab="reputation">Reputation</button>
          <button class="wow-character-tab" type="button" data-char-tab="skills">Skills</button>
          <button class="wow-character-tab" type="button" data-char-tab="honor">Honor</button>
        </div>
      </div>
    </div>
    <div id="wow-spellbook-frame" class="wow-spellbook-frame is-hidden" data-frame-id="spellbook"></div>
    <div id="wow-social-frame" class="wow-social-frame is-hidden" data-frame-id="social"></div>
    <div id="wow-container-layer" class="wow-container-layer"></div>
    <div id="wow-quest-log-frame" class="wow-native-frame wow-quest-log-frame is-hidden" data-frame-id="questlog"></div>
    <div id="wow-loot-frame" class="wow-native-frame wow-loot-frame is-hidden"></div>
    <div id="wow-merchant-frame" class="wow-native-frame wow-ui-panel is-hidden" data-frame-id="merchant"></div>
    <div id="wow-trainer-frame" class="wow-native-frame wow-ui-panel is-hidden" data-frame-id="trainer"></div>
    <div id="wow-gossip-frame" class="wow-native-frame wow-ui-panel is-hidden" data-frame-id="gossip"></div>
    <div id="wow-quest-frame" class="wow-native-frame wow-ui-panel is-hidden" data-frame-id="quest"></div>
    <div id="wow-talent-frame" class="wow-native-frame wow-ui-panel is-hidden" data-frame-id="talents"></div>
    <div id="wow-taxi-frame" class="wow-native-frame wow-ui-panel is-hidden" data-frame-id="taxi"></div>
    <div id="wow-bank-frame" class="wow-native-frame wow-ui-panel wow-bank-frame is-hidden" data-frame-id="bank"></div>
    <div id="wow-trade-frame" class="wow-native-frame wow-ui-panel wow-trade-frame is-hidden" data-frame-id="trade"></div>
    <div id="wow-inspect-frame" class="wow-native-frame wow-ui-panel is-hidden" data-frame-id="inspect"></div>
    <div id="wow-master-loot-frame" class="wow-native-frame wow-master-loot-frame is-hidden"></div>
    <div id="wow-item-text-frame" class="wow-native-frame wow-item-text-frame is-hidden"></div>
    <div id="wow-interaction-panel" class="wow-native-frame wow-interaction-panel is-hidden"></div>
    <div id="wow-logout-popup" class="wow-native-frame wow-interaction-panel is-hidden"></div>
    <div id="wow-game-tooltip" class="wow-game-tooltip is-hidden"></div>`;
