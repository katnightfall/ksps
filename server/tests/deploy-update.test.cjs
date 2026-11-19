// Ours. node --test tests/deploy-update.test.cjs (no build needed; needs bash with GNU tar: Linux, or Git for Windows)
// The server's updater (deploy/update.sh), run for real on a stand-in server: a folder for the
// live project, one for the updater's own files, an upload made as `npm run deploy` makes it, and
// two small scripts in place of systemd and of the ports (the updater's own TSPS_TEST switches).
//   - what is restarted for what: nothing for a document or the admin page's HTML, the website
//     for what the front door loads, the game for what the game service runs;
//   - a build that fails changes nothing; a half that does not come back up is put back;
//   - a file that became a folder (or a folder a file) goes in, and comes back out on a rollback;
//   - saves are never replaced, and an upload that reaches outside the project is refused.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const UPDATER = path.join(__dirname, "../../deploy/update.sh");

/** bash with GNU tools: the system's, or the one that comes with Git on Windows (never WSL's, which sees other paths). */
function findBash() {
  if (process.platform !== "win32") return "bash";
  const git = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  if (git.status !== 0) return null;
  for (let dir = git.stdout.trim(), i = 0; i < 6; i++, dir = path.dirname(dir)) {
    for (const candidate of [path.join(dir, "bin", "bash.exe"), path.join(dir, "usr", "bin", "bash.exe")]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}
const BASH = findBash();
const usable = BASH && spawnSync(BASH, ["-c", "tar --version | grep -q 'GNU tar' && command -v comm xargs sort >/dev/null"]).status === 0;
const skip = usable ? false : "no bash with GNU tar here";

const A = "1".repeat(40), B = "2".repeat(40);
/** A path as bash takes it: on Windows /c/Users/..., since tar takes "C:" before a path for a host's name. */
const slashes = (file) => (process.platform === "win32" ? file.replace(/^([A-Za-z]):/, (whole, drive) => `/${drive.toLowerCase()}`) : file).replace(/\\/g, "/");

/**
 * A server with version A installed: `files` (path -> text) as its project, built and with its
 * packages, and whatever the server itself keeps there.
 */
function server(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const dest = path.join(root, "dest"), base = path.join(root, "base");
  const write = (folder, file, text) => { fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true }); fs.writeFileSync(path.join(folder, file), text); };
  for (const [file, text] of Object.entries(files)) write(dest, file, text);
  // The server's own: packages, builds, the game cache, its settings and the players' saves.
  for (const folder of ["server/node_modules", "client/node_modules", "server/caches"]) fs.mkdirSync(path.join(dest, folder), { recursive: true });
  write(dest, "server/dist/Server.js", "built from A\n");
  write(dest, "client/build/index.html", "built from A\n");
  write(dest, ".env", "SECRET=the server's own\n");
  write(dest, "server/data/saves/players.sqlite", "every account\n");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "commit"), `${A}\n`);
  fs.writeFileSync(path.join(base, "manifest"), `${Object.keys(files).sort().join("\n")}\n`);
  // In systemd's place: notes what it is asked. In the ports' place: a half is up unless its
  // file says "does not start" (deploy/front.mjs for the website, server/dist/Server.js for the game).
  write(root, "service.sh", '#!/usr/bin/env bash\necho "$1 $2" >> "$TSPS_TEST_CALLS"\n');
  write(root, "up.sh", '#!/usr/bin/env bash\nif [ "$1" = 3000 ]; then f=deploy/front.mjs; else f=server/dist/Server.js; fi\n! grep -qs "does not start" "$TSPS_DEST/$f"\n');
  const calls = path.join(root, "calls");
  let uploads = 0;

  /** Runs the updater as the deploy key would. `upload`: { commit, files: every file of that version, sent: the ones that changed }. */
  function run(args, upload = null, extraFiles = {}) {
    let input;
    if (upload) {
      const tree = path.join(root, `upload-${++uploads}`);
      for (const file of upload.sent) write(tree, file, upload.files[file]);
      for (const [file, text] of Object.entries(extraFiles)) write(tree, file, text);
      write(tree, ".tsps-deploy/commit", `${upload.commit}\n`);
      write(tree, ".tsps-deploy/manifest", `${Object.keys(upload.files).sort().join("\n")}\n`);
      // Packed where it lies, by names without a drive letter in them (tar takes "C:" for a host).
      const packed = spawnSync(BASH, ["-c", "tar -czf upload.tgz -C \"$0\" .", path.basename(tree)], { cwd: root, encoding: "utf8" });
      assert.equal(packed.status, 0, packed.stderr);
      input = fs.readFileSync(path.join(root, "upload.tgz"));
    }
    fs.rmSync(calls, { force: true });
    const done = spawnSync(BASH, [slashes(UPDATER), ...args], {
      cwd: root, input, encoding: "utf8",
      env: { ...process.env, TSPS_TEST: "1", TSPS_DEST: slashes(dest), TSPS_BASE: slashes(base), TSPS_CONF: "/nonexistent",
        TSPS_TEST_SERVICE: slashes(path.join(root, "service.sh")), TSPS_TEST_UP: slashes(path.join(root, "up.sh")), TSPS_TEST_CALLS: slashes(calls),
        GAME_WAIT: "4", FIRST_GAME_WAIT: "4", WEB_WAIT: "4" },
    });
    const asked = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : [];
    return { status: done.status, said: `${done.stdout}${done.stderr}`, restarted: asked.filter((line) => line.startsWith("restart ")).map((line) => line.slice("restart ".length)).sort() };
  }
  const read = (file) => { try { return fs.readFileSync(path.join(dest, file), "utf8"); } catch { return null; } };
  /** Every file of the project as it is on the server now (the server's own left out): path -> text. */
  const live = () => {
    const found = {};
    const walk = (folder, prefix) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (/^(\.env|server\/(node_modules|dist|caches|data\/saves)|client\/(node_modules|build))$/.test(name)) continue;
        if (entry.isDirectory()) walk(path.join(folder, entry.name), name);
        else found[name] = fs.readFileSync(path.join(folder, entry.name), "utf8");
      }
    };
    walk(dest, "");
    return found;
  };
  return { root, dest, base, run, read, live, version: () => fs.readFileSync(path.join(base, "commit"), "utf8").trim() };
}

