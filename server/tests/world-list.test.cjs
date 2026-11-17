// Ours. Run after `yarn build`: node --test tests/world-list.test.cjs
// The list of worlds (deploy/worlds.mjs) behind the landing page and the game's world picker, and
// the status address every world answers on (plugins/world/WorldStatus.plugin.js).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");

const worlds = import(pathToFileURL(path.join(__dirname, "../../deploy/worlds.mjs")).href);

test("our own list: the worlds on the panel's nodes; the master itself hosts none (MASTER_ONLY)", async () => {
  const { loadWorlds, listFor, serverList, worldUrls } = await worlds;
  const list = loadWorlds(path.join(__dirname, "../../deploy/worlds.json"));
  assert.ok(list.length >= 1);
  assert.ok(list.every((world) => world.here === false), "the file marks nobody: a world knows itself by name");
  assert.ok(!list.some((world) => world.address === "rs.kat-net.us"), "the master's own address is not a world");
  assert.match(fs.readFileSync(path.join(__dirname, "../../deploy/settings.env"), "utf8"), /^MASTER_ONLY=1$/m);
  // A world on the list finds itself by its own name and shows the others; the master's own
  // world.json name is on no list, and neither is somebody else's world.
  const newYork = listFor(list, "Kat-Net NYC location");
  assert.deepEqual(newYork.filter((world) => world.here).map((world) => world.id), ["new-york"]);
  const ownName = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/definitions/world.json"), "utf8")).name;
  assert.deepEqual(listFor(list, ownName), []);
  assert.deepEqual(listFor(list, "My World"), []);
  assert.deepEqual(listFor(list, ""), []);
  assert.deepEqual(listFor(list, null), []);
  // On the master's page New York is played through the master.
  const york = list.find((world) => world.id === "new-york");
  assert.equal(worldUrls(york, "").play, "/play?world=new-york");
  assert.deepEqual(serverList([york], { host: "rs.kat-net.us", secure: true })[0], { name: "Kat-Net New York", address: "rs.kat-net.us/w/new-york", secure: true, maxPlayers: 2047 });
});

test("a list is only what it safely says: bad entries are dropped, the rest cleaned", async (t) => {
  const { loadWorlds, cleanWorld, worldUrls } = await worlds;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "world-list-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "worlds.json");
  fs.writeFileSync(file, JSON.stringify([
    { id: "One", name: " World One ", address: "ONE.example.com", description: "first" },
    { name: "Two", address: "two.example.com:3000", secure: false },
    { name: "No address" },
    { name: "A path", address: "evil.example.com/steal" },
    { name: "A login", address: "user@evil.example.com" },
    { name: "", address: "nameless.example.com" },
    { id: "one", name: "Same id again", address: "other.example.com" },
    "not an object",
  ]));
  const list = loadWorlds(file);
  assert.deepEqual(list, [
    { id: "one", name: "World One", world: "World One", address: "one.example.com", secure: true, here: false, description: "first" },
    { id: "two-example-com-3000", name: "Two", world: "Two", address: "two.example.com:3000", secure: false, here: false, description: "" },
  ]);
  assert.deepEqual(worldUrls(list[1]), { home: "http://two.example.com:3000/", play: "http://two.example.com:3000/play", hiscores: "http://two.example.com:3000/hiscores" });
  assert.equal(cleanWorld({ name: "x".repeat(100), address: "a.example.com" }).name.length, 40);
  // No file, a missing file, a file that is not a list: no worlds, never an error.
  assert.deepEqual(loadWorlds(""), []);
  assert.deepEqual(loadWorlds(path.join(dir, "missing.json")), []);
  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(loadWorlds(file), []);
});

test("the board: each world's answer, kept twenty seconds, and a world that does not answer is offline", async () => {
  const { createStatusBoard, STATUS_TTL_MS } = await worlds;
  let clock = 1_000_000;
  const asked = [];
  const answers = {
    main: () => ({ name: "Kat-Net", description: "from the world", experienceRate: 10, players: 3, bots: 1475 }),
    second: () => { throw new Error("not answering"); },
    odd: () => ({ players: -5, bots: "many", experienceRate: -1, name: 7 }),
  };
  const board = createStatusBoard(async (world) => { asked.push(world.id); return answers[world.id](); }, () => clock);
  const list = [
    { id: "main", name: "Kat-Net", address: "rs.kat-net.us", secure: true, here: true, description: "" },
    { id: "second", name: "Second", address: "two.example.com", secure: true, here: false, description: "ours" },
    { id: "odd", name: "", address: "odd.example.com", secure: false, here: false, description: "" },
  ];
  const first = await board(list);
  assert.deepEqual(first.worlds, [
    { id: "main", name: "Kat-Net", description: "from the world", here: true, home: "/", play: "/play", hiscores: "/hiscores",
      online: true, players: 3, bots: 1475, experienceRate: 10 },
    { id: "second", name: "Second", description: "ours", here: false, home: "https://two.example.com/", play: "https://two.example.com/play",
      hiscores: "https://two.example.com/hiscores", online: false, players: null, bots: null },
    // An answer that is not what we expect: the world is up, and nothing it said is repeated.
    { id: "odd", name: "World", description: "", here: false, home: "http://odd.example.com/", play: "http://odd.example.com/play",
      hiscores: "http://odd.example.com/hiscores", online: true, players: null, bots: null },
  ]);
  assert.deepEqual(asked, ["main", "second", "odd"]);

  // Within twenty seconds nobody is asked again, however many visitors load the page.
  clock += STATUS_TTL_MS - 1;
  await Promise.all([board(list), board(list), board(list)]);
  assert.equal(asked.length, 3);
  // After it, once each, even when several visitors arrive together.
  clock += 2;
  answers.second = () => ({ players: 1, bots: 0 });
  const [later] = await Promise.all([board(list), board(list)]);
  assert.equal(asked.length, 6);
  assert.equal(later.worlds[1].online, true);
  assert.equal(later.worlds[1].players, 1);
});

