// Run after `yarn build`: node --test tests/pvp-death-charged-equipment.test.cjs
//
// Upstream issue #6002, the rest of it: what a death to another player makes of charged, assembled and imbued
// untradeable equipment (docs/items-kept-on-death.md, "Charged, assembled and imbued equipment on a PvP death"), and
// the Items Kept on Death screen's guide risk value for what such a death takes apart. On the real engine: every plugin
// loaded, real Players, the real PlayerDeathTask.dropItems; only the ground item registration and the grave hook are
// watched. Each family has its "lost" tests (unprotected, skulled, to a player on PvP ground: what the killer's pile
// holds, what the victim is left, and that nothing else exists afterwards) and its "kept" tests (protected by the
// three-item rule or Protect Item, a death to a monster, a player's kill credit outside PvP ground, a preset copy, a
// bot), where the item comes through exactly as it was.
//
// The Wiki's words for each rule are quoted above its tests.
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

let core, I, obj;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  I = core.ItemIdentifiers;
  obj = (name) => {
    const id = core.CacheDefinitions.getObjId(name);
    assert.ok(Number.isInteger(id), `the cache has an item named ${name}`);
    return id;
  };
  // BountyHunter depends on PlayerBots, which this test leaves off, so the plugin is skipped: its area unit is attached
  // here for the one thing these tests ask of it, the answer to `player-death:pvp-ground`.
  const real = PM.createApi("BountyHunter");
  const api = new Proxy({
    core,
    registerArea() {},
    getPluginConfig: (_key, fallback) => fallback,
    onCustomEvent: (name, handler) => { if (name === "player-death:pvp-ground") real.onCustomEvent(name, handler); },
  }, { get: (object, key) => object[key] ?? (() => {}) });
  require("../plugins/minigames/bountyhunter/Area.BountyHunter")(api, require("../plugins/minigames/bountyhunter/State.BountyHunter"));
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));

let next = 9900;
function actor(t) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel));
  p.setIndex(next++);
  p.setUsername("pdc" + p.getIndex());
  p.setRegistered(true);
  p.setAttribute("bot-skip-persistence", true);
  p.needsPlacement = false;
  t.after(() => { p.setRegistered(false); core.TaskManager.cancelTasks(p); });
  return p;
}

// Level 10 Wilderness, a town, and Daimon's Crater's arena.
const WILDERNESS = () => new core.Location(3100, 3600, 0);
const LUMBRIDGE = () => new core.Location(3222, 3218, 0);
const CRATER = () => new core.Location(3470, 4000, 0);

/**
 * The victim dies at `at` to `killer` (null: a monster). `skulled` and `protectItem` set the kept count as the game
 * does. Returns the Items that reached the floor (`floor`: { item, owner }), the Items the grave hook was offered
 * (`grave`), and the Items that came back to the victim (`kept`).
 */
function die(t, victim, killer, at, { skulled = false, protectItem = false } = {}) {
  victim.setLocation(at);
  killer?.setLocation(at.clone());
  if (skulled) core.CombatFactory.skull(victim, core.SkullType.WHITE_SKULL, core.CombatFactory.PVP_SKULL_SECONDS);
  victim.getSkillManager().setMaxLevels(core.Skill.PRAYER, 99, false).setCurrentLevel(core.Skill.PRAYER, 99, false);
  victim.getPrayerActive().fill(false);
  victim.setPrayerActive(core.PrayerHandler.PROTECT_ITEM, protectItem);
  const floor = [];
  const register = core.ItemOnGroundManager.registerLocation;
  t.mock.method(core.ItemOnGroundManager, "registerLocation", (owner, item, location, ...rest) => {
    floor.push({ item, owner: owner === killer ? "killer" : owner === victim ? "victim" : "other" });
    return register.call(core.ItemOnGroundManager, owner, item, location, ...rest);
  });
  const grave = [];
  const emitDrops = PM.emitPlayerDeathDrops;
  t.mock.method(PM, "emitPlayerDeathDrops", (event) => {
    grave.push(...event.items, ...event.untradeables);
    return emitDrops.call(PM, event);
  });
  const kept = PlayerDeathTask.dropItems(victim, killer, at);
  core.ItemOnGroundManager.registerLocation.mock.restore();
  PM.emitPlayerDeathDrops.mock.restore();
  assert.equal(victim.getInventory().getValidItems().length + victim.getEquipment().getValidItems().length, 0, "the death empties the victim");
  return { floor, grave, kept };
}

