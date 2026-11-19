/**
 * Digging at the Dig Site: the soil of the nine digs and the two specimen trays. The Dig Site quest finds its ancient
 * talisman here, and the same digs go on yielding their finds beside and after it (Wiki: "Players can dig at the
 * Digsite during and after the quest").
 *
 * Wiki, Soil: the kind of dig goes by where the player stands, not by the piece of soil ("The various types of digs
 * are based on the location of the player"); each kind has its tool, its other needs, its Mining experience and its
 * table of finds, all copied below. The areas are that page's polygons, which are the cache map's own clusters of
 * soil (digdugupsoil1-3). A third exam's worth of digging (level 3) turns up the ancient talisman on 1 roll in 20
 * while the quest wants it and the player has none ("Ancient talisman is only dropped during The Dig Site"; it "is
 * replaced with coins once you've received" it).
 * Wiki, Specimen tray: Search needs a specimen jar in the inventory, gives 0.5 Mining experience whatever is found,
 * and has its own table (the charcoal for the quest's compound among it).
 * Wiki, Transcript:Digsite workman: the wrong tool, bare hands or feet at a level 1 dig, a brush or a spade on the
 * soil, a trowel in a tray and a search with no jar each have a workman's line; the closest workman says it, and "if
 * no digsite workman is within range, the message will appear in the chatbox instead".
 * Wiki, Sacks (Digsite) and its transcript: the jar sacks (digsacks_jar) hand over a specimen jar to a player who
 * carries none; the others, and those to a player with a jar, have nothing.
 *
 * Not sourced (no recording): what the chatbox says for a dig and for each find, how long a dig takes, the trowel's
 * animation, and what a player hears who has not passed the dig's exam or lacks the jar and brush at a level 3 dig.
 * Those are plain wording of ours, marked below; a dig takes the four ticks this quest's captured panning takes;
 * the rock pick plays the cache's qip_digisite_rockpick_anim and the trowel nothing.
 */
