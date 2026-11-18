// Ours. Run after `yarn build`: node --test tests/bot-ambition.test.cjs
// The levelling bots set themselves goals (plugins/bots/brain/Ambition.PlayerBots.js): the next
// tool, weapon, armour and level, steered to through their rotation and gone after on errands,
// with nothing handed to them. Real Players, real shops, the real brain and exchange book.
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
const Exchange = require("../plugins/bots/brain/actions/Exchange.PlayerBots");
const { createBotExchange, ORDER_MS } = require("../plugins/bots/brain/BotExchange.PlayerBots");
const { createBotActivityRegistry } = require("../plugins/bots/brain/ActivityRegistry.PlayerBots");
const { BotBrain } = require("../plugins/bots/brain/Brain.PlayerBots");

let core;
let Items;
let registry;
let site;
let keeperNear = null;
let names = 0;
const BOB = 10619; // Bob's Brilliant Axes, Lumbridge.
const CROWD = { id: "ambitioncrowd", enabled: true, progression: true, x: 3222, y: 3219,
  bots: { woodcutting: 30, mining: 20, fishing: 10, combat_training: 40, agility: 5, trading: 5 } };

/** A world of the test's own: the real engine, the NPCs near a bot ours to place, and a bank at the bot's elbow. */
function worldWith({ clock = { now: 1_000_000 }, errandsAtOnce = null } = {}) {
  const logged = [];
  const world = {
    core: { ...core, World: Object.assign(Object.create(core.World), { getNpcsNear: () => (keeperNear ? [keeperNear] : []) }) },
    log: (event, data) => logged.push([event, data]),
  };
  const book = createBotExchange({ guide: Exchange.guide, now: () => clock.now });
  world.ambition = Ambition.createAmbition({ world, exchange: book, errandsAtOnce });
  // The walk to a bank is the Bank action's (tried in the live trial); here the booth is where the bot stands.
  OwnItems.ownItemsFor(world).bankTrip = (ctx, key, plan) => {
    const inventory = ctx.player.getInventory();
    const bank = ctx.player.getBank(0);
    for (const item of [...inventory.getItems()]) {
      if (!item || item.getId() <= 0 || !plan.keep || plan.keep(item.getId())) continue;
      const itemId = item.getId();
      const amount = inventory.getAmount(itemId);
      inventory.deleteNumber(itemId, amount);
      bank.adds(itemId, amount);
    }
    for (const entry of typeof plan.withdraw === "function" ? plan.withdraw(ctx.player) : plan.withdraw ?? []) {
      const amount = Math.min(entry.amount, bank.getAmount(entry.itemId));
      if (amount <= 0) continue;
      bank.deleteNumber(entry.itemId, amount);
      inventory.adds(entry.itemId, amount);
    }
    return "success";
  };
  return { world, logged, book, clock, ambition: world.ambition };
}

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  require("../plugins/items/ItemDefinitionLoader.plugin").register({ log() {}, onPlayerLogin() {}, registerContentEndpoint() {} });
  core = PluginManager.getCoreApi();
  Items = core.ItemIdentifiers;
  require("../plugins/items/Food.plugin").register(PluginManager.createApi("BotAmbitionTest"));
  assert.equal(new (require("../dist/game/definition/loader/impl/ShopDefinitionLoader").ShopDefinitionLoader)().load(), true, "the server's shops");
  core.ShopManager.initialize();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bot-sites-")), "bot-sites.json");
  fs.writeFileSync(file, JSON.stringify({ sites: [CROWD], pvp: { botPool: 0, activeRegionBotsPerRegion: 0 } }));
  registry = createBotActivityRegistry({ world: { core }, sitesPath: file });
  site = registry.getSite(CROWD.id);
});

function bot(t, { earns = true, kit = true, coins = 0 } = {}) {
  const p = new Player(null);
  p.getSession = () => ({ sendClientPacket: () => true, write: () => true });
  p.setUsername(`ambition${++names}`);
  p.sendMessage = () => {};
  p.isPlayerBot = () => true;
  t.after(() => core.TaskManager.cancelTasks(p));
  OwnItems.setEarnsOwnItems(p, earns);
  if (kit) StarterKit.giveToBot(p);
  if (coins) p.getInventory().adds(Items.COINS, coins);
  return p;
}

