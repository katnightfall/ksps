// From server/: node --test tests/eyes-of-glouphrie-brimstail-discs.test.cjs (after yarn build).
// Upstream issue #6257: Brimstail's extra crystal discs. The Wiki (The Eyes of Glouphrie, Sabotage): "You can talk to him
// multiple times to get more shapes. If you can no longer get discs from Brimstail, drop the discs and talk to him again
// to get more discs." and "Brimstail cannot directly give you any circles, or red coloured shapes." They used to be
// handed out once, ever. The plugin's own handlers are driven with the transcript's condition and action ids.
const assert = require('node:assert/strict');
const { test, before } = require('node:test');
const path = require('node:path');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const runtime = require('../plugins/quests/QuestRuntime');
const core = PluginManager.getCoreApi();
const I = core.ItemIdentifiers;
const noop = () => {};

const BRIMSTAIL = 4913; // the world spawn the plugin answers Talk-to for
const OWED_CONDITION = 'r8Ly0u'; // "If the player has not received the three extra discs from Brimstail:"
const HAND_OVER_ACTION = 'zghUpW'; // receive "three random discs"
const BEFORE_UNLOCK = 'the-anti-illusion-machine-talking-to-brimstail-again-before-unlocking-the-machine';
const AFTER_UNLOCK = 'the-anti-illusion-machine-talking-to-brimstail-after-unlocking-the-machine-s-front-panel';
const STAGE_REPAIR_REPORTED = 8, STAGE_PANEL_UNLOCKED = 9;
const FIRST_SET = () => [I.GREEN_SQUARE, I.BLUE_TRIANGLE, I.YELLOW_PENTAGON];
const COLOURS = ['RED', 'ORANGE', 'YELLOW', 'GREEN', 'BLUE', 'INDIGO', 'VIOLET'];
const SHAPES = ['CIRCLE', 'TRIANGLE', 'SQUARE', 'PENTAGON'];
const ALL_DISCS = () => COLOURS.flatMap((colour) => SHAPES.map((shape) => I[`${colour}_${shape}`]));

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
});

function harness() {
  const events = {}, conditions = [], talks = new Map(), played = [];
  const startTranscript = runtime.startTranscript;
  const api = new Proxy({
    core,
    persistAttribute: noop,
    onNpcInteraction: (name, actions) => talks.set(name, actions),
    onNpcDialogueCondition: (handler) => conditions.push(handler),
    onCustomEvent: (key, handler) => (events[key] ??= []).push(handler),
    emitCustomEvent: (key, event) => (events[key] ?? []).forEach((handler) => handler(event)),
  }, { get: (target, key) => target[key] ?? noop });
  // The module binds startTranscript when it loads: record which variant Talk-to plays instead of running it.
  runtime.startTranscript = (_api, _player, _npcId, _page, variant) => { played.push(variant); return true; };
  const file = require.resolve('../plugins/quests/quests/EyesOfGlouphrie.Quest');
  delete require.cache[file];
  try { require(file)(api); } finally { runtime.startTranscript = startTranscript; }
  const quest = runtime.getRegisteredQuests().findLast((entry) => entry.key === 'the_eyes_of_glouphrie');
  return {
    quest, played,
    owed: (player) => conditions.map((handler) => handler({ player, npcId: BRIMSTAIL, text: 'x', stepId: OWED_CONDITION })).find((answer) => answer !== null),
    handOver: (player) => (events['npc-dialogue:action'] ?? []).forEach((handler) => handler({ player, npcId: BRIMSTAIL, stepId: HAND_OVER_ACTION })),
    talk: (player) => talks.get('Brimstail')['Talk-to']({ player, npcId: BRIMSTAIL }),
  };
}

