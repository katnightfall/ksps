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
