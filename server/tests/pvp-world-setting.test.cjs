// Run after `yarn build`: node --test tests/pvp-world-setting.test.cjs
//
// Upstream issue #4383, "enabling the PvP world option does not seem to work". The switch is the world setting
// Wilderness:pvpWorld: on, the whole world is PvP ground, as a `pvp` zone with no bounds in world.json makes it.
//
// A world's definition is read once, when the server starts, from the working directory. So each case here starts a
// short-lived Node process in a folder of its own that holds data/definitions/world.json (this repository's own file
// with the case's change, and a world.local.json where the case is about one), loads the real compiled
// WorldDefinition and Wilderness there, and reports what they answer. Wilderness pulls in combat code that reads
// its own definitions as it loads, so those files are copied beside the world file.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const SERVER = path.resolve(__dirname, "..");
const SHIPPED = JSON.parse(fs.readFileSync(path.join(SERVER, "data/definitions/world.json"), "utf8"));
/** Definitions the modules behind Wilderness cannot load without. */
const NEEDED_DEFINITIONS = ["item-combat-styles.json"];
const GRAND_EXCHANGE = [3165, 3487, 0];
const WILDERNESS = [3100, 3600, 0];

const PROBE = `
const dist = process.argv[1];
const { hasGlobalWorldTag, WORLD_ZONE_BOUNDARIES, getWorldDefinition } = require(dist + "/game/definition/WorldDefinition");
const { Wilderness } = require(dist + "/game/content/wilderness/Wilderness");
const { Location } = require(dist + "/game/model/Location");
const at = (tile) => new Location(tile[0], tile[1], tile[2]);
const ge = at(${JSON.stringify(GRAND_EXCHANGE)}), wild = at(${JSON.stringify(WILDERNESS)});
process.stdout.write("PROBE" + JSON.stringify({
  pvpWorld: hasGlobalWorldTag("pvp"),
  otherTag: hasGlobalWorldTag("safe"),
  grandExchange: { pvpGround: Wilderness.isInLocation(ge), geographic: Wilderness.isGeographicPvp(ge), level: Wilderness.levelAt(ge.getX(), ge.getY()) },
  wilderness: { pvpGround: Wilderness.isInLocation(wild), geographic: Wilderness.isGeographicPvp(wild), level: Wilderness.levelAt(wild.getX(), wild.getY()) },
  mapWideBoundaries: WORLD_ZONE_BOUNDARIES.pvp.filter((b) => b.getX() <= 0 && b.getX2() >= 0x3fff && b.getY() <= 0 && b.getY2() >= 0x3fff).length,
  mapWideZonesListed: getWorldDefinition().zones.filter((zone) => zone.minX === undefined && zone.tags.includes("pvp")).length,
}));
`;

/** What the server makes of `world` (world.json), with `local` as world.local.json when given. */
function probe(t, world, local) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pvp-world-setting-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "data", "definitions"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "data", "definitions", "world.json"), JSON.stringify(world));
  for (const file of NEEDED_DEFINITIONS) fs.copyFileSync(path.join(SERVER, "data/definitions", file), path.join(cwd, "data", "definitions", file));
  if (local) fs.writeFileSync(path.join(cwd, "data", "definitions", "world.local.json"), JSON.stringify(local));
  const run = spawnSync(process.execPath, ["-e", PROBE, path.join(SERVER, "dist")], { cwd, encoding: "utf8", timeout: 120000 });
  const marker = run.stdout.lastIndexOf("PROBE");
  assert.ok(run.status === 0 && marker >= 0, `the probe ran: ${run.stderr || run.stdout}`);
  return JSON.parse(run.stdout.slice(marker + "PROBE".length));
}

const shipped = () => structuredClone(SHIPPED);
const withSetting = (value) => { const world = shipped(); world.pluginConfig = { ...world.pluginConfig, "Wilderness:pvpWorld": value }; return world; };

const PVP_WORLD = {
  pvpWorld: true,
  otherTag: false,
  grandExchange: { pvpGround: true, geographic: false, level: 0 },
  wilderness: { pvpGround: true, geographic: true, level: 11 },
  mapWideBoundaries: 4,
  mapWideZonesListed: 0,
};
const NORMAL_WORLD = {
  ...PVP_WORLD,
  pvpWorld: false,
  grandExchange: { pvpGround: false, geographic: false, level: 0 },
  mapWideBoundaries: 0,
};

test("this repository's world is not a PvP world: the Grand Exchange is no PvP ground, the Wilderness is", (t) => {
  assert.equal(SHIPPED.pluginConfig?.["Wilderness:pvpWorld"], undefined, "the shipped world leaves the switch alone");
  assert.deepEqual(probe(t, shipped()), NORMAL_WORLD);
});

test("Wilderness:pvpWorld makes every tile PvP ground, on all four planes, and the Wilderness keeps its levels", (t) => {
  assert.deepEqual(probe(t, withSetting(true)), PVP_WORLD);
});

test("the switch works from world.local.json alone, and as plugins.Wilderness.pvpWorld", (t) => {
  assert.deepEqual(probe(t, shipped(), { pluginConfig: { "Wilderness:pvpWorld": true } }), PVP_WORLD, "no zone list restated");
  assert.deepEqual(probe(t, shipped(), { plugins: { Wilderness: { pvpWorld: true } } }), PVP_WORLD);
  assert.deepEqual(probe(t, withSetting(true), { pluginConfig: { "Wilderness:pvpWorld": false } }), NORMAL_WORLD, "the local file can turn it off again");
});

test("only true turns it on", (t) => {
  for (const value of [false, "true", 1, null]) assert.deepEqual(probe(t, withSetting(value)), NORMAL_WORLD, JSON.stringify(value));
});

test("a zone tagged safe stays safe on a PvP world", (t) => {
  const world = withSetting(true);
  world.zones.push({ minX: 3140, maxX: 3190, minY: 3470, maxY: 3510, z: 0, tags: ["safe"] });
  const result = probe(t, world);
  assert.equal(result.pvpWorld, true);
  assert.equal(result.grandExchange.pvpGround, false);
  assert.equal(result.wilderness.pvpGround, true);
});

test("a world that already has the map-wide pvp zone is a PvP world with or without the switch, and gets it once", (t) => {
  const world = shipped();
  world.zones.push({ tags: ["pvp"] });
  const zoned = { ...PVP_WORLD, mapWideZonesListed: 1 };
  assert.deepEqual(probe(t, world), zoned);
  world.pluginConfig = { ...world.pluginConfig, "Wilderness:pvpWorld": true };
  assert.deepEqual(probe(t, world), zoned);
});
