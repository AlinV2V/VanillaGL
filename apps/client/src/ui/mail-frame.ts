import type { ItemInfo, MailState } from '../world';
import { CanvasPanel, drawItemButton, UI_GOLD, UI_GRAY, type PanelHit } from './panel-kit';
import { DIALOG_EDGE, drawEdgedBox } from './vanilla-canvas';

export class MailCanvasPanel extends CanvasPanel {
  private mailState?: MailState;
  private tab: 'inbox' | 'send' = 'inbox';
  private page = 0;
  private selectedId = 0;
  private attachment?: { guid: string; entry: number; count: number; name: string; iconUrl: string };
  private readonly receiver = document.createElement('input');
  private readonly subject = document.createElement('input');
  private readonly body = document.createElement('textarea');
  private readonly money = document.createElement('input');
  private readonly cod = document.createElement('input');

  constructor(private readonly host: HTMLElement, private readonly deps: {
    closeMailbox: () => void;
    sendMail: (params: { receiver: string; subject: string; body: string; itemGuid?: string; money?: number; cod?: number }) => void;
    takeMoney: (id: number) => void;
    takeItem: (id: number) => void;
    markRead: (id: number) => void;
    returnMail: (id: number) => void;
    deleteMail: (id: number) => void;
    queryBody: (id: number, textId: number) => void;
    senderName: (guid?: string, entry?: number) => string;
    getItemInfo: (entry: number) => ItemInfo | undefined;
    itemIconUrl: (displayInfoId?: number, entry?: number) => string;
    heldItem: () => { guid?: string; entry: number; count: number; name: string; iconUrl: string; isBag?: boolean } | undefined;
    clearHeld: () => void;
    playUi?: (name: string) => unknown;
  }) {
    super(host, 520, 560, 'wow-native-panel-canvas', { playUi: deps.playUi });
    host.dataset.frameId = 'mail';
    for (const [element, className] of [
      [this.receiver, 'wow-mail-input wow-mail-receiver'],
      [this.subject, 'wow-mail-input wow-mail-subject'],
      [this.body, 'wow-mail-input wow-mail-body'],
      [this.money, 'wow-mail-input wow-mail-money'],
      [this.cod, 'wow-mail-input wow-mail-cod'],
    ] as const) {
      element.className = className;
      host.appendChild(element);
    }
    this.receiver.maxLength = 12;
    this.subject.maxLength = 64;
    this.body.maxLength = 8000;
    this.money.type = 'number'; this.money.min = '0'; this.money.value = '0';
    this.cod.type = 'number'; this.cod.min = '0'; this.cod.value = '0';
    this.setInputsVisible(false);
  }

  show(state: MailState) {
    this.mailState = state;
    this.host.classList.remove('is-hidden');
    if (state.result) {
      if (state.result.error === 0 && state.result.action === 0) {
        this.receiver.value = ''; this.subject.value = ''; this.body.value = ''; this.money.value = '0'; this.cod.value = '0'; this.attachment = undefined;
      }
    }
    this.surface.requestRender();
  }
  close() { this.mailState = undefined; this.host.classList.add('is-hidden'); this.setInputsVisible(false); this.deps.closeMailbox(); }
  isOpen() { return !!this.mailState; }

  protected paint() {
    const s = this.surface;
    s.clear();
    drawEdgedBox(s, { x: 8, y: 8, width: 504, height: 544 }, DIALOG_EDGE);
    s.image('/ui/Interface/DialogFrame/UI-DialogBox-Header.png', 132, -1, 256, 64);
    s.text(this.tab === 'inbox' ? 'Inbox' : 'Send Mail', 260, 26, { size: 14, align: 'center', baseline: 'middle' });
    const inboxTab = { x: 28, y: 51, width: 90, height: 25 };
    const sendTab = { x: 120, y: 51, width: 90, height: 25 };
    s.panelButton('Inbox', inboxTab, this.tab === 'inbox' ? 'down' : this.stateFor('tab:inbox'));
    s.panelButton('Send Mail', sendTab, this.tab === 'send' ? 'down' : this.stateFor('tab:send'));
    this.hit('tab:inbox', inboxTab); this.hit('tab:send', sendTab);
    this.setInputsVisible(this.tab === 'send');
    if (this.tab === 'inbox') this.paintInbox(); else this.paintSend();
    const close = { x: 420, y: 511, width: 70, height: 22 };
    s.panelButton('Close', close, this.stateFor('close'));
    this.hit('close', close);
  }

