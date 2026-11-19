// Run after `yarn build`: node --test tests/dig-site-second-half.test.cjs
//
// The Dig Site's second half ("Making a discovery"), from the third certificate to the reward, played by packet on
// real plugins, a real Player, the cache's own map objects and real NPCs: every conversation is talked or clicked
// through (npc_option, item_on_npc, object_option, item_on_object, inventory_use_on, inventory_action,
// dialogue_continue). Until this was built Terry Balando handed over a chemical compound, then an ancient talisman,
// then ended the quest, one conversation each.
//
// What each step rests on is in plugins/quests/digsite/Discovery.DigSite.js and Digging.DigSite.js (the OSRS Wiki's
// quest page, quick guide and transcripts, and the cache map).
process.env.DISABLE_PLAYER_BOTS = "1";
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { before, after, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { ClientConnection } = require("../dist/net/NetworkBuilder");
const { MapObjects } = require("../dist/game/entity/impl/object/MapObjects");
const { ObjectDefinition } = require("../dist/game/definition/ObjectDefinition");
const { ItemOnGroundManager } = require("../dist/game/entity/impl/grounditem/ItemOnGroundManager");
const { GroundItemSpawnDefinitionLoader } = require("../dist/game/definition/loader/impl/GroundItemSpawnDefinitionLoader");
const { ActionDialogue } = require("../dist/game/model/dialogues/entries/impl/ActionDialogue");
const { ItemStatementDialogue } = require("../dist/game/model/dialogues/entries/impl/ItemStatementDialogue");
const QuestRuntime = require("../plugins/quests/QuestRuntime");
const { JsonPlayerPersistence } = require("../plugins/persistence/JsonPlayerPersistence.plugin");

const DIG = "the_dig_site";
const DISCOVERY = "quest.the_dig_site.discovery";
const CONTINUE_CHILD = { 231: 5, 217: 5, 193: 0, 229: 2 };
// Stages.
// Stages (varp 131); from 6 on the live game's, as the Quest Helper reads them. 7 and 8 were also the old stand-in's.
const STARTED = 1, EXAMS_DONE = 4, INVITED = 5, SHAFTS = 6, POURED = 7, BLOWN = 8, COMPLETE = 9;
// Bits of the discovery attribute.
const ROPE_WEST = 1, ROPE_NORTH_EAST = 2, BARREL_OPEN = 4, BRICKS_SEARCHED = 8, CURRENT_STAGES = 16;
// Varbits of varp itdigsitemulti.
const VARBIT_WINCH_1 = 2545, VARBIT_WINCH_2 = 2546, VARBIT_BARREL = 2547, VARBIT_TABLET = 2548, VARBIT_HINT = 2549,
  VARBIT_EXPERT_LETTER = 2550;
// The cache map's placements.
const EXAM_CENTRE = [3353, 3336];
const WEST_WINCH = [3352, 3417], WEST_WINCH_FOOT = [3354, 3417];
const NORTH_EAST_WINCH = [3370, 3428], NORTH_EAST_WINCH_FOOT = [3370, 3427];
const DOUG_SHAFT = [3352, 9817]; // north of winchladder1 at 3352,9816
const BLOCKED_SHAFT = [3369, 9827]; // north of winchladder2 in the copy of the dungeon with the bricks
const BLOCKED_SHAFT_ROPE = [3369, 9826];
const OPEN_SHAFT = [3369, 9763]; // north of winchladder2 in the copy without them
/** Arcenia roots in the copy with the bricks: the Wiki's spawns in the other copy, 64 tiles north (see Discovery). */
const ROOTS_BEFORE_BLAST = [[3347, 9818], [3350, 9823], [3364, 9828], [3368, 9834]];
const BRICK = [3378, 9824];
const TABLET = [3373, 9746];
const CHEST = [3374, 3378];
const BARREL = [3364, 3378];
const TRAY = [3353, 3386];
const LEVEL_3_DIG = [3353, 3408];
const LEVEL_2_DIG = [3352, 3416];
const LEVEL_1_DIG = [3361, 3408];
const TRAINING_DIG = [3354, 3398];

let core;
let I;
let N;
let O;
let next = 9700;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  I = core.ItemIdentifiers;
  N = core.NpcIdentifiers;
  O = core.ObjectIdentifiers;
  core.RegionManager.init();
  for (const [x, y] of [EXAM_CENTRE, WEST_WINCH, NORTH_EAST_WINCH, DOUG_SHAFT, BLOCKED_SHAFT, OPEN_SHAFT, TABLET, BRICK,
    CHEST, BARREL, TRAY, LEVEL_3_DIG, LEVEL_1_DIG, TRAINING_DIG]) core.RegionManager.loadMapFiles(x, y);
  new GroundItemSpawnDefinitionLoader().load();
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));

const quest = () => QuestRuntime.getRegisteredQuests().find((entry) => entry.key === DIG);

