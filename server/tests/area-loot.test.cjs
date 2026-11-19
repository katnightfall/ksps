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
  // West along the castle's path: thirty tiles east lies the River Lum, which nobody walks to.
  drop(p, Items.COINS, 5, -30, 0);
  drop(p, Items.BONES, 1, -31, 0);
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

// What a walk-up Take refuses, the sweep refuses: the audit's three ways round it.
test("an Ironman takes no other player's drop by sweeping, though anyone else may", (t) => {
  // The Ironman rule is a pick-up hook (plugins/modes/ironman/Loot.Ironman.js), as a click's is.
  const Common = require("../plugins/modes/ironman/Common.Ironman");
  const hooks = [];
  const api = { core, emitCustomEvent() {}, onCustomEvent() {}, onGroundItemPickup: (hook) => hooks.push(hook), onCanAttack() {},
    onPlayerDeathItemDrop() {}, onCanGainExperience() {} };
  Common.init(api);
  require("../plugins/modes/ironman/Loot.Ironman")(api);
  const emit = PluginManager.emitGroundItemPickup;
  PluginManager.emitGroundItemPickup = (event) => { for (const hook of hooks) hook(event); return event.handled === true; };
  t.after(() => { PluginManager.emitGroundItemPickup = emit; });

  const iron = character(t);
  iron.setAttribute("ironman:mode", "ironman");
  const other = character(t, [HOME[0] + 1, HOME[1], 0]);
  const main = character(t, [HOME[0], HOME[1] + 1, 0]);
  // Their drop, gone public: every player sees it and may take it, an Ironman may not.
  core.ItemOnGroundManager.registerLocation(other, new core.Item(Items.RUNE_SCIMITAR, 1),
    new core.Location(HOME[0] + 1, HOME[1] + 1, 0), undefined, { public: true });
  drop(iron, Items.BONES, 1, 0, 0);
  loot(iron);
  assert.equal(carried(iron, Items.RUNE_SCIMITAR), 0, "another player's drop is not an Ironman's to take");
  assert.equal(carried(iron, Items.BONES), 1, "their own still comes");
  loot(main);
  assert.equal(carried(main, Items.RUNE_SCIMITAR), 1, "any other player takes it");
});

test("a pile in the Wilderness is not swept up from the safe side of the ditch", (t) => {
  // Edgeville: the ditch runs along y 3520-3523, the Wilderness begins at y 3525.
  const SAFE = [3096, 3518, 0];
  core.RegionManager.loadMapFiles(SAFE[0], SAFE[1]);
  const safe = character(t, SAFE);
  const fighter = character(t, [SAFE[0], SAFE[1] + 9, 0]);
  const loot9 = core.ItemOnGroundManager.registerLocation(fighter, new core.Item(Items.RUNE_SCIMITAR, 1),
    new core.Location(SAFE[0], SAFE[1] + 9, 0), undefined, { public: true });
  assert.ok(core.Wilderness.isInLocation(loot9.getPosition()), "the pile lies in the Wilderness");
  assert.equal(Number(safe.getWildernessLevel() ?? 0), 0, "the sweeper does not");
  assert.equal(AreaLoot._test.nearby(safe).includes(loot9), false, "out of the sweep's reach");
  loot(safe);
  assert.equal(carried(safe, Items.RUNE_SCIMITAR), 0);
  config["AreaLoot:wilderness"] = true;
  assert.equal(AreaLoot._test.nearby(safe).includes(loot9), true, "a world that allows Wilderness sweeps lists it");
});

test("a pile the player cannot walk to stays: walled in it is left, the wall gone it comes", (t) => {
  const p = character(t);
  const [x, y] = [HOME[0] + 4, HOME[1]];
  const BLOCKED = core.RegionManager.BLOCKED_TILE;
  const ring = [];
  // Two rings of solid tiles round the pile: no tile beside it can be stood on.
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) if (dx || dy) ring.push([x + dx, y + dy]);
  const before = ring.map(([rx, ry]) => core.RegionManager.getClipping(rx, ry, 0, null));
  const lift = () => ring.forEach(([rx, ry], i) => { if (!(before[i] & BLOCKED)) core.RegionManager.removeClipping(rx, ry, 0, BLOCKED, null); });
  for (const [rx, ry] of ring) core.RegionManager.addClipping(rx, ry, 0, BLOCKED, null);
  t.after(lift);
  drop(p, Items.RUNE_SCIMITAR, 1, 4, 0);
  drop(p, Items.BONES, 1, 0, 1);
  loot(p);
  assert.equal(carried(p, Items.RUNE_SCIMITAR), 0, "behind the wall");
  assert.equal(carried(p, Items.BONES), 1, "in the open");
  assert.deepEqual(p.said, ["You pick up 1 item from 1 pile nearby. You can't reach 1 more."]);
  loot(p, Items.RUNE_SCIMITAR, x, y);
  assert.deepEqual(p.said, ["You can't reach that."]);
  lift();
  loot(p);
  assert.equal(carried(p, Items.RUNE_SCIMITAR), 1, "the way open, it comes");
});
