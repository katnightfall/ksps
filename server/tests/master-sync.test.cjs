// Ours. Run after `yarn build`: node --test tests/master-sync.test.cjs
// One set of characters for every world of a master: the master's store and its /sync calls
// (deploy/master/characters.mjs), and a world's side of it (plugins/world/MasterSync.plugin.js),
// talking to each other over real HTTP.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
require("../dist/Server").Server.installProductionPathResolver();

const masterSide = import(pathToFileURL(path.join(__dirname, "../../deploy/master/characters.mjs")).href);
const MasterSync = require("../plugins/world/MasterSync.plugin");
const { createMasterSync, settings, signRequest, worldResetId } = MasterSync._test;

const KEY = "k".repeat(64);

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "master-sync-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A master: its store, served over HTTP as the front door would reach it. */
async function master(t, { reset = () => "" } = {}) {
  const { createCharacterStore, createSyncApi } = await masterSide;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "master-sync-"));
  const clock = { now: 1_800_000_000_000 };
  const store = createCharacterStore(path.join(dir, "characters.sqlite"), reset);
  const api = createSyncApi({ store, key: () => KEY, now: () => clock.now });
  const server = http.createServer(async (request, response) => {
    if (!(await api(request, response))) { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // The store first: Windows will not remove a folder with an open database in it.
  t.after(() => {
    store.close();
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, clock, dir, url: `http://127.0.0.1:${server.address().port}` };
}

/** A world: a save database of its own (as much of it as the syncing touches) and its side of the syncing. */
function world(t, name, hub, { reset = "", offline = false, stateFile = null, key = KEY } = {}) {
  const rows = new Map();
  const kicked = [];
  const here = new Set();
  const persistence = {
    saveKey: (username, profile = "main") => (profile === "main" ? "" : `${profile}:`) + String(username).toLowerCase().replace(/[^a-z0-9]/g, "_"),
    currentJson: (key) => rows.get(key),
    enqueue: (key, writes) => { rows.set(key, writes.find((write) => write.kind === "row").json); },
  };
  let down = false;
  const call = async (method, target, body) => {
    if (down) throw new Error("unreachable");
    const text = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(`${hub.url}${target}`, {
      method, body: method === "POST" ? text : undefined,
      headers: { "x-master-sync": signRequest(key, method, target, text, hub.clock.now) },
    });
    return { status: response.status, answer: await response.json().catch(() => ({})) };
  };
  const sync = createMasterSync({
    persistence, call, world: name, reset, stateFile, offlineLogins: () => offline,
    online: () => here, localKeys: () => [...rows.keys()], kick: (names, message) => kicked.push({ names, message }), now: () => hub.clock.now,
  });
  return {
    sync, rows, kicked, here,
    setDown: (value) => { down = value; },
    /** The game saving a character here, as SqlitePlayerPersistence.enqueue is wrapped to report it. */
    async gameSaves(key, save) {
      rows.set(key, JSON.stringify(save));
      await sync.rowWritten(key);
    },
    async login(name) {
      const request = { names: [name], refuse: null };
      await sync.prepare(request);
      if (!request.refuse) await sync.entered(name);
      return request.refuse;
    },
    async logout(name, key, save) {
      sync.left(name);
      await this.gameSaves(key, save);
    },
  };
}

test("a character made on one world is the same character on the next", async (t) => {
  const hub = await master(t);
  const dallas = world(t, "1 - Dallas", hub);
  const miami = world(t, "2 - Miami", hub);
  assert.equal(await dallas.login("Kat"), null, "a new name: nothing to fetch, nothing in the way");
  await dallas.gameSaves("kat", { username: "Kat", skills: { experience: [100] } });
  await dallas.sync.tick();
  assert.equal(hub.store.counts(hub.clock.now).characters, 1, "the autosave reached the master");
  await dallas.logout("Kat", "kat", { username: "Kat", skills: { experience: [250] } });
  assert.equal(await miami.login("Kat"), null);
  assert.deepEqual(JSON.parse(miami.rows.get("kat")), { username: "Kat", skills: { experience: [250] } }, "Miami plays on from Dallas's logout save");
  assert.deepEqual(miami.sync.state().dirty, [], "and what came from the master is not handed back");
});

test("an account is in one world at a time", async (t) => {
  const hub = await master(t);
  const dallas = world(t, "1 - Dallas", hub);
  const miami = world(t, "2 - Miami", hub);
  await dallas.login("Kat");
  assert.equal(await miami.login("Kat"), "Your account is logged in on 1 - Dallas.");
  assert.equal(await miami.login("kat"), "Your account is logged in on 1 - Dallas.", "however it is typed");
  assert.equal(await dallas.login("Somebody Else"), null, "another account is nobody's business");
  await dallas.logout("Kat", "kat", { username: "Kat" });
  assert.equal(await miami.login("Kat"), null, "let go by the logout save");
  assert.equal(await dallas.login("Kat"), "Your account is logged in on 2 - Miami.");
});

test("a wrong password holds nothing: asking for the saves is not being in the world", async (t) => {
  const hub = await master(t);
  const dallas = world(t, "1 - Dallas", hub);
  const miami = world(t, "2 - Miami", hub);
  const request = { names: ["Kat"], refuse: null };
  await miami.sync.prepare(request); // and the login then fails on its password: it never enters
  assert.equal(await dallas.login("Kat"), null, "the owner still gets in elsewhere");
});

test("a world that stops lets its characters go after a while, and its late save does not undo newer play", async (t) => {
  const hub = await master(t);
  const { HOLD_MS } = await masterSide;
  const dir = folder(t);
  const stateFile = path.join(dir, "master-sync.json");
  const dallas = world(t, "1 - Dallas", hub, { stateFile });
  const miami = world(t, "2 - Miami", hub);
  await dallas.login("Kat");
  await dallas.gameSaves("kat", { at: "dallas-1" });
  await dallas.sync.tick();
  // Dallas saves once more and stops before that save is handed in.
  dallas.setDown(true);
  await dallas.gameSaves("kat", { at: "dallas-2-never-sent" });
  await dallas.sync.tick();
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).dirty, ["kat"], "it is noted as still to hand in");
  assert.equal(await miami.login("Kat"), "Your account is logged in on 1 - Dallas.", "held while Dallas may still be there");
  hub.clock.now += HOLD_MS + 1000;
  assert.equal(await miami.login("Kat"), null, "Dallas has been silent too long");
  assert.deepEqual(JSON.parse(miami.rows.get("kat")), { at: "dallas-1" });
  await miami.logout("Kat", "kat", { at: "miami-1" });
  // Dallas starts again with the save it never sent.
  const again = world(t, "1 - Dallas", hub, { stateFile });
  again.rows.set("kat", JSON.stringify({ at: "dallas-2-never-sent" }));
  await again.sync.started();
  assert.deepEqual(again.sync.state().dirty, [], "refused by the master and dropped");
  assert.deepEqual(JSON.parse(again.rows.get("kat")), { at: "miami-1" }, "and Miami's newer save is copied over it");
  assert.equal(await again.login("Kat"), null);
});

test("an account another world took is put out of this one", async (t) => {
  const hub = await master(t);
  const { HOLD_MS } = await masterSide;
  const dallas = world(t, "1 - Dallas", hub);
  const miami = world(t, "2 - Miami", hub);
  await dallas.login("Kat");
  // Dallas loses its way to the master for a while; Miami lets the account in meanwhile.
  hub.clock.now += HOLD_MS + 1000;
  assert.equal(await miami.login("Kat"), null);
  await dallas.sync.heartbeat();
  assert.deepEqual(dallas.kicked, [{ names: ["kat"], message: "Your account has logged in on another world." }]);
});

test("every world copies what the others hand in, so its hiscores rank them all", async (t) => {
  const hub = await master(t);
  const dallas = world(t, "1 - Dallas", hub);
  const london = world(t, "5 - UK", hub);
  for (let n = 0; n < 95; n++) {
    await dallas.login(`Player ${n}`);
    await dallas.logout(`Player ${n}`, `player_${n}`, { username: `Player ${n}`, n });
  }
  // A bot's save is never handed in: no account logged in for it.
  await dallas.gameSaves("sitebot1", { username: "SiteBot1" });
  await dallas.sync.tick();
  assert.equal(hub.store.counts(hub.clock.now).characters, 95);
  london.rows.set("sitebot7", JSON.stringify({ own: "bot" }));
  assert.equal(await london.sync.mirror(), 95, "all of them, page by page");
  assert.equal(london.rows.size, 96);
  assert.deepEqual(JSON.parse(london.rows.get("player_94")), { username: "Player 94", n: 94 });
  assert.deepEqual(JSON.parse(london.rows.get("sitebot7")), { own: "bot" }, "its own bots are left alone");
  assert.equal(await london.sync.mirror(), 0, "nothing new since");
  assert.deepEqual(london.sync.state().dirty, [], "copies are not handed back");
  // Someone playing here is never overwritten by a copy.
  await london.login("Player 3");
  await london.gameSaves("player_3", { username: "Player 3", n: "played in London" });
  await dallas.sync.mirror();
  assert.deepEqual(JSON.parse(dallas.rows.get("player_3")), { username: "Player 3", n: 3 }, "not handed in yet");
  await london.sync.tick();
  await dallas.sync.mirror();
  assert.deepEqual(JSON.parse(dallas.rows.get("player_3")), { username: "Player 3", n: "played in London" });
});

test("with the master out of reach a login waits, unless the world is set to let players in", async (t) => {
  const hub = await master(t);
  const strict = world(t, "1 - Dallas", hub);
  strict.setDown(true);
  assert.equal(await strict.login("Kat"), "The account server can't be reached. Please try again in a moment.");
  const lenient = world(t, "2 - Miami", hub, { offline: true });
  lenient.setDown(true);
  assert.equal(await lenient.login("Kat"), null);
  // A world without the master's key is not one of its worlds.
  const stranger = world(t, "Stranger", hub, { key: "x".repeat(64) });
  assert.equal(await stranger.login("Kat"), "The account server can't be reached. Please try again in a moment.");
  assert.equal(hub.store.counts(hub.clock.now).characters, 0);
});

test("a fresh start empties the master's characters too, and a world not yet restarted plays on its own", async (t) => {
  let id = "2026-11-17|";
  const hub = await master(t, { reset: () => id });
  const dallas = world(t, "1 - Dallas", hub, { reset: "2026-11-17|" });
  await dallas.login("Kat");
  await dallas.logout("Kat", "kat", { at: "before" });
  assert.equal(hub.store.counts(hub.clock.now).characters, 1);
  id = "2026-11-17|2026-12-01T10:00:00Z";
  assert.equal(hub.store.counts(hub.clock.now).characters, 0, "a new reset id: a new, empty store");
  assert.equal(fs.readdirSync(hub.dir).filter((name) => /^characters-\d{8}-\d{6}\.sqlite$/.test(name)).length, 1, "the old one is set aside, not deleted");
  // Dallas has not restarted: it still has the old characters, and must not hand them in.
  assert.equal(await dallas.login("Kat"), null, "it plays on, on its own");
  await dallas.gameSaves("kat", { at: "old world, after the reset" });
  await dallas.sync.tick();
  assert.equal(hub.store.counts(hub.clock.now).characters, 0);
  assert.equal(dallas.sync.state().stale, true);
  // Restarted, it is on the new id and shares again.
  const restarted = world(t, "1 - Dallas", hub, { reset: id });
  assert.equal(await restarted.login("Kat"), null);
  await restarted.logout("Kat", "kat", { at: "new" });
  assert.equal(hub.store.counts(hub.clock.now).characters, 1);
});

test("a world's copy of the reset id has no '|' in it, and is still the same reset", async (t) => {
  // The master's id is its two parts joined by "|"; a world keeps what deploy/reset-accounts.mjs
  // writes down, which leaves the "|" out. Compared as written, every world was told it was on
  // an old reset and shared nothing.
  const { createCharacterStore, resetKey } = await masterSide;
  assert.equal(resetKey("2026-11-17|"), "2026-11-17");
  assert.equal(resetKey("2026-11-17|2026-12-01T10:00:00Z"), "2026-11-172026-12-01T10:00:00Z");
  const reset = await import(pathToFileURL(path.join(__dirname, "../../deploy/reset-accounts.mjs")).href);
  const dir = folder(t);
  fs.mkdirSync(path.join(dir, "deploy"));
  fs.writeFileSync(path.join(dir, "deploy", "settings.env"), ["ACCOUNTS_RESET_ID=2026-11-17", ""].join(String.fromCharCode(10)));
  const mastersId = reset.masterResetId(dir);
  assert.equal(mastersId, "2026-11-17|");
  // What a world made by the master has beside its saves after applying that reset.
  const saves = path.join(dir, "saves");
  reset.applyReset(saves, mastersId.replace(/[^A-Za-z0-9:._-]/g, ""));
  const worldsId = worldResetId(saves);
  assert.equal(worldsId, "2026-11-17");
  const hub = await master(t, { reset: () => mastersId });
  const dakota = world(t, "4 - SD", hub, { reset: worldsId });
  const dallas = world(t, "1 - Dallas", hub, { reset: worldsId });
  assert.equal(await dakota.login("Kat"), null);
  await dakota.logout("Kat", "kat", { made: "in South Dakota" });
  assert.equal(dakota.sync.state().stale, false);
  assert.equal(hub.store.counts(hub.clock.now).characters, 1, "handed in");
  assert.equal(await dallas.login("Kat"), null);
  assert.deepEqual(JSON.parse(dallas.rows.get("kat")), { made: "in South Dakota" }, "from South Dakota to Dallas");
  const miami = world(t, "2 - Miami", hub, { reset: worldsId });
  assert.equal(await miami.sync.mirror(), 1, "and copied to the others for their hiscores");
  void createCharacterStore;
});

test("characters a world already had are handed in as it starts; of two of one name the more played is kept", async (t) => {
  const hub = await master(t);
  const save = (where, experience) => JSON.stringify({ made: where, skills: { experience } });
  // Before the worlds shared anything: the same name made on both, played more in South Dakota.
  const dallas = world(t, "1 - Dallas", hub);
  dallas.rows.set("mod_kat", save("Dallas", [0, 0, 1184]));
  dallas.rows.set("only_dallas", save("Dallas", [50]));
  dallas.rows.set("sitebot12", save("a bot", [999999]));
  const dakota = world(t, "4 - SD", hub);
  dakota.rows.set("mod_kat", save("South Dakota", [900, 400, 1500]));
  // Dallas starts first, as it happens.
  await dallas.sync.started();
  assert.equal(hub.store.counts(hub.clock.now).characters, 2, "its two characters, not its bot");
  await dakota.sync.started();
  assert.equal(JSON.parse(dakota.rows.get("mod_kat")).made, "South Dakota", "the more played one stays where it was");
  assert.equal(JSON.parse(dakota.rows.get("only_dallas")).made, "Dallas", "and Dallas's other character is copied here");
  await dallas.sync.mirror();
  assert.equal(JSON.parse(dallas.rows.get("mod_kat")).made, "South Dakota", "and replaces the lesser one on Dallas");
  assert.equal(await dallas.login("Mod Kat"), null);
  assert.equal(JSON.parse(dallas.rows.get("mod_kat")).made, "South Dakota");
  // Handed in once: a second start asks nothing again and changes nothing.
  const before = hub.store.changes(0, hub.clock.now).cursor;
  await dakota.sync.seed();
  assert.equal(hub.store.changes(0, hub.clock.now).cursor, before);
  // The other order comes to the same.
  const { totalExperience } = await masterSide;
  assert.equal(totalExperience(save("x", [900, 400, 1500])), 2800);
  assert.equal(totalExperience("not json"), 0);
  assert.deepEqual(hub.store.seed("2 - Miami", "mod_kat", save("Miami", [10]), hub.clock.now).kept, true);
});

test("a world that is stopped hands in its last saves before it goes, and lets its characters go", async (t) => {
  const hub = await master(t);
  const dallas = world(t, "1 - Dallas", hub);
  const miami = world(t, "2 - Miami", hub);
  await dallas.login("Kat");
  await dallas.gameSaves("kat", { placeholders: false });
  await dallas.sync.tick();
  // Kat turns placeholders on; a minute later the world is restarted. Its shutdown save is
  // written, and nobody logs out one by one.
  await dallas.gameSaves("kat", { placeholders: true });
  assert.deepEqual(dallas.sync.state().dirty, ["kat"], "not handed in yet");
  await dallas.sync.shutdown();
  assert.deepEqual(dallas.sync.state().dirty, [], "handed in before the world exits");
  // Miami is up first, and Kat goes straight there.
  assert.equal(await miami.login("Kat"), null, "let go by the shutdown");
  assert.deepEqual(JSON.parse(miami.rows.get("kat")), { placeholders: true }, "with the setting as she left it");
  // A master out of reach does not hold the shutdown up; the save is handed in at the next start.
  const dir = folder(t);
  const stateFile = path.join(dir, "master-sync.json");
  const york = world(t, "3 - NYC", hub, { stateFile });
  await york.login("Ann");
  york.setDown(true);
  await york.gameSaves("ann", { made: "in New York" });
  const began = Date.now();
  await york.sync.shutdown(200);
  assert.ok(Date.now() - began < 2000);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).dirty, ["ann"]);
});

