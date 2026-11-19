#!/usr/bin/env node
/**
 * Ours (upstream issue #3551): adds the OSRS Wiki's item spawns that the world lacks to
 * data/definitions/ground-items.json.
 *
 * ground-items.json is hand-kept (the list inherited from Elvarg, patched one spawn at a time)
 * plus what scripts/import-osrs-ground-spawns.mjs adds from an export of the osrsreboxed-db
 * repository, page by audited page. This script reads the Wiki itself instead: every page that
 * uses Template:ItemSpawnLine, each line's tiles with their plane, quantity (`qty:`) and respawn
 * (`respawn:`, else the page's Infobox Item `respawn`, in ticks) and members flag.
 *
 *   node scripts/import-wiki-item-spawns.cjs --fetch   download the pages into the snapshot (network)
 *   node scripts/import-wiki-item-spawns.cjs           add what the snapshot has and the world lacks
 *   node scripts/import-wiki-item-spawns.cjs --check   exit 1 if ground-items.json would change
 *
 * The snapshot (tests/fixtures/wiki-item-spawns.json) is what the Wiki said when it was fetched;
 * the import and tests/wiki-item-spawns.test.cjs work from it alone. A tile is added only when
 * - one item id among the page's has exactly the item's name in the game cache (no id is guessed);
 * - quantity, respawn (above 0), plane and members flag are plain values;
 * - the world does not already hold that item within 2 tiles on that plane, whoever put it
 *   there: this file's older rows, a plugin's own definition source, or a plugin at startup;
 * - no other item lies on the tile, and no plugin's code or data names the tile (a plugin may
 *   place the item itself, for one player or at a quest stage);
 * - the place is not one the server builds per player or per game (HELD_PLACES), the Wiki does
 *   not tie the spawn to a moment of a quest (CONDITIONAL_PLACE), and the item is not one a quest
 *   plugin hands out in its own way (HELD_ITEMS).
 * Everything else is held and listed by the run's report, never guessed. Rows this script adds
 * carry a description starting ADDED_PREFIX; they are replaced as a whole on every run, so a
 * run on its own output changes nothing.
 */
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const SERVER = path.resolve(__dirname, "..");
const SNAPSHOT = path.join(SERVER, "tests", "fixtures", "wiki-item-spawns.json");
const GROUND_ITEMS = path.join(SERVER, "data", "definitions", "ground-items.json");
const ADDED_PREFIX = "OSRS Wiki item spawn: ";
const API = "https://oldschool.runescape.wiki/api.php";
const USER_AGENT = "osrs-data-check/1.0 (generic script)";

// Places whose floor items are built per player or per game, or that a plugin runs as a whole.
const HELD_PLACES = /Hallowed Sepulchre|Tutorial Island|Last Man Standing|Castle Wars|Soul Wars|Pest Control|Barbarian Assault|Fight Pits|Trouble Brewing|Gauntlet|Chambers of Xeric|Tombs of Amascut|Theatre of Blood|Nightmare Zone|Clan Wars|Emir's Arena|Duel Arena|Mage Training Arena|Rogues' Den|Temple Trekking|Burgh de Rott Ramble|Pyramid Plunder|Fishing Trawler|Volcanic Mine|Tithe Farm|Inferno|Fight Cave|Random event|Evil Bob|Drill Demon|Barrows|Stealing Creation|Fortis Colosseum|Guardians of the Rift|Wintertodt|Tempoross|Giants' Foundry|Mahogany Homes|Brimhaven Agility Arena|Player-owned house|Bryophyta's lair|Obor's Lair|instance/i;
// A spawn the Wiki ties to a moment ("after killing the Dire Wolf Alpha", "during A Shell of a Friend"): its quest's to place.
const CONDITIONAL_PLACE = /\b(after|during|while|once|until)\b/i;
// Quest items whose quest plugin hands them out in its own way; a floor copy would be a second source.
const HELD_ITEMS = new Map([
  ["door key", "Witch's House gives it from the potted plant"],
  ["keg", "The Great Brain Robbery's"],
  ["shoes", "Spirits of the Elid's"],
]);

// ---------------------------------------------------------------------------------------------
// The Wiki: fetch and parse
// ---------------------------------------------------------------------------------------------

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": USER_AGENT } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

