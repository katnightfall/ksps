"use strict";

/**
 * Charged crystal weapons (docs/crystal-weapons.md): the Bow of Faerdhinen and the Blade of Saeldor.
 * A new one holds 10,000 charges, one is used by every shot or swing, hit or miss, and crystal shards
 * add 100 each up to 20,000 (CrystalShards.js). Each charge used that leaves a multiple of 500 sends
 * a red reminder of the charges left. An emptied weapon becomes its inactive form, which has no
 * bonuses until it is charged again. Shared by the two weapon plugins in this directory.
 *
 * `defineCrystalWeapon(api, config)`:
 * - `name`: the weapon in messages ("bow of Faerdhinen"); `chargesKey`: the item meta holding
 *   `{ charges, used }`; `chargedName` / `inactiveName`: the cache names the Check and shard hooks bind.
 * - `pairs`: [[chargedId, inactiveId]]; `usedPerPercent`: charges used per 1% of corruption progress.
 * - `corrupted`: the cache name of the corrupted ("(c)") weapon; each colour of it is that name or `<name>_<clan>`.
 *
 * A PvP death that does not protect the weapon leaves the killer the inactive one (inactiveOnPvpDeath).
 */

const { MAX_CHARGES, CHARGES_PER_SHARD, SHARD_NAME, shardRoom, chargesWith, promptShards } = require("./CrystalShards");

const NEW_CHARGES = 10000;
const WARNING_STEP = 500;

