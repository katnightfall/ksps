"use strict";

/**
 * Ours. A group of levelling bots goes to the Wintertodt (an outing of brain/BotGroups with a
 * kind of its own, "wintertodt" in data/definitions/bot-groups.json).
 *
 * Who may come: a bot with the Firemaking the Doors of Dinh ask for, an axe of its own, and
 * enough cooked food that warms (the minigame's rule: food healing 4 or more) to see a round out.
 * What it does, with what it owns and by the minigame's own rules (plugins/minigames/wintertodt):
 *
 *   packs     at its bank: its food, its axe and its tinderbox; its goods are left there
 *   sails     it walks to Veos at Port Sarim and takes his ship to Port Piscarilius (asked of
 *             the ferries as his dialogue asks it, since a bot cannot work a dialogue), crosses
 *             the gangplank and walks to the Wintertodt camp
 *   meets     the others at the camp, a few minutes at most from the first to arrive
 *   plays     through the Doors of Dinh each takes a corner of its own while there are corners
 *             to go round (the group's first). There it keeps the brazier burning: it chops
 *             bruma roots and feeds them, lights the brazier when it has gone out, mends it with
 *             a hammer from the crate when it is broken, and heals its pyromancer with a
 *             rejuvenation potion. The potion it makes as a player without the Herblore does: an
 *             unfinished one from the crate, a bruma herb from the sprouting roots, and Brew'ma
 *             mixes them. Against the cold it eats its food, and when that is gone drinks the
 *             potion. The clicks are the ones a player makes: Chop, Feed, Light, Fix, Help,
 *             Take, Pick, a herb used on Brew'ma, Enter.
 *   leaves    when a round ends and it has played its rounds, or has earned its crate and is
 *             short of food; at once, round or no round, when it is freezing with nothing left
 *             to warm it, or it has been in there too long (the doors ask whether to throw the
 *             round away, and it says yes). It searches the reward cart for what it earned, and
 *             sails home the way it came.
 *
 * Two things the game does for people only, done here for a bot on this trip. Its zone hooks
 * (World runs them from a person's turn, not a bot's): the Wintertodt hangs the cold, the
 * warmth meter and the reward at a round's end on who has walked into the prison, so without
 * them a bot was not there to the minigame. And Brew'ma: she is not among this server's
 * spawns, so the first bot through the doors puts her at her place by the crates if she is not
 * there (people without the Herblore may use her as well, as in the game itself).
 *
 * What it does not do: fletch the roots into kindling, or step out from under the Wintertodt's
 * area attack; without warm clothes and at the Firemaking it comes with, the cold takes a good
 * deal of its time.
 *
 * A bot found in Great Kourend, or on Veos's deck, with no trip under way (the server
 * restarted under it) is sent home the same way, so none is left stranded across the sea. That
 * much stays when a world turns the trip off (world setting "PlayerBots:wintertodt", default
 * on), so the setting can be changed while bots are over there.
 */
const { Skill } = require("../../../src/main/typescript/elvarg/game/model/Skill");
const { Location } = require("../../../src/main/typescript/elvarg/game/model/Location");
const { MapObjects } = require("../../../src/main/typescript/elvarg/game/entity/impl/object/MapObjects");
const { ObjectDefinition } = require("../../../src/main/typescript/elvarg/game/definition/ObjectDefinition");
const { ItemIdentifiers } = require("../../../src/main/typescript/elvarg/util/ItemIdentifiers");
const { PluginManager } = require("../../../src/main/typescript/elvarg/plugins/PluginManager");
const { UseItemPacketListener } = require("../../../src/main/typescript/elvarg/net/packet/impl/UseItemPacketListener");
const { requestMovement, peekMovementRequest, clearMovementRequest } = require("../behaviours/navigation/Navigation.PlayerBots");
const { foodBite } = require("../../items/Food.plugin");
const Woodcutting = require("../../skills/Woodcutting.plugin");
const Shared = require("../../minigames/wintertodt/Shared.Wintertodt");
const Round = require("../../minigames/wintertodt/Round.Wintertodt");
const Corners = require("../../minigames/wintertodt/Corners.Wintertodt");
const Warmth = require("../../minigames/wintertodt/Warmth.Wintertodt");
const { npcName } = require("../../minigames/wintertodt/Supplies.Wintertodt");
const { bankedWhere, carried, earnsOwnItems, ownItemsFor } = require("./OwnItems.PlayerBots");

/** The activity a trip runs as (bot-activities.json). */
const TRIP_ACTIVITY = "wintertodt_trip";
const KIND = "wintertodt";

// Where things are. Veos stands on the docks at both ends; his ship puts a passenger on its deck.
const SARIM_VEOS = Object.freeze({ x: 3054, y: 3245, z: 0 });
const PISCARILIUS_VEOS = Object.freeze({ x: 1825, y: 3691, z: 0 });
const CAMP = Object.freeze({ x: 1630, y: 3944, z: 0 });
/**
 * A point on the way between the docks and the camp, just north of the Arceuus Library. The
 * shortest walk goes through the library, whose east doors a bot does not get open (every bot
 * of the first trial stopped in front of them); by way of this point it goes round the building.
 */
