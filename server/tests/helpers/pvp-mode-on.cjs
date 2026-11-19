// Preset tests need the PvpMode plugin (it owns Presets) whatever a worktree's gitignored
// world.local.json says: test and play worlds often turn PvP off there. Require this before
// PluginManager.loadFromDirectory; it keeps every other world setting as configured.
// Ours: and presets open to every player, as the original project has them: our world.json keeps
// them for owners and developers (PvpMode:players off), and these tests have ordinary players load them.
const WorldDefinition = require("../../dist/game/definition/WorldDefinition");

const PRESETS_FOR_PLAYERS = { "PvpMode:players": true };
const readWorldConfig = WorldDefinition.readWorldConfig;
WorldDefinition.readWorldConfig = function readWorldConfigWithPvpMode() {
  const config = readWorldConfig();
  const pluginConfig = { ...(config.pluginConfig ?? {}), ...PRESETS_FOR_PLAYERS };
  if (config.disabledPlugins !== undefined) {
    const disabled = Array.isArray(config.disabledPlugins) ? config.disabledPlugins : [];
    return { ...config, pluginConfig, disabledPlugins: disabled.filter((name) => String(name).toLowerCase() !== "pvpmode") };
  }
  return { ...config, pluginConfig, plugins: { ...(config.plugins ?? {}), PvpMode: true } };
};
