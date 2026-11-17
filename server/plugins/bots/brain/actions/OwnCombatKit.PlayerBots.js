"use strict";

/**
 * Ours. Combat training for a bot that owns what it uses (brain/OwnItems).
 *
 * TrainCombat hands its bots a weapon, armour, arrows, runes and food for their level. A bot
 * that owns what it uses gets none of that. It fights with what it has:
 *
 *   worn        the best weapon and armour for its style among what it carries
 *   style       its own (melee, ranged or magic, as TrainCombat draws it) while it has the bow
 *               and arrows, or the runes, for it; otherwise it fights hand to hand
 *   food        what it cooked and banked; with none, and hurt, it stops training for a while
 *   between     a visit to the bank (food out, clutter in), more arrows or runes from its bank
 *   fights      or a shop, and one better piece of kit when it can pay for it
 *   after       it picks up its kill's coins, arrows and runes, and anything better than it wears
 *   a kill
 *
 * The tiers (bot-combat-gear.json) say what suits a level; here they are what a bot aims for
 * and may wear, not what it is given.
 */
const { banked, bankedWhere, carried, clutter, keeping, ownItemsFor, purse, worn } = require("../OwnItems.PlayerBots");
const { requestMovement, peekMovementRequest } = require("../../behaviours/navigation/Navigation.PlayerBots");
const { isFoodItem } = require("../../../items/Food.plugin");

// Food taken along, and how little is left before more is fetched.
const FOOD_CARRIED = 10;
const FOOD_LOW = 3;
// Arrows and casts: fewer than LOW and more are fetched, BUY at a time (or what the coins buy).
const AMMO_LOW = 15;
const AMMO_BUY = 100;
const CASTS_LOW = 10;
const CASTS_BUY = 60;
// Between fights the bank and the shops are thought about this often.
const PROVISION_EVERY_MS = 3 * 60 * 1000;
// A backpack with fewer free slots than this is emptied at the bank before training.
const FREE_SLOTS_WANTED = 8;
// Drops appear a moment after the kill; they are gone for after this long.
const LOOT_WAIT_MS = 1200;
const LOOT_FOR_MS = 12000;
const LOOT_RANGE = 3;
// Hurt this badly with nothing to eat: training stops, for this long.
const RETREAT_HP_RATIO = 0.3;
const RETREAT_COOLDOWN_MS = 8 * 60 * 1000;

