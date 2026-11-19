// Ours. Run after `yarn build`: node --test tests/grand-exchange-command.test.cjs
// ::ge and ::gecollect put the Grand Exchange at a player's hand wherever they stand, and it does a
// bank's work: an item put up for sale has left the backpack, and what is collected can go to the
// bank. So by command it is refused where ::bank is (tests/bank-command.test.cjs): in the Wilderness
// and in a fight (a skulled player sold their gear away from the death that followed), on Entrana,
// and where teleporting away is refused (a PvP Arena fight hands out real Torva and Virtus for the
// fight: sold from inside it, the sale's coins were waiting when the player's own things came back).
// The clerks and booths at the exchange itself are as they were.
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
const GrandExchange = require("../plugins/interface/GrandExchange.plugin");

const GE = 465;
const GE_COLLECT = 402;
let core, Rights;
let inCombat = false;
let teleportAllowed = true;
const restore = [];

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  require("../plugins/items/ItemDefinitionLoader.plugin").register({ log() {}, onPlayerLogin() {}, registerContentEndpoint() {} });
  core = PluginManager.getCoreApi();
  Rights = core.PlayerRights;
  const api = PluginManager.createApi("AdminCommands");
  const combat = api.getCombatFactory();
  const wasInCombat = combat.inCombat;
  combat.inCombat = () => inCombat;
  const wasAllowed = core.TeleportHandler.destinationAllowed;
  core.TeleportHandler.destinationAllowed = () => teleportAllowed;
  restore.push(() => { combat.inCombat = wasInCombat; core.TeleportHandler.destinationAllowed = wasAllowed; });
  AdminCommands.register(api);
  GrandExchange.register(PluginManager.createApi("GrandExchange"));
});

afterEach(() => {
  inCombat = false;
  teleportAllowed = true;
});

/** A real player at a tile, with what they were told. */
function playerAt(x, y, rights = Rights.NONE, wilderness = 0) {
  const player = new Player(null, new core.Location(x, y, 0));
  player.getSession = () => ({ sendClientPacket: () => true, write: () => true });
  player.setUsername("Trader");
  player.setRights(rights);
  player.setWildernessLevel(wilderness);
  const messages = [];
  player.sendMessage = (text) => messages.push(text);
  const sender = player.getPacketSender();
  sender.sendMessage = (text) => (messages.push(text), sender);
  return Object.assign(player, { messages });
}

const type = (player, text) => CommandPacketListener.execute(player, text);

test("::ge and ::gecollect open the exchange and its collection box where a bank may be opened", () => {
  const buyer = playerAt(3222, 3219);
  type(buyer, "ge");
  assert.equal(buyer.getInterfaceId(), GE);
  type(buyer, "ge");
  assert.equal(buyer.getInterfaceId(), GE, "typed again with it open, it opens again");
  const collector = playerAt(3222, 3219);
  type(collector, "gecollect");
  assert.equal(collector.getInterfaceId(), GE_COLLECT);
});

for (const [command, name] of [["ge", "the Grand Exchange"], ["gecollect", "the Grand Exchange"]]) {
  test(`::${command} is refused in the Wilderness, in a fight, where teleports are refused and on Entrana`, () => {
    const wild = playerAt(3100, 3700, Rights.NONE, 23);
    type(wild, command);
    assert.equal(wild.getInterfaceId(), -1, "not in the Wilderness");
    assert.equal(wild.messages.at(-1), `You can't open ${name} in the Wilderness.`);

    inCombat = true;
    const fighting = playerAt(3222, 3219);
    type(fighting, command);
    assert.equal(fighting.getInterfaceId(), -1, "not in a fight");
    assert.equal(fighting.messages.at(-1), `You can't open ${name} during combat.`);
    inCombat = false;

    // A PvP Arena fight, Last Man Standing, a raid: wherever the area or a plugin refuses a teleport out.
    teleportAllowed = false;
    const closedIn = playerAt(3222, 3219);
    type(closedIn, command);
    assert.equal(closedIn.getInterfaceId(), -1, "not where teleporting away is refused");
    assert.equal(closedIn.messages.at(-1), `You can't open ${name} here.`);
    teleportAllowed = true;

    const pilgrim = playerAt(2834, 3335);
    type(pilgrim, command);
    assert.equal(pilgrim.getInterfaceId(), -1, "not on Entrana");
    assert.equal(pilgrim.messages.at(-1), "The monks of Entrana allow no trading here.");
  });
}

test("owners and developers are refused nowhere, as with ::bank", () => {
  inCombat = true;
  teleportAllowed = false;
  const owner = playerAt(3100, 3700, Rights.OWNER, 23);
  type(owner, "ge");
  assert.equal(owner.getInterfaceId(), GE);
  const developer = playerAt(2834, 3335, Rights.DEVELOPER);
  type(developer, "gecollect");
  assert.equal(developer.getInterfaceId(), GE_COLLECT);
});

test.after(() => restore.forEach((undo) => undo()));