/** Version B of `files`: `changes` laid over them (null removes a file); `sent` is what a deploy sends. */
function next(files, changes) {
  const all = { ...files };
  for (const [file, text] of Object.entries(changes)) { if (text === null) delete all[file]; else all[file] = text; }
  return { commit: B, files: all, sent: Object.keys(changes).filter((file) => changes[file] !== null) };
}

const PROJECT = {
  "README.md": "about A\n",
  "deploy/front.mjs": "front door A\n",
  "deploy/worlds.mjs": "worlds A\n",
  "deploy/reset-accounts.mjs": "reset A\n",
  "deploy/quest-helper.mjs": "engine keeper A\n",
  "deploy/master/admin.html": "<html>admin page A</html>\n",
  "deploy/master/admin.mjs": "admin A\n",
  "deploy/master/parked.mjs": "parked A\n",
  "deploy/settings.env": "MASTER_ONLY=1\nACCOUNTS_RESET_ID=2026-11-17\n",
  "deploy/run.sh": "#!/usr/bin/env bash\n# In the real one's place: builds as it is told to by the file beside it.\ncd \"$(dirname \"${BASH_SOURCE[0]}\")/..\"\nif [ \"$1\" = build-server ]; then if grep -q 'does not compile' server/src/Main.ts; then echo 'error TS2304: Cannot find name'; exit 2; fi; mkdir -p server/dist; { echo built from; cat server/src/Main.ts; } > server/dist/Server.js; fi\n",
  "server/src/Main.ts": "engine A\n",
  "server/plugins/Shop.js": "shop A\n",
  "server/data/saves/Bans.txt": "\n",
  "docs/guide": "a guide, as one file\n",
  "docs/notes/one.md": "one\n",
  "docs/notes/two.md": "two\n",
};

