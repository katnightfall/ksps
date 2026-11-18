/**
 * Ours: the "Search for traps" thieving chests that nothing answered (OSRS Wiki audit, pass 2). Each is a cache loc
 * named "Chest" with the options Open and Search for traps; a click on either did nothing at all.
 *
 * Wiki: https://oldschool.runescape.wiki/w/Chest_(10_coins), /w/Chest_(nature_runes), /w/Chest_(50_coins),
 * /w/Chest_(steel_arrowtips), /w/Chest_(Chaos_Druid_Tower) and the chest table of /w/Thieving. Level, experience
 * and loot are the same on a chest's own page and in the Thieving table:
 *
 * | Chest | Loc (cache name) | Thieving | XP | Loot | Looted for |
 * | --- | --- | --- | --- | --- | --- |
 * | 10 coins | 11735 (trapchest1) | 13 | 7.8 | 10 coins | 7 s |
 * | Nature rune | 11736 (trapchest2) | 28 | 25 | 1 nature rune, 3 coins | 15 s |
 * | 50 coins | 11737 (trapchest3) | 43 | 125 | 50 coins | 50 s |
 * | Steel arrowtips | 11742 (pickchest3) | 47, a lockpick | 150 | 5 steel arrowtips, 20 coins | 90 s |
 * | Blood rune (Chaos Druid Tower) | 11738 (trapchest4) | 59 | 250 | 2 blood runes, 500 coins | 135 s |
 *
 * "Looted for" is each chest's own page ("will lock themselves after 7 seconds", "... 15 seconds", "... 50 seconds",
 * "remain looted for 90 seconds", "respawn once every 135 seconds"). The Thieving table gives shorter times for the
 * same chests (3.5, 8, 45, 75 and 120 seconds); the Hemenster chest already used its page's 90 seconds, so the pages
 * are followed. A looted chest is the cache's empty chest (emptytrapchest 11740, emptypickchest 11741) for everyone.
 *
 * Open without searching (Wiki, Thieving: "the player will attempt to open the chest and take damage; this damage
 * scales off of your current health"): the nature rune chest's page gives floor(current Hitpoints x 12 / 100) + 3 and
 * the Chaos Druid Tower's (9 x Hitpoints + 225) / 50 ("up to 22"). The 10 and 50 coin chests' pages say only
 * "substantial damage" and the arrowtips chest's page names none, so Open on those three is left unanswered.
 *
 * The Chaos Druid Tower chest (Wiki): "Once looted, a second magical trap will be triggered, teleporting the player
 * to the house located west of Elena in East Ardougne" (the page's map pin: 2584,3337).
 *
 * The timeline, lines, animations and sounds are the Rogues' Castle chest's, the one captured "Search for traps"
 * chest (rsprox 462 and 463, see items/WildernessChests.plugin.js): on the click "You search the chest for traps."
 * and "You find a trap on the chest." (human_lockedchest); 2 ticks on "You disable the trap." (sound 2402); 4 on "You
 * open the chest." (sound 52); 6 on the loot (human_openchest), the experience and the chest emptied. Open: "You have
 * activated a trap on the chest." (sound 2400) and the hit a tick later (sound 518).
 *
 * Ours (no capture of these five chests, nothing on the Wiki): the loot line ("You find treasure inside!", the
 * Dorgesh-Kaan chests' captured line), the second trap's line, the level, lockpick, full-inventory and looted-chest
 * refusals (the Rogues' Castle and Dorgesh-Kaan chests' wording), and the level being the current (boostable) one.
 * A search always succeeds: no page gives a failure chance. Not done: Rocky (the pet) from these chests.
 *
 * The Hemenster arrowtips chest (2639,3424) stays the Kandarin diary's (KandarinDiaryFinish.AchievementDiaries.js),
 * which gives the same loot and experience and credits its task; the Ardougne Castle chest (11739) is its diary's too.
 */
const TICK = Object.freeze({ DISABLE: 2, OPEN: 4, LOOT: 6 });
const SOUND = Object.freeze({ TRAP: 2400, TRAP_HIT: 518, DISABLE: 2402, OPEN: 52 });
const MESSAGE = Object.freeze({
  SEARCH: "You search the chest for traps.",
  FOUND: "You find a trap on the chest.",
  DISABLE: "You disable the trap.",
  OPEN: "You open the chest.",
  LOOT: "You find treasure inside!",
  TRAP: "You have activated a trap on the chest.",
  SECOND_TRAP: "Suddenly a second magical trap triggers.",
  LEVEL: (level) => `You need a Thieving level of at least ${level} to steal from this chest.`,
  LOCKPICK: "You need a lockpick to open this chest.",
  ROOM: "You need more inventory space for the loot.",
  LOOTED: "It looks like this chest has already been looted.",
});
/** 0.6 seconds a tick. */
const seconds = (count) => Math.round(count / 0.6);

