// Ours. Run after `yarn build`: node --test tests/varrock-pigeon.test.cjs
// The pigeon on the Varrock rooftop course's clothes line says "Squawk!" as the player jumps
// past it. Only its sound was there; the words are said by an NPC nobody sees, placed on the
// pigeon's tile for a few ticks (plugins/skills/agility/ObstacleRunner.Agility.js sceneryVoice,
// the `npcSay` step; plugins/skills/agility/courses/VarrockRooftop.Agility.js).
const assert = require("node:assert/strict");
const { test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Location } = require("../dist/game/model/Location");
const { ObjectIds } = require("../dist/util/IdEnums");
const Runner = require("../plugins/skills/agility/ObstacleRunner.Agility");
const Varrock = require("../plugins/skills/agility/courses/VarrockRooftop.Agility");

/** Runs submitted tasks on demand instead of on the game loop (as tests/agility.test.cjs does). */
const tasks = [];
let ticks = 0;
const taskManager = {
  submit(task) {
    if (task.isRunning()) return;
    task.setRunning(true);
    if (task.isImmediate()) task.execute();
    tasks.push(task);
  },
};
function tick() {
  ticks++;
  for (const task of tasks.splice(0)) if (task.tick()) tasks.push(task);
}

const world = { spawned: [], removed: [], said: [], refuse: false };
const core = PluginManager.getCoreApi();
const heard = [];
const playAreaSound = core.Sounds.playAreaSound;
core.Sounds.playAreaSound = (sound) => { heard.push({ ...sound, tick: ticks }); };
Runner.init({
  core,
  getTaskManager: () => taskManager,
  spawnNpc(definition) {
    if (world.refuse) return null;
    const npc = { definition, forceChat: (line) => world.said.push({ line, tick: ticks, npc }) };
    world.spawned.push({ npc, tick: ticks });
    return npc;
  },
  removeNpc(npc) { world.removed.push({ npc, tick: ticks }); },
});

/** A player that takes whatever an obstacle does to it. */
function looseJumper(x, y, z) {
  let at = new Location(x, y, z);
  const attributes = new Map();
  const anything = new Proxy(function () {}, { get: (_, name) => (name === Symbol.toPrimitive ? () => 0 : anything), apply: () => anything });
  const known = {
    isRegistered: () => true,
    getHitpoints: () => 50,
    getLocation: () => at,
    moveTo: (to) => { at = to; return player; },
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => { attributes.set(key, value); return player; },
  };
  const player = new Proxy(known, { get: (target, name) => (name in target ? target[name] : anything) });
  return player;
}

const clothesLine = Varrock.obstacles.find((obstacle) => obstacle.object === ObjectIds.CLOTHES_LINE);
const PIGEON = [3211, 3414, 3];

test("the clothes line's steps have the pigeon speak where and when it is heard", () => {
  const steps = clothesLine.steps;
  const sound = steps.findIndex((step) => step.areaSound != null);
  assert.ok(sound >= 0);
  assert.deepEqual(steps[sound].at, PIGEON, "the sound comes from the pigeon's tile");
  const words = steps[sound + 1];
  assert.equal(words.npcSay, "Squawk!", "the words go with the sound: no tick between them");
  assert.deepEqual(words.at, PIGEON);
  assert.ok(Number.isInteger(words.npc) && words.npc > 0);
  assert.equal(steps.filter((step) => step.npcSay).length, 1);
  assert.equal((clothesLine.fail.steps() ?? []).some((step) => step.npcSay), false, "a player who falls at the first jump never reaches it");
});

test("crossing the line: an unseen NPC stands on the pigeon's tile, says Squawk! a tick later and is gone again", () => {
  const before = ticks;
  const player = looseJumper(3214, 3414, 3);
  const steps = typeof clothesLine.steps === "function" ? clothesLine.steps({ player }) : clothesLine.steps;
  const lengthBefore = steps.length;
  Runner.run({ player, object: null }, steps);
  for (let i = 0; i < 20; i++) tick();

  assert.equal(world.spawned.length, 1);
  const { npc, tick: arrived } = world.spawned[0];
  assert.deepEqual([npc.definition.x, npc.definition.y, npc.definition.z], PIGEON);
  assert.equal(npc.definition.wanderRadius, 0, "it stays put");
  assert.equal(heard.length, 1);
  assert.equal(heard[0].tick, arrived, "it arrives with the sound");
  assert.deepEqual(world.said.map((said) => [said.line, said.tick - arrived, said.npc === npc]), [["Squawk!", 1, true]],
    "the words the tick after, when every client near has the NPC");
  assert.deepEqual(world.removed.map((gone) => [gone.npc === npc, gone.tick - arrived]), [[true, 6]], "and it does not stay on the roof");
  assert.ok(arrived - before >= 1 && arrived - before <= 4, "halfway along the line");
  assert.equal(steps.length, lengthBefore, "the course's own list is not changed by a run");
  // The next player along gets a pigeon of their own.
  Runner.run({ player: looseJumper(3214, 3414, 3), object: null }, steps);
  for (let i = 0; i < 20; i++) tick();
  assert.equal(world.spawned.length, 2);
  assert.equal(world.removed.length, 2);
  assert.equal(world.said.length, 2);
});

test("with no NPC to be had (the world is full), the obstacle goes on without the words", () => {
  world.refuse = true;
  try {
    const said = world.said.length;
    assert.equal(Runner.sceneryVoice({ npcSay: "Squawk!", npc: 16668, at: PIGEON }), null);
    const player = looseJumper(3214, 3414, 3);
    const task = Runner.run({ player, object: null }, clothesLine.steps);
    for (let i = 0; i < 20; i++) tick();
    assert.equal(world.said.length, said);
    assert.equal(task.isRunning(), false, "the crossing still finished");
  } finally {
    world.refuse = false;
    core.Sounds.playAreaSound = playAreaSound;
  }
});
