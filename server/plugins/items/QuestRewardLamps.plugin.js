/**
 * The antique lamps the 3 November 2026 update added to free-to-play quests (Wiki: Update:Quest
 * Month Kick Off, TFA Tweaks & More; each lamp's own page). Rub: choose a skill on the shared
 * xpreward interface (plugins/interface/XpReward.plugin.js) and gain the lamp's experience.
 *
 *   34755 Shield of Arrav, 34750 Ernest the Chicken, 34754 Romeo & Juliet: 500 XP, any skill
 *   34748 Black Knights' Fortress, 34749 Demon Slayer: 1,000 XP in a combat skill or Prayer
 *
 * The quests hand them out ("quest-lamps:give" { player, lamp, count }). No recording rubs one; the
 * line is the Ides of Milk lamp's recorded "Your wish has been granted!" form (rsprox 238/239).
 * A lamp that paid its experience is announced ("quest-lamps:rubbed" { player, lamp }).
 *
 * Ours (upstream issue #5610): the lamps from the quest's own NPC. The lamps cannot be banked,
 * and each lamp's page says it "can be destroyed and reclaimed from" its NPC "whenever the player
 * wishes"; the update's news post sends players who finished these quests before it to the same
 * NPCs. What the game keeps is how many of a quest's lamps the character has used (the cache's
 * varbits soa_lamp_used, ernest_chicken_lamp_used, randj_lamp_used, bkf_lamps and
 * demon_slayer_lamps), so here too: the NPC has the quest's lamps, less those used and those
 * carried, and a quest's lamps pay no more times than the quest has lamps, however a character
 * comes to hold more of them. The count is saved with the character. The NPCs' lines are the
 * Wiki's (Transcript:Romeo, King Roald, Veronica, Sir Amik Varze, Aris).
 */
const QuestRuntime = require("../quests/QuestRuntime");
const OwedExperience = require("../quests/OwedExperience.plugin");

const LAMP_IDS = Object.freeze({
  BLACK_KNIGHTS_FORTRESS: 34748,
  DEMON_SLAYER: 34749,
  ERNEST_THE_CHICKEN: 34750,
  ROMEO_AND_JULIET: 34754,
  SHIELD_OF_ARRAV: 34755,
});

/**
 * Each quest's lamps: how many, the saved count of those used, and the cache varbit that says a
 * single lamp was used (sent to the client as the game does; what the two three-bit ones count is
 * in no recording, so they are not sent). `afterwards`: never handed over at completion.
 */
const QUEST_LAMPS = Object.freeze({
  SHIELD_OF_ARRAV: { quest: "shield_of_arrav", count: 1, used: "quest-lamps:soa_lamp_used", varbit: "soa_lamp_used" },
  ERNEST_THE_CHICKEN: { quest: "ernest_the_chicken", count: 1, used: "quest-lamps:ernest_chicken_lamp_used", varbit: "ernest_chicken_lamp_used" },
  ROMEO_AND_JULIET: { quest: "romeo_and_juliet", count: 1, used: "quest-lamps:randj_lamp_used", varbit: "randj_lamp_used" },
  BLACK_KNIGHTS_FORTRESS: { quest: "black_knights_fortress", count: 2, used: "quest-lamps:bkf_lamps" },
  DEMON_SLAYER: { quest: "demon_slayer", count: 2, used: "demon-slayer:lamps-rubbed", afterwards: true },
});

/** Aris' legacy cache id 5082 has no generated NpcIdentifiers member. */
const ARIS_LEGACY_NPC_ID = 5082;
/**
 * Who has each quest's lamps (the ids each quest plugin talks to), what they say before handing
 * them over and what is said after: the Wiki transcripts' claim sections, word for word.
 */
