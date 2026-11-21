/**
 * ::quest - an admin command to look at or set a player's quest progress, for testing
 * quest-gated content without playing the quest.
 *
 *   ::quest <name>             show the quest's stage
 *   ::quest <name> complete    complete it as the quest itself does (rewards, points, scroll)
 *   ::quest <name> reset       back to not started
 *   ::quest <name> <stage>     set the stage
 *   ::quest all complete       (ours) complete every quest, their reward items to the bank;
 *                              ::allquests is the same
 *   ::quest all reset          (ours) every quest back to not started
 *
 * <name> is a quest's name or key, any case; part of a name works when only one quest matches
 * ("grand tree"). Quest points follow a quest set below or above its completion stage.
 */
const QuestRuntime = require("./QuestRuntime");
const { PlayerRights } = require("../../src/main/typescript/elvarg/game/model/rights/PlayerRights");

const USAGE = "Usage: ::quest <name> [complete|reset|<stage>], or ::quest all complete|reset";

/**
 * Ours: how a quest that was not played is completed, as League mode's auto-completed quests are
 * (Unlocks.LeagueMode): its stage, points, reward items and unlocks, and the "quest:completed"
 * event other content listens for; no scroll, jingle or chat line each, and the experience a
 * quest hands out afterwards (a lamp, a trainer) is held back.
 */
const UNPLAYED = { experience: false, scroll: false, announce: false };

/** Set in register: the core API, for the bank. Without it (a bare test stand-in) rewards stay where the quests put them. */
let core = null;

/**
 * Ours (the owner's wish, 2026-11-20): the experience of ::quest all complete comes at 1x, not at
 * the world's rate (10x on ours). While it runs, the experience gate divides the world's rate back
 * out of that player's gains; a character's own rate (a league's) still applies.
 */
let completingAll = null;

function oneTimesExperience(event) {
  if (!completingAll || event.player !== completingAll) return;
  const rate = Number(core?.GameConstants?.EXPERIENCE_MULTIPLIER);
  if (Number.isFinite(rate) && rate > 0) event.multiplier = (Number(event.multiplier) || 1) / rate;
}

/**
 * Ours: everything in the backpack goes to the bank, as a deposit does (notes unnoted, the item's
 * own tab). Returns what the bank took (a count of items) and what it would not take (left in the
 * backpack: a full bank, an item that may not be banked).
 */
function bankBackpack(player) {
  const { Bank, PluginManager } = core;
  const inventory = player.getInventory();
  let banked = 0;
  inventory.getItems().forEach((item, slot) => {
    if (!item || item.getId() < 0 || item.getAmount() <= 0) return;
    if (PluginManager.emitCanBankItem?.(player, item) === false) return;
    const amount = item.getAmount();
    inventory.switchItem(player.getBank(Bank.getTabForItem(player, item.getId())), item.clone(), false, slot, false);
    const left = inventory.getItems()[slot];
    banked += amount - (left && left.getId() === item.getId() ? left.getAmount() : 0);
  });
  return banked;
}

/**
 * Ours: ::quest all complete. A quest whose reward throws is still complete (its stage and points
 * come first), is named, and does not stop the rest.
 *
 * The reward items go to the bank, not the backpack (the user's wish, 2026-11-16: two hundred
 * quests' rewards filled it and the rest fell on the floor). The player's own things are set aside
 * first, so each quest finds an empty backpack and nothing overflows; what a quest puts there is
 * banked before the next one, and their own things come back at the end.
 */
