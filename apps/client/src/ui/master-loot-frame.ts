import { CanvasPanel, type PanelHit } from './panel-kit';

export class MasterLootCanvasPanel extends CanvasPanel {
  private lootGuid = '';
  private itemSlot = 0;
  private itemEntry = 0;
  private candidates: string[] = [];

  constructor(private readonly host: HTMLElement, private readonly deps: {
    playUi: (name: string) => void;
    playerName: (guid: string) => string;
    itemName: (entry: number) => string;
    assign: (lootGuid: string, itemSlot: number, playerGuid: string) => void;
  }) {
    super(host, 256, 256, 'wow-native-panel-canvas', { playUi: deps.playUi });
  }

  show(lootGuid: string, itemSlot: number, itemEntry: number, candidates: string[]) {
    this.lootGuid = lootGuid;
    this.itemSlot = itemSlot;
    this.itemEntry = itemEntry;
    this.candidates = candidates.slice(0, 10);
    this.host.classList.remove('is-hidden');
    this.playUi('igMainMenuOpen');
    this.surface.requestRender();
  }

  hide() { this.host.classList.add('is-hidden'); }

  protected paint() {
    const s = this.surface;
    s.clear();
    s.image('/ui/Interface/LootFrame/UI-LootPanel.png', 0, 0, 256, 256);
    s.text('Give Loot', 116, 26, { size: 12, align: 'center', baseline: 'middle' });
    s.closeButton(159, 10, this.buttonState('close'));
    this.hit('close', { x: 159, y: 10, width: 32, height: 32 });
    s.text(this.deps.itemName(this.itemEntry), 97, 61, { size: 11, color: '#ffd100', align: 'center', maxWidth: 165 });
    this.candidates.slice(0, 6).forEach((guid, index) => {
      const rect = { x: 24, y: 78 + index * 25, width: 145, height: 21 };
      s.panelButton(this.deps.playerName(guid), rect, this.buttonState(`player:${index}`));
      this.hit(`player:${index}`, rect);
    });
  }

  private buttonState(id: string): 'normal' | 'hover' | 'down' {
    const state = this.state(id);
    return state === 'disabled' ? 'normal' : state;
  }

  protected activate(hit: PanelHit) {
    if (hit.id === 'close') { this.hide(); return; }
    if (!hit.id.startsWith('player:')) return;
    const guid = this.candidates[Number(hit.id.slice(7))];
    if (!guid) return;
    this.deps.assign(this.lootGuid, this.itemSlot, guid);
    this.playUi('igMainMenuOption');
    this.hide();
  }
}