/**
 * One row a kind of chest: `closed` and `empty` are cache loc names, `loot` rows are [ItemIdentifiers key, amount],
 * `trap(hitpoints)` the damage Open deals, `teleport` where the second trap sends the looter, `except` the
 * placements another plugin owns.
 */
const KINDS = Object.freeze([
  { key: "10-coins", closed: "trapchest1", empty: "emptytrapchest", level: 13, xp: 7.8, respawnTicks: seconds(7), loot: [["COINS", 10]] },
  {
    key: "nature-rune", closed: "trapchest2", empty: "emptytrapchest", level: 28, xp: 25, respawnTicks: seconds(15),
    loot: [["NATURE_RUNE", 1], ["COINS", 3]], trap: (hitpoints) => Math.floor(hitpoints * 12 / 100) + 3,
  },
  { key: "50-coins", closed: "trapchest3", empty: "emptytrapchest", level: 43, xp: 125, respawnTicks: seconds(50), loot: [["COINS", 50]] },
  {
    key: "steel-arrowtips", closed: "pickchest3", empty: "emptypickchest", level: 47, xp: 150, respawnTicks: seconds(90), lockpick: true,
    loot: [["STEEL_ARROWTIPS", 5], ["COINS", 20]], except: [[2639, 3424, 0]],
  },
  {
    key: "blood-rune", closed: "trapchest4", empty: "emptytrapchest", level: 59, xp: 250, respawnTicks: seconds(135),
    loot: [["BLOOD_RUNE", 2], ["COINS", 500]], trap: (hitpoints) => Math.floor((9 * hitpoints + 225) / 50),
    teleport: [2584, 3337, 0],
  },
]);

let api;
let core;
let ids = null;
/** Looted chests: closed object -> the empty one standing in for it. */
const looted = new WeakMap();
/** Empty chest objects on the map, so a click on one is known to be ours. */
const empties = new WeakSet();
/** player -> the search under way. */
const busy = new WeakMap();

function resolveIds() {
  if (ids) return ids;
  const cache = core.CacheDefinitions;
  ids = { kinds: new Map(), lockedChest: cache.getSeqId("human_lockedchest"), openChest: cache.getSeqId("human_openchest") };
  for (const kind of KINDS) ids.kinds.set(cache.getLocId(kind.closed), { kind, empty: cache.getLocId(kind.empty) });
  return ids;
}

/** The kind of chest `object` is, or null: not one of these, or a placement another plugin owns. */
function entryFor(object) {
  const entry = resolveIds().kinds.get(object.getId());
  if (!entry) return null;
  const at = object.getLocation();
  const owned = entry.kind.except?.some(([x, y, z]) => at.getX() === x && at.getY() === y && at.getZ() === z);
  return owned ? null : entry;
}

const alive = (player) => player.isRegistered?.() !== false && player.getHitpoints?.() > 0;

function stillThere(player, start) {
  const at = player.getLocation();
  return alive(player) && at.getX() === start.getX() && at.getY() === start.getY() && at.getZ() === start.getZ();
}

function later(player, ticks, action) {
  core.TaskManager.submit(new core.CountdownTask(player, ticks, action));
}

function lootItems(kind) {
  return kind.loot.map(([key, amount]) => new core.Item(core.ItemIdentifiers[key], amount));
}

/** Every item fits: a stack it joins, or a free slot each (all the loot here stacks). */
function hasRoom(player, items) {
  const inventory = player.getInventory();
  const newStacks = items.filter((item) => inventory.getAmount(item.getId()) === 0).length;
  return inventory.getFreeSlots() >= newStacks && items.every((item) => inventory.getAddableAmount(item) >= item.getAmount());
}

/** The chest shows empty for everyone until its loot is back. */
function empty(object, entry) {
  if (looted.has(object)) return;
  const shown = new core.GameObject(entry.empty, object.getLocation().clone(), object.getType(), object.getFace(), object.getPrivateArea());
  looted.set(object, shown);
  empties.add(shown);
  core.ObjectManager.deregister(object, true);
  core.ObjectManager.register(shown, true);
  core.TaskManager.submit(new core.CountdownTask(object, entry.kind.respawnTicks, () => {
    looted.delete(object);
    core.ObjectManager.deregister(shown, true);
    core.ObjectManager.register(object, true);
  }));
}

