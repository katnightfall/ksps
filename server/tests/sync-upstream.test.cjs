// Ours: deploy/sync-upstream.mjs, the script that merges the original project into our copy.
// Its git half runs here against two scratch repositories; its checks (build, tests, a trial
// start of the server) are run by the script itself on every merge.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const script = import(pathToFileURL(path.join(__dirname, "../../deploy/sync-upstream.mjs")).href);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

function commit(root, message, files) {
  for (const [file, text] of Object.entries(files)) write(root, file, text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

/** The original project and our copy of it, each with one commit of its own on top. */
function pair(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-upstream-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const theirs = path.join(dir, "theirs");
  const ours = path.join(dir, "ours");
  for (const root of [theirs, ours]) {
    fs.mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.invalid");
    // Line endings as written: a Windows default would make every file differ.
    git(root, "config", "core.autocrlf", "false");
  }
  commit(theirs, "the project", {
    "game.txt": "one\ntwo\nthree\n",
    "docs/world-configuration.md": "settings: a\n",
    "client/public/favicon/favicon.svg": "<svg>theirs</svg>\n",
    "server/plugins/bots/data/object-index.json": "{}\n",
  });
  git(ours, "remote", "add", "upstream", theirs);
  git(ours, "pull", "-q", "upstream", "main");
  commit(ours, "our change", { "ours.txt": "ours\n" });
  return { theirs, ours };
}

const clean = (root) => git(root, "status", "--porcelain") === "" && !fs.existsSync(path.join(root, ".git", "MERGE_HEAD"));

test("nothing new in the original project: nothing is done", async (t) => {
  const { mergeUpstream } = await script;
  const { ours } = pair(t);
  const head = git(ours, "rev-parse", "HEAD");
  assert.deepEqual(mergeUpstream(ours), { result: "current" });
  assert.equal(git(ours, "rev-parse", "HEAD"), head);
  assert.ok(clean(ours));
});

test("new commits are merged and staged, not committed; undoing puts the folder back", async (t) => {
  const { mergeUpstream, undoMerge } = await script;
  const { theirs, ours } = pair(t);
  commit(theirs, "new content", { "new.txt": "new\n" });
  commit(theirs, "more", { "game.txt": "one\ntwo\nthree\nfour\n" });
  const head = git(ours, "rev-parse", "HEAD");

  const merged = mergeUpstream(ours);
  assert.equal(merged.result, "merged");
  assert.equal(merged.commits, 2);
  assert.deepEqual(merged.resolved, []);
  assert.deepEqual(merged.changed.sort(), ["game.txt", "new.txt"]);
  assert.equal(merged.theirs, git(theirs, "rev-parse", "HEAD"));
  assert.equal(git(ours, "rev-parse", "HEAD"), head, "the merge waits for the checks");
  assert.ok(fs.existsSync(path.join(ours, "new.txt")));
  assert.ok(fs.existsSync(path.join(ours, "ours.txt")), "our own change is kept");

  // What the bots' tests leave behind does not stand in the way of undoing.
  write(ours, "server/plugins/bots/data/object-index.json", '{"rewritten":true}\n');
  assert.equal(undoMerge(ours), true);
  assert.ok(clean(ours));
  assert.ok(!fs.existsSync(path.join(ours, "new.txt")));
  assert.equal(git(ours, "rev-parse", "HEAD"), head);
});

test("both sides changed a generated file: theirs is taken, to be made again", async (t) => {
  const { mergeUpstream, commitMessage } = await script;
  const { theirs, ours } = pair(t);
  commit(theirs, "their setting", { "docs/world-configuration.md": "settings: a, theirs\n" });
  commit(ours, "our setting", { "docs/world-configuration.md": "settings: a, ours\n" });

  const merged = mergeUpstream(ours);
  assert.equal(merged.result, "merged");
  assert.deepEqual(merged.resolved, ["docs/world-configuration.md"]);
  assert.equal(fs.readFileSync(path.join(ours, "docs/world-configuration.md"), "utf8"), "settings: a, theirs\n");
  assert.equal(git(ours, "diff", "--name-only", "--diff-filter=U"), "");
  assert.match(commitMessage(merged), /^Merge upstream \(RSPSApp\/tsps\) main: 1 commit, .*docs\/world-configuration\.md \(generated, made again\)$/);
});

test("both sides changed one of our pictures: ours is kept", async (t) => {
  const { mergeUpstream, commitMessage } = await script;
  const { theirs, ours } = pair(t);
  commit(ours, "our icon", { "client/public/favicon/favicon.svg": "<svg>ours</svg>\n" });
  commit(theirs, "their new icon", { "client/public/favicon/favicon.svg": "<svg>theirs, redrawn</svg>\n" });

  const merged = mergeUpstream(ours);
  assert.equal(merged.result, "merged");
  assert.deepEqual(merged.resolved, ["client/public/favicon/favicon.svg"]);
  assert.equal(fs.readFileSync(path.join(ours, "client/public/favicon/favicon.svg"), "utf8"), "<svg>ours</svg>\n");
  assert.match(commitMessage(merged), /favicon\.svg \(ours kept\)$/);
});

test("both sides changed the same lines of the game: the folder is put back and the files are named", async (t) => {
  const { mergeUpstream } = await script;
  const { theirs, ours } = pair(t);
  commit(ours, "our rule", { "game.txt": "one\ntwo, ours\nthree\n" });
  commit(theirs, "their rule", { "game.txt": "one\ntwo, theirs\nthree\n", "docs/world-configuration.md": "settings: b\n" });
  const head = git(ours, "rev-parse", "HEAD");

  assert.deepEqual(mergeUpstream(ours), { result: "conflict", commits: 1, files: ["game.txt"] });
  assert.ok(clean(ours), "nothing is left half merged");
  assert.equal(git(ours, "rev-parse", "HEAD"), head);
  assert.equal(fs.readFileSync(path.join(ours, "game.txt"), "utf8"), "one\ntwo, ours\nthree\n");
});

test("a merge only starts from our branch with nothing uncommitted", async (t) => {
  const { notReady } = await script;
  const { ours } = pair(t);
  assert.equal(notReady(ours), null);
  write(ours, "ours.txt", "being edited\n");
  assert.match(notReady(ours), /not committed \(ours\.txt\)/);
  git(ours, "checkout", "-q", "--", "ours.txt");
  git(ours, "checkout", "-q", "-b", "experiment");
  assert.match(notReady(ours), /branch 'experiment'/);
});

test("our tests are the ones the original project does not have", async (t) => {
  const { ourTests } = await script;
  const { theirs, ours } = pair(t);
  commit(theirs, "their tests", { "server/tests/theirs.test.cjs": "", "client/tests/theirs.test.ts": "" });
  git(ours, "pull", "-q", "--no-rebase", "--no-edit", "upstream", "main");
  commit(ours, "our tests", { "server/tests/ours.test.cjs": "", "server/tests/helper.cjs": "", "client/tests/ours-too.test.ts": "" });
  assert.deepEqual(ourTests(ours, git(theirs, "rev-parse", "HEAD")), { server: ["tests/ours.test.cjs"], client: ["ours-too"] });
});

test("a trial start passes only when the server came up, printed no errors and saved everyone", async () => {
  const { trialVerdict } = await script;
  const healthy = "[plugins] active=630 disabled=6\n[network] client websocket listening on 43777\n[world] savePlayers queued: saved=20, failed=0\n";
  assert.equal(trialVerdict(0, healthy), null);
  assert.match(trialVerdict(1, healthy), /stopped with code 1/);
  assert.match(trialVerdict(0, "[network] client websocket listening on 43777\n"), /plugins did not load/);
  assert.match(trialVerdict(0, "[plugins] active=630 disabled=6\n"), /never opened its port/);
  assert.match(trialVerdict(0, `${healthy}[plugins] login hook failed (Quests) TypeError: x is not a function\n`), /printed errors while starting \(1\)/);
  assert.match(trialVerdict(0, healthy.replace("failed=0", "failed=3")), /3 players could not be saved/);
});

test("package files are told from the rest", async () => {
  const { PACKAGE_FILES } = await script;
  for (const file of ["package.json", "yarn.lock", "server/package.json", "client/yarn.lock", ".yarnrc.yml"]) assert.ok(PACKAGE_FILES.test(file), file);
  for (const file of ["server/plugins/package.json", "client/tests/yarn.lock.txt", "server/data/definitions/world.json"]) assert.ok(!PACKAGE_FILES.test(file), file);
});
