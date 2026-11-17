// Ours. Run after `yarn build`: node --test tests/bot-talk.test.cjs
// What the levelling bots say (plugins/bots/brain/BotTalk.PlayerBots.js) and the groups they
// form (brain/BotGroups.PlayerBots.js): canned lines kept rare, a proposal in chat, bots that
// agree, a walk to the meeting place and the outing's work there. Real Players and brains.
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
const Talk = require("../plugins/bots/brain/BotTalk.PlayerBots");
const Groups = require("../plugins/bots/brain/BotGroups.PlayerBots");
const { createBotActivityRegistry } = require("../plugins/bots/brain/ActivityRegistry.PlayerBots");
const { BotBrain } = require("../plugins/bots/brain/Brain.PlayerBots");
const { peekMovementRequest } = require("../plugins/bots/behaviours/navigation/Navigation.PlayerBots");

let core;
let Items;
let registry;
let site;
let names = 0;
const CROWD = { id: "talkcrowd", enabled: true, progression: true, x: 3222, y: 3219,
  bots: { woodcutting: 30, mining: 20, fishing: 10, combat_training: 40 } };
const HOME = [3222, 3219];

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  require("../plugins/items/ItemDefinitionLoader.plugin").register({ log() {}, onPlayerLogin() {}, registerContentEndpoint() {} });
  core = PluginManager.getCoreApi();
  Items = core.ItemIdentifiers;
  require("../plugins/items/Food.plugin").register(PluginManager.createApi("BotTalkTest"));
  assert.equal(new (require("../dist/game/definition/loader/impl/ShopDefinitionLoader").ShopDefinitionLoader)().load(), true, "the server's shops");
  core.ShopManager.initialize();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bot-sites-")), "bot-sites.json");
  fs.writeFileSync(file, JSON.stringify({ sites: [CROWD], pvp: { botPool: 0, activeRegionBotsPerRegion: 0 } }));
  registry = createBotActivityRegistry({ world: { core }, sitesPath: file });
  site = registry.getSite(CROWD.id);
});

function someone(t, { isBot = true, at = HOME } = {}) {
  const p = new Player(null);
  p.getSession = () => ({ sendClientPacket: () => true, write: () => true });
  p.setUsername(`${isBot ? "talkbot" : "person"}${++names}`);
  p.sendMessage = () => {};
  p.isPlayerBot = () => isBot;
  p.setLocation(new core.Location(at[0], at[1], 0));
  t.after(() => core.TaskManager.cancelTasks(p));
  if (isBot) {
    OwnItems.setEarnsOwnItems(p, true);
    StarterKit.giveToBot(p);
  }
  return p;
}

/** A world with everyone the test makes standing in it, and a record of every line said. */
function worldWith({ chat = true, random = Math.random, groupRandom = () => 0 } = {}) {
  const everyone = [];
  const said = [];
  const logged = [];
  const settings = { chat };
  const world = {
    core: {
      ...core,
      World: Object.assign(Object.create(core.World), { getNearbyPlayersForUpdate: () => everyone }),
      ChatPacketListener: { handleText: (player, text) => said.push([player.getUsername(), text]) },
    },
    log: (event, data) => logged.push([event, data]),
  };
  const runtime = { entriesByUsername: new Map() };
  world.ambition = Ambition.createAmbition({ world });
  world.talk = Talk.createBotTalk({ world, enabled: () => settings.chat, random });
  world.groups = Groups.createBotGroups({ world, runtime, registry, ambition: world.ambition, talk: world.talk, random: groupRandom, minutes: [30, 90] });
  const join = (t, options = {}) => {
    const p = someone(t, options);
    everyone.push(p);
    return p;
  };
  /** A bot at its work, with a brain the others can be reached through. */
  const worker = (t, { at = HOME, activity = "normal_trees", levels = {} } = {}) => {
    const p = join(t, { at });
    for (const [skill, level] of Object.entries(levels)) {
      p.getSkillManager().setCurrentLevel(core.Skill[skill], level, false).setMaxLevels(core.Skill[skill], level, false);
    }
    const brain = new BotBrain({ player: p, state: {}, registry, world, activity: registry.byId.get(activity), rotation: site.rotation, nowMs: 1000 });
    brain.frames[0].state = "running";
    runtime.entriesByUsername.set(p.getUsername(), { player: p, brain });
    return { p, brain };
  };
  return { world, said, logged, settings, runtime, join, worker, talk: world.talk, groups: world.groups, ambition: world.ambition };
}

