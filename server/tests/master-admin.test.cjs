// Ours. node --test tests/master-admin.test.cjs
// The master's admin page (deploy/master/): signing in, and making, listing, running and deleting
// worlds through a Pterodactyl panel. The panel here is a stand-in that answers as the real one does.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");

const load = (file) => import(pathToFileURL(path.join(__dirname, "../../deploy", file)).href);
const PASSWORD = "a-long-admin-password";

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** A panel with one egg and two nodes; it records what it is asked to do. */
async function fakePanel(t) {
  const calls = [];
  const servers = new Map();
  // limits.on: a key that may read Nodes and nothing else, and a client key the panel does not know.
  const limits = { on: false };
  const allocations = {
    1: [{ id: 11, ip: "0.0.0.0", alias: null, port: 5000, assigned: true }, { id: 12, ip: "0.0.0.0", alias: null, port: 5001, assigned: false }, { id: 13, ip: "0.0.0.0", alias: null, port: 5002, assigned: false }],
    2: [{ id: 21, ip: "104.194.10.100", alias: "ny.example.com", port: 5000, assigned: false }],
  };
  const nodes = [
    { id: 1, name: "Dallas 8", fqdn: "dal8.example.com", maintenance_mode: false, location_id: 1, relationships: { location: { attributes: { id: 1, short: "dal", long: "Dallas, US" } } } },
    { id: 2, name: "New York 1", fqdn: "ny1.example.com", maintenance_mode: false, location_id: 2, relationships: { location: { attributes: { id: 2, short: "nyc", long: "New York, US" } } } },
  ];
  const egg = { id: 15, name: "Kat-Net TSPS", docker_images: { "Node.js 22": "ghcr.io/parkervcp/yolks:nodejs_22" }, startup: "node deploy/pterodactyl/launch.mjs",
    relationships: { variables: { data: [
      { attributes: { env_variable: "WORLD_NAME", default_value: "My World" } }, { attributes: { env_variable: "XP_RATE", default_value: "10" } },
      { attributes: { env_variable: "AUTO_UPDATE", default_value: "1" } }, { attributes: { env_variable: "GIT_BRANCH", default_value: "main" } },
    ] } } };
  const list = (items) => ({ data: items.map((attributes) => ({ attributes })), meta: { pagination: { total_pages: 1 } } });
  const { server, url } = await listen(async (request, response) => {
    const { pathname, searchParams } = new URL(request.url, "http://panel");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const scope = pathname.startsWith("/api/application") ? "application" : "client";
    const route = pathname.replace(/^\/api\/(application|client)/, "");
    calls.push({ method: request.method, scope, route, body, key: request.headers.authorization });
    const answer = (status, payload) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(payload === undefined ? "" : JSON.stringify(payload)); };
    const wanted = scope === "application" ? "Bearer app-key" : "Bearer client-key";
    if (request.headers.authorization !== wanted) return answer(403, { errors: [{ detail: "This action is unauthorized." }] });
    let match;
    if (limits.on) {
      if (scope === "client") return answer(401, { errors: [{ detail: "Unauthenticated." }] });
      const bare = nodes.map(({ relationships, ...node }) => node);
      if (route === "/nodes") return answer(200, list(bare));
      if ((match = /^\/nodes\/(\d+)$/.exec(route))) return answer(200, { attributes: bare.find((node) => node.id === Number(match[1])) });
      return answer(403, { errors: [{ detail: "This action is unauthorized." }] });
    }
    if (scope === "application") {
      if (route === "/nests") return answer(200, list([{ id: 3, name: "Games" }, { id: 5, name: "Ours" }]));
      if ((match = /^\/nests\/(\d+)\/eggs$/.exec(route))) return answer(200, list(match[1] === "5" ? [{ id: 15, name: "Kat-Net TSPS" }] : [{ id: 7, name: "Paper" }]));
      if (route === "/nests/5/eggs/15") return answer(200, { attributes: egg });
      if (route === "/nodes") return answer(200, list(nodes));
      if ((match = /^\/nodes\/(\d+)$/.exec(route))) return answer(200, { attributes: nodes.find((node) => node.id === Number(match[1])) });
      if ((match = /^\/nodes\/(\d+)\/allocations$/.exec(route))) return answer(200, list(allocations[match[1]]));
      if (route === "/servers" && request.method === "GET") return answer(200, list([...servers.values()]));
      if (route === "/locations") return answer(200, list([{ id: 1, short: "dal" }, { id: 2, short: "nyc" }]));
      if (route === "/users") return answer(200, list([{ id: 42, email: searchParams.get("filter[email]") }]));
      if (route === "/servers" && request.method === "POST") {
        const allocation = Object.values(allocations).flat().find((candidate) => candidate.id === body.allocation.default);
        if (!allocation || allocation.assigned) return answer(422, { errors: [{ detail: "The selected allocation is invalid." }] });
        allocation.assigned = true;
        const id = 100 + servers.size;
        const made = { id, identifier: `abc${id}`, uuid: `abc${id}-0000`, state: "installing", ...body };
        servers.set(id, made);
        return answer(201, { attributes: made });
      }
      if ((match = /^\/servers\/(\d+)$/.exec(route)) && request.method === "DELETE") {
        const gone = servers.get(Number(match[1]));
        if (!gone) return answer(404, { errors: [{ detail: "not found" }] });
        Object.values(allocations).flat().find((candidate) => candidate.id === gone.allocation.default).assigned = false;
        servers.delete(gone.id);
        return answer(204);
      }
    } else {
      if (route === "/account") return answer(200, { attributes: { email: "admin@example.com", admin: true } });
      const made = [...servers.values()].find((candidate) => route.startsWith(`/servers/${candidate.identifier}`));
      if (!made) return answer(404, { errors: [{ detail: "not found" }] });
      if (route.endsWith("/power")) { made.state = body.signal === "stop" ? "offline" : "running"; return answer(204); }
      if (route.endsWith("/resources")) {
        if (made.state === "installing") return answer(409, { errors: [{ detail: "The server is installing." }] });
        return answer(200, { attributes: { current_state: made.state, resources: { memory_bytes: 2048 * 1048576, cpu_absolute: 37.4 } } });
      }
    }
    return answer(404, { errors: [{ detail: `no such route ${route}` }] });
  });
  t.after(() => server.close());
  return { url, calls, servers, allocations, limits };
}

