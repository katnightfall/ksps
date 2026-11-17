"use strict";

/**
 * Empties listed inventory items. Used to keep an activity loop alive until a bank resolver
 * takes over (phase 3). All in one tick, or with brain pacing (AI bots) a slot or two a tick,
 * as a player drops them.
 */
const { ItemDefinition } = require("../../../../src/main/typescript/elvarg/game/definition/ItemDefinition");
const { earnsOwnItems } = require("../OwnItems.PlayerBots");

/**
 * Ours: a bot that owns what it uses (brain/OwnItems) does not throw away what it can sell. It
 * keeps its logs, ore and fish, its next round begins at the bank with them (the tool step
 * empties a cluttered backpack there), and they are sold at the Grand Exchange
 * (actions/Exchange). What nobody would buy (burnt fish) it drops like any bot.
 */
function sellable(itemId) {
  try {
    return ItemDefinition.forId(ItemDefinition.forId(itemId).unNote()).isTradeable() === true;
  } catch {
    return false;
  }
}

function createDropItemsAction(spec) {
  const listed = Array.isArray(spec.itemIds) ? spec.itemIds : [];
  return {
    id: "dropItems",
    update(ctx) {
      const inventory = ctx.player?.getInventory?.();
      if (!inventory) {
        return "failed";
      }
      const itemIds = earnsOwnItems(ctx.player) ? listed.filter((itemId) => !sellable(itemId)) : listed;
      const range = ctx.brain?.pacing?.dropsPerTick;
      let slots = range ? range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1)) : Infinity;
      for (const itemId of itemIds) {
        while (slots > 0 && inventory.getAmount(itemId) > 0) {
          // A stack is one drop; unstackable items go one at a time.
          const stackable = inventory.getItems().find((item) => item?.getId?.() === itemId)?.getDefinition?.()?.isStackable?.();
          inventory.deleteNumber(itemId, stackable || !range ? inventory.getAmount(itemId) : 1);
          slots -= 1;
        }
      }
      return itemIds.some((itemId) => inventory.getAmount(itemId) > 0) ? "running" : "success";
    },
  };
}

module.exports = {
  createDropItemsAction,
};