module.exports = function createDigSiteDigging(api, { held, owned, stageNow, STAGE_STARTED, STAGE_EXAMS_DONE }) {
  const { Animation, CacheDefinitions, DialogueChainBuilder, ItemIdentifiers: I, ItemStatementDialogue, NpcIdentifiers,
    ObjectIdentifiers, PlayerDialogue, Skill, Task, TaskManager } = api.core;
  const { startTranscript, loadTranscripts } = require("../QuestRuntime");

  const WORKMAN_PAGE = "Digsite workman";
  const WORKMAN_NPC_IDS = [NpcIdentifiers.DIGSITE_WORKMAN, NpcIdentifiers.DIGSITE_WORKMAN_2, NpcIdentifiers.DIGSITE_WORKMAN_3];
  const SOIL_IDS = new Set([ObjectIdentifiers.SOIL, ObjectIdentifiers.SOIL_2, ObjectIdentifiers.SOIL_3]); // digdugupsoil1-3
  const TRAINING = 0;
  /** Ticks from the tool going in to the find: not sourced, the time `pan` takes (RSProx 232/03231). */
  const DIG_TICKS = 4;
  const ROCK_PICK_ANIMATION = "qip_digisite_rockpick_anim";

  const find = (itemId, text, amount = 1) => ({ itemId, text, amount });
  const NOTHING = null;
  /**
   * Wiki, Soil: each kind of dig. `areas` are [x1, y1, x2, y2] tiles, both ends in. `finds` holds one entry per
   * slot of the page's table (a find listed at 2/16 twice), rolled evenly. The find's words are ours.
   */
  const DIGS = [
    {
      level: TRAINING, experience: 5,
      areas: [[3367, 3397, 3372, 3400], [3352, 3396, 3357, 3400]],
      // 13 slots: nothing 8, and one each of the five finds.
      finds: [NOTHING, NOTHING, NOTHING, NOTHING, NOTHING, NOTHING, NOTHING, NOTHING,
        find(I.CHARCOAL, "some charcoal"), find(I.COINS, "a coin"), find(I.BROKEN_ARROW, "a broken arrow"),
        find(I.CRACKED_SAMPLE, "a cracked sample"), find(I.VASE, "a vase")],
    },
    {
      level: 1, experience: 6,
      areas: [[3367, 3403, 3372, 3414], [3360, 3402, 3363, 3414]],
      // 12 slots: nothing 2, and one each of the ten finds.
      finds: [NOTHING, NOTHING,
        find(I.BUTTONS, "some buttons"), find(I.VASE, "a vase"), find(I.COPPER_ORE, "some copper ore"),
        find(I.LEATHER_BOOTS, "some leather boots"), find(I.OPAL, "an opal"), find(I.OLD_TOOTH, "an old tooth"),
        find(I.ROTTEN_APPLE, "a rotten apple"), find(I.BROKEN_GLASS, "some broken glass"),
        find(I.RUSTY_SWORD, "a rusty sword"), find(I.BONES, "some bones")],
    },
    {
      level: 2, experience: 7,
      areas: [[3350, 3424, 3363, 3430], [3350, 3415, 3355, 3418], [3367, 3423, 3372, 3430]],
      // 16 slots: nothing 3, bones 2, and one each of the other eleven finds.
      finds: [NOTHING, NOTHING, NOTHING,
        find(I.BONES, "some bones"), find(I.BONES, "some bones"),
        find(I.DAMAGED_ARMOUR, "some damaged armour"), find(I.LEATHER_BOOTS, "some leather boots"),
        find(I.BOWL, "a bowl"), find(I.BROKEN_STAFF, "a broken staff"), find(I.BROKEN_ARMOUR, "some broken armour"),
        find(I.UNCUT_JADE, "an uncut jade"), find(I.BROKEN_GLASS, "some broken glass"), find(I.JUG, "a jug"),
        find(I.POT, "a pot"), find(I.CLAY, "some clay"), find(I.UNCUT_OPAL, "an uncut opal")],
    },
    {
      level: 3, experience: 8,
      areas: [[3350, 3404, 3357, 3412], [3370, 3437, 3377, 3442]],
      // 20 slots: the talisman's (10 coins in its place outside the quest's talisman step), nothing 1,
      // 10 coins 2, and one each of the other sixteen finds.
      finds: ["talisman", NOTHING,
        find(I.COINS, "some coins", 10), find(I.COINS, "some coins", 10),
        find(I.BELT_BUCKLE, "a belt buckle"), find(I.BLACK_MED_HELM, "a black med helm"), find(I.BONES, "some bones"),
        find(I.BROKEN_ARMOUR, "some broken armour"), find(I.BROKEN_ARROW, "a broken arrow"),
        find(I.BROKEN_STAFF, "a broken staff"), find(I.BRONZE_SPEAR, "a bronze spear"), find(I.BUTTONS, "some buttons"),
        find(I.CERAMIC_REMAINS, "some ceramic remains"), find(I.CLAY, "some clay"),
        find(I.DAMAGED_ARMOUR, "some damaged armour"), find(I.IRON_KNIFE, "an iron knife"),
        find(I.LEATHER_BOOTS, "some leather boots"), find(I.NEEDLE, "a needle"), find(I.OLD_TOOTH, "an old tooth"),
        find(I.PIE_DISH, "a pie dish")],
    },
  ];
  /** Wiki, Specimen tray: 11 slots, nothing 2, bones 2, and one each of the other seven finds. */
  const TRAY_FINDS = [NOTHING, NOTHING, find(I.BONES, "some bones"), find(I.BONES, "some bones"),
    find(I.COINS, "a coin"), find(I.IRON_DAGGER, "an iron dagger"), find(I.CHARCOAL, "some charcoal"),
    find(I.BROKEN_ARROW, "a broken arrow"), find(I.BROKEN_GLASS, "some broken glass"),
    find(I.CERAMIC_REMAINS, "some ceramic remains"), find(I.CRACKED_SAMPLE, "a cracked sample")];
  const TRAY_EXPERIENCE = 0.5;
  const TALISMAN_VARIANT = "making-a-discovery-digging-up-the-talisman";
  // No capture of these: the wording is ours.
  const NOTHING_FOUND = "You find nothing of interest.";
  const NEEDS_JAR_AND_BRUSH = "You need a specimen jar and a specimen brush to dig at a level 3 site.";
  const needsExam = (level) => `You need to pass the level ${level} Earth Sciences exam to dig at a level ${level} site.`;

  /** Wiki, Sacks (Digsite): the sacks that hold a specimen jar, and the plain ones (on the surface and in the shafts). */
  const JAR_SACKS = ObjectIdentifiers.SACKS_5; // 2356
  const SACKS = new Set([ObjectIdentifiers.SACKS_3, ObjectIdentifiers.SACKS_4, JAR_SACKS]); // 2354, 2355, 2356
  const digging = new WeakSet();

  const worn = (player, itemId) => player.getEquipment().getItems().some((item) => item?.getId() === itemId);

  /** The dig the player is standing in, or null. */
  function digAt(location) {
    if (location.getZ() !== 0) return null;
    const x = location.getX(), y = location.getY();
    return DIGS.find((dig) => dig.areas.some(([x1, y1, x2, y2]) => x >= x1 && x <= x2 && y >= y1 && y <= y2)) ?? null;
  }

  /** The closest Digsite workman the player can see, or null. */
  function nearestWorkman(player) {
    const list = player.getLocalNpcs?.();
    const at = player.getLocation();
    let best = null;
    for (const npc of Array.isArray(list) ? list : list ? [...list.values()] : []) {
      if (!npc?.isRegistered?.() || !WORKMAN_NPC_IDS.includes(npc.getId())) continue;
      const distance = at.getDistance(npc.getLocation());
      if (!best || distance < best.distance) best = { npc, distance };
    }
    return best?.npc ?? null;
  }

  /** A workman's telling-off: said by the closest workman, or put in the chatbox when none is about. */
  function workmanSays(player, variant) {
    const npc = nearestWorkman(player);
    if (npc) return startTranscript(api, player, npc.getId(), WORKMAN_PAGE, variant, undefined, npc);
    const steps = loadTranscripts(api)?.[WORKMAN_PAGE]?.variants?.[variant] ?? [];
    const line = steps.find((step) => typeof step?.npc === "string" || (step?.type === "line" && typeof step.text === "string"));
    if (line) player.sendMessage(line.npc ?? line.text);
    return true;
  }

  const refuse = (player, variant) => { workmanSays(player, variant); return false; };

  /** The find a roll lands on at this dig for this player: { itemId, amount, text }, "talisman" or null. */
  function roll(player, finds) {
    const found = finds[Math.floor(Math.random() * finds.length)];
    if (found !== "talisman") return found;
    // Wiki, Soil and Ancient talisman: the quest's own find, and only while the player has none to show.
    const wanted = stageNow(player) === STAGE_EXAMS_DONE && !owned(player, I.ANCIENT_TALISMAN);
    return wanted ? found : find(I.COINS, "some coins", 10);
  }

  function hand(player, found) {
    if (found === NOTHING) {
      player.sendMessage(NOTHING_FOUND);
      return;
    }
    if (found === "talisman") {
      player.getInventory().adds(I.ANCIENT_TALISMAN, 1);
      startTranscript(api, player, NpcIdentifiers.TERRY_BALANDO, "The Dig Site", TALISMAN_VARIANT);
      return;
    }
    player.getInventory().adds(found.itemId, found.amount);
    player.sendMessage(`You find ${found.text}.`);
  }

  /** A find of any kind needs a free slot. */
  const hasRoom = (player) => player.getInventory().getFreeSlots() > 0;

  /** Whether this player may dig here with this tool: true, false once a refusal was given, null when nothing answers. */
  function mayDig(player, dig, toolId) {
    const stage = stageNow(player);
    if (toolId === I.ROCK_PICK) {
      if (dig.level === TRAINING) return null; // no line for it: nothing interesting happens
      if (dig.level !== 2) return refuse(player, "standard-dialogue-using-a-rock-pick-on-a-level-1-or-3-site");
    } else if (dig.level === 2) {
      return refuse(player, "standard-dialogue-using-a-trowel-on-soil-in-a-level-2-site");
    }
    // Wiki, Soil: each level is "unlocked after passing" that exam. Stage 1 is the first exam still to pass.
    if (dig.level !== TRAINING && stage < STAGE_STARTED + dig.level) {
      player.sendMessage(needsExam(dig.level));
      return false;
    }
    if (dig.level === 1) {
      if (!worn(player, I.LEATHER_GLOVES)) {
        return refuse(player, "standard-dialogue-using-a-trowel-on-soil-in-a-level-1-site-without-wearing-leather-gloves");
      }
      if (!worn(player, I.LEATHER_BOOTS)) {
        return refuse(player, "standard-dialogue-using-a-trowel-on-soil-in-a-level-1-site-while-wearing-leather-gloves-but-not-leather-boots");
      }
    }
    if (dig.level === 3 && (!held(player, I.SPECIMEN_JAR) || !held(player, I.SPECIMEN_BRUSH))) {
      player.sendMessage(NEEDS_JAR_AND_BRUSH);
      return false;
    }
    return true;
  }

  /** A trowel, rock pick, specimen brush or spade used on the soil. */
  function useOnSoil(event) {
    const { player, itemId } = event;
    if (!SOIL_IDS.has(event.objectId)) return;
    if (itemId !== I.TROWEL && itemId !== I.ROCK_PICK && itemId !== I.SPECIMEN_BRUSH && itemId !== I.SPADE) return;
    const dig = digAt(player.getLocation());
    if (!dig) return; // outside every dig (the Wiki: no tool digs there)
    if (itemId === I.SPECIMEN_BRUSH || itemId === I.SPADE) {
      event.handled = true;
      workmanSays(player, itemId === I.SPADE ? "standard-dialogue-digging-with-a-spade-in-soil" : "standard-dialogue-using-a-specimen-brush-on-soil");
      return;
    }
    const allowed = mayDig(player, dig, itemId);
    if (allowed === null) return;
    event.handled = true;
    if (!allowed || digging.has(player)) return;
    if (!hasRoom(player)) {
      player.getInventory().full();
      return;
    }
    const start = player.getLocation().clone();
    digging.add(player);
    if (itemId === I.ROCK_PICK) {
      const animation = CacheDefinitions.getSeqId(ROCK_PICK_ANIMATION);
      if (animation != null) player.performAnimation(new Animation(animation));
    }
    TaskManager.submit(new (class extends Task {
      constructor() { super(DIG_TICKS, player, false); }
      execute() {
        this.stop();
        if (!player.getLocation().equals(start) || !held(player, itemId) || !hasRoom(player)) return;
        player.getSkillManager().addExperiences(Skill.MINING, dig.experience);
        hand(player, roll(player, dig.finds));
      }
      stop() {
        digging.delete(player);
        super.stop();
      }
    })());
  }

  /** A trowel used on a specimen tray. */
  function useOnTray(event) {
    if (event.objectId !== ObjectIdentifiers.SPECIMEN_TRAY || event.itemId !== I.TROWEL) return;
    event.handled = true;
    workmanSays(event.player, "standard-dialogue-using-a-trowel-on-the-specimen-tray");
  }

  function searchTray({ player, objectId }) {
    if (objectId !== ObjectIdentifiers.SPECIMEN_TRAY) return false;
    if (!held(player, I.SPECIMEN_JAR)) {
      // A workman stops the search; with none in sight one still answers (the conversation needs no one standing by).
      const npc = nearestWorkman(player);
      startTranscript(api, player, npc?.getId() ?? WORKMAN_NPC_IDS[0], WORKMAN_PAGE,
        "standard-dialogue-trying-to-search-the-specimen-tray-without-a-specimen-jar", undefined, npc);
      return true;
    }
    if (!hasRoom(player)) {
      player.getInventory().full();
      return true;
    }
    player.getSkillManager().addExperiences(Skill.MINING, TRAY_EXPERIENCE);
    hand(player, roll(player, TRAY_FINDS));
    return true;
  }

  /** Search on the sacks (Transcript:Sacks (Digsite)). */
  function searchSacks({ player, objectId }) {
    if (!SACKS.has(objectId)) return false;
    player.sendMessage("You search the sacks.");
    if (objectId !== JAR_SACKS || held(player, I.SPECIMEN_JAR)) {
      player.sendMessage("You find nothing of interest");
      return true;
    }
    if (!hasRoom(player)) {
      player.getInventory().full();
      return true;
    }
    player.getInventory().adds(I.SPECIMEN_JAR, 1);
    player.getDialogueManager().startDialogues(new DialogueChainBuilder()
      .add(new PlayerDialogue(0, "Hey there's something under here."))
      .add(new ItemStatementDialogue(1, I.SPECIMEN_JAR, "You find a specimen jar!")));
    return true;
  }

  function handleItemOnObject(event) {
    if (event.handled || !event.player) return;
    useOnSoil(event);
    if (!event.handled) useOnTray(event);
  }

  return { handleItemOnObject, searchTray, searchSacks, nearestWorkman };
};
