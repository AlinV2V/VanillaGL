/** Asset conversion utility. */
const SPELL_CAST_RESULT_TEXT: readonly string[] = [
  /* 0x00 */ 'You are in combat',
  'You are already at full health.',
  'You are already at full power.',
  'That creature is already being tamed',
  'You already control a charmed creature',
  'You already control a summoned creature',
  'Already open',
  'A more powerful spell is already active',
  '', // AUTOTRACK_INTERRUPTED (hidden)
  'You have no target.',
  /* 0x0a */ 'Invalid target',
  "Target can't be charmed",
  'Item cannot be disenchanted',
  'There are no gems in this',
  'Target is tapped',
  "You can't start a duel while invisible",
  "You can't start a duel while stealthed",
  'You are too close to enemies',
  "You can't do that yet",
  'You are dead',
  /* 0x14 */ "Can't do that while charmed",
  'That is already being used',
  "Can't do that while confused",
  '', // DONT_REPORT (hidden)
  'Must have the proper item equipped',
  'Must have the proper weapon equipped',
  'Must have the proper weapon equipped in your main hand',
  'Must have the proper weapon equipped in your offhand',
  'Internal error',
  'Fizzled',
  /* 0x1e */ "Can't do that while fleeing",
  "That food's level is not high enough for your pet",
  'Target is too high level',
  '', // HUNGER_SATIATED (hidden)
  'Immune',
  'Interrupted',
  'Interrupted',
  'Item is already enchanted',
  'Item is gone',
  "Tried to enchant an item that didn't exist",
  /* 0x28 */ 'Item is not ready yet',
  'You are not high enough level',
  'Target not in line of sight',
  'Target is too low level',
  'Skill not high enough',
  'Your weapon hand is empty',
  "Can't do that while moving",
  'Ammo needs to be in the paper doll ammo slot before it can be fired',
  'Requires an ammo pouch',
  'Requires exotic ammo',
  /* 0x32 */ 'No path available',
  'You must be behind your target',
  "Your cast didn't land in fishable water",
  "You can't use that here",
  'You must be in front of your target',
  'You are not in control of your actions',
  'Spell not learned',
  'You are mounted',
  'You are in flight',
  'You are on a transport',
  /* 0x3c */ 'Spell is not ready yet',
  'You are in shapeshift form',
  'You must be standing to do that',
  'You can only use this on an object you own',
  'Tried to enchant a trade item, but not trading',
  'You have to be unsheathed to do that!',
  "Can't cast as ghost",
  'Out of ammo',
  'No charges remain',
  "You haven't selected a champion",
  /* 0x46 */ 'That ability requires combo points',
  "Dueling isn't allowed here",
  'Not enough endurance',
  "There aren't any fish here",
  "Can't use items while shapeshifted",
  "You can't mount here",
  'You do not have a pet',
  'Not enough power',
  'Nothing to dispel',
  'Nothing to steal',
  /* 0x50 */ 'Cannot use while swimming',
  'Can only use during the day',
  'Can only use indoors',
  'Can only use while mounted',
  'Can only use during the night',
  'Can only use outside',
  'Must be in the proper shapeshift form',
  'You must be in stealth mode',
  'Can only use while swimming',
  'Out of range',
  /* 0x5a */ "Can't use that ability while pacified",
  'You are possessed',
  'Missing reagents',
  'You are in the wrong zone',
  'Requires a spell focus',
  'You are unable to move',
  "Can't do that while silenced",
  'Another action is in progress',
  'You have already learned the spell',
  'The spell is not available to you',
  /* 0x64 */ "Can't do that while stunned",
  'Your target is dead',
  'Target is in combat',
  "You can't do that yet",
  'Target is currently dueling',
  'Target is hostile',
  'Target is too enraged to be charmed',
  'Target is friendly',
  "The target can't be in combat",
  "Can't target players",
  /* 0x6e */ 'Target is alive',
  'Target is not in your party',
  'Creature must be looted first',
  'Target is not a player',
  'No pockets to pick',
  'Target has no weapons equipped',
  'Creature is not skinnable',
  '', // THIRST_SATIATED (hidden)
  'Target too close',
  'You have too many of that item already',
  /* 0x78 */ '', // TOTEMS (client-side)
  'Not enough training points',
  'Failed attempt',
  'Target needs to be behind you',
  'Target needs to be in front of you',
  "Your pet doesn't like that food",
  "Can't cast while fatigued",
  'Target must be in this instance',
  "Can't cast while trading",
  'Target is not in your party or raid group',
  /* 0x82 */ 'Cannot disenchant while looting',
  'Cannot prospect while looting',
  'Requires more items to prospect',
  'Target is flagged for free-for-all PvP',
  'There are no nearby corpses to eat',
  'You can only use that in battlegrounds',
  'Target is not a ghost',
  'You have learned the maximum number of skills',
  'That transformation cannot be used here',
  'The weather is not right for that',
  'Target is immune to damage',
  'Prevented by game mechanics',
  'Your available play time prevents that action',
  'Your reputation is not high enough',
  'Your skill is not high enough',
];

