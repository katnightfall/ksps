/**
 * Fishing Guild (OSRS Wiki): level 68 Fishing to go through the front door, and temporary boosts
 * count. Inside, an invisible +7 Fishing boost applies to catch rolls.
 *
 * Ours (2026-11-21): the door swings open and shut as the other guild doors do, in Doors.plugin.js
 * (its PASS_THROUGH_GATES entry); it used to be hidden from the player while they crossed, so it
 * seemed to vanish. Only the level check is here.
 */
const GUILD_LEVEL = 68;
const INVISIBLE_BOOST = 7;

// Front door: a wall on the south edge of its tile (cache loc 20925, type 0, rotation 3), so the
// door tile is inside and the tile south of it outside.
const DOOR = Object.freeze({ x: 2611, y: 3394, z: 0 });
const INSIDE = Object.freeze([2611, 3394]);
const OUTSIDE = Object.freeze([2611, 3393]);

// The guild's map region from the door wall up to the docks. It holds only the guild's own spots
// (Wiki: about 11 cage/harpoon and 9 big net/harpoon), so these bounds stand in for the fenced
// grounds. Kylie Minnow's platform (y 3437 up) is not part of the guild and gets no boost.
const GUILD_BOUNDS = Object.freeze({ minX: 2560, maxX: 2623, minY: DOOR.y, maxY: 3436, z: DOOR.z });

let core = null;

function isInGuild(player) {
  const location = player.getLocation?.();
  if (!location) return false;
  const { minX, maxX, minY, maxY, z } = GUILD_BOUNDS;
  const x = location.getX();
  const y = location.getY();
  return location.getZ() === z && x >= minX && x <= maxX && y >= minY && y <= maxY;
}

function invisibleBoost(player) {
  return isInGuild(player) ? INVISIBLE_BOOST : 0;
}

// Leaving is always allowed; only players outside are checked. Ours: a player let in is left to
// Doors.plugin.js (request.handled stays false), which swings the door open and steps them across.
function useGuildDoor(request) {
  if (request.handled) return;
  const { player, location } = request;
  // The swung-open door (on the tile outside for two ticks) is the same loc with the same Open:
  // checked too, or a low level could follow someone else in.
  const onDoor = location.x === DOOR.x && location.z === DOOR.z && (location.y === DOOR.y || location.y === OUTSIDE[1]);
  if (request.objectId !== core.ObjectIdentifiers.DOOR_422 || !onDoor) return;
  const entering = player.getLocation().getY() < INSIDE[1];
  if (entering && player.getSkillManager().getCurrentLevel(core.Skill.FISHING) < GUILD_LEVEL) {
    request.handled = true;
    player.sendMessage(`You need a Fishing level of ${GUILD_LEVEL} to enter the Fishing Guild.`);
  }
}

function attach(api) {
  core = api.core;
  api.onCustomEvent("door:toggle", useGuildDoor);
}

module.exports = { attach, isInGuild, invisibleBoost, useGuildDoor, DOOR, INSIDE, OUTSIDE };
