// Run after `yarn build`: node --test tests/npc-spawns-stand-still.test.cjs
// Ours: an NPC whose walk animation in the cache is its ready (standing) animation has no walk
// to play, so a wander radius moves it from tile to tile in its standing pose. Its spawns in
// data/definitions/npc-spawns.json stand still (wanderRadius 0), as the NPC does in live OSRS.
const assert = require('node:assert/strict');
const path = require('node:path');
const { test, before } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { CacheDefinitions } = require('../dist/game/cache/CacheDefinitions');

const spawns = require('../data/definitions/npc-spawns.json');

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
});

test('Perdu stands still at every spot: his walk animation is his ready animation', () => {
  // 7456 is Perdu himself (Ferox Enclave); 7457 and 7458 are the multi NPCs that show him on an
  // ordinary world and on a PvP or Bounty Hunter world (varbit this_is_a_pvp_or_bh_world).
  const perdu = spawns.filter((spawn) => spawn.name === 'Perdu');
  assert.deepEqual([...new Set(perdu.map((spawn) => spawn.id))].sort(), [7456, 7457, 7458]);
  assert.equal(perdu.length, 9);
  for (const spawn of perdu) {
    const npc = CacheDefinitions.getNpc(spawn.id);
    // dwarf_ready_walkingstick for both; the other dwarves with that ready animation walk with
    // dwarf_walk_walkingstick (2154).
    assert.deepEqual([npc.idleSeqId, npc.walkSeqId, npc.basTypeId], [2155, 2155, -1], `${spawn.id}`);
    assert.equal(spawn.wanderRadius, 0, `${spawn.id} at ${spawn.x},${spawn.y},${spawn.level}`);
  }
});
