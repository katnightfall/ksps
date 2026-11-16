/**
 * ::quest - an admin command to look at or set a player's quest progress, for testing
 * quest-gated content without playing the quest.
 *
 *   ::quest <name>             show the quest's stage
 *   ::quest <name> complete    complete it as the quest itself does (rewards, points, scroll)
 *   ::quest <name> reset       back to not started
 *   ::quest <name> <stage>     set the stage
 *   ::quest all complete       (ours) complete every quest; ::allquests is the same
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

/** Ours: ::quest all complete. A quest whose reward throws is still complete (its stage and points come first), is named, and does not stop the rest. */
function completeAll(player) {
  let completed = 0;
  const failed = [];
  for (const quest of QuestRuntime.getRegisteredQuests()) {
    try {
      if (quest.complete(player, UNPLAYED)) completed++;
    } catch (error) {
      failed.push(quest.name);
      if (quest.isComplete(player)) completed++;
      console.error(`[QuestCommand] completing ${quest.name} failed`, error);
    }
  }
  const total = QuestRuntime.getRegisteredQuests().length;
  const points = Number(player.getAttribute(QuestRuntime.QUEST_POINTS_ATTRIBUTE)) || 0;
  player.sendMessage(completed === 0 && failed.length === 0
    ? `All ${total} quests were already complete (${points} quest points).`
    : `Completed ${completed} of ${total} quests; you have ${points} quest points.`);
  if (failed.length > 0) player.sendMessage(`The rewards of ${failed.length} failed (see the server log): ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? ", ..." : ""}.`);
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

module.exports = {
  name: "QuestCommand",
  description: "Adds the admin ::quest command to show, set, complete or reset a player's quest stage, for testing quest-gated content.",
  register(api) {
    api.registerCommand("quest", questCommand, PlayerRights.ADMINISTRATOR, "Show or set a quest's progress: ::quest <name> [complete|reset|<stage>]");
    // Ours: the short way to complete every quest.
    api.registerCommand("allquests", ({ player }) => { completeAll(player); return true; }, PlayerRights.ADMINISTRATOR, "Complete every quest (the same as ::quest all complete)");
  },
  _test: { questCommand, findQuests, completeAll, resetAll },
};
