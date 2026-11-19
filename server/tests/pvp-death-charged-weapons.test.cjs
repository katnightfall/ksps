// Run after `yarn build`: node --test tests/pvp-death-charged-weapons.test.cjs
//
// Upstream issue #6002, second half: what a death to another player makes of a charged or assembled weapon. On the real
// engine: every plugin loaded, real Players, the real PlayerDeathTask.dropItems; only the ground item registration and
// the grave hook are watched (as pvp-death-item-loss.test.cjs does).
//
// Wiki, Items Kept on Death (Mechanics), "Chargable items", PvP death: "Dropped to the PKer as the tradeable uncharged
// item, and drops the items that would result from uncharging the item to the PKer too". Each item's own page:
// - Scythe of Vitur: "all charges will be lost and the player who gets the scythe will not receive any blood runes or
//   vials of blood"; Holy / Sanguine scythe, Holy sanguinesti staff: "the holy ornament kit will be placed in their
//   gravestone".
// - Sanguinesti staff, Tumeken's shadow: the page does not say where the charges go, so the "Chargable items" rule
//   gives the killer what Uncharge gives back.
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

let core, I, CASES, UNTOUCHED;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  I = core.ItemIdentifiers;
  // BountyHunter depends on PlayerBots, which this test leaves off, so the plugin is skipped: its area unit is attached
  // here for the one thing these tests ask of it, the answer to `player-death:pvp-ground` (pvp-death-item-loss does the same).
  const real = PM.createApi("BountyHunter");
  const api = new Proxy({
    core,
    registerArea() {},
    getPluginConfig: (_key, fallback) => fallback,
    onCustomEvent: (name, handler) => { if (name === "player-death:pvp-ground") real.onCustomEvent(name, handler); },
  }, { get: (object, key) => object[key] ?? (() => {}) });
  require("../plugins/minigames/bountyhunter/Area.BountyHunter")(api, require("../plugins/minigames/bountyhunter/State.BountyHunter"));
  PM.emitServerStartup({});
  CASES = cases();
  UNTOUCHED = untouched();
});
after(() => PM.emitServerShutdown({}));

// --- The items ---------------------------------------------------------------------------------------------------

/** One item with metadata: `meta` is { key: value }. */
function make(id, meta = {}) {
  const item = new core.Item(id, 1);
  for (const [key, value] of Object.entries(meta)) item.setMetaValue(key, value);
  return item;
}

/**
 * Every charged or assembled form: `item()` stages it, `killer` is exactly what an unprotected PvP death drops for the
 * killer ({ id: amount }), `kept` what the victim is left with (a kit or mutagen that does not trade).
 */
function cases() {
  return [
    // Theatre of Blood and Tombs of Amascut
    { name: "Scythe of Vitur", item: () => make(I.SCYTHE_OF_VITUR, { "scythe-of-vitur-charges": 1234 }),
      killer: { [I.SCYTHE_OF_VITUR_UNCHARGED_]: 1 }, kept: [] },
    { name: "Holy Scythe of Vitur", item: () => make(I.HOLY_SCYTHE_OF_VITUR, { "scythe-of-vitur-charges": 1234 }),
      killer: { [I.SCYTHE_OF_VITUR_UNCHARGED_]: 1 }, kept: [I.HOLY_ORNAMENT_KIT] },
    { name: "Sanguine Scythe of Vitur", item: () => make(I.SANGUINE_SCYTHE_OF_VITUR, { "scythe-of-vitur-charges": 20000 }),
      killer: { [I.SCYTHE_OF_VITUR_UNCHARGED_]: 1 }, kept: [I.SANGUINE_ORNAMENT_KIT] },
    { name: "Sanguinesti staff", item: () => make(I.SANGUINESTI_STAFF, { "sanguinesti-staff-charges": 1234 }),
      killer: { [I.SANGUINESTI_STAFF_UNCHARGED_]: 1, [I.BLOOD_RUNE]: 2468 }, kept: [] },
    { name: "Holy sanguinesti staff", item: () => make(I.HOLY_SANGUINESTI_STAFF, { "sanguinesti-staff-charges": 20000 }),
      killer: { [I.SANGUINESTI_STAFF_UNCHARGED_]: 1, [I.BLOOD_RUNE]: 40000 }, kept: [I.HOLY_ORNAMENT_KIT] },
    // 1,000 charges of which 600 soul runes were paid in aether runes: Uncharge gives 1,400 soul runes back.
    { name: "Tumeken's shadow", item: () => make(I.TUMEKENS_SHADOW, { "tumekens-shadow-charges": 1000, "tumekens-shadow-aether-runes": 600 }),
      killer: { [I.TUMEKENS_SHADOW_UNCHARGED_]: 1, [I.SOUL_RUNE]: 1400, [I.CHAOS_RUNE]: 5000 }, kept: [] },
  ];
}

