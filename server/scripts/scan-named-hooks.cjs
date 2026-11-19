// Hooks registered by name or by id against what the cache has.
//
// api.onObjectInteraction("Church organ", { Play: fn }) is matched when a player clicks: the loc's
// name must equal "Church organ" exactly and the clicked option must be "Play". Nothing checks either
// at load, so a name the cache spells differently (or renamed in a cache move), or an option the loc
// does not have, is a handler that never runs. The same holds for NPC and item names, and an id list
// with `undefined` in it (a constant that no longer exists) or an id past the cache's end.
//
// This loads every plugin with the registration calls recorded, then checks each recorded name,
// option and id against the definitions the server serves (cache, seasonal archives, custom items).
//
// A line that registers several names or several options is judged as a whole: an option none of its
// names has is dead ("option"), one that is only spare beside others that match is listed with --all.
// Seasonal content whose definitions are loaded only in season shows up here out of season.
//
// Usage (after `yarn build`, from server/): node scripts/scan-named-hooks.cjs [--all]
// tests/plugin-references.test.cjs holds it at its list of known ones.
"use strict";
const path = require("node:path");

const BY_ID = {
  onObjectClick: "object", onObjectFirstClick: "object", onObjectSecondClick: "object", onObjectThirdClick: "object",
  onObjectFourthClick: "object", onObjectFifthClick: "object", setDeckReach: "object",
  onNpcClick: "npc", onNpcFirstClick: "npc", onNpcSecondClick: "npc", onNpcThirdClick: "npc", onNpcFourthClick: "npc",
  registerNpcInteraction: "npc", registerNpcCombatMethodProvider: "npc",
  onGroundItemClick: "item", onItemFirstAction: "item",
};

/** Records the registrations made through every plugin api created after this call. */
function recordRegistrations(PluginManager, serverDir) {
  const records = [];
  const original = PluginManager.createApi;
  const pluginsDir = path.join(serverDir, "plugins") + path.sep;
  const site = () => {
    const frame = new Error().stack.split("\n").slice(3).find((line) => line.includes(pluginsDir));
    const m = frame && /([^\\/()]+[\\/]plugins[\\/].*?):(\d+):\d+\)?$/.exec(frame.trim());
    return m ? m[1].replace(/\\/g, "/").replace(/^.*?\/plugins\//, "plugins/") + ":" + m[2] : "?";
  };
  const optionNames = (actions) => (actions && typeof actions === "object" ? Object.keys(actions).filter((k) => typeof actions[k] === "function") : []);
  PluginManager.createApi = function createApi(pluginName, ...rest) {
    const api = original.call(this, pluginName, ...rest);
    const wrapped = { ...api };
    const wrap = (method, record) => {
      if (typeof api[method] !== "function") return;
      wrapped[method] = function (...args) {
        try { const r = record(args); if (r) for (const one of [].concat(r)) records.push({ plugin: pluginName, method, site: site(), ...one }); } catch { /* never get in a plugin's way */ }
        return api[method].apply(api, args);
      };
    };
    wrap("onObjectInteraction", ([name, actions]) => typeof name === "string" && { kind: "object", names: [name], options: optionNames(actions) });
    wrap("onNpcInteraction", ([name, actions]) => typeof name === "string" && { kind: "npc", names: [name], options: optionNames(actions) });
    wrap("onNpcsInteraction", ([names, actions]) => Array.isArray(names) && { kind: "npc", names: names.slice(), options: optionNames(actions) });
    wrap("onAnyNpcInteraction", ([actions]) => ({ kind: "npc", names: null, options: optionNames(actions) }));
    wrap("onItemAction", ([name, actions]) => typeof name === "string" && { kind: "item", names: [name], options: optionNames(actions) });
    wrap("onItemOnObject", ([item, object]) => typeof item === "string" && [{ kind: "item", names: [item], options: [] }, { kind: "object", names: [object], options: [] }]);
    wrap("onItemOnItem", ([a, b]) => typeof a === "string" && { kind: "item", names: [a, b], options: [] });
    wrap("setUsableFromDeck", ([list]) => Array.isArray(list) && { kind: "object", names: list.filter((e) => typeof e === "string"), options: [], ids: list.filter((e) => typeof e !== "string") });
    for (const [method, kind] of Object.entries(BY_ID)) {
      wrap(method, ([ids]) => (typeof ids === "function" || (ids && typeof ids === "object" && !Array.isArray(ids)) ? null : { kind, ids: [].concat(ids) }));
    }
    return Object.isFrozen(api) ? Object.freeze(wrapped) : wrapped;
  };
  return { records, restore: () => { PluginManager.createApi = original; } };
}

/** name -> the options any definition of that name has, for locs, NPCs and items as the server serves them. */
function definitionIndex(core) {
  const counts = core.CacheDefinitions.getCounts();
  const index = { object: new Map(), npc: new Map(), item: new Map(), counts: { object: counts.objects, npc: counts.npcs, item: counts.items } };
  const add = (map, name, options) => {
    if (typeof name !== "string" || !name || name === "null") return;
    let set = map.get(name);
    if (!set) { set = new Set(); map.set(name, set); }
    for (const option of options ?? []) if (typeof option === "string" && option) set.add(option);
  };
  // The cache types themselves, as the hooks compare them at click time (ObjectDefinition and
  // NpcDefinition copy name and actions from these; item actions are read from the cache type).
  const C = core.CacheDefinitions;
  for (let id = 0; id < counts.objects; id++) {
    let d; try { d = C.getObject(id); } catch { continue; }
    if (d) add(index.object, d.name, d.actions);
  }
  for (let id = 0; id < counts.npcs; id++) {
    let d; try { d = C.getNpc(id); } catch { continue; }
    if (d) add(index.npc, d.name, d.actions);
  }
  for (let id = 0; id < counts.items; id++) {
    let d; try { d = C.getItem(id); } catch { continue; }
    if (!d) continue;
    const extra = [];
    // worn options (params 451..458) and the sub-options of an inventory option, as PluginManager.itemActionOption reads them
    for (let p = 451; p <= 458; p++) { const v = d.params?.get?.(p); if (typeof v === "string") extra.push(v); }
    for (const sub of d.subops ?? []) for (const text of sub ?? []) if (typeof text === "string") extra.push(text);
    add(index.item, d.name, [...(d.inventoryActions ?? []), ...extra]);
  }
  return index;
}

