// Run after yarn build: node --test tests/league-area-wiki-points.test.cjs
// Upstream issue #5386 (regional locked tiles). The league areas' map is 64-tile squares drawn by
// hand; the OSRS Wiki tags every NPC, scenery and item-spawn location with its league region
// (the Locline bucket). tests/fixtures/league-area-wiki-points.json keeps the Wiki's points for
// the squares that disagreed with it: dungeons that followed the wrong surface square, squares
// two areas share, and Catherby east of the bank, which belonged to Asgarnia.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const fixture = require("./fixtures/league-area-wiki-points.json");

const MISTHALIN = 1, ASGARNIA = 3, KANDARIN = 4, MORYTANIA = 5, KOUREND = 20, VARLAMORE = 21;
// The Wiki's Demonic Pacts tags; the map itself is the same for every league but for its overrides.
const LEAGUE = 6;
let Regions;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  require("../plugins/modes/leagueareas/Common.LeagueAreaUnlocks").init({ core: PluginManager.getCoreApi() });
  Regions = require("../plugins/modes/leagueareas/Regions.LeagueAreaUnlocks");
});

const contradicted = (page, x, y) => fixture.contradicted.some(([name, px, py]) => name === page && px === x && py === y);

test("the squares moved for the Wiki's location data now give every tagged point its area", () => {
  // The Salve's two squares are split by the Wiki's own outline of Misthalin, checked below.
  const split = new Set(["53,54"]);
  let points = 0;
  for (const [square, list] of Object.entries(fixture.squares)) {
    assert.ok(list.length > 0, `the fixture has points for ${square}`);
    if (split.has(square)) continue;
    for (const [page, x, y, area] of list) {
      if (contradicted(page, x, y)) continue;
      assert.equal(`${x >> 6},${y >> 6}`, square);
      assert.equal(Regions.areaAt(LEAGUE, x, y), area, `${page} at ${x},${y} (square ${square})`);
      points++;
    }
  }
  assert.ok(points > 700, `${points} points checked`);
});

test("the River Salve's squares follow the Wiki's outline of Misthalin", () => {
  const list = fixture.squares["53,54"];
  const wrong = list.filter(([, x, y, area]) => Regions.areaAt(LEAGUE, x, y) !== area);
  // Four Morytania-tagged points lie inside the Wiki's own outline of Misthalin (it contradicts itself there).
  assert.deepEqual(wrong.map(([page, x, y]) => `${page}@${x},${y}`).sort(),
    ["Bucket@3414,3493", "Rotting log@3405,3456", "Tall Reeds@3424,3483", "Tall Reeds@3425,3480"]);
  assert.equal(Regions.areaAt(5, 3410, 3485), MISTHALIN, "Paterdomus");
  assert.equal(Regions.areaAt(5, 3440, 3470), MORYTANIA, "the Salve's east bank");
  assert.equal(Regions.areaAt(5, 3441, 3413), MORYTANIA, "Mort Myre's north-west (swamp tar)");
  assert.equal(Regions.areaAt(5, 3396, 3410), MISTHALIN, "the Salve's west bank, south of the temple");
});

test("Catherby east of x 2816 is Kandarin's, White Wolf Mountain above it Asgarnia's", () => {
  for (const league of [4, 5, 6]) {
    for (const [name, x, y, area] of [
      ["the tile the report was stopped at", 2815, 3436, KANDARIN], ["the next one east", 2816, 3436, KANDARIN],
      ["Harry", 2834, 3445, KANDARIN], ["Harry's Fishing Shop's north-east corner", 2837, 3448, KANDARIN],
      ["Hickton's shop", 2822, 3442, KANDARIN], ["a beach fishing spot", 2853, 3423, KANDARIN],
      ["the fruit tree patch's gardener", 2861, 3432, KANDARIN], ["the farm shop north of town", 2820, 3463, KANDARIN],
      ["a white wolf by the shop", 2842, 3450, ASGARNIA], ["a white wolf above the beach", 2870, 3438, ASGARNIA],
      ["a white wolf on the mountain", 2847, 3474, ASGARNIA], ["the ice giants", 2817, 3514, ASGARNIA],
      ["Catherby bank", 2809, 3440, KANDARIN], ["Taverley", 2895, 3440, ASGARNIA],
    ]) assert.equal(Regions.areaAt(league, x, y), area, `league ${league}: ${name} (${x}, ${y})`);
  }
});

test("each league's own rules still hold where the map changed", () => {
  assert.equal(Regions.areaAt(4, 1200, 3350), KOUREND, "Trailblazer Reloaded: the Stranglewood counts as Kourend");
  assert.equal(Regions.areaAt(4, 1150, 3420), KOUREND, "its north too (Vardorvis)");
  assert.equal(Regions.areaAt(5, 1150, 3420), VARLAMORE, "Raging Echoes: Varlamore");
  assert.equal(Regions.areaAt(6, 1150, 3420), VARLAMORE, "Demonic Pacts: Varlamore");
  for (const league of [4, 5, 6]) {
    assert.equal(Regions.areaAt(league, 1331, 3433), VARLAMORE, `league ${league}: Varlamore's north (black bears)`);
    assert.equal(Regions.areaAt(league, 1450, 3420), KOUREND, `league ${league}: the Kebos Lowlands beside it`);
    assert.equal(Regions.areaAt(league, 2480, 5100), 2, `league ${league}: Mor Ul Rek stays Karamja's`);
    assert.equal(Regions.areaAt(league, 2700, 9500), 2, `league ${league}: the Brimhaven Dungeon stays Karamja's`);
    assert.equal(Regions.areaAt(league, 2420, 9700), 7, `league ${league}: the Underground Pass stays Tirannwn's`);
    assert.equal(Regions.areaAt(league, 2340, 3690), KANDARIN, `league ${league}: Piscatoris stays Kandarin's`);
  }
});
