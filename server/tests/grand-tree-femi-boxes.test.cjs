// Run after yarn build: node --test tests/grand-tree-femi-boxes.test.cjs
// Upstream issue #2207, the part that needs no recording. Wiki (Femi, Transcript:Femi): Femi asks
// about her boxes when the player first tries the Tree Gnome Stronghold's main gate; helping gets
// a free ride in The Grand Tree, refusing costs 1,000 coins, and afterwards "The little gnome is
// too busy to talk." The carrying of the boxes itself (animation) still needs a recording.
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, after, test } = require('node:test');
process.env.DISABLE_PLAYER_BOTS = '1';
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager: PM } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { PlayerSession } = require('../dist/net/PlayerSession');
const { ClientConnection } = require('../dist/net/NetworkBuilder');
const { MultiChatboxPrompt } = require('../dist/game/model/menu/MultiChatboxPrompt');
const { ObjectActionPacketListener } = require('../dist/net/packet/impl/ObjectActionPacketListener');

const GATE = { x: 2459, y: 3383 };
const OUTSIDE = [2461, 3382], INSIDE = [2461, 3385];
const HELPED = 'grand-tree:femi-helped', REFUSED = 'grand-tree:femi-refused';
let core, femi, gate, nextIndex = 4900;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  core = PM.getCoreApi();
  core.RegionManager.init();
  PM.loadFromDirectory(path.resolve(__dirname, '../plugins'));
  PM.emitServerStartup({});
  core.RegionManager.loadMapFiles(GATE.x, GATE.y);
  gate = core.MapObjects.get(core.ObjectIdentifiers.GATE_16, new core.Location(GATE.x, GATE.y, 0), null);
  assert.ok(gate, 'the map places the stronghold gate (loc 190) at 2459,3383');
  assert.deepEqual(gate.getDefinition().getInteractions().slice(0, 1), ['Open']);
  // Where the Wiki maps her: beside the gate, outside.
  femi = core.NPC.create(core.NpcIdentifiers.FEMI, new core.Location(2460, 3382, 0));
});
after(() => PM.emitServerShutdown({}));

function quest() {
  return require('../plugins/quests/QuestRuntime').getRegisteredQuests().find(q => q.key === 'grand_tree');
}

