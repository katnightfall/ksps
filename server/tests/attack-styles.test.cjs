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
