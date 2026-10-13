import type { InventorySlot, ItemInfo } from '../world';

const ITEM_QUALITY_NAMES = ['Poor', 'Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Artifact'];
const ITEM_QUALITY_HEX = ['9d9d9d', 'ffffff', '1eff00', '0070dd', 'a335ee', 'ff8000', 'e6cc80'];

/** GetContainerItemLink's Vanilla hyperlink shape, using the item fields retained by this client. */
export const chatItemLink = (slot: InventorySlot) => {
  const item = slot.item;
  if (!item?.entry) return '';
  const quality = Math.max(0, Math.min(6, item.info?.quality ?? 1));
  const enchant = item.enchantments?.[0]?.enchantId ?? 0;
  const name = (item.info?.name ?? `Item #${item.entry}`).replaceAll('|', '||');
  return `|cff${ITEM_QUALITY_HEX[quality]}|Hitem:${item.entry}:${enchant}:0:0|h[${name}]|h|r`;
};

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export const formatMoney = (copper: number) => {
  const sign = copper < 0 ? '-' : '';
  let value = Math.abs(copper);
  const gold = Math.floor(value / 10000);
  value -= gold * 10000;
  const silver = Math.floor(value / 100);
  const cp = value - silver * 100;
  return `${sign}${gold ? `${gold}g ` : ''}${silver ? `${silver}s ` : ''}${cp}c`;
};

const renderCoin = (amount: number, coin: 'gold' | 'silver' | 'copper') =>
  `<span class="wow-money-denom"><span class="wow-money-amount">${amount}</span><span class="wow-coin wow-coin-${coin}"></span></span>`;

export const renderSmallMoneyFrame = (copper: number) => {
  const gold = Math.floor(copper / 10000);
  const silver = Math.floor((copper % 10000) / 100);
  const cp = copper % 100;
  const parts: string[] = [];
  if (gold > 0) parts.push(renderCoin(gold, 'gold'));
  if (gold > 0 || silver > 0) parts.push(renderCoin(silver, 'silver'));
  parts.push(renderCoin(cp, 'copper'));
  return `<div class="wow-container-money">${parts.join('')}</div>`;
};

export const createItemUiHelpers = (deps: {
  getItemInfo: (entry: number) => ItemInfo | undefined;
  getItemIconName: (displayInfoId: number) => string | undefined;
}) => {
  const itemName = (slot: InventorySlot) => {
    if (!slot.item) return '';
    return slot.item.info?.name ?? (slot.item.entry ? `Item #${slot.item.entry}` : 'Loading');
  };

  const itemLabel = (entry: number, count = 1) => {
    const info = deps.getItemInfo(entry);
    const quality = Math.max(0, Math.min(6, info?.quality ?? 1));
    const name = info?.name ?? `Item #${entry}`;
    const suffix = count > 1 ? ` x${count}` : '';
    return `<span class="wow-quality-${quality}">${escapeHtml(name)}${suffix}</span>`;
  };

  const itemIconUrl = (displayInfoId?: number, entry?: number) => {
    const resolvedDisplayId = displayInfoId || (entry ? deps.getItemInfo(entry)?.displayInfoId : 0);
    if (!resolvedDisplayId) return '';
    // Six active Build-5875 templates reference legacy icon names absent from every supplied MPQ.
    // Vanilla represents unresolved item artwork with its question-mark icon rather than a blank slot.
    const icon = deps.getItemIconName(resolvedDisplayId) ?? 'INV_Misc_QuestionMark';
    return `/ui/Interface/Icons/${encodeURIComponent(icon)}.png`;
  };

  const itemIconStyle = (displayInfoId?: number, entry?: number) => {
    const url = itemIconUrl(displayInfoId, entry);
    return url ? `--item-icon:url('${url}');` : '';
  };

  const itemIconMarkup = (className: string, displayInfoId: number | undefined, entry: number | undefined, fallback: string) => {
    const style = itemIconStyle(displayInfoId, entry);
    const hasIcon = !!style;
    return `<span class="${className} ${hasIcon ? 'has-icon' : ''}"${hasIcon ? ` style="${style}"` : ''}>${hasIcon ? '' : escapeHtml(fallback)}</span>`;
  };

  const itemTooltipText = (entry: number, count = 1) => {
    const info = deps.getItemInfo(entry);
    const quality = Math.max(0, Math.min(6, info?.quality ?? 1));
    return [
      info?.name ?? `Item #${entry}`,
      ITEM_QUALITY_NAMES[quality] ?? `Quality ${quality}`,
      count > 1 ? `Stack: ${count}` : '',
      info?.itemLevel ? `Item Level ${info.itemLevel}` : '',
      info?.requiredLevel ? `Requires Level ${info.requiredLevel}` : '',
      info?.sellPrice ? `Sell Price: ${formatMoney(info.sellPrice)}` : '',
    ].filter(Boolean).join('\n');
  };

  const slotTooltipText = (slot: InventorySlot) => {
    const item = slot.item;
    if (!item?.entry) return slot.label;
    return [
      itemTooltipText(item.entry, item.count),
      item.durability !== undefined && item.maxDurability ? `Durability ${item.durability}/${item.maxDurability}` : '',
    ].filter(Boolean).join('\n');
  };

  return {
    escapeHtml,
    formatMoney,
    itemIconMarkup,
    itemIconStyle,
    itemIconUrl,
    itemLabel,
    itemName,
    itemTooltipText,
    renderSmallMoneyFrame,
    slotTooltipText,
  };
};
