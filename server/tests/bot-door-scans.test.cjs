// Ours. Run after `yarn build`: node --test tests/bot-door-scans.test.cjs
// What a bot's "would opening a door help?" scan costs (plugins/bots/brain/DoorOpening.PlayerBots.js).
// With a world's whole crowd walking, the scan took a third of the time the bots are given to
// think in, so every bot's turn came round less often. It now makes one route search where it
// made two, stops at the first door that makes the target reachable, and a bot that asks what
// another just asked from the same tile is given that bot's answer.
const assert = require("node:assert/strict");
const { test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { MapObjects } = require("../dist/game/entity/impl/object/MapObjects");
const { maybeOpenDoor, routeDistance } = require("../plugins/bots/brain/DoorOpening.PlayerBots");

const tile = (x, y, z = 0) => ({ getX: () => x, getY: () => y, getZ: () => z });

/**
 * A world of closed gates whose route finder answers as the real one does: asked for the exact
 * reach "or as near as you can get", it says which it found. `reach(destX, destY, open)` says
 * whether a route gets there, `open` being the gates whose clipping is lifted for the test.
 */
function countingWorld(reach) {
  const open = new Set();
  const world = {
    searches: 0,
    walked: [],
    core: {
      RegionManager: {
        getClipping: () => 0,
        removeObjectClipping: (object) => open.add(object),
        addObjectClipping: (object) => open.delete(object),
      },
      RsmodRouteFinding: class {
        findRoute({ locShape, moveNear, destX, destY, srcX, srcY }) {
          world.searches += 1;
          if (locShape === -2) {
            if (reach(destX, destY, open)) return { success: true, alternative: false, endX: destX, endY: destY, waypoints: [] };
            // Not reachable: the bot's own tile is as near as it gets, when near will do.
            return moveNear ? { success: true, alternative: true, endX: srcX, endY: srcY, waypoints: [] } : { success: false, alternative: false, endX: srcX, endY: srcY, waypoints: [] };
          }
          // A stand tile beside a gate: always walkable here.
          return { success: true, alternative: false, endX: destX, endY: destY, waypoints: [] };
        }
      },
      PathFinder: { calculateWalkRoute: (_player, x, y) => { world.walked.push(`${x},${y}`); return 1; } },
    },
    emitObjectInteraction: () => true,
  };
  return world;
}

function gateAt(x, y, id = 2786) {
  const gate = {
    closed: true,
    getId: () => id,
    getLocation: () => tile(x, y),
    getDefinition: () => ({ name: "Gate", getInteractions: () => (gate.closed ? ["Open"] : ["Close"]) }),
  };
  return gate;
}

/** Puts the gates on the map for the length of `run`. */
function withGates(gates, run) {
  const before = new Map();
  for (const gate of gates) {
    const at = gate.getLocation();
    const hash = MapObjects.getHash(at.getX(), at.getY(), 0);
    if (!before.has(hash)) before.set(hash, MapObjects.mapObjects.get(hash));
    MapObjects.mapObjects.set(hash, [...(MapObjects.mapObjects.get(hash) ?? []).filter((object) => !gates.includes(object)), gate]);
  }
  try {
    run();
  } finally {
    for (const [hash, objects] of before) {
      if (objects) MapObjects.mapObjects.set(hash, objects);
      else MapObjects.mapObjects.delete(hash);
    }
  }
}

const walker = (x, y, name = "SiteBot7") => ({
  getUsername: () => name,
  getLocation: () => tile(x, y),
  getMovementQueue: () => ({ size: () => 0 }),
  getSize: () => 1,
});

test("how far a route gets is one search: there, as near as it gets, or nowhere", () => {
  const world = countingWorld((x, y) => x === 110 && y === 100);
  const finder = new world.core.RsmodRouteFinding();
  assert.equal(routeDistance(finder, walker(100, 100), 110, 100), 0, "reachable");
  assert.equal(world.searches, 1);
  // Not reachable, and the bot's own tile is the nearest: 1 + the 12 tiles still to go.
  assert.equal(routeDistance(finder, walker(100, 100), 112, 100), 13);
  assert.equal(world.searches, 2);
  world.core.RsmodRouteFinding.prototype.findRoute = () => { world.searches += 1; return { success: false, alternative: false }; };
  assert.equal(routeDistance(finder, walker(100, 100), 112, 100), Number.MAX_SAFE_INTEGER, "nothing near it either");
  assert.equal(world.searches, 3);
});

test("a route finder that does not say which it found is asked both ways, as before", () => {
  let searches = 0;
  const finder = {
    findRoute({ locShape, moveNear }) {
      searches += 1;
      if (locShape === -2 && !moveNear) return { success: false };
      return { success: true, endX: 103, endY: 100 };
    },
  };
  assert.equal(routeDistance(finder, walker(100, 100), 110, 100), 8);
  assert.equal(searches, 3, "the one that could not be read, then the two");
});

test("the scan stops at the first door that makes the target reachable", () => {
  const near = gateAt(195, 100, 1);
  const far = gateAt(198, 100, 2);
  withGates([near, far], () => {
    // Either gate alone lets the bot through.
    const world = countingWorld((x, y, open) => x === 210 && y === 100 && open.size > 0);
    const state = {};
    assert.equal(maybeOpenDoor({ player: walker(190, 100), state, world, request: { x: 210, y: 100, z: 0 }, select: true }), true);
    assert.equal(state.doorAttempt.object, near, "the nearer one");
    // The route as it is, the near gate lifted, and its eight stand tiles: the far gate is never tried.
    assert.equal(world.searches, 10);
  });
});

test("the next bot on the same tile, going the same way, is given the door the first one found", () => {
  const gate = gateAt(201, 100);
  withGates([gate], () => {
    const world = countingWorld((x, y, open) => x === 210 && y === 100 && open.has(gate));
    const request = () => ({ x: 210, y: 100, z: 0 });
    const first = {};
    assert.equal(maybeOpenDoor({ player: walker(190, 100, "SiteBot1"), state: first, world, request: request(), select: true }), true);
    assert.ok(world.searches > 0);
    const searched = world.searches;

    const second = {};
    assert.equal(maybeOpenDoor({ player: walker(190, 100, "SiteBot2"), state: second, world, request: request(), select: true }), true);
    assert.equal(world.searches, searched, "no route search for the second bot's scan");
    assert.equal(second.doorAttempt.object, gate);
    assert.deepEqual(second.doorAttempt.stand, first.doorAttempt.stand);
    assert.equal(world.walked.length, 2, "and it sets off for the gate as the first did");

    // From another tile it is another question.
    const third = {};
    maybeOpenDoor({ player: walker(191, 100, "SiteBot3"), state: third, world, request: request(), select: true });
    assert.ok(world.searches > searched);
    assert.equal(third.doorAttempt.object, gate);
  });
});

test("a door found is not handed to a bot that has just been through it, nor once it stands open", () => {
  const gate = gateAt(201, 100);
  withGates([gate], () => {
    const world = countingWorld((x, y, open) => x === 210 && y === 100 && open.has(gate));
    const ask = (state, name) => maybeOpenDoor({ player: walker(190, 100, name), state, world, request: { x: 210, y: 100, z: 0 }, select: true });
    assert.equal(ask({}, "SiteBot1"), true);

    // This bot opened it seconds ago (a door that shuts by itself keeps its id): it looks for
    // another, finds none, and that "none" is its own, not the next bot's.
    const through = { recentDoorKeys: { "2786:201,100,0": Date.now() + 30000 } };
    assert.equal(ask(through, "SiteBot2"), false);
    assert.equal(through.doorAttempt ?? null, null);
    const next = {};
    assert.equal(ask(next, "SiteBot3"), true, "the next bot still has the first one's answer");
    assert.equal(next.doorAttempt.object, gate);

    // Somebody opens it: nothing is clicked on the strength of an old answer.
    gate.closed = false;
    const late = {};
    assert.equal(ask(late, "SiteBot4"), false);
    assert.equal(late.doorAttempt ?? null, null);
  });
});

test("\"no door helps\" is kept for the next bot too, but only a short while", (t) => {
  const gate = gateAt(201, 100);
  withGates([gate], () => {
    const world = countingWorld(() => false);
    const ask = (name) => maybeOpenDoor({ player: walker(190, 100, name), state: {}, world, request: { x: 260, y: 130, z: 0 }, select: true });
    assert.equal(ask("SiteBot1"), false);
    const searched = world.searches;
    assert.ok(searched > 0);
    assert.equal(ask("SiteBot2"), false);
    assert.equal(world.searches, searched, "the second bot does not search again");

    // Half a minute on the world may have changed: the question is asked afresh.
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    t.mock.timers.tick(21000);
    assert.equal(ask("SiteBot3"), false);
    assert.ok(world.searches > searched);
  });
});