test("what is restarted for what: nothing for a document or the admin page's HTML, each half for what it runs", { skip }, (t) => {
  for (const [changed, expected] of [
    [{ "README.md": "about B\n" }, []],
    // Read from disk at every visit. A restart of the website for it disconnected every player the front door carries.
    [{ "deploy/master/admin.html": "<html>admin page B</html>\n" }, []],
    [{ "deploy/master/admin.mjs": "admin B\n" }, ["web"]],
    [{ "deploy/front.mjs": "front door B\n" }, ["web"]],
    // Loaded by the front door and the admin page: a change to it used to restart nothing.
    [{ "deploy/reset-accounts.mjs": "reset B\n" }, ["web"]],
    // The front door loads it and, on a master with no world of its own, the game service runs it.
    [{ "deploy/quest-helper.mjs": "engine keeper B\n" }, ["game", "web"]],
    [{ "server/plugins/Shop.js": "shop B\n" }, ["game"]],
  ]) {
    const s = server(t, PROJECT);
    const done = s.run(["update", A], next(PROJECT, changed));
    const file = Object.keys(changed)[0];
    assert.equal(done.status, 0, `${file}: ${done.said}`);
    assert.deepEqual(done.restarted, expected, file);
    assert.equal(s.read(file), changed[file], file);
    assert.equal(s.version(), B);
  }
  // Where a world runs on the server itself, the game service runs neither of the two: its players stay.
  const own = { ...PROJECT, "deploy/settings.env": "MASTER_ONLY=0\n" };
  const s = server(t, own);
  assert.deepEqual(s.run(["update", A], next(own, { "deploy/quest-helper.mjs": "engine keeper B\n" })).restarted, ["web"]);
});

test("a build that fails changes nothing on the live server, and says why", { skip }, (t) => {
  const s = server(t, PROJECT);
  const before = s.live();
  const done = s.run(["update", A], next(PROJECT, { "server/src/Main.ts": "engine B, which does not compile\n", "server/plugins/Shop.js": "shop B\n" }));
  assert.equal(done.status, 1);
  assert.match(done.said, /Building the game server failed\. The live server was not touched\./);
  assert.match(done.said, /error TS2304/, "the end of the build's own log is shown");
  assert.deepEqual(s.live(), before);
  assert.equal(s.read("server/dist/Server.js"), "built from A\n");
  assert.equal(s.version(), A);
  assert.deepEqual(done.restarted, []);
  // The same deploy, mended, then goes through: built beside the live copy and swapped in.
  const mended = s.run(["update", A], next(PROJECT, { "server/src/Main.ts": "engine B\n", "server/plugins/Shop.js": "shop B\n" }));
  assert.equal(mended.status, 0, mended.said);
  assert.equal(s.read("server/dist/Server.js"), "built from\nengine B\n");
  assert.deepEqual(mended.restarted, ["game"]);
  assert.equal(s.version(), B);
});

test("a half that does not come back up is put back as it was, by itself; a rollback by hand does the same", { skip }, (t) => {
  const s = server(t, PROJECT);
  const before = s.live();
  const changes = { "deploy/front.mjs": "front door B, which does not start\n", "README.md": "about B\n", "docs/new/page.md": "new in B\n", "docs/notes/one.md": null };
  const done = s.run(["update", A], next(PROJECT, changes));
  assert.equal(done.status, 1);
  assert.match(done.said, /The web client is not answering on port 3000/);
  assert.match(done.said, /Putting the previous version back\.\.\.[\s\S]*The previous version is running again\./);
  assert.deepEqual(s.live(), before, "every file as it was: the changed ones back, the new one gone, the removed one back");
  assert.equal(fs.existsSync(path.join(s.dest, "docs/new")), false, "and the folder the new file came in");
  assert.equal(s.version(), A);

  // One that does come up, then taken back by hand.
  const good = s.run(["update", A], next(PROJECT, { ...changes, "deploy/front.mjs": "front door B\n" }));
  assert.equal(good.status, 0, good.said);
  assert.equal(s.read("docs/new/page.md"), "new in B\n");
  assert.equal(s.read("docs/notes/one.md"), null);
  const back = s.run(["rollback"]);
  assert.equal(back.status, 0, back.said);
  assert.deepEqual(back.restarted, ["web"]);
  assert.deepEqual(s.live(), before);
  assert.equal(s.version(), A);
  assert.equal(s.run(["rollback"]).status, 1, "nothing further back to go to");
});

