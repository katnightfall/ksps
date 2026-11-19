// From server/: node --test tests/lunar-diplomacy-ship-symbols-ring.test.cjs
// Upstream issue #5162: the Lady Zay's stairs that asked "Which way would you like to climb?", the jinx
// symbols found on any five cannons, and the lunar ring that the spade's Dig never turned up.
// Real ClientConnection packets, routing, map and plugins (quest-capture-harness).
const assert = require("node:assert/strict");
const { before, after, test, mock } = require("node:test");
const h = require("./quest-capture-harness.cjs");

const STAGE_SYMBOLS = 110;
const STAGE_STAFF_GIVEN = 150;
const SYMBOLS_ATTRIBUTE = "quest.lunar_diplomacy.symbols";

// Cache (scripts/dump-loc.ts 16945,16946,16947,16948): the stairs with no recorded row in loc-teleports.json,
// on the galleon at Pirates' Cove and on its copy at Lunar Isle. [id, x, y, z, plane it leads to]
const UNRECORDED_STAIRS = [
  [16945, 2226, 3792, 1, 2], // cove, lower deck south-east, up
  [16947, 2221, 3792, 2, 1], // cove, main deck south-west, down
  [16946, 2141, 3911, 0, 1],
  [16945, 2138, 3895, 1, 2],
  [16945, 2142, 3895, 1, 2],
  [16947, 2141, 3910, 1, 0],
  [16947, 2137, 3895, 2, 1],
  [16947, 2142, 3895, 2, 1],
];
// Cache: the five objects switched by lunar_quest_symbolpres1-5, each placed once. [key, id, x, y, z, varbit]
const SYMBOLS = [
  ["support", 15587, 2224, 3793, 0, 2431],
  ["cannon", 17015, 2227, 3785, 3, 2432],
  ["crate", 17016, 2226, 3790, 0, 2433],
  ["wallchart", 17017, 2222, 3790, 2, 2434],
  ["chest", 17018, 2223, 3811, 0, 2435],
];
const RING_FLOWERS = [2090, 3877, 0]; // Flowers 1196, the island's south-west corner

before(async () => {
  h.key = "lunar_diplomacy";
  const worldConfig = require("../dist/game/definition/WorldDefinition");
  const readConfig = worldConfig.readWorldConfig;
  const config = mock.method(worldConfig, "readWorldConfig", (...args) => {
    const actual = readConfig(...args);
    return { ...actual, plugins: { ...actual.plugins, WorldAdmin: false } };
  });
  try { await h.setup([[2220, 3800], [2140, 3900], [2090, 3877]]); } finally { config.mock.restore(); }
});
after(() => h.teardown());

const I = () => h.core.ItemIdentifiers;
const position = (f) => {
  const at = f.player.getLocation();
  return [at.getX(), at.getY(), at.getZ()];
};
const texts = (f) => f.messages.map((m) => m.text);
const varbit = (f, id) => f.calls.filter((c) => c.name === "sendVarbit" && c.args[0] === id).at(-1)?.args[1];
const slotOf = (f, id) => f.player.getInventory().getSlotForItemId(id);

/** A free tile the object can be used from: the first one a real click does not answer "I can't reach that!" from. */
function freeTilesAround(x, y, z) {
  const tiles = [];
  for (let radius = 1; radius <= 3; radius++) {
    for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
      if (!h.core.RegionManager.blocked(new h.core.Location(x + dx, y + dy, z), null)) tiles.push([x + dx, y + dy, z]);
    }
  }
  return tiles;
}

test("every stair on the Lady Zay climbs its one way without asking which", async (t) => {
  for (const [id, x, y, z, toZ] of UNRECORDED_STAIRS) {
    let climbed = null;
    for (const stand of freeTilesAround(x, y, z)) {
      const f = h.actor(t, { at: stand, done: [], stage: STAGE_SYMBOLS });
      await h.clickObject(f, id, [x, y]);
      h.ticks(f, 5);
      if (texts(f).includes("I can't reach that!")) continue;
      assert.equal(h.shown(f), null, `stair ${id} at ${x},${y},${z} asks nothing`);
      climbed = position(f);
      break;
    }
    assert.ok(climbed, `stair ${id} at ${x},${y},${z} can be reached`);
    assert.equal(climbed[2], toZ, `stair ${id} at ${x},${y},${z} leads to plane ${toZ}`);
    assert.equal(h.core.RegionManager.blocked(new h.core.Location(...climbed), null), false);
    assert.ok(Math.abs(climbed[0] - x) <= 3 && Math.abs(climbed[1] - y) <= 3, "beside the stair at the other end");
  }
});

