// Ours. Run after `yarn build`: node --test tests/quest-command-all.test.cjs
// ::quest all complete (and ::allquests) and ::quest all reset: every quest at once.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const QuestRuntime = require("../plugins/quests/QuestRuntime");
const QuestCommand = require("../plugins/quests/QuestCommand.plugin");
const { PlayerRights } = require("../src/main/typescript/elvarg/game/model/rights/PlayerRights");

const events = [];
const api = new Proxy({}, { get: (_target, name) => (name === "emitCustomEvent" ? (event, payload) => events.push([event, payload]) : () => {}) });
const rewards = [];
const grandTree = QuestRuntime.registerQuest(api, { key: "the_grand_tree", name: "The Grand Tree", varpId: 150, completionValue: 160, questPoints: 5,
  onReward: (player, quest, options) => rewards.push(["The Grand Tree", options]) });
const gnomeVillage = QuestRuntime.registerQuest(api, { key: "tree_gnome_village", name: "Tree Gnome Village", varpId: 111, completionValue: 9, questPoints: 2 });
const broken = QuestRuntime.registerQuest(api, { key: "broken_quest", name: "Broken Quest", varpId: 999, questPoints: 1,
  onReward: () => { throw new Error("this quest's reward fails"); } });
const allQuests = () => QuestRuntime.getRegisteredQuests();

function createPlayer() {
  const attributes = new Map();
  const messages = [];
  const sender = new Proxy({}, { get: () => () => sender });
  return {
    messages,
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    sendMessage: (message) => messages.push(message),
    getPacketSender: () => sender,
    getInventory: () => ({ adds() {} }),
  };
}

const run = (player, command) => QuestCommand._test.questCommand({ player, parts: command.split(" ") });
// A quest whose reward throws is reported, not printed over the test's output.
const quietly = (fn) => { const original = console.error; console.error = () => {}; try { return fn(); } finally { console.error = original; } };

test("::quest all complete completes every quest, as one not played: no scroll or chat line each, later experience held back", () => {
  const player = createPlayer();
  gnomeVillage.complete(player); // one already done by playing it
  events.length = rewards.length = 0;

  quietly(() => run(player, "quest all complete"));

  for (const quest of allQuests()) assert.ok(quest.isComplete(player), quest.name);
  assert.deepEqual(rewards, [["The Grand Tree", { experience: false, scroll: false, announce: false }]], "its reward runs, told it was not played");
  assert.ok(grandTree.experienceWithheld(player));
  const completed = events.filter(([name]) => name === "quest:completed").map(([, payload]) => payload.key);
  assert.ok(completed.includes("the_grand_tree"), "content that listens for a completion hears it");
  assert.ok(!completed.includes("tree_gnome_village"), "a quest already complete is left alone");
  // Points: every quest's, each counted once (the broken one took its points before its reward threw).
  const points = allQuests().reduce((sum, quest) => sum + (quest.questPoints || 0), 0);
  assert.equal(player.getAttribute("quest.points"), points);
  // One line for the lot. The quest whose reward failed is complete all the same, and is named; it does not stop the others.
  const total = allQuests().length;
  assert.equal(player.messages.at(-2), `Completed ${total - 1} of ${total} quests; you have ${points} quest points.`);
  assert.equal(player.messages.at(-1), "The rewards of 1 failed (see the server log): Broken Quest.");
  assert.ok(broken.isComplete(player));

  quietly(() => run(player, "quest all complete"));
  assert.equal(player.messages.at(-1), `All ${total} quests were already complete (${points} quest points).`);
});

test("::allquests is the same command", () => {
  const registered = new Map();
  QuestCommand.register({ registerCommand: (name, handler) => registered.set(name, handler) });
  assert.ok(registered.has("quest") && registered.has("allquests"));
  const player = createPlayer();
  player.getRights = () => PlayerRights.ADMINISTRATOR;
  assert.equal(quietly(() => registered.get("allquests")({ player, parts: ["allquests"] })), true);
  assert.ok(grandTree.isComplete(player) && gnomeVillage.isComplete(player));
});

