process.env.DISABLE_PLAYER_BOTS = "1";
// Run after `yarn build`: node --test tests/thieving-trapped-chests.test.cjs
//
// Ours: the Wiki's "Search for traps" thieving chests (Chest (10 coins), Chest (nature runes), Chest (50 coins),
// Chest (steel arrowtips), Chest (Chaos Druid Tower)), through real object clicks on the chests the map places,
// with a real Player and the real plugins. Level, experience and loot are the Wiki's; the timeline is the Rogues'
// Castle chest's (rsprox 462 and 463). Experience is compared as the base value times the world's rate.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { ClientConnection } = require("../dist/net/NetworkBuilder");
const { GameConstants } = require("../dist/game/GameConstants");

const TEN_COINS = { name: "trapchest1", tile: [2673, 3307, 0], stand: [2674, 3307], level: 13, xp: 7.8, respawn: 12 };
const NATURE = { name: "trapchest2", tile: [2671, 3301, 1], stand: [2672, 3301], level: 28, xp: 25, respawn: 25 };
const FIFTY_COINS = { name: "trapchest3", tile: [2671, 3299, 1], stand: [2672, 3299], level: 43, xp: 125, respawn: 83 };
const ARROWTIPS = { name: "pickchest3", tile: [2650, 3659, 0], stand: [2649, 3659], level: 47, xp: 150, respawn: 150 };
const HEMENSTER = { name: "pickchest3", tile: [2639, 3424, 0], stand: [2640, 3424], level: 47, xp: 150 };
const BLOOD = { name: "trapchest4", tile: [2586, 9734, 0], stand: [2586, 9733], level: 59, xp: 250, respawn: 225 };
const ALL = [TEN_COINS, NATURE, FIFTY_COINS, ARROWTIPS, HEMENSTER, BLOOD];
let core;
let I;
let next = 7700;
let clock = 0;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  I = core.ItemIdentifiers;
  core.RegionManager.init();
  for (const chest of ALL) {
    core.RegionManager.loadMapFiles(chest.tile[0], chest.tile[1]);
    chest.id = core.CacheDefinitions.getLocId(chest.name);
  }
  core.RegionManager.loadMapFiles(2584, 3337);
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));

/** One game cycle in World.process's order: the tasks, then the player's movement and walk-to. */
function tick(f) {
  clock++;
  core.TaskManager.process();
  f.player.getMovementQueue().process();
  core.TaskManager.processWalkTo(f.player.getIndex());
}
const ticks = (f, n) => { for (let i = 0; i < n; i++) tick(f); };

function actor(t, chest, { thieving = 99 } = {}) {
  const channel = {
    kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true,
    close() {}, onData() {}, onError() {}, onClose() {},
  };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(next++);
  player.setUsername("trapchest" + player.getIndex());
  player.setRegistered(true);
  player.setAttribute("bot-skip-persistence", true);
  player.setLocation(new core.Location(chest.stand[0], chest.stand[1], chest.tile[2]));
  player.needsPlacement = false;
  player.getSkillManager().setMaxLevels(core.Skill.THIEVING, thieving, false).setCurrentLevels(core.Skill.THIEVING, thieving, false);
  const connection = new ClientConnection(channel);
  connection.player = player;
  const f = { player, connection, inv: player.getInventory(), messages: [], animations: [], hits: [] };
  const sender = player.getPacketSender();
  const sendMessage = sender.sendMessage.bind(sender);
  sender.sendMessage = (message) => { f.messages.push([clock, message]); return sendMessage(message); };
  const perform = player.performAnimation.bind(player);
  player.performAnimation = (animation) => { f.animations.push([clock, animation.getId()]); return perform(animation); };
  const queue = player.getCombat().getHitQueue();
  const addPendingDamage = queue.addPendingDamage.bind(queue);
  queue.addPendingDamage = (hits) => { f.hits.push([clock, hits.map((hit) => hit.getDamage())]); return addPendingDamage(hits); };
  t.after(() => {
    PM.emitPlayerLogout({ player, username: player.getUsername() });
    player.setRegistered(false);
    core.TaskManager.cancelTasks(player.getIndex());
    core.TaskManager.cancelTasks(player);
  });
  return f;
}