const brainOf = (player) => ({ player, frames: [{ behaviour: { mode: "woodcutting" } }] });
const lines = (said) => said.map(([, text]) => text);

test("a line is filled from what the bot knows, and one it cannot fill is not used", () => {
  assert.equal(Talk.fill("saving up for {a item}", { item: "iron axe" }), "saving up for an iron axe");
  assert.equal(Talk.fill("need {cost}gp for {a item}", { item: "steel axe", cost: 200 }), "need 200gp for a steel axe");
  assert.equal(Talk.fill("need {level} {skill} for {unlock}", { level: 15, skill: "woodcutting" }), null);
  for (const [topic, list] of Object.entries(Talk.LINES)) {
    for (const text of list) assert.ok(text.length <= 80 && !/[<>]/.test(text) && !text.startsWith("::"), `${topic}: ${text}`);
  }
});

test("a bot speaks only with a person in earshot, and then keeps quiet for minutes", (t) => {
  const { said, join, talk } = worldWith();
  const bot = join(t);
  talk.note(bot, "got", { goal: { itemId: Items.IRON_AXE } }, 1000);
  talk.tick(brainOf(bot), 2000);
  assert.deepEqual(said, [], "nobody there to read it");
  const far = join(t, { isBot: false, at: [HOME[0] + 40, HOME[1]] });
  talk.tick(brainOf(bot), 8000);
  assert.deepEqual(said, [], "too far to hear");
  far.setLocation(new core.Location(HOME[0] + 5, HOME[1] + 3, 0));
  talk.tick(brainOf(bot), 14_000);
  assert.equal(said.length, 1);
  assert.equal(said[0][0], bot.getUsername());
  assert.match(said[0][1], /iron axe/);
  // Something else happens to it straight away: it has only just spoken.
  talk.note(bot, "level", { skill: core.Skill.MINING, level: 20 }, 15_000);
  for (let at = 15_000; at < 15_000 + 3 * 60_000; at += 5_000) talk.tick(brainOf(bot), at);
  assert.equal(said.length, 1, "not within minutes of its last line");
  assert.equal(talk.pending(bot), null, "and old news is dropped, not saved up");
  talk.note(bot, "level", { skill: core.Skill.MINING, level: 25 }, 10 * 60_000);
  talk.tick(brainOf(bot), 10 * 60_000 + 1000);
  assert.equal(said.length, 2);
  assert.match(said[1][1], /25/);
});

test("however many bots stand around a person, that person hears one line every 20 seconds at most", (t) => {
  const { said, join, talk } = worldWith();
  join(t, { isBot: false });
  const bots = Array.from({ length: 30 }, () => join(t));
  for (const bot of bots) talk.note(bot, "got", { goal: { itemId: Items.STEEL_AXE } }, 1000);
  const times = [];
  for (let at = 1000; at <= 121_000; at += 600) {
    for (const bot of bots) talk.tick(brainOf(bot), at);
    while (times.length < said.length) times.push(at);
  }
  assert.ok(said.length >= 4 && said.length <= 7, `a handful of lines in two minutes from thirty bots (${said.length})`);
  for (let index = 1; index < times.length; index++) assert.ok(times[index] - times[index - 1] >= Talk.LISTENER_QUIET_MS, "never two within 20 seconds");
  assert.equal(new Set(said.map(([name]) => name)).size, said.length, "each from a different bot");
  // Away from people the same bots say nothing at all.
  const { said: unheard, join: alone, talk: quiet } = worldWith();
  const lonely = Array.from({ length: 10 }, () => alone(t));
  for (const bot of lonely) quiet.note(bot, "got", { goal: { itemId: Items.STEEL_AXE } }, 1000);
  for (let at = 1000; at <= 61_000; at += 600) for (const bot of lonely) quiet.tick(brainOf(bot), at);
  assert.deepEqual(unheard, []);
});

