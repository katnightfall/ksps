// Ours. Run after `yarn build`: node --test tests/saved-attributes-carried.test.cjs
// Our worlds share their characters and are not always the same server: they restart one by one
// after an update, and a plugin can be switched off on one world. A save's attributes were read
// and written by the list of attributes the running server saves, so anything in a save under a
// key this server did not know was left out of the character's next save: one visit to such a
// world wiped that plugin's progress from the character, on every world.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.PLAYER_SAVE_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tsps-saves-")), "players.sqlite");
process.env.PLAYER_SAVE_IMPORT_LEGACY_JSON = "0";
require("../dist/Server").Server.installProductionPathResolver();
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSave } = require("../dist/game/entity/impl/player/persistence/PlayerSave");

let persistence = null;
require("../plugins/persistence/SqlitePlayerPersistence.plugin").register({
  getSkillManager: () => require("../dist/game/content/skill/SkillManager").SkillManager,
  setPlayerPersistence: (backend) => { persistence = backend; },
  log() {},
});

function login(name) {
  const player = new Player(null);
  player.setUsername(name);
  persistence.load(name).applyToPlayer(player);
  return player;
}

test("what a save holds that this server does not save stays in the save", async () => {
  PlayerSave.persistAttribute("known-plugin:points", 0);
  // Written on a world that runs a plugin this one does not (newer, or switched off here).
  const elsewhere = persistence.hydratePlayerSave({
    displayName: "Zezima",
    attributes: { "known-plugin:points": 40, "other-world-plugin:progress": { stage: 3, items: [[4151, 1]] }, "other-world-plugin:unlocked": true },
  });
  persistence.saveOffline("Zezima", elsewhere, "seed");
  await persistence.flush();

  const player = login("Zezima");
  assert.equal(player.getAttribute("known-plugin:points"), 40);
  assert.equal(player.getAttribute("other-world-plugin:progress"), undefined, "this server gives the player nothing it does not understand");
  player.setAttribute("known-plugin:points", 55);
  persistence.save(player, "logout");
  await persistence.flush();

  const saved = persistence.load("Zezima").attributes;
  assert.equal(saved["known-plugin:points"], 55);
  assert.deepEqual(saved["other-world-plugin:progress"], { stage: 3, items: [[4151, 1]] }, "kept as it was read");
  assert.equal(saved["other-world-plugin:unlocked"], true);
  assert.equal(PlayerSave.CARRIED_ATTRIBUTES in saved, false, "and nothing of the carrying itself is saved");

  // Back on a server that saves the attribute, it is the player's own again and changes are kept.
  PlayerSave.persistAttribute("other-world-plugin:progress", null);
  PlayerSave.persistAttribute("other-world-plugin:unlocked", false);
  const back = login("Zezima");
  assert.deepEqual(back.getAttribute("other-world-plugin:progress"), { stage: 3, items: [[4151, 1]] });
  back.setAttribute("other-world-plugin:progress", { stage: 4, items: [] });
  persistence.save(back, "logout");
  await persistence.flush();
  assert.deepEqual(persistence.load("Zezima").attributes["other-world-plugin:progress"], { stage: 4, items: [] });

  // A player with nothing unknown in their save carries nothing.
  const plain = new Player(null);
  plain.setUsername("Plain");
  persistence.save(plain, "logout");
  await persistence.flush();
  assert.equal(login("Plain").getAttribute(PlayerSave.CARRIED_ATTRIBUTES), undefined);
});
