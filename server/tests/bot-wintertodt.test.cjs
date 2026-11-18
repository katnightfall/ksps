// Ours. Run after `yarn build`: node --test tests/bot-wintertodt.test.cjs
// A group of levelling bots goes to the Wintertodt (plugins/bots/brain/BotWintertodt.PlayerBots.js):
// who may come, the packing, the voyage there and back, the corners they take, and a bot never
// left stranded across the sea. The rounds themselves are the minigame's own rules and were
// tried in a live trial.
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
const Groups = require("../plugins/bots/brain/BotGroups.PlayerBots");
const Talk = require("../plugins/bots/brain/BotTalk.PlayerBots");
const Wintertodt = require("../plugins/bots/brain/BotWintertodt.PlayerBots");
const { createChooseAction } = require("../plugins/bots/brain/actions/Choose.PlayerBots");
const { createBotActivityRegistry } = require("../plugins/bots/brain/ActivityRegistry.PlayerBots");
const { BotBrain } = require("../plugins/bots/brain/Brain.PlayerBots");

let core;
let Items;
let registry;
let site;
let names = 0;
const CROWD = { id: "todtcrowd", enabled: true, progression: true, x: 3222, y: 3219,
  bots: { woodcutting: 30, mining: 20, fishing: 10, combat_training: 40 } };
const HOME = [3222, 3219, 0];

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  require("../plugins/items/ItemDefinitionLoader.plugin").register({ log() {}, onPlayerLogin() {}, registerContentEndpoint() {} });
  core = PluginManager.getCoreApi();
  Items = core.ItemIdentifiers;
  require("../plugins/items/Food.plugin").register(PluginManager.createApi("BotWintertodtTest"));
  assert.equal(new (require("../dist/game/definition/loader/impl/ShopDefinitionLoader").ShopDefinitionLoader)().load(), true, "the server's shops");
  core.ShopManager.initialize();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bot-sites-")), "bot-sites.json");
  fs.writeFileSync(file, JSON.stringify({ sites: [CROWD], pvp: { botPool: 0, activeRegionBotsPerRegion: 0 } }));
  registry = createBotActivityRegistry({ world: { core }, sitesPath: file });
  site = registry.getSite(CROWD.id);
});

