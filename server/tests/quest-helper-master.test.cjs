// Ours. node --test tests/quest-helper-master.test.cjs (no build needed)
// Quest Helper's engine runs once, on the master, for every world of it (deploy/quest-helper.mjs):
//   - a world of a master is started with the master's address for it and a token made from the
//     key the two already share (deploy/pterodactyl/launch.mjs);
//   - the master's website passes a world's requests on to the engine, and turns away anyone
//     without that token before the engine hears of them (deploy/front.mjs).
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { pathToFileURL } = require("node:url");

const deploy = path.join(__dirname, "../../deploy");
const load = (file) => import(pathToFileURL(path.join(deploy, file)).href);
const KEY = "a".repeat(64);

test("the token is made from the shared key, the same on both sides, and does not give the key away", async () => {
  const { questHelperToken, BRIDGE_PATH } = await load("quest-helper.mjs");
  const token = questHelperToken(KEY);
  assert.match(token, /^[0-9a-f]{64}$/, "long enough for the engine, which wants 24 characters or more");
  assert.equal(questHelperToken(` ${KEY}\n`), token, "as the key is read from its file");
  assert.notEqual(token, KEY);
  assert.equal(token.includes(KEY.slice(0, 16)), false);
  assert.notEqual(questHelperToken("b".repeat(64)), token);
  assert.equal(questHelperToken(""), "", "no key, no token");
  assert.equal(questHelperToken(undefined), "");
  assert.equal(BRIDGE_PATH, "/quest-helper");
});

test("a world of a master asks the master's engine; a world on its own, or with an engine of its own, is left as it is", async () => {
  const { gameEnv } = await load("pterodactyl/launch.mjs");
  const { questHelperToken } = await load("quest-helper.mjs");
  const ours = gameEnv({ WORLDS_MASTER_URL: "https://rs.example.com/", MASTER_PROXY_KEY: KEY, QUEST_HELPER_URL: "", QUEST_HELPER_TOKEN: "" });
  assert.equal(ours.QUEST_HELPER_URL, "https://rs.example.com/quest-helper");
  assert.equal(ours.QUEST_HELPER_TOKEN, questHelperToken(KEY));
  // What the game server makes of it (plugins/quests/questhelper/Http.QuestHelper.js).
  const { QuestHelperHttp } = require("../plugins/quests/questhelper/Http.QuestHelper");
  const asked = [];
  const client = new QuestHelperHttp({ url: ours.QUEST_HELPER_URL, token: ours.QUEST_HELPER_TOKEN,
    fetchImpl: async (url, options) => { asked.push([url, options.headers.Authorization]); return new Response("{}"); } });
  await client.catalog();
  assert.deepEqual(asked, [["https://rs.example.com/quest-helper/catalog", `Bearer ${questHelperToken(KEY)}`]]);

  for (const [why, env, own] of [
    ["no master", { MASTER_PROXY_KEY: KEY }, ""],
    ["no key", { WORLDS_MASTER_URL: "https://rs.example.com" }, ""],
    ["a master address that is not one", { WORLDS_MASTER_URL: "rs.example.com/x y", MASTER_PROXY_KEY: KEY }, ""],
  ]) {
    const game = gameEnv(env, own);
    assert.equal("QUEST_HELPER_URL" in game, false, why);
    assert.equal("QUEST_HELPER_TOKEN" in game, false, why);
  }
  const master = { WORLDS_MASTER_URL: "https://rs.example.com", MASTER_PROXY_KEY: KEY };
  const panel = gameEnv({ ...master, QUEST_HELPER_TOKEN: "their-own-token-of-24-characters" });
  assert.equal(panel.QUEST_HELPER_TOKEN, "their-own-token-of-24-characters", "set in the panel");
  assert.equal("QUEST_HELPER_URL" in panel, false, "so their own engine beside the game");
  const file = gameEnv(master, "DEV_USERNAME=someone\n  QUEST_HELPER_TOKEN=their-own-token-of-24-characters\n");
  assert.equal("QUEST_HELPER_TOKEN" in file, false, "set in the server's .env, which the game reads itself");
  assert.equal("QUEST_HELPER_URL" in file, false);
  const commented = gameEnv(master, "# QUEST_HELPER_TOKEN=replace-with-32-random-bytes\nQUEST_HELPER_TOKEN=\n");
  assert.equal(commented.QUEST_HELPER_URL, "https://rs.example.com/quest-helper", ".env.example's commented line is not a setting");
});