const Chests = () => require("../plugins/skills/thieving/TrappedChests.Thieving")._test;
const chestLocation = (chest) => new core.Location(...chest.tile);
/** The chest ids on the tile (walls and decorations share it). */
const shownIds = (chest) => core.MapObjects.getObjectsAt(chestLocation(chest), null).map((o) => o.getId())
  .filter((id) => /chest/.test(core.CacheDefinitions.getLocNames().get(id) ?? ""));

/** A real object_option packet on whatever chest stands on the tile; the option runs on the next cycle (tick 0). */
async function click(f, chest, option, id = chest.id) {
  const index = [...(core.CacheDefinitions.getObject(id).actions ?? [])].indexOf(option);
  assert.ok(index >= 0, `the cache offers ${option}`);
  clock = -1;
  await f.connection.dispatch([{ type: "object_option", id, x: chest.tile[0], y: chest.tile[1], clickType: index + 1 }]);
  f.connection.processTurnPackets();
}

const at = (f, text) => f.messages.find(([, message]) => message === text)?.[0];
const thievingXp = (f) => f.player.getSkillManager().getExperience(core.Skill.THIEVING);
const gained = (f, before, base) => Math.abs(thievingXp(f) - before - base * GameConstants.EXPERIENCE_MULTIPLIER) <= 1;
/** Lets a looted chest refill before the next test (the longest is the blood rune chest's 225 ticks). */
const refill = (f) => ticks(f, 230);

test("the map places every chest, and the table is the Wiki's (level, experience, loot, lockpick)", () => {
  for (const chest of ALL) assert.ok(core.MapObjects.get(chest.id, chestLocation(chest), null), `${chest.name} at ${chest.tile}`);
  const kinds = Object.fromEntries(Chests().KINDS.map((kind) => [kind.key, kind]));
  const row = (kind) => [kind.closed, kind.level, kind.xp, kind.loot, kind.lockpick === true];
  assert.deepEqual(row(kinds["10-coins"]), ["trapchest1", 13, 7.8, [["COINS", 10]], false]);
  assert.deepEqual(row(kinds["nature-rune"]), ["trapchest2", 28, 25, [["NATURE_RUNE", 1], ["COINS", 3]], false]);
  assert.deepEqual(row(kinds["50-coins"]), ["trapchest3", 43, 125, [["COINS", 50]], false]);
  assert.deepEqual(row(kinds["steel-arrowtips"]), ["pickchest3", 47, 150, [["STEEL_ARROWTIPS", 5], ["COINS", 20]], true]);
  assert.deepEqual(row(kinds["blood-rune"]), ["trapchest4", 59, 250, [["BLOOD_RUNE", 2], ["COINS", 500]], false]);
  // Each chest's own page: looted for 7, 15, 50, 90 and 135 seconds.
  assert.deepEqual(Chests().KINDS.map((kind) => kind.respawnTicks), [12, 25, 83, 150, 225]);
  for (const kind of Chests().KINDS) for (const [key] of kind.loot) assert.equal(typeof I[key], "number", key);
});

test("a 10 coin chest: search, disable 2 ticks on, open at 4, 10 coins and 7.8 XP at 6, empty for 7 seconds", async (t) => {
  const f = actor(t, TEN_COINS);
  const xp = thievingXp(f);
  await click(f, TEN_COINS, "Search for traps");
  ticks(f, 7); // ticks 0-6
  assert.equal(at(f, "You search the chest for traps."), 0);
  assert.equal(at(f, "You find a trap on the chest."), 0);
  assert.equal(at(f, "You disable the trap."), 2);
  assert.equal(at(f, "You open the chest."), 4);
  assert.equal(at(f, "You find treasure inside!"), 6);
  assert.deepEqual(f.animations, [[0, 537], [4, 537], [6, 536]]);
  assert.equal(f.inv.getAmount(I.COINS), 10);
  assert.ok(gained(f, xp, 7.8), `7.8 XP, got ${thievingXp(f) - xp}`);
  const emptyId = core.CacheDefinitions.getLocId("emptytrapchest");
  assert.deepEqual(shownIds(TEN_COINS), [emptyId], "the chest shows empty");

  // The empty chest answers a search with the looted line and gives nothing.
  await click(f, TEN_COINS, "Search for traps", emptyId);
  ticks(f, 2);
  assert.ok(at(f, "It looks like this chest has already been looted.") !== undefined);
  assert.equal(f.inv.getAmount(I.COINS), 10);

  ticks(f, TEN_COINS.respawn);
  assert.deepEqual(shownIds(TEN_COINS), [TEN_COINS.id], "and is full again 7 seconds after the loot");
});

