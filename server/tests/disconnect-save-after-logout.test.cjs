// Ours. Run after `yarn build`: node --test tests/disconnect-save-after-logout.test.cjs
// A logout closes the player's socket; the socket's close is heard a moment later (or up to half
// a minute later, from a client that has gone quiet), after the player has left the world and
// the logout save is written. That close asked for one more save of the player ("disconnect"),
// from the memory of a player who is gone: written after the logout save, and after anything a
// new login of the same account had saved meanwhile. Real ClientConnection, real save requests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, before, beforeEach } = require("node:test");

process.env.TSPS_ACCOUNTS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "accounts-")), "accounts.json");
process.env.TSPS_DISPLAY_NAMES_FILE = path.join(path.dirname(process.env.TSPS_ACCOUNTS_FILE), "display-names.json");
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { GameConstants } = require("../dist/game/GameConstants");
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { World } = require("../dist/game/World");
const { Sailing } = require("../dist/game/content/sailing/Sailing");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Accounts } = require("../dist/game/entity/impl/player/Accounts");
const { DisplayNames } = require("../dist/game/entity/impl/player/DisplayNames");
const { PlayerPersistence } = require("../dist/game/entity/impl/player/persistence/PlayerPersistence");
const net = require("../dist/net/NetworkBuilder");

let REVISION;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  REVISION = CachePipeline.getActive().revision;
});

/** The engine's own save requests (PlayerPersistence.requestSave), writing to a list. */
class RecordingPersistence extends PlayerPersistence {
  written = [];
  load() { return null; }
  exists() { return false; }
  save(player, reason) { this.written.push([player.getUsername(), reason]); }
}

let persistence;
beforeEach(() => {
  Accounts.reset();
  DisplayNames.reset();
  net.ClientConnection.pendingNames.clear();
  persistence = new RecordingPersistence();
  GameConstants.PLAYER_PERSISTENCE = persistence;
});

function channel() {
  const handlers = {};
  return {
    kind: "test",
    remoteAddress: "127.0.0.1",
    isOpen: () => true,
    send: () => true,
    close() {},
    onData() {},
    onError() {},
    onClose(handler) { handlers.close = handler; },
    /** The socket's close reaching the server. */
    closes: () => handlers.close(),
  };
}

/** A player logged in and in the world (the player list, regions, sailing and plugins are stubbed). */
async function enter(t, name) {
  const socket = channel();
  const connection = new net.ClientConnection(socket);
  let player = null;
  t.mock.method(World.getPlayers(), "add", (added) => { added.setIndex(1); added.setRegistered(true); player = added; return true; });
  t.mock.method(World, "refreshActiveRegions", () => {});
  t.mock.method(Sailing, "onLogin", () => {});
  t.mock.method(PluginManager, "emitPlayerLogin", () => {});
  t.mock.method(PluginManager, "emitCustomEvent", () => {});
  connection.inject([{ type: "login", username: name, password: "pw", revision: REVISION, flags: 0 }]);
  await connection.idle();
  connection.inject([{ type: "handshake", name, clientType: 0, capabilities: 0 }]);
  await connection.idle();
  assert.ok(player, "the player entered the world");
  t.after(() => { World.getRemovePlayerQueue().length = 0; });
  return { socket, player };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

test("a socket that closes after its player has left the world does not save that player again", async (t) => {
  const { socket, player } = await enter(t, "Zezima");
  // The logout: the world takes the player out and writes the logout save (World.process, Player.onLogout).
  player.setRegistered(false);
  persistence.save(player, "logout");
  // The account logs in again and saves; only then is the first socket's close heard.
  persistence.written.push(["Zezima", "a new login's save"]);
  socket.closes();
  await settled();
  assert.deepEqual(persistence.written, [["Zezima", "logout"], ["Zezima", "a new login's save"]], "nothing is written from the gone player's memory");
});

test("a socket that drops while its player is in the world still asks for a save at once", async (t) => {
  const { socket, player } = await enter(t, "Durial");
  socket.closes();
  await settled();
  assert.deepEqual(persistence.written, [["Durial", "disconnect"]]);
  assert.ok(World.getRemovePlayerQueue().includes(player), "and the player is queued to leave the world");
});
