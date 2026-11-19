// Run after yarn build: node --test tests/wiki-item-spawns.test.cjs
// Upstream issue #3551: about a third of the Wiki's item spawns were missing from the world.
// scripts/import-wiki-item-spawns.cjs adds them to data/definitions/ground-items.json from a
// snapshot of the Wiki (tests/fixtures/wiki-item-spawns.json: every Template:ItemSpawnLine tile
// with its plane, quantity, respawn and members flag). This checks the file against that
// snapshot, with every plugin loaded and started so that plugin-owned spawns count.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { before, after, test } = require("node:test");

const Importer = require("../scripts/import-wiki-item-spawns.cjs");
const snapshot = require("./fixtures/wiki-item-spawns.json");
const groundItems = JSON.parse(fs.readFileSync(Importer.GROUND_ITEMS, "utf8"));
const added = groundItems.filter(Importer.isAdded);
let core, result;

before(async () => {
  core = await Importer.boot();
  result = Importer.importSpawns(snapshot, core, groundItems);
});
after(() => require("../dist/plugins/PluginManager").PluginManager.emitServerShutdown({}));

const tileKey = (id, x, y, z) => `${id}:${x}:${y}:${z}`;

test("the snapshot is the whole of the Wiki's item spawn tables", () => {
  assert.ok(snapshot.pages > 350, `${snapshot.pages} pages`);
  assert.ok(snapshot.tiles.length > 2800, `${snapshot.tiles.length} tiles`);
  for (const [page, x, y, quantity] of [["Fire rune", "3304", "3311", "3"], ["Chaos rune", "3021", "3640", "5"]]) {
    const tile = snapshot.tiles.find((entry) => entry.page === page && entry.x === x && entry.y === y);
    assert.ok(tile, `${page} at ${x},${y}`);
    assert.equal(tile.qty, quantity);
  }
});

test("ground-items.json holds exactly the rows the import gives: running it again changes nothing", () => {
  assert.equal(Importer.render(result.definitions), fs.readFileSync(Importer.GROUND_ITEMS, "utf8"));
  assert.ok(added.length > 300, `${added.length} spawns added from the Wiki`);
});

test("every added spawn is the Wiki's: exact tile, plane, quantity, respawn and members flag", () => {
  const wanted = new Map();
  for (const tile of snapshot.tiles) {
    for (const id of tile.ids) wanted.set(tileKey(id, tile.x, tile.y, tile.plane), [...(wanted.get(tileKey(id, tile.x, tile.y, tile.plane)) ?? []), tile]);
  }
  const seen = new Set();
  for (const row of added) {
    const { x, y, z } = row.location;
    const key = tileKey(row.id, x, y, z);
    assert.equal(seen.has(key), false, `${key} is added once`);
    seen.add(key);
    const tiles = wanted.get(key);
    assert.ok(tiles?.length, `${row.description} at ${x},${y},${z}: the Wiki lists this item on this tile`);
    const tile = tiles[0];
    assert.equal(row.amt, tile.qty === undefined ? 1 : Number(tile.qty), `${key} quantity`);
    assert.equal(row.respawn, Number(tile.tileRespawn ?? tile.respawn[0]), `${key} respawn`);
    assert.ok(row.respawn > 0, `${key} respawns`);
    assert.equal(row.members === true, /^yes$/i.test(tile.members), `${key} members flag`);
    // The id is the cache's item of exactly the Wiki line's name.
    assert.equal(Importer.normal(core.CacheDefinitions.getItem(row.id).name), Importer.normal(tile.item ?? tile.name), `${key} is the cache's ${tile.item ?? tile.name}`);
    assert.ok(core.CacheMaps.getRegionIds().includes(((x >> 6) << 8) | (y >> 6)), `${key} is on the map`);
  }
});

test("no added spawn doubles one the world already had", () => {
  const older = Importer.worldItems(core, groundItems);
  for (const row of added) {
    const { x, y, z } = row.location;
    const double = older.find((item) => item.id === row.id && item.z === z && Math.abs(item.x - x) <= 2 && Math.abs(item.y - y) <= 2);
    assert.equal(double, undefined, `${row.description} at ${x},${y},${z}`);
    assert.equal(older.some((item) => item.x === x && item.y === y && item.z === z), false, `${x},${y},${z} was empty`);
  }
});

test("the places the issue named have their spawns", () => {
  const at = (id, x, y, z = 0) => groundItems.find((row) => row.id === id && row.location.x === x && row.location.y === y && row.location.z === z);
  const I = core.ItemIdentifiers;
  // Already added by the other importer: fire runes at the Al Kharid mine (3), the Dark Warriors' Fortress (5).
  assert.equal(at(I.FIRE_RUNE, 3304, 3311)?.amt, 3);
  assert.equal(at(I.FIRE_RUNE, 3026, 3637)?.amt, 5);
  // This import: chaos runes there, sea shells on every coast, Varlamore's supplies, coins.
  assert.equal(at(I.CHAOS_RUNE, 3021, 3640)?.amt, 5);
  const shells = added.filter((row) => core.CacheDefinitions.getItem(row.id).name === "Sea shell");
  assert.ok(shells.length >= 14, `${shells.length} sea shell tiles added`);
  const coins = groundItems.filter((row) => row.id === I.COINS);
  assert.ok(coins.length > 100, `${coins.length} coin tiles`);
});

test("what is held back is held for a stated reason, and the Wiki's tiles are otherwise all in the world", () => {
  const counts = result.counts;
  assert.equal((counts.add ?? 0) + (counts.present ?? 0) + (counts.held ?? 0) + (counts.duplicate ?? 0), snapshot.tiles.length);
  for (const row of result.rows.filter((entry) => entry.status === "held")) assert.ok(row.reasons.length > 0, `${row.tile.page} ${row.tile.x},${row.tile.y}`);
  // After the import every tile is in the world or held: none is left merely unimported.
  assert.equal(counts.add, added.length);
});
