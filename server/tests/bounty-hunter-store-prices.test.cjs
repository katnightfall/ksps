// Run after `yarn build`: node --test tests/bounty-hunter-store-prices.test.cjs
//
// Upstream issue #5877, "Bounty Hunter: incorrect prices for shops": on the reporters' worlds every piece of equipment
// cost 1 point and the imbue scrolls 10,000. Those are the items' own cache values (the engine's price for a stock row
// that carries no price), so those worlds were serving the store without its price list. This pins the list itself.
//
// Wiki, Bounty Hunter Store, "Stock (Daimon's Crater)", the "sold at" column in Bounty Hunter points, read on
// 18 November 2026. The real engine: the shops as the server loads them, the store opened for a real Player, the
// Value option and a purchase through the shop's own container actions.
process.env.DISABLE_PLAYER_BOTS = "1";
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { ShopDefinitionLoader } = require("../dist/game/definition/loader/impl/ShopDefinitionLoader");
const { ShopDefinition } = require("../dist/game/definition/ShopDefinition");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");

const STORE = "Bounty Hunter Store";
const WIKI_PRICES = [
  ["Vesta's chainbody (bh)(inactive)", 600],
  ["Vesta's plateskirt (bh)(inactive)", 550],
  ["Statius's full helm (bh)(inactive)", 400],
  ["Statius's platebody (bh)(inactive)", 600],
  ["Statius's platelegs (bh)(inactive)", 500],
  ["Morrigan's coif (bh)(inactive)", 400],
  ["Morrigan's leather body (bh)(inactive)", 600],
  ["Morrigan's leather chaps (bh)(inactive)", 500],
  ["Zuriel's hood (bh)(inactive)", 300],
  ["Zuriel's robe top (bh)(inactive)", 500],
  ["Zuriel's robe bottom (bh)(inactive)", 400],
  ["Vesta's spear (bh)(inactive)", 300],
  ["Vesta's longsword (bh)(inactive)", 650],
  ["Statius's warhammer (bh)(inactive)", 450],
  ["Morrigan's throwing axe (bh)(inactive)", 300],
  ["Morrigan's javelin (bh)(inactive)", 550],
  ["Zuriel's staff (bh)(inactive)", 300],
  ["Dark bow imbue scroll", 100],
  ["Barrelchest anchor imbue scroll", 75],
  ["Dragon mace imbue scroll", 50],
  ["Dragon longsword imbue scroll", 50],
  ["Abyssal dagger imbue scroll", 150],
  ["Bounty hunter ornament kit", 50],
  ["Elder maul ornament kit", 50],
  ["Heavy ballista ornament kit", 50],
  ["Elder chaos robes ornament kit", 50],
  ["Target teleport scroll", 500],
  ["Blighted karambwan", 2],
  ["Blighted manta ray", 2],
  ["Blighted anglerfish", 2],
  ["Blighted super restore(4)", 2],
  ["Esoteric emblem (tier 1)", 2],
];

let core, storeId;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  PM.emitServerStartup({});
  assert.equal(new ShopDefinitionLoader().load(), true);
  core.ShopManager.initialize();
  const stores = ShopDefinition.all().filter((definition) => definition.getName() === STORE);
  assert.equal(stores.length, 1, "one shop is the Bounty Hunter Store");
  storeId = stores[0].getId();
});
after(() => PM.emitServerShutdown({}));

let next = 9800;
function shopper(t) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(next++);
  player.setUsername("bhs" + player.getIndex());
  player.setRegistered(true);
  player.setAttribute("bot-skip-persistence", true);
  player.needsPlacement = false;
  // Fort Daimon, where the Emblem Trader keeps the store.
  player.setLocation(new core.Location(3423, 4061, 0));
  const messages = [];
  t.mock.method(player.getPacketSender(), "sendMessage", (message) => { messages.push(String(message)); return player.getPacketSender(); });
  t.after(() => { core.ShopManager.close(player); player.setRegistered(false); core.TaskManager.cancelTasks(player); });
  return { player, messages };
}

const nameOf = (itemId) => core.ItemDefinition.forId(itemId).getName();
const points = () => core.ShopManager.currencyHandlers.get("BOUNTY HUNTER POINTS");

test("the store lists the Wiki's stock at the Wiki's prices, in Bounty Hunter points", (t) => {
  const { player } = shopper(t);
  assert.equal(core.ShopManager.open(player, storeId, true), true);
  const open = core.ShopManager.getOpenShop(player);
  assert.equal(open.name, STORE);
  assert.match(open.currency, /^bounty hunter points$/i);
  assert.deepEqual(open.stock.map((entry) => [nameOf(entry.itemId), entry.price]), WIKI_PRICES);
});

test("no row of the store falls back to the item's own value", (t) => {
  const { player } = shopper(t);
  core.ShopManager.open(player, storeId, true);
  const fallbacks = core.ShopManager.getOpenShop(player).stock
    .filter((entry) => entry.price === core.ItemDefinition.forId(entry.itemId).getValue())
    .map((entry) => nameOf(entry.itemId));
  assert.deepEqual(fallbacks, [], "the reported prices (1 point, 10,000 points) were these values");
});

test("Value quotes Vesta's chainbody at 600 points and the Dark bow imbue scroll at 100", (t) => {
  const { player, messages } = shopper(t);
  core.ShopManager.open(player, storeId, true);
  const stock = core.ShopManager.getOpenShop(player).stock;
  for (const [name, price] of [["Vesta's chainbody (bh)(inactive)", "600"], ["Dark bow imbue scroll", "100"]]) {
    const slot = stock.findIndex((entry) => nameOf(entry.itemId) === name);
    messages.length = 0;
    core.ShopManager.handleItemContainerAction(player, { containerId: core.ShopManager.ITEMS_INTERFACE_ID, slot, itemId: stock[slot].itemId, kind: "value", amount: 1 });
    assert.equal(messages.length, 1, `one quote for ${name}`);
    assert.match(messages[0], new RegExp(`\\b${price}\\b`), messages[0]);
    assert.match(messages[0], /Bounty Hunter Points/i, messages[0]);
  }
});

test("buying a Dark bow imbue scroll takes 100 points, and 99 points do not buy one", (t) => {
  const { player } = shopper(t);
  core.ShopManager.open(player, storeId, true);
  const stock = core.ShopManager.getOpenShop(player).stock;
  const slot = stock.findIndex((entry) => nameOf(entry.itemId) === "Dark bow imbue scroll");
  const scroll = stock[slot].itemId;
  const buy = () => core.ShopManager.handleItemContainerAction(player, { containerId: core.ShopManager.ITEMS_INTERFACE_ID, slot, itemId: scroll, kind: "buy_sell", amount: 1 });

  points().add(player, 99);
  buy();
  assert.equal(player.getInventory().getAmount(scroll), 0, "99 points are too few");
  assert.equal(points().amount(player), 99);

  points().add(player, 13);
  buy();
  assert.equal(player.getInventory().getAmount(scroll), 1);
  assert.equal(points().amount(player), 12, "112 points less the scroll's 100");
});