/** A bot whose combat style is `style` (each is drawn one for good, by its name). */
function botOfStyle(t, ambition, style, options) {
  for (let tries = 0; tries < 200; tries++) {
    const p = bot(t, options);
    if (ambition.kit().preferredStyle(p) === style) return p;
  }
  throw new Error(`no ${style} bot drawn`);
}

/** The bot's brain as the site spawner makes it: the crowd's rotation, at work on `activityId`. */
function brainFor(player, world, activityId = "normal_trees", nowMs = 1000) {
  const brain = new BotBrain({ player, state: {}, registry, world, activity: registry.byId.get(activityId), rotation: site.rotation, nowMs });
  brain.frames[0].state = "running";
  return brain;
}

const setLevel = (player, skill, level) => player.getSkillManager().setCurrentLevel(skill, level, false).setMaxLevels(skill, level, false)
  .setExperience(skill, core.SkillManager.getExperienceForLevel(level));
const wornIn = (player, slot) => player.getEquipment().getItems()[slot]?.getId?.() ?? -1;
const keeper = (npcId, at) => ({ getDefinition: () => ({ getId: () => npcId }), isRegistered: () => true, getLocation: () => at });
const keys = (goals) => goals.map((goal) => goal.key);
/** Everything the bot owns, valued in coins as a shop values it: buying moves it about, it does not add to it. */
const coinsOf = (player) => OwnItems.purse(player);

test("a new bot wants the next tool, a better weapon and armour, and the level that unlocks something", (t) => {
  const { world, ambition, logged } = worldWith();
  const p = botOfStyle(t, ambition, "melee");
  const brain = brainFor(p, world);
  ambition.consider(brain, 2000);
  const mind = ambition.mind(p);
  assert.ok(keys(mind.goals).includes(`tool:${Items.IRON_AXE}`), "the axe above its bronze one that Woodcutting 1 can use");
  assert.ok(keys(mind.goals).includes(`tool:${Items.IRON_PICKAXE}`));
  assert.equal(mind.goals[0].key, `tool:${Items.IRON_AXE}`, "the tool of the work it is at comes first");
  assert.ok(mind.goals.some((goal) => goal.kind === "weapon"), "a better weapon than its bronze sword");
  assert.ok(mind.goals.some((goal) => goal.kind === "armour" && goal.slot === core.Equipment.BODY_SLOT), "it wears no body armour");
  for (const goal of mind.goals) {
    assert.ok(goal.cost > 0 && (goal.source === "shop" || goal.source === "exchange"), `${goal.key} has a price and a place to buy it`);
    assert.equal(ambition.holdings(p).owns(goal.itemId), false, `${goal.key} is not something it has`);
  }
  // 25 coins in its bank: the iron axe (56) is what it saves for, and that is its wish.
  assert.equal(mind.saving.itemId, Items.IRON_AXE);
  assert.equal(brain.state.ownWish.itemId, Items.IRON_AXE);
  assert.equal(OwnItems.ownItemsFor(world).wishing(p, brain.state, 3000), true, "so it sells what it gathers");
  const levels = Object.fromEntries(mind.levels.map((goal) => [goal.skill.getName(), goal]));
  assert.equal(levels.Woodcutting.level, 6, "the steel axe");
  assert.equal(levels.Fishing.level, 20);
  assert.equal(levels.Fishing.unlocks, "fly_fishing");
  assert.equal(levels.Attack.level, 5);
  assert.ok(levels.Attack.toGo > 0);
  assert.ok(mind.focus && mind.levels.some((goal) => goal.key === mind.focus.key), "one of them is the level it goes after");
  assert.equal(logged.filter(([event]) => event === "bot_ambition_goals").length, 1);
  ambition.consider(brain, 3000);
  assert.equal(logged.filter(([event]) => event === "bot_ambition_goals").length, 1, "said once while nothing changes");
});