const ids = (items) => items.map((item) => item.getId()).sort((a, b) => a - b);
const sorted = (list) => [...list].sort((a, b) => a - b);
const forKiller = ({ floor }) => floor.filter(({ owner }) => owner === "killer").map(({ item }) => item);
/** Every id, amount and metadata of a list of Items, in a form two lists can be compared by. */
const exact = (items) => items.map((item) => [item.getId(), item.getAmount(), item.getMeta() ?? null]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const withMeta = (id, key, value) => new core.Item(id, 1).setMetaValue(key, value);
const plain = (id, amount = 1) => new core.Item(id, amount);
function preset(item) {
  for (const key of [core.Item.UNTRADEABLE_META, core.Item.UNBANKABLE_META, core.Item.PRESET_META]) item.setMetaValue(key, true);
  return item;
}
const lostOnPreview = (item) => { const query = { item, wildernessLevel: 10, lost: false }; PM.emitCustomEvent("items:lost-to-pvp-killer", query); return query.lost; };
/** What the death's own question (`player-death:pvp-item-parts`) makes of one item for a real player: the parts, or null. */
function partsOf(item, player = { isPlayerBot: () => false }) {
  const query = { player, killer: {}, item, parts: null };
  PM.emitCustomEvent("player-death:pvp-item-parts", query);
  return query.parts;
}

/**
 * A skulled victim carrying `carried()` dies to a player at `at`: the killer's pile holds exactly `killerGets`
 * ([id, amount, meta] rows, as `exact` gives them), the victim is left exactly `victimKeeps`, and nothing else is on
 * the floor. Returns the death's result.
 */
function lost(t, carried, killerGets, victimKeeps = [], at = WILDERNESS()) {
  const victim = actor(t), killer = actor(t);
  carried().forEach((item, slot) => victim.getInventory().setItem(slot, item));
  const result = die(t, victim, killer, at, { skulled: true });
  assert.deepEqual(exact(forKiller(result)), exact(killerGets), "what the killer's pile holds");
  assert.deepEqual(exact(result.kept), exact(victimKeeps), "what the victim is left");
  assert.equal(result.floor.length, forKiller(result).length, "nothing else is dropped");
  return { ...result, victim, killer };
}

/**
 * The cases where `make()`'s item must come through the death exactly as it was: protected by the three-item rule,
 * protected by Protect Item on a skulled player, a death to a monster in the Wilderness (to the grave whole, or kept), a
 * player's kill credit in a town, a preset copy (deleted, and nothing for anyone), and a bot (the hook itself, and a
 * bot's own death in the Wilderness).
 */
function keptCases(t, make) {
  const same = (items, label) => assert.deepEqual(exact(items), exact([make()]), label);
  for (const [options, label] of [[{}, "the three-item rule"], [{ skulled: true, protectItem: true }, "Protect Item on a skulled player"]]) {
    const victim = actor(t), killer = actor(t);
    victim.getInventory().setItem(0, make());
    const result = die(t, victim, killer, WILDERNESS(), options);
    same(result.kept, `kept as it is by ${label}`);
    assert.deepEqual(result.floor, [], `${label}: nothing is dropped`);
  }
  {
    const victim = actor(t);
    victim.getEquipment().setItem(core.Equipment.WEAPON_SLOT, make());
    const result = die(t, victim, null, WILDERNESS(), { skulled: true });
    // To the grave, or straight back where the death keeps it beyond the count (a locked item).
    same(result.grave.length > 0 ? result.grave : result.kept, "a death to a monster leaves it as it is, for the grave or kept");
    assert.deepEqual(result.floor, [], "a death to a monster drops nothing");
  }
  {
    const victim = actor(t), killer = actor(t);
    victim.getInventory().setItem(0, make());
    const result = die(t, victim, killer, LUMBRIDGE(), { skulled: true });
    same(result.kept, "a player's kill credit outside PvP ground leaves it as it is");
    assert.deepEqual(result.floor, []);
  }
  {
    const victim = actor(t), killer = actor(t);
    victim.getInventory().setItem(0, preset(make()));
    const result = die(t, victim, killer, WILDERNESS(), { skulled: true });
    assert.deepEqual(result.kept, [], "a preset copy is deleted");
    assert.deepEqual(result.floor, [], "a preset copy leaves the killer nothing");
    assert.equal(partsOf(preset(make())), null, "asked directly, a preset copy has no parts");
    assert.equal(lostOnPreview(preset(make())), false, "and the preview does not call it lost to the killer");
  }
  {
    const item = make();
    assert.equal(partsOf(item, { isPlayerBot: () => true }), null, "a bot's copy is not split");
    same([item], "a bot's copy is left as it is");
    const bot = actor(t), killer = actor(t);
    bot.setPlayerBot(true);
    bot.getInventory().setItem(0, make());
    const result = die(t, bot, killer, WILDERNESS(), { skulled: true });
    same(result.kept, "a bot's own death leaves its copy as it is");
    assert.deepEqual(forKiller(result), [], "and gives its killer nothing of it");
  }
}

// --- Crystal equipment ---------------------------------------------------------------------------------------------
// Wiki, Blade of Saeldor: "On unprotected death in PvP, the inactive blade is dropped, and all shards used to charge it
// will be lost." Bow of Faerdhinen: "On unprotected death in PvP, the inactive bow is dropped, and all shards used to
// charge it will be lost. In a PvM or protected on PvP death, all current charges are kept." The (c) pages: "While
// untradeable, the [weapon] can be uncharged, but the crystal shards used to upgrade it will not be returned."

const bladeCharges = () => withMeta(I.BLADE_OF_SAELDOR, "blade-of-saeldor:charges", { charges: 4321, used: 777 });
const bowCharges = () => withMeta(I.BOW_OF_FAERDHINEN, "bow-of-faerdhinen:charges", { charges: 19999, used: 3 });

test("lost: a charged Blade of Saeldor and Bow of Faerdhinen drop for the killer inactive, their charges gone", (t) => {
  for (const at of [WILDERNESS(), CRATER()]) {
    lost(t, () => [bladeCharges(), bowCharges()],
      [plain(I.BLADE_OF_SAELDOR_INACTIVE_), plain(I.BOW_OF_FAERDHINEN_INACTIVE_)], [], at);
  }
  assert.equal(new core.Item(I.BLADE_OF_SAELDOR_INACTIVE_, 1).isPlayerTradeable(), true);
  assert.equal(new core.Item(I.BOW_OF_FAERDHINEN_INACTIVE_, 1).isPlayerTradeable(), true);
  assert.equal(lostOnPreview(bladeCharges()), true);
  assert.equal(lostOnPreview(bowCharges()), true);
});

test("lost: a corrupted blade or bow, in every colour, drops for the killer as the inactive weapon", (t) => {
  lost(t, () => [plain(I.BLADE_OF_SAELDOR_C_), plain(I.BOW_OF_FAERDHINEN_C_)],
    [plain(I.BLADE_OF_SAELDOR_INACTIVE_), plain(I.BOW_OF_FAERDHINEN_INACTIVE_)]);
  const names = [...core.CacheDefinitions.getObjNames()];
  for (const [family, inactive] of [["blade_of_saeldor_infinite", I.BLADE_OF_SAELDOR_INACTIVE_], ["bow_of_faerdhinen_infinite", I.BOW_OF_FAERDHINEN_INACTIVE_]]) {
    const colours = names.filter(([, name]) => name === family || (name.startsWith(`${family}_`) && !name.endsWith("_dummy"))).map(([id]) => id);
    assert.ok(colours.length >= 8, `${family} has its eight colours: ${colours.length}`);
    for (const id of colours) {
      assert.match(new core.Item(id, 1).getDefinition().getName(), /\(c\)$/);
      assert.deepEqual(exact(partsOf(plain(id))), exact([plain(inactive)]), `${id}`);
      assert.equal(lostOnPreview(plain(id)), true);
    }
  }
  // The cache's Last Man Standing bow of the same name is a tradeable item of its own and is not asked about.
  assert.equal(partsOf(plain(obj("br_bow_of_faerdhinen"))), null);
});

test("kept: a charged blade and bow, and a corrupted bow, come through with their charges", (t) => {
  keptCases(t, bladeCharges);
  keptCases(t, bowCharges);
  keptCases(t, () => plain(obj("bow_of_faerdhinen_infinite_ithell")));
});

// Wiki, Crystal helm / body / legs: "If lost to another player in a dangerous PvP death, the crystal [piece] will revert
// to [a / 3 / 2] crystal armour seed[s], which will then be dropped for the killer. All crystal shards will be lost
// should this happen. If [it] is protected on death, [it] will be kept, and will not lose any charges".

const armour = (id, charges = 1234) => withMeta(id, "crystal-armour", { charges });

test("lost: crystal armour reverts to its crystal armour seeds for the killer: helm 1, body 3, legs 2", (t) => {
  const seeds = (count) => Array.from({ length: count }, () => plain(I.CRYSTAL_ARMOUR_SEED));
  lost(t, () => [armour(I.CRYSTAL_HELM)], seeds(1));
  lost(t, () => [armour(I.CRYSTAL_BODY)], seeds(3));
  lost(t, () => [armour(I.CRYSTAL_LEGS)], seeds(2), [], CRATER());
  // Worn, as a set, with an inactive piece and a recoloured one: six seeds and nothing else.
  const victim = actor(t), killer = actor(t);
  victim.getEquipment().setItem(core.Equipment.HEAD_SLOT, plain(I.CRYSTAL_HELM_INACTIVE_));
  victim.getEquipment().setItem(core.Equipment.BODY_SLOT, armour(obj("crystal_chestplate_hefin"), 20000));
  victim.getEquipment().setItem(core.Equipment.LEG_SLOT, armour(I.CRYSTAL_LEGS, 1));
  const result = die(t, victim, killer, WILDERNESS(), { skulled: true });
  assert.deepEqual(exact(forKiller(result)), exact(seeds(6)));
  assert.deepEqual(result.kept, []);
  assert.equal(new core.Item(I.CRYSTAL_ARMOUR_SEED, 1).isPlayerTradeable(), true);
});

test("lost: every colour of every crystal armour piece, active or inactive, gives the seeds its Revert gives", () => {
  const Armour = require("../plugins/items/CrystalArmour.plugin")._test;
  let pieces = 0;
  for (const [id, name] of core.CacheDefinitions.getObjNames()) {
    if (!/^crystal_(helmet|chestplate|platelegs)(_inactive)?(_[a-z]+)?$/.test(name) || /_(basic|attuned|perfected)$/.test(name)) continue;
    const piece = Armour.pieceOf(id);
    assert.ok(piece, `${name} is a crystal armour piece`);
    assert.deepEqual(exact(partsOf(armour(id))), exact(Array.from({ length: piece.seeds }, () => plain(I.CRYSTAL_ARMOUR_SEED))), name);
    assert.equal(lostOnPreview(armour(id)), true, name);
    pieces++;
  }
  assert.ok(pieces >= 3 * 2 * 9, `every colour was asked: ${pieces}`);
});

test("kept: crystal armour comes through with its charges and its colour", (t) => {
  keptCases(t, () => armour(I.CRYSTAL_BODY));
  keptCases(t, () => armour(obj("crystal_helmet_hefin"), 19000));
  keptCases(t, () => plain(I.CRYSTAL_LEGS_INACTIVE_));
});

// Wiki, Crystal equipment: "Upon death in the Wilderness, the killer will receive the seed form of the crystal
// equipment." Crystal bow, Crystal shield, Crystal halberd (Changes): "Crystal equipment now reverts to a seed when
// dropped on death."

test("lost: a crystal bow, shield and halberd each revert to a crystal weapon seed for the killer", (t) => {
  const seed = () => plain(I.CRYSTAL_WEAPON_SEED);
  lost(t, () => [withMeta(I.CRYSTAL_BOW, "crystal-bow:shots-in-stage", 17), plain(I.CRYSTAL_SHIELD), withMeta(I.CRYSTAL_HALBERD, "crystal-halberd", { charges: 9 })],
    [seed(), seed(), seed()]);
  lost(t, () => [plain(I.CRYSTAL_BOW_INACTIVE_), plain(I.CRYSTAL_SHIELD_INACTIVE_), plain(I.CRYSTAL_HALBERD_INACTIVE_)],
    [seed(), seed(), seed()], [], CRATER());
  // The staged forms the Roving Elves reward still gives.
  lost(t, () => [plain(I.NEW_CRYSTAL_BOW), plain(I.CRYSTAL_BOW_7_10), plain(I.NEW_CRYSTAL_SHIELD)], [seed(), seed(), seed()]);
  assert.equal(seed().isPlayerTradeable(), true);
});

test("lost: every crystal bow the engine knows, and every listed shield and halberd, is lost as a seed", () => {
  const Death = require("../plugins/items/CrystalEquipmentDeath.plugin")._test;
  const { CRYSTAL_BOW_ALL_WEAPON_IDS } = require("../dist/game/content/combat/ranged/CrystalBow");
  const Halberd = require("../plugins/items/CrystalHalberd.plugin")._test;
  const halberds = [...Halberd.buildIdMaps(I)].flat();
  for (const id of [...CRYSTAL_BOW_ALL_WEAPON_IDS, ...halberds]) {
    assert.deepEqual(exact(partsOf(plain(id))), exact([plain(I.CRYSTAL_WEAPON_SEED)]), `${id} ${new core.Item(id, 1).getDefinition().getName()}`);
    assert.equal(lostOnPreview(plain(id)), true);
  }
  for (const [id, to] of Death.lostAs) {
    assert.equal(new core.Item(id, 1).isPlayerTradeable(), false, `${id} is an untradeable form`);
    assert.equal(new core.Item(to, 1).isPlayerTradeable(), true, `${to} is what a killer can pick up`);
  }
  // The Gauntlet's own equipment is not crystal equipment a death outside it meets.
  for (const name of ["CRYSTAL_BOW_BASIC_", "CRYSTAL_HALBERD_PERFECTED_", "CRYSTAL_HELM_ATTUNED_"]) assert.equal(partsOf(plain(I[name])), null, name);
});

test("kept: a crystal bow, shield and halberd come through as they were", (t) => {
  keptCases(t, () => withMeta(I.CRYSTAL_BOW, "crystal-bow:shots-in-stage", 17));
  keptCases(t, () => plain(I.CRYSTAL_SHIELD));
  keptCases(t, () => withMeta(I.CRYSTAL_HALBERD, "crystal-halberd", { charges: 9 }));
});

// Wiki, Crystal axe / pickaxe / harpoon: "A dangerous death in PvP causes the crystal [tool] to revert to a dragon
// [tool], which will then be dropped for the killer. All crystal shards will be lost should this happen."

test("lost: a crystal axe, pickaxe, harpoon and felling axe drop for the killer as the dragon tool, and no tool seed", (t) => {
  lost(t, () => [withMeta(I.CRYSTAL_AXE, "crystal-axe", { charges: 5000 }), withMeta(I.CRYSTAL_PICKAXE, "crystal-pickaxe", { charges: 5000 }),
    withMeta(I.CRYSTAL_HARPOON, "crystal-harpoon", { charges: 5000 }), plain(I.CRYSTAL_FELLING_AXE)],
  [plain(I.DRAGON_AXE), plain(I.DRAGON_PICKAXE), plain(I.DRAGON_HARPOON), plain(I.DRAGON_FELLING_AXE)]);
  lost(t, () => [plain(I.CRYSTAL_AXE_INACTIVE_), plain(I.CRYSTAL_PICKAXE_INACTIVE_), plain(I.CRYSTAL_HARPOON_INACTIVE_), plain(I.CRYSTAL_FELLING_AXE_INACTIVE_)],
    [plain(I.DRAGON_AXE), plain(I.DRAGON_PICKAXE), plain(I.DRAGON_HARPOON), plain(I.DRAGON_FELLING_AXE)], [], CRATER());
  for (const id of [I.CRYSTAL_AXE, I.CRYSTAL_HARPOON_INACTIVE_]) assert.equal(lostOnPreview(plain(id)), true);
});

test("kept: the crystal tools come through with their charges", (t) => {
  keptCases(t, () => withMeta(I.CRYSTAL_AXE, "crystal-axe", { charges: 5000 }));
  keptCases(t, () => withMeta(I.CRYSTAL_PICKAXE, "crystal-pickaxe", { charges: 5000 }));
  keptCases(t, () => withMeta(I.CRYSTAL_HARPOON, "crystal-harpoon", { charges: 5000 }));
  keptCases(t, () => plain(I.CRYSTAL_FELLING_AXE));
});

// --- Tomes ---------------------------------------------------------------------------------------------------------
// Wiki, Tome of Fire: "If lost to another player in a dangerous PVP death, all charges inside will be converted into
// pages and dropped for the killer alongside the empty tome." Items Kept on Death, "Chargable items": "Dropped to the
// PKer as the tradeable uncharged item, and drops the items that would result from uncharging the item to the PKer too."

const tome = (id, charges, pageId) => withMeta(id, "elemental-tomes", { charges, pageId });

test("lost: a charged tome drops for the killer empty, with the whole pages that were in it and no more", (t) => {
  // 1,234 charges are 61 pages and 14 charges of a 62nd, which is gone, as Remove all pages loses it.
  lost(t, () => [tome(I.TOME_OF_FIRE, 1234, I.BURNT_PAGE)], [plain(I.TOME_OF_FIRE_EMPTY_), plain(I.BURNT_PAGE, 61)]);
  lost(t, () => [tome(I.TOME_OF_WATER, 20000, I.SOAKED_PAGE)], [plain(I.TOME_OF_WATER_EMPTY_), plain(I.SOAKED_PAGE, 1000)], [], CRATER());
  lost(t, () => [tome(I.TOME_OF_EARTH, 40, I.SOILED_PAGE)], [plain(I.TOME_OF_EARTH_EMPTY_), plain(I.SOILED_PAGE, 2)]);
  // Searing pages come back as searing pages.
  lost(t, () => [tome(I.TOME_OF_FIRE, 200, I.SEARING_PAGE)], [plain(I.TOME_OF_FIRE_EMPTY_), plain(I.SEARING_PAGE, 10)]);
  for (const id of [I.TOME_OF_FIRE_EMPTY_, I.TOME_OF_WATER_EMPTY_, I.TOME_OF_EARTH_EMPTY_, I.BURNT_PAGE, I.SOAKED_PAGE, I.SOILED_PAGE, I.SEARING_PAGE]) {
    assert.equal(new core.Item(id, 1).isPlayerTradeable(), true, `${id} trades`);
  }
  assert.equal(lostOnPreview(tome(I.TOME_OF_FIRE, 1234, I.BURNT_PAGE)), true);
});

test("lost: a tome with less than a page left, or with no count at all, gives the empty tome and no pages", (t) => {
  lost(t, () => [tome(I.TOME_OF_EARTH, 19, I.SOILED_PAGE)], [plain(I.TOME_OF_EARTH_EMPTY_)]);
  lost(t, () => [plain(I.TOME_OF_FIRE)], [plain(I.TOME_OF_FIRE_EMPTY_)]);
  // An empty tome is a tradeable item and is lost as it is.
  lost(t, () => [plain(I.TOME_OF_WATER_EMPTY_)], [plain(I.TOME_OF_WATER_EMPTY_)]);
  assert.equal(partsOf(plain(I.TOME_OF_WATER_EMPTY_)), null);
});

test("kept: a charged tome comes through with its pages", (t) => {
  keptCases(t, () => tome(I.TOME_OF_FIRE, 1234, I.BURNT_PAGE));
  keptCases(t, () => tome(I.TOME_OF_WATER, 20000, I.SOAKED_PAGE));
  keptCases(t, () => tome(I.TOME_OF_EARTH, 19, I.SOILED_PAGE));
});

// --- Dragonfire shield, Dragonfire ward, Ancient wyvern shield -----------------------------------------------------
// Wiki, Items Kept on Death: "The dragonfire shield, dragonfire ward and ancient wyvern shield will lose their charges
// if not protected." Dragonfire ward: "if dropped on death in an unsafe environment, when recovered, the dragonfire
// ward will be completely uncharged."

const shieldCharges = (id, charges) => withMeta(id, "dragonfire-shield", charges);

test("lost: a charged dragonfire shield, ward and wyvern shield drop for the killer uncharged", (t) => {
  lost(t, () => [shieldCharges(I.DRAGONFIRE_SHIELD, 37), shieldCharges(I.DRAGONFIRE_WARD, 1), shieldCharges(I.ANCIENT_WYVERN_SHIELD, 49)],
    [plain(I.DRAGONFIRE_SHIELD_2), plain(I.DRAGONFIRE_WARD_2), plain(I.ANCIENT_WYVERN_SHIELD_2)]);
  // A charged shield with no saved count is a full one: it is emptied the same.
  lost(t, () => [plain(I.DRAGONFIRE_SHIELD)], [plain(I.DRAGONFIRE_SHIELD_2)], [], CRATER());
  for (const id of [I.DRAGONFIRE_SHIELD_2, I.DRAGONFIRE_WARD_2, I.ANCIENT_WYVERN_SHIELD_2]) {
    assert.equal(new core.Item(id, 1).isPlayerTradeable(), true);
    assert.equal(partsOf(plain(id)), null, "an uncharged shield is lost as any tradeable item");
  }
  assert.equal(lostOnPreview(shieldCharges(I.DRAGONFIRE_WARD, 1)), true);
});

test("kept: the charged shields come through with their charges", (t) => {
  keptCases(t, () => shieldCharges(I.DRAGONFIRE_SHIELD, 37));
  keptCases(t, () => shieldCharges(I.DRAGONFIRE_WARD, 1));
  keptCases(t, () => shieldCharges(I.ANCIENT_WYVERN_SHIELD, 49));
});

// --- Amulet of blood fury, Neitiznot faceguard -----------------------------------------------------------------------
// Wiki, Amulet of blood fury: "When killed by another player and the amulet of blood fury is not one of the items
// protected on death, the amulet is converted to a normal amulet of fury; the blood shard and any remaining charges
// are lost." Neitiznot faceguard: "If lost in PvP, it will revert to the normal helm of Neitiznot and basilisk jaw."

const bloodFury = () => withMeta(I.AMULET_OF_BLOOD_FURY, "blood-fury", { charges: 12345 });

test("lost: an amulet of blood fury drops for the killer as an amulet of fury; no blood shard comes out of it", (t) => {
  for (const at of [WILDERNESS(), CRATER()]) {
    const result = lost(t, () => [bloodFury()], [plain(I.AMULET_OF_FURY)], [], at);
    assert.ok(!result.floor.some(({ item }) => item.getId() === I.BLOOD_SHARD));
  }
  assert.equal(lostOnPreview(bloodFury()), true);
});

test("lost: a Neitiznot faceguard drops for the killer as the helm of Neitiznot and the basilisk jaw", (t) => {
  for (const at of [WILDERNESS(), CRATER()]) lost(t, () => [plain(I.NEITIZNOT_FACEGUARD)], [plain(I.HELM_OF_NEITIZNOT), plain(I.BASILISK_JAW)], [], at);
  assert.equal(new core.Item(I.HELM_OF_NEITIZNOT, 1).isPlayerTradeable(), true);
  assert.equal(new core.Item(I.BASILISK_JAW, 1).isPlayerTradeable(), true);
  assert.equal(lostOnPreview(plain(I.NEITIZNOT_FACEGUARD)), true);
});

test("kept: the amulet of blood fury and the faceguard come through whole", (t) => {
  keptCases(t, bloodFury);
  keptCases(t, () => plain(I.NEITIZNOT_FACEGUARD));
});

// --- Imbued items ----------------------------------------------------------------------------------------------------
// Wiki, Magic shortbow (i): "On death, players who lose the magic shortbow (i) will drop a regular magic shortbow for
// the person who killed them"; "there's no way to reclaim the scroll".

test("lost: a magic shortbow (i) drops for the killer as a magic shortbow, and its scroll is nobody's", (t) => {
  for (const at of [WILDERNESS(), CRATER()]) {
    const result = lost(t, () => [plain(I.MAGIC_SHORTBOW_I_)], [plain(I.MAGIC_SHORTBOW)], [], at);
    assert.ok(![...result.floor.map(({ item }) => item), ...result.kept].some((item) => item.getId() === I.MAGIC_SHORTBOW_SCROLL));
  }
  assert.equal(lostOnPreview(plain(I.MAGIC_SHORTBOW_I_)), true);
});

test("kept: a magic shortbow (i) comes through imbued", (t) => {
  keptCases(t, () => plain(I.MAGIC_SHORTBOW_I_));
});

// Wiki, Berserker ring (i) and the other imbued rings: "If not protected, dying to another player will cause the
// imbued ring to lose its imbued status, but the player will be reimbursed the Nightmare Zone points, Zeal Tokens or
// Scroll of imbuing to re-imbue it via the aforementioned methods. Dying to a monster will not remove its imbued
// effect."

const RING_NAMES = ["seer_ring", "ranger_ring", "warrior_ring", "berzerker_ring", "heavy_ring", "sharp_ring", "rotg", "zenyte_ring_enchanted", "granite_ring"];
const nmzPoints = (player) => require("../plugins/minigames/nightmarezone/Common.NightmareZone").points(player);
const zealTokens = (player) => require("../plugins/minigames/soulwars/Common.SoulWars").getVarp(player, "zeal_tokens");

test("lost: a Nightmare Zone imbued ring drops for the killer as the plain ring, and the victim gets the points back", (t) => {
  const { imbuePrice } = require("../plugins/minigames/nightmarezone/Rewards.NightmareZone");
  for (const name of RING_NAMES) {
    const base = obj(name), imbued = obj(`nzone_${name}`);
    assert.match(new core.Item(imbued, 1).getDefinition().getName(), /\(i\)$/);
    const { victim, killer } = lost(t, () => [plain(imbued)], [plain(base)]);
    const price = imbuePrice(base, victim);
    assert.ok(price >= 500_000, `${name} has a price: ${price}`);
    assert.equal(nmzPoints(victim), price, `${name}: the whole price back, once`);
    assert.equal(zealTokens(victim), 0);
    assert.equal(nmzPoints(killer), 0, "the killer gets none of it");
    assert.equal(new core.Item(base, 1).isPlayerTradeable(), true);
    assert.equal(lostOnPreview(plain(imbued)), true);
  }
  const { victim } = lost(t, () => [plain(I.BERSERKER_RING_I_), plain(I.RING_OF_SUFFERING_I_), plain(I.GRANITE_RING_I_)],
    [plain(I.BERSERKER_RING), plain(I.RING_OF_SUFFERING), plain(I.GRANITE_RING)], [], CRATER());
  assert.equal(nmzPoints(victim), 650_000 + 725_000 + 500_000);
});

test("lost: a Soul Wars imbued ring refunds its Zeal Tokens, an Emir's Arena one its scroll of imbuing", (t) => {
  const costs = { seer_ring: 260, ranger_ring: 260, warrior_ring: 260, berzerker_ring: 260, heavy_ring: 260, sharp_ring: 260, rotg: 260, zenyte_ring_enchanted: 300, granite_ring: 200 };
  for (const name of RING_NAMES) {
    const base = obj(name);
    const soulWars = lost(t, () => [plain(obj(`sw_${name}`))], [plain(base)]);
    assert.equal(zealTokens(soulWars.victim), costs[name], `${name}: the Zeal Tokens back`);
    assert.equal(nmzPoints(soulWars.victim), 0);
    const arena = lost(t, () => [plain(obj(`pvpa_${name}`))], [plain(base)], [plain(I.SCROLL_OF_IMBUING)]);
    assert.equal(zealTokens(arena.victim), 0);
    assert.equal(nmzPoints(arena.victim), 0);
    assert.equal(lostOnPreview(plain(obj(`sw_${name}`))), true);
    assert.equal(lostOnPreview(plain(obj(`pvpa_${name}`))), true);
  }
  assert.equal(new core.Item(I.SCROLL_OF_IMBUING, 1).isPlayerTradeable(), false, "the scroll stays the victim's");
});

test("lost: points that would pass the Nightmare Zone's cap come back as a scroll of imbuing instead", (t) => {
  const Nmz = require("../plugins/minigames/nightmarezone/Common.NightmareZone");
  const victim = actor(t), killer = actor(t);
  Nmz.addPoints(victim, Nmz.data.pointsCap);
  const full = nmzPoints(victim);
  victim.getInventory().setItem(0, plain(I.BERSERKER_RING_I_));
  const result = die(t, victim, killer, WILDERNESS(), { skulled: true });
  assert.deepEqual(exact(forKiller(result)), exact([plain(I.BERSERKER_RING)]));
  assert.deepEqual(exact(result.kept), exact([plain(I.SCROLL_OF_IMBUING)]));
  assert.equal(nmzPoints(victim), full);
});

// Wiki, Ring of suffering: "Charges are not lost upon death. While charged, the ring is untradeable."

test("lost: a Ring of suffering (ri) loses its imbue, refunded, and stays with the victim as the (r) with its recoil charges", (t) => {
  const charged = (id) => withMeta(id, "ring-of-suffering:charges", 4240);
  const nmz = lost(t, () => [charged(I.RING_OF_SUFFERING_RI_)], [], [charged(I.RING_OF_SUFFERING_R_)]);
  assert.equal(nmzPoints(nmz.victim), 725_000);
  const soulWars = lost(t, () => [charged(obj("sw_zenyte_ring_enchanted_recoil"))], [], [charged(I.RING_OF_SUFFERING_R_)]);
  assert.equal(zealTokens(soulWars.victim), 300);
  lost(t, () => [charged(obj("pvpa_zenyte_ring_enchanted_recoil"))], [], [charged(I.RING_OF_SUFFERING_R_), plain(I.SCROLL_OF_IMBUING)]);
  assert.equal(lostOnPreview(charged(I.RING_OF_SUFFERING_RI_)), false, "nothing of it goes to the killer");
  // The plain recoil-charged ring is as it was before: an untradeable that stays.
  lost(t, () => [charged(I.RING_OF_SUFFERING_R_)], [], [charged(I.RING_OF_SUFFERING_R_)]);
});

test("kept: an imbued ring comes through imbued, and nothing is refunded for it", (t) => {
  const refunds = [];
  const watch = (name) => PM.createApi("ChargedEquipmentTest").onCustomEvent(name, (request) => refunds.push([name, request.refunded]));
  watch("nightmare-zone:refund-imbue");
  watch("soul-wars:refund-imbue");
  keptCases(t, () => plain(I.BERSERKER_RING_I_));
  keptCases(t, () => plain(obj("sw_rotg")));
  keptCases(t, () => plain(obj("pvpa_granite_ring")));
  keptCases(t, () => withMeta(I.RING_OF_SUFFERING_RI_, "ring-of-suffering:charges", 4240));
  assert.deepEqual(refunds, [], "no shop was asked for a refund");
});

// Wiki, Salve amulet(ei): "As the amulet is untradeable and does not break, it will always be kept on PvP death in the
// Wilderness." The Salve amulet (i) page has no death rule, and its plain amulet is untradeable too.

test("kept: an imbued Salve amulet stays with the victim on a PvP death, imbued, whichever shop imbued it", (t) => {
  for (const name of ["nzone_salve_amulet", "nzone_salve_amulet_e", "sw_salve_amulet", "sw_salve_amulet_e", "pvpa_salve_amulet", "pvpa_salve_amulet_e"]) {
    const id = obj(name);
    assert.match(new core.Item(id, 1).getDefinition().getName(), /^Salve amulet\(e?i\)$/);
    const { victim } = lost(t, () => [plain(id)], [], [plain(id)]);
    assert.equal(nmzPoints(victim), 0);
    assert.equal(zealTokens(victim), 0);
    assert.equal(partsOf(plain(id), victim), null);
    assert.equal(lostOnPreview(plain(id)), false);
  }
  assert.equal(new core.Item(I.SALVE_AMULET, 1).isPlayerTradeable(), false);
  assert.equal(new core.Item(I.SALVE_AMULET_E_, 1).isPlayerTradeable(), false);
});

// --- Locked and ornamented breakable items ---------------------------------------------------------------------------
// Wiki, Items Kept on Death, "Locked items with tradeable ornament kit" (Elite void top (l)(or)): "The victim keeps it
// in their inventory in broken form and keeps its (l) status. The PKer receives the tradeable ornament kit and item's
// repair cost"; above level 20 Wilderness "in mangled form ... The PKer receives the tradeable ornament kit and Trouver
// cost (500,000)". Fighter torso (or): "it will remain in the player's inventory; however, the item will be in a
// broken, unusable state ... The ornament kit will be placed in their gravestone"; above level 20, unlocked, "it will be
// converted to coins", locked, "in a mangled, unusable state".

const DEEP_WILDERNESS = () => new core.Location(3100, 3760, 0);
const named = (name) => {
  const id = require("../plugins/items/brokenitems/Common.BrokenItems").idOf(name);
  assert.ok(Number.isInteger(id), `the cache has ${name}`);
  return id;
};
const coins = (amount) => plain(I.COINS, amount);

test("lost: a locked void piece with its kit loses the kit to the killer and stays, locked, broken or mangled", (t) => {
  const kit = named("Shattered relics void ornament kit");
  assert.equal(new core.Item(kit, 1).isPlayerTradeable(), true);
  lost(t, () => [plain(named("Void knight top (l)(or)"))], [plain(kit), coins(180_000)], [plain(named("Void knight top (l) (broken)"))]);
  lost(t, () => [plain(named("Elite void robe (l)(or)"))], [plain(kit), coins(250_000)], [plain(named("Elite void robe (l) (broken)"))], CRATER());
  lost(t, () => [plain(named("Void mage helm (l)(or)"))], [plain(kit), coins(500_000)], [plain(named("Void mage helm (l) (mangled)"))], DEEP_WILDERNESS());
  // Every locked void piece with a kit is known.
  const Ornamented = require("../plugins/items/brokenitems/Ornamented.BrokenItems");
  for (const piece of ["Void knight top", "Void knight robe", "Void knight gloves", "Elite void top", "Elite void robe", "Void mage helm", "Void ranger helm", "Void melee helm"]) {
    assert.deepEqual(Ornamented.underKit(plain(named(`${piece} (l)(or)`))), { base: named(`${piece} (l)`), kit }, piece);
  }
});

test("lost: a Fighter torso (or) breaks, is lost or is mangled as the torso is, and its Bounty Hunter kit stays the victim's", (t) => {
  const kit = I.BOUNTY_HUNTER_ORNAMENT_KIT;
  assert.equal(new core.Item(kit, 1).isPlayerTradeable(), false);
  lost(t, () => [plain(I.FIGHTER_TORSO_OR_)], [coins(150_000)], [plain(named("Fighter torso (broken)")), plain(kit)]);
  // Above level 20 Wilderness an unlocked torso is gone, its repair cost paid to the killer.
  lost(t, () => [plain(I.FIGHTER_TORSO_OR_)], [coins(150_000)], [plain(kit)], DEEP_WILDERNESS());
  lost(t, () => [plain(I.FIGHTER_TORSO_L_OR_)], [coins(150_000)], [plain(named("Fighter torso (l) (broken)")), plain(kit)]);
  lost(t, () => [plain(I.FIGHTER_TORSO_L_OR_)], [coins(500_000)], [plain(named("Fighter torso (l) (mangled)")), plain(kit)], DEEP_WILDERNESS());
});

// Wiki, (l): items locked before the Trouver rework "will behave like their regular counterparts".
test("lost: a Rune defender (l)(t) loses its kit and breaks as a Rune defender (t) does", (t) => {
  lost(t, () => [plain(named("Rune defender (l)(t)"))], [plain(I.RUNE_DEFENDER_ORNAMENT_KIT), coins(35_000)], [plain(named("Rune defender (broken)"))]);
});

test("kept: a locked piece with its kit and a Fighter torso (or) come through whole", (t) => {
  keptCases(t, () => plain(named("Elite void top (l)(or)")));
  keptCases(t, () => plain(I.FIGHTER_TORSO_OR_));
  keptCases(t, () => plain(I.FIGHTER_TORSO_L_OR_));
});