async function api(params) {
  const query = Object.entries({ format: "json", ...params }).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  const parsed = JSON.parse(await get(`${API}?${query}`));
  if (parsed.error) throw new Error(`wiki: ${JSON.stringify(parsed.error).slice(0, 300)}`);
  await new Promise((resolve) => setTimeout(resolve, 700)); // one request at a time, unhurried
  return parsed;
}

/** The inner text of every `{{name ...}}` in wikitext, nested templates kept whole. */
function templates(text, name) {
  const out = [];
  const lower = text.toLowerCase();
  const open = `{{${name.toLowerCase()}`;
  let from = 0;
  for (;;) {
    const start = lower.indexOf(open, from);
    if (start < 0) break;
    const after = text[start + open.length];
    if (after !== "|" && after !== "\n" && after !== " " && after !== "}") { from = start + open.length; continue; }
    let depth = 0;
    let i = start;
    for (; i < text.length - 1; i++) {
      if (text[i] === "{" && text[i + 1] === "{") { depth++; i++; }
      else if (text[i] === "}" && text[i + 1] === "}") { depth--; i++; if (depth === 0) break; }
    }
    out.push(text.slice(start + 2, i - 1));
    from = i + 1;
  }
  return out;
}

/** A template's parameters: `named` (lower-case keys) and `positional`, split on top-level pipes. */
function parameters(inner) {
  const parts = [];
  let depth = 0;
  let link = 0;
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const two = inner.slice(i, i + 2);
    if (two === "{{") { depth++; current += two; i++; continue; }
    if (two === "}}") { depth--; current += two; i++; continue; }
    if (two === "[[") { link++; current += two; i++; continue; }
    if (two === "]]") { link--; current += two; i++; continue; }
    if (inner[i] === "|" && depth === 0 && link === 0) { parts.push(current); current = ""; continue; }
    current += inner[i];
  }
  parts.push(current);
  const named = {};
  const positional = [];
  for (const part of parts.slice(1)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_ ]*?)\s*=([\s\S]*)$/.exec(part);
    if (match && !/^\s*\d/.test(part)) named[match[1].trim().toLowerCase()] = match[2].trim();
    else if (part.trim()) positional.push(part.trim());
  }
  return { named, positional };
}

/** One page's spawn tiles, each with the ids and respawn of the Infobox version its line names. */
function parsePage(title, wikitext) {
  // An editor's remark behind a spawn line ("currently unobtainable for some reason?") is kept
  // with the line; every other comment goes.
  const text = wikitext
    .replace(/(\{\{ItemSpawnLine[^\n]*?)\}\}[ \t]*<!--([^\n]*?)-->/gi, (_, line, remark) => `${line}|wikiremark=${remark.replace(/[|{}]/g, " ")}}}`)
    .replace(/<!--[\s\S]*?-->/g, "");
  const versions = [];
  for (const { named } of templates(text, "Infobox Item").map(parameters)) {
    const indexes = Object.keys(named).filter((key) => /^version\d+$/.test(key)).map((key) => key.slice(7));
    if (!indexes.length) versions.push({ name: named.name ?? title, ids: named.id ?? "", respawn: named.respawn ?? null });
    for (const i of indexes) {
      versions.push({ name: named[`name${i}`] ?? named.name ?? title, ids: named[`id${i}`] ?? named.id ?? "", respawn: named[`respawn${i}`] ?? named.respawn ?? null });
    }
  }
  const tiles = [];
  for (const { named, positional } of templates(text, "ItemSpawnLine").map(parameters)) {
    const name = named.name ?? title;
    // The line names a version of the page's item, or the page itself ("Swamp toad (item)" for the
    // item "Swamp toad"). A line naming another item (a table shared between pages) picks nothing.
    const matching = versions.filter((version) => normal(version.name) === normal(name));
    const picked = matching.length ? matching : normal(name) === normal(title) && versions.length === 1 ? versions : [];
    const item = picked.length && picked.every((version) => normal(version.name) === normal(picked[0].name)) ? plainText(picked[0].name) : null;
    const ids = [...new Set(picked.flatMap((version) => String(version.ids).split(",").map((id) => Number(id.trim())).filter(Number.isInteger)))];
    const respawn = [...new Set(picked.map((version) => version.respawn).filter((value) => value != null && value !== ""))];
    for (const entry of positional) {
      const tile = {};
      const plain = [];
      for (const field of entry.split(",").map((value) => value.trim())) {
        const pair = /^([a-zA-Z]+)\s*:\s*(.*)$/.exec(field);
        if (pair) tile[pair[1].toLowerCase()] = pair[2];
        else plain.push(field);
      }
      if (tile.x === undefined && plain.length >= 2) [tile.x, tile.y] = plain;
      tiles.push({
        page: title, name: plainText(name), ...(item !== null && item !== plainText(name) ? { item } : {}),
        location: named.location ?? "", members: named.members ?? "",
        x: tile.x ?? "", y: tile.y ?? "", plane: tile.plane ?? named.plane ?? "0",
        ...(tile.qty !== undefined ? { qty: tile.qty } : {}),
        ...(tile.respawn !== undefined ? { tileRespawn: tile.respawn } : {}),
        ...(tile.notes !== undefined ? { notes: tile.notes } : {}),
        ...(named.wikiremark ? { remark: named.wikiremark.trim() } : {}),
        ids, respawn,
      });
    }
  }
  return tiles;
}