/** A world whose only outing is the Wintertodt, with the ferries answering as the game's do. */
function worldWith() {
  const logged = [];
  const sailed = [];
  // The doors' question, as the game holds it for a player until an answer is clicked.
  const asked = { title: null, answers: [] };
  const prompts = {
    OPTIONS_WIDGET_ID: core.MultiChatboxPrompt.OPTIONS_WIDGET_ID,
    getPending: () => (asked.title ? { title: asked.title, options: [] } : null),
    handleInterfaceActionClick: (event) => {
      asked.answers.push(event.slot);
      asked.title = null;
      return true;
    },
  };
  // Everyone standing in it (the bots, and any person a test adds), and every line said in public chat.
  const everyone = [];
  const said = [];
  const world = {
    core: {
      ...core, MultiChatboxPrompt: prompts,
      World: Object.assign(Object.create(core.World), { getNearbyPlayersForUpdate: () => everyone }),
      ChatPacketListener: { handleText: (player, text) => said.push([player.getUsername(), text]) },
    },
    log: (event, data) => logged.push([event, data]), regionManager: { loadMapFiles() {} },
  };
  const runtime = { entriesByUsername: new Map() };
  const talk = Talk.createBotTalk({ world, enabled: () => true, random: () => 0 });
  world.ambition = Ambition.createAmbition({ world });
  const outings = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bot-groups-")), "bot-groups.json");
  const shipped = Groups.loadOutings(path.resolve(__dirname, "../data/definitions/bot-groups.json")).filter((outing) => outing.kind === Wintertodt.KIND);
  assert.equal(shipped.length, 1, "the Wintertodt is one of the shipped outings");
  fs.writeFileSync(outings, JSON.stringify({ outings: shipped }));
  world.groups = Groups.createBotGroups({ world, runtime, registry, ambition: world.ambition, talk, definitionsPath: outings, random: () => 0, minutes: [30, 90] });
  world.wintertodt = Wintertodt.createBotWintertodt({
    world, groups: world.groups, registry, ambition: world.ambition,
    emit: (name, request) => {
      sailed.push([name, request.route]);
      request.handled = true;
    },
  });
  // The booth is where the bot stands.
  OwnItems.ownItemsFor(world).bankTrip = (ctx, key, plan) => {
    const inventory = ctx.player.getInventory();
    const bank = ctx.player.getBank(0);
    for (const item of [...inventory.getItems()]) {
      const itemId = item?.getId?.() ?? -1;
      if (itemId <= 0 || plan.keep(itemId)) continue;
      const amount = inventory.getAmount(itemId);
      inventory.deleteNumber(itemId, amount);
      bank.adds(itemId, amount);
    }
    for (const entry of plan.withdraw(ctx.player)) {
      const amount = Math.min(entry.amount, bank.getAmount(entry.itemId));
      if (amount <= 0) continue;
      bank.deleteNumber(entry.itemId, amount);
      inventory.adds(entry.itemId, amount);
    }
    return "success";
  };
  const worker = (t, { at = HOME, firemaking = 60, trout = 20 } = {}) => {
    const p = new Player(null);
    p.getSession = () => ({ sendClientPacket: () => true, write: () => true });
    p.setUsername(`todtbot${++names}`);
    p.sendMessage = () => {};
    p.isPlayerBot = () => true;
    p.setLocation(new core.Location(at[0], at[1], at[2] ?? 0));
    t.after(() => core.TaskManager.cancelTasks(p));
    OwnItems.setEarnsOwnItems(p, true);
    StarterKit.giveToBot(p);
    p.getSkillManager().setCurrentLevel(core.Skill.FIREMAKING, firemaking, false).setMaxLevels(core.Skill.FIREMAKING, firemaking, false);
    if (trout) p.getBank(0).adds(Items.TROUT, trout);
    const brain = new BotBrain({ player: p, state: {}, registry, world, activity: registry.byId.get("normal_trees"), rotation: site.rotation, nowMs: 1000 });
    brain.frames[0].state = "running";
    runtime.entriesByUsername.set(p.getUsername(), { player: p, brain });
    everyone.push(p);
    return { p, brain };
  };
  /** Someone playing the game, standing where they can read what the bots say. */
  const person = (t, at = HOME) => {
    const p = new Player(null);
    p.getSession = () => ({ sendClientPacket: () => true, write: () => true });
    p.setUsername(`todtperson${++names}`);
    p.isPlayerBot = () => false;
    p.setLocation(new core.Location(at[0], at[1], at[2] ?? 0));
    t.after(() => core.TaskManager.cancelTasks(p));
    everyone.push(p);
    return p;
  };
  const ctx = (who, nowMs) => ({ player: who.p, state: who.brain.state, world, brain: who.brain, frame: {}, nowMs });
  return { world, logged, sailed, asked, said, worker, person, ctx, groups: world.groups, trip: world.wintertodt, ambition: world.ambition };
}

test("who may come: the Firemaking the doors ask for, an axe, and food that warms", (t) => {
  const { worker, trip, groups } = worldWith();
  const ready = worker(t);
  assert.equal(trip.eligible(ready.p), true);
  assert.equal(trip.warms(Items.TROUT), true);
  assert.equal(trip.warms(Items.SHRIMPS), false, "the minigame's rule: food healing 4 or more");
  const hungry = worker(t, { trout: 3 });
  assert.equal(trip.eligible(hungry.p), false, "three trout, its bread and its shrimps will not see a round out");
  const noAxe = worker(t);
  noAxe.p.getInventory().deleteNumber(Items.BRONZE_AXE, 1);
  assert.equal(trip.eligible(noAxe.p), false);
  noAxe.p.getBank(0).adds(Items.IRON_AXE, 1);
  assert.equal(trip.eligible(noAxe.p), true, "an axe in its bank is an axe it has");
  // Below 50 Firemaking the outing is not one it could go on, so it never proposes it.
  const novice = worker(t, { firemaking: 49 });
  assert.equal(groups.propose(novice.brain, 5000), null);
  assert.ok(groups.propose(ready.brain, 5000), "one that could, does");
});