test("a bot beside the speaker may answer, once, and an answer is never answered", (t) => {
  const { said, join, talk } = worldWith({ random: () => 0 });
  join(t, { isBot: false });
  const speaker = join(t);
  const beside = join(t, { at: [HOME[0] + 2, HOME[1]] });
  const across = join(t, { at: [HOME[0] + 12, HOME[1]] });
  for (const bot of [speaker, beside, across]) talk.tick(brainOf(bot), 500);
  talk.note(speaker, "level", { skill: core.Skill.FISHING, level: 30 }, 1000);
  talk.tick(brainOf(speaker), 1000);
  assert.equal(said.length, 1);
  assert.equal(talk.pending(across), null, "too far off to bother");
  assert.ok(talk.pending(beside), "the one beside it has a word");
  talk.tick(brainOf(beside), 2000);
  assert.equal(said.length, 1, "it takes a moment to type, and the listener's quiet holds");
  for (let at = 3000; at <= 30_000; at += 1000) talk.tick(brainOf(beside), at);
  assert.equal(said.length, 2);
  assert.equal(said[1][0], beside.getUsername());
  assert.ok(Talk.LINES.reply_level.includes(said[1][1]));
  for (const bot of [speaker, across]) assert.equal(talk.pending(bot), null, "no answer to the answer");
});

test("only round levels are worth a shout below 50, and its work gives it a remark now and then", (t) => {
  const { said, join, talk } = worldWith({ random: () => 0.5 });
  join(t, { isBot: false });
  const bot = join(t);
  talk.tick(brainOf(bot), 0);
  talk.levelUp({ player: bot, skill: core.Skill.WOODCUTTING, newLevel: 7 });
  assert.equal(talk.pending(bot), null);
  talk.levelUp({ player: bot, skill: core.Skill.WOODCUTTING, newLevel: 10 });
  assert.match(talk.pending(bot).text, /10/);
  talk.levelUp({ player: bot, skill: core.Skill.WOODCUTTING, newLevel: 53 });
  assert.match(talk.pending(bot).text, /53/);
  const stranger = join(t, { isBot: false });
  talk.levelUp({ player: stranger, skill: core.Skill.WOODCUTTING, newLevel: 60 });
  assert.equal(talk.pending(stranger), null, "a person's level-up is theirs to announce");
  // Left alone long enough it says something about what it is doing.
  const { said: remarks, join: other, talk: idle } = worldWith({ random: () => 0.5 });
  other(t, { isBot: false });
  const worker = other(t);
  idle.tick(brainOf(worker), 0);
  for (let at = 60_000; at <= 25 * 60_000 && remarks.length === 0; at += 30_000) idle.tick(brainOf(worker), at);
  assert.equal(remarks.length, 1);
  assert.ok(Talk.LINES.woodcutting.includes(remarks[0][1]), remarks[0][1]);
  assert.equal(said.length, 0);
});

