"use strict";

/**
 * Ancient Warriors' equipment from the Bounty Hunter Store (Wiki: Ancient Warriors' equipment, Bounty Hunter#Equipment
 * and each item's page).
 *
 * - The store sells each piece inactive. "Activate" charges it with coins ("must be charged with 5,000,000 coins before
 *   it can be used"; the amounts are in data/bounty-hunter-equipment.json) and makes it the wearable piece.
 * - "Upon dying in PvP, the coins used to activate the item are given to the killer, and players are left with the
 *   inactive item. ... the activated form is preserved and the coins aren't lost if [it] is one of the player's
 *   protected items."
 * - "Uncharge" makes it inactive again.
 *
 * The coins a piece was charged with are kept on the item (item metadata), so the death and Uncharge hand back
 * exactly what went in. A piece nobody charged (one spawned by a preset, a command or a bot's kit) holds no coins: a
 * death still leaves it inactive, and pays the killer nothing.
 *
 * The weapons made with the store's imbue scrolls (Dark bow (bh) and the rest) are lost to a PvP death as the weapon
 * they were made from, and the scroll is kept (loseImbuedWeaponOnPvpDeath).
 *
 * Ours, where the Wiki says nothing: Uncharge gives the coins back to the player; the wording of every message; the
 * Yes/No before the coins are taken; and `bounty-hunter:can-convert`, by which the Corrupted Warrior refuses a charged
 * piece whose corrupted (or plain) form takes a different amount, so that converting never changes what a piece holds.
 */
// Ours (upstream issue #6002): before this an activated piece came back from a PvP death as it was, skulled or not, and
// the inactive pieces the store sells could not be activated at all.

const DATA = require("./data/bounty-hunter-equipment.json");

/** The coins this copy was charged with. */
const FEE_META = "bounty-hunter:activation-fee";
const NOT_ENOUGH_SPACE = "You don't have enough inventory space to do that.";

let api;
let core;
/** Active id -> { active, inactive, fee }, and the same entry by inactive id. */
const byActive = new Map();
const byInactive = new Map();
/** Imbued weapon id -> { weapon, scroll }: what it is made of. */
const imbuedWeapons = new Map();

function load(identifiers) {
  byActive.clear();
  byInactive.clear();
  for (const [name, fee] of Object.entries(DATA.activationFees)) {
    const active = identifiers[name];
    const inactive = identifiers[name.replace(/_$/, "_INACTIVE_")];
    if (!Number.isInteger(active) || !Number.isInteger(inactive) || !Number.isSafeInteger(fee) || fee <= 0) {
      throw new Error(`bounty-hunter-equipment.json: unknown piece or fee for ${name}`);
    }
    const entry = { active, inactive, fee };
    byActive.set(active, entry);
    byInactive.set(inactive, entry);
  }
  imbuedWeapons.clear();
  for (const row of DATA.imbuedWeapons) {
    const [imbued, weapon, scroll] = [row.imbued, row.weapon, row.scroll].map((name) => identifiers[name]);
    if (![imbued, weapon, scroll].every(Number.isInteger)) {
      throw new Error(`bounty-hunter-equipment.json: unknown item in ${JSON.stringify(row)}`);
    }
    imbuedWeapons.set(imbued, { weapon, scroll });
  }
}

/** A copy a preset spawned (or another restricted copy) was never paid for and is deleted by a death as it is. */
function restricted(item) {
  return item?.isPresetItem?.() === true || item?.isUntradeable?.() === true;
}

/** The coins an activated copy holds: what it was charged with, never more than its piece takes. */
function heldCoins(item) {
  const entry = byActive.get(item?.getId?.());
  const held = Number(item?.getMetaValue?.(FEE_META));
  return entry && Number.isSafeInteger(held) && held > 0 ? Math.min(held, entry.fee) : 0;
}

function coins(amount) {
  return `${amount.toLocaleString("en-US")} coins`;
}

function nameOf(itemId) {
  return core.ItemDefinition.forId(itemId).getName();
}

function inInventory(player, slot, item, id) {
  return player.getInventory().getItems()[slot] === item && item.getId() === id && item.getAmount() === 1;
}

function activate(event) {
  const { player, item, slot } = event;
  const entry = byInactive.get(item.getId());
  if (!entry) return false;
  if (!inInventory(player, slot, item, entry.inactive)) return;
  if (restricted(item)) {
    player.sendMessage("You can't activate that.");
    return;
  }
  const { ItemIdentifiers } = core;
  if (player.getInventory().getAmount(ItemIdentifiers.COINS) < entry.fee) {
    player.sendMessage(`You need ${coins(entry.fee)} in your inventory to activate the ${nameOf(entry.active)}.`);
    return;
  }
  api.sendMultiChatboxPrompt(player, `Activate it for ${coins(entry.fee)}?`,
    "Yes.", () => {
      const inventory = player.getInventory();
      if (!inInventory(player, slot, item, entry.inactive) || inventory.getAmount(ItemIdentifiers.COINS) < entry.fee) return;
      inventory.deleteNumber(ItemIdentifiers.COINS, entry.fee);
      item.setId(entry.active);
      item.setMetaValue(FEE_META, entry.fee);
      inventory.refreshItems();
      player.sendMessage(`You charge the ${nameOf(entry.active)} with ${coins(entry.fee)}.`);
    },
    "No.", () => {});
}

