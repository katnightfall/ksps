// Run after `yarn build`: node --test tests/regular-trees.test.cjs
// Ours: "Woodcutting:regularTreeTicks" lets a regular tree stand through several logs like an
// oak. Through the real Woodcutting: at 0 (OSRS) the tree falls with its first log; above 0 it is
// chopped on for that many ticks and falls with the next log after them.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
process.env.DISABLE_PLAYER_BOTS = "1";
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { ClientConnection } = require("../dist/net/NetworkBuilder");

let core;
let Woodcutting;
let next = 1950;
const AT = [1666, 3136, 0];

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  core.RegionManager.init();
  PM.emitServerStartup({});
  Woodcutting = require("../plugins/skills/Woodcutting.plugin");
});
after(() => PM.emitServerShutdown({}));

/** A level 99 woodcutter with a rune axe, standing beside a regular tree and told to chop it. */
async function chopper(t, treeTicks) {
  Woodcutting._test.setRegularTreeTicks(treeTicks);
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(next++);
  player.setUsername(`chopper${next}`);
  player.setRegistered(true);
  player.setLocation(new core.Location(...AT));
  player.needsPlacement = false;
  const connection = new ClientConnection(channel);
  connection.player = player;
  const skills = player.getSkillManager();
  skills.setMaxLevel(core.Skill.WOODCUTTING, 99);
  skills.setCurrentLevel(core.Skill.WOODCUTTING, 99);
  player.getInventory().resetItems();
  player.getInventory().add(new core.Item(core.ItemIdentifiers.RUNE_AXE), true);
  core.RegionManager.loadMapFiles(AT[0], AT[1]);
  const tree = new core.GameObject(core.ObjectIdentifiers.TREE, new core.Location(AT[0] + 1, AT[1], 0), 10, 0, null);
  core.ObjectManager.register(tree, true);
  t.after(() => {
    Woodcutting._test.setRegularTreeTicks(0);
    core.ObjectManager.deregister(tree, true);
    player.setRegistered(false);
    core.TaskManager.cancelTasks(player.getIndex());
  });
  // Every roll a log, never a nest.
  t.mock.method(Math, "random", () => (new Error().stack.includes("maybeDropBirdNest") ? 0.99 : 0));
  await connection.dispatch([{ type: "object_option", id: tree.getId(), x: AT[0] + 1, y: AT[1], action: "Chop down" }]);
  connection.processTurnPackets();
  const ticks = (count) => {
    for (let i = 0; i < count; i++) {
      core.TaskManager.processWalkTo(player.getIndex());
      player.getMovementQueue().process();
      core.TaskManager.process();
    }
  };
  const logs = () => player.getInventory().getAmount(core.ItemIdentifiers.LOGS);
  const stands = () => core.ObjectManager.objectsAt(tree.getLocation()).some((object) => object.getId() === tree.getId());
  return { player, ticks, logs, stands };
}

test("at 0 (OSRS) a regular tree falls with its first log", async (t) => {
  const f = await chopper(t, 0);
  f.ticks(20);
  assert.equal(f.logs(), 1);
  assert.equal(f.stands(), false, "a stump in its place");
  assert.equal(Woodcutting.isWoodcuttingActive(f.player), false);
});

test("above 0 it is chopped on like an oak, then falls once its time is up", async (t) => {
  const f = await chopper(t, 45);
  f.ticks(30);
  assert.ok(f.logs() >= 4, `several logs from one tree: ${f.logs()}`);
  assert.equal(f.stands(), true, "the tree still stands");
  assert.equal(Woodcutting.isWoodcuttingActive(f.player), true, "still chopping");
  const before = f.logs();
  f.ticks(40);
  assert.ok(f.logs() > before, "more logs before it fell");
  assert.equal(f.stands(), false, "its 45 ticks of chopping are up: a stump");
  assert.equal(Woodcutting.isWoodcuttingActive(f.player), false);
  assert.ok(f.logs() <= 20, `no more than its time allows: ${f.logs()}`);
});

test("the world's setting is what the plugin starts with, and the oak is as it was", () => {
  const regular = Woodcutting.TREES.find((tree) => tree.name === "normal tree");
  const oak = Woodcutting.TREES.find((tree) => tree.name === "oak");
  Woodcutting._test.setRegularTreeTicks(45);
  assert.deepEqual([regular.multi, regular.despawnTicks], [true, 45]);
  Woodcutting._test.setRegularTreeTicks(0);
  assert.deepEqual([regular.multi, regular.despawnTicks], [false, undefined]);
  Woodcutting._test.setRegularTreeTicks(NaN);
  assert.equal(regular.multi, false, "a bad value is OSRS");
  assert.deepEqual([oak.multi, oak.despawnTicks], [true, 45]);
  const world = require("../data/definitions/world.json");
  assert.equal(world.pluginConfig["Woodcutting:regularTreeTicks"], 45, "this world's own rule");
});
