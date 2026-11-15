/**
 * The ranking half of the Hiscores plugin: turns player saves into entries and entries into
 * ranked tables. Nothing here touches the game or the database, so it is tested on its own.
 *
 * A save is the JSON PlayerSave writes (skills.maxLevel / skills.experience by Skill index, the
 * persisted attributes). An entry is the handful of numbers the tables rank by.
 */

/** Rows a page of a table holds. */
const PAGE_SIZE = 25;
const MODES = ["regular", "ironman", "hardcore", "ultimate"];
const MODE_LABELS = { regular: "Regular", ironman: "Ironman", hardcore: "Hardcore Ironman", ultimate: "Ultimate Ironman" };
/**
 * Saved bots that the AI roster does not list: Registry.PlayerBots.js names its own
 * PlayerBot<N>, and the levelling crowd of a progression site is SiteBot<N> (SiteSpawner).
 */
const BOT_NAME = /^(playerbot|sitebot)\d+$/i;
const CLUE_TIERS = ["beginner", "easy", "medium", "hard", "elite", "master"];

/** The ranked things that are not skills: what they are called and where a save keeps them. */
const ACTIVITIES = [
  { key: "pvp-kills", name: "Player kills", score: (attributes) => count(attributes["pvp:player-kills"]) },
  { key: "quest-points", name: "Quest points", score: (attributes) => count(attributes["quest.points"]) },
  { key: "clue-scrolls", name: "Clue scrolls", score: (attributes) => CLUE_TIERS.reduce((sum, tier) => sum + count(attributes[`treasure-trails:${tier}-completed`]), 0) },
  { key: "time-played", name: "Hours played", score: (attributes) => Math.floor(count(attributes["account-summary:play-time"]) / 3_600_000) },
];

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/** PlayerSave writes a Map as { __type: "Map", entries: [[key, value], ...] }; older saves hold a plain object. */
function pairs(value) {
  if (!value || typeof value !== "object") return [];
  if (value.__type === "Map" && Array.isArray(value.entries)) return value.entries;
  return Array.isArray(value) ? [] : Object.entries(value);
}

/** SkillManager.calculateCombatLevel, for base levels by Skill index. */
function combatLevel(levels) {
  const [attack, defence, strength, hitpoints, ranged, prayer, magic] = levels;
  const base = (defence + hitpoints + Math.floor(prayer / 2)) * 0.25;
  const best = Math.max((attack + strength) * 0.325, Math.floor(ranged * 1.5) * 0.325, Math.floor(magic * 1.5) * 0.325);
  return Math.max(3, Math.min(126, Math.floor(base + best)));
}

/**
 * The entry of one saved player, or null for a save that is not ranked: a league or hardcore
 * world character (their rows are keyed "league:<name>"), an account stub left by a Hardcore
 * reset, a bot, or a save whose skills can't be read.
 */
function entryFromSave(key, save, skillCount, botNames = new Set()) {
  if (!save || typeof save !== "object" || key.includes(":") || save.unmade === true) return null;
  const levels = save.skills?.maxLevel;
  const experience = save.skills?.experience;
  if (!Array.isArray(levels) || !Array.isArray(experience) || levels.length < skillCount || experience.length < skillCount) return null;
  const name = String(save.displayName ?? key).trim() || key;
  if (BOT_NAME.test(name) || botNames.has(name.toLowerCase())) return null;
  const attributes = save.attributes && typeof save.attributes === "object" ? save.attributes : {};
  const mode = MODES.includes(attributes["ironman:mode"]) ? attributes["ironman:mode"] : "regular";
  const entry = {
    key,
    name,
    rights: count(save.rights?.id),
    mode,
    dead: mode === "hardcore" && count(attributes["ironman:hardcore-dead"]) > 0,
    levels: levels.slice(0, skillCount).map((level) => Math.max(1, count(level))),
    xp: experience.slice(0, skillCount).map(count),
    activities: {},
    kills: {},
  };
  entry.totalLevel = entry.levels.reduce((sum, level) => sum + level, 0);
  entry.totalXp = entry.xp.reduce((sum, xp) => sum + xp, 0);
  entry.combat = combatLevel(entry.levels);
  for (const activity of ACTIVITIES) entry.activities[activity.key] = activity.score(attributes);
  // Kills are kept by monster name; a key that is only digits is an older save's id, which has no name here.
  for (const [monster, kills] of pairs(attributes["combat-achievements:kills"])) {
    if (typeof monster === "string" && !/^\d+$/.test(monster) && count(kills) > 0) entry.kills[monster] = count(kills);
  }
  return entry;
}

const byName = (a, b) => a.name.localeCompare(b.name);

/** Entries ranked by a score, highest first; `tie` breaks equal scores and the name settles the rest. */
function ranked(entries, score, tie = () => 0) {
  return entries
    .filter((entry) => score(entry) > 0)
    .sort((a, b) => score(b) - score(a) || tie(b) - tie(a) || byName(a, b));
}

