// Run after `yarn build`: node --test tests/sins-escort-rooms.test.cjs
//
// Sins of the Father (upstream issue #6068): the Ivan escort plays in the player's own copies of the
// Temple Trekking rooms (the river, the nail beasts, the broken bridge, the juvinates) instead of on
// open swamp tiles, where there was no big tree to throw the long vine over and no bridge to mend.
// Real plugins, a real Player, the real instances and map objects; every step is the real hook
// (dialogue action, object click, item on item/object, NPC death). No client ran.
process.env.DISABLE_PLAYER_BOTS = "1";
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { NpcDefinitionLoader } = require("../dist/game/definition/loader/impl/NpcDefinitionLoader");
const { RegionManager } = require("../dist/game/collision/RegionManager");
const { MapObjects } = require("../dist/game/entity/impl/object/MapObjects");
const QuestRuntime = require("../plugins/quests/QuestRuntime");
const ROOMS = require("../plugins/minigames/data/temple-trekking.json").rooms;

const STAGE_MEETING = 34, STAGE_ESCORT = 36, STAGE_ESCORT_DONE = 38;
const BITS = "quest.sins_of_the_father.bits";
const BIT_TREK = 1 << 13, BIT_BRIDGE = 1 << 15, NAIL_SHIFT = 16;
const IVAN = 9536, NAIL_BEASTS = [9612, 9613], JUVINATES = [9614, 9615], ZOMBIE = 5647;
const BRANCH = 38004, BRANCH_WITH_VINE = 38005, SMALL_TREE = 13847, RUCKSACK = 13872, DEAD_TREE = 1365;
const BRIDGE = [13834, 13835, 13836, 13837];
const KNIFE = 946, SHORT_VINE = 7778, LONG_VINE = 7777, LOGS = 1511, BRONZE_AXE = 1351;
const START_ESCORT = "_popnC", IVAN_DEPARTS = "uD7Qcw";
let core, quest;
let index = 7740;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  new NpcDefinitionLoader().load();
  RegionManager.init();
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  PM.emitServerStartup({});
  quest = QuestRuntime.getRegisteredQuests().find((entry) => entry.key === "sins_of_the_father");
});
after(() => PM.emitServerShutdown({}));

function player(t, name, stage) {
  const channel = {
    kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true,
    close() {}, onData() {}, onError() {}, onClose() {},
  };
  const p = new Player(new PlayerSession(channel));
  p.setIndex(index++);
  p.setUsername(name);
  p.setRegistered(true);
  p.setLocation(new core.Location(3444, 3484, 0));
  p.needsPlacement = false;
  p.messages = [];
  const send = p.sendMessage.bind(p);
  p.sendMessage = (text) => { p.messages.push(String(text)); return send(text); };
  t.after(() => {
    PM.emitPlayerLogout({ player: p, username: p.getUsername() });
    p.setRegistered(false);
  });
  quest.setStage(p, stage);
  return p;
}

const action = (p, stepId) => PM.emitCustomEvent("npc-dialogue:action", { player: p, npcId: IVAN, stepId });
const ticks = (n) => { for (let i = 0; i < n; i++) core.TaskManager.process(); };
const room = (p) => p.getArea();
/** The room tile the player (or a location) stands for, as the room's own map coordinates. */
const source = (p, location = p.getLocation()) => {
  const at = room(p).toSource(location);
  return [at.getX(), at.getY(), at.getZ()];
};
const tile = (p, [x, y]) => room(p).sourceTile(x, y, 0);
/** The loc on a room tile: the room's own (placed by the quest) first, else the copied map's. */
function loc(p, id, at, type = 10) {
  const where = tile(p, at);
  return MapObjects.get(id, where, room(p))
    ?? (room(p).getTemplateObjects?.(where) ?? []).find((object) => object.getId() === id && object.getType() === type)
    ?? null;
}
function click(p, object, clickType = 1) {
  assert.ok(object, "the loc to click is there");
  const event = { player: p, object, objectId: object.getId(), location: object.getLocation(), clickType };
  PM.emitObjectInteraction(event);
  return event;
}
/** The quest's NPCs of an id in the player's room. */
const actors = (p, id) => [...core.World.getAddNPCQueue(), ...core.World.getNpcs()]
  .filter((npc) => npc && npc.getId() === id && npc.getOwner?.() === p && npc.isRegistered?.() !== false && room(p).contains(npc.getLocation()));
