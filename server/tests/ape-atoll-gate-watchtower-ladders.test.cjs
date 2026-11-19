// From server/: node --test tests/ape-atoll-gate-watchtower-ladders.test.cjs
// Upstream issue #4101 (comment of 18 November): the ladders of the two watchtowers at Ape Atoll's
// Bamboo Gate put the player on plane 1 in mid-air, from where the whole plane, sea included, could be walked.
// Cache: each ladder is 4775/4774 on the ground and again on plane 1 (inside the tower's legs, no floor
// round it), and 4777/4776 on the platform, plane 2. Real clicks, routing, map and plugins.
const assert = require("node:assert/strict");
const { before, after, test, mock } = require("node:test");
const h = require("./quest-capture-harness.cjs");

const TOWERS = [
  { name: "west", bottom: 4775, top: 4777, x: 2713, y: 2766 },
  { name: "east", bottom: 4774, top: 4776, x: 2729, y: 2766 },
];

before(async () => {
  h.key = "monkey_madness_i";
  const worldConfig = require("../dist/game/definition/WorldDefinition");
  const readConfig = worldConfig.readWorldConfig;
  const config = mock.method(worldConfig, "readWorldConfig", (...args) => {
    const actual = readConfig(...args);
    return { ...actual, plugins: { ...actual.plugins, WorldAdmin: false } };
  });
  try { await h.setup([[2720, 2766]]); } finally { config.mock.restore(); }
});
after(() => h.teardown());

const position = (f) => {
  const at = f.player.getLocation();
  return [at.getX(), at.getY(), at.getZ()];
};
const blocked = (x, y, z) => h.core.RegionManager.blocked(new h.core.Location(x, y, z), null);

/** Tiles that can be walked to from a tile, up to a cap: a platform is small, open air is not. */
function walkable([sx, sy, z], cap = 200) {
  const seen = new Set([`${sx},${sy}`]);
  const queue = [[sx, sy]];
  while (queue.length && seen.size < cap) {
    const [x, y] = queue.shift();
    for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
      const key = `${x + dx},${y + dy}`;
      if (seen.has(key)) continue;
      const from = new h.core.Location(x, y, z);
      const to = new h.core.Location(x + dx, y + dy, z);
      if (!h.core.RegionManager.canMovestart(from, to, 1, 1, null)) continue;
      seen.add(key);
      queue.push([x + dx, y + dy]);
    }
  }
  return seen.size;
}

/** A real click from the first free tile beside the ladder that can use it. */
async function climb(t, id, [x, y, z]) {
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    if (blocked(x + dx, y + dy, z)) continue;
    const f = h.actor(t, { at: [x + dx, y + dy, z], done: ["monkey_madness_i"], stage: 0 });
    f.messages.length = 0;
    await h.clickObject(f, id, [x, y]);
    h.ticks(f, 5);
    if (f.messages.some((m) => m.text === "I can't reach that!")) continue;
    return position(f);
  }
  assert.fail(`ladder ${id} at ${x},${y},${z} can be reached`);
}

for (const tower of TOWERS) {
  test(`the ${tower.name} watchtower's ladder climbs to the platform and back to the ground`, async (t) => {
    assert.ok(blocked(tower.x - 1, tower.y, 1) && blocked(tower.x + 1, tower.y, 1), "plane 1 is the tower's legs, not a floor");
    const up = await climb(t, tower.bottom, [tower.x, tower.y, 0]);
    assert.equal(up[2], 2, `on the platform's plane, not ${up[2]}`);
    assert.equal(blocked(...up), false, "on a floor tile");
    assert.ok(Math.abs(up[0] - tower.x) <= 1 && Math.abs(up[1] - tower.y) <= 1, "beside the ladder's top");
    assert.ok(walkable(up) < 60, "the platform and the walk over the gate, not the open sky");

    const down = await climb(t, tower.top, [tower.x, tower.y, 2]);
    assert.equal(down[2], 0, "back on the ground");
    assert.equal(blocked(...down), false);
    assert.ok(Math.abs(down[0] - tower.x) <= 1 && Math.abs(down[1] - tower.y) <= 1, "beside the ladder's foot");
  });
}
