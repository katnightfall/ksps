const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");
const { GameConstants } = require("../../src/main/typescript/elvarg/game/GameConstants");
const Presets = require("./pvp/Presets.PvpMode");

function openPresets({ player }) {
  // Ours: a world that keeps presets from its players (PvpMode:players) says so, and closes nothing first.
  if (Presets.keptFromPresets(player)) {
    player.sendMessage(Presets.NOT_ON_THIS_WORLD);
    return true;
  }
  if (player.busy?.()) {
    player.getPacketSender().sendInterfaceRemoval();
  }
  Presets.openPresetInterface(player);
  return true;
}

const OPEN_PRESETS_DELAY_TICKS = 2;
let TaskManager;
let pluginApi = null;

/** The player's respawn point (RespawnPoints.plugin.js: Edgeville, Ferox Enclave ...), else the world's spawn. */
function respawnPointOf(player) {
  const request = { player, location: null };
  pluginApi?.emitCustomEvent?.("respawn-point:location", request);
  return request.location ?? GameConstants.DEFAULT_LOCATION;
}

function isAtRespawnPoint(player) {
  const location = player?.getLocation?.();
  const respawn = respawnPointOf(player);
  if (!location || !respawn) {
    return false;
  }
  return (
    location.getX?.() === respawn.getX?.() &&
    location.getY?.() === respawn.getY?.() &&
    location.getZ?.() === respawn.getZ?.()
  );
}

class OpenPresetsAfterDeath extends Task {
  constructor(player) {
    super(OPEN_PRESETS_DELAY_TICKS, false);
    this.player = player;
  }

  execute() {
    this.stop();
    const player = this.player;
    if (!player.isRegistered?.() || player.getHitpoints?.() <= 0
        || !Presets.shouldOpenOnDeath(player) || !isAtRespawnPoint(player)) return;
    openPresets({ player });
  }
}

function openPresetsAfterDeath({ victim }) {
  if (!victim || victim.isPlayerBot?.() || !Presets.shouldOpenOnDeath(victim) || !Presets.canUsePresets(victim, true)) return;
  TaskManager.submit(new OpenPresetsAfterDeath(victim));
}

/**
 * Presets assume the unlocked prayers, so PvP mode hands them out without the quests and scrolls,
 * but only to an account that may load presets: an Ironman (every league character) earns them.
 */
function bypassPrayerUnlocks(event) {
  if (Presets.accountMayUsePresets(event.player)) event.bypass = true;
}

/**
 * Ours: the rank ::presets and ::kits need. Anyone's, as in the original project, unless the world keeps presets for
 * owners and developers (PvpMode:players off): then the commands, their lines in ::commands and the Character
 * Summary's Presets button are theirs alone.
 */
function presetsCommandRank() {
  return Presets.playersMayUsePresets() ? undefined : pluginApi.core.PlayerRights.OWNER;
}

module.exports = {
  name: "PvpMode",
  description: "Adds the ::presets and ::kits commands, opens presets after a PvP death, and lets accounts that may use presets have their prayers without the unlock quests. A world may keep all of it for owners and developers (PvpMode:players); bots still dress from presets.",
  config: {
    [Presets.PLAYERS_CONFIG]: {
      type: "boolean", label: "Presets for every player", default: true,
      help: "On, as on the original project's PvP worlds: every player may open presets (::presets, ::kits, the Character Summary's Presets button) and load one, which hands out PvP gear and sets the seven combat levels with their experience; presets open after a PvP death; and an account that may use presets has every prayer without its quest or scroll. Off, for a world where levels are earned: all of that is for owners and developers only, and other players are told it is not available. Bots still dress from presets.",
    },
  },
  _test: { OpenPresetsAfterDeath, isAtRespawnPoint },
  register(api) {
    pluginApi = api;
    TaskManager = api.getTaskManager();
    Presets.register(api);
    api.registerCommand("presets", openPresets, presetsCommandRank(), "Open the presets interface");
    api.registerCommand("kits", openPresets, presetsCommandRank(), "Open the presets interface");
    api.onPlayerDefeated(openPresetsAfterDeath);
    api.onCustomEvent("presets:open", openPresets);
    api.onCustomEvent("prayer:unlocks-bypass", bypassPrayerUnlocks);
  },
};