test("/api/world-status counts people and bots apart", () => {
  const plugin = require("../plugins/world/WorldStatus.plugin");
  const person = (connected) => ({ isPlayerBot: () => false, connected });
  const bot = { isPlayerBot: () => true };
  plugin._test.setCore({
    WorldDefinition: { getWorldDefinition: () => ({ name: "Kat-Net", description: "10x custom", experienceMultiplier: 10 }) },
    World: {
      getPlayers: () => [person(true), null, bot, bot, person(false), person(true), bot],
      isPlayerSessionConnected: (player) => player.connected,
    },
  });
  assert.deepEqual(plugin._test.status(new URLSearchParams(), []), { name: "Kat-Net", description: "10x custom", experienceRate: 10, players: 2, bots: 3 });
  assert.equal(plugin._test.status(new URLSearchParams(), ["more"]), undefined, "only the address itself");
  let registered = null;
  plugin.register({ core: {}, registerContentEndpoint: (name) => { registered = name; } });
  assert.equal(registered, "world-status");
});

// Worlds played through the master (a world with no https of its own): the master lists it at its
// own address, carries it at /w/<id>, and signs each visitor's address for it.
test("through the master: which worlds, their addresses on the master's page, and their links", async () => {
  const { serverList, worldUrls, throughMaster, masterRoute, createStatusBoard } = await worlds;
  const here = { id: "kat-net", name: "Dallas", world: "Kat-Net", address: "rs.kat-net.us", secure: true, here: true, description: "" };
  const bare = { id: "new-york", name: "New York", world: "NY", address: "104.194.10.100:5000", secure: false, here: false, description: "" };
  const own = { id: "classic", name: "Classic", world: "Classic", address: "classic.kat-net.us", secure: true, here: false, description: "" };
  assert.deepEqual([here, bare, own].map(throughMaster), [false, true, false], "only a world without https of its own");

  // The world picker on the master's https page: the bare world at the master's own address.
  assert.deepEqual(serverList([here, bare, own], { host: "rs.kat-net.us", secure: true }), [
    { name: "Dallas", address: "rs.kat-net.us", secure: true, maxPlayers: 2047 },
    { name: "New York", address: "rs.kat-net.us/w/new-york", secure: true, maxPlayers: 2047 },
    { name: "Classic", address: "classic.kat-net.us", secure: true, maxPlayers: 2047 },
  ]);
  // On a world that is not the master, as before: where it really is.
  assert.equal(serverList([bare])[0].address, "104.194.10.100:5000");

  // Links: on the master, on a world that knows the master, on one that does not.
  assert.deepEqual(worldUrls(bare, ""), { home: "/play?world=new-york", play: "/play?world=new-york", hiscores: "/hiscores?world=new-york" });
  assert.equal(worldUrls(bare, "https://rs.kat-net.us").play, "https://rs.kat-net.us/play?world=new-york");
  assert.equal(worldUrls(bare).play, "http://104.194.10.100:5000/play");
  assert.equal(worldUrls(own, "").play, "https://classic.kat-net.us/play", "a world with https of its own is reached directly");
  const board = createStatusBoard(async () => ({ players: 1, bots: 0 }), () => 0, "");
  assert.equal((await board([here, bare])).worlds[1].play, "/play?world=new-york");

  assert.deepEqual(masterRoute("/w/new-york"), ["new-york", "/"]);
  assert.deepEqual(masterRoute("/w/new-york/api/world-info?x=1"), ["new-york", "/api/world-info?x=1"]);
  assert.deepEqual(masterRoute("/w/new-york?x=1"), ["new-york", "?x=1"]);
  for (const url of ["/w/", "/w", "/world-list.json", "/w/Bad_Id/api", "/play", "/w/a/../admin".replace("a/..", "..")]) assert.equal(masterRoute(url), null, url);
});

test("the visitor's address is believed only as the master signed it, and only for two minutes", async () => {
  const { signVisitor, verifyVisitor } = await worlds;
  const key = "k".repeat(64);
  const at = Date.UTC(2026, 10, 17);
  const header = signVisitor("203.0.113.7", key, at);
  assert.equal(verifyVisitor(header, key, at), "203.0.113.7");
  assert.equal(verifyVisitor(signVisitor("2001:db8::7", key, at), key, at + 60_000), "2001:db8::7");
  assert.equal(verifyVisitor(header, key, at + 121_000), null, "stale");
  assert.equal(verifyVisitor(header, "another-key", at), null);
  assert.equal(verifyVisitor(header.replace("203.0.113.7", "198.51.100.1"), key, at), null, "a changed address");
  assert.equal(verifyVisitor(header, "", at), null, "a world given no key believes nothing");
  for (const bad of [undefined, "", "203.0.113.7", "a|b|c", "203.0.113.7|notatime|x"]) assert.equal(verifyVisitor(bad, key, at), null);
});
