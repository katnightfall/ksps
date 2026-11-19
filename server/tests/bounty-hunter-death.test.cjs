// Run after `yarn build`: node --test tests/bounty-hunter-death.test.cjs
//
// Upstream issue #5644, "Bounty Hunter: skulling system and bot BH drops/inventory". What a death in Daimon's Crater
// keeps (Wiki, Items Kept on Death: three items unskulled, one more with Protect Item, none skulled), that the free
// loadout gear the reporter died in is always lost, and that the risk skull counts what such a death drops. The real
// engine: every plugin loaded, real Players, the real PlayerDeathTask.dropItems.
process.env.DISABLE_PLAYER_BOTS = "1";
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { PlayerDeathTask } = require("../dist/game/task/impl/PlayerDeath");

let core, I, RiskSkulls;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  I = core.ItemIdentifiers;
  // BountyHunter depends on PlayerBots, which this test leaves off, so the plugin is skipped: the two units these
  // tests ask (the arena as PvP ground, the risk skull) are attached here.
  const real = PM.createApi("BountyHunter");
  const api = new Proxy({
    core,
    registerArea() {},
    getPluginConfig: (_key, fallback) => fallback,
    onCustomEvent: (name, handler) => { if (name === "player-death:pvp-ground") real.onCustomEvent(name, handler); },
  }, { get: (object, key) => object[key] ?? (() => {}) });
  const bh = require("../plugins/minigames/bountyhunter/State.BountyHunter");
  require("../plugins/minigames/bountyhunter/Area.BountyHunter")(api, bh);
  RiskSkulls = require("../plugins/minigames/bountyhunter/RiskSkulls.BountyHunter");
  RiskSkulls(api, bh);
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));

let next = 9950;
function actor(t) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel));
  p.setIndex(next++);
  p.setUsername("bhd" + p.getIndex());
  p.setRegistered(true);
  p.setAttribute("bot-skip-persistence", true);
  p.needsPlacement = false;
  p.getSkillManager().setMaxLevels(core.Skill.PRAYER, 99, false).setCurrentLevel(core.Skill.PRAYER, 99, false);
  p.getPrayerActive().fill(false);
  t.after(() => { p.setRegistered(false); core.TaskManager.cancelTasks(p); });
  return p;
}

const ARENA = () => new core.Location(3470, 4000, 0);
const GEAR = () => [I.ARMADYL_GODSWORD, I.ABYSSAL_WHIP, I.DRAGON_BOOTS, I.AMULET_OF_FURY, I.RUNE_PLATEBODY];
const byValue = (ids) => [...ids].sort((a, b) => PlayerDeathTask.keepValue(new core.Item(b, 1)) - PlayerDeathTask.keepValue(new core.Item(a, 1)));
const sorted = (ids) => [...ids].sort((a, b) => a - b);

function preset(id) {
  const item = new core.Item(id, 1);
  for (const key of [core.Item.UNTRADEABLE_META, core.Item.UNBANKABLE_META, core.Item.PRESET_META]) item.setMetaValue(key, true);
  return item;
}

/** The victim dies in the arena to `killer`: the ids that come back, and the ids dropped for the killer. */
function dieInArena(t, victim, killer) {
  victim.setLocation(ARENA());
  killer.setLocation(ARENA());
  const dropped = [];
  const register = core.ItemOnGroundManager.registerLocation;
  t.mock.method(core.ItemOnGroundManager, "registerLocation", (owner, item, ...rest) => {
    if (owner === killer) dropped.push(item.getId());
    return register.call(core.ItemOnGroundManager, owner, item, ...rest);
  });
  const kept = PlayerDeathTask.dropItems(victim, killer, ARENA()).map((item) => item.getId());
  core.ItemOnGroundManager.registerLocation.mock.restore();
  return { kept, dropped };
}

