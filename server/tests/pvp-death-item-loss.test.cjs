// Run after `yarn build`: node --test tests/pvp-death-item-loss.test.cjs
//
// Upstream issue #6002, "PvP + Bounty Hunter: not losing items on death". What a death to another player takes and what
// it leaves, on the real engine: every plugin loaded, real Players, the real PlayerDeathTask.dropItems; only the ground
// item registration and the grave hook are watched.
//
// Wiki, Items Kept on Death (Mechanics): tradeable items are "Dropped to the PKer"; a tradeable item with a tradeable
// ornament kit is "Dropped to the PKer as the tradeable, non-ornamented item. Also drops the tradeable ornament kit";
// a Volcanic abyssal whip is "Dropped to the PKer as base item, recolour is destroyed"; a Rune defender (t) "Drops the
// tradeable ornament kit to the PKer", stays with the victim broken, "and the PKer receives the item's repair cost".
// Bounty hunter ornament kit / Elder chaos robes ornament kit: "the item will be lost to the killer but the kit will be
// sent to the gravestone". Abyssal tentacle: "If the abyssal tentacle is not protected upon death, it will fully degrade
// into a kraken tentacle". Bounty Hunter: a death in the crater is "the standard item loss to PvP death".
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

let core, I, Kits, Equipment;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  I = core.ItemIdentifiers;
  Kits = require("../plugins/items/OrnamentKits.plugin")._test;
  Equipment = require("../plugins/items/BountyHunterEquipment.plugin")._test;
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

let next = 9700;
function actor(t) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel));
  p.setIndex(next++);
  p.setUsername("pdl" + p.getIndex());
  p.setRegistered(true);
  p.setAttribute("bot-skip-persistence", true);
  p.needsPlacement = false;
  t.after(() => { p.setRegistered(false); core.TaskManager.cancelTasks(p); });
  return p;
}

// Level 10 and level 30 Wilderness, a town, and Daimon's Crater's arena: its east, and its west, whose map rows the
// Wilderness level strip also covers (Wilderness.levelAt answers 57 there).
const WILDERNESS = () => new core.Location(3100, 3600, 0);
const DEEP_WILDERNESS = () => new core.Location(3100, 3760, 0);
const LUMBRIDGE = () => new core.Location(3222, 3218, 0);
const CRATER_EAST = () => new core.Location(3470, 4000, 0);
const CRATER_WEST = () => new core.Location(3340, 4000, 0);

