/**
 * The Birds and the Wasps: ids, stages, saved state, the dialogue player and the journal the units share.
 *
 * Sources, in order: the game cache (osrs-242_2026-11-11: quest row 221, dbrow 17316 quest_birdsandthewasps; the
 * quest's NPCs, locs, items and varbits by gameval), then the OSRS Wiki (The Birds and the Wasps, its quick guide,
 * Transcript:The Birds and the Wasps, Transcript:The Birds and the Wasps/Journal, Transcript:Farmer Bea, and each
 * item's, NPC's and location's page). RuneLite's Quest Helper has no helper for this quest (neither the pinned
 * commit 06da90f nor master b9b9370 of 3 November 2026), and the original project has nothing for it.
 */
const QUEST_KEY = "the_birds_and_the_wasps";
const QUEST_NAME = "The Birds and the Wasps";

/**
 * The `baw` varbit (10992, bits 0-6 of varp baw_primary 6248). The cache fixes the end (55, the quest row's endstate)
 * and, through what its multi NPCs and locs show, these bounds: the bee dealer shows at 10-15; the equipment crate
 * opens above 20; the honey buzzards show at 35-55 and the black honey buzzards at 45-55; Bea shows at 0-50 and, with
 * her Trade and Swap-darts options, at 55. The values between are ours, one for each of the journal's sections.
 */
const STAGE = {
  NOT_STARTED: 0,
  STARTED: 10, // "Will do!": collect the bees from the dealer at the Grand Exchange
  BEES_COLLECTED: 15, // the dealer's box
  BEES_DELIVERED: 20, // the box handed to Bea; the hive scene plays
  WASPS: 25, // "Grab some kit outta me box 'ere": the crate and the wasp swarms
  WASPS_CAUGHT: 30, // 50 wasp stings: "Looks like I've caught enough."
  BIRDS: 35, // the honey buzzards scene: the birds, and Bea's bird snares
  BIRDS_CAUGHT: 40, // five birds and 50 brown feathers
  DARTS: 45, // the new hives' scene: make something of the stings and feathers
  DARTS_MADE: 50, // the first wasp darts
  COMPLETE: 55,
};

/** The quest's other varbits, all in varp baw_primary (6248). */
const VARBIT = {
  STAGE: 10992, // baw
  BIRDS_CAUGHT: 16847, // baw_birds_caught (4 bits)
  HAD_CIDER: 16848, // baw_had_cider
  WASPS_NOTIFIED: 16850, // baw_wasps_caught_notification
  BIRDS_NOTIFIED: 16852, // baw_birds_caught_notification
};

const ATTRIBUTE = {
  BIRDS_CAUGHT: "the-birds-and-the-wasps:birds-caught",
  HAD_CIDER: "the-birds-and-the-wasps:had-cider",
  WASPS_NOTIFIED: "the-birds-and-the-wasps:wasps-notified",
  BIRDS_NOTIFIED: "the-birds-and-the-wasps:birds-notified",
};

/** What Bea asks for (Transcript:The Birds and the Wasps). */
const WASPS_NEEDED = 50;
const BIRDS_NEEDED = 5;
const FEATHERS_NEEDED = 50;
const DARTS_NEEDED = 50;
/** Wiki (Farmer Bea, Bea's supplies): one supply bag for 35 wasp darts or 20 killer wasp darts. */
const WASP_DARTS_PER_BAG = 35;
const KILLER_WASP_DARTS_PER_BAG = 20;

