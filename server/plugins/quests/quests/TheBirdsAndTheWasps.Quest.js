/**
 * The Birds and the Wasps (members, novice, 11 November 2026, 1 Quest Point; no requirements).
 *
 * Built from the game cache (quest row 221, dbrow 17316 quest_birdsandthewasps: endstate 55, start NPC baw_bea_multi,
 * 1,000 Hunter and 250 Fletching XP in stat_xp_awarded) and the OSRS Wiki (the quest page, quick guide, the quest's and
 * Farmer Bea's transcripts and the journal's). RuneLite's Quest Helper has no helper for it yet. The units are in
 * ../birdsandthewasps/: Common (ids, stages, state, the dialogue player, the journal), Bea, Bees (the dealer and the
 * bee box) and Farm (the crate, the catches, the darts and Bea's supplies). The wasp swarms and the honey buzzards are
 * Hunter's (skills/hunter/Wasps.Hunter.js, Data.Hunter.js), the darts Fletching's (skills/data/fletching.json).
 *
 * Stage varbit baw (10992); see Common.STAGE for what each value is and which of them the cache fixes.
 */
module.exports = function registerTheBirdsAndTheWaspsQuest(api) {
  const { Skill } = api.core;
  const { registerQuest } = require("../QuestRuntime");
  const { createCommon, journalLines } = require("../birdsandthewasps/Common.TheBirdsAndTheWasps");
  const createBea = require("../birdsandthewasps/Bea.TheBirdsAndTheWasps");
  const createBees = require("../birdsandthewasps/Bees.TheBirdsAndTheWasps");
  const createFarm = require("../birdsandthewasps/Farm.TheBirdsAndTheWasps");

  const common = createCommon(api);
  const { STAGE, ATTRIBUTE, ITEM, carried, banked } = common;
  const bees = createBees(api, common);
  const farm = createFarm(api, common);
  const bea = createBea(api, common, { giveSnares: farm.giveSnares, beeBoxDelivered: bees.stop });

  function buildJournal(player, handle) {
    const stage = handle.getStage(player);
    const lost = stage === STAGE.BEES_COLLECTED && carried(player, ITEM.BEE_BOX) <= 0 && !banked(player, ITEM.BEE_BOX);
    return journalLines(stage, lost);
  }

  /** The quest's other varbits, and the bee box's insects for a player who logs in carrying it. */
  function login({ player }) {
    common.sendState(player);
    bees.watch(player);
  }

  function logout({ player }) {
    bees.stop(player);
  }

  /** Wiki (The Birds and the Wasps, Rewards): 1,000 Hunter and 250 Fletching XP, through the world's own rate. */
  function reward(player) {
    player.getSkillManager().addExperiences(Skill.HUNTER, 1000);
    player.getSkillManager().addExperiences(Skill.FLETCHING, 250);
  }

  const quest = registerQuest(api, {
    key: common.QUEST_KEY,
    name: common.QUEST_NAME,
    varbitId: common.VARBIT.STAGE,
    startedValue: STAGE.STARTED,
    completionValue: STAGE.COMPLETE,
    questPoints: 1,
    xpRewards: [
      { skillId: Skill.HUNTER.getIndex(), amount: 1000, label: "Hunter" },
      { skillId: Skill.FLETCHING.getIndex(), amount: 250, label: "Fletching" },
    ],
    // The update's own words for the other rewards (Wiki: Update:Quest Month: Week Two & TFA Changes).
    otherRewards: ["Access to four new low-level Hunter creatures", "Access to buying a supply bag"],
    // Ours: the reward scroll's picture is not documented.
    scrollItemId: ITEM.WASP_DART,
    buildJournal,
    onReward: reward,
  });
  common.setQuest(quest);

  for (const key of [ATTRIBUTE.HAD_CIDER, ATTRIBUTE.WASPS_NOTIFIED, ATTRIBUTE.BIRDS_NOTIFIED]) api.persistAttribute(key, false);
  api.persistAttribute(ATTRIBUTE.BIRDS_CAUGHT, 0);

  api.onNpcInteraction("Farmer Bea", { "Talk-to": bea.talk, Trade: bea.trade, "Swap-darts": bea.swap });
  api.onNpcInteraction("Bee dealer", { "Talk-to": bees.talk });
  api.onItemAction("Bee box", { Shake: bees.shake });
  api.onObjectInteraction("Equipment crate", { "Take-from": farm.takeFrom, "Take-all": farm.takeEverything });
  api.onCustomEvent("hunter:success", farm.caught);
  api.onCustomEvent("fletching:made", farm.dartsMade);
  api.onItemAction("Wasp dart", { Inspect: farm.inspect });
  api.onItemAction("Killer wasp dart", { Inspect: farm.inspect });
  api.onItemAction("Bea's supplies", { Open: farm.openSupplies });
  api.onPlayerLogin(login);
  api.onPlayerLogout(logout);

  // For tests and the admin tools: the units, by name.
  quest.units = { common, bea, bees, farm };
};
