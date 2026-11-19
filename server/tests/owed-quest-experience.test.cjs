// Run after yarn build: node --test tests/owed-quest-experience.test.cjs
// Upstream issue #5610. The 3 November 2026 update added experience to thirteen quests that gave
// none, and "If you have already completed the quests ... you can claim these additional XP
// rewards through Perdu or the Lumbridge Guide" (Wiki: Update:Quest Month Kick Off, TFA Tweaks &
// More; Transcript:Perdu; Transcript:Lumbridge Guide, "Claiming owed experience"). Nobody paid it.
// Real engine: every plugin loaded, a real Player, the two NPCs' Talk-to, the chat continued and
// answered through the connection, and a reload through the real PlayerSave and JSON codec.
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

// The Wiki's table ("XP Rewards Added") and each quest's Rewards section.
const WIKI = {
  prince_ali_rescue: { Smithing: 500, Crafting: 500 },
  pirates_treasure: { Cooking: 800 },
  rune_mysteries: { Runecraft: 500 },
  the_corsair_curse: { Firemaking: 1200 },
  below_ice_mountain: { Mining: 1200 },
  clock_tower: { Firemaking: 1000 },
  family_crest: { Mining: 2000, Smithing: 2000, Crafting: 2000 },
  lost_city: { Woodcutting: 1500, Crafting: 1500 },
  merlins_crystal: { Firemaking: 1000 },
  sheep_herder: { Hunter: 1000 },
  tale_of_the_righteous: { Mining: 1500 },
  throne_of_miscellania: { Woodcutting: 1000, Mining: 1000, Fishing: 1000, Farming: 1000 },
  troll_stronghold: { Agility: 2000 },
};
const KEYS = Object.keys(WIKI);
// Transcript:Lumbridge Guide, "Claiming owed experience": all thirteen owed.
const WIKI_LIST = 'You are owed the following: 800 Cooking XP. 4,000 Crafting XP. 3,200 Firemaking XP. 1,000 Fishing XP. '
  + '5,700 Mining XP. 500 Runecraft XP. 2,500 Smithing XP. 2,500 Woodcutting XP. 2,000 Agility XP. 1,000 Farming XP. 1,000 Hunter XP. ';
const OFFER = "It seems you're missing out on some valuable experience. Would you like it?";
const PERDU_GREETING = "Hello. I've found some stuff that I think is yours. You can pay me with cash you're carrying, or I can take payments from your bank. Would you like to buy anything from me?";
const GUIDE_GREETING = /^Greetings, adventurer\..*Is there anything I can help you with\?$/;

const BEFORE = Date.parse('2026-10-20T12:00:00Z'); // a character older than our copy of the server
let core, codec, perdu, guide, rate, nextIndex = 5300;

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
  perdu = core.NPC.create(core.NpcIdentifiers.PERDU, new core.Location(3230, 3215, 0));
  guide = core.NPC.create(core.NpcIdentifiers.LUMBRIDGE_GUIDE, new core.Location(3238, 3220, 0));
  assert.equal(perdu.getDefinition().getName(), 'Perdu');
  assert.equal(guide.getDefinition().getName(), 'Lumbridge Guide');
  rate = core.GameConstants.EXPERIENCE_MULTIPLIER;
});
after(() => PM.emitServerShutdown({}));

const questFor = (key) => QuestRuntime.getRegisteredQuests().find((quest) => quest.key === key);
const skillNamed = (name) => core.Skill[name === 'Runecraft' ? 'RUNECRAFTING' : name.toUpperCase()];