function createCommon(api) {
  const {
    ActionDialogue, CacheDefinitions, DialogueChainBuilder, DoubleItemStatementDialogue, EndDialogue, ItemIdentifiers: I,
    ItemStatementDialogue, NpcDialogue, OptionDialogue, PlayerDialogue, StatementDialogue,
  } = api.core;
  const npc = (name) => {
    const id = CacheDefinitions.getNpcId(name);
    if (!Number.isInteger(id)) throw new Error(`The Birds and the Wasps: no NPC ${name} in the cache`);
    return id;
  };
  const NPC = {
    BEA_MULTI: npc("baw_bea_multi"),
    BEA: npc("baw_bea"),
    BEA_AFTER: npc("baw_bea_3ops"),
    DEALER_MULTI: npc("baw_bee_dealer_multi"),
    DEALER: npc("baw_bee_dealer"),
    HONEY_BUZZARD: npc("baw_honey_buzzard"),
  };
  const ITEM = {
    BEE_BOX: I.BEE_BOX,
    HAT: I.BEE_HUNTERS_HAT,
    NET: I.INSECT_NET,
    REPELLENT: I.INSECT_REPELLENT,
    SNARE: I.BIRD_SNARE,
    WASP_STING: I.WASP_STING,
    BROWN_FEATHER: I.BROWN_FEATHER,
    WASP_DART: I.WASP_DART,
    KILLER_WASP_DART: I.KILLER_WASP_DART,
    SUPPLIES: I.BEAS_SUPPLIES,
  };
  let quest = null;

  const stageOf = (player) => (quest ? quest.getStage(player) : 0);
  const complete = (player) => stageOf(player) >= STAGE.COMPLETE;
  const count = (player, key) => Number(player.getAttribute(key)) || 0;
  const flag = (player, key) => player.getAttribute(key) === true;
  const carried = (player, itemId) => player.getInventory().getAmount(itemId);
  const banked = (player, itemId) => (player.getBanks?.() ?? (player.getBank ? [player.getBank()] : []))
    .some((bank, tab) => tab !== api.core.Bank?.BANK_SEARCH_TAB_INDEX && Number(bank?.getAmount?.(itemId) ?? 0) > 0);

  /** The quest's varbits other than its stage (QuestRuntime sends that), as saved. */
  function sendState(player) {
    const sender = player.getPacketSender();
    sender.sendVarbit(VARBIT.BIRDS_CAUGHT, Math.min(15, count(player, ATTRIBUTE.BIRDS_CAUGHT)));
    sender.sendVarbit(VARBIT.HAD_CIDER, flag(player, ATTRIBUTE.HAD_CIDER) ? 1 : 0);
    sender.sendVarbit(VARBIT.WASPS_NOTIFIED, flag(player, ATTRIBUTE.WASPS_NOTIFIED) ? 1 : 0);
    sender.sendVarbit(VARBIT.BIRDS_NOTIFIED, flag(player, ATTRIBUTE.BIRDS_NOTIFIED) ? 1 : 0);
  }

  function setFlag(player, key, varbit) {
    player.setAttribute(key, true);
    player.getPacketSender().sendVarbit(varbit, 1);
  }

  function addBird(player) {
    const birds = Math.min(15, count(player, ATTRIBUTE.BIRDS_CAUGHT) + 1);
    player.setAttribute(ATTRIBUTE.BIRDS_CAUGHT, birds);
    player.getPacketSender().sendVarbit(VARBIT.BIRDS_CAUGHT, birds);
    return birds;
  }

  /** Runs `on` as the entry shows, before its text. */
  function hooked(entry, on) {
    if (!on) return entry;
    const send = entry.send.bind(entry);
    entry.send = (player) => { on(); send(player); };
    return entry;
  }

  /**
   * Plays a script. Entries: { npc, text } (the NPC's chat line), { player: text }, { box: text } (a message box),
   * { item, text }, { items: [a, b], text } (an item box with one or two items), { menu: title, options: [[label, fn],
   * ...] }; any entry may carry `on`, run as it shows. `then` runs after the last entry is continued; a chain that
   * ends without opening anything else closes the chatbox.
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
      if (entry.npc !== undefined) dialogue = new NpcDialogue(index, entry.npc, entry.text);
      else if (entry.player !== undefined) dialogue = new PlayerDialogue(index, entry.player);
      else if (entry.box !== undefined) dialogue = new StatementDialogue(index, entry.box);
      else if (entry.items) dialogue = new DoubleItemStatementDialogue(index, entry.items[0], entry.items[1], entry.text);
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
      // The chatbox closes first, so what `then` opens (another chat, Bea's shop) stays open.
      const action = new ActionDialogue(index++, { execute: () => { close(action); then(); } });
      chain.add(action);
    }
    chain.add(new EndDialogue(index));
    manager.startDialogues(chain);
  }

  return {
    STAGE, VARBIT, ATTRIBUTE, NPC, ITEM, QUEST_KEY, QUEST_NAME,
    WASPS_NEEDED, BIRDS_NEEDED, FEATHERS_NEEDED, DARTS_NEEDED, WASP_DARTS_PER_BAG, KILLER_WASP_DARTS_PER_BAG,
    setQuest: (handle) => { quest = handle; },
    quest: () => quest,
    stageOf, complete, count, flag, carried, banked, sendState, setFlag, addBird, play,
    setStage: (player, stage) => quest.setStage(player, stage),
  };
}

// ---------------------------------------------------------------------------- the journal

/**
 * Transcript:The Birds and the Wasps/Journal, section by section. "{" and "}" mark the names live shows in red while a
 * paragraph is the current one; a struck paragraph is plain. Where the Wiki's struck and current forms of a paragraph
 * differ (the second paragraph is the dealer's line once struck), each form is the Wiki's own.
 */
const PARAGRAPH = {
  agreed: "I spoke to {Farmer Bea} south west of the {Digsite} and agreed to help her set up her {Bee Farm}.",
  toDealer: "I spoke to {Farmer Bea} south west of the {Digsite} and agreed to help her set up her {Bee Farm}. To do so, I need"
    + " to head to the {Grand Exchange} in {Varrock} and collect some {Bees} from a {Bee Dealer} there. I should be able to"
    + " find him near the east entrance to the {Exchange}.",
  carrying: "At {Bea's} request, I travelled to the {Grand Exchange} in {Varrock} and collected some {Bees} from a {Bee Dealer}"
    + " there. I should carefully transport them back to {Bea}.",
  lost: " If I lose the {Bees}, I'll need to speak to the {Bee Dealer} about getting some more.",
  dealer: "The bee dealer gave me a box of bees. I should transport them safely back to Farmer Bea at her farm west of The Digsite.",
  delivered: "At Bea's request, I travelled to the Grand Exchange in Varrock and collected some Bees from a Bee Dealer there. I then"
    + " carefully delivered them to Bea. However, upon taking them to her hives, we discovered them to actually be Wasps.",
  wasps: "{Bea} asked me to thin down the number of {Wasps} by catching 50 of them and bringing her back proof. If needed, {Bea}"
    + " has a crate of equipment that I can use for catching them.",
  stingers: "{Bea} asked me to thin down the number of {Wasps} by catching 50 of them. I did so and gathered 50 {Wasp Stingers}"
    + " in the process. I should show them to {Bea}.",
  waspsDone: "Bea asked me to thin down the number of Wasps by catching 50 of them. I did so and gathered 50 Wasp Stings in the"
    + " process. However, the infestation of Wasps lured some Honey Buzzards to the area.",
  birds: "{Bea} asked me to thin down the number of {Honey Buzzards} by catching at least 5 of them and collecting 50 of their"
    + " feathers. If needed, {Bea} can give me some equipment that I can use for catching them.",
  feathers: "{Bea} asked me to thin down the number of {Honey Buzzards} by catching at least 5 of them and collecting 50 of their"
    + " feathers. Having done that, I should speak to {Bea} again.",
  birdsDone: "Bea asked me to thin down the number of Honey Buzzards by catching at least 5 of them and collecting 50 of their"
    + " feathers. With that done, Bea once again attempted to move some Bees into her hives. However, it seems the Bee Dealer"
    + " lied for a second time. The end result was that there were two different types of Wasps and two different types of"
    + " Honey Buzzard preying on them.",
  darts: "To make the best out of a bad situation, {Bea} has asked me to see if I can make anything out of the {Wasp Stings} and"
    + " {Feathers} I gathered.",
  dartsMade: "To make the best out of a bad situation, {Bea} asked me to see if I could make anything out of the {Wasp Stings}"
    + " and {Feathers} I gathered. I was able to use them to make some {Darts}. I should discuss this with {Bea}.",
  dartsDone: "To make the best out of a bad situation, Bea asked me to see if I could make anything out of the Wasp Stings and"
    + " Feathers I gathered. I was able to use them to make some Darts. While not thrilled over the lack of Honey, Bea was"
    + " happy that we at least managed to achieve something with her Bee-less Bee Farm.",
};

const LINE_WIDTH = 60;

/** Words to lines of at most LINE_WIDTH characters; a {name} never breaks. */
function wrap(text) {
  const words = text.match(/\{[^}]*\}[^\s{]*|\S+/g) ?? [];
  const lines = [];
  let line = "";
  const width = (value) => value.replace(/[{}]/g, "").length;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && width(next) > LINE_WIDTH) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

const current = (text) => wrap(text).map((line) => line.replace(/\{([^}]*)\}/g, "<col=800000>$1</col>"));
const struck = (text) => wrap(text).map((line) => `<str>${line.replace(/[{}]/g, "")}</str>`);

