// Run after `yarn build`: node --test tests/plugin-references.test.cjs   (about two minutes)
//
// References that point at nothing. Plugins are plain JavaScript and JSON: a constant the cache move
// removed, a function another module does not export, a hook registered under a name the cache spells
// differently, a getter called on a tile that arrives as plain { x, y, z } - none of them fails until
// a player gets there, and then it fails quietly. The scanners in server/scripts find them by reading
// every script; this holds each one at what is known today, so a merge or the next cache build that
// adds one fails here and names it.
//
// When a check fails: fix the reference. Add to a KNOWN list only what is deliberate (a spare option,
// a seasonal object), with the reason.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
// The bots rewrite their tracked object index on load, and nothing here needs them.
process.env.DISABLE_PLAYER_BOTS = "1";
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { CacheDefinitions } = require("../dist/game/cache/CacheDefinitions");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const members = require("../scripts/scan-member-refs.cjs");
const tiles = require("../scripts/scan-plain-tiles.cjs");
const named = require("../scripts/scan-named-hooks.cjs");
const gamevals = require("../scripts/scan-gamevals.cjs");
const events = require("../scripts/scan-events.cjs");

const SERVER = path.resolve(__dirname, "..");
const FIXTURE = path.join(__dirname, "fixtures", "plugin-references");

let core;
let api;
let registrations;

before(async () => {
  await CachePipeline.initialize(SERVER);
  registrations = named.recordRegistrations(PM, SERVER);
  PM.loadFromDirectory(path.join(SERVER, "plugins"));
  registrations.restore();
  core = PM.getCoreApi();
  api = PM.createApi("PluginReferencesTest");
});
after(() => PM.emitServerShutdown({}));

// ---- names read from an object that does not have them ---------------------------------------

test("the member scanner finds every way a plugin reaches a missing name (guards against matching nothing)", () => {
  const { findings } = members.scan({ serverDir: SERVER, sourceRoot: FIXTURE, dirs: ["plugins/skills"], core, api, moduleExports: members.loadedModuleExports });
  const names = (guarded) => findings.filter((f) => f.guarded === guarded).map((f) => f.name).sort();
  assert.deepEqual(names(false), [
    // identifier classes: direct, api.core, an alias, a string key, a helper module's core, a late
    // assignment, a function that returns the class, lookup helpers, literal lists, destructuring
    "GONE_DESTRUCTURED", "GONE_DIRECT", "GONE_API_CORE", "GONE_NPC_ALIAS", "GONE_OBJECT_STRING", "GONE_H_CORE",
    "GONE_LATE_ASSIGN", "GONE_VIA_FUNCTION", "GONE_LOOKUP_ARROW", "GONE_LOOKUP_FN", "GONE_LIST_ITEM", "GONE_INLINE_LIST",
    "COINS", // an item name looked up among the NPCs
    "GONE_IN_CALLBACK", "GONE_PARAM_CORE", "GONE_IN_OBJECT_LITERAL", "GONE_COMPUTED_KEY", "GONE_CASE_LABEL",
    "GONE_TEMPLATE", "GONE_SPREAD_ARG", "GONE_SPREAD", "GONE_MAP_KEY", "GONE_THIS_CORE",
    // the engine's classes, api.core itself, a required module's exports, the plugin api, a missing file
    "NOT_A_SKILL", "NOPE", "noSuchHelper", "NotAThing", "noSuchExport", "noSuchFunction", "alsoNotThere", "onNoSuchHook",
    "./NoSuchFile.Hunter",
  ].sort());
  assert.deepEqual(names(true), ["GONE_GUARDED"], "a read with a fallback is marked, not counted");
});

test("no plugin reads a constant, a core class member, a module export or an api method that does not exist", () => {
  const { findings, stats } = members.scan({ serverDir: SERVER, core, api, moduleExports: members.loadedModuleExports });
  assert.ok(stats.identifierReads > 15000 && stats.coreMemberReads > 10000 && stats.moduleMemberReads > 20000 && stats.apiReads > 10000,
    `the scan follows the plugins' references (${JSON.stringify(stats)})`);
  const missing = findings.filter((f) => !f.guarded).map((f) => `${f.file}:${f.line} ${f.base}.${f.name}`);
  assert.deepEqual(missing, []);
});

// ---- getters on plain tiles --------------------------------------------------------------------

// Both are fixed in the main copy by commits made after this branch left it (Fishing Contest's
// Hemenster gate, Haunted Mine's cart); once those are merged with this test, empty this list.
const TILES_FIXED_ELSEWHERE = ["plugins/quests/quests/FishingContest.Quest.js", "plugins/quests/quests/HauntedMine.Quest.js"];

test("the plain-tile scanner follows a tile through helpers, required modules, option tables and custom events", () => {
  const { findings } = tiles.scan({ serverDir: SERVER, sourceRoot: FIXTURE });
  assert.deepEqual(findings.map((f) => `${path.basename(f.file)} ${f.text}`).sort(), [
    "ZzTiles.js location.getDistance()", "ZzTiles.js location.getX()", "ZzTiles.js location.getY()", "ZzTiles.js location.getZ()",
    "ZzTilesHelper.js event.location.getY()",
  ]);
});

