// Run after `yarn build`: node --test tests/shades-of-mortton-diary-trade.test.cjs
//
// Ours: the Diary of Herbi Flax used on the Apothecary in Varrock (OSRS Wiki: Shades of Mort'ton,
// Rewards; Diary (Shades of Mort'ton); Transcript:Apothecary): 335 Herblore experience, once.
const assert = require('node:assert/strict');
const { before, test } = require('node:test');
const path = require('node:path');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');

before(async () => {
  await require('../dist/game/cache/CachePipeline').CachePipeline.initialize(path.resolve(__dirname, '..'));
});

function setup() {
  const core = PluginManager.getCoreApi();
  const itemOnNpc = [];
  const persisted = new Map();
  const api = new Proxy({
    core,
    persistAttribute(key, initial) { persisted.set(key, initial); },
    onItemOnNpc(fn) { itemOnNpc.push(fn); },
    emitCustomEvent() {},
  }, { get(target, key) { return target[key] ?? (() => {}); } });
  require('../plugins/quests/quests/ShadesOfMortton.Quest')(api);

  const attrs = new Map(), inventory = new Map(), configs = new Map(), xp = [];
  let chain = [], index = -1;
  const sender = new Proxy({ sendConfig(id, value) { configs.set(id, value); return sender; } },
    { get(target, key) { return target[key] ?? (() => sender); } });
  const player = {
    getUsername: () => 'diary-test',
    getAttribute: (key) => attrs.get(key),
    setAttribute(key, value) { attrs.set(key, value); },
    getPacketSender: () => sender,
    sendMessage() {},
    getInventory: () => ({
      getAmount: (id) => inventory.get(id) ?? 0,
      deleteNumber(id, count) { inventory.set(id, Math.max(0, (inventory.get(id) ?? 0) - count)); },
    }),
    getSkillManager: () => ({ addExperiences(skill, amount) { xp.push([skill.getName(), amount]); } }),
    // As DialogueManager: a chain is shown entry by entry; an ActionDialogue runs when reached.
    getDialogueManager: () => ({
      startDialogues(builder) { chain = [...builder.getDialogues().values()]; index = -1; next(); },
      reset() { chain = []; index = -1; },
    }),
  };
  function next() {
    index += 1;
    const entry = chain[index];
    if (entry instanceof core.ActionDialogue) entry.send(player);
    return entry;
  }
  const text = () => chain[index]?.getText?.() ?? null;
  const use = (itemId, npcId) => {
    const event = { player, itemId, npcId, handled: false };
    for (const fn of itemOnNpc) if (!event.handled) fn(event);
    return event;
  };
  return { core, player, attrs, inventory, configs, xp, persisted, use, next, text, current: () => chain[index] };
}

test('the Apothecary trains Herblore for the diary: 335 experience, the diary is taken, and only once', () => {
  const h = setup();
  const I = h.core.ItemIdentifiers, N = h.core.NpcIdentifiers;
  const DIARY = I.DIARY_2;
  assert.equal(h.core.ItemDefinition.forId(DIARY).getName(), 'Diary');
  assert.equal(h.persisted.get('shades-of-mortton:diary-traded'), false, 'the trade is saved');

  h.inventory.set(DIARY, 1);
  assert.equal(h.use(DIARY, N.APOTHECARY).handled, true);
  assert.equal(h.text(), 'You show the Serum book to the Apothecary.');
  h.next();
  assert.match(h.text(), /^Do you want to trade the diary yet\?/);
  const options = h.next();
  assert.deepEqual(options.getOptions(), ["Yes, I'll trade it for herblore training.", 'No thanks, I want to keep hold if it a bit longer.']);

  // "No": nothing changes.
  options.execute(2);
  assert.equal(h.text(), 'No thanks, I want to keep hold if it a bit longer.');
  h.next();
  assert.equal(h.text(), "Oh, that's a shame... Come back if you change your mind.");
  assert.equal(h.inventory.get(DIARY), 1);
  assert.deepEqual(h.xp, []);

  // "Yes": the training.
  h.use(DIARY, N.APOTHECARY);
  h.next();
  h.next().execute(1);
  assert.equal(h.text(), "Yes, I'll trade it for herblore training.");
  h.next();
  assert.equal(h.text(), 'Great...');
  h.next();
  assert.equal(h.text(), 'The apothecary trains you in herblore.');
  assert.equal(h.inventory.get(DIARY), 0, 'the diary is handed over');
  assert.deepEqual(h.xp, [['Herblore', 335]]);
  assert.equal(h.configs.get(340) & (1 << 30), 1 << 30, 'varp 340 gains bit 30 (Transcript:Apothecary)');
  h.next();
  assert.equal(h.text(), "Ok, that's all I can teach you. Many thanks for the diary.");

  // A second diary from the shelf: refused.
  h.inventory.set(DIARY, 1);
  h.use(DIARY, N.APOTHECARY);
  h.next();
  assert.equal(h.text(), "Hmm, this is an interesting tome... But you've already sold me one, thanks!");
  assert.equal(h.next(), undefined, 'no offer follows');
  assert.equal(h.inventory.get(DIARY), 1);
  assert.deepEqual(h.xp, [['Herblore', 335]]);
});

test('other items on the Apothecary, and the diary on other NPCs, are left to their own handlers', () => {
  const h = setup();
  const I = h.core.ItemIdentifiers, N = h.core.NpcIdentifiers;
  assert.equal(h.use(I.CADAVA_BERRIES, N.APOTHECARY).handled, false);
  assert.equal(h.use(I.DIARY_2, N.AUBURY).handled, false);
  assert.equal(h.current(), undefined);
});