export function spellCastErrorText(reason: number | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const text = SPELL_CAST_RESULT_TEXT[reason];
  if (text === '') return undefined; // vanilla-hidden result
  return text ?? `Spell failed (0x${reason.toString(16)})`;
}

/**
 * SMSG_INVENTORY_CHANGE_FAILURE InventoryResult -> vanilla GlobalStrings message (1.12 build
 * 5875, codes contiguous from 0 — matches INVENTORY_RESULT_NAMES in world.ts). Codes without an
 * entry fall back to a prettified enum name so nothing is ever silent again (UI-17).
 */
const INVENTORY_RESULT_TEXT: Record<number, string> = {
  1: 'You must reach level %d to use that item.',
  2: "You aren't skilled enough to use that item.",
  3: 'That item does not go in that slot.',
  4: 'That bag is full.',
  5: "Can't put non-empty bags in other bags.",
  6: "You can't trade equipped bags.",
  7: 'Only ammo can go there.',
  8: 'You do not have the required proficiency for that item.',
  9: 'No equipment slot is available for that item.',
  10: 'You can never use that item.',
  11: 'You can never use that item.',
  12: 'No equipment slot is available for that item.',
  13: 'Cannot equip that with a two-handed weapon.',
  14: 'You cannot dual-wield.',
  15: "That item doesn't go in that container.",
  16: "That item doesn't go in that container.",
  17: "You can't carry any more of those items.",
  18: 'No equipment slot is available for that item.',
  19: 'This item cannot stack.',
  20: 'This item cannot be equipped.',
  21: "These items can't be swapped.",
  22: 'That slot is empty.',
  23: 'The item was not found.',
  24: "You can't drop a soulbound item.",
  25: 'Out of range.',
  26: 'Tried to split more than number in stack.',
  27: "Couldn't split those items.",
  28: 'Missing reagent.',
  29: "You don't have enough money.",
  30: 'Not a bag.',
  31: 'You can only do that with empty bags.',
  32: "You don't own that item.",
  33: 'You can only equip one quiver.',
  34: 'You must purchase that bag slot first.',
  35: 'You are too far away from a bank.',
  36: 'Item is locked.',
  37: 'You are stunned.',
  38: "You can't do that while you're dead.",
  39: "You can't do that right now.",
  40: 'Internal bag error.',
  41: 'You can only equip one quiver.',
  42: 'You can only equip one ammo pouch.',
  43: 'Stackable items cannot be wrapped.',
  44: 'Equipped items cannot be wrapped.',
  45: 'Wrapped items cannot be wrapped.',
  46: 'Bound items cannot be wrapped.',
  47: 'Unique items cannot be wrapped.',
  48: 'Bags cannot be wrapped.',
  49: 'Already looted.',
  50: 'Inventory is full.',
  51: 'Your bank is full.',
  52: 'That item is currently sold out.',
  53: 'That bag is full.',
  54: 'The item was not found.',
  55: 'This item cannot stack.',
  56: 'That bag is full.',
  57: 'That item is currently sold out.',
  58: 'That object is busy.',
  59: 'That item cannot be disenchanted.',
  60: 'You must be in combat to do that.',
  61: "You can't do that while disarmed.",
  62: 'That bag is full.',
  63: "You don't have the required rank for that item.",
  64: "You don't have the required reputation for that item.",
  65: "You can't carry any more of those bags.",
  66: "You can't loot that item now.",
};

export function inventoryErrorText(code: number, enumName: string, requiredLevel?: number): string {
  const text = INVENTORY_RESULT_TEXT[code];
  if (text) return text.replace('%d', String(requiredLevel ?? 0));
  // Fallback: "CANT_EQUIP_SKILL" -> "Cant equip skill" — readable even for unmapped codes.
  const pretty = enumName.toLowerCase().replaceAll('_', ' ');
  return pretty.charAt(0).toUpperCase() + pretty.slice(1) + '.';
}

let errorsFrame: HTMLElement | null = null;

/**
 * Vanilla UIErrorsFrame: red text top-center that fades out. One message at a time,
 * newest replaces oldest, like the 1.12 default UI's first slot.
 */
export function showUiError(text: string) {
  if (!errorsFrame) {
    errorsFrame = document.createElement('div');
    errorsFrame.style.cssText =
      'position:fixed;top:14%;left:50%;transform:translateX(-50%);z-index:60;pointer-events:none;'
      + "color:#ff2020;font:15px 'Friz Quadrata',Georgia,serif;text-shadow:1px 1px 2px #000;"
      + 'text-align:center;transition:opacity 0.6s ease-in;';
    document.body.appendChild(errorsFrame);
  }
  errorsFrame.textContent = text;
  errorsFrame.style.opacity = '1';
  const frame = errorsFrame;
  window.clearTimeout((frame as HTMLElement & { fadeTimer?: number }).fadeTimer);
  (frame as HTMLElement & { fadeTimer?: number }).fadeTimer = window.setTimeout(() => {
    frame.style.opacity = '0';
  }, 2400);
}