test("with the world's chat off the bots say nothing, and a line never runs a command", (t) => {
  const { said, settings, join, talk } = worldWith();
  join(t, { isBot: false });
  const bot = join(t);
  assert.equal(talk.say(bot, "::bank", 1000), true);
  assert.deepEqual(lines(said), ["bank"]);
  settings.chat = false;
  talk.note(bot, "got", { goal: { itemId: Items.IRON_AXE } }, 20 * 60_000);
  talk.tick(brainOf(bot), 20 * 60_000 + 1000);
  assert.equal(talk.say(bot, "hello", 30 * 60_000, { group: "open" }), false);
  assert.equal(said.length, 1);
  assert.equal(Talk.worldBotsTalk(), true, "on unless a world turns it off");
  assert.equal(require("../plugins/bots/PlayerBots.plugin").config[Talk.CHAT_CONFIG].default, true);
});

test("the outings shipped are things the crowd can do, at a place, with something to say", () => {
  const outings = Groups.loadOutings(path.resolve(__dirname, "../data/definitions/bot-groups.json"));
  assert.ok(outings.length >= 4);
  for (const outing of outings) {
    const activity = registry.byId.get(outing.activity);
    assert.ok(activity && activity.mode, `${outing.id}: a known activity`);
    assert.ok(outing.size[0] >= 2 && outing.say.length > 3 && outing.minutes[0] > 0, outing.id);
  }
  assert.ok(registry.byId.get(Groups.MEET_ACTIVITY).manual, "the walk to the meeting place is never drawn from the rotation");
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bot-groups-")), "bot-groups.json");
  fs.writeFileSync(bad, JSON.stringify({ outings: [{ id: "nowhere", activity: "normal_trees", say: "stand about" }] }));
  assert.throws(() => Groups.loadOutings(bad), /needs an id, an activity, a place/);
});

test("one proposes, those near and those after the same skill agree, and they set off together", (t) => {
  const { said, logged, worker, join, groups, ambition } = worldWith();
  join(t, { isBot: false });
  const leader = worker(t);
  const near = [worker(t, { at: [HOME[0] + 3, HOME[1]] }), worker(t, { at: [HOME[0] - 6, HOME[1] + 4] })];
  const farAway = worker(t, { at: [HOME[0] + 60, HOME[1]] });
  const fighting = worker(t, { at: [HOME[0] + 2, HOME[1] + 2] });
  fighting.p.getCombat().getAttacker = () => ({});
  // One far off, but after Woodcutting like the outing: it comes too.
  const likeMinded = worker(t, { at: [HOME[0] + 80, HOME[1]] });
  ambition.consider(likeMinded.brain, 1000);
  ambition.mind(likeMinded.p).focus = { ...ambition.mind(likeMinded.p).focus, mode: "woodcutting" };
  ambition.consider(farAway.brain, 1000);
  ambition.mind(farAway.p).focus = { ...ambition.mind(farAway.p).focus, mode: "mining" };

  const party = groups.propose(leader.brain, 10_000);
  assert.equal(party.outing.id, "lumbridge_trees", "the one a new character can do");
  assert.equal(party.phase, "gathering");
  assert.equal(said.length, 1);
  assert.match(said[0][1], /cut trees west of lumbridge/);
  const asked = party.pledges.map((pledge) => pledge.player);
  assert.deepEqual(new Set(asked), new Set([near[0].p, near[1].p, likeMinded.p]), "not the one in a fight, nor the one far off after something else");
  assert.equal(groups.propose(near[0].brain, 10_500), null, "a bot that has been asked does not start a party of its own");

  // They answer after a moment; those in earshot say so.
  groups.tick(leader.brain, 11_000);
  assert.equal(party.members.size, 1);
  groups.tick(leader.brain, 13_000);
  assert.equal(party.members.size, 4);
  assert.equal(said.length, 3, "two answers in chat; the one far off just comes");
  for (const [, text] of said.slice(1)) assert.ok(["me", "ill come", "sure", "omw", "im in", "yeah ok", "me too"].includes(text), text);
  assert.equal(leader.brain.frames.length, 1, "still gathering");

  // The wait over, the proposer says so and each one's work becomes the outing, the walk on top.
  groups.tick(near[1].brain, 26_000);
  assert.equal(party.phase, "travelling");
  assert.equal(said.length, 4);
  assert.ok(["ok lets go", "lets go then", "ok going", "right lets go"].includes(said[3][1]));
  assert.equal(said[3][0], leader.p.getUsername());
  for (const member of [leader, ...near, likeMinded]) {
    assert.deepEqual(member.brain.frames.map((frame) => frame.behaviour.id), ["normal_trees", Groups.MEET_ACTIVITY]);
    assert.ok(member.brain.switchAt >= 26_000 + 8 * 60_000 + 8 * 60_000, "its rotation waits for the outing");
    assert.equal(groups.partyOf(member.p), party);
  }
  assert.equal(farAway.brain.frames.length, 1);
  assert.equal(fighting.brain.frames.length, 1);
  assert.ok(logged.some(([event, data]) => event === "bot_group_set_off" && data.members.length === 4));
});

