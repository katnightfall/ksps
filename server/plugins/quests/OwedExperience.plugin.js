/**
 * Experience owed for quests finished before they paid any. Ours (upstream issue #5610).
 *
 * The 3 November 2026 update added experience to thirteen quests that had none (Wiki:
 * Update:Quest Month Kick Off, TFA Tweaks & More, "Quest XP Rewards"; each quest's Rewards and
 * Changes) and lamps to five more. "If you have already completed the quests ... you can claim
 * these additional XP rewards through Perdu or the Lumbridge Guide. Likewise, the XP lamps can be
 * claimed from the relevant NPCs giving the quests" (the lamps: plugins/items/QuestRewardLamps).
 *
 * Who is owed. A character is owed a quest's experience when the quest is complete, was not
 * completed for it without experience (a league's quest pack), is not on the character's saved
 * list of quests whose new reward it has had (NEW_REWARD_PAID_ATTRIBUTE), and the character is
 * older than these rewards in our code (REWARDS_IN_OUR_CODE_SINCE). A quest goes on the list when
 * it pays its reward at completion and when the experience is claimed, so it is paid once.
 *
 * The words are Transcript:Perdu's and Transcript:Lumbridge Guide's ("Claiming owed experience").
 * Perdu's are in the dialogue data, whose two conditions and two steps are answered here; the
 * data's Lumbridge Guide page is older than the update, so his are spoken from here, before his
 * usual conversation. Lines of ours, in neither transcript, are marked "Ours".
 */
const QuestRuntime = require("./QuestRuntime");

/**
 * Quest key -> what the update added, [Skill member, amount, the Wiki's name for the skill]. None
 * of these quests gave experience before, so the whole of it is owed.
 */
const ADDED_EXPERIENCE = Object.freeze({
  prince_ali_rescue: [["SMITHING", 500], ["CRAFTING", 500]],
  pirates_treasure: [["COOKING", 800]],
  rune_mysteries: [["RUNECRAFTING", 500]],
  the_corsair_curse: [["FIREMAKING", 1200]],
  below_ice_mountain: [["MINING", 1200]],
  clock_tower: [["FIREMAKING", 1000]],
  family_crest: [["MINING", 2000], ["SMITHING", 2000], ["CRAFTING", 2000]],
  lost_city: [["WOODCUTTING", 1500], ["CRAFTING", 1500]],
  merlins_crystal: [["FIREMAKING", 1000]],
  sheep_herder: [["HUNTER", 1000]],
  tale_of_the_righteous: [["MINING", 1500]],
  throne_of_miscellania: [["WOODCUTTING", 1000], ["MINING", 1000], ["FISHING", 1000], ["FARMING", 1000]],
  troll_stronghold: [["AGILITY", 2000]],
});

/** The four quests that hand their lamps over at completion (Demon Slayer's come from Aris afterwards). */
const LAMPS_AT_COMPLETION = Object.freeze(["romeo_and_juliet", "shield_of_arrav", "ernest_the_chicken", "black_knights_fortress"]);

/**
 * The skills in the order of the transcript's list ("800 Cooking XP. 4,000 Crafting XP. 3,200
 * Firemaking XP. 1,000 Fishing XP. 5,700 Mining XP. 500 Runecraft XP. 2,500 Smithing XP. 2,500
 * Woodcutting XP. 2,000 Agility XP. 1,000 Farming XP. 1,000 Hunter XP. ": every one of the
 * thirteen quests owed), with the names it gives them.
 */
const LISTED = Object.freeze([
  ["COOKING", "Cooking"], ["CRAFTING", "Crafting"], ["FIREMAKING", "Firemaking"], ["FISHING", "Fishing"],
  ["MINING", "Mining"], ["RUNECRAFTING", "Runecraft"], ["SMITHING", "Smithing"], ["WOODCUTTING", "Woodcutting"],
  ["AGILITY", "Agility"], ["FARMING", "Farming"], ["HUNTER", "Hunter"],
]);

/** Saved with the character, as quest stages are: the keys of the quests whose 3 November 2026 reward it has had. */
const NEW_REWARD_PAID_ATTRIBUTE = "quest.new-reward-paid";

/**
 * Our copy of the server began as a clone of the original project made at this moment (git reflog
 * of main: "clone: from https://github.com/RSPSApp/tsps", 2026-11-14 23:26:21 -06:00, at b240d68ae),
 * and that code already paid every one of these rewards at completion (they entered the original
 * between 7 and 15 November; the last, The Corsair Curse's, at 04:24 UTC that day). A character
 * created from then on can only have finished these quests on code that paid them, and the save
 * holds no date for a quest, only for the character: so such a character is owed nothing, and
 * only an older one (a save brought from an earlier server) can claim.
 */
const REWARDS_IN_OUR_CODE_SINCE = Date.parse("2026-11-15T05:26:21Z");

const XP_LOCKED_ATTRIBUTE = "skills:xp-locked";