/**
 * The victim dies at `at` to `killer` (null: a monster). `skulled` and `protectItem` set the kept count as the game
 * does. Returns what reached the floor ([id, amount, for]), what the grave hook was offered, and what came back.
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
    floor.push([item.getId(), item.getAmount(), owner === killer ? "killer" : owner === victim ? "victim" : "other"]);
    return register.call(core.ItemOnGroundManager, owner, item, location, ...rest);
  });
  const grave = [];
  const emitDrops = PM.emitPlayerDeathDrops;
  t.mock.method(PM, "emitPlayerDeathDrops", (event) => {
    grave.push(...[...event.items, ...event.untradeables].map((item) => item.getId()));
    return emitDrops.call(PM, event);
  });
  const kept = PlayerDeathTask.dropItems(victim, killer, at).map((item) => item.getId());
  core.ItemOnGroundManager.registerLocation.mock.restore();
  PM.emitPlayerDeathDrops.mock.restore();
  return { floor, grave, kept };
}

const carry = (player, ids) => ids.forEach((id, slot) => player.getInventory().setItem(slot, new core.Item(id, 1)));
const forKiller = ({ floor }) => floor.filter(([, , owner]) => owner === "killer").map(([id]) => id).sort((a, b) => a - b);
const sorted = (ids) => [...ids].sort((a, b) => a - b);
const coinsForKiller = ({ floor }) => floor.filter(([id, , owner]) => id === I.COINS && owner === "killer").reduce((sum, [, amount]) => sum + amount, 0);

// --- The items the issue names -----------------------------------------------------------------------------------

test("the issue's plain tradeable items all drop for the killer on a skulled PvP death, in the Wilderness and in the crater", (t) => {
  const named = () => [I.VOIDWAKER, I.NIGHTMARE_STAFF, I.REGEN_BRACELET, I.ARANEA_BOOTS, I.ABYSSAL_WHIP];
  for (const at of [WILDERNESS(), CRATER_EAST()]) {
    const victim = actor(t), killer = actor(t);
    carry(victim, named());
    const result = die(t, victim, killer, at, { skulled: true });
    assert.deepEqual(result.kept, [], "a skulled player keeps nothing");
    assert.deepEqual(forKiller(result), sorted(named()));
    assert.equal(victim.getInventory().getValidItems().length, 0);
  }
});

test("unskulled, the three most valuable of them are kept and the rest drop; Protect Item keeps a fourth", (t) => {
  const named = () => [I.VOIDWAKER, I.NIGHTMARE_STAFF, I.REGEN_BRACELET, I.ARANEA_BOOTS, I.ABYSSAL_WHIP];
  const byValue = () => named().sort((a, b) => PlayerDeathTask.keepValue(new core.Item(b, 1)) - PlayerDeathTask.keepValue(new core.Item(a, 1)));
  for (const [protectItem, count] of [[false, 3], [true, 4]]) {
    const victim = actor(t), killer = actor(t);
    carry(victim, named());
    const result = die(t, victim, killer, WILDERNESS(), { protectItem });
    assert.deepEqual(sorted(result.kept), sorted(byValue().slice(0, count)), `the ${count} most valuable are kept`);
    assert.deepEqual(forKiller(result), sorted(byValue().slice(count)), "the rest drop for the killer");
  }
});

test("skulled with Protect Item, only the most valuable item is kept", (t) => {
  const victim = actor(t), killer = actor(t);
  carry(victim, [I.ABYSSAL_WHIP, I.VOIDWAKER, I.REGEN_BRACELET]);
  const result = die(t, victim, killer, WILDERNESS(), { skulled: true, protectItem: true });
  assert.deepEqual(result.kept, [I.VOIDWAKER]);
  assert.deepEqual(forKiller(result), sorted([I.ABYSSAL_WHIP, I.REGEN_BRACELET]));
});

// --- Ornamented and recoloured items -----------------------------------------------------------------------------

test("an ornamented tradeable item is lost to the killer as the plain item, with its tradeable kit", (t) => {
  const victim = actor(t), killer = actor(t);
  carry(victim, [I.ARMADYL_GODSWORD_OR_, I.ABYSSAL_WHIP_OR_]);
  const result = die(t, victim, killer, WILDERNESS(), { skulled: true });
  assert.deepEqual(result.kept, [], "nothing comes back to the victim");
  assert.deepEqual(forKiller(result), sorted([I.ARMADYL_GODSWORD, I.ARMADYL_GODSWORD_ORNAMENT_KIT, I.ABYSSAL_WHIP, I.SHATTERED_RELICS_VARIETY_ORNAMENT_KIT]));
});

test("Elder chaos (or) robes and a Dragon scimitar (cr) are lost to the killer plain; the Bounty Hunter kits stay the victim's", (t) => {
  const victim = actor(t), killer = actor(t);
  carry(victim, [I.ELDER_CHAOS_TOP_OR_, I.ELDER_CHAOS_ROBE_OR_, I.ELDER_CHAOS_HOOD_OR_, I.DRAGON_SCIMITAR_CR_]);
  const result = die(t, victim, killer, WILDERNESS(), { skulled: true });
  assert.deepEqual(forKiller(result), sorted([I.ELDER_CHAOS_TOP, I.ELDER_CHAOS_ROBE, I.ELDER_CHAOS_HOOD, I.DRAGON_SCIMITAR]));
  assert.deepEqual(sorted(result.kept), sorted([I.ELDER_CHAOS_ROBES_ORNAMENT_KIT, I.ELDER_CHAOS_ROBES_ORNAMENT_KIT,
    I.ELDER_CHAOS_ROBES_ORNAMENT_KIT, I.BOUNTY_HUNTER_ORNAMENT_KIT]), "the untradeable kits are the victim's still");
});

test("a Volcanic or Frozen abyssal whip is lost to the killer as an abyssal whip, and the mix is gone", (t) => {
  const victim = actor(t), killer = actor(t);
  carry(victim, [I.VOLCANIC_ABYSSAL_WHIP, I.FROZEN_ABYSSAL_WHIP]);
  const result = die(t, victim, killer, WILDERNESS(), { skulled: true });
  assert.deepEqual(result.kept, []);
  assert.deepEqual(forKiller(result), [I.ABYSSAL_WHIP, I.ABYSSAL_WHIP]);
});

test("a Rune defender (t) loses its kit to the killer and stays with the victim broken, the repair cost paid to the killer", (t) => {
  const victim = actor(t), killer = actor(t);
  carry(victim, [I.RUNE_DEFENDER_T_]);
  const result = die(t, victim, killer, WILDERNESS(), { skulled: true });
  const broken = Object.entries(I).find(([name]) => name === "RUNE_DEFENDER_BROKEN_")?.[1];
  assert.ok(Number.isInteger(broken), "the cache has Rune defender (broken)");
  assert.deepEqual(result.kept, [broken]);
  assert.deepEqual(forKiller(result).filter((id) => id !== I.COINS), [I.RUNE_DEFENDER_ORNAMENT_KIT]);
  assert.ok(coinsForKiller(result) > 0, "the killer gets the repair cost");
});

test("an ornamented item among the kept ones is kept as it is: unskulled, and skulled with Protect Item", (t) => {
  for (const options of [{}, { skulled: true, protectItem: true }]) {
    const victim = actor(t), killer = actor(t);
    carry(victim, [I.ARMADYL_GODSWORD_OR_]);
    const result = die(t, victim, killer, WILDERNESS(), options);
    assert.deepEqual(result.kept, [I.ARMADYL_GODSWORD_OR_], "kept whole, kit and all");
    assert.deepEqual(forKiller(result), []);
  }
});

test("unskulled with four items, the least valuable one is the one lost, ornamented or not", (t) => {
  const victim = actor(t), killer = actor(t);
  carry(victim, [I.VOIDWAKER, I.ARMADYL_GODSWORD_OR_, I.NIGHTMARE_STAFF, I.RUNE_SCIMITAR]);
  const result = die(t, victim, killer, WILDERNESS());
  assert.equal(result.kept.length, 3);
  assert.ok(!result.kept.includes(I.RUNE_SCIMITAR));
  assert.deepEqual(forKiller(result), [I.RUNE_SCIMITAR]);
});

test("a death to a monster takes no kit off: outside the Wilderness the item is protected, inside it goes to the grave whole", (t) => {
  const town = actor(t);
  carry(town, [I.ARMADYL_GODSWORD_OR_, I.VOLCANIC_ABYSSAL_WHIP]);
  const safe = die(t, town, null, LUMBRIDGE(), { skulled: true });
  assert.deepEqual(sorted(safe.kept), sorted([I.ARMADYL_GODSWORD_OR_, I.VOLCANIC_ABYSSAL_WHIP]), "death protection from cosmetics");
  assert.deepEqual(safe.floor, []);

  const wild = actor(t);
  carry(wild, [I.ARMADYL_GODSWORD_OR_, I.VOLCANIC_ABYSSAL_WHIP]);
  const result = die(t, wild, null, WILDERNESS(), { skulled: true });
  assert.deepEqual(sorted(result.grave), sorted([I.ARMADYL_GODSWORD_OR_, I.VOLCANIC_ABYSSAL_WHIP]), "to the grave as they are");
  assert.deepEqual(result.floor, []);
});

test("a preset copy of an ornamented item is deleted with the rest of the preset: no plain item and no kit for the killer", (t) => {
  const victim = actor(t), killer = actor(t);
  const sword = new core.Item(I.ARMADYL_GODSWORD_OR_, 1);
  for (const key of [core.Item.UNTRADEABLE_META, core.Item.UNBANKABLE_META, core.Item.PRESET_META]) sword.setMetaValue(key, true);
  victim.getInventory().setItem(0, sword);
  const result = die(t, victim, killer, WILDERNESS(), { skulled: true });
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.floor, []);
});

test("items that change no hands are left alone: a dyed Graceful piece, Fighter torso (or), a kit carried by itself", (t) => {
  const victim = actor(t), killer = actor(t);
  const dyed = Kits.loadKits().find((entry) => entry.kit === I.DARK_DYE).result;
  // Fighter torso (or) is breakable; the level-10 Wilderness leaves it with the victim either way.
  carry(victim, [dyed, I.ELDER_CHAOS_ROBES_ORNAMENT_KIT]);
  const result = die(t, victim, killer, WILDERNESS(), { skulled: true });
  assert.deepEqual(sorted(result.kept), sorted([dyed, I.ELDER_CHAOS_ROBES_ORNAMENT_KIT]));
  assert.deepEqual(forKiller(result), []);
  assert.equal(Kits.pvpDeathParts(new core.Item(I.FIGHTER_TORSO_OR_, 1)), null);
});

test("a bot's ornamented gear is not split into loot", () => {
  const query = { player: { isPlayerBot: () => true }, killer: {}, item: new core.Item(I.ARMADYL_GODSWORD_OR_, 1), parts: null };
  PM.emitCustomEvent("player-death:pvp-item-parts", query);
  assert.equal(query.parts, null);
  assert.equal(query.item.getId(), I.ARMADYL_GODSWORD_OR_);
});

test("the Items Kept on Death PvP preview is told an ornamented tradeable item is lost, and a dyed Graceful piece is not", () => {
  const lost = (id) => { const query = { item: new core.Item(id, 1), wildernessLevel: 0, lost: false }; PM.emitCustomEvent("items:lost-to-pvp-killer", query); return query.lost; };
  assert.equal(lost(I.ARMADYL_GODSWORD_OR_), true);
  assert.equal(lost(I.VOLCANIC_ABYSSAL_WHIP), true);
  assert.equal(lost(Kits.loadKits().find((entry) => entry.kit === I.DARK_DYE).result), false);
  assert.equal(lost(I.RUNE_DEFENDER_T_), false, "the defender itself stays with the victim");
});

test("the Bounty hunter ornament kit goes on Dragon boots, not on the potion that shared their old id", () => {
  const entry = Kits.loadKits().find((kit) => kit.result === I.DRAGON_BOOTS_CR_);
  assert.equal(entry.base, I.DRAGON_BOOTS);
  assert.equal(new core.Item(entry.base, 1).getDefinition().getName(), "Dragon boots");
});

// --- The abyssal tentacle ----------------------------------------------------------------------------------------

test("an unprotected abyssal tentacle is lost to the killer as a kraken tentacle; an (or) one's kit goes too", (t) => {
  const victim = actor(t), killer = actor(t);
  carry(victim, [I.ABYSSAL_TENTACLE, I.ABYSSAL_TENTACLE_OR_]);
  const result = die(t, victim, killer, WILDERNESS(), { skulled: true });
  assert.deepEqual(result.kept, []);
  assert.deepEqual(forKiller(result), sorted([I.KRAKEN_TENTACLE, I.KRAKEN_TENTACLE, I.SHATTERED_RELICS_VARIETY_ORNAMENT_KIT]));
});

test("a protected abyssal tentacle stays a tentacle with its charges, and a death to a monster leaves it whole", (t) => {
  const victim = actor(t), killer = actor(t);
  const tentacle = new core.Item(I.ABYSSAL_TENTACLE, 1);
  tentacle.setMetaValue("abyssal-tentacle", 4321);
  victim.getInventory().setItem(0, tentacle);
  victim.setLocation(WILDERNESS());
  const kept = PlayerDeathTask.dropItems(victim, killer, WILDERNESS());
  assert.deepEqual(kept.map((item) => [item.getId(), item.getMetaValue("abyssal-tentacle")]), [[I.ABYSSAL_TENTACLE, 4321]]);

  const pvm = actor(t);
  carry(pvm, [I.ABYSSAL_TENTACLE]);
  const result = die(t, pvm, null, WILDERNESS(), { skulled: true });
  assert.deepEqual(result.grave, [I.ABYSSAL_TENTACLE]);
});

// --- Ancient Warriors' equipment from the Bounty Hunter Store ----------------------------------------------------
// Wiki, Vesta's longsword (bh): "Upon dying in PvP, the coins used to activate the item are given to the killer, and
// players are left with the inactive item. That said, the activated form is preserved and the coins aren't lost if the
// longsword is one of the player's protected items."

/** An activated piece holding the coins it was charged with (BountyHunterEquipment keeps them on the item). */
function charged(id, coins) {
  const item = new core.Item(id, 1);
  if (coins > 0) item.setMetaValue(Equipment.FEE_META, coins);
  return item;
}

