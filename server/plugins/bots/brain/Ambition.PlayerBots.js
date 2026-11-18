"use strict";

/**
 * Ours. What a levelling bot wants next, and what it does about it.
 *
 * A bot that owns what it uses (brain/OwnItems) only looks for a better axe or sword when a
 * step of its work happens to. This gives each of them a mind of its own. Every few minutes it
 * looks at what it has, what its levels allow and what its coins buy, and sets itself goals:
 *
 *   tool      the next axe or pickaxe its level can use; the rod, pot or harpoon (and the bait)
 *             of the best fishing it can do
 *   weapon    the next better weapon and piece of armour for its combat style, from the tiers
 *   armour    in bot-combat-gear.json
 *   food      a stock of cooked food in its bank before it fights
 *   level     the next level that unlocks something: a better tree, rock or fish, a rooftop
 *             course, a tool, a tier of kit
 *   more      what other parts of the bots add (brain/BotPotions: potions for its fights)
 *
 * and acts on them:
 *
 *   wish      what it cannot pay for yet is its wish (OwnItems), so it sells what it gathers
 *             instead of dropping it
 *   steer     its next activity is drawn with its own weights: more of the skill whose level it
 *             is after, more gathering while it saves, more fishing while it is short of food
 *   errand    what it can pay for it goes and gets, there and then: at the shop that sells it,
 *             or with a bid on the Grand Exchange when no shop does or the exchange is cheaper.
 *             It goes back to collect what it bought, takes better kit out of its bank and puts
 *             it on, and takes its goods to the exchange when it is saving for something.
 *
 * Nothing is handed to it. Every errand is one of the bot's own ways of getting a thing: a shop
 * paid with its coins (OwnItems.fetch), its bank, or the exchange's book (BotExchange), which
 * takes the coins when the bid is placed.
 *
 * Only the bots of a progression site have one (Brain asks for it by the site's rotation), and
 * only while they own what they use. World setting "PlayerBots:ambition" (default on).
 */
const fs = require("node:fs");
const path = require("node:path");
const { Skill } = require("../../../src/main/typescript/elvarg/game/model/Skill");
const { SkillManager } = require("../../../src/main/typescript/elvarg/game/content/skill/SkillManager");
const { ItemDefinition } = require("../../../src/main/typescript/elvarg/game/definition/ItemDefinition");
const { ItemIdentifiers } = require("../../../src/main/typescript/elvarg/util/ItemIdentifiers");
const { Equipment } = require("../../../src/main/typescript/elvarg/game/model/container/impl/Equipment");
const { Bank } = require("../../../src/main/typescript/elvarg/game/model/container/impl/Bank");
const WorldDefinition = require("../../../src/main/typescript/elvarg/game/definition/WorldDefinition");
const { CacheDefinitions } = require("../../../src/main/typescript/elvarg/game/cache/CacheDefinitions");
const { PluginManager } = require("../../../src/main/typescript/elvarg/plugins/PluginManager");
const Woodcutting = require("../../skills/Woodcutting.plugin");
const Mining = require("../../skills/Mining.plugin");
const { isFoodItem } = require("../../items/Food.plugin");
const { clearMovementRequest } = require("../behaviours/navigation/Navigation.PlayerBots");
const { bankedWhere, carried, earnsOwnItems, ownItemsFor, purse } = require("./OwnItems.PlayerBots");
const { botExchange, createExchangeAction, guide, loadProduce } = require("./actions/Exchange.PlayerBots");
const { createOwnCombatKit } = require("./actions/OwnCombatKit.PlayerBots");

const AMBITION_CONFIG = "PlayerBots:ambition";
/** The activity an errand runs as, on top of the bot's work (bot-activities.json). */
const ERRAND_ACTIVITY = "ambition_errand";
const COINS = ItemIdentifiers.COINS;

// A bot takes stock of itself this often (each draws its own time in the range).
const SURVEY_MS = [120_000, 240_000];
// Not a moment it can leave its work (a fight, a lap of a course): asked again after this long.
const RETRY_MS = 20_000;
// After an errand it works on for at least this long before the next.
const ERRAND_REST_MS = 5 * 60_000;
// An errand that failed within this long of starting never got going.
const QUICK_FAILURE_MS = 30_000;
// While it is out it does this many things at most (a shop, then another, then the bank), as a
// player does a round of the shops, before it goes back to work.
const ERRAND_STOPS = 3;
// The exchange is a long walk: not again for this long after a visit.
const EXCHANGE_REST_MS = 12 * 60_000;
// A goal whose errand failed is left alone this long.
const GOAL_COOLDOWN_MS = 20 * 60_000;
// A bot whose look at itself went wrong (a fault in here) is left to its work this long.
const FAULT_REST_MS = 10 * 60_000;
// A shop it could not buy an item at is not tried again for this long: the exchange is asked instead.
const NO_SHOP_MS = 45 * 60_000;
// The level it is after is kept this long, so it does not change its mind at every look.
const FOCUS_MS = 60 * 60_000;
// How much more often it turns to the skill it is after, to fishing while short of food, and
// to work that earns while it saves; and how much less often to a fight it has no food for.
const FOCUS_WEIGHT = 3;
const FOOD_WEIGHT = 2;
const HUNGRY_FIGHT_WEIGHT = 0.4;
const SAVING_WEIGHT = 1.5;
// Cooked food it wants to own before it turns to fighting as often as the site would have it:
// more as its Hitpoints grow (a new character's fights with chickens need none), up to this much.
const FOOD_STOCK = 20;
const FOOD_FREE_HITPOINTS = 10;
// Goods worth less than this in all are not worth a walk to the exchange (as Exchange has it).
const WORTH_SELLING = 150;
// Food it never counts as goods (Exchange keeps as much back for the bot's own fights).
const FOOD_KEPT = 30;
// A shop up to this much dearer than the exchange is still where it buys: the item is in its
// hands at once, and the exchange is two walks.
const SHOP_PREFERENCE = 1.25;
// Coins it never spends on a goal: a toll gate's fee and a little over, so that an errand never
// leaves it unable to pay its way back (the gate into Al Kharid stops a bot with empty pockets).
const SPARE_COINS = 20;
// Bait: fewer than LOW and more is wanted, BUY at a time (or what its coins buy, MIN at least).
const BAIT_LOW = 20;
const BAIT_BUY = 150;
const BAIT_MIN = 20;