test("a world told it is on an old reset asks again, and shares once the master agrees", async (t) => {
  let id = "new";
  const hub = await master(t, { reset: () => id });
  const logged = [];
  const dallas = world(t, "1 - Dallas", hub, { reset: "old" });
  assert.equal(await dallas.login("Kat"), null, "it plays on, on its own");
  assert.equal(dallas.sync.state().stale, true);
  id = "old";
  assert.equal(await dallas.login("Kat"), null);
  assert.equal(dallas.sync.state().stale, true, "not asked again straight away");
  hub.clock.now += 2 * 60_000 + 1;
  assert.equal(await dallas.login("Kat"), null);
  assert.equal(dallas.sync.state().stale, false);
  await dallas.logout("Kat", "kat", { at: "shared" });
  assert.equal(hub.store.counts(hub.clock.now).characters, 1);
  void logged;
});

test("the calls are signed with the master's key: nothing else is answered", async (t) => {
  const hub = await master(t);
  const { signRequest: masterSign, verifyRequest } = await masterSide;
  const body = JSON.stringify({ world: "x", reset: "", keys: ["kat"] });
  assert.equal(signRequest(KEY, "POST", "/sync/checkout", body, 5_000_000_000_000), masterSign(KEY, "POST", "/sync/checkout", body, 5_000_000_000_000), "the world signs as the master checks");
  const post = (headers) => fetch(`${hub.url}/sync/checkout`, { method: "POST", body, headers }).then((response) => response.status);
  assert.equal(await post({}), 401);
  assert.equal(await post({ "x-master-sync": signRequest("another key ".repeat(4), "POST", "/sync/checkout", body, hub.clock.now) }), 401);
  assert.equal(await post({ "x-master-sync": signRequest(KEY, "POST", "/sync/checkout", `${body} `, hub.clock.now) }), 401, "a changed body");
  assert.equal(await post({ "x-master-sync": signRequest(KEY, "POST", "/sync/checkout", body, hub.clock.now - 10 * 60_000) }), 401, "an old request");
  assert.equal(await post({ "x-master-sync": signRequest(KEY, "POST", "/sync/checkout", body, hub.clock.now) }), 200);
  assert.equal(verifyRequest("", "1.2", "POST", "/sync/checkout", body), false, "no key, no calls");
});

