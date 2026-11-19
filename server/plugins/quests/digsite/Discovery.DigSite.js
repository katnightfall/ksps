/**
 * The Dig Site, "Making a discovery": everything after the third certificate. The words are the transcript's
 * ("The Dig Site" page, and the "Terry Balando", "Digsite workman" and "Doug Deeping" pages for what is said outside
 * the quest's own page); the ids and tiles are the cache's.
 *
 * In order (Wiki: The Dig Site, its Quick guide and transcript, and the page of each item and place):
 * - the ancient talisman is dug up at a level 3 dig (Digging.DigSite.js) and shown to Terry Balando, by talking to
 *   him or using it on him; he keeps it and writes the invitation letter (stage 5);
 * - the letter is used on a Digsite workman, who keeps it: the winches may now be used (stage 6);
 * - a rope is tied to each winch (it stays there: "2 ropes" on the quest's page) and Operate, with 10 Agility,
 *   lowers the player into that winch's shaft. The north-east winch (digwinch2) leads to Doug Deeping, who hands
 *   over the chest key; the west winch (digwinch1) to arcenia roots and the bricks;
 * - the key opens the chest in the panning tent (the key is used up; the chest stands open three minutes, for
 *   anyone) and a search finds the chemical powder; a trowel levers the lid off the barrel west of the tent and a
 *   vial takes the unidentified liquid, after which the lid goes back; Terry names the two (all the player
 *   carries of each) ammonium nitrate and nitroglycerin;
 * - ammonium nitrate on nitroglycerin (6 Herblore) makes mixed chemicals; ground charcoal on those (8) the second
 *   mixture; an arcenia root on that (10) the chemical compound. Any other pairing is not a step;
 * - the compound is poured on the bricks (stage 7) and lit with a tinderbox: the wall is gone (stage 8). The cache
 *   holds the dungeon twice (Wiki, Arcenia root: "the dungeon after the explosion is actually a separate copy"):
 *   the map square at 3328,9792 with the brick (digblastbrick) and the one at 3328,9728 without it. The west winch
 *   lowers a player into the first until they have blown the wall, and into the second from then on;
 * - the stone tablet (a multiloc on itdigsitetablet) is taken from the altar room and Terry ends the quest for it.
 *
 * The stages from 6 on are the live game's values of varp 131, which the Quest Helper (upstream's TheDigSite, run by
 * tools/quest-helper-bridge) reads: 6 the shafts, 7 the compound poured, 8 the wall blown. It reads the varbits sent
 * here too (itexpertletter, itdigsitewinch1 and 2, itdigsitehint, itdigsitebarrel), and its zones are the two copies
 * of the dungeon used here: the first copy with Doug's room for the shafts before the blast, the second after it.
 * Stages 7 and 8 were also the stand-in's stages before this was built (see DigSite.Quest.js); a save at either
 * without CURRENT_STAGES in DISCOVERY_ATTRIBUTE is one of those (isLegacyStage).
 *
 * State kept: the stage, and DISCOVERY_ATTRIBUTE, a set of bits for the two ropes, the barrel's lid, the searched
 * bricks and whether the stage was set by this code. A completed quest counts as both ropes tied and the wall
 * blown, whatever the bits say: a quest completed before this half was built never set them.
 *
 * Not sourced (no recording; plain and listed in the quest file's header): the animations of every step here, the
 * explosion's graphic, sound and the run to the entrance (the player is put at the foot of the rope), the tile a
 * descent lands on (the free tile north of each rope), the words for a locked chest, for mixing the first two
 * mixtures, for too low a Herblore level and for emptying the vial, what a dropped mixture says overhead, and where
 * the arcenia roots lie before the blast (see ROOTS_BEFORE_BLAST).
 */