async function fetchSnapshot() {
  const titles = [];
  let next = "";
  do {
    const page = await api({ action: "query", list: "embeddedin", eititle: "Template:ItemSpawnLine", eilimit: 500, einamespace: 0, ...(next ? { eicontinue: next } : {}) });
    titles.push(...page.query.embeddedin.map((entry) => entry.title));
    next = page.continue?.eicontinue ?? "";
  } while (next);
  titles.sort();
  const tiles = [];
  for (const title of titles) {
    const page = await api({ action: "parse", page: title, prop: "wikitext", redirects: 1 });
    tiles.push(...parsePage(title, page.parse.wikitext["*"]));
  }
  const snapshot = {
    $comment: "OSRS Wiki item spawns: every tile of every Template:ItemSpawnLine, with the item ids and respawn (ticks) of the Infobox Item version the line names. Written by scripts/import-wiki-item-spawns.cjs --fetch; never edited by hand.",
    retrieved: new Date().toISOString().slice(0, 10),
    pages: titles.length,
    tiles,
  };
  writeSnapshot(snapshot);
  return snapshot;
}

function writeSnapshot(snapshot) {
  const { tiles, ...head } = snapshot;
  const lines = tiles.map((tile) => `  ${JSON.stringify(tile)}`).join(",\n");
  fs.writeFileSync(SNAPSHOT, `${JSON.stringify(head).slice(0, -1)},"tiles":[\n${lines}\n]}\n`);
}

// ---------------------------------------------------------------------------------------------
// The world as it is, and the import
// ---------------------------------------------------------------------------------------------

function plainText(text) {
  return String(text ?? "").replace(/\{\{[^{}]*\}\}/g, " ").replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1").replace(/\s+/g, " ").trim();
}

function normal(name) {
  return plainText(name).toLowerCase().replace(/[^a-z0-9()+]+/g, " ").trim();
}

/** Tiles ("x,y") a plugin's own code or data names, with one file that does. */
function tilesNamedByPlugins() {
  const named = new Map();
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|json)$/.test(entry.name)) {
        for (const match of fs.readFileSync(full, "utf8").matchAll(/(?<![\d.])(\d{4})\s*,\s*(?:"?y"?\s*:\s*)?(\d{4,5})(?![\d.])/g)) {
          const key = `${match[1]},${match[2]}`;
          if (!named.has(key)) named.set(key, path.relative(SERVER, full).replace(/\\/g, "/"));
        }
      }
    }
  };
  walk(path.join(SERVER, "plugins"));
  return named;
}

/**
 * Every ground item the world holds without this script's rows: ground-items.json's other rows,
 * the plugins' definition sources and whatever plugins put down when they start. Needs the
 * plugins loaded and started (PluginManager.loadFromDirectory, emitServerStartup).
 */
function worldItems(core, existing) {
  const { DefinitionLoader } = require(path.join(SERVER, "dist/game/definition/loader/DefinitionLoader"));
  class Sources extends DefinitionLoader {
    load() { return true; }
    file() { return GROUND_ITEMS; }
    read() { return this.loadSources("ground_items").sources.flatMap((source) => source.definitions); }
  }
  const items = [];
  for (const row of [...existing.filter((entry) => !isAdded(entry)), ...new Sources().read()]) {
    if (Number.isInteger(row?.id) && row.location) items.push({ id: row.id, x: row.location.x, y: row.location.y, z: row.location.z ?? 0 });
  }
  for (const item of core.World.getItems()) {
    if (item.getOwner?.() || item.getPrivateArea?.()) continue;
    items.push({ id: item.getItem().getId(), x: item.getPosition().getX(), y: item.getPosition().getY(), z: item.getPosition().getZ() });
  }
  return items;
}

