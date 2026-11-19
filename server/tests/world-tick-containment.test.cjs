// Run after `yarn build`: node --test tests/world-tick-containment.test.cjs
// One failing piece of a world cycle must not take the rest of the cycle with it. A thrown error used to leave
// World.process at once: nobody after that point was synced or flushed that cycle, GameEngine saved every player
// ("tick-error"), and where the cause stayed (a plugin's boat listener, a logout request that was never cleared)
// the same happened on every cycle after. The real World.process, BoatManager, HitQueue and a real Player.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, beforeEach, test } = require("node:test");
process.env.DISABLE_PLAYER_BOTS = "1";
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { World } = require("../dist/game/World");
const { BoatManager } = require("../dist/game/content/sailing/BoatManager");
const { HitQueue } = require("../dist/game/content/combat/hit/HitQueue");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { Location } = require("../dist/game/model/Location");

before(async () => { await CachePipeline.initialize(path.resolve(__dirname, "..")); });

let errors;
beforeEach((t) => {
  errors = [];
  t.mock.method(console, "error", (...args) => { errors.push(args); });
  t.mock.method(console, "log", () => {});
});

/** Whether the cycle got as far as the hit sweep, which runs after the boats. */
function ranToTheEnd(t) {
  const sweep = t.mock.method(HitQueue, "processAll", () => {});
  return () => sweep.mock.callCount();
}

test("a boat listener that throws stops neither the other listeners nor the rest of the cycle", (t) => {
  const listeners = BoatManager.afterTickListeners;
  const before = listeners.length;
  t.after(() => { listeners.length = before; });
  let later = 0;
  BoatManager.onAfterTick(() => { throw new Error("a plugin's boat listener failed (expected by this test)"); });
  BoatManager.onAfterTick(() => { later++; });
  const reached = ranToTheEnd(t);

  for (let cycle = 0; cycle < 3; cycle++) assert.doesNotThrow(() => World.process());
  assert.equal(later, 3, "the listener registered after it ran every cycle");
  assert.equal(reached(), 3, "and so did the rest of the cycle");
  assert.ok(errors.length >= 1, "the failure was reported");
  assert.ok(errors.length < 3, "but not once a cycle");
});

test("a logout request that fails is dropped, not retried on every cycle, and the cycle goes on", (t) => {
  const channel = {
    kind: "test", remoteAddress: "127.0.0.1", readyState: 1, isOpen: () => true, send: () => true,
    close() { throw new Error("the connection failed while closing (expected by this test)"); },
    onData() {}, onError() {}, onClose() {},
  };
  const p = new Player(new PlayerSession(channel), new Location(3222, 3218, 0));
  p.setIndex(1903);
  p.setUsername("logoutfails");
  p.setAttribute("bot-skip-persistence", true);
  let otherClosed = 0;
  const other = new Player(new PlayerSession({ ...channel, close() { otherClosed++; } }), new Location(3222, 3218, 0));
  other.setIndex(1904);
  other.setUsername("logoutworks");
  other.setAttribute("bot-skip-persistence", true);
  t.after(() => {
    for (const player of [p, other]) {
      const queued = World.getRemovePlayerQueue().indexOf(player);
      if (queued >= 0) World.getRemovePlayerQueue().splice(queued, 1);
    }
    World.logoutRequests.clear();
  });
  const reached = ranToTheEnd(t);

  // Past the first cycles of a world, in which nobody counts as out of combat yet.
  World.processCycle += 100;
  World.queueLogoutRequest(p);
  World.queueLogoutRequest(other);
  assert.doesNotThrow(() => World.process());
  assert.equal(reached(), 1, "the rest of the cycle ran");
  assert.equal(World.logoutRequests.size, 0, "the requests were answered once");
  assert.equal(otherClosed, 1, "the player after the failing one was logged out");
});

test("one hit queue that throws does not stop the sweep of the others", () => {
  const failing = { process() { throw new Error("a hit failed to land (expected by this test)"); } };
  let swept = 0;
  const working = { process() { swept++; } };
  HitQueue.active.add(failing);
  HitQueue.active.add(working);
  try {
    assert.doesNotThrow(() => HitQueue.processAll(1));
    assert.equal(swept, 1);
  } finally {
    HitQueue.active.delete(failing);
    HitQueue.active.delete(working);
  }
});
