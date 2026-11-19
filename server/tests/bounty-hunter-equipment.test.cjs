// Run after `yarn build`: node --test tests/bounty-hunter-equipment.test.cjs
//
// Ancient Warriors' equipment from the Bounty Hunter Store (upstream issue #6002): the store sells it inactive, and
// "it must be charged with 5,000,000 coins before it can be used" (Wiki, each item's page; the amounts are in
// plugins/items/data/bounty-hunter-equipment.json). The real engine: every plugin loaded, real Players, the item
// options sent as the client sends them (a slot and a click, no option text). The death side is in
// pvp-death-item-loss.test.cjs.
process.env.DISABLE_PLAYER_BOTS = "1";
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");

let core, I, Equipment, DATA;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  I = core.ItemIdentifiers;
  Equipment = require("../plugins/items/BountyHunterEquipment.plugin")._test;
  DATA = require("../plugins/items/data/bounty-hunter-equipment.json");
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));

let next = 9850;
function actor(t) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(next++);
  player.setUsername("bhe" + player.getIndex());
  player.setRegistered(true);
  player.setAttribute("bot-skip-persistence", true);
  player.needsPlacement = false;
  player.setLocation(new core.Location(3222, 3218, 0));
  const messages = [];
  t.mock.method(player.getPacketSender(), "sendMessage", (message) => { messages.push(String(message)); return player.getPacketSender(); });
  t.after(() => { player.setRegistered(false); core.TaskManager.cancelTasks(player); });
  return { player, inventory: player.getInventory(), messages };
}

/** The item option called `option` in the cache, clicked on inventory slot `slot` as the client sends it. */
function click(player, slot, option) {
  const item = player.getInventory().getItems()[slot];
  const index = core.CacheDefinitions.getItem(item.getId()).inventoryActions.indexOf(option);
  assert.ok(index >= 0, `${item.getDefinition().getName()} has the option ${option}`);
  return PM.emitItemAction({ player, interfaceId: core.Inventory.INTERFACE_ID, item, itemId: item.getId(), slot, clickType: index + 1, handled: false });
}

function answer(player, number) {
  return core.MultiChatboxPrompt.handleInterfaceActionClick({
    player, buttonId: core.MultiChatboxPrompt.OPTIONS_WIDGET_ID, groupId: 219, slot: number, action: number,
  });
}

test("every piece the Bounty Hunter Store sells inactive has an activated form and a fee, and the fees are the Wiki's", () => {
  const { ShopDefinitionLoader } = require("../dist/game/definition/loader/impl/ShopDefinitionLoader");
  const { ShopDefinition } = require("../dist/game/definition/ShopDefinition");
  assert.equal(new ShopDefinitionLoader().load(), true);
  const store = ShopDefinition.all().find((definition) => definition.getName() === "Bounty Hunter Store");
  const inactive = store.getOriginalStock().map((row) => row.id).filter((id) => /\(inactive\)$/.test(core.ItemDefinition.forId(id).getName()));
  assert.equal(inactive.length, 17);
  for (const id of inactive) assert.ok(Equipment.byInactive.has(id), `${core.ItemDefinition.forId(id).getName()} can be activated`);

  assert.equal(Equipment.byActive.size, 28, "17 as-bought pieces and 11 corrupted pieces of armour");
  for (const entry of Equipment.byActive.values()) {
    const active = core.ItemDefinition.forId(entry.active).getName();
    assert.equal(core.ItemDefinition.forId(entry.inactive).getName(), `${active}(inactive)`);
    const expected = /^Corrupted /.test(active) ? 1_500_000
      : active === "Vesta's longsword (bh)" ? 50_000_000
        : ["Statius's warhammer (bh)", "Morrigan's javelin (bh)"].includes(active) ? 10_000_000 : 5_000_000;
    assert.equal(entry.fee, expected, active);
  }
  assert.equal(Object.keys(DATA.activationFees).length, 28);
});

test("Activate asks first, takes the coins and gives the activated piece, which holds them", (t) => {
  const { player, inventory } = actor(t);
  inventory.setItem(0, new core.Item(I.VESTAS_LONGSWORD_BH_INACTIVE_, 1));
  inventory.setItem(1, new core.Item(I.COINS, 60_000_000));

  assert.equal(click(player, 0, "Activate"), true);
  assert.equal(inventory.getItems()[0].getId(), I.VESTAS_LONGSWORD_BH_INACTIVE_, "nothing happens before the answer");
  assert.equal(inventory.getAmount(I.COINS), 60_000_000);
  answer(player, 2);
  assert.equal(inventory.getItems()[0].getId(), I.VESTAS_LONGSWORD_BH_INACTIVE_, "No leaves it as it was");
  assert.equal(inventory.getAmount(I.COINS), 60_000_000);

  click(player, 0, "Activate");
  answer(player, 1);
  assert.equal(inventory.getItems()[0].getId(), I.VESTAS_LONGSWORD_BH_);
  assert.equal(inventory.getAmount(I.COINS), 10_000_000);
  assert.equal(Equipment.heldCoins(inventory.getItems()[0]), 50_000_000);
});