const kill = (p, npc) => PM.emitNpcDeath({ killer: p, npc, npcId: npc.getId() });
const amount = (p, id) => p.getInventory().getAmount(id);
const inRoom = (p, name) => String(room(p)?.getName?.() ?? "") === `sins-trek-${name} scene`;

test("the escort goes room by room: the river, the nail beasts, the bridge, the juvinates, Burgh de Rott", (t) => {
  const p = player(t, "sinsescort1", STAGE_MEETING);
  action(p, START_ESCORT);
  assert.equal(quest.getStage(p), STAGE_ESCORT);

  // The river room: the player and Ivan south of the bog, the backpack, the big tree's bare branch.
  assert.ok(inRoom(p, "river"), `in the river room (${room(p)?.getName?.()})`);
  assert.deepEqual(source(p), [...ROOMS.river.entry, 0]);
  assert.equal(actors(p, IVAN).length, 1, "Ivan came along");
  assert.deepEqual(source(p, actors(p, IVAN)[0].getLocation()), [...ROOMS.river.follower, 0]);
  assert.deepEqual(p.getAttribute("sins-of-the-father:trek-exit"), [3444, 3484, 0], "a logout comes back beside Ivan's starting place");
  assert.ok(loc(p, RUCKSACK, ROOMS.river.rucksack), "the backpack");
  assert.ok(loc(p, BRANCH, ROOMS.river.branch), "the branch to throw the long vine over");
  const tree = loc(p, SMALL_TREE, ROOMS.river.tree);
  assert.ok(tree, "the small swamp tree with vines, from the room's own map");

  // No knife: the backpack has one. Three cuts, twisted into a long vine, thrown over the branch.
  click(p, tree);
  assert.equal(amount(p, SHORT_VINE), 0, "no vine without a knife");
  click(p, loc(p, RUCKSACK, ROOMS.river.rucksack));
  assert.equal(amount(p, KNIFE), 1, "the backpack's knife");
  for (let i = 0; i < 3; i++) click(p, tree);
  assert.equal(amount(p, SHORT_VINE), 3);
  // Temple Trekking's twist and the quest's both answer to two short vines; whichever takes it, one long vine comes of it.
  PM.emitItemOnItem({ player: p, usedItemId: SHORT_VINE, usedWithItemId: SHORT_VINE, usedItem: new core.Item(SHORT_VINE, 1), usedWithItem: new core.Item(SHORT_VINE, 1) });
  ticks(4);
  assert.equal(amount(p, LONG_VINE), 1);
  assert.equal(amount(p, SHORT_VINE), 0);
  const branch = loc(p, BRANCH, ROOMS.river.branch);
  PM.emitItemOnObject({ player: p, itemId: LONG_VINE, objectId: BRANCH, object: branch, location: branch.getLocation() });
  assert.equal(amount(p, LONG_VINE), 0, "the vine is on the branch");
  const vine = loc(p, BRANCH_WITH_VINE, ROOMS.river.branch);
  assert.ok(vine, "the branch now has the vine to swing from");
  assert.equal(vine.getDefinition().getInteractions()[0], "Swing-from");

  // Swinging across: the nail beasts' room (the hollows room of capture 1637).
  click(p, vine);
  assert.equal(p.getAttribute(BITS) & BIT_TREK, BIT_TREK);
  assert.ok(inRoom(p, "nails"), `in the nail beasts' room (${room(p)?.getName?.()})`);
  assert.deepEqual(source(p), [2334, 5005, 0], "capture 1637's start tile");
  assert.equal(actors(p, IVAN).length, 1);
  const beasts = NAIL_BEASTS.map((id) => actors(p, id)[0]);
  assert.deepEqual(beasts.map((npc) => source(p, npc.getLocation())), [[2332, 5008, 0], [2328, 5010, 0]], "capture 1637's two spawn tiles");
  kill(p, beasts[0]);
  ticks(3);
  assert.ok(inRoom(p, "nails"), "one nail beast left: still here");
  kill(p, beasts[1]);
  assert.equal((p.getAttribute(BITS) >> NAIL_SHIFT) & 3, 2);
  ticks(3);

  // The broken bridge: the zombie with the axe, dead trees for logs, three logs to mend it.
  assert.ok(inRoom(p, "bridge"), `in the bridge room (${room(p)?.getName?.()})`);
  assert.deepEqual(source(p), [...ROOMS.bridge.entry, 0]);
  assert.equal(actors(p, ZOMBIE).length, 1);
  const broken = loc(p, BRIDGE[0], ROOMS.bridge.bridge, 22);
  assert.ok(broken, "the broken bridge, from the room's own map");
  assert.equal(broken.getDefinition().getInteractions()[0], "Inspect");
  click(p, broken);
  assert.ok(p.messages.some((text) => text.includes("axe")), "no axe: told so");
  kill(p, actors(p, ZOMBIE)[0]);
  assert.equal(amount(p, BRONZE_AXE), 1, "the zombie's axe");
  const [tx, ty] = ROOMS.bridge.trees.find(([x, y]) => loc(p, DEAD_TREE, [x, y]));
  for (let i = 0; i < 3; i++) click(p, loc(p, DEAD_TREE, [tx, ty]));
  assert.equal(amount(p, LOGS), 3, "three logs from a dead tree");
  for (let stage = 0; stage < 3; stage++) {
    click(p, loc(p, BRIDGE[stage], ROOMS.bridge.bridge, 22));
    assert.ok(loc(p, BRIDGE[stage + 1], ROOMS.bridge.bridge, 22), `bridge stage ${stage + 1}`);
  }
  assert.equal(amount(p, LOGS), 0);
  const fixed = loc(p, BRIDGE[3], ROOMS.bridge.bridge, 22);
  assert.equal(fixed.getDefinition().getInteractions()[0], "Cross");
  click(p, fixed);
  assert.equal(p.getAttribute(BITS) & BIT_BRIDGE, BIT_BRIDGE);

  // The juvinates, then Ivan's last words take the player to Burgh de Rott.
  assert.ok(inRoom(p, "juvinates"), `in the juvinates' room (${room(p)?.getName?.()})`);
  const juvinates = JUVINATES.map((id) => actors(p, id)[0]);
  assert.ok(juvinates.every(Boolean), "both juvinates");
  juvinates.forEach((npc) => kill(p, npc));
  ticks(2);
  assert.equal(quest.getStage(p), STAGE_ESCORT, "Ivan's finishing words come first");
  action(p, IVAN_DEPARTS);
  assert.equal(quest.getStage(p), STAGE_ESCORT_DONE);
  assert.deepEqual([p.getLocation().getX(), p.getLocation().getY(), p.getLocation().getZ()], [3529, 3169, 0], "at Burgh de Rott's boathouse");
  assert.ok(!String(room(p)?.getName?.() ?? "").startsWith("sins-trek-"), "out of the escort's rooms");
  assert.equal(p.getAttribute("sins-of-the-father:trek-exit") ?? null, null);
});

