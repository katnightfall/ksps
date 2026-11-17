"use strict";

/**
 * Ours. Potions for a levelling bot's fights (one of the things brain/Ambition has it want).
 *
 *   wants    a couple of potions for its combat style once it can well afford them: strength
 *            and attack (and defence) for a fighter hand to hand, ranging for an archer, magic
 *            for a mage, the super kinds when its coins run to them; and an antipoison once
 *            something has poisoned it
 *   gets     as it gets anything else: a shop that sells them, or a bid on the Grand Exchange
 *   carries  one of each when it goes to fight (taken from its bank on Ambition's bank visit)
 *   drinks   a dose when a fight worth one starts and the boost has worn off; an antipoison
 *            when it is poisoned. It drinks as a player does (the potion's own item option), so
 *            the dose, the timer and the empty vial are the game's
 *   wears    off: upstream's bots keep a boost for good (they are spawned with theirs). These
 *            bots drink for theirs, so it leaves them a point a minute as it leaves a player
 *
 * It makes none: a potion needs Herblore, the bots have no way to train it yet (the first
 * level comes from a quest), so until they do, potions are bought.
 */
const { Skill } = require("../../../src/main/typescript/elvarg/game/model/Skill");
const { ItemDefinition } = require("../../../src/main/typescript/elvarg/game/definition/ItemDefinition");
const { ItemIdentifiers } = require("../../../src/main/typescript/elvarg/util/ItemIdentifiers");
const WorldDefinition = require("../../../src/main/typescript/elvarg/game/definition/WorldDefinition");
const { CacheDefinitions } = require("../../../src/main/typescript/elvarg/game/cache/CacheDefinitions");
const { ALWAYS_KEPT, carried } = require("./OwnItems.PlayerBots");

// Potions of a kind bought at a time, and carried to a fight.
const STOCK = 2;
const CARRIED = 1;
// A bot buys potions only when they cost no more than this share of its coins: its tools and
// its kit come first, and it never saves up for a drink.
const PURSE_SHARE = 0.25;
// After Ambition's armour, before its capes and amulets.
const RANK = 45;
// A fight is looked at this often, and a boost leaves a point this often.
const LOOK_MS = 2400;
const DECAY_MS = 60_000;
// An antipoison is wanted for this long after the bot was last poisoned.
const POISON_MEMORY_MS = 3 * 60 * 60_000;
// Not for a chicken: the monster is at least this level, or this share of the bot's own.
const WORTH_LEVEL = 5;
const WORTH_SHARE = 1 / 5;

/** The potions a style drinks, each kind best first: [skill, item-name stem ...]. */
const BOOSTS = Object.freeze({
  melee: [[Skill.STRENGTH, "SUPER_STRENGTH", "STRENGTH_POTION"], [Skill.ATTACK, "SUPER_ATTACK", "ATTACK_POTION"], [Skill.DEFENCE, "SUPER_DEFENCE", "DEFENCE_POTION"]],
  ranged: [[Skill.RANGED, "RANGING_POTION"]],
  magic: [[Skill.MAGIC, "MAGIC_POTION"]],
});
const CURES = Object.freeze(["SUPERANTIPOISON", "ANTIPOISON"]);

/** A potion's items by dose: [4, 3, 2, 1], or null when the game has no such potion. */
function doses(stem) {
  const ids = [4, 3, 2, 1].map((dose) => ItemIdentifiers[`${stem}_${dose}_`]);
  return ids.every(Number.isInteger) ? ids : null;
}
const usableOnWorld = (itemId) => WorldDefinition.isMembersWorld() || CacheDefinitions.getItem(itemId)?.isMembers !== true;

