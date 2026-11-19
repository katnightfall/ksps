// node --test tests/area-index-lookups.test.cjs
//
// Finding the area a tile is in goes through an index of every area's boundaries. Each lookup
// (every player and NPC that moves, every tick) used to count all the areas' boundaries again to
// see whether the index was stale: on a full world 2 s of every five minutes, 128 ms in one tick.
// The index is now kept while the area list is the same list, and is rebuilt when areas are added
// or the list is replaced; lookups give the same areas as before.
const assert = require("node:assert/strict");
const { test } = require("node:test");

require("../dist/Server").Server.installProductionPathResolver();
const { AreaManager } = require("../dist/game/model/areas/AreaManager");
const { Area } = require("../dist/game/model/areas/Area");
const { Boundary } = require("../dist/game/model/Boundary");
const { Location } = require("../dist/game/model/Location");

class CountedArea extends Area {
  constructor(name, boundaries) {
    super(boundaries);
    this.name = name;
    this.asked = 0;
  }
  getName() { return this.name; }
  getBoundaries() { this.asked++; return super.getBoundaries(); }
}

test("area lookups do not count every area's boundaries again, and still see new areas", (t) => {
  const saved = { areas: AreaManager.areas, index: AreaManager.areaSearchIndex };
  t.after(() => { AreaManager.areas = saved.areas; AreaManager.areaSearchIndex = saved.index; });

  // Forty areas far from where we look, and one around it.
  const far = Array.from({ length: 40 }, (_, i) => new CountedArea(`far${i}`, [new Boundary(1000 + i * 70, 1010 + i * 70, 1000, 1010, 0)]));
  const here = new CountedArea("here", [new Boundary(3200, 3210, 3200, 3210, 0)]);
  AreaManager.areas = [...far, here];
  AreaManager.areaSearchIndex = null;

  for (let i = 0; i < 100; i++) {
    assert.equal(AreaManager.get(new Location(3205, 3205, 0)), here);
    assert.equal(AreaManager.get(new Location(3300, 3300, 0)), null);
  }
  const askedFar = far.reduce((sum, area) => sum + area.asked, 0);
  assert.ok(askedFar <= far.length * 2, `200 lookups asked the far areas for their boundaries ${askedFar} times (once each to build the index)`);

  // An area added to the list is found by the next lookup.
  const added = new CountedArea("added", [new Boundary(3300, 3305, 3300, 3305, 0)]);
  AreaManager.areas.push(added);
  assert.equal(AreaManager.get(new Location(3301, 3301, 0)), added);
  assert.equal(AreaManager.get(new Location(3205, 3205, 0)), here);

  // So is one in a list that replaces the old one, though it has as many areas and boundaries.
  const swapped = new CountedArea("swapped", [new Boundary(3400, 3405, 3400, 3405, 0)]);
  AreaManager.areas = [...far, here, swapped];
  assert.equal(AreaManager.get(new Location(3401, 3401, 0)), swapped);
  assert.equal(AreaManager.get(new Location(3301, 3301, 0)), null);
});
