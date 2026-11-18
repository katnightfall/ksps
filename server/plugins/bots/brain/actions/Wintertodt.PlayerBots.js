"use strict";

/**
 * Ours. A levelling bot's trip to the Wintertodt with its group (brain/BotWintertodt has the
 * trip: the packing, the voyage, the rounds and the way home).
 *
 * JSON: { "type": "wintertodt" }
 */
function createWintertodtAction(spec, world) {
  // The brain's own world first: that is the one whose bots go.
  const tripOf = (ctx) => (ctx?.world ?? world)?.wintertodt ?? null;
  return {
    id: "wintertodt",
    update(ctx) {
      return tripOf(ctx)?.step(ctx) ?? "failed";
    },
    stop(ctx) {
      tripOf(ctx)?.stop(ctx);
    },
    madeProgress(ctx) {
      return tripOf(ctx)?.progress(ctx) === true;
    },
    // Across the sea its rotation waits: it comes home before it turns to other work.
    holdsRotation(ctx) {
      return tripOf(ctx)?.holds(ctx.player) === true;
    },
    describe(ctx) {
      return `wintertodt: ${tripOf(ctx)?.phaseOf(ctx.player) ?? "no trip"}`;
    },
  };
}

module.exports = { createWintertodtAction };