test("they walk to the meeting place, wait there for each other, and then work", (t) => {
  const { worker, groups, world } = worldWith();
  const a = worker(t);
  const b = worker(t, { at: [HOME[0] + 2, HOME[1]] });
  const c = worker(t, { at: [HOME[0] - 2, HOME[1]] });
  const party = groups.propose(a.brain, 10_000);
  groups.tick(a.brain, 13_000);
  groups.tick(a.brain, 26_000);
  assert.equal(party.phase, "travelling");
  assert.equal(party.members.size, 3);
  const ctx = (who, nowMs) => ({ player: who.p, state: who.brain.state, world, brain: who.brain, frame: {}, nowMs });
  assert.equal(groups.meet(ctx(a, 27_000)), "running");
  const walk = peekMovementRequest(a.p);
  assert.ok(walk, "a walk is asked for");
  const place = new core.Location(party.outing.x + 1, party.outing.y - 1, 0);
  a.p.setLocation(place);
  assert.equal(groups.meet(ctx(a, 60_000)), "running", "the first there waits");
  b.p.setLocation(place);
  assert.equal(groups.meet(ctx(b, 70_000)), "running", "two of three");
  assert.equal(groups.meet(ctx(a, 71_000)), "running");
  // The third never comes: a minute after the first arrived the others start without it.
  assert.equal(groups.meet(ctx(a, 60_000 + 61_000)), "success");
  assert.equal(groups.meet(ctx(b, 60_000 + 61_500)), "success");
  assert.equal(groups.partyOf(a.p), null, "the party is over for them: the work is their own");
  // It stood still on the way for a minute: it gives the outing up.
  assert.equal(groups.meet(ctx(c, 200_000)), "running");
  assert.equal(groups.meet(ctx(c, 200_000 + 61_000)), "failed");
  assert.equal(groups.partyOf(c.p), null);

  // When everyone is there, nobody waits.
  const d = worker(t, { at: [HOME[0], HOME[1] + 1] });
  const e = worker(t, { at: [HOME[0] + 1, HOME[1] + 1] });
  const second = groups.propose(d.brain, 2_000_000);
  groups.tick(d.brain, 2_003_000);
  groups.tick(d.brain, 2_016_000);
  assert.equal(second.phase, "travelling");
  d.p.setLocation(place);
  e.p.setLocation(place);
  assert.equal(groups.meet(ctx(d, 2_020_000)), "running");
  assert.equal(groups.meet(ctx(e, 2_021_000)), "success");
  assert.equal(groups.meet(ctx(d, 2_022_000)), "success");
});

test("with nobody to come it is called off, and the bot goes on with its work", (t) => {
  const { said, worker, join, groups } = worldWith();
  join(t, { isBot: false });
  const lonely = worker(t);
  const party = groups.propose(lonely.brain, 10_000);
  assert.equal(party.pledges.length, 0);
  groups.tick(lonely.brain, 20_000);
  assert.equal(party.phase, "gathering");
  groups.tick(lonely.brain, 26_000);
  assert.equal(party.phase, "done");
  assert.equal(said.length, 2);
  assert.ok(["nvm", "guess not", "ok maybe later", "no one? ok"].includes(said[1][1]));
  assert.equal(lonely.brain.frames.length, 1);
  assert.equal(groups.partyOf(lonely.p), null);
});

