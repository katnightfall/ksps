// Ours. Run after `yarn build`: node --test tests/master-sync-sessions.test.cjs
// A world's side of the shared characters (plugins/world/MasterSync.plugin.js) through the life
// of one login: asked for, waiting on the character picker, in the world, leaving. Each test is a
// way a player's progress was lost or an account got into two worlds; the master is the real
// store behind real HTTP (deploy/master/characters.mjs), as in master-sync.test.cjs.
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
const { createMasterSync, signRequest, PENDING_MS } = MasterSync._test;

const KEY = "k".repeat(64);

/** A master: its store, served over HTTP. `answers.status(request)` may answer in its place, as a proxy in front of it would. */
async function master(t) {
  const { createCharacterStore, createSyncApi } = await masterSide;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "master-sync-"));
  const clock = { now: 1_800_000_000_000 };
  const store = createCharacterStore(path.join(dir, "characters.sqlite"), () => "");
  const api = createSyncApi({ store, key: () => KEY, now: () => clock.now });
  const answers = { status: null };
  const server = http.createServer(async (request, response) => {
    const forced = answers.status?.(request) ?? 0;
    if (forced) {
      response.writeHead(forced, { "content-type": "text/html" });
      response.end("<html>not the master</html>");
      return;
    }
    if (!(await api(request, response))) { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    store.close();
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  /** The save the master holds for a character, whoever is in a world. */
  const saved = (key) => JSON.parse(store.changes(0, clock.now).rows.find((row) => row.key === key)?.json ?? "null");
  return { store, clock, dir, answers, saved, url: `http://127.0.0.1:${server.address().port}` };
}

/** A world: a save database of its own (as much of it as the syncing touches) and its side of the syncing. */
function world(t, name, hub, { offline = false, wrapCall = (call) => call, persistence: custom = {} } = {}) {
  const rows = new Map();
  const kicked = [];
  const logged = [];
  const persistence = {
    saveKey: (username, profile = "main") => (profile === "main" ? "" : `${profile}:`) + String(username).toLowerCase().replace(/[^a-z0-9]/g, "_"),
    currentJson: (key) => rows.get(key),
    enqueue: (key, writes) => { rows.set(key, writes.find((write) => write.kind === "row").json); },
    ...custom,
  };
  let down = false;
  const call = wrapCall(async (method, target, body) => {
    if (down) throw new Error("unreachable");
    const text = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(`${hub.url}${target}`, {
      method, body: method === "POST" ? text : undefined,
      headers: { "x-master-sync": signRequest(KEY, method, target, text, hub.clock.now) },
    });
    return { status: response.status, answer: await response.json().catch(() => ({})) };
  });
  const sync = createMasterSync({
    persistence, call, world: name, offlineLogins: () => offline,
    localKeys: () => [...rows.keys()], kick: (names, message) => kicked.push({ names, message }),
    log: (event, details) => logged.push({ event, ...details }), now: () => hub.clock.now,
  });
  return {
    sync, rows, kicked, logged,
    setDown: (value) => { down = value; },
    /** The game saving a character here, as SqlitePlayerPersistence.enqueue is wrapped to report it. */
    async gameSaves(key, save) {
      rows.set(key, JSON.stringify(save));
      await sync.rowWritten(key);
    },
    /** The login is accepted (its saves are read); the player is on the character picker. */
    async accepted(name) {
      const request = { names: [name], refuse: null };
      await sync.prepare(request);
      return request.refuse;
    },
    async login(name) {
      const refused = await this.accepted(name);
      if (!refused) await sync.entered(name);
      return refused;
    },
    async logout(name, key, save) {
      sync.left(name);
      await this.gameSaves(key, save);
    },
  };
}

test("a player who takes minutes on the character picker is still this world's when they enter", async (t) => {
  const hub = await master(t);
  const dallas = world(t, "1 - Dallas", hub);
  const miami = world(t, "2 - Miami", hub);
  const { ClientConnection } = require("../dist/net/NetworkBuilder");
  assert.ok(PENDING_MS > ClientConnection.PENDING_LOGIN_TIMEOUT_MS, "a login is remembered for longer than the engine lets it wait to enter");
  assert.equal(await dallas.accepted("Kat"), null);
  // Three minutes on the picker (the engine allows five), the world's housekeeping running meanwhile.
  for (let waited = 0; waited < 3 * 60_000; waited += 15_000) {
    hub.clock.now += 15_000;
    await dallas.sync.tick();
  }
  await dallas.sync.entered("Kat");
  assert.deepEqual(dallas.sync.state().tracked.filter((key) => key === "kat"), ["kat"], "the world still knows the login");
  assert.equal(await miami.login("Kat"), "Your account is logged in on 1 - Dallas.", "so no other world lets the account in");
  await dallas.logout("Kat", "kat", { at: "an evening's play in Dallas" });
  assert.deepEqual(hub.saved("kat"), { at: "an evening's play in Dallas" }, "and what was played is handed in");
  assert.equal(await miami.login("Kat"), null);
  assert.deepEqual(JSON.parse(miami.rows.get("kat")), { at: "an evening's play in Dallas" });
  // A login that never enters (a wrong password, a closed tab) is still forgotten in the end.
  assert.equal(await dallas.accepted("Somebody"), null);
  hub.clock.now += PENDING_MS + 1000;
  await dallas.sync.tick();
  assert.deepEqual(dallas.sync.state().tracked, []);
});