  private paintInbox() {
    const s = this.surface;
    const messages = this.mailState?.messages ?? [];
    const maxPage = Math.max(0, Math.ceil(messages.length / 7) - 1);
    this.page = Math.min(this.page, maxPage);
    messages.slice(this.page * 7, this.page * 7 + 7).forEach((mail, row) => {
      const y = 85 + row * 47;
      const selected = mail.id === this.selectedId;
      if (selected || this.isHover(`mail:${mail.id}`)) {
        s.ctx.save(); s.ctx.fillStyle = selected ? 'rgba(185,130,25,.32)' : 'rgba(255,255,255,.07)'; s.ctx.fillRect(27, y, 462, 43); s.ctx.restore();
      }
      const unread = (mail.checked & 1) === 0;
      s.text(mail.subject || '(No Subject)', 42, y + 17, { size: 12, color: unread ? '#ffffff' : '#b8b8b8', maxWidth: 245 });
      s.text(this.deps.senderName(mail.senderGuid, mail.senderEntry), 42, y + 34, { size: 10, color: UI_GOLD, maxWidth: 220 });
      s.text(`${Math.max(0, mail.daysLeft).toFixed(0)} Days`, 468, y + 18, { size: 10, align: 'right', color: UI_GRAY });
      if (mail.itemEntry) s.text('Item', 468, y + 34, { size: 10, align: 'right', color: '#1eff00' });
      else if (mail.money) s.text(`${mail.money}c`, 468, y + 34, { size: 10, align: 'right', color: '#ffd100' });
      this.hit(`mail:${mail.id}`, { x: 27, y, width: 462, height: 43 }, { data: mail.id });
    });
    const selected = messages.find((mail) => mail.id === this.selectedId);
    if (selected) {
      s.ctx.save(); s.ctx.fillStyle = 'rgba(0,0,0,.7)'; s.ctx.fillRect(27, 422, 462, 73); s.ctx.restore();
      s.text(selected.body ?? (selected.itemTextId ? 'Click Open to read this letter.' : selected.subject), 38, 441, { size: 10, color: '#fff1bd', maxWidth: 275 });
      const info = selected.itemEntry ? this.deps.getItemInfo(selected.itemEntry) : undefined;
      if (selected.itemEntry) drawItemButton(s, 332, 430, 38, { iconUrl: info ? this.deps.itemIconUrl(info.displayInfoId, info.entry) : undefined, count: selected.itemCount });
      const actions = [
        ['open', 'Open', 282, !!selected.itemTextId], ['takeItem', selected.cod ? `Pay ${selected.cod}c` : 'Take Item', 372, !!selected.itemEntry],
        ['takeMoney', 'Take Money', 282, !!selected.money], ['return', 'Return', 372, true],
      ] as const;
      actions.forEach(([id, label, x, enabled], index) => {
        const rect = { x, y: 447 + (index > 1 ? 24 : 0), width: 84, height: 21 };
        s.panelButton(label, rect, enabled ? this.stateFor(id) : 'disabled');
        this.hit(id, rect, { disabled: !enabled, data: selected.id });
      });
      const del = { x: 38, y: 470, width: 76, height: 21 };
      s.panelButton('Delete', del, (selected.itemEntry || selected.money) ? 'disabled' : this.stateFor('delete'));
      this.hit('delete', del, { disabled: !!(selected.itemEntry || selected.money), data: selected.id });
    }
    const prev = { x: 28, y: 511, width: 70, height: 22 };
    const next = { x: 104, y: 511, width: 70, height: 22 };
    s.panelButton('Prev', prev, this.page <= 0 ? 'disabled' : this.stateFor('prev'));
    s.panelButton('Next', next, this.page >= maxPage ? 'disabled' : this.stateFor('next'));
    this.hit('prev', prev, { disabled: this.page <= 0 }); this.hit('next', next, { disabled: this.page >= maxPage });
  }

