// Run after `yarn build`: node --test tests/logout-walk-to-task.test.cjs
// A click that walks the player to something (a ground item, an object, an NPC, another player) queues a walk-to
// task under the player's index. Logging out cancelled only the tasks under the Player object, so that task
// outlived its player: every cycle it was swept up with the walk-tos of players who took no turn and worked out a
// new route for somebody no longer in the world, until the next player given that index clicked something (which
// cancels every task under the index). Real Player, real walk-to, real onLogout, the real map.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, test } = require("node:test");
process.env.DISABLE_PLAYER_BOTS = "1";
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { Location } = require("../dist/game/model/Location");
const { RegionManager } = require("../dist/game/collision/RegionManager");
const { TaskManager } = require("../dist/game/task/TaskManager");
const { World } = require("../dist/game/World");
const { PathFinder } = require("../dist/game/model/movement/path/PathFinder");

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  RegionManager.init();
  RegionManager.loadMapFiles(3222, 3218);
});

function actor(index, x, y) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel), new Location(x, y, 0));
  p.setIndex(index);
  p.setUsername("walkto" + index);
  p.setRegistered(true);
  p.setAttribute("bot-skip-persistence", true);
  p.needsPlacement = false;
  return p;
}

/** One world cycle for nobody: the task pass, then the sweep for walk-tos whose owner took no turn. */
function cycle() {
  World.processCycle++;
  TaskManager.process();
  TaskManager.processRemainingWalkTo();
}

test("a walk-to is cancelled when its player logs out", (t) => {
  const p = actor(1901, 3222, 3218);
  t.after(() => TaskManager.cancelTasks(1901));
  let acted = false;
  // Lumbridge Castle's courtyard: a walk of several tiles, so the task is still walking at the logout.
  p.getMovementQueue().walkToTile(new Location(3222, 3224, 0), () => { acted = true; });
  assert.equal(TaskManager.hasWalkToTask(1901), true, "the click queued a walk-to under the player's index");

  p.onLogout();
  p.setRegistered(false);
  const routes = t.mock.method(PathFinder, "calculateGroundItemRoute");
  for (let i = 0; i < 12; i++) cycle();
  assert.equal(routes.mock.callCount(), 0, "no route is worked out for a player who has left");
  assert.equal(TaskManager.hasWalkToTask(1901), false, "the logout cancelled the walk-to");
  assert.equal(acted, false);
});

test("the next player given that index does not inherit the walk-to", (t) => {
  const first = actor(1902, 3222, 3218);
  t.after(() => TaskManager.cancelTasks(1902));
  let acted = 0;
  first.getMovementQueue().walkToTile(new Location(3222, 3224, 0), () => { acted++; });
  first.onLogout();
  first.setRegistered(false);

  const second = actor(1902, 3222, 3220);
  assert.equal(TaskManager.hasWalkToTask(second.getIndex()), false, "a fresh login has no interaction pending");
  for (let i = 0; i < 6; i++) {
    TaskManager.process();
    TaskManager.processWalkTo(second.getIndex());
  }
  assert.equal(acted, 0);
});