const PERDU_PAGE = "Perdu";
/** Transcript:Perdu's steps in the dialogue data. */
const PERDU = Object.freeze({
  OWED: { id: "CNUDd3", text: "If the player has experience to claim:" },
  NOT_OWED: { id: "kvok22", text: "If the player does not have experience to claim:" },
  LIST: "sEipjh",
  RECEIVE: "LeCmMv",
});
const GUIDE_NAME = "Lumbridge Guide";
const LINE = Object.freeze({
  OFFER: "It seems you're missing out on some valuable experience. Would you like it?",
  PROMPT: "Claim your owed XP?",
  YES: "Yes please.",
  NO: "No thanks.",
  PAID: "There you go.",
  DECLINED: "Fair enough.",
  // Ours: said in the chat when nothing, or not all of it, can be given.
  LOCKED: "Unlock experience with ::lockxp before claiming your owed experience.",
  BLOCKED: "You can't gain that experience right now.",
  PARTLY: "Some of your owed experience can't be given right now. Ask again later.",
});
/** The Guide's greeting, which the transcript skips after the claim ("goes straight to 'select an option'"). */
const GUIDE_GREETING = /Is there anything I can help you with\?$/;

let pluginApi;
let core;
/** Players Perdu has offered their experience in the conversation under way: his usual greeting is not said after it. */
const offered = new WeakSet();
/** Players whose Talk-to on the Guide is being passed on to his usual conversation. */
const passingOn = new WeakSet();

// ---------------------------------------------------------------------------- the record

function paidKeys(player) {
  const keys = player.getAttribute?.(NEW_REWARD_PAID_ATTRIBUTE);
  return Array.isArray(keys) ? keys : [];
}

/** Whether the quest's new reward is on the character's list: paid at completion, or claimed. */
function newRewardPaid(player, key) {
  return paidKeys(player).includes(key);
}

function recordNewRewardPaid(player, key) {
  const keys = paidKeys(player);
  if (!keys.includes(key)) player.setAttribute(NEW_REWARD_PAID_ATTRIBUTE, [...keys, key]);
}

/** Whether the character is older than these rewards in our code. One with no date is not. */
function predatesNewRewards(player) {
  const created = player.getCreationDate?.()?.getTime?.();
  return Number.isFinite(created) && created > 0 && created < REWARDS_IN_OUR_CODE_SINCE;
}

/** "quest:completed": a quest that has just paid its new reward will never owe it. */
function recordCompletion({ player, key, options }) {
  if (!player || options?.experience === false) return;
  if (Object.hasOwn(ADDED_EXPERIENCE, key) || LAMPS_AT_COMPLETION.includes(key)) recordNewRewardPaid(player, key);
}

// ---------------------------------------------------------------------------- what is owed

function questFor(key) {
  return QuestRuntime.getRegisteredQuests().find((quest) => quest.key === key);
}

/** The quests whose experience the character is owed: [{ key, experience: [[Skill, amount]] }]. */
function owedQuests(player) {
  if (!player || !predatesNewRewards(player)) return [];
  const owed = [];
  for (const [key, added] of Object.entries(ADDED_EXPERIENCE)) {
    if (newRewardPaid(player, key)) continue;
    const quest = questFor(key);
    if (!quest || !quest.isComplete(player) || quest.experienceWithheld(player)) continue;
    owed.push({ key, experience: added.map(([skill, amount]) => [core.Skill[skill], amount]) });
  }
  return owed;
}

/** "You are owed the following: 800 Cooking XP. 4,000 Crafting XP. " as the transcript lists it, a total for each skill. */
function owedText(player) {
  const totals = new Map();
  for (const { experience } of owedQuests(player)) {
    for (const [skill, amount] of experience) totals.set(skill, (totals.get(skill) ?? 0) + amount);
  }
  const parts = LISTED.filter(([skill]) => totals.has(core.Skill[skill]))
    .map(([skill, name]) => `${totals.get(core.Skill[skill]).toLocaleString("en-US")} ${name} XP. `);
  return `You are owed the following: ${parts.join("")}`;
}

/**
 * Pays what is owed, a quest at a time, each exactly as the quest pays it at completion
 * (addExperiences: the world's rate and the character's own apply, as to every quest reward).
 * A quest is put on the list before its experience is added, so nothing that happens after can
 * leave it to be claimed again; one whose experience the character cannot gain now stays owed.
 * Returns { paid, left }: the quests paid and those still owed.
 */
function claim(player) {
  const owed = owedQuests(player);
  if (!owed.length) return { paid: [], left: [] };
  if (player.getAttribute(XP_LOCKED_ATTRIBUTE) === true) {
    player.sendMessage(LINE.LOCKED);
    return { paid: [], left: owed.map(({ key }) => key) };
  }
  const paid = [];
  const left = [];
  const skills = player.getSkillManager();
  for (const { key, experience } of owed) {
    if (experience.some(([skill, amount]) => core.PluginManager.emitCanGainExperience(player, skill, amount).allow === false)) {
      left.push(key);
      continue;
    }
    recordNewRewardPaid(player, key);
    for (const [skill, amount] of experience) skills.addExperiences(skill, amount);
    paid.push(key);
  }
  if (left.length) player.sendMessage(paid.length ? LINE.PARTLY : LINE.BLOCKED);
  return { paid, left };
}

