"use strict";

/**
 * Ours. An errand of the bot's own (brain/Ambition): a walk to a shop for something it can now
 * pay for, to its bank for better kit, or to the Grand Exchange. Ambition starts it on top of
 * the bot's work and decides its steps; when it ends, the work goes on where it stopped.
 *
 * JSON: { "type": "errand" }
 */
function createErrandAction(spec, world) {
  // The brain's own world first: that is the one whose bots have a mind of their own.
  const ambitionOf = (ctx) => (ctx?.world ?? world)?.ambition ?? null;
  return {
    id: "errand",
    update(ctx) {
      return ambitionOf(ctx)?.runErrand(ctx) ?? "failed";
    },
    stop(ctx) {
      ambitionOf(ctx)?.stopErrand(ctx);
    },
    describe(ctx) {
      const errand = ambitionOf(ctx)?.mind(ctx.player)?.errand;
      return errand ? `errand: ${errand.kind}` : "errand";
    },
  };
}

module.exports = { createErrandAction };
