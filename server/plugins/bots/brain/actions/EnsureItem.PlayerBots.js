"use strict";

/**
 * Ensures the inventory holds a tool (tinderbox), conjured the same way equipTool
 * provides an axe or pickaxe. Tools only: resources (ores, logs) must come from
 * gathering or a bank withdrawal, so bots never add free items to the economy.
 */
const { earnsOwnItems, keeping, ownItemsFor } = require("../OwnItems.PlayerBots");

function createEnsureItemAction(spec, world = null) {
  const itemId = spec.item;
  const amount = Math.max(1, Math.floor(Number(spec.amount ?? 1)));
  return {
    id: "ensureItem",
    update(ctx) {
      const inventory = ctx.player?.getInventory?.();
      if (!inventory || !Number.isInteger(itemId)) {
        return "failed";
      }
      const missing = amount - inventory.getAmount(itemId);
      // Ours: a bot that owns what it uses gets the tool from its bank or a shop, with its
      // own coins, and leaves at the bank what this work has no use for.
      if (earnsOwnItems(ctx.player)) {
        const own = ownItemsFor(world ?? ctx.world);
        const keep = keeping(itemId, spec.keep ?? []);
        const result = own.fetch(ctx, { itemId, min: amount, keep });
        return result !== "success" || spec.tidy === false ? result : own.tidy(ctx, keep);
      }
      if (missing <= 0) {
        return "success";
      }
      inventory.adds(itemId, missing);
      return inventory.getAmount(itemId) >= amount ? "success" : "failed";
    },
    stop(ctx) {
      if (earnsOwnItems(ctx?.player)) ownItemsFor(world ?? ctx.world).stop(ctx);
    },
  };
}

module.exports = {
  createEnsureItemAction,
};
