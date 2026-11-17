// Ours. Run after `yarn build`: node --test tests/mobile-list-walk.test.cjs
// A walk of the world's NPC or player list (MobileList) visits the live entries in slot order
// and stops at the highest slot in use, instead of every slot the list could hold; and it makes
// no object per entry (upstream issue #6036: that walk was half of the server's garbage).
const assert = require("node:assert/strict");
const { test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { MobileList } = require("../dist/game/entity/impl/MobileList");

function mobile(name) {
  let index = -1;
  let registered = false;
  return {
    name, onAdd() {}, onRemove() {},
    isRegistered: () => registered, setRegistered: (value) => { registered = value; },
    getIndex: () => index, setIndex: (value) => { index = value; },
  };
}
const names = (list) => [...list].map((entry) => entry.name);

test("the live entries, in slot order, by every way of walking the list", () => {
  const list = new MobileList(65535);
  const made = ["a", "b", "c", "d", "e"].map(mobile);
  for (const entry of made) assert.equal(list.add(entry), true);
  assert.deepEqual(names(list), ["a", "b", "c", "d", "e"]);
  assert.equal(list.highestSlot(), 5, "five slots to look at, not 65,536");
  list.removes(made[1]);
  list.removes(made[3]);
  assert.deepEqual(names(list), ["a", "c", "e"]);
  const seen = [];
  list.forEach((entry) => seen.push(entry.name));
  assert.deepEqual(seen, ["a", "c", "e"]);
  assert.equal(list.search((entry) => entry.name === "e"), made[4]);
  assert.equal(list.search((entry) => entry.name === "b"), null, "removed");
  assert.deepEqual(Array.from(list, (entry) => entry.name), ["a", "c", "e"]);
  const [first, ...rest] = list;
  assert.deepEqual([first.name, rest.map((entry) => entry.name)], ["a", ["c", "e"]]);
  assert.equal(list.sizeReturn(), 3);
});

test("the walk's end follows the highest slot in use, down as well as up", () => {
  const list = new MobileList(1000);
  const made = Array.from({ length: 10 }, (_, n) => mobile(`n${n}`));
  for (const entry of made) list.add(entry);
  assert.equal(list.highestSlot(), 10);
  list.removes(made[9]);
  list.removes(made[8]);
  assert.equal(list.highestSlot(), 8);
  list.removes(made[3]);
  assert.equal(list.highestSlot(), 8, "a gap below the top changes nothing");
  // The lowest free slot is handed out first: the gap is filled before the list grows.
  const late = mobile("late");
  list.add(late);
  assert.equal(late.getIndex(), 4);
  assert.equal(list.highestSlot(), 8);
  for (const entry of [...list]) list.removes(entry);
  assert.equal(list.highestSlot(), 0);
  assert.deepEqual(names(list), []);
  list.add(mobile("again"));
  assert.deepEqual(names(list), ["again"]);
});

test("entries added or removed during a walk: a later slot is still visited, a removed one is skipped", () => {
  const list = new MobileList(1000);
  const made = ["a", "b", "c"].map(mobile);
  for (const entry of made) list.add(entry);
  const seen = [];
  for (const entry of list) {
    seen.push(entry.name);
    if (entry.name === "a") {
      list.removes(made[1]);
      list.add(mobile("d"));  // takes b's slot, 2: still ahead
      list.add(mobile("e"));  // slot 4: beyond where the list ended when the walk began
    }
  }
  assert.deepEqual(seen, ["a", "d", "c", "e"]);
});

test("a walk of a big, mostly empty list is quick and makes next to no garbage", () => {
  const list = new MobileList(65535);
  for (let n = 0; n < 4000; n++) list.add(mobile(`npc${n}`));
  let count = 0;
  for (let round = 0; round < 50; round++) for (const entry of list) if (entry) count++;  // warm up
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  const started = process.hrtime.bigint();
  for (let round = 0; round < 500; round++) for (const entry of list) if (entry) count++;
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const grown = process.memoryUsage().heapUsed - before;
  assert.equal(count, 550 * 4000);
  // The generator this replaces made an object per entry: 2,000,000 here, some 60 MB or more.
  assert.ok(grown < 8 * 1024 * 1024, `the heap grew by ${Math.round(grown / 1024)} KB over 2,000,000 steps`);
  assert.ok(ms < 2000, `500 walks took ${ms.toFixed(0)} ms`);
});
