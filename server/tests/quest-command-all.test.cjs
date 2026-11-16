// Ours. Run after `yarn build`: node --test tests/quest-command-all.test.cjs
// ::quest all complete (and ::allquests) and ::quest all reset: every quest at once.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const QuestRuntime = require("../plugins/quests/QuestRuntime");
const QuestCommand = require("../plugins/quests/QuestCommand.plugin");

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
  assert.equal(quietly(() => registered.get("allquests")({ player, parts: ["allquests"] })), true);
  assert.ok(grandTree.isComplete(player) && gnomeVillage.isComplete(player));
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
