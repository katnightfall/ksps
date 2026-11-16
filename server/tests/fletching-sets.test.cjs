// Run after `yarn build`: node --test tests/fletching-sets.test.cjs
// Ours: "Fletching:maxSets" lets more than OSRS's 10 sets of arrows, bolts, darts and javelins be
// made from one choice. Above 28 the menu offers the amounts as they are (largeAmounts), which
// is what gives the client its 100 button (client/rs/cs2/makeAmounts.ts).
const assert = require("node:assert/strict");
const { test, before, beforeEach } = require("node:test");
const path = require("node:path");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { CacheDefinitions } = require("../dist/game/cache/CacheDefinitions");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { PacketSender, CREATION_MENU_LARGE_MAX_QUANTITY } = require("../dist/net/packet/PacketSender");
const { CreationMenu } = require("../dist/game/model/menu/CreationMenu");

const core = PluginManager.getCoreApi();
const I = core.ItemIdentifiers;
const hooks = { itemOnItem: [], events: {}, tasks: [] };
let Shared = null;
let worldSets = 0;

function fakeApi() {
  return {
    core,
    log() {},
    persistAttribute() {},
    onPlayerLogin() {},
    onPlayerDisconnect() {},
    getPluginConfig: (key, fallback) => (key === "Fletching:maxSets" ? worldSets : fallback),
    getTaskManager: () => ({ submit: (task) => { task.setRunning(true); hooks.tasks.push(task); } }),
    onItemOnItem(...args) { hooks.itemOnItem.push(args); },
    onItemAction() {},
    onCustomEvent(name, handler) { (hooks.events[name] ??= []).push(handler); },
    emitCustomEvent(name, event) { for (const handler of hooks.events[name] ?? []) handler(event); },
  };
}

function player(items) {
  const counts = new Map(Object.entries(items).map(([name, n]) => [I[name], n]));
  let menu = null;
  const inventory = {
    contains: (id) => (counts.get(id) ?? 0) > 0,
    getAmount: (id) => counts.get(id) ?? 0,
    deleteNumber(id, n) { const left = (counts.get(id) ?? 0) - n; if (left > 0) counts.set(id, left); else counts.delete(id); },
    addItem(item) { counts.set(item.getId(), (counts.get(item.getId()) ?? 0) + item.getAmount()); },
    getFreeSlots: () => 28 - counts.size,
    getAddableAmount: (item) => item.getAmount(),
    getItems: () => [...counts].map(([id, n]) => new core.Item(id, n)),
    deleteAtSlot(slot, n) { inventory.deleteNumber([...counts.keys()][slot], n); },
  };
  const sender = new Proxy({
    sendCreationMenu(value) { menu = value; return sender; },
    getVarbit: () => 0,
  }, { get: (target, key) => target[key] ?? (() => sender) });
  const attrs = new Map();
  return {
    menu: () => menu,
    count: (name) => counts.get(I[name]) ?? 0,
    getInventory: () => inventory,
    getEquipment: () => ({ contains: () => false }),
    getPacketSender: () => sender,
    getSkillManager: () => ({ getCurrentLevel: () => 99, addExperiences() {} }),
    getLocation: () => new core.Location(3000, 3000, 0),
    getForceMovement: () => null,
    isRegistered: () => true,
    getHitpoints: () => 99,
    getIndex: () => 1,
    getUsername: () => "tester",
    isPlayerBot: () => false,
    performAnimation() {},
    sendMessage() {},
    getAttribute: (key) => attrs.get(key),
    setAttribute: (key, value) => attrs.set(key, value),
  };
}

function use(p, a, b) {
  const event = { player: p, usedItemId: I[a], usedWithItemId: I[b], handled: false };
  for (const [handlerOrName, otherOrFilter, maybeHandler] of hooks.itemOnItem) {
    if (typeof handlerOrName === "function") handlerOrName(event);
    else if ([I[a], I[b]].every((id) => [handlerOrName, otherOrFilter].includes(CacheDefinitions.getItem(id).name))) maybeHandler(event);
    if (event.handled) break;
  }
  return event.handled;
}

function runTask() {
  const task = hooks.tasks.at(-1);
  for (let tick = 0; tick < 5000 && task.isRunning(); tick++) task.execute();
}

/** Headless arrows and bronze arrowtips for `sets` sets of 15, the menu open. */
function arrows(sets) {
  const p = player({ HEADLESS_ARROW: sets * 15, BRONZE_ARROWTIPS: sets * 15 });
  assert.equal(use(p, "BRONZE_ARROWTIPS", "HEADLESS_ARROW"), true);
  return p;
}

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  worldSets = 1000;
  require("../plugins/skills/Fletching.plugin").register(fakeApi());
  Shared = require("../plugins/skills/fletching/Shared.Fletching");
});
beforeEach(() => { hooks.tasks.length = 0; Shared.setMaxSets(1000); });

