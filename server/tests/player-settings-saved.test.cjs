// Ours. Run after `yarn build`: node --test tests/player-settings-saved.test.cjs
// A player's settings are saved, come back at the next login, are the same on another world of
// the master, and are written within seconds of being changed (plugins/world/SettingsSave.plugin.js).
// Every plugin is loaded, so the save holds what a real world's save holds; the save database is
// the real one, on a file of its own.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { before, after, test } = require("node:test");
const { pathToFileURL } = require("node:url");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "player-settings-"));
process.env.PLAYER_SAVE_DATABASE_PATH = path.join(dir, "players.sqlite");
process.env.DISABLE_PLAYER_BOTS = "1";
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSave } = require("../dist/game/entity/impl/player/persistence/PlayerSave");
const SettingsSave = require("../plugins/world/SettingsSave.plugin");

let core;
let persistence;
let names = 0;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  persistence = core.GameConstants.PLAYER_PERSISTENCE;
});
after(async () => {
  await persistence.flush().catch(() => {});
  try { persistence.database.close(); } catch {}
  try { persistence.writer?.terminate(); } catch {}
  // Windows keeps the database file locked until the writer thread has gone: best effort.
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch {}
  // Loaded plugins leave timers running; the checks are done.
  setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
});

function character(t, name = `settingstest${++names}`) {
  const p = new Player(null);
  p.getSession = () => ({ sendClientPacket: () => true, write: () => true });
  p.setUsername(name);
  p.sendMessage = () => {};
  PlayerSave.applyAttributeDefaults(p);
  t.after(() => core.TaskManager.cancelTasks(p));
  return p;
}

/** The settings a player might change in a session, each away from its default. */
const ATTRIBUTES = {
  "bank-settings:incinerator": 1,
  "bank-settings:hide-inventory-options": 1,
  "bank-settings:bank-item-options": 1,
  "bank-settings:hide-deposit-worn": 1,
  "bank-settings:tab-display": 2,
  "bank-settings:filler-mode": 3,
  "bank-settings:deposit-locks": 0b1010,
  "bank-settings:deposit-lock-ops": 1,
  "settings:values": { "varbit:4181": 1, "varp:168": 3 },
  "keybind_4675": 5,
  "chat.filters": [1, 2, 1],
  "accept-aid": false,
  "xp-drops:enabled": false,
  "tab-filters:prayer": 3,
  "teleports:skip-wilderness-warning": true,
  "looting-bag:store-everything": true,
};

function change(p) {
  p.setPlaceholders(true);
  p.setNoteWithdrawal(true);
  p.setInsertMode(true);
  p.setBankQuantityMode(3);
  p.setBankCustomQuantity(77);
  p.setAutoRetaliate(false);
  for (const [key, value] of Object.entries(ATTRIBUTES)) p.setAttribute(key, structuredClone(value));
}

function assertChanged(p, where) {
  assert.equal(p.isPlaceholders(), true, `always set placeholders, ${where}`);
  assert.equal(p.withdrawAsNote(), true, `withdraw as note, ${where}`);
  assert.equal(p.insertModeReturn(), true, `insert mode, ${where}`);
  assert.equal(p.getBankQuantityMode(), 3, `quantity mode, ${where}`);
  assert.equal(p.getBankCustomQuantity(), 77, `custom quantity, ${where}`);
  assert.equal(p.autoRetaliateReturn(), false, `auto retaliate, ${where}`);
  for (const [key, value] of Object.entries(ATTRIBUTES)) assert.deepEqual(p.getAttribute(key), value, `${key}, ${where}`);
}

test("the attributes checked here are ones the game saves (a renamed one would be a silent hole)", () => {
  for (const key of Object.keys(ATTRIBUTES)) assert.ok(PlayerSave.persistentAttributeKeys.has(key), key);
  for (const key of ["bank:placeholders", "bank:note-withdrawal", "bank:insert-mode", "bank:quantity-mode", "bank:custom-quantity"]) {
    assert.ok(PlayerSave.persistentAttributeKeys.has(key), key);
  }
});

