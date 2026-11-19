/**
 * Ornament kits and cosmetic recolours (https://oldschool.runescape.wiki/w/Ornament_kit).
 *
 * Using a kit on its base item consumes the kit and swaps the item for the cosmetic id from
 * plugins/items/data/ornament-kits.json. Reverting swaps the id back; entries whose Wiki says
 * the kit is returned set `refund: true`. The table also maps graceful colour variants, which
 * keep the graceful set bonus because the cache names every colour "Graceful ...".
 *
 * Barrows gear maps through Barrows.baseItemId, so a kit applies to a degraded piece and an
 * Echo Ahrim's piece reverts to the matching stage of the plain set (keeping its meta).
 *
 * A refund (the Wiki page of the ornamented item: "can be dismantled anytime, returning the
 * tradeable <item> and ornament kit") needs a free slot, and a restricted (preset, untradeable,
 * unbankable) copy is refused, because the kit would come back as a free, unrestricted item.
 * The same refusal guards applying a kit. Echo Ahrim's takes the option "Detach" as well.
 */
const fs = require("fs");
const path = require("path");
const { Barrows } = require("../../src/main/typescript/elvarg/game/content/combat/Barrows");

let core = null;
let byKitAndBase = new Map();
let byResult = new Map();
let byBase = new Map();
let gracefulBaseByVariant = new Map();
const GRACEFUL_BASES = new Set([11850, 11852, 11854, 11856, 11858, 11860]);

const PRESET_TEXT = "Preset items cannot be used for this.";

let pluginApi = null;

/** Preset (and other untradeable or unbankable) copies keep their restrictions; a refunded kit would not. */
function restricted(item) {
  const Item = core.Item;
  return !!item && (item.isPresetItem?.() === true
    || item.getMetaValue?.(Item.PRESET_META) === true
    || item.getMetaValue?.(Item.UNTRADEABLE_META) === true
    || item.getMetaValue?.(Item.UNBANKABLE_META) === true);
}

function loadKits() {
  const file = path.join(__dirname, "data", "ornament-kits.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return (data.kits ?? []).map((entry) => ({
    kit: Number(entry.kit) || 0,
    base: Number(entry.base),
    result: Number(entry.result),
    worn: Number(entry.worn) || 0,
    name: entry.name,
    refund: entry.refund === true,
    cleaningCloth: entry.cleaningCloth === true,
    consumeKit: entry.consumeKit !== false,
    revertable: entry.revertable !== false,
    allowGracefulVariants: entry.allowGracefulVariants === true,
    materials: (entry.materials ?? []).map((material) => ({
      id: Number(material.id),
      amount: Number(material.amount),
      name: String(material.name ?? "items"),
    })),
  }));
}

function resolvedBase(itemId) {
  const id = Number(itemId);
  return Barrows.baseItemId(id) ?? gracefulBaseByVariant.get(id) ?? id;
}

function findEntry(usedItemId, usedWithItemId) {
  const findFor = (kitId, baseId) => {
    const entry = byKitAndBase.get(`${kitId}|${resolvedBase(baseId)}`);
    if (entry && gracefulBaseByVariant.has(Number(baseId)) && !entry.allowGracefulVariants) {
      return null;
    }
    return entry;
  };
  const direct = findFor(usedItemId, usedWithItemId);
  if (direct) {
    return { entry: direct, kitOnLeft: true };
  }
  const reverse = findFor(usedWithItemId, usedItemId);
  return reverse ? { entry: reverse, kitOnLeft: false } : null;
}

function refresh(player) {
  player.getInventory().refreshItems();
  player.getEquipment().refreshItems();
}

/** True when the piece already is this entry's ornamented item (any Barrows stage of it, for Echo Ahrim's). */
function alreadyOrnamented(entry, itemId) {
  if (itemId === entry.result || (entry.worn > 0 && itemId === entry.worn)) {
    return true;
  }
  for (let stage = 0; stage < 5; stage++) {
    if (Barrows.stageItemIdFor(entry.result, stage) === itemId) {
      return true;
    }
  }
  return false;
}

