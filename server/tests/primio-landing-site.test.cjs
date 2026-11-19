// From server/: node --test tests/primio-landing-site.test.cjs
//
// Upstream issue #5740: Primio stood off-centre on his landing site in Civitas illa Fortis. He is a
// 3x3 NPC and the server anchors an NPC on its south-west tile, but his spawn row carried the OSRS
// Wiki's map pin, which is the middle of the site: he stood one tile north-east of it. Renu's row
// beside him (recorded, not from the Wiki) is on her site's south-west tile; Primio's now is too.
const assert = require('node:assert/strict');
const { test, before } = require('node:test');
const path = require('node:path');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { CacheDefinitions } = require('../dist/game/cache/CacheDefinitions');
const { RegionManager } = require('../dist/game/collision/RegionManager');
const { MapObjects } = require('../dist/game/entity/impl/object/MapObjects');
const core = PluginManager.getCoreApi();

const LANDING_SITE = 52815; // "Landing Site", 3x3
const PRIMIO_FORTIS = 12889;
const RENU_FORTIS = 13355;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  RegionManager.init();
  RegionManager.loadMapFiles(1702, 3141);
  RegionManager.loadMapFiles(1696, 3141);
});

test('Primio and Renu each cover their own landing site in Civitas illa Fortis', () => {
  const spawns = require('../data/definitions/npc-spawns.json');
  const site = CacheDefinitions.getObject(LANDING_SITE);
  assert.equal(site.name, 'Landing Site');
  assert.deepEqual([site.sizeX, site.sizeY], [3, 3]);
  for (const [id, name] of [[PRIMIO_FORTIS, 'Primio'], [RENU_FORTIS, 'Renu']]) {
    const rows = spawns.filter((row) => row.id === id);
    assert.equal(rows.length, 1, `${name} has one spawn`);
    const [row] = rows;
    assert.equal(CacheDefinitions.getNpc(id).size, 3, `${name} is a 3x3 NPC`);
    const loc = MapObjects.get(LANDING_SITE, new core.Location(row.x, row.y, row.level ?? 0), null);
    assert.ok(loc, `${name}'s south-west tile (${row.x},${row.y}) is the south-west tile of a landing site`);
  }
  const primio = spawns.find((row) => row.id === PRIMIO_FORTIS);
  assert.deepEqual([primio.x, primio.y, primio.level], [1702, 3141, 0]);
});
