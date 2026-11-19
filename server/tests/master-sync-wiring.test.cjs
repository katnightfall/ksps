// Ours. Run after `yarn build`: node --test tests/master-sync-wiring.test.cjs
// The MasterSync plugin as the game loads it (its register), on the real SQLite save database,
// with real players saved by the real save code, talking to the real master store over HTTP.
// master-sync.test.cjs and master-sync-sessions.test.cjs drive the syncing itself with a stand-in
// save database; this is the wiring between the plugin and the engine around it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test, before, after } = require("node:test");
const { pathToFileURL } = require("node:url");

// The world's own folder for this test: its save database, and data/saves for the plugin's notes.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "master-sync-wiring-"));
const serverDir = path.resolve(__dirname, "..");
process.env.PLAYER_SAVE_DATABASE_PATH = path.join(home, "data", "saves", "players.sqlite");
process.env.PLAYER_SAVE_IMPORT_LEGACY_JSON = "0";
process.env.TSPS_ACCOUNTS_FILE = path.join(home, "accounts.json");
process.env.TSPS_DISPLAY_NAMES_FILE = path.join(home, "display-names.json");
const KEY = "k".repeat(64);

require("../dist/Server").Server.installProductionPathResolver();
const { GameConstants } = require("../dist/game/GameConstants");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { Item } = require("../dist/game/model/Item");
const { PlayerRights } = require("../dist/game/model/rights/PlayerRights");

let hub;
let persistence = null;
const hooks = { login: [], logout: [], startup: [] };
const online = new Map();
let stopping = false;

