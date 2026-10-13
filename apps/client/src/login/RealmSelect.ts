import type { AuthSession, RealmInfo } from '../auth';
import type { GlueOverlay } from './GlueOverlay';

export class RealmSelect {
  private selectedIndex = 0;
  private currentTab: 'All' | 'PvE' | 'PvP' | 'RP' = 'All';
  private sortBy: 'name' | 'type' | 'characters' | 'load' = 'name';
  private sortDir: 'asc' | 'desc' = 'asc';

  constructor(
    private readonly overlay: GlueOverlay,
    private readonly session: AuthSession,
    private readonly onRealmSelected: (index: number) => void,
    private readonly onCancel: () => void
  ) {}

  show() {
    this.render();
  }

  private render() {
    const realmsData = this.getRealmsData();

    // Verify selectedIndex is still valid/visible in sorted list
    const hasSelected = realmsData.some((x) => x.originalIndex === this.selectedIndex);
    if (!hasSelected && realmsData.length > 0) {
      this.selectedIndex = realmsData[0].originalIndex;
    }

    let listHtml = '';
    realmsData.forEach(({ realm, originalIndex, type, load }) => {
      listHtml += `
        <div class="glue-realm-item ${originalIndex === this.selectedIndex ? 'selected' : ''}" data-index="${originalIndex}">
          <div style="flex: 2; font-weight: bold;">${this.escape(realm.name)}</div>
          <div style="flex: 1; color: #4388ff;">${type}</div>
          <div style="flex: 1; text-align: center; color: #c7c7c7;">${realm.characters > 0 ? realm.characters : '-'}</div>
          <div style="flex: 1; text-align: right; color: ${load === 'High' ? '#ff3333' : load === 'Medium' ? '#ffe600' : '#1eff00'}">${load}</div>
        </div>
      `;
    });

    if (realmsData.length === 0) {
      listHtml = `
        <div style="padding: 20px; text-align: center; color: #8c8578;">
          No realms match this category.
        </div>
      `;
    }

    const html = `
      <div class="glue-realm-select-container">
        <div class="glue-dialog glue-realm-dialog">
          <div class="glue-dialog-header">Realm Selection</div>
          <div class="glue-dialog-body" style="display: flex; flex-direction: column; height: 100%; box-sizing: border-box; padding: 10px;">
            <p style="margin: 0 0 10px 0; color: #fff7df; font-size: 12px;">Please select a realm to play on:</p>
            
            <!-- Sort Headers -->
            <div class="glue-realm-headers">
              <div class="glue-realm-header-col" data-sort="name" style="flex: 2;">Realm Name ${this.sortBy === 'name' ? (this.sortDir === 'asc' ? '▲' : '▼') : ''}</div>
              <div class="glue-realm-header-col" data-sort="type" style="flex: 1;">Type ${this.sortBy === 'type' ? (this.sortDir === 'asc' ? '▲' : '▼') : ''}</div>
              <div class="glue-realm-header-col" data-sort="characters" style="flex: 1; text-align: center;">Characters ${this.sortBy === 'characters' ? (this.sortDir === 'asc' ? '▲' : '▼') : ''}</div>
              <div class="glue-realm-header-col" data-sort="load" style="flex: 1; text-align: right;">Load ${this.sortBy === 'load' ? (this.sortDir === 'asc' ? '▲' : '▼') : ''}</div>
            </div>

            <div class="glue-realm-list">
              ${listHtml}
            </div>

            <!-- Tabs at bottom -->
            <div class="glue-realm-tabs">
              <div class="glue-realm-tab ${this.currentTab === 'All' ? 'active' : ''}" data-tab="All">All</div>
              <div class="glue-realm-tab ${this.currentTab === 'PvE' ? 'active' : ''}" data-tab="PvE">Normal</div>
              <div class="glue-realm-tab ${this.currentTab === 'PvP' ? 'active' : ''}" data-tab="PvP">PvP</div>
              <div class="glue-realm-tab ${this.currentTab === 'RP' ? 'active' : ''}" data-tab="RP">RP</div>
            </div>
            
            <div class="glue-dialog-actions" style="display: flex; justify-content: flex-end; gap: 15px; margin-top: 15px;">
              <button id="glue-realm-cancel" class="glue-button">Cancel</button>
              <button id="glue-realm-ok" class="glue-button">Okay</button>
            </div>
          </div>
        </div>
      </div>
    `;

    const el = this.overlay.showScreen(html);

    // Bind list items
    const items = el.querySelectorAll<HTMLDivElement>('.glue-realm-item');
    items.forEach((item) => {
      item.addEventListener('click', () => {
        items.forEach((x) => x.classList.remove('selected'));
        item.classList.add('selected');
        this.selectedIndex = Number(item.dataset.index);
      });

      item.addEventListener('dblclick', () => {
        this.selectedIndex = Number(item.dataset.index);
        this.confirmSelection();
      });
    });

    // Bind sort headers
    el.querySelectorAll('.glue-realm-header-col').forEach((header) => {
      header.addEventListener('click', () => {
        const field = (header as HTMLElement).dataset.sort as any;
        if (this.sortBy === field) {
          this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          this.sortBy = field;
          this.sortDir = 'asc';
        }
        this.render();
      });
    });

    // Bind tabs
    el.querySelectorAll('.glue-realm-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.currentTab = (tab as HTMLElement).dataset.tab as any;
        this.render();
      });
    });

    const cancelBtn = el.querySelector('#glue-realm-cancel')!;
    cancelBtn.addEventListener('click', () => this.onCancel());

    const okBtn = el.querySelector('#glue-realm-ok')!;
    okBtn.addEventListener('click', () => this.confirmSelection());
  }

  private getRealmsData() {
    const getRealmType = (r: RealmInfo) => {
      if (r.name.toLowerCase().includes('pvp')) return 'PvP';
      if (r.name.toLowerCase().includes('rp')) return 'RP';
      return 'PvE';
    };

    const getRealmLoad = (r: RealmInfo) => {
      if (r.population >= 2.0) return 'High';
      if (r.population >= 1.0) return 'Medium';
      return 'Low';
    };

    let data = this.session.realms.map((realm, originalIndex) => ({
      realm,
      originalIndex,
      type: getRealmType(realm),
      load: getRealmLoad(realm),
      loadValue: realm.population,
    }));

    if (this.currentTab !== 'All') {
      data = data.filter((item) => item.type === this.currentTab);
    }

    data.sort((a, b) => {
      let valA: any = '';
      let valB: any = '';

      if (this.sortBy === 'name') {
        valA = a.realm.name;
        valB = b.realm.name;
      } else if (this.sortBy === 'type') {
        valA = a.type;
        valB = b.type;
      } else if (this.sortBy === 'characters') {
        valA = a.realm.characters;
        valB = b.realm.characters;
      } else if (this.sortBy === 'load') {
        valA = a.loadValue;
        valB = b.loadValue;
      }

      if (valA < valB) return this.sortDir === 'asc' ? -1 : 1;
      if (valA > valB) return this.sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    return data;
  }

  private confirmSelection() {
    this.onRealmSelected(this.selectedIndex);
  }

  private escape(value: string) {
    return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
  }
}
