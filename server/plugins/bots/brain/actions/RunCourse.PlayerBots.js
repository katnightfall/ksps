"use strict";

/**
 * Ours: one lap of an Agility course, so a bot trains Agility the way a player does. It walks to
 * the course's start, then takes each obstacle in turn through the same click a player makes
 * (Agility.plugin plays the obstacle, gives the XP and counts the lap). A lap is one run of this
 * action; the activity repeats it.
 *
 *   { "type": "runCourse", "course": "draynor", "start": [3104, 3279, 0], "minHitpoints": 0 }
 *
 * `course` is a course's key (plugins/skills/agility/courses), `start` a ground tile beside its
 * first obstacle, and `minHitpoints` what a bot needs before it starts a lap of a course that
 * can hurt (below it the activity fails, and the bot does something else for a while).
 *
 * A roof is not a place a bot can walk away from, so:
 *  - a rotation waits for the lap to end (`holdsRotation`, asked by the brain);
 *  - a bot that falls goes back to the start by itself: the next obstacle is not on its floor;
 *  - a bot whose lap is cut short (its activity stopped, the server restarted) is put back at
 *    the start. The start tile is kept in its save while it is on the roofs for that.
 */

const ObstacleRunner = require("../../../skills/agility/ObstacleRunner.Agility");
const { COURSES } = require("../../../skills/agility/courses/Courses.Agility");
const { MapObjects } = require("../../../../src/main/typescript/elvarg/game/entity/impl/object/MapObjects");
const { Location } = require("../../../../src/main/typescript/elvarg/game/model/Location");
const { PlayerSave } = require("../../../../src/main/typescript/elvarg/game/entity/impl/player/persistence/PlayerSave");
const { clearMovementRequest, requestMovement } = require("../../behaviours/navigation/Navigation.PlayerBots");
const { playerState } = require("../ActionState.PlayerBots");

// Agility.plugin's own: the lap in progress ({ course, index }) and the laps done by course.
const PROGRESS_ATTRIBUTE = "agility.progress";
const LAPS_ATTRIBUTE = "agility.laps";
/** Kept in the save while a bot is on a course's roofs: the ground tile ([x, y, z]) to come back at. */
const RETURN_ATTRIBUTE = "bots:return-to";
PlayerSave.persistAttribute(RETURN_ATTRIBUTE, null);

/** How near the start a bot looks for the first obstacle instead of walking on. */
const START_TILES = 8;
/** How far from where it stands a bot looks for its next obstacle. */
const OBSTACLE_TILES = 24;
/** A bot off the start's floor this near the start is on the course's roofs, not somewhere else upstairs. */
const COURSE_TILES = 64;
const CLICK_GAP_MS = 1800;
/** Clicks on one obstacle that start nothing before the lap is given up. */
const MAX_CLICKS = 10;

const chebyshev = (loc, x, y) => Math.max(Math.abs(loc.getX() - x), Math.abs(loc.getY() - y));

function lapsOf(player, key) {
  const laps = player.getAttribute?.(LAPS_ATTRIBUTE);
  return Number(laps && typeof laps === "object" ? laps[key] ?? 0 : 0);
}

/** The tile a bot saved on a course's roofs comes back at, or null (SiteSpawner reads this from its save). */
function returnTile(attributes) {
  const tile = attributes?.[RETURN_ATTRIBUTE];
  return Array.isArray(tile) && tile.length >= 2 && tile.every(Number.isFinite) ? [tile[0], tile[1], tile[2] ?? 0] : null;
}

