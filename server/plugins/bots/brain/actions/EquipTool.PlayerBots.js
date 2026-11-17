"use strict";

const { Equipment } = require("../../../../src/main/typescript/elvarg/game/model/container/impl/Equipment");
const { Item } = require("../../../../src/main/typescript/elvarg/game/model/Item");
const { Flag } = require("../../../../src/main/typescript/elvarg/game/model/Flag");
const { Skill } = require("../../../../src/main/typescript/elvarg/game/model/Skill");
const WorldDefinition = require("../../../../src/main/typescript/elvarg/game/definition/WorldDefinition");
const { CacheDefinitions } = require("../../../../src/main/typescript/elvarg/game/cache/CacheDefinitions");
const Woodcutting = require("../../../skills/Woodcutting.plugin");
const Mining = require("../../../skills/Mining.plugin");
const { WANT_COOLDOWN_MS, banked, carried, earnsOwnItems, keeping, ownItemsFor, purse, worn } = require("../OwnItems.PlayerBots");

/** Free worlds: a members tool is no tool there (as Woodcutting and Mining refuse it), so bots don't wield one. */
function usableOnWorld(tool) {
  return WorldDefinition.isMembersWorld() || CacheDefinitions.getItem(tool.id)?.isMembers !== true;
}

const TOOL_RESOLVERS = {
  axe(player) {
    const level = player.getSkillManager().getCurrentLevel(Skill.WOODCUTTING);
    return Woodcutting.findBestUsableAxeByLevel(level, usableOnWorld)?.id ?? null;
  },
  pickaxe(player) {
    const level = player.getSkillManager().getCurrentLevel(Skill.MINING);
    const pickaxe = (Mining.PICKAXES_DESC ?? []).find(
      // Only the standard pickaxes, as for axes: not the league's Echo pickaxe or a crystal one that needs Agility.
      (entry) => entry.standard && level >= entry.requiredLevel && usableOnWorld(entry)
    );
    return pickaxe?.id ?? null;
  },
};

/**
 * Ours: every standard tool of a kind this player's level can use on this world, best first.
 * A bot that owns what it uses (brain/OwnItems) picks from these the best one it has.
 */
const TOOL_LISTS = {
  axe(player) {
    const level = player.getSkillManager().getCurrentLevel(Skill.WOODCUTTING);
    return (Woodcutting.AXES_BEST_FIRST ?? [])
      .filter((axe) => axe.standard && level >= axe.requiredLevel && usableOnWorld(axe)).map((axe) => axe.id);
  },
  pickaxe(player) {
    const level = player.getSkillManager().getCurrentLevel(Skill.MINING);
    return (Mining.PICKAXES_DESC ?? [])
      .filter((entry) => entry.standard && level >= entry.requiredLevel && usableOnWorld(entry)).map((entry) => entry.id);
  },
};
// A better tool that could not be bought (sold out, no way there) is not tried again for this long.
const SHOP_AGAIN_MS = 15 * 60 * 1000;

/**
 * Ours: the tool step of a bot that owns what it uses. It works with the best tool it has (in
 * its backpack, in its hand or in its bank), buys a better one when its level and its coins
 * allow, and with none at all it fails: the activity is off until it can pay for one.
 * `spec.tidy === false` (a step inside another, as Cook's log for a fire) never goes to the bank
 * to empty the backpack.
 */
function ownToolStep(spec, world) {
  const listTools = TOOL_LISTS[spec.tool];
  const states = new WeakMap();
  const stateFor = (player) => {
    let state = states.get(player);
    if (!state) states.set(player, (state = { buying: null, shopAfter: 0 }));
    return state;
  };
  return function update(ctx) {
    const { player, nowMs } = ctx;
    const own = ownItemsFor(world ?? ctx.world);
    const bot = stateFor(player);
    const tools = listTools(player);
    const has = (id) => carried(player, id) > 0 || worn(player, id);
    const ownedAt = tools.findIndex((id) => has(id) || banked(player, id) > 0);
    // Its best axe goes everywhere with it: a fire for its fish needs a log.
    const bestAxe = spec.tool === "axe" ? null : TOOL_LISTS.axe(player).find((id) => carried(player, id) > 0);
    // A step inside another keeps its hands off the rest of the backpack (the fish to be cooked).
    const keep = spec.tidy === false ? null : keeping(ownedAt >= 0 ? tools[ownedAt] : [], bot.buying ?? [], bestAxe ?? []);
    if (bot.buying === null && nowMs >= bot.shopAfter) {
      // The best tool above its own that a shop sells and it can pay for; failing that, the
      // cheapest of them is what it saves for.
      let saveFor = null;
      for (const id of ownedAt < 0 ? tools : tools.slice(0, ownedAt)) {
        const offer = own.offer(id);
        if (!offer) continue;
        if (purse(player) >= offer.price) {
          bot.buying = id;
          break;
        }
        saveFor = { id, price: offer.price };
      }
      if (bot.buying === null && saveFor) own.wish(ctx.state, saveFor.id, saveFor.price, nowMs);
    }
    if (bot.buying !== null) {
      const result = own.fetch(ctx, { itemId: bot.buying, worn: true, keep, optional: ownedAt >= 0 });
      if (result === "running") return "running";
      bot.buying = null;
      if (result === "success") return "success";
      bot.shopAfter = nowMs + SHOP_AGAIN_MS;
    }
    if (ownedAt < 0) {
      if (ctx.frame) ctx.frame.cooldownMs = Math.max(ctx.frame.cooldownMs ?? 0, WANT_COOLDOWN_MS);
      return "failed";
    }
    const result = own.fetch(ctx, { itemId: tools[ownedAt], worn: true, buy: false, keep });
    if (result !== "success" || spec.tidy === false) return result;
    return own.tidy(ctx, keep);
  };
}

function createEquipToolAction(spec, world = null) {
  const resolveTool = TOOL_RESOLVERS[spec.tool];
  if (!resolveTool) {
    throw new Error(`[bot activities] unknown tool '${spec.tool}'`);
  }
  const ownTool = ownToolStep(spec, world);
  return {
    id: "equipTool",
    update(ctx) {
      const player = ctx.player;
      // Ours: a bot that owns what it uses is handed nothing.
      if (earnsOwnItems(player)) return ownTool(ctx);
      const equipment = player.getEquipment();
      const toolId = resolveTool(player);
      if (!toolId) {
        return "failed";
      }
      const equipped = equipment.getItems()[Equipment.WEAPON_SLOT];
      if (equipped && equipped.getId() === toolId) {
        return "success";
      }
      equipment.set(Equipment.WEAPON_SLOT, new Item(toolId, 1));
      equipment.refreshItems();
      player.getUpdateFlag().flag(Flag.APPEARANCE);
      return "success";
    },
    stop(ctx) {
      if (earnsOwnItems(ctx?.player)) ownItemsFor(world ?? ctx.world).stop(ctx);
    },
  };
}

module.exports = {
  createEquipToolAction,
};
