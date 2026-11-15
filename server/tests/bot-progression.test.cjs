// Run after `yarn build`: node --test tests/bot-progression.test.cjs
// Ours: a `"progression": true` bot site is one crowd of brand-new characters that change mode
// on a timer and always do the best activity their own levels allow.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const { createBotActivityRegistry } = require('../plugins/bots/brain/ActivityRegistry.PlayerBots');
const { BotBrain } = require('../plugins/bots/brain/Brain.PlayerBots');
const { Skill } = require('../dist/game/model/Skill');

/**
 * A registry over the shipped activities and a sites file of our own. The world's own
 * "PlayerBots:sites" (world.json) is laid over any sites file, so the test's site has an id of
 * its own and is looked up by it.
 */
function registryWith(sites) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bot-sites-')), 'bot-sites.json');
  fs.writeFileSync(file, JSON.stringify({ sites, pvp: { botPool: 0, activeRegionBotsPerRegion: 0 } }));
  return createBotActivityRegistry({ world: { core: PluginManager.getCoreApi() }, sitesPath: file });
}

/** A player with the given levels (by skill name, lower case); every other skill is 1. */
function playerWith(levels = {}) {
  const level = (skill) => levels[String(skill.getName()).toLowerCase()] ?? 1;
  return { getUsername: () => 'SiteBot1', getSkillManager: () => ({ getCurrentLevel: level, getMaxLevel: level }) };
}

const NEWCOMERS = { id: 'testcrowd', enabled: true, progression: true, x: 3222, y: 3219, radius: 12, switchMinutes: [20, 40],
  bots: { woodcutting: 30, mining: 20, fishing: 10, combat_training: 40 } };

test('a progression site is one crowd that may do every activity of its modes', () => {
  const registry = registryWith([NEWCOMERS]);
  const site = registry.getSite('testcrowd');
  assert.equal(site.progression, true);
  assert.equal(site.count, 100, 'the mode counts add up to the crowd');
  assert.equal(site.levels, null, 'no levels are handed out: they start as new characters');
  assert.deepEqual(site.anchor, { x: 3222, y: 3219, z: 0 });
  assert.equal(site.spawnRadius, 12);
  const ids = site.activities.map((activity) => activity.id);
  for (const id of ['normal_trees', 'oak_trees', 'willow_trees', 'yew_trees', 'copper_tin_rocks', 'mithril_rocks', 'net_fishing', 'harpoon_fishing', 'combat_training']) {
    assert.ok(ids.includes(id), id);
  }
  assert.ok(!ids.includes('pvp') && !ids.includes('roam'), 'never the Wilderness activities');
  assert.equal(site.rotation.best, true);
  assert.deepEqual(site.rotation.switchAfterMs, { min: 20 * 60000, max: 40 * 60000 });
  assert.equal(site.rotation.weights.yew_trees, 30, 'an activity weighs what its mode counts');
  assert.equal(site.rotation.weights.combat_training, 40);
  assert.deepEqual(registryWith([{ ...NEWCOMERS, switchMinutes: undefined }]).getSite('testcrowd').rotation.switchAfterMs, { min: 20 * 60000, max: 40 * 60000 }, 'the default');
});

test('a mode left at 0 is not one of the crowd\'s; a bad count or mode stops the load', () => {
  const site = registryWith([{ ...NEWCOMERS, bots: { woodcutting: 5, mining: 0 } }]).getSite('testcrowd');
  assert.deepEqual([...new Set(site.activities.map((activity) => activity.mode))], ['woodcutting']);
  assert.throws(() => registryWith([{ ...NEWCOMERS, bots: { woodcutting: { novices: 5 } } }]), /whole number/);
  assert.throws(() => registryWith([{ ...NEWCOMERS, bots: { dancing: 5 } }]), /unknown mode/);
  assert.throws(() => registryWith([{ ...NEWCOMERS, switchMinutes: [0, 5] }]), /switchMinutes/);
});

