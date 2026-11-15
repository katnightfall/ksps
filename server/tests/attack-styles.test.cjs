// Run after `yarn build`: node --test tests/attack-styles.test.cjs
// Ours: AttackStyles.plugin.js changes what some attack styles train.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { FightType } = require('../dist/game/content/combat/FightType');
const { FightStyle } = require('../dist/game/content/combat/FightStyle');
const { CombatType } = require('../dist/game/content/combat/CombatType');
const { Skill } = require('../dist/game/model/Skill');
const plugin = require('../plugins/items/AttackStyles.plugin');

test('the scythes\' Jab gives shared XP; their other styles are untouched', () => {
  assert.equal(FightType.SCYTHE_JAB.getStyle(), FightStyle.AGGRESSIVE, 'as the cache has it');
  plugin.register({ core: { FightType, FightStyle } });
  assert.equal(FightType.SCYTHE_JAB.getStyle(), FightStyle.CONTROLLED);
  assert.deepEqual(FightType.SCYTHE_JAB.getStyle().skill(CombatType.MELEE),
    [Skill.ATTACK.getIndex(), Skill.STRENGTH.getIndex(), Skill.DEFENCE.getIndex()]);
  assert.equal(FightType.SCYTHE_REAP.getStyle(), FightStyle.ACCURATE);
  assert.equal(FightType.SCYTHE_CHOP.getStyle(), FightStyle.AGGRESSIVE);
  assert.equal(FightType.SCYTHE_BLOCK.getStyle(), FightStyle.DEFENSIVE);
});

test('every style the plugin names exists', () => {
  for (const [key, style] of Object.entries(plugin._test.STYLES)) {
    assert.ok(FightType[key], key);
    assert.ok(FightStyle[style], style);
  }
});

test('the Combat Options tab is told: the scythe row is sent whole with Jab reworded', () => {
  assert.equal(plugin._test.describe('(Aggressive)<br>(Crush)<br>(Strength XP)', 'CONTROLLED'), '(Controlled)<br>(Crush)<br>(Shared XP)');
  const definitions = require('../data/definitions/item-combat-styles.json');
  // The cache's own rows for the scythes (3955) and the swords (3948), as table 78 holds them.
  const row = (id, category, styles) => ({ id, columns: new Map([[0, [category]], [1, styles]]), column(column) { return this.columns.get(column) ?? []; } });
  const scythe = row(3955, 14, [0, 'Reap', '(Accurate)<br>(Slash)<br>(Attack XP)', 272, 1, 'Chop', '(Aggressive)<br>(Slash)<br>(Strength XP)', 262,
    2, 'Jab', '(Aggressive)<br>(Crush)<br>(Strength XP)', 271, 3, 'Block', '(Defensive)<br>(Slash)<br>(Defence XP)', 261]);
  const sword = row(3948, 9, [0, 'Chop', '(Accurate)<br>(Slash)<br>(Attack XP)', 239]);
  const rows = plugin._test.buildTooltipRows(definitions, [sword, scythe]);
  assert.deepEqual(rows, [{ rowId: 3955, tableId: 78, columns: {
    0: [14],
    1: [0, 'Reap', '(Accurate)<br>(Slash)<br>(Attack XP)', 272, 1, 'Chop', '(Aggressive)<br>(Slash)<br>(Strength XP)', 262,
      2, 'Jab', '(Controlled)<br>(Crush)<br>(Shared XP)', 271, 3, 'Block', '(Defensive)<br>(Slash)<br>(Defence XP)', 261],
  } }]);
  assert.equal(scythe.column(1)[10], '(Aggressive)<br>(Crush)<br>(Strength XP)', 'the cache row itself is not touched');
});

test('a person is sent the rows at login; a bot and a league character are not', () => {
  const sent = [];
  const scythe = { id: 3955, columns: new Map([[0, [14]], [1, [2, 'Jab', '(Aggressive)<br>(Crush)<br>(Strength XP)', 271]]]), column(column) { return this.columns.get(column) ?? []; } };
  const handlers = {};
  plugin.register({
    core: { FightType, FightStyle, CacheDefinitions: { getDbTableRows: (table) => (table === 78 ? [scythe] : []) } },
    onPlayerLogin: (handler) => { handlers.login = handler; },
    onCustomEvent: (name, handler) => { handlers[name] = handler; },
  });
  const player = (bot) => ({ isPlayerBot: () => bot, getPacketSender: () => ({ sendContentData: (source, datasets) => sent.push([source, datasets]) }) });
  handlers.login({ player: player(true), profile: 'main' });
  handlers.login({ player: player(false), profile: 'league' });
  assert.deepEqual(sent, []);
  handlers.login({ player: player(false), profile: 'main' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'server');
  assert.equal(sent[0][1][0].key, 'dbRowOverrides');
  assert.equal(sent[0][1][0].rows[0].columns[1][2], '(Controlled)<br>(Crush)<br>(Shared XP)');
  const query = { dbRows: [] };
  handlers['league:content-rows'](query);
  assert.equal(query.dbRows.length, 1, 'a league character gets them with the league\'s own');
});