test("below the chest's Thieving level, or without room, nothing is searched", async (t) => {
  for (const chest of [TEN_COINS, NATURE, FIFTY_COINS, ARROWTIPS, BLOOD]) {
    const f = actor(t, chest, { thieving: chest.level - 1 });
    f.inv.add(new core.Item(I.LOCKPICK, 1), false);
    await click(f, chest, "Search for traps");
    ticks(f, 8);
    assert.equal(at(f, "You search the chest for traps."), undefined, chest.name);
    assert.ok(at(f, `You need a Thieving level of at least ${chest.level} to steal from this chest.`) !== undefined, chest.name + ": " + JSON.stringify(f.messages));
    assert.deepEqual(shownIds(chest), [chest.id]);
  }
  const full = actor(t, FIFTY_COINS);
  for (let i = 0; i < 28; i++) full.inv.add(new core.Item(I.BRONZE_DAGGER, 1), false);
  await click(full, FIFTY_COINS, "Search for traps");
  ticks(full, 8);
  assert.ok(at(full, "You need more inventory space for the loot.") !== undefined);
  assert.equal(full.inv.getAmount(I.COINS), 0);
});

test("the nature rune and 50 coin chests give their Wiki loot and experience", async (t) => {
  const f = actor(t, NATURE, { thieving: 28 });
  const xp = thievingXp(f);
  await click(f, NATURE, "Search for traps");
  ticks(f, 7);
  assert.equal(f.inv.getAmount(I.NATURE_RUNE), 1);
  assert.equal(f.inv.getAmount(I.COINS), 3);
  assert.ok(gained(f, xp, 25), `25 XP, got ${thievingXp(f) - xp}`);
  refill(f);

  const g = actor(t, FIFTY_COINS, { thieving: 43 });
  const gxp = thievingXp(g);
  await click(g, FIFTY_COINS, "Search for traps");
  ticks(g, 7);
  assert.equal(g.inv.getAmount(I.COINS), 50);
  assert.ok(gained(g, gxp, 125), `125 XP, got ${thievingXp(g) - gxp}`);
  ticks(g, FIFTY_COINS.respawn - 1);
  assert.notDeepEqual(shownIds(FIFTY_COINS), [FIFTY_COINS.id], "still empty a tick before 50 seconds");
  ticks(g, 1);
  assert.deepEqual(shownIds(FIFTY_COINS), [FIFTY_COINS.id]);
});

test("the steel arrowtips chest needs a lockpick: 5 arrowtips, 20 coins and 150 XP (Rellekka)", async (t) => {
  const f = actor(t, ARROWTIPS, { thieving: 47 });
  await click(f, ARROWTIPS, "Search for traps");
  ticks(f, 8);
  assert.ok(at(f, "You need a lockpick to open this chest.") !== undefined);
  assert.equal(f.inv.getAmount(I.STEEL_ARROWTIPS), 0);

  f.inv.add(new core.Item(I.LOCKPICK, 1), false);
  const xp = thievingXp(f);
  await click(f, ARROWTIPS, "Search for traps");
  ticks(f, 7);
  assert.equal(f.inv.getAmount(I.STEEL_ARROWTIPS), 5);
  assert.equal(f.inv.getAmount(I.COINS), 20);
  assert.equal(f.inv.getAmount(I.LOCKPICK), 1, "the lockpick is kept");
  assert.ok(gained(f, xp, 150), `150 XP, got ${thievingXp(f) - xp}`);
  assert.deepEqual(shownIds(ARROWTIPS), [core.CacheDefinitions.getLocId("emptypickchest")]);
  refill(f);
});

