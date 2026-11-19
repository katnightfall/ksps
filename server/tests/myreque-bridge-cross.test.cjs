// Upstream issue #6264: the Hollows rope bridge after its repair. The bridge's pieces block walking in the map, so the
// player moves along it by the pieces' own options; with all three rungs in, the trees' option is Cross-bridge (loc
// 5003 shows 50788 while varbit 3928 is 7). Before the fix that option was answered as a climb, a repaired rung's Cross
// said it was "already fixed", and a piece further along could not be reached at all: the bridge could only be crossed
// northwards, by clicking the piece under the player. Real clicks through the object packet's own route; run after
// `yarn build`.
process.env.DISABLE_PLAYER_BOTS = '1'; // no bot population: the test needs the plugins, not the world's bots
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, after, test } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager: PM } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { PlayerSession } = require('../dist/net/PlayerSession');
const { ObjectDefinition } = require('../dist/game/definition/ObjectDefinition');
const { ObjectActionPacketListener } = require('../dist/net/packet/impl/ObjectActionPacketListener');
const { RegionManager } = require('../dist/game/collision/RegionManager');

const STAGE = 'quest.in_search_of_the_myreque.stage';
const BRIDGE = 'quest.in_search_of_the_myreque.bridge';
const REACHED_HOLLOWS = 25;
const TREE = 5003, BRIDGE_PIECE = 5002, RUNG_BOTTOM = 26245, RUNG_MIDDLE = 26246, RUNG_TOP = 26247;
const SOUTH_TREE = [3502, 3426], NORTH_TREE = [3502, 3431];
const SOUTH_BANK = [3502, 3425, 0], NORTH_BANK = [3503, 3431, 0];
let core, next = 2900;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  PM.loadFromDirectory(path.resolve(__dirname, '../plugins')); core = PM.getCoreApi();
  PM.emitServerStartup({});
  RegionManager.init();
});
after(() => PM.emitServerShutdown({}));

/** A player at the Hollows with `rungs` repaired (bit 0 the southern rung), the varbits sent as the login does. */
function actor(t, x, y, rungs) {
  const channel = { kind: 'test', remoteAddress: '127.0.0.1', isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {}, flush() {} };
  const p = new Player(new PlayerSession(channel)); p.setIndex(next++); p.setUsername('myrequecross' + next);
  p.setRegistered(true); p.setLocation(new core.Location(x, y, 0)); p.needsPlacement = false;
  p.setAttribute(STAGE, REACHED_HOLLOWS);
  p.setAttribute(BRIDGE, rungs);
  for (const bit of [0, 1, 2]) p.getPacketSender().sendVarbit(176 + bit, (rungs >> bit) & 1);
  p.messages = [];
  p.sendMessage = (text) => { p.messages.push(text); };
  p.teleports = [];
  const moveTo = p.moveTo.bind(p);
  p.moveTo = (location) => { p.teleports.push([location.getX(), location.getY(), location.getZ()]); return moveTo(location); };
  t.after(() => { p.setRegistered(false); core.TaskManager.cancelTasks(p.getIndex()); });
  return p;
}
const at = (p) => { const l = p.getLocation(); return [l.getX(), l.getY(), l.getZ()]; };
function step(p) { core.World.processCycle++; core.TaskManager.process(); const q = p.getMovementQueue(); q.beginCycle?.(); if (q.hasPendingWork?.()) q.process(); core.TaskManager.processWalkTo(p.getIndex()); p.setNeedsPlacement(false); p.setResetMovementQueue(false); /* the player update clears these at the end of every cycle */ }

/** The option as the client's menu shows it for this player, clicked through the object packet's route. */
function click(p, id, [x, y], option) {
  const clickType = (ObjectDefinition.forPlayer(id, p)?.getActions() ?? []).indexOf(option) + 1;
  assert.ok(clickType > 0, `loc ${id} offers ${option} to this player (it offers ${JSON.stringify(ObjectDefinition.forPlayer(id, p)?.getActions())})`);
  new ObjectActionPacketListener().executeAction(p, id, x, y, clickType);
  for (let i = 0; i < 10; i++) step(p);
}

