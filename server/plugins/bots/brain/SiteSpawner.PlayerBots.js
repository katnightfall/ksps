"use strict";

const crypto = require("crypto");
const { GameConstants } = require("../../../src/main/typescript/elvarg/game/GameConstants");
const { PlayerSave } = require("../../../src/main/typescript/elvarg/game/entity/impl/player/persistence/PlayerSave");
const { Location } = require("../../../src/main/typescript/elvarg/game/model/Location");
const { attachBrain } = require("./AttachBrain.PlayerBots");
const { sharedRouteFinder } = require("./DoorOpening.PlayerBots");
const { RETURN_ATTRIBUTE, returnTile } = require("./actions/RunCourse.PlayerBots");
const { runPaced } = require("../runtime/SpawnPacing.PlayerBots");
const { botActivityAllowed } = require("../behaviours/spawn/PlayerFactory.PlayerBots");
const { Skill } = require("../../../src/main/typescript/elvarg/game/model/Skill");
const { SkillManager } = require("../../../src/main/typescript/elvarg/game/content/skill/SkillManager");
const { Flag } = require("../../../src/main/typescript/elvarg/game/model/Flag");
const { Item } = require("../../../src/main/typescript/elvarg/game/model/Item");
const { Equipment } = require("../../../src/main/typescript/elvarg/game/model/container/impl/Equipment");
const { ItemIdentifiers } = require("../../../src/main/typescript/elvarg/util/ItemIdentifiers");

/**
 * A site's `levels` sets every skill (a number) or named skills ({ "all": 40,
 * "mining": 60 }) on a freshly spawned bot, so tiers can be tested without
 * levelling up. A [min, max] pair rolls a level in the band per skill, so a
 * site's crowd is not one flat level. Hitpoints never go below 10. Agility is
 * always 99 so every shortcut on a bot's route is usable.
 */
