// From server/: node --test tests/monkey-madness-travel-after-last-line.test.cjs
// Upstream issue #4101: "Waydar moves the player to Crash Island before finishing his dialogue". The flight
// (and Lumdo's boat) happened as the lines after the choice were laid out, so the player stood on Crash Island
// while "Yes, let's go." was still on screen. Both journeys now follow their last line, "As you wish.".
// Real ClientConnection packets, plugins, cache and map (quest-capture-harness).
const assert = require("node:assert/strict");
const { before, after, test, mock } = require("node:test");
const h = require("./quest-capture-harness.cjs");

// MonkeyMadnessI.Quest.js: HANGAR_LANDING, CRASH_ISLAND_LANDING, ATOLL_LANDING; stages 5 (puzzle solved) and 7.
const HANGAR = [2394, 9889, 0];
const CRASH_ISLAND = [2892, 2725, 0];
const ATOLL = [2803, 2707, 0];

before(async () => {
  h.key = "monkey_madness_i";
  const worldConfig = require("../dist/game/definition/WorldDefinition");
  const readConfig = worldConfig.readWorldConfig;
  const config = mock.method(worldConfig, "readWorldConfig", (...args) => {
    const actual = readConfig(...args);
    return { ...actual, plugins: { ...actual.plugins, WorldAdmin: false } };
  });
  try { await h.setup([[2394, 9889], [2892, 2725], [2803, 2707]]); } finally { config.mock.restore(); }
});
after(() => h.teardown());

const position = (f) => {
  const at = f.player.getLocation();
  return [at.getX(), at.getY(), at.getZ()];
};

/** Plays the conversation, answering Yes; returns where the player stood while each line was on screen. */
async function travel(f, npc) {
  const seen = [];
  await h.talk(f, npc);
  for (let i = 0; i < 40; i++) {
    const line = h.shown(f);
    if (!line) break;
    if (line.who === "menu") {
      const options = line.text.split("|");
      await h.choose(f, options.includes("Yes") ? "Yes" : options[0]);
      continue;
    }
    seen.push({ text: line.text, at: position(f) });
    await h.continueLine(f);
  }
  h.ticks(f, 2);
  return seen;
}

test("Waydar flies to Crash Island only once his 'As you wish.' has been read", async (t) => {
  const f = h.actor(t, { at: HANGAR, done: [], stage: 5, attributes: { "quest.monkey_madness_i.post-puzzle-talk": true } });
  const waydar = h.spawn(f, h.core.NpcIdentifiers.WAYDAR_2, [HANGAR[0] + 1, HANGAR[1], 0]);
  const seen = await travel(f, waydar);
  const texts = seen.map((line) => line.text);
  assert.ok(texts.includes("Yes, let's go.") && texts.at(-1) === "As you wish.", JSON.stringify(texts));
  for (const line of seen) assert.deepEqual(line.at, HANGAR, `still in the hangar at "${line.text}"`);
  assert.deepEqual(position(f), CRASH_ISLAND);
  assert.equal(h.stage(f), 6);
});

test("Lumdo rows to Ape Atoll only once his 'As you wish.' has been read", async (t) => {
  const f = h.actor(t, { at: CRASH_ISLAND, done: [], stage: 7 });
  const lumdo = h.spawn(f, h.core.NpcIdentifiers.LUMDO_3, [CRASH_ISLAND[0] + 1, CRASH_ISLAND[1], 0]);
  const seen = await travel(f, lumdo);
  assert.equal(seen.at(-1)?.text, "As you wish.", JSON.stringify(seen.map((line) => line.text)));
  for (const line of seen) assert.deepEqual(line.at, CRASH_ISLAND, `still on Crash Island at "${line.text}"`);
  assert.deepEqual(position(f), ATOLL);
});