const TOOL_SKILLS = { axe: Skill.WOODCUTTING, pickaxe: Skill.MINING };

/** Whether this world's levelling bots set themselves goals (world setting, default on). */
function worldHasAmbition() {
  return PluginManager.getPluginConfig?.(AMBITION_CONFIG) !== false;
}

/** TrainCombat's own seed for a bot's draws (its style, its pick of a tier): the two must agree. */
function hashSeed(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash;
}

const itemNamed = (name) => (typeof name === "string" ? ItemIdentifiers[name.trim().toUpperCase().replace(/[\s-]+/g, "_")] ?? null : null);
const skillNamed = (name) => (typeof name === "string" ? Skill[name.trim().toUpperCase().replace(/[\s-]+/g, "_")] ?? null : null);
const value = (itemId) => Number(ItemDefinition.forId(itemId)?.getValue?.() ?? 0);
const itemName = (itemId) => String(ItemDefinition.forId(itemId)?.getName?.() ?? `item ${itemId}`);
const between = ([least, most]) => least + Math.random() * (most - least);
/** Free worlds: a members item is no use there, so a bot does not want one. */
const usableOnWorld = (itemId) => WorldDefinition.isMembersWorld() || CacheDefinitions.getItem(itemId)?.isMembers !== true;

/** Every action type in a list of action specs, however deep (a choose's options, an orElse). */
function actionTypes(actions, found = new Set()) {
  for (const action of actions ?? []) {
    if (!action || typeof action !== "object") continue;
    if (action.type) found.add(action.type);
    actionTypes([action.orElse, action.then, action.else, ...(action.options ?? []).flatMap((option) => option.actions ?? [])], found);
  }
  return found;
}

/**
 * What the bots' own data says there is to want, read once: the rungs of each mode (which level
 * of which skill opens which activity, and the tool it needs), the tools by level, and the
 * combat tiers.
 */
function loadCatalogue(core, definitionsPath) {
  const raw = JSON.parse(fs.readFileSync(definitionsPath, "utf8"));
  const gearTables = JSON.parse(fs.readFileSync(path.join(path.dirname(definitionsPath), "bot-combat-gear.json"), "utf8"));
  const templates = raw.templates ?? {};
  const ladders = new Map();
  const fieldsById = new Map();
  const modes = { combat: null, food: null, trading: null, earning: new Set() };
  let combat = null;
  for (const activity of raw.activities ?? []) {
    const fields = { ...(fieldsById.get(activity.fieldsFrom) ?? {}), ...(activity.fields ?? {}) };
    fieldsById.set(activity.id, fields);
    const template = templates[activity.template] ?? null;
    const merged = template ? { ...template, ...activity } : activity;
    if (!merged.mode || merged.manual === true) continue;
    const types = actionTypes(merged.actions);
    const fight = (merged.actions ?? []).find((action) => action?.type === "trainCombat");
    if (fight && !combat) {
      combat = { ...fight, ...(fight.gearRef ? gearTables[fight.gearRef] ?? {} : {}) };
      modes.combat = merged.mode;
    }
    if (types.has("exchange")) modes.trading = merged.mode;
    if (types.has("cook")) modes.food = merged.mode;
    if (types.has("sellItems")) modes.earning.add(merged.mode);
    const skill = skillNamed((merged.requires ?? []).find((rule) => rule?.skill)?.skill?.id);
    if (!skill) continue;
    let ladder = ladders.get(merged.mode);
    if (!ladder) ladders.set(merged.mode, (ladder = []));
    ladder.push({
      id: activity.id,
      skill,
      level: Number(fields.level ?? 1),
      toolKind: (merged.actions ?? []).find((action) => action?.type === "equipTool")?.tool ?? null,
      tool: itemNamed(fields.tool),
      bait: itemNamed(fields.bait),
    });
  }
  for (const ladder of ladders.values()) ladder.sort((a, b) => a.level - b.level);

  // As TrainCombat builds them: lowest tier first, item names resolved, a null for "nothing in this slot".
  const buildTiers = (tiers) => (tiers ?? []).map((tier) => ({
    minLevel: tier.minLevel,
    weapons: (tier.weapons ?? []).map(itemNamed).filter(Number.isInteger),
    ammo: (tier.ammo ?? []).map(itemNamed).filter(Number.isInteger),
    spells: (tier.spells ?? []).map((key) => core.CombatSpells?.[key]).filter(Boolean),
    armour: Object.entries(tier.armour ?? {}).filter(([slot]) => Number.isInteger(Equipment[slot]))
      .map(([slot, keys]) => [Equipment[slot], (Array.isArray(keys) ? keys : [keys]).map((key) => (key === null ? null : itemNamed(key)))]),
  })).sort((a, b) => a.minLevel - b.minLevel);
  const tiers = { melee: buildTiers(combat?.gearTiers), ranged: buildTiers(combat?.rangedTiers), magic: buildTiers(combat?.magicTiers) };
  const styles = (combat?.styles ?? ["melee"]).filter((style) => (tiers[style] ?? tiers.melee).length > 0);

  const standard = (list) => (list ?? []).filter((tool) => tool.standard && usableOnWorld(tool.id))
    .map((tool) => ({ id: tool.id, level: tool.requiredLevel }));
  return {
    ladders,
    modes,
    tiers,
    styles,
    // Best first, as EquipTool lists them.
    tools: { axe: standard(Woodcutting.AXES_BEST_FIRST), pickaxe: standard(Mining.PICKAXES_DESC) },
  };
}

