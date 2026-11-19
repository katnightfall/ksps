/**
 * Ours. Area loot: a player picks up what lies around them without walking to each pile.
 *
 *   ::loot                     everything they may take within the world's loot distance
 *   ::loot <item> <x> <y>      one pile: that item on that tile
 *
 * The client's Area Loot window (client/game/plugins/arealoot) pops up in the game with what
 * is in range and sends these; typed in chat they work the same. GET /api/area-loot tells the
 * window the distance.
 *
 * What may be taken is what the player could take by walking there, decided by the game's own
 * rules for ground items (ItemOnGroundManager): it is on their floor, they can see it, the
 * take option is theirs (another player's fresh drop is not), there is a way to walk to it (no
 * wall or fence between), and the backpack has room. Each pile is offered to the pick-up hooks
 * a click's Take runs (an Ironman takes no other player's drop, a minigame keeps its own items)
 * and then goes through the same hand-over as a normal take, so every plugin that watches or
 * limits pick-ups still does.
 *
 * Left where it lies: an item that spawns in the world (a quest item on a table has its own
 * way of being taken), and, unless the world allows it, anything in the Wilderness, where a
 * kill's loot is fought over on foot: neither while the player is in it, nor a pile lying in it
 * swept up from the safe side of its edge.
 *
 * World settings: AreaLoot:enabled, AreaLoot:radius (1 to 30 tiles, default 10),
 * AreaLoot:wilderness.
 */
const ENABLED_CONFIG = "AreaLoot:enabled";
const RADIUS_CONFIG = "AreaLoot:radius";
const WILDERNESS_CONFIG = "AreaLoot:wilderness";
const DEFAULT_RADIUS = 10;
const MAX_RADIUS = 30;
/** A sweep is this many game ticks apart at least, per player. */
const COOLDOWN_TICKS = 2;
/** The most piles one sweep takes: a backpack holds 28, and stacks may add a few more. */
const MAX_PILES = 60;
/** How far beyond the loot distance the walk to a pile may stray (round a fence, through a doorway). */
const REACH_MARGIN = 6;

let api;
let core;
let routes;
const lastSweep = new WeakMap();

function radius() {
  const set = Number(api.getPluginConfig?.(RADIUS_CONFIG, DEFAULT_RADIUS));
  return Number.isFinite(set) ? Math.max(1, Math.min(MAX_RADIUS, Math.floor(set))) : DEFAULT_RADIUS;
}
const enabled = () => api.getPluginConfig?.(ENABLED_CONFIG, true) !== false;
const wildernessAllowed = () => api.getPluginConfig?.(WILDERNESS_CONFIG, false) === true;

/** Why this player cannot loot the area right now, or null. */
function refusal(player) {
  if (!enabled()) return "Area loot is switched off on this world.";
  if (player.getHitpoints?.() <= 0 || player.isDyingReturn?.() === true) return "You can't do that right now.";
  if (!wildernessAllowed() && Number(player.getWildernessLevel?.() ?? 0) > 0) return "You can't loot the area in the Wilderness.";
  return null;
}

const distance = (from, to) => Math.max(Math.abs(from.getX() - to.getX()), Math.abs(from.getY() - to.getY()));

/**
 * The piles this player may take from where they stand, nearest first: within the loot
 * distance, on their floor, visible and takeable by the game's own rules, and not a world spawn.
 */
function nearby(player, within = radius()) {
  const { ItemOnGroundManager, World } = core;
  const here = player.getLocation();
  const piles = [];
  for (const pile of World.getItems()) {
    if (!pile || pile.isPendingRemoval?.() === true || pile.isStaticSpawn?.() === true) continue;
    const at = pile.getPosition();
    if (at.getZ() !== here.getZ() || distance(here, at) > within) continue;
    if (pile.getPrivateArea?.() !== player.getPrivateArea?.()) continue;
    // The Wilderness rule is the pile's too: standing a tile outside it is not being out of it.
    if (!wildernessAllowed() && core.Wilderness?.isInLocation?.(at) === true) continue;
    if (!ItemOnGroundManager.canInteract(player, pile, "pickup")) continue;
    piles.push(pile);
  }
  return piles.sort((a, b) => distance(here, a.getPosition()) - distance(here, b.getPosition()));
}