/**
 * Charged items a PvP death leaves as they were (`dropsWhole`: a tradeable one, dropped for the killer as it is).
 */
function untouched() {
  return [
  ];
}

// --- Staging a death ---------------------------------------------------------------------------------------------

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
 * The victim dies at `at` to `killer` (null: a monster). Returns what reached the floor ({ id, amount, owner, item }),
 * what the grave hook was offered, and the items that came back.
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
    floor.push({ id: item.getId(), amount: item.getAmount(), owner: owner === killer ? "killer" : owner === victim ? "victim" : "other", item });
    return register.call(core.ItemOnGroundManager, owner, item, location, ...rest);
  });
  const grave = [];
  const emitDrops = PM.emitPlayerDeathDrops;
  t.mock.method(PM, "emitPlayerDeathDrops", (event) => {
    grave.push(...[...event.items, ...event.untradeables].map((item) => item.getId()));
    return emitDrops.call(PM, event);
  });
  const kept = PlayerDeathTask.dropItems(victim, killer, at);
  core.ItemOnGroundManager.registerLocation.mock.restore();
  PM.emitPlayerDeathDrops.mock.restore();
  return { floor, grave, kept, keptIds: kept.map((item) => item.getId()) };
}

/** What lies on the floor for `owner`, as { id: total amount }. */
function pile({ floor }, owner = "killer") {
  const totals = {};
  for (const entry of floor) if (entry.owner === owner) totals[entry.id] = (totals[entry.id] ?? 0) + entry.amount;
  return totals;
}
const sorted = (ids) => [...ids].sort((a, b) => a - b);
const state = (item) => JSON.stringify([item.getId(), item.getAmount(), item.getMeta() ?? null]);
const noCarried = (victim) => victim.getInventory().getValidItems().length + victim.getEquipment().getValidItems().length === 0;
function preset(item) {
  for (const key of [core.Item.UNTRADEABLE_META, core.Item.UNBANKABLE_META, core.Item.PRESET_META]) item.setMetaValue(key, true);
  return item;
}
const lostOnPreview = (item) => {
  const query = { item, wildernessLevel: 10, lost: false };
  PM.emitCustomEvent("items:lost-to-pvp-killer", query);
  return query.lost;
};
const expected = (name) => CASES.find((entry) => entry.name === name).killer;
/** What a player holds after uncharging the named case's item by hand with `uncharge(player, item)`, as { id: amount }. */
function byHand(t, name, uncharge) {
  const player = actor(t);
  player.setLocation(LUMBRIDGE());
  const item = CASES.find((entry) => entry.name === name).item();
  player.getInventory().setItem(0, item);
  uncharge(player, item);
  const held = {};
  for (const stack of player.getInventory().getValidItems()) held[stack.getId()] = (held[stack.getId()] ?? 0) + stack.getAmount();
  return held;
}

// --- Lost: an unprotected item on a skulled PvP death ------------------------------------------------------------