test("no handler calls a method on a tile that arrives as plain { x, y, z }", () => {
  const { findings, stats } = tiles.scan({ serverDir: SERVER });
  assert.ok(stats.hookHandlers > 3000 && stats.tileMethodCalls > 200, `the scan reaches the plugins' handlers (${JSON.stringify(stats)})`);
  const calls = findings.filter((f) => !TILES_FIXED_ELSEWHERE.includes(f.file)).map((f) => `${f.file}:${f.line} ${f.text} <- ${f.origin}`);
  assert.deepEqual(calls, []);
});

// ---- hooks registered by name or id ------------------------------------------------------------

/** Registrations that can never fire, each looked at: `problem: plugin method "name" "option"`. */
const KNOWN_DEAD_REGISTRATIONS = new Set([
  // A second registration beside one that works (another spelling, the NPC beside the booth, a
  // handler by id on the line above): nothing is lost.
  'option: GrandExchange onObjectInteraction "Grand Exchange booth" "Sets"',
  'name: RandomEvents onItemAction "MysteryBox"',
  'option: RandomEvents onObjectInteraction "Door" "Walk"',
  'option: Quests onObjectInteraction "Teleporter" "Enter"',
  'option: Quests onObjectInteraction "Ceremonial Brazier" "Light"',
  'name: Quests onObjectInteraction "Chisel"',
  'name: Construction onNpcsInteraction "Combat dummy"',
  'name: Construction onNpcsInteraction "Undead Combat dummy"',
  'name: Quests onNpcInteraction "Bob the Cat"',
  'name: Quests onNpcsInteraction "Western baker"',
  'name: Quests onNpcsInteraction "Eastern baker"',
  // An option the item or NPC does not offer in that state (an empty blowpipe has no Check).
  'option: CrystalHalberd onItemAction "Crystal halberd (inactive)" "Check"',
  'option: ToxicBlowpipe onItemAction "Blazing blowpipe (empty)" "Check"',
  'option: ToxicBlowpipe onItemAction "Blazing blowpipe (empty)" "Unload"',
  'option: ToxicBlowpipe onItemAction "Blazing blowpipe (empty)" "Uncharge"',
  'option: VenatorBow onItemAction "Venator bow (uncharged)" "Check"',
  'option: VenatorBow onItemAction "Venator bow (uncharged)" "Uncharge"',
  'option: VenatorBow onItemAction "Echo venator bow (uncharged)" "Check"',
  'option: VenatorBow onItemAction "Echo venator bow (uncharged)" "Uncharge"',
  'option: Quests onItemAction "Drunk parrot" "Release"',
  'option: Quests onNpcInteraction "H.A.M. Archer" "Talk-to"',
  'option: Quests onNpcInteraction "H.A.M. Mage" "Talk-to"',
  'option: Quests onNpcInteraction "Juna" "Talk-to"',
  'option: Quests onNpcInteraction "Vardorvis" "Talk-to"',
  'option: Quests onNpcInteraction "The Leviathan" "Talk-to"',
  'option: Quests onNpcInteraction "Duke Sucellus" "Talk-to"',
  'option: Quests onNpcInteraction "The Whisperer" "Talk-to"',
  'option: BarbarianAssault onNpcInteraction "Commander Connad" "Gamble"',
  // The house ovens are cooked on by using food on them; the cache gives them no Cook option.
  'option: Cooking onObjectInteraction "Small oven" "Cook"',
  'option: Cooking onObjectInteraction "Large oven" "Cook"',
  'option: Cooking onObjectInteraction "Steel range" "Cook"',
  // Only the medium, hard and elite tiers have a challenge scroll.
  'name: TreasureTrails onItemAction "Challenge scroll (easy)"',
  'name: TreasureTrails onItemAction "Challenge scroll (master)"',
  // The Lumbridge tutors the 242 cache retired (docs/cache-revision-update.md): Tutors keeps them by id.
  'name: Tutors onNpcInteraction "Ranged combat tutor"',
  'name: Tutors onNpcInteraction "Magic combat tutor"',
  // Seasonal definitions are loaded only in season.
  'option: ChristmasDinner onObjectInteraction "Table" "Serve"',
  'option: ChristmasDinner onObjectInteraction "Bar" "Get Drink From"',
  'name: ChristmasDinner onItemAction "Serving platter"',
  // Not settled: no loc named "Flowers" has an option in this cache, so a planted mithril-seed flower
  // may have nothing to click. To check in a client before it is called deliberate.
  'option: MithrilSeeds onObjectInteraction "Flowers" "Pick"',
]);

test("hooks are registered under names, options and ids the cache has", () => {
  const { findings, stats } = named.check(registrations.records, named.definitionIndex(core));
  assert.ok(stats.registrations > 4000 && stats.names > 4000 && stats.ids > 4000, `the loader's registrations were recorded (${JSON.stringify(stats)})`);
  const key = (f) => `${f.problem}: ${f.plugin} ${f.method} ${JSON.stringify(f.name)}${f.option ? ` ${JSON.stringify(f.option)}` : ""}`;
  const dead = findings.filter((f) => f.problem !== "spare-option" && !KNOWN_DEAD_REGISTRATIONS.has(key(f)))
    .map((f) => `${key(f)}   at ${f.site}: ${f.detail}`);
  assert.deepEqual(dead, []);
});

