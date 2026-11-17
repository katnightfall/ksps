// Ours. Run after `yarn build`: node --test tests/area-loot.test.cjs
// Area loot (plugins/world/AreaLoot.plugin.js): ::loot picks up what a player may take within
// the world's loot distance, by the game's own pick-up rules. Real Players and ground items.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const AreaLoot = require("../plugins/world/AreaLoot.plugin");

let core;
let Items;
let config = {};
let tick = 100;
let names = 0;
const HOME = [3222, 3222, 0];

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  require("../plugins/items/ItemDefinitionLoader.plugin").register({ log() {}, onPlayerLogin() {}, registerContentEndpoint() {} });
  core = PluginManager.getCoreApi();
  Items = core.ItemIdentifiers;
  core.RegionManager.init();
  core.RegionManager.loadMapFiles(HOME[0], HOME[1]);
  AreaLoot._test.setApi({
    core: { ...core, World: Object.assign(Object.create(core.World), { getProcessCycle: () => tick }) },
    getPluginConfig: (key, fallback) => (key in config ? config[key] : fallback),
  });
});

function character(t, at = HOME) {
  const p = new Player(null, new core.Location(...at));
  p.getSession = () => ({ sendClientPacket: () => true, write: () => true });
  p.setUsername(`arealoot${++names}`);
  p.said = [];
  p.sendMessage = (line) => { p.said.push(line); };
  t.after(() => {
    core.TaskManager.cancelTasks(p);
    for (const pile of [...core.World.getItems()]) core.ItemOnGroundManager.deregister(pile);
    config = {};
  });
  return p;
}
/** A drop of `owner`'s at an offset from home, as a kill's loot lands. */
const drop = (owner, itemId, amount, dx, dy, z = 0) =>
  core.ItemOnGroundManager.registerLocation(owner, new core.Item(itemId, amount), new core.Location(HOME[0] + dx, HOME[1] + dy, z));
const loot = (player, ...args) => {
  tick += 10;
  player.said.length = 0;
  return AreaLoot._test.lootCommand({ player, parts: ["loot", ...args.map(String)] });
};
const carried = (p, itemId) => p.getInventory().getAmount(itemId);
/** Piles still on the ground (a taken one stays in the world's list until the tick clears it). */
const lying = () => core.World.getItems().filter((pile) => !pile.isPendingRemoval()).length;

test("everything in range comes at once: piles ten tiles away, not those beyond", (t) => {
  const p = character(t);
  drop(p, Items.COINS, 150, 0, 0);
  drop(p, Items.BONES, 1, 3, -2);
  drop(p, Items.BRONZE_ARROW, 40, -10, 10);
  drop(p, Items.IRON_AXE, 1, 11, 0);          // one tile too far
  drop(p, Items.LOGS, 1, 2, 2, 1);            // upstairs
  assert.equal(AreaLoot._test.nearby(p).length, 3);
  loot(p);
  assert.equal(carried(p, Items.COINS), 150);
  assert.equal(carried(p, Items.BONES), 1);
  assert.equal(carried(p, Items.BRONZE_ARROW), 40);
  assert.equal(carried(p, Items.IRON_AXE), 0);
  assert.equal(carried(p, Items.LOGS), 0);
  assert.deepEqual(p.said, ["You pick up 191 items from 3 piles nearby."]);
  assert.equal(lying(), 2, "the two out of reach still lie there");
  loot(p);
  assert.deepEqual(p.said, ["There is nothing to pick up within 10 tiles."]);
});

test("the distance is the world's: thirty tiles when it says so, never more", (t) => {
  const p = character(t);
  drop(p, Items.COINS, 5, 30, 0);
  drop(p, Items.BONES, 1, 31, 0);
  assert.equal(AreaLoot._test.nearby(p).length, 0);
  config["AreaLoot:radius"] = 30;
  assert.equal(AreaLoot._test.radius(), 30);
  loot(p);
  assert.equal(carried(p, Items.COINS), 5);
  assert.equal(carried(p, Items.BONES), 0);
  config["AreaLoot:radius"] = 500;
  assert.equal(AreaLoot._test.radius(), 30, "thirty is the most");
  config["AreaLoot:radius"] = "nonsense";
  assert.equal(AreaLoot._test.radius(), 10);
  assert.deepEqual(AreaLoot._test.settings({}, []), { enabled: true, radius: 10, wilderness: false });
});

