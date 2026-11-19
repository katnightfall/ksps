// Run after `yarn build`: node --test tests/death-kept-overflow.test.cjs
//
// A death can keep more items than a backpack holds: every untradeable is kept when no grave takes
// them (a death to another player, a world without graves), on top of the three or four most
// valuable. The kept items go back into the backpack at the respawn, and what did not fit was
// simply gone ("You couldn't hold all those items."). Real Player, containers and PlayerDeathTask;
// no plugins, so the engine's own rule is what is shown.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");

let core;
let untradeables;
let names = 0;
let bankSpace = null;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  require("../plugins/items/ItemDefinitionLoader.plugin").register({ log() {}, onPlayerLogin() {}, registerContentEndpoint() {} });
  core = PluginManager.getCoreApi();
  // Untradeable, unstackable items a death does not destroy: what a death keeps beyond the count.
  untradeables = [];
  for (let id = 1; id < 30000 && untradeables.length < 40; id++) {
    const definition = core.ItemDefinition.forId(id);
    const item = new core.Item(id, 1);
    if (!definition || definition.getId() !== id || !definition.getName() || definition.getName() === "null") continue;
    if (definition.isStackable() || definition.isNoted() || !(definition.getValue() > 0)) continue;
    if (item.isPlayerTradeable() || item.isLostOnDeath()) continue;
    untradeables.push(id);
  }
  PluginManager.createApi("DeathKeptOverflowTest").onCustomEvent("bank:capacity", (event) => {
    if (bankSpace !== null) event.capacity = bankSpace;
  });
});

function character(t, x) {
  const p = new Player(null, new core.Location(x, 3222, 0));
  p.getSession = () => ({ sendClientPacket: () => true, write: () => true });
  p.setUsername(`keptoverflow${++names}`);
  p.said = [];
  p.sendMessage = (line) => { p.said.push(line); };
  t.after(() => {
    core.TaskManager.cancelTasks(p);
    for (const pile of [...core.World.getItems()]) core.ItemOnGroundManager.deregister(pile);
    bankSpace = null;
  });
  return p;
}

const carried = (p) => p.getInventory().getValidItems().length + p.getEquipment().getValidItems().length;
const banked = (p) => Array.from({ length: core.Bank.TOTAL_BANK_TABS - 1 }, (_, tab) => p.getBank(tab).getValidItems())
  .flat().reduce((sum, item) => sum + item.getAmount(), 0);
const lying = (p) => core.World.getItems().filter((pile) => !pile.isPendingRemoval() && pile.getOwner() === p.getUsername())
  .reduce((sum, pile) => sum + pile.getItem().getAmount(), 0);

/** 28 untradeables carried and 6 worn, killed by another player: nothing goes to a grave. */
function die(t) {
  const victim = character(t, 3222);
  const killer = character(t, 3223);
  untradeables.slice(0, 28).forEach((id) => victim.getInventory().adds(id, 1));
  untradeables.slice(28, 34).forEach((id, slot) => victim.getEquipment().setItem(slot, new core.Item(id, 1)));
  assert.equal(carried(victim), 34);
  const kept = core.PlayerDeathTask.dropItems(victim, killer, victim.getLocation().clone());
  assert.equal(kept.length, 34, "the death keeps all 34");
  assert.equal(carried(victim), 0);
  core.PlayerDeathTask.returnKeptItems(victim, kept);
  return victim;
}

test("kept items the backpack cannot hold go to the bank: none is gone", (t) => {
  assert.ok(untradeables.length >= 34, "the cache has the untradeables this needs");
  const victim = die(t);
  assert.equal(victim.getInventory().getValidItems().length, 28, "the backpack is full of them");
  assert.equal(banked(victim), 6, "the six that did not fit are in the bank");
  assert.equal(carried(victim) + banked(victim) + lying(victim), 34, "34 kept, 34 held");
  assert.ok(victim.said.some((line) => /bank/.test(line)), "and the player is told where they are");
});

test("with no bank space either they lie where the player died, theirs alone", (t) => {
  bankSpace = 0;
  const victim = die(t);
  assert.equal(victim.getInventory().getValidItems().length, 28);
  assert.equal(banked(victim), 0);
  assert.equal(lying(victim), 6, "on the floor, the player's own");
  assert.equal(carried(victim) + banked(victim) + lying(victim), 34);
});

test("a death that keeps no more than fits is as it was", (t) => {
  const victim = character(t, 3222);
  untradeables.slice(0, 5).forEach((id) => victim.getInventory().adds(id, 1));
  const kept = core.PlayerDeathTask.dropItems(victim, null, victim.getLocation().clone());
  core.PlayerDeathTask.returnKeptItems(victim, kept);
  assert.equal(victim.getInventory().getValidItems().length, 5);
  assert.equal(banked(victim) + lying(victim), 0);
  assert.deepEqual(victim.said, []);
});
