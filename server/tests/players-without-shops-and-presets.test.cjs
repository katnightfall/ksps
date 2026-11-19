// Ours. Run after `yarn build`: node --test tests/players-without-shops-and-presets.test.cjs
// World settings CustomShops:players (plugins/interface/CustomShops.plugin.js) and PvpMode:players
// (plugins/modes/PvpMode.plugin.js, modes/pvp/Presets.PvpMode.js). The original project's worlds are PvP-spawn worlds;
// ours are levelling worlds, and our world.json turns both off: only owners and developers open the custom shops (the
// ::shops panel and its PK shops, by any road) or use presets (::presets, ::kits, the Character Summary's button, the
// interface, loading, the opening after a PvP death, and the prayers without their quests). Bots are not players
// here: they still dress from presets. With both settings at their default (on) the original behaviour is back; that
// half runs in a child process of this file, because commands take their rank when the plugins load.
// Every plugin loaded, real Players, commands as they are typed, buttons through the dispatch a click takes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const DEFAULTS = process.env.NOSHOPS_TEST_DEFAULTS === "1";
const SHOPS_SETTING = "CustomShops:players";
const PRESETS_SETTING = "PvpMode:players";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "noshops-"));
process.env.DISABLE_PLAYER_BOTS = "1";
process.env.PLAYER_SAVE_DATABASE_PATH = path.join(scratch, "players.sqlite");
process.env.TSPS_ACCOUNTS_FILE = path.join(scratch, "accounts.json");
process.env.TSPS_DISPLAY_NAMES_FILE = path.join(scratch, "display-names.json");
// Server startup opens the world-admin page: the parent and its child each on a port of their own.
process.env.WORLD_ADMIN_PORT = DEFAULTS ? "46271" : "46270";
require("../dist/Server").Server.installProductionPathResolver();

// Our world.json's two settings, whatever a worktree's world.local.json says; in the child, the defaults.
const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/definitions/world.json"), "utf8"));
const WorldDefinition = require("../dist/game/definition/WorldDefinition");
const readWorldConfig = WorldDefinition.readWorldConfig;
WorldDefinition.readWorldConfig = (...args) => {
  const config = readWorldConfig(...args);
  const pluginConfig = { ...(config.pluginConfig ?? {}) };
  for (const key of [SHOPS_SETTING, PRESETS_SETTING]) {
    if (DEFAULTS) delete pluginConfig[key];
    else pluginConfig[key] = shipped.pluginConfig?.[key];
  }
  return { ...config, plugins: { ...(config.plugins ?? {}), PvpMode: true, CustomShops: true }, pluginConfig };
};

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { RegionManager } = require("../dist/game/collision/RegionManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { Location } = require("../dist/game/model/Location");
const { Skill } = require("../dist/game/model/Skill");
const { PlayerRights } = require("../dist/game/model/rights/PlayerRights");
const { TaskManager } = require("../dist/game/task/TaskManager");
const { ShopManager } = require("../dist/game/model/container/shop/ShopManager");
const { ShopDefinition } = require("../dist/game/definition/ShopDefinition");
const { ShopDefinitionLoader } = require("../dist/game/definition/loader/impl/ShopDefinitionLoader");
const { ChatPacketListener } = require("../dist/net/packet/impl/ChatPacketListener");
const { InterfaceActionClickOpcode } = require("../dist/net/packet/impl/InterfaceActionClickOpcode");
const PresetsWidget = require("../plugins/modes/pvp/PresetsWidget.PvpMode");
const Presets = require("../plugins/modes/pvp/Presets.PvpMode");
const PvpMode = require("../plugins/modes/PvpMode.plugin");
const Journal = require("../plugins/interface/sidejournaldefaults/Layout.SideJournalDefaults");
const { applyGeneratedPvpLoadout } = require("../plugins/bots/behaviours/policies/PvpLoadoutPolicy.PlayerBots");

const CUSTOM_SHOP_IDS = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/definitions/custom-shops.json"), "utf8"))
  .map((entry) => entry.id);
const PK_SHOPS = [13, 14, 27]; // custom-shops.json: PK Weapon Shop, PK Armor Shop, Pk Supplies Shop
const LUMBRIDGE_GENERAL_STORE = 1222; // shops.json
const CUSTOM_SHOPS_GROUP = 30009; // CustomShops.plugin.js GROUP_ID
const CUSTOM_ROW_UID = (CUSTOM_SHOPS_GROUP << 16) | 100; // the panel's first shop row (LEFT_LABEL_START)
const CUSTOM_NOTED_UID = (CUSTOM_SHOPS_GROUP << 16) | 6; // its Buy noted toggle
const NO_PERMISSION = "You do not have permission to use this command."; // the core's refusal of a command's rank
const NOT_HERE = "That is not available on this world.";
// The seven levels a preset sets, in its own stat order (Presets.PvpMode.js COMBAT_SKILLS).
const COMBAT = ["ATTACK", "DEFENCE", "STRENGTH", "HITPOINTS", "RANGED", "PRAYER", "MAGIC"];

let loading = null;
/** The server as such a test loads it, once, on first use (so the parent spawns its child before it loads). */
function load() {
  loading ??= (async () => {
    await CachePipeline.initialize(path.resolve(__dirname, ".."));
    PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
    RegionManager.init();
    RegionManager.loadMapFiles(3222, 3218);
    PM.emitServerStartup({});
    new ShopDefinitionLoader().load();
    ShopManager.initialize();
  })();
  return loading;
}

let index = 1960;
function actor(t, rights = PlayerRights.NONE, { bot = false, at = new Location(3222, 3218, 0) } = {}) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel), at);
  p.setIndex(index++);
  p.setUsername("noshops" + p.getIndex());
  p.setRegistered(true);
  p.setAttribute("bot-skip-persistence", true);
  p.needsPlacement = false;
  p.setRights(rights);
  if (bot) p.setPlayerBot(true);
  for (const name of COMBAT) p.getSkillManager().setMaxLevel(Skill[name], 70).setCurrentLevels(Skill[name], 70);
  const messages = [];
  t.mock.method(p.getPacketSender(), "sendMessage", (message) => { messages.push(message); return p.getPacketSender(); });
  t.after(() => p.setRegistered(false));
  const held = () => [...p.getInventory().getItems(), ...p.getEquipment().getItems()].filter((item) => item?.getId() > 0).length;
  const levels = () => COMBAT.map((name) => p.getSkillManager().getMaxLevel(Skill[name]));
  return { p, messages, held, levels };
}

