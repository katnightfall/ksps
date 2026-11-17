"use strict";

/**
 * Ours. What the levelling bots say out loud.
 *
 * Short lines of public chat about what they are at, chosen here from lists (no model, no
 * service): what a bot is saving for, the level it is after, something it just bought, a level
 * gained, a grumble about its work, and a word back when a bot beside it says one of those.
 * brain/BotGroups says its lines through here too.
 *
 * It is kept rare, so a crowd of bots does not bury the people playing:
 *
 *   a bot      says at most one line of its own every few minutes (each draws its own gap)
 *   a listener hears at most one of these lines every LISTENER_QUIET_MS, however many bots
 *              stand around them: a bot about to speak stays quiet if anyone in earshot has
 *              just been spoken at
 *   nobody     in earshot: nothing is said. A line no person can read is not worth sending.
 *   a reply    is one bot answering one line, once: bots do not hold conversations
 *
 * A group forming (BotGroups) is a short exchange, so its lines go by the exchange and not by
 * the bot: a proposal is said only if nobody in earshot has heard one of these lines for
 * PROPOSAL_QUIET_MS, and the few answers to a proposal that was said follow it freely. A
 * proposal nobody could be told of is made in silence, and so is its party.
 *
 * World setting "PlayerBots:chat" (default on): off, the levelling bots say nothing at all.
 */
const { ItemDefinition } = require("../../../src/main/typescript/elvarg/game/definition/ItemDefinition");
const { PluginManager } = require("../../../src/main/typescript/elvarg/plugins/PluginManager");

const CHAT_CONFIG = "PlayerBots:chat";
// A bot's own lines are this far apart.
const BOT_GAP_MS = [4 * 60_000, 9 * 60_000];
// A person hears a bot's line no more often than this, and a group's proposal no more often than that.
const LISTENER_QUIET_MS = 20_000;
const PROPOSAL_QUIET_MS = 30_000;
// How far a line carries, and how near a bot must be to answer it.
const EARSHOT = 14;
const ANSWER_RANGE = 8;
// A line not said within this long of its cause is dropped: old news.
const FRESH_MS = 90_000;
// A bot held back (its gap, a listener's quiet) looks again after this long.
const RETRY_MS = 5_000;
// How often a line is answered by a bot beside the speaker, and how long the answer takes to type.
const ANSWER_CHANCE = 0.35;
const ANSWER_DELAY_MS = [2_000, 6_000];
// A remark about its work, when nothing else has given it something to say.
const IDLE_REMARK_MS = [8 * 60_000, 20 * 60_000];
// Levels worth a shout: every one from here up, and every fifth below.
const EVERY_LEVEL_FROM = 50;

const LINES = Object.freeze({
  saving: ["saving up for {a item}", "need {cost}gp for {a item}", "almost got enough for {a item}", "anyone selling {a item}?", "so broke, need {a item}"],
  focus: ["going for {level} {skill}", "need {level} {skill} for {unlock}", "{skill} grind till {level}", "only {level} {skill} to go lol"],
  got: ["finally got my {item}", "new {item} :)", "got {a item} at last", "{item} get", "check out my {item}"],
  level: ["{level} {skill}!", "gz me, {level} {skill}", "woo {level} {skill}", "finally {level} {skill}", "{skill} {level} :D"],
  woodcutting: ["these trees are packed", "wc is so slow", "anyone know a quieter spot for trees?", "logs logs logs", "my axe is so bad"],
  mining: ["rocks keep getting taken", "mining lvls take forever", "anyone smelting?", "need a better pick", "ore run again"],
  fishing: ["fish arent biting", "fishing is so chill", "cooking these after", "anyone want fish?", "burnt half of them last time"],
  combat_training: ["good xp here", "anyone got spare food?", "these things hit hard", "need better armour", "so many people training here"],
  agility: ["agility is pain", "fell off again lol", "one more lap", "laps laps laps"],
  trading: ["off to the ge", "prices are mad today", "selling my stuff at the ge"],
  standing: ["{name} is only a few lvls ahead of me", "gonna pass {name} soon", "total lvl {total} now"],
  reply_level: ["gz", "gratz", "nice", "gz!", "grats"],
  reply_got: ["nice", "gz", "how much was it?", "want one too", "sick"],
  reply_goal: ["gl", "good luck", "same lol", "same tbh"],
  reply_remark: ["lol", "ikr", "yep", "true", "haha"],
});
/** What a line of a topic may be answered with. */
const ANSWERS = Object.freeze({ level: "reply_level", got: "reply_got", saving: "reply_goal", focus: "reply_goal", remark: "reply_remark" });