function uncharge(event) {
  const { player, item, slot } = event;
  const entry = byActive.get(item.getId());
  if (!entry) return false;
  if (!inInventory(player, slot, item, entry.active)) return;
  if (restricted(item)) {
    player.sendMessage("You can't uncharge that.");
    return;
  }
  const held = heldCoins(item);
  const inventory = player.getInventory();
  const refund = new core.Item(core.ItemIdentifiers.COINS, held);
  if (held > 0 && inventory.getAddableAmount(refund) < held) {
    player.sendMessage(NOT_ENOUGH_SPACE);
    return;
  }
  item.setId(entry.inactive);
  item.setMetaValue(FEE_META, undefined);
  if (held > 0) inventory.add(refund, false);
  inventory.refreshItems();
  player.sendMessage(held > 0
    ? `You uncharge the ${nameOf(entry.active)} and take back ${coins(held)}.`
    : `You uncharge the ${nameOf(entry.active)}.`);
}

/**
 * `player-death:pvp-item-parts` (PlayerDeathTask, asked for the items a PvP death does not protect): the piece goes
 * inactive, the same Item, which the victim then keeps as any untradeable; the coins it held become a part of their
 * own, which the death drops for the killer with the rest of the loot.
 */
function deactivateOnPvpDeath(query) {
  const item = query?.item;
  // A bot's kit is not loot (DeathLoot.PlayerBots decides what its death gives), and was never charged.
  if (!item || query.parts || query.player?.isPlayerBot?.() === true || restricted(item)) return;
  const entry = byActive.get(item.getId());
  if (!entry) return;
  const held = heldCoins(item);
  item.setId(entry.inactive);
  item.setMetaValue(FEE_META, undefined);
  query.parts = held > 0 ? [item, new core.Item(core.ItemIdentifiers.COINS, held)] : [item];
}

/**
 * `player-death:pvp-item-parts`: a weapon made with one of the store's imbue scrolls. Wiki (Dark bow (bh), Barrelchest
 * anchor (bh), Dragon mace (bh), Dragon longsword (bh), Abyssal dagger (bh)): "If the player dies in Bounty Hunter
 * with the item, the imbue scroll is kept, but the weapon is lost." The weapon is lost as the weapon it was made from,
 * the same Item, which then meets the death as that weapon does (a Dark bow drops for the killer, a Barrelchest anchor
 * becomes its coins), and the scroll, an untradeable, stays the victim's.
 */
// Ours (upstream issue #6002): before this an imbued weapon came back whole to whoever died with it.
function loseImbuedWeaponOnPvpDeath(query) {
  const item = query?.item;
  // A bot's kit is not loot (DeathLoot.PlayerBots decides what its death gives): what a crater bot's imbued weapon
  // should give its killer is left as it was, nothing.
  if (!item || query.parts || query.player?.isPlayerBot?.() === true || restricted(item)) return;
  const made = imbuedWeapons.get(item.getId());
  if (!made) return;
  item.setId(made.weapon);
  query.parts = [item, new core.Item(made.scroll, 1)];
}

/** `items:lost-to-pvp-killer` { item, wildernessLevel, lost }: the Items Kept on Death screen's PvP preview. */
function answerLostToPvpKiller(query) {
  const made = restricted(query?.item) ? null : imbuedWeapons.get(query?.item?.getId?.());
  if (made && new core.Item(made.weapon, 1).isPlayerTradeable()) query.lost = true;
}

/**
 * `bounty-hunter:can-convert` { item, to, allowed, message }: the Corrupted Warrior asks before swapping a piece for
 * its corrupted or plain form. A charged piece converts only where both forms take the same coins.
 */
function canConvert(query) {
  const from = byActive.get(query?.item?.getId?.());
  const to = byActive.get(query?.to);
  if (!from || !to || heldCoins(query.item) <= 0 || from.fee === to.fee) return;
  query.allowed = false;
  query.message = "The Corrupted Warrior can't convert armour that is charged with coins. Uncharge it first.";
}

module.exports = {
  name: "BountyHunterEquipment",
  description: "Bounty Hunter Store equipment: Activate charges a piece of Ancient Warriors' equipment with coins, Uncharge takes them back, an unprotected piece lost to a player goes inactive and pays its coins to the killer, and an imbued weapon is lost as the plain weapon.",
  members: true,
  _test: { byActive, byInactive, imbuedWeapons, heldCoins, FEE_META },
  register(pluginApi) {
    api = pluginApi;
    core = pluginApi.core;
    load(core.ItemIdentifiers);
    // By the cache's item names: the click carries only its slot, and the name resolves the option it stands for.
    for (const entry of byActive.values()) {
      api.onItemAction(nameOf(entry.inactive), { Activate: activate });
      api.onItemAction(nameOf(entry.active), { Uncharge: uncharge });
    }
    api.onCustomEvent("player-death:pvp-item-parts", deactivateOnPvpDeath);
    api.onCustomEvent("items:pvp-death-parts-preview", deactivateOnPvpDeath);
    api.onCustomEvent("player-death:pvp-item-parts", loseImbuedWeaponOnPvpDeath);
    api.onCustomEvent("items:pvp-death-parts-preview", loseImbuedWeaponOnPvpDeath);
    api.onCustomEvent("items:lost-to-pvp-killer", answerLostToPvpKiller);
    api.onCustomEvent("bounty-hunter:can-convert", canConvert);
  },
};
