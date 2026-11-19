// Run after `yarn build`: node --test tests/raid-boss-defence-rolls.test.cjs
// Upstream issue #6239 ("raids bosses have incredibly high defence"): what the raid bosses defend with,
// as the engine rolls it, against the Wiki's monster pages. (level + 9) x (bonus + 64), the Wiki DPS
// calculator's NPC defence roll; Tombs of Amascut x (1 + raid level / 250).
const assert = require('node:assert/strict');
const { test, before } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { NpcDefinitionLoader } = require('../dist/game/definition/loader/impl/NpcDefinitionLoader');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { AccuracyFormulasDpsCalc: Formulas } = require('../dist/game/content/combat/formula/AccuracyFormulasDpsCalc');
const { NPC } = require('../dist/game/entity/impl/npc/NPC');
const Monsters = require('../plugins/minigames/cox/Monsters.ChambersOfXeric');

const core = PluginManager.getCoreApi();
const SOLO = { size: 1, maxCombat: 126, maxHitpoints: 99, averageMining: 99, challenge: false };
const TILE = () => new core.Location(3222, 3218, 0);
const RANGED_TYPES = ['light', 'standard', 'heavy'];

before(() => {
  CachePipeline.initialize();
  new NpcDefinitionLoader().load();
});

function rolls(npc) {
  const factor = npc.getDefenceRollFactor();
  const scaled = (roll) => Math.floor(roll * factor);
  return {
    stab: scaled(Formulas.defenseMeleeRoll(npc, core.BonusManager.ATTACK_STAB)),
    slash: scaled(Formulas.defenseMeleeRoll(npc, core.BonusManager.ATTACK_SLASH)),
    crush: scaled(Formulas.defenseMeleeRoll(npc, core.BonusManager.ATTACK_CRUSH)),
    magic: scaled(Formulas.defenseMagicRoll(npc)),
    light: scaled(Formulas.defenseRangedRoll(npc, 'light')),
    standard: scaled(Formulas.defenseRangedRoll(npc, 'standard')),
    heavy: scaled(Formulas.defenseRangedRoll(npc, 'heavy')),
  };
}

/** The Wiki's roll: Defence for melee and ranged, Magic for magic; bonuses stab, slash, crush, magic, light, standard, heavy. */
function wikiRolls(defence, magic, [stab, slash, crush, magicBonus, light, standard, heavy], factor = 1) {
  const roll = (level, bonus) => Math.floor((level + 9) * (bonus + 64) * factor);
  return {
    stab: roll(defence, stab), slash: roll(defence, slash), crush: roll(defence, crush), magic: roll(magic, magicBonus),
    light: roll(defence, light), standard: roll(defence, standard), heavy: roll(defence, heavy),
  };
}

function rangedBonuses(npc) {
  return RANGED_TYPES.map((type) => npc.getDefenceBonus(core.BonusManager.DEFENCE_RANGE, type));
}

