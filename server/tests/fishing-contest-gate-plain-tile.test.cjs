// Ours. Run after `yarn build`: node --test tests/fishing-contest-gate-plain-tile.test.cjs
// The doors' own event (door:toggle) hands a gate's tile over as plain { x, y, z }. Fishing Contest's
// Hemenster gate check read it as a Location, threw on every click of a gate of its two ids, and so
// never refused a player without a fishing pass.
process.env.DISABLE_PLAYER_BOTS = '1';
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, after, test } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager: PM } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');

let core;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  PM.loadFromDirectory(path.resolve(__dirname, '../plugins'));
  core = PM.getCoreApi();
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));

/** The clicked gate, as the doors' event carries it beside the plain tile. */
const gate = (x, y) => ({ getId: () => core.ObjectIdentifiers.GATE_4, getLocation: () => new core.Location(x, y, 0) });

function playerAt(x, y) {
  const player = new Player(null);
  player.setUsername('angler');
  player.setLocation(new core.Location(x, y, 0));
  player.messages = [];
  player.sendMessage = (text) => player.messages.push(text);
  return player;
}

test('the Hemenster gate turns a player without a pass away when asked with a plain tile', () => {
  const player = playerAt(2643, 3442); // outside, east of the gate
  const request = { player, object: gate(2642, 3442), objectId: core.ObjectIdentifiers.GATE_4, location: { x: 2642, y: 3442, z: 0 }, handled: false };
  PM.emitCustomEvent('door:toggle', request);
  assert.equal(request.handled, true, 'the gate is claimed, not left to open');
  assert.match(player.messages.at(-1), /Fishing Contest|fishing pass/);
});

test('a gate of the same id elsewhere is left alone, and from inside the field the gate opens', () => {
  const elsewhere = { player: playerAt(3200, 3200), object: gate(3199, 3200), objectId: core.ObjectIdentifiers.GATE_4, location: { x: 3199, y: 3200, z: 0 }, handled: false };
  PM.emitCustomEvent('door:toggle', elsewhere);
  assert.equal(elsewhere.handled, false);
  const leaving = { player: playerAt(2641, 3442), object: gate(2642, 3442), objectId: core.ObjectIdentifiers.GATE_4, location: { x: 2642, y: 3442, z: 0 }, handled: false };
  PM.emitCustomEvent('door:toggle', leaving);
  assert.equal(leaving.handled, false);
});