function createBotPotions({ world, ambition }) {
  const core = world.core;
  /** A kind of potion: the skill it lifts (null: a cure), its potions best first, and every dose item of them, the fewest doses first (an opened potion is finished before a full one). */
  const kinds = (list) => list.map(([skill, ...stems]) => {
    const potions = stems.map(doses).filter((ids) => ids && usableOnWorld(ids[0]));
    const items = potions.flatMap((ids) => ids.map((itemId, index) => ({ itemId, doses: 4 - index }))).sort((a, b) => a.doses - b.doses).map((entry) => entry.itemId);
    return { skill, potions, items };
  }).filter((kind) => kind.potions.length > 0);
  // Read when first needed: a world's members setting is not known as the plugins load.
  let table = null;
  const potions = () => (table ??= {
    melee: kinds(BOOSTS.melee), ranged: kinds(BOOSTS.ranged), magic: kinds(BOOSTS.magic),
    cure: kinds([[null, ...CURES]])[0] ?? null,
  });
  // A potion is not clutter: a bank visit of the bot's work leaves it in the backpack.
  for (const stem of [...Object.values(BOOSTS).flatMap((list) => list.flatMap(([, ...stems]) => stems)), ...CURES]) {
    for (const itemId of doses(stem) ?? []) ALWAYS_KEPT.add(itemId);
  }
  const bots = new WeakMap();
  const botFor = (player) => {
    let bot = bots.get(player);
    if (!bot) bots.set(player, (bot = { lookAt: 0, decayAt: 0, poisonedAt: 0 }));
    return bot;
  };

  const carriedOf = (player, kind) => kind.items.reduce((sum, itemId) => sum + carried(player, itemId), 0);
  const ownedOf = (have, kind) => kind.items.reduce((sum, itemId) => sum + have.count(itemId), 0);

  /** The kinds this bot drinks: its combat style's boosts, and the cure when it has met poison (`since`: no longer ago than that). */
  function kindsFor(player, since = 0) {
    const list = [...(potions()[ambition.kit().preferredStyle(player)] ?? [])];
    const poisonedAt = bots.get(player)?.poisonedAt ?? 0;
    if (poisonedAt > 0 && poisonedAt >= since && potions().cure) list.push(potions().cure);
    return list;
  }

  /** Ambition's goals of this part: potions of a kind it has none of, when it can well afford them. */
  function goals(player, have, coins, price, nowMs = Date.now()) {
    const wanted = [];
    for (const kind of kindsFor(player, nowMs - POISON_MEMORY_MS)) {
      if (ownedOf(have, kind) > 0) continue;
      // The best kind a quarter of its coins buys a pair of (a cure: one will do).
      const amount = kind.skill === null ? 1 : STOCK;
      for (const ids of kind.potions) {
        const offer = price(ids[0]);
        if (!offer || offer.cost * amount > coins * PURSE_SHARE) continue;
        wanted.push({ kind: "potion", key: `potion:${ids[0]}`, rank: RANK, itemId: ids[0], amount, source: offer.source, cost: offer.cost * amount });
        break;
      }
    }
    return wanted;
  }

  /** Ambition's bank visit: one of each kind it has none of with it, when its work is a fight. */
  function carry(player, have, fighting) {
    if (!fighting) return [];
    const list = [];
    for (const kind of kindsFor(player)) {
      if (carriedOf(player, kind) >= CARRIED) continue;
      const banked = kind.items.find((itemId) => (have.bank.get(itemId) ?? 0) > 0);
      if (banked !== undefined) list.push({ itemId: banked, amount: CARRIED });
    }
    return list;
  }

  /** Drinks a dose of a kind it carries, as a player clicks it. Returns the item drunk from, or null. */
  function drink(player, kind) {
    const inventory = player.getInventory();
    const items = inventory.getItems();
    for (const itemId of kind.items) {
      const slot = items.findIndex((item) => item?.getId?.() === itemId);
      if (slot < 0) continue;
      core.ItemActionPacketListener.handleAction(player, core.Inventory.INTERFACE_ID, itemId, slot, 1);
      // Still there: the game refused it (the potion timer, a place where none may be drunk).
      return inventory.getItems()[slot]?.getId?.() === itemId ? null : itemId;
    }
    return null;
  }

  /** A boost leaves a bot that drank for it a point a minute, down to its own level. */
  function wearOff(player, bot, nowMs) {
    const manager = player.getSkillManager();
    const points = 1 + Math.floor((nowMs - bot.decayAt) / DECAY_MS);
    let boosted = false;
    for (const skill of [Skill.ATTACK, Skill.STRENGTH, Skill.DEFENCE, Skill.RANGED, Skill.MAGIC]) {
      const resting = manager.getRestingLevel(skill);
      const current = manager.getCurrentLevel(skill);
      if (current <= resting) continue;
      const next = Math.max(resting, current - points);
      manager.setCurrentLevel(skill, next, true);
      if (next > resting) boosted = true;
    }
    bot.decayAt = boosted ? bot.decayAt + points * DECAY_MS : 0;
  }

  /** Whether the fight is worth a dose: the monster is no chicken to this bot. */
  function worthADose(player, target) {
    const level = Number(target.getDefinition?.()?.getCombatLevel?.() ?? 0);
    return level >= WORTH_LEVEL || level >= player.getSkillManager().getCombatLevel() * WORTH_SHARE;
  }

  /** Every tick of a bot with a mind: cheap until its next look is due. */
  function tick(brain, nowMs = Date.now()) {
    const player = brain.player;
    const bot = botFor(player);
    if (bot.decayAt > 0 && nowMs >= bot.decayAt) wearOff(player, bot, nowMs);
    if (nowMs < bot.lookAt) return;
    bot.lookAt = nowMs + LOOK_MS;
    if (player.getHitpoints() <= 0) return;
    const said = (itemId, skill) => {
      world.log?.("bot_potion_drunk", { username: player.getUsername?.(), potion: ItemDefinition.forId(itemId)?.getName?.(), level: skill ? player.getSkillManager().getCurrentLevel(skill) : null });
      world.talk?.note?.(player, "drank", { itemId });
    };
    if (player.isPoisoned?.() === true) {
      bot.poisonedAt = nowMs;
      const cured = potions().cure ? drink(player, potions().cure) : null;
      if (cured !== null) return said(cured, null);
    }
    const target = player.getCombat?.()?.getTarget?.();
    if (!target || target.isNpc?.() !== true || target.getHitpoints() <= 0 || !worthADose(player, target)) return;
    const manager = player.getSkillManager();
    // The style it fights in now (an archer out of arrows fights hand to hand).
    for (const kind of potions()[ambition.kit().usableStyle(player)] ?? []) {
      if (manager.getCurrentLevel(kind.skill) > manager.getRestingLevel(kind.skill)) continue;
      const drunk = drink(player, kind);
      if (drunk === null) continue;
      if (bot.decayAt === 0) bot.decayAt = nowMs + DECAY_MS;
      // One drink a look: the next kind follows when the potion timer allows.
      return said(drunk, kind.skill);
    }
  }

  ambition.addProvider(goals);
  ambition.addCarrier(carry);
  ambition.addTicker(tick);
  return { goals, carry, tick, kindsFor, potions };
}

module.exports = { createBotPotions };