const isAdded = (row) => typeof row?.description === "string" && row.description.startsWith(ADDED_PREFIX);

/**
 * Sorts every snapshot tile: `add` (with the row to write), `present` (the world has it), or
 * `held` with the reasons. `core` is the plugin core API with the cache loaded; `items` from
 * worldItems; `pluginTiles` from tilesNamedByPlugins.
 */
function classify(snapshot, core, items, pluginTiles) {
  const squares = new Set(core.CacheMaps.getRegionIds());
  const byTile = new Map();
  for (const item of items) {
    const key = `${item.x},${item.y},${item.z}`;
    byTile.set(key, [...(byTile.get(key) ?? []), item.id]);
  }
  const has = (id, x, y, z, range) => {
    for (let dx = -range; dx <= range; dx++) {
      for (let dy = -range; dy <= range; dy++) if ((byTile.get(`${x + dx},${y + dy},${z}`) ?? []).includes(id)) return true;
    }
    return false;
  };
  const rows = [];
  for (const tile of snapshot.tiles) {
    const x = Number(tile.x), y = Number(tile.y), z = Number(tile.plane);
    const reasons = [];
    const quantity = tile.qty === undefined ? 1 : Number(tile.qty);
    const members = /^yes$/i.test(tile.members) ? true : /^no$/i.test(tile.members) ? false : null;
    if (![x, y, z].every(Number.isInteger) || z < 0 || z > 3) reasons.push("bad-coordinate");
    else if (!squares.has(((x >> 6) << 8) | (y >> 6))) reasons.push("no-such-map-square");
    if (!Number.isInteger(quantity) || quantity <= 0) reasons.push("quantity");
    if (members === null) reasons.push("members");
    if (tile.notes !== undefined) reasons.push("tile-note");
    if (tile.remark !== undefined) reasons.push("wiki-editors-remark");
    const itemName = tile.item ?? tile.name;
    const named = tile.ids.filter((id) => normal(core.CacheDefinitions.getItem(id)?.name) === normal(itemName));
    const id = named.length === 1 ? named[0] : null;
    if (id === null) reasons.push(named.length ? "several-ids-of-that-name" : "no-id-with-the-cache-name");
    let respawn = null;
    if (tile.tileRespawn !== undefined) {
      if (/^\d+$/.test(tile.tileRespawn)) respawn = Number(tile.tileRespawn);
      else reasons.push("tile-respawn");
    } else if (tile.respawn.length === 1 && /^\d+$/.test(String(tile.respawn[0]).trim())) respawn = Number(String(tile.respawn[0]).trim());
    else reasons.push(tile.respawn.length ? "respawn-not-a-number" : "no-respawn-time");
    if (respawn !== null && respawn <= 0) reasons.push("respawn-zero");
    if (HELD_PLACES.test(plainText(tile.location))) reasons.push("place-built-per-player-or-game");
    if (CONDITIONAL_PLACE.test(plainText(tile.location))) reasons.push("conditional-on-the-wiki");
    if (HELD_ITEMS.has(normal(itemName))) reasons.push("quest-plugin-item");
    if (pluginTiles.has(`${x},${y}`)) reasons.push(`tile-named-in-plugin:${pluginTiles.get(`${x},${y}`)}`);
    let status = "held";
    if (id !== null && has(id, x, y, z, 2)) status = "present";
    else if (reasons.length === 0) {
      if ((byTile.get(`${x},${y},${z}`) ?? []).length) reasons.push("another-item-on-the-tile");
      else status = "add";
    }
    rows.push({ tile, status, reasons, id, x, y, z, quantity, respawn, members });
  }
  // A spawn line with a tile a plugin names is that plugin's as a whole (the Summer Shore's sea
  // shells are Troubled Tortugans' materials: six tiles named in its code, the seventh not).
  const line = (row) => `${row.tile.page}|${row.tile.name}|${row.tile.location}|${row.tile.plane}`;
  const pluginLines = new Set(rows.filter((row) => row.reasons.some((reason) => reason.startsWith("tile-named-in-plugin"))).map(line));
  for (const row of rows) {
    if (row.status === "add" && pluginLines.has(line(row))) { row.status = "held"; row.reasons.push("line-partly-named-in-plugin"); }
  }
  // A tile listed twice is one spawn; copies that disagree are held.
  const first = new Map();
  for (const row of rows.filter((entry) => entry.status === "add")) {
    const key = `${row.id}:${row.x}:${row.y}:${row.z}`;
    const earlier = first.get(key);
    if (!earlier) { first.set(key, row); continue; }
    if (earlier.quantity === row.quantity && earlier.respawn === row.respawn && earlier.members === row.members) row.status = "duplicate";
    else for (const entry of [earlier, row]) { entry.status = "held"; entry.reasons.push("copies-disagree"); }
  }
  return rows;
}

