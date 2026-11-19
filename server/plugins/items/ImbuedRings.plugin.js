"use strict";

/**
 * Imbued rings lost to a PvP death (docs/items-kept-on-death.md): the Seers, Archers, Warrior, Berserker, Tyrannical
 * and Treasonous rings, the Ring of the gods, the Ring of suffering and the Granite ring, each as the Nightmare Zone,
 * the Soul Wars or the Emir's Arena imbue (three items in the cache: `nzone_`, `sw_` and `pvpa_` before the ring's
 * own name).
 *
 * Wiki, each ring's (i) page: "If not protected, dying to another player will cause the imbued ring to lose its
 * imbued status, but the player will be reimbursed the Nightmare Zone points, Zeal Tokens or Scroll of imbuing to
 * re-imbue it via the aforementioned methods. Dying to a monster will not remove its imbued effect." The Ring of the
 * gods (i) page has that only as its change note ("Dying with the Ring of the gods (i) that is lost on death will
 * now refund either the points or the Imbue Scroll used to create it"), as Imbuing has for every imbued item.
 *
 * So the ring becomes the plain ring, which drops for the killer as any tradeable item, and the victim gets the imbue
 * back in the form it was paid in: the Nightmare Zone's points and Soul Wars' Zeal Tokens through the shops' own
 * refunds (`nightmare-zone:refund-imbue`, `soul-wars:refund-imbue`: the price the shop asks of that player now), a
 * scroll of imbuing for an Emir's Arena ring. Where a shop gives nothing back (the points would pass its cap) the
 * scroll stands in, as it does for a black mask (i) (SlayerHelmet.plugin.js).
 *
 * A Ring of suffering (ri) becomes the Ring of suffering (r), the same Item with its recoil charges (Wiki, Ring of
 * suffering: "Charges are not lost upon death"), and the (r), an untradeable, then stays with the victim as it did
 * before. Ours: the Wiki's pages do not say that a recoil-charged ring's plain ring goes to the killer.
 *
 * Not built here: Uncharge on these rings (nothing answers it yet).
 */
// Ours (upstream issue #6002): before this an imbued ring came back whole to whoever died with it, skulled or not.

/** The rings the reward shops imbue, by the cache's names. */
const RINGS = ["seer_ring", "ranger_ring", "warrior_ring", "berzerker_ring", "heavy_ring", "sharp_ring", "rotg",
  "zenyte_ring_enchanted", "zenyte_ring_enchanted_recoil", "granite_ring"];
/** The cache's prefix for each place a ring is imbued. */
const SOURCES = ["nzone", "sw", "pvpa"];

let api = null;
let core = null;
/** Imbued ring id -> { imbued, base, source }. */
const rings = new Map();

function load() {
  rings.clear();
  for (const name of RINGS) {
    const base = core.CacheDefinitions.getObjId(name);
    if (base == null) throw new Error(`ImbuedRings: the cache has no item named ${name}`);
    for (const source of SOURCES) {
      const imbued = core.CacheDefinitions.getObjId(`${source}_${name}`);
      if (imbued != null) rings.set(imbued, { imbued, base, source });
    }
  }
}

/** The ring this copy is an imbue of, or null: a preset copy (or another restricted one) was never paid for. */
function imbuedRing(item) {
  if (!core || !item || item.isPresetItem?.() === true || item.isUntradeable?.() === true) return null;
  return rings.get(item.getId?.()) ?? null;
}

/** Gives the imbue's price back through the shop that took it; false where there is no shop refund to give. */
function refundThroughShop(player, ring) {
  if (ring.source === "nzone") {
    const request = { player, baseItemId: ring.base, refunded: null };
    api.emitCustomEvent("nightmare-zone:refund-imbue", request);
    return request.refunded != null;
  }
  if (ring.source === "sw") {
    const request = { player, imbuedItemId: ring.imbued, refunded: null };
    api.emitCustomEvent("soul-wars:refund-imbue", request);
    return request.refunded != null;
  }
  return false;
}

/**
 * `player-death:pvp-item-parts` (PlayerDeathTask, asked for the items a PvP death does not protect): the plain ring,
 * the same Item, and the scroll of imbuing where that is the refund, which the victim keeps as any untradeable.
 * Asked as `items:pvp-death-parts-preview` (the Items Kept on Death screen, with a copy of the item and `preview`
 * set) it names the plain ring and refunds nothing.
 */
function unimbueOnPvpDeath(query) {
  const item = query?.item;
  // A bot's kit is not loot (DeathLoot.PlayerBots decides what its death gives), and its imbue was never paid for.
  if (!item || query.parts || !query.player || query.player.isPlayerBot?.() === true) return;
  const ring = imbuedRing(item);
  if (!ring) return;
  item.setId(ring.base);
  query.parts = query.preview === true || refundThroughShop(query.player, ring)
    ? [item]
    : [item, new core.Item(core.ItemIdentifiers.SCROLL_OF_IMBUING, 1)];
}

/** `items:lost-to-pvp-killer` { item, wildernessLevel, lost }: the Items Kept on Death screen's PvP preview. */
function answerLostToPvpKiller(query) {
  const ring = imbuedRing(query?.item);
  if (ring && new core.Item(ring.base, 1).isPlayerTradeable()) query.lost = true;
}

module.exports = {
  name: "ImbuedRings",
  description: "Imbued rings lost to a player: the killer gets the plain ring and the victim gets the imbue back as Nightmare Zone points, Zeal Tokens or a scroll of imbuing.",
  members: true,
  _test: { rings, imbuedRing, RINGS, SOURCES },
  register(pluginApi) {
    api = pluginApi;
    core = api.core;
    load();
    api.onCustomEvent("player-death:pvp-item-parts", unimbueOnPvpDeath);
    api.onCustomEvent("items:pvp-death-parts-preview", unimbueOnPvpDeath);
    api.onCustomEvent("items:lost-to-pvp-killer", answerLostToPvpKiller);
  },
};
