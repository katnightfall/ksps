// Ours. Run after `yarn build`: node --test tests/bot-exchange.test.cjs
// The levelling bots on the Grand Exchange (plugins/bots/brain/BotExchange.PlayerBots.js and
// actions/Exchange.PlayerBots.js): they sell what they gather and bid for what they save for,
// and a player's offer meets theirs before the market's.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { before, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const OwnItems = require("../plugins/bots/brain/OwnItems.PlayerBots");
const { createBotExchange, LISTING_MS, ORDER_MS } = require("../plugins/bots/brain/BotExchange.PlayerBots");
const Exchange = require("../plugins/bots/brain/actions/Exchange.PlayerBots");

let core;
let Items;
let names = 0;
const LOGS = 1511;
const GUIDE = { buy: () => 100, sell: () => 90 };

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  require("../plugins/items/ItemDefinitionLoader.plugin").register({ log() {}, onPlayerLogin() {}, registerContentEndpoint() {} });
  core = PluginManager.getCoreApi();
  Items = core.ItemIdentifiers;
  require("../plugins/items/Food.plugin").register(PluginManager.createApi("BotExchangeTest"));
});

function book(clock = { now: 1_000_000 }) {
  return { clock, exchange: createBotExchange({ guide: GUIDE, now: () => clock.now }) };
}

test("what a bot puts up is sold to a buyer at the bot's price, oldest goods first, and the bot is paid", () => {
  const { exchange, clock } = book();
  exchange.list("sitebot1", LOGS, 20, 90);
  clock.now += 1000;
  exchange.list("sitebot2", LOGS, 20, 95);
  assert.equal(exchange.onSale(LOGS, 90), 20);
  assert.equal(exchange.onSale(LOGS, 100), 40);
  assert.equal(exchange.onSale(LOGS, 80), 0, "nobody sells that low");
  assert.equal(exchange.buyFromBots(LOGS, 25, 100), 25);
  assert.deepEqual(exchange.collect("sitebot1"), { coins: 20 * 90, items: [] }, "all of the older goods");
  assert.deepEqual(exchange.collect("sitebot2"), { coins: 5 * 95, items: [] });
  assert.equal(exchange.onSale(LOGS, 100), 15);
  assert.deepEqual(exchange.collect("sitebot1"), { coins: 0, items: [] }, "paid once");
});

test("goods no player bought in time are taken by the market, at the going price", () => {
  const { exchange, clock } = book();
  exchange.list("sitebot1", LOGS, 10, 95);
  clock.now += LISTING_MS - 1;
  assert.equal(exchange.settle(), 0, "still up for players");
  assert.equal(exchange.hasDue("sitebot1"), false);
  clock.now += 2;
  assert.equal(exchange.settle(), 1);
  assert.deepEqual(exchange.collect("sitebot1"), { coins: 10 * 90, items: [] });
  assert.equal(exchange.onSale(LOGS, 1000), 0);
});

test("a bot's bid is filled by a player selling at its price or lower; else by the market, later", () => {
  const { exchange, clock } = book();
  exchange.order("sitebot1", Items.IRON_AXE, 1, 100);
  assert.equal(exchange.bids("sitebot1", Items.IRON_AXE), true);
  assert.equal(exchange.wanted(Items.IRON_AXE, 100), 1);
  assert.equal(exchange.wanted(Items.IRON_AXE, 101), 0, "it does not pay more than it bid");
  assert.equal(exchange.sellToBots(Items.IRON_AXE, 5, 80), 1, "one bid, one axe");
  assert.deepEqual(exchange.collect("sitebot1"), { coins: 0, items: [{ itemId: Items.IRON_AXE, amount: 1 }] });
  // No player sells: the market does after a while, and what the bid was over the price comes back.
  exchange.order("sitebot2", Items.IRON_AXE, 2, 130);
  clock.now += ORDER_MS + 1;
  exchange.settle();
  assert.deepEqual(exchange.collect("sitebot2"), { coins: 2 * 30, items: [{ itemId: Items.IRON_AXE, amount: 2 }] });
  // A bid under the going price buys nothing: the coins come back.
  exchange.order("sitebot3", Items.IRON_AXE, 1, 60);
  clock.now += ORDER_MS + 1;
  exchange.settle();
  assert.deepEqual(exchange.collect("sitebot3"), { coins: 60, items: [] });
});