test("a party sets off on the trip: each packs its own food, axe and tinderbox and makes for Veos", (t) => {
  const { worker, ctx, groups, trip, logged, ambition } = worldWith();
  const a = worker(t);
  const b = worker(t, { at: [HOME[0] + 2, HOME[1], 0] });
  const cold = worker(t, { at: [HOME[0] - 2, HOME[1], 0], firemaking: 30 });
  const party = groups.propose(a.brain, 10_000);
  assert.equal(party.outing.id, "wintertodt");
  groups.tick(a.brain, 13_000);
  groups.tick(a.brain, 26_000);
  assert.equal(party.phase, "travelling");
  assert.deepEqual([...party.members], [a.p, b.p], "not the one without the Firemaking");
  for (const member of [a, b]) {
    assert.deepEqual(member.brain.frames.map((frame) => frame.behaviour.id), [Wintertodt.TRIP_ACTIVITY]);
    assert.equal(trip.phaseOf(member.p), "pack");
    assert.ok(member.brain.switchAt > 26_000 + 60 * 60_000, "its rotation waits for the trip");
  }
  assert.equal(cold.brain.frames[0].behaviour.id, "normal_trees");
  assert.ok(party.corner >= 0 && party.corner <= 3, "one corner for the whole group");
  // On the trip it is left to it: no errand of its own, and no other party.
  a.p.getInventory().adds(Items.COINS, 5000);
  ambition.consider(a.brain, 26_500);
  ambition.mind(a.p).thinkAt = 0;
  ambition.mind(a.p).errandAfter = 0;
  ambition.tick(a.brain, 26_600);
  assert.equal(a.brain.frames.length, 1, "it could buy a better axe, but not from here");
  assert.equal(ambition.free(a.brain, 26_700), false);
  assert.equal(trip.eligible(a.p), false, "nor is it asked along on another trip");
  a.p.getInventory().adds(Items.LOGS, 6);
  assert.equal(trip.step(ctx(a, 27_000)), "running");
  assert.equal(trip.phaseOf(a.p), "sarim");
  assert.equal(a.p.getInventory().getAmount(Items.TROUT), 11, "food for the cold from its own bank: twelve with its bread");
  assert.equal(a.p.getInventory().getAmount(Items.BREAD), 1);
  assert.equal(OwnItems.banked(a.p, Items.TROUT), 9);
  assert.equal(a.p.getInventory().getAmount(Items.BRONZE_AXE), 1);
  assert.equal(a.p.getInventory().getAmount(Items.TINDERBOX), 1);
  assert.equal(a.p.getInventory().getAmount(Items.LOGS), 0, "its goods stay at the bank");
  assert.equal(a.p.getInventory().getAmount(Items.BRONZE_PICKAXE), 0, "and so does what the trip has no use for");
  assert.ok(logged.some(([event]) => event === "bot_wintertodt_trip"));
});

test("with a person there to read it the trip is proposed out loud, and those who come say so", (t) => {
  const { worker, person, groups, said } = worldWith();
  const a = worker(t);
  const b = worker(t, { at: [HOME[0] + 2, HOME[1], 0] });
  person(t, [HOME[0] + 3, HOME[1] + 3, 0]);
  const party = groups.propose(a.brain, 10_000);
  assert.deepEqual(said, [[a.p.getUsername(), "anyone want to do wintertodt?"]]);
  groups.tick(a.brain, 13_000);
  groups.tick(a.brain, 26_000);
  assert.equal(party.phase, "travelling");
  assert.deepEqual(said.slice(1), [[b.p.getUsername(), "me"], [a.p.getUsername(), "ok lets go"]]);
});

test("it takes Veos's ship both ways, and the trip ends back on the mainland", (t) => {
  const { worker, ctx, trip, sailed } = worldWith();
  const a = worker(t);
  trip.begin(a.p, "sarim");
  // On the Port Sarim dock beside Veos: aboard.
  a.p.setLocation(new core.Location(3054, 3246, 0));
  assert.equal(trip.step(ctx(a, 10_000)), "running");
  assert.deepEqual(sailed, [["ferries:travel", "kourend-piscarilius"]]);
  assert.equal(trip.phaseOf(a.p), "sarim", "at sea");
  // The ship puts it down on its deck at Port Piscarilius; over the gangplank it is ashore.
  a.p.setLocation(new core.Location(1824, 3695, 1));
  assert.equal(trip.step(ctx(a, 20_000)), "running");
  assert.equal(trip.phaseOf(a.p), "ashore");
  a.p.setLocation(new core.Location(1824, 3691, 0));
  assert.equal(trip.step(ctx(a, 30_000)), "running");
  assert.equal(trip.phaseOf(a.p), "camp");
  // Home again: to Veos on the Piscarilius dock, his ship, the Port Sarim deck, the dock.
  trip.begin(a.p, "home");
  a.p.setLocation(new core.Location(1825, 3692, 0));
  assert.equal(trip.step(ctx(a, 40_000)), "running");
  assert.deepEqual(sailed[1], ["ferries:travel", "kourend-sarim"]);
  a.p.setLocation(new core.Location(3055, 3242, 1));
  assert.equal(trip.step(ctx(a, 50_000)), "running");
  assert.equal(trip.phaseOf(a.p), "landed");
  a.p.setLocation(new core.Location(3048, 3236, 0));
  assert.equal(trip.step(ctx(a, 60_000)), "success");
  assert.equal(trip.phaseOf(a.p), null);
});

