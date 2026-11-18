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
