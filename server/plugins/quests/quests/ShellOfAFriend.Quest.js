/**
 * A Shell of a Friend (members, 11 November 2026, 2 Quest Points).
 *
 * Built from the OSRS Wiki: the quest's page and quick guide, Transcript:A Shell of a Friend (every line said or
 * shown here is its own), Transcript:A Shell of a Friend/Journal, and the pages of the Juvenile Snail, the Leech
 * (A Shell of a Friend), SnelmLover500, Fresh leaves, Dew-covered branch, Restorative dew, Strong sticks, the Tree
 * and Stepping stone (A Shell of a Friend), Pink snelm and Bronze axe (its spawn). No live capture and no Quest
 * Helper exist for it yet (Quest Helper's newest source, master b9b9370 of 3 November 2026, predates the quest).
 *
 * Cache (osrs-242_2026-11-11): quest row 220 (dbrow 17315 quest_shellofafriend), 2 Quest Points, requirements
 * Priest in Peril, Herblore 16 and Construction 15, endstate 24. Client script 4024 (the quest progress getter)
 * reads its progress from varbit snailquest (16854, bits 0-6 of varp snailquest_primary 6250); the snail's name has
 * snailquest_snail_name (16855, bits 7-11). The island's tree is the multiloc snailquest_tree_multi (33159) on that
 * varbit: a plain tree at 0-10, the shelter (63334) at 11, "Build-shelter" (33161) at 12 and the shelter from 13 on.
 * The stage values between are ours (STAGE), placed so that the tree shows what the Wiki says it shows when.
 *
 * Docs: docs/quests/a-shell-of-a-friend/README.md. Test: server/tests/a-shell-of-a-friend.test.cjs.
 */
const QUEST_KEY = "a_shell_of_a_friend";
const QUEST_NAME = "A Shell of a Friend";

/** snailquest (16854). 24 is the cache's endstate; 12 shows "Build-shelter" and 13 on the shelter (multiloc 33159). */
const STAGE = {
  NOT_STARTED: 0,
  STARTED: 1, // "Yes." to "Start the A Shell of a Friend quest?": gather leaves
  LEAVES_GATHERED: 2, // the fifth fresh leaf picked up: the leech waits on the island
  LEECH_KILLED: 3, // the leech dead: feed the snail
  FED: 4, // the leaves laid down: find a balm (the dew-covered branches)
  DEW_GATHERED: 5, // the fifth branch picked up
  HEALED: 6, // the dew rubbed on: name the snail
  NAMED: 7, // a name picked
  SHELTER: 12, // "I'll be quick!": strong sticks, and the tree's Build-shelter
  SHELTER_BUILT: 13, // the shelter built: talk to the snail
  FAREWELL: 14, // "I'll be right back!": fresh leaves again
  FOOD_GATHERED: 15, // the fifth leaf again: SnelmLover500 by the shelter, the snail gone
  AVENGE: 16, // "What have you done?!": SnelmLover500 attacks
  COMPLETE: 24,
};

const VARBIT_STAGE = 16854; // snailquest
const VARBIT_NAME = 16855; // snailquest_snail_name
/** Ours: the name varbit's values, in the menu's order from 1 (no client script reads them). */
const NAMES = ["Sprout", "Sunny", "Sadie", "Scout", "Sasha", "Sushi", "Sophie", "Samantha", "Sebastian", "Snowball", "Squishy", "Orlando", "Smudge"];
/** The naming menu's four pages (the transcript's "More options..." / "Previous options..."). */
const NAME_PAGES = [[0, 1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]];

/** The Wiki's spawn tiles (each item's Spawns table; the quest page's map). */
const LEAVES = [[3573, 3502], [3571, 3506], [3575, 3508], [3579, 3511], [3573, 3513]];
const BRANCHES = [[3573, 3478], [3576, 3482], [3575, 3483], [3573, 3485], [3574, 3486]];
const STICKS = [[3581, 3479], [3581, 3483], [3583, 3486], [3580, 3488], [3582, 3497]];
const AXE_SPOT = [3585, 3496]; // Bronze axe: "Haunted Woods - during A Shell of a Friend"

/** The Juvenile Snail's tile and range (its page: 3564,3493, r=3; the cache's startcoord). */
const SNAIL_TILE = [3564, 3493];
const SNAIL_RANGE = 3;
/** Ours: the leech appears beside the snail; SnelmLover500 "standing by the shelter" (the tree is 3562-3563,3491-3492). */
const LEECH_TILE = [3565, 3493];
const LOVER_TILE = [3564, 3492];

/** The island west of fairy ring ALQ (cache map: its walkable tiles lie in this box, water all round). */
const ISLAND = { minX: 3560, maxX: 3568, minY: 3489, maxY: 3498, levels: [0] };
/** Ours: where the quest's spawns are kept for a player: the woods round the island, the fairy ring included. */
const WOODS = { minX: 3544, maxX: 3607, minY: 3464, maxY: 3527, levels: [0] };

const NEEDED = 5;
const DEW_NEEDED = 10;
const DEW_PER_BRANCH = 2;
const STRIP_TICKS = 3;
const STRIP_XP = 5;
const STRIP_LEVEL = 16;
const HERBLORE_LEVEL = 16;
const CONSTRUCTION_LEVEL = 15;
const REWARD_XP = 2500;
/** The Wiki's destroy text of the four quest items (the strong sticks' page has it without the full stop). */
const DESTROY_NOTE = "You'll have to search the Haunted Woods for some more.";

