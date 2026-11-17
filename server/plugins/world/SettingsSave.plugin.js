/**
 * Ours. A changed setting is saved within seconds.
 *
 * A player's settings (the bank's placeholders, note and quantity modes, its settings menu, the
 * All Settings values, key binds, chat filters, the game frame's layout, auto retaliate, sound
 * volumes, quick prayers...) are part of the save, and the save is written at logout, at
 * shutdown and by the autosave, every five to ten minutes. So a setting changed a minute before
 * a crash was lost, and on our worlds, which share characters through a master
 * (MasterSync.plugin.js), a player who moved to another world found the old setting there
 * until the first world had saved.
 *
 * Every few seconds this looks at each person's settings, and saves a player whose settings
 * are not what they were at the last look. Nothing else about saving changes: what is saved,
 * and how, is the save database's own business.
 */
const ENABLED_CONFIG = "SettingsSave:enabled";
/** How often the settings are looked at, in game ticks (0.6 s each). */
const CHECK_TICKS = 10;
const REASON = "settings";
/**
 * The saved attributes that are settings: choices a player makes about how the game behaves or
 * looks for them, not progress. (Everything else in a save is written as it always was.)
 */
const SETTING_KEY = new RegExp("^(" + [
  "bank:", "bank-settings:", "settings[:.]", "keybind_", "client-layout", "chat\\.filters$", "accept-aid$",
  "xp-drops:", "side-channels:", "tab-filters:", "friends-list:", "warning-screens:", "teleports:(favourites|skip)",
  "looting-bag:(store|skip)", "loot-key-settings$", "loot-keys-enabled$", "music:(selected|playlists)",
  "rune-pouch:(selected|custom)", "grouping:",
].join("|") + ")");

let api;
let core;
let tick = 0;
/** Each person's settings as last seen. */
const seen = new WeakMap();
let keys = null;
let keysFrom = -1;

/** The setting attributes, read again when plugins have registered more. */
function settingKeys(PlayerSave) {
  const all = PlayerSave.persistentAttributeKeys;
  if (!keys || keysFrom !== all.size) {
    keys = [...all].filter((key) => SETTING_KEY.test(key)).sort();
    keysFrom = all.size;
  }
  return keys;
}

/** A player's settings as one string: equal strings, equal settings. */
function fingerprint(player, PlayerSave) {
  const parts = [];
  for (const key of settingKeys(PlayerSave)) {
    const value = player.getAttribute(key);
    if (value !== undefined) parts.push(key, value);
  }
  return JSON.stringify([
    player.autoRetaliateReturn?.() === true,
    player.getAudioSettings?.() ?? null,
    (player.getQuickPrayers?.()?.getPrayers?.() ?? []).map((prayer) => prayer?.configId ?? null),
    parts,
  ]);
}

/** One look at everyone: a player whose settings changed since the last look is saved. Returns who. */
function check(PlayerSave = core.PlayerSave) {
  const saved = [];
  for (const player of core.World.getPlayers()) {
    if (!player || player.isPlayerBot?.() === true) continue;
    let now;
    try {
      now = fingerprint(player, PlayerSave);
    } catch {
      continue;
    }
    const before = seen.get(player);
    seen.set(player, now);
    // The first look (they have just logged in) is what the settings are, not a change.
    if (before === undefined || before === now) continue;
    core.GameConstants.PLAYER_PERSISTENCE.requestSave(player, REASON);
    saved.push(player);
  }
  return saved;
}

module.exports = {
  name: "SettingsSave",
  description: "Saves a player within seconds of a change to their settings (bank options, All Settings, key binds, chat filters, layout, auto retaliate, volumes, quick prayers), instead of at the next autosave or logout.",
  config: {
    [ENABLED_CONFIG]: {
      type: "boolean", label: "Save changed settings at once", default: true,
      help: "A player whose settings changed is saved within a few seconds, so a setting survives a crash and is there at once on another world of the same master. Off: settings are saved with everything else, at logout and by the autosave.",
    },
  },
  register(pluginApi) {
    api = pluginApi;
    core = pluginApi.core;
    const { PlayerSave } = require("../../src/main/typescript/elvarg/game/entity/impl/player/persistence/PlayerSave");
    api.onServerStartup?.(() => {
      const { Task, TaskManager } = core;
      TaskManager.submit(new (class extends Task {
        constructor() {
          super(1, "settings-save");
        }
        execute() {
          if (++tick % CHECK_TICKS !== 0 || api.getPluginConfig?.(ENABLED_CONFIG, true) === false) return;
          check(PlayerSave);
        }
      })());
    });
  },
  _test: { check, fingerprint, settingKeys, SETTING_KEY, REASON, setCore: (value) => { core = value; } },
};
