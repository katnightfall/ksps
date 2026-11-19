"use strict";

/**
 * What a PvP death makes of the crystal equipment that has no Revert code of its own to ask: the crystal bow, shield
 * and halberd, and the crystal tools (docs/items-kept-on-death.md). Crystal armour answers in CrystalArmour.plugin.js
 * (the seeds its Revert gives back), the Blade of Saeldor and Bow of Faerdhinen in CrystalWeapon.js.
 *
 * - Crystal bow, shield and halberd, active, inactive and the older staged ones ("Crystal bow 7/10", their (i)
 *   forms): the killer gets a crystal weapon seed. Wiki, Crystal equipment: "Upon death in the Wilderness, the
 *   killer will receive the seed form of the crystal equipment"; Crystal bow, Crystal shield (Changes): "Crystal
 *   equipment now reverts to a seed when dropped on death."
 * - Crystal axe, pickaxe and harpoon: the killer gets the dragon tool. Wiki, each tool's page: "A dangerous death in
 *   PvP causes the crystal [tool] to revert to a dragon [tool], which will then be dropped for the killer. All
 *   crystal shards will be lost should this happen." The crystal tool seed is not named there, so it is gone with
 *   the shards.
 * - Ours (the Wiki's Crystal felling axe page has no death rule): the crystal felling axe is lost as the other
 *   crystal tools are, as a dragon felling axe ("the standard process of reverting crystal to dragon does apply").
 *
 * The charges, the shards that bought them and an (i) form's imbue go with the item. The Gauntlet's own crystal
 * equipment never leaves the Gauntlet and is not listed.
 */
// Ours (upstream issue #6002): before this every one of these came back whole to whoever died with it, skulled or not.

/** The staged forms of the older crystal equipment, as the cache names them. */
const STAGES = ["new", "1000", "900", "800", "700", "600", "500", "400", "300", "200", "100"];
const CURRENT_FORMS = ["", "_2500", "_inactive"];
/** Cache names of what reverts to a crystal weapon seed. */
const SEED_EQUIPMENT = [
  ...["crystal_bow", "crystal_shield", "crystal_halberd"].flatMap((name) => CURRENT_FORMS.map((form) => `${name}${form}`)),
  ...["roving_crystal_bow", "nzone_crystal_bow", "roving_crystal_shield", "nzone_crystal_shield", "crystal_halberd", "nzone_crystal_halberd"]
    .flatMap((name) => STAGES.map((stage) => `${name}_${stage}`)),
];
/** Crystal tool (cache name) -> the dragon tool it was sung from (cache name). */
const TOOLS = {
  crystal_axe: "dragon_axe",
  crystal_pickaxe: "dragon_pickaxe",
  crystal_harpoon: "dragon_harpoon",
  crystal_axe_2h: "dragon_axe_2h",
};

let core = null;
/** Item id -> the item id its killer gets. */
const lostAs = new Map();

function load() {
  const obj = (name) => {
    const id = core.CacheDefinitions.getObjId(name);
    if (id == null) throw new Error(`CrystalEquipmentDeath: the cache has no item named ${name}`);
    return id;
  };
  lostAs.clear();
  const seed = core.ItemIdentifiers.CRYSTAL_WEAPON_SEED;
  for (const name of SEED_EQUIPMENT) lostAs.set(obj(name), seed);
  for (const [tool, dragon] of Object.entries(TOOLS)) {
    lostAs.set(obj(tool), obj(dragon));
    lostAs.set(obj(`${tool}_inactive`), obj(dragon));
  }
}

/** The item a PvP death leaves the killer for this copy, or null: a preset copy is deleted by the death as it is. */
function lostToKillerAs(item) {
  if (!core || !item || item.isPresetItem?.() === true || item.isUntradeable?.() === true) return null;
  return lostAs.get(item.getId?.()) ?? null;
}

/** `player-death:pvp-item-parts` (PlayerDeathTask, asked for the items a PvP death does not protect). */
function revertOnPvpDeath(query) {
  // A bot's kit is not loot (DeathLoot.PlayerBots decides what its death gives).
  if (!query?.item || query.parts || query.player?.isPlayerBot?.() === true) return;
  const id = lostToKillerAs(query.item);
  if (id == null) return;
  // A new item: the charges the old one carried are not the seed's or the dragon tool's.
  query.parts = [new core.Item(id, 1)];
}

/** `items:lost-to-pvp-killer` { item, wildernessLevel, lost }: the Items Kept on Death screen's PvP preview. */
function answerLostToPvpKiller(query) {
  if (lostToKillerAs(query?.item) != null) query.lost = true;
}

module.exports = {
  name: "CrystalEquipmentDeath",
  description: "Crystal bow, shield, halberd and tools lost to a PvP death: the killer gets the crystal weapon seed, or the dragon tool, and the charges are gone.",
  members: true,
  _test: { lostAs, lostToKillerAs, SEED_EQUIPMENT, TOOLS },
  register(api) {
    core = api.core;
    load();
    api.onCustomEvent("player-death:pvp-item-parts", revertOnPvpDeath);
    api.onCustomEvent("items:pvp-death-parts-preview", revertOnPvpDeath);
    api.onCustomEvent("items:lost-to-pvp-killer", answerLostToPvpKiller);
  },
};