test("a group nobody could be told of forms in silence, and a person hears a proposal every half minute at most", (t) => {
  const { said, worker, join, groups } = worldWith();
  // No person anywhere near: the party forms and sets off without a word.
  const a = worker(t);
  worker(t, { at: [HOME[0] + 1, HOME[1]] });
  const silent = groups.propose(a.brain, 10_000);
  groups.tick(a.brain, 13_000);
  groups.tick(a.brain, 26_000);
  assert.equal(silent.phase, "travelling");
  assert.deepEqual(said, []);
  // A person arrives. The next proposal is said, and so are its answers and its setting off.
  join(t, { isBot: false });
  const b = worker(t, { at: [HOME[0], HOME[1] + 2] });
  worker(t, { at: [HOME[0] + 1, HOME[1] + 2] });
  const heard = groups.propose(b.brain, 100_000);
  groups.tick(b.brain, 103_000);
  groups.tick(b.brain, 116_000);
  assert.equal(heard.phase, "travelling");
  assert.equal(said.length, 3, "the proposal, one answer, and the word to go");
  // Another bot proposes ten seconds later: the person has only just read one, so this party keeps quiet throughout.
  const c = worker(t, { at: [HOME[0] - 2, HOME[1] - 2] });
  worker(t, { at: [HOME[0] - 3, HOME[1] - 2] });
  const quiet = groups.propose(c.brain, 126_000);
  groups.tick(c.brain, 129_000);
  groups.tick(c.brain, 142_000);
  assert.equal(quiet.phase, "travelling");
  assert.equal(said.length, 3, "nothing more was said");
  // Half a minute on a proposal is heard again.
  const d = worker(t, { at: [HOME[0] + 4, HOME[1] - 2] });
  groups.propose(d.brain, 126_000 + Talk.PROPOSAL_QUIET_MS);
  assert.equal(said.length, 4);
});

test("a bot proposes only now and then, and only an outing its levels allow", (t) => {
  const { worker, groups, logged } = worldWith({ groupRandom: () => 0.999 });
  const novice = worker(t);
  const proposals = () => logged.filter(([event]) => event === "bot_group_proposed");
  // Its first proposal comes within the world's gap (30 to 90 minutes, here the far end of it).
  for (let at = 0; at < 80 * 60_000; at += 60_000) groups.tick(novice.brain, at);
  assert.equal(proposals().length, 0);
  for (let at = 80 * 60_000; at < 100 * 60_000 && proposals().length === 0; at += 60_000) groups.tick(novice.brain, at);
  assert.equal(proposals().length, 1);
  assert.equal(proposals()[0][1].outing, "draynor_net_fishing", "the last of those a new character can do: never willows or iron");
  const { worker: skilled, groups: second } = worldWith({ groupRandom: () => 0.999 });
  const miner = skilled(t, { levels: { MINING: 20, WOODCUTTING: 35, FISHING: 25 } });
  const open = second.outings.filter((outing) => registry.byId.get(outing.activity).requires.every((rule) => rule.check({ player: miner.p })));
  assert.ok(open.some((outing) => outing.id === "draynor_willows") && open.some((outing) => outing.id === "varrock_west_iron"));
  assert.equal(Groups.worldBotsGroup(), true, "on unless a world turns it off");
  const PlayerBots = require("../plugins/bots/PlayerBots.plugin");
  assert.equal(PlayerBots.config[Groups.GROUPS_CONFIG].default, true);
  assert.ok(PlayerBots.config[Groups.GROUP_MINUTES_CONFIG]);
});