// The owner's wish (2026-11-20): every player may complete all their quests (QuestCommand:everyone).
test("QuestCommand:everyone opens ::allquests and ::quest all complete to players, and nothing else of ::quest", () => {
  const registered = new Map();
  let everyone = false;
  QuestCommand.register({
    registerCommand: (name, handler, rights) => registered.set(name, { handler, rights }),
    getPluginConfig: (key, fallback) => (key === "QuestCommand:everyone" ? everyone : fallback),
  });
  assert.equal(registered.get("quest").rights, PlayerRights.NONE);
  assert.equal(registered.get("allquests").rights, PlayerRights.NONE);
  const command = (player, text) => quietly(() => registered.get(text.split(" ")[0]).handler({ player, parts: text.split(" ") }));
  const player = () => Object.assign(createPlayer(), { getRights: () => PlayerRights.NONE });

  // Off (the default): players are refused, as before.
  const refused = player();
  command(refused, "allquests");
  command(refused, "quest all complete");
  assert.ok(!grandTree.isComplete(refused));
  assert.deepEqual(refused.messages, ["You do not have permission to use this command.", "You do not have permission to use this command."]);

  // On: both complete every quest.
  everyone = true;
  const short = player();
  command(short, "allquests");
  for (const quest of allQuests()) assert.ok(quest.isComplete(short), quest.name);
  const long = player();
  command(long, "quest ALL Complete");
  for (const quest of allQuests()) assert.ok(quest.isComplete(long), quest.name);

  // A reset (then the rewards again), a stage or one quest stay with staff.
  for (const text of ["quest all reset", "quest grand tree reset", "quest grand tree 5", "quest grand tree"]) {
    command(long, text);
    assert.equal(long.messages.at(-1), "Only ::quest all complete (or ::allquests) is open to players; the rest of ::quest is for staff.", text);
  }
  assert.ok(grandTree.isComplete(long), "nothing was reset");
  const fresh = player();
  command(fresh, "quest grand tree complete");
  assert.ok(!grandTree.isComplete(fresh));

  // Staff keep the whole command.
  const admin = Object.assign(createPlayer(), { getRights: () => PlayerRights.ADMINISTRATOR });
  command(admin, "quest grand tree complete");
  assert.ok(grandTree.isComplete(admin));
  command(admin, "quest grand tree reset");
  assert.equal(grandTree.getStage(admin), 0);
});

test("::quest all reset puts every quest back to not started, with its points", () => {
  const player = createPlayer();
  quietly(() => run(player, "quest all complete"));
  run(player, "quest all reset");
  for (const quest of allQuests()) assert.equal(quest.getStage(player), 0, quest.name);
  assert.equal(player.getAttribute("quest.points"), 0);
  assert.equal(player.messages.at(-1), `Reset ${allQuests().length} quests to not started.`);
});

test("'all' needs complete or reset, and a quest's own name still works", () => {
  const player = createPlayer();
  run(player, "quest all");
  assert.match(player.messages.at(-1), /^Usage: ::quest <name> \[complete\|reset\|<stage>\], or ::quest all complete\|reset$/);
  run(player, "quest all 5");
  assert.match(player.messages.at(-1), /^Usage:/);
  for (const quest of allQuests()) assert.equal(quest.getStage(player), 0);
  run(player, "quest grand tree complete");
  assert.ok(grandTree.isComplete(player) && !gnomeVillage.isComplete(player));
});

