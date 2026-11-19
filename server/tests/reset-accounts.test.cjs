// Ours. node --test tests/reset-accounts.test.cjs
// A fresh start (deploy/reset-accounts.mjs): the master calls it, each world applies it once as it
// starts, and what was saved is moved aside, never deleted.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");

const reset = import(pathToFileURL(path.join(__dirname, "../../deploy/reset-accounts.mjs")).href);

/** A world's saves folder as a played world leaves it. */
function saves(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reset-accounts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries({
    "players.sqlite": "accounts", "players.sqlite-wal": "wal", "clans.json": "{}", "nex-scoreboard.json": "[]",
    "Bans.txt": "cheater", "IPBans.txt": "203.0.113.9", "Mutes.txt": "", "IPMutes.txt": "", "bank-pin-host.key": "secret",
  })) fs.writeFileSync(path.join(dir, name), text);
  fs.mkdirSync(path.join(dir, "master"));
  fs.writeFileSync(path.join(dir, "master", "master-worlds.json"), "{}");
  return dir;
}
const list = (dir) => fs.readdirSync(dir).sort();

test("a reset moves every account and what players built aside, and keeps bans, the PIN key and the master's folder", async (t) => {
  const { applyReset } = await reset;
  const dir = saves(t);
  const done = applyReset(dir, "2026-11-17|", { now: new Date(Date.UTC(2026, 10, 17, 2, 30, 5)) });
  assert.equal(done.result, "reset");
  assert.deepEqual(done.moved.sort(), ["clans.json", "nex-scoreboard.json", "players.sqlite", "players.sqlite-wal"]);
  assert.equal(path.basename(done.backup), "reset-20261117-023005");
  assert.deepEqual(list(dir), [".accounts-reset", "Bans.txt", "IPBans.txt", "IPMutes.txt", "Mutes.txt", "bank-pin-host.key", "master", "reset-20261117-023005"]);
  // Nothing is lost: it is all in the backup folder, as it was.
  assert.deepEqual(list(done.backup), ["clans.json", "nex-scoreboard.json", "players.sqlite", "players.sqlite-wal"]);
  assert.equal(fs.readFileSync(path.join(done.backup, "players.sqlite"), "utf8"), "accounts");
  assert.equal(fs.readFileSync(path.join(dir, "Bans.txt"), "utf8"), "cheater");
});

test("a reset is applied once; the next one moves only what was played since, and leaves earlier backups alone", async (t) => {
  const { applyReset } = await reset;
  const dir = saves(t);
  const first = applyReset(dir, "one", { now: new Date(Date.UTC(2026, 10, 17, 2, 0, 0)) });
  assert.equal(applyReset(dir, "one").result, "current");
  assert.equal(applyReset(dir, "one").result, "current");
  fs.writeFileSync(path.join(dir, "players.sqlite"), "new accounts");
  const second = applyReset(dir, "two", { now: new Date(Date.UTC(2026, 10, 18, 2, 0, 0)) });
  assert.deepEqual(second.moved, ["players.sqlite"]);
  assert.ok(fs.existsSync(path.join(first.backup, "players.sqlite")), "the first backup is still whole");
  assert.equal(fs.readFileSync(path.join(second.backup, "players.sqlite"), "utf8"), "new accounts");
  // Two resets in the same second do not overwrite each other's backup.
  fs.writeFileSync(path.join(dir, "players.sqlite"), "again");
  const third = applyReset(dir, "three", { now: new Date(Date.UTC(2026, 10, 18, 2, 0, 0)) });
  assert.notEqual(third.backup, second.backup);
});

test("no reset called, no reset: an empty id never touches the saves", async (t) => {
  const { applyReset } = await reset;
  const dir = saves(t);
  const before = list(dir);
  for (const id of ["", undefined, null]) assert.equal(applyReset(dir, id).result, "none");
  assert.deepEqual(list(dir), before);
});

test("a world's first word from its master is noted, not applied: joining a master does not wipe a world", async (t) => {
  const { applyReset } = await reset;
  const dir = saves(t);
  assert.equal(applyReset(dir, "called-before-it-joined", { adopt: true }).result, "adopted");
  assert.ok(fs.existsSync(path.join(dir, "players.sqlite")), "its accounts are kept");
  assert.equal(applyReset(dir, "called-before-it-joined", { adopt: true }).result, "current");
  // A reset called after that is applied.
  assert.equal(applyReset(dir, "called-later", { adopt: true }).result, "reset");
  assert.ok(!fs.existsSync(path.join(dir, "players.sqlite")));
});

test("the master's id is its settings' part and its admin page's part; either changing is a new reset", async (t) => {
  const { combinedResetId, masterResetId } = await reset;
  assert.equal(combinedResetId("", ""), "", "nothing called");
  assert.equal(combinedResetId("2026-11-17", ""), "2026-11-17|");
  assert.equal(combinedResetId("2026-11-17", "2026-12-01T10:00:00Z"), "2026-11-17|2026-12-01T10:00:00Z");
  assert.equal(combinedResetId("a b;rm -rf", ""), "abrm-rf|", "only plain characters");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reset-master-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(masterResetId(root), null, "no settings file to read: not known (below), which is never a reset");
  fs.mkdirSync(path.join(root, "deploy"));
  fs.writeFileSync(path.join(root, "deploy", "settings.env"), "DEV_USERNAME=kat\n");
  assert.equal(masterResetId(root), "", "nothing called");
  fs.writeFileSync(path.join(root, "deploy", "settings.env"), "DEV_USERNAME=kat\nACCOUNTS_RESET_ID=2026-11-17\n");
  assert.equal(masterResetId(root), "2026-11-17|");
  fs.mkdirSync(path.join(root, "server", "data", "saves", "master"), { recursive: true });
  fs.writeFileSync(path.join(root, "server", "data", "saves", "master", "master-worlds.json"), JSON.stringify({ accountsReset: "2026-12-01T10:00:00Z", worlds: [] }));
  assert.equal(masterResetId(root), "2026-11-17|2026-12-01T10:00:00Z");
});

