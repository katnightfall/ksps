// Ours. Run after `yarn build`: node --test tests/bot-potions.test.cjs
// Potions for the levelling bots' fights (plugins/bots/brain/BotPotions.PlayerBots.js): bought
// with their own coins once they can well afford them, carried to a fight, drunk through the
// potion's own item option, and worn off a point a minute. Real Players, the real Potions plugin.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { before, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const StarterKit = require("../plugins/world/StarterKit.plugin");
const OwnItems = require("../plugins/bots/brain/OwnItems.PlayerBots");
const Ambition = require("../plugins/bots/brain/Ambition.PlayerBots");
const { createBotPotions } = require("../plugins/bots/brain/BotPotions.PlayerBots");
const Exchange = require("../plugins/bots/brain/actions/Exchange.PlayerBots");
const { createBotExchange } = require("../plugins/bots/brain/BotExchange.PlayerBots");
const { createBotActivityRegistry } = require("../plugins/bots/brain/ActivityRegistry.PlayerBots");
const { BotBrain } = require("../plugins/bots/brain/Brain.PlayerBots");

let core;
let Items;
let registry;
let site;
let names = 0;
const CROWD = { id: "potioncrowd", enabled: true, progression: true, x: 3222, y: 3219,
  bots: { woodcutting: 30, mining: 20, fishing: 10, combat_training: 40 } };

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  require("../plugins/items/ItemDefinitionLoader.plugin").register({ log() {}, onPlayerLogin() {}, registerContentEndpoint() {} });
  core = PluginManager.getCoreApi();
  Items = core.ItemIdentifiers;
  require("../plugins/items/Food.plugin").register(PluginManager.createApi("BotPotionsTestFood"));
  require("../plugins/items/Potions.plugin").register(PluginManager.createApi("BotPotionsTest"));
  assert.equal(new (require("../dist/game/definition/loader/impl/ShopDefinitionLoader").ShopDefinitionLoader)().load(), true, "the server's shops");
  core.ShopManager.initialize();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bot-sites-")), "bot-sites.json");
  fs.writeFileSync(file, JSON.stringify({ sites: [CROWD], pvp: { botPool: 0, activeRegionBotsPerRegion: 0 } }));
  registry = createBotActivityRegistry({ world: { core }, sitesPath: file });
  site = registry.getSite(CROWD.id);
});

function worldWith() {
  const logged = [];
  const clock = { now: 1_000_000 };
  const world = { core, log: (event, data) => logged.push([event, data]) };
  const book = createBotExchange({ guide: Exchange.guide, now: () => clock.now });
  world.ambition = Ambition.createAmbition({ world, exchange: book });
  const potions = createBotPotions({ world, ambition: world.ambition });
  // The booth is where the bot stands (the walk is the Bank action's, tried in the live trial).
  OwnItems.ownItemsFor(world).bankTrip = (ctx, key, plan) => {
    const inventory = ctx.player.getInventory();
    const bank = ctx.player.getBank(0);
    for (const entry of typeof plan.withdraw === "function" ? plan.withdraw(ctx.player) : plan.withdraw ?? []) {
      const amount = Math.min(entry.amount, bank.getAmount(entry.itemId));
      if (amount <= 0) continue;
      bank.deleteNumber(entry.itemId, amount);
      inventory.adds(entry.itemId, amount);
    }
    return "success";
  };
  return { world, logged, book, clock, ambition: world.ambition, potions };
}

