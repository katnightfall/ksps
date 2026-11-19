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

test("two hand-ins of one save never cross: the logout save is the character, not the autosave before it", async (t) => {
  const hub = await master(t);
  // The autosave's hand-in is slow on its way (a new connection, a busy master); the logout's is not.
  let arrive;
  const slow = new Promise((resolve) => { arrive = resolve; });
  const sent = [];
  const dallas = world(t, "1 - Dallas", hub, {
    wrapCall: (call) => async (method, target, body) => {
      if (target === "/sync/save") {
        sent.push(JSON.parse(body.json).at);
        if (JSON.parse(body.json).at === "autosave") await slow;
      }
      return call(method, target, body);
    },
  });
  const miami = world(t, "2 - Miami", hub);
  await dallas.login("Kat");
  await dallas.gameSaves("kat", { at: "autosave", coins: 1 });
  const handingIn = dallas.sync.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // She logs out while it is on its way.
  const leaving = dallas.logout("Kat", "kat", { at: "logout", coins: 2 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  arrive();
  await Promise.all([handingIn, leaving]);
  assert.deepEqual(sent, ["autosave", "logout"], "one after the other");
  assert.deepEqual(dallas.sync.state().dirty, []);
  assert.deepEqual(hub.saved("kat"), { at: "logout", coins: 2 }, "the master has the logout save");
  assert.equal(await miami.login("Kat"), null, "and the logout let the character go");
  assert.deepEqual(JSON.parse(miami.rows.get("kat")), { at: "logout", coins: 2 });
});

test("an answer that is not the master's lets nobody in on a guess, and no save is dropped for it", async (t) => {
  const hub = await master(t);
  const dallas = world(t, "1 - Dallas", hub);
  await dallas.login("Kat");
  await dallas.logout("Kat", "kat", { at: "first evening" });
  // Something between the world and the master answers in the master's place.
  for (const status of [403, 429, 404, 200]) {
    hub.answers.status = (request) => (request.url === "/sync/checkout" ? status : 0);
    assert.equal(await dallas.login("Kat"), "The account server can't be reached. Please try again in a moment.", `checkout answered ${status}`);
  }
  hub.answers.status = null;
  assert.equal(await dallas.login("Kat"), null);
  // The same for a save on its way in: kept, and handed in when the master answers again.
  for (const status of [429, 400, 200]) {
    hub.answers.status = (request) => (request.url === "/sync/save" ? status : 0);
    await dallas.gameSaves("kat", { at: `second evening, ${status}` });
    await dallas.sync.tick();
    assert.deepEqual(dallas.sync.state().dirty, ["kat"], `a save answered ${status} is still to hand in`);
  }
  hub.answers.status = null;
  await dallas.sync.tick();
  assert.deepEqual(dallas.sync.state().dirty, []);
  assert.deepEqual(hub.saved("kat"), { at: "second evening, 200" });
  assert.ok(dallas.logged.some((line) => line.event === "unexpected_answer" && line.call === "checkout" && line.status === 403), "and the log says what was answered");
});

test("a login this world could not prepare is refused, not let in unknown", async (t) => {
  const hub = await master(t);
  let broken = false;
  const rows = new Map();
  const dallas = world(t, "1 - Dallas", hub, {
    persistence: {
      currentJson: (key) => { if (broken) throw new Error("database is locked"); return rows.get(key); },
      enqueue: (key, writes) => { rows.set(key, writes.find((write) => write.kind === "row").json); },
    },
  });
  const other = world(t, "2 - Miami", hub);
  await other.login("Kat");
  await other.logout("Kat", "kat", { at: "Miami" });
  broken = true;
  assert.equal(await dallas.accepted("Kat"), "The account server can't be reached. Please try again in a moment.");
  broken = false;
  assert.equal(await dallas.login("Kat"), null);
  assert.deepEqual(JSON.parse(rows.get("kat")), { at: "Miami" });
});

test("a world set to let players in without the master hands in what they played once it is back", async (t) => {
  const hub = await master(t);
  const dallas = world(t, "1 - Dallas", hub, { offline: true });
  const miami = world(t, "2 - Miami", hub);
  await dallas.login("Kat");
  await dallas.logout("Kat", "kat", { at: "before the master went away" });
  dallas.setDown(true);
  assert.equal(await dallas.login("Kat"), null, "let in from this world's own copy");
  await dallas.logout("Kat", "kat", { at: "played while the master was away" });
  assert.deepEqual(dallas.sync.state().dirty, ["kat"], "noted as still to hand in");
  dallas.setDown(false);
  await dallas.sync.tick();
  assert.deepEqual(hub.saved("kat"), { at: "played while the master was away" });
  assert.equal(await miami.login("Kat"), null);
  assert.deepEqual(JSON.parse(miami.rows.get("kat")), { at: "played while the master was away" });
});

test("a world told for a moment that it is on an old reset still hands in what was played meanwhile", async (t) => {
  const { createCharacterStore, createSyncApi } = await masterSide;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "master-sync-"));
  const clock = { now: 1_800_000_000_000 };
  const store = createCharacterStore(path.join(dir, "characters.sqlite"), () => "2026-11-17|");
  // The master answers one checkout as if its reset id were another (its settings read half-written).
  let mistaken = false;
  const api = createSyncApi({ store: { ...store, reset: (now) => (mistaken ? "" : store.reset(now)) }, key: () => KEY, now: () => clock.now });
  const server = http.createServer(async (request, response) => { await api(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { store.close(); server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const hub = { clock, url: `http://127.0.0.1:${server.address().port}` };
  const rows = new Map();
  const call = async (method, target, body) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(`${hub.url}${target}`, { method, body: method === "POST" ? text : undefined, headers: { "x-master-sync": signRequest(KEY, method, target, text, clock.now) } });
    return { status: response.status, answer: await response.json().catch(() => ({})) };
  };
  const sync = createMasterSync({
    persistence: { saveKey: (name) => String(name).toLowerCase(), currentJson: (key) => rows.get(key), enqueue: (key, writes) => rows.set(key, writes.find((write) => write.kind === "row").json) },
    call, world: "1 - Dallas", reset: "2026-11-17", now: () => clock.now,
  });
  const saves = async (key, save) => { rows.set(key, JSON.stringify(save)); await sync.rowWritten(key); };
  const request = { names: ["Kat"], refuse: null };
  await sync.prepare(request);
  await sync.entered("Kat");
  await saves("kat", { at: "before" });
  await sync.tick();
  sync.left("Kat");
  await saves("kat", { at: "logged out" });
  // The mistaken answer, to another player's login. Kat logs in during the two minutes it is believed.
  mistaken = true;
  await sync.prepare({ names: ["Somebody"], refuse: null });
  mistaken = false;
  assert.equal(sync.state().stale, true);
  const again = { names: ["Kat"], refuse: null };
  await sync.prepare(again);
  assert.equal(again.refuse, null, "it plays on, on its own");
  await sync.entered("Kat");
  await saves("kat", { at: "three hours later" });
  clock.now += 2 * 60_000 + 1;
  sync.left("Kat");
  await saves("kat", { at: "three hours later, logged out" });
  await sync.tick();
  assert.equal(sync.state().stale, false);
  assert.deepEqual(JSON.parse(store.changes(0, clock.now).rows.find((row) => row.key === "kat").json), { at: "three hours later, logged out" }, "handed in once the master agreed again");
});

const PLAYED_ELSEWHERE = "Your character has been played on another world since you logged in. Please log in again.";

test("a login that waited on the picker while the account was played elsewhere does not enter with the old copy", async (t) => {
  const hub = await master(t);
  const dallas = world(t, "1 - Dallas", hub);
  const miami = world(t, "2 - Miami", hub);
  await dallas.login("Kat");
  await dallas.logout("Kat", "kat", { coins: 1000, at: "Dallas" });
  // Dallas accepts a login and reads the save; the player stays on the character picker.
  assert.equal(await dallas.accepted("Kat"), null);
  const readOnDallas = JSON.parse(dallas.rows.get("kat"));
  // Meanwhile (another tab) Miami lets the account in: asking for the saves holds nothing.
  assert.equal(await miami.login("Kat"), null);
  await miami.logout("Kat", "kat", { coins: 0, at: "Miami, the coins given away" });
  await dallas.sync.mirror(); // Dallas copies what Miami handed in, as it does every minute
  // Back on Dallas's picker, the player enters: the engine puts the save it read at login in the world.
  await dallas.sync.entered("Kat");
  assert.deepEqual(dallas.kicked, [{ names: ["kat"], message: PLAYED_ELSEWHERE }], "put out at once");
  await dallas.logout("Kat", "kat", { ...readOnDallas, at: "Dallas, from the old copy" });
  await dallas.sync.tick();
  assert.deepEqual(hub.saved("kat"), { coins: 0, at: "Miami, the coins given away" }, "and the old copy never becomes the character again");
  assert.equal(await dallas.login("Kat"), null);
  assert.deepEqual(JSON.parse(dallas.rows.get("kat")), { coins: 0, at: "Miami, the coins given away" }, "the next login plays on from Miami's save");
  assert.equal(dallas.kicked.length, 1, "and is left in peace");
});

test("a save the master refuses as played elsewhere puts its player out instead of letting them play on for nothing", async (t) => {
  const hub = await master(t);
  // The check at entry does not get through (the master busy for a moment): the first save decides.
  let entering = false;
  const dallas = world(t, "1 - Dallas", hub, {
    wrapCall: (call) => async (method, target, body) => {
      if (entering && target === "/sync/checkout") throw new Error("timed out");
      return call(method, target, body);
    },
  });
  const miami = world(t, "2 - Miami", hub);
  await dallas.login("Kat");
  await dallas.logout("Kat", "kat", { at: "Dallas" });
  assert.equal(await dallas.accepted("Kat"), null);
  assert.equal(await miami.login("Kat"), null);
  await miami.logout("Kat", "kat", { at: "Miami" });
  await dallas.sync.mirror();
  entering = true;
  await dallas.sync.entered("Kat");
  entering = false;
  assert.deepEqual(dallas.kicked, [], "not known yet");
  await dallas.gameSaves("kat", { at: "Dallas, from the old copy" });
  await dallas.sync.tick();
  assert.deepEqual(hub.saved("kat"), { at: "Miami" }, "the master keeps the newer play");
  assert.deepEqual(dallas.kicked, [{ names: ["kat"], message: PLAYED_ELSEWHERE }], "and the player is told, once");
  await dallas.gameSaves("kat", { at: "Dallas, from the old copy, again" });
  await dallas.sync.tick();
  assert.equal(dallas.kicked.length, 1);
  assert.deepEqual(hub.saved("kat"), { at: "Miami" });
});

test("an ordinary login is not put out: the world's own writes while it waits are no change", async (t) => {
  const hub = await master(t);
  const dallas = world(t, "1 - Dallas", hub);
  const miami = world(t, "2 - Miami", hub);
  await miami.login("Kat");
  await miami.logout("Kat", "kat", { at: "Miami" });
  assert.equal(await dallas.accepted("Kat"), null);
  // The engine writes the account's remembered logins as it accepts the login (NetworkBuilder saveLoginTokens).
  await dallas.gameSaves("kat", { at: "Miami", tokens: 1 });
  await dallas.sync.mirror();
  await dallas.sync.entered("Kat");
  assert.deepEqual(dallas.kicked, []);
  await dallas.logout("Kat", "kat", { at: "Dallas", tokens: 1 });
  assert.deepEqual(hub.saved("kat"), { at: "Dallas", tokens: 1 });
  assert.deepEqual(dallas.kicked, []);
  // A new name, never saved anywhere, on its first evening.
  assert.equal(await dallas.login("New Player"), null);
  await dallas.gameSaves("new_player", { at: "tutorial" });
  await dallas.sync.tick();
  await dallas.logout("New Player", "new_player", { at: "Lumbridge" });
  assert.deepEqual(dallas.kicked, []);
  assert.deepEqual(hub.saved("new_player"), { at: "Lumbridge" });
});
