// Run after `yarn build`: node --test tests/object-click-range.test.cjs
// A click on a loc names its tile, and the server looked that tile's loc up wherever it was, loading the map square
// (and the eight around it) to do so. A client could name tiles all over the world: one turn's 240 packets (2,640
// bytes) took 2.2 s of that turn, loaded 702 map squares and kept 250 MB (measured). The client draws at most 160
// tiles out, so a tile further than 256 from the player is now no loc at all. The real decoder and listeners, the
// real map.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, test } = require("node:test");
process.env.DISABLE_PLAYER_BOTS = "1";
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { RegionManager } = require("../dist/game/collision/RegionManager");
const { ObjectDefinition } = require("../dist/game/definition/ObjectDefinition");
const { MapObjects } = require("../dist/game/entity/impl/object/MapObjects");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { Location } = require("../dist/game/model/Location");
const { Item } = require("../dist/game/model/Item");
const { TaskManager } = require("../dist/game/task/TaskManager");
const { ObjectActionPacketListener } = require("../dist/net/packet/impl/ObjectActionPacketListener");
const { UseItemPacketListener } = require("../dist/net/packet/impl/UseItemPacketListener");
const { decodeClientPacket } = require("../dist/net/protocol/ClientProtocol");

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  RegionManager.init();
  ObjectDefinition.init();
  RegionManager.loadMapFiles(3222, 3218);
});

let index = 1910;
function actor(t) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel), new Location(3222, 3218, 0));
  p.setIndex(index++);
  p.setUsername("clickrange" + p.getIndex());
  p.setRegistered(true);
  p.setAttribute("bot-skip-persistence", true);
  p.needsPlacement = false;
  t.after(() => { p.setRegistered(false); TaskManager.cancelTasks(p.getIndex()); });
  return p;
}

/** LOC_INTERACT (opcode 231) as the client writes it: id, x, y, a byte, the option's name, the option's number. */
function locClick(id, x, y, option = 1) {
  const frame = Buffer.alloc(11);
  frame[0] = 231; frame[1] = 9;
  frame.writeUInt16BE(id, 2); frame.writeUInt16BE(x, 4); frame.writeUInt16BE(y, 6);
  frame[10] = option;
  return decodeClientPacket(frame);
}

const loaded = (x, y) => RegionManager.getRegionid(RegionManager.regionIdForTile(x, y))?.isLoaded() === true;
/** Tiles in map squares no test here stands near, and each test its own (a square stays loaded). */
const FAR = [[2850, 2950], [1500, 3500], [3000, 9800]];
const FAR_FOR_ITEMS = [[2400, 4400], [1300, 3800]];
const FAR_FOR_SPELLS = [[3800, 3500], [2600, 9500]];

test("a loc click naming a tile far across the world loads nothing", (t) => {
  const p = actor(t);
  const lookups = t.mock.method(MapObjects, "getPrivateArea");
  for (const [x, y] of FAR) {
    assert.equal(loaded(x, y), false, "not loaded before");
    const packet = locClick(1, x, y);
    new ObjectActionPacketListener().executeAction(p, packet.id, packet.x, packet.y, packet.clickType, packet.action);
    assert.equal(loaded(x, y), false, `the map square of ${x},${y} was not loaded for a click from Lumbridge`);
  }
  assert.equal(lookups.mock.callCount(), 0);
});

test("an item or a spell used on a loc far across the world loads nothing either", (t) => {
  const p = actor(t);
  p.getInventory().add(new Item(590, 1));
  for (const [x, y] of FAR_FOR_ITEMS) {
    assert.equal(loaded(x, y), false, "not loaded before");
    UseItemPacketListener.itemOnObject(p, 3214, 1, 590, 0, x, y);
    assert.equal(loaded(x, y), false, `the map square of ${x},${y} was not loaded for an item used from Lumbridge`);
  }
  for (const [x, y] of FAR_FOR_SPELLS) {
    assert.equal(loaded(x, y), false, "not loaded before");
    UseItemPacketListener.spellOnObject(p, 1, x, y, 0, 0, -1, -1);
    assert.equal(loaded(x, y), false, `the map square of ${x},${y} was not loaded for a spell cast from Lumbridge`);
  }
});

test("a loc as far away as the client can draw is still looked up, and one nearby still walked to", (t) => {
  const p = actor(t);
  const lookups = t.mock.method(MapObjects, "getPrivateArea");
  // 160 tiles east of Lumbridge Castle: the client's longest draw distance.
  const packet = locClick(1, 3222 + 160, 3218);
  new ObjectActionPacketListener().executeAction(p, packet.id, packet.x, packet.y, packet.clickType, packet.action);
  assert.equal(lookups.mock.callCount(), 1);

  // A real loc in the castle courtyard: found, and the walk to it queued.
  const near = [...MapObjects.mapObjects.values()].flat().find((object) => {
    const at = object.getLocation();
    return at.getZ() === 0 && Math.abs(at.getX() - 3222) <= 8 && Math.abs(at.getY() - 3218) <= 8
      && Math.max(Math.abs(at.getX() - 3222), Math.abs(at.getY() - 3218)) >= 3
      && ObjectDefinition.forId(object.getId())?.getInteractions()?.[0];
  });
  assert.ok(near, "a loc with a first option stands near the Lumbridge spawn");
  const click = locClick(near.getId(), near.getLocation().getX(), near.getLocation().getY());
  new ObjectActionPacketListener().executeAction(p, click.id, click.x, click.y, click.clickType, click.action);
  assert.equal(TaskManager.hasWalkToTask(p.getIndex()), true, "the click walks the player to the loc");
});