test("an unprotected Vesta's longsword (bh) goes inactive and its 50,000,000 coins drop for the killer: Wilderness and crater", (t) => {
  for (const at of [WILDERNESS(), CRATER_EAST()]) {
    const victim = actor(t), killer = actor(t);
    victim.getInventory().setItem(0, charged(I.VESTAS_LONGSWORD_BH_, 50_000_000));
    victim.getEquipment().setItem(core.Equipment.BODY_SLOT, charged(I.VESTAS_CHAINBODY_BH_, 5_000_000));
    const result = die(t, victim, killer, at, { skulled: true });
    assert.deepEqual(sorted(result.kept), sorted([I.VESTAS_LONGSWORD_BH_INACTIVE_, I.VESTAS_CHAINBODY_BH_INACTIVE_]), "the victim is left with the inactive pieces");
    assert.deepEqual(forKiller(result), [I.COINS, I.COINS]);
    assert.equal(coinsForKiller(result), 55_000_000);
  }
});

test("a protected Vesta's longsword (bh) stays activated with its coins: unskulled, and skulled with Protect Item", (t) => {
  for (const options of [{}, { skulled: true, protectItem: true }]) {
    const victim = actor(t), killer = actor(t);
    victim.getInventory().setItem(0, charged(I.VESTAS_LONGSWORD_BH_, 50_000_000));
    const result = die(t, victim, killer, WILDERNESS(), options);
    assert.deepEqual(result.kept, [I.VESTAS_LONGSWORD_BH_]);
    assert.deepEqual(result.floor, []);
  }
  // The coins stay on the kept item itself.
  const victim = actor(t), killer = actor(t);
  const sword = charged(I.VESTAS_LONGSWORD_BH_, 50_000_000);
  victim.getInventory().setItem(0, sword);
  victim.setLocation(WILDERNESS());
  const kept = PlayerDeathTask.dropItems(victim, killer, WILDERNESS());
  assert.deepEqual(kept.map((item) => [item.getId(), Equipment.heldCoins(item)]), [[I.VESTAS_LONGSWORD_BH_, 50_000_000]]);
});