function makePlayer() {
  const attrs = new Map(), items = new Map(), messages = [];
  let free = 28;
  const sender = new Proxy({}, { get: () => () => sender });
  return {
    attrs, items, messages,
    setFree(value) { free = value; },
    discs: () => ALL_DISCS().flatMap((id) => Array(items.get(id) ?? 0).fill(id)),
    drop: () => { for (const id of ALL_DISCS()) items.delete(id); },
    getAttribute: (key) => attrs.get(key),
    setAttribute: (key, value) => attrs.set(key, value),
    getInventory: () => ({
      getAmount: (id) => items.get(id) ?? 0,
      getFreeSlots: () => free,
      adds: (id, amount = 1) => { items.set(id, (items.get(id) ?? 0) + amount); return true; },
      deleteNumber: (id, amount = 1) => { items.set(id, Math.max(0, (items.get(id) ?? 0) - amount)); return true; },
    }),
    getPacketSender: () => sender,
    getSkillManager: () => ({ getMaxLevel: () => 99 }),
    sendMessage: (text) => messages.push(text),
    isPlayerBot: () => false,
  };
}

test('the first three extra discs are the fixed set, and he owes no more while the player carries a disc', () => {
  const h = harness();
  const p = makePlayer();
  h.quest.setStage(p, STAGE_REPAIR_REPORTED);
  assert.equal(h.owed(p), true, 'never handed out: owed');
  h.handOver(p);
  assert.deepEqual(p.discs().sort(), FIRST_SET().sort());
  assert.equal(h.owed(p), false, 'carrying discs: not owed');
  h.handOver(p);
  assert.equal(p.discs().length, 3, 'the hand-over step gives nothing while discs are carried');
  p.drop();
  p.items.set(I.RED_SQUARE, 1);
  assert.equal(h.owed(p), false, 'one disc left is still a disc');
});

test('the drop trick: with no disc carried he hands over three more, again and again', () => {
  const h = harness();
  const p = makePlayer();
  h.quest.setStage(p, STAGE_REPAIR_REPORTED);
  h.handOver(p);
  for (let round = 0; round < 3; round++) {
    p.drop();
    assert.equal(h.owed(p), true, `round ${round}: owed once the discs are dropped`);
    h.handOver(p);
    assert.equal(p.discs().length, 3, `round ${round}: three discs`);
    assert.equal(h.owed(p), false);
  }
});

test('the rolled discs are never circles and never red (Wiki), and cover more than the fixed set', () => {
  const h = harness();
  const p = makePlayer();
  h.quest.setStage(p, STAGE_REPAIR_REPORTED);
  h.handOver(p);
  const allowed = new Set(COLOURS.slice(1).flatMap((colour) => SHAPES.slice(1).map((shape) => I[`${colour}_${shape}`])));
  assert.equal(allowed.size, 18);
  const seen = new Set();
  for (let round = 0; round < 300; round++) {
    p.drop();
    h.handOver(p);
    for (const id of p.discs()) {
      assert.ok(allowed.has(id), `disc ${id} is a circle or red`);
      seen.add(id);
    }
  }
  assert.equal(seen.size, 18, 'every disc he can give turns up over 900 rolls');
});

test('a full inventory keeps the discs owed', () => {
  const h = harness();
  const p = makePlayer();
  h.quest.setStage(p, STAGE_REPAIR_REPORTED);
  h.handOver(p);
  p.drop();
  p.setFree(2);
  h.handOver(p);
  assert.deepEqual(p.discs(), []);
  assert.deepEqual(p.messages, ['You need three free inventory slots.']);
  assert.equal(h.owed(p), true);
  p.setFree(3);
  h.handOver(p);
  assert.equal(p.discs().length, 3);
});

test('after the panel is unlocked a player with no disc left gets the page that hands discs over', () => {
  const h = harness();
  const p = makePlayer();
  h.quest.setStage(p, STAGE_PANEL_UNLOCKED);
  p.items.set(I.RED_SQUARE, 1);
  h.talk(p);
  assert.equal(h.played.at(-1), AFTER_UNLOCK, 'with a disc: the stage\'s own page');
  p.drop();
  h.talk(p);
  assert.equal(h.played.at(-1), BEFORE_UNLOCK, 'with none: the page whose answer hands discs over');
  assert.equal(h.owed(p), true);
  h.handOver(p);
  assert.equal(p.discs().length, 3);
});