test("the book is kept through a restart", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-exchange-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "bot-exchange.json");
  const first = createBotExchange({ file, guide: GUIDE });
  first.list("sitebot1", LOGS, 7, 90);
  first.order("sitebot1", Items.IRON_AXE, 1, 100);
  first.buyFromBots(LOGS, 2, 90);
  first.flush();
  const second = createBotExchange({ file, guide: GUIDE });
  assert.equal(second.onSale(LOGS, 90), 5);
  assert.equal(second.wanted(Items.IRON_AXE, 100), 1);
  assert.deepEqual(second.collect("sitebot1"), { coins: 180, items: [] });
});

test("a player's buy offer the bots cover fills at once and is final; one they cover only in part is left to the market", () => {
  const { exchange } = book();
  exchange.list("sitebot1", LOGS, 30, 90);
  const now = 5_000_000;
  const whole = { itemId: LOGS, sell: false, quantity: 10, price: 100, completesAt: now + 600_000 };
  assert.equal(Exchange.meetOffer(exchange, whole, now), 10);
  assert.equal(whole.completesAt, now + 5000, "from the bots, at once");
  assert.equal(whole.met, true, "it has traded: the exchange no longer aborts it (tests/bot-exchange-abort.test.cjs)");
  assert.equal(exchange.onSale(LOGS, 100), 20);
  // An offer fills whole or is aborted whole, so a part sold to it could be paid for and then given back.
  const part = { itemId: LOGS, sell: false, quantity: 80, price: 100, completesAt: now + 800_000 };
  assert.equal(Exchange.meetOffer(exchange, part, now), 0);
  assert.equal(part.completesAt, now + 800_000, "the market's wait, untouched");
  assert.equal(part.met, undefined);
  assert.equal(exchange.onSale(LOGS, 100), 20, "the bots keep their logs");
  assert.deepEqual(exchange.collect("sitebot1"), { coins: 10 * 90, items: [] });
});

test("an offer below the bots' price takes nothing, and one the market would never fill only trades whole", () => {
  const { exchange } = book();
  exchange.list("sitebot1", LOGS, 10, 90);
  const cheap = { itemId: LOGS, sell: false, quantity: 5, price: 50, completesAt: null };
  assert.equal(Exchange.meetOffer(exchange, cheap, 1000), 0);
  assert.equal(cheap.completesAt, null);
  const tooMany = { itemId: LOGS, sell: false, quantity: 50, price: 95, completesAt: null };
  assert.equal(Exchange.meetOffer(exchange, tooMany, 1000), 0, "the rest would never come: the bots keep their logs");
  assert.equal(exchange.onSale(LOGS, 95), 10);
  const fits = { itemId: LOGS, sell: false, quantity: 10, price: 95, completesAt: null };
  assert.equal(Exchange.meetOffer(exchange, fits, 1000), 10);
  assert.equal(fits.completesAt, 6000);
});

test("a player selling what a bot bids for sells to the bot", () => {
  const { exchange } = book();
  exchange.order("sitebot1", Items.IRON_AXE, 1, 100);
  const offer = { itemId: Items.IRON_AXE, sell: true, quantity: 1, price: 95, completesAt: 9_000_000 };
  assert.equal(Exchange.meetOffer(exchange, offer, 1000), 1);
  assert.equal(offer.completesAt, 6000);
  assert.deepEqual(exchange.collect("sitebot1"), { coins: 0, items: [{ itemId: Items.IRON_AXE, amount: 1 }] });
});

function bot(t, { earns = true } = {}) {
  const p = new Player(null);
  p.getSession = () => ({ sendClientPacket: () => true, write: () => true });
  p.setUsername(`SiteBot${900 + ++names}`);
  p.sendMessage = () => {};
  p.isPlayerBot = () => true;
  t.after(() => core.TaskManager.cancelTasks(p));
  OwnItems.setEarnsOwnItems(p, earns);
  return p;
}