test("a piece nobody charged goes inactive and pays nothing; a preset copy is deleted and pays nothing", (t) => {
  const victim = actor(t), killer = actor(t);
  const preset = new core.Item(I.STATIUSS_WARHAMMER_BH_, 1);
  for (const key of [core.Item.UNTRADEABLE_META, core.Item.UNBANKABLE_META, core.Item.PRESET_META]) preset.setMetaValue(key, true);
  victim.getInventory().setItem(0, charged(I.VESTAS_LONGSWORD_BH_, 0));
  victim.getInventory().setItem(1, preset);
  const result = die(t, victim, killer, WILDERNESS(), { skulled: true });
  assert.deepEqual(result.kept, [I.VESTAS_LONGSWORD_BH_INACTIVE_]);
  assert.deepEqual(result.floor, [], "no coins were ever put in");
});

test("a death to a monster, or a player's kill credit outside PvP ground, leaves an activated piece as it is", (t) => {
  const pvm = actor(t);
  pvm.getInventory().setItem(0, charged(I.VESTAS_LONGSWORD_BH_, 50_000_000));
  const grave = die(t, pvm, null, WILDERNESS(), { skulled: true });
  assert.deepEqual(grave.grave, [I.VESTAS_LONGSWORD_BH_], "to the grave activated");
  assert.deepEqual(grave.floor, []);

  const victim = actor(t), killer = actor(t);
  victim.getInventory().setItem(0, charged(I.VESTAS_LONGSWORD_BH_, 50_000_000));
  const town = die(t, victim, killer, LUMBRIDGE(), { skulled: true });
  assert.deepEqual(town.kept, [I.VESTAS_LONGSWORD_BH_]);
  assert.deepEqual(town.floor, []);
});

