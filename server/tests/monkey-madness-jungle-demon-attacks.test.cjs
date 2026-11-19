// From server/: node --test tests/monkey-madness-jungle-demon-attacks.test.cjs
// Upstream issue #4101: the Jungle Demon never used magic. Wiki (Jungle Demon): it "alternates between
// all four wave spells, each hitting for up to 32", and "when in range" swings a halberd-like attack that
// reaches two tiles (three or more squares away avoids it); it casts without walking up to the player first.
// Real plugins, cache, map and NPC. The attacks are driven as Combat.performNewAttack drives them (start, hits,
// finished on one method object); a whole fight on World turns is not run here (the harness loads no NPC definitions).
const assert = require("node:assert/strict");
const { before, after, test, mock } = require("node:test");
const h = require("./quest-capture-harness.cjs");

// The quest's arena tiles (MonkeyMadnessI.Quest.js ARENA_DEMON / ARENA_PLAYER), plane 1.
const DEMON_TILE = [2713, 9168, 1];
const FAR = [2713, 9174, 1]; // four tiles north of the demon's 3x3
const TWO_AWAY = [2713, 9172, 1];
const THREE_AWAY = [2713, 9173, 1];

before(async () => {
  h.key = "monkey_madness_i";
  const worldConfig = require("../dist/game/definition/WorldDefinition");
  const readConfig = worldConfig.readWorldConfig;
  const config = mock.method(worldConfig, "readWorldConfig", (...args) => {
    const actual = readConfig(...args);
    return { ...actual, plugins: { ...actual.plugins, WorldAdmin: false } };
  });
  try { await h.setup([[2713, 9170]]); } finally { config.mock.restore(); }
});
after(() => h.teardown());

const seq = (name) => h.core.CacheDefinitions.getSeqId(name);

function fight(t, playerTile) {
  const f = h.actor(t, { at: playerTile, done: [], stage: 8 });
  const demon = h.spawn(f, h.core.NpcIdentifiers.JUNGLE_DEMON, DEMON_TILE);
  demon.getMovementCoordinator().setRadius(0);
  const animations = [];
  const animate = demon.performAnimation.bind(demon);
  demon.performAnimation = (animation) => { animations.push(animation.getId()); return animate(animation); };
  return { f, demon, animations };
}

test("the cache names the demon's two attack sequences", () => {
  assert.ok(Number.isInteger(seq("demon_casting")) && seq("demon_casting") >= 0);
  assert.ok(Number.isInteger(seq("demon_attack")) && seq("demon_attack") >= 0);
  assert.equal(h.core.NpcDefinition.forId(h.core.NpcIdentifiers.JUNGLE_DEMON).getSize(), 3);
});

test("out of reach it casts the four waves in turn, each with a maximum of 32", (t) => {
  const { f, demon, animations } = fight(t, FAR);
  const { CombatFactory, CombatSpells, CombatType } = h.core;
  const cast = [];
  for (let attack = 0; attack < 5; attack++) {
    const method = CombatFactory.getMethod(demon);
    assert.equal(method.constructor.name, "JungleDemonCombat");
    assert.ok(method.attackDistance(demon) >= 4, "it need not walk up to the player to attack");
    method.start(demon, f.player);
    assert.equal(method.type(), CombatType.MAGIC);
    const spell = demon.getCombat().getCastSpell();
    assert.equal(spell.maximumHit(), 32);
    cast.push(spell.spellId());
    assert.equal(animations.at(-1), seq("demon_casting"));
    const hits = method.hits(demon, f.player);
    assert.equal(hits.length, 1);
    assert.ok(hits[0].getTotalDamage() <= 32);
    method.finished(demon, f.player);
    assert.equal(demon.getCombat().getCastSpell(), null);
  }
  const waves = [CombatSpells.WIND_WAVE, CombatSpells.WATER_WAVE, CombatSpells.EARTH_WAVE, CombatSpells.FIRE_WAVE].map((spell) => spell.spellId());
  assert.deepEqual(cast, [...waves, waves[0]], "wind, water, earth, fire and round again");
});

test("within two tiles it swings; from the third tile it casts", (t) => {
  const near = fight(t, TWO_AWAY);
  const method = h.core.CombatFactory.getMethod(near.demon);
  method.start(near.demon, near.f.player);
  assert.equal(method.type(), h.core.CombatType.MELEE);
  assert.equal(near.demon.getCombat().getCastSpell(), null);
  assert.equal(near.animations.at(-1), seq("demon_attack"));
  const hits = method.hits(near.demon, near.f.player);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].getTotalDamage() <= 32);

  const off = fight(t, THREE_AWAY);
  const ranged = h.core.CombatFactory.getMethod(off.demon);
  ranged.start(off.demon, off.f.player);
  assert.equal(ranged.type(), h.core.CombatType.MAGIC);
});

test("asked before the attack starts, its style and reach are those of where its target stands", (t) => {
  // The engine reads type() and attackDistance() while the demon closes in, before start().
  const far = fight(t, FAR);
  far.demon.getCombat().attack(far.f.player);
  assert.equal(far.demon.getCombat().getTarget(), far.f.player);
  const ranged = h.core.CombatFactory.getMethod(far.demon);
  assert.equal(ranged.type(), h.core.CombatType.MAGIC);
  assert.equal(ranged.attackDistance(far.demon), new h.core.MagicCombatMethod().attackDistance(far.demon), "casting range");
  assert.equal(ranged.attackSpeed(far.demon), new h.core.MeleeCombatMethod().attackSpeed(far.demon), "the demon's own speed for both");

  const near = fight(t, TWO_AWAY);
  near.demon.getCombat().attack(near.f.player);
  assert.equal(h.core.CombatFactory.getMethod(near.demon).type(), h.core.CombatType.MELEE);
});
