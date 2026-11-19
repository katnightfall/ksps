// Run after `yarn build`: node --test tests/bot-revenant-caves-roamers.test.cjs
//
// Upstream issue #5163, "revenant cave bots disappeared". With the bot settings this repository ships (bot-sites.json's
// pvp block and whatever world.json says of PlayerBots), a player standing where the reporter stood, 3234, 10141 in
// the Revenant Caves, gets the map square's full count of PvP roamers, each on a cave tile it can walk to the player
// from. The real registry, bot factory, world zones, map and route finder; only the active-region snapshot is given.
const assert = require('node:assert/strict');
const { before, test } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const { World } = require('../dist/game/World');
const { Location } = require('../dist/game/model/Location');
const { RegionManager } = require('../dist/game/collision/RegionManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { PlayerSession } = require('../dist/net/PlayerSession');
const { Wilderness } = require('../dist/game/content/wilderness/Wilderness');
const { createBotPlayer } = require('../plugins/bots/behaviours/spawn/PlayerFactory.PlayerBots');
const { createBotRegistry } = require('../plugins/bots/runtime/Registry.PlayerBots');
const { PVP_BOT_SETTINGS } = require('../plugins/bots/behaviours/pvp/WildernessHotspotRegistry.PlayerBots');
const { SPAWN_BATCH_DELAY_MS } = require('../plugins/bots/runtime/SpawnPacing.PlayerBots');

const REPORTED = [3234, 10141, 0];
const SQUARE = { regionX: REPORTED[0] >> 6, regionY: REPORTED[1] >> 6, z: 0 };
const KEY = `0:${SQUARE.regionX}:${SQUARE.regionY}`;

before(async () => {
  await require('../dist/game/cache/CachePipeline').CachePipeline.initialize();
  RegionManager.init();
  RegionManager.loadMapFiles(REPORTED[0], REPORTED[1]);
  require('../plugins/items/ItemDefinitionLoader.plugin').register({ log() {}, onPlayerLogin() {}, registerContentEndpoint() {} });
});

test('the shipped settings leave the caves their roamers: a pool, a per-square target, and no zero for this square', () => {
  assert.equal(KEY, '0:50:158');
  assert.ok(PVP_BOT_SETTINGS.botPool > 0, 'there is a roamer pool');
  const target = PVP_BOT_SETTINGS.activeRegionBotsByRegion[KEY] ?? PVP_BOT_SETTINGS.activeRegionBotsPerRegion;
  assert.ok(target > 0, `the square's target is ${target}`);
  const allowed = PluginManager.getPluginConfig('PlayerBots:allowedActivities');
  assert.ok(allowed === undefined || allowed.includes('world'), 'the world keeps its own bot population');
  assert.equal(Wilderness.isInLocation(new Location(...REPORTED)), true, 'the caves are PvP ground');
});

test('a player at the reported tile gets the square filled, every roamer on a cave tile that walks to the player', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const channel = { kind: 'test', remoteAddress: '127.0.0.1', isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const human = new Player(new PlayerSession(channel));
  human.setUsername('cavevisitor');
  human.setLocation(new Location(...REPORTED));
  human.needsPlacement = false;
  World.getPlayers().add(human, true);

  // What the world reports for one player: the 3x3 squares round them (ActiveRegionIndex, radius 1).
  const regions = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const regionX = SQUARE.regionX + dx, regionY = SQUARE.regionY + dy;
    regions.push({ key: `0:${regionX}:${regionY}`, regionX, regionY, z: 0 });
  }
  let snapshot = { radius: 1, regions };
  let update;
  const api = { core: PluginManager.getCoreApi(), getWorld: () => World, getRegionManager: () => RegionManager, log() {} };
  const mapHooksBefore = PluginManager.mapSquareChangeHooks.length;
  const registry = createBotRegistry({
    botApi: api, botCount: 0,
    wildernessRoamerBotCount: PVP_BOT_SETTINGS.botPool,
    wildernessActiveRegionBotsPerRegion: PVP_BOT_SETTINGS.activeRegionBotsPerRegion,
    wildernessActiveRegionBotsByRegion: PVP_BOT_SETTINGS.activeRegionBotsByRegion,
    wildernessActiveRegionInset: PVP_BOT_SETTINGS.activeRegionInset,
    spawn: new Location(3222, 3218), behaviorMode: { PVP: 'pvp' },
    createBotPlayer, createInitialState: () => ({ pvp: {} }),
    applyInitialPvpLoadout: () => true, ensureBehaviorTaskStarted() {}, emitPlayerLogin() {},
    worldGetPlayerByName: (name) => World.getPlayerByName(name), randomInRange: (min) => min,
    onActiveRegionsUpdated: (handler) => { update = handler; },
    onPlayerMapSquareChange: (handler) => PluginManager.createApi('caves-roamers-test').onPlayerMapSquareChange(handler),
    getActiveRegionSnapshot: () => snapshot,
  });
  t.after(() => {
    snapshot = { regions: [] };
    PluginManager.mapSquareChangeHooks.length = mapHooksBefore;
    for (const player of [...World.getPlayers()]) World.getPlayers().remove(player);
    World.getAddPlayerQueue().length = 0;
    World.getRemovePlayerQueue().length = 0;
  });
  registry.scheduleInitialSpawn();
  update(snapshot);
  // Spawning is paced: a batch, then a follow-up after a delay, until the square is full.
  for (let batch = 0; batch < 20; batch++) t.mock.timers.tick(SPAWN_BATCH_DELAY_MS);

  const target = PVP_BOT_SETTINGS.activeRegionBotsByRegion[KEY] ?? PVP_BOT_SETTINGS.activeRegionBotsPerRegion;
  const inSquare = registry.entries.filter((entry) => entry.state.roaming?.roamBounds?.id === KEY);
  assert.equal(inSquare.length, target, `the caves square holds its ${target} roamers`);
  const routes = new (PluginManager.getCoreApi().RsmodRouteFinding)((x, y, z, area) => RegionManager.getClipping(x, y, z, area));
  for (const { player } of inSquare) {
    const at = player.getLocation();
    assert.equal(Wilderness.isInLocation(at), true, `${at.getX()},${at.getY()} is cave PvP ground`);
    assert.equal(at.getX() >> 6, SQUARE.regionX);
    assert.equal(at.getY() >> 6, SQUARE.regionY);
    assert.equal(RegionManager.blocked(at, null), false);
    const route = routes.findRoute({ level: 0, srcX: at.getX(), srcY: at.getY(), srcSize: 1, destX: REPORTED[0], destY: REPORTED[1], privateArea: null, moveNear: false });
    assert.ok(route.success && !route.alternative, `a roamer at ${at.getX()},${at.getY()} can walk to the player`);
  }
  // Only the player's own square is filled (activeRegionInset): the ring round it is not.
  const regional = () => registry.entries.filter((entry) => /^0:\d+:\d+$/.test(entry.state.roaming?.roamBounds?.id ?? ''));
  assert.equal(regional().length, target);

  // Roamers that leave the world (killed and logged out, culled, fled) are replaced while the player stays.
  for (const player of World.getAddPlayerQueue().splice(0)) World.getPlayers().add(player, true);
  const gone = inSquare.slice(0, 6);
  for (const { player } of gone) {
    registry.handleDisconnect(player, player.getUsername());
    World.getPlayers().remove(player);
  }
  assert.ok(gone.every(({ player }) => !registry.entries.some((entry) => entry.player === player)), 'they are off the roster');
  update(snapshot);
  for (let batch = 0; batch < 20; batch++) t.mock.timers.tick(SPAWN_BATCH_DELAY_MS);
  const refilled = registry.entries.filter((entry) => entry.state.roaming?.roamBounds?.id === KEY);
  assert.equal(refilled.length, target, 'the square is topped up again');
  assert.ok(gone.every(({ player }) => !refilled.some((entry) => entry.player === player)), 'by new roamers');
});