function actor(t, stage, at = EXAM_CENTRE) {
  const channel = {
    kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true,
    close() {}, onData() {}, onError() {}, onClose() {},
  };
  const p = new Player(new PlayerSession(channel));
  p.setIndex(next++);
  p.setUsername("digsite" + p.getIndex());
  p.setRegistered(true);
  p.setLocation(new core.Location(at[0], at[1], 0));
  p.needsPlacement = false;
  const c = new ClientConnection(channel);
  c.player = p;
  const messages = [];
  const sendMessage = p.sendMessage.bind(p);
  t.mock.method(p, "sendMessage", (text) => { messages.push(String(text)); return sendMessage(text); });
  const overheads = [];
  const forceChat = p.forceChat.bind(p);
  t.mock.method(p, "forceChat", (text) => { overheads.push(String(text)); return forceChat(text); });
  t.after(() => {
    PM.emitPlayerLogout({ player: p, username: p.getUsername() });
    p.setRegistered(false);
    core.TaskManager.cancelTasks(p.getIndex());
    core.TaskManager.cancelTasks(p);
  });
  for (const skill of [core.Skill.AGILITY, core.Skill.HERBLORE, core.Skill.THIEVING]) p.getSkillManager().setCurrentLevel(skill, 50, false);
  quest().setStage(p, stage);
  // `said`: every chatbox line and box the player was shown, in order; `boxes`: the item pictured in each item box.
  return { p, c, inv: p.getInventory(), messages, overheads, said: [], boxes: [] };
}

const stageOf = (f) => quest().getStage(f.p);
const bits = (f) => Number(f.p.getAttribute(DISCOVERY)) || 0;
const varbit = (f, id) => f.p.getPacketSender().getVarbit(id);
const at = (f) => [f.p.getLocation().getX(), f.p.getLocation().getY()];
const stand = (f, [x, y]) => f.p.setLocation(new core.Location(x, y, 0));
const slotOf = (f, id) => f.inv.getItems().findIndex((held) => held?.getId() === id);
/**
 * The journal as one string, without its highlight colours: "<str>done</str> next". Each journal line is struck on its
 * own, so a run of struck lines reads as one struck run here.
 */
const journal = (f) => quest().buildJournal(f.p, quest()).join(" ").split("<col=800000>").join("").split("</col>").join("")
  .split("</str> <str>").join(" ");
const experience = (f, skill) => f.p.getSkillManager().getExperience(skill);
/** What the inventory holds, as "id x amount" sorted: for nothing-lost, nothing-doubled checks. */
const holding = (f) => f.inv.getItems().filter((held) => held && held.getId() > 0)
  .map((held) => `${held.getId()}x${held.getAmount()}`).sort().join(",");

function give(f, ...ids) {
  for (const id of ids) f.inv.add(new core.Item(id, 1), false);
  f.inv.refreshItems();
}

function fill(f, filler = I.RAKE) {
  while (f.inv.getFreeSlots() > 0) f.inv.add(new core.Item(filler, 1), false);
  f.inv.refreshItems();
  assert.equal(f.inv.getFreeSlots(), 0, "control: the bag is full");
}

function remove(f, id, amount = 1) {
  f.inv.deleteNumber(id, amount);
  f.inv.refreshItems();
}

function ticks(f, count) {
  for (let i = 0; i < count; i++) {
    core.World.processCycle++;
    core.TaskManager.processWalkTo(f.p.getIndex());
    f.p.getMovementQueue().process();
    core.TaskManager.process();
    // The player update clears these at the end of every cycle; no update runs here.
    f.p.setNeedsPlacement(false);
    f.p.setResetMovementQueue(false);
  }
}

async function send(f, packet) {
  await f.c.dispatch([packet]);
  f.c.processTurnPackets();
}

/** Plays what's open, answering menus from `answers`; stops at a menu it has no answer for. */
async function playChat(f, answers = []) {
  const queue = [...answers];
  let shown = null;
  for (let i = 0; i < 160; i++) {
    const menu = core.MultiChatboxPrompt.getPending(f.p);
    if (menu) {
      const choice = menu.options.findIndex((option) => queue[0] !== undefined && option.startsWith(queue[0]));
      if (choice < 0) return menu.options;
      queue.shift();
      await send(f, { type: "dialogue_continue", widgetId: core.MultiChatboxPrompt.OPTIONS_WIDGET_ID, childIndex: choice + 1 });
      ticks(f, 1);
      continue;
    }
    const manager = f.p.getDialogueManager();
    if (!manager.isActive()) {
      ticks(f, 2);
      if (!manager.isActive() && !core.MultiChatboxPrompt.getPending(f.p)) return null;
      continue;
    }
    const current = manager.getCurrent();
    if (current !== shown && typeof current?.getText === "function") {
      shown = current;
      f.said.push(current.getText());
      if (current instanceof ItemStatementDialogue) f.boxes.push(current.itemId ?? current.getItemId?.());
    }
    const group = f.p.getPacketSender().getChatboxGroupId();
    if (!(current instanceof ActionDialogue) && group in CONTINUE_CHILD) {
      await send(f, { type: "dialogue_continue", widgetId: (group << 16) | CONTINUE_CHILD[group], childIndex: -1 });
    }
    ticks(f, 1);
  }
  return null;
}

