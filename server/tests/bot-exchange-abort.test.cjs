// Ours. Run after `yarn build`: node --test tests/bot-exchange-abort.test.cjs
// A player's Grand Exchange offer that the bots' book has met (plugins/bots/brain/actions/
// Exchange.PlayerBots.js) has traded: the bots are paid, or handed the items, as it is placed.
// Such an offer must not be abortable back into the player's coins or items, or the bots' side
// was paid for nothing. The real Grand Exchange plugin, the real book, real item definitions.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { GameConstants } = require("../dist/game/GameConstants");
const { createBotExchange } = require("../plugins/bots/brain/BotExchange.PlayerBots");
const Exchange = require("../plugins/bots/brain/actions/Exchange.PlayerBots");
const GrandExchange = require("../plugins/interface/GrandExchange.plugin");

const GE = 465;
const COINS = 995;
let core;
let Items;
let names = 0;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  require("../plugins/items/ItemDefinitionLoader.plugin").register({ log() {}, onPlayerLogin() {}, registerContentEndpoint() {} });
  core = PluginManager.getCoreApi();
  Items = core.ItemIdentifiers;
});

/** The Grand Exchange open for a real player, its offers meeting `book` as the bots' plugin wires them. */
function exchange(t, book) {
  const buttons = [];
  const hooks = {};
  const timers = [];
  t.mock.method(GameConstants.PLAYER_PERSISTENCE, "save", () => {});
  t.mock.method(global, "setTimeout", (callback, delay) => (timers.push({ callback, delay }), timers.length));
  GrandExchange.register(new Proxy({
    core,
    getPluginConfig: (key, fallback) => fallback,
    emitCustomEvent: (name, payload) => { if (name === "ge:offer-placing") Exchange.meetOffer(book, payload.offer); },
    emitCanBank: () => true,
    onCustomEvent() {},
    onInterfaceActionButton: (ids, handler) => buttons.push({ ids, handler }),
  }, { get: (api, key) => api[key] ?? ((handler) => { hooks[key] = handler; }) }));
  const p = new Player(null);
  p.setUsername(`geabort${++names}`);
  const sender = new Proxy({}, { get: (_, key) => (key === "getVarbit" ? () => 1 : () => sender) });
  p.getPacketSender = () => sender;
  p.getSession = () => ({ sendClientPacket: () => true, write: () => true });
  p.said = [];
  p.sendMessage = (line) => { p.said.push(line); };
  let amountAction, syntaxAction;
  p.setEnteredAmountAction = (action) => { amountAction = action; };
  p.setEnteredSyntaxAction = (action) => { syntaxAction = action; };
  p.setInterfaceId(GE);
  const click = (child, slot = 0) => {
    const buttonId = (GE << 16) | child;
    buttons.find(({ ids }) => Array.isArray(ids) && ids.includes(buttonId)).handler({ player: p, buttonId, slot, action: 1 });
  };
  const place = (sell, itemId, quantity, price) => {
    click(7, sell ? 4 : 3);
    if (sell) hooks.onItemFirstAction({ player: p, itemId, slot: p.getInventory().getSlotForItemId(itemId) });
    else syntaxAction.execute(String(itemId));
    click(34, 7);
    amountAction.execute(quantity);
    click(34, 12);
    amountAction.execute(price);
    click(30);
    return p.getAttribute("grand-exchange-offers")?.[0];
  };
  /** Abort (465:23), let any wait run out, then collect both parts (465:24). */
  const abortAndCollect = () => {
    click(23);
    for (const timer of timers.splice(0)) timer.callback();
    click(24);
  };
  return { p, place, abortAndCollect };
}