test('startOver is the crowd\'s round: 0 unless set, and a whole number', () => {
  assert.equal(registryWith([NEWCOMERS]).getSite('testcrowd').startOver, 0);
  assert.equal(registryWith([{ ...NEWCOMERS, startOver: 3 }]).getSite('testcrowd').startOver, 3);
  assert.throws(() => registryWith([{ ...NEWCOMERS, startOver: -1 }]), /startOver/);
  assert.throws(() => registryWith([{ ...NEWCOMERS, startOver: 'again' }]), /startOver/);
});

test('an ordinary site next to it is untouched', () => {
  const registry = registryWith([NEWCOMERS, { id: 'draynor', enabled: true, x: 3093, y: 3244, bots: { fishing: { novices: 4 } } }]);
  const ordinary = registry.getSite('draynor_fishing_novices');
  assert.equal(ordinary.count, 4);
  assert.equal(ordinary.activities.length, 1);
  assert.equal(ordinary.progression, undefined);
  assert.equal(registry.getSite('testcrowd').count, 100);
});

test('a pick for a progression bot is the best activity of a mode for its own levels', () => {
  const registry = registryWith([NEWCOMERS]);
  const { rotation } = registry.getSite('testcrowd');
  const options = { allowed: rotation.activityIds, weights: rotation.weights, best: true };
  const picks = (player, extra = {}) => {
    const seen = new Set();
    for (let i = 0; i < 400; i++) seen.add(registry.pickActivity(playerWith(player), 1000 + i, { ...options, ...extra }).id);
    return [...seen].sort();
  };
  assert.deepEqual(picks({}), ['combat_training', 'copper_tin_rocks', 'net_fishing', 'normal_trees'], 'a new character: the first activity of each mode');
  assert.deepEqual(picks({ woodcutting: 31, mining: 15, fishing: 60 }), ['combat_training', 'harpoon_fishing', 'iron_rocks', 'willow_trees']);
  assert.deepEqual(picks({ woodcutting: 99 }, { avoid: 'yew_trees' }), ['combat_training', 'copper_tin_rocks', 'net_fishing', 'willow_trees'],
    'a change of activity never offers the one being left');
  // Without `best` (an ordinary rotation) every activity the levels allow is on offer.
  const all = new Set();
  for (let i = 0; i < 600; i++) all.add(registry.pickActivity(playerWith({ woodcutting: 99 }), 5000 + i, { allowed: rotation.activityIds }).id);
  assert.ok(all.has('normal_trees') && all.has('yew_trees'));
});

test('Agility is a mode like the others: a rooftop course by level, started at 1', () => {
  const registry = registryWith([{ ...NEWCOMERS, bots: { agility: 5 } }]);
  const site = registry.getSite('testcrowd');
  assert.deepEqual(site.activities.map((activity) => activity.id), ['draynor_rooftop', 'varrock_rooftop', 'falador_rooftop']);
  assert.deepEqual(site.activities.map((activity) => registry.requiredLevel(activity)), [1, 30, 50]);
  assert.equal(registry.bestForMode(playerWith({}), 'agility').id, 'draynor_rooftop', 'a new character has 1 Agility, not 99');
  assert.equal(registry.bestForMode(playerWith({ agility: 30 }), 'agility').id, 'varrock_rooftop');
  assert.equal(registry.bestForMode(playerWith({ agility: 99 }), 'agility').id, 'falador_rooftop');
  const lap = registry.byId.get('draynor_rooftop').actions[0];
  assert.equal(lap.id, 'runCourse');
  assert.equal(typeof lap.holdsRotation, 'function');
});

