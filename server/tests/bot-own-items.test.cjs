// Ours. Run after `yarn build`: node --test tests/bot-own-items.test.cjs
// The levelling bots own what they use (plugins/bots/brain/OwnItems.PlayerBots.js): they start
// with a new player's kit and nothing is handed to them after that. Real Players, real shops.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const StarterKit = require("../plugins/world/StarterKit.plugin");
const OwnItems = require("../plugins/bots/brain/OwnItems.PlayerBots");
const { createEquipToolAction } = require("../plugins/bots/brain/actions/EquipTool.PlayerBots");
const { createEnsureItemAction } = require("../plugins/bots/brain/actions/EnsureItem.PlayerBots");
const { createChooseAction } = require("../plugins/bots/brain/actions/Choose.PlayerBots");
const { createOwnCombatKit } = require("../plugins/bots/brain/actions/OwnCombatKit.PlayerBots");

let core;
let Items;
let keeperNear = null;
let world;
let names = 0;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  require("../plugins/items/ItemDefinitionLoader.plugin").register({ log() {}, onPlayerLogin() {}, registerContentEndpoint() {} });
  core = PluginManager.getCoreApi();
  Items = core.ItemIdentifiers;
  require("../plugins/items/Food.plugin").register(PluginManager.createApi("BotOwnItemsTest"));
  assert.equal(new (require("../dist/game/definition/loader/impl/ShopDefinitionLoader").ShopDefinitionLoader)().load(), true, "the server's shops");
  core.ShopManager.initialize();
  // The world as the bots' actions see it: the real engine, with the NPCs near a bot ours to place.
  world = { core: { ...core, World: { ...core.World, getNpcsNear: () => (keeperNear ? [keeperNear] : []) } }, log: () => {} };
});

function bot(t, { earns = true, kit = true } = {}) {
  const p = new Player(null);
  p.getSession = () => ({ sendClientPacket: () => true, write: () => true });
  p.setUsername(`ownitems${++names}`);
  p.sendMessage = () => {};
  p.isPlayerBot = () => true;
  t.after(() => core.TaskManager.cancelTasks(p));
  OwnItems.setEarnsOwnItems(p, earns);
  if (kit) StarterKit.giveToBot(p);
  return p;
}
const ctxFor = (player, extra = {}) => ({ player, world, state: {}, frame: {}, nowMs: 1000, ...extra });
const wornIn = (player, slot) => player.getEquipment().getItems()[slot]?.getId?.() ?? -1;
const keeper = (npcId, at) => ({
  getDefinition: () => ({ getId: () => npcId }), isRegistered: () => true, getLocation: () => at,
});

test("a new levelling bot has a new player's kit, once: 18 items and 25 coins in the bank", (t) => {
  const p = bot(t);
  assert.equal(p.getInventory().getFreeSlots(), 10);
  for (const [name, amount] of StarterKit._test.KIT) assert.equal(p.getInventory().getAmount(Items[name]), amount, name);
  assert.equal(OwnItems.banked(p, Items.COINS), 25);
  assert.equal(StarterKit.giveToBot(p), false, "not twice");
  assert.equal(OwnItems.banked(p, Items.COINS), 25);
  assert.equal(OwnItems.purse(p), 25);
});

test("its axe is the one it has: nothing is put in its hand", (t) => {
  const p = bot(t);
  p.getSkillManager().setCurrentLevel(core.Skill.WOODCUTTING, 60, false).setMaxLevels(core.Skill.WOODCUTTING, 60, false);
  // Kept from the bank trip a cluttered backpack would start: this is about the tool alone.
  for (const [name] of StarterKit._test.KIT) if (name !== "BRONZE_AXE") p.getInventory().deleteNumber(Items[name], 100);
  const action = createEquipToolAction({ tool: "axe" }, world);
  assert.equal(action.update(ctxFor(p)), "success");
  assert.equal(wornIn(p, core.Equipment.WEAPON_SLOT), -1, "a bot handed its tools would hold a rune axe at 60");
  assert.equal(p.getInventory().getAmount(Items.BRONZE_AXE), 1);
  assert.equal(p.getInventory().getAmount(Items.RUNE_AXE), 0);
});