function bot(t, { coins = 0 } = {}) {
  const p = new Player(null);
  p.getSession = () => ({ sendClientPacket: () => true, write: () => true });
  p.setUsername(`potions${++names}`);
  p.sendMessage = () => {};
  p.isPlayerBot = () => true;
  p.setRegistered(true);
  t.after(() => { p.setRegistered(false); core.TaskManager.cancelTasks(p); });
  OwnItems.setEarnsOwnItems(p, true);
  StarterKit.giveToBot(p);
  if (coins) p.getInventory().adds(Items.COINS, coins);
  return p;
}
function botOfStyle(t, ambition, style, options) {
  for (let tries = 0; tries < 200; tries++) {
    const p = bot(t, options);
    if (ambition.kit().preferredStyle(p) === style) return p;
  }
  throw new Error(`no ${style} bot drawn`);
}
function brainFor(player, world, activityId) {
  const brain = new BotBrain({ player, state: {}, registry, world, activity: registry.byId.get(activityId), rotation: site.rotation, nowMs: 1000 });
  brain.frames[0].state = "running";
  return brain;
}
const setLevel = (player, skill, level) => player.getSkillManager().setCurrentLevel(skill, level, false).setMaxLevels(skill, level, false)
  .setExperience(skill, core.SkillManager.getExperienceForLevel(level));
/** A monster the bot is fighting: only what a look at the fight asks of it. */
const monster = (level) => ({ isNpc: () => true, getHitpoints: () => 30, getDefinition: () => ({ getCombatLevel: () => level }) });
function fight(player, target) {
  const combat = player.getCombat();
  combat.getTarget = () => target;
}
const level = (player, skill) => player.getSkillManager().getCurrentLevel(skill);
const potionGoals = (ambition, p) => ambition.mind(p).goals.filter((goal) => goal.kind === "potion");

test("a bot that can well afford them wants a pair of potions for its style; a poor one wants none and never saves for one", (t) => {
  const { world, ambition } = worldWith();
  // A new character: 25 coins in its bank.
  const poor = botOfStyle(t, ambition, "melee");
  ambition.consider(brainFor(poor, world, "combat_training"), 2000);
  assert.deepEqual(potionGoals(ambition, poor), [], "its coins are for its tools and its kit");
  assert.notEqual(ambition.mind(poor).saving?.kind, "potion");

  const rich = botOfStyle(t, ambition, "melee", { coins: 400_000 });
  ambition.consider(brainFor(rich, world, "combat_training"), 2000);
  const wanted = potionGoals(ambition, rich);
  assert.equal(wanted.length, 3, "strength, attack and defence");
  for (const goal of wanted) {
    assert.equal(goal.amount, 2);
    assert.ok(goal.cost > 0 && goal.cost <= 400_025 * 0.25, `${goal.key} costs ${goal.cost}`);
    assert.ok(goal.source === "shop" || goal.source === "exchange");
    assert.match(core.ItemDefinition.forId(goal.itemId).getName(), /\(4\)$/, "a full one");
  }
  // One it already has a dose of is not wanted again.
  rich.getBank(0).adds(Items.STRENGTH_POTION_2_, 1);
  ambition.consider(brainFor(rich, world, "combat_training"), 3000);
  assert.equal(potionGoals(ambition, rich).length, 2);

  const archer = botOfStyle(t, ambition, "ranged", { coins: 400_000 });
  ambition.consider(brainFor(archer, world, "combat_training"), 2000);
  const ranging = potionGoals(ambition, archer);
  assert.ok(ranging.length <= 1, "one kind for an archer");
  if (ranging.length) assert.match(core.ItemDefinition.forId(ranging[0].itemId).getName(), /^Ranging potion/);
});

test("at the exchange it bids for the pair, coins down", (t) => {
  const { world, ambition, book } = worldWith();
  const p = botOfStyle(t, ambition, "melee", { coins: 400_000 });
  const brain = brainFor(p, world, "combat_training");
  ambition.consider(brain, 2000);
  // Only its potions are left to get, and no shop it can walk to sells them.
  for (const goal of ambition.mind(p).goals) {
    if (goal.kind !== "potion") ambition.mind(p).cool.set(goal.key, Infinity);
    else ambition.mind(p).noShop.set(goal.itemId, Infinity);
  }
  const visit = ambition.consider(brain, 3000);
  assert.equal(visit.kind, "exchange");
  assert.equal(visit.goal.kind, "potion");
  p.setLocation(new core.Location(Exchange.EXCHANGE.x, Exchange.EXCHANGE.y + 1, 0));
  const before = OwnItems.purse(p);
  ambition.mind(p).errand = { ...visit, startedAt: 3000 };
  let result = "running";
  for (let tick = 0; tick < 5 && result === "running"; tick++) result = ambition.runErrand({ player: p, state: brain.state, world, brain, frame: {}, nowMs: 4000 + tick * 600 });
  assert.equal(result, "success");
  const orders = book.book().orders;
  const byItem = new Map();
  for (const entry of orders) byItem.set(entry.itemId, (byItem.get(entry.itemId) ?? 0) + entry.remaining);
  assert.equal(byItem.size, 3);
  for (const [itemId, amount] of byItem) assert.equal(amount, 2, `two of item ${itemId}`);
  assert.equal(before - OwnItems.purse(p), orders.reduce((sum, entry) => sum + entry.remaining * entry.price, 0), "paid as the bids went in");
});

