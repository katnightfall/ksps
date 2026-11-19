"use strict";

/**
 * Saradomin's blessed sword (https://oldschool.runescape.wiki/w/Saradomin%27s_blessed_sword).
 *
 * Wiki: "If the sword is not protected upon death, it will fully degrade into Saradomin's tear. However, if it is
 * protected on death, it will remain in its regular state as Saradomin's blessed sword." The death to another player
 * is here: the sword becomes the tear, the same Item, as its Revert does ("immediately consumes the Saradomin sword and
 * returns the Tear"), and the tear, a tradeable item, then drops for the killer. A death to a monster is left as it
 * was (the sword goes to the grave whole), as the abyssal tentacle's is.
 *
 * Not here yet: making the sword from a Saradomin sword and the tear, its 10,000 hits and Revert. Its special attack
 * is combat/specials/SaradominsBlessedSword.SpecialAttack.js.
 */
let core = null;

/** The partly used sword and the full one (cache: "Saradomin's blessed sword", "Sara's blessed sword (full)"). */
function isBlessedSword(item) {
  const I = core.ItemIdentifiers;
  const id = item?.getId?.();
  return id === I.SARADOMINS_BLESSED_SWORD || id === I.SARAS_BLESSED_SWORD_FULL_;
}

/** `player-death:pvp-item-parts` (PlayerDeathTask, asked for the items a PvP death does not protect). */
// Ours (upstream issue #6002): before this an unprotected sword came back whole from a PvP death, skulled or not.
function degradeOnPvpDeath(query) {
  const item = query?.item;
  // A bot's gear is not loot (DeathLoot.PlayerBots decides what its death gives), and a preset copy is deleted with
  // the rest of the preset.
  if (!item || query.parts || query.player?.isPlayerBot?.() === true || item.isPresetItem?.() === true) return;
  if (!isBlessedSword(item)) return;
  item.setId(core.ItemIdentifiers.SARADOMINS_TEAR);
  query.parts = [item];
}

/** `items:lost-to-pvp-killer` { item, wildernessLevel, lost }: the Items Kept on Death screen's PvP preview. */
function answerLostToPvpKiller(query) {
  if (query?.item?.isPresetItem?.() !== true && isBlessedSword(query?.item)) query.lost = true;
}

module.exports = {
  name: "SaradominsBlessedSword",
  description: "Saradomin's blessed sword: an unprotected sword lost to another player degrades into Saradomin's tear, which the killer gets.",
  members: true,
  _test: { isBlessedSword },
  register(api) {
    core = api.core;
    api.onCustomEvent("player-death:pvp-item-parts", degradeOnPvpDeath);
    api.onCustomEvent("items:lost-to-pvp-killer", answerLostToPvpKiller);
  },
};