// ---------------------------------------------------------------------------- Perdu

function onPerduPage(event) {
  return event.pages?.some(({ page }) => page === PERDU_PAGE) === true;
}

const isStep = (event, step) => event.stepId === step.id || event.text === step.text;

/** The two greetings of Transcript:Perdu. After the offer, taken or not, he goes straight to his menu. */
function answerPerduCondition(event) {
  if (!onPerduPage(event)) return null;
  if (isStep(event, PERDU.OWED)) {
    const owes = owedQuests(event.player).length > 0;
    if (owes) offered.add(event.player);
    else offered.delete(event.player);
    return owes;
  }
  if (isStep(event, PERDU.NOT_OWED)) return !offered.has(event.player);
  return null;
}

function perduStep(event) {
  if (!onPerduPage(event)) return;
  if (event.kind === "message" && event.stepId === PERDU.LIST) {
    event.text = owedText(event.player);
    event.box = { statement: true };
    event.handled = true;
    return;
  }
  if (event.kind === undefined && event.stepId === PERDU.RECEIVE) {
    event.handled = true;
    // Nothing given: he does not say "There you go."
    if (!claim(event.player).paid.length) event.end = true;
  }
}

// ---------------------------------------------------------------------------- the Lumbridge Guide

/** Chat entries in order (each made from its index), then `then`. */
function say(player, entries, then) {
  const chain = new core.DialogueChainBuilder();
  entries.forEach((entry, index) => chain.add(entry(index)));
  chain.add(new core.ActionDialogue(entries.length, { execute: then }));
  player.getDialogueManager().startDialogues(chain);
}

/** His usual conversation, by the Talk-to it would have had, without his greeting. */
function guideCarriesOn(event) {
  const { player } = event;
  const manager = player.getDialogueManager();
  const current = manager.getCurrent();
  passingOn.add(player);
  try {
    core.PluginManager.emitNpcInteraction({ ...event, handled: false });
  } finally {
    passingOn.delete(player);
  }
  // Nothing more to say: the last line's chatbox closes.
  if (manager.getCurrent() === current) player.getPacketSender().sendInterfaceRemoval();
}

function skipGuideGreeting(request) {
  if (!passingOn.has(request.player) || typeof request.step?.npc !== "string") return;
  if (request.pages?.some(({ page }) => page === GUIDE_NAME) && GUIDE_GREETING.test(request.step.npc)) request.skip = true;
}

function guideAnswer(event, accepted) {
  const { player, npcId } = event;
  say(player, [(index) => new core.PlayerDialogue(index, accepted ? LINE.YES : LINE.NO)], () => {
    // Nothing given: he does not say "There you go."
    if (accepted && !claim(player).paid.length) return player.getPacketSender().sendInterfaceRemoval();
    say(player, [(index) => new core.NpcDialogue(index, npcId, accepted ? LINE.PAID : LINE.DECLINED)], () => guideCarriesOn(event));
  });
}

/** Talk-to on the Lumbridge Guide with experience owed: Transcript:Lumbridge Guide, "Claiming owed experience". */
function guideOffer(event) {
  const { player, npcId } = event;
  if (passingOn.has(player) || event.definition?.getName?.() !== GUIDE_NAME) return false;
  const option = String(event.definition?.getActions?.()?.[event.clickType - 1] ?? "").toLowerCase();
  if (option !== "talk-to" || !owedQuests(player).length) return false;
  event.handled = true;
  say(player, [
    (index) => new core.NpcDialogue(index, npcId, LINE.OFFER),
    (index) => new core.StatementDialogue(index, owedText(player)),
  ], () => {
    player.getDialogueManager().reset();
    pluginApi.sendMultiChatboxPrompt(player, LINE.PROMPT,
      LINE.YES, () => guideAnswer(event, true),
      LINE.NO, () => guideAnswer(event, false));
  });
  return true;
}

module.exports = {
  name: "OwedExperience",
  description: "Perdu and the Lumbridge Guide give the experience the 3 November 2026 update added to thirteen quests to characters who finished them before it was paid, once.",
  ADDED_EXPERIENCE,
  LAMPS_AT_COMPLETION,
  NEW_REWARD_PAID_ATTRIBUTE,
  REWARDS_IN_OUR_CODE_SINCE,
  newRewardPaid,
  predatesNewRewards,
  register(api) {
    pluginApi = api;
    core = api.core;
    api.persistAttribute(NEW_REWARD_PAID_ATTRIBUTE, []);
    api.onCustomEvent("quest:completed", recordCompletion);
    api.onNpcDialogueCondition(answerPerduCondition);
    api.onCustomEvent("npc-dialogue:action", perduStep);
    api.onCustomEvent("npc-dialogue:line", skipGuideGreeting);
    api.onBeforeNpcInteraction(guideOffer);
  },
  _test: { owedQuests, owedText, claim },
};