/** An NPC standing beside the player, for one conversation or item use. */
function beside(t, f, npcId) {
  const [x, y] = at(f);
  const npc = core.NPC.create(npcId, new core.Location(x + 1, y, 0));
  core.World.getNpcs().add(npc);
  t.after(() => core.World.getNpcs().remove(npc));
  return npc;
}

async function talk(t, f, npcId, answers, option = "Talk-to") {
  const npc = beside(t, f, npcId);
  const actions = npc.getCurrentDefinition(f.p).getActions();
  const index = actions.findIndex((action) => action === option);
  assert.ok(index >= 0, `control: ${npcId} has ${option}: ${JSON.stringify(actions)}`);
  await send(f, { type: "npc_option", index: npc.getIndex(), clickType: index + 1 });
  ticks(f, 3);
  const left = await playChat(f, answers);
  f.p.getDialogueManager().reset();
  core.World.getNpcs().remove(npc);
  return left;
}

async function useOnNpc(t, f, itemId, npcId, answers) {
  const npc = beside(t, f, npcId);
  const slot = slotOf(f, itemId);
  assert.ok(slot >= 0, `control: the player carries item ${itemId}`);
  await send(f, { type: "item_on_npc", targetIndex: npc.getIndex(), itemId, slot, widgetId: 149 << 16 });
  ticks(f, 3);
  await playChat(f, answers);
  f.p.getDialogueManager().reset();
  core.World.getNpcs().remove(npc);
}

/** A map object's option, clicked from where the player stands (they walk the rest). */
async function click(f, id, [x, y], option, answers) {
  const definition = ObjectDefinition.forPlayer(id, f.p);
  assert.ok((definition?.getActions() ?? []).includes(option), `control: loc ${id} offers ${option}: ${JSON.stringify(definition?.getActions())}`);
  await send(f, { type: "object_option", id, x, y, action: option });
  ticks(f, 8);
  await playChat(f, answers);
  f.p.getDialogueManager().reset();
}

async function useOnObject(f, itemId, id, [x, y], answers) {
  const slot = slotOf(f, itemId);
  assert.ok(slot >= 0, `control: the player carries item ${itemId}`);
  await send(f, { type: "item_on_object", widgetId: 149 << 16, objectId: id, itemId, slot, x, y });
  ticks(f, 8);
  await playChat(f, answers);
  f.p.getDialogueManager().reset();
}

async function useOnItem(f, usedId, targetId) {
  const slot = slotOf(f, usedId);
  const target = slotOf(f, targetId);
  assert.ok(slot >= 0 && target >= 0, `control: the player carries ${usedId} and ${targetId}`);
  await send(f, { type: "inventory_use_on", slot, itemId: usedId, target: { kind: "inventory", slot: target, id: targetId } });
  ticks(f, 2);
  await playChat(f);
  f.p.getDialogueManager().reset();
}

async function itemOption(f, itemId, option) {
  const slot = slotOf(f, itemId);
  assert.ok(slot >= 0, `control: the player carries item ${itemId}`);
  await send(f, { type: "inventory_action", slot, itemId, widgetId: 3214, option });
  ticks(f, 2);
  await playChat(f);
  f.p.getDialogueManager().reset();
}

const barrelId = () => core.CacheDefinitions.getLocId("digbarrelclosed");
const tabletId = () => core.CacheDefinitions.getLocId("qip_digsite_zaros_stone_tablet_multiloc");
const rootAt = ([x, y]) => core.World.getItems().some((item) => item.getItem().getId() === I.ARCENIA_ROOT
  && item.getPosition().getX() === x && item.getPosition().getY() === y && item.getPosition().getZ() === 0);
const standsAt = (id, [x, y]) => MapObjects.getObjectsAt(new core.Location(x, y, 0), null).some((object) => object.getId() === id);
const onFloor = (f, id) => ItemOnGroundManager.getGroundItem(f.p.getUsername(), id, f.p.getLocation(), null);