function createAmbition({ world, definitionsPath = path.join(process.cwd(), "data", "definitions", "bot-activities.json"), exchange = null } = {}) {
  const core = world.core;
  const own = ownItemsFor(world);
  const minds = new WeakMap();
  /** Every bot's total level as it last looked, by name: who is ahead of whom. */
  const ledger = new Map();
  /** Levels worth reaching that other parts of the bots add: { skill, level, mode, unlocks }. */
  const unlocks = [];
  /** Other parts' goals: (player, have, coins, price, nowMs) => [goal]. */
  const providers = [];
  /** What other parts want taken out of the bank on a visit: (player, have, fighting) => [{ itemId, amount }]. */
  const carriers = [];
  /** What other parts do every tick of a bot with a mind (a look at its potions): (brain, nowMs) => void. */
  const tickers = [];
  const skillByIndex = new Map(Skill.values().map((skill) => [skill.getIndex(), skill]));
  const book = () => exchange ?? botExchange();
  const nameOf = (player) => String(player.getUsername?.() ?? "").toLowerCase();

  // Read when first needed: the item definitions are loaded after the plugins register.
  let catalogue = null;
  const cat = () => (catalogue ??= loadCatalogue(core, definitionsPath));
  let ownKit = null;
  const kit = () => (ownKit ??= createOwnCombatKit({ world, tiers: cat().tiers, combatStyles: cat().styles, hashSeed, skillByIndex }));
  let produce = null;
  const goods = () => (produce ??= new Set(loadProduce(definitionsPath)));
  let visit = null;
  const exchangeVisit = () => (visit ??= createExchangeAction({}, world, book()));

  function mindOf(player, nowMs) {
    let mind = minds.get(player);
    if (!mind) {
      minds.set(player, (mind = {
        // The crowd does not all look at once.
        thinkAt: nowMs + Math.random() * SURVEY_MS[1],
        goals: [], levels: [], focus: null, saving: null, shortOfFood: false,
        errand: null, errandAfter: 0, exchangeAfter: 0,
        cool: new Map(), noShop: new Map(), told: null,
      }));
    }
    return mind;
  }

  /** What the bot has, looked at once: its bank as a map, and how many of an item it owns anywhere. */
  function holdings(player) {
    const bank = new Map(bankedWhere(player, () => true).map((entry) => [entry.itemId, entry.amount]));
    const wearing = new Set();
    for (const item of player.getEquipment().getItems() ?? []) if (item?.getId?.() > 0 && item.getAmount() > 0) wearing.add(item.getId());
    const count = (itemId) => carried(player, itemId) + (bank.get(itemId) ?? 0) + (wearing.has(itemId) ? 1 : 0);
    return { bank, wearing, count, owns: (itemId) => count(itemId) > 0 };
  }

  const meets = (player, itemId) => {
    const manager = player.getSkillManager();
    return !(ItemDefinition.forId(itemId)?.getRequirements?.() ?? [])
      .some((required, index) => required > 1 && skillByIndex.get(index) && required > manager.getCurrentLevel(skillByIndex.get(index)));
  };

  /** What one of an item costs this bot and where: { cost, source: "shop" | "exchange" }, or null when it is not for sale. */
  function price(itemId, mind, nowMs) {
    const shop = (mind.noShop.get(itemId) ?? 0) > nowMs ? null : own.offer(itemId);
    const going = ItemDefinition.forId(itemId)?.isTradeable?.() === true ? guide.buy(itemId) : null;
    if (shop && (going === null || shop.price <= going * SHOP_PREFERENCE)) return { cost: shop.price, source: "shop" };
    return going === null ? null : { cost: going, source: "exchange" };
  }

  /**
   * Of `candidates` (best first), the goal to set: the best one its coins buy now; with none,
   * the cheapest, which is what it saves for.
   */
  function purchase(candidates, coins, mind, nowMs, base) {
    let cheapest = null;
    for (const itemId of candidates) {
      const offer = price(itemId, mind, nowMs);
      if (!offer) continue;
      const goal = { ...base, key: `${base.kind}:${itemId}`, itemId, amount: 1, ...offer };
      if (offer.cost <= coins) return goal;
      if (!cheapest || offer.cost < cheapest.cost) cheapest = goal;
    }
    return cheapest;
  }

  /** The modes this bot's site lets it turn to. */
  function modesOf(brain) {
    const modes = new Set();
    for (const id of brain.rotation?.activityIds ?? []) {
      const mode = brain.registry?.byId?.get(id)?.mode;
      if (mode) modes.add(mode);
    }
    return modes;
  }

  function toolGoals(player, have, coins, modes, current, mind, nowMs) {
    const goals = [];
    const manager = player.getSkillManager();
    for (const mode of modes) {
      const ladder = cat().ladders.get(mode);
      if (!ladder) continue;
      // The work it is at comes first.
      const rank = mode === current ? 10 : 30;
      const kind = ladder.find((rung) => rung.toolKind)?.toolKind ?? null;
      if (kind && cat().tools[kind]) {
        const level = manager.getCurrentLevel(TOOL_SKILLS[kind]);
        const usable = cat().tools[kind].filter((tool) => level >= tool.level).map((tool) => tool.id);
        const ownedAt = usable.findIndex(have.owns);
        const goal = purchase(ownedAt < 0 ? usable : usable.slice(0, ownedAt), coins, mind, nowMs, { kind: "tool", rank, mode });
        if (goal) goals.push(goal);
      }
      // The best fishing its level allows: its rod, pot or harpoon, and the bait that goes with it.
      const rung = [...ladder].reverse().find((entry) => entry.tool !== null && manager.getCurrentLevel(entry.skill) >= entry.level);
      if (!rung) continue;
      if (!have.owns(rung.tool)) {
        const goal = purchase([rung.tool], coins, mind, nowMs, { kind: "tool", rank, mode });
        if (goal) goals.push(goal);
      } else if (rung.bait !== null && have.count(rung.bait) < BAIT_LOW) {
        const offer = price(rung.bait, mind, nowMs);
        if (offer) {
          const amount = Math.max(BAIT_MIN, Math.min(BAIT_BUY, Math.floor(coins / Math.max(1, offer.cost))));
          goals.push({ kind: "bait", key: `bait:${rung.bait}`, rank: rank + 5, mode, itemId: rung.bait, amount, source: offer.source, cost: offer.cost * amount });
        }
      }
    }
    return goals;
  }

  /** What this bot may wear for `style` at its levels: slot -> Set(item id), the weapon first (as OwnCombatKit has it). */
  function wearable(player, style) {
    const manager = player.getSkillManager();
    const offence = manager.getCurrentLevel(style === "ranged" ? Skill.RANGED : style === "magic" ? Skill.MAGIC : Skill.ATTACK);
    const defence = style === "melee" ? manager.getCurrentLevel(Skill.DEFENCE) : offence;
    const bySlot = new Map([[Equipment.WEAPON_SLOT, new Set()]]);
    const add = (slot, itemId) => {
      if (!Number.isInteger(itemId)) return;
      let ids = bySlot.get(slot);
      if (!ids) bySlot.set(slot, (ids = new Set()));
      ids.add(itemId);
    };
    for (const tier of cat().tiers[style] ?? cat().tiers.melee) {
      if (offence >= tier.minLevel) for (const itemId of tier.weapons) add(Equipment.WEAPON_SLOT, itemId);
      if (defence >= tier.minLevel) for (const [slot, ids] of tier.armour) for (const itemId of ids) add(slot, itemId);
    }
    if (style === "melee") add(Equipment.SHIELD_SLOT, ItemIdentifiers.WOODEN_SHIELD);
    return bySlot;
  }

  const SLOT_RANK = new Map([[Equipment.WEAPON_SLOT, 20], [Equipment.BODY_SLOT, 40], [Equipment.LEG_SLOT, 41], [Equipment.SHIELD_SLOT, 42], [Equipment.HEAD_SLOT, 43]]);

  /** One goal a slot: something better (dearer in a shop, which is how the kit ranks what it wears) than the best it owns. */
  function gearGoals(player, have, coins, mind, nowMs) {
    const goals = [];
    for (const [slot, ids] of wearable(player, kit().preferredStyle(player))) {
      let owned = -1;
      for (const itemId of ids) if (have.owns(itemId)) owned = Math.max(owned, value(itemId));
      const better = [...ids].filter((itemId) => value(itemId) > owned && meets(player, itemId) && usableOnWorld(itemId))
        .sort((a, b) => value(b) - value(a));
      const goal = purchase(better, coins, mind, nowMs, { kind: slot === Equipment.WEAPON_SLOT ? "weapon" : "armour", rank: SLOT_RANK.get(slot) ?? 50, slot });
      if (goal) goals.push(goal);
    }
    return goals;
  }

  /**
   * Better kit lying in its bank than it wears or carries: the item ids to take out. For the
   * style it can fight in now, which is what it would put on (an archer without arrows is not
   * handed its bow: OwnCombatKit fetches bow and arrows together when it next fights).
   */
  function kitInBank(player, have) {
    const list = [];
    const wornItems = player.getEquipment().getItems() ?? [];
    for (const [slot, ids] of wearable(player, kit().usableStyle(player))) {
      const wornId = wornItems[slot]?.getId?.() ?? -1;
      let best = ids.has(wornId) ? value(wornId) : -1;
      for (const itemId of ids) if (carried(player, itemId) > 0 && meets(player, itemId)) best = Math.max(best, value(itemId));
      let take = null;
      for (const itemId of ids) {
        if (!(have.bank.get(itemId) > 0) || !meets(player, itemId) || !(value(itemId) > best)) continue;
        best = value(itemId);
        take = itemId;
      }
      if (take !== null) list.push(take);
    }
    return list;
  }

  /** The next level of each skill that opens something to this bot: [{ kind: "level", skill, level, mode, unlocks, toGo }]. */
  function levelGoals(player, modes) {
    const manager = player.getSkillManager();
    const nearest = new Map();
    const consider = (skill, level, mode, what) => {
      if (!skill || !modes.has(mode) || !(level > manager.getMaxLevel(skill))) return;
      const known = nearest.get(skill);
      if (known && known.level <= level) return;
      nearest.set(skill, {
        kind: "level", key: `level:${skill.getName()}`, skill, level, mode, unlocks: what,
        toGo: Math.max(0, SkillManager.getExperienceForLevel(level) - manager.getExperience(skill)),
      });
    };
    for (const [mode, ladder] of cat().ladders) {
      for (const rung of ladder) consider(rung.skill, rung.level, mode, rung.id);
      const kind = ladder.find((rung) => rung.toolKind)?.toolKind ?? null;
      for (const tool of cat().tools[kind] ?? []) consider(TOOL_SKILLS[kind], tool.level, mode, itemName(tool.id));
    }
    const combat = cat().modes.combat;
    if (combat) {
      const style = kit().preferredStyle(player);
      const offence = style === "ranged" ? Skill.RANGED : style === "magic" ? Skill.MAGIC : Skill.ATTACK;
      for (const tier of cat().tiers[style] ?? []) {
        consider(offence, tier.minLevel, combat, `level ${tier.minLevel} kit`);
        if (style === "melee") consider(Skill.DEFENCE, tier.minLevel, combat, `level ${tier.minLevel} armour`);
      }
    }
    for (const entry of unlocks) consider(entry.skill, entry.level, entry.mode, entry.unlocks);
    return [...nearest.values()];
  }

  /**
   * The level it goes after: kept while it is still ahead of the bot, else drawn anew. Each
   * bot has a bent of its own, so a crowd does not all chase the same thing: the level
   * nearest to hand, the skill it is worst at, or its fighting.
   */
  function focusOn(player, mind, levels, nowMs) {
    const kept = mind.focus && levels.find((goal) => goal.key === mind.focus.key && goal.level === mind.focus.level);
    if (kept && nowMs - mind.focus.since < FOCUS_MS) return { ...kept, since: mind.focus.since };
    if (levels.length === 0) return null;
    const bent = hashSeed(`${player.getUsername?.() ?? "bot"}:bent`) % 3;
    const manager = player.getSkillManager();
    const nearest = [...levels].sort((a, b) => a.toGo - b.toGo);
    const fighting = nearest.find((goal) => goal.mode === cat().modes.combat);
    const weakest = [...levels].sort((a, b) => manager.getMaxLevel(a.skill) - manager.getMaxLevel(b.skill) || a.toGo - b.toGo)[0];
    const pick = bent === 0 ? nearest[0] : bent === 1 ? weakest : fighting ?? nearest[0];
    return { ...pick, since: nowMs };
  }

  /** Cooked food it has, in its backpack and its bank. */
  function foodStock(player, have) {
    let stock = 0;
    for (const [itemId, amount] of have.bank) if (isFoodItem(itemId)) stock += amount;
    for (const item of player.getInventory().getItems() ?? []) if (isFoodItem(item?.getId?.())) stock += item.getAmount();
    return stock;
  }

  /** What its goods would fetch at the exchange (food it keeps for itself left out). */
  function goodsWorth(player, have) {
    let worth = 0;
    let foodLeft = FOOD_KEPT;
    for (const itemId of goods()) {
      let amount = (have.bank.get(itemId) ?? 0) + carried(player, itemId);
      if (isFoodItem(itemId)) {
        const kept = Math.min(amount, foodLeft);
        foodLeft -= kept;
        amount -= kept;
      }
      worth += amount * guide.sell(itemId);
    }
    return worth;
  }

  /** The bot's whole look at itself. Sets what it wants; returns the errand it could run now, or null. */
  function think(brain, mind, nowMs) {
    const player = brain.player;
    const state = brain.ensureState?.() ?? brain.state ?? null;
    const have = holdings(player);
    // What it has to spend: its purse less what it keeps by.
    const coins = Math.max(0, purse(player) - SPARE_COINS);
    const modes = modesOf(brain);
    const current = brain.frames?.[0]?.behaviour?.mode ?? null;
    for (const [key, until] of mind.cool) if (until <= nowMs) mind.cool.delete(key);

    const goals = [...toolGoals(player, have, coins, modes, current, mind, nowMs)];
    if (modes.has(cat().modes.combat)) goals.push(...gearGoals(player, have, coins, mind, nowMs));
    for (const provider of providers) goals.push(...provider(player, have, coins, (itemId) => price(itemId, mind, nowMs), nowMs));
    goals.sort((a, b) => a.rank - b.rank);
    mind.goals = goals;
    mind.levels = levelGoals(player, modes);
    mind.focus = focusOn(player, mind, mind.levels, nowMs);
    mind.food = foodStock(player, have);
    mind.foodWanted = Math.max(0, Math.min(FOOD_STOCK, player.getSkillManager().getMaxLevel(Skill.HITPOINTS) - FOOD_FREE_HITPOINTS));
    mind.shortOfFood = modes.has(cat().modes.combat) && modes.has(cat().modes.food) && mind.food < mind.foodWanted;
    const open = goals.filter((goal) => !mind.cool.has(goal.key));
    mind.saving = open.find((goal) => goal.cost > coins) ?? null;
    // Its wish: while it is short of the coins it sells what it gathers (Choose asks OwnItems).
    if (mind.saving && state && !own.wishing(player, state, nowMs)) own.wish(state, mind.saving.itemId, mind.saving.cost + SPARE_COINS, nowMs);

    const manager = player.getSkillManager();
    ledger.set(nameOf(player), Skill.values().reduce((sum, skill) => sum + manager.getMaxLevel(skill), 0));
    const told = `${mind.saving?.key ?? ""}|${mind.focus?.key ?? ""}:${mind.focus?.level ?? ""}`;
    if (told !== mind.told) {
      mind.told = told;
      world.log?.("bot_ambition_goals", {
        username: player.getUsername?.(), coins,
        saving: mind.saving ? { item: itemName(mind.saving.itemId), cost: mind.saving.cost, from: mind.saving.source } : null,
        level: mind.focus ? { skill: mind.focus.skill.getName(), level: mind.focus.level, unlocks: mind.focus.unlocks } : null,
        wants: goals.map((goal) => itemName(goal.itemId)),
      });
      world.talk?.note?.(player, "goal", { saving: mind.saving, focus: mind.focus });
    }

    if (nowMs < mind.errandAfter) return null;
    const errand = (kind, goal, steps) => ({ kind, goal, steps });
    const fighting = current === cat().modes.combat;
    const take = [...kitInBank(player, have), ...carriers.flatMap((carrier) => carrier(player, have, fighting).map((entry) => entry.itemId))];
    if (take.length > 0 && !mind.cool.has("wear")) return errand("wear", null, [wearStep(mind, fighting)]);
    const buy = open.find((goal) => goal.cost <= coins && goal.source === "shop");
    if (buy) return errand("buy", buy, [buyStep(mind, buy)]);
    if (nowMs < mind.exchangeAfter || mind.cool.has("exchange")) return null;
    const bid = open.find((goal) => goal.cost <= coins && goal.source === "exchange" && !book().bids(nameOf(player), goal.itemId));
    if (bid) return errand("exchange", bid, [exchangeStep(mind, bid, fighting)]);
    if (book().hasDue(nameOf(player)) || (mind.saving && goodsWorth(player, have) >= WORTH_SELLING)) return errand("exchange", null, [exchangeStep(mind, null, fighting)]);
    return null;
  }

  /** Wears the best of what it carries, as it would before a fight. */
  function dress(player) {
    return kit().dress(player, kit().usableStyle(player));
  }

  function got(player, goal) {
    world.log?.("bot_ambition_got", { username: player.getUsername?.(), item: itemName(goal.itemId), amount: goal.amount, from: goal.source, cost: goal.cost });
    world.talk?.note?.(player, "got", { goal });
  }

  /** A walk to the shop that sells it, paid with its own coins. */
  function buyStep(mind, goal) {
    let base = null;
    return (ctx) => {
      base ??= carried(ctx.player, goal.itemId);
      const result = own.fetch(ctx, { itemId: goal.itemId, min: base + 1, amount: base + goal.amount, optional: true });
      if (result === "running") return "running";
      if (result === "failed") {
        // Sold out, too dear at the counter, or no way there: the exchange is asked next time.
        mind.noShop.set(goal.itemId, ctx.nowMs + NO_SHOP_MS);
        return "failed";
      }
      got(ctx.player, { ...goal, amount: carried(ctx.player, goal.itemId) - base });
      if (goal.kind === "weapon" || goal.kind === "armour") dress(ctx.player);
      return "success";
    };
  }

  /** A walk to the bank: its goods are left there, better kit comes out and is put on. `fighting`: its work is a fight. */
  function wearStep(mind, fighting) {
    return (ctx) => {
      const result = own.bankTrip(ctx, "ambition", {
        keep: (itemId) => !goods().has(itemId),
        withdraw: (player) => {
          const have = holdings(player);
          return [...kitInBank(player, have).map((itemId) => ({ itemId, amount: 1 })), ...carriers.flatMap((carrier) => carrier(player, have, fighting))];
        },
      });
      if (result === "running") return "running";
      if (result === "failed") {
        mind.cool.set("wear", ctx.nowMs + GOAL_COOLDOWN_MS);
        return "failed";
      }
      if (dress(ctx.player)) world.log?.("bot_ambition_dressed", { username: ctx.player.getUsername?.() });
      // Still there (a full backpack): not walked back for at every look.
      const have = holdings(ctx.player);
      if (kitInBank(ctx.player, have).length > 0 || carriers.some((carrier) => carrier(ctx.player, have, fighting).length > 0)) mind.cool.set("wear", ctx.nowMs + GOAL_COOLDOWN_MS);
      return "success";
    };
  }

  /** Takes coins from the bot, its backpack first and then its bank. Returns whether it had them. */
  function spend(player, coins) {
    if (purse(player) - SPARE_COINS < coins) return false;
    let left = coins;
    const pack = Math.min(left, carried(player, COINS));
    if (pack > 0) {
      player.getInventory().deleteNumber(COINS, pack);
      left -= pack;
    }
    for (let tab = 0; tab < Bank.TOTAL_BANK_TABS - 1 && left > 0; tab++) {
      const bank = player.getBank(tab);
      const there = Math.min(left, bank?.getAmount?.(COINS) ?? 0);
      if (there > 0) {
        bank.deleteNumber(COINS, there);
        left -= there;
      }
    }
    return left === 0;
  }

  /**
   * A visit to the Grand Exchange (Exchange has the walk and the trade: what is due to it is
   * collected, its goods are put up, and its wish is bid for). `goal` is made its wish first,
   * and once there it bids for whatever else on its list its coins still cover.
   */
  function exchangeStep(mind, goal, fighting) {
    // Exchange's own cooldowns are for its activity in the rotation, not for this frame.
    const frame = {};
    let wished = false;
    return (ctx) => {
      const { player, nowMs } = ctx;
      if (goal && !wished) {
        own.wish(ctx.state, goal.itemId, goal.cost, nowMs);
        wished = true;
      }
      const result = exchangeVisit().update({ ...ctx, frame, activity: { id: `${ERRAND_ACTIVITY}:exchange` } });
      if (result === "running") return "running";
      mind.exchangeAfter = nowMs + EXCHANGE_REST_MS;
      if (result === "failed") {
        mind.cool.set("exchange", nowMs + GOAL_COOLDOWN_MS);
        return "failed";
      }
      const have = holdings(player);
      const bidFor = new Map();
      for (const entry of book().book().orders) if (entry.bot === nameOf(player)) bidFor.set(entry.itemId, (bidFor.get(entry.itemId) ?? 0) + entry.remaining);
      for (const want of mind.goals) {
        // Exchange bid for one of its wish; the rest of that (two potions), and of its list, is bid for here.
        const amount = want.amount - (bidFor.get(want.itemId) ?? 0);
        if (want.source !== "exchange" || mind.cool.has(want.key) || have.owns(want.itemId) || amount <= 0) continue;
        const each = guide.buy(want.itemId);
        if (!spend(player, each * amount)) continue;
        book().order(nameOf(player), want.itemId, amount, each);
        world.log?.("bot_ambition_bid", { username: player.getUsername?.(), item: itemName(want.itemId), amount, price: each });
      }
      // What it collected is in its bank, and so is it: better kit goes on before it leaves.
      if (kitInBank(player, have).length > 0 || carriers.some((carrier) => carrier(player, have, fighting).length > 0)) mind.errand?.steps.push(wearStep(mind, fighting));
      return "success";
    };
  }

  /** Whether the bot can put its work down this tick: no fight, no lap half run, no errand of its work's own. */
  function free(brain, nowMs) {
    const player = brain.player;
    const frame = brain.frames[0];
    if (brain.frames.length !== 1 || brain.paused) return false;
    // Only from work of the site's own: not from a trip another part has it on (the Wintertodt, across the sea).
    if (brain.rotation && !brain.rotation.activityIds.includes(frame.behaviour.id)) return false;
    if (frame.behaviour.mode === cat().modes.trading) return false;
    const combat = player.getCombat?.();
    if (combat?.getTarget?.() || combat?.getAttacker?.()) return false;
    if (player.busy?.() || own.busy(player)) return false;
    return frame.action()?.holdsRotation?.(brain.context(frame, nowMs)) !== true;
  }

  function finish(player, mind, ok, nowMs) {
    const errand = mind.errand;
    if (!errand) return;
    mind.errand = null;
    // One that came to nothing at once (no shop it can walk to) has cost it no time: it may try something else soon.
    mind.errandAfter = nowMs + (ok || nowMs - errand.startedAt > QUICK_FAILURE_MS ? ERRAND_REST_MS : RETRY_MS);
    mind.thinkAt = Math.min(mind.thinkAt, nowMs + RETRY_MS);
    if (!ok && errand.goal) mind.cool.set(errand.goal.key, nowMs + GOAL_COOLDOWN_MS);
    const at = player.getLocation?.();
    world.log?.("bot_ambition_errand_done", {
      username: player.getUsername?.(), errand: errand.kind, item: errand.goal ? itemName(errand.goal.itemId) : null,
      ok, tookMs: nowMs - errand.startedAt, x: at?.getX?.() ?? null, y: at?.getY?.() ?? null,
    });
  }

  /**
   * A fault in a bot's wants must never cost it its work: the brain's tick goes on, the fault
   * is logged (once a rest), and the bot is not asked what it wants for a while.
   */
  function fault(brain, error, nowMs) {
    const mind = mindOf(brain.player, nowMs);
    mind.thinkAt = nowMs + FAULT_REST_MS;
    if (mind.faultSaidAt !== undefined && nowMs < mind.faultSaidAt + FAULT_REST_MS) return;
    mind.faultSaidAt = nowMs;
    world.log?.("bot_ambition_fault", { username: brain.player.getUsername?.(), error: String(error?.stack ?? error).slice(0, 600) });
  }

  return {
    /** Called by the brain every tick of a progression bot: cheap until its next look is due. */
    tick(brain, nowMs = Date.now()) {
      if (!earnsOwnItems(brain.player)) return;
      try {
        for (const ticker of tickers) ticker(brain, nowMs);
        this.look(brain, nowMs);
      } catch (error) {
        fault(brain, error, nowMs);
      }
    },

    /** The bot's look at itself when it is due, and the errand it may start on. */
    look(brain, nowMs) {
      const player = brain.player;
      const mind = mindOf(player, nowMs);
      if (nowMs < mind.thinkAt) return;
      const top = brain.frames[brain.frames.length - 1];
      if (!top || top.behaviour.id === ERRAND_ACTIVITY) {
        mind.thinkAt = nowMs + RETRY_MS;
        return;
      }
      // An errand whose frame is gone (the brain was reset under it) is over.
      if (mind.errand) finish(player, mind, false, nowMs);
      mind.thinkAt = nowMs + between(SURVEY_MS);
      const errand = think(brain, mind, nowMs);
      const able = free(brain, nowMs);
      // Kit it already carries goes on without a walk (a fight dresses itself).
      if (able && brain.frames[0].behaviour.mode !== cat().modes.combat) dress(player);
      const activity = errand ? brain.registry?.byId?.get(ERRAND_ACTIVITY) : null;
      if (!activity) return;
      if (!able) {
        mind.thinkAt = nowMs + RETRY_MS;
        return;
      }
      const frame = brain.frames[0];
      brain.stopAction(frame.action(), brain.context(frame, nowMs));
      mind.errand = { ...errand, startedAt: nowMs };
      brain.pushActivity(activity, nowMs);
      world.log?.("bot_ambition_errand", { username: player.getUsername?.(), errand: errand.kind, item: errand.goal ? itemName(errand.goal.itemId) : null });
    },

    /** The bot's own weights for its next activity (activity id -> weight), or null for the site's. */
    steer(brain, weights) {
      try {
        return this.weigh(brain, weights);
      } catch (error) {
        fault(brain, error, Date.now());
        return null;
      }
    },

    /** The weights as its wants make them: see steer. */
    weigh(brain, weights) {
      const mind = minds.get(brain.player);
      if (!mind || !weights || !earnsOwnItems(brain.player) || !catalogue) return null;
      const factors = new Map();
      const weigh = (mode, factor) => mode && factors.set(mode, (factors.get(mode) ?? 1) * factor);
      if (mind.focus) weigh(mind.focus.mode, FOCUS_WEIGHT);
      if (mind.shortOfFood) {
        weigh(cat().modes.food, FOOD_WEIGHT);
        weigh(cat().modes.combat, HUNGRY_FIGHT_WEIGHT);
      }
      if (mind.saving) for (const mode of cat().modes.earning) weigh(mode, SAVING_WEIGHT);
      if (factors.size === 0) return null;
      const steered = {};
      for (const [id, weight] of Object.entries(weights)) steered[id] = weight * (factors.get(brain.registry?.byId?.get(id)?.mode) ?? 1);
      return steered;
    },

    /** The errand action's update: the bot's errand, a step at a time. */
    runErrand(ctx) {
      const mind = minds.get(ctx.player);
      const errand = mind?.errand;
      if (!errand) return "success";
      const step = errand.steps[0];
      const result = step ? step(ctx) : "success";
      if (result === "running") return "running";
      if (result === "failed") {
        // A later stop that did not work out is left for another day; what it went out for is done.
        const went = (errand.stops ?? 0) > 0;
        if (went && errand.goal) mind.cool.set(errand.goal.key, ctx.nowMs + GOAL_COOLDOWN_MS);
        finish(ctx.player, mind, went, ctx.nowMs);
        return went ? "success" : "failed";
      }
      errand.steps.shift();
      errand.stops = (errand.stops ?? 0) + 1;
      // As between a brain's actions: the next step inherits neither this one's walk nor an interface it left open.
      clearMovementRequest(ctx.player);
      if (Number(ctx.player.getInterfaceId?.() ?? -1) > 0) ctx.player.getPacketSender?.()?.sendInterfaceRemoval?.();
      if (errand.steps.length > 0) return "running";
      // While it is out: is there something else it can get now?
      const more = errand.stops < ERRAND_STOPS && ctx.brain ? think(ctx.brain, mind, ctx.nowMs) : null;
      if (more) {
        errand.steps.push(...more.steps);
        errand.goal = more.goal;
        world.log?.("bot_ambition_errand", { username: ctx.player.getUsername?.(), errand: more.kind, item: more.goal ? itemName(more.goal.itemId) : null, stop: errand.stops + 1 });
        return "running";
      }
      finish(ctx.player, mind, true, ctx.nowMs);
      return "success";
    },

    /** The errand action's stop: whatever trip it was on is dropped. */
    stopErrand(ctx) {
      own.stop(ctx);
      visit?.stop(ctx);
    },

    /** Another part's level worth reaching: { skill, level, mode (the mode that trains it), unlocks }. */
    addUnlock(entry) {
      unlocks.push(entry);
    },
    /** Another part's goals: (player, have, coins, price, nowMs) => [{ kind, key, rank, itemId, amount, cost, source }]. */
    addProvider(provider) {
      providers.push(provider);
    },
    /** What another part wants out of the bank on a visit: (player, have, fighting) => [{ itemId, amount }]. */
    addCarrier(carrier) {
      carriers.push(carrier);
    },
    /** What another part does every tick of a bot with a mind: (brain, nowMs) => void. Keep it cheap. */
    addTicker(ticker) {
      tickers.push(ticker);
    },

    /** Looks now, whatever the clock says, and returns the errand it would run (the tests, and a bot that has just changed). */
    consider(brain, nowMs = Date.now()) {
      return think(brain, mindOf(brain.player, nowMs), nowMs);
    },
    /** What the bot wants as it last looked: { goals, levels, focus, saving, food, shortOfFood, errand }. */
    mind: (player) => minds.get(player) ?? null,
    /** Where a bot stands in the crowd by total level: { total, rank, of, ahead (the name just above it) }. */
    standing(player) {
      const total = ledger.get(nameOf(player));
      if (total === undefined) return null;
      let rank = 1;
      let ahead = null;
      for (const [name, other] of ledger) {
        if (other <= total) continue;
        rank += 1;
        if (!ahead || other < ahead.total) ahead = { name, total: other };
      }
      return { total, rank, of: ledger.size, ahead: ahead?.name ?? null };
    },
    /** Whether the bot can put its work down this tick (brain/BotGroups asks before it calls a bot away). */
    free,
    holdings,
    kit,
    catalogue: cat,
  };
}

module.exports = { AMBITION_CONFIG, ERRAND_ACTIVITY, createAmbition, hashSeed, worldHasAmbition };