/** The journal for a stage; `lost` is the box neither carried nor banked while it is being taken to Bea. */
function journalLines(stage, lost = false) {
  if (stage < STAGE.STARTED) {
    return current("I can start this quest by talking to {Farmer Bea} south west of the {Digsite}.");
  }
  if (stage < STAGE.BEES_COLLECTED) return current(PARAGRAPH.toDealer);
  const lines = [...struck(PARAGRAPH.agreed)];
  if (stage < STAGE.BEES_DELIVERED) return [...lines, ...current(PARAGRAPH.carrying + (lost ? PARAGRAPH.lost : ""))];
  lines.push(...struck(PARAGRAPH.dealer), ...struck(PARAGRAPH.delivered));
  if (stage < STAGE.WASPS_CAUGHT) return [...lines, ...current(PARAGRAPH.wasps)];
  if (stage < STAGE.BIRDS) return [...lines, ...current(PARAGRAPH.stingers)];
  lines.push(...struck(PARAGRAPH.waspsDone));
  if (stage < STAGE.BIRDS_CAUGHT) return [...lines, ...current(PARAGRAPH.birds)];
  if (stage < STAGE.DARTS) return [...lines, ...current(PARAGRAPH.feathers)];
  lines.push(...struck(PARAGRAPH.birdsDone));
  if (stage < STAGE.DARTS_MADE) return [...lines, ...current(PARAGRAPH.darts)];
  if (stage < STAGE.COMPLETE) return [...lines, ...current(PARAGRAPH.dartsMade)];
  return [...lines, ...struck(PARAGRAPH.dartsDone), "", "<col=ff0000>QUEST COMPLETE!</col>"];
}

module.exports = {
  createCommon, journalLines, wrap, STAGE, VARBIT, ATTRIBUTE, QUEST_KEY, QUEST_NAME,
  WASPS_NEEDED, BIRDS_NEEDED, FEATHERS_NEEDED, DARTS_NEEDED, WASP_DARTS_PER_BAG, KILLER_WASP_DARTS_PER_BAG,
};
