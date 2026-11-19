"use strict";

const { sites } = require("./data/enchanted-key.json");
const ORDER_ATTRIBUTE = "enchanted-key:order";
const FOUND_ATTRIBUTE = "enchanted-key:treasures-found";
// rev242 dump.varbit: makinghistory_locstatus (604:21..31), enchantedkey (3403:8..9).
// rsprox1702: each of eleven reward deltas adds its site's bit; final enchantedkey changes 1 -> 2.
const LOCSTATUS_VARBIT = 1391;
const STATUS_VARBIT = 13717;
// rsprox1702 same-tick Feel responses, loops=1/delay=0. The three unobserved
// categories deliberately have no asserted sound policy; gameval names alone do not prove it.
const FEEDBACK = [
  [4, "The key is steaming. It must be right below your feet.", 1201],
  [30, "Ouch! It's burning hot", 1197],
  [60, "It's very hot", null],
  [100, "It's hot", null],
  [400, "It's warm", 1202],
  [700, "It's cold", 1198],
  [1000, "It's very cold", null],
  [Infinity, "It's freezing", 1199],
];
const LAST_DISTANCE = new WeakMap();
/**
 * Ours (upstream issues #5656 and #4289): the quest list has a row of its own for this miniquest (quest table row
 * "The Enchanted Key", type miniquest, end state 2, read from varbit 13717 enchantedkey), and with no quest registered
 * under that name a click on the row opened nothing. It is registered here so the row opens a journal. Its stages
 * follow the route's own state and are never set by hand: 0 until Making History is complete, 1 while treasures remain,
 * 2 once all eleven are dug up. The journal's wording is ours: the Wiki has no journal transcript for this miniquest
 * and no capture of the row was found.
 */
const MINIQUEST_KEY = "the_enchanted_key";
const STAGE_HUNTING = 1;
const STAGE_COMPLETE = 2;
const REPLACEMENT_PRICE = 500; // the silver merchant's price, MakingHistory.Quest.js KEY_PRICE (Wiki, The Enchanted Key)
let api;
let core;
let quest;
let miniquest;

function found(player) {
  const value = player.getAttribute(FOUND_ATTRIBUTE) ?? 0;
  return Number.isInteger(value) && value >= 0 && value <= sites.length ? value : null;
}
function complete(player) { return found(player) === sites.length; }
function physicalKey(player) { return player.getInventory().getAmount(core.ItemIdentifiers.ENCHANTED_KEY) > 0; }
function queryComplete(request) {
  if (request.player && quest.isComplete(request.player)) request.complete = complete(request.player);
}
function validOrder(order) {
  return Array.isArray(order) && order.length === sites.length && order[0] === sites[0].key
    && new Set(order).size === sites.length && order.every(key => sites.some(site => site.key === key));
}
/** The miniquest's stage as the route has it; a corrupt found count leaves the saved stage alone. */
function syncStage(player) {
  if (found(player) == null) return;
  const stage = !quest.isComplete(player) ? 0 : complete(player) ? STAGE_COMPLETE : STAGE_HUNTING;
  if (miniquest.getStage(player) !== stage) miniquest.setStage(player, stage);
}
function sync({ player }) {
  syncStage(player);
  if (!quest.isComplete(player)) return;
  const count = found(player), order = player.getAttribute(ORDER_ATTRIBUTE);
  if (count == null) return;
  if (count > 0 && !validOrder(order)) return;
  const mask = count === 0 ? 0 : order.slice(0, count).reduce((bits, key) => bits | (1 << sites.find(site => site.key === key).wireBit), 0);
  player.getPacketSender().sendVarbit(LOCSTATUS_VARBIT, mask).sendVarbit(STATUS_VARBIT, complete(player) ? 2 : 1);
}

/** A saved permutation is never regenerated after progress; invalid saved state cannot award loot. */
function route(player) {
  const saved = player.getAttribute(ORDER_ATTRIBUTE);
  if (validOrder(saved)) return saved;
  if (found(player) !== 0 || (saved != null && (!Array.isArray(saved) || saved.length !== 0))) return null;
  const tail = sites.slice(1).map(site => site.key);
  for (let i = tail.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tail[i], tail[j]] = [tail[j], tail[i]];
  }
  const order = [sites[0].key, ...tail];
  player.setAttribute(ORDER_ATTRIBUTE, order);
  return order;
}
function target(player) {
  const count = found(player);
  if (count == null || count === sites.length) return null;
  const order = route(player);
  return order ? sites.find(site => site.key === order[count]) : null;
}
function distance(player, site) {
  const location = player.getLocation();
  const x = location.getX(), y = location.getY();
  return Number.isFinite(x) && Number.isFinite(y) ? Math.max(Math.abs(x - site.x), Math.abs(y - site.y)) : null;
}
function temperature(steps) {
  return FEEDBACK.find(([maximum]) => steps <= maximum);
}
function feel({ player }) {
  if (!quest.isComplete(player) || !physicalKey(player)) return false;
  const site = target(player);
  if (!site) return false;
  const steps = distance(player, site);
  if (steps == null) return false;
  const [, text, sound] = temperature(steps);
  let message = text;
  const last = LAST_DISTANCE.get(player);
  if (steps > 4 && last != null) {
    message += steps < last ? " and warmer than last time"
      : steps > last ? " but colder than last time" : " and the same temperature as last time";
  }
  LAST_DISTANCE.set(player, steps);
  player.sendMessage(message);
  if (sound != null) core.Sounds.sendSound(player, new core.Sound(sound, 1, 0, 1));
}

