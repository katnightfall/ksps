// From server/: node --test tests/enchanted-key-journal.test.cjs (after yarn build).
// Upstream issues #5656 and #4289: the quest list's own row for The Enchanted Key miniquest (quest table id 98) opened
// nothing, because no quest was registered under its name. The treasure route now registers one whose stage follows
// the route (0 until Making History is complete, 1 while treasures remain, 2 when all eleven are found), so the row
// opens the overview or the journal. The module is attached with a stand-in Making History handle; the journal's
// wording is ours and is only checked for the facts it states.
const assert = require('node:assert/strict');
const { test, before } = require('node:test');
const path = require('node:path');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const runtime = require('../plugins/quests/QuestRuntime');
const core = PluginManager.getCoreApi();
const noop = () => {};

const ENCHANTED_KEY_ROW = 98; // quest table `id` of "The Enchanted Key"
const STATUS_VARBIT = 13717; // enchantedkey
const FOUND = 'enchanted-key:treasures-found';
const ORDER = 'enchanted-key:order';
const JOURNAL_GROUP = 119, OVERVIEW_GROUP = 782, OVERVIEW_SETUP_SCRIPT = 6821;
const SITES = require('../plugins/quests/makinghistory/data/enchanted-key.json').sites;

let events;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  events = {};
  const api = new Proxy({
    core,
    persistAttribute: noop,
    onCustomEvent: (key, handler) => (events[key] ??= []).push(handler),
    emitCustomEvent: (key, event) => (events[key] ?? []).forEach((handler) => handler(event)),
  }, { get: (target, key) => target[key] ?? noop });
  // The stand-in for the Making History quest handle the module is attached to.
  require('../plugins/quests/makinghistory/EnchantedKey.MakingHistory')(api, { isComplete: (player) => player.makingHistoryDone === true });
});

const emit = (key, event) => (events[key] ?? []).forEach((handler) => handler(event));
const miniquest = () => runtime.getRegisteredQuests().findLast((quest) => quest.key === 'the_enchanted_key');

function makePlayer({ done = false, found = 0, key = true } = {}) {
  const attrs = new Map([[FOUND, found]]), varbits = new Map(), strings = [], scripts = [], opened = [];
  if (found > 0) attrs.set(ORDER, SITES.map((site) => site.key));
  const sender = new Proxy({
    sendVarbit: (id, value) => { varbits.set(id, value); return sender; },
    getVarbit: (id) => varbits.get(id) ?? 0,
    getVarp: () => 0,
    sendString: (text, uid) => { strings.push([uid >> 16, text]); return sender; },
    sendInterfaceScript: (id, args) => { scripts.push([id, args]); return sender; },
    sendSubInterface: (_target, group) => { opened.push(group); return sender; },
  }, { get: (target, prop) => target[prop] ?? (() => sender) });
  return {
    makingHistoryDone: done, varbits, strings, scripts, opened,
    getAttribute: (name) => attrs.get(name),
    setAttribute: (name, value) => attrs.set(name, value),
    getInventory: () => ({ getAmount: (id) => (key && id === core.ItemIdentifiers.ENCHANTED_KEY ? 1 : 0) }),
    getPacketSender: () => sender,
    getSkillManager: () => ({ getCombatLevel: () => 3 }),
    sendMessage: noop,
  };
}
const journal = (player) => player.strings.filter(([group]) => group === JOURNAL_GROUP).map(([, text]) => text.replace(/<[^>]*>/g, ''));

test('the quest list row has something to open', () => {
  assert.ok(miniquest(), 'a quest is registered for the row');
  assert.equal(runtime.hasQuestJournal(ENCHANTED_KEY_ROW), true);
});

test('before Making History the row opens the overview, saying how the miniquest starts', () => {
  const p = makePlayer();
  emit('enchanted-key:sync', { player: p });
  assert.equal(miniquest().getStage(p), 0);
  runtime.openQuestJournal(p, ENCHANTED_KEY_ROW);
  assert.deepEqual(p.opened, [OVERVIEW_GROUP]);
  const start = p.scripts.find(([id]) => id === OVERVIEW_SETUP_SCRIPT)?.[1]?.[1];
  assert.match(String(start), /^completing .*Making History/, 'the sentence after "I can start this miniquest by"');
});

test('with Making History complete the miniquest is started and the journal counts the treasures dug up', () => {
  const p = makePlayer({ done: true, found: 3 });
  emit('enchanted-key:sync', { player: p });
  assert.equal(miniquest().getStage(p), 1);
  assert.equal(miniquest().isStarted(p), true);
  assert.equal(miniquest().isComplete(p), false);
  assert.equal(p.varbits.get(STATUS_VARBIT), 1, 'the row shows as started');
  runtime.openQuestJournal(p, ENCHANTED_KEY_ROW);
  assert.deepEqual(p.opened, [JOURNAL_GROUP]);
  const lines = journal(p);
  assert.ok(lines[0].includes('The Enchanted Key'), `title: ${lines[0]}`);
  assert.ok(lines.some((line) => line.includes(`3 of the ${SITES.length} treasures`)), lines.join('|'));
  assert.ok(!lines.some((line) => line.includes('silver merchant')), 'the replacement is only mentioned without the key');
});

test('a player who has lost the key is told where to buy another', () => {
  const p = makePlayer({ done: true, found: 0, key: false });
  emit('enchanted-key:sync', { player: p });
  runtime.openQuestJournal(p, ENCHANTED_KEY_ROW);
  const lines = journal(p);
  assert.ok(lines.some((line) => line.includes('silver merchant')), lines.join('|'));
  assert.ok(lines.some((line) => line.includes('500 coins')), lines.join('|'));
});

test('all eleven treasures complete the miniquest, and the login sync alone gives an old save its stage', () => {
  const p = makePlayer({ done: true, found: SITES.length, key: false });
  assert.equal(miniquest().getStage(p), 0, 'a save from before the miniquest had a stage');
  emit('player:bootstrap-complete', { player: p });
  assert.equal(miniquest().getStage(p), 2);
  assert.equal(miniquest().isComplete(p), true);
  assert.equal(p.varbits.get(STATUS_VARBIT), 2);
  runtime.openQuestJournal(p, ENCHANTED_KEY_ROW);
  assert.ok(journal(p).some((line) => line.includes('MINIQUEST COMPLETE!')));
});

test('a corrupt found count leaves the saved stage alone', () => {
  const p = makePlayer({ done: true, found: 2 });
  emit('enchanted-key:sync', { player: p });
  assert.equal(miniquest().getStage(p), 1);
  p.setAttribute(FOUND, 99);
  emit('enchanted-key:sync', { player: p });
  assert.equal(miniquest().getStage(p), 1);
});
