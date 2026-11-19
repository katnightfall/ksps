// Ours. Run after `yarn build`: node --test tests/gc-allocation-hotspots.test.cjs
// Upstream issue #6036 (lag spikes from garbage-collection pauses). A world started from this
// code with its 1,590 bots made 54.8 MB of garbage a second; an allocation profile of it
// (collected objects included) named three places that made 40% of it between them for nothing:
//   27%  the Combat Achievements' tier question (asked by every clue nest, clue bottle, geode
//        and Slayer roll), which built the 21-word array once per task, about 640 times a call;
//   6%   Misc.formatNameForProtocol, two strings for every player on every search by name;
//   7%   Location.isSameTile, two Locations and six strings for every pair of tiles compared.
// Each is measured here by the young-generation collections (scavenges) a burst of calls
// causes: none now, several before; and each still answers as it did.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before } = require("node:test");
const { PerformanceObserver, constants } = require("node:perf_hooks");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CacheDefinitions } = require("../dist/game/cache/CacheDefinitions");
const { Location } = require("../dist/game/model/Location");
const { Misc } = require("../dist/util/Misc");
const Ca = require("../plugins/achievements/CombatAchievements.plugin");
const Data = require("../plugins/achievements/combatachievements/Data.CombatAchievements");
const Progress = require("../plugins/achievements/combatachievements/Progress.CombatAchievements");

const customEvents = new Map();
const fakeApi = new Proxy({
  core: { CacheDefinitions, PlayerRights: { ADMINISTRATOR: 2 }, Task: require("../dist/game/task/Task").Task },
  getTaskManager: () => ({ submit() {} }),
  onCustomEvent: (name, handler) => customEvents.set(name, [...(customEvents.get(name) ?? []), handler]),
  emitCustomEvent: (name, request) => (customEvents.get(name) ?? []).forEach((handler) => handler(request)),
}, { get: (target, key) => target[key] ?? (() => {}) });

before(async () => {
  const { CachePipeline } = require("../dist/game/cache/CachePipeline");
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  Ca.register(fakeApi);
});