// Wiki monster pages, 18 November 2026: Defence, Magic, then the defence bonuses.
const CHAMBERS = [
  ['Tekton', 7542, 205, 205, [155, 165, 105, 0, 0, 0, 0]],
  ['Tekton (enraged)', 7543, 205, 205, [280, 290, 180, 0, 0, 0, 0]],
  ['Great Olm, head', 7554, 150, 250, [200, 200, 200, 200, 50, 50, 50]],
  ['Great Olm, left claw', 7555, 175, 175, [50, 50, 50, 200, 200, 200, 200]],
  ['Great Olm, right claw', 7553, 175, 87, [200, 200, 200, 50, 200, 200, 200]],
  ['Vasa Nistirio', 7566, 175, 230, [170, 190, 40, 400, 40, 40, 30]],
  ['Vespula', 7531, 88, 88, [0, 0, 0, 70, 20, 60, 60]],
  ['Abyssal portal', 7533, 176, 176, [0, 0, 0, 60, 140, 140, 110]],
  ['Muttadile (small)', 7562, 138, 1, [-5, 72, 50, 60, 0, 0, 0]],
  ['Muttadile (large)', 7563, 220, 250, [-5, 82, 60, 75, 0, 0, 0]],
  ['Vanguard (melee)', 7527, 160, 150, [150, 150, 150, 20, 400, 400, 400]],
  ['Vanguard (ranged)', 7528, 160, 150, [55, 60, 100, 400, 300, 300, 300]],
  ['Vanguard (magic)', 7529, 160, 150, [315, 340, 400, 110, 50, 50, 50]],
  ['Skeletal Mystic', 7604, 187, 140, [155, 155, 75, 140, 115, 115, 75]],
  ['Lizardman shaman', 7573, 210, 130, [102, 160, 150, 160, -10, 0, 0]],
  ['Ice demon', 7584, 160, 390, [70, 70, 110, 40, 140, 140, 140]],
];
const THEATRE = [
  ['The Maiden of Sugadinti', 8360, 200, 350, [0, 0, 0, 0, 0, 0, 0]],
  ['Pestilent Bloat', 8359, 100, 150, [40, 20, 40, 600, 800, 800, 800]],
  ['Nylocas Vasilias', 8355, 50, 50, [0, 0, 0, 0, 0, 0, 0]],
  ['Sotetseg', 8388, 200, 250, [70, 70, 70, 30, 150, 150, 150]],
  ['Xarpus', 8340, 250, 220, [0, 0, 0, 0, 160, 160, 160]],
  ['Verzik Vitur, phase 1', 8370, 20, 400, [20, 20, 20, 20, 20, 20, 20]],
  ['Verzik Vitur, phase 2', 8372, 200, 400, [100, 60, 100, 70, 250, 250, 250]],
  ['Verzik Vitur, phase 3', 8374, 150, 300, [70, 30, 70, 100, 230, 230, 230]],
];
const TOMBS = [
  ['Akkha', 11790, 80, 100, [60, 120, 120, 10, 60, 60, 60]],
  ['Ba-Ba', 11778, 80, 100, [80, 160, 240, 280, 200, 200, 120]],
  ['Kephri', 11719, 80, 125, [60, 300, 100, 200, 300, 300, 300]],
  ['Zebak', 11730, 70, 100, [160, 160, 260, 200, 110, 110, 110]],
  ["Elidinis' Warden, phase 2", 11753, 100, 190, [70, 70, 70, -30, 70, 70, 70]],
  ["Tumeken's Warden, phase 3", 11762, 150, 150, [40, 40, 20, 20, 20, 20, 20]],
];

test("Chambers of Xeric: a solo raid at 126 combat and 99 Hitpoints defends with the Wiki's levels and bonuses", () => {
  for (const [name, id, defence, magic, bonuses] of CHAMBERS) {
    const npc = new NPC(id, TILE());
    assert.ok(Monsters.apply(npc, SOLO), `${name} is scaled by the raid`);
    assert.deepEqual(rolls(npc), wikiRolls(defence, magic, bonuses), name);
  }
});

test("Theatre of Blood: the bosses defend with the Wiki's levels and bonuses (the raid scales hitpoints only)", () => {
  for (const [name, id, defence, magic, bonuses] of THEATRE) {
    assert.deepEqual(rolls(new NPC(id, TILE())), wikiRolls(defence, magic, bonuses), name);
  }
});

test("Tombs of Amascut: the Wiki's levels and bonuses, the roll 2% higher for every 5 raid levels", () => {
  const { Raid } = require('../plugins/minigames/toa/RaidState.TombsOfAmascut');
  for (const raidLevel of [0, 150, 300, 500]) {
    const raid = Object.assign(Object.create(Raid.prototype), { original: { size: 1 }, settings: { raidLevel } });
    for (const [name, id, defence, magic, bonuses] of TOMBS) {
      const npc = new NPC(id, TILE());
      raid.scale(npc, 0);
      assert.deepEqual(rolls(npc), wikiRolls(defence, magic, bonuses, 1 + raidLevel / 250), `${name} at raid level ${raidLevel}`);
    }
  }
});

test("an NPC's own combat stats carry its ranged defence bonus, and the definition's light and heavy ones stay while it is untouched", () => {
  // The abyssal portal's definition has no stats: all of its defence is the raid's.
  const portal = new NPC(7533, TILE());
  assert.deepEqual(rangedBonuses(portal), [0, 0, 0]);
  Monsters.apply(portal, SOLO);
  assert.deepEqual(rangedBonuses(portal), [140, 140, 110]);
  // Vasa Nistirio's heavy bonus (30) is the definition's; the raid leaves the standard one (40) as it is.
  const vasa = new NPC(7566, TILE());
  Monsters.apply(vasa, SOLO);
  assert.deepEqual(rangedBonuses(vasa), [40, 40, 30]);
  // An override that changes the standard bonus changes all three, unless it names the others.
  const stats = [...vasa.getDefinition().getStats()];
  stats[14] = 75;
  vasa.setCombatOverride({ stats });
  assert.deepEqual(rangedBonuses(vasa), [75, 75, 75]);
  vasa.setCombatOverride({ stats, rangedDefence: { heavy: 60 } });
  assert.deepEqual(rangedBonuses(vasa), [75, 75, 60]);
  vasa.setCombatOverride(null);
  assert.deepEqual(rangedBonuses(vasa), [40, 40, 30]);
});
