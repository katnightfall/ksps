// Upstream issue #5201: "Following a player stops when a new chunk loads" (seen in RuneLite
// through the gateway).
//
// The server's own part of a map change is MovementQueue.handleRegionChange: when a player's
// tile comes within 16 tiles of the edge of the 104-tile scene the last map was built around,
// their "last known region" moves and the active regions are refreshed. This walks a leader and
// a follower across that line and checks the follow is still on afterwards, for both of them
// crossing. (It is: nothing on that path ends a follow. What stops RuneLite's follower is in the
// gateway or the RuneLite client, not here, and the browser client is not affected.)
const assert = require('node:assert/strict'), path = require('node:path');
const { before, after, test } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager: PM } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { PlayerSession } = require('../dist/net/PlayerSession');
const { ClientConnection } = require('../dist/net/NetworkBuilder');
const { PlayerOptionPacketListener } = require('../dist/net/packet/impl/PlayerOptionPacketListener');

let core, next = 5201;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  PM.loadFromDirectory(path.resolve(__dirname, '../plugins'));
  core = PM.getCoreApi();
  core.RegionManager.init();
  core.RegionManager.loadMapFiles(3350, 3000);
  core.RegionManager.loadMapFiles(3350, 3080);
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));

function actor(t, x, y) {
  const channel = {
    kind: 'test', remoteAddress: '127.0.0.1', isOpen: () => true, send: () => true,
    close() {}, onData() {}, onError() {}, onClose() {},
  };
  const p = new Player(new PlayerSession(channel));
  p.setUsername('chunkwalker' + next++);
  p.setLocation(new core.Location(x, y, 0));
  p.setLastKnownRegion(p.getLocation().clone());
  p.needsPlacement = false;
  const c = new ClientConnection(channel);
  c.player = p;
  assert.equal(core.World.getPlayers().add(p), true);
  p.needsPlacement = false;
  t.after(() => {
    PM.emitPlayerLogout({ player: p, username: p.getUsername() });
    p.setRegistered(false);
    core.TaskManager.cancelTasks(p.getIndex());
    core.World.getPlayers().remove(p);
  });
  return p;
}

const gap = (a, b) => Math.max(
  Math.abs(a.getLocation().getX() - b.getLocation().getX()),
  Math.abs(a.getLocation().getY() - b.getLocation().getY()),
);

test('a follow goes on when the leader and the follower walk into a new map area (#5201)', async (t) => {
  // Open desert, walked north in hops a minimap click could make; a hop that ends on a cactus
  // or a rock stops at the nearest tile, which is as good here.
  const follower = actor(t, 3350, 3000);
  const leader = actor(t, 3350, 3001);
  const regionOf = (p) => `${p.getLastKnownRegion().getRegionX()},${p.getLastKnownRegion().getRegionY()}`;
  const started = { leader: regionOf(leader), follower: regionOf(follower) };

  PlayerOptionPacketListener.executeClientOption(follower, leader.getIndex(), 3);
  assert.equal(follower.getFollowing(), leader);

  let worst = 0;
  for (let hop = 0; hop < 12 && leader.getLocation().getY() < 3075; hop++) {
    leader.getMovementQueue().requestWalk(new core.Location(3350, leader.getLocation().getY() + 10, 0));
    for (let i = 0; i < 12; i++) {
      leader.getMovementQueue().process();
      follower.getMovementQueue().process();
      leader.needsPlacement = follower.needsPlacement = false;
      assert.equal(follower.getFollowing(), leader,
        `the follow ended with the leader at ${leader.getLocation()} and the follower at ${follower.getLocation()}`);
      worst = Math.max(worst, gap(follower, leader));
    }
  }
  assert.ok(leader.getLocation().getY() >= 3075, `the leader walked north (now at ${leader.getLocation()})`);

  assert.notEqual(regionOf(leader), started.leader, 'the leader crossed into a new map area');
  assert.notEqual(regionOf(follower), started.follower, 'and so did the follower');
  assert.equal(follower.getFollowing(), leader);
  assert.equal(follower.getInteractingMobile(), leader);
  assert.equal(gap(follower, leader), 1, 'the follower ends beside the leader');
  assert.ok(worst <= 3, `the follower kept up all the way (widest gap ${worst})`);
});
