// Ours. Run after `yarn build`: node --test tests/bank-command.test.cjs
// ::bank is every player's (world setting BankCommand:everyone), but not in the Wilderness, in a
// fight, on Entrana or where teleporting away is refused; owners and developers anywhere.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before, afterEach } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { CommandPacketListener } = require("../dist/net/packet/impl/CommandPacketListener");
const AdminCommands = require("../plugins/commands/AdminCommands.plugin");

let core, Rights, api;
let inCombat = false;
let teleportAllowed = true;
let everyone = true;
const restore = [];

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  core = PluginManager.getCoreApi();
  Rights = core.PlayerRights;
  api = PluginManager.createApi("AdminCommands");
  const combat = api.getCombatFactory();
  const wasInCombat = combat.inCombat;
  combat.inCombat = () => inCombat;
  const wasAllowed = core.TeleportHandler.destinationAllowed;
  core.TeleportHandler.destinationAllowed = () => teleportAllowed;
  const wasConfig = api.getPluginConfig.bind(api);
  api.getPluginConfig = (key, fallback) => (key === "BankCommand:everyone" ? everyone : wasConfig(key, fallback));
  restore.push(() => { combat.inCombat = wasInCombat; core.TeleportHandler.destinationAllowed = wasAllowed; });
  AdminCommands.register(api);
});

afterEach(() => {
  inCombat = false;
  teleportAllowed = true;
  everyone = true;
});

/** A player at a tile, with their messages and how often their bank was opened. */
function playerAt(x, y, rights = Rights.NONE, wilderness = 0) {
  const player = new Player(null);
  player.setUsername("Banker");
  player.setRights(rights);
  player.setLocation(new core.Location(x, y, 0));
  player.getWildernessLevel = () => wilderness;
  const messages = [];
  let opened = 0;
  player.sendMessage = (text) => messages.push(text);
  player.getBank = () => ({ open: () => { opened += 1; } });
  return Object.assign(player, { messages, opened: () => opened });
}

const type = (player, text) => CommandPacketListener.execute(player, text);

test("any player opens their bank with ::bank", () => {
  const player = playerAt(3222, 3219);
  type(player, "bank");
  assert.equal(player.opened(), 1);
  assert.deepEqual(player.messages, []);
});

test("not in the Wilderness, not in a fight, not where teleports are refused, not on Entrana", () => {
  const wild = playerAt(3100, 3600, Rights.NONE, 10);
  type(wild, "bank");
  assert.equal(wild.opened(), 0);
  assert.equal(wild.messages.at(-1), "You can't open your bank in the Wilderness.");

  inCombat = true;
  const fighting = playerAt(3222, 3219);
  type(fighting, "bank");
  assert.equal(fighting.opened(), 0);
  assert.equal(fighting.messages.at(-1), "You can't open your bank during combat.");
  inCombat = false;

  teleportAllowed = false;
  const closedIn = playerAt(3222, 3219);
  type(closedIn, "bank");
  assert.equal(closedIn.opened(), 0);
  assert.equal(closedIn.messages.at(-1), "You can't open your bank here.");
  teleportAllowed = true;

  for (const [x, y] of [[2834, 3335], [2800, 3350], [2822, 9774]]) {
    const pilgrim = playerAt(x, y);
    type(pilgrim, "bank");
    assert.equal(pilgrim.opened(), 0, `Entrana ${x},${y}`);
    assert.equal(pilgrim.messages.at(-1), "The monks of Entrana allow no banking here.");
  }
});

test("a busy player is refused", () => {
  const player = playerAt(3222, 3219);
  player.busy = () => true;
  type(player, "bank");
  assert.equal(player.opened(), 0);
  assert.equal(player.messages.at(-1), "You can't open your bank right now.");
});

test("a world may keep ::bank to its owners and developers, who are refused nowhere", () => {
  everyone = false;
  const player = playerAt(3222, 3219);
  type(player, "bank");
  assert.equal(player.opened(), 0);
  assert.equal(player.messages.at(-1), "You do not have permission to use this command.");

  inCombat = true;
  teleportAllowed = false;
  const owner = playerAt(3100, 3600, Rights.OWNER, 10);
  type(owner, "bank");
  assert.equal(owner.opened(), 1);
  const developer = playerAt(2834, 3335, Rights.DEVELOPER);
  type(developer, "bank");
  assert.equal(developer.opened(), 1);
});

test.after(() => restore.forEach((undo) => undo()));
