// From server/: node --test tests/perilous-moons-entrances.test.cjs
// Upstream issue #5161: Neypotzli's entrances join the caverns the OSRS Wiki's map joins, a cavern's way back comes
// out by the antechamber entrance it belongs to, the builders wait on the bridge, and the transcript's unnamed
// speakers (Guard, Builder 1, Builder 2) get the cache's heads.
const assert = require('node:assert/strict');
const { test, before } = require('node:test');
const path = require('node:path');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const { DialogueManager } = require('../dist/game/model/dialogues/DialogueManager');
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { NpcDefinitionLoader } = require('../dist/game/definition/loader/impl/NpcDefinitionLoader');
const { MapObjects } = require('../dist/game/entity/impl/object/MapObjects');
const { RegionManager } = require('../dist/game/collision/RegionManager');
const { PathFinder } = require('../dist/game/model/movement/path/PathFinder');
const runtime = require('../plugins/quests/QuestRuntime');
const core = PluginManager.getCoreApi();
const O = core.ObjectIdentifiers;
let next = 1;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  new NpcDefinitionLoader().load();
  RegionManager.init();
  RegionManager.loadMapFiles(1440, 9640);
  for (const [x, y] of [[1374, 9667], [1347, 9590], [1390, 9676], [1522, 9719]]) RegionManager.loadMapFiles(x, y);
});

function harness() {
  const hooks = {}, events = {}, tasks = [], npcs = [], removed = [], objects = [];
  const api = new Proxy({ core: { ...core, World: { ...core.World, getNpcsNear: () => npcs }, TaskManager: {
    submit(task) { task.setRunning?.(true); tasks.push(task); }, cancelTasks(key) { tasks.filter(t => t.key === key).forEach(t => t.stop?.()); },
  }, ObjectManager: { register: o => objects.push(o), deregister: () => {} } },
    getObjectManager: () => ({ register: () => {}, deregister: () => {} }),
    getItemOnGroundManager: () => ({ registerLocation: () => {} }),
    persistAttribute() {}, onCustomEvent(k, fn) { (events[k] ??= []).push(fn); },
    emitCustomEvent(k, e) { for (const fn of events[k] ?? []) fn(e); },
    onObjectInteraction(fn) { if (typeof fn === 'function') (hooks.object ??= []).push(fn); },
    spawnNpc(def) { let loc = new core.Location(def.x, def.y, def.z); const npc = { ...def, getLocation: () => loc, moveTo: to => { loc = to; }, remove: () => {}, isRegistered: () => true, isNpc: () => true, getAsNpc: () => npc, getIndex: () => next++, setOwner() {}, setMobileInteraction() {}, setPositionToFace() {}, getMovementQueue: () => ({ reset() { return this; }, setBlockMovement() { return this; } }) }; npcs.push(npc); return npc; },
    removeNpc(npc) { npc.removed = true; removed.push(npc); },
  }, { get: (t, k) => t[k] ?? ((...args) => (hooks[k] ??= []).push(args.find(x => typeof x === 'function'))) });
  require('../plugins/quests/quests/PerilousMoons.Quest')(api);
  return { api, hooks, tasks, npcs, removed, objects, quest: runtime.getRegisteredQuests().at(-1) };
}
function player() {
  const attrs = new Map(), items = new Map();
  let loc = new core.Location(1440, 9620, 1);
  const inv = { getAmount: id => items.get(id) ?? 0, getFreeSlots: () => 28, adds(id, n) { items.set(id, (items.get(id) ?? 0) + n); }, deleteNumber(id, n) { items.set(id, (items.get(id) ?? 0) - n); } };
  const sender = new Proxy({ sendVarbit() { return sender; }, sendConfig() { return sender; }, sendInterfaceRemoval() { return sender; } }, { get: (t, k) => t[k] ?? (() => sender) });
  const p = { attrs, items, messages: [], getAttribute: k => attrs.get(k), setAttribute: (k, v) => attrs.set(k, v), getInventory: () => inv,
    getLocation: () => loc, moveTo: to => { loc = to; }, sendMessage: m => p.messages.push(m), getPacketSender: () => sender,
    getSkillManager: () => ({ getMaxLevel: () => 99 }), getEquipment: () => ({ get: () => null }),
    getMovementQueue: () => ({ reset() { return this; }, setBlockMovement() { return this; } }), setUntargetable() {}, isRegistered: () => true,
    getDialogueManager: () => p.manager, getIndex: () => next++, isPlayer: () => true, isNpc: () => false };
  p.manager = new DialogueManager(p);
  return p;
}
function gate(h, p, id, x, y, z = 0) {
  const event = { player: p, objectId: id, location: new core.Location(x, y, z), clickType: 1, definition: { getInteractions: () => ['Pass-through'] } };
  for (const fn of h.hooks.object ?? []) fn(event);
  return event;
}
const pos = p => [p.getLocation().getX(), p.getLocation().getY(), p.getLocation().getZ()];

