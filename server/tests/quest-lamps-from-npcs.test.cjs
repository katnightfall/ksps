// Run after yarn build: node --test tests/quest-lamps-from-npcs.test.cjs
// Upstream issue #5610. The 3 November 2026 update gave Romeo & Juliet, Shield of Arrav and Ernest
// the Chicken an antique lamp of 500 XP and Black Knights' Fortress two of 1,000 XP in a combat
// skill or Prayer; "the XP lamps can be claimed from the relevant NPCs giving the quests" by
// players who finished before it, and each lamp "can be destroyed and reclaimed" from its NPC
// (Wiki: Update:Quest Month Kick Off, TFA Tweaks & More; Antique lamp (Romeo & Juliet) and the
// other three; Transcript:Romeo, King Roald, Veronica, Sir Amik Varze). The NPCs gave nothing.
// Real engine: every plugin loaded, a real Player, each NPC's Talk-to, the lamps' Rub, and a
// reload through the real PlayerSave and JSON codec. Aris and Demon Slayer's lamps:
// demon-slayer-aris-lamps.test.cjs.
process.env.DISABLE_PLAYER_BOTS = '1';
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, after, test } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager: PM } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { PlayerSave } = require('../dist/game/entity/impl/player/persistence/PlayerSave');
const { PlayerSession } = require('../dist/net/PlayerSession');
const { ClientConnection } = require('../dist/net/NetworkBuilder');
const { MultiChatboxPrompt } = require('../dist/game/model/menu/MultiChatboxPrompt');
const JsonPersistence = require('../plugins/persistence/JsonPlayerPersistence.plugin');
const QuestRuntime = require('../plugins/quests/QuestRuntime');
const Owed = require('../plugins/quests/OwedExperience.plugin');
const Lamps = require('../plugins/items/QuestRewardLamps.plugin');

// Each lamp's Wiki page (item id, experience, how many the quest gives) and its NPC's transcript.
const QUESTS = [
  { name: 'Romeo', npc: 'ROMEO', key: 'romeo_and_juliet', lamp: 'ROMEO_AND_JULIET', item: 34754, count: 1, xp: 500, skill: 'FLETCHING',
    said: ['I heard Juliet had died. Terrible business. Her cousin and I are getting on well though. Here, take this as thanks for your help.'] },
  { name: 'King Roald', npc: 'KING_ROALD_3', key: 'shield_of_arrav', lamp: 'SHIELD_OF_ARRAV', item: 34755, count: 1, xp: 500, skill: 'HERBLORE',
    said: ['Here, citizen. I have this lamp for you.', 'Thanks!'] },
  { name: 'Veronica', npc: 'VERONICA', key: 'ernest_the_chicken', lamp: 'ERNEST_THE_CHICKEN', item: 34750, count: 1, xp: 500, skill: 'THIEVING',
    said: ['Thank you for rescuing Ernest. He left this lamp for you.', 'Thanks!'] },
  { name: 'Sir Amik Varze', npc: 'SIR_AMIK_VARZE_4', key: 'black_knights_fortress', lamp: 'BLACK_KNIGHTS_FORTRESS', item: 34748, count: 2, xp: 1000, skill: 'PRAYER',
    said: ['I have a reward here for you, friend.', 'Thanks!'] },
];
const NO_ROOM = 'You need a free inventory slot to take the lamp.';

const BEFORE = Date.parse('2026-10-20T12:00:00Z'); // a character older than our copy of the server
let core, codec, rate, nextIndex = 5500;
const npcs = new Map();

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  core = PM.getCoreApi();
  core.RegionManager.init();
  PM.loadFromDirectory(path.resolve(__dirname, '../plugins'));
  PM.emitServerStartup({});
  JsonPersistence.register({
    getSkillManager: () => require('../dist/game/content/skill/SkillManager').SkillManager,
    setPlayerPersistence: (backend) => { codec = backend; }, log() {},
  });
  for (const quest of QUESTS) {
    const npc = core.NPC.create(core.NpcIdentifiers[quest.npc], new core.Location(3203, 3424, 0));
    assert.equal(npc.getDefinition().getName(), quest.name);
    npcs.set(quest.key, npc);
    const item = core.CacheDefinitions.getItem(quest.item);
    assert.equal(item.name, 'Antique lamp');
    assert.deepEqual(item.inventoryActions.filter(Boolean), ['Rub', 'Destroy'], 'never dropped: destroyed');
  }
  rate = core.GameConstants.EXPERIENCE_MULTIPLIER;
});
after(() => PM.emitServerShutdown({}));