test("the egg's launcher asks its master before the game starts, and only a world with a master does", () => {
  const launcher = fs.readFileSync(path.join(__dirname, "../../deploy/pterodactyl/launch.mjs"), "utf8");
  assert.match(launcher, /if \(text\(env\.WORLDS_MASTER_URL\)\) \{\s*spawnSync\(process\.execPath, \[path\.join\(ROOT, "deploy\/reset-accounts\.mjs"\), "--from-master", text\(env\.WORLDS_MASTER_URL\), "--world", text\(env\.WORLD_NAME\)\]/);
  const run = fs.readFileSync(path.join(__dirname, "../../deploy/run.sh"), "utf8");
  assert.ok(run.indexOf('node "$ROOT/deploy/reset-accounts.mjs" || true') < run.indexOf("./dist/Server.js"), "the master's own world: before the game opens its saves");
});

test("a world the master made applies the first reset it hears of; one joined by hand only notes it", async () => {
  const { bornUnderMaster } = await reset;
  const worlds = [
    { id: "1", name: "1 - Kat-Net - US Dallas", world: "1", address: "node.example.com:5000", secure: false, headless: true },
    { id: "friends", name: "Friends", world: "Friends World", address: "friends.example.com", secure: true },
  ];
  assert.equal(bornUnderMaster(worlds, "1"), true, "made on the admin page");
  assert.equal(bornUnderMaster(worlds, "Friends World"), false, "added by its address");
  assert.equal(bornUnderMaster(worlds, "Somebody else"), false, "not on the list at all");
  for (const name of ["", undefined, null]) assert.equal(bornUnderMaster(worlds, name), false);
  assert.equal(bornUnderMaster(null, "1"), false);
});

test("an id that cannot be read is not known, and what is not known resets nothing", async (t) => {
  const { applyReset, masterResetId } = await reset;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reset-master-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = path.join(root, "deploy", "settings.env");
  const worlds = path.join(root, "server", "data", "saves", "master", "master-worlds.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.mkdirSync(path.dirname(worlds), { recursive: true });
  fs.writeFileSync(settings, "ACCOUNTS_RESET_ID=2026-11-17\n");
  fs.writeFileSync(worlds, JSON.stringify({ accountsReset: "2026-12-01T10:00:00Z", worlds: [] }));
  const whole = "2026-11-17|2026-12-01T10:00:00Z";
  assert.equal(masterResetId(root), whole);

  // A deploy putting a new settings file in place: for a moment it is not there, or is empty.
  // Half the id ("|2026-12-01T10:00:00Z") is another id, and so a reset of everything.
  fs.rmSync(settings);
  assert.equal(masterResetId(root), null);
  fs.writeFileSync(settings, "");
  assert.equal(masterResetId(root), null);
  fs.writeFileSync(settings, "ACCOUNTS_RESET_ID=2026-11-17\n");
  assert.equal(masterResetId(root), whole);
  // The admin page's file, there and not readable (cut short, or a slip in a hand edit).
  for (const broken of ["", '{ "accountsReset": "2026-12-01T10:00:00Z", "worlds": [', "null"]) {
    fs.writeFileSync(worlds, broken);
    assert.equal(masterResetId(root), null, JSON.stringify(broken));
  }
  // Never there at all: the admin page has called no reset.
  fs.rmSync(worlds);
  assert.equal(masterResetId(root), "2026-11-17|");

  // And what is not known moves nothing (the master's own saves, deploy/run.sh).
  const dir = saves(t);
  fs.writeFileSync(path.join(dir, ".accounts-reset"), `${whole}\n`);
  const before = list(dir);
  assert.deepEqual(applyReset(dir, null), { result: "none", moved: [], backup: null });
  assert.deepEqual(list(dir), before);
});

test("a marker cut short is no marker: a world joined by hand notes the reset again and keeps its saves", async (t) => {
  const { applyReset } = await reset;
  const dir = saves(t);
  // As a full disk leaves it: the file made, nothing in it.
  fs.writeFileSync(path.join(dir, ".accounts-reset"), "");
  const before = list(dir);
  assert.equal(applyReset(dir, "2026-11-17", { adopt: true }).result, "adopted");
  assert.deepEqual(list(dir), before, "nothing was moved, and nothing is left beside the marker");
  assert.equal(fs.readFileSync(path.join(dir, ".accounts-reset"), "utf8"), "2026-11-17\n");
  assert.equal(fs.readFileSync(path.join(dir, "players.sqlite"), "utf8"), "accounts");
  assert.equal(applyReset(dir, "2026-11-17", { adopt: true }).result, "current");
  // A real reset still is one, and writes its marker whole.
  const done = applyReset(dir, "2026-12-01", { adopt: true });
  assert.equal(done.result, "reset");
  assert.equal(fs.readFileSync(path.join(dir, ".accounts-reset"), "utf8"), "2026-12-01\n");
  assert.equal(fs.existsSync(path.join(dir, ".accounts-reset.tmp")), false);
});
