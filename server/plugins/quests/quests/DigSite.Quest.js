/**
 * The Dig Site (members).
 *
 * The words come from the "The Dig Site" transcript page; this plugin supplies
 * the variant selector for the examiners, the three students, the researcher,
 * Terry Balando, the curator, the panning guide, the workmen and Doug Deeping
 * (all indexed), the start hook, the prose-condition answers and the exam /
 * discovery stage progression.
 *
 * Stages (varp 131): 1 started, 2-4 passed the three exams, 5 Terry Balando has seen the ancient talisman and
 * written the invitation letter, 6 a workman has the letter (the winches and shafts are open), 7 the compound is on
 * the bricks, 8 the wall is blown, 9 complete. From 6 on these are the live game's values, which the Quest Helper
 * reads (see ../digsite/Discovery.DigSite.js); the first half's are one lower than the live game's, which counts the
 * delivered letter as a stage of its own (here an attribute). The ropes, the barrel and the searched bricks are kept
 * beside the stage.
 *
 * Saves from before the discovery was built (it was one conversation with Terry per step): stage 7 was "Terry has
 * handed over a chemical compound" and stage 8 "the compound has become an ancient talisman", with the next talk
 * ending the quest. Both become stage 6 the first time the player is seen (a stage 7 or 8 that the discovery did not
 * set: Discovery's isLegacyStage): nobody goes back past a step they had been let through, the compound a stage 7
 * player carries is the one the bricks want, and a stage 8 player (whose compound that conversation took, and who
 * keeps the talisman it gave) makes theirs the real way, which stage 6 opens in full. Stage 4 is unchanged (the
 * talisman is now dug up, not handed over) and a completed quest stays complete: it counts as both ropes tied and the
 * wall blown, so the dungeon is open to it as it is after the real quest. The certificates the stand-in took from a
 * stage 7, 8 or 9 player are not given back (nothing in the quest needs them).
 *
 * The letter (stage 1): the examiner hands over an unstamped letter, the curator stamps it
 * (the sealed letter) and the examiner takes it back before the first exam. Whether the
 * curator stamped one and whether the examiner has it are kept in two attributes.
 *
 * The three first-exam students each ask for a lost item (the animal skull, teddy or
 * special cup); the second Talk-to while carrying it hands the item back and teaches
 * their exam answer, as the Wiki describes ("you will need to talk to each person twice").
 * The skull comes from the Digsite workman's Steal-from table and the cup from panning mud.
 *
 * The three exams (ours, upstream issue #6215) are the transcript's own quizzes: three questions each, the
 * right answer offered only once the student who knows it has told the player (the transcript's option
 * conditions), the examiner's count of right answers, and on three out of three the certificate (with a trowel
 * after the first) and the next stage. For the first exam a student tells their answer once their lost item is
 * back; for the second all three simply tell; for the third the student in purple wants an opal first (Wiki: "an
 * uncut opal or opal"). A student used to sign each certificate instead, whatever the examiner had just said.
 *
 * The discovery (after the third exam) is ../digsite/Discovery.DigSite.js, and the digging it starts with, which
 * goes on outside the quest, ../digsite/Digging.DigSite.js. This file chooses the speakers' conversations and
 * passes the dialogue's conditions, actions and item uses on to them.
 *
 * Gaps of that half, for want of a recording of the live game (each is plain here, nothing invented to look the
 * part): no animation for trowel digging, tying a rope, the winch, the chest, the barrel, mixing or lighting; no
 * graphic, sound or camera for the explosion, and no run (the player is put at the foot of the rope); a dig takes
 * the four ticks panning does; a descent lands on the free tile north of the shaft's rope. Words of ours where the
 * transcript has none: a dig's finds and "nothing", a dig refused for want of its exam or of the jar and brush,
 * the locked chest, the first two mixtures, too low a Herblore level, and emptying the vial. Not sourced: where the
 * arcenia roots lie before the blast (Discovery's ROOTS_BEFORE_BLAST). Not built: Terry's word on an ancient staff,
 * and the curator's cake or fruit blast for the level 3 certificate.
 */
