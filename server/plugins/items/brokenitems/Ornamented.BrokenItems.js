"use strict";

/**
 * The ornament kit on a breakable item that a PvP death does not protect, where the ornament kits' own answer
 * (OrnamentKits.plugin.js) leaves the item alone: a locked item with a kit, and a breakable item whose kit does not
 * trade. The kit comes off and the item meets the death as the item under it, which then breaks, is mangled or is lost
 * as Death.BrokenItems decides.
 *
 * Wiki, Items Kept on Death (Mechanics):
 * - "Locked items with tradeable ornament kit" (Elite void top (l)(or)): "The victim keeps it in their inventory in
 *   broken form and keeps its (l) status. The PKer receives the tradeable ornament kit and item's repair cost"; above
 *   level 20 Wilderness, "in mangled form ... The PKer receives the tradeable ornament kit and Trouver cost".
 * - Fighter torso (or): at level 20 or below "it will remain in the player's inventory; however, the item will be in a
 *   broken, unusable state ... The ornament kit will be placed in their gravestone"; above it, unlocked, "it will be
 *   converted to coins", and locked "The locked item will remain in the player's inventory ... in a mangled, unusable
 *   state ... The ornament kit will be placed in their gravestone." The Bounty hunter ornament kit does not trade, so
 *   it stays the victim's, as it does on the items OrnamentKits takes it off.
 * - A lock from before the Trouver rework (Rune defender (l)(t)): "these discontinued items will behave like their
 *   regular counterparts" (Wiki, (l)), so it loses its kit and breaks as a Rune defender (t) does.
 *
 * The pairs come from the two tables: an ornament kit that Dismantle gives back (ornament-kits.json, `refund`) on an
 * item that breaks (broken-items.json), and the cache's items of the same names with "(l)" in them.
 */
// Ours (upstream issue #6002): before this a Void knight top (l)(or) and a Fighter torso (or) came back whole from a
// PvP death, kit and all, and never broke: the death did not know them as the item under the kit.
const Common = require("./Common.BrokenItems");
const KITS = require("../data/ornament-kits.json");

/** Ornamented item id -> { base, kit }: the breakable item under the kit, and the kit. Built on first use. */
let ornamented = null;

function build() {
  const core = Common.getCore();
  ornamented = new Map();
  for (const entry of KITS.kits ?? []) {
    const kit = Number(entry.kit) || 0;
    const base = Number(entry.base);
    const result = Number(entry.result);
    if (kit <= 0 || entry.refund !== true || Common.lookup(base)?.form.kind !== "unlocked") continue;
    const baseName = Common.itemName(base);
    const resultName = Common.itemName(result);
    if (!baseName || !resultName || !resultName.startsWith(baseName)) continue;
    // A kit that trades is taken off the unlocked item by OrnamentKits already (Rune defender (t), Void (or)).
    if (!new core.Item(kit, 1).isPlayerTradeable()) ornamented.set(result, { base, kit });
    // "Void knight top (or)" -> "Void knight top (l)(or)", over "Void knight top (l)".
    const lockedBase = Common.idOf(`${baseName} (l)`);
    const lockedResult = Common.idOf(`${baseName} (l)${resultName.slice(baseName.length).trim()}`);
    if (lockedBase != null && lockedResult != null && Common.lookup(lockedBase)) ornamented.set(lockedResult, { base: lockedBase, kit });
  }
}

/** { base, kit } for an ornamented breakable item this unit takes the kit off, or null. */
function underKit(item) {
  // A preset copy (or another restricted one) was never given a kit by its holder and is deleted by the death as it is.
  if (!Common.getCore() || !item || item.isPresetItem?.() === true || item.isUntradeable?.() === true) return null;
  if (!ornamented) build();
  return ornamented.get(item.getId?.()) ?? null;
}

/**
 * `player-death:pvp-item-parts` (PlayerDeathTask, asked for the items a PvP death does not protect): the item under
 * the kit, the same Item, and the kit, which drops for the killer if it trades and stays the victim's if it does not.
 */
function takeKitOffOnPvpDeath(query) {
  const item = query?.item;
  // A bot's kit is not loot (DeathLoot.PlayerBots decides what its death gives).
  if (!item || query.parts || query.player?.isPlayerBot?.() === true) return;
  const made = underKit(item);
  if (!made) return;
  item.setId(made.base);
  query.parts = [item, new (Common.getCore().Item)(made.kit, 1)];
}

function attach(api) {
  api.onCustomEvent("player-death:pvp-item-parts", takeKitOffOnPvpDeath);
  api.onCustomEvent("items:pvp-death-parts-preview", takeKitOffOnPvpDeath);
}

module.exports = attach;
module.exports.underKit = underKit;
module.exports.takeKitOffOnPvpDeath = takeKitOffOnPvpDeath;
