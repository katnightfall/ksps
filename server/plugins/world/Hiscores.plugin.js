/**
 * Hiscores: a feature of our world. Every saved player is ranked by total level, by each skill,
 * by a few activities (player kills, quest points, clue scrolls, hours played) and by kills of
 * each monster the game counts. The tables are served to the website's /hiscores page over the
 * content API, and ::hiscores shows the top of one in game.
 *
 *   GET /api/hiscores                               what there is to rank by, and how many players
 *   GET /api/hiscores?view=skill&name=mining        a table: &page=2, &mode=ironman, &find=<player>
 *   GET /api/hiscores?view=activity&name=quest-points
 *   GET /api/hiscores?view=kills&name=zulrah
 *   GET /api/hiscores?view=player&name=<player>     one player's ranks
 *
 * The numbers come from the save database, read through a second, read-only connection (the
 * world config page's Players list does the same), so a player moves up when the game saves
 * them: at logout and at each autosave. A save is only parsed again when its row has changed.
 * Left out: bots, league and hardcore-world characters, and account stubs. The ranking itself
 * is hiscores/Ranking.Hiscores.js.
 */
const fs = require("node:fs");
const path = require("node:path");
const Ranking = require("./hiscores/Ranking.Hiscores");

/** How long a request may be answered from the tables as they are before the database is looked at again. */
const REFRESH_MS = 30_000;
/** Rows ::hiscores lists. */
const SCROLL_ROWS = 50;
// The journal scroll ::staff uses (PlayerCommands.plugin.js, which also handles its close button).
const JOURNAL_GROUP = 119;
const JOURNAL_TITLE = (JOURNAL_GROUP << 16) | 5;
const JOURNAL_CLOSE = (JOURNAL_GROUP << 16) | 8;
const JOURNAL_SWITCH = (JOURNAL_GROUP << 16) | 9;
const JOURNAL_BACK = (JOURNAL_GROUP << 16) | 10;
const JOURNAL_FIRST_LINE = 11;
const JOURNAL_LINES_VARP = 4398;
const JOURNAL_RESET_SCRIPT = 5240;
const JOURNAL_SCROLL_SCRIPT = 2523;
const FLOATER_OVERLAY = (161 << 16) | 18;

let core;
let skillNames = [];
/** Skill icons as data URIs by Skill index (the world config page's own), for the website. */
let skillIcons = [];
/** Save rows as last read: database key -> { updatedAt, entry or null }. */
const rows = new Map();
let board = Ranking.buildBoard([], []);
let refreshedAt = -Infinity;
let warned = false;

function databasePath() {
  return process.env.PLAYER_SAVE_DATABASE_PATH || path.join("data", "saves", "players.sqlite");
}

