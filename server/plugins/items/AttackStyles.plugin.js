/**
 * Attack styles: a rule of our world, not of OSRS. Some weapons train differently here than in
 * the real game.
 *
 * What a style trains comes from data/definitions/item-combat-styles.json, but that file is
 * made from the game cache and checked against it, so our changes are made here instead, once
 * the styles are loaded. A style is one of a weapon type's slots, shared by every weapon of the
 * type: SCYTHE_JAB is the Jab of every scythe, the Scythe of vitur in all its forms included.
 *
 * To change another, add its key in item-combat-styles.json ("fightTypes") to STYLES below with
 * ACCURATE (Attack XP), AGGRESSIVE (Strength), DEFENSIVE (Defence) or CONTROLLED (shared).
 * The style also sets the small level bonus a swing gets, as in OSRS: a shared style gives +1
 * to Attack, Strength and Defence where an aggressive one gives +3 Strength.
 *
 * The Combat Options tab says what each style trains ("(Aggressive) (Crush) (Strength XP)")
 * from the cache too: the weapon type's row of table 78, combat_interface_weapon_category. So
 * each player is sent that row with our wording at login, which their client reads in place of
 * the cache's (a "dbRowOverrides" row; GamemodeContentStore on the client). The client keeps
 * one set of such rows, replaced whole by whoever sends next: a league character's set is
 * joined here ("league:content-rows"), not replaced.
 */
const STYLES = {
  // Jab trains Attack, Strength and Defence together (it was Strength only).
  SCYTHE_JAB: "CONTROLLED",
};

/** What the Combat Options tab calls a kind of style, and the XP it names. */
const WORDING = {
  ACCURATE: ["Accurate", "Attack XP"],
  AGGRESSIVE: ["Aggressive", "Strength XP"],
  DEFENSIVE: ["Defensive", "Defence XP"],
  CONTROLLED: ["Controlled", "Shared XP"],
};
/** combat_interface_weapon_category: a weapon type's number (column 0) and its styles (column 1). */
const STYLE_TABLE = 78;
const CATEGORY_COLUMN = 0;
const STYLES_COLUMN = 1;
/** A style in column 1 is four values: its slot, its name, its description and its picture. */
const STYLE_FIELDS = 4;

let core;
/** The rows to send, made once the cache is there to read; null until then. */
let tooltipRows = null;

/** "(Aggressive)<br>(Crush)<br>(Strength XP)" with its first and last parts changed for `kind`. */
function describe(description, kind) {
  const [label, xp] = WORDING[kind];
  const parts = String(description).split("<br>");
  if (parts.length < 2) return `(${label})<br>(${xp})`;
  parts[0] = `(${label})`;
  parts[parts.length - 1] = `(${xp})`;
  return parts.join("<br>");
}

/**
 * The cache rows of the weapon types whose styles we changed, with our wording in them. A row is
 * sent whole: every column the cache row has, the description of each changed style rewritten.
 * `definitions` is item-combat-styles.json and `tableRows` the cache's rows of table 78.
 */
function buildTooltipRows(definitions, tableRows, styles = STYLES) {
  const rows = new Map();
  for (const [key, kind] of Object.entries(styles)) {
    const fightType = definitions.fightTypes?.[key];
    const category = Object.values(definitions.weaponInterfaces ?? {}).find((weapon) => weapon.fightTypes?.includes(key))?.category;
    const source = tableRows.find((row) => row.column(CATEGORY_COLUMN)[0] === category);
    if (!fightType || !WORDING[kind] || !source) continue;
    const row = rows.get(source.id) ?? {
      rowId: source.id,
      tableId: STYLE_TABLE,
      columns: Object.fromEntries([...source.columns].map(([column, values]) => [String(column), [...values]])),
    };
    const values = row.columns[String(STYLES_COLUMN)] ?? [];
    for (let at = 0; at + STYLE_FIELDS <= values.length; at += STYLE_FIELDS) {
      if (values[at] === fightType.childId && values[at + 1] === fightType.name) values[at + 2] = describe(values[at + 2], kind);
    }
    rows.set(source.id, row);
  }
  return [...rows.values()];
}

function rowsToSend() {
  if (tooltipRows === null) {
    try {
      tooltipRows = buildTooltipRows(require("../../data/definitions/item-combat-styles.json"), core.CacheDefinitions.getDbTableRows(STYLE_TABLE));
    } catch (error) {
      console.warn("[attack-styles] the Combat Options wording could not be made; the tab keeps the cache's", error);
      tooltipRows = [];
    }
  }
  return tooltipRows;
}

function sendTooltips({ player, profile }) {
  // Bots have no client, and a league character's rows go with the league's own set (below).
  if (!player || player.isPlayerBot?.() === true || profile === "league") return;
  const rows = rowsToSend();
  if (rows.length > 0) player.getPacketSender().sendContentData("server", [{ key: "dbRowOverrides", rows }]);
}

module.exports = {
  name: "AttackStyles",
  description: "Changes what some weapons' attack styles train on this world, and says so in the Combat Options tab: the scythes' Jab gives shared XP (Attack, Strength and Defence) instead of Strength.",
  register(api) {
    core = api.core;
    const { FightType, FightStyle } = core;
    for (const [key, style] of Object.entries(STYLES)) {
      const fightType = FightType[key];
      const fightStyle = FightStyle[style];
      if (!fightType || !fightStyle) {
        console.warn(`[attack-styles] ${key}: no such style or kind (${style}); left as it is`);
        continue;
      }
      // FightType keeps its style in a field it only reads (getStyle).
      fightType.style = fightStyle;
    }
    api.onPlayerLogin?.(sendTooltips);
    api.onCustomEvent?.("league:content-rows", (query) => {
      if (Array.isArray(query?.dbRows)) query.dbRows.push(...rowsToSend());
    });
  },
  _test: { STYLES, buildTooltipRows, describe, sendTooltips },
};