test('with all three rungs in, the trees offer Cross-bridge and take the player to the far bank, both ways', (t) => {
  const p = actor(t, ...SOUTH_BANK.slice(0, 2), 0b111);
  click(p, TREE, SOUTH_TREE, 'Cross-bridge');
  assert.deepEqual(at(p), NORTH_BANK, `south tree: over to the north bank; msgs=${p.messages.join('|')}`);
  p.setLocation(new core.Location(3502, 3432, 0)); // north of the north tree, where its wall lets it be reached
  click(p, TREE, NORTH_TREE, 'Cross-bridge');
  assert.deepEqual(at(p), SOUTH_BANK, `north tree: back over to the south bank; msgs=${p.messages.join('|')}`);
  assert.ok(!p.messages.includes("I can't reach that!"), p.messages.join('|'));
});

test('Cross-bridge on a tree from on the bridge is the way down to that tree\'s bank', (t) => {
  const south = actor(t, 3502, 3427, 0b111);
  click(south, TREE, SOUTH_TREE, 'Cross-bridge');
  assert.deepEqual(at(south), SOUTH_BANK);
  const north = actor(t, 3502, 3430, 0b111);
  click(north, TREE, NORTH_TREE, 'Cross-bridge');
  assert.deepEqual(at(north), NORTH_BANK);
});

test('from the north end, Cross on the southern piece walks the whole bridge (it could not be reached before)', (t) => {
  const p = actor(t, 3502, 3430, 0b111);
  click(p, BRIDGE_PIECE, [3502, 3427], 'Cross');
  assert.deepEqual(at(p), [3502, 3427, 0], `msgs=${p.messages.join('|')}`);
  assert.deepEqual(p.teleports, [], 'walked, not placed');
  assert.equal(p.hasFlag('movement:ignore-clipping'), false, 'the clipping pass ends with the walk');
  assert.deepEqual(p.messages, []);
});

test('Cross on a repaired rung walks to it instead of saying it is already fixed', (t) => {
  const p = actor(t, 3502, 3427, 0b111);
  click(p, RUNG_MIDDLE, [3502, 3429], 'Cross');
  assert.deepEqual(at(p), [3502, 3429, 0], `msgs=${p.messages.join('|')}`);
  click(p, RUNG_TOP, [3502, 3430], 'Cross');
  assert.deepEqual(at(p), [3502, 3430, 0]);
  click(p, RUNG_BOTTOM, [3502, 3428], 'Cross');
  assert.deepEqual(at(p), [3502, 3428, 0]);
  assert.deepEqual(p.teleports, []);
  assert.deepEqual(p.messages, []);
  assert.equal(p.hasFlag('movement:ignore-clipping'), false);
});

test('a player who stops part-way (one rung repaired) can walk back and climb down the south tree', (t) => {
  const p = actor(t, 3502, 3428, 0b001);
  click(p, BRIDGE_PIECE, [3502, 3427], 'Cross');
  assert.deepEqual(at(p), [3502, 3427, 0], `back on the southern piece; msgs=${p.messages.join('|')}`);
  click(p, TREE, SOUTH_TREE, 'Climb');
  assert.deepEqual(at(p), SOUTH_BANK);
  assert.ok(p.messages.includes('You climb the tree.'), p.messages.join('|'));
});

test('Cross on the piece under the player still takes them over a fully repaired bridge, and nowhere on a broken one', (t) => {
  const whole = actor(t, 3502, 3427, 0b111);
  click(whole, BRIDGE_PIECE, [3502, 3427], 'Cross');
  assert.deepEqual(at(whole), NORTH_BANK);
  const broken = actor(t, 3502, 3427, 0b001);
  click(broken, BRIDGE_PIECE, [3502, 3427], 'Cross');
  assert.deepEqual(at(broken), [3502, 3427, 0]);
  assert.deepEqual(broken.messages, ['This bridge looks pretty old. The wooden boards break apart beneath your feet.']);
});

test('a bridge piece is not answered from a bank', (t) => {
  const p = actor(t, ...SOUTH_BANK.slice(0, 2), 0b111);
  click(p, BRIDGE_PIECE, [3502, 3427], 'Cross');
  assert.ok(at(p)[1] <= 3426, `still on the south bank: ${at(p)}`);
  assert.deepEqual(p.teleports, []);
});