test("with no axe and no coins for one the step fails, the activity is held back, and the bot knows what it is saving for", (t) => {
  const p = bot(t, { kit: false });
  const ctx = ctxFor(p);
  assert.equal(createEquipToolAction({ tool: "axe" }, world).update(ctx), "failed");
  assert.equal(p.getInventory().getFreeSlots(), 28, "nothing appeared");
  assert.equal(wornIn(p, core.Equipment.WEAPON_SLOT), -1);
  assert.equal(ctx.frame.cooldownMs, OwnItems.WANT_COOLDOWN_MS);
  assert.equal(ctx.state.ownWish.itemId, Items.BRONZE_AXE);
  assert.ok(ctx.state.ownWish.cost > 0);
  assert.equal(OwnItems.ownItemsFor(world).wishing(p, ctx.state, 2000), true);
  p.getInventory().adds(Items.COINS, 1000);
  assert.equal(OwnItems.ownItemsFor(world).wishing(p, ctx.state, 3000), false, "it has the coins now");
});

test("a tool it lacks is not conjured either: no fishing rod, no coins, no fly fishing", (t) => {
  const p = bot(t, { kit: false });
  const ctx = ctxFor(p);
  assert.equal(createEnsureItemAction({ item: Items.FLY_FISHING_ROD }, world).update(ctx), "failed");
  assert.equal(p.getInventory().getAmount(Items.FLY_FISHING_ROD), 0);
  assert.equal(ctx.state.ownWish.itemId, Items.FLY_FISHING_ROD);
});

test("other bots are outfitted as before", (t) => {
  const p = bot(t, { earns: false, kit: false });
  assert.equal(createEquipToolAction({ tool: "axe" }, world).update(ctxFor(p)), "success");
  assert.equal(wornIn(p, core.Equipment.WEAPON_SLOT), Items.IRON_AXE, "the best axe of its level, from nowhere");
  assert.equal(createEnsureItemAction({ item: Items.TINDERBOX }, world).update(ctxFor(p)), "success");
  assert.equal(p.getInventory().getAmount(Items.TINDERBOX), 1);
});

test("the shops it can buy from are the coin shops with a keeper to walk to", () => {
  const { offers, keepers } = OwnItems.loadOffers();
  const axes = offers.get(Items.IRON_AXE);
  assert.ok(axes.some((entry) => entry.npcIds.includes(10619)), "Bob's Brilliant Axes in Lumbridge");
  for (const entry of axes) assert.ok(entry.price > 0 && keepers.get(entry.npcIds[0]) === entry.shopId);
  assert.ok(offers.get(Items.FEATHER).length > 0 && offers.get(Items.BRONZE_ARROW).length > 0 && offers.get(Items.MIND_RUNE).length > 0);
  assert.equal(offers.get(Items.RUNE_AXE)?.some((entry) => entry.npcIds.length === 0) ?? false, false);
});

test("at the keeper's counter it buys with its own coins, at the shop's price", (t) => {
  const p = bot(t, { kit: false });
  p.getSkillManager().setCurrentLevel(core.Skill.WOODCUTTING, 5, false).setMaxLevels(core.Skill.WOODCUTTING, 5, false);
  p.getInventory().adds(Items.COINS, 500);
  keeperNear = keeper(10619, p.getLocation());
  t.after(() => { keeperNear = null; });
  const own = OwnItems.createOwnItems(world);
  const ctx = ctxFor(p);
  let result = "running";
  for (let tick = 0; tick < 5 && result === "running"; tick++) result = own.fetch({ ...ctx, nowMs: 1000 + tick * 600 }, { itemId: Items.IRON_AXE });
  assert.equal(result, "success");
  assert.equal(p.getInventory().getAmount(Items.IRON_AXE), 1);
  const paid = 500 - p.getInventory().getAmount(Items.COINS);
  assert.ok(paid > 0 && paid < 200, `an iron axe costs coins (paid ${paid})`);
});