test("it takes one of each to a fight, and leaves them in the bank for other work", (t) => {
  const { world, ambition } = worldWith();
  const p = botOfStyle(t, ambition, "melee");
  p.getBank(0).adds(Items.STRENGTH_POTION_4_, 2);
  p.getBank(0).adds(Items.ATTACK_POTION_3_, 1);
  p.getBank(0).adds(Items.ATTACK_POTION_4_, 1);
  const chopping = brainFor(p, world, "normal_trees");
  const errandWhileChopping = ambition.consider(chopping, 2000);
  assert.notEqual(errandWhileChopping?.kind, "wear", "no use for a potion at a tree");
  const fighting = brainFor(p, world, "combat_training");
  ambition.mind(p).errandAfter = 0;
  const errand = ambition.consider(fighting, 3000);
  assert.equal(errand.kind, "wear");
  ambition.mind(p).errand = { ...errand, startedAt: 3000 };
  assert.equal(ambition.runErrand({ player: p, state: fighting.state, world, frame: {}, nowMs: 4000 }), "success");
  assert.equal(p.getInventory().getAmount(Items.STRENGTH_POTION_4_), 1);
  assert.equal(p.getInventory().getAmount(Items.ATTACK_POTION_3_), 1, "the opened one first");
  assert.equal(p.getInventory().getAmount(Items.ATTACK_POTION_4_), 0);
  assert.equal(OwnItems.banked(p, Items.STRENGTH_POTION_4_), 1, "the other stays in the bank");
  // With it for good: a bank visit of its work does not put a potion away.
  const keep = OwnItems.keeping([]);
  assert.equal(keep(Items.STRENGTH_POTION_4_), true);
  assert.equal(keep(Items.ANTIPOISON_1_), true);
  assert.equal(keep(Items.LOGS), false);
  ambition.mind(p).errandAfter = 0;
  assert.notEqual(ambition.consider(fighting, 5000)?.kind, "wear", "it has what it came for");
});

test("it drinks a dose when a fight worth one starts, one potion a look, and not again while the boost lasts", (t) => {
  const { world, ambition, potions, logged } = worldWith();
  const p = botOfStyle(t, ambition, "melee");
  setLevel(p, core.Skill.STRENGTH, 40);
  setLevel(p, core.Skill.ATTACK, 40);
  p.getInventory().adds(Items.STRENGTH_POTION_4_, 1);
  p.getInventory().adds(Items.ATTACK_POTION_2_, 1);
  const brain = brainFor(p, world, "combat_training");
  potions.tick(brain, 10_000);
  assert.equal(level(p, core.Skill.STRENGTH), 40, "no fight, no drink");
  fight(p, monster(1));
  potions.tick(brain, 20_000);
  assert.equal(level(p, core.Skill.STRENGTH), 40, "not for a chicken");
  fight(p, monster(25));
  potions.tick(brain, 30_000);
  assert.equal(level(p, core.Skill.STRENGTH), 47, "a strength potion: 3 + 10%");
  assert.equal(p.getInventory().getAmount(Items.STRENGTH_POTION_4_), 0);
  assert.equal(p.getInventory().getAmount(Items.STRENGTH_POTION_3_), 1, "one dose gone, by the game's own rule");
  assert.equal(level(p, core.Skill.ATTACK), 40, "one drink at a time");
  potions.tick(brain, 30_600);
  assert.equal(level(p, core.Skill.ATTACK), 40, "its next look is a few ticks off");
  // The game's potion timer has run out by its next look.
  p.getTimers().cancel(core.TimerKey.POTION);
  potions.tick(brain, 33_000);
  assert.equal(level(p, core.Skill.ATTACK), 47);
  assert.equal(p.getInventory().getAmount(Items.ATTACK_POTION_1_), 1);
  p.getTimers().cancel(core.TimerKey.POTION);
  potions.tick(brain, 36_000);
  assert.equal(p.getInventory().getAmount(Items.STRENGTH_POTION_3_), 1, "boosted: no more is drunk");
  assert.equal(logged.filter(([event]) => event === "bot_potion_drunk").length, 2);
});

