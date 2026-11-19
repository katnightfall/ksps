// Run after yarn build: node --test tests/hunter-tracking-feldip.test.cjs
// Upstream issue #6220 ("searching a tracking bush does nothing for Feldip weasels") could not be
// reproduced; this keeps what was checked. Whole Feldip weasel hunts from both burrows, by real
// object clicks (the packet listener, the map's own objects, routing and collision): every search
// on an active trail answers, each hunt ends at a bush and the noose wand takes the fur there.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, afterEach, test } = require("node:test");

require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { ObjectActionPacketListener } = require("../dist/net/packet/impl/ObjectActionPacketListener");
const C = require("../plugins/skills/hunter/Context.Hunter");
const { H } = C;
const Runtime = require("../plugins/skills/hunter/Runtime.Hunter");
const Tracking = require("../plugins/skills/hunter/Tracking.Hunter");

const BURROWS = [[2525, 2889], [2554, 2882]];
const HUNTS_PER_BURROW = 20;
const saved = {};
let core, index = 9700;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  core = PluginManager.getCoreApi();
  core.ObjectDefinition.init();
  core.RegionManager.init();
  for (const [x, y] of BURROWS) core.RegionManager.loadMapFiles(x, y);
  H.core = core;
  H.data = require("../plugins/skills/hunter/Data.Hunter").build(core);
  H.api = { emitCustomEvent() {} };
  H.tick = 0;
  Tracking.initialize();
  saved.named = PluginManager.objectHooksByName;
  PluginManager.objectHooksByName = new Map();
  // As Hunter.plugin.js wires the Feldip trail's three objects.
  const api = PluginManager.createApi("HunterTrackingFeldipTest");
  for (const name of ["Burrow", "Bush", "Jungle plant"]) {
    api.onObjectInteraction(name, { Inspect: Runtime.inspect, Search: Runtime.inspect, Attack: Runtime.attack });
  }
});

afterEach(() => {
  for (const player of [...H.players]) Tracking.clear({ player });
  H.actions.clear(); H.players.clear();
});

test.after(() => { PluginManager.objectHooksByName = saved.named; });

function hunter(x, y) {
  const player = new Player(null, new core.Location(x, y, 0));
  player.setIndex(index++);
  player.setUsername("weasel" + player.getIndex());
  player.setRegistered(true);
  player.setNeedsPlacement(false);
  player.varbits = [];
  player.messages = [];
  player.getPacketSender = () => new Proxy({}, {
    get: (_, key) => (key === "sendVarbit" ? (id, value) => player.varbits.push([id, value]) : () => {}),
  });
  player.sendMessage = (text) => player.messages.push(text);
  player.getSkillManager().setMaxLevels(core.Skill.HUNTER, 7, false);
  player.getSkillManager().setCurrentLevel(core.Skill.HUNTER, 7, false);
  player.getSkillManager().addExperiences = () => {};
  player.getInventory().add(new core.Item(core.ItemIdentifiers.NOOSE_WAND, 1));
  return player;
}

/** Clicks the map's own object on a tile by its option, walks there and lets the action run. */
function click(player, [x, y], option) {
  const object = core.MapObjects.getObjectsAt(new core.Location(x, y, 0), null)
    .find((candidate) => candidate.getLocation().getX() === x && candidate.getLocation().getY() === y &&
      (candidate.getDefinition().getInteractions() ?? []).includes(option));
  assert.ok(object, `the map has an object offering ${option} at ${x},${y}`);
  const from = player.messages.length;
  new ObjectActionPacketListener().executeAction(
    player, object.getId(), x, y, object.getDefinition().getInteractions().indexOf(option) + 1);
  for (let tick = 0; tick < 40; tick++) {
    core.World.processCycle = (core.World.processCycle + 1) & 0x7fffffff;
    core.TaskManager.process();
    player.getMovementQueue().beginCycle();
    player.getMovementQueue().process();
    core.TaskManager.processWalkTo(player.getIndex());
    H.tick++;
    C.processActions();
    Tracking.process();
  }
  return { object, messages: player.messages.slice(from) };
}

/** Where the tracks last shown lead: the far end of that segment as it was drawn. */
function trailEnd(player) {
  const [varbit, value] = player.varbits.at(-1);
  const segment = Tracking.data.segments.find((candidate) => candidate.varbit === varbit);
  assert.ok(segment, `varbit ${varbit} is a trail segment`);
  return (value === 5) !== Boolean(segment.inverted) ? segment.start : segment.end;
}

for (const burrow of BURROWS) {
  test(`Feldip weasel hunts from the burrow at ${burrow.join(",")} can all be finished`, () => {
    for (let hunt = 0; hunt < HUNTS_PER_BURROW; hunt++) {
      const player = hunter(burrow[0] + 1, burrow[1] - 2);
      assert.deepEqual(click(player, burrow, "Inspect").messages,
        ["You discover tracks. Search along the trail to follow them."]);
      let caught = false;
      for (let step = 0; step < 14 && !caught; step++) {
        const end = trailEnd(player);
        const here = core.MapObjects.getObjectsAt(new core.Location(end[0], end[1], 0), null)
          .flatMap((object) => object.getDefinition().getInteractions() ?? []);
        const searched = click(player, end, here.includes("Search") ? "Search" : "Inspect");
        assert.equal(searched.messages.length, 1, `searching ${searched.object.getDefinition().getName()} at ${end} answers`);
        if (searched.messages[0] === "You find more tracks.") continue;
        assert.equal(searched.messages[0], "Something is moving here. Use your noose wand to catch it.");
        assert.equal(searched.object.getDefinition().getName(), "Bush", "a trail ends at a bush");
        assert.deepEqual(click(player, end, "Attack").messages, ["You catch a feldip weasel!"]);
        caught = true;
      }
      assert.ok(caught, "the trail ends within its segments");
      assert.ok(player.getInventory().contains(core.ItemIdentifiers.FELDIP_WEASEL_FUR), "the catch gives the fur");
      Tracking.clear({ player });
      H.players.delete(player);
    }
  });
}

test("with a trail going, a bush the tracks do not lead to still answers", () => {
  const player = hunter(BURROWS[0][0] + 1, BURROWS[0][1] - 2);
  click(player, BURROWS[0], "Inspect");
  const end = trailEnd(player);
  // The bush by the eastern burrow is no end of a first segment from the western one.
  const other = [2553, 2888];
  assert.notDeepEqual(end.slice(0, 2), other);
  assert.deepEqual(click(player, other, "Search").messages, ["You find no new tracks here."]);
});