function actor(t, [x, y]) {
  const channel = { kind: 'test', remoteAddress: '127.0.0.1', isOpen: () => true,
    send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(nextIndex++); player.setUsername(`femibox${nextIndex}`);
  player.setAttribute('bot-skip-persistence', true); player.setRegistered(true);
  player.setLocation(new core.Location(x, y, 0)); player.setNeedsPlacement(false);
  const connection = new ClientConnection(channel); connection.player = player;
  const messages = [];
  const sender = player.getPacketSender();
  const send = sender.sendMessage.bind(sender);
  t.mock.method(sender, 'sendMessage', (text, ...rest) => { messages.push(text); return send(text, ...rest); });
  // Femi stands by the gate for whoever is near it.
  t.mock.method(core.World, 'getNpcsNear', () => [femi]);
  t.after(() => {
    PM.emitPlayerLogout({ player, username: player.getUsername() });
    player.closeInterruptibleInterfaces(); player.setRegistered(false);
    core.TaskManager.cancelTasks(player); core.TaskManager.cancelTasks(player.getIndex());
  });
  return { player, connection, messages };
}

function tick(player) {
  core.World.processCycle++;
  player.setNeedsPlacement(false);
  player.setResetMovementQueue(false);
  player.getMovementQueue().process();
  core.TaskManager.processWalkTo(player.getIndex());
  core.TaskManager.process();
}

function openGate(f) {
  new ObjectActionPacketListener().executeAction(f.player, gate.getId(), GATE.x, GATE.y, 1);
  for (let i = 0; i < 3; i++) tick(f.player);
}

const gateShut = () => !!core.MapObjects.get(core.ObjectIdentifiers.GATE_16, new core.Location(GATE.x, GATE.y, 0), null);

/** Puts the shut gate back for the next player (opening swaps it for its two open leaves, 191 and 192). */
function shutGate() {
  for (const [id, dx] of [[191, 0], [192, 3]]) {
    const leaf = core.MapObjects.get(id, new core.Location(GATE.x + dx, GATE.y, 0), null);
    if (leaf) core.ObjectManager.deregister(leaf, true);
  }
  if (!gateShut()) core.ObjectManager.register(gate, true);
  assert.ok(gateShut());
}

function talk(f) {
  return PM.emitNpcInteraction({ player: f.player, npc: femi, npcId: femi.getId(), action: 'Talk-to', clickType: 1, handled: false });
}

/** Continues the open conversation to its menu and picks the option, then to its end; the lines seen. */
async function answer(f, pattern) {
  const seen = [];
  for (let step = 0; step < 40; step++) {
    tick(f.player);
    const prompt = MultiChatboxPrompt.getPending(f.player);
    if (prompt) {
      const choice = prompt.options.findIndex(text => pattern.test(text));
      assert.ok(choice >= 0, `the menu offers ${pattern}: ${prompt.options.join(' | ')}`);
      seen.push(...prompt.options);
      await f.connection.dispatch([{ type: 'dialogue_continue', widgetId: MultiChatboxPrompt.OPTIONS_WIDGET_ID, childIndex: choice + 1 }]);
      f.connection.processTurnPackets();
      continue;
    }
    const group = f.player.getPacketSender().getChatboxGroupId();
    const child = ({ 231: 5, 217: 5, 229: 4, 193: 0, 11: 4 })[group];
    if (child === undefined) { if (seen.length) break; continue; }
    await f.connection.dispatch([{ type: 'dialogue_continue', widgetId: (group << 16) | child, childIndex: -1 }]);
    f.connection.processTurnPackets();
  }
  return seen;
}

const talking = (player) => [231, 217, 229].includes(player.getPacketSender().getChatboxGroupId()) || !!MultiChatboxPrompt.getPending(player);

test('the first try at the gate from outside brings Femi\'s question; helping is recorded and asked once', async t => {
  const f = actor(t, OUTSIDE);
  assert.equal(quest().getStage(f.player), 0);
  openGate(f);
  assert.ok(talking(f.player), 'Femi speaks instead of the gate opening');
  const menu = await answer(f, /^Okay then\.$/);
  assert.deepEqual(menu, ["Sorry, I'm a bit busy.", 'Okay then.']);
  assert.equal(f.player.getAttribute(HELPED), true);
  assert.notEqual(f.player.getAttribute(REFUSED), true);

  assert.ok(gateShut(), 'the gate stayed shut while she asked');
  f.player.closeInterruptibleInterfaces();
  openGate(f);
  assert.equal(talking(f.player), false, 'the gate is not held a second time');
  assert.equal(gateShut(), false, 'it opens');
  shutGate();

  assert.equal(talk(f), true);
  for (let i = 0; i < 2; i++) tick(f.player);
  assert.ok(!MultiChatboxPrompt.getPending(f.player), 'her question is not asked again');
});

test('turning her down is recorded, and cannot be taken back by talking to her again', async t => {
  const f = actor(t, OUTSIDE);
  openGate(f);
  assert.ok(talking(f.player), 'Femi speaks instead of the gate opening');
  await answer(f, /^Sorry, I'm a bit busy\.$/);
  assert.equal(f.player.getAttribute(REFUSED), true);
  assert.notEqual(f.player.getAttribute(HELPED), true);

  f.player.closeInterruptibleInterfaces();
  assert.equal(talk(f), true);
  for (let i = 0; i < 3; i++) tick(f.player);
  assert.ok(!MultiChatboxPrompt.getPending(f.player), 'no second chance to help');
  assert.notEqual(f.player.getAttribute(HELPED), true);
});

test('leaving the stronghold, a started quest and bots do not bring the question', t => {
  const inside = actor(t, INSIDE);
  openGate(inside);
  assert.equal(talking(inside.player), false, 'from inside the gate just opens');
  assert.equal(gateShut(), false);
  shutGate();

  const started = actor(t, OUTSIDE);
  quest().setStage(started.player, 10);
  openGate(started);
  assert.equal(talking(started.player), false, 'the quest is begun inside the stronghold: nothing to ask');
  assert.equal(gateShut(), false);
  shutGate();

  const bot = actor(t, OUTSIDE);
  bot.player.isPlayerBot = () => true;
  openGate(bot);
  assert.equal(talking(bot.player), false, 'bots walk through');
  assert.equal(gateShut(), false);
  shutGate();
  assert.notEqual(bot.player.getAttribute(HELPED), true);
});
