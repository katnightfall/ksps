// Ours. Run after `yarn build`: node --test tests/fishing-noted-catch.test.cjs
// World setting "Fishing:notedCatch": a player's fish come as notes; junk, fish without a note and
// bots' catches come as before.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

test("Fishing:notedCatch puts players' fish in the backpack as notes", async () => {
  const { CachePipeline } = require("../dist/game/cache/CachePipeline");
  const { PluginManager } = require("../dist/plugins/PluginManager");
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  const core = PluginManager.getCoreApi();
  const { ItemIdentifiers: I, ItemDefinition, Skill, Item } = core;

  const events = new Map();
  const api = new Proxy({
    core,
    getTaskManager: () => ({ submit() {} }),
    getWorld: () => ({}),
    getPluginConfig: (key, fallback) => (key === "Fishing:notedCatch" ? true : fallback),
    onCustomEvent: (name, handler) => events.set(name, handler),
    emitCustomEvent: (name, payload) => events.get(name)?.(payload),
  }, { get: (target, name) => target[name] ?? (() => {}) });
  const Fishing = require("../plugins/skills/Fishing.plugin");
  Fishing.register(api);
  const { FISH, TOOLS, findTool, landCatch, _test } = Fishing;
  const noteOf = (id) => ItemDefinition.forId(id).getNoteId();

  function player({ inventory = [], filler = 0, bot = false } = {}) {
    const items = inventory.map((id) => new Item(id, 1));
    for (let i = 0; i < filler; i++) items.push(new Item(I.LOGS, 1));
    const xp = new Map();
    return {
      items, xp,
      isPlayerBot: () => bot,
      getInventory: () => ({
        getItems: () => items,
        contains: (id) => items.some((item) => item?.getId() === id),
        isFull: () => items.length >= 28,
        getFreeSlots: () => 28 - items.length,
        getAmount: (id) => items.reduce((sum, item) => sum + (item?.getId() === id ? item.getAmount() : 0), 0),
        addItem(item) {
          const stack = ItemDefinition.forId(item.getId()).isStackable() && items.find((held) => held.getId() === item.getId());
          if (stack) stack.setAmount(stack.getAmount() + item.getAmount());
          else items.push(item);
        },
        deleteNumber: (id) => items.splice(items.findIndex((item) => item.getId() === id), 1),
        refreshItems() {},
      }),
      getEquipment: () => ({ getItems: () => [], contains: () => false }),
      getSkillManager: () => ({
        getCurrentLevel: () => 99,
        getMaxLevel: () => 99,
        addExperiences: (skill, amount) => xp.set(skill.getName(), (xp.get(skill.getName()) ?? 0) + amount),
      }),
      getLocation: () => null,
      sendMessage() {},
      getPacketSender: () => ({ sendTypedMessage() {}, sendSoundEffect() {} }),
    };
  }
  const amount = (p, id) => p.getInventory().getAmount(id);

  const random = Math.random;
  try {
    Math.random = () => 0.9; // no big fish, no flakes or blessing
    // Shrimps come noted and stack in one slot; the experience is the same.
    const netter = player({ inventory: [I.SMALL_FISHING_NET] });
    landCatch(netter, TOOLS.NET, findTool(netter, TOOLS.NET), [FISH.SHRIMP]);
    landCatch(netter, TOOLS.NET, findTool(netter, TOOLS.NET), [FISH.SHRIMP]);
    assert.equal(amount(netter, I.RAW_SHRIMPS), 0);
    assert.equal(amount(netter, noteOf(I.RAW_SHRIMPS)), 2);
    assert.equal(netter.items.length, 2, "the net and one noted stack");
    assert.equal(netter.xp.get("Fishing"), 20);

    // A full backpack holding the noted stack keeps taking the catch, and doesn't stop fishing.
    const full = player({ inventory: [I.HARPOON], filler: 26 });
    landCatch(full, TOOLS.SHARK_HARPOON, findTool(full, TOOLS.SHARK_HARPOON), [FISH.SHARK]);
    assert.equal(full.items.length, 28);
    assert.equal(_test.inventoryBlocks(full, TOOLS.SHARK_HARPOON), false);
    landCatch(full, TOOLS.SHARK_HARPOON, findTool(full, TOOLS.SHARK_HARPOON), [FISH.SHARK]);
    assert.equal(amount(full, noteOf(I.RAW_SHARK)), 2);
    // Without a stack of that fish, a full backpack still stops it, as in OSRS.
    const stuffed = player({ inventory: [I.HARPOON], filler: 27 });
    assert.equal(_test.inventoryBlocks(stuffed, TOOLS.SHARK_HARPOON), true);

    // Junk and fish without a note come as they are.
    assert.equal(_test.notedCatchId(netter, FISH.CASKET), null, "a casket stays openable");
    assert.equal(_test.notedCatchId(netter, FISH.SACRED_EEL), null, "sacred eels have no note");
    assert.equal(_test.notedCatchId(netter, FISH.MINNOW), null, "minnows already stack");
    assert.equal(_test.notedCatchId(netter, FISH.KARAMBWAN), noteOf(I.RAW_KARAMBWAN));

    // Bots keep the normal catch.
    const bot = player({ inventory: [I.SMALL_FISHING_NET], bot: true });
    landCatch(bot, TOOLS.NET, findTool(bot, TOOLS.NET), [FISH.SHRIMP]);
    assert.equal(amount(bot, I.RAW_SHRIMPS), 1);

    // Off (OSRS), players' fish come as they are too.
    _test.setNotedCatch(false);
    const plain = player({ inventory: [I.SMALL_FISHING_NET] });
    landCatch(plain, TOOLS.NET, findTool(plain, TOOLS.NET), [FISH.SHRIMP]);
    assert.equal(amount(plain, I.RAW_SHRIMPS), 1);
    assert.equal(amount(plain, noteOf(I.RAW_SHRIMPS)), 0);
  } finally {
    Math.random = random;
    _test.setNotedCatch(false);
  }
});