test("its goals follow its levels and what it owns", (t) => {
  const { world, ambition } = worldWith();
  const p = botOfStyle(t, ambition, "melee", { coins: 100_000 });
  const brain = brainFor(p, world);
  setLevel(p, core.Skill.WOODCUTTING, 41);
  setLevel(p, core.Skill.FISHING, 20);
  ambition.consider(brain, 2000);
  let mind = ambition.mind(p);
  assert.ok(keys(mind.goals).includes(`tool:${Items.RUNE_AXE}`), "the best axe Woodcutting 41 can use, since it can pay for it");
  assert.ok(keys(mind.goals).includes(`tool:${Items.FLY_FISHING_ROD}`), "the rod of the best fishing it can do");
  assert.ok(!keys(mind.goals).includes(`bait:${Items.FEATHER}`), "no bait before the rod");
  assert.equal(mind.levels.find((goal) => goal.skill === core.Skill.WOODCUTTING).level, 60, "yews (the dragon axe is 61)");
  p.getBank(0).adds(Items.RUNE_AXE, 1);
  p.getInventory().adds(Items.FLY_FISHING_ROD, 1);
  ambition.consider(brain, 3000);
  mind = ambition.mind(p);
  assert.ok(!mind.goals.some((goal) => goal.kind === "tool" && goal.mode === "woodcutting"), "an axe in its bank is an axe it has");
  const bait = mind.goals.find((goal) => goal.key === `bait:${Items.FEATHER}`);
  assert.ok(bait && bait.amount === 150 && bait.cost === 150 * bait.cost / bait.amount, "feathers for the rod, a good many at once");
  assert.equal(mind.saving, null, "nothing it cannot pay for");
  assert.equal(brain.state.ownWish ?? null, null);
});

test("what it can pay for at a shop it goes and buys, with its own coins, and puts on", (t) => {
  const { world, ambition, logged } = worldWith();
  // The coins are in its backpack: fetching them from its bank first is OwnItems' business.
  const p = botOfStyle(t, ambition, "melee", { coins: 60 });
  const brain = brainFor(p, world, "combat_training");
  const before = coinsOf(p);
  const errand = ambition.consider(brain, 2000);
  assert.equal(errand.kind, "buy");
  assert.equal(errand.goal.source, "shop");
  assert.ok(errand.goal.cost <= 60);
  // Run by the brain: the errand goes on top of its work, and the work goes on after.
  ambition.mind(p).thinkAt = 0;
  ambition.tick(brain, 3000);
  assert.deepEqual(brain.frames.map((frame) => frame.behaviour.id), ["combat_training", Ambition.ERRAND_ACTIVITY]);
  const sellers = OwnItems.loadOffers().offers.get(errand.goal.itemId).flatMap((entry) => entry.npcIds);
  keeperNear = keeper(sellers.includes(BOB) ? BOB : sellers[0], p.getLocation());
  t.after(() => { keeperNear = null; });
  for (let tick = 0; tick < 12 && brain.frames.length > 1; tick++) brain.tick(4000 + tick * 600);
  assert.deepEqual(brain.frames.map((frame) => frame.behaviour.id), ["combat_training"], "back at its work");
  if (errand.goal.kind === "tool") assert.equal(p.getInventory().getAmount(errand.goal.itemId), 1, "bought, and in its backpack");
  else assert.equal(wornIn(p, errand.goal.slot), errand.goal.itemId, "bought, and on");
  const paid = before - coinsOf(p);
  assert.ok(paid > 0 && paid <= errand.goal.cost * 1.5, `paid for with its coins (${paid})`);
  assert.ok(logged.some(([event, data]) => event === "bot_ambition_got" && data.from === "shop"));
  assert.ok(logged.some(([event, data]) => event === "bot_ambition_errand_done" && data.ok === true));
  // It rests before the next errand, however much it could still buy.
  p.getInventory().adds(Items.COINS, 5000);
  assert.equal(ambition.consider(brain, 10_000), null);
  assert.ok(ambition.consider(brain, 10_000 + 6 * 60_000), "and then goes on");
});

