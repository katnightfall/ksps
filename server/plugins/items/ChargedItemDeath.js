"use strict";

/**
 * What a death to another player makes of a charged item (docs/items-kept-on-death.md, "Charged items"). Shared by the
 * charged items' own plugins, which answer `player-death:pvp-item-parts` (PlayerDeathTask) with it.
 *
 * Wiki, Items Kept on Death (Mechanics), "Chargable items", PvP death: "Dropped to the PKer as the tradeable uncharged
 * item, and drops the items that would result from uncharging the item to the PKer too." Each item's own page then
 * says what its charges give (Toxic blowpipe: "all scale and dart charges will appear on the floor alongside the
 * blowpipe"; Scythe of Vitur: "all charges will be lost and the player who gets the scythe will not receive any blood
 * runes or vials of blood"; Trident of the seas: "only the uncharged trident will appear on the floor").
 *
 * The item is emptied by its own plugin's uncharge code, the same Item, and what comes out of it is what was in it:
 * nothing is made here. The death asks only for the items it does not protect, so a kept item keeps its charges.
 */
// Ours (upstream issue #6002): before this a charged item counted as an untradeable and came back to its owner whole
// and fully charged from a PvP death, skulled or not.
const { restricted } = require("./PoweredStaff");

const PARTS_EVENT = "player-death:pvp-item-parts";
/** Its read-only twin, asked with a copy of the item and `preview: true` (PlayerDeathTask.keepValue, Items Kept on Death). */
const PREVIEW_EVENT = "items:pvp-death-parts-preview";

/**
 * Answers `player-death:pvp-item-parts` { player, killer, item, parts } for one plugin's charged items, and its
 * read-only twin `items:pvp-death-parts-preview` (the same, with `preview: true`), by which the death ranks the kept
 * items by what an item is lost as.
 * - `uncharged(item)`: the id the item becomes when the plugin empties it, or null when it is not one of the plugin's
 *   charged items (or is one that a death leaves alone).
 * - `empty(item, player)`: empties the item where it is and returns what the death gives of its contents, as
 *   [itemId, amount] pairs. In a preview it is handed no player: it changes the copy it is given and nothing else.
 *
 * Once emptied, the item is asked about again, as the uncharged item it now is: an ornamented one then loses its kit
 * by the ornament kits' own rule. OrnamentKits leaves a charged Holy scythe alone, because the charged scythe under the
 * kit does not trade; the uncharged scythe does, so the kit comes off the emptied item (Wiki, Holy scythe of Vitur: "the
 * holy ornament kit will be placed in their gravestone"). Where OrnamentKits already took a kit off the charged item (a
 * Blazing blowpipe's, which trades), its answer is kept and the contents are added to it.
 */
function splitOnPvpDeath(core, query, uncharged, empty) {
  const item = query?.item;
  // A bot's gear is not loot (DeathLoot.PlayerBots decides what its death gives), and a preset copy is deleted with
  // the rest of the preset.
  if (!item || query.player?.isPlayerBot?.() === true || restricted(item)) return;
  if (uncharged(item) == null) return;
  // An earlier answer that put another item in this one's place has dealt with it: emptying it too would make two.
  if (query.parts && !query.parts.includes(item)) return;
  const preview = query.preview === true;
  const contents = empty(item, preview ? null : query.player)
    .filter(([, amount]) => amount > 0)
    .map(([contentId, amount]) => new core.Item(contentId, amount));
  const emptied = { player: query.player, killer: query.killer, item, parts: null, preview };
  core.PluginManager.emitCustomEvent(preview ? PREVIEW_EVENT : PARTS_EVENT, emptied);
  // The item is listed once: by the second answer where there is one, which says what the emptied item becomes.
  query.parts = [
    ...(query.parts ?? []).filter((part) => part !== item),
    ...(emptied.parts ?? [item]),
    ...contents,
  ];
}

/**
 * Answers `items:lost-to-pvp-killer` { item, wildernessLevel, lost }, the Items Kept on Death screen's PvP preview.
 * `plain(item)`: the tradeable item the killer would get in its place (for an ornamented one, the plain uncharged
 * item), or null when it is not one of the plugin's charged items.
 */
function answerLostToPvpKiller(core, query, plain) {
  const item = query?.item;
  if (!item || restricted(item)) return;
  const id = plain(item);
  if (id != null && new core.Item(id, 1).isPlayerTradeable()) query.lost = true;
}

module.exports = { splitOnPvpDeath, answerLostToPvpKiller };