function defineCrystalWeapon(api, config) {
  const core = api.core;
  const inactiveByCharged = new Map(config.pairs);
  const chargedByInactive = new Map(config.pairs.map(([charged, inactive]) => [inactive, charged]));

  const isCharged = (id) => inactiveByCharged.has(Number(id));
  /** Every colour of the corrupted weapon, read from the cache on first use; its `_dummy` copy is not an item a player holds. */
  let corruptedIds = null;
  function isCorrupted(id) {
    if (!corruptedIds) {
      corruptedIds = new Set();
      for (const [itemId, name] of config.corrupted ? core.CacheDefinitions.getObjNames() : []) {
        if (name === config.corrupted || (name.startsWith(`${config.corrupted}_`) && !name.endsWith("_dummy"))) corruptedIds.add(Number(itemId));
      }
    }
    return corruptedIds.has(Number(id));
  }
  const isWeapon = (id) => isCharged(id) || chargedByInactive.has(Number(id));
  /** Player -> the weapon whose last charge their current shot or swing spent. */
  const spent = new WeakMap();
  const weaponOf = (player) => player.getEquipment().getItems()[core.Equipment.WEAPON_SLOT] ?? null;

  function saved(item) {
    const value = item?.getMetaValue?.(config.chargesKey);
    return value && typeof value === "object" ? value : null;
  }

  /** A weapon with no saved count is new: full if charged, empty if inactive. */
  function chargesOf(item) {
    const value = Number(saved(item)?.charges);
    if (Number.isFinite(value)) return Math.max(0, Math.min(MAX_CHARGES, Math.floor(value)));
    return isCharged(item?.getId?.()) ? NEW_CHARGES : 0;
  }

  function usedOf(item) {
    const value = Number(saved(item)?.used);
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }

  function progressOf(item) {
    return Math.min(100, Math.floor(usedOf(item) / config.usedPerPercent));
  }

  /** Stores the count and swaps between the charged and inactive form to match. */
  function store(item, charges, used) {
    item.setMetaValue(config.chargesKey, { charges, used });
    const id = item.getId();
    if (charges > 0 && chargedByInactive.has(id)) item.setId(chargedByInactive.get(id));
    if (charges <= 0 && inactiveByCharged.has(id)) item.setId(inactiveByCharged.get(id));
  }

  function refresh(player) {
    player.getInventory().refreshItems();
    player.getEquipment().refreshItems();
    core.BonusManager.update(player);
    player.getUpdateFlag().flag(core.Flag.APPEARANCE);
    core.WeaponInterfaceManager.assign(player);
  }

  /** The worn weapon pays for the shot or swing; the last charge turns it inactive. */
  function useCharge(player) {
    const item = weaponOf(player);
    if (!item || !isCharged(item.getId())) return;
    // Content may spare the charge (a league relic): the question every charged weapon asks.
    // `extra`: charges given back on top (Demonic Pacts' Regenerate above 100%), up to 20,000.
    const consume = { player, itemId: item.getId(), skip: false, extra: 0 };
    api.emitCustomEvent("combat:consume-charge", consume);
    if (consume.skip) {
      if (consume.extra > 0) store(item, Math.min(MAX_CHARGES, chargesOf(item) + consume.extra), usedOf(item));
      return;
    }
    const left = Math.max(0, chargesOf(item) - 1);
    if (left === 0) {
      // The shot or swing is rolled with the charged bonuses; the weapon turns inactive after it.
      item.setMetaValue(config.chargesKey, { charges: 0, used: usedOf(item) + 1 });
      spent.set(player, item);
      return;
    }
    store(item, left, usedOf(item) + 1);
    if (left % WARNING_STEP === 0) {
      player.sendMessage(`<col=ff0000>Your ${config.name} has ${left} charges remaining.</col>`);
    }
  }

  /** The last charge's attack is over: the emptied weapon becomes its inactive form. */
  function onAttackFinished({ attacker }) {
    const player = attacker?.isPlayer?.() ? attacker.getAsPlayer() : null;
    const item = player ? spent.get(player) : null;
    if (!item) return;
    spent.delete(player);
    if (isCharged(item.getId()) && chargesOf(item) === 0) {
      store(item, 0, usedOf(item));
      refresh(player);
    }
  }

  function check({ player, item }) {
    if (!item || !isCharged(item.getId())) return false;
    const charges = chargesOf(item).toLocaleString("en-US");
    player.sendMessage(`Your ${config.name} has ${charges} charges remaining, and ${progressOf(item)}% progress towards corruption.`);
    return true;
  }

  /** Asks how many shards to add, each 100 charges, up to the cap. */
  function addShards(event) {
    const { player, usedItem, usedWithItem, usedItemId, usedWithItemId } = event;
    const weapon = isWeapon(usedItemId) ? usedItem : isWeapon(usedWithItemId) ? usedWithItem : null;
    const shards = weapon === usedItem ? usedWithItem : usedItem;
    if (!weapon || !shards) return;
    event.handled = true;
    if (shardRoom(chargesOf(weapon)) < 1) {
      player.sendMessage(`Your ${config.name} cannot hold any more charges.`);
      return;
    }
    promptShards(player, weapon, chargesOf, shards.getId(), (count) => {
      store(weapon, chargesWith(chargesOf(weapon), count), usedOf(weapon));
      refresh(player);
    });
  }

  /** The inactive weapon a PvP death makes of this copy, or null: a charged one's own, a corrupted one's the plain. */
  function inactiveIdOf(item) {
    // A preset copy (or another restricted one) was never paid for and is deleted by the death as it is.
    if (!item || item.isPresetItem?.() === true || item.isUntradeable?.() === true) return null;
    const id = Number(item.getId?.());
    return inactiveByCharged.get(id) ?? (isCorrupted(id) ? config.pairs[0][1] : null);
  }

  /**
   * `player-death:pvp-item-parts` (PlayerDeathTask, asked for the items a PvP death does not protect). Wiki, Blade of
   * Saeldor and Bow of Faerdhinen: "On unprotected death in PvP, the inactive [weapon] is dropped, and all shards used
   * to charge it will be lost." The weapon becomes its inactive form, the same Item with its charge count gone, and
   * that tradeable item then drops for the killer. A corrupted one is lost the same way: its Uncharge makes the
   * inactive weapon and gives no shards back (Wiki, the (c) pages), which is what Items Kept on Death's "Chargable
   * items" row drops for the killer ("the tradeable uncharged item, and ... the items that would result from
   * uncharging the item"). Its colour goes with it.
   */
  // Ours (upstream issue #6002): before this the charged and the corrupted weapon came back whole to whoever died
  // with them, skulled or not.
  function inactiveOnPvpDeath(query) {
    const item = query?.item;
    // A bot's kit is not loot (DeathLoot.PlayerBots decides what its death gives).
    if (!item || query.parts || query.player?.isPlayerBot?.() === true) return;
    const inactiveId = inactiveIdOf(item);
    if (inactiveId == null) return;
    item.setId(inactiveId);
    item.setMetaValue(config.chargesKey, undefined);
    query.parts = [item];
  }

  /** `items:lost-to-pvp-killer` { item, wildernessLevel, lost }: the Items Kept on Death screen's PvP preview. */
  function answerLostToPvpKiller(query) {
    if (inactiveIdOf(query?.item) != null) query.lost = true;
  }

  function attach() {
    api.onCustomEvent("combat:attack-finished", onAttackFinished);
    api.onCustomEvent("player-death:pvp-item-parts", inactiveOnPvpDeath);
    api.onCustomEvent("items:pvp-death-parts-preview", inactiveOnPvpDeath);
    api.onCustomEvent("items:lost-to-pvp-killer", answerLostToPvpKiller);
    api.onItemAction(config.chargedName, { Check: check });
    api.onItemOnItem(SHARD_NAME, config.chargedName, addShards, { noted: false });
    api.onItemOnItem(SHARD_NAME, config.inactiveName, addShards, { noted: false });
  }

  return { attach, useCharge, onAttackFinished, check, addShards, chargesOf, progressOf, isCharged, isCorrupted, isWeapon, weaponOf, inactiveOnPvpDeath };
}

module.exports = { defineCrystalWeapon, NEW_CHARGES, MAX_CHARGES, CHARGES_PER_SHARD };