/** The quests the presets' gear asks for (Death Plateau's climbing boots ...): the administrators' ::allquests. */
function withAllQuests(f) {
  const rights = f.p.getRights();
  f.p.setRights(PlayerRights.ADMINISTRATOR);
  ChatPacketListener.handleText(f.p, "::allquests");
  f.p.setRights(rights);
  f.p.getPacketSender().closeInterruptibleInterfaces();
  f.p.setInterfaceId(-1);
  f.p.getInventory().resetItems();
  f.p.getEquipment().resetItems();
  f.messages.length = 0;
}

const typed = (f, text) => { f.messages.length = 0; ChatPacketListener.handleText(f.p, text); return [...f.messages]; };
const commands = (p) => new Set(PM.getRegisteredCommands(p).map(({ command }) => command));
const openShop = (p) => ShopManager.getOpenShop(p)?.name ?? null;
const shopName = (id) => ShopDefinition.forId(id).getName();
const presetsOpen = (p) => p.getInterfaceId() === PresetsWidget.GROUP_ID;
const click = (p, uid) => InterfaceActionClickOpcode.handle(p, uid, 1, { groupId: uid >>> 16, childId: uid & 0xffff });
const journalShowsPresets = (available) =>
  Journal.buttonPositions(available).some(({ component }) => component === Journal.COMPONENT.PRESETS);

/** The OpenPresetsAfterDeath tasks a PvP death submits for `victim`. */
function deathOpenings(t, victim) {
  const killer = actor(t).p;
  const submitted = [];
  const submit = t.mock.method(TaskManager, "submit", (task) => { submitted.push(task); });
  try {
    PM.emitPlayerDefeated(killer, victim);
  } finally {
    submit.mock.restore();
  }
  return submitted.filter((task) => task instanceof PvpMode._test.OpenPresetsAfterDeath && task.player === victim).length;
}

/** What PvP mode answers PrayerUnlocks: whether the prayers are this player's without their quests and scrolls. */
function prayerBypass(p) {
  const event = { player: p, prayer: PM.getCoreApi().PrayerData.PIETY, bypass: false };
  PM.emitCustomEvent("prayer:unlocks-bypass", event);
  return event.bypass;
}

/** Bots gear up for the Wilderness through the preset code, as PvpLoadoutPolicy does on a live world. */
function botsDress(t) {
  const edgeville = new Location(3093, 3493, 0);
  const bot = actor(t, PlayerRights.NONE, { bot: true, at: edgeville });
  const state = { pvp: { profileId: "elite", loadoutId: "deep_wild_hybrid", generatedArchetypeId: "elite_ancients_dbow" } };
  assert.equal(applyGeneratedPvpLoadout(bot.p, state, { api: PM.createApi("NoShopsAndPresetsTest") }), true, "the loadout is applied");
  assert.ok(bot.p.getEquipment().getItems().some((item) => item?.getId() > 0), "the bot wears its kit");
  assert.ok(bot.p.getAttribute("pvp:current-preset"), "pvp:current-preset is set");
  const other = actor(t, PlayerRights.NONE, { bot: true, at: edgeville });
  const preset = Presets.getGlobalPresetPool()[0];
  assert.equal(Presets.applyPreset(other.p, preset), true, "a global preset loads on a bot");
  assert.deepEqual(other.levels(), preset.getStats().map(Number), "with the preset's levels");
  assert.ok(other.held() > 0, "and its gear");
}