test("a file that became a folder, and a folder that became a file, go in whole and come back out on a rollback", { skip }, (t) => {
  const s = server(t, PROJECT);
  const before = s.live();
  const changes = {
    "docs/guide": null, "docs/guide/start.md": "the guide, now a folder\n", "docs/guide/more.md": "more\n",
    "docs/notes/one.md": null, "docs/notes/two.md": null, "docs/notes": "the notes, now one file\n",
    "README.md": "about B\n",
  };
  const done = s.run(["update", A], next(PROJECT, changes));
  assert.equal(done.status, 0, done.said);
  const after = s.live();
  assert.equal(after["docs/guide/start.md"], "the guide, now a folder\n");
  assert.equal(after["docs/guide/more.md"], "more\n");
  assert.equal(after["docs/notes"], "the notes, now one file\n");
  assert.equal(after["README.md"], "about B\n");
  assert.deepEqual(Object.keys(after).sort(), Object.keys(next(PROJECT, changes).files).filter((file) => !file.startsWith("server/data/saves/")).sort(), "exactly the new version's files");
  assert.equal(s.version(), B);

  const back = s.run(["rollback"]);
  assert.equal(back.status, 0, back.said);
  assert.deepEqual(s.live(), before);
  assert.equal(s.version(), A);
});

test("what belongs to the server is never replaced, and an upload that reaches for it is refused whole", { skip }, (t) => {
  const s = server(t, PROJECT);
  fs.writeFileSync(path.join(s.dest, "server/data/saves/Bans.txt"), "a cheater, banned since the last deploy\n");
  const before = s.live();
  // A full upload carries the project's empty ban list again: the server's own stays.
  const full = s.run(["update", "full"], { commit: B, files: { ...PROJECT, "README.md": "about B\n" }, sent: Object.keys(PROJECT) });
  assert.equal(full.status, 0, full.said);
  assert.equal(s.read("server/data/saves/Bans.txt"), "a cheater, banned since the last deploy\n");
  assert.equal(s.read("server/data/saves/players.sqlite"), "every account\n");
  assert.equal(s.read(".env"), "SECRET=the server's own\n");
  assert.equal(s.read("README.md"), "about B\n");

  const C = "3".repeat(40);
  for (const [why, upload, extra, said] of [
    ["the server's settings", { commit: C, files: { ...PROJECT, ".env": "SECRET=another\n" }, sent: [".env"] }, {}, /contains \.env, which belongs to the server/],
    ["its packages", { commit: C, files: { ...PROJECT, "server/node_modules/x/index.js": "x\n" }, sent: ["server/node_modules/x/index.js"] }, {}, /belongs to the server/],
    ["a path out of the folder", { commit: C, files: { ...PROJECT, "../outside.txt": "x\n" }, sent: [] }, {}, /lists a file name this updater won't take/],
    ["a file its own list lacks", { commit: C, files: PROJECT, sent: [] }, { "server/extra.js": "x\n" }, /has files its own list doesn't/],
    ["a version it does not build on", null, {}, /BASE-MISMATCH/],
  ]) {
    const now = s.live();
    const done = upload ? s.run(["update", B], upload, extra) : s.run(["update", A], { commit: C, files: PROJECT, sent: [] });
    assert.notEqual(done.status, 0, why);
    assert.match(done.said, said, why);
    assert.deepEqual(s.live(), now, `${why}: nothing was changed`);
    assert.equal(s.version(), B, why);
    assert.deepEqual(done.restarted, [], why);
  }
  assert.equal(fs.existsSync(path.join(s.root, "outside.txt")), false);
  void before;
});