/** Waits until `check()` is true (the hand-ins are asynchronous). */
async function until(check, what) {
  for (let waited = 0; waited < 5000; waited += 20) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

before(async () => {
  const { createCharacterStore, createSyncApi } = await import(pathToFileURL(path.join(__dirname, "../../deploy/master/characters.mjs")).href);
  const store = createCharacterStore(path.join(home, "master", "characters.sqlite"), () => "");
  const api = createSyncApi({ store, key: () => KEY });
  const server = http.createServer(async (request, response) => {
    if (!(await api(request, response))) { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const saved = (key) => JSON.parse(store.changes(0).rows.find((row) => row.key === key)?.json ?? "null");
  hub = { store, server, saved, url: `http://127.0.0.1:${server.address().port}` };

  require("../plugins/persistence/SqlitePlayerPersistence.plugin").register({
    getSkillManager: () => require("../dist/game/content/skill/SkillManager").SkillManager,
    setPlayerPersistence: (backend) => { persistence = backend; },
    log() {},
  });
  GameConstants.PLAYER_PERSISTENCE = persistence;

  // The plugin reads the master's address and key, and its own folder, as it registers.
  process.env.WORLDS_MASTER_URL = hub.url;
  process.env.MASTER_PROXY_KEY = KEY;
  process.chdir(home);
  const { World } = require(path.join(serverDir, "dist/game/World"));
  require(path.join(serverDir, "plugins/world/MasterSync.plugin")).register({
    getPluginConfig: (_key, fallback) => fallback,
    onServerStartup: (handler) => hooks.startup.push(handler),
    onPlayerLogin: (handler) => hooks.login.push(handler),
    onPlayerLogout: (handler) => hooks.logout.push(handler),
    core: {
      WorldDefinition: { getWorldDefinition: () => ({ name: "1 - Dallas" }) },
      World: { getPlayers: () => [...online.values()], getPlayerByName: (name) => online.get(String(name).toLowerCase()) },
      Server: { isShuttingDown: () => stopping },
    },
  });
  for (const handler of hooks.startup) handler();
  void World;
});

after(() => {
  process.chdir(serverDir);
  hub.store.close();
  hub.server.closeAllConnections();
  hub.server.close();
});

/** A login as the engine makes it: the plugins are asked first, then the save is read and the player enters. */
async function login(name) {
  const request = { names: [name], refuse: null };
  await PluginManager.prepareLogin(request);
  if (request.refuse) return request.refuse;
  const player = new Player(null);
  player.setUsername(name);
  player.requestLogout = () => { player.loggedOutBy = "kick"; };
  player.sendMessage = (message) => { player.told = message; };
  persistence.load(name)?.applyToPlayer(player);
  online.set(name.toLowerCase(), player);
  for (const handler of hooks.login) handler({ player, username: name });
  return player;
}

function logout(player) {
  for (const handler of hooks.logout) handler({ player, username: player.getUsername() });
  online.delete(player.getUsername().toLowerCase());
  persistence.save(player, "logout");
}

const coins = (save) => save?.inventory?.[0]?.amount ?? 0;

test("the game's saves are handed in, a logout lets the character go, and offline edits follow", async () => {
  const kat = await login("Kat");
  assert.ok(kat instanceof Player, "let in");
  await until(() => hub.store.counts().online > 0, "the master to hold Kat for this world");
  kat.getInventory().setItem(0, new Item(995, 100));
  persistence.save(kat, "autosave");
  kat.getInventory().setItem(0, new Item(995, 250));
  logout(kat);
  await until(() => coins(hub.saved("kat")) === 250, "the logout save at the master");
  await until(() => hub.store.counts().online === 0, "the character to be let go");
  assert.equal(kat.loggedOutBy, undefined, "nobody was put out");

  // Staff give her a rank while she is offline (the engine's updateOffline, as the world's admin page uses it).
  await persistence.updateOffline("Kat", (save) => save.setRights(PlayerRights.MODERATOR), "world-admin-rights");
  assert.equal(persistence.load("Kat").getRights(), PlayerRights.MODERATOR);
  await until(() => JSON.stringify(hub.saved("kat")) === JSON.stringify(JSON.parse(persistence.currentJson("kat"))), "the offline edit at the master");

  // And roll her back to her autosave (the save history's restoreSnapshot, as the rollback command uses it).
  await persistence.flush();
  const autosave = persistence.listSnapshots("Kat", 15).find((snapshot) => snapshot.reason === "autosave");
  assert.ok(autosave, "the autosave is in the save history");
  assert.equal(persistence.restoreSnapshot("Kat", autosave.id).pending, false);
  await until(() => coins(hub.saved("kat")) === 100, "the rolled-back save at the master");

  // Her next login plays on from the rolled-back save.
  const again = await login("Kat");
  assert.equal(again.getInventory().getItems()[0].getAmount(), 100);
  logout(again);
  await until(() => hub.store.counts().online === 0, "the character to be let go again");
});

test("a bot's save is never handed in", async () => {
  const bot = new Player(null);
  bot.setUsername("SiteBot12");
  bot.isPlayerBot = () => true;
  persistence.save(bot, "autosave");
  const roamer = new Player(null);
  roamer.setUsername("PlayerBot3");
  roamer.isPlayerBot = () => true;
  persistence.save(roamer, "autosave");
  await persistence.flush();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(hub.saved("sitebot12"), null);
  assert.equal(hub.saved("playerbot3"), null);
});

test("a stopping world's flush hands in the shutdown saves, also when another save would not write", async () => {
  const ann = await login("Ann");
  await until(() => hub.store.counts().online > 0, "the master to hold Ann");
  ann.getInventory().setItem(0, new Item(995, 7));
  // Somebody's save does not pass the writer's check: it fails the flush for everybody.
  const broken = new Player(null);
  broken.setUsername("Broken");
  broken.isPlayerBot = () => true;
  broken.getInventory().setItem(0, new Item(995, NaN));
  persistence.save(broken, "shutdown");
  stopping = true;
  persistence.save(ann, "shutdown");
  await assert.rejects(persistence.flush(), /Refusing to save broken/);
  stopping = false;
  assert.equal(coins(hub.saved("ann")), 7, "Ann's shutdown save is at the master when the flush returns");
  assert.equal(hub.store.counts().online, 0, "and she is let go");
  assert.equal(fs.existsSync(path.join(home, "data", "saves", "master-sync.json")), true, "the plugin keeps its notes beside the saves");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "data", "saves", "master-sync.json"), "utf8")).dirty, []);
});