test("the world limit is read at the start and applies to the recipes made in sets only", () => {
  const made = (output) => Shared.getRecipes().find((recipe) => recipe.outputId === I[output]);
  assert.equal(made("BRONZE_ARROW").maxSets, 1000);
  assert.equal(made("RUNE_DART").maxSets, 1000);
  assert.equal(made("ARROW_SHAFT").maxSets, 28, "cut from logs: an inventory, as before");
  Shared.setMaxSets(0);
  assert.equal(made("BRONZE_ARROW").maxSets, 10, "0 is OSRS");
  Shared.setMaxSets(50000);
  assert.equal(made("BRONZE_ARROW").maxSets, 10000, "never more than a menu can offer");
  Shared.setMaxSets(NaN);
  assert.equal(made("BRONZE_ARROW").maxSets, 10);
});

test("with the limit above 28 the menu offers every set that can be made, and the amount chosen is the amount made", () => {
  const p = arrows(300);
  assert.equal(p.menu().getOptions().maxAmount, 300);
  assert.equal(p.menu().getOptions().largeAmounts, true);
  // The 100 button.
  p.menu().execute(I.BRONZE_ARROW, 100);
  runTask();
  assert.equal(p.count("BRONZE_ARROW"), 1500);
  assert.equal(p.count("HEADLESS_ARROW"), 200 * 15);

  // 28 typed after X is 28 sets, not "all".
  const q = arrows(300);
  q.menu().execute(I.BRONZE_ARROW, 28);
  runTask();
  assert.equal(q.count("BRONZE_ARROW"), 28 * 15);

  // All: the most the menu offers.
  const r = arrows(300);
  r.menu().execute(I.BRONZE_ARROW, r.menu().getOptions().maxAmount);
  runTask();
  assert.equal(r.count("BRONZE_ARROW"), 300 * 15);
  assert.equal(r.count("HEADLESS_ARROW"), 0);
});

test("no more is offered than the limit, or than the materials make", () => {
  assert.equal(arrows(2500).menu().getOptions().maxAmount, 1000);
  const few = arrows(12);
  assert.equal(few.menu().getOptions().maxAmount, 12);
  few.menu().execute(I.BRONZE_ARROW, 100);
  runTask();
  assert.equal(few.count("BRONZE_ARROW"), 12 * 15, "100 chosen with less to hand: what there is");
});

test("at 0 (OSRS) the menu is as it was: 10 sets, and 28 is all of them", () => {
  Shared.setMaxSets(0);
  const p = arrows(300);
  assert.equal(p.menu().getOptions().maxAmount, 10);
  assert.equal(p.menu().getOptions().largeAmounts, undefined);
  p.menu().execute(I.BRONZE_ARROW, 28);
  runTask();
  assert.equal(p.count("BRONZE_ARROW"), 150);
});

test("the menu packet: only a largeAmounts menu may offer more than 28, up to the limit", () => {
  const sent = (options) => {
    const scripts = [];
    const sender = Object.create(PacketSender.prototype);
    sender.player = { setCreationMenu() {}, getAttribute: () => undefined };
    for (const name of ["setChatboxUnclamped", "sendInterfaceDisplayState", "sendSubInterface", "sendInterfaceFlagsRange", "sendConfig"]) sender[name] = () => sender;
    sender.sendInterfaceScript = (id, args) => { scripts.push([id, args]); return sender; };
    sender.sendCreationMenu(new CreationMenu("How many?", [I.BRONZE_ARROW], { execute() {} }, options));
    const args = scripts.find(([id]) => id === 2046)[1];
    return { most: args[2], suggested: args.at(-1) };
  };
  assert.deepEqual(sent({ maxAmount: 300, largeAmounts: true }), { most: 300, suggested: 300 });
  assert.deepEqual(sent({ maxAmount: 300 }), { most: 28, suggested: 28 }, "an ordinary menu is held to an inventory");
  assert.deepEqual(sent({ maxAmount: 99999, largeAmounts: true }), { most: CREATION_MENU_LARGE_MAX_QUANTITY, suggested: CREATION_MENU_LARGE_MAX_QUANTITY });
  assert.deepEqual(sent({ maxAmount: 12, largeAmounts: true }), { most: 12, suggested: 12 });
});

test("the limit this world sets", () => {
  assert.equal(require("../data/definitions/world.json").pluginConfig["Fletching:maxSets"], 1000);
});