function refusal(player, kind) {
  if (player.getSkillManager().getCurrentLevel(core.Skill.THIEVING) < kind.level) return MESSAGE.LEVEL(kind.level);
  if (kind.lockpick && !player.getInventory().contains(core.ItemIdentifiers.LOCKPICK)) return MESSAGE.LOCKPICK;
  if (!hasRoom(player, lootItems(kind))) return MESSAGE.ROOM;
  return null;
}

function giveLoot(player, object, entry) {
  const { kind } = entry;
  const inventory = player.getInventory();
  for (const item of lootItems(kind)) inventory.add(item, false);
  inventory.refreshItems();
  player.sendMessage(MESSAGE.LOOT);
  player.performAnimation(new core.Animation(resolveIds().openChest));
  player.getSkillManager().addExperiences(core.Skill.THIEVING, kind.xp);
  empty(object, entry);
  api.emitCustomEvent("thieving:success", { player, skill: core.Skill.THIEVING, method: "chest", target: `${kind.key} chest` });
  api.emitCustomEvent("chest:opened", { player, objectId: object.getId() });
  if (kind.teleport) {
    player.sendMessage(MESSAGE.SECOND_TRAP);
    player.moveTo(new core.Location(...kind.teleport));
  }
}

function searchForTraps(event) {
  const { player, object } = event;
  if (!player || !object) return false;
  if (empties.has(object)) {
    player.sendMessage(MESSAGE.LOOTED);
    return true;
  }
  const entry = entryFor(object);
  if (!entry) return false;
  if (busy.has(player) || looted.has(object)) return true;
  const refused = refusal(player, entry.kind);
  if (refused) {
    player.sendMessage(refused);
    return true;
  }
  const start = player.getLocation().clone();
  const sequence = { start };
  busy.set(player, sequence);
  const step = (ticks, action) => later(player, ticks, () => {
    if (busy.get(player) !== sequence) return;
    if (!stillThere(player, start) || looted.has(object)) {
      busy.delete(player);
      return;
    }
    action();
  });

  player.setPositionToFace(object.getLocation());
  player.sendMessage(MESSAGE.SEARCH);
  player.sendMessage(MESSAGE.FOUND);
  player.performAnimation(new core.Animation(resolveIds().lockedChest));
  step(TICK.DISABLE, () => {
    player.sendMessage(MESSAGE.DISABLE);
    player.getPacketSender().sendSound(SOUND.DISABLE, 10, 0);
  });
  step(TICK.OPEN, () => {
    player.sendMessage(MESSAGE.OPEN);
    player.performAnimation(new core.Animation(resolveIds().lockedChest));
    player.getPacketSender().sendSound(SOUND.OPEN, 10, 0);
  });
  step(TICK.LOOT, () => {
    busy.delete(player);
    // Checked again as it lands: the lockpick and the room may have gone in the meantime.
    if (refusal(player, entry.kind)) return;
    giveLoot(player, object, entry);
  });
  return true;
}

/** Open without searching: the trap, where the Wiki gives its damage. */
function open(event) {
  const { player, object } = event;
  if (!player || !object) return false;
  const entry = entryFor(object);
  if (!entry?.kind.trap) return false;
  if (busy.has(player)) return true;
  player.setPositionToFace(object.getLocation());
  player.sendMessage(MESSAGE.TRAP);
  player.performAnimation(new core.Animation(resolveIds().lockedChest));
  player.getPacketSender().sendSound(SOUND.TRAP, 10, 0);
  later(player, 1, () => {
    if (!alive(player)) return;
    const damage = entry.kind.trap(player.getHitpoints());
    player.getCombat().getHitQueue().addPendingDamage([new core.HitDamage(damage, core.HitMask.RED)]);
    player.getPacketSender().sendSound(SOUND.TRAP_HIT, 10, 20);
  });
  return true;
}

module.exports = function attach(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  ids = null;
  pluginApi.onObjectInteraction("Chest", { Open: open, "Search for traps": searchForTraps });
};
module.exports._test = { KINDS, TICK, MESSAGE, looted, busy, resolveIds, refusal, searchForTraps, open };
