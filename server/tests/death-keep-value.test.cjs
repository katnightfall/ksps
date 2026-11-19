// Run after `yarn build`: node --test tests/death-keep-value.test.cjs
//
// Which items a death keeps when some of them have no Grand Exchange price of their own: a charged weapon, an item a PvP
// death takes apart (docs/items-kept-on-death.md, "The kept items"). On the real engine: every plugin loaded, real
// Players, the real PlayerDeathTask and the real Items Kept on Death screen; only the ground item registration is watched.
//
// Wiki, Items Kept on Death (Scenarios, Protected Items): the kept items "are decided selected in order of value, with the
// highest value determined first by effective Grand Exchange value, and then by alchemy value if the item lacks an
// effective Grand Exchange value". Mechanics, "Chargable items", PvP death: "Dropped to the PKer as the tradeable
// uncharged item, and drops the items that would result from uncharging the item to the PKer too." Value: "the activated
// Vesta's blighted longsword has an Items Kept on Death value of 50,000,000 coins (the amount used to make the sword
// useable)". So an item with no price of its own is worth, for the ranking, what a PvP death would leave the killer.
process.env.DISABLE_PLAYER_BOTS = "1";
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { PlayerDeathTask } = require("../dist/game/task/impl/PlayerDeath");

let core, I;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  I = core.ItemIdentifiers;
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));

function make(id, meta = {}) {
  const item = new core.Item(id, 1);
  for (const [key, value] of Object.entries(meta)) item.setMetaValue(key, value);
  return item;
}
const scythe = () => make(I.SCYTHE_OF_VITUR, { "scythe-of-vitur-charges": 20000 });
const staff = () => make(I.SANGUINESTI_STAFF, { "sanguinesti-staff-charges": 1234 });
const loadedPipe = () => make(I.TOXIC_BLOWPIPE, { "toxic-blowpipe": { scales: 4000, dartId: I.DRAGON_DART, dartAmount: 300 } });

let next = 9700;
function actor(t) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel));
  p.setIndex(next++);
  p.setUsername("dkv" + p.getIndex());
  p.setRegistered(true);
  p.setAttribute("bot-skip-persistence", true);
  p.needsPlacement = false;
  t.after(() => { p.setRegistered(false); core.TaskManager.cancelTasks(p); });
  return p;
}

const WILDERNESS = () => new core.Location(3100, 3600, 0);

function prepare(victim, { skulled = false, protectItem = false } = {}) {
  victim.setLocation(WILDERNESS());
  if (skulled) core.CombatFactory.skull(victim, core.SkullType.WHITE_SKULL, core.CombatFactory.PVP_SKULL_SECONDS);
  victim.getSkillManager().setMaxLevels(core.Skill.PRAYER, 99, false).setCurrentLevel(core.Skill.PRAYER, 99, false);
  victim.getPrayerActive().fill(false);
  victim.setPrayerActive(core.PrayerHandler.PROTECT_ITEM, protectItem);
}

/** The victim dies in the Wilderness to `killer`: what the killer's pile holds ({ id: amount }) and what came back. */
function die(t, victim, killer, options = {}) {
  prepare(victim, options);
  killer.setLocation(WILDERNESS());
  const floor = [];
  const register = core.ItemOnGroundManager.registerLocation;
  t.mock.method(core.ItemOnGroundManager, "registerLocation", (owner, item, location, ...rest) => {
    if (owner === killer) floor.push({ id: item.getId(), amount: item.getAmount() });
    return register.call(core.ItemOnGroundManager, owner, item, location, ...rest);
  });
  const kept = PlayerDeathTask.dropItems(victim, killer, WILDERNESS());
  core.ItemOnGroundManager.registerLocation.mock.restore();
  const pile = {};
  for (const { id, amount } of floor) pile[id] = (pile[id] ?? 0) + amount;
  return { kept, pile };
}

const state = (item) => JSON.stringify([item.getId(), item.getAmount(), item.getMeta() ?? null]);
/** One item's price as the guide risk value counts it: coins at face value, anything else as a death ranks it. */
const price = (id) => (id === I.COINS ? 1 : PlayerDeathTask.keepValue(new core.Item(id, 1)));
const worth = (pile) => Object.entries(pile).reduce((sum, [id, amount]) => sum + price(Number(id)) * amount, 0);
/** The value a death ranked an item by before: its Grand Exchange price, else its alchemy value. */
function oldValue(item) {
  const definition = item.getDefinition();
  if (definition.hasGrandExchangeValue()) return definition.getGrandExchangeValue();
  const alch = definition.getHighAlchValue();
  return alch > 0 ? alch : Math.floor(Math.max(0, definition.getValue()) * 0.6);
}

