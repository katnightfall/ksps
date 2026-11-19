// Ours. Run after `yarn build`: node --test tests/blank-login-name.test.cjs
// A login name of underscores (or underscores and spaces) only, "_" or "__", passed the name
// check. Its account key is empty, so it was nobody's account and no online player's name; but
// the save database files a name with no letters under "player", the save of the account named
// Player. Whoever knew that account's password could so be in the world twice on one save, as
// "Player" and as "_", and what one of the two gave away the other still had.
// Real ClientConnection and the real SQLite save database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, before, beforeEach } = require("node:test");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "blank-name-"));
process.env.TSPS_ACCOUNTS_FILE = path.join(scratch, "accounts.json");
process.env.TSPS_DISPLAY_NAMES_FILE = path.join(scratch, "display-names.json");
process.env.PLAYER_SAVE_DATABASE_PATH = path.join(scratch, "players.sqlite");
process.env.PLAYER_SAVE_IMPORT_LEGACY_JSON = "0";
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { GameConstants } = require("../dist/game/GameConstants");
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { World } = require("../dist/game/World");
const { Sailing } = require("../dist/game/content/sailing/Sailing");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Accounts } = require("../dist/game/entity/impl/player/Accounts");
const { DisplayNames } = require("../dist/game/entity/impl/player/DisplayNames");
const { Item } = require("../dist/game/model/Item");
const net = require("../dist/net/NetworkBuilder");
const { createLoginExtension } = require("../plugins/accounts/characters/Login.Characters");

const LOGIN_RESPONSE = 3;
const CHARACTER_RESULT = 8;
let REVISION;
let persistence = null;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  REVISION = CachePipeline.getActive().revision;
  require("../plugins/persistence/SqlitePlayerPersistence.plugin").register({
    getSkillManager: () => require("../dist/game/content/skill/SkillManager").SkillManager,
    setPlayerPersistence: (backend) => { persistence = backend; },
    log() {},
  });
});

beforeEach((t) => {
  Accounts.reset();
  DisplayNames.reset();
  net.ClientConnection.pendingNames.clear();
  GameConstants.PLAYER_PERSISTENCE = persistence;
  t.mock.method(PluginManager, "createLoginExtension", (context) => createLoginExtension({ ...context, api: PluginManager.createApi("Characters") }));
});

function channel() {
  const sent = [];
  return { sent, kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send(packet) { sent.push(Buffer.from(packet)); return true; }, close() {}, onData() {}, onError() {}, onClose() {} };
}

/** The last packet with this opcode: its body (after the opcode and the two-byte size). */
const last = (socket, opcode) => socket.sent.filter((bytes) => bytes[0] === opcode).at(-1)?.subarray(2);

/** A login on a fresh connection: whether it was accepted, and the connection. */
async function login(username, password) {
  const socket = channel();
  const connection = new net.ClientConnection(socket);
  connection.inject([{ type: "login", username, password, revision: REVISION, flags: 0 }]);
  await connection.idle();
  return { socket, connection, accepted: last(socket, LOGIN_RESPONSE)?.[0] === 1 };
}

/** Enters the world without a world: the player list, regions, sailing and plugins are stubbed. */
async function enter(t, connection, name) {
  let player = null;
  t.mock.method(World.getPlayers(), "add", (added) => { added.setIndex(1); added.setRegistered(true); player = added; return true; });
  t.mock.method(World, "refreshActiveRegions", () => {});
  t.mock.method(Sailing, "onLogin", () => {});
  t.mock.method(PluginManager, "emitPlayerLogin", () => {});
  t.mock.method(PluginManager, "emitCustomEvent", () => {});
  connection.inject([{ type: "handshake", name, clientType: 0, capabilities: 0 }]);
  await connection.idle();
  return player;
}

test("a name of underscores and spaces only is refused: it is not a second way in to the account named Player", async (t) => {
  // The account named Player, with 500 coins, saved.
  const first = await login("Player", "its-password");
  assert.equal(first.accepted, true);
  const player = await enter(t, first.connection, "Player");
  player.getInventory().setItem(0, new Item(995, 500));
  persistence.save(player, "autosave");
  await persistence.flush();
  for (const name of ["_", "__", " _ ", "_ _"]) {
    const second = await login(name, "its-password");
    assert.equal(second.accepted, false, `"${name}" with Player's password is no login`);
    const twin = await enter(t, second.connection, name);
    assert.equal(twin, null, `and nobody enters the world as "${name}" beside Player`);
  }
  const fresh = await login("_", "any-password");
  assert.equal(fresh.accepted, false, "nor is it a new account");
  // A real name with an underscore in it is the name with a space, as ever.
  const spaced = await login("Mod_Kat", "pw");
  assert.equal(spaced.accepted, true);
});

test("nor can an account add a character with such a name", async (t) => {
  const owner = await login("Zezima", "pw");
  const player = await enter(t, owner.connection, "Zezima");
  persistence.save(player, "logout");
  await persistence.flush();
  net.ClientConnection.pendingNames.clear();
  const again = await login("Zezima", "pw");
  assert.equal(again.accepted, true);
  again.connection.inject([{ type: "character_create", name: "_" }]);
  await again.connection.idle();
  const result = last(again.socket, CHARACTER_RESULT);
  assert.equal(result[0], 0, "refused");
  assert.deepEqual(Accounts.charactersOf(Accounts.accountOf("Zezima")).map((character) => character.name), ["Zezima"]);
});