test("only so many of a world's bots are out on an errand at once; the rest work on and look again", (t) => {
  // The world lets one go at a time (PlayerBots:errandsAtOnce; 150 when a world does not say).
  const { world, ambition, logged } = worldWith({ errandsAtOnce: 1 });
  const first = botOfStyle(t, ambition, "melee", { coins: 60 });
  const second = botOfStyle(t, ambition, "melee", { coins: 60 });
  const one = brainFor(first, world, "combat_training");
  const two = brainFor(second, world, "combat_training");
  // Each has looked at itself once (which is when a bot gets its mind).
  ambition.consider(one, 2000);
  ambition.consider(two, 2000);
  ambition.mind(first).thinkAt = 0;
  ambition.tick(one, 3000);
  assert.deepEqual(one.frames.map((frame) => frame.behaviour.id), ["combat_training", Ambition.ERRAND_ACTIVITY]);

  // The second can pay for the same thing, but the first is out: it stays at its work.
  ambition.mind(second).thinkAt = 0;
  ambition.tick(two, 3000);
  assert.deepEqual(two.frames.map((frame) => frame.behaviour.id), ["combat_training"]);
  const again = ambition.mind(second).thinkAt - 3000;
  assert.ok(again >= 45_000 && again <= 150_000, `and looks again in a minute or two (${again} ms)`);
  assert.equal(logged.filter(([event]) => event === "bot_ambition_errand").length, 1);

  // The first comes back; now the second may go.
  const sellers = OwnItems.loadOffers().offers.get(ambition.mind(first).errand.goal.itemId).flatMap((entry) => entry.npcIds);
  keeperNear = keeper(sellers.includes(BOB) ? BOB : sellers[0], first.getLocation());
  t.after(() => { keeperNear = null; });
  for (let tick = 0; tick < 12 && one.frames.length > 1; tick++) one.tick(4000 + tick * 600);
  assert.deepEqual(one.frames.map((frame) => frame.behaviour.id), ["combat_training"], "the first is back at its work");
  ambition.mind(second).thinkAt = 0;
  ambition.tick(two, 200_000);
  assert.deepEqual(two.frames.map((frame) => frame.behaviour.id), ["combat_training", Ambition.ERRAND_ACTIVITY]);
});

test("a bot that set off on an errand and was never heard of again does not hold a place for good", (t) => {
  const { world, ambition } = worldWith({ errandsAtOnce: 1 });
  const lost = botOfStyle(t, ambition, "melee", { coins: 60 });
  const waiting = botOfStyle(t, ambition, "melee", { coins: 60 });
  const gone = brainFor(lost, world, "combat_training");
  const brain = brainFor(waiting, world, "combat_training");
  ambition.consider(gone, 2000);
  ambition.consider(brain, 2000);
  ambition.mind(lost).thinkAt = 0;
  ambition.tick(gone, 3000);
  assert.equal(gone.frames.length, 2, "it set off");
  ambition.mind(waiting).thinkAt = 0;
  ambition.tick(brain, 10 * 60_000);
  assert.equal(brain.frames.length, 1, "ten minutes on its place is still taken");
  ambition.mind(waiting).thinkAt = 0;
  ambition.tick(brain, 21 * 60_000);
  assert.deepEqual(brain.frames.map((frame) => frame.behaviour.id), ["combat_training", Ambition.ERRAND_ACTIVITY], "after twenty it is not");
});

test("a shop it could not buy at is left for the exchange", (t) => {
  const { world, ambition } = worldWith();
  const p = botOfStyle(t, ambition, "melee", { coins: 100 });
  const brain = brainFor(p, world);
  const errand = ambition.consider(brain, 2000);
  assert.equal(errand.goal.key, `tool:${Items.IRON_AXE}`);
  assert.equal(errand.goal.source, "shop");
  ambition.mind(p).thinkAt = 0;
  ambition.tick(brain, 3000);
  // No keeper anywhere near, and no route to one: the step fails.
  OwnItems.ownItemsFor(world).fetch = () => "failed";
  for (let tick = 0; tick < 5 && brain.frames.length > 1; tick++) brain.tick(4000 + tick * 600);
  assert.equal(brain.frames.length, 1);
  assert.equal(p.getInventory().getAmount(Items.IRON_AXE), 0, "and nothing appeared");
  ambition.consider(brain, 3000 + 21 * 60_000);
  const again = ambition.mind(p).goals.find((goal) => goal.kind === "tool" && goal.mode === "woodcutting");
  assert.equal(again.source, "exchange", "asked for at the exchange instead");
});

