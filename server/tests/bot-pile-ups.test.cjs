// Ours. Run after `yarn build`: node --test tests/bot-pile-ups.test.cjs
// Two ways a crowd of bots came to stand on a few tiles and never leave:
//   - at the Al Kharid toll gate, the check for "would opening this gate help" was measured
//     against a destination too far for the route finder to see, so the gate never looked
//     helpful and no bot clicked it (plugins/bots/brain/DoorOpening.PlayerBots.js);
//   - a bot holding one queued step it could not take waited for its queue to empty for good
//     (plugins/bots/brain/Brain.PlayerBots.js clearStaleQueue).
const assert = require("node:assert/strict");
const { test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { MapObjects } = require("../dist/game/entity/impl/object/MapObjects");
const { maybeOpenDoor } = require("../plugins/bots/brain/DoorOpening.PlayerBots");
const { BotBrain } = require("../plugins/bots/brain/Brain.PlayerBots");

const tile = (x, y, z = 0) => ({ getX: () => x, getY: () => y, getZ: () => z });

/** A world of one closed gate: `reach(destX, destY, gateOpen)` says whether a route gets there. */
function gateWorld(gate, reach) {
  let open = false;
  const walked = [];
  const world = {
    walked,
    emitted: [],
    core: {
      RegionManager: {
        getClipping: () => 0,
        removeObjectClipping: (object) => { if (object === gate) open = true; },
        addObjectClipping: (object) => { if (object === gate) open = false; },
      },
      RsmodRouteFinding: class {
        findRoute({ locShape, moveNear, destX, destY, srcX, srcY }) {
          // The exact route (entity reach): there, or not.
          if (locShape === -2 && !moveNear) return { success: reach(destX, destY, open) };
          // A stand tile beside the gate: always walkable here.
          if (!moveNear) return { success: true, endX: destX, endY: destY, waypoints: [] };
          // "As near as I can get": the bot's own tile, gate open or shut, unless it is reachable.
          return reach(destX, destY, open) ? { success: true, endX: destX, endY: destY } : { success: true, endX: srcX, endY: srcY };
        }
      },
      PathFinder: { calculateWalkRoute: (_player, x, y) => { walked.push(`${x},${y}`); return 1; } },
    },
    emitObjectInteraction: (payload) => { world.emitted.push(payload); return true; },
  };
  return world;
}

function withGate(x, y, run) {
  const gate = {
    getId: () => 2786,
    getLocation: () => tile(x, y),
    getDefinition: () => ({ name: "Gate", getInteractions: () => ["Open", "Pay-toll(10gp)"] }),
  };
  const hash = MapObjects.getHash(x, y, 0);
  const before = MapObjects.mapObjects.get(hash);
  MapObjects.mapObjects.set(hash, [gate]);
  try {
    run(gate);
  } finally {
    if (before) MapObjects.mapObjects.set(hash, before);
    else MapObjects.mapObjects.delete(hash);
  }
}

const walker = (x, y) => ({
  getUsername: () => "SiteBot7",
  getLocation: () => tile(x, y),
  getMovementQueue: () => ({ size: () => 0 }),
  getSize: () => 1,
});

test("a bot one step from the far side of a gate tries that gate, though its destination is out of the route finder's sight", () => {
  withGate(201, 100, (gate) => {
    // The mine is 60 tiles on: no route reaches it, gate open or shut. The tile just across
    // the gate is reached only through the gate.
    const world = gateWorld(gate, (x, y, open) => open && x === 201 && y === 100);
    const state = {};
    const request = { x: 260, y: 130, z: 0, lastSegmentX: 201, lastSegmentY: 100 };
    // A bot that owns what it carries, with no coins: it is given none for the toll.
    const added = [];
    const bot = {
      ...walker(200, 100),
      getAttribute: (name) => name === "bots:earns-items",
      getInventory: () => ({ getAmount: () => 0, adds: (id, amount) => added.push([id, amount]) }),
    };
    assert.equal(maybeOpenDoor({ player: bot, state, world, request, select: true }), true);
    // It stands beside the gate already, so the click is at once.
    assert.equal(world.emitted.length, 1, "the gate is clicked");
    assert.equal(world.emitted[0].object, gate);
    assert.deepEqual(added, [], "and the guards, not a conjured coin, settle the toll (objects/AlKharidGate)");
  });
});

test("when no gate helps with the next step, the destination itself is still the yardstick", () => {
  withGate(205, 104, (gate) => {
    // The step beside the bot is blocked by something no gate cures; the destination is
    // reached through the gate (a pen: the bot is past the gate's tile already).
    const world = gateWorld(gate, (x, y, open) => open && x === 210 && y === 110);
    const state = {};
    const request = { x: 210, y: 110, z: 0, lastSegmentX: 201, lastSegmentY: 100 };
    assert.equal(maybeOpenDoor({ player: walker(200, 100), state, world, request, select: true }), true);
    assert.equal(state.doorAttempt?.object, gate);
  });
});

test("with nothing a gate would cure, no gate is clicked", () => {
  withGate(201, 100, (gate) => {
    const world = gateWorld(gate, () => false);
    const state = {};
    const request = { x: 260, y: 130, z: 0, lastSegmentX: 201, lastSegmentY: 100 };
    assert.equal(maybeOpenDoor({ player: walker(200, 100), state, world, request, select: true }), false);
    assert.equal(state.doorAttempt ?? null, null);
    assert.deepEqual(world.walked, []);
  });
});

/** A bot whose movement queue holds `steps` steps it never takes. */
function heldBot({ steps = 1, blocked = false, hitpoints = 10, frozen = false } = {}) {
  const bot = {
    at: [3112, 3348, 0],
    steps,
    resets: 0,
    blocked,
    hitpoints,
    frozen,
  };
  const queue = {
    size: () => bot.steps,
    isMovementBlocked: () => bot.blocked,
    reset: () => { bot.resets++; bot.steps = 0; },
  };
  bot.player = {
    getUsername: () => "SiteBot42",
    getForceMovement: () => null,
    getLocation: () => tile(...bot.at),
    getMovementQueue: () => queue,
    getHitpoints: () => bot.hitpoints,
    getCombat: () => ({ getFreezeTimer: () => ({ finished: () => !bot.frozen }) }),
  };
  return bot;
}

function brainFor(bot) {
  const logged = [];
  const brain = new BotBrain({
    player: bot.player, state: {}, nowMs: 0,
    world: { log: (event, details) => logged.push([event, details]) },
    registry: { occupy() {}, release() {}, blockActivity() {}, pickActivity: () => null, resolversFor: () => [] },
    activity: { id: "idle", repeat: true, actions: [{ id: "wait", update: () => "running" }] },
  });
  return { brain, logged };
}

test("a queued step the bot never takes is dropped after a while, so it can plan again", () => {
  const bot = heldBot();
  const { brain, logged } = brainFor(bot);
  // A far bot's brain ticks seconds apart: three of its ticks and nine seconds, both.
  brain.dispatchMovement(0);
  brain.dispatchMovement(1000);
  brain.dispatchMovement(2000);
  brain.dispatchMovement(3000);
  assert.equal(bot.resets, 0, "ticks alone are not enough: a bot ticking fast may just be mid-step");
  brain.dispatchMovement(9500);
  assert.equal(bot.resets, 1, "nine seconds on one tile with a step queued");
  assert.deepEqual(logged, [["bot_brain_stale_queue", { username: "SiteBot42", at: "3112,3348,0" }]]);
});

test("time alone is not enough either, and a bot that is moving is left alone", () => {
  const bot = heldBot();
  const { brain } = brainFor(bot);
  brain.dispatchMovement(0);
  brain.dispatchMovement(20000);
  assert.equal(bot.resets, 0, "two looks, however far apart");
  // It takes a step: the count starts over from the new tile.
  bot.at = [3113, 3348, 0];
  brain.dispatchMovement(21000);
  brain.dispatchMovement(22000);
  brain.dispatchMovement(23000);
  assert.equal(bot.resets, 0);
  // An emptied queue forgets the wait altogether.
  bot.steps = 0;
  brain.dispatchMovement(40000);
  bot.steps = 1;
  brain.dispatchMovement(41000);
  brain.dispatchMovement(42000);
  brain.dispatchMovement(43000);
  assert.equal(bot.resets, 0);
  brain.dispatchMovement(51000);
  assert.equal(bot.resets, 1);
});

test("a bot that is held where it stands keeps its queue: an obstacle's walk, a freeze, its death", () => {
  for (const held of [{ blocked: true }, { frozen: true }, { hitpoints: 0 }]) {
    const bot = heldBot(held);
    const { brain, logged } = brainFor(bot);
    for (const at of [0, 4000, 8000, 12000, 16000]) brain.dispatchMovement(at);
    assert.equal(bot.resets, 0, JSON.stringify(held));
    assert.deepEqual(logged, []);
  }
});
