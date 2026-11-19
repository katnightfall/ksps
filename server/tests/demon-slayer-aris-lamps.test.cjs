// Run after yarn build: node --test tests/demon-slayer-aris-lamps.test.cjs
// Upstream issue #5610. The 3 November 2026 update gave Demon Slayer two antique lamps of 1,000 XP
// in a combat skill or Prayer, claimed from Aris after the quest (Wiki: Update:Quest Month Kick
// Off, TFA Tweaks & More; Demon Slayer, Rewards; Antique lamp (Demon Slayer): "if the player
// prefers to use them at a later date, they can be destroyed and reclaimed from Aris"). Nobody
// gave them. Real engine: every plugin loaded, a real Player, Aris's Talk-to and the lamps' Rub.
process.env.DISABLE_PLAYER_BOTS = '1';
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, after, test } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager: PM } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { PlayerSession } = require('../dist/net/PlayerSession');
const { ClientConnection } = require('../dist/net/NetworkBuilder');
const { EXPERIENCE_WITHHELD_ATTRIBUTE } = require('../plugins/quests/QuestRuntime');

const LAMP = 34749; // Antique lamp (Demon Slayer), the Wiki's item id
let core, aris, nextIndex = 5100;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  core = PM.getCoreApi();
  core.RegionManager.init();
  PM.loadFromDirectory(path.resolve(__dirname, '../plugins'));
  PM.emitServerStartup({});
  assert.equal(core.CacheDefinitions.getItem(LAMP).name, 'Antique lamp');
  aris = core.NPC.create(core.NpcIdentifiers.ARIS, new core.Location(3203, 3424, 0));
});
after(() => PM.emitServerShutdown({}));

function quest() {
  return require('../plugins/quests/QuestRuntime').getRegisteredQuests().find(q => q.key === 'demon_slayer');
}

function actor(t, { complete = true } = {}) {
  const channel = { kind: 'test', remoteAddress: '127.0.0.1', isOpen: () => true,
    send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(nextIndex++); player.setUsername(`arislamp${nextIndex}`);
  player.setAttribute('bot-skip-persistence', true); player.setRegistered(true);
  player.setLocation(new core.Location(3204, 3424, 0)); player.setNeedsPlacement(false);
  if (complete) quest().setStage(player, quest().completionValue);
  const connection = new ClientConnection(channel); connection.player = player;
  const lines = [];
  const emit = PM.emitCustomEvent.bind(PM);
  let request;
  t.mock.method(PM, 'emitCustomEvent', (name, event) => {
    if (name === 'xpreward:open') { request = event; return event; }
    return emit(name, event);
  });
  t.after(() => {
    PM.emitPlayerLogout({ player, username: player.getUsername() });
    player.closeInterruptibleInterfaces(); player.setRegistered(false);
    core.TaskManager.cancelTasks(player); core.TaskManager.cancelTasks(player.getIndex());
  });
  return { player, connection, lines, takeRequest: () => { const taken = request; request = undefined; return taken; } };
}

const held = (player) => player.getInventory().getAmount(LAMP);

/** Talks to Aris and continues the conversation to its first menu or its end. */
async function talk(f) {
  f.player.closeInterruptibleInterfaces();
  assert.equal(PM.emitNpcInteraction({ player: f.player, npc: aris, npcId: aris.getId(), definition: aris.getDefinition(),
    action: 'Talk-to', clickType: 1, handled: false }), true);
  for (let step = 0; step < 12; step++) {
    core.World.processCycle++;
    core.TaskManager.process();
    const group = f.player.getPacketSender().getChatboxGroupId();
    const child = ({ 231: 5, 217: 5 })[group];
    if (child === undefined) break;
    await f.connection.dispatch([{ type: 'dialogue_continue', widgetId: (group << 16) | child, childIndex: -1 }]);
    f.connection.processTurnPackets();
  }
}

function rub(f, skill) {
  const slot = f.player.getInventory().getSlotForItemId(LAMP);
  const item = f.player.getInventory().getItems()[slot];
  PM.emitItemAction({ player: f.player, item, itemId: LAMP, slot, option: 'Rub',
    clickType: core.CacheDefinitions.getItem(LAMP).inventoryActions.indexOf('Rub') + 1, handled: false });
  const request = f.takeRequest();
  assert.ok(request, 'the lamp opens the skill choice');
  const before = f.player.getSkillManager().getExperience(skill);
  request.onConfirm(skill, skill.getName());
  return f.player.getSkillManager().getExperience(skill) - before;
}

test('Aris gives the two lamps after the quest, once', async t => {
  const f = actor(t);
  assert.equal(held(f.player), 0);
  await talk(f);
  assert.equal(held(f.player), 2, 'two antique lamps');
  await talk(f);
  assert.equal(held(f.player), 2, 'no more while they are carried');
});

test('each lamp pays in a combat skill, and a used lamp is not replaced', async t => {
  const f = actor(t);
  await talk(f);
  assert.ok(rub(f, core.Skill.PRAYER) > 0, 'Prayer counts as a combat skill for this lamp');
  assert.equal(held(f.player), 1);
  await talk(f);
  assert.equal(held(f.player), 1, 'the used lamp is not replaced');
  assert.ok(rub(f, core.Skill.ATTACK) > 0);
  await talk(f);
  assert.equal(held(f.player), 0, 'both used: Aris has none left');
});

test('a lamp destroyed unused is had from Aris again', async t => {
  const f = actor(t);
  await talk(f);
  f.player.getInventory().delete(LAMP, 1); // Destroy
  await talk(f);
  assert.equal(held(f.player), 2);
  rub(f, core.Skill.DEFENCE);
  f.player.getInventory().delete(LAMP, 1);
  await talk(f);
  assert.equal(held(f.player), 1, 'one used, one destroyed: one back');
});

test('no lamps before the quest is done, for a completion without experience, or without room', async t => {
  const fresh = actor(t, { complete: false });
  await talk(fresh);
  assert.equal(held(fresh.player), 0);

  const withheld = actor(t);
  withheld.player.setAttribute(EXPERIENCE_WITHHELD_ATTRIBUTE, ['demon_slayer']);
  await talk(withheld);
  assert.equal(held(withheld.player), 0);

  const full = actor(t);
  for (let slot = 0; slot < 27; slot++) full.player.getInventory().setItem(slot, new core.Item(core.ItemIdentifiers.BUCKET, 1));
  await talk(full);
  assert.equal(held(full.player), 1, 'only what fits is handed over; nothing goes on the floor');
  full.player.getInventory().setItem(0, new core.Item(-1, 0));
  await talk(full);
  assert.equal(held(full.player), 2, 'the other one when there is room');
});