function visit(t, player, exchange, state = {}) {
  const blocked = [];
  const world = { core: { ...core, World: { ...core.World, getPlayers: () => [] } }, log: () => {} };
  const action = Exchange.createExchangeAction({ type: "exchange" }, world, exchange, [Items.LOGS, Items.COPPER_ORE, Items.SHRIMPS]);
  const ctx = {
    player, world, state, frame: {}, nowMs: 1000, activity: { id: "grand_exchange" },
    brain: { registry: { blockActivity: (who, id, at, ms) => blocked.push({ id, ms }) } },
  };
  return { result: action.update(ctx), ctx, blocked };
}
const atExchange = (player) => player.setLocation(new core.Location(Exchange.EXCHANGE.x + 2, Exchange.EXCHANGE.y - 1, 0));

test("at the exchange a bot puts up what it gathered, keeps food for itself, and is paid when it next comes", (t) => {
  const { exchange, clock } = book();
  const p = bot(t);
  p.getBank(0).adds(Items.LOGS, 120);
  p.getBank(0).adds(Items.SHRIMPS, 40);
  p.getInventory().adds(Items.COPPER_ORE, 5);
  p.getInventory().adds(Items.BRONZE_AXE, 1);
  atExchange(p);
  const who = String(p.getUsername()).toLowerCase();
  const first = visit(t, p, exchange);
  assert.equal(first.result, "success");
  assert.equal(OwnItems.banked(p, Items.LOGS), 0);
  assert.equal(OwnItems.carried(p, Items.COPPER_ORE), 0, "from its backpack too");
  assert.equal(OwnItems.banked(p, Items.SHRIMPS), 30, "thirty kept to eat");
  assert.equal(OwnItems.carried(p, Items.BRONZE_AXE), 1, "its tools are not for sale");
  assert.equal(exchange.onSale(Items.LOGS, 1_000_000), 120);
  assert.equal(exchange.onSale(Items.SHRIMPS, 1_000_000), 10);
  assert.ok(first.blocked[0].id === "grand_exchange" && first.blocked[0].ms >= 25 * 60_000, "and stays away for a while");
  // A player buys forty of the logs; the market takes the rest later.
  const price = Exchange.guide.sell(Items.LOGS);
  exchange.buyFromBots(Items.LOGS, 40, price);
  assert.equal(exchange.hasDue(who), true);
  clock.now += LISTING_MS + 1;
  const second = visit(t, p, exchange);
  assert.equal(second.result, "success");
  assert.ok(OwnItems.carried(p, Items.COINS) >= 120 * price, `paid for all of it (${OwnItems.carried(p, Items.COINS)} coins)`);
});

test("a bot's goods meet a player's waiting offer once: one already met is not sold to again", (t) => {
  const price = Exchange.guide.buy(Items.LOGS);
  const waiting = (met) => {
    const buyer = new Player(null);
    buyer.getSession = () => ({ sendClientPacket: () => true, write: () => true });
    buyer.setUsername(`LogBuyer${++names}`);
    buyer.sendMessage = () => {};
    // As the exchange saves it: a buy of ten logs at the going price, still waiting.
    buyer.setAttribute("grand-exchange-offers", { 0: { slot: 0, itemId: Items.LOGS, sell: false, quantity: 10, price, total: 10 * price,
      finished: false, placedAt: Date.now(), completesAt: Date.now() + 1000, ...(met ? { met: true } : {}) } });
    t.after(() => core.TaskManager.cancelTasks(buyer));
    return buyer;
  };
  for (const met of [false, true]) {
    const { exchange } = book();
    const buyer = waiting(met);
    const seller = bot(t);
    seller.getBank(0).adds(Items.LOGS, 120);
    atExchange(seller);
    const world = { core: { ...core, World: { ...core.World, getPlayers: () => [buyer] } }, log: () => {} };
    const action = Exchange.createExchangeAction({ type: "exchange" }, world, exchange, [Items.LOGS]);
    action.update({ player: seller, world, state: {}, frame: {}, nowMs: 1000, activity: { id: "grand_exchange" }, brain: { registry: { blockActivity() {} } } });
    assert.equal(exchange.onSale(Items.LOGS, price), met ? 120 : 110, met ? "already traded: the logs stay up" : "ten go to the waiting offer");
    assert.equal(buyer.getAttribute("grand-exchange-offers")[0].met, true, "final either way");
  }
});