test("the boost leaves it a point a minute, and then it drinks again", (t) => {
  const { world, ambition, potions } = worldWith();
  const p = botOfStyle(t, ambition, "melee");
  setLevel(p, core.Skill.STRENGTH, 40);
  p.getInventory().adds(Items.STRENGTH_POTION_4_, 1);
  const brain = brainFor(p, world, "combat_training");
  fight(p, monster(25));
  potions.tick(brain, 100_000);
  assert.equal(level(p, core.Skill.STRENGTH), 47);
  fight(p, null);
  potions.tick(brain, 100_000 + 59_000);
  assert.equal(level(p, core.Skill.STRENGTH), 47, "not yet a minute");
  potions.tick(brain, 100_000 + 61_000);
  assert.equal(level(p, core.Skill.STRENGTH), 46);
  potions.tick(brain, 100_000 + 4 * 60_000 + 1000);
  assert.equal(level(p, core.Skill.STRENGTH), 43, "a bot that was not looked at for a while catches up");
  potions.tick(brain, 100_000 + 30 * 60_000);
  assert.equal(level(p, core.Skill.STRENGTH), 40, "down to its own level and no further");
  potions.tick(brain, 100_000 + 40 * 60_000);
  assert.equal(level(p, core.Skill.STRENGTH), 40);
  p.getTimers().cancel(core.TimerKey.POTION);
  fight(p, monster(25));
  potions.tick(brain, 100_000 + 41 * 60_000);
  assert.equal(level(p, core.Skill.STRENGTH), 47, "worn off: the next fight gets a dose");
  assert.equal(p.getInventory().getAmount(Items.STRENGTH_POTION_2_), 1);
});

test("poisoned, it drinks an antipoison if it has one; after that it wants one in its kit", (t) => {
  const { world, ambition, potions } = worldWith();
  const p = botOfStyle(t, ambition, "melee", { coins: 50_000 });
  const brain = brainFor(p, world, "combat_training");
  ambition.consider(brain, 2000);
  assert.ok(!ambition.mind(p).goals.some((goal) => /ntipoison/.test(core.ItemDefinition.forId(goal.itemId).getName())), "nothing has poisoned it yet");
  p.setPoisonDamage(4);
  assert.equal(p.isPoisoned(), true);
  potions.tick(brain, 10_000);
  assert.equal(p.isPoisoned(), true, "it has nothing for it");
  ambition.consider(brain, 11_000);
  const cure = ambition.mind(p).goals.find((goal) => /ntipoison/.test(core.ItemDefinition.forId(goal.itemId).getName()));
  assert.ok(cure && cure.amount === 1, "now it wants one");
  p.getInventory().adds(Items.ANTIPOISON_3_, 1);
  potions.tick(brain, 20_000);
  assert.equal(p.isPoisoned(), false, "cured");
  assert.equal(p.getInventory().getAmount(Items.ANTIPOISON_2_), 1);
});

test("the world setting is on unless a world turns it off", () => {
  const PlayerBots = require("../plugins/bots/PlayerBots.plugin");
  assert.equal(PlayerBots.config["PlayerBots:potions"].default, true);
});
