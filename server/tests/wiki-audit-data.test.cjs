// Run: node --test tests/wiki-audit-data.test.cjs
// Ours: values corrected in the OSRS Wiki audit, pinned so a later data edit can't undo them.
// Each names the Wiki page it follows. Experience is the base value, before the world's multiplier.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const furniture = require("../plugins/skills/construction/data/furniture.json");
const fletching = require("../plugins/skills/data/fletching.json");
const bones = require("../plugins/skills/data/bones.json");

test("Construction experience follows each piece's Wiki page and its room's table", () => {
  const xp = (key) => furniture.find((entry) => entry.key === key).experience;
  // Costume Room: each tier is an upgrade of the one below, paid for its own materials only.
  assert.equal(xp("TEAK_ARMOUR_CASE"), 270, "3 teak planks");
  assert.equal(xp("MAHOGANY_CAPE_RACK"), 560, "4 mahogany planks");
  assert.equal(xp("GILDED_CAPE_RACK"), 860, "4 mahogany planks and a gold leaf");
  assert.equal(xp("MARBLE_CAPE_RACK"), 500, "a marble block");
  assert.equal(xp("MAGICAL_CAPE_RACK"), 1000, "a magic stone");
  assert.equal(xp("CARVED_TEAK_MAGIC_WARDROBE"), 540, "6 teak planks");
  assert.equal(xp("GILDED_MAGIC_WARDROBE"), 860, "4 mahogany planks and a gold leaf");
  assert.equal(xp("MARBLE_MAGIC_WARDROBE"), 500, "a marble block");
  // Throne Room, Bedroom, Study, Chapel, Achievement Gallery, Menagerie, Superior Garden.
  assert.equal(xp("GILDED_THRONE"), 2600);
  assert.equal(xp("SKELETON_THRONE"), 7003.5);
  assert.equal(xp("GILDED_FOUR_POSTER_BED"), 1330);
  assert.equal(xp("MAHOGANY_TELESCOPE"), 281);
  assert.equal(xp("STEEL_TORCHES"), 40);
  assert.equal(xp("LUNAR_ALTAR"), 1957);
  assert.equal(xp("DESERT_HABITAT"), 181);
  assert.equal(xp("ZEN_THEME"), 474);
});

test("Fletching: stringing a willow shortbow or a maple longbow gives a tenth less than cutting it (Wiki, Fletching)", () => {
  const strung = (output) => fletching.recipes.find((recipe) => recipe.group === "stringing" && recipe.output === output).xp;
  assert.equal(strung("WILLOW_SHORTBOW"), 33.2);
  assert.equal(strung("MAPLE_LONGBOW"), 58.2);
});

test("Prayer: ninja and zombie monkey bones (Wiki, Remains and each bone's page), bonemeal four times that", () => {
  const bury = (obj) => bones.bones.find((bone) => bone.obj === obj).xp;
  const worship = (obj) => bones.bonemeal.find((meal) => meal.obj === obj).xp;
  assert.equal(bury("mm_small_ninja_monkey_bones"), 16);
  assert.equal(bury("mm_medium_ninja_monkey_bones"), 18);
  assert.equal(bury("mm_large_zombie_monkey_bones"), 5);
  assert.equal(worship("pot_bonemeal_small_ninja_monkey"), 64);
  assert.equal(worship("pot_bonemeal_medium_ninja_monkey"), 72);
  assert.equal(worship("pot_bonemeal_large_zombie_monkey"), 20);
  for (const bone of bones.bones) {
    if (!bone.obj.startsWith("mm_") || !bone.bonemeal) continue;
    assert.equal(worship(bone.bonemeal), bone.xp * 4, `${bone.obj} bonemeal`);
  }
});

test("High and Low Alchemy: bird nests with an egg and the stardust packs pay 60% and 40% of their value (Wiki: each item's page)", () => {
  const overrides = require("../data/definitions/item-overrides.json");
  for (const id of [5070, 5071, 5072]) assert.deepEqual(overrides[id], { highAlch: 271, lowAlch: 181 }, `bird nest ${id}, value 453`);
  for (const id of [25533, 25535]) assert.deepEqual(overrides[id], { highAlch: 90, lowAlch: 60 }, `stardust pack ${id}, value 150`);
  // The Wiki marks these versions "alchable = No": they stay unalchable (no override).
  for (const id of [5013, 20499, 20501, 19812, 26392, 28922, 28826, 33524, 31992]) assert.equal(overrides[id], undefined, `item ${id}`);
});

test("Rapid Burst (Rosewood blowpipe) has no accuracy or damage modifier: two darts for 25% energy (Wiki: Rosewood blowpipe, Changes of 22 July 2026; Special attacks)", () => {
  require("../dist/Server").Server.installProductionPathResolver();
  const core = require("../dist/plugins/PluginManager").PluginManager.getCoreApi();
  let special = null;
  require("../plugins/combat/specials/RosewoodBlowpipe.SpecialAttack")({ core, registerCombatSpecial: (config) => { special = config; } });
  assert.equal(special.drainAmount, 25);
  assert.equal(special.accuracyMultiplier, 1);
  assert.equal(special.strengthMultiplier, 1);
  assert.equal(special.traits.hitCount, 2);
  assert.equal(special.traits.accuracyMultiplier, 1);
  assert.equal(special.traits.damageMultiplier, 1);
});

test("Cooking: roqed fish stop burning at 95 (Wiki: Roqed fish (5); Cooking/Burn level, Raids food)", () => {
  const cooking = require("../plugins/skills/data/cooking.json");
  const food = (name) => cooking.cookables.find((entry) => entry.name === name);
  assert.equal(food("roqed fish").level, 75);
  assert.equal(food("roqed fish").stopBurn, 95);
  // Kyren fish follow their page's chart (163 to 255 out of 256), which first reaches 256 at 99: the page's "99".
  assert.deepEqual(food("kyren fish").chance.fire, [163, 255]);
});

test("Agility: the Moss Giant Island ropeswings give 3 experience each way (Wiki: Ropeswing (Brimhaven); Agility shortcuts)", () => {
  const { shortcuts } = require("../plugins/skills/data/agility-shortcuts.json");
  const swings = shortcuts.filter((entry) => entry.name.startsWith("Ropeswing (Moss Giant Island"));
  assert.equal(swings.length, 2);
  for (const swing of swings) {
    assert.equal(swing.level, 10);
    assert.equal(swing.xp, 3);
  }
});