function applyKit(event) {
  const match = findEntry(Number(event.usedItemId), Number(event.usedWithItemId));
  if (!match) {
    return;
  }
  const { player } = event;
  const baseItem = match.kitOnLeft ? event.usedWithItem : event.usedItem;
  if (!baseItem || resolvedBase(baseItem.getId?.()) !== match.entry.base) {
    return;
  }
  const kit = match.kitOnLeft ? event.usedItem : event.usedWithItem;
  const kitSlot = match.kitOnLeft ? event.usedItemSlot : event.usedWithItemSlot;
  const baseSlot = match.kitOnLeft ? event.usedWithItemSlot : event.usedItemSlot;
  const inventory = player.getInventory();
  if (inventory.getItems()[kitSlot] !== kit || inventory.getItems()[baseSlot] !== baseItem ||
    kit.getId() !== match.entry.kit || kit.getAmount() !== 1 || baseItem.getAmount() !== 1) return;
  // Echo Ahrim's resolves to its plain base, so the kit would otherwise be spent on a piece that has it.
  if (alreadyOrnamented(match.entry, baseItem.getId())) {
    return;
  }
  // A restricted kit would make a free, unrestricted ornamented item. A restricted base is refused only
  // where the kit is refundable (it could never come back from a restricted copy); a preset whip still
  // takes a whip mix, which keeps its metadata.
  if (restricted(kit) || (match.entry.refund && restricted(baseItem))) {
    player.sendMessage("You cannot use restricted items to upgrade equipment.");
    event.handled = true;
    return;
  }
  for (const material of match.entry.materials) {
    if (inventory.getAmount(material.id) < material.amount) {
      player.sendMessage(`You need ${material.amount.toLocaleString("en-US")} ${material.name} to use the ${match.entry.name.toLowerCase()}.`);
      event.handled = true;
      return;
    }
  }
  if (match.entry.consumeKit) inventory.deleteAtSlot(kitSlot, 1, false);
  for (const material of match.entry.materials) {
    inventory.deleteNumber(material.id, material.amount);
  }
  // The plain undamaged piece makes the undamaged ornamented one; a used one keeps its stage.
  const stage = Barrows.stageOf(baseItem.getId?.()) ?? 0;
  baseItem.setId(baseItem.getId() === match.entry.base
    ? match.entry.result
    : Barrows.stageItemIdFor(match.entry.result, stage) ?? match.entry.result);
  refresh(player);
  player.sendMessage(`You apply the ${match.entry.name.toLowerCase()}.`);
  event.handled = true;
  // `ornament-kits:applied` { player, kit, result }: the kit's name ("Sanguine ornament kit") and the new item.
  pluginApi?.emitCustomEvent?.("ornament-kits:applied", { player, kit: match.entry.name, result: baseItem.getId() });
}

function cleanDye(event) {
  const clothFirst = event.usedItemId === core.ItemIdentifiers.CLEANING_CLOTH;
  const cloth = clothFirst ? event.usedItem : event.usedWithItem;
  const item = clothFirst ? event.usedWithItem : event.usedItem;
  const clothSlot = clothFirst ? event.usedItemSlot : event.usedWithItemSlot;
  const itemSlot = clothFirst ? event.usedWithItemSlot : event.usedItemSlot;
  const entry = byResult.get(item?.getId());
  const inventory = event.player.getInventory();
  if (!entry?.cleaningCloth || cloth?.getId() !== core.ItemIdentifiers.CLEANING_CLOTH ||
    inventory.getItems()[clothSlot] !== cloth || inventory.getItems()[itemSlot] !== item ||
    cloth.getAmount() !== 1 || item.getAmount() !== 1) return;
  item.setId(entry.base);
  inventory.refreshItems();
  event.player.sendMessage("You wipe the colour off your weapon.");
  event.handled = true;
}

/**
 * Death protection from cosmetics: an item made with a tradeable ornament kit, mix or paint is
 * kept on a non-PvP death outside the Wilderness on top of the kept count, and so is one with the
 * untradeable Bounty Hunter ornament kit (Wiki: Items Kept on Death, Bounty hunter ornament kit).
 * Other untradeable modifications (the twisted ancestral colour kit, dark dye) and recolours made
 * without a kit go to the grave as the item would.
 */