test("what no shop sells it bids for at the Grand Exchange, coins down, collects, and puts on", (t) => {
  const { world, ambition, book, clock, logged } = worldWith();
  const p = botOfStyle(t, ambition, "melee", { kit: false });
  setLevel(p, core.Skill.ATTACK, 40);
  setLevel(p, core.Skill.DEFENCE, 40);
  p.getInventory().adds(Items.BRONZE_SHORTSWORD, 1);
  const brain = brainFor(p, world, "combat_training");
  ambition.consider(brain, 2000);
  const wanted = ambition.mind(p).goals.find((goal) => goal.kind === "weapon");
  assert.ok(wanted.cost > 0, "it has no coins at all");
  assert.equal(ambition.mind(p).saving.key, wanted.key, "so the cheapest better weapon is what it saves for");
  // With coins enough for the best weapon of its levels (a rune one), that is the one it wants,
  // and no shop has it at the exchange's price.
  p.getInventory().adds(Items.COINS, 60_000);
  const errand = ambition.consider(brain, 3000);
  const weapon = ambition.mind(p).goals.find((goal) => goal.kind === "weapon");
  assert.ok(weapon.cost > wanted.cost);
  assert.equal(weapon.source, "exchange");
  const nearer = ambition.mind(p).goals.some((goal) => goal.cost <= 60_000 && goal.source === "shop");
  assert.equal(errand.kind, nearer ? "buy" : "exchange", "what a shop sells comes first: it is nearer");
  // Those bought (here: set aside), the exchange is next. The bot is put there: the walk is Exchange's own.
  for (const goal of ambition.mind(p).goals) if (goal.source === "shop") ambition.mind(p).cool.set(goal.key, Infinity);
  const visit = ambition.consider(brain, 4000);
  assert.equal(visit.kind, "exchange");
  assert.equal(visit.goal.key, weapon.key);
  p.setLocation(new core.Location(Exchange.EXCHANGE.x + 1, Exchange.EXCHANGE.y, 0));
  const beforeCoins = coinsOf(p);
  ambition.mind(p).errand = { ...visit, startedAt: 4000 };
  let result = "running";
  for (let tick = 0; tick < 5 && result === "running"; tick++) result = ambition.runErrand({ player: p, state: brain.state, world, brain, frame: {}, nowMs: 5000 + tick * 600 });
  assert.equal(result, "success");
  const orders = book.book().orders.filter((entry) => entry.bot === p.getUsername().toLowerCase());
  assert.ok(orders.some((entry) => entry.itemId === weapon.itemId), "a bid for the weapon");
  assert.ok(orders.length > 1, "and for the armour its coins still covered");
  const committed = orders.reduce((sum, entry) => sum + entry.remaining * entry.price, 0);
  assert.equal(beforeCoins - coinsOf(p), committed, "the coins left its purse as the bids went in");
  assert.equal(wornIn(p, core.Equipment.WEAPON_SLOT), -1, "nothing is in its hands yet");
  assert.ok(logged.some(([event]) => event === "bot_ambition_bid"));

  // The market fills the bids after a while; the bot goes back for what is due to it.
  ambition.stopErrand({ player: p });
  clock.now += ORDER_MS + 1;
  book.settle();
  assert.equal(book.hasDue(p.getUsername().toLowerCase()), true);
  assert.equal(ambition.consider(brain, 5000 + 6 * 60_000), null, "the exchange is a long walk: not again so soon");
  const back = ambition.consider(brain, 5000 + 13 * 60_000);
  assert.equal(back.kind, "exchange");
  ambition.mind(p).errand = { ...back, startedAt: 0 };
  result = "running";
  for (let tick = 0; tick < 8 && result === "running"; tick++) result = ambition.runErrand({ player: p, state: brain.state, world, brain, frame: {}, nowMs: 900_000 + tick * 600 });
  assert.equal(result, "success");
  assert.equal(wornIn(p, core.Equipment.WEAPON_SLOT), weapon.itemId, "collected to its bank, taken out and put on");
  for (const entry of orders) assert.ok(ambition.holdings(p).wearing.has(entry.itemId), `and item ${entry.itemId} it bid for with it`);
  assert.equal(book.hasDue(p.getUsername().toLowerCase()), false);
});

