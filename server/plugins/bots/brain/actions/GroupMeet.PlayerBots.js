"use strict";

/**
 * Ours. A bot's walk to the place its group agreed to meet, and its wait there for the others
 * (brain/BotGroups has the party). It runs on top of the outing's own activity, which starts
 * where the bot then stands.
 *
 * JSON: { "type": "groupMeet" }
 */
function createGroupMeetAction(spec, world) {
  // The brain's own world first: that is the one whose bots form groups.
  const groupsOf = (ctx) => (ctx?.world ?? world)?.groups ?? null;
  return {
    id: "groupMeet",
    update(ctx) {
      return groupsOf(ctx)?.meet(ctx) ?? "failed";
    },
    stop(ctx) {
      groupsOf(ctx)?.stopMeet(ctx);
    },
    madeProgress(ctx) {
      return groupsOf(ctx)?.meetProgress(ctx) === true;
    },
    describe(ctx) {
      const party = groupsOf(ctx)?.partyOf(ctx.player);
      return party ? `meeting the group for ${party.outing.id}` : "meeting the group";
    },
  };
}

module.exports = { createGroupMeetAction };
