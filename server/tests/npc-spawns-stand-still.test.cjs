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
const { NpcIdentifiers } = require('../dist/util/NpcIdentifiers');
const { chooseWanderRadius, walksByReady, hasOwnWalk } = require('../scripts/npc-spawn-matching.cjs');

const spawns = require('../data/definitions/npc-spawns.json');

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
});

test('Perdu stands still at every spot: his walk animation is his ready animation', () => {
  // 7456 is Perdu himself (Ferox Enclave); 7457 and 7458 are the multi NPCs that show him on an
  // ordinary world and on a PvP or Bounty Hunter world (varbit this_is_a_pvp_or_bh_world).
  const perdu = spawns.filter((spawn) => spawn.name === 'Perdu');
  assert.deepEqual([...new Set(perdu.map((spawn) => spawn.id))].sort(), [7456, 7457, 7458]);
  for (const spawn of perdu) {
    const npc = CacheDefinitions.getNpc(spawn.id);
    // dwarf_ready_walkingstick for both; the other dwarves with that ready animation walk with
    // dwarf_walk_walkingstick (2154).
    assert.deepEqual([npc.idleSeqId, npc.walkSeqId, npc.basTypeId], [2155, 2155, -1], `${spawn.id}`);
    assert.equal(spawn.wanderRadius, 0, `${spawn.id} at ${spawn.x},${spawn.y},${spawn.level}`);
  }
});

test('a walk animation that repeats the ready animation is no walk when others walk from that pose', () => {
  const dwarf = { idleSeqId: 2155, walkSeqId: 2154, basTypeId: -1 };
  const perdu = { idleSeqId: 2155, walkSeqId: 2155, basTypeId: -1 };
  const butterfly = { idleSeqId: 362, walkSeqId: 362, basTypeId: -1 };
  const prop = { idleSeqId: -1, walkSeqId: -1, basTypeId: -1 };
  const man = { idleSeqId: 808, walkSeqId: 819, basTypeId: -1 };
  const walks = walksByReady([dwarf, perdu, butterfly, butterfly, prop, man, undefined]);
  assert.deepEqual([...walks.get(2155)].sort(), [2154, 2155]);
  assert.equal(hasOwnWalk(dwarf, walks), true);
  assert.equal(hasOwnWalk(perdu, walks), false, 'other dwarves walk with 2154');
  assert.equal(hasOwnWalk(butterfly, walks), true, 'every butterfly flies with its one animation');
  assert.equal(hasOwnWalk(prop, walks), false, 'no walk animation at all');
  assert.equal(hasOwnWalk(man, walks), true);
  // A BAS carries the animations itself: its NPCs are left alone, and do not count as witnesses.
  assert.equal(hasOwnWalk({ idleSeqId: 2155, walkSeqId: 2155, basTypeId: 12 }, walks), true);
  assert.equal(hasOwnWalk(butterfly, walksByReady([butterfly, { idleSeqId: 362, walkSeqId: 363, basTypeId: 12 }])), true);
  // A pose nobody else has, or that the others have no walk for either, proves nothing.
  assert.equal(hasOwnWalk({ idleSeqId: 3851, walkSeqId: 3851 }, walksByReady([{ idleSeqId: 3851, walkSeqId: -1, basTypeId: -1 }])), true);
});

test('the Wiki sync stands a new NPC still when it has no walk animation of its own', () => {
  assert.equal(chooseWanderRadius([], { id: 7457, name: 'Perdu' }, { walkSeqId: 2155, ownWalk: false }), 0);
  assert.equal(chooseWanderRadius([], { id: 1, name: 'Walker' }, { walkSeqId: 819, ownWalk: true }), undefined);
  assert.equal(chooseWanderRadius([], { id: 1, name: 'Walker' }, { walkSeqId: 819 }), undefined, 'unknown counts as a walk');
  assert.equal(chooseWanderRadius([], { id: 2, name: 'Prop' }, { walkSeqId: -1 }), 0);
});

test('no spawn wanders unless a form the NPC shows has a walk animation of its own', () => {
  const count = CacheDefinitions.getCounts().npcs;
  const walks = walksByReady(Array.from({ length: count }, (_, id) => CacheDefinitions.getNpc(id)));
  // The NPC as spawned and, for a multi NPC, every form it can show.
  const forms = (id) => {
    const npc = CacheDefinitions.getNpc(id);
    return [npc, ...(npc.transforms ?? []).filter((form) => form >= 0 && form < count).map((form) => CacheDefinitions.getNpc(form))];
  };
  const canWalk = new Map();
  const wandering = [];
  let stationary = 0;
  for (const spawn of spawns) {
    const id = typeof spawn.key === 'string' ? NpcIdentifiers[spawn.key] : spawn.id;
    if (!(id >= 0) || id >= count) continue;
    if (!canWalk.has(id)) canWalk.set(id, forms(id).some((form) => hasOwnWalk(form, walks)));
    if (canWalk.get(id)) continue;
    stationary++;
    if (spawn.wanderRadius !== 0) wandering.push(`${spawn.name} (${id}) at ${spawn.x},${spawn.y},${spawn.level}`);
  }
  assert.deepEqual(wandering, []);
  assert.ok(stationary >= 500, `${stationary} spawns of NPCs without a walk animation`);
  // Perdu is one of them; a butterfly, a will o' the wisp and a man are not.
  assert.deepEqual([7456, 7457, 7458, 234, 3483, 3106].map((id) => forms(id).some((form) => hasOwnWalk(form, walks))),
    [false, false, false, true, true, true]);
});
