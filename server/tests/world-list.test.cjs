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

test("our own list: each world finds itself on it by its own name, and shows the others", async () => {
  const { loadWorlds, listFor, serverList, worldUrls } = await worlds;
  const list = loadWorlds(path.join(__dirname, "../../deploy/worlds.json"));
  assert.deepEqual(list.map((world) => world.id), ["kat-net", "new-york"]);
  assert.ok(list.every((world) => world.here === false), "the file marks nobody: a world knows itself by name");
  // The world this project's own world.json names is on the list.
  const ownName = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/definitions/world.json"), "utf8")).name;
  const dallas = listFor(list, ownName);
  assert.deepEqual(dallas.map((world) => [world.id, world.here]), [["kat-net", true], ["new-york", false]]);
  assert.deepEqual(worldUrls(dallas[0]), { home: "/", play: "/play", hiscores: "/hiscores" }, "its own links stay on its site");
  assert.equal(worldUrls(dallas[1]).play, "http://104.194.10.100:5000/play");
  // The same file on the New York server: the other way round.
  const newYork = listFor(list, "Kat-Net NYC location");
  assert.deepEqual(newYork.map((world) => [world.id, world.here]), [["kat-net", false], ["new-york", true]]);
  assert.equal(worldUrls(newYork[0]).play, "https://rs.kat-net.us/play");
  // Somebody else's world, or a world that has not said its name yet: nothing of ours.
  assert.deepEqual(listFor(list, "My World"), []);
  assert.deepEqual(listFor(list, ""), []);
  assert.deepEqual(listFor(list, null), []);
  // What the game's world picker reads (client/game/login/renderer/serverList.ts).
  assert.deepEqual(serverList(list)[0], { name: "Kat-Net Dallas", address: "rs.kat-net.us", secure: true, maxPlayers: 2047 });
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
