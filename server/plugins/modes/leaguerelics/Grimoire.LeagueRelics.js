/**
 * Grimoire (https://oldschool.runescape.wiki/w/Grimoire_(Raging_Echoes_League)), Raging Echoes'
 * tier 7 relic: every spell's area, quest or diary requirement is lifted (`magic:spell-unlocked`:
 * here, the Mage Arena's god spells outside the arena without their 100 casts), and every prayer is
 * unlocked whatever its quest or unlock (`prayer:unlocks-bypass`, for the effect's `prayersLeagues`;
 * the Prayer level itself still counts, Wiki). Its Arcane grimoire switches to any spellbook,
 * whatever quest the book needs (`opensEveryBook`, for the effect's `booksLeagues`; the swap itself
 * is the item's own unit, ArcaneGrimoire.LeagueRelics.js).
 * Ours (upstream issue #5586): the prayers and the books were Demonic Pacts' only, so a Raging
 * Echoes character with the relic still needed King's Ransom, the prayer scrolls, Desert Treasure
 * I and Lunar Diplomacy.
 *
 * Demonic Pacts' Grimoire (tier 6) lifts the spells' requirements and unlocks every prayer the
 * same way; its Arcane grimoire comes
 * from the cache's relic struct. It also opens the Arceuus spellbook without speaking to Tyss
 * (core SpellbookLocks; the cache proc `arceuus_spellbook_unlocked` names this relic's struct 1132).
 */
const Common = require("./Common.LeagueRelics");

let effect;

function unlocked(request) {
  if (Common.effectActive(request.player, effect)) request.unlocked = true;
}

function prayersUnlocked(request) {
  if (effect.prayersLeagues?.includes(Common.leagueOf(request.player)) && Common.effectActive(request.player, effect)) request.bypass = true;
}

/**
 * Choosing the relic (or a relic reset) changes what the prayer book may show: live sends the
 * Knight Waves state and the three scroll flags with the relic's message (capture 237/01107).
 */
function arceuusUnlocked(request) {
  if (effect.arceuusLeagues?.includes(Common.leagueOf(request.player)) && Common.effectActive(request.player, effect)) request.unlocked = true;
}

/** Whether this character's Grimoire lets its Arcane grimoire switch to a book whose quest isn't done. */
function opensEveryBook(player) {
  return !!effect && effect.booksLeagues?.includes(Common.leagueOf(player)) === true && Common.effectActive(player, effect);
}

function syncPrayerBook({ player, relic }) {
  if (relic !== undefined && ![effect.key, ...(effect.aliases ?? [])].includes(relic)) return;
  if (!effect.prayersLeagues?.includes(Common.leagueOf(player))) return;
  Common.api.emitCustomEvent("prayer:sync-unlocks", { player });
}

module.exports = function attach(api) {
  effect = Common.data.effects.grimoire;
  api.onCustomEvent("magic:spell-unlocked", unlocked);
  api.onCustomEvent("prayer:unlocks-bypass", prayersUnlocked);
  api.onCustomEvent(api.core.SpellbookLocks.ARCEUUS_UNLOCK_QUERY_EVENT, arceuusUnlocked);
  api.onCustomEvent("league:relic-unlocked", syncPrayerBook);
  api.onCustomEvent("league:relics-reset", syncPrayerBook);
};

Object.assign(module.exports, { opensEveryBook });