const PAST_LIBRARY = Object.freeze({ x: 1650, y: 3838, z: 0 });
const DOORS = Object.freeze({ x: 1630, y: 3963, z: 0 });
const PRISON_MIDDLE = Object.freeze({ x: 1630, y: 4006, z: 0 });
/** The corridor behind the doors, where the crates and the sprouting roots are and no cold reaches. */
const CORRIDOR = Object.freeze({ x: 1630, y: 3981, z: 0 });
/** Where Brew'ma stands in the game (the Wiki's map of her), by the crates. */
const BREWMA = Object.freeze({ x: 1635, y: 3986, z: 0 });
const TO_KOUREND = "kourend-piscarilius";
const TO_SARIM = "kourend-sarim";
/** Great Kourend and the Kebos lowlands, roughly: the land a bot cannot walk home from. */
const inKourend = (at) => at.getX() >= 1150 && at.getX() <= 1960 && at.getY() >= 3350 && at.getY() <= 4100;

// Food that warms (heals this much or more), how much of it a bot takes, and how little is too little to go.
const WARMING_HEAL = 4;
const FOOD_TAKEN = 12;
const FOOD_NEEDED = 6;
const ROAD_COINS = 50;
// It warms itself when its warmth is down to this share (one blow of the area attack takes over
// half of it at 50 Firemaking), eats for its health at that one, and with nothing to warm it
// and no way to make any leaves below the last.
const WARM_AT = 0.65;
const EAT_AT = 0.5;
const FREEZING_AT = 0.35;
// Roots in its backpack before it goes to the brazier.
const FEED_AT = 10;
// Rounds it plays at most, and the food it wants left to start another once it has earned a crate.
const ROUNDS = 2;
const FOOD_FOR_ANOTHER = 4;
// Potions it makes at a time: one to heal with while it has food, more to keep warm with when it has none.
const POTIONS_TO_HEAL = 1;
const POTIONS_TO_WARM = 3;
// She is healed when she has fallen, and when only hurt by one with this many doses to spare.
const DOSES_TO_SPARE = 2;
// Making potions may take this long; one that came to nothing is not tried again for a while.
const BREW_MS = 90_000;
const BREW_REST_MS = 3 * 60_000;
// With no corner it can do anything for, for this long, it leaves.
const IDLE_MS = 4 * 60_000;
// It looks at the game this often, a little slower than a tick, as a player's clicks come.
const LOOK_MS = 1800;
// Not moving this long on a walk: the trip is given up (and the bot turns for home).
const STUCK_MS = 90_000;
// The whole trip may take this long before the rotation moves the bot on; a party waits as long.
const TRIP_MS = 75 * 60_000;
// A bot in Kourend with no trip is looked for this often.
const STRANDED_LOOK_MS = 60_000;
// Longer than this behind the doors and it leaves when the round ends; longer than the other, round or no round.
const PLAY_MS = 25 * 60_000;
const LONGEST_MS = 40 * 60_000;
/** The doors' question to one leaving in the middle of a round (minigames/wintertodt/Doors). */
const LEAVE_QUESTION = "Are you sure you want to leave?";
// Further from an object than this, it walks nearer before it clicks.
const CLICK_RANGE = 12;
const NEAR = 3;
// This near Veos and a floor up is his ship's deck.
const DECK_RANGE = 12;

const apart = (at, spot) => Math.max(Math.abs(at.getX() - spot.x), Math.abs(at.getY() - spot.y));

