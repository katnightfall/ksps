"use strict";

/**
 * Ours. Bots that own what they use.
 *
 * A bot of a progression site (brain/SiteSpawner) starts as a new player does, with the starter
 * kit (plugins/world/StarterKit.plugin.js), and from then on nothing is handed to it. A tool,
 * bait, runes, arrows, food or armour is something it carries, has in its bank, buys in a shop
 * with coins it earned, or picks up. This file is how it gets one of those:
 *
 *   carried            done
 *   in its bank        a walk to the bank and a withdrawal (leaving there what it has no use for)
 *   in a shop          a walk to the nearest keeper who stocks it, paid for with its own coins
 *   none of these      the step fails; what it could not afford is remembered as a wish, and a
 *                      bot with a wish sells what it gathers rather than dropping it (Choose)
 *
 * Bots of other kinds (the levelled sites, the Wilderness, mini-games) are still outfitted by
 * their own code, as upstream has it. World setting "PlayerBots:earnOwnItems" (default on).
 */
const fs = require("node:fs");
const path = require("node:path");
const { Bank } = require("../../../src/main/typescript/elvarg/game/model/container/impl/Bank");
const { Item } = require("../../../src/main/typescript/elvarg/game/model/Item");
const { ItemIdentifiers } = require("../../../src/main/typescript/elvarg/util/ItemIdentifiers");
const { PlayerSave } = require("../../../src/main/typescript/elvarg/game/entity/impl/player/persistence/PlayerSave");
const { PluginManager } = require("../../../src/main/typescript/elvarg/plugins/PluginManager");
const { requestMovement, peekMovementRequest, clearMovementRequest } = require("../behaviours/navigation/Navigation.PlayerBots");
const { canReachSpot } = require("../behaviours/navigation/LongRoutes.PlayerBots");
const { nearestClusters, npcClustersFor } = require("./NpcClusterIndex.PlayerBots");

const EARNS_ATTRIBUTE = "bots:earns-items";
const EARN_CONFIG = "PlayerBots:earnOwnItems";
PlayerSave.persistAttribute(EARNS_ATTRIBUTE, false);

const COINS = ItemIdentifiers.COINS;
/** Never left at the bank: money, fire, and bait (one slot each, wanted again within minutes). */
const ALWAYS_KEPT = new Set([COINS, ItemIdentifiers.TINDERBOX, ItemIdentifiers.FEATHER, ItemIdentifiers.FISHING_BAIT]);
// Close enough to a shopkeeper to trade.
const TRADE_RANGE = 3;
// Not moving this long on the way to a shop or a bank: give up.
const STUCK_MS = 30000;
// A shop that was sold out, or could not be walked to, is left alone this long.
const AVOID_SHOP_MS = 10 * 60 * 1000;
// What a bot could not get keeps its activity off for this long: time to do something else, and earn.
const WANT_COOLDOWN_MS = 12 * 60 * 1000;
// A wish older than this is forgotten.
const WISH_MS = 60 * 60 * 1000;
// A backpack this full of things the work at hand has no use for is emptied at the bank first.
const CLUTTER_SLOTS = 4;
const TIDY_RETRY_MS = 10 * 60 * 1000;
const NEAREST_SHOPS = 6;

/** Whether this world's levelling bots own what they use (world setting, default on). */
function worldEarns() {
  return PluginManager.getPluginConfig?.(EARN_CONFIG) !== false;
}

/** Whether nothing is handed to this bot. */
function earnsOwnItems(player) {
  return player?.getAttribute?.(EARNS_ATTRIBUTE) === true;
}

function setEarnsOwnItems(player, earns) {
  player?.setAttribute?.(EARNS_ATTRIBUTE, earns === true);
}

/** How many of an item the bot's bank holds, over every tab. */
function banked(player, itemId) {
  let total = 0;
  for (let tab = 0; tab < Bank.TOTAL_BANK_TABS - 1; tab++) total += player.getBank(tab)?.getAmount?.(itemId) ?? 0;
  return total;
}

const carried = (player, itemId) => player.getInventory().getAmount(itemId);

function worn(player, itemId) {
  return (player.getEquipment().getItems() ?? []).some((item) => item?.getId?.() === itemId && item.getAmount() > 0);
}

/** The bot's coins, in its backpack and its bank. */
function purse(player) {
  return carried(player, COINS) + banked(player, COINS);
}