function check(records, index) {
  const findings = [];
  const stats = { registrations: records.length, names: 0, options: 0, ids: 0 };
  const allOptions = { object: new Set(), npc: new Set(), item: new Set() };
  for (const kind of ["object", "npc", "item"]) for (const set of index[kind].values()) for (const o of set) allOptions[kind].add(o);
  // One line of a plugin often registers a whole list of names with one table of options (every kind
  // of door with Open and Close): an option counts as dead only when none of that line's names has it.
  const groups = new Map();
  for (const r of records) {
    for (const id of r.ids ?? []) {
      stats.ids++;
      if (!Number.isInteger(id) || id < 0) findings.push({ ...r, problem: "id", detail: `${String(id)} is not an id (a constant that does not exist?)` });
      else if (id >= index.counts[r.kind]) findings.push({ ...r, problem: "id", detail: `${id} is past the last ${r.kind} (${index.counts[r.kind] - 1})` });
    }
    if (r.names === undefined) continue;
    const key = [r.plugin, r.method, r.site, r.kind].join("|");
    let g = groups.get(key);
    if (!g) { g = { ...r, names: r.names === null ? null : new Set(), options: new Set() }; groups.set(key, g); }
    if (g.names && r.names) for (const name of r.names) g.names.add(name);
    for (const option of r.options ?? []) g.options.add(option);
  }
  for (const g of groups.values()) {
    const known = [];
    for (const name of g.names ?? []) {
      stats.names++;
      if (typeof name !== "string" || !index[g.kind].has(name)) {
        const lower = String(name).toLowerCase();
        const near = [...index[g.kind].keys()].find((k) => k.toLowerCase() === lower);
        if (near && g.names.has(near)) continue; // both spellings registered on the same line
        findings.push({ ...g, names: undefined, options: undefined, problem: "name", name, detail: `no ${g.kind} is named ${JSON.stringify(name)}${near ? ` (the cache has ${JSON.stringify(near)})` : ""}` });
      } else known.push(name);
    }
    if (g.names !== null && !known.length) continue;
    const have = g.names === null ? allOptions[g.kind] : new Set(known.flatMap((n) => [...index[g.kind].get(n)]));
    // A table that offers several spellings or several options is fine while one of them can match;
    // `spare` marks an option that can never match beside others that can.
    const anyLive = [...g.options].some((option) => have.has(option));
    for (const option of g.options) {
      stats.options++;
      if (have.has(option)) continue;
      const lower = option.toLowerCase();
      const near = [...have].find((o) => o.toLowerCase() === lower);
      if (near && g.options.has(near)) continue; // both spellings registered on the same line
      const where = g.names === null ? `any ${g.kind}` : known.slice(0, 4).map((n) => JSON.stringify(n)).join(", ") + (known.length > 4 ? ` and ${known.length - 4} more` : "");
      findings.push({ ...g, names: undefined, options: undefined, problem: anyLive ? "spare-option" : "option", name: known[0] ?? null, option,
        detail: `${JSON.stringify(option)} is not an option of ${where}${near ? ` (the cache spells it ${JSON.stringify(near)})` : g.names === null ? "" : ` (options there: ${[...have].slice(0, 12).join(", ") || "none"})`}` });
    }
  }
  return { findings, stats };
}

module.exports = { recordRegistrations, definitionIndex, check };

if (require.main === module) {
  const serverDir = path.resolve(process.argv.find((a) => a.startsWith("--server="))?.slice(9) ?? path.join(__dirname, ".."));
  process.chdir(serverDir);
  process.env.DISABLE_PLAYER_BOTS = "1";
  require(path.join(serverDir, "dist", "Server")).Server.installProductionPathResolver();
  const { PluginManager } = require(path.join(serverDir, "dist", "plugins", "PluginManager"));
  const { CachePipeline } = require(path.join(serverDir, "dist", "game", "cache", "CachePipeline"));
  (async () => {
    const log = console.log;
    console.log = console.info = console.debug = () => {};
    await CachePipeline.initialize(serverDir);
    const { records } = recordRegistrations(PluginManager, serverDir);
    PluginManager.loadFromDirectory(path.join(serverDir, "plugins"));
    const core = PluginManager.getCoreApi();
    const { findings, stats } = check(records, definitionIndex(core));
    console.log = log;
    const all = process.argv.includes("--all");
    for (const f of findings) if (all || f.problem !== "spare-option") console.log(`${f.site}  [${f.problem}] ${f.plugin} ${f.method}: ${f.detail}`);
    console.log(JSON.stringify(stats));
    console.log(["name", "option", "id", "spare-option"].map((p) => `${findings.filter((f) => f.problem === p).length} ${p}`).join(", "));
    process.exit(0);
  })().catch((error) => { console.error(error); process.exit(1); });
}