test("Activate without the coins is refused, and nothing is taken", (t) => {
  const { player, inventory, messages } = actor(t);
  inventory.setItem(0, new core.Item(I.VESTAS_CHAINBODY_BH_INACTIVE_, 1));
  inventory.setItem(1, new core.Item(I.COINS, 4_999_999));
  assert.equal(click(player, 0, "Activate"), true);
  answer(player, 1);
  assert.equal(inventory.getItems()[0].getId(), I.VESTAS_CHAINBODY_BH_INACTIVE_);
  assert.equal(inventory.getAmount(I.COINS), 4_999_999);
  assert.match(messages.join("\n"), /5,000,000 coins/);
});

test("coins spent between the question and the answer do not activate the piece", (t) => {
  const { player, inventory } = actor(t);
  inventory.setItem(0, new core.Item(I.ZURIELS_STAFF_BH_INACTIVE_, 1));
  inventory.setItem(1, new core.Item(I.COINS, 5_000_000));
  click(player, 0, "Activate");
  inventory.deleteNumber(I.COINS, 1);
  answer(player, 1);
  assert.equal(inventory.getItems()[0].getId(), I.ZURIELS_STAFF_BH_INACTIVE_);
  assert.equal(inventory.getAmount(I.COINS), 4_999_999);
});

test("Uncharge gives the coins the piece holds back and leaves it inactive; a piece nobody charged gives none", (t) => {
  const { player, inventory } = actor(t);
  const paid = new core.Item(I.MORRIGANS_JAVELIN_BH_, 1);
  paid.setMetaValue(Equipment.FEE_META, 10_000_000);
  inventory.setItem(0, paid);
  inventory.setItem(1, new core.Item(I.STATIUSS_WARHAMMER_BH_, 1));

  assert.equal(click(player, 0, "Uncharge"), true);
  assert.equal(inventory.getItems()[0].getId(), I.MORRIGANS_JAVELIN_BH_INACTIVE_);
  assert.equal(Equipment.heldCoins(inventory.getItems()[0]), 0);
  assert.equal(inventory.getAmount(I.COINS), 10_000_000);

  assert.equal(click(player, 1, "Uncharge"), true);
  assert.equal(inventory.getItems()[1].getId(), I.STATIUSS_WARHAMMER_BH_INACTIVE_);
  assert.equal(inventory.getAmount(I.COINS), 10_000_000, "no coins were ever put in");
});

test("Uncharge with no room for the coins is refused", (t) => {
  const { player, inventory, messages } = actor(t);
  for (let slot = 0; slot < inventory.capacity(); slot++) inventory.setItem(slot, new core.Item(I.BRONZE_DAGGER, 1));
  const paid = new core.Item(I.VESTAS_SPEAR_BH_, 1);
  paid.setMetaValue(Equipment.FEE_META, 5_000_000);
  inventory.setItem(0, paid);
  click(player, 0, "Uncharge");
  assert.equal(inventory.getItems()[0].getId(), I.VESTAS_SPEAR_BH_);
  assert.equal(Equipment.heldCoins(inventory.getItems()[0]), 5_000_000);
  assert.match(messages.join("\n"), /inventory space/);
});

test("a preset copy cannot be uncharged for coins", (t) => {
  const { player, inventory } = actor(t);
  const forged = new core.Item(I.VESTAS_LONGSWORD_BH_, 1);
  for (const key of [core.Item.UNTRADEABLE_META, core.Item.UNBANKABLE_META, core.Item.PRESET_META]) forged.setMetaValue(key, true);
  forged.setMetaValue(Equipment.FEE_META, 50_000_000);
  inventory.setItem(0, forged);
  click(player, 0, "Uncharge");
  assert.equal(inventory.getItems()[0].getId(), I.VESTAS_LONGSWORD_BH_);
  assert.equal(inventory.getAmount(I.COINS), 0);
});

test("the Corrupted Warrior is told to refuse a charged piece, and to take an inactive or uncharged one", () => {
  const ask = (item, to) => { const query = { item, to, allowed: true, message: null }; PM.emitCustomEvent("bounty-hunter:can-convert", query); return query.allowed; };
  const paid = new core.Item(I.CORRUPTED_VESTAS_CHAINBODY_BH_, 1);
  paid.setMetaValue(Equipment.FEE_META, 1_500_000);
  assert.equal(ask(paid, I.VESTAS_CHAINBODY_BH_), false, "1,500,000 coins must not become a 5,000,000 piece");
  assert.equal(ask(new core.Item(I.CORRUPTED_VESTAS_CHAINBODY_BH_, 1), I.VESTAS_CHAINBODY_BH_), true);
  assert.equal(ask(new core.Item(I.VESTAS_CHAINBODY_BH_INACTIVE_, 1), I.CORRUPTED_VESTAS_CHAINBODY_BH_INACTIVE_), true);
});