test("better kit lying in its bank is taken out and put on; its goods are left there for the exchange", (t) => {
  const { world, ambition } = worldWith();
  const p = botOfStyle(t, ambition, "melee");
  const brain = brainFor(p, world, "normal_trees");
  p.getBank(0).adds(Items.IRON_SCIMITAR, 1);
  p.getBank(0).adds(Items.RUNE_SCIMITAR, 1);
  p.getInventory().adds(Items.LOGS, 5);
  const errand = ambition.consider(brain, 2000);
  assert.equal(errand.kind, "wear");
  ambition.mind(p).errand = { ...errand, startedAt: 2000 };
  assert.equal(ambition.runErrand({ player: p, state: brain.state, world, frame: {}, nowMs: 3000 }), "success");
  assert.equal(wornIn(p, core.Equipment.WEAPON_SLOT), Items.IRON_SCIMITAR, "the iron one: a rune scimitar is not for Attack 1");
  assert.equal(OwnItems.banked(p, Items.RUNE_SCIMITAR), 1);
  assert.equal(OwnItems.banked(p, Items.LOGS), 5, "its logs stay at the bank");
  assert.equal(p.getInventory().getAmount(Items.BRONZE_AXE), 1, "its tools stay with it");
});

test("while it is out it makes a round of it: three stops at most, then back to work", (t) => {
  const { world, ambition, logged } = worldWith();
  const p = botOfStyle(t, ambition, "melee", { coins: 50_000 });
  const brain = brainFor(p, world);
  // Every shop is at its elbow and has what it asks for, at the price it reckoned.
  const bought = [];
  OwnItems.ownItemsFor(world).fetch = (ctx, need) => {
    const goal = ambition.mind(p).errand.goal;
    assert.equal(goal.itemId, need.itemId);
    p.getInventory().deleteNumber(Items.COINS, goal.cost);
    p.getInventory().adds(need.itemId, goal.amount);
    bought.push(need.itemId);
    return "success";
  };
  const errand = ambition.consider(brain, 2000);
  assert.equal(errand.kind, "buy");
  ambition.mind(p).errand = { ...errand, startedAt: 2000 };
  let result = "running";
  let ticks = 0;
  for (; ticks < 20 && result === "running"; ticks++) result = ambition.runErrand({ player: p, state: brain.state, world, brain, frame: {}, nowMs: 3000 + ticks * 600 });
  assert.equal(result, "success");
  assert.equal(bought.length, 3, "three things in one trip");
  assert.equal(new Set(bought).size, 3);
  assert.equal(logged.filter(([event]) => event === "bot_ambition_errand_done").length, 1, "one errand");
  assert.equal(ambition.consider(brain, 10_000), null, "and then it works for a while, though it could buy more");
  // A later stop that does not work out ends the round without undoing the first.
  const { world: other, ambition: second, logged: events } = worldWith();
  const q = botOfStyle(t, second, "melee", { coins: 50_000 });
  const brainQ = brainFor(q, other);
  let calls = 0;
  OwnItems.ownItemsFor(other).fetch = (ctx, need) => {
    if (++calls > 1) return "failed";
    q.getInventory().adds(need.itemId, 1);
    return "success";
  };
  second.mind(q) ?? second.consider(brainQ, 1000);
  second.mind(q).errand = { ...second.consider(brainQ, 2000), startedAt: 2000 };
  result = "running";
  for (ticks = 0; ticks < 20 && result === "running"; ticks++) result = second.runErrand({ player: q, state: brainQ.state, world: other, brain: brainQ, frame: {}, nowMs: 3000 + ticks * 600 });
  assert.equal(result, "success");
  assert.equal(calls, 2);
  assert.deepEqual(events.filter(([event]) => event === "bot_ambition_errand_done").map(([, data]) => data.ok), [true]);
});

test("its goods go to the exchange when it is saving for something, and not otherwise", (t) => {
  const { world, ambition } = worldWith();
  const p = botOfStyle(t, ambition, "melee");
  const brain = brainFor(p, world);
  for (const goal of (ambition.consider(brain, 2000), ambition.mind(p).goals)) if (goal.cost <= 25) ambition.mind(p).cool.set(goal.key, Infinity);
  assert.equal(ambition.consider(brain, 3000), null, "nothing to sell, nothing it can pay for");
  p.getBank(0).adds(Items.OAK_LOGS, 200);
  const errand = ambition.consider(brain, 4000);
  assert.equal(errand.kind, "exchange");
  assert.equal(errand.goal, null, "a visit to sell");
});