test("it bids for what it is saving for, coins down, and takes the item home from its next visit", (t) => {
  const { exchange, clock } = book();
  const p = bot(t);
  const price = Exchange.guide.buy(Items.IRON_AXE);
  p.getBank(0).adds(Items.COINS, price + 50);
  atExchange(p);
  const who = String(p.getUsername()).toLowerCase();
  const state = { ownWish: { itemId: Items.IRON_AXE, cost: 56, at: 0 } };
  assert.equal(visit(t, p, exchange, state).result, "success");
  assert.equal(OwnItems.purse(p), 50, "the bid is paid when it is made");
  assert.equal(exchange.bids(who, Items.IRON_AXE), true);
  assert.equal(visit(t, p, exchange, state).result, "failed", "nothing more to do there until it fills");
  clock.now += ORDER_MS + 1;
  exchange.settle();
  assert.equal(visit(t, p, exchange, state).result, "success");
  assert.equal(OwnItems.banked(p, Items.IRON_AXE), 1, "to its bank, where its tool step finds it");
});

test("with nothing to sell, collect or bid for it does not make the walk; nor does a bot that is handed its kit", (t) => {
  const { exchange } = book();
  const idle = bot(t);
  const first = visit(t, idle, exchange);
  assert.equal(first.result, "failed");
  assert.ok(first.ctx.frame.cooldownMs >= 20 * 60_000, "and does not ask again for a while");
  const outfitted = bot(t, { earns: false });
  outfitted.getBank(0).adds(Items.LOGS, 500);
  assert.equal(visit(t, outfitted, exchange).result, "failed");
  assert.equal(OwnItems.banked(outfitted, Items.LOGS), 500);
  // Far from the exchange with goods to sell: it sets off.
  const seller = bot(t);
  seller.getBank(0).adds(Items.LOGS, 500);
  seller.setLocation(new core.Location(3222, 3219, 0));
  assert.equal(visit(t, seller, exchange).result, "running");
  assert.equal(OwnItems.banked(seller, Items.LOGS), 500, "nothing is sold from afar");
});

test("the exchange asks the bots before the market, the crowd has traders, and what they sell is what they gather", () => {
  const plugin = fs.readFileSync(path.join(__dirname, "../plugins/interface/GrandExchange.plugin.js"), "utf8");
  const asked = plugin.indexOf('pluginApi.emitCustomEvent("ge:offer-placing", { player, offer: finished });');
  assert.ok(asked > 0 && asked < plugin.indexOf("completedOffers(player)[offer.slot] = finished;") && asked < plugin.indexOf("scheduleCompletion(player, finished);"), "before the offer's wait is set going");
  assert.equal(typeof require("../plugins/interface/GrandExchange.plugin").fillBy, "function");
  const activities = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/definitions/bot-activities.json"), "utf8")).activities;
  assert.deepEqual(activities.find((activity) => activity.id === "grand_exchange").actions, [{ type: "exchange" }]);
  const world = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/definitions/world.json"), "utf8"));
  assert.ok(world.pluginConfig["PlayerBots:sites"].newcomers.bots.trading > 0);
  const produce = Exchange.loadProduce();
  for (const name of ["LOGS", "OAK_LOGS", "YEW_LOGS", "COPPER_ORE", "IRON_ORE", "COAL", "BRONZE_BAR", "RAW_SHRIMPS", "LOBSTER", "RAW_SWORDFISH"]) {
    assert.ok(produce.includes(Items[name]), name);
  }
  assert.ok(!produce.includes(Items.BURNT_FISH) && !produce.includes(Items.BRONZE_AXE), "nothing burnt, no tools");
});