/**
 * The tiles the player can walk to from where they stand, step by step past walls, fences and
 * closed doors, without straying more than REACH_MARGIN tiles beyond the loot distance. One
 * search answers for every pile of a sweep, and its cost has a ceiling whatever lies around.
 * Returns has(x, y).
 */
function walkable(player, within) {
  const { RegionManager } = core;
  const here = player.getLocation();
  const [homeX, homeY, level] = [here.getX(), here.getY(), here.getZ()];
  const privateArea = player.getPrivateArea?.() ?? null;
  const limit = within + REACH_MARGIN;
  const side = limit * 2 + 1;
  const seen = new Uint8Array(side * side);
  const index = (x, y) => (x - homeX + limit) * side + (y - homeY + limit);
  const inside = (x, y) => Math.abs(x - homeX) <= limit && Math.abs(y - homeY) <= limit;
  const queue = [homeX, homeY];
  seen[index(homeX, homeY)] = 1;
  for (let head = 0; head < queue.length; head += 2) {
    const x = queue[head];
    const y = queue[head + 1];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const [toX, toY] = [x + dx, y + dy];
        if ((!dx && !dy) || !inside(toX, toY) || seen[index(toX, toY)]) continue;
        if (!RegionManager.canMove(x, y, toX, toY, level, 1, 1, privateArea)) continue;
        seen[index(toX, toY)] = 1;
        queue.push(toX, toY);
      }
    }
  }
  return { has: (x, y) => inside(x, y) && seen[index(x, y)] === 1 };
}

/**
 * Whether the player could walk to the pile and take it: its tile can be walked to, or a tile
 * beside it can with nothing between (an item on a table or a counter is taken from the tile
 * next to it), as ItemOnGroundManager.pickup asks of a player who has walked up.
 */
function reachable(player, pile, tiles) {
  const at = pile.getPosition();
  if (tiles.has(at.getX(), at.getY())) return true;
  const finder = (routes ??= new core.RsmodRouteFinding());
  const privateArea = player.getPrivateArea?.() ?? null;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if ((!dx && !dy) || !tiles.has(at.getX() + dx, at.getY() + dy)) continue;
      if (finder.reachedAbsolute({
        level: at.getZ(), srcX: at.getX() + dx, srcY: at.getY() + dy, srcSize: 1, destX: at.getX(), destY: at.getY(),
        destWidth: 1, destLength: 1, locShape: -2, privateArea,
      })) return true;
    }
  }
  return false;
}

/**
 * Whether a pick-up hook answers for this pile, as it would for a click's Take (an Ironman is
 * refused another player's drop, a minigame keeps its own items, a pouch takes its runes): the
 * ordinary hand-over is then not ours to make.
 */
function hooked(player, pile) {
  const at = pile.getPosition();
  return core.PluginManager?.emitGroundItemPickup?.({
    player, groundItem: pile, groundItemId: pile.getItem().getId(), clickType: 1,
    location: { x: at.getX(), y: at.getY(), z: at.getZ() }, handled: false,
  }) === true;
}

/**
 * Takes `piles` in order. Returns { taken (piles emptied or drawn from), items (how many items
 * came), full (piles left because the backpack had no room), unreachable (piles there is no way
 * to walk to) }.
 */
function take(player, piles, within = radius()) {
  const { ItemOnGroundManager } = core;
  let taken = 0;
  let items = 0;
  let full = 0;
  let unreachable = 0;
  let tried = 0;
  const tiles = piles.length ? walkable(player, within) : null;
  for (const pile of piles) {
    if (!reachable(player, pile, tiles)) {
      unreachable++;
      continue;
    }
    if (++tried > MAX_PILES) break;
    // The hooks first, as a click's Take has them: one may take the pile where the backpack has no room.
    const lying = pile.getItem().getAmount();
    if (hooked(player, pile)) {
      // A hook that took the pile itself (into a pouch or a quiver) took all of it.
      if (pile.isPendingRemoval?.() === true) {
        taken++;
        items += lying;
      }
      continue;
    }
    // No room for this one: the next may still stack on to something carried.
    if (ItemOnGroundManager.inventoryCapacity(player, ItemOnGroundManager.rewardItem(player, pile, "pickup")) <= 0) {
      full++;
      continue;
    }
    const came = ItemOnGroundManager.transferToInventory(player, pile, "pickup");
    if (came > 0) {
      taken++;
      items += came;
    }
  }
  return { taken, items, full, unreachable };
}

