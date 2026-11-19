"use strict";

/**
 * Ours: the wasp swarms at Bea's farm (The Birds and the Wasps, 11 November 2026), from the OSRS Wiki (Swarm of wasps,
 * Swarm of killer wasps, Insect repellent, Transcript:The Birds and the Wasps) and the cache.
 *
 * - Each of the six swarms is a multi NPC on its own varbit (baw_wasp_<n>_state, baw_killer_wasp_<n>_state): 0 hidden,
 *   1 the swarm with Catch, 2 the furious swarm with Spray, 3 hidden. The varbits are each player's, so a swarm a
 *   player enraged is furious for that player only. The wasps show from Bea's "Catch 50 o' the blighters" (stage 25)
 *   on; the killer wasps once the quest is done (Wiki: "can catch after completion").
 * - Catch, with an insect net wielded and a beekeeper's or bee hunter's hat worn, catches a sting every game tick,
 *   1 and 2 Hunter XP in turn (killer wasps, level 12: 2 and 3). The refusals are the transcript's boxes.
 * - "After some time hunting a swarm": "The wasps become enraged with you!" and the swarm turns furious; insect repellent
 *   (Spray, or the repellent used on it) calms it again, and the repellent is kept (as on beehives).
 *
 * Not documented, so ours: the chance of enraging (1 in 20 catches), the animations (the butterfly net's swing, as
 * Catching swings it for butterflies; human_use_insect_repellant for the spray), no damage for the hatless sting (the
 * transcript's box says nothing of one) and catching stopping when the swarm wanders out of reach.
 */
const C = require("./Context.Hunter");
const { H, ANIM, level, nearby, active, exchange, xp, begin, questComplete, questStage } = C;

const QUEST = "the_birds_and_the_wasps";
/** baw at Bea's "Grab some kit outta me box 'ere" (BirdsAndTheWasps.Quest.js). */
const WASPS_STAGE = 25;
const HIDDEN = 0, CALM = 1, FURIOUS = 2;
const ENRAGE_CHANCE = 1 / 20;
const REPELLENT_ANIMATION = "human_use_insect_repellant";

/** player -> varbits of the swarms that are furious for them. */
const furious = new Map();
/** player -> catches so far, for the alternating XP. */
const catches = new Map();

function kindOf(npcId) {
  return H.data.wasps.find(kind => kind.npc === npcId || kind.furious === npcId);
}

function swarmOf(npc) {
  for (const kind of H.data.wasps) {
    const swarm = kind.swarms.find(s => s.npc === npc?.getId?.());
    if (swarm) return { kind, swarm };
  }
  return null;
}

function shows(player, kind) {
  return kind.key === "wasp" ? questStage(player, QUEST) >= WASPS_STAGE || questComplete(player, QUEST) : questComplete(player, QUEST);
}

/** Every swarm's varbit as this player should see it. */
function sync(player) {
  if (!H.data || !player?.getPacketSender || player.isPlayerBot?.() === true) return;
  const angry = furious.get(player);
  for (const kind of H.data.wasps) {
    const visible = shows(player, kind);
    for (const swarm of kind.swarms) {
      player.getPacketSender().sendVarbit(swarm.varbit, !visible ? HIDDEN : angry?.has(swarm.varbit) ? FURIOUS : CALM);
    }
  }
}

function setFurious(player, swarm, on) {
  let angry = furious.get(player);
  if (!angry) furious.set(player, angry = new Set());
  if (on) angry.add(swarm.varbit);
  else angry.delete(swarm.varbit);
  player.getPacketSender().sendVarbit(swarm.varbit, on ? FURIOUS : CALM);
}

function box(player, text, itemId) {
  const { DialogueChainBuilder, StatementDialogue, ItemStatementDialogue } = H.core;
  const entry = itemId === undefined ? new StatementDialogue(0, text) : new ItemStatementDialogue(0, itemId, text);
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(entry));
}

function worn(player, slot) {
  return player.getEquipment().get(slot)?.getId?.() ?? -1;
}

