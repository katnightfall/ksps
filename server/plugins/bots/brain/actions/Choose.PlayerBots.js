"use strict";

const { playerState } = require("../ActionState.PlayerBots");
const { clearMovementRequest } = require("../../behaviours/navigation/Navigation.PlayerBots");
const { bankedWhere, earnsOwnItems, ownItemsFor } = require("../OwnItems.PlayerBots");
const { isFoodItem } = require("../../../items/Food.plugin");

// Ours: a bot that owns what it uses and has less food than this in its bank cooks for its bank more often.
const FOOD_STOCK = 30;

/**
 * Weighted choice between short action lists, re-rolled every time the action
 * starts, then run in order. Lets one activity vary what a bot does at a step,
 * e.g. on a full inventory: bank, drop, sell, or smelt then bank/sell/drop.
 *
 * JSON: { "type": "choose", "options": [ { "weight": 2, "actions": [ ... ] }, ... ] }
 */
function createChooseAction(spec, compileAction) {
  const options = (spec.options ?? [])
    .map((option) => ({
      weight: Math.max(0, Number(option.weight ?? 1)),
      actions: (option.actions ?? []).map(compileAction),
      // Ours: what the option does with the goods, for a bot that lives off them.
      sells: (option.actions ?? []).some((step) => step?.type === "sellItems"),
      banks: (option.actions ?? []).some((step) => step?.type === "cook") && (option.actions ?? []).some((step) => step?.type === "bank"),
    }))
    .filter((option) => option.weight > 0 && option.actions.length > 0);
  if (!options.length) {
    throw new Error("[bot activities] choose needs options with a weight and actions");
  }
  const totalWeight = options.reduce((sum, option) => sum + option.weight, 0);
  const stateFor = (player) => playerState(action, player, () => ({ option: null, index: 0 }));
  const current = (bot) => bot.option?.actions[bot.index] ?? null;

  /**
   * Ours: the options a bot that owns what it uses (brain/OwnItems) rolls between. Short of
   * coins for something it wants, it sells; short of food in its bank, it cooks for its bank
   * three times as often. Any other bot rolls between them all, as before.
   */
  function weighed(ctx) {
    if (!earnsOwnItems(ctx.player)) return options;
    if (ownItemsFor(ctx.world).wishing(ctx.player, ctx.state, ctx.nowMs)) {
      const selling = options.filter((option) => option.sells);
      if (selling.length) return selling;
    }
    if (options.some((option) => option.banks) &&
        bankedWhere(ctx.player, isFoodItem).reduce((sum, entry) => sum + entry.amount, 0) < FOOD_STOCK) {
      return options.map((option) => (option.banks ? { ...option, weight: option.weight * 3 } : option));
    }
    return options;
  }

  const action = {
    id: "choose",
    update(ctx) {
      const bot = stateFor(ctx.player);
      if (!bot.option) {
        const pool = weighed(ctx);
        let roll = Math.random() * (pool === options ? totalWeight : pool.reduce((sum, option) => sum + option.weight, 0));
        bot.option = pool.find((option) => (roll -= option.weight) < 0) ?? pool[pool.length - 1];
        bot.index = 0;
      }
      const step = current(bot);
      const result = step.update(ctx);
      if (result === "success") {
        step.stop?.(ctx);
        // As between brain actions: the next step must not inherit this one's walk,
        // nor an interface it left open (busy() would stall it).
        clearMovementRequest(ctx.player);
        if (Number(ctx.player.getInterfaceId?.() ?? -1) > 0) ctx.player.getPacketSender?.()?.sendInterfaceRemoval?.();
        bot.index += 1;
        if (bot.index < bot.option.actions.length) {
          return "running";
        }
        bot.option = null;
        return "success";
      }
      if (result === "failed") {
        step.stop?.(ctx);
        bot.option = null;
      }
      return result;
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      current(bot)?.stop?.(ctx);
      bot.option = null;
    },
    madeProgress(ctx) {
      return current(stateFor(ctx.player))?.madeProgress?.(ctx) === true;
    },
    describe(ctx) {
      const step = current(stateFor(ctx.player));
      return step?.describe?.(ctx) ?? `choose -> ${step?.id ?? "next roll"}`;
    },
  };
  return action;
}

module.exports = {
  createChooseAction,
};