  private paintSend() {
    const s = this.surface;
    s.text('To:', 34, 102, { size: 11, color: UI_GOLD });
    s.text('Subject:', 34, 137, { size: 11, color: UI_GOLD });
    s.text('Message:', 34, 175, { size: 11, color: UI_GOLD });
    for (const rect of [{ x: 94, y: 84, width: 370, height: 25 }, { x: 94, y: 119, width: 370, height: 25 }, { x: 34, y: 190, width: 430, height: 188 }]) {
      s.ctx.save(); s.ctx.fillStyle = 'rgba(0,0,0,.72)'; s.ctx.fillRect(rect.x, rect.y, rect.width, rect.height); s.ctx.strokeStyle = '#8c6d35'; s.ctx.strokeRect(rect.x + .5, rect.y + .5, rect.width, rect.height); s.ctx.restore();
    }
    s.text('Attachment', 34, 403, { size: 11, color: UI_GOLD });
    drawItemButton(s, 112, 389, 38, { iconUrl: this.attachment?.iconUrl, count: this.attachment?.count, hover: this.isHover('attachment') });
    this.hit('attachment', { x: 112, y: 389, width: 38, height: 38 }, { tooltip: [{ text: this.attachment?.name ?? 'Drop an item here', color: '#ffffff' }] });
    s.text('Money (copper)', 182, 403, { size: 10, color: UI_GOLD });
    s.text('COD (copper)', 330, 403, { size: 10, color: UI_GOLD });
    const send = { x: 319, y: 468, width: 104, height: 24 };
    s.panelButton('Send', send, this.receiver.value.trim() ? this.stateFor('send') : 'disabled');
    this.hit('send', send, { disabled: !this.receiver.value.trim() });
  }

  protected activate(hit: PanelHit) {
    if (hit.id === 'tab:inbox' || hit.id === 'tab:send') this.tab = hit.id.endsWith('send') ? 'send' : 'inbox';
    else if (hit.id === 'close') this.close();
    else if (hit.id.startsWith('mail:')) {
      this.selectedId = hit.data as number;
      const mail = this.mailState?.messages.find((candidate) => candidate.id === this.selectedId);
      if (mail) { this.deps.markRead(mail.id); if (mail.itemTextId && !mail.body) this.deps.queryBody(mail.id, mail.itemTextId); }
    } else if (hit.id === 'prev') this.page--;
    else if (hit.id === 'next') this.page++;
    else if (hit.id === 'open') {
      const mail = this.selected(); if (mail?.itemTextId) this.deps.queryBody(mail.id, mail.itemTextId);
    } else if (hit.id === 'takeItem') { const mail = this.selected(); if (mail) this.deps.takeItem(mail.id); }
    else if (hit.id === 'takeMoney') { const mail = this.selected(); if (mail) this.deps.takeMoney(mail.id); }
    else if (hit.id === 'return') { const mail = this.selected(); if (mail) this.deps.returnMail(mail.id); }
    else if (hit.id === 'delete') { const mail = this.selected(); if (mail) this.deps.deleteMail(mail.id); }
    else if (hit.id === 'attachment') {
      const held = this.deps.heldItem();
      if (held?.guid && !held.isBag) { this.attachment = { ...held, guid: held.guid }; this.deps.clearHeld(); }
      else if (!held) this.attachment = undefined;
    } else if (hit.id === 'send') {
      this.deps.sendMail({
        receiver: this.receiver.value, subject: this.subject.value, body: this.body.value,
        itemGuid: this.attachment?.guid, money: Number(this.money.value) || 0, cod: Number(this.cod.value) || 0,
      });
    }
    this.playUi('igMainMenuOptionClick');
  }

  private selected() { return this.mailState?.messages.find((mail) => mail.id === this.selectedId); }
  private stateFor(id: string): 'normal' | 'hover' | 'down' { const value = this.state(id); return value === 'disabled' ? 'normal' : value; }
  private setInputsVisible(visible: boolean) { for (const input of [this.receiver, this.subject, this.body, this.money, this.cod]) input.classList.toggle('is-hidden', !visible); }
}