async function useLantern(f, objectId, [x, y]) {
  const lantern = I().EMERALD_LANTERN_2;
  await h.dispatch(f, { type: "item_on_object", widgetId: 149 << 16, objectId, itemId: lantern, slot: slotOf(f, lantern), x, y });
  for (let i = 0; i < 15 && !h.shown(f); i++) h.tick(f);
}

/** A real use of the lit lantern from the first tile the object is reachable from; returns the actor. */
async function lanternOn(t, objectId, [x, y, z], attributes = {}, stage = STAGE_SYMBOLS) {
  for (const stand of freeTilesAround(x, y, z)) {
    const f = h.actor(t, { at: stand, done: [], stage, attributes, items: [I().EMERALD_LANTERN_2] });
    f.calls.length = f.messages.length = 0;
    await useLantern(f, objectId, [x, y]);
    if (texts(f).includes("I can't reach that!")) continue;
    return f;
  }
  assert.fail(`object ${objectId} at ${x},${y},${z} can be reached`);
}

test("the lantern finds a symbol only on the five objects that carry one", async (t) => {
  // An ordinary cannon on the top deck (cache: Cannon 16939 at Pirates' Cove), not the one with the symbol.
  const plain = [];
  for (let x = 2215; x <= 2232 && !plain.length; x++) for (let y = 3782; y <= 3815 && !plain.length; y++) {
    for (const z of [1, 2, 3]) {
      const hit = h.core.MapObjects.getObjectsAt(new h.core.Location(x, y, z), null).find((o) => [16938, 16939].includes(o.getId()));
      if (hit) { plain.push([hit.getId(), x, y, z]); break; }
    }
  }
  assert.equal(plain.length, 1, "the ship has an ordinary cannon");
  const [plainId, px, py, pz] = plain[0];
  const idle = await lanternOn(t, plainId, [px, py, pz]);
  assert.equal(h.shown(idle), null, "no symbol on an ordinary cannon");
  assert.ok(texts(idle).includes("Nothing interesting happens."));
  assert.equal(idle.player.getAttribute(SYMBOLS_ATTRIBUTE) ?? null, null);
  assert.equal(h.stage(idle), STAGE_SYMBOLS);

  for (const [key, id, x, y, z, bit] of SYMBOLS) {
    const f = await lanternOn(t, id, [x, y, z]);
    assert.equal(h.shown(f)?.text, "Ah-ha! I've found one!", `${key}: the symbol is found`);
    assert.equal(varbit(f, bit), 1, `${key}: the object shows its symbol`);
    const said = await h.converse(f, async () => {}, ["Rub away!"]);
    assert.ok(said.some((line) => line.includes("One down, four more to go!")), JSON.stringify(said));
    assert.deepEqual(f.player.getAttribute(SYMBOLS_ATTRIBUTE), [key]);
    assert.equal(varbit(f, bit), 2, `${key}: rubbed out`);
    assert.equal(h.stage(f), STAGE_SYMBOLS + 2);
    for (const [, , , , , other] of SYMBOLS) if (other !== bit) assert.equal(varbit(f, other), 0);

    // The same object again has nothing left on it.
    f.messages.length = 0;
    await useLantern(f, id, [x, y]);
    assert.equal(h.shown(f), null);
    assert.equal(h.stage(f), STAGE_SYMBOLS + 2);
  }
});

