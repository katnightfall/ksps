const Common = require('./Common.ElementalTomes');

/**
 * What a PvP death makes of a charged tome (docs/items-kept-on-death.md). Wiki, Tome of Fire: "If lost to another
 * player in a dangerous PVP death, all charges inside will be converted into pages and dropped for the killer
 * alongside the empty tome." The Tome of Water and Tome of Earth pages have no line of their own; Items Kept on Death
 * gives the same rule for every chargeable item ("Dropped to the PKer as the tradeable uncharged item, and drops the
 * items that would result from uncharging the item to the PKer too").
 *
 * The pages are the ones "Remove all pages" gives (Pages.ElementalTomes: the whole pages of the kind the tome was
 * filled with, a part-used page's charges gone), so the death hands out nothing the tome did not hold.
 */
// Ours (upstream issue #6002): before this a charged tome, an untradeable, came back whole to whoever died with it,
// skulled or not.

/** The tome's definition when this copy is a charged tome a PvP death empties, or null. */
function chargedTome(item) {
  // A preset copy (or another restricted one) was never filled by its holder and is deleted by the death as it is.
  if (!item || item.isPresetItem?.() === true || item.isUntradeable?.() === true) return null;
  const definition = Common.getDefinition(item.getId?.());
  return definition && item.getId() === definition.chargedId ? definition : null;
}

/** `player-death:pvp-item-parts` (PlayerDeathTask, asked for the items a PvP death does not protect). */
function emptyOnPvpDeath(query) {
  const item = query?.item;
  // A bot's kit is not loot (DeathLoot.PlayerBots decides what its death gives).
  if (!item || query.parts || query.player?.isPlayerBot?.() === true) return;
  const definition = chargedTome(item);
  if (!definition) return;
  const state = Common.read(item);
  const pages = Common.wholePages(state);
  // The same Item, now the empty tome, with its charge count gone.
  Common.set(item, definition, 0, state.pageId);
  query.parts = pages > 0 ? [item, new Common.core.Item(state.pageId, pages)] : [item];
}

/** `items:lost-to-pvp-killer` { item, wildernessLevel, lost }: the Items Kept on Death screen's PvP preview. */
function answerLostToPvpKiller(query) {
  if (chargedTome(query?.item)) query.lost = true;
}

function attach(api) {
  api.onCustomEvent('player-death:pvp-item-parts', emptyOnPvpDeath);
  api.onCustomEvent('items:pvp-death-parts-preview', emptyOnPvpDeath);
  api.onCustomEvent('items:lost-to-pvp-killer', answerLostToPvpKiller);
}

module.exports = { attach, emptyOnPvpDeath, answerLostToPvpKiller };
