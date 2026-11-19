let core;

function imbue({ player, usedItem, usedWithItem, usedItemSlot, usedWithItemSlot }) {
  const { MAGIC_SHORTBOW, MAGIC_SHORTBOW_SCROLL, MAGIC_SHORTBOW_I_ } = core.ItemIdentifiers;
  const scrollFirst = usedItem.getId() === MAGIC_SHORTBOW_SCROLL;
  const scroll = scrollFirst ? usedItem : usedWithItem;
  const bow = scrollFirst ? usedWithItem : usedItem;
  const scrollSlot = scrollFirst ? usedItemSlot : usedWithItemSlot;
  const bowSlot = scrollFirst ? usedWithItemSlot : usedItemSlot;
  if (scroll.getId() !== MAGIC_SHORTBOW_SCROLL || bow.getId() !== MAGIC_SHORTBOW) return false;

  const inventory = player.getInventory();
  const items = inventory.getItems();
  if (items[scrollSlot] !== scroll || items[bowSlot] !== bow || bow.getAmount() !== 1) return false;
  if ([scroll, bow].some((item) => item.isPresetItem() || item.isUntradeable() || item.isUnbankable())) {
    player.sendMessage("You cannot use restricted items to imbue a magic shortbow.");
    return true;
  }

  inventory.deleteAtSlot(scrollSlot, 1, false);
  bow.setId(MAGIC_SHORTBOW_I_);
  inventory.refreshItems();
  player.sendMessage("You imbue your magic shortbow.");
  return true;
}

/** A magic shortbow (i) a PvP death unimbues; a preset copy (or another restricted one) is deleted by the death as it is. */
function lostToKiller(item) {
  return !!core && !!item && item.getId?.() === core.ItemIdentifiers.MAGIC_SHORTBOW_I_
    && item.isPresetItem?.() !== true && item.isUntradeable?.() !== true;
}

/**
 * `player-death:pvp-item-parts` (PlayerDeathTask, asked for the items a PvP death does not protect). Wiki, Magic
 * shortbow (i): "After being imbued by the magic shortbow scroll, the bow cannot be reverted, and there's no way to
 * reclaim the scroll. On death, players who lose the magic shortbow (i) will drop a regular magic shortbow for the
 * person who killed them"; Items Kept on Death: "The magic shortbow (i) only loses its imbued status from PvP deaths."
 * The same Item becomes the magic shortbow, which drops for the killer; the scroll is gone, for both.
 */
// Ours (upstream issue #6002): before this a magic shortbow (i) came back whole to whoever died with it, skulled or not.
function unimbueOnPvpDeath(query) {
  const item = query?.item;
  // A bot's kit is not loot (DeathLoot.PlayerBots decides what its death gives).
  if (query?.parts || query?.player?.isPlayerBot?.() === true || !lostToKiller(item)) return;
  item.setId(core.ItemIdentifiers.MAGIC_SHORTBOW);
  query.parts = [item];
}

/** `items:lost-to-pvp-killer` { item, wildernessLevel, lost }: the Items Kept on Death screen's PvP preview. */
function answerLostToPvpKiller(query) {
  if (lostToKiller(query?.item)) query.lost = true;
}

module.exports = {
  name: "MagicShortbowScroll",
  description: "Imbue a magic shortbow by using a magic shortbow scroll on it; a magic shortbow (i) lost to a player is lost as the plain bow.",
  members: true,
  register(api) {
    core = api.core;
    api.onItemOnItem("Magic shortbow scroll", "Magic shortbow", imbue, { noted: false });
    api.onCustomEvent("player-death:pvp-item-parts", unimbueOnPvpDeath);
    api.onCustomEvent("items:pvp-death-parts-preview", unimbueOnPvpDeath);
    api.onCustomEvent("items:lost-to-pvp-killer", answerLostToPvpKiller);
  },
};