async function reload(t, original) {
  const directory = mkdtempSync(path.join(tmpdir(), "tsps-digsite2-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new JsonPlayerPersistence(directory);
  await store.save(original.p);
  const restored = actor(t, 0);
  restored.p.setUsername(original.p.getUsername());
  store.load(original.p.getUsername()).applyToPlayer(restored.p);
  return restored;
}

// ------------------------------------------------------------------ the whole route

test("the discovery from the third certificate to the reward, as one played-through route", async (t) => {
  const f = actor(t, EXAMS_DONE);
  give(f, I.LEVEL_1_CERTIFICATE, I.LEVEL_2_CERTIFICATE, I.LEVEL_3_CERTIFICATE, I.TROWEL, I.SPECIMEN_JAR, I.SPECIMEN_BRUSH,
    I.ROPE, I.ROPE, I.VIAL, I.TINDERBOX, I.PESTLE_AND_MORTAR, I.CHARCOAL);
  assert.equal(journal(f), "<str>I passed the three examinations.</str> I need a find from the digsite to impress the Expert.");

  // Terry has nothing of the discovery to say, and hands nothing over, until there is a find.
  await talk(t, f, N.TERRY_BALANDO, ["No thanks."]);
  assert.equal(stageOf(f), EXAMS_DONE);
  assert.equal(f.inv.getAmount(I.CHEMICAL_COMPOUND), 0, "the stand-in's compound is gone");
  assert.equal(f.inv.getAmount(I.LEVEL_3_CERTIFICATE), 1, "and he no longer takes the certificates");
  assert.ok(f.said.includes("Good day to you. My name is Terry Balando; I am an expert on digsite finds."), f.said.join(" | "));

  // The talisman: a trowel on the soil of a level 3 dig.
  stand(f, LEVEL_3_DIG);
  const soil = MapObjects.getObjectsAt(new core.Location(...LEVEL_3_DIG, 0), null).find((object) => /^Soil$/.test(ObjectDefinition.forId(object.getId())?.getName() ?? ""));
  assert.ok(soil, "control: soil lies on the level 3 dig's tile");
  t.mock.method(Math, "random", () => 0); // the talisman's slot of the 20
  const miningBefore = experience(f, core.Skill.MINING);
  f.said.length = 0;
  await useOnObject(f, I.TROWEL, soil.getId(), LEVEL_3_DIG);
  assert.equal(f.inv.getAmount(I.ANCIENT_TALISMAN), 1, f.messages.join(" | "));
  assert.deepEqual(f.said, ["You find a strange talisman."]);
  assert.deepEqual(f.boxes, [I.ANCIENT_TALISMAN], "shown in an item box, as the transcript's");
  assert.ok(experience(f, core.Skill.MINING) > miningBefore, "a dig gives Mining experience");
  await useOnObject(f, I.TROWEL, soil.getId(), LEVEL_3_DIG);
  assert.equal(f.inv.getAmount(I.ANCIENT_TALISMAN), 1, "no second talisman while one is carried");
  assert.equal(f.inv.getAmount(I.COINS), 10, "its slot pays 10 coins instead");
  Math.random.mock.restore();
  remove(f, I.COINS, 10);

  // Terry takes the talisman and writes the invitation.
  stand(f, EXAM_CENTRE);
  f.said.length = 0;
  await talk(t, f, N.TERRY_BALANDO);
  assert.equal(f.said[0], "Take a look at this talisman.");
  assert.equal(f.said.at(-1), "You obviously have a keen eye. Take this letter and give it to one of the workmen, and they will allow you to use them.");
  assert.equal(f.inv.getAmount(I.ANCIENT_TALISMAN), 0, "he keeps the talisman");
  assert.equal(f.inv.getAmount(I.INVITATION_LETTER), 1);
  assert.equal(stageOf(f), INVITED);
  assert.equal(varbit(f, VARBIT_EXPERT_LETTER), 1, "itexpertletter: the Quest Helper's \"given the talisman in\"");
  assert.ok(journal(f).endsWith("I need a find from the digsite to impress the Expert.</str> I need to take the letter to a workman near a winch."), journal(f));
  f.said.length = 0;
  await itemOption(f, I.INVITATION_LETTER, "Read");
  assert.deepEqual(f.said, ["It says, 'I give permission for the bearer... to use the mine shafts on site. - signed Terrance Balando, Archaeological Expert, City of Varrock.'"]);
  f.said.length = 0;
  await useOnNpc(t, f, I.INVITATION_LETTER, N.TERRY_BALANDO);
  assert.deepEqual(f.said, ["There's no point in giving me this back!"]);
  assert.equal(f.inv.getAmount(I.INVITATION_LETTER), 1);

  // The winches are closed until a workman has the letter.
  stand(f, WEST_WINCH_FOOT);
  f.said.length = 0;
  await click(f, O.WINCH_2, WEST_WINCH, "Operate");
  assert.deepEqual(at(f), WEST_WINCH_FOOT);
  assert.equal(f.said[0], "Sorry; this area is private. The only way you'll get to use these is by impressing the archaeological expert up at the centre.", f.said.join(" | "));
  await useOnObject(f, I.ROPE, O.WINCH_2, WEST_WINCH);
  assert.equal(f.inv.getAmount(I.ROPE), 2, "no rope is tied without permission");
  stand(f, NORTH_EAST_WINCH_FOOT);
  f.messages.length = 0;
  await click(f, O.WINCH_3, NORTH_EAST_WINCH, "Operate");
  assert.deepEqual(f.messages, ["There is a sign on the winch.", "Private area - invitation only."]);
  assert.deepEqual(at(f), NORTH_EAST_WINCH_FOOT);

  // A workman takes the letter.
  f.said.length = 0;
  await useOnNpc(t, f, I.INVITATION_LETTER, N.DIGSITE_WORKMAN);
  assert.deepEqual(f.said, ["Here, have a look at this...",
    "I give permission... blah de blah... etc. Okay, that's all in order; you may use the mineshaft now. I'll hang onto this scroll, shall I?"]);
  assert.equal(f.inv.getAmount(I.INVITATION_LETTER), 0);
  assert.equal(stageOf(f), SHAFTS);
  assert.ok(journal(f).endsWith("I need to take the letter to a workman near a winch.</str> I need to investigate the dig shafts."), journal(f));

  // The west winch: no rope, a rope, too little Agility, and down.
  stand(f, WEST_WINCH_FOOT);
  f.said.length = 0;
  f.messages.length = 0;
  await click(f, O.WINCH_2, WEST_WINCH, "Operate");
  assert.deepEqual(f.messages, ["You operate the winch.", "The bucket descends, but does not reach the bottom."]);
  assert.deepEqual(f.said, ["Hey, I think I could fit down here. I need something to help me get all the way down."]);
  assert.deepEqual(at(f), WEST_WINCH_FOOT);
  f.messages.length = 0;
  await useOnObject(f, I.ROPE, O.WINCH_2, WEST_WINCH);
  assert.deepEqual(f.messages, ["You tie the rope to the bucket."]);
  assert.equal(f.inv.getAmount(I.ROPE), 1, "the rope stays on the winch");
  assert.equal(bits(f) & ROPE_WEST, ROPE_WEST);
  assert.equal(varbit(f, VARBIT_WINCH_1), 1);
  assert.equal(varbit(f, VARBIT_WINCH_2), 0);
  await useOnObject(f, I.ROPE, O.WINCH_2, WEST_WINCH);
  assert.equal(f.inv.getAmount(I.ROPE), 1, "a second rope is not taken");
  f.p.getSkillManager().setCurrentLevel(core.Skill.AGILITY, 9, false);
  f.messages.length = 0;
  await click(f, O.WINCH_2, WEST_WINCH, "Operate");
  assert.deepEqual(f.messages, ["You try to climb down the rope.", "You need an Agility level of 10 to squeeze down the shaft."]);
  assert.deepEqual(at(f), WEST_WINCH_FOOT);
  f.p.getSkillManager().setCurrentLevel(core.Skill.AGILITY, 10, false);
  const agilityBefore = experience(f, core.Skill.AGILITY);
  f.messages.length = 0;
  await click(f, O.WINCH_2, WEST_WINCH, "Operate");
  assert.deepEqual(f.messages, ["You try to climb down the rope.", "You lower yourself into the shaft.", "You find yourself in a cavern..."]);
  assert.deepEqual(at(f), BLOCKED_SHAFT, "the copy of the dungeon whose bricks stand");
  assert.ok(experience(f, core.Skill.AGILITY) > agilityBefore);

  // An arcenia root from the floor just north of the rope.
  const root = ROOTS_BEFORE_BLAST[3];
  assert.ok(rootAt(root), "a root lies at " + root);
  await send(f, { type: "ground_item_action", itemId: I.ARCENIA_ROOT, x: root[0], y: root[1], option: "Take" });
  ticks(f, 12);
  assert.equal(f.inv.getAmount(I.ARCENIA_ROOT), 1, f.messages.join(" | "));
  stand(f, BLOCKED_SHAFT);

  // The bricks, searched and tried.
  stand(f, [BRICK[0], BRICK[1] + 1]);
  f.said.length = 0;
  await click(f, O.BRICK_8, BRICK, "Search");
  assert.deepEqual(f.said, ["Hmmm, there's a room past these bricks. If I could move them out of the way then I could find out what's inside. Maybe there's someone around here who can help..."]);
  assert.ok(journal(f).endsWith("I need to investigate the dig shafts. I need to find a way to move the rocks blocking the way in the shaft. Perhaps someone can help me."), journal(f));
  await useOnObject(f, I.TINDERBOX, O.BRICK_8, BRICK);
  assert.deepEqual(f.overheads, ["Now, what am I trying to achieve here?"]);
  assert.equal(stageOf(f), SHAFTS);
  assert.equal(bits(f) & BRICKS_SEARCHED, BRICKS_SEARCHED);
  assert.equal(varbit(f, VARBIT_HINT), 1, "itdigsitehint: the bricks have been searched");

  // Back up the rope, and down the other winch to Doug Deeping.
  stand(f, BLOCKED_SHAFT);
  await click(f, O.ROPE_3, BLOCKED_SHAFT_ROPE, "Climb-up");
  assert.deepEqual(at(f), WEST_WINCH_FOOT);
  stand(f, NORTH_EAST_WINCH_FOOT);
  await useOnObject(f, I.ROPE, O.WINCH_3, NORTH_EAST_WINCH);
  assert.equal(f.inv.getAmount(I.ROPE), 0);
  assert.equal(varbit(f, VARBIT_WINCH_2), 1);
  await click(f, O.WINCH_3, NORTH_EAST_WINCH, "Operate");
  assert.deepEqual(at(f), DOUG_SHAFT);
  f.said.length = 0;
  await talk(t, f, N.DOUG_DEEPING, ["How could I move a large pile of rocks?"]);
  assert.equal(f.said.at(-1), "Doug hands you a key.", f.said.join(" | "));
  assert.equal(f.boxes.at(-1), I.CHEST_KEY_2);
  assert.equal(f.inv.getAmount(I.CHEST_KEY_2), 1);
  f.said.length = 0;
  await talk(t, f, N.DOUG_DEEPING, ["How could I move a large pile of rocks?"]);
  assert.equal(f.said.at(-1), "It's ok, I already have one.");
  assert.equal(f.inv.getAmount(I.CHEST_KEY_2), 1, "one key");
  // Up Doug's rope (the captured loc teleport) to the north-east winch.
  await click(f, O.ROPE_2, [DOUG_SHAFT[0], DOUG_SHAFT[1] - 1], "Climb-up");
  assert.deepEqual(at(f), NORTH_EAST_WINCH_FOOT);

  // The chest in the panning tent: the key opens it and is used up; a search finds the powder.
  stand(f, [CHEST[0] - 1, CHEST[1]]);
  await useOnObject(f, I.CHEST_KEY_2, O.CHEST_9, CHEST);
  assert.equal(f.inv.getAmount(I.CHEST_KEY_2), 0);
  assert.ok(standsAt(O.CHEST_8, CHEST) && !standsAt(O.CHEST_9, CHEST), "the chest stands open");
  f.said.length = 0;
  await click(f, O.CHEST_8, CHEST, "Search");
  assert.deepEqual(f.said, ["You find some unusual powder inside..."]);
  assert.equal(f.boxes.at(-1), I.CHEMICAL_POWDER);
  assert.equal(f.inv.getAmount(I.CHEMICAL_POWDER), 1);
  await click(f, O.CHEST_8, CHEST, "Close");
  assert.ok(standsAt(O.CHEST_9, CHEST) && !standsAt(O.CHEST_8, CHEST), "and shuts again");

  // The barrel west of the tent: shut tight, levered open with the trowel, a vial filled, the lid back on.
  stand(f, [BARREL[0] - 1, BARREL[1]]);
  f.said.length = 0;
  await click(f, barrelId(), BARREL, "Open");
  await click(f, barrelId(), BARREL, "Search");
  assert.deepEqual(f.said, ["Mmmm... The lid is shut tight; I'll have to find something to lever it off.", "It's closed tight."]);
  await useOnObject(f, I.VIAL, barrelId(), BARREL);
  assert.equal(f.inv.getAmount(I.VIAL), 1, "a shut barrel fills no vial");
  f.said.length = 0;
  await useOnObject(f, I.TROWEL, barrelId(), BARREL);
  assert.deepEqual(f.said, ["Great! It's opened."]);
  assert.equal(varbit(f, VARBIT_BARREL), 1);
  assert.equal(ObjectDefinition.forPlayer(barrelId(), f.p).id, O.BARREL_91, "the player sees the open barrel");
  f.said.length = 0;
  await click(f, barrelId(), BARREL, "Search");
  assert.deepEqual(f.said, ["I can't pick this up with my bare hands! I'll need something to put it in. It looks and smells rather dangerous though, so it'll need to be something small and capable of containing dangerous chemicals."]);
  f.said.length = 0;
  f.messages.length = 0;
  await useOnObject(f, I.VIAL, barrelId(), BARREL);
  assert.deepEqual(f.said, ["You fill the vial with the liquid.", "I'm not sure what this stuff is. I had better be VERY careful with it; I had better not drop it either..."]);
  assert.deepEqual(f.messages, ["You put the lid back on the barrel just in case it's dangerous."]);
  assert.equal(f.inv.getAmount(I.VIAL), 0);
  assert.equal(f.inv.getAmount(I.UNIDENTIFIED_LIQUID), 1);
  assert.equal(varbit(f, VARBIT_BARREL), 0, "the lid is back on");

  // Unidentified, the two do not mix; Terry names them.
  await useOnItem(f, I.CHEMICAL_POWDER, I.UNIDENTIFIED_LIQUID);
  assert.equal(f.inv.getAmount(I.MIXED_CHEMICALS), 0);
  stand(f, EXAM_CENTRE);
  f.said.length = 0;
  await useOnNpc(t, f, I.CHEMICAL_POWDER, N.TERRY_BALANDO);
  assert.deepEqual(f.said, ["Do you know what this powder is?",
    "Really, you do find the most unusual items. I know what this is, it's a strong chemical called ammonium nitrate. Why you want this I'll never know..."]);
  assert.equal(f.inv.getAmount(I.CHEMICAL_POWDER), 0);
  assert.equal(f.inv.getAmount(I.AMMONIUM_NITRATE), 1);
  f.said.length = 0;
  await useOnNpc(t, f, I.UNIDENTIFIED_LIQUID, N.TERRY_BALANDO);
  assert.equal(f.said.at(-1), "This is a VERY dangerous liquid called nitroglycerin. Be careful how you handle it. Don't drop it or it will explode!");
  assert.equal(f.inv.getAmount(I.UNIDENTIFIED_LIQUID), 0);
  assert.equal(f.inv.getAmount(I.NITROGLYCERIN), 1);

  // The charcoal is ground and the compound mixed, in its order.
  await useOnItem(f, I.PESTLE_AND_MORTAR, I.CHARCOAL);
  assert.equal(f.inv.getAmount(I.GROUND_CHARCOAL), 1);
  assert.equal(f.inv.getAmount(I.CHARCOAL), 0);
  const herbloreBefore = experience(f, core.Skill.HERBLORE);
  await useOnItem(f, I.AMMONIUM_NITRATE, I.NITROGLYCERIN);
  assert.equal(f.inv.getAmount(I.MIXED_CHEMICALS), 1);
  assert.equal(f.inv.getAmount(I.AMMONIUM_NITRATE) + f.inv.getAmount(I.NITROGLYCERIN), 0);
  await useOnItem(f, I.GROUND_CHARCOAL, I.MIXED_CHEMICALS);
  assert.equal(f.inv.getAmount(I.MIXED_CHEMICALS_2), 1);
  assert.equal(f.inv.getAmount(I.GROUND_CHARCOAL) + f.inv.getAmount(I.MIXED_CHEMICALS), 0);
  f.said.length = 0;
  await useOnItem(f, I.ARCENIA_ROOT, I.MIXED_CHEMICALS_2);
  assert.deepEqual(f.said, ["Excellent! This looks just right!"]);
  assert.equal(f.inv.getAmount(I.CHEMICAL_COMPOUND), 1);
  assert.equal(f.inv.getAmount(I.ARCENIA_ROOT) + f.inv.getAmount(I.MIXED_CHEMICALS_2), 0);
  const rate = experience(f, core.Skill.HERBLORE) - herbloreBefore;
  assert.ok(rate > 0 && Math.abs(rate / 7.5 - Math.round(rate / 7.5)) < 1e-6, `2 + 2.5 + 3 Herblore experience, at the world's rate: ${rate}`);

  // Down the west winch again: the compound on the bricks, the tinderbox, and the wall is gone.
  stand(f, WEST_WINCH_FOOT);
  await click(f, O.WINCH_2, WEST_WINCH, "Operate");
  assert.deepEqual(at(f), BLOCKED_SHAFT, "the bricks still stand for this player");
  stand(f, [BRICK[0], BRICK[1] + 1]);
  f.said.length = 0;
  f.messages.length = 0;
  await useOnObject(f, I.CHEMICAL_COMPOUND, O.BRICK_8, BRICK);
  assert.deepEqual(f.messages, ["You pour the compound over the bricks..."]);
  assert.deepEqual(f.said, ["Okay, the mixture is all over the bricks. I need some way to ignite this compound."]);
  assert.equal(f.inv.getAmount(I.CHEMICAL_COMPOUND), 0);
  assert.equal(stageOf(f), POURED);
  assert.ok(journal(f).endsWith("I covered the rocks in the cave with an Explosive Compound.</str> I need to ignite the Explosive Compound and blow up the rocks blocking the way."), journal(f));
  f.said.length = 0;
  f.messages.length = 0;
  await useOnObject(f, I.TINDERBOX, O.BRICK_8, BRICK);
  assert.deepEqual(f.messages, ["You strike the tinderbox...", "Fizz..."]);
  assert.deepEqual(f.said, ["Whoa! This is going to blow! I'd better run!",
    "Wow, that was a big explosion! What's that noise I can hear? Sounds like bones moving or something..."]);
  assert.equal(f.inv.getAmount(I.TINDERBOX), 1, "the tinderbox is kept");
  assert.equal(stageOf(f), BLOWN);
  assert.deepEqual(at(f), OPEN_SHAFT, "the foot of the rope, in the copy of the dungeon without the bricks");
  assert.ok(!standsAt(O.BRICK_8, [BRICK[0], BRICK[1] - 64]), "control: no brick stands in that copy");
  assert.ok(journal(f).endsWith("I should look for an interesting find in the secret room I found, and show it to the Expert at the Exam Centre."), journal(f));

  // The stone tablet, from the altar room.
  assert.equal(varbit(f, VARBIT_TABLET), 0);
  stand(f, [TABLET[0], TABLET[1] + 1]);
  await click(f, tabletId(), TABLET, "Take");
  assert.equal(f.inv.getAmount(I.STONE_TABLET), 1);
  assert.equal(varbit(f, VARBIT_TABLET), 1, "bare floor where it lay");
  assert.equal((ObjectDefinition.forPlayer(tabletId(), f.p)?.getActions() ?? []).includes("Take"), false);
  f.said.length = 0;
  await itemOption(f, I.STONE_TABLET, "Read");
  assert.deepEqual(f.said, ["It says: Tremble mortal, before the altar of our dread lord Zaros."]);

  // Up the rope (the captured loc teleport) and to Terry: the quest's end, paid once.
  stand(f, OPEN_SHAFT);
  await click(f, O.ROPE_3, [OPEN_SHAFT[0], OPEN_SHAFT[1] - 1], "Climb-up");
  assert.deepEqual(at(f), WEST_WINCH_FOOT);
  stand(f, EXAM_CENTRE);
  const before = { mining: experience(f, core.Skill.MINING), herblore: experience(f, core.Skill.HERBLORE),
    points: Number(f.p.getAttribute(QuestRuntime.QUEST_POINTS_ATTRIBUTE)) || 0 };
  f.said.length = 0;
  await talk(t, f, N.TERRY_BALANDO);
  assert.equal(f.said[0], "I found this in a hidden cavern beneath the digsite.");
  assert.equal(f.said.at(-1), "The expert gives you 2 gold bars as payment.", f.said.join(" | "));
  assert.equal(f.boxes.at(-1), I.GOLD_BAR);
  assert.equal(quest().isComplete(f.p), true);
  assert.equal(f.inv.getAmount(I.STONE_TABLET), 0, "he keeps the tablet");
  assert.equal(f.inv.getAmount(I.GOLD_BAR), 2);
  assert.equal((Number(f.p.getAttribute(QuestRuntime.QUEST_POINTS_ATTRIBUTE)) || 0) - before.points, 2);
  const paid = { mining: experience(f, core.Skill.MINING) - before.mining, herblore: experience(f, core.Skill.HERBLORE) - before.herblore };
  assert.ok(paid.mining > 0 && paid.herblore > 0);
  assert.ok(Math.abs(paid.mining / paid.herblore - 15300 / 2000) < 1e-6, "15,300 Mining and 2,000 Herblore experience, at the world's rate");
  assert.equal(f.inv.getAmount(I.LEVEL_3_CERTIFICATE), 1, "the certificates were never his to take");
  assert.ok(journal(f).endsWith("The expert was impressed with the Zaros Tablet that I found, and I also discovered an ancient altar! I was rewarded for my findings. My work here is done.</str>  <col=ff0000>QUEST COMPLETE!"), journal(f));

  // Afterwards: nothing is paid or handed over again, and the wall stays open.
  f.p.getDialogueManager().reset();
  f.p.getPacketSender().sendInterfaceRemoval();
  f.said.length = 0;
  const left = await talk(t, f, N.TERRY_BALANDO, ["Ask about the Digsite quest."]);
  assert.equal(left, null);
  assert.equal(f.said[0], "Hello again. I am now studying this mysterious altar and its inhabitants. The markings are strange...", f.said.join(" | "));
  assert.equal(f.inv.getAmount(I.GOLD_BAR), 2);
  stand(f, WEST_WINCH_FOOT);
  await click(f, O.WINCH_2, WEST_WINCH, "Operate");
  assert.deepEqual(at(f), OPEN_SHAFT, "the west winch leads to the open dungeon from now on");
  assert.equal(varbit(f, VARBIT_TABLET), 0, "another tablet lies there for a player who carries none (Wiki)");
  stand(f, [TABLET[0], TABLET[1] + 1]);
  await click(f, tabletId(), TABLET, "Take");
  assert.equal(f.inv.getAmount(I.STONE_TABLET), 1);
  stand(f, EXAM_CENTRE);
  f.said.length = 0;
  await useOnNpc(t, f, I.STONE_TABLET, N.TERRY_BALANDO);
  assert.deepEqual(f.said, ["Have a look at this.", "I don't need another tablet! One is enough, thank you."]);
  assert.equal(f.inv.getAmount(I.GOLD_BAR), 2, "no second payment");
  assert.equal(f.inv.getAmount(I.STONE_TABLET), 1);
  assert.equal(Number(f.p.getAttribute(QuestRuntime.QUEST_POINTS_ATTRIBUTE)), before.points + 2, "no second quest points");
  assert.equal(experience(f, core.Skill.MINING), before.mining + paid.mining, "no second experience");
  f.said.length = 0;
  await talk(t, f, N.DOUG_DEEPING);
  assert.deepEqual(f.said, ["Well, hello again. Congratulations on your finds."]);
  assert.equal(f.inv.getAmount(I.CHEST_KEY_2), 0, "Doug hands over no key after the quest");
  f.said.length = 0;
  await talk(t, f, N.DIGSITE_WORKMAN);
  assert.deepEqual(f.said, ["Hello there.", "Ah, it's the great archaeologist! Congratulations on your discovery."]);
});
