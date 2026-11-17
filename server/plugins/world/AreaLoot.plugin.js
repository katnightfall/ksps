/**
 * Ours. Area loot: a player picks up what lies around them without walking to each pile.
 *
 *   ::loot                     everything they may take within the world's loot distance
 *   ::loot <item> <x> <y>      one pile: that item on that tile
 *
 * The client's Area Loot panel (client/game/plugins/arealoot) lists what is in range and sends
 * these; typed in chat they work the same. GET /api/area-loot tells the panel the distance.
 *
 * What may be taken is what the player could take by walking there, decided by the game's own
 * rules for ground items (ItemOnGroundManager): it is on their floor, they can see it, the
 * take option is theirs (another player's fresh drop is not, an Ironman's rules apply), and the
 * backpack has room. Each pile goes through the same hand-over as a normal take, so every plugin
 * that watches or limits pick-ups still does.
 *
 * Left where it lies: an item that spawns in the world (a quest item on a table has its own
 * way of being taken), and, unless the world allows it, anything while the player is in the
 * Wilderness, where a kill's loot is fought over on foot.
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

let api;
let core;
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
    if (!ItemOnGroundManager.canInteract(player, pile, "pickup")) continue;
    piles.push(pile);
  }
  return piles.sort((a, b) => distance(here, a.getPosition()) - distance(here, b.getPosition()));
}

/**
 * Takes `piles` in order. Returns { taken (piles emptied or drawn from), items (how many items
 * came), full (piles left because the backpack had no room) }.
 */
function take(player, piles) {
  const { ItemOnGroundManager } = core;
  let taken = 0;
  let items = 0;
  let full = 0;
  for (const pile of piles.slice(0, MAX_PILES)) {
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
  return { taken, items, full };
}

function report(player, { taken, items, full }, within) {
  if (taken > 0) {
    core.Sounds?.sendSound?.(player, core.Sound.PICK_UP_ITEM);
    player.getLastItemPickup?.()?.reset?.();
    player.sendMessage(`You pick up ${items.toLocaleString("en-US")} ${items === 1 ? "item" : "items"} from ${taken} ${taken === 1 ? "pile" : "piles"} nearby.`
      + (full > 0 ? ` You have no room for ${full} more.` : ""));
  } else if (full > 0) {
    player.sendMessage("You don't have enough inventory space to pick anything up.");
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
  report(player, take(player, piles), within);
  return true;
}

/** GET /api/area-loot: what the client's panel needs to list the same piles. */
function settings(query, segments) {
  if (segments.length) return undefined;
  return { enabled: enabled(), radius: radius(), wilderness: wildernessAllowed() };
}

module.exports = {
  name: "AreaLoot",
  description: "Area loot: ::loot picks up everything a player may take within the world's loot distance, by the game's own pick-up rules, without walking to each pile. The client's Area Loot panel lists what is in range.",
  config: {
    [ENABLED_CONFIG]: {
      type: "boolean", label: "Area loot", default: true,
      help: "Players may pick up what lies around them with ::loot or the client's Area Loot panel, without walking to each pile.",
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
  _test: { lootCommand, nearby, take, radius, settings, refusal, setApi: (pluginApi) => { api = pluginApi; core = pluginApi.core; }, DEFAULT_RADIUS, MAX_RADIUS, COOLDOWN_TICKS },
};