module.exports = function createDigSiteDiscovery(api, ctx) {
  const { CacheDefinitions, HitDamage, HitMask, Item, ItemDefinition, ItemIdentifiers: I, Location, MapObjects,
    NpcIdentifiers, ObjectIdentifiers, Skill, Task, TaskManager } = api.core;
  const { startTranscript, giveReward } = require("../QuestRuntime");
  const { PAGE, STAGE_EXAMS_DONE, STAGE_INVITED, STAGE_SHAFTS, STAGE_POURED, STAGE_BLOWN, held, owned, stageNow,
    swapObject, nearestWorkman } = ctx;
  const quest = () => ctx.quest();

  const TERRY_PAGE = "Terry Balando";
  const WORKMAN_PAGE = "Digsite workman";
  const DOUG_PAGE = "Doug Deeping";
  const TERRY = NpcIdentifiers.TERRY_BALANDO;
  const DOUG = NpcIdentifiers.DOUG_DEEPING;
  const WORKMAN_NPC_IDS = new Set([NpcIdentifiers.DIGSITE_WORKMAN, NpcIdentifiers.DIGSITE_WORKMAN_2, NpcIdentifiers.DIGSITE_WORKMAN_3]);

  const DISCOVERY_ATTRIBUTE = "quest.the_dig_site.discovery";
  const ROPE_WEST = 1 << 0;
  const ROPE_NORTH_EAST = 1 << 1;
  const BARREL_OPEN = 1 << 2;
  const BRICKS_SEARCHED = 1 << 3;
  /** The stage was set by this code (5 to 8), not by the stand-in that used 7 and 8 for other things. */
  const CURRENT_STAGES = 1 << 4;
  // Varp itdigsitemulti (135), by the cache's names.
  const VARBIT_WINCH_1 = 2545; // itdigsitewinch1
  const VARBIT_WINCH_2 = 2546; // itdigsitewinch2
  const VARBIT_BARREL = 2547; // itdigsitebarrel: digbarrelclosed shows qip_digsite_barrel (0) or _open (1)
  const VARBIT_TABLET = 2548; // itdigsitetablet: the tablet's multiloc shows the tablet (0) or bare floor (1)
  const VARBIT_HINT = 2549; // itdigsitehint: the bricks have been searched
  const VARBIT_EXPERT_LETTER = 2550; // itexpertletter: Terry has written the invitation

  /**
   * The two winches (cache map) and where each lowers the player: the free tile north of the shaft's rope. Coming
   * back up is the rope's Climb-up; two of the three ropes have a captured landing (loc-teleports.json, winchladder1
   * and winchladder2) and the third, the west shaft's before the wall is blown, lands where its twin does.
   */
  const WEST_WINCH = { bit: ROPE_WEST, varbit: VARBIT_WINCH_1, privateDig: false,
    landing: [3369, 9827, 0], landingBlown: [3369, 9763, 0] }; // digwinch1 at 3352,3417
  const NORTH_EAST_WINCH = { bit: ROPE_NORTH_EAST, varbit: VARBIT_WINCH_2, privateDig: true,
    landing: [3352, 9817, 0], landingBlown: [3352, 9817, 0] }; // digwinch2 at 3370,3428
  const WINCHES = new Map([
    [ObjectIdentifiers.WINCH_2, WEST_WINCH],
    [ObjectIdentifiers.WINCH_3, NORTH_EAST_WINCH],
  ]);
  /** winchladder2 in the dungeon's first copy (bricks standing): up to the tile its captured twin at 3369,9762 lands on. */
  const BLOCKED_SHAFT_ROPE = { id: ObjectIdentifiers.ROPE_3, x: 3369, y: 9826, to: [3354, 3417, 0] };
  /**
   * Arcenia roots in the first copy of the dungeon, the one a player is in until the wall is blown. ground-items.json
   * (from the Wiki's Arcenia root spawns) has them only in the second copy, where a player comes only after the blast,
   * so the root the compound needs could not be had. The Wiki names no tiles for the first copy (its trivia: the
   * spawns "seem to shift" after the blast), only two in Doug Deeping's room and two by the west shaft's rope (Digsite
   * Dungeon); these are the second copy's four tiles in the first, 64 tiles north, the same ground in both copies.
   * Respawn 100 ticks as there (Wiki, Arcenia root).
   */
  const ROOTS_BEFORE_BLAST = [[3347, 9818], [3350, 9823], [3364, 9828], [3368, 9834]];
  const WINCH_AGILITY_LEVEL = 10;
  const WINCH_AGILITY_EXPERIENCE = 2; // Wiki, Winch: Agility info
  const CHEST_CLOSED = ObjectIdentifiers.CHEST_9; // digchestclosed at 3374,3378
  const CHEST_OPEN = ObjectIdentifiers.CHEST_8; // digchestopen
  const CHEST_OPEN_TICKS = 300; // Wiki, Chest (Chemical powder): "The chest remains open for 3 minutes"
  const BRICK = ObjectIdentifiers.BRICK_8; // digblastbrick at 3378,9824
  const barrelId = () => CacheDefinitions.getLocId("digbarrelclosed"); // the multiloc at 3364,3378
  const tabletId = () => CacheDefinitions.getLocId("qip_digsite_zaros_stone_tablet_multiloc"); // at 3373,9746

  // ---- Variants ----
  const V = {
    talisman: "making-a-discovery-talking-to-terry-balando",
    terryAgain: "making-a-discovery-talking-to-terry-again",
    terryAfterWorkman: "making-a-discovery-talking-to-terry-again-talking-to-terry-after-giving-the-workman-the-invitation",
    letterOnTerry: "making-a-discovery-talking-to-terry-again-using-the-invitation-on-terry",
    readLetter: "making-a-discovery-talking-to-terry-again-reading-the-invitation",
    giveWorkman: "making-a-discovery-talking-to-terry-again-giving-a-workman-the-invitation",
    secondLetter: "making-a-discovery-talking-to-terry-again-using-a-second-invitation-on-a-workman",
    winch: "making-a-discovery-operating-the-winch",
    ropeOnWinch: "making-a-discovery-operating-the-winch-using-a-rope-on-the-winch",
    searchBricks: "making-a-discovery-searching-the-bricks",
    doug: "making-a-discovery-talking-to-doug-deeping",
    searchChest: "making-a-discovery-creating-the-explosive-searching-the-chest",
    openBarrel: "making-a-discovery-creating-the-explosive-opening-the-barrel",
    searchShutBarrel: "making-a-discovery-creating-the-explosive-searching-the-barrel",
    trowelOnBarrel: "making-a-discovery-creating-the-explosive-using-a-trowel-on-the-barrel",
    searchOpenBarrel: "making-a-discovery-creating-the-explosive-searching-the-barrel-2",
    vialOnBarrel: "making-a-discovery-creating-the-explosive-using-a-vial-on-the-barrel",
    identifyLiquid: "making-a-discovery-creating-the-explosive-identifying-the-liquid",
    identifyPowder: "making-a-discovery-creating-the-explosive-identifying-the-powder",
    rootAdded: "making-a-discovery-creating-the-explosive-adding-the-arcenia-root-to-the-mixed-chemicals",
    tinderboxTooSoon: "making-a-discovery-creating-the-explosive-using-a-tinderbox-on-the-bricks-before-pouring-the-mixture-on-them",
    rockPickOnBricks: "making-a-discovery-creating-the-explosive-using-a-rock-pick-on-the-bricks",
    pickaxeOnBricks: "making-a-discovery-creating-the-explosive-using-a-pickaxe-on-the-bricks",
    pour: "making-a-discovery-spreading-the-mixture",
    light: "making-a-discovery-lighting-the-mixture",
    readTablet: "making-a-discovery-reading-the-stone-tablet",
    turnIn: "making-a-discovery-turning-in-the-stone-table",
    westWinchRefused: "standard-dialogue-trying-to-use-the-western-winch-before-getting-permission",
    dougSteal: "standard-dialogue-after-the-dig-site-attempting-to-steal-from-him",
    trayOnTerry: "using-items-using-a-panning-tray-on-him",
    nuggetsOnTerry: "using-items-using-nuggets-on-him",
  };
  /** The last line of the talisman conversation: here the talisman changes hands for the letter. */
  const LETTER_LINE = "You obviously have a keen eye. Take this letter";
  // Step ids of the "The Dig Site" record.
  const STEP = {
    stillHasLetter: "EuXkaR", letterInBank: "Pm9s8G", lostLetter: "15z9zB",
    beforeRope: "xR7qHp", afterRope: "T8N-_j", withoutAgility: "bc16tV", withAgility: "Jajh5V", inCavern: "KNT8nr",
    noKey: "d7Muu3", hasKey: "C9F0Ny", dougHandsKey: "myn9J4",
    lidBack: "I7_JSu", runToEntrance: "nPRQNy", complete: "NwSdYK",
  };
  // Step ids of the "Terry Balando" record.
  const TERRY_STEP = {
    emptyTray: "vgbqiO", fullTray: "h6ecLT",
    fewNuggets: "Envesa", enoughNuggets: "Zcy1bp", givesNuggets: "D2k2aH",
  };
  const NUGGETS_PER_ORE = 3; // Terry Balando: "Come back when you have 3 and I will exchange them for you."
  /** The transcript's item boxes ({{tbox|pic=...}}): message step -> the item pictured. */
  const BOXES = new Map([
    ["RiLE3G", I.ANCIENT_TALISMAN], // You find a strange talisman.
    [STEP.dougHandsKey, I.CHEST_KEY_2], // Doug hands you a key.
    ["5VvL0Z", I.CHEMICAL_POWDER], // You find some unusual powder inside...
    ["LDH6dJ", I.UNIDENTIFIED_LIQUID], // You fill the vial with the liquid.
    ["jxyD7b", I.GOLD_BAR], // The expert gives you 2 gold bars as payment.
  ]);
  /**
   * "Terry Balando" page: {{tbox|...}} with no picture: "The expert has already seen the talisman." and "The expert
   * cleans off the mud." (the special cup).
   */
  const STATEMENT_BOXES = new Set(["jsjesp", "OGemUG"]);
  /** "Terry Balando" page, "Using items": what he says of each thing shown him that changes nothing. */
  const TERRY_ITEM_VARIANTS = new Map([
    [I.NITROGLYCERIN, "using-items-using-nitroglycerin-on-him"],
    [I.AMMONIUM_NITRATE, "using-items-using-ammonium-nitrate-on-him"],
    [I.MIXED_CHEMICALS, "using-items-using-mixed-chemicals-on-him"],
    [I.MIXED_CHEMICALS_2, "using-items-using-mixed-chemicals-with-charcoal-added-on-him"],
    [I.CHEMICAL_COMPOUND, "using-items-using-the-chemical-compound-on-him"],
    [I.NEEDLE, "using-items-using-a-needle-on-him"],
    [I.ROTTEN_APPLE, "using-items-using-a-rotten-apple-on-him"],
    [I.BROKEN_GLASS, "using-items-using-broken-glass-on-him"],
    [I.BROKEN_ARROW, "using-items-using-a-broken-arrow-on-him"],
    [I.BONES, "using-items-using-bones-on-him"],
    [I.BUTTONS, "using-items-using-buttons-on-him"],
    [I.CRACKED_SAMPLE, "using-items-using-a-cracked-sample-on-him"],
    [I.OLD_TOOTH, "using-items-using-an-old-tooth-on-him"],
    [I.RUSTY_SWORD, "using-items-using-a-rusty-sword-on-him"],
    [I.BROKEN_STAFF, "using-items-using-a-broken-staff-on-him"],
    [I.BROKEN_ARMOUR, "using-items-using-broken-armour-on-him"],
    [I.DAMAGED_ARMOUR, "using-items-using-damaged-armour-on-him"],
    [I.CERAMIC_REMAINS, "using-items-using-ceramic-remains-on-him"],
    [I.BELT_BUCKLE, "using-items-using-a-belt-buckle-on-him"],
    [I.ANIMAL_SKULL, "using-items-using-an-animal-skull-on-him"],
    [I.SPECIAL_CUP, "using-items-using-the-special-cup-on-him"],
    [I.TEDDY, "using-items-using-teddy-on-him"],
    [I.OLD_BOOT, "using-items-using-an-old-boot-on-him"],
  ]);
  /** The three panning trays (empty, nuggets, mud): only the empty one "is empty". */
  const PANNING_TRAYS = [I.PANNING_TRAY, I.PANNING_TRAY_2, I.PANNING_TRAY_3];
  /**
   * Wiki, Mixed chemicals and Chemical compound: the three mixtures in their order, each with its Herblore level
   * (boostable) and experience (2, 2.5 and 3: 7.5 in all). The vial of the second item becomes the product and the
   * first item is used up.
   */
  const MIXTURES = [
    { add: I.AMMONIUM_NITRATE, to: I.NITROGLYCERIN, level: 6, experience: 2, product: I.MIXED_CHEMICALS },
    { add: I.GROUND_CHARCOAL, to: I.MIXED_CHEMICALS, level: 8, experience: 2.5, product: I.MIXED_CHEMICALS_2 },
    { add: I.ARCENIA_ROOT, to: I.MIXED_CHEMICALS_2, level: 10, experience: 3, product: I.CHEMICAL_COMPOUND, variant: V.rootAdded },
  ];
  /**
   * Wiki, Nitroglycerin, Mixed chemicals and Chemical compound: a dropped vial bursts, is lost, and hurts, never to
   * death ("at most reducing them to a single hitpoint"). The overhead words are the pages'; the two mixtures' pages
   * give none.
   */
  const VOLATILE = new Map([
    [I.UNIDENTIFIED_LIQUID, { damage: 25, says: "Ow! The liquid exploded!" }],
    [I.NITROGLYCERIN, { damage: 35, says: "Ow! the nitroglycerin exploded!" }],
    [I.MIXED_CHEMICALS, { damage: 45 }],
    [I.MIXED_CHEMICALS_2, { damage: 55 }],
    [I.CHEMICAL_COMPOUND, { damage: 65, harmlessSays: "Ow! That really hurt!" }],
  ]);
  // No capture of these: the wording is ours.
  const CHEST_LOCKED = "The chest is locked.";
  const MIXED = "You mix the chemicals together.";
  const EMPTIED = "You empty the vial.";
  const needsHerblore = (level) => `You need a Herblore level of ${level} to mix these chemicals.`;
  // Wiki, Winch: the private dig's winch before permission.
  const PRIVATE_WINCH_MESSAGES = ["There is a sign on the winch.", "Private area - invitation only."];

  /** player -> the winch being operated, for the conversation's conditions. */
  const operating = new WeakMap();
  /** player -> the panning tray just shown to Terry, for his conversation's conditions. */
  const shownTray = new WeakMap();
  let chestOpenings = 0;

  const bits = (player) => Number(player.getAttribute(DISCOVERY_ATTRIBUTE)) || 0;
  const has = (player, bit) => (bits(player) & bit) !== 0;
  const put = (player, bit, on = true) => player.setAttribute(DISCOVERY_ATTRIBUTE, on ? bits(player) | bit : bits(player) & ~bit);
  const complete = (player) => quest().isComplete(player);
  /** The workman has the letter (or the quest is done): the winches may be used. */
  const hasAccess = (player) => stageNow(player) >= STAGE_SHAFTS;
  const roped = (player, winch) => complete(player) || has(player, winch.bit);
  const blown = (player) => complete(player) || stageNow(player) >= STAGE_BLOWN;
  const poured = (player) => !complete(player) && stageNow(player) === STAGE_POURED;
  const bricksSearched = (player) => has(player, BRICKS_SEARCHED);
  const say = (player, variant, npcId = TERRY, page = PAGE, npc = null) => startTranscript(api, player, npcId, page, variant, undefined, npc);

  /** A stage 7 or 8 that this code did not set: the stand-in's "carrying the compound" or "carrying the talisman". */
  function isLegacyStage(player, stage) {
    return (stage === STAGE_POURED || stage === STAGE_BLOWN) && !has(player, CURRENT_STAGES);
  }

  /** Moves the discovery on: the stage, marked as this code's, and what the player sees of it. */
  function setStage(player, stage) {
    put(player, CURRENT_STAGES);
    quest().setStage(player, stage);
    syncVarbits(player);
  }

  function syncVarbits(player) {
    const sender = player.getPacketSender();
    for (const winch of WINCHES.values()) sender.sendVarbit(winch.varbit, Number(roped(player, winch)));
    sender.sendVarbit(VARBIT_BARREL, Number(has(player, BARREL_OPEN)));
    sender.sendVarbit(VARBIT_HINT, Number(bricksSearched(player)));
    sender.sendVarbit(VARBIT_EXPERT_LETTER, Number(complete(player) || quest().getStage(player) >= STAGE_INVITED));
    syncTablet(player);
  }

  /**
   * Wiki, Stone tablet (The Dig Site): another lies there once the player's own is banked or dropped outside, and
   * "it can also be obtained after the quest". So the altar shows a tablet to a player who carries none, as from
   * their next descent (a tablet dropped in the cave does not bring another back while they are there).
   */
  function syncTablet(player) {
    player.getPacketSender().sendVarbit(VARBIT_TABLET, Number(held(player, I.STONE_TABLET)));
  }

  function setBarrel(player, open) {
    put(player, BARREL_OPEN, open);
    player.getPacketSender().sendVarbit(VARBIT_BARREL, Number(open));
  }

  /** Every one of `from` the player carries becomes `to` (Wiki, Nitroglycerin: "all vials in your inventory"). */
  function convertAll(player, from, to) {
    const inventory = player.getInventory();
    inventory.getItems().forEach((item, slot) => {
      if (item?.getId() === from) inventory.setItem(slot, new Item(to, item.getAmount()));
    });
    inventory.refreshItems();
  }

  // ---- Terry Balando ----

  /** Terry's conversation by where the discovery stands; null leaves him his own page's. */
  function terryVariant(player) {
    const stage = stageNow(player);
    if (complete(player)) return { page: TERRY_PAGE, variant: "after-the-dig-site" };
    if (stage >= STAGE_BLOWN && held(player, I.STONE_TABLET)) return V.turnIn;
    if (stage >= STAGE_SHAFTS) return V.terryAfterWorkman;
    if (stage === STAGE_INVITED) return V.terryAgain;
    if (stage === STAGE_EXAMS_DONE && held(player, I.ANCIENT_TALISMAN)) return V.talisman;
    return null;
  }

  /** "Take this letter and give it to one of the workmen": the talisman for the invitation, once. */
  function takeTalisman(player) {
    if (stageNow(player) !== STAGE_EXAMS_DONE || !held(player, I.ANCIENT_TALISMAN)) return;
    player.getInventory().deleteNumber(I.ANCIENT_TALISMAN, 1);
    giveReward(player, I.INVITATION_LETTER, 1);
    setStage(player, STAGE_INVITED);
  }

  /** "I lost the letter you gave me.": he writes another only for a player who has none, carried or banked. */
  function replaceLetter(player) {
    const stage = stageNow(player);
    if (stage < STAGE_INVITED || complete(player) || owned(player, I.INVITATION_LETTER)) return;
    giveReward(player, I.INVITATION_LETTER, 1);
  }

  /** The tablet for the reward: the quest's end. */
  function turnIn(player) {
    if (complete(player) || stageNow(player) < STAGE_BLOWN || !held(player, I.STONE_TABLET)) return;
    player.getInventory().deleteNumber(I.STONE_TABLET, 1);
    quest().complete(player);
    syncVarbits(player);
  }

  /** "Player gives 3 nuggets." and "receives a Gold ore", in one: what does not fit goes on the floor. */
  function exchangeNuggets(player) {
    if (!held(player, I.NUGGETS, NUGGETS_PER_ORE)) return;
    player.getInventory().deleteNumber(I.NUGGETS, NUGGETS_PER_ORE);
    giveReward(player, I.GOLD_ORE, 1);
  }

  /** An item used on Terry Balando; true when he had something to say about it. */
  function useOnTerry(player, itemId, npc) {
    const stage = stageNow(player);
    const play = (variant, page = PAGE) => say(player, variant, TERRY, page, npc);
    switch (itemId) {
      case I.ANCIENT_TALISMAN:
        if (stage < STAGE_EXAMS_DONE) return false;
        return stage === STAGE_EXAMS_DONE ? play(V.talisman) : play("using-items-using-another-ancient-talisman-on-him", TERRY_PAGE);
      case I.INVITATION_LETTER:
        return play(V.letterOnTerry);
      case I.CHEMICAL_POWDER:
        convertAll(player, I.CHEMICAL_POWDER, I.AMMONIUM_NITRATE);
        return play(V.identifyPowder);
      case I.UNIDENTIFIED_LIQUID:
        convertAll(player, I.UNIDENTIFIED_LIQUID, I.NITROGLYCERIN);
        return play(V.identifyLiquid);
      case I.STONE_TABLET:
        if (complete(player)) return play("using-items-using-stone-tablet-on-him-post-quest", TERRY_PAGE);
        return stage >= STAGE_BLOWN ? play(V.turnIn) : false;
      case I.NUGGETS:
        return play(V.nuggetsOnTerry, TERRY_PAGE);
      case I.PANNING_TRAY:
      case I.PANNING_TRAY_2:
      case I.PANNING_TRAY_3:
        shownTray.set(player, itemId);
        return play(V.trayOnTerry, TERRY_PAGE);
      default: {
        const variant = TERRY_ITEM_VARIANTS.get(itemId);
        return variant ? play(variant, TERRY_PAGE) : false;
      }
    }
  }

  // ---- The workmen and Doug Deeping ----

  /** The invitation used on a Digsite workman. */
  function useOnWorkman(player, itemId, npcId, npc) {
    if (itemId !== I.INVITATION_LETTER) return false;
    const stage = stageNow(player);
    if (stage < STAGE_INVITED) return false;
    if (stage === STAGE_INVITED) {
      player.getInventory().deleteNumber(I.INVITATION_LETTER, 1);
      setStage(player, STAGE_SHAFTS);
      return say(player, V.giveWorkman, npcId, PAGE, npc);
    }
    return say(player, V.secondLetter, npcId, PAGE, npc);
  }

  const workmanVariant = (player) => complete(player) ? { page: WORKMAN_PAGE, variant: "after-the-dig-site" } : null;
  const dougVariant = (player) => complete(player) ? { page: DOUG_PAGE, variant: "standard-dialogue-after-the-dig-site" } : V.doug;

  function stealFromDoug({ player, npc, npcId }) {
    if (npcId !== DOUG) return false;
    return say(player, V.dougSteal, DOUG, DOUG_PAGE, npc ?? null);
  }

  // ---- The winches and shafts ----

  function refuseWinch(player, winch) {
    if (winch.privateDig) {
      for (const text of PRIVATE_WINCH_MESSAGES) player.sendMessage(text);
      return;
    }
    const npc = nearestWorkman(player);
    say(player, V.westWinchRefused, npc?.getId() ?? NpcIdentifiers.DIGSITE_WORKMAN, WORKMAN_PAGE, npc);
  }

  function operateWinch(event) {
    const winch = WINCHES.get(event.objectId);
    if (!winch) return false;
    const { player } = event;
    if (!hasAccess(player)) {
      refuseWinch(player, winch);
      return true;
    }
    operating.set(player, winch);
    say(player, V.winch);
    return true;
  }

  function tieRope(event, winch) {
    const { player } = event;
    if (!hasAccess(player)) {
      refuseWinch(player, winch);
      return true;
    }
    if (roped(player, winch)) return false;
    player.getInventory().deleteAtSlot(event.itemSlot);
    put(player, winch.bit);
    player.getPacketSender().sendVarbit(winch.varbit, 1);
    say(player, V.ropeOnWinch);
    return true;
  }

  /** "You lower yourself into the shaft.": down the rope, into the copy of the dungeon the player's wall stands in. */
  function descend(player) {
    const winch = operating.get(player);
    operating.delete(player);
    if (!winch || !hasAccess(player) || !roped(player, winch)) return;
    player.getSkillManager().addExperiences(Skill.AGILITY, WINCH_AGILITY_EXPERIENCE);
    syncTablet(player);
    player.moveTo(new Location(...(blown(player) ? winch.landingBlown : winch.landing)));
  }

  function climbRope(event) {
    const { player, objectId, location } = event;
    const rope = BLOCKED_SHAFT_ROPE;
    if (objectId !== rope.id || location?.x !== rope.x || location?.y !== rope.y) return false;
    player.moveTo(new Location(...rope.to));
    return true;
  }

  /** The roots of ROOTS_BEFORE_BLAST, as ground_items definitions. */
  function groundItems() {
    return ROOTS_BEFORE_BLAST.map(([x, y]) => ({ id: I.ARCENIA_ROOT, location: { x, y, z: 0 }, amt: 1, respawn: 100, members: true }));
  }

  // ---- The chest and the barrel ----

  function unlockChest(player, object) {
    if (!held(player, I.CHEST_KEY_2)) {
      player.sendMessage(CHEST_LOCKED);
      return;
    }
    // Wiki, Chest key (Digsite): each key opens the chest once (more powder needs more keys).
    player.getInventory().deleteNumber(I.CHEST_KEY_2, 1);
    const location = object.getLocation().clone();
    const area = object.getPrivateArea?.() ?? null;
    swapObject(object, CHEST_OPEN);
    const opening = ++chestOpenings;
    TaskManager.submit(new (class extends Task {
      constructor() { super(CHEST_OPEN_TICKS, false); }
      execute() {
        this.stop();
        const open = opening === chestOpenings ? MapObjects.get(CHEST_OPEN, location, area) : null;
        if (open) swapObject(open, CHEST_CLOSED);
      }
    })());
  }

  function openChest(event) {
    if (event.objectId !== CHEST_CLOSED || !event.object) return false;
    unlockChest(event.player, event.object);
    return true;
  }

  function closeChest(event) {
    if (event.objectId !== CHEST_OPEN || !event.object) return false;
    chestOpenings++;
    swapObject(event.object, CHEST_CLOSED);
    return true;
  }

  function searchChest(event) {
    if (event.objectId !== CHEST_OPEN) return false;
    const { player } = event;
    if (player.getInventory().getFreeSlots() === 0) {
      player.getInventory().full();
      return true;
    }
    player.getInventory().adds(I.CHEMICAL_POWDER, 1);
    say(player, V.searchChest);
    return true;
  }

  function openBarrel(event) {
    if (event.objectId !== barrelId()) return false;
    say(event.player, V.openBarrel);
    return true;
  }

  function searchBarrel(event) {
    if (event.objectId !== barrelId()) return false;
    say(event.player, has(event.player, BARREL_OPEN) ? V.searchOpenBarrel : V.searchShutBarrel);
    return true;
  }

  // ---- The bricks and the tablet ----

  function searchBricks(event) {
    if (event.objectId !== BRICK) return false;
    put(event.player, BRICKS_SEARCHED);
    event.player.getPacketSender().sendVarbit(VARBIT_HINT, 1);
    say(event.player, V.searchBricks);
    return true;
  }

  function useOnBricks(event) {
    const { player, itemId } = event;
    if (itemId === I.CHEMICAL_COMPOUND) {
      if (complete(player) || stageNow(player) !== STAGE_SHAFTS) return false;
      player.getInventory().deleteAtSlot(event.itemSlot);
      setStage(player, STAGE_POURED);
      return say(player, V.pour);
    }
    if (itemId === I.TINDERBOX) return say(player, poured(player) ? V.light : V.tinderboxTooSoon);
    if (itemId === I.ROCK_PICK) return say(player, V.rockPickOnBricks);
    if (/ pickaxe$/i.test(ItemDefinition.forId(itemId)?.getName?.() ?? "")) return say(player, V.pickaxeOnBricks);
    return false;
  }

  /** "The player runs to the entrance of the dungeon.": the wall is gone, and the player stands in the copy without it. */
  function blowBricks(player) {
    if (!poured(player)) return;
    setStage(player, STAGE_BLOWN);
    player.moveTo(new Location(...WEST_WINCH.landingBlown));
  }

  function takeTablet(event) {
    if (event.objectId !== tabletId()) return false;
    const { player } = event;
    // Only where this player sees one (syncTablet): bare floor has no Take.
    if (held(player, I.STONE_TABLET) || player.getPacketSender().getVarbit(VARBIT_TABLET) !== 0) return true;
    if (player.getInventory().getFreeSlots() === 0) {
      player.getInventory().full();
      return true;
    }
    player.getInventory().adds(I.STONE_TABLET, 1);
    syncTablet(player);
    return true;
  }

  // ---- Items ----

  function handleItemOnObject(event) {
    if (event.handled || !event.player) return;
    const { player, itemId, objectId } = event;
    const winch = WINCHES.get(objectId);
    let handled = false;
    if (winch && itemId === I.ROPE) {
      handled = tieRope(event, winch);
    } else if (objectId === CHEST_CLOSED && itemId === I.CHEST_KEY_2 && event.object) {
      unlockChest(player, event.object);
      handled = true;
    } else if (objectId === BRICK) {
      handled = useOnBricks(event);
    } else if (objectId === barrelId()) {
      if (itemId === I.TROWEL && !has(player, BARREL_OPEN)) {
        setBarrel(player, true);
        handled = say(player, V.trowelOnBarrel);
      } else if (itemId === I.VIAL && has(player, BARREL_OPEN)) {
        player.getInventory().setItem(event.itemSlot, new Item(I.UNIDENTIFIED_LIQUID, 1));
        player.getInventory().refreshItems();
        handled = say(player, V.vialOnBarrel);
      }
    }
    if (handled) event.handled = true;
  }

  function handleItemOnItem(event) {
    if (event.handled || !event.player) return;
    const { player, usedItemId, usedWithItemId } = event;
    const mixture = MIXTURES.find((entry) => (entry.add === usedItemId && entry.to === usedWithItemId)
      || (entry.add === usedWithItemId && entry.to === usedItemId));
    if (!mixture) return;
    event.handled = true;
    if (player.getSkillManager().getCurrentLevel(Skill.HERBLORE) < mixture.level) {
      player.sendMessage(needsHerblore(mixture.level));
      return;
    }
    const inventory = player.getInventory();
    const addSlot = mixture.add === usedItemId ? event.usedItemSlot : event.usedWithItemSlot;
    const vialSlot = mixture.add === usedItemId ? event.usedWithItemSlot : event.usedItemSlot;
    if (inventory.getItems()[addSlot]?.getId() !== mixture.add || inventory.getItems()[vialSlot]?.getId() !== mixture.to) return;
    inventory.deleteAtSlot(addSlot);
    inventory.setItem(vialSlot, new Item(mixture.product, 1));
    inventory.refreshItems();
    player.getSkillManager().addExperiences(Skill.HERBLORE, mixture.experience);
    if (mixture.variant) say(player, mixture.variant);
    else player.sendMessage(MIXED);
  }

  function handleItemDropPolicy(event) {
    const volatile = VOLATILE.get(event.itemId);
    if (!volatile || !event.player) return;
    const { player } = event;
    event.handled = true;
    event.dropToGround = false;
    player.getInventory().deleteAtSlot(event.slot);
    const hitpoints = player.getHitpointsAfterPendingDamage();
    const damage = Math.min(volatile.damage, Math.max(0, hitpoints - 1));
    const says = damage === 0 && volatile.harmlessSays ? volatile.harmlessSays : volatile.says;
    if (says) player.forceChat(says);
    if (damage > 0) player.getCombat().getHitQueue().addPendingDamage([new HitDamage(damage, HitMask.RED)]);
  }

  function readLetter({ player, itemId }) {
    if (itemId !== I.INVITATION_LETTER) return false;
    return say(player, V.readLetter);
  }

  function readTablet({ player, itemId }) {
    if (itemId !== I.STONE_TABLET) return false;
    return say(player, V.readTablet);
  }

  function emptyLiquid({ player, itemId, slot }) {
    if (itemId !== I.UNIDENTIFIED_LIQUID) return false;
    player.getInventory().setItem(slot, new Item(I.VIAL, 1));
    player.getInventory().refreshItems();
    player.sendMessage(EMPTIED);
    return true;
  }

  // ---- The conversations' conditions and actions ----

  /** The prose conditions of the discovery's conversations, by step id; null when the step is not one of them. */
  function answerCondition(player, stepId) {
    switch (stepId) {
      case STEP.stillHasLetter: return held(player, I.INVITATION_LETTER);
      case STEP.letterInBank: return !held(player, I.INVITATION_LETTER) && owned(player, I.INVITATION_LETTER);
      case STEP.lostLetter: return !owned(player, I.INVITATION_LETTER);
      case STEP.noKey: return !owned(player, I.CHEST_KEY_2);
      case STEP.hasKey: return owned(player, I.CHEST_KEY_2);
      case STEP.beforeRope: return !roped(player, operating.get(player) ?? WEST_WINCH);
      case STEP.afterRope: return roped(player, operating.get(player) ?? WEST_WINCH);
      case STEP.withoutAgility: return player.getSkillManager().getCurrentLevel(Skill.AGILITY) < WINCH_AGILITY_LEVEL;
      case STEP.withAgility: return player.getSkillManager().getCurrentLevel(Skill.AGILITY) >= WINCH_AGILITY_LEVEL;
      case TERRY_STEP.emptyTray: return shownTray.get(player) === I.PANNING_TRAY;
      case TERRY_STEP.fullTray: return PANNING_TRAYS.includes(shownTray.get(player)) && shownTray.get(player) !== I.PANNING_TRAY;
      case TERRY_STEP.fewNuggets: return !held(player, I.NUGGETS, NUGGETS_PER_ORE);
      case TERRY_STEP.enoughNuggets: return held(player, I.NUGGETS, NUGGETS_PER_ORE);
      default: return null;
    }
  }

  /** A condition's branch was taken. */
  function handleCondition({ player, stepId }) {
    if (stepId === STEP.lostLetter) replaceLetter(player);
  }

  /** A message or action step of the discovery's conversations. */
  function handleAction(event) {
    const { player, stepId } = event;
    if (event.kind === "message") {
      if (BOXES.has(stepId)) event.box = { items: [BOXES.get(stepId)] };
      else if (STATEMENT_BOXES.has(stepId)) event.box = { statement: true };
      if (stepId === STEP.dougHandsKey && !owned(player, I.CHEST_KEY_2)) giveReward(player, I.CHEST_KEY_2, 1);
      else if (stepId === STEP.inCavern) descend(player);
      else if (stepId === STEP.lidBack) setBarrel(player, false);
      return;
    }
    if (stepId === STEP.runToEntrance) blowBricks(player);
    else if (stepId === STEP.complete && event.npcId === TERRY) turnIn(player);
    else if (stepId === TERRY_STEP.givesNuggets && event.npcId === TERRY) exchangeNuggets(player);
  }

  /** A line about to be spoken. */
  function handleLine(event) {
    if (event.npcId !== TERRY || !String(event.text ?? "").startsWith(LETTER_LINE)) return;
    event.before = () => takeTalisman(event.player);
  }

  function handleItemOnNpc(event) {
    const { player, itemId } = event;
    const targetId = event.npcId ?? event.target?.getId?.();
    let handled = false;
    if (targetId === TERRY) handled = useOnTerry(player, itemId, event.target ?? null);
    else if (WORKMAN_NPC_IDS.has(targetId)) handled = useOnWorkman(player, itemId, targetId, event.target ?? null);
    if (handled) event.handled = true;
    return handled;
  }

  /**
   * The journal after the exams (Wiki, Transcript:The Dig Site/Journal: its sentences, a line of the journal's width
   * each). Finished steps are struck through, without their highlights.
   */
  const JOURNAL = {
    find: ["I need a find from the digsite to <col=800000>impress the Expert</col>."],
    letter: ["I need to take the letter to a workman near a winch."],
    shafts: ["I need to <col=800000>investigate the dig shafts.</col>"],
    rocks: ["I need to find a way to move the rocks blocking the way", "in the shaft. Perhaps someone can help me."],
    covered: ["I covered the rocks in the cave with an Explosive", "Compound."],
    ignite: ["I need to ignite the <col=800000>Explosive Compound</col> and blow up", "the rocks blocking the way."],
    room: ["I should look for an interesting find in the secret room", "I found, and show it to the <col=800000>Expert</col> at the Exam Centre."],
    impressed: ["The expert was impressed with the Zaros Tablet that I", "found, and I also discovered an ancient altar!"],
    rewarded: ["I was rewarded for my findings."],
    done: ["My work here is done."],
  };
  const struck = (...sentences) => sentences.flat().map((line) => `<str>${line.replace(/<col=800000>|<\/col>/g, "")}</str>`);

  /** The journal's lines after the exams; `stage` is the player's (a stand-in's stage already read as its place). */
  function journal(player, stage) {
    const J = JOURNAL;
    if (complete(player)) {
      return struck(J.find, J.letter, J.shafts, J.rocks, J.covered, J.ignite, J.room, J.impressed, J.rewarded, J.done);
    }
    if (stage < STAGE_INVITED) return [...J.find];
    if (stage < STAGE_SHAFTS) return [...struck(J.find), ...J.letter];
    if (stage >= STAGE_BLOWN) return [...struck(J.find, J.letter, J.shafts, J.rocks, J.covered, J.ignite), ...J.room];
    if (stage === STAGE_POURED) return [...struck(J.find, J.letter, J.shafts, J.rocks, J.covered), ...J.ignite];
    return [...struck(J.find, J.letter), ...J.shafts, ...(bricksSearched(player) ? J.rocks : [])];
  }

  return {
    DISCOVERY_ATTRIBUTE,
    isLegacyStage, setStage,
    terryVariant, workmanVariant, dougVariant,
    answerCondition, handleCondition, handleAction, handleLine,
    handleItemOnNpc, handleItemOnObject, handleItemOnItem, handleItemDropPolicy,
    operateWinch, climbRope, openChest, closeChest, searchChest, openBarrel, searchBarrel, searchBricks, takeTablet,
    readLetter, readTablet, emptyLiquid, stealFromDoug, syncVarbits, journal, groundItems,
  };
};