test("a ship that does not sail, or too little food, ends the trip where it is safe to", (t) => {
  const { worker, ctx, trip, world } = worldWith();
  const a = worker(t, { trout: 0 });
  trip.begin(a.p, "pack");
  assert.equal(trip.step(ctx(a, 10_000)), "failed", "nothing warm to eat: it stays at home");
  // Refused at the dock on the mainland: back to work. Given up in Kourend: home first.
  const b = worker(t);
  const refusing = Wintertodt.createBotWintertodt({ world, groups: world.groups, registry, emit: () => {} });
  refusing.begin(b.p, "sarim");
  b.p.setLocation(new core.Location(3054, 3246, 0));
  assert.equal(refusing.step(ctx(b, 10_000)), "failed");
  const c = worker(t);
  trip.begin(c.p, "enter");
  c.p.setLocation(new core.Location(1700, 3800, 0));
  let result = "running";
  for (let at = 10_000; at < 10_000 + 4 * 60_000 && trip.phaseOf(c.p) === "enter"; at += 5_000) result = trip.step(ctx(c, at));
  assert.equal(result, "running");
  assert.equal(trip.phaseOf(c.p), "home", "stuck on the way to the doors: it turns for the ship");
});

test("leaving in the middle of a round, it answers the doors' question as a player would", (t) => {
  const { worker, ctx, trip, asked } = worldWith();
  const a = worker(t);
  trip.begin(a.p, "leave");
  // Behind the doors, which have just asked.
  a.p.setLocation(new core.Location(1630, 3980, 0));
  asked.title = "Are you sure you want to leave?";
  assert.equal(trip.step(ctx(a, 10_000)), "running");
  assert.deepEqual(asked.answers, [1], "the first answer: leave and lose all progress");
  assert.equal(trip.phaseOf(a.p), "leave", "until the doors have put it outside");
  a.p.setLocation(new core.Location(1630, 3956, 0));
  assert.equal(trip.step(ctx(a, 20_000)), "running");
  assert.equal(trip.phaseOf(a.p), "home", "nothing owed to it at the cart: for the ship");
});

test("a world may turn the Wintertodt off, and only so many go at once", () => {
  const PlayerBots = require("../plugins/bots/PlayerBots.plugin");
  assert.equal(PlayerBots.config["PlayerBots:wintertodt"].default, true);
  assert.equal(registry.byId.get(Wintertodt.TRIP_ACTIVITY).capacity, 40, "the trip has room for forty of a world's bots");
  // Turned off, the outing is one no bot could go on: its kind is not known to the groups.
  const logged = [];
  const world = { core, log: (event, data) => logged.push([event, data]) };
  world.ambition = Ambition.createAmbition({ world });
  const runtime = { entriesByUsername: new Map() };
  const groups = Groups.createBotGroups({ world, runtime, registry, ambition: world.ambition, random: () => 0, minutes: [30, 90] });
  world.wintertodt = Wintertodt.createBotWintertodt({ world, groups, registry, ambition: world.ambition, emit() {}, goes: false });
  assert.ok(groups.outings.some((outing) => outing.kind === Wintertodt.KIND));
  const p = new Player(null);
  p.getSession = () => ({ sendClientPacket: () => true, write: () => true });
  p.setUsername("todtoff");
  p.isPlayerBot = () => true;
  OwnItems.setEarnsOwnItems(p, true);
  StarterKit.giveToBot(p);
  for (const skill of [core.Skill.FIREMAKING, core.Skill.WOODCUTTING, core.Skill.MINING, core.Skill.FISHING]) p.getSkillManager().setCurrentLevel(skill, 60, false).setMaxLevels(skill, 60, false);
  p.getBank(0).adds(Items.TROUT, 30);
  const brain = new BotBrain({ player: p, state: {}, registry, world, activity: registry.byId.get("normal_trees"), rotation: site.rotation, nowMs: 1000 });
  for (let round = 0; round < 40; round++) {
    const party = groups.propose(brain, 10_000 + round * 100_000);
    assert.notEqual(party?.outing.kind, Wintertodt.KIND);
    if (party) groups.leave(party, p);
  }
  world.ambition.consider(brain, 5_000_000);
  assert.equal(world.ambition.mind(p).levels.some((goal) => goal.unlocks === Wintertodt.KIND), false, "nor is its Firemaking a level worth going after");
  // One that was over there when the world turned it off is still brought home.
  p.setLocation(new core.Location(1640, 3940, 0));
  brain.frames[0].state = "running";
  world.wintertodt.tick(brain, 6_000_000);
  assert.deepEqual(brain.frames.map((frame) => frame.behaviour.id), [Wintertodt.TRIP_ACTIVITY]);
  assert.equal(world.wintertodt.phaseOf(p), "home");
});