const createDigSiteDigging = require("../digsite/Digging.DigSite");
const createDigSiteDiscovery = require("../digsite/Discovery.DigSite");
module.exports = function registerDigSiteQuest(api) {
  const { Animation, DialogueChainBuilder, GameObject, Item, ItemIdentifiers, ItemStatementDialogue, MapObjects,
    NpcDialogue, NpcIdentifiers, ObjectIdentifiers, ObjectManager, PlayerDialogue, Skill, Task, TaskManager } = api.core;
  const { registerQuest, refreshQuestList, startTranscript, giveReward, loadTranscripts } = require("../QuestRuntime");

  const EXAMINER_NPC_IDS = new Set([
    NpcIdentifiers.EXAMINER,
    NpcIdentifiers.EXAMINER_2,
    NpcIdentifiers.EXAMINER_3,
  ]);
  const STUDENT_GREEN_NPC_ID = NpcIdentifiers.STUDENT;
  const STUDENT_PURPLE_NPC_ID = NpcIdentifiers.STUDENT_2;
  const STUDENT_ORANGE_NPC_ID = NpcIdentifiers.STUDENT_3;

  /** Attribute states: 0 not asked, 1 asked and the item is still missing, 2 item returned. */
  const STUDENT_ASKED = 1;
  const STUDENT_HELPED = 2;
  /**
   * Each first-exam student lost one item. The first Talk-to is the request; a later
   * Talk-to while carrying that item hands it back and teaches their exam answer, then
   * repeats the answer on every later talk (Wiki: "you will need to talk to each person twice").
   */
  const STUDENT_LOST_ITEM = new Map([
    [STUDENT_GREEN_NPC_ID, {
      itemId: ItemIdentifiers.ANIMAL_SKULL,
      attribute: "quest.the_dig_site.student.animal-skull",
      ask: "the-first-exam-the-student-in-the-green-top-asking-the-student-for-help",
      missing: "the-first-exam-the-student-in-the-green-top-returning-to-the-student-without-the-skull",
      give: "the-first-exam-the-student-in-the-green-top-returning-the-skull",
      again: "the-first-exam-the-student-in-the-green-top-talking-to-the-student-again",
      index: 0,
      second: "the-second-exam-the-student-in-the-green-top",
      third: "the-third-exam-the-student-in-the-green-top",
    }],
    [STUDENT_PURPLE_NPC_ID, {
      itemId: ItemIdentifiers.TEDDY,
      attribute: "quest.the_dig_site.student.teddy",
      ask: "the-first-exam-the-student-in-the-purple-skirt-asking-the-student-for-help",
      missing: "the-first-exam-the-student-in-the-purple-skirt-returning-to-the-student-without-the-teddy-bear",
      give: "the-first-exam-the-student-in-the-purple-skirt-returning-the-teddy-bear",
      again: "the-first-exam-the-student-in-the-purple-skirt-talking-to-the-student-again",
      index: 1,
      second: "the-second-exam-the-student-in-the-purple-skirt",
      // Her third answer costs an opal: see OPAL_* below.
      third: "the-third-exam-the-student-in-the-purple-skirt-talking-to-the-student-again",
    }],
    [STUDENT_ORANGE_NPC_ID, {
      itemId: ItemIdentifiers.SPECIAL_CUP,
      attribute: "quest.the_dig_site.student.special-cup",
      ask: "the-first-exam-the-student-in-the-orange-shirt-asking-the-student-for-help",
      missing: "the-first-exam-the-student-in-the-orange-shirt-returning-to-the-student-without-the-cup",
      give: "the-first-exam-the-student-in-the-orange-shirt-returning-the-cup",
      again: "the-first-exam-the-student-in-the-orange-shirt-talking-to-the-student-again",
      index: 2,
      second: "the-second-exam-the-student-in-the-orange-shirt",
      third: "the-third-exam-the-student-in-the-orange-shirt",
    }],
  ]);
  const RESEARCHER_NPC_ID = NpcIdentifiers.RESEARCHER;
  const TERRY_BALANDO_NPC_ID = NpcIdentifiers.TERRY_BALANDO;
  const CURATOR_NPC_ID = NpcIdentifiers.CURATOR_HAIG_HALEN;
  const PANNING_GUIDE_NPC_ID = NpcIdentifiers.PANNING_GUIDE;
  const WORKMAN_NPC_IDS = new Set([
    NpcIdentifiers.DIGSITE_WORKMAN,
    NpcIdentifiers.DIGSITE_WORKMAN_2,
    NpcIdentifiers.DIGSITE_WORKMAN_3,
  ]);
  const DOUG_DEEPING_NPC_ID = NpcIdentifiers.DOUG_DEEPING;

  /** NPCs whose transcripts this plugin owns; dialogue conditions from anyone else are not ours. */
  const DIALOGUE_NPC_IDS = new Set([
    ...EXAMINER_NPC_IDS,
    STUDENT_GREEN_NPC_ID,
    STUDENT_PURPLE_NPC_ID,
    STUDENT_ORANGE_NPC_ID,
    RESEARCHER_NPC_ID,
    TERRY_BALANDO_NPC_ID,
    CURATOR_NPC_ID,
    PANNING_GUIDE_NPC_ID,
    ...WORKMAN_NPC_IDS,
    DOUG_DEEPING_NPC_ID,
  ]);

  const VARP_DIG_SITE = 131;
  const STAGE_STARTED = 1;
  const STAGE_EXAMS_DONE = 4;
  /** Terry has the talisman and has written the invitation letter. */
  const STAGE_INVITED = 5;
  /** A workman has the letter: the winches may be used. */
  const STAGE_SHAFTS = 6;
  /** The compound is on the bricks. In a save from before the discovery was built: carrying Terry's compound. */
  const STAGE_POURED = 7;
  /** The wall is blown. In a save from before the discovery was built: carrying Terry's talisman. */
  const STAGE_BLOWN = 8;
  const STAGE_COMPLETE = 9;

  const LEVEL_1_CERTIFICATE_ITEM_ID = ItemIdentifiers.LEVEL_1_CERTIFICATE;
  const LEVEL_2_CERTIFICATE_ITEM_ID = ItemIdentifiers.LEVEL_2_CERTIFICATE;
  const LEVEL_3_CERTIFICATE_ITEM_ID = ItemIdentifiers.LEVEL_3_CERTIFICATE;
  const TROWEL_ITEM_ID = ItemIdentifiers.TROWEL;
  const UNSTAMPED_LETTER_ITEM_ID = ItemIdentifiers.UNSTAMPED_LETTER; // 682
  const STAMPED_LETTER_ITEM_ID = ItemIdentifiers.SEALED_LETTER; // 683, the stamped letter
  const STAMPED_ATTRIBUTE = "quest.the_dig_site.letter_stamped";
  const DELIVERED_ATTRIBUTE = "quest.the_dig_site.letter_delivered";
  const PANNING_PERMISSION = "dig-site:panning-permission";
  const PANNING_PERMISSION_VARBIT = 2544; // itdigsitetea
  const TEA_ITEM_ID = ItemIdentifiers.CUP_OF_TEA_2;
  const NETTLE_TEA_IDS = [ItemIdentifiers.NETTLE_TEA, ItemIdentifiers.NETTLE_TEA_2,
    ItemIdentifiers.CUP_OF_TEA_4, ItemIdentifiers.CUP_OF_TEA_5,
    ItemIdentifiers.CUP_OF_TEA_6, ItemIdentifiers.CUP_OF_TEA_7];
  const PANNING_GUIDE_VARIANT = "the-first-exam-the-student-in-the-orange-shirt-talking-to-the-panning-guide";
  const TEA_THANKS = "Ah! Lovely! You can't beat a good cuppa... You're free to pan all you want.";
  const NETTLE_TEA_THANKS = "Urg! Is that what you call tea? Oh well, I suppose it will do; you can pan all you want.";
  const EMPTY_TRAY = ItemIdentifiers.PANNING_TRAY;
  const MUD_TRAY = ItemIdentifiers.PANNING_TRAY_3;
  const EMPTY_TRAY_CHAT_EXPRESSION = 554; // chatquiz1, rsprox 232/03231 tick 3074
  const FULL_TRAY_CHAT_EXPRESSION = 576; // chatcon2, rsprox 232/03231 tick 3463
  const SEARCH_ANIMATION = 832; // RSProx 232/03228, tick 1081
  const PAN_ANIMATION = 4593; // RSProx 232/03231, tick 2625
  const PAGE = "The Dig Site";

  const START_HOOK = "quest:the-dig-site:start";

  // ---- The three exams (stage 1, 2 and 3 are the first, second and third exam still to pass) ----
  const EXAM_VARIANTS = ["the-first-exam-taking-the-exam", "the-second-exam", "the-third-exam"];
  const EXAM_RETRY_VARIANT = "the-first-exam-taking-the-exam-repeating-the-exam";
  const EXAMS_DONE_VARIANT = "the-third-exam-talking-to-the-examiner-again";
  const EXAM_CERTIFICATES = [LEVEL_1_CERTIFICATE_ITEM_ID, LEVEL_2_CERTIFICATE_ITEM_ID, LEVEL_3_CERTIFICATE_ITEM_ID];
  /**
   * Which student (STUDENT_LOST_ITEM's index: 0 green, 1 purple, 2 orange) knows each exam's questions, in the order
   * the examiner asks them. From the transcript: the students' own lines name the question they answer (first exam:
   * "The study of Earth Sciences is", "The people eligible to use the digsite are", "The proper health and safety
   * points are"; second: sample transportation, finds handling, rock pick usage; third: sample preparation,
   * specimen brush use, handling bones).
   */
  const EXAM_STUDENTS = [[0, 2, 1], [2, 1, 0], [1, 0, 2]];
  /** Bits (exam - 1) * 3 + student: what the students have told the player for the second and third exams. */
  const LEARNED_ATTRIBUTE = "quest.the_dig_site.learned";
  /** The purple student's opal before the third exam: 0 not asked, 1 asked, 2 given. */
  const OPAL_ATTRIBUTE = "quest.the_dig_site.student.opal";
  const OPAL_ITEM_IDS = [ItemIdentifiers.UNCUT_OPAL, ItemIdentifiers.OPAL]; // Wiki: "an uncut opal or opal"
  const OPAL_ASK_VARIANT = "the-third-exam-the-student-in-the-purple-skirt";
  const OPAL_MISSING_VARIANT = "the-third-exam-the-student-in-the-purple-skirt-returning-without-an-opal";
  const OPAL_GIVE_VARIANT = "the-third-exam-the-student-in-the-purple-skirt-giving-the-student-the-opal";
  /** The exam centre's cupboards (cache map): the one on the south wall holds specimen jars, the other rock picks. */
  const CUPBOARDS = new Map([
    [ObjectIdentifiers.CUPBOARD_45, { open: ObjectIdentifiers.CUPBOARD_46 }], // 17302 at 3354,3332
    [ObjectIdentifiers.CUPBOARD_43, { open: ObjectIdentifiers.CUPBOARD_44 }], // 17300 at 3355,3337
  ]);
  const OPEN_CUPBOARDS = new Map([
    [ObjectIdentifiers.CUPBOARD_46, { closed: ObjectIdentifiers.CUPBOARD_45, itemId: ItemIdentifiers.SPECIMEN_JAR,
      variant: "making-a-discovery-searching-the-south-cupboard" }],
    [ObjectIdentifiers.CUPBOARD_44, { closed: ObjectIdentifiers.CUPBOARD_43, itemId: ItemIdentifiers.ROCK_PICK,
      variant: "making-a-discovery-searching-the-north-cupboard" }],
  ]);

  let quest;
  const panning = new WeakSet();
  /** player -> the questions (0-2) answered rightly in the exam being sat; a conversation's worth, never saved. */
  const examScores = new WeakMap();
  const examCache = [];

  const held = (player, itemId, amount = 1) =>
    player.getInventory().getAmount(itemId) >= amount;
  /** Carried or banked (bank tabs only: the search tab repeats them, placeholders hold 0). */
  const owned = (player, itemId) => held(player, itemId) || player.getBanks().some((bank, tab) =>
    tab !== api.core.Bank.BANK_SEARCH_TAB_INDEX && Number(bank?.getAmount(itemId) ?? 0) > 0);
  const delivered = (player) => player.getAttribute(DELIVERED_ATTRIBUTE) === true;
  const stamped = (player) => player.getAttribute(STAMPED_ATTRIBUTE) === true;
  const canPan = (player) => player.getAttribute(PANNING_PERMISSION) === true;
  const holdsLetter = (player) => held(player, UNSTAMPED_LETTER_ITEM_ID) || held(player, STAMPED_LETTER_ITEM_ID);
  /** Still waiting on the letter: started, and the examiner hasn't taken a stamped one. */
  const awaitingLetter = (player) => quest.getStage(player) === STAGE_STARTED && !delivered(player);
  /** The stage, with a save from before the discovery was built brought to its place in it (see the header). */
  function stageNow(player) {
    const stage = quest.getStage(player);
    if (!discovery.isLegacyStage(player, stage)) return stage;
    discovery.setStage(player, STAGE_SHAFTS);
    return STAGE_SHAFTS;
  }
  /** The exam the player has still to pass (0-2), or null: before the letter is in, and once all three are passed. */
  function pendingExam(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_STARTED || stage >= STAGE_EXAMS_DONE || awaitingLetter(player)) return null;
    return stage - STAGE_STARTED;
  }

  /**
   * An exam as the transcript has it: its steps, and for each of its three questions the option that is right (shown
   * once "the player has asked the students for answers") and the wrong one shown in its place until then; then the
   * four "answered N correctly" conditions in order. Read from the record, so a re-export keeps working.
   */
  function examData(exam) {
    if (examCache[exam] !== undefined) return examCache[exam];
    const steps = loadTranscripts(api)?.[PAGE]?.variants?.[EXAM_VARIANTS[exam]] ?? [];
    // The first exam is the conversation itself; the later two sit under their "I am ready for the ... exam" option.
    const direct = steps.filter((step) => step?.type === "choice").length >= 3;
    const body = direct ? steps : steps.find((step) => step?.type === "choice")?.options?.[0]?.steps ?? [];
    const questions = body.filter((step) => step?.type === "choice").map((choice) => ({
      right: choice.options.find((option) => /has asked/i.test(option.condition ?? ""))?.id,
      decoy: choice.options.find((option) => /has not asked/i.test(option.condition ?? ""))?.id,
    }));
    const results = body.filter((step) => step?.type === "condition").map((step) => step.id);
    const usable = questions.length === 3 && questions.every((question) => question.right && question.decoy) && results.length === 4;
    if (!usable) console.warn(`[DigSite] the transcript's ${EXAM_VARIANTS[exam]} is not the three-question exam expected; it cannot be passed`);
    return examCache[exam] = { body, questions: usable ? questions : [], results: usable ? results : [] };
  }

  /** Whether the student who knows an exam's question has told the player. */
  function knowsAnswer(player, exam, question) {
    const index = EXAM_STUDENTS[exam][question];
    if (exam === 0) {
      const student = [...STUDENT_LOST_ITEM.values()].find((entry) => entry.index === index);
      return Number(player.getAttribute(student.attribute)) === STUDENT_HELPED;
    }
    return ((Number(player.getAttribute(LEARNED_ATTRIBUTE)) || 0) & (1 << ((exam - 1) * 3 + index))) !== 0;
  }

  function learnAnswer(player, exam, index) {
    const learned = Number(player.getAttribute(LEARNED_ATTRIBUTE)) || 0;
    player.setAttribute(LEARNED_ATTRIBUTE, learned | (1 << ((exam - 1) * 3 + index)));
  }

  /** Passing an exam: its certificate (and after the first, the trowel), and the next stage. What does not fit drops. */
  function passExam(player, exam) {
    examScores.delete(player);
    giveReward(player, EXAM_CERTIFICATES[exam], 1);
    if (exam === 0 && !held(player, TROWEL_ITEM_ID)) giveReward(player, TROWEL_ITEM_ID, 1);
    quest.setStage(player, STAGE_STARTED + exam + 1);
  }

  /**
   * "Hello again. Are you ready for another shot at the exam?" / "Yes, I certainly am." ends in a jump back to the
   * exam that the record has no target for, so the conversation stopped there. The first exam's own steps, from the
   * examiner's "Okay, we will start with the first exam" on, are put in its place.
   */
  function spliceExamRetry(steps) {
    const first = loadTranscripts(api)?.[PAGE]?.variants?.[EXAM_VARIANTS[0]] ?? [];
    const start = first.findIndex((step) => String(step?.text ?? "").startsWith("Okay, we will start with the first exam"));
    if (start < 0) return steps;
    return steps.map((step) => step?.type !== "choice" ? step : {
      ...step,
      options: step.options.map((option) => !(option.steps ?? []).some((entry) => entry?.type === "jump") ? option : {
        ...option,
        steps: [{ player: option.text }, ...first.slice(start)],
      }),
    });
  }

  /** The lost-trowel answer alone, for a player who has passed every exam and lost the trowel since. */
  function lostTrowelSteps(steps) {
    const option = steps.find((step) => step?.type === "choice")?.options?.find((entry) => /lost my trowel/i.test(entry.text ?? ""));
    return option?.steps ?? [];
  }

  /** Talk-to an examiner where the plain variant is not enough: the first exam again, and a lost trowel afterwards. */
  function talkToExaminer(event) {
    const { player, npc, npcId } = event;
    if (!EXAMINER_NPC_IDS.has(npcId)) return false;
    if (pendingExam(player) === 0) {
      examScores.delete(player);
      const request = { player, npc, npcId, variant: EXAM_RETRY_VARIANT, exact: true, select: spliceExamRetry };
      api.emitCustomEvent("npc-dialogue:start", request);
      return request.handled === true;
    }
    const stage = quest.getStage(player);
    if (stage >= STAGE_EXAMS_DONE && !quest.isComplete(player) && !owned(player, TROWEL_ITEM_ID)) {
      return startTranscript(api, player, npcId, PAGE, EXAM_VARIANTS[2], lostTrowelSteps, npc ?? null);
    }
    return false;
  }

  function giveLetter(player, itemId) {
    if (player.getInventory().getFreeSlots() < 1) {
      // No capture of a full inventory here: the wording is ours. Asking again re-issues it.
      player.sendMessage("You don't have enough inventory space for the letter.");
      return;
    }
    player.getInventory().adds(itemId, 1);
  }

  /** The curator stamps the letter the player carries. */
  function stampLetter(player) {
    if (held(player, UNSTAMPED_LETTER_ITEM_ID)) {
      player.getInventory().deleteNumber(UNSTAMPED_LETTER_ITEM_ID, 1);
      player.getInventory().adds(STAMPED_LETTER_ITEM_ID, 1);
    }
    player.setAttribute(STAMPED_ATTRIBUTE, true);
  }

  /** The examiner takes the stamped letter and the first exam begins. */
  function deliverLetter(player) {
    player.getInventory().deleteNumber(STAMPED_LETTER_ITEM_ID, 1);
    player.setAttribute(DELIVERED_ATTRIBUTE, true);
  }

  function showItem(player, itemId, text) {
    player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new ItemStatementDialogue(0, itemId, text)));
  }

  function searchTeddyBush({ player, objectId }) {
    if (objectId !== ObjectIdentifiers.BUSH_10) return false;
    player.performAnimation(new Animation(SEARCH_ANIMATION));
    player.sendMessage("You search the bush...");
    // Ours (upstream issue #6215): nor once the student has her teddy back (it is hers again, not the bush's).
    const returned = Number(player.getAttribute(STUDENT_LOST_ITEM.get(STUDENT_PURPLE_NPC_ID).attribute)) === STUDENT_HELPED;
    if (quest.getStage(player) >= STAGE_EXAMS_DONE || returned || owned(player, ItemIdentifiers.TEDDY)) {
      player.sendMessage("You find nothing of interest.");
    } else if (player.getInventory().getFreeSlots() === 0) {
      player.getInventory().full();
    } else {
      player.getInventory().adds(ItemIdentifiers.TEDDY, 1);
      showItem(player, ItemIdentifiers.TEDDY, "You find a teddy bear.");
    }
    return true;
  }

  function acceptTea(player, slot) {
    const inventory = player.getInventory();
    const id = inventory.forSlot(slot)?.getId();
    if (canPan(player) || (id !== TEA_ITEM_ID && !NETTLE_TEA_IDS.includes(id))) return false;
    inventory.deleteAtSlot(slot);
    player.setAttribute(PANNING_PERMISSION, true);
    player.getPacketSender().sendVarbit(PANNING_PERMISSION_VARBIT, 1);
    return true;
  }

  function pan({ player }) {
    if (panning.has(player)) return true;
    const inventory = player.getInventory();
    if (!canPan(player)) {
      startTranscript(api, player, PANNING_GUIDE_NPC_ID, PAGE, PANNING_GUIDE_VARIANT);
      return true;
    }
    const slot = inventory.getSlotForItemId(EMPTY_TRAY);
    if (slot < 0) {
      if (held(player, MUD_TRAY)) {
        player.getDialogueManager().startDialogues(new DialogueChainBuilder()
          .add(new PlayerDialogue(0, "I already have a full panning tray; perhaps I should<br>search it first.", FULL_TRAY_CHAT_EXPRESSION)));
      } else {
        player.sendMessage("You need a panning tray to pan here!");
      }
      return true;
    }
    const start = player.getLocation().clone();
    const tray = inventory.forSlot(slot);
    panning.add(player);
    player.performAnimation(new Animation(PAN_ANIMATION));
    TaskManager.submit(new (class extends Task {
      constructor() { super(4, player, false); }
      execute() {
        this.stop();
        if (!player.getLocation().equals(start) || inventory.forSlot(slot) !== tray) return;
        inventory.setItem(slot, new Item(MUD_TRAY, 1));
        inventory.refreshItems();
        player.getSkillManager().addExperiences(Skill.FISHING, 2);
        player.getSkillManager().addExperiences(Skill.MINING, 2);
        showItem(player, MUD_TRAY, "You lift the full tray from the water.");
      }
      stop() {
        panning.delete(player);
        super.stop();
      }
    })());
    return true;
  }

  // OSRS Wiki, Panning tray (mud): drop table out of 40 rolls.
  const PAN_REWARDS = [
    [4, ItemIdentifiers.COINS, "You find some coins within the mud."],
    [8, ItemIdentifiers.NUGGETS, "You find some gold nuggets within the mud.", ItemIdentifiers.PANNING_TRAY_2],
    [11, ItemIdentifiers.OYSTER, "You find an oyster within the mud!"],
    [14, ItemIdentifiers.UNCUT_OPAL, "You find a gem within the mud!"],
    [17, ItemIdentifiers.UNCUT_JADE, "You find a gem within the mud!"],
    [20, ItemIdentifiers.SPECIAL_CUP, "You find a special cup in the mud."],
  ];

  function searchTray({ player, itemId, slot }) {
    if (itemId === EMPTY_TRAY) {
      player.getDialogueManager().startDialogues(new DialogueChainBuilder()
        .add(new PlayerDialogue(0, "Err, why am I searching an empty tray?", EMPTY_TRAY_CHAT_EXPRESSION)));
      return true;
    }
    if (itemId !== MUD_TRAY) return false;
    const inventory = player.getInventory();
    if (inventory.getFreeSlots() === 0) {
      inventory.full();
      return true;
    }
    const roll = Math.floor(Math.random() * 40);
    const found = PAN_REWARDS.find(([end]) => roll < end);
    const reward = found && (found[1] !== ItemIdentifiers.SPECIAL_CUP ||
        (!quest.isComplete(player) && !held(player, ItemIdentifiers.SPECIAL_CUP))) ? found : null;
    const amount = reward?.[1] === ItemIdentifiers.COINS ? 1 + Math.floor(Math.random() * 10) : 1;
    // A coin stack at the cap takes no more; keep the mud rather than empty it for nothing.
    if (reward && inventory.getAddableAmount(new Item(reward[1], amount)) < amount) {
      inventory.full();
      return true;
    }
    player.sendMessage("You search the contents of the tray...");
    inventory.setItem(slot, new Item(EMPTY_TRAY, 1));
    if (reward) {
      const [, id, text, boxId = id] = reward;
      inventory.adds(id, amount);
      showItem(player, boxId, text);
    } else {
      inventory.refreshItems();
      showItem(player, MUD_TRAY, "The tray contains only plain mud.");
    }
    return true;
  }

  function buildJournal(player, questHandle) {
    // A save's old stand-in stage reads as the stage it becomes (stageNow moves it when the player next acts).
    const saved = questHandle.getStage(player);
    const stage = discovery.isLegacyStage(player, saved) ? STAGE_SHAFTS : saved;
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>I passed the three examinations.</str>",
        ...discovery.journal(player, stage),
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_EXAMS_DONE) return ["<str>I passed the three examinations.</str>", ...discovery.journal(player, stage)];
    if (awaitingLetter(player)) {
      return stamped(player)
        ? ["The curator stamped my letter of recommendation.", "I should take it back to the <col=800000>Examiner</col>."]
        : ["The examiner gave me a letter of recommendation.", "I should get it stamped by the <col=800000>Curator</col> of Varrock's museum."];
    }
    if (stage >= STAGE_STARTED) {
      const exam = ["first", "second", "third"][stage - STAGE_STARTED];
      return [
        ...["first", "second", "third"].slice(0, stage - STAGE_STARTED).map((passed) => `<str>I passed the ${passed} Earth Sciences exam.</str>`),
        `I need to pass the ${exam} Earth Sciences exam with the <col=800000>Examiner</col>.`,
        "The <col=800000>three students</col> on the Digsite know the answers.",
      ];
    }
    return ["I can start this quest by talking to an <col=800000>Examiner</col> in the <col=800000>Exam Centre</col> south of the <col=800000>Digsite</col>."];
  }

  function grantReward(player) {
    player.getSkillManager().addExperiences(Skill.MINING, 15300);
    player.getSkillManager().addExperiences(Skill.HERBLORE, 2000);
    // Ours: Wiki (The Dig Site, Rewards: "2 gold bars"; walkthrough: Terry Balando "gives you two gold bars as a
    // reward"). They were missing. What does not fit in the inventory goes on the floor.
    giveReward(player, ItemIdentifiers.GOLD_BAR, 2);
  }

  function isQuestStarted(player, key) {
    const request = { player, key, started: false };
    api.emitCustomEvent("quest:is-started", request);
    return request.started === true;
  }

  function isQuestComplete(player, key) {
    const request = { player, key, complete: false };
    api.emitCustomEvent("quest:is-complete", request);
    return request.complete === true;
  }

  /** Which transcript variant each speaker plays, by quest stage. */
  function selectVariant({ npcId, player }) {
    const stage = stageNow(player);
    if (EXAMINER_NPC_IDS.has(npcId)) {
      if (stage === 0) return "starting-the-quest";
      if (awaitingLetter(player)) {
        if (!held(player, STAMPED_LETTER_ITEM_ID)) return "starting-the-quest-talking-to-an-examiner-again";
        deliverLetter(player);
        examScores.delete(player);
        return EXAM_VARIANTS[0];
      }
      // Each stage sits its own exam (the first exam's page used to play through all three, and the second and third
      // only after they were already passed). A new conversation is a new sitting.
      examScores.delete(player);
      if (stage === STAGE_STARTED) return EXAM_RETRY_VARIANT;
      if (stage < STAGE_EXAMS_DONE) return EXAM_VARIANTS[stage - STAGE_STARTED];
      return EXAMS_DONE_VARIANT;
    }
    const student = STUDENT_LOST_ITEM.get(npcId);
    if (student) {
      // Second exam: each student tells what they have learned since (no errand).
      if (stage === STAGE_STARTED + 1) {
        learnAnswer(player, 1, student.index);
        return student.second;
      }
      // Third exam, and afterwards: the same, but the student in purple wants an opal for hers first.
      if (stage >= STAGE_STARTED + 2) {
        if (npcId === STUDENT_PURPLE_NPC_ID) {
          const opal = Number(player.getAttribute(OPAL_ATTRIBUTE)) || 0;
          if (opal === 0) {
            player.setAttribute(OPAL_ATTRIBUTE, 1);
            return OPAL_ASK_VARIANT;
          }
          if (opal === 1) {
            const itemId = OPAL_ITEM_IDS.find((id) => held(player, id));
            if (itemId === undefined) return OPAL_MISSING_VARIANT;
            player.getInventory().deleteNumber(itemId, 1);
            player.setAttribute(OPAL_ATTRIBUTE, 2);
            learnAnswer(player, 2, student.index);
            return OPAL_GIVE_VARIANT;
          }
        }
        learnAnswer(player, 2, student.index);
        return student.third;
      }
      // First exam (and before it): the lost item, then the answer.
      const state = Number(player.getAttribute(student.attribute)) || 0;
      if (state === STUDENT_HELPED) return student.again;
      if (state === STUDENT_ASKED) {
        if (!held(player, student.itemId)) return student.missing;
        player.getInventory().deleteNumber(student.itemId, 1);
        player.setAttribute(student.attribute, STUDENT_HELPED);
        return student.give;
      }
      player.setAttribute(student.attribute, STUDENT_ASKED);
      return student.ask;
    }
    if (npcId === RESEARCHER_NPC_ID) {
      // Each of his conversations opens on the exam just passed ("I passed my second Earth Sciences exam.", "I did
      // it! Level 3 Earth Sciences!"), and the last on the shafts Terry has opened.
      if (stage >= STAGE_COMPLETE) return { page: "Researcher", variant: "standard-dialogue-after-the-dig-site" };
      if (stage >= STAGE_INVITED) return "making-a-discovery-talking-to-the-researcher";
      if (stage >= STAGE_EXAMS_DONE) return "the-third-exam-talking-to-the-researcher";
      if (stage === STAGE_STARTED + 2) return "the-second-exam-talking-to-the-researcher";
      if (stage === STAGE_STARTED + 1) return "the-first-exam-talking-to-the-researcher-after-completing-the-first-exam";
      return "the-first-exam-talking-to-the-researcher-before-completing-the-first-exam";
    }
    if (npcId === TERRY_BALANDO_NPC_ID) return discovery.terryVariant(player);
    if (npcId === CURATOR_NPC_ID) {
      // The Golem reuses the museum curator only while its museum step is active.
      if (isQuestStarted(player, "the_golem") && !isQuestComplete(player, "the_golem")) return null;
      // Only while the letter is still owed; otherwise the curator's own dialogue.
      if (!awaitingLetter(player)) return null;
      if (!stamped(player) && held(player, UNSTAMPED_LETTER_ITEM_ID)) {
        stampLetter(player);
        return "starting-the-quest-getting-the-curator-s-approval";
      }
      return stamped(player) ? "starting-the-quest-getting-the-curator-s-approval-talking-the-curator-again" : null;
    }
    if (npcId === PANNING_GUIDE_NPC_ID) {
      return PANNING_GUIDE_VARIANT;
    }
    // A workman takes the invitation when it is used on him (handleItemOnNpc); talked to, he has his own page's
    // conversation. It used to be the hand-over's words on every Talk-to, letter or none.
    if (WORKMAN_NPC_IDS.has(npcId)) return discovery.workmanVariant(player);
    if (npcId === DOUG_DEEPING_NPC_ID) return discovery.dougVariant(player);
    return null;
  }

  /** Answer the page's prose conditions for this plugin's own NPCs. */
  function answerCondition({ player, npcId, text, stepId }) {
    if (!DIALOGUE_NPC_IDS.has(npcId)) return null;
    const value = String(text).toLowerCase();
    const has = (itemId, amount = 1) => held(player, itemId, amount);
    const exam = EXAMINER_NPC_IDS.has(npcId) && stepId ? pendingExam(player) : null;
    if (exam !== null) {
      const { questions, results } = examData(exam);
      // A question's right answer is on offer once its student has told the player; until then a wrong one is.
      const question = questions.findIndex((entry) => entry.right === stepId || entry.decoy === stepId);
      if (question >= 0) return (questions[question].right === stepId) === knowsAnswer(player, exam, question);
      // "If the player answered N questions correctly:"
      const result = results.indexOf(stepId);
      if (result >= 0) return (examScores.get(player)?.size ?? 0) === result;
    }
    if (value.includes("does not have a trowel")) return !has(TROWEL_ITEM_ID);
    if (value.includes("has a trowel")) return has(TROWEL_ITEM_ID);
    // The discovery's own conditions (the lost invitation, Doug's key, the winch's rope and Agility), by step.
    const discovered = stepId ? discovery.answerCondition(player, stepId) : null;
    if (discovered !== null) return discovered;
    if (npcId === TERRY_BALANDO_NPC_ID && value.includes("desert treasure i has been completed")) {
      return isQuestComplete(player, "desert_treasure_i");
    }
    if (npcId === PANNING_GUIDE_NPC_ID) {
      const tea = !canPan(player) && held(player, TEA_ITEM_ID);
      const nettleTea = !canPan(player) && NETTLE_TEA_IDS.some((id) => held(player, id));
      if (value.includes("does not have a cup of tea")) return !tea && !nettleTea;
      if (value.includes("has a cup of nettle tea")) return !tea && nettleTea;
      if (value.includes("has a cup of tea")) return tea;
    }
    if (npcId === CURATOR_NPC_ID) {
      // Talking to the curator again: re-stamp a lost letter, or stamp another one.
      if (value.includes("another unstamped letter")) {
        if (!held(player, UNSTAMPED_LETTER_ITEM_ID)) return false;
        stampLetter(player);
        return true;
      }
      if (value.includes("still has the letter") || value.includes("still have the letter")) {
        return held(player, STAMPED_LETTER_ITEM_ID);
      }
      if (value.includes("lost the letter")) {
        if (holdsLetter(player)) return false;
        giveLetter(player, STAMPED_LETTER_ITEM_ID);
        return true;
      }
    } else if (EXAMINER_NPC_IDS.has(npcId)) {
      if (value.includes("still has the letter") || value.includes("still have the letter")) return holdsLetter(player);
      if (value.includes("lost the letter")) {
        if (holdsLetter(player)) return false;
        giveLetter(player, UNSTAMPED_LETTER_ITEM_ID);
        return true;
      }
    }
    if (value.includes("shield of arrav hasn't been completed")) return !isQuestComplete(player, "shield_of_arrav");
    if (value.includes("shield of arrav has been completed")) return isQuestComplete(player, "shield_of_arrav");
    return null;
  }

  /** An exam answer: the right option of one of the exam's questions counts once. */
  function handleChoice({ player, npcId, stepId }) {
    if (!player || !stepId || !EXAMINER_NPC_IDS.has(npcId)) return;
    const exam = pendingExam(player);
    if (exam === null) return;
    const question = examData(exam).questions.findIndex((entry) => entry.right === stepId);
    if (question < 0) return;
    if (!examScores.has(player)) examScores.set(player, new Set());
    examScores.get(player).add(question);
  }

  /** The branch the examiner takes: three right answers pass the exam; "Here you go..." hands over a new trowel. */
  function handleCondition({ player, npcId, stepId, text }) {
    if (player && DIALOGUE_NPC_IDS.has(npcId)) discovery.handleCondition({ player, stepId });
    if (!player || !EXAMINER_NPC_IDS.has(npcId)) return;
    if (String(text).toLowerCase().includes("does not have a trowel")) {
      // Carried, as the condition itself is judged: the examiner has just said "Here you go...".
      if (quest.getStage(player) > STAGE_STARTED && !held(player, TROWEL_ITEM_ID)) giveReward(player, TROWEL_ITEM_ID, 1);
      return;
    }
    const exam = pendingExam(player);
    if (exam === null) return;
    const { results } = examData(exam);
    if (results.length === 4 && stepId === results[3] && (examScores.get(player)?.size ?? 0) === 3) passExam(player, exam);
  }

  /** The object standing where `object` stands, if it is still the one clicked. */
  function swapObject(object, id) {
    const location = object.getLocation();
    const current = MapObjects.get(object.getId(), location, object.getPrivateArea?.() ?? null);
    if (!current) return;
    ObjectManager.deregister(current, true);
    ObjectManager.register(new GameObject(id, location.clone(), current.getType(), current.getFace(), current.getPrivateArea?.() ?? null), true);
  }

  /**
   * The exam centre's two cupboards (ours, upstream issue #6215: nothing answered them, so the specimen jar could
   * not be had). Open and Close swap the cache's shut and open cupboards; Search hands over the cupboard's tool with
   * the transcript's line ("You find a specimen jar." / "You find a rock pick."), one at a time.
   */
  function openCupboard(event) {
    const cupboard = CUPBOARDS.get(event.objectId);
    if (!cupboard || !event.object) return false;
    swapObject(event.object, cupboard.open);
    return true;
  }

  function closeCupboard(event) {
    const cupboard = OPEN_CUPBOARDS.get(event.objectId);
    if (!cupboard || !event.object) return false;
    swapObject(event.object, cupboard.closed);
    return true;
  }

  function searchCupboard(event) {
    const cupboard = OPEN_CUPBOARDS.get(event.objectId);
    if (!cupboard) return false;
    const { player } = event;
    if (held(player, cupboard.itemId)) {
      // No capture of a second search: the wording is ours.
      player.sendMessage("You find nothing more of use in the cupboard.");
    } else if (player.getInventory().getFreeSlots() === 0) {
      player.getInventory().full();
    } else {
      player.getInventory().adds(cupboard.itemId, 1);
      startTranscript(api, player, TERRY_BALANDO_NPC_ID, PAGE, cupboard.variant);
    }
    return true;
  }

  /** Wiki: 25 Thieving, 10 Herblore and 10 Agility. */
  const REQUIRED_SKILLS = [
    { skill: Skill.THIEVING, level: 25, label: "Thieving" },
    { skill: Skill.HERBLORE, level: 10, label: "Herblore" },
    { skill: Skill.AGILITY, level: 10, label: "Agility" },
  ];

  function missingSkillRequirements(player) {
    const skills = player.getSkillManager();
    return REQUIRED_SKILLS.filter((requirement) => skills.getMaxLevel(requirement.skill) < requirement.level);
  }

  function meetsSkillRequirements(player) {
    return missingSkillRequirements(player).length === 0;
  }

  function notifySkillRequirements(player) {
    for (const requirement of missingSkillRequirements(player)) {
      player.sendMessage(
        `You need a ${requirement.label} level of at least ${requirement.level} to start this quest.`
      );
    }
  }

  function handleStartHook({ player, npcId, hook }) {
    if (!EXAMINER_NPC_IDS.has(npcId) || hook !== START_HOOK) return;
    if (quest.getStage(player) < STAGE_STARTED) {
      if (!meetsSkillRequirements(player)) {
        notifySkillRequirements(player);
        return;
      }
      quest.setStage(player, STAGE_STARTED);
      player.setAttribute(STAMPED_ATTRIBUTE, false);
      player.setAttribute(DELIVERED_ATTRIBUTE, false);
      // "You can if you get this letter stamped by the Curator of Varrock's museum."
      giveLetter(player, UNSTAMPED_LETTER_ITEM_ID);
    }
  }

  /** The letters used on the examiner and the curator. */
  function handleItemOnNpc(event) {
    const { player, itemId } = event;
    const targetId = event.npcId ?? event.target?.getId?.();
    if (targetId === PANNING_GUIDE_NPC_ID && (itemId === TEA_ITEM_ID || NETTLE_TEA_IDS.includes(itemId))) {
      event.handled = true;
      const accepted = acceptTea(player, event.slot);
      const text = !accepted ? "You're free to pan all you want." : itemId === TEA_ITEM_ID ? TEA_THANKS : NETTLE_TEA_THANKS;
      player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new NpcDialogue(0, targetId, text)));
      return;
    }
    if (player && !event.handled && discovery.handleItemOnNpc(event)) return;
    if (!player || (itemId !== UNSTAMPED_LETTER_ITEM_ID && itemId !== STAMPED_LETTER_ITEM_ID)) return;
    if (EXAMINER_NPC_IDS.has(targetId)) {
      event.handled = true;
      if (itemId === UNSTAMPED_LETTER_ITEM_ID) {
        startTranscript(api, player, targetId, PAGE, "starting-the-quest-using-an-unstamped-letter-on-the-examiner");
      } else if (awaitingLetter(player)) {
        deliverLetter(player);
        startTranscript(api, player, targetId, PAGE, "the-first-exam-taking-the-exam");
      } else {
        startTranscript(api, player, targetId, PAGE, "the-first-exam-taking-the-exam-using-another-stamped-letter-on-the-examiner");
      }
    } else if (targetId === CURATOR_NPC_ID) {
      event.handled = true;
      if (itemId === STAMPED_LETTER_ITEM_ID) {
        startTranscript(api, player, targetId, PAGE, "starting-the-quest-getting-the-curator-s-approval-using-the-stamped-letter-on-the-curator");
      } else if (awaitingLetter(player)) {
        const first = !stamped(player);
        stampLetter(player);
        startTranscript(api, player, targetId, PAGE, first
          ? "starting-the-quest-getting-the-curator-s-approval"
          : "starting-the-quest-getting-the-curator-s-approval-talking-the-curator-again");
      } else {
        event.handled = false;
      }
    }
  }

  function handleGuideLine(event) {
    if (event.npcId !== PANNING_GUIDE_NPC_ID || (event.text !== TEA_THANKS && event.text !== NETTLE_TEA_THANKS)) return;
    event.before = () => {
      const id = event.text === TEA_THANKS ? TEA_ITEM_ID : NETTLE_TEA_IDS.find((id) => held(event.player, id));
      if (id !== undefined) acceptTea(event.player, event.player.getInventory().getSlotForItemId(id));
    };
  }

  /** The discovery's message and action steps: its item boxes and hand-overs, the descent, the blast, the quest's end. */
  function handleAction(event) {
    if (!event.player || !DIALOGUE_NPC_IDS.has(event.npcId)) return;
    discovery.handleAction(event);
  }

  function handleLogin({ player }) {
    stageNow(player);
    refreshQuestList(player);
    player.getPacketSender().sendVarbit(PANNING_PERMISSION_VARBIT, Number(canPan(player)));
    discovery.syncVarbits(player);
  }

  /** Wiki, Signpost (Digsite): what each dig's signpost reads. */
  const SIGNPOSTS = new Map([
    [ObjectIdentifiers.SIGNPOST_13, "This site is for training purposes only."], // digsigntrain
    [ObjectIdentifiers.SIGNPOST_14, "Level 1 digs only."], // digsign1
    [ObjectIdentifiers.SIGNPOST_15, "Level 2 digs only."], // digsign2
    [ObjectIdentifiers.SIGNPOST_16, "Level 3 digs only."], // digsign3
    [ObjectIdentifiers.SIGNPOST_17, "Private dig."], // digsignprivate
  ]);

  function readSignpost({ player, objectId }) {
    const text = SIGNPOSTS.get(objectId);
    if (text === undefined) return false;
    player.sendMessage(text);
    return true;
  }

  const digging = createDigSiteDigging(api, { held, owned, stageNow, STAGE_STARTED, STAGE_EXAMS_DONE });
  const discovery = createDigSiteDiscovery(api, {
    PAGE, STAGE_EXAMS_DONE, STAGE_INVITED, STAGE_SHAFTS, STAGE_POURED, STAGE_BLOWN, held, owned, stageNow, swapObject,
    nearestWorkman: digging.nearestWorkman, quest: () => quest,
  });
  if (api.core.WorldDefinition.isMembersWorld()) {
    api.registerDefinitionSource("ground_items", { name: "the-dig-site-arcenia-roots", load: discovery.groundItems });
  }

  api.persistAttribute(STAMPED_ATTRIBUTE, false);
  api.persistAttribute(DELIVERED_ATTRIBUTE, false);
  api.persistAttribute(PANNING_PERMISSION, false);
  for (const student of STUDENT_LOST_ITEM.values()) api.persistAttribute(student.attribute, 0);
  api.persistAttribute(LEARNED_ATTRIBUTE, 0);
  api.persistAttribute(OPAL_ATTRIBUTE, 0);
  api.persistAttribute(discovery.DISCOVERY_ATTRIBUTE, 0);
  quest = registerQuest(api, {
    key: "the_dig_site",
    name: "The Dig Site",
    varpId: VARP_DIG_SITE,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 2,
    xpRewards: [
      { skillId: Skill.MINING.getIndex(), amount: 15300, label: "Mining" },
      { skillId: Skill.HERBLORE.getIndex(), amount: 2000, label: "Herblore" },
    ],
    // Ours (upstream issue #6215): the talisman is the scroll's picture only. As rewardItemId it was handed over
    // again on completion, a second one beside the one the player already carried (Wiki, Rewards: no talisman).
    scrollItemId: ItemIdentifiers.ANCIENT_TALISMAN,
    otherRewards: ["2 gold bars", "Access to the Dig Site's deeper dig shafts"],
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcInteraction("Examiner", { "Talk-to": talkToExaminer });
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:choice", handleChoice);
  api.onCustomEvent("npc-dialogue:condition", handleCondition);
  api.onObjectInteraction("Cupboard", { Open: openCupboard, Close: closeCupboard, Search: searchCupboard });
  api.onObjectInteraction("Bush", { Search: searchTeddyBush });
  api.onObjectInteraction("Panning point", { Pan: pan });
  api.onItemAction("Panning tray", { Search: searchTray });
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onCustomEvent("npc-dialogue:line", handleGuideLine);
  api.onCustomEvent("npc-dialogue:line", discovery.handleLine);
  api.onItemOnNpc(handleItemOnNpc);
  // The digs (during the quest and outside it) and the discovery.
  api.onObjectInteraction("Signpost", { Read: readSignpost });
  api.onObjectInteraction("Specimen tray", { Search: digging.searchTray });
  api.onObjectInteraction("Sacks", { Search: digging.searchSacks });
  api.onItemOnObject(digging.handleItemOnObject, { noted: false });
  api.onItemOnObject(discovery.handleItemOnObject, { noted: false });
  api.onItemOnItem(discovery.handleItemOnItem);
  api.onItemDropPolicy(discovery.handleItemDropPolicy);
  api.onObjectInteraction("Winch", { Operate: discovery.operateWinch });
  api.onObjectInteraction("Rope", { "Climb-up": discovery.climbRope });
  api.onObjectInteraction("Chest", { Open: discovery.openChest, Search: discovery.searchChest, Close: discovery.closeChest });
  api.onObjectInteraction("Barrel", { Open: discovery.openBarrel, Search: discovery.searchBarrel });
  api.onObjectInteraction("Brick", { Search: discovery.searchBricks });
  api.onObjectInteraction("Stone Tablet", { Take: discovery.takeTablet });
  api.onItemAction("Invitation letter", { Read: discovery.readLetter });
  api.onItemAction("Stone tablet", { Read: discovery.readTablet });
  api.onItemAction("Unidentified liquid", { Empty: discovery.emptyLiquid });
  api.onNpcInteraction("Doug Deeping", { "Steal-from": discovery.stealFromDoug });
  api.onPlayerLogin(handleLogin);
};
