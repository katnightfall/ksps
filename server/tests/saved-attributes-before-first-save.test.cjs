// Ours. Run after `yarn build`: node --test tests/saved-attributes-before-first-save.test.cjs
// The remembered attack style of each weapon type ("combat:style-by-category") was made a saved
// attribute only inside PlayerSave.fromPlayer, that is by the first save any player got after the
// server started. A login before that did not read it from the save, and that player's next save
// then wrote the save without it. This file must not save anyone before its first login: it is
// the first minutes of a freshly started server.
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
const { COMBAT_STYLE_BY_CATEGORY_ATTRIBUTE } = require("../dist/game/content/combat/FightType");

let persistence = null;
require("../plugins/persistence/SqlitePlayerPersistence.plugin").register({
  getSkillManager: () => require("../dist/game/content/skill/SkillManager").SkillManager,
  setPlayerPersistence: (backend) => { persistence = backend; },
  log() {},
});

test("the first login after a start reads the remembered attack styles, and the save after it keeps them", async () => {
  const styles = { 4: 2, 17: 1 };
  // A save as another start of the server wrote it.
  const written = persistence.hydratePlayerSave({ displayName: "Zezima", attributes: { [COMBAT_STYLE_BY_CATEGORY_ATTRIBUTE]: styles, [Player.BANK_PLACEHOLDERS_ATTRIBUTE]: true } });
  persistence.saveOffline("Zezima", written, "seed");
  await persistence.flush();
  // The server has saved nobody yet; the first player logs in.
  const player = new Player(null);
  player.setUsername("Zezima");
  persistence.load("Zezima").applyToPlayer(player);
  assert.deepEqual(player.getAttribute(COMBAT_STYLE_BY_CATEGORY_ATTRIBUTE), styles, "read from the save");
  assert.equal(player.getAttribute(Player.BANK_PLACEHOLDERS_ATTRIBUTE), true);
  persistence.save(player, "logout");
  await persistence.flush();
  assert.deepEqual(persistence.load("Zezima").attributes[COMBAT_STYLE_BY_CATEGORY_ATTRIBUTE], styles, "and still in the save after the next one");
  // A new account, before anyone was saved, starts with the same defaults as one made later.
  const fresh = new Player(null);
  PlayerSave.applyAttributeDefaults(fresh);
  assert.deepEqual(fresh.getAttribute(COMBAT_STYLE_BY_CATEGORY_ATTRIBUTE), {});
  assert.equal(fresh.getAttribute(Player.BANK_QUANTITY_MODE_ATTRIBUTE), 0);
});