/** The scavenges `work` causes (the young generation filling up with what it allocates). */
async function scavenges(work) {
  const seen = [];
  const observer = new PerformanceObserver((list) => seen.push(...list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  await new Promise((resolve) => setImmediate(resolve));
  seen.length = 0;
  work();
  await new Promise((resolve) => setTimeout(resolve, 20));
  seen.push(...observer.takeRecords());
  observer.disconnect();
  return seen.filter((entry) => (entry.detail?.kind ?? entry.kind) === constants.NODE_PERFORMANCE_GC_MINOR).length;
}

function player(completedIds = []) {
  const attributes = new Map();
  const all = Data.TASK_VARPS.map(() => 0);
  for (const id of completedIds) all[id >>> 5] |= (1 << (id & 31));
  attributes.set("combat-achievements:completed", all);
  return { getAttribute: (key) => attributes.get(key), setAttribute: (key, value) => attributes.set(key, value) };
}

const askTier = (who, tier) => {
  const request = { player: who, tier };
  fakeApi.emitCustomEvent("combat-achievements:tier", request);
  return request;
};

test("a tier question answers as before", () => {
  const tasks = [...Data.tasks().values()];
  const easy = Data.tiers().find((tier) => tier.name === "Easy");
  const easyTasks = tasks.filter((task) => task.tier === easy.tier);
  assert.ok(tasks.length > 400 && easyTasks.length > 10);

  const fresh = player();
  assert.equal(Progress.points(fresh), 0);
  assert.deepEqual(Progress.completedTasks(fresh), []);
  assert.deepEqual({ ...askTier(fresh, "Easy"), player: null }, { player: null, tier: "Easy", unlocked: false, claimed: false, currentThresholdMet: false, allTasksDone: false });

  // Every task of the tier, and one of another: the bits of the 21 words are read as they were.
  const other = tasks.find((task) => task.tier !== easy.tier);
  const done = player([...easyTasks.map((task) => task.id), other.id]);
  assert.equal(Progress.points(done), easyTasks.reduce((sum, task) => sum + task.points, 0) + other.points);
  assert.deepEqual(Progress.completedTasks(done).map((task) => task.id).sort((a, b) => a - b),
    [...easyTasks.map((task) => task.id), other.id].sort((a, b) => a - b));
  for (const task of tasks) assert.equal(Progress.isComplete(done, task.id), task.tier === easy.tier || task === other, `task ${task.id}`);
  const answer = askTier(done, "easy");
  assert.equal(answer.unlocked, true);
  assert.equal(answer.claimed, false);
  assert.equal(answer.currentThresholdMet, true);
  assert.equal(answer.allTasksDone, true);

  const oneShort = player(easyTasks.slice(1).map((task) => task.id));
  assert.equal(askTier(oneShort, "Easy").allTasksDone, false);
  // A save without the attribute, a task id past the 21 words and a string id, as the old array gave them.
  const blank = { getAttribute: () => undefined };
  assert.equal(Progress.isComplete(blank, easyTasks[0].id), false);
  assert.equal(Progress.isComplete(done, 21 * 32 + 5), false);
  assert.equal(Progress.isComplete(done, String(easyTasks[0].id)), true);
});

test("1,500 tier questions fill no young generation (they made about 1,900 arrays each)", async () => {
  const who = player([...Data.tasks().values()].slice(0, 50).map((task) => task.id));
  askTier(who, "Hard");
  const count = await scavenges(() => { for (let i = 0; i < 1500; i++) askTier(who, "Hard"); });
  assert.ok(count <= 1, `${count} scavenges`);
});

test("formatNameForProtocol answers as before and hands the same string back", async () => {
  for (const [name, formatted] of [["Zezima", "zezima"], ["Mod Ash", "mod_ash"], ["a  b", "a__b"], ["already_ok", "already_ok"], ["", ""], ["ÀB c", "àb_c"]]) {
    assert.equal(Misc.formatNameForProtocol(name), formatted);
    assert.equal(Misc.formatNameForProtocol(name), formatted, "and from memory");
  }
  assert.throws(() => Misc.formatNameForProtocol(undefined), TypeError, "a missing name still throws");
  // More names than are kept: the oldest go, the answers stay right.
  for (let i = 0; i < 20000; i++) assert.equal(Misc.formatNameForProtocol(`Bot Name ${i}`), `bot_name_${i}`);
  assert.equal(Misc.formatNameForProtocol("Bot Name 3"), "bot_name_3");
  const names = Array.from({ length: 1600 }, (_, i) => `Bot Player ${i}`);
  for (const name of names) Misc.formatNameForProtocol(name);
  const count = await scavenges(() => { for (let round = 0; round < 1500; round++) for (const name of names) Misc.formatNameForProtocol(name); });
  assert.ok(count <= 1, `${count} scavenges for 2,400,000 names (1,500 searches of 1,600 players)`);
});

test("isSameTile answers as before and builds nothing", async () => {
  const at = new Location(3200, 3201, 1);
  const plain = { x: 3200, y: 3201, z: 1 };
  const getters = { getX: () => 3200, getY: () => 3201, getZ: () => 1 };
  for (const [a, b, same] of [
    [at, new Location(3200, 3201, 1), true], [at, plain, true], [plain, getters, true], [getters, at, true],
    [at, new Location(3200, 3201, 0), false], [at, new Location(3201, 3201, 1), false], [at, new Location(3200, 3200, 1), false],
    [at, null, false], [null, null, false], [undefined, at, false], [at, { x: 3200, y: 3201 }, false],
    [at, { x: 3200, y: 3201, z: NaN }, false], [{ x: "3200", y: 3201, z: 1 }, at, false], [at, {}, false],
    // A getter wins over a field of the same name, as before.
    [{ x: 1, y: 1, z: 1, getX: () => 3200, getY: () => 3201, getZ: () => 1 }, at, true],
  ]) assert.equal(Location.isSameTile(a, b), same, JSON.stringify([a, b]));
  const read = Location.readTile(plain);
  assert.ok(read instanceof Location && read !== plain);
  assert.deepEqual([read.getX(), read.getY(), read.getZ()], [3200, 3201, 1]);
  assert.equal(Location.readTile({ x: 1, y: 2 }), null);
  assert.equal(Location.readTile(null), null);

  const tiles = Array.from({ length: 2000 }, (_, i) => new Location(3000 + (i % 50), 3000 + ((i / 50) | 0), 0));
  let matches = 0;
  const count = await scavenges(() => { for (let round = 0; round < 1500; round++) for (const tile of tiles) if (Location.isSameTile(tile, at)) matches++; });
  assert.equal(matches, 0);
  assert.ok(count <= 1, `${count} scavenges for 3,000,000 comparisons`);
});
