// From server/: node --test tests/ascent-of-arceuus-trobin-head.test.cjs
//
// Upstream issue #5158: Lord Trobin Arceuus had no head in the chatbox before the end of The Ascent of
// Arceuus. Until the device is smashed he is his entranced form (8504), which has no chathead model in
// the cache; his lines now take the head of his other form (8505).
const assert = require('node:assert/strict');
const { test, before } = require('node:test');
const path = require('node:path');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { CacheDefinitions } = require('../dist/game/cache/CacheDefinitions');
const { NpcDefinitionLoader } = require('../dist/game/definition/loader/impl/NpcDefinitionLoader');
const core = PluginManager.getCoreApi();

const ENTRANCED = 8504, TROBIN = 8505;
let lineHooks;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  new NpcDefinitionLoader().load();
  const events = {};
  const api = new Proxy({
    core,
    persistAttribute() {},
    onCustomEvent(key, fn) { (events[key] ??= []).push(fn); },
    emitCustomEvent() {},
  }, { get: (target, key) => target[key] ?? (() => {}) });
  require('../plugins/quests/quests/AscentOfArceuus.Quest')(api);
  lineHooks = events['npc-dialogue:line'];
});

function line(npcId, step) {
  const attrs = new Map();
  const player = { getAttribute: (key) => attrs.get(key), setAttribute: (key, value) => attrs.set(key, value), getPacketSender: () => new Proxy({}, { get: () => () => {} }) };
  const event = { player, npcId, step, text: step.npc ?? step.text ?? step.player };
  for (const hook of lineHooks) hook(event);
  return event.speakerId;
}

test('the cache gives the entranced Lord Trobin no head, and his other form one', () => {
  assert.equal(CacheDefinitions.getNpc(ENTRANCED).name, 'Lord Trobin Arceuus');
  assert.equal(CacheDefinitions.getNpc(ENTRANCED).chatheadModelIds, undefined);
  assert.equal(CacheDefinitions.getNpc(TROBIN).name, 'Lord Trobin Arceuus');
  assert.ok(CacheDefinitions.getNpc(TROBIN).chatheadModelIds.length > 0);
  // The entranced form is the one on the map until the quest's stage reaches 13.
  assert.deepEqual(CacheDefinitions.getNpc(8624).transforms.slice(0, 14), [...Array(13).fill(ENTRANCED), -1]);
});

test("the entranced Lord Trobin's lines take his own head", () => {
  assert.equal(line(ENTRANCED, { npc: 'Good day friend.' }), TROBIN);
  assert.equal(line(ENTRANCED, { type: 'line', speaker: 'Lord Trobin Arceuus', text: 'Good day friend.' }), TROBIN);
  assert.equal(line(ENTRANCED, { player: 'Tell me about yourself.' }), undefined, "the player's lines are left alone");
  assert.equal(line(TROBIN, { npc: 'Good day friend.' }), undefined, 'his other form already has its head');
});