test("a better axe is bought when its level and its coins allow; until then the old one does", (t) => {
  const p = bot(t, { kit: false });
  p.getInventory().adds(Items.BRONZE_AXE, 1);
  p.getSkillManager().setCurrentLevel(core.Skill.WOODCUTTING, 6, false).setMaxLevels(core.Skill.WOODCUTTING, 6, false);
  const action = createEquipToolAction({ tool: "axe" }, world);
  const poor = ctxFor(p);
  assert.equal(action.update(poor), "success", "the bronze axe does");
  assert.equal(poor.state.ownWish.itemId, Items.IRON_AXE, "saving for the cheapest better one a shop sells");
  assert.equal(poor.frame.cooldownMs, undefined, "and working on meanwhile");
  p.getInventory().adds(Items.COINS, 5000);
  keeperNear = keeper(10619, p.getLocation());
  t.after(() => { keeperNear = null; });
  let result = "running";
  for (let tick = 0; tick < 5 && result === "running"; tick++) result = action.update(ctxFor(p, { nowMs: 5000 + tick * 600 }));
  assert.equal(result, "success");
  assert.equal(p.getInventory().getAmount(Items.STEEL_AXE), 1, "the best its level 6 can use that Bob sells");
});

test("short of coins for something it wants, it sells what it gathered instead of dropping it", (t) => {
  const p = bot(t, { kit: false });
  const ran = [];
  const step = (name) => ({ id: name, update: () => (ran.push(name), "success") });
  const choose = createChooseAction({ options: [
    { weight: 50, actions: [{ type: "dropItems" }] },
    { weight: 1, actions: [{ type: "sellItems" }] },
  ] }, (spec) => step(spec.type));
  const state = { ownWish: { itemId: Items.IRON_AXE, cost: 56, at: 1000 } };
  for (let round = 0; round < 20; round++) choose.update(ctxFor(p, { state }));
  assert.deepEqual([...new Set(ran)], ["sellItems"]);
  // Any other bot rolls between them all.
  const other = bot(t, { earns: false, kit: false });
  ran.length = 0;
  for (let round = 0; round < 40; round++) choose.update(ctxFor(other, { state }));
  assert.ok(ran.includes("dropItems"));
});

function combatKit() {
  const tier = (minLevel, weapons, extra = {}) => ({ minLevel, weapons: weapons.map((name) => Items[name]), ammo: [], spells: [], armour: [], ...extra });
  return createOwnCombatKit({
    world,
    combatStyles: ["melee", "ranged", "magic"],
    hashSeed: (value) => [...value].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0),
    skillByIndex: new Map(core.Skill.values().map((skill) => [skill.getIndex(), skill])),
    tiers: {
      melee: [tier(1, ["BRONZE_DAGGER", "BRONZE_SHORTSWORD"], { armour: [[core.Equipment.HEAD_SLOT, [Items.BRONZE_MED_HELM, null]]] }),
        tier(5, ["IRON_SCIMITAR"])],
      ranged: [tier(1, ["SHORTBOW"], { ammo: [Items.BRONZE_ARROW] }), tier(5, ["OAK_SHORTBOW"], { ammo: [Items.IRON_ARROW] })],
      magic: [tier(1, ["STAFF_OF_AIR"], { spells: [core.CombatSpells.WIND_STRIKE] })],
    },
  });
}

test("in a fight it wears the best of what it carries, and nothing it does not have", (t) => {
  const kit = combatKit();
  const p = bot(t);
  const state = {};
  const style = kit.prepare(p, state);
  assert.equal(style, kit.usableStyle(p));
  assert.equal(state.combatStyle, style);
  const weapon = wornIn(p, core.Equipment.WEAPON_SLOT);
  if (style === "melee") {
    assert.equal(weapon, Items.BRONZE_SHORTSWORD, "the sword, not the dagger");
    assert.equal(wornIn(p, core.Equipment.SHIELD_SLOT), Items.WOODEN_SHIELD);
  } else if (style === "ranged") {
    assert.equal(weapon, Items.SHORTBOW);
    assert.equal(p.getEquipment().getItems()[core.Equipment.AMMUNITION_SLOT].getAmount(), 25, "its 25 bronze arrows");
  } else {
    assert.equal(style, "magic");
  }
  assert.equal(wornIn(p, core.Equipment.HEAD_SLOT), -1, "no helmet: it has none");
  assert.equal(state.virtualFoodChargesRemaining, 2, "its shrimps and its bread");
});