function rollLevel(value) {
  if (Array.isArray(value) && value.length === 2) {
    const min = Number(value[0]);
    const max = Number(value[1]);
    if (Number.isFinite(min) && Number.isFinite(max)) {
      return Math.round(min + Math.random() * (max - min));
    }
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
}

const COMBAT_SKILLS = [Skill.ATTACK, Skill.STRENGTH, Skill.DEFENCE, Skill.HITPOINTS, Skill.RANGED, Skill.MAGIC, Skill.PRAYER];

/** SkillManager.getCombatLevel over [attack, strength, defence, hitpoints, ranged, magic, prayer]. */
function combatLevelOf([attack, strength, defence, hp, ranged, magic, prayer]) {
  return SkillManager.calculateCombatLevel([attack, defence, strength, hp, ranged, prayer, magic]);
}

/**
 * Combat stats (COMBAT_SKILLS order) whose combat level lands in [min, max]: aim at a
 * level in the band, find the even stat level that reaches it, then jitter each stat a
 * little so a crowd isn't uniform. Falls back to the even stats if jitter leaves the band.
 */
function rollCombatStats([min, max]) {
  const clamp = (level, floor = 1) => Math.max(floor, Math.min(99, level));
  const even = (level) => COMBAT_SKILLS.map((skill) => clamp(level, skill === Skill.HITPOINTS ? 10 : 1));
  const target = min + Math.floor(Math.random() * (max - min + 1));
  let base = 1;
  while (base < 99 && combatLevelOf(even(base)) < target) base++;
  for (let attempt = 0; attempt < 20; attempt++) {
    const stats = even(base).map((level, index) =>
      clamp(level + Math.floor(Math.random() * 9) - 4, COMBAT_SKILLS[index] === Skill.HITPOINTS ? 10 : 1));
    const combat = combatLevelOf(stats);
    if (combat >= min && combat <= max) return stats;
  }
  return even(base);
}

function applyLevels(bot, levels) {
  if (levels == null) return;
  const manager = bot.getSkillManager?.();
  if (!manager) return;
  // `combat: [min, max]` is a combat level band; the combat stats are rolled to land in it.
  const combat = Array.isArray(levels.combat) ? rollCombatStats(levels.combat) : null;
  for (const skill of Skill.values()) {
    const name = String(skill.getName?.() ?? skill.toString?.() ?? "").toLowerCase();
    const combatIndex = combat ? COMBAT_SKILLS.indexOf(skill) : -1;
    let level = skill === Skill.AGILITY
      ? 99
      : combatIndex >= 0
        ? combat[combatIndex]
        : rollLevel(typeof levels === "number" ? levels : levels[name] ?? levels.all);
    if (!Number.isFinite(level)) continue;
    level = Math.max(skill === Skill.HITPOINTS ? 10 : 1, Math.min(99, Math.floor(level)));
    manager.setCurrentLevel(skill, level, false).setMaxLevels(skill, level, false)
      .setExperience(skill, SkillManager.getExperienceForLevel(level));
  }
  bot.getUpdateFlag?.()?.flag?.(Flag.APPEARANCE);
}

/** Wearable kit per tier; a bot draws one random item per slot, so crowds vary. */
const SKILLING_OUTFITS = Object.freeze({
  novice: {
    head: ["LEATHER_COWL", "BRONZE_MED_HELM", "IRON_MED_HELM", "WIZARD_HAT", "BLUE_WIZARD_HAT"],
    cape: ["BLUE_CAPE", "RED_CAPE", "GREEN_CAPE", "YELLOW_CAPE", "ORANGE_CAPE", "PURPLE_CAPE"],
    amulet: ["AMULET_OF_STRENGTH", "AMULET_OF_DEFENCE", "AMULET_OF_MAGIC"],
    body: ["LEATHER_BODY", "BRONZE_PLATEBODY", "IRON_PLATEBODY", "BLUE_WIZARD_ROBE"],
    legs: ["LEATHER_CHAPS", "BRONZE_PLATELEGS", "IRON_PLATELEGS", "BLUE_SKIRT", "BLACK_SKIRT"],
    hands: ["LEATHER_GLOVES", "BRONZE_GLOVES", "IRON_GLOVES"],
    feet: ["LEATHER_BOOTS", "BRONZE_BOOTS", "IRON_BOOTS"],
  },
  mid: {
    head: ["STEEL_MED_HELM", "MITHRIL_MED_HELM", "WIZARD_HAT", "BLUE_WIZARD_HAT"],
    cape: ["BLACK_CAPE", "BLUE_CAPE", "RED_CAPE", "GREEN_CAPE", "PURPLE_CAPE"],
    amulet: ["AMULET_OF_STRENGTH", "AMULET_OF_DEFENCE", "AMULET_OF_MAGIC"],
    body: ["STUDDED_BODY", "STEEL_PLATEBODY", "MITHRIL_PLATEBODY", "GREEN_DHIDE_BODY", "BLUE_WIZARD_ROBE"],
    legs: ["STUDDED_CHAPS", "STEEL_PLATELEGS", "MITHRIL_PLATELEGS", "GREEN_DHIDE_CHAPS", "BLUE_SKIRT"],
    hands: ["STEEL_GLOVES", "MITHRIL_GLOVES", "LEATHER_GLOVES"],
    feet: ["STEEL_BOOTS", "MITHRIL_BOOTS", "LEATHER_BOOTS", "CLIMBING_BOOTS"],
  },
  advanced: {
    head: ["ADAMANT_MED_HELM", "MITHRIL_MED_HELM", "MYSTIC_HAT", "SPLITBARK_HELM"],
    cape: ["BLACK_CAPE", "RED_CAPE", "BLUE_CAPE", "GREEN_CAPE"],
    amulet: ["AMULET_OF_GLORY", "AMULET_OF_STRENGTH", "AMULET_OF_MAGIC"],
    body: ["ADAMANT_PLATEBODY", "BLUE_DHIDE_BODY", "RED_DHIDE_BODY", "MYSTIC_ROBE_TOP", "SPLITBARK_BODY"],
    legs: ["ADAMANT_PLATELEGS", "BLUE_DHIDE_CHAPS", "RED_DHIDE_CHAPS", "MYSTIC_ROBE_BOTTOM", "SPLITBARK_LEGS"],
    hands: ["ADAMANT_GLOVES", "MITHRIL_GLOVES"],
    feet: ["ADAMANT_BOOTS", "CLIMBING_BOOTS", "FIGHTING_BOOTS"],
  },
  elite: {
    head: ["RUNE_MED_HELM", "ADAMANT_MED_HELM", "MYSTIC_HAT"],
    cape: ["BLACK_CAPE", "GREEN_CAPE", "PURPLE_CAPE", "ORANGE_CAPE"],
    amulet: ["AMULET_OF_GLORY"],
    body: ["RUNE_PLATEBODY", "BLACK_DHIDE_BODY", "MYSTIC_ROBE_TOP", "SPLITBARK_BODY"],
    legs: ["RUNE_PLATELEGS", "BLACK_DHIDE_CHAPS", "MYSTIC_ROBE_BOTTOM", "SPLITBARK_LEGS"],
    hands: ["RUNE_GLOVES", "ADAMANT_GLOVES"],
    feet: ["RUNE_BOOTS", "ADAMANT_BOOTS", "FIGHTING_BOOTS"],
  },
});

/** The outfit tier a site's level band implies (its lowest levels pick the kit). */
function outfitTier(levels) {
  let lowest = null;
  if (typeof levels === "number") {
    lowest = levels;
  } else if (levels && Array.isArray(levels.all)) {
    lowest = Number(levels.all[0]);
  } else if (levels && typeof levels.all === "number") {
    lowest = levels.all;
  }
  if (!Number.isFinite(lowest)) return "novice";
  if (lowest < 20) return "novice";
  if (lowest < 40) return "mid";
  if (lowest < 60) return "advanced";
  return "elite";
}

/** The outfit slots in the order they are filled; the weapon slot stays free for the tool. */
const OUTFIT_SLOTS = Object.freeze({
  head: Equipment.HEAD_SLOT,
  cape: Equipment.CAPE_SLOT,
  amulet: Equipment.AMULET_SLOT,
  body: Equipment.BODY_SLOT,
  legs: Equipment.LEG_SLOT,
  hands: Equipment.HANDS_SLOT,
  feet: Equipment.FEET_SLOT,
});

/** Dress the bot for its tier; the weapon slot stays free for the skill tool. */
function applyOutfit(bot, tier) {
  const pool = SKILLING_OUTFITS[tier] ?? SKILLING_OUTFITS.novice;
  const equipment = bot.getEquipment?.();
  if (!equipment) return;
  for (const [key, slot] of Object.entries(OUTFIT_SLOTS)) {
    const list = pool[key];
    if (!Array.isArray(list) || list.length === 0) continue;
    const id = ItemIdentifiers[list[Math.floor(Math.random() * list.length)]];
    if (id != null) {
      equipment.set(slot, new Item(id, 1));
    }
  }
  equipment.refreshItems();
  bot.getUpdateFlag?.()?.flag?.(Flag.APPEARANCE);
}

const SPAWN_ATTEMPTS = 16;

/**
 * Ours: the bots of a progression site keep their saves, so each needs a name that is the same
 * every time the server starts. Hiscores.plugin.js leaves these names out of the tables.
 */
const PROGRESSION_BOT_NAME = "SiteBot";

/**
 * Ours: the round a progression bot's save belongs to (its site's `startOver` when it was made).
 * A bot whose save is from another round starts over as a new character, so raising the site's
 * number resets the whole crowd without touching the save database by hand.
 */
const START_OVER_ATTRIBUTE = "bots:start-over";
PlayerSave.persistAttribute(START_OVER_ATTRIBUTE, 0);

/** A password no one can log in with: these accounts are never playable by people. */
function lockedPassword() {
  return `${crypto.randomBytes(16).toString("hex")}:${crypto.randomBytes(32).toString("hex")}`;
}

/**
 * Spawns the skilling sites in bot-sites.json as brain-driven bots. Only sites with
 * "enabled": true spawn (temporary until /host controls them).
 */
function startBotSites(options = {}) {
  // The sites are part of the world's population ("PlayerBots:allowedActivities").
  if (!botActivityAllowed("world")) return null;
  const { api, botApi, runtime, registry, world, resetMovementState } = options;
  if (!runtime || !registry || !Array.isArray(registry.sites) || registry.sites.length === 0) {
    return null;
  }
  const RegionManager = api?.getRegionManager?.() ?? null;

  /**
   * Ours: whether a bot standing on (x, y) can walk to the site's anchor. A free tile is not
   * always one a bot can leave: the strip behind Lumbridge castle's east wall is walled in, and
   * a bot put there never got to its first tree. True when it can't be told.
   */
  function reachesAnchor(x, y, anchor) {
    const core = world?.core;
    if (!core?.RsmodRouteFinding) return true;
    try {
      return sharedRouteFinder(core).findRoute({
        level: anchor.z ?? 0, srcX: x, srcY: y, srcSize: 1,
        destX: anchor.x, destY: anchor.y, destWidth: 1, destLength: 1,
        locAngle: 0, blockAccessFlags: 0, locShape: -2, moveNear: false,
        maxWaypoints: 25, privateArea: null,
      }).success === true;
    } catch {
      return true;
    }
  }

  /** A free tile near a site's anchor that a bot can walk away from, or the anchor itself. */
  function spawnTile(site, anchor) {
    const radius = Math.max(0, Math.min(24, Number(site.spawnRadius ?? 6)));
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 1 + Math.floor(Math.random() * Math.max(1, radius));
      const candidate = new Location(
        anchor.x + Math.round(Math.cos(angle) * distance),
        anchor.y + Math.round(Math.sin(angle) * distance),
        anchor.z ?? 0
      );
      if ((!RegionManager || !RegionManager.blocked(candidate, null)) && reachesAnchor(candidate.getX(), candidate.getY(), anchor)) return candidate;
    }
    return new Location(anchor.x, anchor.y, anchor.z ?? 0);
  }

  /**
   * Ours: a progression site's bot. The first time it is a brand-new character at the site's
   * anchor (the world's start location): every skill at 1, Agility too, nothing worn or carried.
   * After that it comes back from its save, where it was, with what it had earned (a bot saved
   * up on an Agility course's roofs comes back on the ground at the course's start). Either way
   * it starts on the best activity its levels allow, in a mode drawn by the site's counts.
   */
  function spawnProgressionBot(site, index) {
    const anchor = site.anchor ?? null;
    if (!anchor || site.activities.length === 0) return false;
    const username = `${PROGRESSION_BOT_NAME}${index + 1}`;
    const persistence = GameConstants.PLAYER_PERSISTENCE ?? null;
    const round = Number(site.startOver ?? 0);
    let saved = null;
    try {
      const save = persistence?.exists?.(username) === true ? persistence.load(username) : null;
      // A save from an earlier round is left unread: the bot starts over, and its next save replaces it.
      if (save && Number(save.attributes?.[START_OVER_ATTRIBUTE] ?? 0) === round) {
        const back = returnTile(save.attributes);
        saved = back ? new Location(back[0], back[1], back[2]) : save.getPosition?.() ?? null;
      }
    } catch {
      saved = null;
    }
    const returning = saved != null;
    RegionManager?.loadMapFiles?.(anchor.x, anchor.y);
    // A bot saved where it was first put, on a tile it could never leave, is put somewhere it can.
    const stranded = returning && saved.getZ() === (anchor.z ?? 0) &&
      Math.max(Math.abs(saved.getX() - anchor.x), Math.abs(saved.getY() - anchor.y)) <= Number(site.spawnRadius ?? 6) + 2 &&
      !reachesAnchor(saved.getX(), saved.getY(), anchor);
    const location = returning && !stranded ? saved.clone() : spawnTile(site, anchor);
    if (returning) RegionManager?.loadMapFiles?.(location.getX(), location.getY());
    // Any of the site's modes will do to start with: the real pick needs the bot and its levels.
    const bot = runtime.spawnPvpBot(location, { username, mode: site.activities[0].mode, activity: "world", persistent: true, fresh: !returning });
    if (!bot) {
      return false;
    }
    bot.setAttribute?.(START_OVER_ATTRIBUTE, round);
    bot.setAttribute?.(RETURN_ATTRIBUTE, null);
    bot.setPasswordHashWithSalt?.(lockedPassword());
    // These bots earn their Agility on the courses like any other skill. One saved before they
    // could still holds the 99 it was handed (exactly level 99's experience): that is taken back.
    const skills = bot.getSkillManager?.();
    if (skills && skills.getMaxLevel(Skill.AGILITY) === 99 && skills.getExperience(Skill.AGILITY) === SkillManager.getExperienceForLevel(99)) {
      skills.setCurrentLevel(Skill.AGILITY, 1, false).setMaxLevels(Skill.AGILITY, 1, false).setExperience(Skill.AGILITY, 0);
    }
    const activity = registry.pickActivity(bot, Date.now(), {
      allowed: site.rotation.activityIds,
      weights: site.rotation.weights,
      best: true,
    }) ?? site.activities.find((candidate) => registry.hasRoom(candidate.id));
    if (!activity) {
      return false;
    }
    return attachBrain({
      runtime,
      registry,
      world,
      bot,
      activity,
      rotation: site.rotation,
      home: anchor,
      resetMovementState,
    });
  }

  function spawn(site, index) {
    if (site.progression === true) return spawnProgressionBot(site, index);
    const anchor = site.anchor ?? null;
    // Start on a random site activity that still has a capacity slot.
    const open = site.activities.filter((activity) => registry.hasRoom(activity.id));
    const activity = open[Math.floor(Math.random() * open.length)];
    if (!anchor || !activity) {
      return false;
    }
    RegionManager?.loadMapFiles?.(anchor.x, anchor.y);
    const radius = Math.max(0, Math.min(24, Number(site.spawnRadius ?? 6)));
    let location = null;
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS && !location; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 1 + Math.floor(Math.random() * Math.max(1, radius));
      const candidate = new Location(
        anchor.x + Math.round(Math.cos(angle) * distance),
        anchor.y + Math.round(Math.sin(angle) * distance),
        anchor.z ?? 0
      );
      if (!RegionManager || !RegionManager.blocked(candidate, null)) {
        location = candidate;
      }
    }
    if (!location) {
      location = new Location(anchor.x, anchor.y, anchor.z ?? 0);
    }

    const bot = runtime.spawnPvpBot(location, { mode: activity.mode, activity: "world" });
    if (!bot) {
      return false;
    }
    applyLevels(bot, site.levels);
    applyOutfit(bot, site.outfit ?? outfitTier(site.levels));
    return attachBrain({
      runtime,
      registry,
      world,
      bot,
      activity,
      rotation: site.rotation,
      home: anchor,
      resetMovementState,
    });
  }

  function start() {
    // Round-robin over the sites so they all fill in together, paced a few per tick.
    const sites = registry.sites
      .filter((site) => site.enabled)
      .map((site) => ({ site, requested: Math.max(0, Math.floor(Number(site.count ?? 0))), spawned: 0 }));
    const jobs = [];
    for (let index = 0; sites.some((entry) => index < entry.requested); index++) {
      for (const entry of sites) {
        if (index < entry.requested) {
          jobs.push(() => {
            if (spawn(entry.site, index)) entry.spawned++;
          });
        }
      }
    }
    runPaced(jobs, () => {
      for (const { site, requested, spawned } of sites) {
        botApi?.log?.("bot_site_spawned", {
          site: site.id,
          activities: site.activities.map((activity) => activity.id),
          requested,
          spawned,
        });
      }
      const spawned = sites.reduce((sum, entry) => sum + entry.spawned, 0);
      if (spawned > 0) {
        botApi?.log?.("bot_sites_started", { spawned });
      }
    });
  }

  if (typeof api?.onServerStartup === "function") {
    api.onServerStartup(() => setTimeout(start, 1000));
  }
  return { start };
}

module.exports = {
  applyLevels,
  applyOutfit,
  combatLevelOf,
  outfitTier,
  startBotSites,
};