// ---- cache names (gamevals) --------------------------------------------------------------------

/** Literal lookups the cache has no answer for, where the code goes on to a fallback. */
const KNOWN_MISSING_GAMEVALS = new Set([
  'plugins/bosses/leviathan/Common.Leviathan.js getObjId("dt2_awakener_orb")', // falls back to ItemIdentifiers.AWAKENERS_ORB on the next line
]);

test("every cache name asked for by a literal lookup is in the cache", () => {
  const { findings, checked } = gamevals.scanLiterals({ serverDir: SERVER, CacheDefinitions });
  assert.ok(checked > 300, `literal lookups were found (${checked})`);
  const missing = findings.filter((f) => !f.guarded).map((f) => `${f.file} ${f.method}(${JSON.stringify(f.name)})`)
    .filter((entry) => !KNOWN_MISSING_GAMEVALS.has(entry));
  assert.deepEqual(missing, []);
});

// ---- custom events -----------------------------------------------------------------------------

/** Names listened for that nothing sends by that name and that sit next to a name that is sent: each is its own event. */
const KNOWN_NEAR_EVENT_NAMES = new Set([
  "grouping:unkick", // the Grouping panel's own button, beside grouping:kick
  "fairy-rings:destinations", // a question other plugins ask, beside the fairy-rings:destination announcement
  "miscellania:collect", // the request to collect, beside the miscellania:collected announcement
]);

test("no custom event is listened for under a misspelling of a name that is sent", () => {
  const found = events.scan({ serverDir: SERVER });
  assert.ok(found.emitted.size > 800 && found.heard.size > 800, "the events were read");
  const suspects = events.nearMisses(found).filter((entry) => !KNOWN_NEAR_EVENT_NAMES.has(entry.name))
    .map((entry) => `${entry.name} (${entry.sites[0]}) is never sent; sent names close to it: ${entry.near.join(", ")}`);
  assert.deepEqual(suspects, []);
});

// ---- item-gameplay.json rows skipped by name ---------------------------------------------------

/**
 * ItemDefinitionLoader skips a row of item-gameplay.json whose name is not the cache's name for that
 * id (the file is an old export). A skipped row's level requirements and weapon type are lost with
 * it, so a rename in the cache, or an old name in the file, lets anyone wear the item.
 */
const KNOWN_SKIPPED_GAMEPLAY_ROWS = new Set([
  2425, // the row is another item's (named "Null", a knife); the id is Vorkath's head
  2535, 2537, 2539, 2541, 11222, 21330, // lit fire arrows: the rows ask a Ranged level arrows do not have
  10798, 10800, // ids with no item in the cache
]);

test("no item-gameplay.json row with a level requirement or a weapon type is skipped for its name", () => {
  const rows = require("../data/definitions/item-gameplay.json");
  const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
  const lost = [];
  let checked = 0;
  for (const row of rows) {
    if (!Number.isInteger(row?.id)) continue;
    const requires = Array.isArray(row.requirements) && row.requirements.some((level) => level > 1);
    const weapon = typeof row.weaponInterface === "string" && row.weaponInterface !== "UNARMED";
    if (!requires && !weapon) continue;
    checked++;
    const cacheName = CacheDefinitions.hasItem(row.id) ? CacheDefinitions.getItem(row.id)?.name : undefined;
    if (same(cacheName, row.name) || KNOWN_SKIPPED_GAMEPLAY_ROWS.has(row.id)) continue;
    lost.push(`${row.id}: the row is named ${JSON.stringify(row.name)}, the cache's item ${JSON.stringify(cacheName)}`);
  }
  assert.ok(checked > 3000, `rows with requirements or weapon types were found (${checked})`);
  assert.deepEqual(lost, []);
});

test("the blessed d'hide bodies, spiky vambraces and their like ask for their levels", () => {
  const { Skill } = core;
  const needs = (id) => core.ItemDefinition.forId(id).getRequirements();
  for (const id of [10370, 10378, 10386, 12492, 12500, 12508]) {
    assert.equal(needs(id)[Skill.RANGED.getIndex()], 70, `${core.ItemDefinition.forId(id).getName()} asks 70 Ranged`);
    assert.equal(needs(id)[Skill.DEFENCE.getIndex()], 40, `${core.ItemDefinition.forId(id).getName()} asks 40 Defence`);
  }
  assert.deepEqual([10079, 10081, 10085].map((id) => needs(id)[Skill.RANGED.getIndex()]), [40, 50, 70], "green, blue and black spiky vambraces");
  assert.equal(needs(10826)[Skill.DEFENCE.getIndex()], 25, "Neitiznot shield");
  assert.equal(needs(13381)[Skill.DEFENCE.getIndex()], 20, "Shayzien body (5)");
  assert.deepEqual(needs(13337), needs(13280), "the Accumulator max cape asks what the Max cape asks");
});
