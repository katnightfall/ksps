// Fixture for tests/plugin-references.test.cjs (scripts/scan-member-refs.cjs): never loaded as a plugin.
// It is read as if it sat at plugins/skills/hunter/ZzFixture.js, beside the Hunter modules it requires.
// Every name that starts GONE_ (and the few other lines marked MISS) does not exist on the object it is
// read from; GONE_GUARDED is read with a fallback, and GONE_SHADOWED from a local object of the same name.
"use strict";
const C = require("./Context.Hunter"), { H } = C;
const Catching = require("./Catching.Hunter");
const { ItemIdentifiers } = require("../../../src/main/typescript/elvarg/util/ItemIdentifiers");
const Missing = require("./NoSuchFile.Hunter"); // MISS require
const { noSuchExport, available } = require("./Context.Hunter"); // MISS noSuchExport
let Items = null;
let lateCore;
const NAMES = ["COINS", "GONE_LIST_ITEM"]; // MISS GONE_LIST_ITEM
const itemId = (name) => H.core.ItemIdentifiers[name];
function lookupNpc(key) {
  const id = H.core.NpcIdentifiers[key];
  if (!Number.isInteger(id)) throw new Error("bad " + key);
  return id;
}
function items() { return H.core.ItemIdentifiers; }
module.exports = {
  name: "ZzFixture",
  register(api) {
    const core = api.core;
    Items = core.ItemIdentifiers;
    lateCore = api.core;
    const { NpcIdentifiers: N, Skill, ObjectIdentifiers } = api.core;
    const { COINS, GONE_DESTRUCTURED } = core.ItemIdentifiers; // MISS GONE_DESTRUCTURED
    const a = ItemIdentifiers.GONE_DIRECT; // MISS
    const b = api.core.ItemIdentifiers.GONE_API_CORE; // MISS
    const c = N.GONE_NPC_ALIAS; // MISS
    const d = ObjectIdentifiers["GONE_OBJECT_STRING"]; // MISS
    const e = H.core.ItemIdentifiers.GONE_H_CORE; // MISS
    const f = Items.GONE_LATE_ASSIGN; // MISS
    const g = items().GONE_VIA_FUNCTION; // MISS
    const h = itemId("GONE_LOOKUP_ARROW"); // MISS
    const i = lookupNpc("GONE_LOOKUP_FN"); // MISS
    const j = NAMES.map((n) => Items[n]);
    const k = Skill.NOT_A_SKILL; // MISS
    const l = core.NotAThing.x; // MISS
    const m = C.noSuchFunction(1); // MISS
    const n = Catching.alsoNotThere; // MISS
    api.onNoSuchHook(() => {}); // MISS
    const o = core.Misc.noSuchHelper(3); // MISS
    const p = lateCore.TimerKey.NOPE; // MISS
    const q = Items.GONE_GUARDED ?? 5; // GUARDED
    const r = Items.COINS + N.HANS + Skill.ATTACK + C.available; // OK
    const s = ["COINS", "GONE_INLINE_LIST"].map((x) => N[x]); // MISS both (COINS is not an NPC)
    for (const t of [1]) { const Items = { GONE_SHADOWED: 1 }; void Items.GONE_SHADOWED; } // OK (shadowed)
    api.onCustomEvent("x:y", (event) => { const z = api.core.ItemIdentifiers.GONE_IN_CALLBACK; }); // MISS
    function inner(core) { return core.ItemIdentifiers.GONE_PARAM_CORE + core.Skill.ATTACK; } // MISS
    const u = { v: Items.GONE_IN_OBJECT_LITERAL, [Items.GONE_COMPUTED_KEY]: 1 }; // MISS x2
    switch (a) { case Items.GONE_CASE_LABEL: break; } // MISS
    const w = `${Items.GONE_TEMPLATE}`; // MISS
    const x = [Items.GONE_SPREAD_ARG, ...[N.GONE_SPREAD]]; // MISS x2
    const y = new Map([[Items.GONE_MAP_KEY, 1]]); // MISS
    const cls = class { m() { return this.core.ItemIdentifiers.GONE_THIS_CORE + this.core.Skill.ATTACK; } }; // MISS
  },
};