test("an escort that was left goes on from the room it had reached", (t) => {
  const p = player(t, "sinsescort2", STAGE_ESCORT);
  p.setAttribute(BITS, BIT_TREK | (2 << NAIL_SHIFT));
  assert.equal(room(p) ?? null, null, "not in a room after a death, teleport or logout");
  action(p, START_ESCORT);
  assert.ok(inRoom(p, "bridge"), `straight to the bridge room (${room(p)?.getName?.()})`);
  assert.equal(actors(p, IVAN).length, 1);
});

test("the rooms the escort copies have what it needs in the cache", () => {
  for (const [x, y] of [[2090, 5005], [2334, 5005], [2083, 5041]]) RegionManager.loadMapFiles(x, y);
  const at = ([x, y]) => new core.Location(x, y, 0);
  assert.ok(MapObjects.get(SMALL_TREE, at(ROOMS.river.tree), null), "the small swamp tree");
  assert.ok(MapObjects.get(13845, at(ROOMS.river.branch), null), "the big tree's branch, which the quest's branch stands on");
  assert.ok(MapObjects.get(BRIDGE[0], at(ROOMS.bridge.bridge), null), "the broken bridge");
  assert.ok(ROOMS.bridge.trees.some((tree) => MapObjects.get(DEAD_TREE, at(tree), null)), "a dead tree to chop");
  for (const [x, y] of [[2334, 5005], [2335, 5005], [2332, 5008], [2328, 5010], ROOMS.river.entry, ROOMS.river.follower, ROOMS.bridge.entry, ROOMS.bridge.follower]) {
    assert.equal(RegionManager.blocked(new core.Location(x, y, 0), null), false, `${x},${y} is open`);
  }
});