function cosmeticOnDeath(query) {
  const entry = byResult.get(query?.item?.getId?.());
  if (!entry || entry.kit <= 0) return;
  if (entry.kit === core.ItemIdentifiers.BOUNTY_HUNTER_ORNAMENT_KIT || new core.Item(entry.kit, 1).isTradeable()) {
    query.cosmetic = true;
  }
}

/**
 * What a PvP death makes of an unprotected ornamented item (Wiki: Items Kept on Death, Mechanics), or null where it
 * leaves the item as it is: { base, kit }, the plain item's id and the kit that comes off it (0: none).
 * - A tradeable item with a kit or recolour is "dropped to the PKer as the tradeable, non-ornamented item".
 * - A kit that dismantling gives back comes off: a tradeable one "also drops ... to the PKer", an untradeable one (the
 *   Bounty Hunter kits: "the item will be lost to the killer but the kit will be sent to the gravestone") stays the
 *   victim's, and so does any other untradeable kit that was used up making the item ("The untradeable modification
 *   goes to the victim's gravestone"). A tradeable kit or recolour that dismantling does not give back is gone with
 *   the death (Volcanic abyssal whip: "Dropped to the PKer as base item, recolour is destroyed").
 * - An untradeable item with a tradeable kit (Rune defender (t), Graceful (Trailblazer)) loses the kit to the PKer
 *   and meets the death as the plain item.
 * Where nothing would change hands (an untradeable item whose kit is untradeable or does not come back: a dyed
 * Graceful piece, Fighter torso (or)) the item is left alone, as are preset copies and Barrows pieces, which have a
 * death rule of their own.
 */
// Ours (upstream issue #6002): before this every ornamented item counted as an untradeable and came back to its
// owner from a PvP death, skulled or not: an Armadyl godsword (or), a Volcanic abyssal whip, Elder chaos (or) robes.
function pvpDeathParts(item) {
  if (!item || restricted(item)) return null;
  const id = Number(item.getId?.());
  const entry = byResult.get(id);
  if (!entry || Barrows.baseItemId(id) != null || Barrows.baseItemId(entry.base) != null) return null;
  const tradeable = (itemId) => new core.Item(itemId, 1).isPlayerTradeable();
  const comesOff = entry.kit > 0 && (entry.refund || (entry.consumeKit && !tradeable(entry.kit)));
  const kit = comesOff ? entry.kit : 0;
  const baseTradeable = tradeable(entry.base);
  if (!baseTradeable && !(kit > 0 && tradeable(kit))) return null;
  return { base: entry.base, kit, baseTradeable };
}

/** `player-death:pvp-item-parts` (PlayerDeathTask): the plain item, the same Item so its metadata stays, and its kit. */
function splitOnPvpDeath(query) {
  // A bot's gear is not loot (DeathLoot.PlayerBots decides what its death gives).
  if (query?.player?.isPlayerBot?.() === true || query.parts) return;
  const parts = pvpDeathParts(query.item);
  if (!parts) return;
  const { item } = query;
  const amount = item.getAmount();
  item.setId(parts.base);
  query.parts = parts.kit > 0 ? [item, new core.Item(parts.kit, amount)] : [item];
}

/** `items:lost-to-pvp-killer` { item, wildernessLevel, lost }: the Items Kept on Death screen's PvP preview. */
function answerLostToPvpKiller(query) {
  if (pvpDeathParts(query?.item)?.baseTradeable) query.lost = true;
}

/** Revert from the item's Revert/Dismantle option, returning the kit for entries that specify it. */
function revertItem(event) {
  if (event.option !== "Revert" && event.option !== "Dismantle" && event.option !== "Detach") {
    return;
  }
  const itemId = Number(event.itemId);
  const barrowsBase = Barrows.baseItemId(itemId);
  const entry = byResult.get(itemId) ?? (barrowsBase == null ? null : byBase.get(barrowsBase));
  if (!entry || entry.cleaningCloth || !entry.revertable || !event.item) {
    return;
  }
  // Wiki (Dragon full helm (g) and the rest): these kits come back when dismantled, so it must fit first.
  const kit = entry.refund ? new core.Item(entry.kit, 1) : null;
  if (kit && restricted(event.item)) {
    event.player.sendMessage(PRESET_TEXT);
    event.handled = true;
    return;
  }
  if (kit && event.player.getInventory().getAddableAmount(kit) < 1) {
    event.player.sendMessage("You don't have enough inventory space to do that.");
    event.handled = true;
    return;
  }
  if (barrowsBase == null) {
    event.item.setId(entry.base);
  } else {
    // The undamaged ornamented piece gives the undamaged plain one back, a used one its stage.
    event.item.setId(itemId === entry.result
      ? entry.base
      : Barrows.stageItemId(barrowsBase, Barrows.stageOf(itemId) ?? 0));
  }
  if (kit) event.player.getInventory().add(kit, false);
  refresh(event.player);
  event.player.sendMessage(`You revert the ${entry.name.toLowerCase()}.`);
  event.handled = true;
}

