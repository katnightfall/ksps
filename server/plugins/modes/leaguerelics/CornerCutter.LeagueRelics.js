/**
 * Corner Cutter (https://oldschool.runescape.wiki/w/Corner_Cutter_(Raging_Echoes_League)), Raging
 * Echoes' tier 2 relic: Agility actions always succeed, a lap counts twice and pays 25% more, and
 * a mark of grace spawns with 10,000 coins, and the golden pyramid, the Prifddinas course's crystal
 * shards (`agility:course-item`), the Brimhaven Agility Arena's tickets and vouchers and the
 * Hallowed Sepulchre's marks (`minigame:points`, after the tier passive's) come twofold (ours,
 * upstream issue #5586: these four were left out). Not here: the Sage's greaves (not in this cache).
 */
const Common = require("./Common.LeagueRelics");

let core;
let effect;

function active(player) {
  return Common.effectActive(player, effect);
}

function succeeds(request) {
  if (active(request.player)) request.success = true;
}

function lapReward(request) {
  if (!active(request.player)) return;
  request.count = effect.lapCount;
  request.xp *= effect.lapXpMultiplier;
}

/** A course's own find the relic doubles (the effect's `courseItems`). */
function courseItem(request) {
  const items = effect.courseItems?.[request.course];
  const name = items && Object.keys(items).find((key) => core.ItemIdentifiers[key] === request.itemId);
  if (name && active(request.player)) request.amount *= items[name];
}

/** A minigame award the relic doubles (the effect's `minigamePoints`). */
function minigamePoints(request) {
  const multiplier = effect.minigamePoints?.[request.minigame];
  if (multiplier && active(request.player)) request.points *= multiplier;
}

function markCoins(request) {
  if (active(request.player)) request.items.push([core.ItemIdentifiers.COINS, effect.markCoins]);
}

module.exports = function attach(api) {
  core = api.core;
  effect = Common.data.effects.cornerCutter;
  api.onCustomEvent("agility:roll", succeeds);
  api.onCustomEvent("agility:lap-reward", lapReward);
  api.onCustomEvent("agility:mark", markCoins);
  api.onCustomEvent("agility:course-item", courseItem);
  api.onCustomEvent("minigame:points", minigamePoints);
};