function netWielded(player) {
  const I = H.core.ItemIdentifiers;
  return [I.INSECT_NET, I.MAGIC_INSECT_NET].includes(worn(player, H.core.Equipment.WEAPON_SLOT));
}

function hatWorn(player) {
  const I = H.core.ItemIdentifiers;
  return [I.BEEKEEPERS_HAT, I.BEE_HUNTERS_HAT].includes(worn(player, H.core.Equipment.HEAD_SLOT));
}

/** Catch on a swarm (any NPC option named Catch reaches here first through Runtime.catchNpc). */
function catchSwarm({ player, npc, npcId }) {
  const found = swarmOf(npc);
  if (!found || found.kind.npc !== npcId) return false;
  if (!active(player) || !nearby(player, npc)) return true;
  // The transcript's order: the net, the hat, then room for the stings.
  if (!netWielded(player)) { box(player, "You need to be holding an insect net to catch these wasps."); return true; }
  if (!hatWorn(player)) { box(player, "The wasps sting you in the face. Some sort of protective hat is probably in order."); return true; }
  if (level(player) < found.kind.level) { player.sendMessage(`You need a Hunter level of at least ${found.kind.level} to catch these wasps.`); return true; }
  if (!exchange(player, [], [[found.kind.sting, 1]], false)) { box(player, "You need more inventory space to catch these wasps."); return true; }
  keepCatching(player, npc, found);
  return true;
}

function keepCatching(player, npc, { kind, swarm }) {
  const swing = worn(player, H.core.Equipment.WEAPON_SLOT) === H.core.ItemIdentifiers.MAGIC_INSECT_NET ? ANIM.NET : ANIM.BUTTERFLY;
  begin(player, 1, swing, () => {
    if (!active(player) || !npc.isRegistered() || !nearby(player, npc) || !netWielded(player) || !hatWorn(player)
      || player.getPacketSender().getVarbit(swarm.varbit) !== CALM) return;
    if (!exchange(player, [], [[kind.sting, 1]])) { box(player, "You need more inventory space to catch these wasps."); return; }
    const count = (catches.get(player) ?? 0) + 1;
    catches.set(player, count);
    xp(player, kind.xp[(count - 1) % kind.xp.length], "wasps", kind.npc);
    // A chatbox opened by the catch (the quest's "Looks like I've caught enough.") ends the catching.
    if (player.getDialogueManager().isActive()) return;
    if (Math.random() < ENRAGE_CHANCE) {
      setFurious(player, swarm, true);
      box(player, "The wasps become enraged with you!");
      return;
    }
    keepCatching(player, npc, { kind, swarm });
  }, undefined, { reset: false });
}

/** Spray on a furious swarm, or insect repellent used on it. */
function spray({ player, npc, npcId }) {
  const found = swarmOf(npc);
  if (!found || found.kind.furious !== npcId) return false;
  if (!active(player) || !nearby(player, npc)) return true;
  if (!player.getInventory().contains(H.core.ItemIdentifiers.INSECT_REPELLENT)) {
    box(player, "You need to have some insect repellent to spray these wasps.");
    return true;
  }
  const animation = H.core.CacheDefinitions.getSeqId(REPELLENT_ANIMATION);
  if (animation !== null) player.performAnimation(new H.core.Animation(animation));
  setFurious(player, found.swarm, false);
  box(player, "You calm the wasps down a bit by spraying them with insect repellent.", H.core.ItemIdentifiers.INSECT_REPELLENT);
  return true;
}

function useRepellent(event) {
  if (event.itemId !== H.core.ItemIdentifiers.INSECT_REPELLENT) return;
  const npc = event.npc ?? event.target;
  if (spray({ player: event.player, npc, npcId: event.npcId ?? npc?.getContentId?.(event.player) })) event.handled = true;
}

function stageChanged({ player, key }) {
  if (key === QUEST) sync(player);
}

function login({ player }) {
  furious.delete(player);
  sync(player);
}

function cleanup({ player }) {
  furious.delete(player);
  catches.delete(player);
}

module.exports = { catchSwarm, spray, useRepellent, sync, stageChanged, login, cleanup, CALM, FURIOUS, HIDDEN };
