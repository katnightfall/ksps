"use strict";

/**
 * Ours. Levelling bots that do things together.
 *
 * Now and then a bot feels like company. It picks something a few of them could do together
 * (data/definitions/bot-groups.json: the willows at Draynor, the mine east of Varrock ...),
 * something its own levels allow and, by choice, the skill it is after (brain/Ambition), and:
 *
 *   proposes   it says so in public chat ("anyone want to cut willows at draynor?"), when
 *              there is a person near to read it and they have not just read another (brain/BotTalk)
 *   gathers    for a few seconds. Bots standing near it that could come often do, and so do
 *              bots further off that are after the same skill; the first couple in earshot say
 *              so ("me", "ill come"). Only bots free to leave their work are asked.
 *   sets off   with enough of them (the outing's `size`), the proposer says so and each walks
 *              to the meeting place by itself; with too few it is called off ("nvm")
 *   meets      there they wait for each other, a minute at most from the first to arrive
 *              (an outing may give its own `waitMinutes`: after a long road they come in further apart)
 *   works      then each does the outing's activity there, side by side, for its `minutes`;
 *              after that each bot's own rotation takes it where it will
 *
 * What a bot uses on an outing is its own, as in all its work: the outing only decides where
 * and with whom. An outing with a `kind` of its own (Wintertodt) has its own way of setting off
 * and playing, added by that part with addKind.
 *
 * World settings: "PlayerBots:groups" (default on) and "PlayerBots:groupMinutes" ([least, most]
 * minutes between one bot's proposals, default [30, 90]).
 */
const fs = require("node:fs");
const path = require("node:path");
const { PluginManager } = require("../../../src/main/typescript/elvarg/plugins/PluginManager");
const { requestMovement, peekMovementRequest, clearMovementRequest } = require("../behaviours/navigation/Navigation.PlayerBots");
const { earnsOwnItems } = require("./OwnItems.PlayerBots");

const GROUPS_CONFIG = "PlayerBots:groups";
const GROUP_MINUTES_CONFIG = "PlayerBots:groupMinutes";
const DEFAULT_MINUTES = [30, 90];
/** The activity a bot walks to the meeting place as, on top of the outing's own (bot-activities.json). */
const MEET_ACTIVITY = "group_meet";

// A proposal stays open this long.
const GATHER_MS = 15_000;
// Bots this near the proposer hear it; ones after the same skill come from this far.
const NEAR = 18;
const LIKE_MINDED_RANGE = 160;
// How often a bot that could come does.
const NEAR_CHANCE = 0.7;
const LIKE_MINDED_CHANCE = 0.5;
// A bot takes this long to answer.
const REPLY_MS = [2_000, 9_000];
// At the meeting place: this near counts as there, and the first to arrive waits this long for the rest.
const ARRIVE = 6;
const WAIT_MS = 60_000;
// The walk there is allowed this long on top of the outing's minutes before the rotation moves the bot on.
const TRAVEL_MS = 8 * 60_000;
// Not moving this long on the way: the bot gives the outing up.
const STUCK_MS = 60_000;
// How much likelier a bot proposes the outing of the skill it is after.
const FOCUS_WEIGHT = 3;
// Answers said aloud to one proposal: the rest come without a word.
const ANSWERS_SAID = 2;

const SAY = Object.freeze({
  propose: ["anyone want to {do}?", "{do} anyone?", "going to {do}, whos coming?", "need a few people to {do}", "wanna {do}?"],
  join: ["me", "ill come", "sure", "omw", "im in", "yeah ok", "me too"],
  go: ["ok lets go", "lets go then", "ok going", "right lets go"],
  cancel: ["nvm", "guess not", "ok maybe later", "no one? ok"],
  arrived: ["here", "made it", "ok im here", "ready"],
});

const between = ([least, most], random) => least + random() * (most - least);
const apart = (a, b) => Math.max(Math.abs(a.getX() - b.getX()), Math.abs(a.getY() - b.getY()));

/** Whether this world's levelling bots form groups (world setting, default on). */
function worldBotsGroup() {
  return PluginManager.getPluginConfig?.(GROUPS_CONFIG) !== false;
}