const questFor = (key) => QuestRuntime.getRegisteredQuests().find((quest) => quest.key === key);

/** A character created at `created`; `done` are finished as before the lamps: the stage alone. */
function actor(t, { created = BEFORE, done = [] } = {}) {
  const channel = { kind: 'test', remoteAddress: '127.0.0.1', isOpen: () => true,
    send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(nextIndex++); player.setUsername(`npclamp${nextIndex}`);
  player.setAttribute('bot-skip-persistence', true); player.setRegistered(true);
  player.setLocation(new core.Location(3204, 3424, 0)); player.setNeedsPlacement(false);
  player.setCreationDate(created);
  for (const key of done) questFor(key).setStage(player, questFor(key).completionValue);
  const connection = new ClientConnection(channel); connection.player = player;
  const messages = [];
  const sendMessage = player.sendMessage.bind(player);
  player.sendMessage = (text) => { messages.push(text); return sendMessage(text); };
  const emit = PM.emitCustomEvent.bind(PM);
  let request;
  t.mock.method(PM, 'emitCustomEvent', (name, event) => {
    if (name === 'xpreward:open' && event.player === player) { request = event; return event; }
    return emit(name, event);
  });
  t.after(() => {
    PM.emitPlayerLogout({ player, username: player.getUsername() });
    player.closeInterruptibleInterfaces(); player.setRegistered(false);
    core.TaskManager.cancelTasks(player); core.TaskManager.cancelTasks(player.getIndex());
  });
  return { player, connection, messages, takeRequest: () => { const taken = request; request = undefined; return taken; } };
}

const held = (f, quest) => f.player.getInventory().getAmount(quest.item);
const used = (f, quest) => Lamps._test.lampsUsed(f.player, quest.lamp);

/** Talks to the quest's NPC and continues to the first menu or the end; returns the lines said. */
async function talk(f, quest) {
  const npc = npcs.get(quest.key);
  f.player.closeInterruptibleInterfaces();
  const said = [];
  assert.equal(PM.emitNpcInteraction({ player: f.player, npc, npcId: npc.getId(), definition: npc.getDefinition(),
    action: 'Talk-to', clickType: 1, handled: false }), true);
  for (let step = 0; step < 20; step++) {
    core.World.processCycle++;
    core.TaskManager.process();
    if (MultiChatboxPrompt.getPending(f.player)) break;
    const current = f.player.getDialogueManager().getCurrent();
    if (!current) break;
    if (typeof current.getText === 'function') said.push(current.getText());
    const group = f.player.getPacketSender().getChatboxGroupId();
    const child = ({ 231: 5, 217: 5, 229: 4 })[group];
    if (child === undefined) break;
    await f.connection.dispatch([{ type: 'dialogue_continue', widgetId: (group << 16) | child, childIndex: -1 }]);
    f.connection.processTurnPackets();
  }
  return said;
}

/** Rubs one of the quest's lamps on `skill`; returns the experience gained. */
function rub(f, quest, skill = core.Skill[quest.skill]) {
  const slot = f.player.getInventory().getSlotForItemId(quest.item);
  const item = f.player.getInventory().getItems()[slot];
  PM.emitItemAction({ player: f.player, item, itemId: quest.item, slot, option: 'Rub',
    clickType: core.CacheDefinitions.getItem(quest.item).inventoryActions.indexOf('Rub') + 1, handled: false });
  const request = f.takeRequest();
  assert.ok(request, 'the lamp opens the skill choice');
  const from = f.player.getSkillManager().getExperience(skill);
  request.onConfirm(skill, skill.getName());
  return f.player.getSkillManager().getExperience(skill) - from;
}

const destroy = (f, quest, count = 1) => { if (count > 0) f.player.getInventory().delete(quest.item, count); };

function fill(f, slots) {
  for (let slot = 0; slot < slots; slot++) f.player.getInventory().setItem(slot, new core.Item(core.ItemIdentifiers.BUCKET, 1));
}

function reload(t, f) {
  const raw = JSON.parse(JSON.stringify(PlayerSave.fromPlayer(f.player), codec.replacer.bind(codec)), codec.reviver.bind(codec));
  const g = actor(t, { created: Date.now() });
  codec.hydratePlayerSave(raw).applyToPlayer(g.player);
  g.player.setRegistered(true);
  g.player.setLocation(new core.Location(3204, 3424, 0)); g.player.setNeedsPlacement(false);
  PM.emitPlayerLogin({ player: g.player, username: g.player.getUsername(), isNewAccount: false });
  PM.emitCustomEvent('player:bootstrap-complete', { player: g.player });
  return g;
}

for (const quest of QUESTS) {
  const lamps = quest.count === 1 ? 'the lamp' : `the ${quest.count} lamps`;

  test(`${quest.name}: finished before, ${lamps} once, with the Wiki's words; each pays ${quest.xp} XP once`, async t => {
    const f = actor(t, { done: [quest.key] });
    assert.equal(held(f, quest), 0);
    assert.deepEqual(await talk(f, quest), quest.said);
    assert.equal(held(f, quest), quest.count);
    assert.notEqual((await talk(f, quest))[0], quest.said[0], 'nothing more while they are carried: the usual conversation');
    assert.equal(held(f, quest), quest.count);

    for (let n = 1; n <= quest.count; n++) {
      assert.equal(rub(f, quest), quest.xp * rate, 'at the world\'s rate, as every quest reward');
      assert.equal(held(f, quest), quest.count - n);
      assert.equal(used(f, quest), n);
      assert.notEqual((await talk(f, quest))[0], quest.said[0], 'a used lamp is not replaced');
      assert.equal(held(f, quest), quest.count - n);
    }
    const name = Lamps.QUEST_LAMPS[quest.lamp].varbit;
    if (name) assert.equal(f.player.getPacketSender().getVarbit(core.CacheDefinitions.getVarbitId(name)), 1, `${name}, the cache's own record`);
  });

  test(`${quest.name}: a lamp destroyed unused is had again; only what fits is handed over`, async t => {
    const f = actor(t, { done: [quest.key] });
    await talk(f, quest);
    destroy(f, quest, quest.count);
    assert.deepEqual(await talk(f, quest), quest.said);
    assert.equal(held(f, quest), quest.count, 'all of them back');
    assert.equal(used(f, quest), 0);

    destroy(f, quest, quest.count);
    fill(f, 28);
    assert.notEqual((await talk(f, quest))[0], quest.said[0], 'no room: the usual conversation');
    assert.ok(f.messages.includes(NO_ROOM));
    assert.equal(held(f, quest), 0);
    assert.equal(Lamps._test.lampsOwed(f.player, quest.lamp), quest.count, 'still owed');
    f.player.getInventory().setItem(0, new core.Item(-1, 0));
    assert.deepEqual(await talk(f, quest), quest.said);
    assert.equal(held(f, quest), 1, 'one free slot: one lamp, and none on the floor');
    assert.equal(Lamps._test.lampsOwed(f.player, quest.lamp), quest.count - 1, 'the rest stays owed');
    if (quest.count > 1) {
      f.player.getInventory().setItem(1, new core.Item(-1, 0));
      await talk(f, quest);
      assert.equal(held(f, quest), quest.count, 'the other when there is room');
    }
    for (let n = 0; n < quest.count; n++) assert.equal(rub(f, quest), quest.xp * rate);
    assert.notEqual((await talk(f, quest))[0], quest.said[0]);
    assert.equal(held(f, quest), 0, 'all used: none left');
  });

  test(`${quest.name}: finished now, ${lamps} come at completion and the NPC has no more`, async t => {
    const f = actor(t, { created: Date.now() });
    assert.notEqual((await talk(f, quest))[0], quest.said[0], 'not finished: nothing');
    assert.equal(held(f, quest), 0);
    assert.equal(questFor(quest.key).complete(f.player, { scroll: false }), true);
    f.player.closeInterruptibleInterfaces();
    assert.equal(held(f, quest), quest.count, 'handed over at completion');
    assert.ok(f.player.getAttribute(Owed.NEW_REWARD_PAID_ATTRIBUTE).includes(quest.key), 'recorded');
    assert.notEqual((await talk(f, quest))[0], quest.said[0]);
    assert.equal(held(f, quest), quest.count, 'no more from the NPC');

    // Its lamps are counted, so one destroyed unused is had again, and a used one is not.
    assert.equal(rub(f, quest), quest.xp * rate);
    destroy(f, quest, quest.count - 1);
    await talk(f, quest);
    assert.equal(held(f, quest), quest.count - 1);
    for (let n = 1; n < quest.count; n++) assert.equal(rub(f, quest), quest.xp * rate);
    await talk(f, quest);
    assert.equal(held(f, quest), 0, 'all used: none left');
  });

  test(`${quest.name}: a quest's lamps never pay more times than it has lamps`, async t => {
    const f = actor(t, { done: [quest.key] });
    await talk(f, quest);
    // One more of them than the quest gives, however it was come by.
    f.player.getInventory().add(new core.Item(quest.item, 1), false);
    assert.equal(held(f, quest), quest.count + 1);
    for (let n = 0; n < quest.count; n++) assert.equal(rub(f, quest), quest.xp * rate);
    assert.equal(rub(f, quest), 0, 'the lamp beyond them pays nothing');
    assert.equal(held(f, quest), 0, 'and is gone');
    assert.equal(used(f, quest), quest.count);
    assert.ok(f.messages.includes("You have already used the lamps from this quest, so this one is taken away."));
  });

  test(`${quest.name}: the count of lamps used is saved with the character`, async t => {
    const f = actor(t, { done: [quest.key] });
    await talk(f, quest);
    rub(f, quest);
    destroy(f, quest, quest.count - 1);
    const g = reload(t, f);
    assert.equal(used(g, quest), 1, 'in the save');
    assert.equal(g.player.getCreationDate().getTime(), BEFORE);
    await talk(g, quest);
    assert.equal(held(g, quest), quest.count - 1, 'after a relog, on any world: only the lamps not yet used');
    for (let n = 1; n < quest.count; n++) rub(g, quest);
    const h = reload(t, g);
    assert.equal(used(h, quest), quest.count);
    assert.notEqual((await talk(h, quest))[0], quest.said[0]);
    assert.equal(held(h, quest), 0);
  });

  test(`${quest.name}: nothing for an unfinished quest, a completion without experience, or lamps already had at completion`, async t => {
    const pack = actor(t);
    assert.equal(questFor(quest.key).complete(pack.player, { experience: false, scroll: false, announce: false }), true);
    pack.player.closeInterruptibleInterfaces();
    assert.equal(held(pack, quest), 0, 'a quest pack: no lamps at completion');
    assert.notEqual((await talk(pack, quest))[0], quest.said[0]);
    assert.equal(held(pack, quest), 0, 'nor from the NPC');

    // Finished on our code before lamps were counted: it had them at completion.
    const earlier = actor(t, { created: Owed.REWARDS_IN_OUR_CODE_SINCE, done: [quest.key] });
    assert.notEqual((await talk(earlier, quest))[0], quest.said[0]);
    assert.equal(held(earlier, quest), 0);
    // One it still carries works, and is counted from now on.
    earlier.player.getInventory().add(new core.Item(quest.item, 1), false);
    assert.equal(rub(earlier, quest), quest.xp * rate);
    assert.equal(used(earlier, quest), 1);
    await talk(earlier, quest);
    assert.equal(held(earlier, quest), 0);
  });
}

test('the two 1,000 XP lamps are for a combat skill or Prayer only', async t => {
  const quest = QUESTS.find((entry) => entry.key === 'black_knights_fortress');
  const f = actor(t, { done: [quest.key] });
  await talk(f, quest);
  assert.equal(rub(f, quest, core.Skill.FLETCHING), 0, 'not a combat skill');
  assert.equal(held(f, quest), 2);
  assert.equal(used(f, quest), 0);
  assert.equal(rub(f, quest, core.Skill.HITPOINTS), 1000 * rate);
});
