// Run after `yarn build`: node --test tests/duel-staking-inventory.test.cjs
// Upstream issue #3387: with the staking screen on (the DuelStaking plugin), an item clicked to stake was
// wielded instead. The screen's own inventory (the cache's equipment_side, items offering Stake-1/5/10/All/X)
// was no longer put in the side panel, so the ordinary inventory answered the click and nothing could be staked.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { Gamevals, GamevalKind } = require("../dist/game/cache/Gamevals");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const DuelArena = require("../plugins/minigames/DuelArena.plugin");

const SIDE_MODAL = (161 << 16) | 74;
const STAKE_OPS = ["Stake-1", "Stake-5", "Stake-10", "Stake-All", "Stake-X"];
const COINS = 995;
let core;
let stakeInventory;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  core = PluginManager.getCoreApi();
  // The group is the cache's equipment_side, whatever its number.
  const groups = new Gamevals().namesOf(GamevalKind.INTERFACE);
  stakeInventory = [...groups].find(([, name]) => String(name).split("\u0000")[0] === "equipment_side")?.[0];
  const api = new Proxy({ core, emitCustomEvent() {} }, { get: (target, key) => (key in target ? target[key] : () => {}) });
  DuelArena.register(api);
  DuelArena.enableStaking();
});

/** A real player whose packets are recorded by name. */
function account(name, x) {
  const player = new Player(null);
  player.setUsername(name);
  const calls = [];
  const sender = new Proxy({}, { get: (target, key) => (key === "getVarbit" ? () => 0 : (...args) => (calls.push([key, ...args]), sender)) });
  player.getPacketSender = () => sender;
  player.sendMessage = () => {};
  player.setLocation(new core.Location(x, 3250, 0));
  return Object.assign(player, { calls });
}

function openOffer() {
  const [a, b] = [account("staker", 3330), account("opponent", 3331)];
  const session = { players: [a, b], mask: 0, accepted: new Set(), offers: new Map([[a, new Map()], [b, new Map()]]), stage: "options" };
  for (const player of session.players) {
    DuelArena._test.sessions.set(player, session);
    player.getDueling().setInteract(player === a ? b : a);
  }
  DuelArena._test.showOptions(session);
  return { a, b, session };
}

test("the cache has the side inventory the stake screen uses", () => {
  assert.equal(stakeInventory, 85, "equipment_side");
});

test("the stake screen puts its own inventory in the side panel, every item offering the Stake options", () => {
  const { a, session } = openOffer();
  assert.deepEqual(a.calls.find(([key, target]) => key === "sendSubInterface" && target === SIDE_MODAL),
    ["sendSubInterface", SIDE_MODAL, stakeInventory, 3], "equipment_side as the side modal");
  const init = a.calls.find(([key, id, args]) => key === "sendInterfaceScript" && id === 149 && args[0] === stakeInventory << 16);
  assert.ok(init, "interface_inv_init on its items layer");
  assert.deepEqual(init[2].slice(1, 6), [93, 4, 7, 1, -1], "the player's own inventory, 4 by 7");
  assert.deepEqual(init[2].slice(6), STAKE_OPS);
  assert.ok(a.calls.some(([key, target, from, to]) => key === "sendInterfaceFlagsRange" && target === stakeInventory << 16 && from === 0 && to === 27),
    "all 28 slots take clicks");
  DuelArena._test.end(session);
});

test("a click on an item there stakes it, and the same click on the offer takes it back", () => {
  const { a, b, session } = openOffer();
  a.getInventory().adds(COINS, 1000);
  session.snapshots = session.players.map(DuelArena._test.snapshot);
  const slot = a.getInventory().getItems().findIndex((item) => item.getId() === COINS);
  const click = (buttonId, clickedSlot, opId) => DuelArena._test.handleInterface({ player: a, buttonId, itemId: COINS, slot: clickedSlot, opId });
  click(stakeInventory << 16, slot, 3); // Stake-10
  assert.deepEqual([...session.offers.get(a).values()].map((item) => [item.getId(), item.getAmount()]), [[COINS, 10]]);
  click(stakeInventory << 16, slot, 4); // Stake-All
  assert.equal(session.offers.get(a).get(slot).getAmount(), 1000);
  assert.equal(a.getInventory().getAmount(COINS), 1000, "an offer moves nothing until the duel starts");
  assert.equal(session.offers.get(b).size, 0);
  click((DuelArena._test.OPTIONS << 16) | 12, 0, 4); // Remove-All on "Your Stake"
  assert.equal(session.offers.get(a).size, 0);
  DuelArena._test.end(session);
});
