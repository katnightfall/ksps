// Ours. Run after `yarn build`: node --test tests/starter-kit.test.cjs
// A new character's starter items (plugins/world/StarterKit.plugin.js): OSRS's Tutorial Island kit,
// on worlds that do not run the island. Real Players and real containers.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { before, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const StarterKit = require("../plugins/world/StarterKit.plugin");

let core;
let onLogin;
let tutorialOn = false;
let config = {};
const persisted = [];

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  core = PluginManager.getCoreApi();
  StarterKit.register({
    core,
    persistAttribute: (name) => persisted.push(name),
    onPlayerLogin: (fn) => { onLogin = fn; },
    emitCustomEvent: (name, event) => { if (name === "tutorial:availability" && tutorialOn) event.available = true; },
    getPluginConfig: (key, fallback) => (key in config ? config[key] : fallback),
  });
});

function character(t, { bot = false } = {}) {
  const p = new Player(null);
  p.getSession = () => ({ sendClientPacket: () => true, write: () => true });
  p.setUsername("starterkittest");
  p.sendMessage = () => {};
  p.isPlayerBot = () => bot;
  t.after(() => core.TaskManager.cancelTasks(p));
  return p;
}
const carried = (p) => p.getInventory().getValidItems().map((item) => [item.getId(), item.getAmount()]);
const banked = (p) => p.getBanks().flatMap((tab) => (tab ? tab.getValidItems().map((item) => [item.getId(), item.getAmount()]) : []));

/** What a player steps off Tutorial Island with, in the island's order (item id, amount). */
const OSRS_KIT = [
  [1351, 1],  // Bronze axe
  [1265, 1],  // Bronze pickaxe
  [590, 1],   // Tinderbox
  [303, 1],   // Small fishing net
  [315, 1],   // Shrimps
  [1205, 1],  // Bronze dagger
  [1277, 1],  // Bronze sword
  [1171, 1],  // Wooden shield
  [841, 1],   // Shortbow
  [882, 25],  // Bronze arrows
  [556, 25],  // Air runes
  [558, 15],  // Mind runes
  [1925, 1],  // Bucket
  [1931, 1],  // Pot
  [2309, 1],  // Bread
  [555, 6],   // Water runes
  [557, 4],   // Earth runes
  [559, 2],   // Body runes
];

test("a new character starts with the Tutorial Island kit, and its 25 coins in the bank", (t) => {
  const p = character(t);
  onLogin({ player: p, isNewAccount: true });
  assert.deepEqual(carried(p), OSRS_KIT);
  assert.deepEqual(banked(p), [[995, 25]]);
  assert.equal(p.getInventory().getFreeSlots(), 28 - OSRS_KIT.length, "18 of the 28 slots");
  assert.ok(persisted.includes(StarterKit._test.GIVEN_ATTRIBUTE), "that it was given is saved with the character");
});

test("it is the same kit, in the same order, as the island itself hands out", () => {
  const source = fs.readFileSync(path.join(__dirname, "../plugins/areas/tutorialisland/Leave.TutorialIsland.js"), "utf8");
  const kit = source.slice(source.indexOf("function giveStarterKit"), source.indexOf("T.giveBankCoins(player);"));
  const island = [...kit.matchAll(/Items\.([A-Z_]+)(?:, (\d+)\))?/g)].map((match) => [match[1], Number(match[2] ?? 1)]);
  assert.deepEqual(island, StarterKit._test.KIT.map(([name, amount]) => [name, amount]));
  const common = fs.readFileSync(path.join(__dirname, "../plugins/areas/tutorialisland/Common.TutorialIsland.js"), "utf8");
  assert.match(common, new RegExp(`const BANK_COINS = ${StarterKit._test.BANK_COINS};`));
});

test("only once, and only on the first login", (t) => {
  const p = character(t);
  onLogin({ player: p, isNewAccount: false });
  assert.deepEqual(carried(p), [], "an existing character logging in gets nothing");
  onLogin({ player: p, isNewAccount: true });
  onLogin({ player: p, isNewAccount: true });
  assert.deepEqual(carried(p), OSRS_KIT);
  assert.deepEqual(banked(p), [[995, 25]]);
});

test("not to bots, not where the setting is off, and not on a world that runs Tutorial Island", (t) => {
  const bot = character(t, { bot: true });
  onLogin({ player: bot, isNewAccount: true });
  assert.deepEqual(carried(bot), []);

  config = { [StarterKit._test.ENABLED_CONFIG]: false };
  const off = character(t);
  onLogin({ player: off, isNewAccount: true });
  assert.deepEqual(carried(off), []);
  config = {};

  // The island gives its own kit at the end, after emptying the backpack.
  tutorialOn = true;
  const islander = character(t);
  onLogin({ player: islander, isNewAccount: true });
  assert.deepEqual(carried(islander), []);
  assert.deepEqual(banked(islander), []);
  tutorialOn = false;
});

test("our world runs without the island, so the kit is what its new characters get", () => {
  const world = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/definitions/world.json"), "utf8"));
  assert.equal(world.plugins?.TutorialIsland, false);
  assert.notEqual(world.pluginConfig?.[StarterKit._test.ENABLED_CONFIG], false);
});