test("a bot found across the sea with no trip under way is sent home", (t) => {
  const { worker, trip, logged } = worldWith();
  const lost = worker(t, { at: [1640, 3940, 0], firemaking: 55 });
  const atHome = worker(t);
  trip.tick(atHome.brain, 100_000);
  assert.equal(atHome.brain.frames[0].behaviour.id, "normal_trees");
  assert.equal(Wintertodt.inKourend(lost.p.getLocation()), true);
  assert.equal(Wintertodt.inKourend(atHome.p.getLocation()), false);
  trip.tick(lost.brain, 100_000);
  assert.deepEqual(lost.brain.frames.map((frame) => frame.behaviour.id), [Wintertodt.TRIP_ACTIVITY]);
  assert.equal(trip.phaseOf(lost.p), "home");
  assert.ok(logged.some(([event]) => event === "bot_wintertodt_stranded"));
  trip.tick(lost.brain, 200_000);
  assert.equal(lost.brain.frames.length, 1, "once");
});

test("the gangplank at home is crossed however long ago the one on the way out was", (t) => {
  const { worker, ctx, trip } = worldWith();
  const a = worker(t);
  // Out: on Veos's deck at Port Piscarilius, then ashore.
  trip.begin(a.p, "ashore");
  a.p.setLocation(new core.Location(1824, 3695, 1));
  assert.equal(trip.step(ctx(a, 10_000)), "running");
  a.p.setLocation(new core.Location(1824, 3691, 0));
  assert.equal(trip.step(ctx(a, 20_000)), "running");
  assert.equal(trip.phaseOf(a.p), "camp");
  // Half an hour on it stands on the Port Piscarilius dock again, gone no further: for home.
  let at = 30 * 60_000;
  for (; trip.phaseOf(a.p) === "camp" && at < 40 * 60_000; at += 5_000) trip.step(ctx(a, at));
  assert.equal(trip.phaseOf(a.p), "home");
  assert.equal(trip.holds(a.p), true, "its rotation waits while it is across the sea");
  a.p.setLocation(new core.Location(1825, 3692, 0));
  assert.equal(trip.step(ctx(a, at += 5_000)), "running");
  a.p.setLocation(new core.Location(3055, 3242, 1));
  assert.equal(trip.step(ctx(a, at += 5_000)), "running", "the deck at Port Sarim is not one it has stood on too long");
  assert.equal(trip.phaseOf(a.p), "landed");
  assert.equal(trip.holds(a.p), false);
  a.p.setLocation(new core.Location(3048, 3236, 0));
  assert.equal(trip.step(ctx(a, at += 5_000)), "success");
});

test("a bot left on Veos's deck at Port Sarim with no trip under way is taken ashore", (t) => {
  const { worker, ctx, trip } = worldWith();
  const aboard = worker(t, { at: [3055, 3242, 1] });
  const upstairs = worker(t, { at: [3208, 3220, 1] });
  trip.tick(upstairs.brain, 100_000);
  assert.equal(upstairs.brain.frames[0].behaviour.id, "normal_trees", "a floor up somewhere else is not his deck");
  trip.tick(aboard.brain, 100_000);
  assert.deepEqual(aboard.brain.frames.map((frame) => frame.behaviour.id), [Wintertodt.TRIP_ACTIVITY]);
  assert.equal(trip.phaseOf(aboard.p), "landed");
  aboard.p.setLocation(new core.Location(3048, 3236, 0));
  assert.equal(trip.step(ctx(aboard, 110_000)), "success");
});

