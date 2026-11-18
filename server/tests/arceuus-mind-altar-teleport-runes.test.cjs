// Run after `yarn build`: node --test tests/arceuus-mind-altar-teleport-runes.test.cjs
// Ours: Wiki (Mind Altar Teleport): 28 Magic, one law rune and two mind runes. The spell took one mind and
// two law. Real engine: every plugin loaded, a real Player, the spellbook's own ArceuusSpells.handleSpell.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
process.env.DISABLE_PLAYER_BOTS = "1";
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { ArceuusSpells } = require("../dist/game/content/combat/magic/ArceuusSpells");

const MIND_RUNE = 558;
const LAW_RUNE = 563;

let core;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));

let next = 9400;
function cast(t, mind, law) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel));
  p.setIndex(next++); p.setUsername("mindaltar" + p.getIndex()); p.setRegistered(true); p.setAttribute("bot-skip-persistence", true);
  p.setLocation(new core.Location(3222, 3218, 0)); p.needsPlacement = false;
  t.after(() => { core.TaskManager.cancelTasks(p); p.setRegistered(false); });
  p.setSpellbook(core.MagicSpellbook.ARCEUUS);
  p.getSkillManager().setMaxLevels(core.Skill.MAGIC, 99, false).setCurrentLevel(core.Skill.MAGIC, 99, false);
  p.getInventory().add(new core.Item(MIND_RUNE, mind), false);
  p.getInventory().add(new core.Item(LAW_RUNE, law), false);
  const teleports = [];
  t.mock.method(core.TeleportHandler, "teleport", (_p, to) => { teleports.push(to); });
  ArceuusSpells.handleSpell(p, "Mind Altar Teleport");
  return { p, teleports };
}

test("two mind runes and one law rune cast it, and are what it takes", (t) => {
  const { p, teleports } = cast(t, 2, 1);
  assert.equal(teleports.length, 1);
  assert.equal(p.getInventory().getAmount(MIND_RUNE), 0);
  assert.equal(p.getInventory().getAmount(LAW_RUNE), 0);
});

test("one mind rune is not enough, however many law runes are carried", (t) => {
  const { p, teleports } = cast(t, 1, 5);
  assert.equal(teleports.length, 0);
  assert.equal(p.getInventory().getAmount(MIND_RUNE), 1);
  assert.equal(p.getInventory().getAmount(LAW_RUNE), 5);
});
