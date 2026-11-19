// Run after `yarn build`: node --test tests/spell-sounds.test.cjs
// A combat spell's cast and impact sounds, held to the cache's own names for them (sound gamevals:
// windstrike_cast_and_fire, windstrike_hit, teleportblock_cast, ...). A sound id that the cache
// names for another spell, or for something that is not a spell at all, fails here.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { Gamevals } = require("../dist/game/cache/Gamevals");
const { CombatSpells } = require("../dist/game/content/combat/magic/CombatSpells");
const { MagicCombatMethod } = require("../dist/game/content/combat/method/impl/MagicCombatMethod");

/** The cache's gameval group for sound effects. */
const SOUND_GAMEVALS = 16;
let names;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  names = new Gamevals().namesOf(SOUND_GAMEVALS);
});

const cast = (spell) => names.get(MagicCombatMethod.castSoundFor(spell)?.getId());
const impact = (spell) => names.get(MagicCombatMethod.impactSoundFor(spell)?.getId());

test("the cache names sound effects, and the spell table's ids are among them", () => {
  assert.equal(names.get(220), "windstrike_cast_and_fire");
  assert.equal(names.get(227), "spellfail");
});

test("Tele Block is heard: teleportblock_cast as it is cast, teleportblock_impact as it lands (upstream issue #3584)", () => {
  assert.equal(cast(CombatSpells.TELEBLOCK), "teleportblock_cast");
  assert.equal(impact(CombatSpells.TELEBLOCK), "teleportblock_impact");
});

test("the Arceuus spells cast at a target are heard, each with the cache's sounds for it (upstream issue #3241)", () => {
  const arceuus = {
    GHOSTLY_GRASP: ["ghostly_grasp_cast_and_fire", "ghostly_grasp_hit"],
    SKELETAL_GRASP: ["skeleton_grasp_cast_and_fire", "skeleton_grasp_hit"],
    UNDEAD_GRASP: ["undead_grasp_cast_and_fire", "undead_grasp_hit"],
    INFERIOR_DEMONBANE: ["inferior_demonbane_cast", "inferior_demonbane_hit"],
    SUPERIOR_DEMONBANE: ["superior_demonbane_cast", "superior_demonbane_hit"],
    DARK_DEMONBANE: ["dark_demonbane_cast", "dark_demonbane_hit"],
    DARK_LURE: ["dark_lure_cast_and_fire", "dark_lure_hit"],
  };
  for (const [key, sounds] of Object.entries(arceuus)) {
    assert.deepEqual([cast(CombatSpells[key]), impact(CombatSpells[key])], sounds, key);
  }
});

test("every standard combat spell's sounds are the cache's for that spell", () => {
  const standard = {
    WIND_STRIKE: "windstrike", WATER_STRIKE: "waterstrike", EARTH_STRIKE: "earthstrike", FIRE_STRIKE: "firestrike",
    WIND_BOLT: "windbolt", WATER_BOLT: "waterbolt", EARTH_BOLT: "earthbolt", FIRE_BOLT: "firebolt",
    WIND_BLAST: "windblast", WATER_BLAST: "waterblast", EARTH_BLAST: "earthblast", FIRE_BLAST: "fireblast",
    WIND_WAVE: "windwave", WATER_WAVE: "waterwave", EARTH_WAVE: "earthwave", FIRE_WAVE: "firewave",
    WIND_SURGE: "windsurge", WATER_SURGE: "watersurge", EARTH_SURGE: "earthsurge", FIRE_SURGE: "firesurge",
    CONFUSE: "confuse", WEAKEN: "weaken", CURSE: "curse", CRUMBLE_UNDEAD: "crumble", ENFEEBLE: "enfeeble", ENTANGLE: "entangle",
  };
  for (const [key, name] of Object.entries(standard)) {
    assert.equal(cast(CombatSpells[key]), `${name}_cast_and_fire`, key);
    assert.equal(impact(CombatSpells[key]), `${name}_hit`, key);
  }
  // The few the cache names another way.
  assert.deepEqual([cast(CombatSpells.BIND), impact(CombatSpells.BIND)], ["bind_cast", "bind_impact"]);
  assert.deepEqual([cast(CombatSpells.SNARE), impact(CombatSpells.SNARE)], ["snare_cast_and_fire", "snare_impact"]);
  assert.deepEqual([cast(CombatSpells.STUN), impact(CombatSpells.STUN)], ["stun_cast_and_fire", "stun_impact"]);
  assert.deepEqual([cast(CombatSpells.VULNERABILITY), impact(CombatSpells.VULNERABILITY)], ["vulnerability_cast_and_fire", "vulnerability_impact"]);
  assert.deepEqual([cast(CombatSpells.MAGIC_DART), impact(CombatSpells.MAGIC_DART)], ["magic_dart_fire", "magic_dart_hit"]);
});

test("the Ancient Magicks land with their own impact sounds", () => {
  for (const element of ["SMOKE", "SHADOW", "BLOOD", "ICE"]) {
    for (const tier of ["RUSH", "BURST", "BLITZ", "BARRAGE"]) {
      assert.equal(impact(CombatSpells[`${element}_${tier}`]), `${element.toLowerCase()}_${tier.toLowerCase()}_impact`);
    }
  }
});