test("behind the doors each takes a corner of its own while there are corners to go round", (t) => {
  const { worker, ctx, trip, logged } = worldWith();
  const names = ["south-west", "north-west", "north-east", "south-east"];
  const corners = [];
  for (let n = 0; n < 5; n++) {
    const bot = worker(t);
    trip.begin(bot.p, "enter", { partyCorner: 2 });
    bot.p.setLocation(new core.Location(1629 + (n % 3), 3980, 0));
    assert.equal(trip.step(ctx(bot, 10_000 + n * 1000)), "running");
    assert.equal(trip.phaseOf(bot.p), "play");
    corners.push(logged.filter(([event]) => event === "bot_wintertodt_entered").at(-1)[1].corner);
  }
  assert.equal(corners[0], "north-east", "the group's corner first");
  assert.deepEqual([...corners.slice(0, 4)].sort(), [...names].sort(), "then one each");
  assert.equal(corners[4], "north-east", "and a fifth doubles up, at the group's");
});

test("it stays for its rounds, and goes after one that earned it a crate when its food is low", (t) => {
  const Round = require("../plugins/minigames/wintertodt/Round.Wintertodt");
  const { worker, ctx, trip, logged } = worldWith();
  t.after(() => {
    Round._round.active = false;
    Round._round.points.clear();
  });
  const fed = worker(t);
  const hungry = worker(t);
  fed.p.getInventory().adds(Items.TROUT, 8);
  for (const [n, bot] of [fed, hungry].entries()) {
    trip.begin(bot.p, "enter");
    bot.p.setLocation(new core.Location(1629 + n, 3980, 0));
    assert.equal(trip.step(ctx(bot, 10_000)), "running");
  }
  // A round is under way, and both have done enough in it for a crate.
  Round._round.active = true;
  for (const bot of [fed, hungry]) {
    Round._round.points.set(bot.p, 620);
    assert.equal(trip.step(ctx(bot, 20_000)), "running");
    assert.equal(trip.phaseOf(bot.p), "play");
  }
  Round._round.active = false;
  for (const bot of [fed, hungry]) trip.step(ctx(bot, 30_000));
  assert.equal(trip.phaseOf(hungry.p), "leave", "a crate earned and only its bread left: for the cart and home");
  assert.equal(trip.phaseOf(fed.p), "play", "eight trout left: it waits for the next round");
  assert.deepEqual(logged.filter(([event]) => event === "bot_wintertodt_round").map(([, data]) => [data.rounds, data.points]), [[1, 620], [1, 620]]);
  // The next round it sees out is its second, and its last.
  Round._round.active = true;
  trip.step(ctx(fed, 40_000));
  Round._round.active = false;
  trip.step(ctx(fed, 50_000));
  assert.equal(trip.phaseOf(fed.p), "leave");
});

test("a bot after Firemaking burns its logs, whatever it is saving for", (t) => {
  const { worker, world, ambition } = worldWith();
  const { p, brain } = worker(t, { firemaking: 20 });
  const ran = [];
  const step = (name) => ({ id: name, update: () => (ran.push(name), "success") });
  const choose = createChooseAction({ options: [
    { weight: 1, actions: [{ type: "dropItems" }] },
    { weight: 50, actions: [{ type: "sellItems" }] },
    { weight: 1, actions: [{ type: "lightFire" }] },
  ] }, (spec) => step(spec.type));
  ambition.consider(brain, 2000);
  const levels = ambition.mind(p).levels;
  const firemaking = levels.find((goal) => goal.skill === core.Skill.FIREMAKING);
  assert.equal(firemaking.level, 50);
  assert.equal(firemaking.unlocks, "wintertodt");
  assert.equal(firemaking.mode, "woodcutting", "trained by burning what it chops");
  const state = { ownWish: { itemId: Items.IRON_AXE, cost: 76, at: 2000 } };
  for (let round = 0; round < 20; round++) choose.update({ player: p, world, state, frame: {}, nowMs: 3000 });
  assert.deepEqual([...new Set(ran)], ["sellItems"], "saving, and after some other level: it sells");
  ambition.mind(p).focus = { ...firemaking, since: 2000 };
  ran.length = 0;
  for (let round = 0; round < 20; round++) choose.update({ player: p, world, state, frame: {}, nowMs: 4000 });
  assert.deepEqual([...new Set(ran)], ["lightFire"]);
});
