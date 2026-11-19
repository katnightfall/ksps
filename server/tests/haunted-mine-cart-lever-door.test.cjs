// Upstream issue #6075, Haunted Mine, through the object packet's own route on real players (run after `yarn build`):
// - the mine cart by the east cart tunnel (4918 at 3445,3236) is climbed over with 15 Agility, before and after the
//   quest: the handler read the click's plain { x, y, z } location with getX() and threw, so nothing happened;
// - a track lever is thrown and prints its line once (the transcript's message step), not twice; since the 18th the
//   click did nothing at all, because Family Crest's Witchaven lever handler claimed every later "Lever" Pull;
// - the crane room's east door (4962 at 2799,4453) lets the player through and stays where it is: it used to be
//   removed from the world on its first Open;
// - the innocent-looking key stands still on its crate.
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
const { MapObjects } = require('../dist/game/entity/impl/object/MapObjects');

const STAGE = 'quest.haunted_mine.stage';
const STARTED = 1, COMPLETE = 11;
const CART = 4918, CART_AT = [3445, 3236];
const LEVER = 4950, LEVER_AT = [2785, 4517];
const DOOR = 4962, DOOR_AT = [2799, 4453];
const LEVER_LINE = 'You pull the lever. The old points creak into place.';
let core, next = 3000;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  PM.loadFromDirectory(path.resolve(__dirname, '../plugins')); core = PM.getCoreApi();
  PM.emitServerStartup({});
  RegionManager.init();
  for (const [x, y] of [CART_AT, LEVER_AT, DOOR_AT]) RegionManager.loadMapFiles(x, y);
});
after(() => PM.emitServerShutdown({}));

function actor(t, x, y, stage, agility = 99) {
  const channel = { kind: 'test', remoteAddress: '127.0.0.1', isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {}, flush() {} };
  const p = new Player(new PlayerSession(channel)); p.setIndex(next++); p.setUsername('hauntedmine' + next);
  p.setRegistered(true); p.setLocation(new core.Location(x, y, 0)); p.needsPlacement = false;
  p.setAttribute(STAGE, stage);
  p.getSkillManager().setCurrentLevel(core.Skill.AGILITY, agility, false);
  p.messages = [];
  p.sendMessage = (text) => { p.messages.push(text); };
  t.after(() => { p.setRegistered(false); core.TaskManager.cancelTasks(p.getIndex()); });
  return p;
}
const at = (p) => { const l = p.getLocation(); return [l.getX(), l.getY(), l.getZ()]; };
function step(p) { core.World.processCycle++; core.TaskManager.process(); const q = p.getMovementQueue(); q.beginCycle?.(); if (q.hasPendingWork?.()) q.process(); core.TaskManager.processWalkTo(p.getIndex()); p.setNeedsPlacement(false); p.setResetMovementQueue(false); /* the player update clears these at the end of every cycle */ }
function click(p, id, [x, y], option) {
  const clickType = (ObjectDefinition.forPlayer(id, p)?.getActions() ?? []).indexOf(option) + 1;
  assert.ok(clickType > 0, `loc ${id} offers ${option}`);
  new ObjectActionPacketListener().executeAction(p, id, x, y, clickType);
  for (let i = 0; i < 8; i++) step(p);
}
const stands = (id, [x, y]) => MapObjects.getObjectsAt(new core.Location(x, y, 0), null).some((object) => object.getId() === id);

test('the mine cart by the east cart tunnel is climbed over both ways, during and after the quest', (t) => {
  for (const stage of [0, STARTED, COMPLETE]) {
    const p = actor(t, 3446, 3236, stage);
    click(p, CART, CART_AT, 'Climb-over');
    assert.deepEqual(at(p), [3444, 3236, 0], `stage ${stage}: over to the tunnel side; msgs=${p.messages.join('|')}`);
    click(p, CART, CART_AT, 'Climb-over');
    assert.deepEqual(at(p), [3446, 3236, 0], `stage ${stage}: and back`);
  }
});

test('the mine cart needs 15 Agility', (t) => {
  const p = actor(t, 3446, 3236, STARTED, 14);
  click(p, CART, CART_AT, 'Climb-over');
  assert.deepEqual(at(p), [3446, 3236, 0]);
  assert.deepEqual(p.messages, ['You need an Agility level of 15 to climb over this cart.']);
});

test('a track lever prints its line once', (t) => {
  const side = [[0, 1], [0, -1], [1, 0], [-1, 0]].map(([dx, dy]) => [LEVER_AT[0] + dx, LEVER_AT[1] + dy])
    .find(([x, y]) => RegionManager.getClipping(x, y, 0, null) === 0);
  assert.ok(side, 'a free tile beside the lever');
  const p = actor(t, side[0], side[1], STARTED);
  click(p, LEVER, LEVER_AT, 'Pull');
  assert.deepEqual(p.messages.filter((text) => text === LEVER_LINE), [LEVER_LINE], p.messages.join('|'));
  assert.equal(Number(p.getAttribute('haunted-mine:levers')) > 0, true, 'the lever is thrown');
});

test('the crane room door lets the player through both ways and stays in the world', (t) => {
  assert.ok(stands(DOOR, DOOR_AT), 'the door is in the map');
  const p = actor(t, 2799, 4453, STARTED);
  click(p, DOOR, DOOR_AT, 'Open');
  assert.deepEqual(at(p), [2798, 4453, 0], `from the east into the crane room; msgs=${p.messages.join('|')}`);
  assert.ok(stands(DOOR, DOOR_AT), 'the door is still there');
  assert.equal(p.hasFlag('movement:ignore-clipping'), false, 'the clipping pass ends with the step');
  click(p, DOOR, DOOR_AT, 'Open');
  assert.deepEqual(at(p), [2799, 4453, 0], 'and back out');
  assert.ok(stands(DOOR, DOOR_AT));
  // A second player finds the door too.
  const other = actor(t, 2798, 4453, STARTED);
  click(other, DOOR, DOOR_AT, 'Open');
  assert.deepEqual(at(other), [2799, 4453, 0]);
});

test('the innocent-looking key stands still on its crate', () => {
  const keys = require('../data/definitions/npc-spawns.json').filter((spawn) => spawn.id === core.NpcIdentifiers.INNOCENT_LOOKING_KEY);
  assert.deepEqual(keys.map((spawn) => [spawn.x, spawn.y, spawn.level, spawn.wanderRadius]), [[2788, 4455, 0, 0]]);
});