function createRunCourseAction(spec, world) {
  const course = COURSES.find((candidate) => candidate.key === spec.course);
  if (!course) {
    throw new Error(`[bot activities] runCourse: unknown course '${spec.course}'`);
  }
  if (!Array.isArray(spec.start) || spec.start.length < 2) {
    throw new Error(`[bot activities] runCourse '${spec.course}' needs a start tile [x, y, z]`);
  }
  const start = { x: Number(spec.start[0]), y: Number(spec.start[1]), z: Number(spec.start[2] ?? 0) };
  const minHitpoints = Math.max(0, Number(spec.minHitpoints ?? 0) || 0);
  /** The lap's obstacles by their place in it; alternates share a place. Only the ones a first click does. */
  const byIndex = new Map();
  for (const obstacle of course.obstacles) {
    if (!Number.isInteger(obstacle.index) || obstacle.object == null || obstacle.option) continue;
    byIndex.set(obstacle.index, [...(byIndex.get(obstacle.index) ?? []), obstacle]);
  }
  const finalIndex = Math.max(...byIndex.keys());
  for (let index = 1; index <= finalIndex; index++) {
    if (!byIndex.has(index)) throw new Error(`[bot activities] runCourse '${course.key}': obstacle ${index} is not one a bot can do`);
  }

  const stateFor = (player) =>
    playerState(action, player, () => ({ laps: null, clickIndex: 0, clicks: 0, lastClickAt: 0, lastPosition: null }));

  /** The nearest object of the lap's obstacle `index` on the bot's floor, within `radius` of (x, y). */
  function findObstacleObject(player, index, x, y, radius) {
    const z = player.getLocation().getZ();
    const wanted = new Map();
    for (const obstacle of byIndex.get(index) ?? []) {
      for (const id of [].concat(obstacle.object)) wanted.set(id, obstacle);
    }
    let best = null;
    let bestDistance = Infinity;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (const object of MapObjects.mapObjects.get(MapObjects.getHash(x + dx, y + dy, z)) ?? []) {
          const obstacle = wanted.get(object?.getId?.());
          if (!obstacle) continue;
          const at = object.getLocation?.();
          if (!at || at.getX() !== x + dx || at.getY() !== y + dy || at.getZ() !== z) continue;
          if (obstacle.at && (obstacle.at[0] !== at.getX() || obstacle.at[1] !== at.getY())) continue;
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          if (distance < bestDistance) {
            best = object;
            bestDistance = distance;
          }
        }
      }
    }
    return best;
  }

  /** Ends whatever the bot was part-way through and, if it is up on the roofs, puts it at the start. */
  function rescue(player) {
    if (ObstacleRunner.isBusy(player)) ObstacleRunner.completeNow(player);
    player.setAttribute(PROGRESS_ATTRIBUTE, null);
    player.setAttribute(RETURN_ATTRIBUTE, null);
    if (player.getLocation().getZ() !== start.z) {
      player.getMovementQueue?.()?.reset?.();
      player.moveTo(new Location(start.x, start.y, start.z));
      world.log?.("bot_brain_course_rescued", { username: player.getUsername?.() ?? null, course: course.key });
    }
  }

  /** Walks to the obstacle (to the tile Agility.plugin routes its click to) and clicks it on arrival. */
  function click(player, bot, object, index, nowMs) {
    if (player.getForceMovement?.() != null || player.getMovementQueue?.()?.size?.() > 0) return "running";
    if (nowMs - bot.lastClickAt < CLICK_GAP_MS) return "running";
    bot.clicks = bot.clickIndex === index ? bot.clicks + 1 : 1;
    bot.clickIndex = index;
    if (bot.clicks > MAX_CLICKS) return "failed";
    bot.lastClickAt = nowMs;
    clearMovementRequest(player);
    const at = object.getLocation();
    player.getMovementQueue().walkToObject(object, {
      execute: () => {
        if (ObstacleRunner.isBusy(player)) return;
        const from = player.getLocation();
        world.emitObjectInteraction?.({
          player,
          object,
          objectId: object.getId(),
          clickType: 1,
          location: { x: at.getX(), y: at.getY(), z: at.getZ() },
          sourceLocation: { x: from.getX(), y: from.getY(), z: from.getZ() },
          handled: false,
        });
      },
    }, 1);
    return "running";
  }

  const action = {
    id: "runCourse",
    update(ctx) {
      const { player, nowMs } = ctx;
      const bot = stateFor(player);
      if (ObstacleRunner.isBusy(player) || player.getHitpoints() <= 0) return "running";
      const laps = lapsOf(player, course.key);
      if (bot.laps == null) bot.laps = laps;
      if (laps > bot.laps) {
        bot.laps = null;
        bot.clicks = 0;
        player.setAttribute(RETURN_ATTRIBUTE, null);
        world.log?.("bot_brain_course_lap", { username: player.getUsername?.() ?? null, course: course.key, laps });
        return "success";
      }
      const loc = player.getLocation();
      const progress = player.getAttribute(PROGRESS_ATTRIBUTE);
      const index = progress?.course === course.key && progress.index < finalIndex ? progress.index + 1 : 1;

      if (index > 1) {
        const object = findObstacleObject(player, index, loc.getX(), loc.getY(), OBSTACLE_TILES);
        if (object) {
          if (!player.getAttribute(RETURN_ATTRIBUTE)) player.setAttribute(RETURN_ATTRIBUTE, [start.x, start.y, start.z]);
          return click(player, bot, object, index, nowMs);
        }
        // The next obstacle is not on this floor: the bot fell (or died and woke elsewhere). Start again.
        player.setAttribute(PROGRESS_ATTRIBUTE, null);
        player.setAttribute(RETURN_ATTRIBUTE, null);
        return "running";
      }

      const fromStart = chebyshev(loc, start.x, start.y);
      if (loc.getZ() !== start.z && fromStart <= COURSE_TILES) {
        // Up on the roofs with no lap to carry on with.
        rescue(player);
        return "running";
      }
      if (loc.getZ() === start.z && fromStart <= START_TILES) {
        if (player.getHitpoints() < minHitpoints) return "failed";
        const object = findObstacleObject(player, 1, start.x, start.y, START_TILES + 4);
        if (object) return click(player, bot, object, 1, nowMs);
      }
      if (player.getForceMovement?.() == null && !(player.getMovementQueue?.()?.size?.() > 0)) {
        requestMovement(player, start.x, start.y, { reason: "brain_course_start", basicPather: true, z: start.z });
      }
      return "running";
    },
    /** Walking, or part-way through an obstacle (which moves the bot itself). */
    madeProgress(ctx) {
      const bot = stateFor(ctx.player);
      const loc = ctx.player.getLocation();
      const position = `${loc.getX()},${loc.getY()},${loc.getZ()}`;
      const moved = bot.lastPosition != null && position !== bot.lastPosition;
      bot.lastPosition = position;
      return moved || ObstacleRunner.isBusy(ctx.player);
    },
    /** True while a lap is under way: the brain changes activity once the bot is back on the ground. */
    holdsRotation(ctx) {
      return ObstacleRunner.isBusy(ctx.player) || ctx.player.getAttribute(PROGRESS_ATTRIBUTE)?.course === course.key;
    },
    stop(ctx) {
      const player = ctx?.player;
      if (!player) return;
      const bot = stateFor(player);
      bot.laps = null;
      bot.clicks = 0;
      bot.clickIndex = 0;
      clearMovementRequest(player);
      if (ObstacleRunner.isBusy(player) || player.getAttribute(PROGRESS_ATTRIBUTE)?.course === course.key) rescue(player);
    },
  };
  return action;
}

module.exports = {
  RETURN_ATTRIBUTE,
  createRunCourseAction,
  returnTile,
};