module.exports = {
  name: "OrnamentKits",
  description: "Lets ornament kits and colour recolours be applied to their base items and reverted, with refunds where the Wiki says the kit is returned.",
  _test: { loadKits: () => loadKits(), findEntry, applyKit, revertItem, pvpDeathParts },
  register(api) {
    pluginApi = api;
    core = api.core;
    const I = core.ItemIdentifiers;
    core.Barrows.registerVariantStages(I.AHRIMS_HOOD, [
      I.ECHO_AHRIMS_HOOD_100,
      I.ECHO_AHRIMS_HOOD_75,
      I.ECHO_AHRIMS_HOOD_50,
      I.ECHO_AHRIMS_HOOD_25,
      I.ECHO_AHRIMS_HOOD_0,
    ], I.ECHO_AHRIMS_HOOD);
    core.Barrows.registerVariantStages(I.AHRIMS_ROBETOP, [
      I.ECHO_AHRIMS_ROBETOP_100,
      I.ECHO_AHRIMS_ROBETOP_75,
      I.ECHO_AHRIMS_ROBETOP_50,
      I.ECHO_AHRIMS_ROBETOP_25,
      I.ECHO_AHRIMS_ROBETOP_0,
    ], I.ECHO_AHRIMS_ROBETOP);
    core.Barrows.registerVariantStages(I.AHRIMS_ROBESKIRT, [
      I.ECHO_AHRIMS_ROBESKIRT_100,
      I.ECHO_AHRIMS_ROBESKIRT_75,
      I.ECHO_AHRIMS_ROBESKIRT_50,
      I.ECHO_AHRIMS_ROBESKIRT_25,
      I.ECHO_AHRIMS_ROBESKIRT_0,
    ], I.ECHO_AHRIMS_ROBESKIRT);
    core.Barrows.registerVariantStages(I.AHRIMS_STAFF, [
      I.ECHO_AHRIMS_STAFF_100,
      I.ECHO_AHRIMS_STAFF_75,
      I.ECHO_AHRIMS_STAFF_50,
      I.ECHO_AHRIMS_STAFF_25,
      I.ECHO_AHRIMS_STAFF_0,
    ], I.ECHO_AHRIMS_STAFF);
    const entries = loadKits();
    gracefulBaseByVariant = new Map();
    for (const entry of entries) {
      if (!GRACEFUL_BASES.has(entry.base)) continue;
      gracefulBaseByVariant.set(entry.result, entry.base);
      if (entry.worn > 0) gracefulBaseByVariant.set(entry.worn, entry.base);
    }
    for (const entry of entries) {
      if (entry.kit > 0) {
        byKitAndBase.set(`${entry.kit}|${entry.base}`, entry);
        byBase.set(entry.base, entry);
      }
      byResult.set(entry.result, entry);
      if (entry.worn > 0) {
        byResult.set(entry.worn, entry);
      }
    }
    api.onItemOnItem(applyKit, { noted: false });
    api.onItemOnItem(cleanDye, { noted: false });
    api.onItemAction(revertItem);
    api.onCustomEvent("player-death:cosmetic", cosmeticOnDeath);
    api.onCustomEvent("player-death:pvp-item-parts", splitOnPvpDeath);
    api.onCustomEvent("items:lost-to-pvp-killer", answerLostToPvpKiller);
    api.log("registered", { pairs: byKitAndBase.size, variants: byResult.size });
  },
};
