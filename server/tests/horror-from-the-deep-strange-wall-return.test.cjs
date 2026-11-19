// From server/: node --test tests/horror-from-the-deep-strange-wall-return.test.cjs
// Upstream issue #5229: a player coming back up from the dagannoth cave could not pass the strange
// wall again, and the mother's death put them on the surface instead of outside the wall.
// Real ClientConnection clicks, routing, map and plugins (quest-capture-harness).
const assert = require("node:assert/strict");
const { before, after, test, mock } = require("node:test");
const h = require("./quest-capture-harness.cjs");

// Cache (scripts/dump-loc.ts 4545,4546,4413): the two "Open" halves of the strange wall are walls on
// the south edge of 2516,10003 and 2513,10003; the room behind them (north) holds the cave ladder
// 4413 at 2515,10007, the basement (south) the ladder back up to the lighthouse.
const EAST = { id: 4545, tile: [2516, 10003] };
const WEST = { id: 4546, tile: [2513, 10003] };
const FOYER = [2515, 10005, 0]; // where the cave ladder lands a player climbing up
const CAVE = [2515, 4632, 0];

before(async () => {
  h.key = "horror_from_the_deep";
  const worldConfig = require("../dist/game/definition/WorldDefinition");
  const readConfig = worldConfig.readWorldConfig;
  // The unrelated HTTP listener stays off, as in sorceress-garden-gates-native.test.cjs.
  const config = mock.method(worldConfig, "readWorldConfig", (...args) => {
    const actual = readConfig(...args);
    return { ...actual, plugins: { ...actual.plugins, WorldAdmin: false } };
  });
  try { await h.setup([[2515, 10003], [2515, 4632]]); } finally { config.mock.restore(); }
});
after(() => h.teardown());

const position = (f) => {
  const at = f.player.getLocation();
  return [at.getX(), at.getY(), at.getZ()];
};

for (const wall of [EAST, WEST]) {
  test(`${wall.id}: back from the cave, the strange wall lets the player out to the basement`, async (t) => {
    const f = h.actor(t, { at: FOYER, done: [], stage: 10 });
    await h.clickObject(f, wall.id, wall.tile);
    h.ticks(f, 3);
    assert.ok(f.messages.some((m) => m.text === "You pass through the opening in the strange wall."));
    assert.deepEqual(position(f), [wall.tile[0], wall.tile[1] - 1, 0], "south of the wall, in the basement");
    assert.equal(h.core.RegionManager.blocked(f.player.getLocation(), null), false);

    // And in again, then out again: the wall is not a one-way trip.
    await h.clickObject(f, wall.id, wall.tile);
    h.ticks(f, 3);
    assert.deepEqual(position(f), [wall.tile[0], wall.tile[1], 0], "north of the wall, in the ladder room");
    await h.clickObject(f, wall.id, wall.tile);
    h.ticks(f, 3);
    assert.deepEqual(position(f), [wall.tile[0], wall.tile[1] - 1, 0]);
  });
}

test("from the basement the wall is entered from the tile south of it", async (t) => {
  const f = h.actor(t, { at: [2515, 10000, 0], done: [], stage: 10 });
  await h.clickObject(f, EAST.id, EAST.tile);
  h.ticks(f, 3);
  assert.deepEqual(position(f), [2516, 10003, 0]);
});

test("an unfinished wall stays shut from both sides", async (t) => {
  const f = h.actor(t, { at: FOYER, done: [], stage: 4 });
  await h.clickObject(f, EAST.id, EAST.tile);
  h.ticks(f, 3);
  assert.ok(f.messages.some((m) => m.text === "You cannot see any way to move this part of the wall..."));
  assert.deepEqual(position(f), [2516, 10003, 0], "walked up to it and no further");
});

test("the Dagannoth mother's death puts the player outside the strange wall, in the basement", async (t) => {
  const f = h.actor(t, { at: CAVE, done: [], stage: 5 });
  // Jossik's "(The Dagannoth mother appears.)" action, as the conversation emits it.
  h.PM.emitCustomEvent("npc-dialogue:action", { player: f.player, npcId: h.core.NpcIdentifiers.JOSSIK_2, stepId: "yh8sGI" });
  const mother = require("../plugins/quests/quests/HorrorFromTheDeep.Quest")._test.motherPhasesByPlayer.get(f.player)?.npc;
  assert.ok(mother, "the mother is spawned for the player");
  assert.equal(mother.getOwner(), f.player);
  f.npcs.push(mother);
  h.PM.emitNpcDeath({ npc: mother, npcId: mother.getId(), killer: f.player });
  assert.equal(h.quest().isComplete(f.player), true);
  assert.deepEqual(position(f), [2516, 10002, 0], "the tile the eastern half of the wall is opened from");
  assert.equal(h.core.RegionManager.blocked(f.player.getLocation(), null), false);
});
