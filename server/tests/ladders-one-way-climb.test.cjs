// Run after `yarn build`: node --test tests/ladders-one-way-climb.test.cjs
//
// Upstream issue #5158 (The Ascent of Arceuus, the Tower of Magic's stairs): a plain "Climb" on stairs
// that only go one way is climbed; "Which way would you like to climb?" is only asked where both ways
// exist (the Lumbridge mill's first-floor ladder). The real Ladders plugin on the cache's own map objects.
const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const path = require("node:path");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { RegionManager } = require("../dist/game/collision/RegionManager");
const { MapObjects } = require("../dist/game/entity/impl/object/MapObjects");
const { Location } = require("../dist/game/model/Location");

const named = new Map();
const tasks = [];
const prompts = [];

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  RegionManager.init();
  const noop = () => {};
  const api = new Proxy(
    {
      core: PluginManager.getCoreApi(),
      getTaskManager: () => ({ submit: (task) => tasks.push(task) }),
      onObjectInteraction: (name, actions) => named.set(name, actions),
      emitCustomEvent: noop,
      sendMultiChatboxPrompt: (player, title, ...pairs) => { prompts.push({ player, title, pairs }); return true; },
    },
    { get: (target, key) => target[key] ?? noop },
  );
  require("../plugins/objects/Ladders.plugin").register(api);
});

function mapObject(id, x, y, z) {
  RegionManager.loadMapFiles(x, y);
  const object = (MapObjects.mapObjects.get(MapObjects.getHash(x, y, z)) ?? []).find((o) => o.getId() === id);
  assert.ok(object, `object ${id} at ${x},${y},${z}`);
  return object;
}

function climber(x, y, z) {
  let location = new Location(x, y, z);
  const movement = { blocked: false, isMovementBlocked() { return this.blocked; }, setBlockMovement(value) { this.blocked = value; return this; }, reset() { return this; }, didMovePreviousCycle: () => false };
  return {
    animations: [],
    getLocation: () => location, moveTo: (to) => { location = to; }, getMovementQueue: () => movement,
    getPrivateArea: () => null, getHitpoints: () => 10, performAnimation(animation) { this.animations.push(animation.getId()); },
  };
}

/** Clicks "Climb" on a map object from a tile, then runs the climb's task to its end. */
function climb(name, object, from) {
  const player = climber(...from);
  const [x, y, z] = [object.getLocation().getX(), object.getLocation().getY(), object.getLocation().getZ()];
  prompts.length = 0;
  tasks.length = 0;
  const result = named.get(name).Climb({ player, object, objectId: object.getId(), clickType: 1, location: { x, y, z }, definition: object.getDefinition() });
  // The climb's task: the animation on its first cycle, the move on its second.
  for (let tick = 0; tick < 3; tick++) for (const task of tasks) task.execute();
  const at = player.getLocation();
  return { result, prompted: prompts.length, at: [at.getX(), at.getY(), at.getZ()] };
}

test("the Tower of Magic's stairs each go their one way without a question", () => {
  // [stairs id, its tile, the tile the player clicks from, where the climb lands]
  const stairs = [
    [33574, [1584, 3818, 0], [1586, 3818, 0], [1580, 3818, 1]],
    [33575, [1584, 3820, 0], [1586, 3820, 0], [1580, 3820, 1]],
    [33576, [1581, 3818, 1], [1580, 3818, 1], [1587, 3818, 0]],
    [33577, [1581, 3820, 1], [1580, 3820, 1], [1587, 3820, 0]],
  ];
  for (const [id, tile, from, lands] of stairs) {
    const object = mapObject(id, ...tile);
    assert.deepEqual(object.getDefinition().getInteractions().filter(Boolean), ["Climb"], `${id} only offers Climb`);
    const outcome = climb("Stairs", object, from);
    assert.equal(outcome.prompted, 0, `${id}: no "Which way" question`);
    assert.deepEqual(outcome.at, lands, `${id} lands at the other end of the flight`);
  }
});

test("a Climb that can go both ways still asks (the Lumbridge mill's first floor)", () => {
  const ladder = mapObject(12965, 3164, 3307, 1);
  assert.ok(ladder.getDefinition().getInteractions().includes("Climb"));
  const outcome = climb("Ladder", ladder, [3165, 3307, 1]);
  assert.equal(outcome.prompted, 1);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].title, "Which way would you like to climb?");
  assert.deepEqual(outcome.at, [3165, 3307, 1], "nobody moves until an answer is picked");
});