test('a change of activity waits while the action holds it (a lap in progress on a roof)', () => {
  const registry = registryWith([NEWCOMERS]);
  const { rotation } = registry.getSite('testcrowd');
  let onRoof = true;
  const stopped = [];
  const activity = { ...registry.byId.get('normal_trees'), id: 'normal_trees',
    actions: [{ id: 'lap', update: () => 'running', holdsRotation: () => onRoof, stop: () => stopped.push('lap') }] };
  const player = { ...playerWith({}), getCombat: () => ({ getTarget: () => null, getAttacker: () => null }) };
  const brain = new BotBrain({ player, state: {}, registry, world: {}, activity, rotation, nowMs: 1000 });
  const due = brain.switchAt + 1;
  brain.maybeSwitchActivity(due);
  assert.equal(brain.frames[0].behaviour.id, 'normal_trees', 'still on its lap');
  assert.deepEqual(stopped, []);
  onRoof = false;
  brain.maybeSwitchActivity(due + 600);
  assert.notEqual(brain.frames[0].behaviour.id, 'normal_trees', 'back on the ground: it moves on');
  assert.deepEqual(stopped, ['lap']);
});

test('a full activity falls back to the next best of its mode', () => {
  const registry = registryWith([NEWCOMERS]);
  const yews = registry.byId.get('yew_trees');
  for (let i = 0; i < yews.capacity; i++) registry.occupy(yews);
  assert.equal(registry.bestForMode(playerWith({ woodcutting: 99 }), 'woodcutting').id, 'willow_trees');
  registry.release(yews);
  assert.equal(registry.bestForMode(playerWith({ woodcutting: 99 }), 'woodcutting').id, 'yew_trees');
  assert.equal(registry.bestForMode(playerWith({}), 'woodcutting').id, 'normal_trees');
  assert.equal(registry.bestForMode(playerWith({}), 'pvp'), null, 'only the sites\' own modes');
  assert.equal(registry.requiredLevel(yews), 60);
  assert.equal(registry.requiredLevel(registry.byId.get('combat_training')), 1);
});

test('a bot that has outgrown its activity moves up when it comes round again, keeping its timer', () => {
  const registry = registryWith([NEWCOMERS]);
  const { rotation } = registry.getSite('testcrowd');
  const levels = { woodcutting: 1 };
  const player = { ...playerWith(levels), getSkillManager: () => ({ getCurrentLevel: (skill) => (skill === Skill.WOODCUTTING ? levels.woodcutting : 1) }) };
  const logged = [];
  const brain = new BotBrain({ player, state: {}, registry, world: { log: (event, data) => logged.push([event, data.from, data.to]) },
    activity: registry.byId.get('normal_trees'), rotation, nowMs: 1000 });
  const switchAt = brain.switchAt;
  assert.ok(switchAt >= 1000 + 20 * 60000 && switchAt <= 1000 + 40 * 60000);
  // Still level 1: nothing better, so it goes round again.
  assert.equal(brain.promote(brain.frames[0], 2000), false);
  assert.equal(brain.frames[0].behaviour.id, 'normal_trees');
  // Level 15: oaks. The slot it held is given back and the new one taken.
  levels.woodcutting = 15;
  assert.equal(brain.promote(brain.frames[0], 3000), true);
  assert.equal(brain.frames.length, 1);
  assert.equal(brain.frames[0].behaviour.id, 'oak_trees');
  assert.equal(brain.rootActivityId, 'oak_trees');
  assert.equal(brain.switchAt, switchAt, 'the change of mode is still due when it was');
  assert.deepEqual(logged, [['bot_brain_activity_promoted', 'normal_trees', 'oak_trees']]);
  // Level 60 skips willows for yews; a bot never moves down.
  levels.woodcutting = 60;
  assert.equal(brain.promote(brain.frames[0], 4000), true);
  assert.equal(brain.frames[0].behaviour.id, 'yew_trees');
  levels.woodcutting = 30;
  assert.equal(brain.promote(brain.frames[0], 5000), false, 'a drained level does not demote it');
  // An ordinary rotation (no `best`) is never promoted.
  const plain = new BotBrain({ player, state: {}, registry, world: {}, activity: registry.byId.get('normal_trees'),
    rotation: { activityIds: ['normal_trees', 'oak_trees'], weights: {}, switchAfterMs: { min: 1, max: 2 } }, nowMs: 1000 });
  levels.woodcutting = 99;
  assert.equal(plain.promote(plain.frames[0], 2000), false);
});