/** Every table, ranked once; a mode's own table is cut from these when it is first asked for. */
function buildBoard(entries, skillNames) {
  const tables = new Map();
  tables.set("skill:overall", ranked(entries, (entry) => entry.totalLevel, (entry) => entry.totalXp));
  skillNames.forEach((name, index) => {
    tables.set(`skill:${name.toLowerCase()}`, ranked(entries, (entry) => entry.xp[index], (entry) => entry.levels[index]));
  });
  for (const activity of ACTIVITIES) {
    tables.set(`activity:${activity.key}`, ranked(entries, (entry) => entry.activities[activity.key]));
  }
  const monsters = new Map();
  for (const entry of entries) {
    for (const [monster, kills] of Object.entries(entry.kills)) monsters.set(monster, (monsters.get(monster) ?? 0) + kills);
  }
  for (const monster of monsters.keys()) {
    tables.set(`kills:${monster.toLowerCase()}`, ranked(entries, (entry) => entry.kills[monster] ?? 0));
  }
  return {
    entries,
    skillNames,
    tables,
    /** Monster names, most killed first. */
    monsters: [...monsters.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name),
    byName: new Map(entries.map((entry) => [entry.name.toLowerCase(), entry])),
    modeTables: new Map(),
  };
}

/** A table for everyone ("all") or for one mode, where ranks count that mode's players only. */
function tableFor(board, tableKey, mode = "all") {
  const table = board.tables.get(tableKey);
  if (!table || mode === "all") return table;
  if (!MODES.includes(mode)) return undefined;
  const cacheKey = `${mode}|${tableKey}`;
  if (!board.modeTables.has(cacheKey)) board.modeTables.set(cacheKey, table.filter((entry) => entry.mode === mode));
  return board.modeTables.get(cacheKey);
}

/** What a table row shows for an entry: [level or null, score]. */
function scoreOf(board, tableKey, entry) {
  const [kind, name] = [tableKey.slice(0, tableKey.indexOf(":")), tableKey.slice(tableKey.indexOf(":") + 1)];
  if (kind === "skill") {
    if (name === "overall") return [entry.totalLevel, entry.totalXp];
    const index = board.skillNames.findIndex((skill) => skill.toLowerCase() === name);
    return [entry.levels[index], entry.xp[index]];
  }
  if (kind === "activity") return [null, entry.activities[name]];
  const monster = Object.keys(entry.kills).find((kill) => kill.toLowerCase() === name);
  return [null, monster ? entry.kills[monster] : 0];
}

const rowOf = (board, tableKey, entry, rank, online) => {
  const [level, score] = scoreOf(board, tableKey, entry);
  return { rank, name: entry.name, rights: entry.rights, mode: entry.mode, dead: entry.dead, online: online.has(entry.name.toLowerCase()), level, score };
};

/** One page of a table, or the page a player is on when `find` names one who is ranked in it. */
function page(board, tableKey, { mode = "all", page: wanted = 1, find, online = new Set() } = {}) {
  const table = tableFor(board, tableKey, mode);
  if (!table) return undefined;
  const pages = Math.max(1, Math.ceil(table.length / PAGE_SIZE));
  let number = Math.min(pages, Math.max(1, Math.floor(Number(wanted)) || 1));
  const found = find ? table.findIndex((entry) => entry.name.toLowerCase() === String(find).toLowerCase()) : -1;
  if (found >= 0) number = Math.floor(found / PAGE_SIZE) + 1;
  const start = (number - 1) * PAGE_SIZE;
  return {
    table: tableKey,
    mode,
    page: number,
    pages,
    total: table.length,
    rows: table.slice(start, start + PAGE_SIZE).map((entry, index) => rowOf(board, tableKey, entry, start + index + 1, online)),
  };
}

/** Everything about one player: each skill and activity with its rank, and their kill counts. */
function profile(board, name, online = new Set()) {
  const entry = board.byName.get(String(name ?? "").trim().toLowerCase());
  if (!entry) return undefined;
  const rankIn = (tableKey) => {
    const index = board.tables.get(tableKey)?.indexOf(entry) ?? -1;
    return index < 0 ? null : index + 1;
  };
  return {
    name: entry.name,
    rights: entry.rights,
    mode: entry.mode,
    dead: entry.dead,
    online: online.has(entry.name.toLowerCase()),
    combat: entry.combat,
    overall: { rank: rankIn("skill:overall"), level: entry.totalLevel, score: entry.totalXp },
    skills: board.skillNames.map((skill, index) => ({ name: skill, rank: rankIn(`skill:${skill.toLowerCase()}`), level: entry.levels[index], score: entry.xp[index] })),
    activities: ACTIVITIES.map((activity) => ({ key: activity.key, name: activity.name, rank: rankIn(`activity:${activity.key}`), score: entry.activities[activity.key] })),
    kills: Object.entries(entry.kills)
      .map(([monster, kills]) => ({ name: monster, rank: rankIn(`kills:${monster.toLowerCase()}`), score: kills }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
  };
}

/** Whether a save's name (or its database key) is one of those bots': told without reading the save. */
const isBotName = (name) => BOT_NAME.test(String(name ?? ""));

module.exports = { ACTIVITIES, MODES, MODE_LABELS, PAGE_SIZE, entryFromSave, buildBoard, tableFor, page, profile, combatLevel, isBotName };