function completeAll(player) {
  const inventory = player.getInventory();
  const toBank = core?.Bank && typeof inventory.switchItem === "function" && typeof inventory.setItems === "function";
  const own = toBank ? inventory.getItems().map((item) => item) : null;
  if (toBank) inventory.resetItems();

  let completed = 0;
  let banked = 0;
  const failed = [];
  const kept = [];
  completingAll = player; // Ours: 1x experience (oneTimesExperience)
  try {
    for (const quest of QuestRuntime.getRegisteredQuests()) {
      try {
        if (quest.complete(player, UNPLAYED)) completed++;
      } catch (error) {
        failed.push(quest.name);
        if (quest.isComplete(player)) completed++;
        console.error(`[QuestCommand] completing ${quest.name} failed`, error);
      }
      if (!toBank) continue;
      banked += bankBackpack(player);
      // What the bank would not take waits beside the player's own things.
      for (const item of inventory.getItems()) if (item && item.getId() >= 0 && item.getAmount() > 0) kept.push(item);
      inventory.resetItems();
    }
  } finally {
    completingAll = null;
    if (toBank) {
      inventory.setItems(own);
      // forceAdd: what fits goes in the backpack, the rest on the floor under the player.
      for (const item of kept) inventory.forceAdd(player, item);
      inventory.refreshItems();
    }
  }

  const total = QuestRuntime.getRegisteredQuests().length;
  const points = Number(player.getAttribute(QuestRuntime.QUEST_POINTS_ATTRIBUTE)) || 0;
  const lines = [completed === 0 && failed.length === 0
    ? `All ${total} quests were already complete (${points} quest points).`
    : `Completed ${completed} of ${total} quests; you have ${points} quest points.`];
  if (banked > 0) lines.push(`The reward items are in your bank (${banked.toLocaleString("en-US")} items).`);
  if (kept.length > 0) lines.push(`Your bank would not take ${kept.length} of them: they are in your backpack or at your feet.`);
  if (failed.length > 0) lines.push(`The rewards of ${failed.length} failed (see the server log): ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? ", ..." : ""}.`);
  tellAfterwards(player, lines);
}

/**
 * Ours: the summary goes out two ticks on, under the level-up lines the rewards' experience
 * prints, so it is what the player is left reading. At once without the core API (a test stand-in).
 */
function tellAfterwards(player, lines) {
  const send = () => { for (const line of lines) player.sendMessage(line); };
  if (!core?.Task || !core?.TaskManager) return send();
  core.TaskManager.submit(new (class extends core.Task {
    constructor() { super(2, player, false); }
    execute() { send(); this.stop(); }
  })());
}

/** Ours: ::quest all reset. Stages and points only: rewards already given stay. */
function resetAll(player) {
  let reset = 0;
  for (const quest of QuestRuntime.getRegisteredQuests()) {
    if (quest.getStage(player) === 0) continue;
    setStage(player, quest, 0);
    reset++;
  }
  player.sendMessage(`Reset ${reset} quests to not started.`);
}