/** Backpack slots holding something `keep` (an item id -> boolean) has no use for. */
function clutter(player, keep) {
  return (player.getInventory().getItems() ?? []).filter((item) => item && item.getId() > 0 && !keep(item.getId())).length;
}

function depositAllExcept(player, keep) {
  player.getInventory().getItems().forEach((item, slot) => {
    if (item && item.getId() > 0 && !keep(item.getId())) Bank.deposit(player, item.getId(), slot, item.getAmount(), true);
  });
}

/** Takes up to `amount` of an item out of the bank (whatever tab it is in). Returns how many came. */
function withdraw(player, itemId, amount) {
  const before = carried(player, itemId);
  let remaining = amount;
  for (let tab = 0; tab < Bank.TOTAL_BANK_TABS - 1 && remaining > 0; tab++) {
    const bank = player.getBank(tab);
    const slot = bank?.getSlotForItemId?.(itemId) ?? -1;
    const stack = slot >= 0 ? bank.getItems()[slot] : null;
    if (!stack || stack.getId() !== itemId) continue;
    const take = Math.min(remaining, stack.getAmount());
    Bank.withdraw(player, itemId, slot, take, tab);
    remaining -= take;
  }
  return carried(player, itemId) - before;
}

/** The bank's items as [{ itemId, amount }] for which `wanted(itemId)` holds. */
function bankedWhere(player, wanted) {
  const found = new Map();
  for (let tab = 0; tab < Bank.TOTAL_BANK_TABS - 1; tab++) {
    for (const item of player.getBank(tab)?.getItems?.() ?? []) {
      if (item && item.getId() > 0 && item.getAmount() > 0 && wanted(item.getId())) {
        found.set(item.getId(), (found.get(item.getId()) ?? 0) + item.getAmount());
      }
    }
  }
  return [...found].map(([itemId, amount]) => ({ itemId, amount }));
}

/**
 * Coin shops with a keeper to walk to, from shops.json: item id -> [{ shopId, npcIds, price }],
 * `price` being what one costs at the shop's normal stock (the real price is read at the counter).
 */
function loadOffers(file = path.join(process.cwd(), "data", "definitions", "shops.json")) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const offers = new Map();
  const keepers = new Map();
  for (const shop of Array.isArray(raw) ? raw : raw.shops ?? []) {
    if (String(shop.currency ?? "COINS").toUpperCase() !== "COINS") continue;
    const npcIds = (shop.npcInteractions ?? []).flatMap((link) => link.npcIds ?? []).filter(Number.isInteger);
    if (npcIds.length === 0) continue;
    // A keeper with several shops (one per quest state) trades from the first listed.
    const mine = npcIds.filter((npcId) => !keepers.has(npcId));
    if (mine.length === 0) continue;
    for (const npcId of mine) keepers.set(npcId, shop.id);
    for (const stock of shop.originalStock ?? []) {
      if (!Number.isInteger(stock?.id) || !(stock.amount > 0)) continue;
      const value = Number(new Item(stock.id, 1).getDefinition()?.getValue?.() ?? 0);
      if (!(value > 0)) continue;
      const price = Math.max(1, Math.floor(value * Number(shop.sellsAt ?? 1000) / 1000));
      let list = offers.get(stock.id);
      if (!list) offers.set(stock.id, (list = []));
      list.push({ shopId: shop.id, npcIds: mine, price });
    }
  }
  return { offers, keepers };
}

/**
 * A bank or a shop left open keeps the bot busy(): whatever it does next (fight, fish) would
 * wait on it for good.
 */
function closeInterface(player) {
  if (Number(player.getInterfaceId?.() ?? -1) > 0) player.getPacketSender?.()?.sendInterfaceRemoval?.();
}

const BY_WORLD = new WeakMap();

/** The world's one instance (shop table, bank trip, per-bot state). */
function ownItemsFor(world) {
  let own = BY_WORLD.get(world);
  if (!own) BY_WORLD.set(world, (own = createOwnItems(world)));
  return own;
}