test("a buy the bots sold into cannot be aborted back into coins: the logs come, and the bot is paid once", (t) => {
  const book = createBotExchange({ guide: Exchange.guide });
  const price = Exchange.guide.buy(Items.LOGS);
  book.list("sitebot1", Items.LOGS, 10, Exchange.guide.sell(Items.LOGS));
  const { p, place, abortAndCollect } = exchange(t, book);
  p.getInventory().adds(COINS, 10 * price);
  const offer = place(false, Items.LOGS, 10, price);
  assert.ok(offer, "the offer is placed");
  assert.equal(p.getInventory().getAmount(COINS), 0, "paid in");
  assert.equal(book.onSale(Items.LOGS, price), 0, "the bot's logs are sold");
  abortAndCollect();
  const logs = p.getInventory().getAmount(Items.LOGS) + p.getInventory().getAmount(core.ItemDefinition.forId(Items.LOGS).getNoteId());
  const paid = book.collect("sitebot1").coins;
  assert.equal(paid, 10 * Exchange.guide.sell(Items.LOGS), "the bot is paid for its ten logs");
  assert.equal(logs, 10, "and the buyer has them: the trade had happened");
  assert.ok(p.getInventory().getAmount(COINS) < 10 * price, "the coins did not come back as well");
});

test("a sale to a bot's bid cannot be aborted back into the item: the bot has it, the seller the coins", (t) => {
  const book = createBotExchange({ guide: Exchange.guide });
  const bid = Exchange.guide.buy(Items.IRON_AXE);
  book.order("sitebot2", Items.IRON_AXE, 1, bid);
  const { p, place, abortAndCollect } = exchange(t, book);
  p.getInventory().adds(Items.IRON_AXE, 1);
  place(true, Items.IRON_AXE, 1, bid);
  assert.equal(book.wanted(Items.IRON_AXE, bid), 0, "the bot's bid is filled");
  abortAndCollect();
  assert.deepEqual(book.collect("sitebot2").items, [{ itemId: Items.IRON_AXE, amount: 1 }], "the bot has its axe");
  assert.equal(p.getInventory().getAmount(Items.IRON_AXE), 0, "so the seller has not: one axe, not two");
  assert.ok(p.getInventory().getAmount(COINS) > 0, "the seller is paid");
});

test("bots that cover only part of an offer keep their goods: nothing of theirs is sold for an offer that may yet be aborted", (t) => {
  const book = createBotExchange({ guide: Exchange.guide });
  const price = Exchange.guide.buy(Items.LOGS);
  const low = Exchange.guide.sell(Items.LOGS);
  book.list("sitebot3", Items.LOGS, 10, low);
  const { p, place, abortAndCollect } = exchange(t, book);
  p.getInventory().adds(COINS, 40 * price);
  place(false, Items.LOGS, 40, price);
  abortAndCollect();
  assert.equal(p.getInventory().getAmount(COINS), 40 * price, "aborted: every coin back");
  assert.equal(p.getInventory().getAmount(Items.LOGS), 0);
  assert.equal(book.onSale(Items.LOGS, price), 10, "and the bot's logs are still up");
  assert.equal(book.hasDue("sitebot3"), false, "it was paid nothing");
});

test("a bot's goods that meet a waiting offer make it final too", (t) => {
  const book = createBotExchange({ guide: Exchange.guide });
  const price = Exchange.guide.buy(Items.LOGS);
  const { p, place, abortAndCollect } = exchange(t, book);
  p.getInventory().adds(COINS, 5 * price);
  place(false, Items.LOGS, 5, price);
  // The bot comes by later (Exchange's meetWaiting): its logs are sold to the waiting offer.
  book.list("sitebot4", Items.LOGS, 5, Exchange.guide.sell(Items.LOGS));
  assert.equal(book.buyFromBots(Items.LOGS, 5, price), 5);
  assert.equal(GrandExchange.fillBy(p, 0, Date.now() + 5000), true);
  abortAndCollect();
  assert.equal(book.collect("sitebot4").coins, 5 * Exchange.guide.sell(Items.LOGS));
  const logs = p.getInventory().getAmount(Items.LOGS) + p.getInventory().getAmount(core.ItemDefinition.forId(Items.LOGS).getNoteId());
  assert.equal(logs, 5, "the buyer has the logs the bot was paid for");
});