function normalise(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** The one quest a name means: an exact name or key first, then a unique partial match. */
function findQuests(text) {
  const wanted = normalise(text);
  const quests = QuestRuntime.getRegisteredQuests();
  const exact = quests.filter((quest) => normalise(quest.name) === wanted || normalise(quest.key) === wanted ||
    normalise(quest.name).replace(/^the /, "") === wanted);
  return exact.length > 0 ? exact : quests.filter((quest) => normalise(quest.name).includes(wanted));
}

function addQuestPoints(player, delta) {
  const points = Math.max(0, (Number(player.getAttribute(QuestRuntime.QUEST_POINTS_ATTRIBUTE)) || 0) + delta);
  player.setAttribute(QuestRuntime.QUEST_POINTS_ATTRIBUTE, points);
  player.getPacketSender().sendConfig(QuestRuntime.QUEST_POINTS_VARP, points);
}

/** Sets a stage directly, keeping the quest points in step when it crosses completion. */
function setStage(player, quest, stage) {
  const wasComplete = quest.isComplete(player);
  quest.setStage(player, stage);
  const isComplete = quest.isComplete(player);
  if (wasComplete !== isComplete) addQuestPoints(player, (isComplete ? 1 : -1) * (quest.questPoints || 0));
}

function describe(player, quest) {
  const state = quest.isComplete(player) ? "complete" : quest.isStarted(player) ? "started" : "not started";
  return `${quest.name}: stage ${quest.getStage(player)} (${state}; completes at ${quest.completionValue ?? 2}).`;
}

function questCommand({ player, parts }) {
  const args = parts.slice(1);
  const last = String(args.at(-1) ?? "").toLowerCase();
  const action = last === "complete" || last === "reset" || /^\d+$/.test(last) ? last : null;
  const name = (action ? args.slice(0, -1) : args).join(" ");
  if (!name) {
    player.sendMessage(USAGE);
    return true;
  }
  // Ours: every quest at once.
  if (normalise(name) === "all") {
    if (action === "complete") completeAll(player);
    else if (action === "reset") resetAll(player);
    else player.sendMessage(USAGE);
    return true;
  }
  const matches = findQuests(name);
  if (matches.length !== 1) {
    player.sendMessage(matches.length === 0
      ? `No quest matches "${name}".`
      : `"${name}" matches ${matches.length} quests: ${matches.slice(0, 5).map((quest) => quest.name).join(", ")}${matches.length > 5 ? ", ..." : ""}.`);
    return true;
  }
  const [quest] = matches;
  if (action === "complete") {
    if (!quest.complete(player)) player.sendMessage(`${quest.name} is already complete.`);
  } else if (action === "reset") {
    setStage(player, quest, 0);
  } else if (action !== null) {
    setStage(player, quest, Number(action));
  }
  player.sendMessage(describe(player, quest));
  return true;
}

/**
 * Ours (the owner's wish, 2026-11-20): world setting "QuestCommand:everyone". On, every player may
 * complete all their quests with ::allquests or ::quest all complete. The rest of ::quest (a stage,
 * a reset, one quest) stays with administrators and above: a reset followed by another completion
 * would hand every quest's rewards out again.
 */
const EVERYONE_CONFIG = "QuestCommand:everyone";
const STAFF_ONLY = "Only ::quest all complete (or ::allquests) is open to players; the rest of ::quest is for staff.";
let pluginApi = null;

function everyoneMayCompleteAll() {
  return pluginApi?.getPluginConfig?.(EVERYONE_CONFIG, false) === true;
}

function isStaff(player) {
  return PlayerRights.hasAdminRights(player);
}

/** ::quest as registered: staff as before; another player only for "all complete", while the world allows it. */
function playerQuestCommand(event) {
  if (isStaff(event.player)) return questCommand(event);
  const args = event.parts.slice(1).map((part) => String(part).toLowerCase());
  if (everyoneMayCompleteAll() && args.length === 2 && args[0] === "all" && args[1] === "complete") return questCommand(event);
  event.player.sendMessage(everyoneMayCompleteAll() ? STAFF_ONLY : "You do not have permission to use this command.");
  return true;
}

function allQuestsCommand({ player }) {
  if (!isStaff(player) && !everyoneMayCompleteAll()) {
    player.sendMessage("You do not have permission to use this command.");
    return true;
  }
  completeAll(player);
  return true;
}

module.exports = {
  name: "QuestCommand",
  description: "Adds the admin ::quest command to show, set, complete or reset a player's quest stage, for testing quest-gated content.",
  // Ours
  config: {
    [EVERYONE_CONFIG]: {
      type: "boolean", label: "::allquests for every player", default: false,
      help: "Off: only administrators and above. On: every player may complete all their quests at once with ::allquests (or ::quest all complete); the reward items go to their bank and the experience comes at 1x. Setting a stage, resetting and completing one quest stay with staff.",
    },
  },
  register(api) {
    pluginApi = api; // Ours: for QuestCommand:everyone.
    core = api.core ?? null; // Ours: for the bank (completeAll).
    api.onCanGainExperience?.(oneTimesExperience); // Ours: ::quest all complete at 1x
    // Ours: registered for every rank; playerQuestCommand keeps all but "all complete" with staff.
    api.registerCommand("quest", playerQuestCommand, PlayerRights.NONE, "Show or set a quest's progress: ::quest <name> [complete|reset|<stage>]");
    // Ours: the short way to complete every quest.
    api.registerCommand("allquests", allQuestsCommand, PlayerRights.NONE, "Complete every quest (the same as ::quest all complete)");
  },
  _test: { questCommand, playerQuestCommand, findQuests, completeAll, resetAll },
};
