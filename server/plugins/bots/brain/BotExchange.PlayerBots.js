"use strict";

/**
 * Ours. The bots' side of the Grand Exchange.
 *
 * The exchange (plugins/interface/GrandExchange.plugin.js) is a market that answers every offer
 * by itself, after a wait, at the going price. The levelling bots (brain/OwnItems) trade on it
 * as people do, and their offers are real ones, met before the market's:
 *
 *   a bot sells   what it gathered and banked (logs, ore, bars, fish) is put up at the going
 *                 price. A player's buy offer at that price or better is filled from it, at
 *                 once, and the bot is paid; what nobody bought after a while the market takes.
 *   a bot buys    what it is saving for (the tool, weapon or arrows it could not pay a shop
 *                 for) is bid for at the going price, coins down. A player's sell offer at
 *                 that price or lower is filled by it, at once; if no player sells, the market
 *                 does after a while.
 *
 * The book is what the bots have up: kept in data/saves/bot-exchange.json, so it survives a
 * restart and is set aside by a fresh start with the rest. What is due to a bot (coins for what
 * sold, items it bought) waits there until it is next at the exchange.
 */
const fs = require("node:fs");
const path = require("node:path");

// A bot's goods wait this long for a player before the market takes them.
const LISTING_MS = 20 * 60_000;
// A bot's bid waits this long for a player to sell to it before the market does.
const ORDER_MS = 10 * 60_000;
const WRITE_DELAY_MS = 5_000;

/**
 * The book. `guide` gives the going prices ({ buy(itemId), sell(itemId) }); `file` is where it
 * is kept (null: nowhere). Every call that depends on the time takes it.
 */
function createBotExchange({ file = null, guide, now = () => Date.now() } = {}) {
  /** What bots have up for sale: { bot, itemId, remaining, price, at }. */
  let listings = [];
  /** What bots bid for, coins already paid in: { bot, itemId, remaining, price, at }. */
  let orders = [];
  /** What is due to each bot: name -> { coins, items: { itemId: amount } }. */
  let dues = {};
  let writeTimer = null;

  try {
    const kept = file ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    if (kept) {
      listings = Array.isArray(kept.listings) ? kept.listings : [];
      orders = Array.isArray(kept.orders) ? kept.orders : [];
      dues = kept.dues && typeof kept.dues === "object" ? kept.dues : {};
    }
  } catch {}

  function write() {
    writeTimer = null;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ listings, orders, dues }));
    } catch {}
  }
  function changed() {
    if (file && !writeTimer) {
      writeTimer = setTimeout(write, WRITE_DELAY_MS);
      writeTimer.unref?.();
    }
  }

  const due = (bot) => (dues[bot] ??= { coins: 0, items: {} });
  const pay = (bot, coins) => { due(bot).coins += coins; };
  const hand = (bot, itemId, amount) => { due(bot).items[itemId] = (due(bot).items[itemId] ?? 0) + amount; };

  /** Fills `quantity` from entries (oldest first) that `fits`, calling `each(entry, amount)`. Returns how many. */
  function take(entries, fits, quantity, each) {
    let left = quantity;
    for (const entry of [...entries].sort((a, b) => a.at - b.at)) {
      if (left <= 0) break;
      if (!fits(entry)) continue;
      const amount = Math.min(left, entry.remaining);
      entry.remaining -= amount;
      left -= amount;
      each(entry, amount);
    }
    return quantity - left;
  }
  const prune = () => {
    listings = listings.filter((entry) => entry.remaining > 0);
    orders = orders.filter((entry) => entry.remaining > 0);
    changed();
  };

  return {
    /** A bot puts goods up for sale (they have left its bank). */
    list(bot, itemId, amount, price) {
      if (!(amount > 0) || !(price > 0)) return;
      listings.push({ bot, itemId, remaining: Math.floor(amount), price: Math.floor(price), at: now() });
      changed();
    },

    /** A bot bids for an item (the coins, amount x price, have left its purse). */
    order(bot, itemId, amount, price) {
      if (!(amount > 0) || !(price > 0)) return;
      orders.push({ bot, itemId, remaining: Math.floor(amount), price: Math.floor(price), at: now() });
      changed();
    },

    /** How many of an item bots have up at `price` or less. */
    onSale(itemId, price) {
      return listings.filter((entry) => entry.itemId === itemId && entry.price <= price).reduce((sum, entry) => sum + entry.remaining, 0);
    },

    /** How many of an item bots bid `price` or more for. */
    wanted(itemId, price) {
      return orders.filter((entry) => entry.itemId === itemId && entry.price >= price).reduce((sum, entry) => sum + entry.remaining, 0);
    },

    /** A buyer takes up to `quantity` of what bots have up at `price` or less; the bots are paid their own price. */
    buyFromBots(itemId, quantity, price) {
      const taken = take(listings, (entry) => entry.itemId === itemId && entry.price <= price, quantity, (entry, amount) => pay(entry.bot, amount * entry.price));
      if (taken) prune();
      return taken;
    },

    /** A seller fills up to `quantity` of what bots bid `price` or more for; the bots get the items. */
    sellToBots(itemId, quantity, price) {
      const taken = take(orders, (entry) => entry.itemId === itemId && entry.price >= price, quantity, (entry, amount) => hand(entry.bot, itemId, amount));
      if (taken) prune();
      return taken;
    },

    /**
     * The market's turn: goods no player bought in time are sold to it at the going price, and
     * bids no player met are filled by it when they reach the going price (the difference comes
     * back, as it does to a player). Returns how many entries it settled.
     */
    settle() {
      const at = now();
      let settled = 0;
      for (const entry of listings) {
        if (at - entry.at < LISTING_MS) continue;
        pay(entry.bot, entry.remaining * Math.max(1, guide.sell(entry.itemId)));
        entry.remaining = 0;
        settled++;
      }
      for (const entry of orders) {
        if (at - entry.at < ORDER_MS) continue;
        const going = Math.max(1, guide.buy(entry.itemId));
        if (entry.price >= going) {
          hand(entry.bot, entry.itemId, entry.remaining);
          pay(entry.bot, entry.remaining * (entry.price - going));
        } else {
          // Bid too low for the market: the coins come back.
          pay(entry.bot, entry.remaining * entry.price);
        }
        entry.remaining = 0;
        settled++;
      }
      if (settled) prune();
      return settled;
    },

    /** Whether anything waits for this bot at the exchange. */
    hasDue(bot) {
      const waiting = dues[bot];
      return !!waiting && (waiting.coins > 0 || Object.keys(waiting.items).length > 0);
    },

    /** What is due to a bot, handed over: { coins, items: [{ itemId, amount }] }. */
    collect(bot) {
      const waiting = dues[bot];
      if (!waiting) return { coins: 0, items: [] };
      delete dues[bot];
      changed();
      return { coins: waiting.coins, items: Object.entries(waiting.items).map(([itemId, amount]) => ({ itemId: Number(itemId), amount })) };
    },

    /** Whether the bot already bids for an item. */
    bids(bot, itemId) {
      return orders.some((entry) => entry.bot === bot && entry.itemId === itemId) || (dues[bot]?.items?.[itemId] ?? 0) > 0;
    },

    /** The book as it stands, for the tests and the log. */
    book: () => ({ listings: listings.map((entry) => ({ ...entry })), orders: orders.map((entry) => ({ ...entry })), dues: JSON.parse(JSON.stringify(dues)) }),
    flush: write,
  };
}

module.exports = { createBotExchange, LISTING_MS, ORDER_MS };
