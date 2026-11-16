/**
 * Ours. GET /api/world-status: how this world is right now, in a few bytes, for a landing page's
 * list of worlds (deploy/worlds.mjs asks every listed world this, a few times a minute).
 *
 *   { "name": "Kat-Net", "description": "...", "experienceRate": 10, "players": 3, "bots": 1475 }
 *
 * players  people with a live connection; bots are never counted among them
 * bots     the bots walking the world
 *
 * Nothing here is private: it is what the login screen and the hiscores already show.
 */
let core;

function status(query, segments) {
  if (segments.length) return undefined;
  const world = core.WorldDefinition.getWorldDefinition();
  let players = 0;
  let bots = 0;
  for (const player of core.World.getPlayers()) {
    if (!player) continue;
    if (player.isPlayerBot?.() === true) bots++;
    else if (core.World.isPlayerSessionConnected(player)) players++;
  }
  return {
    name: String(world.name ?? ""),
    description: String(world.description ?? ""),
    experienceRate: Number(world.experienceMultiplier) || 1,
    players,
    bots,
  };
}

module.exports = {
  name: "WorldStatus",
  description: "Answers /api/world-status with the world's name, experience rate and how many players and bots are on it, for a landing page's world list.",
  register(api) {
    core = api.core;
    api.registerContentEndpoint("world-status", status);
  },
  _test: { status, setCore: (value) => { core = value; } },
};
