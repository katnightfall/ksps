/**
 * Auto-pickpocket: a rule of our world, not of OSRS. One Pickpocket click keeps going by itself:
 * each success is followed by another attempt on the same NPC until the player is caught.
 *
 * It answers "thieving:done", the request Pickpocket.Thieving.js sends after every attempt (the
 * one a league relic's repeat uses), so the repeat is the Thieving plugin's own: an attempt every
 * 2 ticks, following the NPC as it wanders, ended by any click of the player's, a full inventory
 * or 28 coin pouches. A failed attempt is not answered, so the chain stops there, whether or not
 * a dodgy necklace then spares the stun.
 *
 * Off for the whole world with "plugins": { "AutoPickpocket": false } in world.json.
 */
function pickpocketAgain(done) {
  if (done.kind === "pickpocket" && done.succeeded) done.again = true;
}

module.exports = {
  name: "AutoPickpocket",
  description: "One Pickpocket click keeps picking the same pocket, an attempt every 2 ticks, until the player is caught, clicks elsewhere, or runs out of room.",
  members: true,
  register(api) {
    api.onCustomEvent("thieving:done", pickpocketAgain);
  },
};
