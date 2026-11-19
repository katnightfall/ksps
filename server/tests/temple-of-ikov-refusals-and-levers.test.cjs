// From server/: node --test tests/temple-of-ikov-refusals-and-levers.test.cjs
// Upstream issue #4834, what was left of it: the boots-room stairs and the locked south gate refused
// without a word, and both of the temple's levers had stopped answering Pull (another quest's "Lever"
// handler, registered earlier, returned nothing for levers that were not its own).
// Real ClientConnection clicks, routing, map and every plugin (quest-capture-harness).
const assert = require("node:assert/strict");
const { before, after, test, mock } = require("node:test");
const h = require("./quest-capture-harness.cjs");

const STAGE_STARTED = 10;
const STAIRS = { id: 98, tile: [2650, 9804, 0] }; // down to the boots of lightness
const BRACKET = { id: 86, tile: [2671, 9804, 0] }; // Lever bracket; 87 once the lever is fitted
const FITTED_LEVER = 87;
const SOUTH_GATES = [[90, 2661, 9803], [89, 2662, 9803]];
const TRAPPED_LEVER = { tile: [2665, 9855, 0] };
const ICE_GATE_UNLOCKED = "temple-of-ikov:ice-gate-unlocked";
const TRAP_DOOR_UNLOCKED = "temple-of-ikov:trap-door-unlocked";
const NO_LIGHT = "It's a bit dark down here! You decide not to venture far."; // transcript step OJpSre
const GATE_LOCKED = "The door won't open!"; // transcript step 1ILIvG

before(async () => {
  h.key = "temple_of_ikov";
  const worldConfig = require("../dist/game/definition/WorldDefinition");
  const readConfig = worldConfig.readWorldConfig;
  const config = mock.method(worldConfig, "readWorldConfig", (...args) => {
    const actual = readConfig(...args);
    return { ...actual, plugins: { ...actual.plugins, WorldAdmin: false } };
  });
  try { await h.setup([[2660, 9804], [2665, 9855], [2641, 9764]]); } finally { config.mock.restore(); }
});
after(() => h.teardown());

const I = () => h.core.ItemIdentifiers;
const position = (f) => {
  const at = f.player.getLocation();
  return [at.getX(), at.getY(), at.getZ()];
};
const texts = (f) => f.messages.map((m) => m.text);

function freeTilesAround([x, y, z]) {
  const tiles = [];
  for (let radius = 1; radius <= 3; radius++) {
    for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
      if (!h.core.RegionManager.blocked(new h.core.Location(x + dx, y + dy, z), null)) tiles.push([x + dx, y + dy, z]);
    }
  }
  return tiles;
}

/** An actor on the first free tile from which a real click on the object is not answered "I can't reach that!". */
async function actorAt(t, tile, options, act) {
  for (const stand of freeTilesAround(tile)) {
    const f = h.actor(t, { at: stand, done: [], stage: STAGE_STARTED, ...options });
    f.messages.length = 0;
    await act(f);
    if (texts(f).includes("I can't reach that!")) continue;
    return f;
  }
  assert.fail(`nothing at ${tile} could be reached`);
}

test("the boots-room stairs say why they refuse a player with no light, and take one with a light down", async (t) => {
  const dark = await actorAt(t, STAIRS.tile, {}, async (f) => {
    f.start = position(f);
    await h.clickObject(f, STAIRS.id, STAIRS.tile);
    h.ticks(f, 5);
  });
  assert.ok(texts(dark).includes(NO_LIGHT), JSON.stringify(texts(dark)));
  assert.equal(position(dark)[1] > 9790, true, "still upstairs");

  const lit = await actorAt(t, STAIRS.tile, { items: [I().LIT_TORCH] }, async (f) => {
    await h.clickObject(f, STAIRS.id, STAIRS.tile);
    h.ticks(f, 8);
  });
  assert.equal(texts(lit).includes(NO_LIGHT), false);
  assert.deepEqual(position(lit), [2641, 9764, 0], "the boots room (the landing climb-links.test.cjs fixes)");
});

test("the south gate says it will not open until the fitted lever is pulled, then says nothing", async (t) => {
  for (const [id, x, y] of SOUTH_GATES) {
    const f = await actorAt(t, [x, y, 0], {}, async (actor) => {
      await h.clickObject(actor, id, [x, y]);
      h.ticks(actor, 3);
    });
    assert.ok(texts(f).includes(GATE_LOCKED), `gate ${id}: ${JSON.stringify(texts(f))}`);
    assert.ok(h.core.MapObjects.get(id, new h.core.Location(x, y, 0), null), `gate ${id} still stands shut`);
  }
  // Unlocked, the same click goes on to the ordinary double gate (which swings both leaves, so one click).
  const [id, x, y] = SOUTH_GATES[0];
  const open = await actorAt(t, [x, y, 0], { attributes: { [ICE_GATE_UNLOCKED]: 1 } }, async (actor) => {
    await h.clickObject(actor, id, [x, y]);
    h.ticks(actor, 3);
  });
  assert.equal(texts(open).includes(GATE_LOCKED), false, "unlocked");
});

test("with every plugin loaded, the lever fits the bracket and its Pull unlocks the south gate", async (t) => {
  const f = await actorAt(t, BRACKET.tile, { items: [I().LEVER] }, async (actor) => {
    const slot = actor.player.getInventory().getSlotForItemId(I().LEVER);
    await h.dispatch(actor, { type: "item_on_object", widgetId: 149 << 16, objectId: BRACKET.id, itemId: I().LEVER, slot,
      x: BRACKET.tile[0], y: BRACKET.tile[1] });
    h.ticks(actor, 4);
  });
  assert.equal(f.player.getInventory().getAmount(I().LEVER), 0, "the lever is in the bracket");
  assert.notEqual(f.player.getAttribute(ICE_GATE_UNLOCKED), 1, "fitting alone unlocks nothing");
  await h.clickObject(f, FITTED_LEVER, BRACKET.tile);
  h.ticks(f, 6);
  assert.equal(f.player.getAttribute(ICE_GATE_UNLOCKED), 1, "Pull reached Temple of Ikov");
});

test("with every plugin loaded, the trapped lever is searched and its Pull unlocks the western door", async (t) => {
  const leverId = h.core.ObjectIdentifiers.LEVER_6;
  const f = await actorAt(t, TRAPPED_LEVER.tile, {}, async (actor) => {
    actor.player.getSkillManager().setMaxLevels(h.core.Skill.THIEVING, 42);
    actor.player.getSkillManager().setCurrentLevel(h.core.Skill.THIEVING, 42, false);
    await h.clickObject(actor, leverId, TRAPPED_LEVER.tile, 2); // Search for traps
    h.ticks(actor, 3);
  });
  assert.ok(texts(f).includes("You find a trap on the lever! You disable the trap."), JSON.stringify(texts(f)));
  f.player.getPacketSender().sendInterfaceRemoval();
  await h.clickObject(f, leverId, TRAPPED_LEVER.tile, 1); // Pull
  h.ticks(f, 4);
  assert.equal(f.player.getAttribute(TRAP_DOOR_UNLOCKED), 1, "Pull reached Temple of Ikov");
});