test("unprotected on a skulled PvP death, each item drops for the killer uncharged with exactly its contents: Wilderness and crater", (t) => {
  for (const at of [WILDERNESS, CRATER]) {
    for (const entry of CASES) {
      const victim = actor(t), killer = actor(t);
      const item = entry.item();
      victim.getInventory().setItem(0, item);
      const result = die(t, victim, killer, at(), { skulled: true });
      assert.deepEqual(pile(result), entry.killer, `${entry.name}: the killer's pile`);
      assert.deepEqual(sorted(result.keptIds), sorted(entry.kept), `${entry.name}: what the victim is left with`);
      assert.deepEqual(pile(result, "victim"), {}, `${entry.name}: nothing on the floor for the victim`);
      assert.deepEqual(pile(result, "other"), {}, `${entry.name}: nothing on the floor for anyone else`);
      assert.ok(noCarried(victim), `${entry.name}: nothing left in the inventory or worn`);
      // One copy of the weapon, and it is the staged Item itself, emptied: no charge is left in it beside the pile.
      const weapon = result.floor.filter((dropped) => dropped.item === item);
      assert.equal(weapon.length, 1, `${entry.name}: the staged item is the one dropped, once`);
      assert.equal(item.getMeta() ?? null, null, `${entry.name}: the dropped item holds no charges: ${JSON.stringify(item.getMeta())}`);
      assert.ok(item.isPlayerTradeable(), `${entry.name}: what the killer gets trades`);
    }
  }
});

test("worn, an unprotected item is lost the same way as one carried", (t) => {
  const victim = actor(t), killer = actor(t);
  victim.getEquipment().setItem(core.Equipment.WEAPON_SLOT, make(I.HOLY_SANGUINESTI_STAFF, { "sanguinesti-staff-charges": 50 }));
  const result = die(t, victim, killer, WILDERNESS(), { skulled: true });
  assert.deepEqual(pile(result), { [I.SANGUINESTI_STAFF_UNCHARGED_]: 1, [I.BLOOD_RUNE]: 100 });
  assert.deepEqual(result.keptIds, [I.HOLY_ORNAMENT_KIT]);
  assert.ok(noCarried(victim));
});

test("two of the same item each give what was in them: the charges are the item's, not the player's", (t) => {
  const victim = actor(t), killer = actor(t);
  victim.getInventory().setItem(0, make(I.SANGUINESTI_STAFF, { "sanguinesti-staff-charges": 10 }));
  victim.getInventory().setItem(1, make(I.SANGUINESTI_STAFF, { "sanguinesti-staff-charges": 300 }));
  victim.getInventory().setItem(2, make(I.SANGUINESTI_STAFF_UNCHARGED_));
  const result = die(t, victim, killer, WILDERNESS(), { skulled: true });
  assert.deepEqual(pile(result), { [I.SANGUINESTI_STAFF_UNCHARGED_]: 3, [I.BLOOD_RUNE]: 620 });
  assert.deepEqual(result.keptIds, []);
});

test("a charged item in the bank is not the death's to touch", (t) => {
  const victim = actor(t), killer = actor(t);
  victim.getBank(0).add(make(I.SANGUINESTI_STAFF, { "sanguinesti-staff-charges": 1234 }), false);
  victim.getInventory().setItem(0, make(I.SANGUINESTI_STAFF, { "sanguinesti-staff-charges": 10 }));
  const result = die(t, victim, killer, WILDERNESS(), { skulled: true });
  assert.deepEqual(pile(result), { [I.SANGUINESTI_STAFF_UNCHARGED_]: 1, [I.BLOOD_RUNE]: 20 });
  assert.deepEqual(victim.getBank(0).getValidItems().map(state), [state(make(I.SANGUINESTI_STAFF, { "sanguinesti-staff-charges": 1234 }))]);
});

test("a charged item id that holds no charges gives the uncharged item and nothing else", (t) => {
  const victim = actor(t), killer = actor(t);
  const staged = [
    [I.SANGUINESTI_STAFF, I.SANGUINESTI_STAFF_UNCHARGED_], [I.TUMEKENS_SHADOW, I.TUMEKENS_SHADOW_UNCHARGED_],
  ];
  staged.forEach(([charged], slot) => victim.getInventory().setItem(slot, make(charged)));
  const result = die(t, victim, killer, WILDERNESS(), { skulled: true });
  assert.deepEqual(pile(result), Object.fromEntries(staged.map(([, uncharged]) => [uncharged, 1])));
  assert.deepEqual(result.keptIds, []);
});

