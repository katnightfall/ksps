"use strict";

/**
 * Ours. A levelling bot's trip to the Grand Exchange (brain/BotExchange has the book).
 *
 * It goes when it has something to do there: goods worth selling in its bank, something due to
 * it from last time, or coins enough to bid for what it is saving for. It walks to Varrock, and
 * at the exchange:
 *
 *   collects   the coins for what sold and the items it bought (to its bank)
 *   sells      what it gathered: logs, ore, bars, fish, all but a stock of food for itself
 *   bids       for what it could not afford in a shop, at the going price, coins down
 *
 * Then it goes back to work, and does not come again for a while. A bot that is handed its
 * kit (any but the levelling crowd's) has no business here.
 *
 * JSON: { "type": "exchange" }
 */
const fs = require("node:fs");
const path = require("node:path");
const { ItemDefinition } = require("../../../../src/main/typescript/elvarg/game/definition/ItemDefinition");
const { ItemIdentifiers } = require("../../../../src/main/typescript/elvarg/util/ItemIdentifiers");
const { Bank } = require("../../../../src/main/typescript/elvarg/game/model/container/impl/Bank");
const { playerState } = require("../ActionState.PlayerBots");
const { requestMovement, peekMovementRequest } = require("../../behaviours/navigation/Navigation.PlayerBots");
const { banked, carried, earnsOwnItems, purse, worn } = require("../OwnItems.PlayerBots");
const { createBotExchange } = require("../BotExchange.PlayerBots");
const { isFoodItem } = require("../../../items/Food.plugin");

const COINS = ItemIdentifiers.COINS;
// Varrock's Grand Exchange, and how near its middle counts as being there.
const EXCHANGE = Object.freeze({ x: 3164, y: 3486, z: 0 });
const ARRIVE = 7;
// Goods worth less than this in all are not worth the walk.
const WORTH_THE_WALK = 150;
// Food kept back for the bot's own fights.
const FOOD_KEPT = 30;
// Stackable things (arrows, runes, feathers) are bid for this many at a time, or what the coins allow.
const STACK_BID = 100;
const STUCK_MS = 60_000;
// Nothing to do there: looked at again after this long.
const IDLE_COOLDOWN_MS = 20 * 60_000;
// After a visit the next is this far off.
const NEXT_VISIT_MS = [25 * 60_000, 45 * 60_000];
const PLAYER_FILL_MS = 5_000;
const PLAYER_OFFERS_ATTRIBUTE = "grand-exchange-offers";

const unNote = (itemId) => ItemDefinition.forId(itemId).unNote();
const guide = {
  buy: (itemId) => Math.max(1, Math.floor(ItemDefinition.forId(unNote(itemId)).getGrandExchangeValue()) || 1),
  sell: (itemId) => {
    const definition = ItemDefinition.forId(unNote(itemId));
    return Math.max(1, Math.floor(definition.getGrandExchangeSellValue?.() ?? definition.getGrandExchangeValue()) || 1);
  },
};
const exchangeable = (itemId) => Number.isInteger(itemId) && itemId > 0 && ItemDefinition.forId(unNote(itemId)).isTradeable() === true;

/** What the bots gather and make, from the activities' own lists: the goods they sell. */
function loadProduce(file = path.join(process.cwd(), "data", "definitions", "bot-activities.json")) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const names = new Set();
  for (const activity of raw.activities ?? []) {
    const fields = activity.fields ?? {};
    for (const value of [fields.log, fields.resources, fields.smelted, fields.cooked, fields.dishes].flat()) {
      if (typeof value === "string") names.add(value.trim().toUpperCase().replace(/[\s-]+/g, "_"));
    }
  }
  return [...names].map((name) => ItemIdentifiers[name]).filter((itemId) => Number.isInteger(itemId) && exchangeable(itemId));
}

let shared = null;
/** The world's one book. */
function botExchange() {
  return (shared ??= createBotExchange({ file: path.join(process.cwd(), "data", "saves", "bot-exchange.json"), guide }));
}

/**
 * A player's offer as it is placed (the exchange's "ge:offer-placing"): when what the bots have
 * up, or bid for, covers all of it, it trades with them, at once.
 *
 * The bots are paid for their goods (or handed what they bid for) here and now, so the offer is
 * final from here (`met`: the exchange completes it rather than aborting it). An offer they
 * cover only in part takes nothing of theirs: an offer fills whole or is aborted whole, and a
 * part sold to it would be paid for and then given back with the rest.
 */
