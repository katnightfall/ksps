// Run after `yarn build`: node --test tests/bastion-battlemage-boosts.test.cjs
//
// Ours: OSRS Wiki, Bastion potion ("Ranged will be boosted by 4 + 10% of the player's level", "Defence ... 5 + 15%"),
// Battlemage potion ("Magic will be boosted by 4", "Defence ... 5 + 15%") and their divine versions. The server gave
// a super ranging's 5 + 15% Ranged and a 4 + 15% Magic.
const assert = require('node:assert/strict');
const path = require('node:path');
const { test, before, after } = require('node:test');
process.env.DISABLE_PLAYER_BOTS = '1';
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { Player } = require('../dist/game/entity/impl/player/Player');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { TaskManager } = require('../dist/game/task/TaskManager');
const { ItemIdentifiers: I } = require('../dist/util/ItemIdentifiers');
const { Item } = require('../dist/game/model/Item');
const { Skill } = require('../dist/game/model/Skill');

before(async () => {
  await require('../dist/game/cache/CachePipeline').CachePipeline.initialize(process.cwd());
  PluginManager.loadFromDirectory(path.resolve(__dirname, '../plugins'));
  PluginManager.emitServerStartup({});
});
after(() => PluginManager.emitServerShutdown({}));

/** A level-99 player (level `level` in the three skills) who drinks one dose; returns the boosts. */
function boostsAfter(t, itemId, level = 99) {
  const p = new Player(null);
  p.setRegistered(true);
  t.mock.method(p, 'getSession', () => ({ sendClientPacket: () => true }));
  t.mock.method(p, 'performAnimation', () => {});
  t.after(() => { p.setRegistered(false); TaskManager.cancelTasks(p); });
  const skills = p.getSkillManager();
  for (const skill of [Skill.RANGED, Skill.MAGIC, Skill.DEFENCE]) skills.setMaxLevels(skill, level, false).setCurrentLevels(skill, level, false);
  skills.setMaxLevels(Skill.HITPOINTS, 99, false).setCurrentLevels(Skill.HITPOINTS, 99, false);
  p.getInventory().setItem(0, new Item(itemId, 1));
  const item = p.getInventory().getItems()[0];
  assert.equal(PluginManager.emitItemAction({ player: p, item, itemId, slot: 0, clickType: 1, handled: false }), true, String(itemId));
  const boost = (skill) => skills.getCurrentLevel(skill) - level;
  return { ranged: boost(Skill.RANGED), magic: boost(Skill.MAGIC), defence: boost(Skill.DEFENCE) };
}

test('a bastion potion: Ranged 4 + 10%, Defence 5 + 15% (Wiki: Bastion potion)', (t) => {
  assert.deepEqual(boostsAfter(t, I.BASTION_POTION_4_), { ranged: 13, magic: 0, defence: 19 }, 'at 99: 4 + 9 and 5 + 14');
  assert.deepEqual(boostsAfter(t, I.BASTION_POTION_4_, 70), { ranged: 11, magic: 0, defence: 15 }, 'at 70: 4 + 7 and 5 + 10');
});

test('a battlemage potion: Magic 4, Defence 5 + 15% (Wiki: Battlemage potion)', (t) => {
  assert.deepEqual(boostsAfter(t, I.BATTLEMAGE_POTION_4_), { ranged: 0, magic: 4, defence: 19 });
  assert.deepEqual(boostsAfter(t, I.BATTLEMAGE_POTION_4_, 70), { ranged: 0, magic: 4, defence: 15 });
});

test('the divine versions boost by the same amounts (Wiki: Divine bastion potion, Divine battlemage potion)', (t) => {
  assert.deepEqual(boostsAfter(t, I.DIVINE_BASTION_POTION_4_), { ranged: 13, magic: 0, defence: 19 });
  assert.deepEqual(boostsAfter(t, I.DIVINE_BATTLEMAGE_POTION_4_), { ranged: 0, magic: 4, defence: 19 });
});