const GIVERS = Object.freeze([
  { lamp: "DEMON_SLAYER", npcs: ["ARIS", ARIS_LEGACY_NPC_ID],
    before: "I have a little something here for you, young one. Consider it a gift for slaying that demon.",
    after: [{ player: ["How do you know I killed it?"] }, { npc: ["You forget. I'm good at knowing things."] }] },
  { lamp: "ROMEO_AND_JULIET", npcs: ["ROMEO"],
    before: "I heard Juliet had died. Terrible business. Her cousin and I are getting on well though. Here, take this as thanks for your help.",
    after: [] },
  { lamp: "SHIELD_OF_ARRAV", npcs: ["KING_ROALD", "KING_ROALD_3", "KING_ROALD_5", "KING_ROALD_6", "KING_ROALD_7"],
    before: "Here, citizen. I have this lamp for you.",
    after: [{ player: ["Thanks!"] }] },
  { lamp: "ERNEST_THE_CHICKEN", npcs: ["VERONICA"],
    before: "Thank you for rescuing Ernest. He left this lamp for you.",
    after: [{ player: ["Thanks!"] }] },
  { lamp: "BLACK_KNIGHTS_FORTRESS", npcs: ["SIR_AMIK_VARZE_4"],
    before: "I have a reward here for you, friend.",
    after: [{ player: ["Thanks!"] }] },
]);
// Ours: neither is in a transcript.
const NO_ROOM_MESSAGE = "You need a free inventory slot to take the lamp.";
const SPENT_MESSAGE = "You have already used the lamps from this quest, so this one is taken away.";

let core;
let pluginApi;
let LAMPS;
/** NPC id -> its GIVERS entry. */
let giverByNpc = new Map();
const pending = new WeakMap();

function initialize(coreApi) {
  core = coreApi;
  const { Skill } = core;
  const combat = [Skill.ATTACK, Skill.STRENGTH, Skill.DEFENCE, Skill.RANGED, Skill.MAGIC, Skill.HITPOINTS, Skill.PRAYER];
  LAMPS = new Map([
    [LAMP_IDS.SHIELD_OF_ARRAV, { xp: 500 }],
    [LAMP_IDS.ERNEST_THE_CHICKEN, { xp: 500 }],
    [LAMP_IDS.ROMEO_AND_JULIET, { xp: 500 }],
    [LAMP_IDS.BLACK_KNIGHTS_FORTRESS, { xp: 1000, skills: combat }],
    [LAMP_IDS.DEMON_SLAYER, { xp: 1000, skills: combat }],
  ]);
  giverByNpc = new Map();
  for (const giver of GIVERS) {
    for (const npc of giver.npcs) {
      const id = typeof npc === "number" ? npc : core.NpcIdentifiers?.[npc];
      if (Number.isInteger(id)) giverByNpc.set(id, giver);
    }
  }
}

const lampKey = (itemId) => Object.keys(LAMP_IDS).find((key) => LAMP_IDS[key] === itemId);

/** How many of the quest's lamps the character has used. */
function lampsUsed(player, lamp) {
  return Math.max(0, Number(player.getAttribute?.(QUEST_LAMPS[lamp].used)) || 0);
}

/** The cache's own "lamp used" varbit, for the quests that have one. */
function sendUsed(player, lamp) {
  const name = QUEST_LAMPS[lamp].varbit;
  const id = name ? core?.CacheDefinitions?.getVarbitId?.(name) : null;
  if (Number.isInteger(id)) player.getPacketSender?.()?.sendVarbit?.(id, lampsUsed(player, lamp) > 0 ? 1 : 0);
}

function sendAllUsed({ player }) {
  for (const lamp of Object.keys(QUEST_LAMPS)) sendUsed(player, lamp);
}

/**
 * Lamps the quest's NPC still has for the player: the quest's lamps, less those used and those
 * carried. None before the quest is done, nor for a completion without experience. A character
 * who finished one of the four quests that hand their lamps over at completion before their use
 * was counted had them then, and is taken to have used them: only a character older than the
 * lamps in our code (OwedExperience, REWARDS_IN_OUR_CODE_SINCE) or one who finished since has
 * any with the NPC.
 */
function lampsOwed(player, lamp) {
  const ledger = QUEST_LAMPS[lamp];
  const quest = QuestRuntime.getRegisteredQuests().find((entry) => entry.key === ledger.quest);
  if (!quest || !quest.isComplete(player) || quest.experienceWithheld(player)) return 0;
  if (!ledger.afterwards && !OwedExperience.newRewardPaid(player, ledger.quest) && !OwedExperience.predatesNewRewards(player)) return 0;
  return Math.max(0, ledger.count - lampsUsed(player, lamp) - player.getInventory().getAmount(LAMP_IDS[lamp]));
}

/** Into free inventory slots only: what does not fit stays with the NPC. Returns how many were handed over. */
function handOver(player, lamp) {
  const count = Math.min(lampsOwed(player, lamp), player.getInventory().getFreeSlots());
  if (count < 1) {
    player.sendMessage(NO_ROOM_MESSAGE);
    return 0;
  }
  give({ player, lamp, count });
  return count;
}