function meetOffer(exchange, offer, nowMs = Date.now()) {
  const itemId = unNote(offer.itemId);
  const price = Number(offer.price) || 0;
  const quantity = Number(offer.quantity) || 0;
  if (!(price > 0) || !(quantity > 0)) return 0;
  exchange.settle();
  const there = offer.sell ? exchange.wanted(itemId, price) : exchange.onSale(itemId, price);
  if (there < quantity) return 0;
  if (offer.sell) exchange.sellToBots(itemId, quantity, price);
  else exchange.buyFromBots(itemId, quantity, price);
  offer.completesAt = nowMs + PLAYER_FILL_MS;
  offer.met = true;
  return quantity;
}

function createExchangeAction(spec, world, exchange = botExchange(), goods = null) {
  // Read when first needed: the activities are compiled before the item definitions are loaded.
  let produce = goods;
  const produceList = () => (produce ??= loadProduce());
  const stateFor = (player) => playerState(action, player, () => ({ position: null, movedAt: 0, moved: false }));
  const name = (player) => String(player.getUsername()).toLowerCase();

  /** How many of an item the bot would sell: all it has, less the food it keeps for itself. */
  function forSale(player) {
    let foodLeft = FOOD_KEPT;
    const goods = [];
    for (const itemId of produceList()) {
      let amount = banked(player, itemId) + carried(player, itemId);
      if (isFoodItem(itemId)) {
        const kept = Math.min(amount, foodLeft);
        foodLeft -= kept;
        amount -= kept;
      }
      if (amount > 0) goods.push({ itemId, amount, price: guide.sell(itemId) });
    }
    return goods;
  }

  /** What it would bid for: the thing it is saving for, when it can pay the going price. */
  function bid(player, state) {
    const itemId = state?.ownWish?.itemId;
    if (!exchangeable(itemId) || carried(player, itemId) > 0 || worn(player, itemId) || banked(player, itemId) > 0) return null;
    if (exchange.bids(name(player), itemId)) return null;
    const price = guide.buy(itemId);
    const amount = ItemDefinition.forId(itemId).isStackable?.() === true ? Math.min(STACK_BID, Math.floor(purse(player) / price)) : 1;
    return amount >= 1 && purse(player) >= price * amount ? { itemId, amount, price } : null;
  }

  const worthGoing = (player, state) => exchange.hasDue(name(player)) || bid(player, state) !== null ||
    forSale(player).reduce((sum, entry) => sum + entry.amount * entry.price, 0) >= WORTH_THE_WALK;

  function takeFrom(player, itemId, amount) {
    let left = amount;
    const fromPack = Math.min(left, carried(player, itemId));
    if (fromPack > 0) {
      player.getInventory().deleteNumber(itemId, fromPack);
      left -= fromPack;
    }
    for (let tab = 0; tab < Bank.TOTAL_BANK_TABS - 1 && left > 0; tab++) {
      const bank = player.getBank(tab);
      const there = Math.min(left, bank?.getAmount?.(itemId) ?? 0);
      if (there > 0) {
        bank.deleteNumber(itemId, there);
        left -= there;
      }
    }
    return amount - left;
  }

  /** Players' offers already waiting: one a bot's new goods or bid covers whole is filled now. */
  function meetWaiting(itemId, selling) {
    const GrandExchange = require("../../../interface/GrandExchange.plugin");
    for (const player of world.core.World.getPlayers()) {
      if (!player || player.isPlayerBot?.() === true) continue;
      for (const [slot, offer] of Object.entries(player.getAttribute?.(PLAYER_OFFERS_ATTRIBUTE) ?? {})) {
        // A bot selling meets players buying, and the other way round. An offer the bots have met already has
        // traded (it is only waiting out its few seconds): another bot's goods are not sold to it a second time.
        if (!offer || offer.finished || offer.aborted || offer.met === true || Boolean(offer.sell) === selling || unNote(offer.itemId) !== itemId) continue;
        const price = Number(offer.price) || 0;
        const there = selling ? exchange.onSale(itemId, price) : exchange.wanted(itemId, price);
        if (there < offer.quantity) continue;
        if (selling) exchange.buyFromBots(itemId, offer.quantity, price);
        else exchange.sellToBots(itemId, offer.quantity, price);
        GrandExchange.fillBy?.(player, Number(slot), Date.now() + PLAYER_FILL_MS);
      }
    }
  }

  function trade(ctx) {
    const { player, state } = ctx;
    const who = name(player);
    exchange.settle();
    const dues = exchange.collect(who);
    // To its backpack when there is a place for them (a coin stack, or a free slot), else its bank.
    if (dues.coins > 0) {
      const inventory = player.getInventory();
      (carried(player, COINS) > 0 || inventory.getFreeSlots() > 0 ? inventory : player.getBank(0)).adds(COINS, dues.coins);
    }
    for (const item of dues.items) player.getBank(0).adds(item.itemId, item.amount);
    const sold = [];
    for (const entry of forSale(player)) {
      const amount = takeFrom(player, entry.itemId, entry.amount);
      if (amount <= 0) continue;
      exchange.list(who, entry.itemId, amount, entry.price);
      sold.push(entry.itemId);
      meetWaiting(entry.itemId, true);
    }
    const wanted = bid(player, state);
    if (wanted && takeFrom(player, COINS, wanted.amount * wanted.price) === wanted.amount * wanted.price) {
      exchange.order(who, wanted.itemId, wanted.amount, wanted.price);
      meetWaiting(wanted.itemId, false);
    }
    world.log?.("bot_exchange_visit", {
      username: player.getUsername?.(), collected: dues.coins, got: dues.items.map((item) => item.itemId), listed: sold, bid: wanted?.itemId ?? null,
    });
  }

  const action = {
    id: "exchange",
    update(ctx) {
      const { player, state, nowMs } = ctx;
      const bot = stateFor(player);
      if (!earnsOwnItems(player) || !worthGoing(player, state)) {
        if (ctx.frame) ctx.frame.cooldownMs = Math.max(ctx.frame.cooldownMs ?? 0, IDLE_COOLDOWN_MS);
        return "failed";
      }
      const loc = player.getLocation();
      const position = `${loc.getX()},${loc.getY()},${loc.getZ()}`;
      if (position !== bot.position) {
        bot.position = position;
        bot.movedAt = nowMs;
        bot.moved = true;
      } else if (bot.movedAt && nowMs - bot.movedAt > STUCK_MS) {
        if (ctx.frame) ctx.frame.cooldownMs = Math.max(ctx.frame.cooldownMs ?? 0, IDLE_COOLDOWN_MS);
        return "failed";
      }
      if (loc.getZ() === EXCHANGE.z && Math.max(Math.abs(loc.getX() - EXCHANGE.x), Math.abs(loc.getY() - EXCHANGE.y)) <= ARRIVE) {
        trade(ctx);
        // Back to work; the exchange is not looked at again for a while.
        const [least, most] = NEXT_VISIT_MS;
        ctx.brain?.registry?.blockActivity?.(player, ctx.activity?.id ?? "grand_exchange", nowMs, least + Math.random() * (most - least));
        return "success";
      }
      if (player.getMovementQueue().size() === 0 && !peekMovementRequest(player)) {
        requestMovement(player, EXCHANGE.x, EXCHANGE.y, { nowMs, z: EXCHANGE.z, reason: "brain_exchange_walk", basicPather: true });
      }
      return "running";
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      bot.position = null;
      bot.movedAt = 0;
    },
    madeProgress(ctx) {
      const bot = stateFor(ctx.player);
      const moved = bot.moved;
      bot.moved = false;
      return moved;
    },
    describe() {
      return "walking to the Grand Exchange";
    },
  };
  return action;
}

/**
 * Called once as the bots' plugin starts: players' offers meet the bots' as they are placed,
 * and the market takes what waited too long even when no bot is at the exchange.
 */
function attachBotExchange(api) {
  const exchange = botExchange();
  api.onCustomEvent?.("ge:offer-placing", ({ player, offer }) => {
    if (!player || player.isPlayerBot?.() === true || !offer) return;
    meetOffer(exchange, offer);
  });
  setInterval(() => exchange.settle(), 60_000).unref();
  api.onServerShutdown?.(() => exchange.flush());
  return exchange;
}

module.exports = { EXCHANGE, attachBotExchange, botExchange, createExchangeAction, guide, loadProduce, meetOffer };