async function master(t, { password = PASSWORD, panelEnv, masterOnly = false } = {}) {
  const [{ createAdmin }, { createPanel, panelSettings }, { createRegistry }, { loadWorlds }] = await Promise.all([
    load("master/admin.mjs"), load("master/panel.mjs"), load("master/registry.mjs"), load("worlds.mjs")]);
  const panelStub = await fakePanel(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "master-admin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = panelSettings(panelEnv ?? { PTERO_URL: panelStub.url, PTERO_APP_KEY: "app-key", PTERO_CLIENT_KEY: "client-key" });
  const registry = createRegistry(path.join(dir, "saves", "master-worlds.json"));
  // The project's own list, as it was with a world on the master itself.
  const projectList = path.join(dir, "worlds.json");
  fs.writeFileSync(projectList, JSON.stringify([
    { id: "kat-net", name: "Kat-Net Dallas", world: "Kat-Net", address: "rs.kat-net.us", secure: true, description: "10x custom, US/Dallas dedicated" },
    { id: "new-york", name: "Kat-Net New York", world: "Kat-Net NYC location", address: "104.194.10.100:5000", secure: false, description: "10x custom, US/New York" },
  ]));
  const https = new Set();
  const online = new Map([["kat-net", { online: true, players: 3, bots: 1500, experienceRate: 10 }]]);
  let clock = Date.UTC(2026, 10, 16, 12);
  const handle = createAdmin({
    password, secret: "test-secret", registry, settings, panel: createPanel(settings),
    projectWorlds: () => loadWorlds(projectList), masterOnly,
    publicUrl: "https://rs.kat-net.us", proxyKey: "test-proxy-key", answersHttps: async (address) => https.has(address),
    statusOf: async (worlds) => ({ worlds: worlds.map((world) => ({ id: world.id, ...(online.get(world.id) ?? { online: false, players: null, bots: null }) })) }),
    page: path.join(__dirname, "../../deploy/master/admin.html"),
    now: () => clock,
  });
  const { server, url } = await listen((request, response) => { handle(request, response); });
  t.after(() => server.close());
  let cookie = "";
  const call = async (method, route, body, headers = {}) => {
    const response = await fetch(`${url}/admin/api/${route}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(method === "GET" ? {} : { "x-tsps-admin": "1", "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...headers },
    });
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: response.status, body: await response.json(), set };
  };
  return { url, call, registry, panel: panelStub, online, https, tick: (ms) => { clock += ms; }, signIn: () => call("POST", "login", { password }), forget: () => { cookie = ""; } };
}

test("nothing is answered before signing in, and a wrong password is refused", async (t) => {
  const m = await master(t);
  assert.equal((await m.call("GET", "state")).status, 401);
  assert.equal((await m.call("POST", "worlds", { name: "X", nodeId: 1 })).status, 401);
  const wrong = await m.call("POST", "login", { password: "not-the-password" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.set, null);
  const right = await m.signIn();
  assert.equal(right.status, 200);
  assert.match(right.set, /^tsps_admin=\d+\.[\w-]+; HttpOnly; SameSite=Strict; Path=\/admin; Max-Age=604800$/);
  assert.equal((await m.call("GET", "state")).status, 200);
  // A sign-in lasts a week.
  m.tick(7 * 86_400_000 + 1);
  assert.equal((await m.call("GET", "state")).status, 401);
});

test("ten wrong tries lock sign-in for a quarter of an hour", async (t) => {
  const m = await master(t);
  for (let n = 0; n < 10; n++) assert.equal((await m.call("POST", "login", { password: "wrong" })).status, 401);
  assert.equal((await m.call("POST", "login", { password: PASSWORD })).status, 429, "even the right one waits");
  m.tick(15 * 60_000 + 1);
  assert.equal((await m.signIn()).status, 200);
});

test("a change must come from the admin page itself", async (t) => {
  const m = await master(t);
  await m.signIn();
  assert.equal((await m.call("POST", "worlds/external", { name: "X", address: "x.example.com" }, { "x-tsps-admin": "" })).status, 403);
  assert.equal((await m.call("POST", "worlds/external", { name: "X", address: "x.example.com" }, { origin: "https://evil.example.com" })).status, 403);
  assert.equal(m.registry.all().length, 0);
});

test("without a password of twelve characters the page is off", async (t) => {
  const m = await master(t, { password: "short" });
  const answer = await m.call("POST", "login", { password: "short" });
  assert.equal(answer.status, 503);
  assert.match(answer.body.error, /MASTER_ADMIN_PASSWORD/);
  const page = await fetch(`${m.url}/admin`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("the state: the project's worlds, the panel's egg and nodes with their free ports", async (t) => {
  const m = await master(t);
  await m.signIn();
  const { body } = await m.call("GET", "state");
  assert.deepEqual(body.panel.egg, { id: 15, name: "Kat-Net TSPS" });
  assert.deepEqual([body.panel.ready, body.panel.problems], [true, []]);
  assert.deepEqual(body.panel.nodes.map((node) => [node.id, node.name, node.location, node.free]), [[1, "Dallas 8", "dal", 2], [2, "New York 1", "nyc", 1]]);
  assert.deepEqual(body.worlds.map((world) => [world.id, world.source, world.online, world.players]), [["kat-net", "project", true, 3], ["new-york", "project", false, null]]);
  // The location picker: each of the panel's locations with its free ports.
  assert.deepEqual(body.panel.places.map((place) => [place.key, place.name, place.free, place.nodes.map((node) => node.name)]),
    [["location-1", "Dallas, US", 2, ["Dallas 8"]], ["location-2", "New York, US", 1, ["New York 1"]]]);
  assert.equal(body.site, "https://rs.kat-net.us");
  // The proxy key is given only when asked for, signed in.
  assert.ok(!JSON.stringify(body).includes("test-proxy-key"));
  assert.deepEqual((await m.call("GET", "proxy-key")).body, { key: "test-proxy-key" });
  // The keys never reach the page.
  assert.ok(!JSON.stringify(body).includes("app-key") && !JSON.stringify(body).includes("client-key"));
});

test("making a world: a server on the panel from our egg, told its name and its master, then on the list", async (t) => {
  const m = await master(t);
  await m.signIn();
  const made = await m.call("POST", "worlds", { name: "Kat-Net Chicago", description: "5x, US/Chicago", nodeId: "1", xpRate: "5", bots: "250", developers: "kat", memoryMb: "8192", diskMb: "20480", cpu: "0" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.id, "kat-net-chicago");
  assert.equal(made.body.address, "dal8.example.com:5001", "the node's own name, which is what its certificate is for");
  assert.deepEqual([made.body.headless, made.body.location, made.body.secure], [true, "Dallas 8", false]);
  const create = m.panel.calls.find((call) => call.method === "POST" && call.route === "/servers");
  assert.deepEqual(create.body, {
    name: "Kat-Net Chicago", description: "5x, US/Chicago", external_id: "tsps-world-kat-net-chicago", user: 42, egg: 15,
    docker_image: "ghcr.io/parkervcp/yolks:nodejs_22", startup: "node deploy/pterodactyl/launch.mjs",
    environment: { WORLD_NAME: "Kat-Net Chicago", XP_RATE: "5", AUTO_UPDATE: "1", GIT_BRANCH: "main", WORLD_DESCRIPTION: "5x, US/Chicago", BOT_COUNT: "250",
      DEV_USERNAME: "kat", WORLDS_MASTER_URL: "https://rs.kat-net.us", HEADLESS: "1", MASTER_PROXY_KEY: "test-proxy-key",
      TLS_CERT: "/etc/letsencrypt/live/dal8.example.com/fullchain.pem", TLS_KEY: "/etc/letsencrypt/live/dal8.example.com/privkey.pem" },
    limits: { memory: 8192, swap: 0, disk: 20480, io: 500, cpu: 0 },
    feature_limits: { databases: 0, allocations: 0, backups: 0 },
    allocation: { default: 12 },
    start_on_completion: true,
  });
  assert.equal(create.key, "Bearer app-key");
  assert.deepEqual(m.registry.get("kat-net-chicago").panel, { serverId: 100, identifier: "abc100", nodeId: 1, allocationId: 12 });

  const { body } = await m.call("GET", "state");
  const world = body.worlds.find((entry) => entry.id === "kat-net-chicago");
  assert.equal(world.source, "panel");
  assert.equal(world.server.state, "installing");
  assert.match(world.server.url, /\/server\/abc100$/);
  assert.equal(body.panel.nodes[0].free, 1, "its port is taken");

  // The same name again, in any case, is refused before the panel is asked.
  const before = m.panel.calls.length;
  assert.equal((await m.call("POST", "worlds", { name: "kat-net chicago", nodeId: 1 })).status, 409);
  assert.equal((await m.call("POST", "worlds", { name: "Kat-Net", nodeId: 1 })).status, 409, "nor a project world's own name");
  assert.equal(m.panel.calls.length, before);
  // By location: the world goes on that location's node.
  const second = await m.call("POST", "worlds", { name: "Second", place: "location-2" });
  assert.equal(second.body.address, "ny1.example.com:5000");
  assert.equal(second.body.location, "New York 1");
  // A node with no port left says so.
  const none = await m.call("POST", "worlds", { name: "Third", place: "location-2" });
  assert.equal(none.status, 502);
  assert.match(none.body.error, /New York, US has no free port/);
  assert.equal((await m.call("POST", "worlds", { name: "Third", place: "location-9" })).status, 502, "a location the panel does not have");
  assert.equal(m.registry.get("third"), null, "nothing is listed for a world that was not made");
});

test("the form is checked before the panel is asked", async (t) => {
  const m = await master(t);
  await m.signIn();
  for (const [body, message] of [
    [{ nodeId: 1 }, /Give the world a name/],
    [{ name: "X", nodeId: 1, memoryMb: 1024 }, /Memory \(MB\) must be a whole number from 4096/],
    [{ name: "X", nodeId: 1, bots: 5000 }, /Bots must be/],
    [{ name: "X" }, /Pick a location/],
    [{ name: "X", place: "somewhere" }, /Pick a location/],
  ]) {
    const answer = await m.call("POST", "worlds", body);
    assert.equal(answer.status, 400);
    assert.match(answer.body.error, message);
  }
  assert.ok(!m.panel.calls.some((call) => call.route === "/servers"));
});

test("start and stop go to the panel's client API; delete needs the world's name and removes the server", async (t) => {
  const m = await master(t);
  await m.signIn();
  await m.call("POST", "worlds", { name: "Chicago", nodeId: 1 });
  assert.equal((await m.call("POST", "worlds/chicago/power", { signal: "start" })).status, 200);
  const power = m.panel.calls.findLast((call) => call.route.endsWith("/power"));
  assert.deepEqual([power.scope, power.route, power.body, power.key], ["client", "/servers/abc100/power", { signal: "start" }, "Bearer client-key"]);
  const running = (await m.call("GET", "state")).body.worlds.find((world) => world.id === "chicago").server;
  assert.deepEqual([running.state, running.memoryMb, running.cpu], ["running", 2048, 37]);
  assert.equal((await m.call("POST", "worlds/chicago/power", { signal: "explode" })).status, 400);
  // A project world is not ours to run or delete here.
  assert.equal((await m.call("POST", "worlds/kat-net/power", { signal: "stop" })).status, 403);
  assert.equal((await m.call("DELETE", "worlds/kat-net", { confirm: "Kat-Net Dallas" })).status, 403);

  assert.equal((await m.call("DELETE", "worlds/chicago", { confirm: "chicago" })).status, 400, "the name exactly");
  assert.equal(m.panel.servers.size, 1);
  const gone = await m.call("DELETE", "worlds/chicago", { confirm: "Chicago" });
  assert.deepEqual(gone.body, { ok: true, deletedServer: true });
  assert.equal(m.panel.servers.size, 0);
  assert.equal(m.registry.get("chicago"), null);
  assert.equal(m.panel.allocations[1].find((allocation) => allocation.id === 12).assigned, false);
});

test("a world that runs elsewhere is added by its address, edited, unlisted and removed without touching it", async (t) => {
  const m = await master(t);
  const { listedFrom } = await load("master/registry.mjs");
  await m.signIn();
  assert.equal((await m.call("POST", "worlds/external", { name: "Bad", address: "http://bad.example.com/play" })).status, 400);
  const added = await m.call("POST", "worlds/external", { name: "Friends", address: "203.0.113.10:5000", description: "a friend's" });
  assert.equal(added.status, 201);
  assert.deepEqual(listedFrom(m.registry.all()), [{ id: "friends", name: "Friends", world: "Friends", address: "203.0.113.10:5000", secure: false, here: false, description: "a friend's" }]);
  assert.equal((await m.call("POST", "worlds/friends/power", { signal: "stop" })).status, 400);

  // Behind https now, under a name of its own.
  const edited = await m.call("PATCH", "worlds/friends", { address: "friends.example.com", secure: true });
  assert.equal(edited.status, 200);
  assert.deepEqual([edited.body.address, edited.body.secure, edited.body.name], ["friends.example.com", true, "Friends"]);
  assert.equal((await m.call("PATCH", "worlds/friends", { address: "not an address" })).status, 400);
  assert.equal((await m.call("PATCH", "worlds/friends", { name: "Kat-Net Dallas" })).status, 409);
  await m.call("PATCH", "worlds/friends", { listed: false });
  assert.deepEqual(listedFrom(m.registry.all()), [], "kept, but off the landing page");

  const calls = m.panel.calls.length;
  assert.deepEqual((await m.call("DELETE", "worlds/friends", { confirm: "Friends" })).body, { ok: true, deletedServer: false });
  assert.equal(m.panel.calls.length, calls, "the panel is not asked to delete anything");
});

test("with no panel set up the page still lists and adds worlds, and says what is missing", async (t) => {
  const m = await master(t, { panelEnv: { PTERO_URL: "https://panel.example.com" } });
  await m.signIn();
  const { body } = await m.call("GET", "state");
  assert.deepEqual(body.panel, { configured: false, missing: ["PTERO_APP_KEY", "PTERO_CLIENT_KEY"] });
  assert.equal(body.worlds.length, 2);
  const refused = await m.call("POST", "worlds", { name: "X", nodeId: 1 });
  assert.equal(refused.status, 502);
  assert.match(refused.body.error, /not set up/);
});

test("settings: the keys, an egg by id, and a port range", async () => {
  const { panelSettings, portRanges } = await load("master/panel.mjs");
  assert.deepEqual(portRanges("5000-5099, 6000 ,bad,70000,9-3"), [[5000, 5099], [6000, 6000]]);
  const settings = panelSettings({ PTERO_URL: "https://panel.example.com/", PTERO_APP_KEY: " a ", PTERO_CLIENT_KEY: "c", PTERO_EGG_ID: "15", PTERO_NEST_ID: "5", PTERO_PORT_RANGE: "5000-5010" });
  assert.deepEqual([settings.url, settings.appKey, settings.eggId, settings.nestId, settings.configured], ["https://panel.example.com", "a", 15, 5, true]);
  assert.deepEqual(panelSettings({ PTERO_URL: "panel.example.com" }).missing, ["PTERO_URL", "PTERO_APP_KEY", "PTERO_CLIENT_KEY"], "an address needs its https://");
});

// Our server's website service is locked to a read-only filesystem until its service file names
// the page's folder. The page must say so, and must not make a server it could not then list.
test("where the worlds cannot be saved, nothing is made on the panel and the page says why", async (t) => {
  const [{ createAdmin }, { createPanel, panelSettings }, { createRegistry }] = await Promise.all([load("master/admin.mjs"), load("master/panel.mjs"), load("master/registry.mjs")]);
  const panelStub = await fakePanel(t);
  const settings = panelSettings({ PTERO_URL: panelStub.url, PTERO_APP_KEY: "app-key", PTERO_CLIENT_KEY: "client-key" });
  const handle = createAdmin({
    password: PASSWORD, secret: "s", settings, panel: createPanel(settings), storage: "This page cannot save its worlds: not writable (EROFS).",
    registry: createRegistry(path.join(os.tmpdir(), "never-written", "master-worlds.json")), projectWorlds: () => [], publicUrl: "https://rs.kat-net.us",
    statusOf: async () => ({ worlds: [] }), page: path.join(__dirname, "../../deploy/master/admin.html"),
  });
  const { server, url } = await listen((request, response) => { handle(request, response); });
  t.after(() => server.close());
  const headers = { "x-tsps-admin": "1", "content-type": "application/json" };
  const login = await fetch(`${url}/admin/api/login`, { method: "POST", headers, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const state = await (await fetch(`${url}/admin/api/state`, { headers: { cookie } })).json();
  assert.match(state.storage, /cannot save its worlds/);
  for (const [route, body] of [["worlds", { name: "X", nodeId: 1 }], ["worlds/external", { name: "X", address: "x.example.com" }]]) {
    const answer = await fetch(`${url}/admin/api/${route}`, { method: "POST", headers: { ...headers, cookie }, body: JSON.stringify(body) });
    assert.equal(answer.status, 503);
    assert.match((await answer.json()).error, /cannot save its worlds/);
  }
  assert.ok(!panelStub.calls.some((call) => call.method === "POST" && call.route === "/servers"));
});

test("a world made here that starts answering on https at its node's name is listed there, and reached directly", async (t) => {
  const m = await master(t);
  const { listedFrom } = await load("master/registry.mjs");
  const { serverList, worldUrls } = await load("worlds.mjs");
  await m.signIn();
  await m.call("POST", "worlds", { name: "Chicago", place: "location-1" });
  let world = (await m.call("GET", "state")).body.worlds.find((entry) => entry.id === "chicago");
  assert.equal(world.secure, false, "plain http until the node shows it the certificate");
  let [entry] = listedFrom(m.registry.all());
  assert.deepEqual(serverList([entry], { host: "rs.kat-net.us", secure: true })[0], { name: "Chicago", address: "rs.kat-net.us/w/chicago", secure: true, maxPlayers: 2047 });

  m.https.add("dal8.example.com:5001");
  world = (await m.call("GET", "state")).body.worlds.find((item) => item.id === "chicago");
  assert.equal(world.secure, true);
  [entry] = listedFrom(m.registry.all());
  assert.deepEqual(serverList([entry], { host: "rs.kat-net.us", secure: true })[0], { name: "Chicago", address: "dal8.example.com:5001", secure: true, maxPlayers: 2047 }, "the world picker connects straight to it");
  // It has no website of its own, so its link stays on the master's site.
  assert.equal(worldUrls(entry, "").play, "/play?world=chicago");
});

// What the user met on 2026-11-17: an application key that may read Nodes only, and a client key
// the panel does not know. The location list was empty and the page said nothing useful.
test("a key that is short of permissions: the locations still show, by node, and the page says what is missing", async (t) => {
  const m = await master(t);
  m.panel.limits.on = true;
  await m.signIn();
  const { body } = await m.call("GET", "state");
  assert.equal(body.panel.error, undefined, "the panel answers");
  assert.equal(body.panel.ready, false);
  assert.deepEqual(body.panel.places.map((place) => [place.key, place.name, place.free]),
    [["location-1", "Dallas 8", null], ["location-2", "New York 1", null]], "each node's location, called by its node, its free ports not known");
  assert.equal(body.panel.egg, null);
  assert.deepEqual(body.panel.problems, [
    "The application key (Admin > Application API) is missing: Servers (read & write), Users (read), Allocations (read), Nests (read).",
    "Optional: with Locations (read) the picker shows your locations' names; without it, it goes by node.",
    "The panel does not accept the client key (PTERO_CLIENT_KEY). Make one under Account > API Credentials, signed in as an admin; if you give it allowed IPs, include this server's.",
  ]);
  // Making a world is refused by the panel, in words that say which permission.
  const made = await m.call("POST", "worlds", { name: "X", place: "location-1" });
  assert.equal(made.status, 502);
  assert.match(made.body.error, /the application key may not read/);
  assert.equal(m.registry.all().length, 0);
});

// The user's ask (2026-11-17): the master hosts no world of its own; the egg does the hosting on the nodes.
test("a master with no world of its own: its bare address plays the default world, which the page can change", async (t) => {
  const m = await master(t, { masterOnly: true });
  await m.signIn();
  let { body } = await m.call("GET", "state");
  assert.deepEqual([body.masterOnly, body.defaultId], [true, "kat-net"], "the first listed world until one is picked");
  await m.call("POST", "worlds", { name: "Chicago", place: "location-1" });
  assert.equal((await m.call("POST", "default", { id: "nowhere" })).status, 404);
  assert.deepEqual((await m.call("POST", "default", { id: "chicago" })).body, { ok: true, defaultId: "chicago" });
  ({ body } = await m.call("GET", "state"));
  assert.equal(body.defaultId, "chicago");
  // The choice is kept in the page's own file, beside its worlds, and outlives changes to them.
  await m.call("PATCH", "worlds/chicago", { description: "moved" });
  await m.call("POST", "worlds/external", { name: "Friends", address: "friends.example.com", secure: true });
  assert.equal(m.registry.getDefault(), "chicago");
  assert.equal(JSON.parse(fs.readFileSync(m.registry.file, "utf8")).default, "chicago");
  // A default that is unlisted or deleted falls back to the first listed world.
  await m.call("PATCH", "worlds/chicago", { listed: false });
  assert.equal((await m.call("GET", "state")).body.defaultId, "kat-net");
});

test("a master that runs a world itself has no default world to pick", async (t) => {
  const m = await master(t);
  await m.signIn();
  const { body } = await m.call("GET", "state");
  assert.deepEqual([body.masterOnly, body.defaultId], [false, ""]);
});

// The user's ask (2026-11-17): one click to restart every world after an update.
test("restart all: every world made here gets the signal; the others are left alone, and one failure does not stop the rest", async (t) => {
  const m = await master(t);
  await m.signIn();
  await m.call("POST", "worlds", { name: "Chicago", place: "location-1" });
  await m.call("POST", "worlds", { name: "Boston", place: "location-1" });
  await m.call("POST", "worlds/external", { name: "Friends", address: "friends.example.com", secure: true });
  const before = m.panel.calls.length;
  const all = await m.call("POST", "power-all", { signal: "restart" });
  assert.deepEqual(all.body, { signal: "restart", done: ["Chicago", "Boston"], failed: [] });
  assert.deepEqual(m.panel.calls.slice(before).map((call) => [call.scope, call.route, call.body.signal]),
    [["client", "/servers/abc100/power", "restart"], ["client", "/servers/abc101/power", "restart"]], "only the worlds made here: not the project's, not one added by address");
  assert.equal((await m.call("POST", "power-all", { signal: "kill" })).status, 400, "not kill: that loses what was not saved");

  // A world whose server is gone from the panel: named, and the rest still get the signal.
  m.panel.servers.delete(100);
  const partial = await m.call("POST", "power-all", { signal: "stop" });
  assert.deepEqual(partial.body.done, ["Boston"]);
  assert.deepEqual(partial.body.failed.map((world) => world.name), ["Chicago"]);
});

// The user's ask (2026-11-17): reset all accounts for a fresh start.
test("reset all accounts: only with RESET typed; it sets a new reset id and restarts every world made here", async (t) => {
  const m = await master(t);
  await m.signIn();
  await m.call("POST", "worlds", { name: "Chicago", place: "location-1" });
  assert.equal(m.registry.getAccountsReset(), "");
  for (const confirm of [undefined, "reset", "yes"]) assert.equal((await m.call("POST", "reset-accounts", { confirm })).status, 400);
  assert.equal(m.registry.getAccountsReset(), "", "nothing is called by a wrong word");
  const before = m.panel.calls.length;
  const done = await m.call("POST", "reset-accounts", { confirm: "RESET" });
  assert.equal(done.status, 200);
  assert.equal(done.body.id, "2026-11-16T12:00:00Z");
  assert.deepEqual(done.body.done, ["Chicago"]);
  assert.equal(m.registry.getAccountsReset(), "2026-11-16T12:00:00Z");
  assert.deepEqual(m.panel.calls.slice(before).map((call) => [call.route, call.body.signal]), [["/servers/abc100/power", "restart"]]);
  // The worlds and the default world are untouched by it.
  assert.equal(m.registry.get("chicago").name, "Chicago");
});

test("a list of worlds that cannot be read is never written over: the page says so and changes nothing", async (t) => {
  const m = await master(t);
  const { RegistryUnreadable } = await load("master/registry.mjs");
  await m.signIn();
  await m.call("POST", "worlds/external", { name: "Friends", address: "203.0.113.10:5000" });
  await m.call("POST", "reset-accounts", { confirm: "RESET" });
  const file = m.registry.file;
  const whole = fs.readFileSync(file, "utf8");
  assert.equal(JSON.parse(whole).accountsReset, "2026-11-16T12:00:00Z");

  // Cut short, as a slip in a hand edit or a disk fault leaves it. Read as "no worlds, no reset
  // called", the next change wrote exactly that over it: every world's record gone, and the
  // accounts' reset id with them (which is a reset of every world: deploy/reset-accounts.mjs).
  const broken = whole.slice(0, whole.length - 40);
  fs.writeFileSync(file, broken);
  assert.deepEqual(m.registry.all(), [], "nothing can be read from it");
  assert.match(m.registry.problem(), /cannot be read/);
  for (const [method, route, body] of [
    ["POST", "worlds/external", { name: "Another", address: "203.0.113.11:5000" }],
    ["POST", "default", { id: "kat-net" }],
    ["POST", "reset-accounts", { confirm: "RESET" }],
    ["POST", "worlds", { name: "Chicago", place: "location-1" }],
  ]) {
    const refused = await m.call(method, route, body);
    assert.equal(refused.status, 503, `${method} ${route}`);
    assert.match(refused.body.error, /cannot be read/);
  }
  assert.throws(() => m.registry.setDefault("x"), RegistryUnreadable);
  assert.equal(fs.readFileSync(file, "utf8"), broken, "the file is as it was found, for a person to repair");
  assert.match((await m.call("GET", "state")).body.storage, /cannot be read/, "said across the page");

  // Repaired: everything is as it was.
  fs.writeFileSync(file, whole);
  assert.equal(m.registry.problem(), null);
  assert.equal((await m.call("GET", "state")).body.storage, null);
  assert.equal(m.registry.get("friends").name, "Friends");
  assert.equal((await m.call("POST", "default", { id: "friends" })).status, 200);
  assert.equal(m.registry.getAccountsReset(), "2026-11-16T12:00:00Z");
});

test("an entry in the list that is not a record is no world, and stops nothing", async (t) => {
  const m = await master(t);
  await m.signIn();
  await m.call("POST", "worlds/external", { name: "Friends", address: "203.0.113.10:5000" });
  const kept = JSON.parse(fs.readFileSync(m.registry.file, "utf8"));
  fs.writeFileSync(m.registry.file, JSON.stringify({ ...kept, worlds: [null, "a world", 7, ...kept.worlds, []] }));
  assert.deepEqual(m.registry.all().map((world) => world.id), ["friends"]);
  assert.equal(m.registry.get("nothing"), null);
  const state = await m.call("GET", "state");
  assert.equal(state.status, 200);
  assert.deepEqual(state.body.worlds.map((world) => world.id), ["kat-net", "new-york", "friends"]);
});