test('the Ancient Prison north-west entrance and the Earthbound Cavern south entrance lead to each other', () => {
  const h = harness(), p = player();
  h.quest.setStage(p, 27);
  for (const [id, x, y] of [[O.ENTRANCE_15, 1345, 9590], [O.ENTRANCE_17, 1373, 9664]]) {
    assert.ok(MapObjects.get(id, new core.Location(x, y, 0), null), `entrance ${id} at ${x},${y} is in the cache`);
  }
  const north = gate(h, p, O.ENTRANCE_15, 1345, 9590);
  assert.equal(north.handled, true, 'the prison north-west entrance is taken');
  assert.deepEqual(pos(p), [1374, 9667, 0], 'in front of the Earthbound south entrance (1373..1375, 9664..9666)');
  const south = gate(h, p, O.ENTRANCE_17, 1373, 9664);
  assert.equal(south.handled, true);
  assert.deepEqual(pos(p), [1347, 9590, 0], 'beside the prison north-west entrance (The Final Dawn capture 3128 tile)');
});

test('the Streambound cave leads to the Earthbound cave, not back to itself', () => {
  const h = harness(), p = player();
  h.quest.setStage(p, 27);
  gate(h, p, O.ENTRANCE_18, 1521, 9720);
  assert.deepEqual(pos(p), [1390, 9676, 0]);
  gate(h, p, O.ENTRANCE_18, 1389, 9674);
  assert.deepEqual(pos(p), [1522, 9719, 0]);
});

test('each cavern way back comes out by its own antechamber entrance', () => {
  const h = harness(), p = player();
  h.quest.setStage(p, 27);
  // [the cavern's exit, where it comes out, the antechamber entrance (2x2, south-west tile) that leads to that cavern]
  const exits = [
    [[1388, 9576], [1423, 9615], [1421, 9613]],
    [[1404, 9716], [1423, 9649], [1421, 9650]],
    [[1480, 9667], [1457, 9649], [1458, 9650]],
  ];
  for (const [[x, y], landing, [ex, ey]] of exits) {
    gate(h, p, O.ENTRANCE_15, x, y);
    assert.deepEqual(pos(p), [...landing, 1], `exit ${x},${y}`);
    assert.equal(RegionManager.blocked(new core.Location(landing[0], landing[1], 1), null), false, `landing ${landing} is open`);
    assert.ok(MapObjects.get(O.ENTRANCE_16, new core.Location(ex, ey, 1), null), `antechamber entrance at ${ex},${ey}`);
    const dx = Math.max(ex - landing[0], 0, landing[0] - (ex + 1)), dy = Math.max(ey - landing[1], 0, landing[1] - (ey + 1));
    assert.ok(dx <= 1 && dy <= 1, `landing ${landing} touches the entrance at ${ex},${ey}`);
    // and that entrance takes the player back to the cavern the exit was in
    const before = pos(p);
    gate(h, p, O.ENTRANCE_16, ex, ey, 1);
    assert.notDeepEqual(pos(p), before);
    assert.ok(Math.abs(pos(p)[0] - x) <= 2 && Math.abs(pos(p)[1] - y) <= 2, `entrance ${ex},${ey} lands by exit ${x},${y}`);
  }
});