// --- The case found -----------------------------------------------------------------------------------------------

test("skulled with Protect Item, a charged scythe is kept over a charged Sanguinesti staff, charges and all", (t) => {
  // Before, each ranked by its own alchemy value (scythe 2.4m, staff 3m): the staff was kept and the scythe, a 1,150m
  // item, lost to the killer.
  const victim = actor(t), killer = actor(t);
  const kept = scythe();
  const before = state(kept);
  victim.getInventory().setItem(0, staff());
  victim.getInventory().setItem(1, kept);
  const result = die(t, victim, killer, { skulled: true, protectItem: true });
  assert.deepEqual(result.kept, [kept], "the scythe is the one item kept");
  assert.equal(state(kept), before, "the kept scythe has every charge it had");
  assert.deepEqual(result.pile, { [I.SANGUINESTI_STAFF_UNCHARGED_]: 1, [I.BLOOD_RUNE]: 2468 }, "the staff is lost, emptied, to the killer");
});

// --- The value: what a PvP death leaves the killer -----------------------------------------------------------------

test("each measured item ranks by the price of what a PvP death leaves the killer, not by its alchemy value", (t) => {
  const victim = actor(t);
  const cases = [
    // Wiki, Scythe of Vitur: "all charges will be lost and the player who gets the scythe will not receive any blood
    // runes or vials of blood": the uncharged scythe alone.
    { item: scythe(), lostAs: { [I.SCYTHE_OF_VITUR_UNCHARGED_]: 1 } },
    { item: make(I.HOLY_SCYTHE_OF_VITUR, { "scythe-of-vitur-charges": 20000 }), lostAs: { [I.SCYTHE_OF_VITUR_UNCHARGED_]: 1 } },
    // The uncharged staff and the blood runes Uncharge gives back (2 a charge).
    { item: staff(), lostAs: { [I.SANGUINESTI_STAFF_UNCHARGED_]: 1, [I.BLOOD_RUNE]: 2468 } },
    // Wiki, Toxic blowpipe: "all scale and dart charges will appear on the floor alongside the blowpipe".
    { item: loadedPipe(), lostAs: { [I.TOXIC_BLOWPIPE_EMPTY_]: 1, [I.ZULRAHS_SCALES]: 4000, [I.DRAGON_DART]: 300 } },
    // Wiki: "it will fully degrade into Saradomin's tear"; "A player killer will receive the synapse".
    { item: make(I.SARADOMINS_BLESSED_SWORD), lostAs: { [I.SARADOMINS_TEAR]: 1 } },
    { item: make(I.EMBERLIGHT), lostAs: { [I.TORMENTED_SYNAPSE]: 1 } },
  ];
  for (const { item, lostAs } of cases) {
    const name = item.getDefinition().getName();
    assert.equal(item.getDefinition().hasGrandExchangeValue(), false, `${name}: no price of its own`);
    for (const id of Object.keys(lostAs)) assert.ok(new core.Item(Number(id), 1).getDefinition().hasGrandExchangeValue(), `${name}: part ${id} has a price`);
    const value = PlayerDeathTask.keepValue(item, victim);
    assert.equal(value, worth(lostAs), `${name}: ranked at what it is lost as`);
    assert.ok(value > oldValue(item), `${name}: above its alchemy value ${oldValue(item)}`);
  }
});