function loadOutings(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return (raw.outings ?? []).map((outing) => {
    if (!outing?.id || !outing.activity || !Number.isInteger(outing.x) || !Number.isInteger(outing.y) || !outing.say) {
      throw new Error(`[bot groups] outing '${outing?.id}' needs an id, an activity, a place (x, y) and what to say`);
    }
    const [least, most] = outing.size ?? [2, 5];
    const [short, long] = outing.minutes ?? [12, 20];
    if (!(least >= 2 && most >= least) || !(short > 0 && long >= short)) throw new Error(`[bot groups] outing '${outing.id}' has a bad size or minutes`);
    const waitMs = outing.waitMinutes > 0 ? outing.waitMinutes * 60_000 : WAIT_MS;
    return { kind: "outing", ...outing, z: outing.z ?? 0, size: [least, most], minutes: [short, long], waitMs };
  });
}

function createBotGroups({
  world, runtime, registry, ambition, talk = null,
  definitionsPath = path.join(process.cwd(), "data", "definitions", "bot-groups.json"),
  random = Math.random, minutes = null,
} = {}) {
  const outings = loadOutings(definitionsPath);
  /** How an outing of a kind of its own sets off and plays: kind -> { eligible(player), launch(party, member, brain, nowMs) }. */
  const kinds = new Map();
  const bots = new WeakMap();
  const proposalGap = () => {
    const configured = minutes ?? PluginManager.getPluginConfig?.(GROUP_MINUTES_CONFIG);
    const [least, most] = Array.isArray(configured) && configured.length === 2 && configured[0] > 0 && configured[1] >= configured[0] ? configured : DEFAULT_MINUTES;
    return between([least * 60_000, most * 60_000], random);
  };
  const botFor = (player, nowMs) => {
    let bot = bots.get(player);
    // The first proposal comes anywhere in the gap, so a crowd started together does not all ask at once.
    if (!bot) bots.set(player, (bot = { party: null, proposeAt: nowMs + random() * proposalGap(), position: null, movedAt: 0 }));
    return bot;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];
  /** A line of a party. Its proposal decides whether the party is heard at all; the rest follow a proposal that was. */
  const speak = (party, player, kind, nowMs) => {
    if (kind !== "propose" && !party.heard) return false;
    return talk?.say(player, pick(SAY[kind]).replace("{do}", party.outing.say), nowMs, { group: kind === "propose" ? "open" : "follow", topic: "group" }) === true;
  };
  const brainOf = (player) => runtime?.entriesByUsername?.get?.(player.getUsername?.())?.brain ?? null;

  /** Whether `brain`'s bot could go on `outing` now: one of the crowd, free, and able to do the work. */
  function couldCome(brain, outing, nowMs) {
    const player = brain?.player;
    if (!player || brain.rotation?.best !== true || !earnsOwnItems(player) || bots.get(player)?.party) return false;
    // At work of the site's own: not one away on a trip of another kind (the Wintertodt).
    if (!brain.rotation.activityIds.includes(brain.frames[0]?.behaviour?.id)) return false;
    const activity = registry.byId.get(outing.activity);
    // An outing's activity is one of the site's own; a kind of its own brings its own.
    if (!activity || !(kinds.has(outing.kind) || brain.rotation.activityIds.includes(activity.id)) || !registry.hasRoom(activity.id)) return false;
    if (!activity.requires.every((condition) => condition.check({ player }))) return false;
    if (kinds.get(outing.kind)?.eligible?.(player) === false) return false;
    return ambition.free(brain, nowMs);
  }

  /** The bot proposes an outing, if there is one it could go on. Returns the party, or null. */
  function propose(brain, nowMs) {
    const leader = brain.player;
    const focus = ambition.mind(leader)?.focus?.mode ?? null;
    const open = outings.filter((outing) => couldCome(brain, outing, nowMs));
    if (open.length === 0) return null;
    const weight = (outing) => ((outing.mode ?? registry.byId.get(outing.activity)?.mode) === focus ? FOCUS_WEIGHT : 1);
    let roll = random() * open.reduce((sum, outing) => sum + weight(outing), 0);
    const outing = open.find((candidate) => (roll -= weight(candidate)) < 0) ?? open[0];
    const mode = outing.mode ?? registry.byId.get(outing.activity).mode;
    const party = {
      outing, leader, members: new Set([leader]), pledges: [], arrived: new Set(),
      phase: "gathering", closesAt: nowMs + GATHER_MS, goAt: 0, workMs: between(outing.minutes, random) * 60_000, expiresAt: Infinity,
      heard: false, answersSaid: 0,
    };
    botFor(leader, nowMs).party = party;
    party.heard = speak(party, leader, "propose", nowMs);
    // Who answers: bots near enough to hear, and bots after the same skill from further off.
    const here = leader.getLocation();
    for (const entry of runtime?.entriesByUsername?.values?.() ?? []) {
      if (party.pledges.length >= outing.size[1] - 1) break;
      const other = entry?.player;
      if (!other || other === leader || !entry.brain || !couldCome(entry.brain, outing, nowMs)) continue;
      const there = other.getLocation();
      // An outing that gathers "anywhere" (a long trip each makes by itself, to meet at the far end) asks every bot that could come.
      const anywhere = outing.gather === "anywhere";
      if (there.getZ() !== here.getZ() && !anywhere) continue;
      const distance = there.getZ() === here.getZ() ? apart(here, there) : Infinity;
      const likeMinded = ambition.mind(other)?.focus?.mode === mode;
      const chance = distance <= NEAR ? NEAR_CHANCE : anywhere || (likeMinded && distance <= LIKE_MINDED_RANGE) ? LIKE_MINDED_CHANCE : 0;
      if (random() >= chance) continue;
      party.pledges.push({ player: other, at: nowMs + between(REPLY_MS, random), heard: distance <= NEAR });
      botFor(other, nowMs).party = party;
    }
    world.log?.("bot_group_proposed", { leader: leader.getUsername?.(), outing: outing.id, asked: party.pledges.map((pledge) => pledge.player.getUsername?.()) });
    return party;
  }

  function leave(party, player) {
    party.members.delete(player);
    party.arrived.delete(player);
    const bot = bots.get(player);
    if (bot?.party === party) bot.party = null;
  }

  function disband(party, nowMs, why) {
    party.phase = "done";
    for (const pledge of party.pledges) leave(party, pledge.player);
    for (const member of [...party.members]) leave(party, member);
    world.log?.("bot_group_called_off", { leader: party.leader.getUsername?.(), outing: party.outing.id, why });
  }

  /** The outing begins: each member's work becomes the outing's activity, with the walk to the meeting place on top. */
  function setOff(party, nowMs) {
    const { outing } = party;
    const activity = registry.byId.get(outing.activity);
    const meet = registry.byId.get(MEET_ACTIVITY);
    const kind = kinds.get(outing.kind);
    for (const member of [...party.members]) {
      const brain = brainOf(member);
      // One that got busy while the others answered stays behind.
      if (!brain || !ambition.free(brain, nowMs)) leave(party, member);
    }
    if (party.members.size < outing.size[0] || !party.members.has(party.leader) || (!kind && !meet)) {
      if (party.members.has(party.leader)) speak(party, party.leader, "cancel", nowMs);
      disband(party, nowMs, "too few");
      return false;
    }
    party.phase = "travelling";
    party.expiresAt = nowMs + TRAVEL_MS;
    speak(party, party.leader, "go", nowMs);
    for (const member of party.members) {
      const brain = brainOf(member);
      botFor(member, nowMs).proposeAt = nowMs + party.workMs + proposalGap();
      if (kind) {
        kind.launch(party, member, brain, nowMs);
        continue;
      }
      brain.replaceRoot(activity, nowMs);
      // Its rotation waits for the walk there and the outing's minutes.
      brain.switchAt = nowMs + TRAVEL_MS + party.workMs;
      brain.pushActivity(meet, nowMs);
    }
    world.log?.("bot_group_set_off", {
      leader: party.leader.getUsername?.(), outing: outing.id, members: [...party.members].map((member) => member.getUsername?.()),
      x: outing.x, y: outing.y, minutes: Math.round(party.workMs / 60_000),
    });
    return true;
  }

  /** Moves a gathering party on: answers that have come due, and the end of the wait. */
  function advance(party, nowMs) {
    if (party.phase !== "gathering") return;
    const due = party.pledges.filter((pledge) => nowMs >= pledge.at);
    party.pledges = party.pledges.filter((pledge) => nowMs < pledge.at);
    for (const pledge of due) {
      const brain = brainOf(pledge.player);
      if (!brain || party.members.size >= party.outing.size[1] || !ambition.free(brain, nowMs)) {
        leave(party, pledge.player);
        continue;
      }
      party.members.add(pledge.player);
      if (pledge.heard && party.answersSaid < ANSWERS_SAID && speak(party, pledge.player, "join", nowMs)) party.answersSaid += 1;
    }
    if (nowMs >= party.closesAt && party.pledges.length === 0) setOff(party, nowMs);
  }

  return {
    outings,
    /** Every tick of a bot with a mind: cheap unless it is in a party or its next proposal is due. */
    tick(brain, nowMs = Date.now()) {
      const bot = botFor(brain.player, nowMs);
      const party = bot.party;
      if (party) {
        advance(party, nowMs);
        // A walk that never ended (the bot died, or was taken off it) does not hold it for good.
        if (nowMs > party.expiresAt) leave(party, brain.player);
        return;
      }
      if (nowMs < bot.proposeAt) return;
      bot.proposeAt = nowMs + proposalGap();
      propose(brain, nowMs);
    },

    /** The meet action's update: the walk to the meeting place, and the wait for the others there. */
    meet(ctx) {
      const { player, nowMs } = ctx;
      const bot = botFor(player, nowMs);
      const party = bot.party;
      if (!party || party.phase !== "travelling") return "success";
      const { outing } = party;
      const here = player.getLocation();
      if (here.getZ() === outing.z && Math.max(Math.abs(here.getX() - outing.x), Math.abs(here.getY() - outing.y)) <= ARRIVE) {
        if (!party.arrived.has(player)) {
          party.arrived.add(player);
          if (party.goAt === 0) {
            party.goAt = nowMs + outing.waitMs;
            speak(party, player, "arrived", nowMs);
          }
          world.log?.("bot_group_arrived", { username: player.getUsername?.(), outing: outing.id, there: party.arrived.size, of: party.members.size });
        }
        if (party.arrived.size < party.members.size && nowMs < party.goAt) return "running";
        // All there, or waited long enough: to work. The party is over for this bot; the work is its own.
        bot.party = null;
        return "success";
      }
      const position = `${here.getX()},${here.getY()},${here.getZ()}`;
      if (position !== bot.position) {
        bot.position = position;
        bot.movedAt = nowMs;
      } else if (nowMs - bot.movedAt > STUCK_MS) {
        world.log?.("bot_group_lost", { username: player.getUsername?.(), outing: outing.id, x: here.getX(), y: here.getY() });
        leave(party, player);
        return "failed";
      }
      if (player.getMovementQueue().size() === 0 && !peekMovementRequest(player)) {
        requestMovement(player, outing.x, outing.y, { nowMs, z: outing.z, reason: "brain_group_meet", basicPather: true });
      }
      return "running";
    },

    /** The meet action's stop. A bot taken off the walk (its brain reset) is out of the party. */
    stopMeet(ctx) {
      const bot = bots.get(ctx?.player);
      if (!bot) return;
      bot.position = null;
      clearMovementRequest(ctx.player);
    },

    /** Whether the meet action is getting somewhere: walking, or waiting at the place for the others. */
    meetProgress(ctx) {
      const bot = bots.get(ctx.player);
      return !!bot?.party?.arrived.has(ctx.player) || bot?.movedAt === ctx.nowMs;
    },

    /** An outing kind of its own: { eligible(player) => boolean, launch(party, member, brain, nowMs) }. */
    addKind(name, kind) {
      kinds.set(name, kind);
    },
    propose,
    advance,
    leave,
    partyOf: (player) => bots.get(player)?.party ?? null,
    speak,
  };
}

module.exports = { GROUPS_CONFIG, GROUP_MINUTES_CONFIG, MEET_ACTIVITY, createBotGroups, loadOutings, worldBotsGroup };