/** A character created at `created`, with `done` finished as it was before the rewards: the stage alone. */
function actor(t, { created = BEFORE, done = [] } = {}) {
  const channel = { kind: 'test', remoteAddress: '127.0.0.1', isOpen: () => true,
    send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(nextIndex++); player.setUsername(`owedxp${nextIndex}`);
  player.setAttribute('bot-skip-persistence', true); player.setRegistered(true);
  player.setLocation(new core.Location(3232, 3216, 0)); player.setNeedsPlacement(false);
  player.setCreationDate(created);
  for (const key of done) questFor(key).setStage(player, questFor(key).completionValue);
  const connection = new ClientConnection(channel); connection.player = player;
  const messages = [];
  const sendMessage = player.sendMessage.bind(player);
  player.sendMessage = (text) => { messages.push(text); return sendMessage(text); };
  t.after(() => {
    PM.emitPlayerLogout({ player, username: player.getUsername() });
    player.closeInterruptibleInterfaces(); player.setRegistered(false);
    core.TaskManager.cancelTasks(player); core.TaskManager.cancelTasks(player.getIndex());
  });
  return { player, connection, messages };
}

const experience = (player) => core.Skill.values().map((skill) => player.getSkillManager().getExperience(skill));

/** What each skill gained since `from`, by the Wiki's name for it. */
function gained(player, from) {
  const result = {};
  core.Skill.values().forEach((skill, index) => {
    const delta = player.getSkillManager().getExperience(skill) - from[index];
    if (delta !== 0) result[skill === core.Skill.RUNECRAFTING ? 'Runecraft' : skill.getName()] = delta;
  });
  return result;
}

/** The world's rate on the Wiki's amounts, as every quest reward gets it. */
const atRate = (amounts) => Object.fromEntries(Object.entries(amounts).map(([skill, amount]) => [skill, amount * rate]));

function totals(keys) {
  const sum = {};
  for (const key of keys) for (const [skill, amount] of Object.entries(WIKI[key])) sum[skill] = (sum[skill] ?? 0) + amount;
  return sum;
}

const send = async (f, packet) => { await f.connection.dispatch([packet]); f.connection.processTurnPackets(); };

/**
 * Talks to the NPC and continues the chat, answering each menu with the next of `answers`, until
 * a menu with no answer left or the end. Returns what was shown: lines and boxes as text, a menu
 * as { title, options }.
 */
async function talk(f, npc, answers = []) {
  f.player.closeInterruptibleInterfaces();
  const shown = [];
  assert.equal(PM.emitNpcInteraction({ player: f.player, npc, npcId: npc.getId(), definition: npc.getDefinition(),
    action: 'Talk-to', clickType: 1, handled: false }), true);
  const left = [...answers];
  for (let step = 0; step < 40; step++) {
    core.World.processCycle++;
    core.TaskManager.process();
    const prompt = MultiChatboxPrompt.getPending(f.player);
    if (prompt) {
      shown.push(prompt);
      if (!left.length) break;
      const answer = left.shift();
      assert.ok(prompt.options.includes(answer), `${answer}: ${JSON.stringify(prompt.options)}`);
      await send(f, { type: 'dialogue_continue', widgetId: MultiChatboxPrompt.OPTIONS_WIDGET_ID, childIndex: prompt.options.indexOf(answer) + 1 });
      continue;
    }
    const current = f.player.getDialogueManager().getCurrent();
    if (!current) break;
    if (typeof current.getText === 'function') shown.push(current.getText());
    const group = f.player.getPacketSender().getChatboxGroupId();
    const child = ({ 231: 5, 217: 5, 229: 4 })[group];
    if (child === undefined) break;
    await send(f, { type: 'dialogue_continue', widgetId: (group << 16) | child, childIndex: -1 });
  }
  assert.deepEqual(left, [], 'every answer was asked for');
  return shown;
}

const texts = (shown) => shown.filter((entry) => typeof entry === 'string');
const menus = (shown) => shown.filter((entry) => typeof entry !== 'string');
// The order of the transcript's list.
const ORDER = ['Cooking', 'Crafting', 'Firemaking', 'Fishing', 'Mining', 'Runecraft', 'Smithing', 'Woodcutting', 'Agility', 'Farming', 'Hunter'];
const listOf = (amounts) => ORDER.filter((skill) => skill in amounts).map((skill) => `${amounts[skill].toLocaleString('en-US')} ${skill} XP. `).join('');

function reload(t, f) {
  const raw = JSON.parse(JSON.stringify(PlayerSave.fromPlayer(f.player), codec.replacer.bind(codec)), codec.reviver.bind(codec));
  const g = actor(t, { created: Date.now() });
  codec.hydratePlayerSave(raw).applyToPlayer(g.player);
  g.player.setRegistered(true);
  g.player.setLocation(new core.Location(3232, 3216, 0)); g.player.setNeedsPlacement(false);
  PM.emitPlayerLogin({ player: g.player, username: g.player.getUsername(), isNewAccount: false });
  return g;
}

test('what is owed is what each quest pays at completion, and the Wiki\'s amounts', () => {
  assert.deepEqual(Object.keys(Owed.ADDED_EXPERIENCE).sort(), [...KEYS].sort(), 'the thirteen quests');
  for (const key of KEYS) {
    const quest = questFor(key);
    assert.ok(quest, `${key} is a quest`);
    const table = Object.fromEntries(Owed.ADDED_EXPERIENCE[key].map(([skill, amount]) => [skill, amount]));
    const wiki = Object.fromEntries(Object.entries(WIKI[key]).map(([name, amount]) => [name === 'Runecraft' ? 'RUNECRAFTING' : name.toUpperCase(), amount]));
    assert.deepEqual(table, wiki, key);
    assert.deepEqual(quest.xpRewards.map((reward) => reward.amount).sort(), Object.values(WIKI[key]).sort(), `${key}: the scroll's experience`);
    assert.deepEqual(quest.xpRewards.map((reward) => reward.label).sort(), Object.keys(WIKI[key]).sort(), `${key}: the scroll's skills`);
  }
});

for (const key of KEYS) {
  test(`${key}: finished before, Perdu gives ${listOf(WIKI[key]).trim()} once`, async t => {
    const f = actor(t, { done: [key] });
    const from = experience(f.player);
    const first = await talk(f, perdu, ['Yes please.']);
    assert.deepEqual(texts(first).slice(0, 4), [OFFER, `You are owed the following: ${listOf(WIKI[key])}`, 'Yes please.', 'There you go.']);
    assert.equal(menus(first)[0].title, 'Claim your owed XP?');
    assert.deepEqual(menus(first)[0].options, ['Yes please.', 'No thanks.']);
    assert.equal(menus(first)[1].title, 'What would you like to say?', 'then his usual menu, without his greeting');
    assert.ok(!texts(first).includes(PERDU_GREETING));
    assert.deepEqual(gained(f.player, from), atRate(WIKI[key]), 'exactly what is owed, at the world\'s rate');

    const second = await talk(f, perdu);
    assert.equal(texts(second)[0], PERDU_GREETING, 'nothing owed: his usual greeting');
    assert.ok(!texts(second).includes(OFFER));
    assert.equal(menus(second)[0].title, 'What would you like to say?');
    assert.deepEqual(gained(f.player, from), atRate(WIKI[key]), 'nothing more');
    assert.deepEqual(Owed._test.owedQuests(f.player), []);
  });
}

test('the Lumbridge Guide lists all thirteen as the Wiki has it, pays them once, and goes on to his menu', async t => {
  const f = actor(t, { done: KEYS });
  const from = experience(f.player);
  const first = await talk(f, guide, ['Yes please.']);
  assert.deepEqual(texts(first).slice(0, 4), [OFFER, WIKI_LIST, 'Yes please.', 'There you go.']);
  assert.equal(menus(first)[0].title, 'Claim your owed XP?');
  assert.deepEqual(menus(first)[0].options, ['Yes please.', 'No thanks.']);
  assert.equal(menus(first).length, 2, 'his own menu follows');
  assert.ok(!texts(first).some((line) => GUIDE_GREETING.test(line)), 'without his greeting');
  assert.deepEqual(gained(f.player, from), atRate(totals(KEYS)));

  const second = await talk(f, guide);
  assert.match(texts(second)[0], GUIDE_GREETING, 'nothing owed: his usual greeting');
  assert.deepEqual(menus(second)[0].options, menus(first)[1].options, 'the same menu');
  assert.equal(texts(await talk(f, perdu))[0], PERDU_GREETING, 'and nothing from Perdu');
  assert.deepEqual(gained(f.player, from), atRate(totals(KEYS)), 'nothing more');
});

test('"No thanks." pays nothing and leaves it owed, at either of them', async t => {
  const f = actor(t, { done: ['family_crest', 'sheep_herder'] });
  const from = experience(f.player);
  const refusedGuide = await talk(f, guide, ['No thanks.']);
  assert.deepEqual(texts(refusedGuide).slice(0, 4), [OFFER, `You are owed the following: ${listOf({ Crafting: 2000, Mining: 2000, Smithing: 2000, Hunter: 1000 })}`, 'No thanks.', 'Fair enough.']);
  assert.equal(menus(refusedGuide).length, 2, 'his own menu follows');
  const refusedPerdu = await talk(f, perdu, ['No thanks.']);
  assert.deepEqual(texts(refusedPerdu).slice(0, 4), [OFFER, texts(refusedGuide)[1], 'No thanks.', 'Fair enough.']);
  assert.equal(menus(refusedPerdu)[1].title, 'What would you like to say?');
  assert.ok(!texts(refusedPerdu).includes(PERDU_GREETING));
  assert.deepEqual(gained(f.player, from), {});
  assert.equal(Owed._test.owedQuests(f.player).length, 2);

  await talk(f, perdu, ['Yes please.']);
  assert.deepEqual(gained(f.player, from), atRate(totals(['family_crest', 'sheep_herder'])));
  assert.match(texts(await talk(f, guide))[0], GUIDE_GREETING, 'claimed from Perdu: the Guide has nothing');
  assert.deepEqual(gained(f.player, from), atRate(totals(['family_crest', 'sheep_herder'])));
});

for (const key of KEYS) {
  test(`${key}: finished now, it is paid at completion like a claim, and never owed`, async t => {
    const claimed = actor(t, { done: [key] });
    const claimFrom = experience(claimed.player);
    Owed._test.claim(claimed.player);

    const f = actor(t);
    assert.deepEqual(Owed._test.owedQuests(f.player), [], 'not finished: nothing owed');
    assert.equal(texts(await talk(f, perdu))[0], PERDU_GREETING);
    const from = experience(f.player);
    assert.equal(questFor(key).complete(f.player, { scroll: false }), true);
    const paid = gained(f.player, from);
    for (const [skill, amount] of Object.entries(atRate(WIKI[key]))) assert.equal(paid[skill], amount, `${skill} at completion`);
    for (const [skill, amount] of Object.entries(gained(claimed.player, claimFrom))) {
      assert.equal(amount, paid[skill], `a claim pays ${skill} what completion pays: the rate applies to both alike`);
    }
    assert.ok(f.player.getAttribute(Owed.NEW_REWARD_PAID_ATTRIBUTE).includes(key), 'recorded as paid');
    assert.deepEqual(Owed._test.owedQuests(f.player), []);
    f.player.closeInterruptibleInterfaces();
    const after = experience(f.player);
    assert.equal(texts(await talk(f, perdu))[0], PERDU_GREETING, 'no offer');
    assert.deepEqual(gained(f.player, after), {});
  });
}

test('nothing is owed for a completion without experience, nor to a character made since our code paid these', async t => {
  const pack = actor(t);
  for (const key of KEYS) assert.equal(questFor(key).complete(pack.player, { experience: false, scroll: false, announce: false }), true);
  assert.deepEqual(Owed._test.owedQuests(pack.player), [], 'a quest pack');
  assert.equal(texts(await talk(pack, perdu))[0], PERDU_GREETING);

  const fresh = actor(t, { created: Owed.REWARDS_IN_OUR_CODE_SINCE, done: KEYS });
  const from = experience(fresh.player);
  assert.deepEqual(Owed._test.owedQuests(fresh.player), [], 'it was paid when it finished them');
  assert.equal(texts(await talk(fresh, perdu))[0], PERDU_GREETING);
  assert.match(texts(await talk(fresh, guide))[0], GUIDE_GREETING);
  assert.deepEqual(Owed._test.claim(fresh.player), { paid: [], left: [] });
  assert.deepEqual(gained(fresh.player, from), {});

  const justBefore = actor(t, { created: Owed.REWARDS_IN_OUR_CODE_SINCE - 1, done: ['clock_tower'] });
  assert.equal(Owed._test.owedQuests(justBefore.player).length, 1, 'a character older than that is owed');
});

test('the record is saved with the character: claimed stays claimed, owed stays owed, across a save and load', async t => {
  const f = actor(t, { done: ['lost_city', 'troll_stronghold'] });
  const from = experience(f.player);
  const unclaimed = reload(t, f);
  assert.equal(unclaimed.player.getCreationDate().getTime(), BEFORE, 'the creation date is saved');
  assert.equal(Owed._test.owedQuests(unclaimed.player).length, 2, 'still owed after a relog');

  await talk(unclaimed, perdu, ['Yes please.']);
  assert.deepEqual(gained(unclaimed.player, from), atRate(totals(['lost_city', 'troll_stronghold'])));
  assert.deepEqual([...unclaimed.player.getAttribute(Owed.NEW_REWARD_PAID_ATTRIBUTE)].sort(), ['lost_city', 'troll_stronghold']);

  const claimed = reload(t, unclaimed);
  assert.deepEqual([...claimed.player.getAttribute(Owed.NEW_REWARD_PAID_ATTRIBUTE)].sort(), ['lost_city', 'troll_stronghold'], 'the list is in the save');
  assert.deepEqual(Owed._test.owedQuests(claimed.player), []);
  const again = experience(claimed.player);
  assert.equal(texts(await talk(claimed, perdu))[0], PERDU_GREETING, 'on another world, after a relog: nothing');
  assert.match(texts(await talk(claimed, guide))[0], GUIDE_GREETING);
  assert.deepEqual(Owed._test.claim(claimed.player), { paid: [], left: [] });
  assert.deepEqual(gained(claimed.player, again), {});

  // A quest finished later by a character with the list already saved goes on it too.
  questFor('clock_tower').complete(claimed.player, { scroll: false });
  assert.deepEqual(Owed._test.owedQuests(reload(t, claimed).player), []);
});

test('an offer answered after the experience was had another way pays nothing', async t => {
  const f = actor(t, { done: ['pirates_treasure'] });
  const from = experience(f.player);
  const offer = await talk(f, perdu);
  assert.equal(menus(offer)[0].title, 'Claim your owed XP?');
  assert.equal(Owed._test.claim(f.player).paid.length, 1, 'claimed elsewhere while the menu is open');
  const prompt = MultiChatboxPrompt.getPending(f.player);
  await send(f, { type: 'dialogue_continue', widgetId: MultiChatboxPrompt.OPTIONS_WIDGET_ID, childIndex: prompt.options.indexOf('Yes please.') + 1 });
  for (let step = 0; step < 6 && f.player.getDialogueManager().getCurrent(); step++) {
    assert.notEqual(f.player.getDialogueManager().getCurrent().getText?.(), 'There you go.');
    const group = f.player.getPacketSender().getChatboxGroupId();
    await send(f, { type: 'dialogue_continue', widgetId: (group << 16) | 5, childIndex: -1 });
  }
  assert.deepEqual(gained(f.player, from), atRate(WIKI.pirates_treasure), 'once');

  const g = actor(t, { done: ['pirates_treasure'] });
  const fromG = experience(g.player);
  await talk(g, guide);
  Owed._test.claim(g.player);
  const guidePrompt = MultiChatboxPrompt.getPending(g.player);
  await send(g, { type: 'dialogue_continue', widgetId: MultiChatboxPrompt.OPTIONS_WIDGET_ID, childIndex: guidePrompt.options.indexOf('Yes please.') + 1 });
  for (let step = 0; step < 6 && g.player.getDialogueManager().getCurrent(); step++) {
    assert.notEqual(g.player.getDialogueManager().getCurrent().getText?.(), 'There you go.');
    const group = g.player.getPacketSender().getChatboxGroupId();
    await send(g, { type: 'dialogue_continue', widgetId: (group << 16) | 5, childIndex: -1 });
  }
  assert.deepEqual(gained(g.player, fromG), atRate(WIKI.pirates_treasure), 'once');
});

test('experience that cannot be gained now stays owed, and is paid once when it can', async t => {
  const f = actor(t, { done: ['rune_mysteries', 'throne_of_miscellania'] });
  const from = experience(f.player);
  f.player.setAttribute('skills:xp-locked', true);
  const locked = await talk(f, perdu, ['Yes please.']);
  assert.ok(!texts(locked).includes('There you go.'));
  assert.deepEqual(gained(f.player, from), {});
  assert.equal(Owed._test.owedQuests(f.player).length, 2, 'still owed');
  assert.ok(f.messages.includes('Unlock experience with ::lockxp before claiming your owed experience.'));

  // One skill refused (as a free-to-play world refuses Farming): that quest stays owed, whole.
  f.player.setAttribute('skills:xp-locked', false);
  const api = PM.createApi('OwedExperienceTest');
  let refuse = core.Skill.FARMING;
  api.onCanGainExperience((event) => { if (event.player === f.player && event.skill === refuse) event.allow = false; });
  const partly = await talk(f, guide, ['Yes please.']);
  assert.ok(texts(partly).includes('There you go.'));
  assert.deepEqual(gained(f.player, from), atRate(WIKI.rune_mysteries), 'Rune Mysteries paid, none of Throne of Miscellania');
  assert.deepEqual(Owed._test.owedQuests(f.player).map((entry) => entry.key), ['throne_of_miscellania']);
  assert.ok(f.messages.includes("Some of your owed experience can't be given right now. Ask again later."));

  refuse = null;
  await talk(f, perdu, ['Yes please.']);
  assert.deepEqual(gained(f.player, from), atRate(totals(['rune_mysteries', 'throne_of_miscellania'])));
  assert.deepEqual(Owed._test.owedQuests(f.player), []);
});