/** A ground-items.json row for an `add` row, in the other importer's shape. */
function definition(row) {
  return {
    id: row.id, location: { x: row.x, y: row.y, z: row.z }, amt: row.quantity, respawn: row.respawn,
    ...(row.members ? { members: true } : {}),
    description: `${ADDED_PREFIX}${row.tile.item ?? row.tile.name} — ${plainText(row.tile.location)}`,
  };
}

function render(definitions) {
  return `[\n${definitions.map((row) => `  ${JSON.stringify(row)}`).join(",\n")}\n]\n`;
}

/** The file's rows with this script's own replaced by what the snapshot gives now, and the report. */
function importSpawns(snapshot, core, existing) {
  const rows = classify(snapshot, core, worldItems(core, existing), tilesNamedByPlugins());
  const added = rows.filter((row) => row.status === "add").map(definition)
    .sort((a, b) => a.description.localeCompare(b.description) || a.location.x - b.location.x || a.location.y - b.location.y || a.location.z - b.location.z);
  const counts = {};
  const held = {};
  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    if (row.status === "held") for (const reason of row.reasons) held[reason.split(":")[0]] = (held[reason.split(":")[0]] ?? 0) + 1;
  }
  return { definitions: [...existing.filter((entry) => !isAdded(entry)), ...added], rows, counts, held };
}

/** The plugin core API with the cache read and every plugin loaded and started, as the tests do. */
async function boot() {
  process.env.DISABLE_PLAYER_BOTS = "1";
  process.chdir(SERVER);
  require(path.join(SERVER, "dist/Server")).Server.installProductionPathResolver();
  const { CachePipeline } = require(path.join(SERVER, "dist/game/cache/CachePipeline"));
  const { PluginManager } = require(path.join(SERVER, "dist/plugins/PluginManager"));
  await CachePipeline.initialize(SERVER);
  const core = PluginManager.getCoreApi();
  core.RegionManager.init();
  PluginManager.loadFromDirectory(path.join(SERVER, "plugins"));
  PluginManager.emitServerStartup({});
  return core;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const snapshot = args.has("--fetch") ? await fetchSnapshot() : JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
  const core = await boot();
  const existing = JSON.parse(fs.readFileSync(GROUND_ITEMS, "utf8"));
  const result = importSpawns(snapshot, core, existing);
  const rendered = render(result.definitions);
  if (args.has("--check")) {
    if (rendered !== fs.readFileSync(GROUND_ITEMS, "utf8")) {
      console.error("ground-items.json needs scripts/import-wiki-item-spawns.cjs run again");
      process.exit(1);
    }
  } else {
    fs.writeFileSync(GROUND_ITEMS, rendered);
  }
  if (args.has("--report")) {
    for (const row of result.rows.filter((entry) => entry.status === "held")) {
      console.log(`held ${row.tile.page} ${row.tile.x},${row.tile.y},${row.tile.plane} (${plainText(row.tile.location)}): ${row.reasons.join("; ")}`);
    }
  }
  console.log(JSON.stringify({ snapshot: snapshot.retrieved, tiles: snapshot.tiles.length, definitions: result.definitions.length, counts: result.counts, held: result.held }));
  process.exit(0);
}

module.exports = { ADDED_PREFIX, SNAPSHOT, GROUND_ITEMS, HELD_PLACES, CONDITIONAL_PLACE, HELD_ITEMS, parsePage, classify, importSpawns, worldItems, tilesNamedByPlugins, definition, render, isAdded, normal, plainText, boot };

if (require.main === module) main().catch((error) => { console.error(error); process.exit(1); });