test("the fifth symbol finishes the search, and refusing to rub one out hides it again", async (t) => {
  const [key, id, x, y, z, bit] = SYMBOLS[4];
  const four = SYMBOLS.slice(0, 4).map(([name]) => name);
  const f = await lanternOn(t, id, [x, y, z], { [SYMBOLS_ATTRIBUTE]: four }, STAGE_SYMBOLS + 8);
  await h.converse(f, async () => {}, ["I'm no cleaner!"]);
  assert.equal(varbit(f, bit), 0, "left alone, the symbol is hidden again");
  assert.deepEqual(f.player.getAttribute(SYMBOLS_ATTRIBUTE), four);
  assert.equal(h.stage(f), STAGE_SYMBOLS + 8);

  await useLantern(f, id, [x, y]);
  const said = await h.converse(f, async () => {}, ["Rub away!"]);
  assert.ok(said.some((line) => line.includes("That's it, I've removed all the symbols")), JSON.stringify(said));
  assert.deepEqual(f.player.getAttribute(SYMBOLS_ATTRIBUTE), [...four, key]);
  assert.equal(h.stage(f), STAGE_SYMBOLS + 10);
  for (const [, , , , , every] of SYMBOLS) assert.equal(varbit(f, every), 2);
});

test("a save that counted three cannons keeps its three symbols and has two left to find", async (t) => {
  const legacy = ["16938@2227,3785", "16939@2221,3785", "16939@2221,3800"];
  const f = h.actor(t, { at: [2224, 3800, 2], done: [], stage: STAGE_SYMBOLS + 6, attributes: { [SYMBOLS_ATTRIBUTE]: legacy } });
  f.calls.length = 0;
  h.PM.emitPlayerLogin({ player: f.player, username: f.player.getUsername() });
  // The cannon's own symbol, and the first two not yet found (support, crate) for the other two.
  assert.deepEqual(SYMBOLS.map(([, , , , , bit]) => varbit(f, bit)), [2, 2, 2, 0, 0]);
  assert.equal(h.stage(f), STAGE_SYMBOLS + 6);
});

async function dig(f) {
  const spade = I().SPADE;
  await h.dispatch(f, { type: "inventory_action", slot: slotOf(f, spade), itemId: spade, widgetId: 149 << 16, option: "Dig" });
  h.ticks(f, 3);
}

test("the spade's Dig at the south-west blue flowers turns up the lunar ring", async (t) => {
  const f = h.actor(t, { at: RING_FLOWERS, done: [], stage: STAGE_STAFF_GIVEN, items: [I().SPADE] });
  await dig(f);
  assert.equal(f.player.getInventory().getAmount(I().LUNAR_RING), 1);
  assert.ok(texts(f).includes("You've found a lunar ring!"), JSON.stringify(texts(f)));
  assert.equal(texts(f).includes("Nothing interesting happens."), false);
  // A second dig does not find a second ring.
  await dig(f);
  assert.equal(f.player.getInventory().getAmount(I().LUNAR_RING), 1);
});

test("no room: the ring stays in the dirt and can be dug up once there is space", async (t) => {
  const f = h.actor(t, { at: RING_FLOWERS, done: [], stage: STAGE_STAFF_GIVEN, items: [I().SPADE] });
  const filler = I().BIG_BONES;
  while (f.player.getInventory().getFreeSlots() > 0) f.player.getInventory().add(new h.core.Item(filler, 1), false);
  await dig(f);
  assert.equal(f.player.getInventory().getAmount(I().LUNAR_RING), 0);
  assert.ok(texts(f).includes("There appears to be something in the dirt, but you have no space to hold it."), JSON.stringify(texts(f)));
  f.player.getInventory().deleteNumber(filler, 1);
  await dig(f);
  assert.equal(f.player.getInventory().getAmount(I().LUNAR_RING), 1);
});

test("digging elsewhere on the island, or before the clothes are asked for, finds nothing", async (t) => {
  const far = h.actor(t, { at: [RING_FLOWERS[0] + 4, RING_FLOWERS[1], 0], done: [], stage: STAGE_STAFF_GIVEN, items: [I().SPADE] });
  await dig(far);
  assert.equal(far.player.getInventory().getAmount(I().LUNAR_RING), 0);
  assert.ok(texts(far).includes("Nothing interesting happens."));

  const early = h.actor(t, { at: RING_FLOWERS, done: [], stage: STAGE_SYMBOLS, items: [I().SPADE] });
  await dig(early);
  assert.equal(early.player.getInventory().getAmount(I().LUNAR_RING), 0);
});