test("one pile by its item and tile, as a click on the panel's row asks", (t) => {
  const p = character(t);
  drop(p, Items.COINS, 20, 1, 0);
  drop(p, Items.BONES, 1, 1, 0);
  drop(p, Items.BONES, 1, 4, 4);
  loot(p, Items.BONES, HOME[0] + 4, HOME[1] + 4);
  assert.equal(carried(p, Items.BONES), 1);
  assert.equal(carried(p, Items.COINS), 0, "only what was asked for");
  assert.equal(lying(), 2);
  loot(p, Items.BONES, HOME[0] + 4, HOME[1] + 4);
  assert.deepEqual(p.said, ["That is no longer there to pick up."]);
  loot(p, "bones");
  assert.match(p.said[0], /^Use ::loot/);
});

test("a full backpack takes what still fits (stacks it already carries) and says what was left", (t) => {
  const p = character(t);
  p.getInventory().adds(Items.COINS, 10);
  for (let n = 0; n < 27; n++) p.getInventory().adds(Items.BONES, 1);
  assert.equal(p.getInventory().getFreeSlots(), 0);
  drop(p, Items.IRON_AXE, 1, 1, 1);
  drop(p, Items.COINS, 90, 2, 2);
  loot(p);
  assert.equal(carried(p, Items.COINS), 100, "the coins join the stack");
  assert.equal(carried(p, Items.IRON_AXE), 0);
  assert.deepEqual(p.said, ["You pick up 90 items from 1 pile nearby. You have no room for 1 more."]);
  loot(p);
  assert.deepEqual(p.said, ["You don't have enough inventory space to pick anything up."]);
});

test("another player's fresh drop is theirs: it is not swept up from across the room", (t) => {
  const mine = character(t);
  const theirs = character(t, [HOME[0] + 2, HOME[1], 0]);
  drop(theirs, Items.RUNE_SCIMITAR, 1, 2, 1);
  drop(mine, Items.BONES, 1, 2, 2);
  loot(mine);
  assert.equal(carried(mine, Items.RUNE_SCIMITAR), 0);
  assert.equal(carried(mine, Items.BONES), 1);
  loot(theirs);
  assert.equal(carried(theirs, Items.RUNE_SCIMITAR), 1, "its owner takes it");
});

test("not in the Wilderness unless the world allows it, not when switched off, and not twice in a tick", (t) => {
  const p = character(t);
  drop(p, Items.COINS, 5, 1, 1);
  p.getWildernessLevel = () => 12;
  loot(p);
  assert.deepEqual(p.said, ["You can't loot the area in the Wilderness."]);
  assert.equal(carried(p, Items.COINS), 0);
  config["AreaLoot:wilderness"] = true;
  loot(p);
  assert.equal(carried(p, Items.COINS), 5);
  p.getWildernessLevel = () => 0;
  config["AreaLoot:enabled"] = false;
  drop(p, Items.COINS, 5, 1, 1);
  loot(p);
  assert.deepEqual(p.said, ["Area loot is switched off on this world."]);
  config["AreaLoot:enabled"] = true;
  // Two sweeps in one tick: the second does nothing (and says nothing).
  loot(p);
  assert.equal(carried(p, Items.COINS), 10);
  drop(p, Items.COINS, 5, 1, 1);
  p.said.length = 0;
  AreaLoot._test.lootCommand({ player: p, parts: ["loot"] });
  assert.equal(carried(p, Items.COINS), 10);
  assert.deepEqual(p.said, []);
});

test("an item that spawns in the world stays where it is", (t) => {
  const p = character(t);
  const spawn = drop(p, Items.BRONZE_PICKAXE, 1, 1, 0);
  spawn.isStaticSpawn = () => true;
  loot(p);
  assert.equal(carried(p, Items.BRONZE_PICKAXE), 0);
  assert.deepEqual(p.said, ["There is nothing to pick up within 10 tiles."]);
});
