export type VendorPurchaseRow = { buyCount: number; stock: number; price: number };

/** FrameXML GetMerchantItemMaxStack, additionally bounded to the uint8 wire count. */
export const maxVendorPurchaseCount = (
  item: VendorPurchaseRow,
  stackable: number | undefined,
  money: number,
): number => {
  const buyCount = Math.max(1, item.buyCount);
  const stackLimit = Math.max(1, Math.floor(Math.max(buyCount, stackable ?? buyCount) / buyCount));
  // Runtime wire data uses UINT32_MAX for unlimited stock; offline fixtures historically use -1.
  const stockLimit = item.stock >= 0 && item.stock < 0xffffffff ? Math.floor(item.stock / buyCount) : 255;
  const moneyLimit = item.price > 0 ? Math.floor(money / item.price) : 255;
  return Math.max(1, Math.min(255, stackLimit, stockLimit, moneyLimit));
};