test("every charged or taken-apart item ranks at exactly the price of what a real PvP death drops for the killer", (t) => {
  const items = () => [
    scythe(), make(I.SANGUINE_SCYTHE_OF_VITUR, { "scythe-of-vitur-charges": 20000 }), staff(),
    make(I.HOLY_SANGUINESTI_STAFF, { "sanguinesti-staff-charges": 20000 }),
    make(I.TUMEKENS_SHADOW, { "tumekens-shadow-charges": 1000, "tumekens-shadow-aether-runes": 600 }),
    loadedPipe(), make(I.BLAZING_BLOWPIPE, { "toxic-blowpipe": { scales: 4000, dartId: I.DRAGON_DART, dartAmount: 300 } }),
    make(I.TOXIC_STAFF_OF_THE_DEAD, { "toxic-staff-charges": 3210 }), make(I.SERPENTINE_HELM, { "serpentine-helm": 5000 }),
    make(I.MAGMA_HELM, { "serpentine-helm": 11000 }), make(I.TRIDENT_OF_THE_SEAS, { "trident-charges": 777 }),
    make(I.TRIDENT_OF_THE_SEAS_O_, { "trident-charges": 777 }), make(I.TRIDENT_OF_THE_SWAMP_E_, { "trident-charges": 15000 }),
    make(I.VENATOR_BOW, { "venator-bow:charges": 2500 }), make(I.ECHO_VENATOR_BOW, { "venator-bow:charges": 50000 }),
    make(I.WARPED_SCEPTRE, { "warped-sceptre": 400 }),
    make(I.EYE_OF_AYAK, { "eye-of-ayak-charges": 300, "eye-of-ayak-charge-material": "runes" }),
    make(I.TONALZTICS_OF_RALOS, { "tonalztics-of-ralos:charges": 900 }), make(I.SARAS_BLESSED_SWORD_FULL_),
    make(I.SCORCHING_BOW), make(I.PURGING_STAFF), make(I.ABYSSAL_TENTACLE),
    make(I.VOLATILE_NIGHTMARE_STAFF), make(I.VESTAS_LONGSWORD_BH_, { "bounty-hunter:activation-fee": 50000000 }),
  ];
  const valued = items();
  for (const [index, item] of items().entries()) {
    const victim = actor(t), killer = actor(t);
    const name = item.getDefinition().getName();
    const value = PlayerDeathTask.keepValue(valued[index], victim);
    victim.getInventory().setItem(0, item);
    const result = die(t, victim, killer, { skulled: true });
    assert.ok(Object.keys(result.pile).length > 0, `${name}: the killer gets something`);
    assert.equal(value, worth(result.pile), `${name}: ranked at what the killer gets: ${JSON.stringify(result.pile)}`);
  }
});

test("an activated Bounty Hunter piece ranks at the coins it holds; one that holds none ranks as before", (t) => {
  // Wiki, Vesta's blighted longsword: "In regards to Items Kept on Death, the activated Vesta's blighted longsword has a
  // value of 50,000,000 coins". Our (bh) pieces hold what they were charged with; the inactive piece stays the victim's.
  const victim = actor(t);
  assert.equal(PlayerDeathTask.keepValue(make(I.VESTAS_LONGSWORD_BH_, { "bounty-hunter:activation-fee": 50000000 }), victim), 50000000);
  const empty = make(I.VESTAS_LONGSWORD_BH_);
  assert.equal(PlayerDeathTask.keepValue(empty, victim), oldValue(empty), "nothing that trades: its alchemy value, as before");
});

// --- Unchanged -----------------------------------------------------------------------------------------------------

test("ordinary items, untradeables that nothing takes apart, and items with a price of their own rank as before", (t) => {
  const victim = actor(t);
  const ids = [
    I.ARMADYL_GODSWORD, I.RUNE_PLATEBODY, I.RANGER_BOOTS, I.BERSERKER_RING, I.SHARK, I.COINS, I.BLOOD_RUNE,
    I.SCYTHE_OF_VITUR_UNCHARGED_, I.TOXIC_BLOWPIPE_EMPTY_, I.TRIDENT_OF_THE_SEAS_FULL_,
    I.FIRE_CAPE, I.DRAGON_DEFENDER, I.BARROWS_GLOVES, I.MAX_CAPE, I.ARCLIGHT, I.DRYGORE_BLOWPIPE,
  ];
  for (const id of ids) {
    const item = new core.Item(id, id === I.COINS || id === I.BLOOD_RUNE ? 1000 : 1);
    assert.equal(PlayerDeathTask.keepValue(item, victim), oldValue(item), item.getDefinition().getName());
    assert.equal(PlayerDeathTask.keepValue(item), oldValue(item), `${item.getDefinition().getName()}, asked without the player`);
  }
});