test("the death gives what Uncharge by hand gives: the Sanguinesti staff's blood runes", (t) => {
  const Staff = require("../plugins/items/SanguinestiStaff.plugin")._test;
  assert.deepEqual(byHand(t, "Sanguinesti staff", (player, item) => Staff.uncharge({ player, item })), expected("Sanguinesti staff"));
});

test("the Items Kept on Death PvP preview shows every one of them lost", () => {
  for (const entry of CASES) assert.equal(lostOnPreview(entry.item()), true, entry.name);
});

// --- Kept: the item comes through as it was, charges and all -----------------------------------------------------

test("protected by the three-item rule, or skulled with Protect Item, each item is kept as it is with its charges", (t) => {
  for (const options of [{}, { skulled: true, protectItem: true }]) {
    for (const entry of [...CASES, ...UNTOUCHED]) {
      const victim = actor(t), killer = actor(t);
      const item = entry.item();
      const before = state(item);
      victim.getInventory().setItem(0, item);
      const result = die(t, victim, killer, WILDERNESS(), options);
      assert.deepEqual(result.kept, [item], `${entry.name}: the same item comes back`);
      assert.equal(state(item), before, `${entry.name}: unchanged, charges and all`);
      assert.deepEqual(result.floor, [], `${entry.name}: nothing dropped`);
    }
  }
});

// A charged item has no Grand Exchange price, so the death ranks it by its own alchemy value (PlayerDeathTask.keepValue),
// not by the uncharged item's price (docs/items-kept-on-death.md, Charged items, "Not covered"). The shadow ranks above
// the staff both ways (alchemy 4.2m against 3m; uncharged, hundreds of millions against 13.7m).
test("of two charged items with Protect Item and a skull, the more valuable is kept whole and the other is lost", (t) => {
  const victim = actor(t), killer = actor(t);
  const shadow = make(I.TUMEKENS_SHADOW, { "tumekens-shadow-charges": 1000 });
  const before = state(shadow);
  victim.getInventory().setItem(0, make(I.SANGUINESTI_STAFF, { "sanguinesti-staff-charges": 1234 }));
  victim.getInventory().setItem(1, shadow);
  assert.ok(PlayerDeathTask.keepValue(shadow) > PlayerDeathTask.keepValue(make(I.SANGUINESTI_STAFF)), "the shadow ranks above the staff");
  const result = die(t, victim, killer, WILDERNESS(), { skulled: true, protectItem: true });
  assert.deepEqual(result.kept, [shadow]);
  assert.equal(state(shadow), before);
  assert.deepEqual(pile(result), { [I.SANGUINESTI_STAFF_UNCHARGED_]: 1, [I.BLOOD_RUNE]: 2468 });
});

test("a death to a monster changes nothing: each item goes to the grave whole with its charges", (t) => {
  for (const entry of [...CASES, ...UNTOUCHED]) {
    const victim = actor(t);
    const item = entry.item();
    const before = state(item);
    victim.getInventory().setItem(0, item);
    const result = die(t, victim, null, WILDERNESS(), { skulled: true });
    assert.deepEqual(result.grave, [JSON.parse(before)[0]], `${entry.name}: offered to the grave as it is`);
    assert.equal(state(item), before, `${entry.name}: unchanged, charges and all`);
    assert.deepEqual(result.floor, [], `${entry.name}: nothing dropped`);
  }
});