test("a bot's activated piece is not turned into coins", () => {
  const query = { player: { isPlayerBot: () => true }, killer: {}, item: charged(I.VESTAS_LONGSWORD_BH_, 50_000_000), parts: null };
  PM.emitCustomEvent("player-death:pvp-item-parts", query);
  assert.equal(query.parts, null);
  assert.equal(query.item.getId(), I.VESTAS_LONGSWORD_BH_);
});

// --- Daimon's Crater is PvP ground -------------------------------------------------------------------------------

test("a death to a player in Bounty Hunter's arena is a PvP death; one in a town is not", (t) => {
  const victim = actor(t), killer = actor(t);
  for (const [at, expected] of [[CRATER_EAST(), true], [CRATER_WEST(), true], [WILDERNESS(), true], [LUMBRIDGE(), false]]) {
    victim.setLocation(at);
    assert.equal(PlayerDeathTask.isPvpDeath(victim, killer), expected, `${at.getX()},${at.getY()}`);
    assert.equal(PlayerDeathTask.isPvpDeath(victim, null), false, "a monster's kill never is");
    assert.equal(PlayerDeathTask.isPvpDeath(victim, victim), false);
  }
  // Fort Daimon, the lobby inside the arena's box, is safe ground.
  victim.setLocation(new core.Location(3423, 4061, 0));
  assert.equal(PlayerDeathTask.isPvpDeath(victim, killer), false);
});