test("a preset copy and a bot's gear rank as before, and a bot keeps what it kept before", (t) => {
  const victim = actor(t), bot = actor(t);
  const preset = scythe();
  for (const key of [core.Item.UNTRADEABLE_META, core.Item.UNBANKABLE_META, core.Item.PRESET_META]) preset.setMetaValue(key, true);
  assert.equal(PlayerDeathTask.keepValue(preset, victim), oldValue(preset));
  bot.setPlayerBot(true);
  for (const item of [scythe(), staff(), loadedPipe(), make(I.EMBERLIGHT)]) {
    assert.equal(PlayerDeathTask.keepValue(item, bot), oldValue(item), `a bot's ${item.getDefinition().getName()}`);
  }
  // A bot's ranking is still by alchemy value: the staff (3m) over the scythe (2.4m).
  const botStaff = staff();
  bot.getInventory().setItem(0, scythe());
  bot.getInventory().setItem(1, botStaff);
  prepare(bot, { skulled: true, protectItem: true });
  assert.deepEqual(PlayerDeathTask.getItemsToKeep(bot), [botStaff]);
});

test("ranking touches nothing the player carries: no item changes, no refresh, no appearance update", (t) => {
  const victim = actor(t);
  const carried = [scythe(), staff(), loadedPipe(), make(I.TONALZTICS_OF_RALOS, { "tonalztics-of-ralos:charges": 900 }),
    make(I.TUMEKENS_SHADOW, { "tumekens-shadow-charges": 1000 }), make(I.MAGMA_HELM, { "serpentine-helm": 11000 })];
  carried.forEach((item, slot) => victim.getInventory().setItem(slot, item));
  victim.getEquipment().setItem(core.Equipment.WEAPON_SLOT, make(I.HOLY_SCYTHE_OF_VITUR, { "scythe-of-vitur-charges": 50 }));
  prepare(victim, { skulled: true, protectItem: true });
  const before = [...victim.getInventory().getItems(), ...victim.getEquipment().getItems()].map((item) => item && state(item));
  const inventoryRefresh = t.mock.method(victim.getInventory(), "refreshItems");
  const equipmentRefresh = t.mock.method(victim.getEquipment(), "refreshItems");
  const flag = t.mock.method(victim.getUpdateFlag(), "flag");
  PlayerDeathTask.getItemsToKeep(victim);
  PlayerDeathTask.getKeptItems(victim, 4, false);
  const after = [...victim.getInventory().getItems(), ...victim.getEquipment().getItems()].map((item) => item && state(item));
  assert.deepEqual(after, before);
  assert.equal(inventoryRefresh.mock.callCount(), 0);
  assert.equal(equipmentRefresh.mock.callCount(), 0);
  assert.equal(flag.mock.callCount(), 0);
});

// --- The Items Kept on Death screen --------------------------------------------------------------------------------

/** Opens the Items Kept on Death screen from the Worn Equipment tab: the kept item ids its clientscript 972 lists. */
function screenKept(t, player) {
  const handlers = new Map();
  require("../plugins/interface/ItemsKeptOnDeath.plugin").register({
    core,
    getPrayerHandler: () => core.PrayerHandler,
    emitCustomEvent: (name, payload) => PM.emitCustomEvent(name, payload),
    onInterfaceActionButton: (uid, handler) => handlers.set(uid, handler),
  });
  let args = null;
  const sender = new Proxy({}, {
    get: (_object, key) => (key === "sendInterfaceScript"
      ? (id, scriptArgs) => { if (id === 972) args = scriptArgs; return sender; }
      : () => sender),
  });
  t.mock.method(player, "getPacketSender", () => sender);
  handlers.get((387 << 16) | 5)({ player });
  player.getPacketSender.mock.restore();
  return args.slice(6, 6 + args[5]);
}

test("the Items Kept on Death screen shows the choice the death then makes", (t) => {
  for (const options of [{ skulled: true, protectItem: true }, {}, { protectItem: true }]) {
    const victim = actor(t), killer = actor(t);
    const items = [staff(), make(I.ARMADYL_GODSWORD), scythe(), loadedPipe(), make(I.EMBERLIGHT), make(I.SARADOMINS_BLESSED_SWORD),
      make(I.RANGER_BOOTS), make(I.TUMEKENS_SHADOW, { "tumekens-shadow-charges": 1000 })];
    items.forEach((item, slot) => victim.getInventory().setItem(slot, item));
    prepare(victim, options);
    const shown = screenKept(t, victim);
    const result = die(t, victim, killer, options);
    assert.deepEqual(shown, result.kept.map((item) => item.getId()), JSON.stringify(options));
  }
});