const ATTRIBUTE = {
  NAME: "a-shell-of-a-friend:snail-name",
  PICKED: { leaves: "a-shell-of-a-friend:picked-leaves", branches: "a-shell-of-a-friend:picked-branches", sticks: "a-shell-of-a-friend:picked-sticks" },
  STRIPPING: "a-shell-of-a-friend:stripping",
};

module.exports = function registerShellOfAFriendQuest(api) {
  const {
    ActionDialogue, DialogueChainBuilder, EndDialogue, ItemStatementDialogue, OptionDialogue, PlayerDialogue,
    StatementDialogue, Item, ItemIdentifiers: I, NpcIdentifiers: N, ObjectIdentifiers: O, Location, Skill,
    ItemOnGroundManager, TaskManager, Task, CountdownTask,
  } = api.core;
  const { registerQuest, questStartMessage } = require("../QuestRuntime");

  const NPC = { SNAIL: N.JUVENILE_SNAIL, LEECH: N.LEECH_3, LOVER: N.SNELMLOVER500, LOVER_COMBAT: N.SNELMLOVER500_2 };
  const ITEM = {
    LEAVES: I.FRESH_LEAVES, BRANCH: I.DEW_COVERED_BRANCH, DEW: I.RESTORATIVE_DEW, STICKS: I.STRONG_STICKS,
    SNELM: I.PINK_SNELM, BRONZE_AXE: I.BRONZE_AXE,
  };
  const TREE_BUILDABLE = O.TREE_183; // snailquest_tree_buildable

  /** Wiki monster pages: the cache has the levels, not the bonuses, max hits or speeds. */
  const LEECH_COMBAT = { stats: [80, 20, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], maxHit: 3, attackSpeed: 4 };
  const LOVER_COMBAT = { stats: [50, 50, 35, 1, 10, 0, 0, 0, 0, 0, 20, 20, 10, 0, 0, 0, 0, 0], maxHit: 6, attackSpeed: 4 };

  /** Each gathering: its item, tiles, the stages its spawns show at, and the lines for enough / more than enough. */
  const SETS = {
    leaves: { item: ITEM.LEAVES, spots: LEAVES, stages: [STAGE.STARTED, STAGE.LEAVES_GATHERED, STAGE.LEECH_KILLED, STAGE.FAREWELL],
      advance: { [STAGE.STARTED]: STAGE.LEAVES_GATHERED, [STAGE.FAREWELL]: STAGE.FOOD_GATHERED },
      enough: (player) => held(player, ITEM.LEAVES) >= NEEDED,
      refusal: "Hmm... I don't think I need any more leaves." },
    branches: { item: ITEM.BRANCH, spots: BRANCHES, stages: [STAGE.FED, STAGE.DEW_GATHERED],
      advance: { [STAGE.FED]: STAGE.DEW_GATHERED },
      // Ours: enough branches counts the dew already stripped from them (two a branch).
      enough: (player) => held(player, ITEM.BRANCH) * DEW_PER_BRANCH + held(player, ITEM.DEW) >= DEW_NEEDED,
      refusal: "Hmm... I don't think I need any more of these branches." },
    sticks: { item: ITEM.STICKS, spots: STICKS, stages: [STAGE.SHELTER], advance: {},
      enough: (player) => held(player, ITEM.STICKS) >= NEEDED,
      refusal: "Hmm... I reckon I have enough sticks for a shelter." },
  };
  const ENOUGH_LINE = "There. I reckon that should be enough.";

  let quest = null;
  const stageOf = (player) => (quest ? quest.getStage(player) : 0);
  const held = (player, id) => player.getInventory().getAmount(id);
  const isBot = (player) => player?.isPlayerBot?.() === true;
  const inBox = (box, location) => location && location.getZ() === 0 && location.getX() >= box.minX && location.getX() <= box.maxX
    && location.getY() >= box.minY && location.getY() <= box.maxY;
  const onIsland = (player) => inBox(ISLAND, player.getLocation());
  const nameIndex = (player) => Number(player.getAttribute(ATTRIBUTE.NAME)) || 0;
  const nameOf = (player) => NAMES[nameIndex(player) - 1] ?? "Snail";

  // --- the dialogue player -------------------------------------------------------------------

  /** Runs `on` as the entry shows, before its text. */
  function hooked(entry, on) {
    if (!on) return entry;
    const send = entry.send.bind(entry);
    entry.send = (player) => { on(); send(player); };
    return entry;
  }

  /**
   * Plays entries: { player: text } (the player's line), { box: text } (a message box), { item, text } (an item box),
   * { menu: title, options: [[label, fn], ...] }; any entry may carry `on`, run as it shows. `then` runs after the
   * last entry is continued.
   */
  function play(player, entries, then) {
    const chain = new DialogueChainBuilder();
    const manager = player.getDialogueManager();
    const close = (entry) => {
      if (manager.getCurrent?.() !== entry) return;
      manager.reset();
      player.getPacketSender().sendInterfaceRemoval();
    };
    let index = 0;
    for (const entry of entries.filter(Boolean)) {
      let dialogue;
      if (entry.player !== undefined) dialogue = new PlayerDialogue(index, entry.player);
      else if (entry.box !== undefined) dialogue = new StatementDialogue(index, entry.box);
      else if (entry.item !== undefined) dialogue = new ItemStatementDialogue(index, entry.item, entry.text);
      else if (entry.menu !== undefined) {
        const options = entry.options;
        const menu = new OptionDialogue(index, {
          executeOption(option) {
            options[Number(option) - 1]?.[1]?.();
            close(menu);
          },
        }, ...options.map((option) => option[0])).setTitle(entry.menu);
        dialogue = menu;
      } else continue;
      chain.add(hooked(dialogue, entry.on));
      index++;
    }
    if (then) {
      const action = new ActionDialogue(index++, { execute: () => { then(); close(action); } });
      chain.add(action);
    }
    chain.add(new EndDialogue(index));
    manager.startDialogues(chain);
  }

  const P = (text, on) => ({ player: text, on });
  const BOX = (text, on) => ({ box: text, on });

  // --- spawns: the player's own snail, leech and SnelmLover500, and the gathering spots ----------

  const tracked = new WeakMap();
  function state(player) {
    let entry = tracked.get(player);
    if (!entry) tracked.set(player, (entry = { snail: null, leech: null, lover: null, ground: new Map(), regen: null }));
    return entry;
  }

  const alive = (npc) => npc?.isRegistered?.() === true;
  function remove(npc) {
    if (alive(npc)) api.removeNpc(npc);
  }

  function spawn(player, id, [x, y], wanderRadius = 0) {
    const npc = api.spawnNpc({ id, x, y, z: 0, owner: player, ownerOnly: true, wanderRadius });
    if (npc) npc.__skipDefaultRespawn = true;
    return npc;
  }

  const spotKey = (set, [x, y]) => `${set}:${x},${y}`;
  const pickedMask = (player, set) => Number(player.getAttribute(ATTRIBUTE.PICKED[set])) || 0;
  const hasUsableAxe = (player) => {
    const request = { player, itemId: null, axe: null };
    api.emitCustomEvent("woodcutting:axe", request);
    return Boolean(request.axe);
  };

  /** The spots the player should see now: "set:x,y" -> [item, tile]. */
  function wantedSpots(player) {
    const stage = stageOf(player);
    const wanted = new Map();
    for (const [name, set] of Object.entries(SETS)) {
      if (!set.stages.includes(stage)) continue;
      const mask = pickedMask(player, name);
      set.spots.forEach((tile, index) => {
        if (!(mask & (1 << index))) wanted.set(spotKey(name, tile), [set.item, tile]);
      });
    }
    // Bronze axe: "pick up the bronze axe from the spawn near the fairy ring if needed" (quest page).
    if (stage === STAGE.SHELTER && !hasUsableAxe(player)) wanted.set(spotKey("axe", AXE_SPOT), [ITEM.BRONZE_AXE, AXE_SPOT]);
    return wanted;
  }

  function syncGround(player, inWoods) {
    const entry = state(player);
    const wanted = inWoods ? wantedSpots(player) : new Map();
    for (const [key, groundItem] of [...entry.ground]) {
      if (wanted.has(key) && ItemOnGroundManager.exists(groundItem)) continue;
      if (ItemOnGroundManager.exists(groundItem)) ItemOnGroundManager.deregister(groundItem);
      entry.ground.delete(key);
    }
    for (const [key, [id, [x, y]]] of wanted) {
      if (entry.ground.has(key)) continue;
      const groundItem = ItemOnGroundManager.registerLocation(player, new Item(id, 1), new Location(x, y, 0),
        player.getPrivateArea?.() ?? null, { goesGlobal: false });
      // They lie there while the player is in the woods, and go when they leave (syncGround above).
      groundItem.setAgingPaused?.(true);
      entry.ground.set(key, groundItem);
    }
  }

  /** The snail, the leech and SnelmLover500 for the stage, while the player is in the woods. */
  function syncNpcs(player, inWoods) {
    const entry = state(player);
    const stage = stageOf(player);
    const snail = inWoods && stage < STAGE.FOOD_GATHERED;
    if (!snail) { remove(entry.snail); entry.snail = null; }
    else if (!alive(entry.snail)) entry.snail = spawn(player, NPC.SNAIL, SNAIL_TILE, SNAIL_RANGE);
    if (!inWoods || stage !== STAGE.LEAVES_GATHERED) { remove(entry.leech); entry.leech = null; }
    const lover = inWoods && (stage === STAGE.FOOD_GATHERED || stage === STAGE.AVENGE);
    if (!lover) { remove(entry.lover); entry.lover = null; }
    else if (!alive(entry.lover)) entry.lover = spawn(player, NPC.LOVER, LOVER_TILE);
  }

  function sync(player) {
    if (!player || isBot(player) || player.isRegistered?.() === false) return;
    const inWoods = inBox(WOODS, player.getLocation());
    syncNpcs(player, inWoods);
    syncGround(player, inWoods);
  }

  function clear(player) {
    const entry = tracked.get(player);
    if (!entry) return;
    remove(entry.snail);
    remove(entry.leech);
    remove(entry.lover);
    entry.snail = entry.leech = entry.lover = null;
    for (const groundItem of entry.ground.values()) {
      if (ItemOnGroundManager.exists(groundItem)) ItemOnGroundManager.deregister(groundItem);
    }
    entry.ground.clear();
  }

  function setStage(player, stage) {
    if (stageOf(player) === stage) return;
    quest.setStage(player, stage);
    if (stage === STAGE.FAREWELL) player.setAttribute(ATTRIBUTE.PICKED.leaves, 0);
    sync(player);
  }

  // --- the leech ------------------------------------------------------------------------------

  /** "return to the island to find the snail under attack from a leech" (quest page). */
  function leechAmbush(player) {
    const entry = state(player);
    if (alive(entry.leech) || !alive(entry.snail)) return;
    const leech = spawn(player, NPC.LEECH, LEECH_TILE);
    if (!leech) return;
    leech.setCombatOverride(LEECH_COMBAT);
    entry.leech = leech;
    leech.getCombat().attack(entry.snail);
    keepSnailAlive(player);
  }

  /** "the snail cannot die and will regenerate health upon falling below half its Hitpoints" (quest page). */
  function keepSnailAlive(player) {
    const entry = state(player);
    if (entry.regen) return;
    const task = new (class extends Task {
      constructor() { super(1, player, false); }
      execute() {
        const { snail, leech } = state(player);
        if (!alive(leech) || !alive(snail) || player.isRegistered?.() === false) {
          state(player).regen = null;
          this.stop();
          return;
        }
        const max = snail.getDefinition().getHitpoints();
        if (snail.getHitpoints() < max / 2) snail.setHitpoints(max);
      }
    })();
    entry.regen = task;
    TaskManager.submit(task);
  }

  // --- SnelmLover500 --------------------------------------------------------------------------

  /** "Returning to the island with the food": the two lines, then "SnelmLover500 attacks the player." */
  function confront(player) {
    if (stageOf(player) !== STAGE.FOOD_GATHERED) return;
    const name = nameOf(player);
    play(player, [P(`${name}?`), P("What have you done?!")], () => attack(player));
  }

  function attack(player) {
    const stage = stageOf(player);
    if (stage !== STAGE.FOOD_GATHERED && stage !== STAGE.AVENGE) return;
    const entry = state(player);
    if (alive(entry.lover) && entry.lover.getId() === NPC.LOVER_COMBAT) {
      entry.lover.getCombat().attack(player);
      return;
    }
    const at = alive(entry.lover) ? [entry.lover.getLocation().getX(), entry.lover.getLocation().getY()] : LOVER_TILE;
    remove(entry.lover);
    const lover = spawn(player, NPC.LOVER_COMBAT, at);
    entry.lover = lover;
    if (!lover) return;
    lover.setCombatOverride(LOVER_COMBAT);
    if (stage === STAGE.FOOD_GATHERED) setStage(player, STAGE.AVENGE);
    lover.getCombat().attack(player);
  }

  // --- requirements ---------------------------------------------------------------------------

  function questComplete(player, key) {
    const request = { player, key, complete: false };
    api.emitCustomEvent("quest:is-complete", request);
    return request.complete === true;
  }

  /** Quest table row 220: Priest in Peril, Herblore 16 and Construction 15, needed to start, not boostable. */
  function meetsRequirements(player) {
    const skills = player.getSkillManager();
    return questComplete(player, "priest_in_peril")
      && skills.getMaxLevel(Skill.HERBLORE) >= HERBLORE_LEVEL
      && skills.getMaxLevel(Skill.CONSTRUCTION) >= CONSTRUCTION_LEVEL;
  }

  // --- the Juvenile Snail ----------------------------------------------------------------------

  function talkToSnail(event) {
    const { player, npc } = event;
    if (!player || !npc) return false;
    let stage = stageOf(player);
    if (stage === STAGE.STARTED && held(player, ITEM.LEAVES) >= NEEDED) setStage(player, (stage = STAGE.LEAVES_GATHERED));
    switch (stage) {
      case STAGE.NOT_STARTED: return start(player, npc);
      case STAGE.STARTED: return askForFood(player);
      case STAGE.LEAVES_GATHERED:
        player.sendMessage("The snail seems a bit preoccupied right now.");
        return true;
      case STAGE.LEECH_KILLED: return held(player, ITEM.LEAVES) >= NEEDED ? feed(player) : askForFood(player);
      case STAGE.FED:
      case STAGE.DEW_GATHERED: return balm(player, npc);
      case STAGE.HEALED: return nameTalk(player, npc);
      case STAGE.NAMED: return shelterTalk(player, nameOf(player));
      case STAGE.SHELTER: return sticksTalk(player);
      case STAGE.SHELTER_BUILT: return builtTalk(player);
      case STAGE.FAREWELL:
        play(player, [
          P("I'm going to go fetch you some more food. I'll be back once I've got enough."),
          BOX(`${nameOf(player)} gives you a happy look.`),
        ]);
        return true;
      default:
        return false;
    }
  }

  function start(player, npc) {
    npc.forceChat?.("!");
    play(player, [
      P("What are you doing out here, li'l snail?"),
      BOX("The snail stares at you cautiously. It seems afraid."),
      { menu: `Start the ${QUEST_NAME} quest?`, options: [
        ["Yes.", () => accept(player)],
        ["No.", () => play(player, [P("I guess I'll leave you alone.")])],
      ] },
    ]);
    return true;
  }

  function accept(player) {
    if (stageOf(player) !== STAGE.NOT_STARTED) return;
    if (!meetsRequirements(player)) {
      // Ours: the other quests' refusal (the Wiki has none for this one).
      player.sendMessage(`You do not meet all of the requirements to start ${QUEST_NAME}.`);
      return;
    }
    setStage(player, STAGE.STARTED);
    player.sendMessage(questStartMessage(player, QUEST_NAME));
    play(player, [
      P("Have you become separated from your family?"),
      BOX("The snail looks down. You assume you are correct."),
      P("Hmm... That's not good... This place is pretty hostile. Maybe I can get you some food?"),
      BOX("The snail looks up at you with hopeful eyes."),
      P("Okay, li'l snail. I'm sure I can find you something tasty nearby. Maybe some nice leaves..."),
    ]);
  }

  /** "Talking to the snail again without food" and "Returning to the snail with less than 5 fresh leaves". */
  function askForFood(player) {
    if (held(player, ITEM.LEAVES) > 0) {
      play(player, [
        P("I've managed to find you some leaves. What do you think?"),
        { item: ITEM.LEAVES, text: "You show the leaves to the snail. It gives you a look of affirmation in response, but it doesn't seem fully convinced." },
        P("Hmm... I think you're right. It's not quite enough, is it? I'll be back with more soon."),
        BOX("The snail wiggles excitedly."),
      ]);
    } else {
      play(player, [
        P("I've not managed to find you any food yet, li'l snail, but I'm sure there's something tasty nearby. Maybe some nice leaves..."),
        BOX("The snail gives you a look of affirmation."),
      ]);
    }
    return true;
  }

  /** "Talking to the snail after killing the leech": the five leaves are laid down. */
  function feed(player) {
    play(player, [
      P("Are you okay, li'l snail? That leech ambushed you!"),
      BOX("The snail is shaking. It's in shock."),
      P("Here, have some of this food I gathered for you."),
      { item: ITEM.LEAVES, text: "You lay down the leaves in front of the snail. It cautiously starts nibbling on them, but it noticeably winces as it does so.",
        on: () => layDown(player) },
      P("Oh no! You're injured, you poor thing. I wonder if there's anything nearby that I can make a balm with..."),
      BOX("The snail continues to slowly nibble on the food."),
    ]);
    return true;
  }

  function layDown(player) {
    if (stageOf(player) !== STAGE.LEECH_KILLED || held(player, ITEM.LEAVES) < NEEDED) return;
    player.getInventory().deleteNumber(ITEM.LEAVES, NEEDED);
    player.getInventory().refreshItems();
    setStage(player, STAGE.FED);
  }

  /** "Finding snail medicine": by what the player carries, the balm is not there yet, or it is rubbed on. */
  function balm(player, npc) {
    const opening = [P("How are you holding up?"), BOX("The snail looks uncomfortable. It's hurt.")];
    if (held(player, ITEM.DEW) >= DEW_NEEDED) {
      play(player, [
        ...opening,
        { item: ITEM.DEW, text: "You carefully rub the restorative dew onto the snail's wounds.", on: () => rubDew(player) },
        P("There you go. That should feel better soon."),
        BOX("The snail starts to look more comfortable."),
        ...namingIntro(),
      ], () => namePage(player, npc, 0));
      return true;
    }
    const middle = held(player, ITEM.DEW) > 0
      ? "I think this dew I've gathered might help, but it looks like I'll need some more."
      : held(player, ITEM.BRANCH) > 0
        ? "Hmm... I have some sticks here. Perhaps I can strip the dew off them to use as a balm..."
        : "Hmm... Let me see if there's anything nearby that I can make a balm with...";
    play(player, [...opening, P(middle), BOX("The snail continues to shake.")]);
    return true;
  }

  function rubDew(player) {
    const stage = stageOf(player);
    if ((stage !== STAGE.FED && stage !== STAGE.DEW_GATHERED) || held(player, ITEM.DEW) < DEW_NEEDED) return;
    player.getInventory().deleteNumber(ITEM.DEW, DEW_NEEDED);
    player.getInventory().refreshItems();
    setStage(player, STAGE.HEALED);
  }

  const namingIntro = () => [
    P("Hmm... I can't keep calling you li'l snail. We should think of a name for you."),
    BOX("The snail looks up at you with its wide and round eyes."),
    P("I wonder what would fit you best..."),
  ];

  /** Ours: a player who leaves before picking a name hears the naming lines again. */
  function nameTalk(player, npc) {
    play(player, namingIntro(), () => namePage(player, npc, 0));
    return true;
  }

  function namePage(player, npc, page) {
    const options = NAME_PAGES[page].map((index) => [`${NAMES[index]}.`, () => named(player, npc, index)]);
    if (page > 0) options.push(["Previous options...", () => namePage(player, npc, page - 1)]);
    if (page < NAME_PAGES.length - 1) options.push(["More options...", () => namePage(player, npc, page + 1)]);
    play(player, [{ menu: "Pick a name for the snail.", options }]);
  }

  function named(player, npc, index) {
    if (stageOf(player) !== STAGE.HEALED) return;
    const name = NAMES[index];
    player.setAttribute(ATTRIBUTE.NAME, index + 1);
    player.getPacketSender().sendVarbit(VARBIT_NAME, index + 1);
    setStage(player, STAGE.NAMED);
    play(player, [
      P(`How about ${name}?`),
      BOX("The snail wobbles excitedly. You think it's happy."),
      P(`Haha, ${name} it is then. I think it suits you!`, () => npc?.forceChat?.("Squee!")),
    ], () => shelterTalk(player, name));
  }

  /** After the name: the shelter is planned. Ours: a player who leaves before it hears it from here. */
  function shelterTalk(player, name) {
    play(player, [
      BOX(`${name} wobbles excitedly again. You feel like you're properly starting to understand each other.`),
      P("I think after that attack, you need a shelter to hide from those leeches in."),
      BOX(`${name} playfully goes in and out of their shell.`),
      P("Haha, I know you have your shell, but I don't think it's quite enough."),
      P("I'll go have a look for some materials to build a nice home for you."),
      BOX(`${name} gives you a concerned look. You can tell they're anxious about being left alone.`),
      P("I'll be quick!", () => { if (stageOf(player) === STAGE.NAMED) setStage(player, STAGE.SHELTER); }),
    ]);
    return true;
  }

  /** "Building a snail shelter": without sticks, without enough, and with the five. */
  function sticksTalk(player) {
    const name = nameOf(player);
    const sticks = held(player, ITEM.STICKS);
    const opening = [P(`Hey, ${name}!`), BOX(`${name} looks happy to see you.`)];
    if (sticks >= NEEDED) {
      play(player, [...opening,
        P("I've managed to find some strong sticks to make you a home with. I think I'll build it into this tree here."),
        BOX(`${name} wiggles in anticipation.`)]);
    } else {
      play(player, [...opening,
        P(sticks > 0
          ? "I've managed to find some strong sticks to build you a home with, but I need a few more. I'll keep looking."
          : "I haven't found any suitable materials for a home yet. I'll keep looking."),
        BOX(`${name} looks sad at the thought of you leaving again.`)]);
    }
    return true;
  }

  /** "After building the shelter" (the quick guide: build it, then talk to the snail once more). */
  function builtTalk(player) {
    const name = nameOf(player);
    play(player, [
      P(`I'm happy with that! What do you think, ${name}?`),
      BOX(`${name} sways in agreement.`),
      P("That should keep you protected from those leeches! Make sure you get in here as soon as you see them coming!"),
      BOX(`${name} gives you a look of confirmation.`),
      P(`I think you're mostly set. It might be time for me to go now, ${name}.`),
      BOX(`${name} gives you a sad look.`),
      P("I know, but I can't stay with you forever. I'll make sure to visit you all the time!"),
      BOX(`${name} looks morose, but accepts reality.`),
      P("As a last farewell, I'll gather you some more food before I go."),
      BOX(`${name} looks a bit happier.`),
      P("I'll be right back! Don't forget to use your shelter if the leeches come!",
        () => { if (stageOf(player) === STAGE.SHELTER_BUILT) setStage(player, STAGE.FAREWELL); }),
    ]);
    return true;
  }

  // --- the tree --------------------------------------------------------------------------------

  /** "Build-shelter" on the tree (multiloc 33159 at 12): an axe, then the five strong sticks. */
  function buildShelter(event) {
    const { player, definition } = event;
    if (definition?.id !== TREE_BUILDABLE) return false;
    if (stageOf(player) !== STAGE.SHELTER) return true;
    if (!hasUsableAxe(player)) {
      player.sendMessage("To carve out this tree, you'll need an axe that you have the Woodcutting level to use.");
      return true;
    }
    const sticks = held(player, ITEM.STICKS);
    if (sticks < NEEDED) {
      play(player, [P(sticks > 0
        ? "I have some good sticks for a shelter, but I think I'll need some more."
        : "I need to find some strong materials to build a shelter here.")]);
      return true;
    }
    // Ours: no animation or message is recorded for the build; the tree turns into the shelter (varbit 16854).
    player.getInventory().deleteNumber(ITEM.STICKS, NEEDED);
    player.getInventory().refreshItems();
    setStage(player, STAGE.SHELTER_BUILT);
    return true;
  }

  // --- stripping the branches ------------------------------------------------------------------

  /**
   * "Strip" (Restorative dew: 16 Herblore, 5 experience, 3 ticks, two dew a branch). Ours: one branch every three
   * ticks until none are left or the player moves; no animation or message is recorded.
   */
  function strip(event) {
    const { player } = event;
    if (player.getSkillManager().getMaxLevel(Skill.HERBLORE) < STRIP_LEVEL) {
      player.sendMessage(`You need a Herblore level of ${STRIP_LEVEL} to do that.`);
      return true;
    }
    const token = {};
    player.setAttribute(ATTRIBUTE.STRIPPING, token);
    const from = player.getLocation().clone();
    const next = () => TaskManager.submit(new CountdownTask(player, STRIP_TICKS, () => {
      if (player.getAttribute(ATTRIBUTE.STRIPPING) !== token || player.isRegistered?.() === false) return;
      if (!player.getLocation().equals(from) || held(player, ITEM.BRANCH) <= 0) {
        player.setAttribute(ATTRIBUTE.STRIPPING, null);
        return;
      }
      const inventory = player.getInventory();
      inventory.deleteNumber(ITEM.BRANCH, 1);
      inventory.add(new Item(ITEM.DEW, DEW_PER_BRANCH), false);
      inventory.refreshItems();
      player.getSkillManager().addExperiences(Skill.HERBLORE, STRIP_XP);
      next();
    }));
    next();
    return true;
  }

  // --- the gathering ---------------------------------------------------------------------------

  /** The set and spot index a ground item of the player's is. */
  function spotOf(player, groundItem) {
    const entry = tracked.get(player);
    if (!entry) return null;
    for (const [key, item] of entry.ground) {
      if (item !== groundItem) continue;
      const [set, tile] = key.split(":");
      if (!SETS[set]) return { set, index: -1, key };
      const [x, y] = tile.split(",").map(Number);
      return { set, index: SETS[set].spots.findIndex(([sx, sy]) => sx === x && sy === y), key };
    }
    return null;
  }

  /** "Trying to pick up more than 5 ...": held back, with the player's line. */
  function beforeTake(request) {
    const { player, groundItem } = request;
    if (!player || request.allow !== true) return;
    const spot = spotOf(player, groundItem);
    if (!spot || !SETS[spot.set] || !SETS[spot.set].enough(player)) return;
    request.allow = false;
    play(player, [P(SETS[spot.set].refusal)]);
  }

  /** A spot picked: it stays empty until a destroy; the fifth says it is enough and moves the stage on. */
  function afterTake({ player, groundItem }) {
    if (!player) return;
    const spot = spotOf(player, groundItem);
    if (!spot) return;
    state(player).ground.delete(spot.key);
    const set = SETS[spot.set];
    if (set) {
      player.setAttribute(ATTRIBUTE.PICKED[spot.set], pickedMask(player, spot.set) | (1 << spot.index));
      if (set.enough(player)) {
        play(player, [P(ENOUGH_LINE)]);
        const next = set.advance[stageOf(player)];
        if (next !== undefined) { setStage(player, next); return; }
      }
    }
    sync(player);
  }

  /** "If a leaf is destroyed, all the leaves that have been picked up will respawn" (and so the branches and sticks). */
  function destroyed({ player, itemId }) {
    if (!player) return;
    const set = itemId === ITEM.LEAVES ? "leaves" : itemId === ITEM.BRANCH ? "branches" : itemId === ITEM.STICKS ? "sticks"
      // Ours: destroyed dew brings the branches back too, so the balm can still be made.
      : itemId === ITEM.DEW ? "branches" : null;
    if (!set) return;
    player.setAttribute(ATTRIBUTE.PICKED[set], 0);
    sync(player);
  }

  const QUEST_ITEMS = new Set([ITEM.LEAVES, ITEM.BRANCH, ITEM.DEW, ITEM.STICKS]);
  function destroyPrompt(prompt) {
    if (QUEST_ITEMS.has(prompt?.item?.getId?.())) prompt.warning = DESTROY_NOTE;
  }

  // --- deaths, attacks and drops ---------------------------------------------------------------

  const ownerOf = (npc) => npc?.getOwner?.() ?? null;

  function npcDied({ npc }) {
    const player = ownerOf(npc);
    if (!player || !npc) return;
    const entry = tracked.get(player);
    if (npc.getId() === NPC.LEECH && entry?.leech === npc) {
      entry.leech = null;
      if (stageOf(player) === STAGE.LEAVES_GATHERED) setStage(player, STAGE.LEECH_KILLED);
    } else if (npc.getId() === NPC.LOVER_COMBAT && entry?.lover === npc) {
      entry.lover = null;
      if (stageOf(player) !== STAGE.AVENGE) return;
      // "Kill SnelmLover500 to complete the quest, causing him to drop a pink snelm" (Always, his drop table).
      const location = npc.getLocation().clone();
      api.emitCustomEvent("npc-drops:place", { player, drops: [{ itemId: ITEM.SNELM, amount: 1 }], location, npcId: npc.getId() });
      quest.complete(player);
      sync(player);
    }
  }

  /** The quest's NPCs drop nothing through the tables: the leech has none, SnelmLover500's snelm is placed above. */
  function claimDrops(claim) {
    if (claim.npcId === NPC.LEECH || claim.npcId === NPC.LOVER_COMBAT) claim.handled = true;
  }

  function snailDying(event) {
    if (event.npc?.getId?.() !== NPC.SNAIL) return;
    event.preventDeath = true;
    event.npc.setHitpoints(event.npc.getDefinition().getHitpoints());
  }

  /** The snail never fights back. */
  function snailAttacks(event) {
    if (event.attacker?.isNpc?.() && event.attacker.getAsNpc?.()?.getId?.() === NPC.SNAIL) event.allow = false;
  }

  // --- the player's whereabouts ----------------------------------------------------------------

  function enterWoods({ player }) {
    if (isBot(player)) return;
    sync(player);
  }

  function leaveWoods({ player }) {
    if (isBot(player)) return;
    clear(player);
  }

  /** Back on the island: the leech's ambush, or SnelmLover500 waiting by the shelter. */
  function arriveOnIsland({ player }) {
    if (isBot(player)) return;
    sync(player);
    const stage = stageOf(player);
    if (stage === STAGE.LEAVES_GATHERED) leechAmbush(player);
    else if (stage === STAGE.FOOD_GATHERED) confront(player);
    else if (stage === STAGE.AVENGE) attack(player);
  }

  function talkToLover({ player }) {
    const stage = stageOf(player);
    if (stage === STAGE.FOOD_GATHERED) confront(player);
    else if (stage === STAGE.AVENGE) attack(player);
    return true;
  }

  function handleLogin({ player }) {
    if (nameIndex(player) > 0) player.getPacketSender().sendVarbit(VARBIT_NAME, nameIndex(player));
  }

  function handleLogout({ player }) {
    if (player) clear(player);
  }

  // --- the journal -----------------------------------------------------------------------------

  const red = (text) => `<col=800000>${text}</col>`;
  const struck = (text) => `<str>${text}</str>`;

  /** Transcript:A Shell of a Friend/Journal; one paragraph a line, finished ones struck. */
  function buildJournal(player, handle) {
    const stage = handle.getStage(player);
    if (stage <= STAGE.NOT_STARTED) {
      return [`I can start this quest by finding a ${red("Lost Snail")} in the ${red("Haunted Woods")}.`];
    }
    const name = nameOf(player);
    const found = "I found a Young Snail on a small island in the Haunted Woods. It seemed lost and afraid. I decided to help it out by gathering it some food.";
    if (stage === STAGE.STARTED) {
      return [`I found a ${red("Young Snail")} on a small island in the ${red("Haunted Woods")}. It seemed lost and afraid. I decided to help it out by gathering it some food. I'll probably be able to find some ${red("Leaves")} for it to eat nearby.`];
    }
    const leaves = `I collected some ${red("Leaves")} from nearby for the ${red("Snail")} to eat.`;
    const leech = `${leaves} However, upon my return, I found it being attacked by a ${red("Leech")}. I was able to quickly defeat it, but not before the ${red("Snail")} was injured.`;
    const healed = "I collected some Leaves from nearby for the Snail to eat. However, upon my return, I found it being attacked by a Leech. I was able to quickly defeat it, but not before the Snail was injured. I searched nearby and found some Dew which I was able to heal the Snail with.";
    // Ours: the Wiki's journal transcript has no text after the leaves are gathered; this is its next paragraph's opening.
    if (stage === STAGE.LEAVES_GATHERED) return [struck(found), leaves];
    if (stage <= STAGE.FED) {
      return [struck(found), `${leech} I'll need to search nearby to find something to use as a ${red("Balm")} to heal the ${red("Snail")} with.`];
    }
    if (stage === STAGE.DEW_GATHERED) {
      return [struck(found), `${leech} I searched nearby and found some ${red("Dew")}. I should use it to heal the ${red("Snail")}.`];
    }
    // Ours: nor after the healing; the paragraph as the next journal strikes it, still current.
    if (stage === STAGE.HEALED) return [struck(found), `${leech} I searched nearby and found some ${red("Dew")} which I was able to heal the ${red("Snail")} with.`];
    const naming = `I decided to give the ${red("Snail")} a name: ${red(name)}. It seemed happy with my choice.`;
    if (stage === STAGE.NAMED) return [struck(found), struck(healed), `${naming} I should see how it's doing now.`];
    const shelter = `${naming} To better protect ${red(name)} from danger, I decided to build a shelter.`;
    if (stage === STAGE.SHELTER) return [struck(found), struck(healed), `${shelter} I should hopefully be able to find the materials to do so nearby.`];
    if (stage === STAGE.SHELTER_BUILT) return [struck(found), struck(healed), `${shelter} I should see how ${red(name)} feels about it.`];
    const sheltered = `I decided to give the Snail a name: ${name}. It seemed happy with my choice. To better protect ${name} from danger, I decided to build a shelter.`;
    const done = [struck(found), struck(healed), struck(sheltered)];
    const parting = `With a shelter built for ${red(name)}, it seemed like it was time for us to part ways.`;
    if (stage === STAGE.FAREWELL) return [...done, `${parting} However, I decided to gather a few more ${red("Leaves")} for it to eat first.`];
    if (stage === STAGE.FOOD_GATHERED) {
      return [...done, `${parting} However, I decided to gather a bit more food first. With that done, it's now time to say goodbye to ${red(name)}.`];
    }
    const lost = `However, I decided to gather a bit more food first. I collected some more ${red("Leaves")}, but upon my return, ${red(name)} was nowhere to be found. However, someone was there wearing a horrifyingly familiar looking ${red("Snelm")}.`;
    if (stage < STAGE.COMPLETE) return [...done, `${parting} ${lost} There is only one path ahead of me now. They must die.`];
    return [...done,
      struck(`With a shelter built for ${name}, it seemed like it was time for us to part ways. However, I decided to gather a bit more food first. I collected some more Leaves, but upon my return, ${name} was nowhere to be found. However, someone was there wearing a horrifyingly familiar looking Snelm. At that point, I did the only thing I could. I killed them. I can never undo what happened, but I can take some small solace in the fact that justice was served.`),
      "", "<col=ff0000>QUEST COMPLETE!</col>"];
  }

  function grantReward(player) {
    player.getSkillManager().addExperiences(Skill.HERBLORE, REWARD_XP);
    player.getSkillManager().addExperiences(Skill.CONSTRUCTION, REWARD_XP);
  }

  quest = registerQuest(api, {
    key: QUEST_KEY,
    name: QUEST_NAME,
    varbitId: VARBIT_STAGE,
    startedValue: STAGE.STARTED,
    completionValue: STAGE.COMPLETE,
    questPoints: 2,
    // The Wiki's reward scroll: the pink snelm pictured, the points and the two experience rewards.
    xpRewards: [
      { skillId: Skill.HERBLORE.getIndex(), amount: REWARD_XP, label: "Herblore" },
      { skillId: Skill.CONSTRUCTION.getIndex(), amount: REWARD_XP, label: "Construction" },
    ],
    scrollItemId: ITEM.SNELM,
    buildJournal,
    onReward: grantReward,
  });

  api.persistAttribute(ATTRIBUTE.NAME, 0);
  for (const key of Object.values(ATTRIBUTE.PICKED)) api.persistAttribute(key, 0);

  api.onNpcInteraction("Juvenile Snail", { "Talk-to": talkToSnail });
  api.onNpcInteraction("SnelmLover500", { "Talk-to": talkToLover });
  api.onObjectInteraction("Tree", { "Build-shelter": buildShelter });
  api.onItemAction("Dew-covered branch", { Strip: strip });
  api.onCustomEvent("ground-items:take", beforeTake);
  api.onCustomEvent("ground-items:taken", afterTake);
  api.onCustomEvent("destroy-item:destroyed", destroyed);
  api.onCustomEvent("destroy-item:prompt", destroyPrompt);
  api.onCustomEvent("npc-drops:claim", claimDrops);
  api.onNpcDeath(npcDied);
  api.onNpcBeforeDeath(snailDying);
  api.onCanAttack(snailAttacks);
  api.onZoneEnter(WOODS, enterWoods);
  api.onZoneExit(WOODS, leaveWoods);
  api.onZoneEnter(ISLAND, arriveOnIsland);
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handleLogout);
};

module.exports.STAGE = STAGE;
module.exports.VARBIT = { STAGE: VARBIT_STAGE, NAME: VARBIT_NAME };
module.exports.NAMES = NAMES;
module.exports.SPOTS = { LEAVES, BRANCHES, STICKS, AXE_SPOT };
module.exports.TILES = { SNAIL_TILE, LEECH_TILE, LOVER_TILE };
module.exports.ATTRIBUTE = ATTRIBUTE;
module.exports.QUEST_KEY = QUEST_KEY;