if (!DEFAULTS) {
  test("with both settings at their default, the original project's behaviour is back (a child process of this file)", () => {
    const env = { ...process.env, NOSHOPS_TEST_DEFAULTS: "1" };
    delete env.NODE_TEST_CONTEXT; // node --test's channel to its own children: the child reports as a plain run
    const run = spawnSync(process.execPath, ["--max-old-space-size=4096", __filename],
      { env, encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
    const output = `${run.stdout}\n${run.stderr}`;
    assert.equal(run.status, 0, output.slice(-8000));
    assert.match(output, /\bfail 0\b/);
    assert.match(output, /\bpass [1-9]/);
  });

  test("our world.json turns both settings off", () => {
    assert.equal(shipped.pluginConfig[SHOPS_SETTING], false);
    assert.equal(shipped.pluginConfig[PRESETS_SETTING], false);
  });

  test("an ordinary player, a moderator or an administrator is refused ::shops, and the custom shops by any road", async (t) => {
    await load();
    for (const id of PK_SHOPS) assert.ok(CUSTOM_SHOP_IDS.includes(id), `PK shop ${id} is a custom shop`);
    for (const rights of [PlayerRights.NONE, PlayerRights.MODERATOR, PlayerRights.ADMINISTRATOR]) {
      const f = actor(t, rights);
      assert.equal(commands(f.p).has("shops"), false, "::shops is not in the ::commands list");
      assert.deepEqual(typed(f, "::shops"), [NO_PERMISSION]);
      assert.equal(openShop(f.p), null);
      // What an NPC bound to one, a dialogue's open_shop or another plugin does: ShopManager.open with the shop's id.
      for (const id of CUSTOM_SHOP_IDS) {
        f.messages.length = 0;
        ShopManager.open(f.p, id);
        assert.equal(openShop(f.p), null, `custom shop ${id}`);
        assert.deepEqual(f.messages, [NOT_HERE], `custom shop ${id}`);
      }
      assert.equal(f.held(), 0, "nothing was bought or handed out");
    }
  });

  test("the ::shops panel's own buttons do nothing for a player who has another shop open", async (t) => {
    await load();
    const f = actor(t);
    assert.equal(ShopManager.open(f.p, LUMBRIDGE_GENERAL_STORE), true, "an ordinary shop still opens");
    assert.equal(openShop(f.p), "Lumbridge General Store");
    f.messages.length = 0;
    click(f.p, CUSTOM_ROW_UID); // "select" the panel's first custom shop
    click(f.p, CUSTOM_NOTED_UID);
    assert.equal(openShop(f.p), "Lumbridge General Store", "the general store is still the open shop");
    assert.deepEqual(f.messages, [NOT_HERE]);
    assert.notEqual(f.p.getAttribute("custom-shops:buy-noted"), true);
  });

  test("owners and developers keep ::shops, the custom shops and the PK shops", async (t) => {
    await load();
    for (const rights of [PlayerRights.OWNER, PlayerRights.DEVELOPER]) {
      const f = actor(t, rights);
      assert.equal(commands(f.p).has("shops"), true);
      const said = typed(f, "::shops");
      assert.ok(!said.includes(NO_PERMISSION) && !said.includes(NOT_HERE), said.join(" | "));
      assert.equal(openShop(f.p), shopName(CUSTOM_SHOP_IDS[0]));
      for (const id of PK_SHOPS) {
        ShopManager.open(f.p, id);
        assert.equal(openShop(f.p), shopName(id));
      }
    }
  });

  test("an ordinary player, a moderator or an administrator is refused presets by every road", async (t) => {
    await load();
    for (const rights of [PlayerRights.NONE, PlayerRights.MODERATOR, PlayerRights.ADMINISTRATOR]) {
      const f = actor(t, rights);
      const earned = f.levels();
      // The Character Summary's Presets button and the ::commands list go by the commands a player may run.
      const available = commands(f.p);
      assert.equal(available.has("presets") || available.has("kits"), false);
      assert.equal(journalShowsPresets(available), false, "the Character Summary shows no Presets button");
      assert.deepEqual(typed(f, "::presets"), [NO_PERMISSION]);
      assert.deepEqual(typed(f, "::kits"), [NO_PERMISSION]);
      assert.equal(presetsOpen(f.p), false);
      // "presets:open" (the button's event) with a shop open: the refusal is all that happens.
      ShopManager.open(f.p, LUMBRIDGE_GENERAL_STORE);
      f.messages.length = 0;
      PM.emitCustomEvent("presets:open", { player: f.p });
      assert.deepEqual(f.messages, [NOT_HERE]);
      assert.equal(openShop(f.p), "Lumbridge General Store", "nothing was closed");
      assert.equal(presetsOpen(f.p), false);
      // The interface's buttons without the interface, then the loading itself (what Load calls), every global preset.
      f.messages.length = 0;
      click(f.p, PresetsWidget.uid(PresetsWidget.PRESET_ROW_START));
      click(f.p, PresetsWidget.uid(PresetsWidget.COMPONENT.LOAD_BUTTON));
      for (const preset of Presets.getGlobalPresetPool()) assert.equal(Presets.applyPreset(f.p, preset), false, preset.getName());
      assert.ok(f.messages.length > 0 && f.messages.every((message) => message === NOT_HERE), f.messages.join(" | "));
      assert.deepEqual(f.levels(), earned, "their levels are as they earned them");
      assert.equal(f.held(), 0, "no preset gear");
    }
  });

  test("presets do not open after an ordinary player's PvP death, and the prayers need their quests", async (t) => {
    await load();
    const f = actor(t);
    assert.equal(deathOpenings(t, f.p), 0);
    assert.equal(prayerBypass(f.p), false, "no prayer:unlocks-bypass from PvP mode");
    const { PrayerData } = PM.getCoreApi();
    assert.equal(PM.emitPrayerDisabled(f.p, PrayerData.RIGOUR)?.message, "You have not unlocked that prayer.");
    assert.ok(PM.emitPrayerDisabled(f.p, PrayerData.PIETY), "Piety needs King's Ransom and the Knight Waves");
    // A prayer the player earned stays theirs: the scroll's unlock is saved on the account, the bypass never was.
    f.p.setAttribute("prayer:rigour-unlocked", true);
    assert.equal(PM.emitPrayerDisabled(f.p, PrayerData.RIGOUR), null);
  });

  test("owners and developers keep presets: commands, button, interface, loading, the opening after a death, the prayers", async (t) => {
    await load();
    for (const rights of [PlayerRights.OWNER, PlayerRights.DEVELOPER]) {
      const f = actor(t, rights);
      const available = commands(f.p);
      assert.equal(available.has("presets") && available.has("kits"), true);
      assert.equal(journalShowsPresets(available), true);
      assert.ok(!typed(f, "::presets").includes(NOT_HERE));
      assert.equal(presetsOpen(f.p), true);
      withAllQuests(f);
      const preset = Presets.getGlobalPresetPool()[0];
      assert.equal(Presets.applyPreset(f.p, preset), true, f.messages.join(" | "));
      assert.deepEqual(f.levels(), preset.getStats().map(Number));
      assert.ok(f.held() > 0);
      assert.equal(deathOpenings(t, f.p), 1);
      assert.equal(prayerBypass(f.p), true);
    }
  });

  test("bots still dress from presets", async (t) => {
    await load();
    botsDress(t);
  });
} else {
  test("defaults: ordinary players have ::shops, the custom shops and the PK shops", async (t) => {
    await load();
    const f = actor(t);
    assert.equal(commands(f.p).has("shops"), true);
    const said = typed(f, "::shops");
    assert.ok(!said.includes(NO_PERMISSION) && !said.includes(NOT_HERE), said.join(" | "));
    assert.equal(openShop(f.p), shopName(CUSTOM_SHOP_IDS[0]));
    for (const id of CUSTOM_SHOP_IDS) {
      ShopManager.open(f.p, id);
      assert.equal(openShop(f.p), shopName(id), `custom shop ${id}`);
    }
  });

  test("defaults: ordinary players have presets: commands, button, interface, loading, the opening after a death, the prayers", async (t) => {
    await load();
    const f = actor(t);
    const available = commands(f.p);
    assert.equal(available.has("presets") && available.has("kits"), true);
    assert.equal(journalShowsPresets(available), true);
    assert.ok(!typed(f, "::kits").includes(NOT_HERE));
    assert.equal(presetsOpen(f.p), true);
    f.p.setInterfaceId(-1);
    PM.emitCustomEvent("presets:open", { player: f.p });
    assert.equal(presetsOpen(f.p), true);
    withAllQuests(f);
    const preset = Presets.getGlobalPresetPool()[0];
    assert.equal(Presets.applyPreset(f.p, preset), true, f.messages.join(" | "));
    assert.deepEqual(f.levels(), preset.getStats().map(Number));
    assert.ok(f.held() > 0);
    assert.equal(deathOpenings(t, f.p), 1);
    assert.equal(prayerBypass(f.p), true);
  });

  test("defaults: bots still dress from presets", async (t) => {
    await load();
    botsDress(t);
  });
}