/** Resolve bank-note identities from this deployment's cache, never by assuming id + 1. */
function rewardItems(site) {
  return site.rewards.map(reward => {
    const base = core.ItemIdentifiers[reward.item];
    let id = base;
    if (reward.noted) {
      id = core.ItemDefinition.forId(base).getNoteId();
      if (!Number.isInteger(id) || id < 0) throw new Error(`Enchanted Key reward has no canonical note: ${reward.item}`);
      const definition = core.ItemDefinition.forId(id);
      if (!definition.isNoted() || definition.unNote() !== base || !definition.isStackable()) {
        throw new Error(`Enchanted Key reward has no canonical note: ${reward.item}`);
      }
    }
    return new core.Item(id, reward.amount);
  });
}
function dig({ player }) {
  if (!quest.isComplete(player) || !physicalKey(player)) return false;
  const site = target(player);
  if (!site || player.getLocation().getZ() !== 0) return false;
  const steps = distance(player, site);
  if (steps == null || steps > 4) return false;
  const inventory = player.getInventory();
  const last = found(player) === sites.length - 1;
  const preview = new core.Inventory(player).setItems(inventory.getCopiedItems());
  if (last) preview.deleted(core.ItemIdentifiers.ENCHANTED_KEY, 1, false);
  const rewards = rewardItems(site);
  for (const item of rewards) {
    if (preview.getAddableAmount(item) < item.getAmount()) {
      inventory.full();
      return;
    }
    preview.add(item, false);
  }
  // All amounts were planned on independent Item copies. One synchronous commit, no awaited window.
  inventory.setItems(preview.getCopiedItems());
  player.setAttribute(FOUND_ATTRIBUTE, found(player) + 1);
  sync({ player });
  LAST_DISTANCE.delete(player);
  inventory.refreshItems();
  player.sendMessage("You found some treasure.");
  if (last) {
    player.getDialogueManager().startDialogues(new core.DialogueChainBuilder()
      .add(new core.ItemStatementDialogue(0, core.ItemIdentifiers.ENCHANTED_KEY,
        "You find some items, but the key dissolves in your<br>hand."))
      .add(new core.EndDialogue(1)));
  }
}
function resetComparison({ player }) { LAST_DISTANCE.delete(player); }

function buildJournal(player) {
  const count = found(player) ?? 0;
  if (!quest.isComplete(player)) {
    return [
      "I can start this miniquest by completing <col=800000>Making History</col>,",
      "after which the <col=800000>enchanted key</col> will lead me to buried treasure.",
    ];
  }
  if (complete(player)) {
    return [
      "<str>The enchanted key led me to buried treasure all over the land.</str>",
      `<str>I dug up all ${sites.length} treasures, and the key dissolved in my hand.</str>`,
      "",
      "<col=ff0000>MINIQUEST COMPLETE!</col>",
    ];
  }
  const lines = [
    "The <col=800000>enchanted key</col> grows hotter the closer I carry it to buried",
    "treasure. I should <col=800000>Feel</col> it as I travel, and dig with a <col=800000>spade</col>",
    "where it is steaming.",
    "",
    `I have dug up <col=800000>${count}</col> of the <col=800000>${sites.length}</col> treasures.`,
  ];
  if (!physicalKey(player)) {
    lines.push("", "I am not carrying the key. If I have lost it, the <col=800000>silver merchant</col>",
      `in <col=800000>East Ardougne</col> will sell me another for ${REPLACEMENT_PRICE} coins.`);
  }
  return lines;
}

/**
 * Only an administrative completion comes this way (::quest all): the route itself ends by its last dig, with the
 * key's own box and no scroll. Marking every treasure found keeps the stage and the route telling the same story.
 */
function markAllFound(player) {
  player.setAttribute(FOUND_ATTRIBUTE, sites.length);
}
/** After the other login hooks (Making History's included), so a save from before the miniquest had a stage gets one. */
function syncOnLogin({ player }) { syncStage(player); }

module.exports = function attach(pluginApi, makingHistory) {
  api = pluginApi;
  core = api.core;
  quest = makingHistory;
  miniquest = require("../QuestRuntime").registerQuest(api, {
    key: MINIQUEST_KEY,
    name: "The Enchanted Key",
    varbitId: STATUS_VARBIT,
    startedValue: STAGE_HUNTING,
    completionValue: STAGE_COMPLETE,
    questPoints: 0,
    scrollItemId: () => core.ItemIdentifiers.ENCHANTED_KEY,
    otherRewards: ["Treasure from eleven sites"],
    buildJournal,
    onReward: markAllFound,
  });
  api.persistAttribute(ORDER_ATTRIBUTE, []);
  api.persistAttribute(FOUND_ATTRIBUTE, 0);
  api.onItemAction("Enchanted key", { Feel: feel });
  api.onItemAction("Spade", { Dig: dig });
  api.onCustomEvent("enchanted-key:is-complete", queryComplete);
  api.onCustomEvent("enchanted-key:sync", sync);
  api.onCustomEvent("player:bootstrap-complete", syncOnLogin);
  api.onPlayerLogin(resetComparison);
  api.onPlayerLogout(resetComparison);
};