test("bank options, the bank's settings menu and the other settings come back at the next login", async (t) => {
  const p = character(t);
  change(p);
  persistence.save(p, "logout");
  await persistence.flush();
  const back = character(t, p.getUsername());
  persistence.load(p.getUsername()).applyToPlayer(back);
  assertChanged(back, "after logging back in");
  // And off again is saved as well as on.
  back.setPlaceholders(false);
  back.setAttribute("bank-settings:incinerator", 0);
  persistence.save(back, "logout");
  await persistence.flush();
  const again = character(t, p.getUsername());
  persistence.load(p.getUsername()).applyToPlayer(again);
  assert.equal(again.isPlaceholders(), false);
  assert.equal(Number(again.getAttribute("bank-settings:incinerator")) || 0, 0);
  assert.equal(again.withdrawAsNote(), true, "the rest is as it was");
});

test("they are the same on another world: the save goes through the master as it was written", async (t) => {
  const { createCharacterStore } = await import(pathToFileURL(path.join(__dirname, "../../deploy/master/characters.mjs")).href);
  const store = createCharacterStore(path.join(dir, "characters.sqlite"));
  t.after(() => store.close());
  const p = character(t);
  change(p);
  persistence.save(p, "logout");
  await persistence.flush();
  const key = persistence.saveKey(p.getUsername());
  const json = persistence.currentJson(key);
  assert.deepEqual(store.save("4 - SD", key, json, { release: true }).version, 1);
  // Dallas asks for the account's saves at its login, and plays from what it is given.
  const [row] = store.checkout("1 - Dallas", [key]).rows;
  assert.equal(row.json, json);
  const onDallas = character(t, p.getUsername());
  persistence.hydratePlayerSave(JSON.parse(row.json, persistence.reviver.bind(persistence))).applyToPlayer(onDallas);
  assertChanged(onDallas, "on the other world");
});

test("a changed setting is saved at the next look, once; no change, no save; bots are not looked at", (t) => {
  const p = character(t);
  const robot = character(t);
  robot.isPlayerBot = () => true;
  const asked = [];
  SettingsSave._test.setCore({
    World: { getPlayers: () => [p, robot, null] },
    GameConstants: { PLAYER_PERSISTENCE: { requestSave: (player, reason) => asked.push([player, reason]) } },
  });
  t.after(() => SettingsSave._test.setCore(core));
  const look = () => SettingsSave._test.check(PlayerSave);
  assert.deepEqual(look(), [], "the first look is what the settings are");
  assert.deepEqual(look(), []);
  p.setPlaceholders(true);
  robot.setPlaceholders(true);
  assert.deepEqual(look(), [p]);
  assert.deepEqual(asked, [[p, "settings"]]);
  assert.deepEqual(look(), [], "saved once");
  for (const [act, what] of [
    [() => p.setAttribute("bank-settings:tab-display", 1), "the bank menu's tab display"],
    [() => p.setAttribute("settings:values", { "varbit:4181": 1 }), "an All Settings row"],
    [() => p.setAttribute("keybind_4675", 9), "a key bind"],
    [() => p.setAttribute("chat.filters", [2, 0, 0]), "a chat filter"],
    [() => p.setAutoRetaliate(!p.autoRetaliateReturn()), "auto retaliate"],
    [() => p.setBankQuantityMode(2), "the bank's quantity"],
  ]) {
    act();
    assert.deepEqual(look(), [p], what);
  }
  // Progress is not a setting: it waits for the autosave as before.
  p.setAttribute("quest.cooks_assistant.stage", 3);
  p.getInventory().adds(995, 100);
  assert.deepEqual(look(), []);
});

test("which saved attributes count as settings", () => {
  const keys = SettingsSave._test.settingKeys(PlayerSave);
  for (const key of ["bank:placeholders", "bank-settings:tab-display", "bank-settings:deposit-locks", "settings:values", "keybind_4675",
    "client-layout-root", "chat.filters", "accept-aid", "xp-drops:enabled", "tab-filters:prayer", "settings.run-auto-enable"]) {
    assert.ok(keys.includes(key), key);
  }
  for (const key of ["bank-pin:hash", "bank-space:blocks", "music:unlocked-tracks", "killstreaks:total-kills", "grand-exchange-offers"]) {
    assert.ok(!keys.includes(key), `${key} is not a setting`);
  }
  assert.ok(keys.length >= 40 && keys.length < 200, `${keys.length} setting attributes`);
});