function createOwnCombatKit({ world, tiers, combatStyles, hashSeed, skillByIndex }) {
  const core = world.core;
  const { Skill, Equipment, Item, ItemIdentifiers, EquipPacketListener, Inventory, ItemOnGroundManager } = core;
  const own = ownItemsFor(world);
  const tiersFor = (style) => (style === "ranged" ? tiers.ranged : style === "magic" ? tiers.magic : tiers.melee);
  const offenceSkill = (style) => (style === "ranged" ? Skill.RANGED : style === "magic" ? Skill.MAGIC : Skill.ATTACK);
  const value = (id) => Number(new Item(id, 1).getDefinition()?.getValue?.() ?? 0);
  const meets = (player, id) => {
    const manager = player.getSkillManager();
    return !(new Item(id, 1).getDefinition()?.getRequirements?.() ?? [])
      .some((required, index) => required > 1 && skillByIndex.get(index) && required > manager.getCurrentLevel(skillByIndex.get(index)));
  };
  const has = (player, id) => carried(player, id) > 0 || worn(player, id);
  const foodCarried = (player) => (player.getInventory().getItems() ?? []).filter((item) => isFoodItem(item?.getId?.())).length;

  // Every rune a training spell asks for, every arrow, and the bows and staves: a bot of that
  // style keeps these with it through a visit to the bank.
  const runesOf = (spell) => {
    try {
      return (spell.itemsRequired?.(null) ?? []).map((rune) => rune.getId());
    } catch {
      return [];
    }
  };
  const runeIds = new Set(tiers.magic.flatMap((tier) => tier.spells).flatMap(runesOf));
  const ammoIds = new Set(tiers.ranged.flatMap((tier) => tier.ammo));
  const styleWeapons = {
    ranged: new Set(tiers.ranged.flatMap((tier) => tier.weapons)),
    magic: new Set(tiers.magic.flatMap((tier) => tier.weapons)),
  };

  /** The style TrainCombat draws for this bot: its own, kept for good. */
  function preferredStyle(player) {
    if (!combatStyles.length) return "melee";
    return combatStyles[hashSeed(`${player.getUsername?.() ?? "bot"}:style`) % combatStyles.length] ?? "melee";
  }

  /** The tiers of `style` this bot's levels reach: for its weapon, and for its armour. */
  function reach(player, style) {
    const manager = player.getSkillManager();
    const offence = manager.getCurrentLevel(offenceSkill(style));
    // Melee armour follows Defence; ranged and magic armour follows the skill, as TrainCombat has it.
    const armour = style === "melee" ? manager.getCurrentLevel(Skill.DEFENCE) : offence;
    const all = tiersFor(style);
    return { offence: all.filter((tier) => offence >= tier.minLevel), armour: all.filter((tier) => armour >= tier.minLevel) };
  }

  /** What this bot may wear for `style` at its levels: slot -> Set(item id). Arrows go by the bow. */
  function wearable(player, style) {
    const bySlot = new Map();
    const add = (slot, id) => {
      if (!Number.isInteger(id)) return;
      let ids = bySlot.get(slot);
      if (!ids) bySlot.set(slot, (ids = new Set()));
      ids.add(id);
    };
    const { offence, armour } = reach(player, style);
    for (const tier of offence) for (const id of tier.weapons) add(Equipment.WEAPON_SLOT, id);
    for (const tier of armour) for (const [slot, ids] of tier.armour) for (const id of ids) add(slot, id);
    // The starter kit's shield is in no tier.
    if (style === "melee") add(Equipment.SHIELD_SLOT, ItemIdentifiers.WOODEN_SHIELD);
    return bySlot;
  }

  /** The arrows a bow fires: those of its own tier and the tiers below. */
  function ammoFor(bowId) {
    const at = tiers.ranged.findIndex((tier) => tier.weapons.includes(bowId));
    return new Set(tiers.ranged.slice(0, at + 1).flatMap((tier) => tier.ammo));
  }

  /** The best bow this bot has (worn or carried) and may use, or null. */
  function ownBow(player) {
    const bows = [...(wearable(player, "ranged").get(Equipment.WEAPON_SLOT) ?? [])]
      .filter((id) => has(player, id) && meets(player, id));
    return bows.sort((a, b) => value(b) - value(a))[0] ?? null;
  }

  function arrowsFor(player, bowId) {
    let count = 0;
    for (const id of ammoFor(bowId)) {
      count += carried(player, id);
      const slot = player.getEquipment().getItems()[Equipment.AMMUNITION_SLOT];
      if (slot?.getId?.() === id) count += slot.getAmount();
    }
    return count;
  }

  /** How many times the bot can cast `spell` with the runes it carries. */
  function casts(player, spell) {
    const runes = spell.itemsRequired?.(player) ?? [];
    return runes.reduce((least, rune) => Math.min(least, Math.floor(carried(player, rune.getId()) / Math.max(1, rune.getAmount()))), Infinity);
  }

  /** The training spells this bot's Magic allows, weakest first. */
  function spellsFor(player) {
    const level = player.getSkillManager().getCurrentLevel(Skill.MAGIC);
    return reach(player, "magic").offence.flatMap((tier) => tier.spells).filter((spell) => level >= (spell.levelRequired?.() ?? 1));
  }

  /** The best spell it has the runes for, or null. */
  function ownSpell(player) {
    return [...spellsFor(player)].reverse().find((spell) => casts(player, spell) >= 1) ?? null;
  }

  /** The style it can fight in right now: its own while it is equipped for it, else melee. */
  function usableStyle(player) {
    const preferred = preferredStyle(player);
    if (preferred === "ranged") {
      const bow = ownBow(player);
      return bow !== null && arrowsFor(player, bow) > 0 ? "ranged" : "melee";
    }
    if (preferred === "magic") return ownSpell(player) ? "magic" : "melee";
    return "melee";
  }

  /** Wears the best it carries for `style`, slot by slot. Returns whether anything changed. */
  function dress(player, style) {
    const equipment = player.getEquipment();
    const inventory = player.getInventory();
    let changed = false;
    const wearBest = (slot, ids, stacks = false) => {
      const wornItem = equipment.getItems()[slot];
      const wornId = wornItem?.getId?.() ?? -1;
      let bestAt = -1;
      let bestValue = ids.has(wornId) && wornItem.getAmount() > 0 ? value(wornId) : -1;
      inventory.getItems().forEach((item, at) => {
        const id = item?.getId?.() ?? -1;
        if (id <= 0 || !ids.has(id) || !meets(player, id)) return;
        // More of the arrows already in the quiver join them.
        if (value(id) > bestValue || (stacks && id === wornId && bestAt < 0)) {
          bestValue = Math.max(bestValue, value(id));
          bestAt = at;
        }
      });
      if (bestAt < 0) return;
      EquipPacketListener.equip(player, inventory.getItems()[bestAt].getId(), bestAt, Inventory.INTERFACE_ID);
      changed = true;
    };
    const slots = wearable(player, style);
    // Magic needs no staff: without one the bot casts with whatever it holds.
    wearBest(Equipment.WEAPON_SLOT, slots.get(Equipment.WEAPON_SLOT) ?? new Set());
    const weapon = equipment.getItems()[Equipment.WEAPON_SLOT];
    const twoHanded = weapon?.getId?.() > 0 && weapon.getDefinition?.()?.isDoubleHanded?.() === true;
    if (style === "ranged" && weapon?.getId?.() > 0) wearBest(Equipment.AMMUNITION_SLOT, ammoFor(weapon.getId()), true);
    for (const [slot, ids] of slots) {
      if (slot === Equipment.WEAPON_SLOT || (slot === Equipment.SHIELD_SLOT && twoHanded)) continue;
      wearBest(slot, ids);
    }
    return changed;
  }

  /** Before each target: dressed for the style it can fight in, its spell set. Returns the style. */
  function prepare(player, state) {
    const style = usableStyle(player);
    state.combatStyle = style;
    dress(player, style);
    if (style === "magic") {
      const spell = ownSpell(player);
      if (spell) core.Autocasting?.setAutocast(player, spell);
    }
    state.virtualFoodChargesRemaining = foodCarried(player);
    return style;
  }

  /** What a bot of this style takes with it through a bank visit. */
  function combatKeep(player) {
    const preferred = preferredStyle(player);
    return keeping(isFoodItem, [...runeIds], [...ammoIds], [...(styleWeapons[preferred] ?? [])]);
  }

  function foodToTake(player) {
    let need = FOOD_CARRIED - foodCarried(player);
    const list = [];
    for (const entry of bankedWhere(player, isFoodItem)) {
      if (need <= 0) break;
      const amount = Math.min(need, entry.amount);
      list.push({ itemId: entry.itemId, amount });
      need -= amount;
    }
    return list;
  }

  /** TrainCombat's own draw of a tier's item for this bot, so a crowd still varies. */
  function pick(player, pool, seed) {
    if (!pool?.length) return null;
    const start = hashSeed(`${player.getUsername?.() ?? "bot"}:${seed}`) % pool.length;
    for (let index = 0; index < pool.length; index += 1) {
      const id = pool[(start + index) % pool.length];
      if (id === null) return null;
      if (meets(player, id)) return id;
    }
    return null;
  }

  /** The kit this bot aims for at its levels: [[slot, item id]], weapon first. */
  function aims(player, style) {
    const { offence, armour } = reach(player, style);
    const offenceTier = offence[offence.length - 1];
    const armourTier = armour[armour.length - 1];
    const list = [];
    if (offenceTier) list.push([Equipment.WEAPON_SLOT, pick(player, offenceTier.weapons, `weapon:${offenceTier.minLevel}`)]);
    for (const [slot, ids] of armourTier?.armour ?? []) list.push([slot, pick(player, ids, `slot:${slot}:${armourTier.minLevel}`)]);
    return list.filter(([, id]) => Number.isInteger(id));
  }

  /** The errands to run before the next round of training, in order. Each is (ctx) => a step result. */
  function errands(ctx) {
    const { player, state, nowMs } = ctx;
    const preferred = preferredStyle(player);
    const steps = [];
    const fetching = (need) => (c) => own.fetch(c, { optional: true, ...need });
    const keep = combatKeep(player);
    dress(player, usableStyle(player));
    const lowFood = foodCarried(player) < FOOD_LOW && bankedWhere(player, isFoodItem).length > 0;
    const full = player.getInventory().getFreeSlots() < FREE_SLOTS_WANTED && clutter(player, keep) > 0;
    if (lowFood || full) steps.push((c) => own.bankTrip(c, "combat", { keep, withdraw: foodToTake }));

    if (preferred === "ranged") {
      let bow = ownBow(player);
      if (bow === null) {
        // One in the bank, or the bow it aims for from a shop.
        const usable = [...(wearable(player, "ranged").get(Equipment.WEAPON_SLOT) ?? [])].filter((id) => meets(player, id));
        bow = usable.find((id) => banked(player, id) > 0) ?? aims(player, "ranged")[0]?.[1] ?? null;
        if (bow !== null) steps.push(fetching({ itemId: bow }));
      }
      if (bow !== null && arrowsFor(player, bow) < AMMO_LOW) {
        const arrows = [...ammoFor(bow)].sort((a, b) => value(a) - value(b));
        const arrow = arrows.find((id) => banked(player, id) > 0) ?? arrows.find((id) => own.offer(id));
        if (arrow !== undefined) steps.push(fetching({ itemId: arrow, min: carried(player, arrow) + 1, amount: AMMO_BUY }));
      }
    }
    if (preferred === "magic") {
      const spells = spellsFor(player);
      const cost = (spell) => (spell.itemsRequired?.(player) ?? [])
        .reduce((sum, rune) => sum + (own.offer(rune.getId())?.price ?? Infinity) * rune.getAmount(), 0);
      // The best spell it can pay a good few casts of; failing that, the cheapest.
      const spell = [...spells].reverse().find((candidate) => casts(player, candidate) >= CASTS_LOW || purse(player) >= cost(candidate) * CASTS_LOW)
        ?? [...spells].sort((a, b) => cost(a) - cost(b))[0];
      if (spell && casts(player, spell) < CASTS_LOW) {
        for (const rune of spell.itemsRequired?.(player) ?? []) {
          const each = Math.max(1, rune.getAmount());
          if (carried(player, rune.getId()) >= each * CASTS_LOW) continue;
          steps.push(fetching({ itemId: rune.getId(), min: carried(player, rune.getId()) + each, amount: each * CASTS_BUY }));
        }
      }
    }

    // One better piece of kit a round: the first it aims for, does not own, and a shop sells.
    const equipment = player.getEquipment().getItems();
    for (const [slot, id] of aims(player, preferred)) {
      if (has(player, id)) continue;
      const wornId = equipment[slot]?.getId?.() ?? -1;
      if (wornId > 0 && value(wornId) >= value(id)) continue;
      if (banked(player, id) > 0) {
        steps.push(fetching({ itemId: id, buy: false }));
        break;
      }
      const offer = own.offer(id);
      if (!offer) continue;
      if (purse(player) >= offer.price) steps.push(fetching({ itemId: id }));
      else own.wish(state, id, offer.price, nowMs);
      break;
    }
    return steps;
  }

  /**
   * Between rounds of training: the bank and the shops. "running" while the bot is on an errand,
   * "done" otherwise. `bot` is TrainCombat's per-bot state.
   */
  function provision(ctx, bot) {
    const { nowMs } = ctx;
    if (!bot.errands) {
      if (nowMs < (bot.provisionAfter ?? 0)) return "done";
      bot.errands = errands(ctx);
    }
    while (bot.errands.length > 0) {
      if (bot.errands[0](ctx) === "running") return "running";
      bot.errands.shift();
    }
    bot.errands = null;
    bot.provisionAfter = nowMs + PROVISION_EVERY_MS;
    return "done";
  }

  /** Whether a drop is worth the walk: coins, its arrows and runes, or something better than it wears. */
  function wanted(player, itemId) {
    if (itemId === ItemIdentifiers.COINS || runeIds.has(itemId) || ammoIds.has(itemId)) return true;
    if (player.getInventory().getFreeSlots() <= 0) return false;
    const equipment = player.getEquipment().getItems();
    for (const style of new Set(["melee", preferredStyle(player)])) {
      for (const [slot, ids] of wearable(player, style)) {
        if (!ids.has(itemId) || !meets(player, itemId) || has(player, itemId)) continue;
        const wornId = equipment[slot]?.getId?.() ?? -1;
        if (wornId <= 0 || value(itemId) > value(wornId)) return true;
      }
    }
    return false;
  }

  /** Called when the bot's target dies: its drops are looked for where it fell. */
  function noteKill(bot, npc, nowMs) {
    const at = npc?.getLocation?.();
    if (at) bot.loot = { x: at.getX(), y: at.getY(), z: at.getZ(), at: nowMs + LOOT_WAIT_MS, until: nowMs + LOOT_FOR_MS, items: null };
  }

  /** Picks up what its kill dropped. "running" while there is something to fetch, "done" otherwise. */
  function loot(ctx, bot) {
    const { player, nowMs } = ctx;
    const spot = bot.loot;
    if (!spot) return "done";
    if (nowMs < spot.at) return "running";
    if (!spot.items) {
      spot.items = ItemOnGroundManager.ownedBy(player.getUsername()).filter((item) => {
        const at = item.getPosition();
        return at.getZ() === spot.z && Math.max(Math.abs(at.getX() - spot.x), Math.abs(at.getY() - spot.y)) <= LOOT_RANGE &&
          wanted(player, item.getItem().getId());
      });
    }
    while (spot.items.length > 0 && (!ItemOnGroundManager.exists(spot.items[0]) || spot.items[0].isPendingRemoval?.())) spot.items.shift();
    if (spot.items.length === 0 || nowMs > spot.until) {
      bot.loot = null;
      return "done";
    }
    const at = spot.items[0].getPosition();
    const loc = player.getLocation();
    if (loc.getX() === at.getX() && loc.getY() === at.getY()) {
      ItemOnGroundManager.pickup(player, spot.items.shift());
      return "running";
    }
    if (player.getMovementQueue().size() === 0 && !peekMovementRequest(player)) {
      requestMovement(player, at.getX(), at.getY(), { nowMs, z: at.getZ(), reason: "brain_own_items_loot", basicPather: true });
    }
    return "running";
  }

  /** Hurt, with nothing to eat: training is over for now. */
  function mustRetreat(player) {
    const manager = player.getSkillManager();
    const max = manager.getMaxLevel(Skill.HITPOINTS);
    return max > 0 && player.getHitpoints() / max <= RETREAT_HP_RATIO && foodCarried(player) === 0;
  }

  function stop(ctx, bot) {
    own.stop(ctx);
    bot.errands = null;
    bot.loot = null;
  }

  return { prepare, provision, noteKill, loot, mustRetreat, stop, preferredStyle, usableStyle, dress, wanted, RETREAT_COOLDOWN_MS };
}

module.exports = { createOwnCombatKit };