function createBotWintertodt({ world, groups = null, registry, emit, ambition = null, spawnNpc = null, goes = true }) {
  const core = world.core;
  const own = ownItemsFor(world);
  const bots = new WeakMap();
  const botFor = (player) => {
    let bot = bots.get(player);
    if (!bot) bots.set(player, (bot = { phase: null, lookAt: 0, strandedAt: 0 }));
    return bot;
  };
  const say = (event, player, extra = {}) => world.log?.(event, { username: player.getUsername?.(), ...extra });

  const warms = (itemId) => Number(foodBite(itemId)?.food?.heal ?? 0) >= WARMING_HEAL;
  const foodCarried = (player) => (player.getInventory().getItems() ?? []).filter((item) => warms(item?.getId?.())).length;
  const foodOwned = (player) => foodCarried(player) + bankedWhere(player, warms).reduce((sum, entry) => sum + entry.amount, 0);
  const axes = () => (Woodcutting.AXES_BEST_FIRST ?? []).map((axe) => axe.id);
  const hasAxe = (player) => Woodcutting.findBestUsableAxe?.(player) != null;
  const fuel = (player) => carried(player, Shared.ITEM.BRUMA_ROOT) + carried(player, Shared.ITEM.BRUMA_KINDLING);
  const inPrison = (player) => Shared.inZone(Shared.PRISON_ZONE, player.getLocation());
  const hasHammer = (player) => Shared.hasItem(player, Shared.ITEM.HAMMER);
  // Rejuvenation potions: how many it carries, and the doses in them (a potion of four down to one).
  const potionsCarried = (player) => Shared.POTIONS.reduce((sum, itemId) => sum + carried(player, itemId), 0);
  const dosesCarried = (player) => Shared.POTIONS.reduce((sum, itemId, index) => sum + carried(player, itemId) * (Shared.POTIONS.length - index), 0);
  const slotOf = (player, wanted) => player.getInventory().getItems().findIndex((item) => wanted(item?.getId?.()));

  /** Who burns at which corner: a bot takes the one with the fewest, its group's first. */
  const corners = Shared.CORNERS.map(() => new Set());
  function takeCorner(player, first = 0) {
    for (const there of corners) {
      for (const other of there) if (other === player || !inPrison(other) || bots.get(other)?.phase !== "play") there.delete(other);
    }
    const order = corners.map((_, index) => (first + index) % corners.length);
    const index = order.reduce((best, each) => (corners[each].size < corners[best].size ? each : best), order[0]);
    corners[index].add(player);
    return index;
  }

  /**
   * An object as a player sees it: one that changes with a player's own state (the reward cart
   * fills with what they are owed) has its name and options on the form shown to them.
   */
  const seenBy = (player, object) => (player ? ObjectDefinition.forPlayer(object.getId(), player) : null) ?? object?.getDefinition?.() ?? null;

  /** The objects named `name` within `range` of a spot; `kept`: found once and remembered (they are part of the map). */
  const found = new Map();
  function objectsNamed(name, spot, range, kept = true, player = null) {
    const key = `${name}:${spot.x},${spot.y}`;
    if (kept && found.has(key)) return found.get(key);
    world.regionManager?.loadMapFiles?.(spot.x, spot.y);
    const list = [];
    const seen = new Set();
    for (let x = spot.x - range; x <= spot.x + range; x++) {
      for (let y = spot.y - range; y <= spot.y + range; y++) {
        for (const object of MapObjects.getObjectsAt(new Location(x, y, spot.z ?? 0), null) ?? []) {
          if (!object || seen.has(object) || seenBy(player, object)?.getName?.() !== name) continue;
          seen.add(object);
          list.push(object);
        }
      }
    }
    if (kept && list.length > 0) found.set(key, list);
    return list;
  }
  const nearestTo = (here, objects) => [...objects].sort((a, b) => here.getDistance(a.getLocation()) - here.getDistance(b.getLocation()))[0] ?? null;
  const nearest = (player, objects) => nearestTo(player.getLocation(), objects);

  /** Clicks `option` on an object as a player does: walks to it, then the click. False when it has no such option. */
  function click(player, object, option) {
    if (!object) return false;
    const definition = seenBy(player, object);
    const index = (definition?.getInteractions?.() ?? []).indexOf(option);
    if (index < 0) return false;
    const at = object.getLocation();
    if (player.getLocation().getDistance(at) > CLICK_RANGE) {
      if (!peekMovementRequest(player)) requestMovement(player, at.getX(), at.getY(), { z: at.getZ(), reason: "brain_wintertodt", basicPather: true });
      return true;
    }
    clearMovementRequest(player);
    player.getMovementQueue().walkToObject(object, {
      execute: () => {
        const here = player.getLocation();
        world.emitObjectInteraction?.({
          player, object, definition, objectId: object.getId(), clickType: index + 1,
          location: { x: at.getX(), y: at.getY(), z: at.getZ() },
          sourceLocation: { x: here.getX(), y: here.getY(), z: here.getZ() },
          handled: false,
        });
      },
    }, index + 1);
    return true;
  }

  /** A walk towards a spot. "there" within `near` tiles, "stuck" after too long without a step, else "walking". */
  function walk(ctx, bot, spot, near = NEAR) {
    const { player, nowMs } = ctx;
    const here = player.getLocation();
    if (here.getZ() === spot.z && apart(here, spot) <= near) return "there";
    const position = `${here.getX()},${here.getY()},${here.getZ()}`;
    if (position !== bot.position) {
      bot.position = position;
      bot.movedAt = nowMs;
      bot.moved = true;
    } else if (nowMs - (bot.movedAt ?? nowMs) > STUCK_MS) {
      return "stuck";
    }
    bot.movedAt ??= nowMs;
    if (player.getMovementQueue().size() === 0 && !peekMovementRequest(player)) {
      requestMovement(player, spot.x, spot.y, { nowMs, z: spot.z, reason: "brain_wintertodt", basicPather: true });
    }
    return "walking";
  }

  /** Clicks `option` on a person of the prison as a player does: walks up to them, then the click. */
  function clickNpc(player, npc, option) {
    const index = (npc?.getCurrentDefinition?.(player)?.getActions?.() ?? []).indexOf(option);
    if (index < 0) return false;
    const at = npc.getLocation();
    if (player.getLocation().getDistance(at) > CLICK_RANGE) {
      if (!peekMovementRequest(player)) requestMovement(player, at.getX(), at.getY(), { z: at.getZ(), reason: "brain_wintertodt", basicPather: true });
      return true;
    }
    clearMovementRequest(player);
    player.getMovementQueue().walkToEntity(npc, () => {
      world.emitNpcInteraction?.({
        player, npc, npcId: npc.getId(), npcIndex: npc.getIndex(), clickType: index + 1,
        location: { x: at.getX(), y: at.getY(), z: at.getZ() }, handled: false,
      });
    }, 1);
    return true;
  }

  /** Uses an item it carries on a person of the prison, as a player does (the game walks it up to them). */
  function useOn(player, itemId, npc) {
    const slot = slotOf(player, (id) => id === itemId);
    if (slot < 0 || !npc) return false;
    const at = npc.getLocation();
    if (player.getLocation().getDistance(at) > CLICK_RANGE) {
      if (!peekMovementRequest(player)) requestMovement(player, at.getX(), at.getY(), { z: at.getZ(), reason: "brain_wintertodt", basicPather: true });
      return true;
    }
    clearMovementRequest(player);
    UseItemPacketListener.itemOnNpc(player, core.Inventory.INTERFACE_ID, npc.getIndex(), itemId, slot);
    return true;
  }

  /** The first option of an item it carries, as a player clicks it: Eat, Drink. */
  function consume(player, wanted) {
    const slot = slotOf(player, wanted);
    if (slot < 0) return false;
    core.ItemActionPacketListener.handleAction(player, core.Inventory.INTERFACE_ID, player.getInventory().getItems()[slot].getId(), slot, 1);
    return true;
  }
  /** Eats one piece of warming food. */
  const eat = (player) => consume(player, warms);
  /** Drinks a dose of rejuvenation potion, from the one with the fewest left. */
  const drink = (player) => [...Shared.POTIONS].reverse().some((itemId) => consume(player, (id) => id === itemId));

  /** The people of the prison a bot deals with, found once: a corner's pyromancer, and Brew'ma. */
  const people = { pyromancers: [], brewma: null };
  const there = (npc) => !!npc && npc.isRegistered?.() !== false;
  function pyromancer(index) {
    if (!there(people.pyromancers[index])) people.pyromancers[index] = Corners.pyromancerNpc(index);
    return people.pyromancers[index];
  }
  /** Brew'ma, who mixes the potion for those without the Herblore. Not among this server's spawns: put at her place if she is not there. */
  function brewma() {
    if (there(people.brewma)) return people.brewma;
    const spot = new Location(BREWMA.x, BREWMA.y, BREWMA.z);
    people.brewma = (core.World.getNpcsNear?.(spot, 16) ?? []).find((npc) => npcName(npc) === Shared.NPC.BREWMA) ?? null;
    if (!people.brewma && spawnNpc) {
      people.brewma = spawnNpc({ id: core.NpcIdentifiers.BREWMA, x: BREWMA.x, y: BREWMA.y, z: BREWMA.z, wanderRadius: 0 }) ?? null;
      world.log?.("bot_wintertodt_brewma", { spawned: !!people.brewma, x: BREWMA.x, y: BREWMA.y });
    }
    return people.brewma;
  }

  /** A crate of the corridor by what it gives ("Take-hammer", "Take-concoction"), the nearest to the bot. */
  function crate(player, option) {
    return nearest(player, objectsNamed(Shared.OBJECT.CRATE, CORRIDOR, 10).filter((object) => (object.getDefinition?.()?.getInteractions?.() ?? []).includes(option)));
  }

  /** A corner's brazier as it stands now (unlit, broken or lit). */
  function brazier(index, state) {
    const at = Corners.corner(index).corner.brazier;
    const wanted = { [Shared.BRAZIER.LIT]: Shared.OBJECT.BRAZIER_LIT, [Shared.BRAZIER.UNLIT]: Shared.OBJECT.BRAZIER_UNLIT, [Shared.BRAZIER.BROKEN]: Shared.OBJECT.BRAZIER_BROKEN }[state];
    return (MapObjects.getObjectsAt(new Location(at.x, at.y, 0), null) ?? []).find((object) => object.getId() === wanted) ?? null;
  }

  /**
   * Makes the potions it has set out to (bot.brew of them), a step a look: unfinished ones from
   * the crate, a herb for each from the sprouting roots, and Brew'ma mixes the lot. All of it is
   * in the corridor, out of the cold. True while it is at it.
   */
  function brew(ctx, bot) {
    const { player, nowMs } = ctx;
    const made = potionsCarried(player);
    const unfinished = carried(player, Shared.ITEM.REJUVENATION_UNF);
    const herbs = carried(player, Shared.ITEM.BRUMA_HERB);
    const giveUp = () => {
      bot.brew = 0;
      bot.noBrewUntil = nowMs + BREW_REST_MS;
      say("bot_wintertodt_no_potion", player, { unfinished, herbs, brewma: !!people.brewma });
      return false;
    };
    if (made >= bot.brew) {
      bot.brew = 0;
      say("bot_wintertodt_potion", player, { potions: made, doses: dosesCarried(player) });
      return false;
    }
    if (nowMs - bot.brewSince > BREW_MS) return giveUp();
    if (player.getMovementQueue().size() > 0) return true;
    if (made + unfinished < bot.brew) {
      // No room for another: it makes do with what it has taken.
      if (player.getInventory().getFreeSlots() <= 1) {
        bot.brew = made + unfinished;
        return bot.brew > made;
      }
      const from = crate(player, "Take-concoction");
      return from && click(player, from, "Take-concoction") ? true : giveUp();
    }
    if (herbs < unfinished) {
      if (Shared.actionOf(player) === "pick") return true;
      const roots = nearest(player, objectsNamed(Shared.OBJECT.SPROUTING_ROOTS, CORRIDOR, 10));
      return roots && click(player, roots, "Pick") ? true : giveUp();
    }
    return useOn(player, Shared.ITEM.BRUMA_HERB, brewma()) ? true : giveUp();
  }

  /** Whether a corner can burn as it stands: lit, or unlit with its pyromancer on her feet. */
  const burns = (index) => {
    const corner = Corners.corner(index);
    return corner.brazier === Shared.BRAZIER.LIT || (corner.brazier === Shared.BRAZIER.UNLIT && corner.pyromancerHealthy);
  };
  /** The corner to burn at: its own while it can burn, else the nearest that can. */
  function cornerFor(player, bot) {
    if (burns(bot.corner ?? 0)) return bot.corner ?? 0;
    const here = player.getLocation();
    const open = [0, 1, 2, 3].filter(burns).sort((a, b) =>
      Shared.distance(here, Corners.corner(a).corner.brazier) - Shared.distance(here, Corners.corner(b).corner.brazier));
    return open[0] ?? null;
  }

  /**
   * What its own corner needs before roots: its pyromancer healed, its brazier mended or lit.
   * True when the bot is seeing to it (or to the hammer that takes).
   */
  function tend(ctx, bot) {
    const { player, nowMs } = ctx;
    const index = bot.corner ?? 0;
    const corner = Corners.corner(index);
    const doses = dosesCarried(player);
    const fallen = !corner.pyromancerHealthy;
    // Said once for each thing it turns to, not at every look.
    const seeing = (what, done) => {
      if (done && bot.tending !== what) say("bot_wintertodt_tend", player, { corner: corner.corner.name, what, energy: Round.energyPercent() });
      bot.tending = done ? what : null;
      return done;
    };
    if (fallen || (corner.pyromancerHp < Corners.PYROMANCER_HITPOINTS && doses >= DOSES_TO_SPARE)) {
      if (doses > 0) return seeing(fallen ? "heal the fallen pyromancer" : "heal the pyromancer", clickNpc(player, pyromancer(index), "Help"));
    }
    if (corner.brazier === Shared.BRAZIER.BROKEN) {
      if (!hasHammer(player)) {
        const from = crate(player, "Take-hammer");
        return seeing("take a hammer", !!from && click(player, from, "Take-hammer"));
      }
      const broken = brazier(index, Shared.BRAZIER.BROKEN);
      return seeing("fix the brazier", !!broken && click(player, broken, "Fix"));
    }
    if (corner.brazier === Shared.BRAZIER.UNLIT && !fallen) {
      const unlit = brazier(index, Shared.BRAZIER.UNLIT);
      return seeing("light the brazier", !!unlit && click(player, unlit, "Light"));
    }
    return seeing(null, false);
  }

  /** One look at the round from inside the prison. Returns "play" (carry on), or "leave". */
  function play(ctx, bot) {
    const { player, nowMs } = ctx;
    const active = Round.isActive();
    if (bot.wasActive && !active) {
      bot.rounds = (bot.rounds ?? 0) + 1;
      if ((bot.points ?? 0) >= Shared.REWARD_POINTS) bot.earned = (bot.earned ?? 0) + 1;
      say("bot_wintertodt_round", player, { rounds: bot.rounds, points: bot.points ?? 0, owed: Round.rewardsOwed(player), food: foodCarried(player), doses: dosesCarried(player) });
    }
    bot.wasActive = active;
    if (active) bot.points = Round.pointsOf(player);
    const inside = nowMs - (bot.enteredAt ?? nowMs);
    const idle = player.getMovementQueue().size() === 0;
    if (!active) {
      // Between rounds: off home after its rounds, or with a crate earned and little food left; else it waits for the next.
      if ((bot.rounds ?? 0) >= ROUNDS || inside > PLAY_MS || ((bot.earned ?? 0) >= 1 && foodCarried(player) < FOOD_FOR_ANOTHER)) return "leave";
      // Potions it was at when the round ended wait for the next (no herb is picked between rounds).
      bot.brew = 0;
      // The wait is the time to take a hammer for the braziers of the round to come.
      if (idle && !hasHammer(player)) {
        const from = crate(player, "Take-hammer");
        if (from) click(player, from, "Take-hammer");
      }
      return "play";
    }
    if (inside > LONGEST_MS) return "leave";
    const manager = player.getSkillManager();
    const warmth = Warmth.warmthOf(player) / Shared.MAX_WARMTH;
    const health = player.getHitpoints() / Math.max(1, manager.getMaxLevel(Skill.HITPOINTS));
    if ((warmth <= WARM_AT || health <= EAT_AT) && eat(player)) return "play";
    if (warmth <= WARM_AT && drink(player)) return "play";
    const canBrew = nowMs >= (bot.noBrewUntil ?? 0);
    // Freezing with nothing to warm it and no way to make any: out, and the round is thrown away.
    if (warmth <= FREEZING_AT && foodCarried(player) === 0 && !canBrew) return "leave";
    const doing = Shared.actionOf(player);
    if (doing === "light" || doing === "fix") return "play";
    // A potion to heal its pyromancer with while it has food; a few, to keep warm with, once it has none.
    if (!bot.brew && canBrew && potionsCarried(player) === 0) {
      const room = Math.floor(player.getInventory().getFreeSlots() / 2);
      // No room for the makings: its roots go to the brazier first.
      if (room === 0 && fuel(player) > 0) bot.feeding = true;
      bot.brew = Math.min(room, foodCarried(player) > 0 ? POTIONS_TO_HEAL : POTIONS_TO_WARM);
      bot.brewSince = nowMs;
    }
    if (bot.brew && brew(ctx, bot)) return "play";
    if (!idle) return "play";
    if (tend(ctx, bot)) {
      bot.idleSince = 0;
      return "play";
    }
    const carrying = fuel(player);
    const full = player.getInventory().getFreeSlots() <= 0;
    if (carrying >= FEED_AT || full) bot.feeding = true;
    if (carrying === 0) bot.feeding = false;
    // Feeding is "feed:<corner>" to the minigame.
    if (bot.feeding ? String(doing ?? "").startsWith("feed") : doing === "chop") return "play";
    const index = cornerFor(player, bot);
    if (index === null) {
      // Nothing it can do for any corner: it does not stand there for good.
      return nowMs - (bot.idleSince ||= nowMs) > IDLE_MS ? "leave" : "play";
    }
    bot.idleSince = 0;
    const corner = Corners.corner(index);
    if (bot.feeding) {
      const burning = brazier(index, corner.brazier);
      if (burning) click(player, burning, corner.brazier === Shared.BRAZIER.LIT ? "Feed" : "Light");
      return "play";
    }
    // The roots nearest that corner's brazier.
    const roots = nearestTo(new Location(corner.corner.brazier.x + 1, corner.corner.brazier.y + 1, 0), objectsNamed(Shared.OBJECT.ROOTS, PRISON_MIDDLE, 26));
    if (roots) click(player, roots, "Chop");
    return "play";
  }

  /** The trip, a phase at a time. Each returns the next phase's name, or null to stay. */
  const phases = {
    /** At its bank: food, axe and tinderbox with it, its goods left there. */
    pack(ctx, bot) {
      const { player } = ctx;
      const result = own.bankTrip(ctx, "wintertodt", {
        keep: (itemId) => warms(itemId) || axes().includes(itemId) || itemId === ItemIdentifiers.TINDERBOX || itemId === ItemIdentifiers.COINS,
        withdraw: (who) => {
          const list = [];
          let wanted = FOOD_TAKEN - foodCarried(who);
          for (const entry of bankedWhere(who, warms)) {
            if (wanted <= 0) break;
            list.push({ itemId: entry.itemId, amount: Math.min(wanted, entry.amount) });
            wanted -= Math.min(wanted, entry.amount);
          }
          if (!hasAxe(who)) for (const entry of bankedWhere(who, (itemId) => axes().includes(itemId)).slice(0, 1)) list.push({ itemId: entry.itemId, amount: 1 });
          if (carried(who, ItemIdentifiers.TINDERBOX) === 0) list.push({ itemId: ItemIdentifiers.TINDERBOX, amount: 1 });
          // A few coins for the road (the toll gate out of Al Kharid).
          if (carried(who, ItemIdentifiers.COINS) < ROAD_COINS) list.push({ itemId: ItemIdentifiers.COINS, amount: ROAD_COINS - carried(who, ItemIdentifiers.COINS) });
          return list;
        },
      });
      if (result === "running") return null;
      if (result === "failed" || foodCarried(player) < FOOD_NEEDED || !hasAxe(player)) return "abandon";
      return inKourend(player.getLocation()) ? "camp" : "sarim";
    },
    /** To Veos on the Port Sarim docks, and aboard. */
    sarim: (ctx, bot) => board(ctx, bot, SARIM_VEOS, TO_KOUREND, "ashore"),
    /** Off the ship's deck by its gangplank. */
    ashore: (ctx, bot) => cross(ctx, bot, "camp"),
    /** The walk across Kourend to the camp, where the group meets. */
    camp(ctx, bot) {
      if (!bot.pastLibrary && ctx.player.getLocation().getY() < PAST_LIBRARY.y - 6) {
        const leg = walk(ctx, bot, PAST_LIBRARY, 6);
        if (leg === "stuck") return "home";
        if (leg !== "there") return null;
      }
      if (!bot.pastLibrary) {
        bot.pastLibrary = true;
        bot.position = null;
        bot.movedAt = undefined;
      }
      const result = groups?.partyOf(ctx.player) ? groups.meet(ctx) : walk(ctx, bot, CAMP, 6);
      if (result === "failed" || result === "stuck") return "home";
      return result === "success" || result === "there" ? "enter" : null;
    },
    /** Through the Doors of Dinh. */
    enter(ctx, bot) {
      const { player, nowMs } = ctx;
      if (inPrison(player)) {
        bot.rounds = 0;
        bot.enteredAt = nowMs;
        bot.wasActive = Round.isActive();
        bot.corner = takeCorner(player, bot.partyCorner ?? 0);
        say("bot_wintertodt_entered", player, { food: foodCarried(player), corner: Shared.CORNERS[bot.corner].name, brewma: !!brewma() });
        return "play";
      }
      if (nowMs < bot.lookAt) return null;
      bot.lookAt = nowMs + LOOK_MS * 2;
      const state = walk(ctx, bot, DOORS, 8);
      if (state === "stuck") return "home";
      if (state === "there") {
        const doors = nearest(player, objectsNamed(Shared.OBJECT.DOORS, DOORS, 8));
        if (!doors || !click(player, doors, "Enter")) return "home";
      }
      return null;
    },
    play(ctx, bot) {
      const { player, nowMs } = ctx;
      // Dead of the cold, or put out: the game sent it elsewhere.
      if (!inPrison(player)) {
        say("bot_wintertodt_put_out", player, { points: bot.points ?? 0, food: foodCarried(player), x: player.getLocation().getX(), y: player.getLocation().getY() });
        return inKourend(player.getLocation()) ? "reward" : "done";
      }
      if (nowMs < bot.lookAt) return null;
      bot.lookAt = nowMs + LOOK_MS;
      return play(ctx, bot) === "leave" ? "leave" : null;
    },
    /** Out by the doors, then to the cart. In the middle of a round the doors ask first, and it answers. */
    leave(ctx, bot) {
      const { player, nowMs } = ctx;
      if (!inPrison(player)) return "reward";
      if (nowMs < bot.lookAt) return null;
      bot.lookAt = nowMs + LOOK_MS * 2;
      if (core.MultiChatboxPrompt.getPending(player)?.title === LEAVE_QUESTION) {
        // The first answer, "Leave and lose all progress.", picked as a player's click picks it.
        core.MultiChatboxPrompt.handleInterfaceActionClick({ player, buttonId: core.MultiChatboxPrompt.OPTIONS_WIDGET_ID, slot: 1 });
        return null;
      }
      const doors = nearest(player, objectsNamed(Shared.OBJECT.DOORS, DOORS, 8));
      if (doors && player.getMovementQueue().size() === 0) click(player, doors, "Enter");
      return null;
    },
    /** What it earned, from the reward cart. */
    reward(ctx, bot) {
      const { player, nowMs } = ctx;
      bot.owedAtCart ??= Round.rewardsOwed(player);
      if (Round.rewardsOwed(player) <= 0 || player.getInventory().getFreeSlots() <= 0 || nowMs > (bot.rewardUntil ??= nowMs + 60_000)) {
        say("bot_wintertodt_done", player, { rounds: bot.rounds ?? 0, earned: bot.earned ?? 0, taken: bot.owedAtCart - Round.rewardsOwed(player), owed: Round.rewardsOwed(player) });
        return "home";
      }
      if (nowMs < bot.lookAt) return null;
      bot.lookAt = nowMs + LOOK_MS * 3;
      // The search goes on by itself, a handful at a time, once it has been started.
      if (Shared.actionOf(player) === "cart") return null;
      const cart = nearest(player, objectsNamed(Shared.OBJECT.REWARD_CART, CAMP, 24, true, player));
      if (!cart || !(click(player, cart, "Big-search") || click(player, cart, "Search"))) {
        say("bot_wintertodt_no_cart", player, { owed: Round.rewardsOwed(player), found: !!cart });
        return "home";
      }
      return null;
    },
    /** Back to Veos at Port Piscarilius, and aboard for Port Sarim. */
    home(ctx, bot) {
      const here = ctx.player.getLocation();
      // Still behind the doors (its trip was cut short inside): out first.
      if (inPrison(ctx.player)) return "leave";
      // On Veos's deck at Port Piscarilius (it gave the gangplank up on the way out): ashore first.
      if (here.getZ() === 1 && apart(here, PISCARILIUS_VEOS) <= DECK_RANGE && !bot.sailedAt) return cross(ctx, bot, "home");
      // From the camp's side of the library: round it, as on the way out.
      if (!bot.pastLibrary && inKourend(here) && here.getZ() === 0 && here.getY() > PAST_LIBRARY.y + 6 && here.getX() < 1700) {
        const leg = walk(ctx, bot, PAST_LIBRARY, 6);
        if (leg === "stuck") return "abandon";
        if (leg !== "there") return null;
      }
      if (!bot.pastLibrary) {
        bot.pastLibrary = true;
        bot.position = null;
        bot.movedAt = undefined;
      }
      return inKourend(here) || here.getZ() !== 0 ? board(ctx, bot, PISCARILIUS_VEOS, TO_SARIM, "landed") : "done";
    },
    landed: (ctx, bot) => cross(ctx, bot, "done"),
  };

  /** Walks to Veos and takes his ship. `then` once the ship has put the bot down at the other end. */
  function board(ctx, bot, veos, route, then) {
    const { player, nowMs } = ctx;
    const here = player.getLocation();
    // On a deck: the voyage is over.
    if (bot.sailedAt && here.getZ() === 1 && apart(here, veos) > 64) {
      bot.sailedAt = 0;
      return then;
    }
    if (bot.sailedAt) return nowMs - bot.sailedAt > 60_000 ? (bot.sailedAt = 0, "abandon") : null;
    const state = walk(ctx, bot, veos, 2);
    if (state === "stuck") return "abandon";
    if (state !== "there") return null;
    const request = { player, route };
    emit("ferries:travel", request);
    if (request.handled !== true) return "abandon";
    bot.sailedAt = nowMs;
    bot.position = null;
    say("bot_wintertodt_sailed", player, { route });
    return null;
  }

  /** From a ship's deck to the dock beside it, over the gangplank. */
  function cross(ctx, bot, then) {
    const { player, nowMs } = ctx;
    const here = player.getLocation();
    if (here.getZ() === 0) return then;
    if (nowMs < bot.lookAt) return null;
    bot.lookAt = nowMs + LOOK_MS * 2;
    if (nowMs - (bot.deckSince ??= nowMs) > STUCK_MS) return "abandon";
    const plank = nearest(player, objectsNamed("Gangplank", { x: here.getX(), y: here.getY(), z: here.getZ() }, 8, false));
    if (plank && player.getMovementQueue().size() === 0) click(player, plank, "Cross");
    return null;
  }

  function begin(player, phase, extra = {}) {
    const bot = botFor(player);
    Object.assign(bot, { phase, lookAt: 0, position: null, movedAt: undefined, sailedAt: 0, deckSince: undefined, rewardUntil: undefined, owedAtCart: undefined, enteredAt: undefined, pastLibrary: false, rounds: 0, earned: 0, points: 0, feeding: false, wasActive: false, brew: 0, noBrewUntil: 0, idleSince: 0, ...extra });
    return bot;
  }

  const api = {
    TRIP_ACTIVITY,
    /** Whether a bot could go: the outing's activity asks the Firemaking; this, the rest. */
    eligible(player) {
      // Not one already on its way there or back.
      if (bots.get(player)?.phase || inKourend(player.getLocation())) return false;
      return earnsOwnItems(player) && foodOwned(player) >= FOOD_NEEDED &&
        (hasAxe(player) || bankedWhere(player, (itemId) => axes().includes(itemId)).length > 0);
    },

    /** A member of a party sets off: its work becomes the trip. */
    launch(party, member, brain, nowMs) {
      party.expiresAt = nowMs + TRIP_MS;
      // The corner the group starts from, drawn once for the party: its first in takes it, the rest the ones beside.
      party.corner ??= Math.floor(Math.random() * 4);
      begin(member, "pack", { partyCorner: party.corner });
      brain.replaceRoot(registry.byId.get(TRIP_ACTIVITY), nowMs);
      brain.switchAt = nowMs + TRIP_MS;
      say("bot_wintertodt_trip", member, { leader: party.leader.getUsername?.() });
    },

    /** The trip action's update. */
    step(ctx) {
      const { player } = ctx;
      const bot = botFor(player);
      if (!bot.phase) return "success";
      // Around the camp it is given the game's zone hooks, which a bot's turn does not run: the
      // minigame hangs the cold, the points and the reward on who has walked in (and out).
      const around = Shared.inZone(Shared.CAMP_ZONE, player.getLocation()) || inPrison(player);
      if (around || bot.around) PluginManager.updatePlayerZones?.(player);
      bot.around = around;
      // Where a trip has got to, once a minute: a long walk says nothing else for a long while.
      if (ctx.nowMs >= (bot.saidAt ?? 0)) {
        bot.saidAt = ctx.nowMs + 60_000;
        say("bot_wintertodt_at", player, {
          phase: bot.phase, x: player.getLocation().getX(), y: player.getLocation().getY(), z: player.getLocation().getZ(),
          // Behind the doors: how the round and the bot are doing.
          ...(inPrison(player) ? {
            energy: Round.energyPercent(), lit: Corners.litCount(), points: Round.pointsOf(player), warmth: Warmth.warmthOf(player),
            food: foodCarried(player), doses: dosesCarried(player), roots: fuel(player), doing: Shared.actionOf(player),
            corner: Shared.CORNERS[bot.corner ?? 0].name, brazier: Corners.corner(bot.corner ?? 0).brazier, pyromancer: Corners.corner(bot.corner ?? 0).pyromancerHp,
          } : {}),
        });
      }
      for (let turns = 0; turns < 4; turns++) {
        const next = phases[bot.phase](ctx, bot);
        if (next === null) return "running";
        if (next !== bot.phase) say("bot_wintertodt_phase", player, { from: bot.phase, to: next, x: player.getLocation().getX(), y: player.getLocation().getY() });
        if (next === "done" || next === "abandon") {
          const stranded = inKourend(player.getLocation());
          // Given up across the sea: home first.
          if (next === "abandon" && stranded && bot.phase !== "home" && bot.phase !== "landed") {
            begin(player, "home");
            continue;
          }
          bot.phase = null;
          const party = groups?.partyOf(player);
          if (party) groups.leave(party, player);
          return next === "done" ? "success" : "failed";
        }
        bot.phase = next;
        bot.position = null;
        bot.movedAt = undefined;
        bot.lookAt = 0;
        bot.pastLibrary = false;
        // Each crossing of a gangplank has its own time (the one home is half an hour after the one out).
        bot.deckSince = undefined;
      }
      return "running";
    },

    stop(ctx) {
      clearMovementRequest(ctx.player);
      own.stop(ctx);
    },

    /** Whether the trip is getting somewhere: a step taken, a voyage, or a round being played (a bot chops on one spot for minutes). */
    progress(ctx) {
      const bot = bots.get(ctx.player);
      if (!bot) return false;
      const here = ctx.player.getLocation();
      const position = [here.getX(), here.getY(), here.getZ()].join(",");
      const moved = position !== bot.seenAt;
      bot.seenAt = position;
      // Waiting at the camp for the rest of its group is not standing stuck.
      const waiting = bot.phase === "camp" && groups?.partyOf(ctx.player)?.arrived?.has(ctx.player) === true;
      return moved || waiting || bot.phase === "play" || bot.phase === "leave" || bot.phase === "reward" || !!bot.sailedAt;
    },

    /** Whether the rotation must wait: a bot across the sea comes home before it turns to other work. */
    holds: (player) => !!bots.get(player)?.phase && inKourend(player.getLocation()),

    /** Every tick of a bot with a mind: one found across the sea, or left on Veos's deck, with no trip under way is sent home. */
    tick(brain, nowMs = Date.now()) {
      const player = brain.player;
      const bot = botFor(player);
      if (nowMs < bot.strandedAt) return;
      bot.strandedAt = nowMs + STRANDED_LOOK_MS;
      if (bot.phase || brain.frames.length !== 1 || brain.isRunningActivity(TRIP_ACTIVITY)) return;
      const here = player.getLocation();
      const onDeck = here.getZ() === 1 && apart(here, SARIM_VEOS) <= DECK_RANGE;
      if (!inKourend(here) && !onDeck) return;
      const trip = registry.byId.get(TRIP_ACTIVITY);
      if (!trip) return;
      begin(player, onDeck ? "landed" : "home");
      brain.replaceRoot(trip, nowMs);
      brain.switchAt = nowMs + TRIP_MS;
      say("bot_wintertodt_stranded", player, { x: player.getLocation().getX(), y: player.getLocation().getY() });
    },
    phaseOf: (player) => bots.get(player)?.phase ?? null,
    begin,
    play,
    warms,
  };
  // A world that has turned the trip off (`goes` false) keeps only the way home, for a bot the
  // setting left across the sea: nothing proposes the outing, and Firemaking is no goal.
  if (goes) {
    groups.addKind(KIND, { eligible: api.eligible, launch: api.launch });
    // The Firemaking the doors ask for is a level worth going after, got by burning what it chops.
    ambition?.addUnlock({ skill: Skill.FIREMAKING, level: Shared.FIREMAKING_REQUIRED, mode: "woodcutting", unlocks: KIND });
  }
  ambition?.addTicker(api.tick);
  return api;
}

module.exports = { KIND, TRIP_ACTIVITY, createBotWintertodt, inKourend };
