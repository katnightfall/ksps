// Ours. node --test tests/front-door.test.cjs (no build needed)
// The front door (deploy/front.mjs) is the one way in for every player of every world the master
// carries, so nothing a visitor sends, and nothing that goes wrong behind it, may stop it:
//   - an address that is not one ("//") is refused by the website, not fatal to it;
//   - the website stopping does not stop the front door, or the game connections through it;
//   - a listed world with a port that does not exist is not listed, instead of stopping the
//     front door at the first visitor;
//   - what a visitor says about who they are is not passed on: only the master's signed word is.
// Each front door here is the real one, started as a process, with stand-ins behind it.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");
const { pathToFileURL } = require("node:url");

const project = path.join(__dirname, "../..");
const load = (file) => import(pathToFileURL(path.join(project, "deploy", file)).href);
const KEY = "k".repeat(64);

const cleanups = [];
after(async () => { for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch {} } });

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A copy of the project's deploy folder and the website's server, with a one-page website to serve. */
function makeTree(websiteScript = null) {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "front-door-"));
  cleanups.push(() => fs.rmSync(tree, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  fs.cpSync(path.join(project, "deploy"), path.join(tree, "deploy"), { recursive: true });
  fs.mkdirSync(path.join(tree, "client", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(tree, "client", "build"), { recursive: true });
  fs.writeFileSync(path.join(tree, "client", "build", "index.html"), "<html>the website</html>");
  if (websiteScript) fs.writeFileSync(path.join(tree, "client", "scripts", "serve-build.mjs"), websiteScript);
  else fs.copyFileSync(path.join(project, "client", "scripts", "serve-build.mjs"), path.join(tree, "client", "scripts", "serve-build.mjs"));
  fs.mkdirSync(path.join(tree, "server", "data", "saves", "master"), { recursive: true });
  return tree;
}

/** Starts the front door of `tree`; resolves once it listens. */
async function startFront(tree, env = {}) {
  const port = await freePort();
  const front = spawn(process.execPath, [path.join(tree, "deploy", "front.mjs")], {
    env: { ...process.env, MASTER_ADMIN: "", MASTER_ONLY: "", WORLDS_MASTER_URL: "", MASTER_PROXY_KEY: "", FRONT_STATIC_PORT: "", FRONT_HEADLESS: "",
      PORT: String(port), HOST: "127.0.0.1", GAME_PORT: String(await freePort()), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = { front, port, base: `http://127.0.0.1:${port}`, exit: null, output: "" };
  front.stderr.on("data", (chunk) => { state.output += chunk; });
  front.on("exit", (code) => { state.exit = code ?? 1; });
  cleanups.push(() => { front.kill(); });
  await new Promise((resolve, reject) => {
    const give = setTimeout(() => reject(new Error(`the front door did not start: ${state.output}`)), 20_000);
    front.stdout.on("data", (chunk) => { state.output += chunk; if (String(chunk).includes("[front] http")) { clearTimeout(give); resolve(); } });
    front.on("exit", (code) => { clearTimeout(give); reject(new Error(`the front door stopped (exit ${code}): ${state.output}`)); });
  });
  return state;
}

/** One request written as it is, bytes and all: the first line of the answer ("" when none came). */
const raw = (port, text, host = "127.0.0.1") => new Promise((resolve) => {
  const socket = net.connect(port, host, () => socket.write(Buffer.from(text, "latin1")));
  let got = "";
  socket.on("data", (chunk) => { got += chunk.toString("latin1"); });
  socket.on("close", () => resolve(got.split("\r\n")[0]));
  socket.on("error", () => resolve(got.split("\r\n")[0]));
  setTimeout(() => socket.destroy(), 3_000);
});

const ask = (url) => fetch(url, { signal: AbortSignal.timeout(10_000) });

/** A stand-in server: answers every request, and takes a game connection (an upgrade) and holds it. */
async function standIn(name) {
  const heard = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    heard.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end(name);
  });
  server.on("upgrade", (request, socket) => {
    heard.push({ url: request.url, headers: request.headers, game: true });
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("end", () => socket.end());
    socket.on("close", () => sockets.delete(socket));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  const port = await freePort();
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  cleanups.push(() => { server.closeAllConnections(); server.close(); });
  return { port, heard, sockets };
}

/** Opens a game connection through a front door: the socket once the other side has answered 101. */
const connectGame = (port, target, extraHeaders = "", host = "127.0.0.1") => new Promise((resolve, reject) => {
  const socket = net.connect(port, host, () => socket.write(`GET ${target} HTTP/1.1\r\nHost: play.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${extraHeaders}\r\n`));
  socket.on("error", reject);
  socket.once("data", (chunk) => (String(chunk).startsWith("HTTP/1.1 101") ? resolve(socket) : reject(new Error(`no game connection: ${String(chunk).split("\r\n")[0]}`))));
  socket.on("close", () => reject(new Error("closed before the game answered")));
});

test("an address that is not one is refused by the website; it and the front door stay up", async () => {
  const front = await startFront(makeTree());
  // The website is started by the front door: asked until it answers.
  for (let i = 0; i < 100 && !(await ask(`${front.base}/`).then((answer) => answer.ok, () => false)); i++) await wait(100);
  assert.equal(await (await ask(`${front.base}/`)).text(), "<html>the website</html>");
  for (const target of ["//", "///", "//?x=1", "http://[/x", "//:80/"]) {
    assert.equal(await raw(front.port, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`), "HTTP/1.1 400 Bad Request", target);
  }
  await wait(300);
  assert.equal(front.exit, null, `the front door stopped: ${front.output}`);
  assert.equal(await (await ask(`${front.base}/`)).text(), "<html>the website</html>", "the website still answers");
});

test("the website stopping does not stop the front door or the game connections it carries: the website is started again", async () => {
  // A website that stops when asked to, in the real one's place.
  const tree = makeTree(`import http from "node:http";
http.createServer((request, response) => { if (request.url === "/stop-now") process.exit(3); response.end("the website"); }).listen(Number(process.env.PORT), process.env.HOST);
`);
  const game = await standIn("the game");
  const front = await startFront(tree, { GAME_PORT: String(game.port) });
  for (let i = 0; i < 100 && !(await ask(`${front.base}/`).then((answer) => answer.ok, () => false)); i++) await wait(100);
  const player = await connectGame(front.port, "/");
  let dropped = false;
  player.on("close", () => { dropped = true; });
  assert.equal(game.sockets.size, 1);

  await ask(`${front.base}/stop-now`).catch(() => {});
  await wait(500);
  assert.equal(front.exit, null, "the front door is still running");
  assert.equal(dropped, false, "and so is the game connection through it");
  assert.equal(await (await ask(`${front.base}/api/world-status`)).text(), "the game", "the game's addresses still answer");
  // Started again by itself, within a few seconds.
  let back = false;
  for (let i = 0; i < 150 && !back; i++) { back = await ask(`${front.base}/`).then((answer) => answer.ok, () => false); if (!back) await wait(100); }
  assert.equal(back, true, "the website answers again");
  assert.equal(dropped, false);
  player.destroy();
});

test("a world listed at a port that does not exist is not a world: asking for it does not stop the front door", async () => {
  const { cleanWorld } = await load("worlds.mjs");
  const entry = (address) => cleanWorld({ name: "W", address });
  assert.equal(entry("play.example.com:65535").address, "play.example.com:65535");
  assert.equal(entry("play.example.com").address, "play.example.com");
  for (const address of ["play.example.com:65536", "play.example.com:70000", "203.0.113.10:99999", "play.example.com:0"]) assert.equal(entry(address), null, address);

  const tree = makeTree();
  const world = await standIn("a world");
  const site = await standIn("the website");
  // As the admin page's file had it after a slip of the hand (deploy/master/registry.mjs keeps what it is given).
  fs.writeFileSync(path.join(tree, "server", "data", "saves", "master", "master-worlds.json"), JSON.stringify({ default: "bad", worlds: [
    { id: "bad", name: "Bad", world: "Bad", address: "127.0.0.1:70000", secure: false, listed: true },
    { id: "good", name: "Good", world: "Good", address: `127.0.0.1:${world.port}`, secure: false, listed: true },
  ] }));
  const front = await startFront(tree, { MASTER_ADMIN: "1", MASTER_ONLY: "1", FRONT_STATIC_PORT: String(site.port), FRONT_MASTER_PORT: String(await freePort()) });
  assert.equal((await ask(`${front.base}/w/bad/api/world-status`)).status, 404);
  assert.equal(await raw(front.port, "GET /w/bad HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"), "", "no game connection to it either");
  // The default world it was is passed over for the first that is one.
  assert.equal(await (await ask(`${front.base}/api/world-status`)).text(), "a world");
  assert.equal(await (await ask(`${front.base}/w/good/api/world-status`)).text(), "a world");
  assert.deepEqual((await (await ask(`${front.base}/world-list.json`)).json()).worlds.map((listed) => listed.id), ["good"]);
  await wait(200);
  assert.equal(front.exit, null, `the front door stopped: ${front.output}`);
});

test("a game connection carried to a world: the world hears who the visitor is from the master alone, and each side is closed with the other", async () => {
  const { verifyVisitor, VISITOR_HEADER } = await load("worlds.mjs");
  const tree = makeTree();
  const world = await standIn("a world");
  const site = await standIn("the website");
  fs.writeFileSync(path.join(tree, "server", "data", "saves", "master", "proxy-key"), `${KEY}\n`);
  fs.writeFileSync(path.join(tree, "server", "data", "saves", "master", "master-worlds.json"), JSON.stringify({ worlds: [
    { id: "good", name: "Good", world: "Good", address: `127.0.0.1:${world.port}`, secure: false, listed: true },
  ] }));
  const lan = Object.values(os.networkInterfaces()).flat().find((address) => address.family === "IPv4" && !address.internal)?.address;
  const front = await startFront(tree, { MASTER_ADMIN: "1", MASTER_ONLY: "1", HOST: "0.0.0.0", FRONT_STATIC_PORT: String(site.port), FRONT_MASTER_PORT: String(await freePort()) });

  // Everything a visitor might send to pass for someone else, or that is the master's own.
  const forged = `X-Real-IP: 198.51.100.1\r\nX-Forwarded-For: 198.51.100.2\r\nCF-Connecting-IP: 198.51.100.3\r\n${VISITOR_HEADER}: 198.51.100.4|9999999999|abc\r\nCookie: tsps_admin=1.x\r\n`;
  if (lan) {
    // Not Cloudflare and not this machine: the caller's own address is what the world is told.
    const player = await connectGame(front.port, "/w/good", forged, lan);
    const told = world.heard.at(-1).headers;
    assert.equal(verifyVisitor(told[VISITOR_HEADER], KEY), lan);
    for (const name of ["x-real-ip", "x-forwarded-for", "cf-connecting-ip", "cookie"]) assert.equal(told[name], undefined, name);
    assert.equal(told.host, `127.0.0.1:${world.port}`);
    player.destroy();
  }
  // From this machine itself (where Cloudflare's tunnel runs), what Cloudflare reports is believed.
  const player = await connectGame(front.port, "/w/good/", forged);
  const told = world.heard.at(-1).headers;
  assert.equal(verifyVisitor(told[VISITOR_HEADER], KEY), "198.51.100.3");
  assert.equal(told["x-real-ip"], undefined);
  assert.equal(told.cookie, undefined, "the admin page's sign-in never leaves the master");
  await wait(100);
  assert.equal(world.sockets.size, 1);

  // The visitor goes: the world's side is closed.
  player.destroy();
  for (let i = 0; i < 50 && world.sockets.size > 0; i++) await wait(50);
  assert.equal(world.sockets.size, 0, "the world's side is closed when the visitor goes");
  // The world goes: the visitor's side is closed.
  const second = await connectGame(front.port, "/w/good");
  let closed = false;
  second.on("close", () => { closed = true; });
  for (const socket of world.sockets) socket.destroy();
  for (let i = 0; i < 50 && !closed; i++) await wait(50);
  assert.equal(closed, true, "the visitor's side is closed when the world goes");
  // The carried /api too: the world is told the visitor, never the visitor's own word.
  const answer = await fetch(`${front.base}/w/good/api/world-status`, { headers: { "X-Real-IP": "198.51.100.1", [VISITOR_HEADER]: "198.51.100.4|9999999999|abc", Cookie: "tsps_admin=1.x" } });
  assert.equal(await answer.text(), "a world");
  const carried = world.heard.at(-1).headers;
  assert.equal(verifyVisitor(carried[VISITOR_HEADER], KEY), "127.0.0.1");
  assert.equal(carried["x-real-ip"], undefined);
  assert.equal(carried.cookie, undefined);
  // And anything of a world's but its game and its /api is not carried at all.
  assert.equal((await ask(`${front.base}/w/good/admin/api/state`)).status, 404);
});