test("a world syncs only when it was given a master and its key; its reset id is the one beside its saves", (t) => {
  assert.equal(settings({}), null);
  assert.equal(settings({ WORLDS_MASTER_URL: "https://rs.kat-net.us" }), null, "no key");
  assert.equal(settings({ MASTER_PROXY_KEY: KEY }), null, "no master");
  assert.deepEqual(settings({ WORLDS_MASTER_URL: "https://rs.kat-net.us/", MASTER_PROXY_KEY: KEY }), { master: "https://rs.kat-net.us", key: KEY });
  const dir = folder(t);
  assert.equal(worldResetId(dir), "");
  fs.writeFileSync(path.join(dir, ".accounts-reset"), "2026-11-17|\n");
  assert.equal(worldResetId(dir), "2026-11-17|");
});

test("the login asks the plugins before it reads the account's saves, and a refusal ends it", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/typescript/elvarg/net/NetworkBuilder.ts"), "utf8");
  const asked = source.indexOf("await PluginManager.prepareLogin(preparing);");
  assert.ok(asked > 0 && asked < source.indexOf("save = persistence.load(primaryName, profile);"), "before the saves are read");
  assert.match(source, /if \(preparing\.refuse\) \{\s*this\.releasePendingName\(\);\s*this\.failLogin\(5, preparing\.refuse\);/);
  const { PluginManager } = require("../dist/plugins/PluginManager");
  const seen = [];
  PluginManager.onLoginPrepare(async (request) => { await new Promise((resolve) => setTimeout(resolve, 5)); seen.push("first"); if (request.names[0] === "Taken") request.refuse = "no"; });
  PluginManager.onLoginPrepare(() => { seen.push("second"); });
  const free = { names: ["Free"], refuse: null };
  await PluginManager.prepareLogin(free);
  assert.deepEqual([free.refuse, seen], [null, ["first", "second"]], "each is waited for, in order");
  seen.length = 0;
  const taken = { names: ["Taken"], refuse: null };
  await PluginManager.prepareLogin(taken);
  assert.deepEqual([taken.refuse, seen], ["no", ["first"]], "after a refusal nobody else is asked");
});

test("the front door hands /sync/ to the master's own process, and the master serves the store there", () => {
  const front = fs.readFileSync(path.join(__dirname, "../../deploy/front.mjs"), "utf8");
  const pattern = new RegExp(/const ADMIN_PATH = \/(.+)\/;/.exec(front)[1]);
  for (const url of ["/sync/checkout", "/sync/changes?since=4", "/admin", "/admin/api/state"]) assert.ok(pattern.test(url), url);
  for (const url of ["/synchronise", "/api/sync/x", "/play", "/sync"]) assert.ok(!pattern.test(url), url);
  const server = fs.readFileSync(path.join(__dirname, "../../deploy/master/server.mjs"), "utf8");
  assert.match(server, /createCharacterStore\(path\.join\(DATA_DIR, "characters\.sqlite"\), \(\) => masterResetId\(ROOT\)\)/);
  assert.match(server, /if \(await sync\(request, response\)\) return;/);
});