function createOwnItems(world, table = null) {
  // The Bank action requires this file's users; loaded here, when first needed, to keep that one-way.
  const { createBankAction } = require("./actions/Bank.PlayerBots");
  let shops = table;
  const shopTable = () => (shops ??= loadOffers());
  const states = new WeakMap();
  const stateFor = (player) => {
    let state = states.get(player);
    if (!state) states.set(player, (state = { trip: null, plan: null, avoid: new Map(), tidyAfter: 0, attempts: 0 }));
    return state;
  };
  const routeExists = world.routes?.canReachSpot ?? canReachSpot;

  const bankAction = createBankAction({
    until: { inventoryFull: false },
    // At the booth, with the bank open: put away what is not wanted, take out what is.
    atBank(player) {
      const plan = stateFor(player).plan;
      if (!plan) return true;
      if (plan.keep) depositAllExcept(player, plan.keep);
      const list = typeof plan.withdraw === "function" ? plan.withdraw(player) : plan.withdraw ?? [];
      for (const entry of list) withdraw(player, entry.itemId, entry.amount);
      plan.done = true;
      world.log?.("bot_own_items_banked", { username: player.getUsername?.(), free: player.getInventory().getFreeSlots(), withdrew: list.map((entry) => entry.itemId) });
      closeInterface(player);
      return true;
    },
  }, world);

  /** What one of an item costs at a shop's normal stock (the cheapest keeper's), or null when no shop sells it. */
  function offer(itemId) {
    const list = shopTable().offers.get(itemId);
    if (!list?.length) return null;
    return list.reduce((best, entry) => (entry.price < best.price ? entry : best));
  }

  /** Remembers what the bot is short of coins for; while it is, it sells what it gathers. */
  function wish(state, itemId, cost, nowMs = Date.now()) {
    if (state) state.ownWish = { itemId, cost, at: nowMs };
  }

  function wishing(player, state, nowMs = Date.now()) {
    const want = state?.ownWish;
    if (!want) return false;
    if (nowMs - want.at > WISH_MS || purse(player) >= want.cost) {
      state.ownWish = null;
      return false;
    }
    return true;
  }

  function cooldown(ctx, need) {
    if (need?.optional !== true && ctx.frame) ctx.frame.cooldownMs = Math.max(ctx.frame.cooldownMs ?? 0, WANT_COOLDOWN_MS);
  }

  function endTrip(ctx, bot) {
    if (bot.trip?.kind === "bank") bankAction.stop(ctx);
    if (bot.trip) {
      clearMovementRequest(ctx.player);
      closeInterface(ctx.player);
    }
    bot.trip = null;
    bot.plan = null;
  }

  function startBank(bot, need, plan) {
    world.log?.("bot_own_items_bank_trip", { for: need.itemId ?? null });
    bot.plan = plan;
    bot.trip = { kind: "bank", for: need.itemId ?? null, movedAt: 0, position: null };
  }

  /** The keepers who stock `itemId`, nearest first, that this bot has not given up on. */
  function nearestShop(player, bot, itemId, nowMs) {
    const { keepers, offers } = shopTable();
    const index = npcClustersFor(world, "ownItems:keepers", (definition) => {
      const npcId = definition?.getId?.();
      return keepers.has(npcId) ? `keeper:${npcId}` : null;
    });
    const keys = (offers.get(itemId) ?? []).flatMap((entry) => entry.npcIds.map((npcId) => `keeper:${npcId}`));
    const loc = player.getLocation();
    const near = nearestClusters(index, keys, { x: loc.getX(), y: loc.getY(), z: loc.getZ() })
      .filter((cluster) => (bot.avoid.get(cluster.key) ?? 0) <= nowMs).slice(0, NEAREST_SHOPS);
    for (const cluster of near) {
      const reach = routeExists(player, cluster, nowMs);
      if (reach === undefined) return undefined;
      if (reach === true) return cluster;
      bot.avoid.set(cluster.key, nowMs + AVOID_SHOP_MS);
    }
    return null;
  }

  /** Buys at the counter. Returns how many came. */
  function buy(player, shopId, itemId, amount) {
    const { ShopManager } = world.core;
    if (!ShopManager.open(player, shopId, true)) return 0;
    const before = carried(player, itemId);
    const stock = ShopManager.getOpenShop(player)?.stock ?? [];
    const slot = stock.findIndex((entry) => entry.itemId === itemId);
    const entry = stock[slot];
    if (entry && entry.amount > 0) {
      const affordable = Math.floor(carried(player, COINS) / Math.max(1, entry.price));
      const count = Math.min(amount, entry.amount, affordable);
      if (count > 0) {
        ShopManager.handleItemContainerAction(player, {
          kind: "buy_sell", containerId: ShopManager.ITEMS_INTERFACE_ID, slot, itemId, amount: count,
        });
      }
    }
    ShopManager.close(player);
    closeInterface(player);
    return carried(player, itemId) - before;
  }

  function shopStep(ctx, bot, need) {
    const { player, nowMs } = ctx;
    const trip = bot.trip;
    const { keepers, offers } = shopTable();
    const stocking = new Map((offers.get(need.itemId) ?? []).flatMap((entry) => entry.npcIds.map((npcId) => [npcId, entry.shopId])));
    const loc = player.getLocation();
    const position = `${loc.getX()},${loc.getY()},${loc.getZ()}`;
    if (position !== trip.position) {
      trip.position = position;
      trip.movedAt = nowMs;
    } else if (nowMs - trip.movedAt > STUCK_MS) {
      if (trip.cluster) bot.avoid.set(trip.cluster.key, nowMs + AVOID_SHOP_MS);
      return "failed";
    }
    const keeper = world.core.World.getNpcsNear(loc, 16, player.getPrivateArea?.() ?? null)
      .find((npc) => stocking.has(npc?.getDefinition?.()?.getId?.()) && npc.isRegistered?.() !== false);
    const at = keeper?.getLocation();
    if (at && at.getZ() === loc.getZ() && Math.max(Math.abs(at.getX() - loc.getX()), Math.abs(at.getY() - loc.getY())) <= TRADE_RANGE) {
      const shopId = stocking.get(keeper.getDefinition().getId()) ?? keepers.get(keeper.getDefinition().getId());
      const came = buy(player, shopId, need.itemId, trip.amount);
      world.log?.("bot_own_items_bought", { username: player.getUsername?.(), item: need.itemId, amount: came, shop: shopId });
      if (came <= 0) {
        // Sold out, or dearer than reckoned: another keeper next time.
        if (trip.cluster) bot.avoid.set(trip.cluster.key, nowMs + AVOID_SHOP_MS);
        return "failed";
      }
      return "success";
    }
    if (player.getMovementQueue().size() > 0 || peekMovementRequest(player)) return "running";
    if (!at && !trip.cluster) {
      const cluster = nearestShop(player, bot, need.itemId, nowMs);
      if (cluster === undefined) {
        // The route planner's budget for this tick is spent: asked again next tick, not a stall.
        trip.movedAt = nowMs;
        return "running";
      }
      if (!cluster) return "failed";
      trip.cluster = cluster;
    }
    const goal = at ? { x: at.getX(), y: at.getY(), z: at.getZ() } : trip.cluster;
    requestMovement(player, goal.x, goal.y, { nowMs, z: goal.z, reason: "brain_own_items_shop", basicPather: true });
    return "running";
  }

  function bankStep(ctx, bot) {
    const { player, nowMs } = ctx;
    const trip = bot.trip;
    const loc = player.getLocation();
    const position = `${loc.getX()},${loc.getY()},${loc.getZ()}`;
    if (position !== trip.position) {
      trip.position = position;
      trip.movedAt = nowMs;
    } else if (trip.movedAt && nowMs - trip.movedAt > STUCK_MS * 3) {
      return "failed";
    }
    trip.movedAt ||= nowMs;
    return bankAction.update(ctx);
  }

  /**
   * Gets `need.itemId` into the backpack: { itemId, min = 1 (enough to go on), amount = min (what
   * to aim for), worn (true: wearing it counts), buy (false: never from a shop), keep (an item
   * id -> boolean: at the bank, everything else is left there), optional (true: a failure does
   * not hold the activity back) }. "success", "running" (on its way) or "failed".
   */
  function fetch(ctx, need) {
    const { player, nowMs } = ctx;
    const bot = stateFor(player);
    const min = Math.max(1, Math.floor(need.min ?? 1));
    const amount = Math.max(min, Math.floor(need.amount ?? min));
    const have = () => carried(player, need.itemId) + (need.worn === true && worn(player, need.itemId) ? min : 0);
    if (have() >= min) {
      // Another errand of the bot's (emptying its backpack at the bank) is none of this one's business.
      if (bot.trip?.for === need.itemId) endTrip(ctx, bot);
      bot.attempts = 0;
      return "success";
    }
    if (bot.trip && bot.trip.for !== need.itemId) endTrip(ctx, bot);
    if (!bot.trip) {
      // Each leg (the bank for the item or the coins, then the shop) is one attempt.
      if (bot.attempts++ >= 4) {
        bot.attempts = 0;
        cooldown(ctx, need);
        return "failed";
      }
      if (banked(player, need.itemId) > 0) {
        startBank(bot, need, { keep: need.keep ?? null, withdraw: [{ itemId: need.itemId, amount: amount - carried(player, need.itemId) }] });
      } else {
        const cheapest = need.buy === false ? null : offer(need.itemId);
        const short = min - carried(player, need.itemId);
        if (!cheapest || purse(player) < cheapest.price * short) {
          if (cheapest) wish(ctx.state, need.itemId, cheapest.price * short, nowMs);
          bot.attempts = 0;
          cooldown(ctx, need);
          return "failed";
        }
        const wanted = cheapest.price * (amount - carried(player, need.itemId));
        if (carried(player, COINS) < Math.min(wanted, purse(player)) && banked(player, COINS) > 0) {
          startBank(bot, need, { keep: need.keep ?? null, withdraw: (who) => [{ itemId: COINS, amount: banked(who, COINS) }] });
        } else {
          bot.trip = { kind: "shop", for: need.itemId, amount: amount - carried(player, need.itemId), movedAt: nowMs, position: null, cluster: null };
        }
      }
    }
    const result = bot.trip.kind === "bank" ? bankStep(ctx, bot) : shopStep(ctx, bot, need);
    if (result === "running") return "running";
    endTrip(ctx, bot);
    if (result === "failed") {
      bot.attempts = 0;
      cooldown(ctx, need);
      return "failed";
    }
    // Back from the bank with the item or the coins, or from the shop: looked at again next tick.
    return have() >= min ? ((bot.attempts = 0), "success") : "running";
  }

  /**
   * A walk to the bank on the bot's own business: `plan` is { keep (item id -> boolean; the rest
   * is deposited), withdraw ([{ itemId, amount }] or a function of the player, read at the booth) }.
   * `key` names the errand, so one call after another is the same trip.
   */
  function bankTrip(ctx, key, plan) {
    const bot = stateFor(ctx.player);
    if (bot.trip && bot.trip.for !== key) endTrip(ctx, bot);
    if (!bot.trip) startBank(bot, { itemId: key }, plan);
    const result = bankStep(ctx, bot);
    if (result === "running") return "running";
    endTrip(ctx, bot);
    return result;
  }

  /**
   * Empties the backpack of what the work at hand has no use for, at the bank, when there is
   * enough of it to matter. `keep`: item id -> boolean. A bank too far away is tried again later;
   * the work goes on with a fuller backpack.
   */
  function tidy(ctx, keep) {
    const { player, nowMs } = ctx;
    const bot = stateFor(player);
    const tidying = bot.trip?.for === "tidy";
    if (!tidying && (nowMs < bot.tidyAfter || clutter(player, keep) < CLUTTER_SLOTS)) return "success";
    const result = bankTrip(ctx, "tidy", { keep });
    if (result === "failed") bot.tidyAfter = nowMs + TIDY_RETRY_MS;
    return result === "running" ? "running" : "success";
  }

  /** Drops whatever errand the bot was on (its activity is being stopped). */
  function stop(ctx) {
    const bot = states.get(ctx?.player);
    if (bot) {
      endTrip(ctx, bot);
      bot.attempts = 0;
    }
  }

  return { fetch, tidy, bankTrip, stop, offer, wish, wishing, busy: (player) => !!states.get(player)?.trip };
}

/** What `keep` tests are made of: the always-kept items and any ids or tests given. */
function keeping(...kept) {
  const ids = new Set(ALWAYS_KEPT);
  const tests = [];
  for (const entry of kept.flat()) {
    if (typeof entry === "function") tests.push(entry);
    else if (Number.isInteger(entry)) ids.add(entry);
  }
  return (itemId) => ids.has(itemId) || tests.some((test) => test(itemId));
}

module.exports = {
  ALWAYS_KEPT,
  EARN_CONFIG,
  EARNS_ATTRIBUTE,
  WANT_COOLDOWN_MS,
  banked,
  bankedWhere,
  carried,
  clutter,
  createOwnItems,
  earnsOwnItems,
  keeping,
  loadOffers,
  ownItemsFor,
  purse,
  setEarnsOwnItems,
  worldEarns,
  worn,
};