function report(player, { taken, items, full, unreachable = 0 }, within) {
  if (taken > 0) {
    core.Sounds?.sendSound?.(player, core.Sound.PICK_UP_ITEM);
    player.getLastItemPickup?.()?.reset?.();
    player.sendMessage(`You pick up ${items.toLocaleString("en-US")} ${items === 1 ? "item" : "items"} from ${taken} ${taken === 1 ? "pile" : "piles"} nearby.`
      + (full > 0 ? ` You have no room for ${full} more.` : "")
      + (unreachable > 0 ? ` You can't reach ${unreachable} more.` : ""));
  } else if (full > 0) {
    player.sendMessage("You don't have enough inventory space to pick anything up.");
  } else if (unreachable > 0) {
    player.sendMessage(unreachable === 1 ? "You can't reach that." : "You can't reach what lies nearby.");
  } else {
    player.sendMessage(`There is nothing to pick up within ${within} ${within === 1 ? "tile" : "tiles"}.`);
  }
}

/** ::loot, and ::loot <item> <x> <y> for one pile. */
function lootCommand({ player, parts }) {
  const no = refusal(player);
  if (no) {
    player.sendMessage(no);
    return true;
  }
  const tick = core.World.getProcessCycle?.() ?? 0;
  if (tick - (lastSweep.get(player) ?? -COOLDOWN_TICKS) < COOLDOWN_TICKS) return true;
  lastSweep.set(player, tick);
  const within = radius();
  let piles = nearby(player, within);
  const [itemId, x, y] = (parts ?? []).slice(1, 4).map(Number);
  if ((parts ?? []).length > 1) {
    if (![itemId, x, y].every(Number.isInteger)) {
      player.sendMessage("Use ::loot to pick up everything nearby, or ::loot <item> <x> <y> for one pile.");
      return true;
    }
    piles = piles.filter((pile) => pile.getItem().getId() === itemId && pile.getPosition().getX() === x && pile.getPosition().getY() === y);
    if (piles.length === 0) {
      player.sendMessage("That is no longer there to pick up.");
      return true;
    }
  }
  report(player, take(player, piles, within), within);
  return true;
}

/** GET /api/area-loot: what the client's window needs to list the same piles. */
function settings(query, segments) {
  if (segments.length) return undefined;
  return { enabled: enabled(), radius: radius(), wilderness: wildernessAllowed() };
}

module.exports = {
  name: "AreaLoot",
  description: "Area loot: ::loot picks up everything a player may take within the world's loot distance, by the game's own pick-up rules, without walking to each pile. The client's Area Loot window lists what is in range.",
  config: {
    [ENABLED_CONFIG]: {
      type: "boolean", label: "Area loot", default: true,
      help: "Players may pick up what lies around them with ::loot or the client's Area Loot window, without walking to each pile.",
    },
    [RADIUS_CONFIG]: {
      type: "number", label: "Area loot distance (tiles)", default: DEFAULT_RADIUS, integer: true, min: 1, max: MAX_RADIUS,
      help: "How far from the player area loot reaches, in tiles (1 to 30).",
    },
    [WILDERNESS_CONFIG]: {
      type: "boolean", label: "Area loot in the Wilderness", default: false,
      help: "Off (recommended): in the Wilderness loot is picked up on foot, so a kill's loot can be fought over.",
    },
  },
  register(pluginApi) {
    api = pluginApi;
    core = pluginApi.core;
    api.registerCommand("loot", lootCommand, undefined, "Pick up everything nearby: ::loot, or ::loot <item> <x> <y> for one pile");
    api.registerContentEndpoint("area-loot", settings);
  },
  _test: { lootCommand, nearby, take, walkable, reachable, radius, settings, refusal, setApi: (pluginApi) => { api = pluginApi; core = pluginApi.core; routes = undefined; }, DEFAULT_RADIUS, MAX_RADIUS, COOLDOWN_TICKS },
};