test("the Hemenster arrowtips chest stays the Kandarin diary's: its loot and experience, not this unit's timeline", async (t) => {
  const f = actor(t, HEMENSTER, { thieving: 47 });
  f.inv.add(new core.Item(I.LOCKPICK, 1), false);
  const xp = thievingXp(f);
  await click(f, HEMENSTER, "Search for traps");
  ticks(f, 8);
  assert.equal(at(f, "You search the chest for traps."), undefined);
  assert.equal(f.inv.getAmount(I.STEEL_ARROWTIPS), 5);
  assert.ok(gained(f, xp, 150));
});

test("the blood rune chest: 2 blood runes, 500 coins, 250 XP, and the second trap sends the looter to East Ardougne", async (t) => {
  const f = actor(t, BLOOD, { thieving: 59 });
  const xp = thievingXp(f);
  await click(f, BLOOD, "Search for traps");
  ticks(f, 7);
  assert.equal(f.inv.getAmount(I.BLOOD_RUNE), 2);
  assert.equal(f.inv.getAmount(I.COINS), 500);
  assert.ok(gained(f, xp, 250), `250 XP, got ${thievingXp(f) - xp}`);
  assert.equal(at(f, "Suddenly a second magical trap triggers."), 6);
  const here = f.player.getLocation();
  assert.deepEqual([here.getX(), here.getY(), here.getZ()], [2584, 3337, 0], "the Wiki's map pin, west of Elena's house");
  assert.equal(core.RegionManager.blocked(here, null), false);
  refill(f);
});

test("Open without searching springs the trap where the Wiki gives its damage, and is left alone elsewhere", async (t) => {
  // Nature rune chest: floor(current Hitpoints x 12 / 100) + 3.
  const f = actor(t, NATURE);
  f.player.getSkillManager().setMaxLevels(core.Skill.HITPOINTS, 99, false).setCurrentLevels(core.Skill.HITPOINTS, 60, false);
  await click(f, NATURE, "Open");
  ticks(f, 3);
  assert.equal(at(f, "You have activated a trap on the chest."), 0);
  assert.deepEqual(f.hits, [[1, [10]]], "floor(60 x 12 / 100) + 3 = 10, a tick after the click");
  assert.equal(f.inv.getAmount(I.NATURE_RUNE), 0);

  // Chaos Druid Tower: (9 x Hitpoints + 225) / 50, "up to 22".
  const g = actor(t, BLOOD);
  g.player.getSkillManager().setMaxLevels(core.Skill.HITPOINTS, 99, false).setCurrentLevels(core.Skill.HITPOINTS, 99, false);
  await click(g, BLOOD, "Open");
  ticks(g, 3);
  assert.deepEqual(g.hits, [[1, [22]]]);

  // The 10 coin chest's page gives no number: Open is not answered by this unit. Nor by the Rogues' Den any more,
  // which took this loc everywhere and handed out 10 coins on every Open.
  const h = actor(t, TEN_COINS, { thieving: 1 });
  await click(h, TEN_COINS, "Open");
  ticks(h, 3);
  assert.equal(at(h, "You have activated a trap on the chest."), undefined);
  assert.deepEqual(h.hits, []);
  assert.equal(h.inv.getAmount(I.COINS), 0, "no coins for opening without the level or a search");
});

test("walking off before the loot ends the search: no loot, no experience, the chest stays full", async (t) => {
  const f = actor(t, FIFTY_COINS);
  const xp = thievingXp(f);
  await click(f, FIFTY_COINS, "Search for traps");
  ticks(f, 3);
  f.player.setLocation(new core.Location(FIFTY_COINS.stand[0] + 1, FIFTY_COINS.stand[1], 1));
  ticks(f, 6);
  assert.equal(at(f, "You find treasure inside!"), undefined);
  assert.equal(f.inv.getAmount(I.COINS), 0);
  assert.equal(thievingXp(f), xp);
  assert.deepEqual(shownIds(FIFTY_COINS), [FIFTY_COINS.id]);
});