/** Talk-to on a quest's NPC who has lamps for the player. */
function claimFromGiver(event) {
  const { player, npcId } = event;
  const giver = giverByNpc.get(npcId);
  if (!giver) return false;
  const option = String(event.definition?.getActions?.()?.[event.clickType - 1] ?? "").toLowerCase();
  if (option !== "talk-to" || lampsOwed(player, giver.lamp) < 1) return false;
  // No room: the usual conversation, so a full pack never stands between the player and the NPC.
  if (player.getInventory().getFreeSlots() < 1) {
    player.sendMessage(NO_ROOM_MESSAGE);
    return false;
  }
  event.handled = true;
  QuestRuntime.startDialogue(pluginApi, player, { npcId }, [
    { npc: [giver.before] },
    { exec: () => {
      handOver(player, giver.lamp);
      if (!giver.after.length) player.getPacketSender().sendInterfaceRemoval();
    } },
    ...giver.after,
  ]);
  return true;
}

function rub({ player, item, itemId, slot }) {
  const lamp = LAMPS?.get(itemId);
  if (!lamp) return false;
  if (player.getInventory().get(slot) !== item) return true;
  const request = { item, slot, lamp };
  pending.set(player, request);
  pluginApi.emitCustomEvent("xpreward:open", {
    player, skills: lamp.skills, onConfirm: (skill, name) => grant(player, request, skill, name),
  });
  return true;
}

/** The message box text, or null when the lamp is kept. */
function grant(player, request, skill, name = skill.getName()) {
  if (pending.get(player) !== request) return null;
  pending.delete(player);
  if (request.lamp.skills && !request.lamp.skills.includes(skill)) return null;
  const inventory = player.getInventory();
  if (inventory.get(request.slot) !== request.item) return null;
  const lamp = lampKey(request.item.getId());
  const ledger = QUEST_LAMPS[lamp];
  // A quest's lamps pay once each: a lamp beyond them (one more had from the NPC while another
  // lay on the floor or in a grave) is spent already.
  if (lampsUsed(player, lamp) >= ledger.count) {
    inventory.deleteAtSlot(request.slot, 1);
    player.sendMessage(SPENT_MESSAGE);
    return null;
  }
  const manager = player.getSkillManager();
  const before = manager.getExperience(skill);
  manager.addExperience(skill, request.lamp.xp, true);
  if (manager.getExperience(skill) === before) {
    player.sendMessage("You cannot gain experience in that skill right now.");
    return null;
  }
  inventory.deleteAtSlot(request.slot, 1);
  player.setAttribute?.(ledger.used, lampsUsed(player, lamp) + 1);
  sendUsed(player, lamp);
  pluginApi.emitCustomEvent("quest-lamps:rubbed", { player, lamp });
  return `<col=0000ff>Your wish has been granted!</col> You have been awarded ${request.lamp.xp.toLocaleString("en-GB")} ${name} experience!`;
}

/** "quest-lamps:give" { player, lamp (a LAMP_IDS key), count }: what fits goes in the pack, the rest to the floor. */
function give(event) {
  const id = LAMP_IDS[event?.lamp];
  if (!event?.player || id === undefined) return;
  event.player.getInventory().forceAdd(event.player, new core.Item(id, Math.max(1, event.count | 0)));
  event.given = true;
}

module.exports = {
  name: "QuestRewardLamps",
  description: "The antique lamps from Shield of Arrav, Ernest the Chicken, Romeo & Juliet, Black Knights' Fortress and Demon Slayer: rub for their experience, and have them from the quest's NPC until used.",
  LAMP_IDS,
  QUEST_LAMPS,
  register(api) {
    pluginApi = api;
    api.onServerStartup(initialize.bind(null, api.core));
    api.onItemAction("Antique lamp", { Rub: rub });
    api.onCustomEvent("quest-lamps:give", give);
    for (const { used } of Object.values(QUEST_LAMPS)) api.persistAttribute(used, 0);
    api.onBeforeNpcInteraction(claimFromGiver);
    api.onCustomEvent("player:bootstrap-complete", sendAllUsed);
  },
  _test: { rub, grant, give, initialize, lampsOwed, lampsUsed, handOver },
};