test("unskulled in the crater, a player's own items: the three most valuable are kept and the rest drop", (t) => {
  const victim = actor(t), killer = actor(t);
  GEAR().forEach((id, slot) => victim.getInventory().setItem(slot, new core.Item(id, 1)));
  const { kept, dropped } = dieInArena(t, victim, killer);
  assert.deepEqual(sorted(kept), sorted(byValue(GEAR()).slice(0, 3)));
  assert.deepEqual(sorted(dropped), sorted(byValue(GEAR()).slice(3)));
});

test("Protect Item keeps a fourth, and a skull keeps none (one with Protect Item)", (t) => {
  for (const [skulled, protectItem, count] of [[false, true, 4], [true, false, 0], [true, true, 1]]) {
    const victim = actor(t), killer = actor(t);
    GEAR().forEach((id, slot) => victim.getInventory().setItem(slot, new core.Item(id, 1)));
    if (skulled) core.CombatFactory.skull(victim, core.SkullType.WHITE_SKULL, core.CombatFactory.PVP_SKULL_SECONDS);
    victim.setPrayerActive(core.PrayerHandler.PROTECT_ITEM, protectItem);
    const { kept, dropped } = dieInArena(t, victim, killer);
    assert.deepEqual(sorted(kept), sorted(byValue(GEAR()).slice(0, count)), `skulled ${skulled}, Protect Item ${protectItem}`);
    assert.deepEqual(sorted(dropped), sorted(byValue(GEAR()).slice(count)));
  }
});

test("free loadout gear is always lost, unskulled too, takes no kept slot and is nobody's loot", (t) => {
  const victim = actor(t), killer = actor(t);
  // The loadout's godsword is worth more than anything the player brought: it still takes no slot.
  victim.getInventory().setItem(0, preset(I.ARMADYL_GODSWORD));
  victim.getInventory().setItem(1, preset(I.AMULET_OF_FURY));
  victim.getInventory().setItem(2, preset(I.DRAGON_BOOTS));
  const own = [I.ABYSSAL_WHIP, I.RUNE_PLATEBODY, I.RUNE_SCIMITAR];
  own.forEach((id, slot) => victim.getInventory().setItem(slot + 3, new core.Item(id, 1)));
  const { kept, dropped } = dieInArena(t, victim, killer);
  assert.deepEqual(sorted(kept), sorted(own), "the player's own three items are the kept ones");
  assert.deepEqual(dropped, [], "the loadout gear is deleted, not dropped");
});

test("the risk skull counts a tradeable item that is not on the Grand Exchange, as the death that drops it does", (t) => {
  const victim = actor(t), killer = actor(t);
  const shards = new core.Item(I.GODSWORD_SHARDS_1_2, 1);
  assert.equal(shards.isTradeable(), false, "not a Grand Exchange item");
  assert.equal(shards.isPlayerTradeable(), true, "but players trade it");
  victim.getInventory().setItem(0, shards);
  core.CombatFactory.skull(victim, core.SkullType.WHITE_SKULL, core.CombatFactory.PVP_SKULL_SECONDS);
  const risk = RiskSkulls._test.riskOf(victim);
  assert.equal(risk, PlayerDeathTask.keepValue(shards));
  assert.ok(risk > 200_000, "an iron skull, not a bronze one");
  assert.equal(RiskSkulls._test.skullIcon(risk, true), 29);
  const { kept, dropped } = dieInArena(t, victim, killer);
  assert.deepEqual(kept, []);
  assert.deepEqual(dropped, [I.GODSWORD_SHARDS_1_2]);
});

test("untradeable items still do not count towards the risk skull (the Wiki's note on live's skulls)", (t) => {
  const victim = actor(t);
  victim.getInventory().setItem(0, new core.Item(I.FIRE_CAPE, 1));
  victim.getInventory().setItem(1, new core.Item(I.ARMADYL_GODSWORD_OR_, 1));
  core.CombatFactory.skull(victim, core.SkullType.WHITE_SKULL, core.CombatFactory.PVP_SKULL_SECONDS);
  assert.equal(RiskSkulls._test.riskOf(victim), 0);
});