test("what the engine is built from: the pinned source, a name that follows its files, the right JDK", async () => {
  const { pinnedCommit, sourceFiles, sourceKey, jdkPlatform, javaMajor, restartDelay } = await load("quest-helper.mjs");
  const bridge = path.join(__dirname, "../../tools/quest-helper-bridge");
  const commit = pinnedCommit(fs.readFileSync(path.join(bridge, "build.gradle"), "utf8"));
  assert.match(commit, /^[0-9a-f]{40}$/, "the original project's build file names one Quest Helper commit");
  assert.ok(fs.readFileSync(path.join(bridge, "README.md"), "utf8").includes(commit), "the one its README says to check out");
  assert.equal(pinnedCommit(`x '${"1".repeat(40)}' y '${"2".repeat(40)}'`), null, "two different ones: not guessed between");
  assert.equal(pinnedCommit("no commit here"), null);

  const made = fs.mkdtempSync(path.join(os.tmpdir(), "qh-source-"));
  try {
    fs.mkdirSync(path.join(made, "src/main"), { recursive: true });
    fs.mkdirSync(path.join(made, "build/install"), { recursive: true });
    fs.mkdirSync(path.join(made, "quest-helper-upstream/src"), { recursive: true });
    fs.mkdirSync(path.join(made, "src/build"), { recursive: true });
    fs.writeFileSync(path.join(made, "build.gradle"), "a");
    fs.writeFileSync(path.join(made, "src/main/Bridge.java"), "b");
    fs.writeFileSync(path.join(made, "src/build/Kept.java"), "c");
    fs.writeFileSync(path.join(made, "build/install/bridge.jar"), "built");
    fs.writeFileSync(path.join(made, "quest-helper-upstream/src/Quest.java"), "a developer's checkout");
    assert.deepEqual(sourceFiles(made), ["build.gradle", "src/build/Kept.java", "src/main/Bridge.java"],
      "not what a build makes, nor a checkout of Quest Helper left in the folder; a folder named build deeper down is source");
    const key = sourceKey(made);
    fs.writeFileSync(path.join(made, "build/install/bridge.jar"), "built again");
    assert.equal(sourceKey(made), key, "building changes nothing");
    fs.writeFileSync(path.join(made, "src/main/Bridge.java"), "b2");
    assert.notEqual(sourceKey(made), key, "a changed file is a new version to build");
  } finally {
    fs.rmSync(made, { recursive: true, force: true });
  }

  assert.deepEqual(jdkPlatform("linux", "x64"), { os: "linux", architecture: "x64" });
  assert.deepEqual(jdkPlatform("linux", "arm64"), { os: "linux", architecture: "aarch64" });
  assert.deepEqual(jdkPlatform("win32", "x64"), { os: "windows", architecture: "x64" });
  assert.equal(jdkPlatform("sunos", "x64"), null);
  assert.equal(javaMajor('openjdk version "21.0.5" 2024-10-15 LTS'), 21);
  assert.equal(javaMajor('java version "18.0.2.1" 2022-08-18'), 18);
  assert.equal(javaMajor('java version "1.8.0_402"'), 8);
  assert.equal(javaMajor("not java"), 0);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(restartDelay), [5000, 10000, 20000, 40000, 60000, 60000]);
});

test("the master's server starts the engine beside its parked port, and the worlds' route is on its website", () => {
  const run = fs.readFileSync(path.join(deploy, "run.sh"), "utf8");
  const parked = run.slice(run.indexOf('if [ "$MASTER_ONLY" = 1 ]'), run.indexOf('exec node "$ROOT/deploy/master/parked.mjs"'));
  assert.ok(parked.includes('node "$ROOT/deploy/quest-helper.mjs" &'), "started in the background, before the port is held");
  assert.ok(parked.includes("QUEST_HELPER_BRIDGE"), "and it can be turned off");
  // The engine's own files are kept outside the project, where no deploy copies or removes them.
  const helper = fs.readFileSync(path.join(deploy, "quest-helper.mjs"), "utf8");
  assert.ok(helper.includes('path.join(os.homedir(), "quest-helper")'));
});

// ---- the master's website, in front of a stand-in engine ---------------------------------------------

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

let front;
let engine;
let site;
let base;
let folder;
let enginePort;
const heard = [];
let token;

