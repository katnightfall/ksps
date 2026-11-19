/**
 * The Birds and the Wasps: the rest of Bea's farm and what the player makes of it.
 *
 * - The equipment crate beside Bea (26249 at 3315, 3376; the cache shows it as "Crate" up to baw 20 and as "Equipment
 *   crate", Take-from / Take-all, above): Transcript:The Birds and the Wasps, "Gearing up".
 * - Catches (the Hunter plugin's "hunter:success"): 50 wasp stings carried move the quest on, with the player's
 *   "Looks like I've caught enough. I'd best let Bea know." once (baw_wasps_caught_notification); each honey buzzard
 *   caught while Bea wants birds counts (baw_birds_caught), and five with 50 brown feathers carried do the same
 *   (baw_birds_caught_notification).
 * - Wasp darts (Fletching, data/fletching.json): the first made moves the quest to its last section; Inspect on either
 *   dart is the Wiki's box (Transcript:Wasp dart, Transcript:Killer wasp dart).
 * - Bea's supplies, Open: one roll of the Wiki's loot table (Bea's supplies; its rates are the drop log's, marked
 *   approximate there).
 *
 * Ours: "Take everything" with room for less than all three is answered as a full inventory; opening a bag sends no
 * message (none is documented).
 */
module.exports = function createFarm(api, common) {
  const { ItemIdentifiers: I } = api.core;
  const { STAGE, ATTRIBUTE, VARBIT, NPC, ITEM, play, stageOf, setStage, carried, flag, setFlag, addBird } = common;

  // ------------------------------------------------------------------ the equipment crate

  const CRATE_ITEMS = [
    [ITEM.NET, "Insect net.", "You take an insect net from the crate."],
    [ITEM.HAT, "Bee hunter's hat.", "You take a bee hunter's hat from the crate."],
    [ITEM.REPELLENT, "Insect repellent.", "You take some insect repellent from the crate."],
  ];
  const NO_SPACE = "You don't have space to take anything from the crate.";

  function crate(player) {
    if (player.getInventory().getFreeSlots() <= 0) return play(player, [{ box: NO_SPACE }]);
    play(player, [{ menu: "What would you like to take?", options: [
      ...CRATE_ITEMS.map(([itemId, label, text]) => [label, () => takeOne(player, itemId, text)]),
      ["Take everything.", () => takeAll(player)],
      ["Take nothing.", () => {}],
    ] }]);
  }

  function takeOne(player, itemId, text) {
    if (player.getInventory().getFreeSlots() <= 0) return play(player, [{ box: NO_SPACE }]);
    play(player, [{ item: itemId, text, on: () => player.getInventory().adds(itemId, 1) }], () => crate(player));
  }

  function takeAll(player) {
    if (player.getInventory().getFreeSlots() < CRATE_ITEMS.length) return play(player, [{ box: NO_SPACE }]);
    play(player, [{ items: [ITEM.NET, ITEM.HAT], text: "You take a full set of equipment from the crate.", on: () => {
      for (const [itemId] of CRATE_ITEMS) player.getInventory().adds(itemId, 1);
    } }]);
  }

  function takeFrom({ player }) { crate(player); return true; }
  function takeEverything({ player }) {
    if (player.getInventory().getFreeSlots() <= 0) play(player, [{ box: NO_SPACE }]);
    else takeAll(player);
    return true;
  }

  // ------------------------------------------------------------------ catches

  const ENOUGH = "Looks like I've caught enough. I'd best let Bea know.";
  const WASP_SWARM = api.core.CacheDefinitions.getNpcId("baw_wasp_swarm");

  function caught({ player, method, npcId }) {
    if (!player) return;
    if (method === "wasps" && npcId === WASP_SWARM) waspCaught(player);
    else if (method === "bird" && npcId === NPC.HONEY_BUZZARD) birdCaught(player);
  }

  function waspCaught(player) {
    if (stageOf(player) !== STAGE.WASPS || carried(player, ITEM.WASP_STING) < common.WASPS_NEEDED) return;
    setStage(player, STAGE.WASPS_CAUGHT);
    if (flag(player, ATTRIBUTE.WASPS_NOTIFIED)) return;
    setFlag(player, ATTRIBUTE.WASPS_NOTIFIED, VARBIT.WASPS_NOTIFIED);
    play(player, [{ player: ENOUGH }]);
  }

  function birdCaught(player) {
    if (stageOf(player) !== STAGE.BIRDS) return;
    const birds = addBird(player);
    if (birds < common.BIRDS_NEEDED || carried(player, ITEM.BROWN_FEATHER) < common.FEATHERS_NEEDED) return;
    setStage(player, STAGE.BIRDS_CAUGHT);
    if (flag(player, ATTRIBUTE.BIRDS_NOTIFIED)) return;
    setFlag(player, ATTRIBUTE.BIRDS_NOTIFIED, VARBIT.BIRDS_NOTIFIED);
    play(player, [{ player: ENOUGH }]);
  }

  /** Bea's bird snares: two with none carried, one with one; null when there is no room for any (Transcript). */
  function giveSnares(player) {
    const wanted = Math.max(0, 2 - carried(player, ITEM.SNARE));
    if (wanted === 0) return 0;
    const free = player.getInventory().getFreeSlots();
    if (free <= 0) return null;
    const given = Math.min(wanted, free);
    player.getInventory().adds(ITEM.SNARE, given);
    return given;
  }

  // ------------------------------------------------------------------ darts and supplies

  function dartsMade({ player, itemId }) {
    if (itemId === ITEM.WASP_DART && stageOf(player) === STAGE.DARTS) setStage(player, STAGE.DARTS_MADE);
  }

  const INSPECT = "Some darts made using wasp stings. They don't look like the sort of thing you'd want to use yourself, but maybe Bea will have a use for them.";

  function inspect({ player, itemId }) {
    play(player, [{ item: itemId, text: INSPECT }]);
    return true;
  }

  /** Wiki (Bea's supplies): each line's share of 60, and its amount. */
  const SUPPLIES = [
    [16, I.HEADLESS_ARROW, 60, 140], [8, I.COINS, 150, 300], [8, I.BRONZE_ARROWTIPS, 60, 140], [8, I.BRONZE_DART, 30, 70],
    [5, I.LEATHER, 2, 6], [5, I.IRON_ARROWTIPS, 60, 140], [5, I.IRON_DART, 30, 70], [3, I.HARD_LEATHER, 2, 6],
    [1, I.STEEL_ARROWTIPS, 60, 140], [1, I.STEEL_DART, 30, 70],
  ];

  function rollSupplies(random = Math.random) {
    const total = SUPPLIES.reduce((sum, [weight]) => sum + weight, 0);
    let roll = random() * total;
    for (const [weight, itemId, min, max] of SUPPLIES) {
      roll -= weight;
      if (roll < 0) return [itemId, min + Math.floor(random() * (max - min + 1))];
    }
    const [, itemId, min] = SUPPLIES[SUPPLIES.length - 1];
    return [itemId, min];
  }

  function openSupplies({ player }) {
    const inventory = player.getInventory();
    if (carried(player, ITEM.SUPPLIES) <= 0) return true;
    const [itemId, amount] = rollSupplies();
    const stackable = api.core.ItemDefinition.forId(itemId).isStackable();
    // The bag's own slot frees when it is the last one.
    const freed = carried(player, ITEM.SUPPLIES) === 1 ? 1 : 0;
    const needed = stackable ? (carried(player, itemId) > 0 ? 0 : 1) : amount;
    if (inventory.getFreeSlots() + freed < needed) {
      inventory.full();
      return true;
    }
    inventory.deleteNumber(ITEM.SUPPLIES, 1);
    inventory.adds(itemId, amount);
    return true;
  }

  return { takeFrom, takeEverything, caught, giveSnares, dartsMade, inspect, openSupplies, rollSupplies, SUPPLIES };
};