test("a player's kill credit outside PvP ground changes nothing: each item comes back whole with its charges", (t) => {
  for (const entry of [...CASES, ...UNTOUCHED.filter((other) => !other.dropsWhole)]) {
    const victim = actor(t), killer = actor(t);
    const item = entry.item();
    const before = state(item);
    victim.getInventory().setItem(0, item);
    const result = die(t, victim, killer, LUMBRIDGE(), { skulled: true });
    assert.deepEqual(result.kept, [item], `${entry.name}: the same item comes back`);
    assert.equal(state(item), before, `${entry.name}: unchanged, charges and all`);
    assert.deepEqual(result.floor, [], `${entry.name}: nothing dropped`);
  }
});

test("a preset copy is deleted with the rest of the preset: no uncharged item, no contents, no kit for anyone", (t) => {
  for (const entry of [...CASES, ...UNTOUCHED]) {
    const victim = actor(t), killer = actor(t);
    const item = preset(entry.item());
    const before = state(item);
    victim.getInventory().setItem(0, item);
    const result = die(t, victim, killer, WILDERNESS(), { skulled: true });
    assert.deepEqual(result.kept, [], `${entry.name}: not given back`);
    assert.deepEqual(result.floor, [], `${entry.name}: nothing dropped`);
    assert.equal(state(item), before, `${entry.name}: never emptied`);
    assert.equal(lostOnPreview(item), false, `${entry.name}: the preview's lost answer is for real items`);
    // Asked directly (the death never asks about a preset copy), the answer is still nothing.
    const query = { player: victim, killer, item, parts: null };
    PM.emitCustomEvent("player-death:pvp-item-parts", query);
    assert.equal(query.parts, null, `${entry.name}: no parts for a preset copy`);
    assert.equal(state(item), before);
  }
});

test("a bot's charged gear is not turned into loot", () => {
  for (const entry of [...CASES, ...UNTOUCHED]) {
    const item = entry.item();
    const before = state(item);
    const query = { player: { isPlayerBot: () => true }, killer: {}, item, parts: null };
    PM.emitCustomEvent("player-death:pvp-item-parts", query);
    assert.equal(query.parts, null, entry.name);
    assert.equal(state(item), before, `${entry.name}: unchanged, charges and all`);
  }
});

test("a bot that dies in the Wilderness keeps its charged gear as it was", (t) => {
  const bot = actor(t), killer = actor(t);
  bot.setPlayerBot(true);
  const staff = make(I.SANGUINESTI_STAFF, { "sanguinesti-staff-charges": 1234 });
  const before = state(staff);
  bot.getInventory().setItem(0, staff);
  const result = die(t, bot, killer, WILDERNESS(), { skulled: true });
  assert.deepEqual(result.kept, [staff]);
  assert.equal(state(staff), before);
  assert.deepEqual(result.floor, []);
});

test("an answer that already put another item in a charged one's place is left to stand: the item is not emptied as well", () => {
  const { splitOnPvpDeath } = require("../plugins/items/ChargedItemDeath");
  const item = make(I.SANGUINESTI_STAFF, { "sanguinesti-staff-charges": 1234 });
  const before = state(item);
  const other = make(I.BLOOD_RUNE);
  const query = { player: { isPlayerBot: () => false }, killer: {}, item, parts: [other] };
  splitOnPvpDeath(core, query, () => I.SANGUINESTI_STAFF_UNCHARGED_, () => { throw new Error("emptied"); });
  assert.deepEqual(query.parts, [other]);
  assert.equal(state(item), before);
});

test("an uncharged item carried, with nothing in it, drops as any tradeable item does and no kit or content appears from nowhere", (t) => {
  const victim = actor(t), killer = actor(t);
  const ids = [
    I.SCYTHE_OF_VITUR_UNCHARGED_, I.SANGUINESTI_STAFF_UNCHARGED_, I.TUMEKENS_SHADOW_UNCHARGED_,
  ];
  ids.forEach((id, slot) => victim.getInventory().setItem(slot, make(id)));
  const result = die(t, victim, killer, WILDERNESS(), { skulled: true });
  assert.deepEqual(pile(result), Object.fromEntries(ids.map((id) => [id, 1])));
  assert.deepEqual(result.keptIds, []);
});
