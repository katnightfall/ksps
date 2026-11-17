/**
 * Ours. A new character starts with what OSRS hands a player who steps off Tutorial Island.
 *
 * The island is what gives that kit (areas/tutorialisland/Leave.TutorialIsland.js, "as captured
 * on arrival in Lumbridge"), and our worlds run with the island switched off, so a new character
 * landed in Lumbridge with an empty backpack. This gives the same kit on the first login: the
 * same items in the same order, and the island's 25 coins in the bank.
 *
 * Not given: on a world that runs Tutorial Island (the island gives its own kit at the end, and
 * empties the backpack first), to a bot (bots are outfitted by their own code), or twice.
 */
const GIVEN_ATTRIBUTE = "starter-kit:given";
const ENABLED_CONFIG = "StarterKit:enabled";
/** The tutorial's coins, which it puts in the bank. */
const BANK_COINS = 25;

/** [item's name in ItemIdentifiers, amount], in the order the island adds them. */
const KIT = Object.freeze([
  ["BRONZE_AXE", 1], ["BRONZE_PICKAXE", 1], ["TINDERBOX", 1], ["SMALL_FISHING_NET", 1], ["SHRIMPS", 1],
  ["BRONZE_DAGGER", 1], ["BRONZE_SHORTSWORD", 1], ["WOODEN_SHIELD", 1], ["SHORTBOW", 1],
  ["BRONZE_ARROW", 25], ["AIR_RUNE", 25], ["MIND_RUNE", 15],
  ["BUCKET", 1], ["POT", 1], ["BREAD", 1],
  ["WATER_RUNE", 6], ["EARTH_RUNE", 4], ["BODY_RUNE", 2],
]);

let api, core;

/** Whether this world runs Tutorial Island: its plugin answers this query when it is on. */
function tutorialRuns() {
  const query = { available: false };
  api.emitCustomEvent("tutorial:availability", query);
  return query.available === true;
}

function give(player) {
  const Items = core.ItemIdentifiers;
  const inventory = player.getInventory();
  for (const [name, amount] of KIT) inventory.adds(Items[name], amount);
  player.getBank(0).adds(Items.COINS, BANK_COINS);
  player.setAttribute(GIVEN_ATTRIBUTE, true);
}

function login({ player, isNewAccount }) {
  if (isNewAccount !== true || player.isPlayerBot?.() === true) return;
  if (api.getPluginConfig?.(ENABLED_CONFIG, true) === false) return;
  if (player.getAttribute(GIVEN_ATTRIBUTE) === true || tutorialRuns()) return;
  give(player);
}

module.exports = {
  name: "StarterKit",
  description: "Gives a new character the items OSRS hands out on leaving Tutorial Island (tools, a sword, a bow and arrows, runes, food, and 25 coins in the bank) on worlds that do not run the island.",
  config: {
    [ENABLED_CONFIG]: {
      type: "boolean", label: "Starter items for new characters", default: true,
      help: "A new character starts with OSRS's Tutorial Island kit and 25 coins in the bank. Worlds that run Tutorial Island give it there instead, whatever this says.",
    },
  },
  register(pluginApi) {
    api = pluginApi;
    core = pluginApi.core;
    api.persistAttribute(GIVEN_ATTRIBUTE, false);
    api.onPlayerLogin(login);
  },
  _test: { KIT, BANK_COINS, GIVEN_ATTRIBUTE, ENABLED_CONFIG, login },
};