test("its next activity is drawn with its own weights", (t) => {
  const { world, ambition } = worldWith();
  const p = botOfStyle(t, ambition, "melee");
  const brain = brainFor(p, world);
  assert.equal(ambition.steer(brain, site.rotation.weights), null, "before its first look: the site's");
  assert.equal(brain.weights(), site.rotation.weights);
  ambition.consider(brain, 2000);
  const mind = ambition.mind(p);
  const steered = brain.weights();
  const factor = (id) => steered[id] / site.rotation.weights[id];
  // Saving for an iron axe: the work that earns weighs half as much again; the level it is after three times.
  const expected = (mode) => (["woodcutting", "mining", "fishing"].includes(mode) ? 1.5 : 1) * (mind.focus.mode === mode ? 3 : 1);
  for (const id of ["normal_trees", "copper_tin_rocks", "net_fishing", "combat_training", "draynor_rooftop"]) {
    assert.ok(Math.abs(factor(id) - expected(registry.byId.get(id).mode)) < 1e-9, `${id}: ${factor(id)}`);
  }
  assert.deepEqual(Object.keys(steered).sort(), Object.keys(site.rotation.weights).sort(), "every activity of the site still has a weight");
  // Hitpoints 30 and two bits of food: more fishing, less fighting, until it has a stock.
  setLevel(p, core.Skill.HITPOINTS, 30);
  ambition.consider(brain, 3000);
  assert.equal(ambition.mind(p).shortOfFood, true);
  assert.equal(ambition.mind(p).foodWanted, 20);
  const hungry = brain.weights();
  const focus = ambition.mind(p).focus.mode;
  assert.ok(Math.abs(hungry.net_fishing / site.rotation.weights.net_fishing - 1.5 * 2 * (focus === "fishing" ? 3 : 1)) < 1e-9);
  assert.ok(Math.abs(hungry.combat_training / site.rotation.weights.combat_training - 0.4 * (focus === "combat_training" ? 3 : 1)) < 1e-9);
  p.getBank(0).adds(Items.TROUT, 30);
  ambition.consider(brain, 4000);
  assert.equal(ambition.mind(p).shortOfFood, false);
});

test("the level it is after is kept for a while, and each bot has a bent of its own", (t) => {
  const { world, ambition } = worldWith();
  const focuses = new Set();
  for (let index = 0; index < 30; index++) {
    const p = bot(t);
    const brain = brainFor(p, world);
    ambition.consider(brain, 2000);
    const mind = ambition.mind(p);
    focuses.add(mind.focus.skill.getName());
    const first = mind.focus;
    ambition.consider(brain, 2000 + 10 * 60_000);
    assert.equal(ambition.mind(p).focus.key, first.key);
    assert.equal(ambition.mind(p).focus.since, 2000, "the same one, since then");
  }
  assert.ok(focuses.size >= 2, `a crowd does not all chase one skill (${[...focuses]})`);
});

test("it leaves its work for an errand only when it can: not from a fight, a lap, or its own errand", (t) => {
  const { world, ambition } = worldWith();
  const p = botOfStyle(t, ambition, "melee", { coins: 500 });
  const brain = brainFor(p, world);
  const combat = p.getCombat();
  const real = combat.getAttacker.bind(combat);
  combat.getAttacker = () => ({});
  ambition.consider(brain, 1500);
  ambition.mind(p).thinkAt = 0;
  ambition.tick(brain, 2000);
  assert.equal(brain.frames.length, 1, "in a fight");
  assert.ok(ambition.mind(p).thinkAt <= 2000 + 20_000, "asked again soon");
  combat.getAttacker = real;
  const action = brain.frames[0].action();
  action.holdsRotation = () => true;
  ambition.mind(p).thinkAt = 0;
  ambition.tick(brain, 30_000);
  assert.equal(brain.frames.length, 1, "half way round a course");
  delete action.holdsRotation;
  ambition.mind(p).thinkAt = 0;
  ambition.tick(brain, 60_000);
  assert.equal(brain.frames.length, 2, "now it goes");
  ambition.mind(p).thinkAt = 0;
  ambition.tick(brain, 61_000);
  assert.equal(brain.frames.length, 2, "one errand at a time");
  // Its rotation waits for the errand too.
  brain.switchAt = 61_500;
  brain.maybeSwitchActivity(62_000);
  assert.equal(brain.frames[0].behaviour.id, "normal_trees");
});