test('both halves of the prison doorway to the Ancient Shrine work', () => {
  const h = harness(), p = player();
  h.quest.setStage(p, 27);
  for (const x of [1354, 1356]) {
    p.moveTo(new core.Location(1355, 9538, 0));
    gate(h, p, O.ENTRANCE_15, x, 9536);
    assert.deepEqual(pos(p), [1512, 9563, 0], `half at ${x},9536`);
  }
});

test('the landings added for the caverns are open tiles', () => {
  for (const [x, y] of [[1374, 9667], [1347, 9590], [1390, 9676], [1522, 9719]]) {
    assert.equal(RegionManager.blocked(new core.Location(x, y, 0), null), false, `${x},${y}`);
  }
});

test('the builders wait on the bridge until the player is inside Cam Torum', () => {
  const h = harness(), p = player();
  const login = () => { for (const fn of h.hooks.onPlayerLogin ?? []) fn({ player: p }); };
  const builders = () => h.npcs.filter(npc => npc.id === 12871 && !npc.removed);
  const { CacheDefinitions } = require('../dist/game/cache/CacheDefinitions');
  // The cache: pmoon_digsite_workers_plank is Builder 12876 for pmoon_quest 0-5 and nobody from 6.
  const raw = CacheDefinitions.getNpc(12871);
  assert.equal(raw.transformVarbit, 9819);
  assert.deepEqual(raw.transforms.slice(0, 7), [12876, 12876, 12876, 12876, 12876, 12876, -1]);
  login();
  assert.equal(builders().length, 1, 'there before the quest');
  assert.deepEqual([builders()[0].x, builders()[0].y, builders()[0].z], [1436, 3122, 0]);
  assert.equal(builders()[0].ownerOnly, true);
  h.quest.setStage(p, 5);
  login();
  assert.equal(builders().length, 1, 'still there with the city open');
  h.quest.setStage(p, 6);
  login();
  assert.equal(builders().length, 0, 'gone once the player is in the city');
});

test('Guard, Builder 1 and Builder 2 lines get the heads the cache has for them', () => {
  const h = harness(), p = player();
  const { CacheDefinitions } = require('../dist/game/cache/CacheDefinitions');
  const line = (speaker, page, npcId = 12861) => {
    const event = { player: p, npcId, step: { type: 'line', speaker, text: 'x' }, text: 'x', pages: [{ page }] };
    h.api.emitCustomEvent('npc-dialogue:line', event);
    return event.speakerId;
  };
  assert.equal(line('Guard', 'Perilous Moons'), 12881);
  assert.equal(line('Builder 1', 'Transcript:Builder (Perilous Moons)', 12876), 12872);
  assert.equal(line('Builder 2', 'Transcript:Perilous Moons', 12877), 12873);
  for (const id of [12881, 12872, 12873]) assert.ok(CacheDefinitions.getNpc(id).chatheadModelIds?.length, `npc ${id} has a head`);
  assert.equal(CacheDefinitions.getNpc(12876).chatheadModelIds, undefined, 'the Builder NPC itself has none');
  assert.equal(line('Guard', "Transcript:Twilight's Promise"), undefined, 'other pages keep their own guards');
  assert.equal(line('Attala', 'Perilous Moons'), undefined);
  // The start transcript really has such lines.
  const start = require('../data/definitions/npc-dialogues.json')['Perilous Moons'].variants['ruins-in-cam-torum-talking-to-zuma-or-attala'];
  assert.ok(JSON.stringify(start).includes('"speaker":"Guard","text":"Advisor Attala..."'));
});