// The user's wish (2026-11-16): the reward items go to the bank, not the backpack and the floor.
test("::allquests banks the reward items and leaves the player's own backpack as it was", async (t) => {
  const path = require("node:path");
  const { CachePipeline } = require("../dist/game/cache/CachePipeline");
  const { PluginManager } = require("../dist/plugins/PluginManager");
  const { Player } = require("../dist/game/entity/impl/player/Player");
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  const real = PluginManager.getCoreApi();
  const SHARK = 385, RUNE_PLATEBODY = 1127, RUNE_PLATEBODY_NOTE = 1128, COINS = 995, WHIP = 4151;

  // The summary is sent two ticks on: here, at once.
  const core = { ...real, TaskManager: { ...real.TaskManager, submit: (task) => task.execute() } };
  QuestCommand.register({ core, registerCommand() {} });
  t.after(() => QuestCommand.register({ registerCommand() {} }));

  const p = new Player(null);
  p.getSession = () => ({ sendClientPacket: () => true, write: () => true });
  p.setUsername("allqueststest");
  const messages = [];
  p.sendMessage = (text) => messages.push(text);
  const inventory = p.getInventory();
  // A full backpack of the player's own: 27 sharks and a whip.
  inventory.adds(SHARK, 27);
  inventory.adds(WHIP, 1);
  assert.equal(inventory.getFreeSlots(), 0);
  const own = inventory.getItems().map((item) => [item.getId(), item.getAmount()]);

  // Three quests that pay in items: more than a backpack holds between them, one in notes.
  const paying = [
    QuestRuntime.registerQuest(api, { key: "pays_bodies", name: "Pays Bodies", varpId: 2001, questPoints: 1,
      onReward: (player) => player.getInventory().adds(RUNE_PLATEBODY, 20) }),
    QuestRuntime.registerQuest(api, { key: "pays_more", name: "Pays More", varpId: 2002, questPoints: 1,
      onReward: (player) => { player.getInventory().adds(RUNE_PLATEBODY, 15); player.getInventory().adds(COINS, 1000); } }),
    QuestRuntime.registerQuest(api, { key: "pays_notes", name: "Pays Notes", varpId: 2003, questPoints: 1,
      onReward: (player) => player.getInventory().adds(RUNE_PLATEBODY_NOTE, 7) }),
  ];

  quietly(() => QuestCommand._test.completeAll(p));

  for (const quest of paying) assert.ok(quest.isComplete(p), quest.name);
  assert.deepEqual(inventory.getItems().map((item) => [item.getId(), item.getAmount()]), own, "their own backpack, slot for slot");
  const banked = (id) => p.getBanks().reduce((sum, tab) => sum + (tab ? tab.getAmount(id) : 0), 0);
  assert.equal(banked(RUNE_PLATEBODY), 20 + 15 + 7, "every platebody, the noted ones unnoted");
  assert.equal(banked(RUNE_PLATEBODY_NOTE), 0);
  assert.equal(banked(COINS), 1000);
  assert.equal(banked(SHARK), 0, "nothing of the player's own is banked");
  assert.ok(messages.includes("The reward items are in your bank (1,042 items)."), messages.join(" | "));
  assert.ok(!messages.some((line) => line.startsWith("Your bank would not take")));
});

// The owner's wish (2026-11-20): ::quest all complete gives 1x experience, not the world's rate.
test("::quest all complete pays its quests' experience at 1x on a 10x world", async (t) => {
  const path = require("node:path");
  const { CachePipeline } = require("../dist/game/cache/CachePipeline");
  const { PluginManager } = require("../dist/plugins/PluginManager");
  const { Player } = require("../dist/game/entity/impl/player/Player");
  const { GameConstants } = require("../dist/game/GameConstants");
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  const real = PluginManager.getCoreApi();
  const { Skill } = real;

  const rate = GameConstants.EXPERIENCE_MULTIPLIER;
  GameConstants.setExperienceRate(10);
  const hooks = PluginManager.canGainExperienceHooks;
  const attached = hooks.length;
  const core = { ...real, TaskManager: { ...real.TaskManager, submit: (task) => task.execute() } };
  QuestCommand.register({ core, registerCommand() {}, onCanGainExperience: (handler) => hooks.push({ handler }) });
  t.after(() => {
    hooks.length = attached;
    GameConstants.setExperienceRate(rate);
    QuestCommand.register({ registerCommand() {} });
  });

  QuestRuntime.registerQuest(api, { key: "pays_cooking", name: "Pays Cooking", varpId: 2004, questPoints: 1,
    onReward: (player) => player.getSkillManager().addExperiences(Skill.COOKING, 300) });

  const p = new Player(null);
  p.getSession = () => ({ sendClientPacket: () => true, write: () => true });
  p.setUsername("allquestsxp");
  p.sendMessage = () => {};
  quietly(() => QuestCommand._test.completeAll(p));
  assert.equal(p.getSkillManager().getExperience(Skill.COOKING), 300, "the quest's 300, not 3,000");

  // Afterwards the world's rate is back for everything else.
  p.getSkillManager().addExperiences(Skill.COOKING, 10);
  assert.equal(p.getSkillManager().getExperience(Skill.COOKING), 400);
});