test("a fault in a bot's wants never costs it its work", (t) => {
  const { world, ambition, logged } = worldWith();
  const p = botOfStyle(t, ambition, "melee", { coins: 500 });
  const brain = brainFor(p, world);
  ambition.consider(brain, 1000);
  ambition.addProvider(() => { throw new Error("a part of the bots that has gone wrong"); });
  ambition.mind(p).thinkAt = 0;
  assert.doesNotThrow(() => ambition.tick(brain, 2000));
  assert.equal(brain.frames.length, 1, "it stays at its work");
  const faults = () => logged.filter(([event]) => event === "bot_ambition_fault");
  assert.equal(faults().length, 1);
  assert.match(faults()[0][1].error, /gone wrong/);
  assert.ok(ambition.mind(p).thinkAt >= 2000 + 10 * 60_000, "and is not asked again for a while");
  ambition.addTicker(() => { throw new Error("every tick"); });
  for (let at = 3000; at < 60_000; at += 600) assert.doesNotThrow(() => ambition.tick(brain, at));
  assert.equal(faults().length, 1, "said once, not every tick");
});

test("where it stands in the crowd is its total level against the others'", (t) => {
  const { world, ambition } = worldWith();
  const [a, b, c] = [bot(t), bot(t), bot(t)];
  setLevel(b, core.Skill.MINING, 40);
  setLevel(c, core.Skill.MINING, 20);
  for (const p of [a, b, c]) ambition.consider(brainFor(p, world), 2000);
  assert.equal(ambition.standing(b).rank, 1);
  assert.equal(ambition.standing(b).ahead, null);
  assert.deepEqual({ rank: ambition.standing(a).rank, of: ambition.standing(a).of, ahead: ambition.standing(a).ahead },
    { rank: 3, of: 3, ahead: c.getUsername().toLowerCase() });
});

test("only the levelling bots that own what they use have a mind of their own", (t) => {
  const { world, ambition } = worldWith();
  const handed = bot(t, { earns: false, kit: false });
  const brain = brainFor(handed, world);
  ambition.tick(brain, 5_000_000);
  assert.equal(ambition.mind(handed), null);
  assert.equal(brain.weights(), site.rotation.weights);
  // A bot of an ordinary site (no progression rotation) is never asked.
  const p = bot(t);
  const plain = new BotBrain({ player: p, state: {}, registry, world, activity: registry.byId.get("normal_trees"),
    rotation: { activityIds: ["normal_trees", "oak_trees"], weights: { normal_trees: 1 }, switchAfterMs: { min: 1, max: 2 } }, nowMs: 1000 });
  assert.equal(plain.ambition(), null);
  const wild = new BotBrain({ player: p, state: {}, registry, world, activity: registry.byId.get("roam"), nowMs: 1000 });
  assert.equal(wild.ambition(), null);
  // And a world without the setting has none to give.
  const bare = new BotBrain({ player: p, state: {}, registry, world: { core }, activity: registry.byId.get("normal_trees"), rotation: site.rotation, nowMs: 1000 });
  assert.equal(bare.ambition(), null);
  assert.equal(bare.weights(), site.rotation.weights);
});

test("the world setting is on unless a world turns it off", () => {
  assert.equal(Ambition.worldHasAmbition(), true);
  const PlayerBots = require("../plugins/bots/PlayerBots.plugin");
  assert.equal(PlayerBots.config[Ambition.AMBITION_CONFIG].default, true);
  assert.ok(registry.byId.get(Ambition.ERRAND_ACTIVITY).manual, "an errand is never drawn from the rotation");
  assert.ok(!site.rotation.activityIds.includes(Ambition.ERRAND_ACTIVITY));
});
