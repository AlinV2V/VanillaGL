/** Asset conversion utility. */
export type StackSplitIntent = 'split' | 'split-sell' | 'chat-link' | 'suppress';

export const inventoryStackSplitIntent = (options: {
  container: 'equipment' | 'backpack' | 'bag' | 'keyring';
  button: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  chatOpen: boolean;
  merchantOpen: boolean;
}): StackSplitIntent | undefined => {
  const { container, button, shiftKey, ctrlKey, chatOpen, merchantOpen } = options;
  if (container === 'equipment') {
    // PaperDollFrame.lua: Control/Shift only modify LMB; RMB always uses the equipped item.
    if (button !== 0) return undefined;
    if (ctrlKey) return 'suppress'; // DressUpItemLink is not implemented by BrowserPort.
    if (shiftKey) return chatOpen ? 'chat-link' : 'suppress';
    return undefined;
  }

  // ContainerFrame.lua gives Control priority for both registered buttons.
  if (ctrlKey) return 'suppress';
  if (!shiftKey) return undefined;
  if (button === 0) return chatOpen ? 'chat-link' : 'split';
  // KeyRingItemButton_OnClick uniquely opens StackSplitFrame for Shift+RMB even without a vendor.
  if (button === 2 && container === 'keyring') return 'split';
  if (button === 2 && merchantOpen) return 'split-sell';
  return undefined;
};

/** MerchantFrame.lua opens the quantity frame for Shift+LMB and Shift+RMB alike. */
export const merchantStackSplitIntent = (options: {
  button: number;
  shiftKey: boolean;
  ctrlKey: boolean;
}): 'split' | 'suppress' | undefined => {
  if (options.button !== 0 && options.button !== 2) return undefined;
  if (options.ctrlKey) return 'suppress';
  return options.shiftKey ? 'split' : undefined;
};