test("in the crater an upgraded Nightmare staff is lost as staff and orb, and ornamented items lose as in the Wilderness", (t) => {
  const victim = actor(t), killer = actor(t);
  carry(victim, [I.HARMONISED_NIGHTMARE_STAFF, I.ARMADYL_GODSWORD_OR_, I.ABYSSAL_TENTACLE]);
  const result = die(t, victim, killer, CRATER_EAST(), { skulled: true });
  assert.deepEqual(result.kept, []);
  assert.deepEqual(forKiller(result), sorted([I.NIGHTMARE_STAFF, I.HARMONISED_ORB, I.ARMADYL_GODSWORD, I.ARMADYL_GODSWORD_ORNAMENT_KIT, I.KRAKEN_TENTACLE]));
});

test("in the crater a fire cape and an infernal cape break and stay with the victim: no part of the crater is deep Wilderness", (t) => {
  for (const at of [CRATER_EAST(), CRATER_WEST()]) {
    const victim = actor(t), killer = actor(t);
    carry(victim, [I.FIRE_CAPE, I.INFERNAL_CAPE]);
    const result = die(t, victim, killer, at, { skulled: true });
    assert.equal(result.kept.length, 2, "both capes stay with the victim");
    assert.ok(!result.kept.includes(I.FIRE_CAPE) && !result.kept.includes(I.INFERNAL_CAPE), `as their broken forms: ${JSON.stringify(result.kept)}`);
    for (const id of result.kept) assert.match(new core.Item(id, 1).getDefinition().getName(), /\(broken\)$/);
    assert.ok(coinsForKiller(result) > 0, "the killer gets the repair costs");
  }
});

test("in the deep Wilderness an unlocked infernal cape is still lost, and a fire cape still breaks", (t) => {
  const victim = actor(t), killer = actor(t);
  carry(victim, [I.FIRE_CAPE, I.INFERNAL_CAPE]);
  const result = die(t, victim, killer, DEEP_WILDERNESS(), { skulled: true });
  assert.equal(result.kept.length, 1);
  assert.match(new core.Item(result.kept[0], 1).getDefinition().getName(), /^Fire cape \(broken\)$/);
});

test("with a player's kill credit outside PvP ground nothing is split or broken: untradeables come back as they were", (t) => {
  const victim = actor(t), killer = actor(t);
  carry(victim, [I.HARMONISED_NIGHTMARE_STAFF, I.ARMADYL_GODSWORD_OR_, I.ABYSSAL_TENTACLE, I.FIRE_CAPE]);
  const result = die(t, victim, killer, LUMBRIDGE(), { skulled: true });
  assert.deepEqual(sorted(result.kept), sorted([I.HARMONISED_NIGHTMARE_STAFF, I.ARMADYL_GODSWORD_OR_, I.ABYSSAL_TENTACLE, I.FIRE_CAPE]));
  assert.deepEqual(forKiller(result), []);
});