/** The AI bots' names (plugins/bots/ai/Roster.PlayerBots.js): they have saves like players do. */
function botNames() {
  try {
    const roster = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "saves", "ai-bots.json"), "utf8"));
    return new Set((roster?.bots ?? []).map((bot) => String(bot?.name ?? "").toLowerCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Reads the saves that changed since last time and ranks again if any did. */
function readSaves() {
  const database = databasePath();
  if (!fs.existsSync(database)) return;
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(database, { readOnly: true });
  let changed = false;
  try {
    const bots = botNames();
    const seen = new Set();
    const read = db.prepare("SELECT save_json AS json FROM player_saves WHERE username = ?");
    for (const { username, updated_at: updatedAt } of db.prepare("SELECT username, updated_at FROM player_saves").all()) {
      seen.add(username);
      if (rows.get(username)?.updatedAt === updatedAt) continue;
      let entry = null;
      // League and hardcore-world characters ("league:<name>") are not ranked, so not read either.
      if (!username.includes(":")) {
        try {
          entry = Ranking.entryFromSave(username, JSON.parse(read.get(username)?.json ?? "null"), skillNames.length, bots);
        } catch {
          entry = null;
        }
      }
      rows.set(username, { updatedAt, entry });
      changed = true;
    }
    for (const username of [...rows.keys()]) {
      if (!seen.has(username)) {
        rows.delete(username);
        changed = true;
      }
    }
  } finally {
    db.close();
  }
  if (changed) board = Ranking.buildBoard([...rows.values()].flatMap((row) => (row.entry ? [row.entry] : [])), skillNames);
}

function currentBoard(now = Date.now()) {
  if (now - refreshedAt < REFRESH_MS) return board;
  refreshedAt = now;
  try {
    readSaves();
    warned = false;
  } catch (error) {
    // The tables stay as they were; say so once rather than on every request.
    if (!warned) console.warn("[hiscores] could not read the save database", error);
    warned = true;
  }
  return board;
}

/** Lower-case names of the people playing now. */
function onlineNames() {
  const names = new Set();
  for (const player of core.World.getPlayers()) {
    if (!player || player.isPlayerBot?.() === true || !core.World.isPlayerSessionConnected(player)) continue;
    names.add(String(player.getUsername()).toLowerCase());
  }
  return names;
}

const TABLE_VIEWS = { skill: "skill", activity: "activity", kills: "kills" };

function hiscores(query, segments) {
  if (segments.length) return undefined;
  const view = query.get("view") ?? "meta";
  const tables = currentBoard();
  if (view === "meta") {
    return {
      world: String(core.WorldDefinition.getWorldDefinition().name ?? ""),
      players: tables.entries.length,
      online: onlineNames().size,
      pageSize: Ranking.PAGE_SIZE,
      skills: skillNames.map((name, index) => ({ name, icon: skillIcons[index] ?? null })),
      activities: Ranking.ACTIVITIES.map(({ key, name }) => ({ key, name })),
      monsters: tables.monsters,
      modes: Ranking.MODES.map((key) => ({ key, name: Ranking.MODE_LABELS[key] })),
    };
  }
  const name = String(query.get("name") ?? "").trim();
  if (view === "player") return Ranking.profile(tables, name, onlineNames());
  if (!TABLE_VIEWS[view]) return undefined;
  return Ranking.page(tables, `${TABLE_VIEWS[view]}:${(name || "overall").toLowerCase()}`, {
    mode: query.get("mode") ?? "all",
    page: query.get("page") ?? 1,
    find: query.get("find") ?? undefined,
    online: onlineNames(),
  });
}

const number = (value) => Number(value).toLocaleString("en-US");

/** ::hiscores [skill]: the top of a skill's table (or the overall one) in the journal scroll, with the player's own rank. */
function showHiscores({ player, parts }) {
  const wanted = parts.slice(1).join(" ").trim().toLowerCase();
  const skill = !wanted || wanted === "overall" ? "overall"
    : skillNames.find((name) => name.toLowerCase() === wanted) ?? skillNames.find((name) => name.toLowerCase().startsWith(wanted));
  if (!skill) {
    player.sendMessage(`There is no skill called "${wanted}". Try ::hiscores, or ::hiscores mining.`);
    return true;
  }
  const tables = currentBoard();
  const tableKey = `skill:${skill.toLowerCase()}`;
  const top = [];
  for (let page = 1; top.length < SCROLL_ROWS; page++) {
    const result = Ranking.page(tables, tableKey, { page });
    top.push(...result.rows);
    if (page >= result.pages) break;
  }
  const lines = top.slice(0, SCROLL_ROWS).map((row) => `${row.rank}. ${row.name} - level ${number(row.level)} (${number(row.score)} xp)`);
  if (lines.length === 0) lines.push("Nobody is ranked yet.");
  const own = Ranking.page(tables, tableKey, { find: player.getUsername() }).rows.find((row) => row.name.toLowerCase() === player.getUsername().toLowerCase());
  lines.push("", own ? `Your rank: ${number(own.rank)} of ${number(tables.tables.get(tableKey).length)}` : "You are ranked after your next save (log out, or wait a few minutes).");
  lines.push("The full hiscores are on our website: /hiscores");
  const title = skill === "overall" ? "Overall" : skill;
  const sender = player.getPacketSender();
  sender.sendConfig(JOURNAL_LINES_VARP, lines.length);
  sender.sendSubInterface(FLOATER_OVERLAY, JOURNAL_GROUP, 0);
  sender.sendInterfaceFlagsRange(JOURNAL_CLOSE, -1, -1, 1 << 1);
  sender.sendInterfaceScript(JOURNAL_RESET_SCRIPT, []);
  sender.sendInterfaceDisplayState(JOURNAL_SWITCH, true);
  sender.sendInterfaceDisplayState(JOURNAL_BACK, true);
  sender.sendString(`<col=7f0000>Hiscores: ${title}</col>`, JOURNAL_TITLE);
  lines.forEach((line, index) => sender.sendString(`<col=000080>${line}</col>`, (JOURNAL_GROUP << 16) | (JOURNAL_FIRST_LINE + index)));
  sender.sendInterfaceScript(JOURNAL_SCROLL_SCRIPT, [0, lines.length]);
  return true;
}

function loadSkillIcons() {
  try {
    return require("../tools/worldadmin/panel/skill-icons.json").skills ?? [];
  } catch {
    return [];
  }
}

module.exports = {
  name: "Hiscores",
  description: "Ranks every saved player by total level, each skill, activities and monster kills; serves the tables to the website's /hiscores page and shows the top of one in game with ::hiscores.",
  register(api) {
    core = api.core;
    skillNames = core.Skill.values().map((skill) => skill.getName());
    skillIcons = loadSkillIcons();
    api.registerContentEndpoint("hiscores", hiscores);
    api.registerCommand("hiscores", showHiscores, core.PlayerRights.NONE, "Show the top players: ::hiscores, or ::hiscores <skill>");
    api.registerCommand("highscores", showHiscores, core.PlayerRights.NONE, "Show the top players: ::highscores, or ::highscores <skill>");
  },
  _test: { hiscores, showHiscores, currentBoard, reset() { rows.clear(); board = Ranking.buildBoard([], skillNames); refreshedAt = -Infinity; } },
};
