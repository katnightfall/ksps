// Run after `yarn build`: node --test tests/fishing-guild-door.test.cjs
// Ours (the user's report, 2026-11-21: "the door disappears when we open it"): the Fishing Guild's front door
// (fishguilddoor 20925, the south edge of 2611,3394) was hidden from the player while they crossed. It now swings as
// the captured guild doors do (Doors.plugin.js PASS_THROUGH_GATES): inviswall on the doorway, the door swung onto
// the tile outside, the player steps across, and the door is back two ticks later. 68 Fishing to go in.
// Real engine: every plugin loaded, the real map door through PluginManager.emitObjectInteraction and World ticks.
process.env.DISABLE_PLAYER_BOTS = "1";
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { MapObjects } = require("../dist/game/entity/impl/object/MapObjects");
const { ObjectDefinition } = require("../dist/game/definition/ObjectDefinition");

const DOOR = 20925;
const INVISWALL = 38848;
const REFUSAL = "You need a Fishing level of 68 to enter the Fishing Guild.";
let core;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  ObjectDefinition.init();
  core.RegionManager.init();
  core.RegionManager.loadMapFiles(2611, 3394);
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));

function fisher(t, level, [x, y]) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel));
  p.setUsername(`guilddoor${level}${x}${y}`);
  p.setAttribute("bot-skip-persistence", true);
  p.setLocation(new core.Location(x, y, 0));
  assert.equal(core.World.getPlayers().add(p), true);
  p.needsPlacement = false;
  p.getSkillManager().setMaxLevel(core.Skill.FISHING, level).setCurrentLevel(core.Skill.FISHING, level);
  const messages = [];
  t.mock.method(p.getPacketSender(), "sendMessage", (m) => { messages.push(m); return p.getPacketSender(); });
  t.after(() => {
    core.TaskManager.cancelTasks(p);
    if (p.isRegistered()) core.World.getPlayers().removes(p);
  });
  return { p, messages };
}

/** Wall locs (shape 0) on a tile: [id, face]. */
function walls(x, y) {
  return MapObjects.getObjectsAt(new core.Location(x, y, 0), null)
    .filter((o) => o.getType() === 0).map((o) => [o.getId(), o.getFace()]);
}

function open(f, [x, y] = [2611, 3394]) {
  const door = MapObjects.getObjectsAt(new core.Location(x, y, 0), null).find((o) => o.getId() === DOOR);
  assert.ok(door, `the guild door is at ${x},${y}`);
  const event = { player: f.p, object: door, objectId: DOOR, definition: ObjectDefinition.forId(DOOR), clickType: 1,
    location: { x, y, z: 0 }, sourceLocation: { x: f.p.getLocation().getX(), y: f.p.getLocation().getY(), z: 0 }, handled: false };
  PM.emitObjectInteraction(event);
  return event;
}

const at = (f) => [f.p.getLocation().getX(), f.p.getLocation().getY()];

test("at 68 Fishing the door swings open onto the tile outside, the player steps in, and it shuts two ticks later", (t) => {
  assert.deepEqual(walls(2611, 3394), [[DOOR, 3]], "closed on the doorway's south edge");
  const f = fisher(t, 68, [2611, 3393]);
  assert.equal(open(f).handled, true);
  assert.deepEqual(walls(2611, 3394), [[INVISWALL, 3]], "the doorway stays solid for everyone else");
  assert.deepEqual(walls(2611, 3393), [[DOOR, 0]], "the door is still there, swung open");
  core.World.process();
  assert.deepEqual(at(f), [2611, 3394], "in");
  core.World.process();
  core.World.process();
  assert.deepEqual(walls(2611, 3394), [[DOOR, 3]], "shut again");
  assert.deepEqual(walls(2611, 3393), []);
  assert.deepEqual(f.messages, []);
});

test("leaving is free, and the door swings the same way", (t) => {
  const f = fisher(t, 1, [2611, 3394]);
  assert.equal(open(f).handled, true);
  assert.deepEqual(walls(2611, 3393), [[DOOR, 0]]);
  core.World.process();
  assert.deepEqual(at(f), [2611, 3393], "out");
  core.World.process();
  core.World.process();
  assert.deepEqual(walls(2611, 3394), [[DOOR, 3]]);
});

test("below 68 the door stays shut, even swung open by someone else", (t) => {
  const low = fisher(t, 67, [2610, 3393]);
  open(low);
  assert.ok(low.messages.includes(REFUSAL));
  assert.deepEqual(walls(2611, 3394), [[DOOR, 3]], "not opened");

  const member = fisher(t, 99, [2611, 3393]);
  open(member);
  assert.deepEqual(walls(2611, 3393), [[DOOR, 0]]);
  low.messages.length = 0;
  open(low, [2611, 3393]);
  assert.ok(low.messages.includes(REFUSAL), "the swung door is checked too");
  core.World.process();
  core.World.process();
  core.World.process();
  assert.deepEqual(at(low), [2610, 3393], "still outside");
  assert.deepEqual(walls(2611, 3394), [[DOOR, 3]]);
});