before(async () => {
  token = (await load("quest-helper.mjs")).questHelperToken(KEY);
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "qh-front-"));
  fs.writeFileSync(path.join(folder, "proxy-key"), `${KEY}\n`);
  // The engine, as BridgeServer.java answers: /health to anyone, the rest to the token.
  engine = http.createServer((request, response) => {
    const parts = [];
    request.on("data", (part) => parts.push(part));
    request.on("end", () => {
      const body = Buffer.concat(parts).toString("utf8");
      heard.push({ method: request.method, url: request.url, authorization: request.headers.authorization ?? null, body, cookie: request.headers.cookie ?? null, forwarded: request.headers["x-real-ip"] ?? null });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ route: request.url, got: body.length }));
    });
  });
  enginePort = await freePort();
  await new Promise((resolve) => engine.listen(enginePort, "127.0.0.1", resolve));
  site = http.createServer((request, response) => { response.writeHead(200, { "Content-Type": "text/plain" }); response.end("the website"); });
  const sitePort = await freePort();
  await new Promise((resolve) => site.listen(sitePort, "127.0.0.1", resolve));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  front = spawn(process.execPath, [path.join(deploy, "front.mjs")], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", MASTER_ADMIN: "1", MASTER_ONLY: "1", FRONT_MASTER_PORT: String(await freePort()),
      FRONT_STATIC_PORT: String(sitePort), FRONT_QUEST_HELPER_PORT: String(enginePort), FRONT_PROXY_KEY_FILE: path.join(folder, "proxy-key"), GAME_PORT: String(await freePort()) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    const give = setTimeout(() => reject(new Error("the front door did not start")), 20_000);
    front.stdout.on("data", (chunk) => { if (String(chunk).includes("[front]")) { clearTimeout(give); resolve(); } });
    front.on("exit", (code) => reject(new Error(`the front door stopped (exit ${code})`)));
  });
});

after(async () => {
  front?.removeAllListeners("exit");
  front?.kill();
  for (const server of [engine, site]) { server?.closeAllConnections?.(); server?.close(); }
  try { fs.rmSync(folder, { recursive: true, force: true }); } catch {}
});

const ask = (route, options = {}) => fetch(`${base}${route}`, { signal: AbortSignal.timeout(10_000), ...options });

test("a world with the token reaches the engine through the master's website, and only its own request is passed on", async () => {
  heard.length = 0;
  const catalog = await ask("/quest-helper/catalog", { headers: { Authorization: `Bearer ${token}`, Cookie: "session=1", "X-Real-IP": "203.0.113.9" } });
  assert.equal(catalog.status, 200);
  assert.deepEqual(await catalog.json(), { route: "/catalog", got: 0 });
  const body = JSON.stringify({ protocol: 1, session: "s", sequence: 1, questKey: "cooks_assistant", snapshot: { pad: "x".repeat(200_000) } });
  const evaluated = await ask("/quest-helper/evaluate", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
  assert.equal(evaluated.status, 200);
  assert.deepEqual(await evaluated.json(), { route: "/evaluate", got: body.length });
  const closed = await ask("/quest-helper/close", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: '{"session":"s"}' });
  assert.equal(closed.status, 200);
  assert.deepEqual(heard.map((request) => [request.method, request.url, request.authorization, request.cookie, request.forwarded]), [
    ["GET", "/catalog", `Bearer ${token}`, null, null],
    ["POST", "/evaluate", `Bearer ${token}`, null, null],
    ["POST", "/close", `Bearer ${token}`, null, null],
  ]);
  assert.equal(heard[1].body, body, "the whole snapshot, as it was sent");
});

test("anyone without the token is turned away at the website: the engine never hears of them", async () => {
  heard.length = 0;
  for (const headers of [{}, { Authorization: "Bearer " }, { Authorization: `Bearer ${"0".repeat(64)}` }, { Authorization: `Bearer ${KEY}` }, { Authorization: token }, { Authorization: `Bearer ${token}x` }]) {
    for (const route of ["/quest-helper/catalog", "/quest-helper/evaluate", "/quest-helper/close"]) {
      const answer = await ask(route, { method: route.endsWith("catalog") ? "GET" : "POST", headers, body: route.endsWith("catalog") ? undefined : "{}" });
      assert.equal(answer.status, 401, `${route} with ${JSON.stringify(headers)}`);
    }
  }
  // Nothing but the engine's four addresses, token or not.
  for (const route of ["/quest-helper/", "/quest-helper/shutdown", "/quest-helper/catalog/../x", "/quest-helper/evaluate/more"]) {
    const answer = await ask(route, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(answer.status, 404, route);
  }
  // More than the engine takes in one request.
  const big = await ask("/quest-helper/evaluate", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "x".repeat(4 * 1024 * 1024 + 1) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
  assert.deepEqual(heard, []);
  // Whether it is up is no secret (the engine answers that to anyone, too).
  const health = await ask("/quest-helper/health");
  assert.equal(health.status, 200);
  assert.equal(heard.length, 1);
  // The website itself is where it was.
  const page = await ask("/quest-helperish");
  assert.equal(await page.text(), "the website");
});

test("with the engine down, the world is told so in words its log can show", async () => {
  await new Promise((resolve) => { engine.closeAllConnections(); engine.close(resolve); });
  const answer = await ask("/quest-helper/catalog", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(answer.status, 503);
  assert.match(await answer.text(), /Quest Helper's engine is not answering on the master/);
});