const between = ([least, most], random) => least + random() * (most - least);
const aOrAn = (noun) => (/^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`);
/** An item's name as a player types it: lower case, no dose or charge count. */
const itemWord = (itemId) => String(ItemDefinition.forId(itemId)?.getName?.() ?? "it").toLowerCase().replace(/\s*\(\d+\)$/, "");

/** Whether this world's levelling bots talk (world setting, default on). */
function worldBotsTalk() {
  return PluginManager.getPluginConfig?.(CHAT_CONFIG) !== false;
}

/** Fills a line's {words} from `fields`; a line with a word it has no value for is not used. */
function fill(template, fields) {
  let complete = true;
  const text = template.replace(/\{(a )?([a-z]+)\}/g, (match, article, key) => {
    const value = fields[key];
    if (value === undefined || value === null || value === "") {
      complete = false;
      return "";
    }
    return article ? aOrAn(String(value)) : String(value);
  });
  return complete ? text : null;
}

function createBotTalk({ world, enabled = worldBotsTalk, random = Math.random } = {}) {
  const core = world.core;
  const bots = new WeakMap();
  /** When each person was last spoken at by a bot. */
  const heardAt = new WeakMap();
  const botFor = (player, nowMs) => {
    let bot = bots.get(player);
    if (!bot) bots.set(player, (bot = { pending: null, quietUntil: 0, tryAt: 0, remarkAt: nowMs + between(IDLE_REMARK_MS, random) }));
    return bot;
  };

  /** A line of `topic` with its words filled in, or null when none of its lines can be. */
  function line(topic, fields = {}) {
    const usable = (LINES[topic] ?? []).map((template) => fill(template, fields)).filter(Boolean);
    return usable.length ? usable[Math.floor(random() * usable.length)] : null;
  }

  function near(player, range) {
    const here = player.getLocation();
    return core.World.getNearbyPlayersForUpdate(player).filter((other) => {
      if (!other || other === player || other.isRegistered?.() === false) return false;
      const there = other.getLocation();
      return there.getZ() === here.getZ() && Math.max(Math.abs(there.getX() - here.getX()), Math.abs(there.getY() - here.getY())) <= range;
    });
  }

  /**
   * Says `text` in public chat if the rules above allow it. `group`: "open" for a group's
   * proposal, "follow" for a line that follows one that was said; neither goes by the bot's own
   * gap. Returns whether it was said.
   */
  function say(player, text, nowMs = Date.now(), { group = null, topic = null } = {}) {
    if (!enabled() || !text || player.isRegistered?.() === false) return false;
    const bot = botFor(player, nowMs);
    if (group === null && nowMs < bot.quietUntil) return false;
    const people = near(player, EARSHOT).filter((other) => other.isPlayerBot?.() !== true);
    if (people.length === 0) return false;
    const quietMs = group === "follow" ? 0 : group === "open" ? PROPOSAL_QUIET_MS : LISTENER_QUIET_MS;
    if (people.some((person) => nowMs - (heardAt.get(person) ?? -Infinity) < quietMs)) return false;
    for (const person of people) heardAt.set(person, nowMs);
    if (group === null) bot.quietUntil = nowMs + between(BOT_GAP_MS, random);
    // A line starting "::" would be run as a command: a bot's never does.
    core.ChatPacketListener.handleText(player, String(text).replace(/^[\s:]+/, ""));
    world.log?.("bot_talk", { username: player.getUsername?.(), text, topic });
    // One bot beside it may have a word to say back. An answer is never answered.
    const answer = ANSWERS[topic];
    if (answer && random() < ANSWER_CHANCE) {
      const beside = near(player, ANSWER_RANGE).filter((other) => other.isPlayerBot?.() === true && bots.has(other) && !bots.get(other).pending);
      const other = beside[Math.floor(random() * beside.length)];
      const reply = other ? line(answer) : null;
      if (reply) bots.get(other).pending = { text: reply, topic: answer, notBefore: nowMs + between(ANSWER_DELAY_MS, random), until: nowMs + FRESH_MS };
    }
    return true;
  }

  /** Something happened to a bot that it may remark on: the line is drawn now and said when it may be. */
  function note(player, topic, data = {}, nowMs = Date.now()) {
    if (!enabled()) return;
    const bot = botFor(player, nowMs);
    let text = null;
    let said = topic;
    if (topic === "goal") {
      // What it saves for, or the level it is after: whichever it has, one of them at random.
      const saving = data.saving ? line("saving", { item: itemWord(data.saving.itemId), cost: data.saving.cost }) : null;
      const focus = data.focus ? line("focus", { level: data.focus.level, skill: String(data.focus.skill.getName()).toLowerCase(), unlock: String(data.focus.unlocks ?? "").replace(/_/g, " ").toLowerCase() }) : null;
      text = saving && focus ? (random() < 0.5 ? saving : focus) : saving ?? focus;
      said = text === saving ? "saving" : "focus";
    } else if (topic === "got") {
      text = line("got", { item: itemWord(data.goal.itemId) });
    } else if (topic === "level") {
      if (data.level < EVERY_LEVEL_FROM && data.level % 5 !== 0) return;
      text = line("level", { level: data.level, skill: String(data.skill.getName()).toLowerCase() });
    } else if (topic === "remark") {
      text = data.standing && random() < 0.25 ? line("standing", data.standing) : line(data.mode);
    }
    if (!text) return;
    bot.pending = { text, topic: said, notBefore: nowMs, until: nowMs + FRESH_MS };
  }

  /** Every tick of a bot with a mind: says what it has waiting, when it may. Cheap otherwise. */
  function tick(brain, nowMs = Date.now()) {
    const player = brain.player;
    const bot = botFor(player, nowMs);
    if (nowMs >= bot.remarkAt) {
      bot.remarkAt = nowMs + between(IDLE_REMARK_MS, random);
      if (!bot.pending && nowMs >= bot.quietUntil) {
        const standing = world.ambition?.standing(player);
        note(player, "remark", {
          mode: brain.frames?.[0]?.behaviour?.mode ?? null,
          standing: standing?.ahead ? { name: standing.ahead, total: standing.total } : standing ? { total: standing.total } : null,
        }, nowMs);
      }
    }
    const pending = bot.pending;
    if (!pending || nowMs < pending.notBefore || nowMs < bot.tryAt) return;
    if (nowMs > pending.until) {
      bot.pending = null;
      return;
    }
    if (say(player, pending.text, nowMs, { topic: pending.topic })) bot.pending = null;
    else bot.tryAt = nowMs + RETRY_MS;
  }

  /** A level gained (the game's own level-up hook): worth a shout now and then. */
  function levelUp({ player, skill, newLevel }) {
    if (bots.has(player)) note(player, "level", { skill, level: newLevel });
  }

  return { say, note, tick, levelUp, line, pending: (player) => bots.get(player)?.pending ?? null };
}

module.exports = { CHAT_CONFIG, LINES, LISTENER_QUIET_MS, PROPOSAL_QUIET_MS, createBotTalk, fill, worldBotsTalk };