test("its own style lasts while it has the arrows or the runes for it; without them it fights hand to hand", (t) => {
  const kit = combatKit();
  // Bots are drawn one style each: find one of each.
  const byStyle = {};
  for (let tries = 0; tries < 200 && Object.keys(byStyle).length < 3; tries++) {
    const p = bot(t);
    byStyle[kit.preferredStyle(p)] ??= p;
  }
  const archer = byStyle.ranged;
  const mage = byStyle.magic;
  assert.ok(archer && mage && byStyle.melee, "all three styles are drawn");
  assert.equal(kit.usableStyle(archer), "ranged");
  archer.getInventory().deleteNumber(Items.BRONZE_ARROW, 25);
  assert.equal(kit.usableStyle(archer), "melee", "no arrows");
  assert.equal(kit.usableStyle(mage), "magic");
  mage.getInventory().deleteNumber(Items.MIND_RUNE, 15);
  assert.equal(kit.usableStyle(mage), "melee", "no mind runes");
  assert.equal(mage.getInventory().getAmount(Items.MIND_RUNE), 0, "and none are conjured");
});

test("what its kill drops is worth the walk when it is coins, its ammunition, or better than it wears", (t) => {
  const kit = combatKit();
  const p = bot(t);
  kit.prepare(p, {});
  assert.equal(kit.wanted(p, Items.COINS), true);
  assert.equal(kit.wanted(p, Items.BRONZE_ARROW), true);
  assert.equal(kit.wanted(p, Items.MIND_RUNE), true);
  assert.equal(kit.wanted(p, Items.BRONZE_MED_HELM), true, "it wears no helmet");
  assert.equal(kit.wanted(p, Items.BONES), false);
  assert.equal(kit.wanted(p, Items.IRON_SCIMITAR), false, "not at Attack 1");
});

test("hurt with nothing to eat, it stops training", (t) => {
  const kit = combatKit();
  const p = bot(t);
  assert.equal(kit.mustRetreat(p), false, "full health");
  p.setHitpoints(2);
  assert.equal(kit.mustRetreat(p), false, "it has bread and shrimps");
  p.getInventory().deleteNumber(Items.BREAD, 1);
  p.getInventory().deleteNumber(Items.SHRIMPS, 1);
  assert.equal(kit.mustRetreat(p), true);
});

test("it keeps what it can sell and drops only what nobody would buy; other bots drop it all", (t) => {
  const { createDropItemsAction } = require("../plugins/bots/brain/actions/DropItems.PlayerBots");
  const drop = createDropItemsAction({ itemIds: [Items.LOGS, Items.BURNT_FISH] });
  const p = bot(t, { kit: false });
  p.getInventory().adds(Items.LOGS, 20);
  p.getInventory().adds(Items.BURNT_FISH, 5);
  assert.equal(drop.update(ctxFor(p)), "success");
  assert.equal(p.getInventory().getAmount(Items.LOGS), 20, "for the Grand Exchange");
  assert.equal(p.getInventory().getAmount(Items.BURNT_FISH), 0);
  const other = bot(t, { earns: false, kit: false });
  other.getInventory().adds(Items.LOGS, 20);
  assert.equal(drop.update(ctxFor(other)), "success");
  assert.equal(other.getInventory().getAmount(Items.LOGS), 0);
});

test("the world setting is on unless a world turns it off", () => {
  assert.equal(OwnItems.worldEarns(), true);
  const PlayerBots = require("../plugins/bots/PlayerBots.plugin");
  assert.equal(PlayerBots.config[OwnItems.EARN_CONFIG].default, true);
});
