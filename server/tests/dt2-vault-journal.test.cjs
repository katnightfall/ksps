// Run after `yarn build`: node --test tests/dt2-vault-journal.test.cjs
//
// Desert Treasure II (upstream issue #5607): the quest journal follows the Ancient Vault steps. It used to
// say "Speak to Asgarnia Smith about the statues and plaque" after Smith had already sent the player on
// to Terry Balando, which read as a quest that would not move on. Real plugins and a real Player; the
// statues, the plaque and Smith are clicked through the real hooks. No client ran.
process.env.DISABLE_PLAYER_BOTS = "1";
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const QuestRuntime = require("../plugins/quests/QuestRuntime");

const STATUES_ATTRIBUTE = "desert-treasure-ii:statues";
const SMITH_INTRO_ATTRIBUTE = "desert-treasure-ii:smith-intro";
let core, quest;
let index = 7710;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  PM.emitServerStartup({});
  quest = QuestRuntime.getRegisteredQuests().find((entry) => entry.key === "desert_treasure_ii");
});
after(() => PM.emitServerShutdown({}));

function player(t, name) {
  const channel = {
    kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true,
    close() {}, onData() {}, onError() {}, onClose() {},
  };
  const p = new Player(new PlayerSession(channel));
  p.setIndex(index++);
  p.setUsername(name);
  p.setRegistered(true);
  p.setLocation(new core.Location(3511, 2971, 0));
  p.needsPlacement = false;
  t.after(() => {
    PM.emitPlayerLogout({ player: p, username: p.getUsername() });
    p.setRegistered(false);
  });
  return p;
}

const journal = (p) => quest.buildJournal(p, quest, {}).join(" ");

test("the journal names the step that is actually next in the Ancient Vault", (t) => {
  const p = player(t, "dt2journal1");
  quest.setStage(p, 1);
  assert.match(journal(p), /Inspect the four statues and plaque/);
  p.setAttribute(SMITH_INTRO_ATTRIBUTE, true);
  p.setAttribute(STATUES_ATTRIBUTE, 15);
  assert.match(journal(p), /Inspect the four statues and plaque/, "the plaque is still to read");
  p.setAttribute(STATUES_ATTRIBUTE, 31);
  assert.match(journal(p), /Speak to Asgarnia Smith about the statues and plaque/, "all five inspected: back to Smith");
  // Smith's "after inspecting the vault" conversation moves the quest to stage 2 (the vault done).
  quest.setStage(p, 2);
  assert.doesNotMatch(journal(p), /Asgarnia Smith/, "Smith is done with: the journal no longer sends the player to him");
  assert.match(journal(p), /Terry Balando at the Digsite Exam Centre/);
  quest.setStage(p, 3);
  assert.match(journal(p), /Dr Banikan/);
});

test("Smith's own words send the player to Terry Balando at the Digsite Exam Centre", () => {
  const variant = require("../data/definitions/npc-dialogues.json")["Desert Treasure II - The Fallen Empire"]
    .variants["familiar-faces-talking-to-asgarnia-smith-after-inspecting-the-vault"];
  assert.ok(JSON.stringify(variant).includes("You'll find Terry at the Digsite Exam Centre."));
});
