// Run after `yarn build`: node --test tests/a-shell-of-a-friend.test.cjs
//
// A Shell of a Friend, played by packet from the snail's first "!" to SnelmLover500's death: real Player, PlayerSession
// and ClientConnection, the real plugins, cache and map (the between-a-rock harness), every tick run as World.process
// runs it (zones included). What each step rests on is in plugins/quests/quests/ShellOfAFriend.Quest.js (the OSRS
// Wiki's quest page, quick guide, transcripts and item pages; the cache's quest row 220 and multiloc 33159).
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { before, after, test } = require("node:test");
const H = require("./between-a-rock-harness.cjs");
const QuestRuntime = require("../plugins/quests/QuestRuntime");
const Shell = require("../plugins/quests/quests/ShellOfAFriend.Quest");
const { JsonPlayerPersistence } = require("../plugins/persistence/JsonPlayerPersistence.plugin");
const { AreaManager } = require("../dist/game/model/areas/AreaManager");

const { STAGE, SPOTS, TILES, VARBIT, ATTRIBUTE } = Shell;
const QUEST_NAME = "A Shell of a Friend";
const ON_ISLAND = [3563, 3494];
const SHORE = [3569, 3487]; // the stepping stone's south-east end
const LANDING = [3567, 3489]; // its island end
const STONE = [3568, 3488];
const TREE = [3562, 3491]; // snailquest_tree_multi (33159), 2x2
const START_MENU = `Start the ${QUEST_NAME} quest?`;
const REFUSAL = `You do not meet all of the requirements to start ${QUEST_NAME}.`;

let core, I, N, O, OptionDialogue;
const quest = () => QuestRuntime.questNamed(QUEST_NAME);

before(async () => {
  core = await H.boot();
  ({ ItemIdentifiers: I, NpcIdentifiers: N, ObjectIdentifiers: O, OptionDialogue } = core);
  for (const [x, y] of [[3564, 3493], [3575, 3510], [3580, 3480], [3597, 3495]]) core.RegionManager.loadMapFiles(x, y);
});
after(H.shutdown);

// ---- the harness, with zones ------------------------------------------------------------------

/**
 * A world tick as the harness runs it, with what the harness leaves out and this quest needs: the zone hooks (the
 * player's process drives them) and combat, the player's (Player.process: hits, combat around the movement) and the
 * player's own NPCs' (NPC.process). Other NPCs only move, as in the harness.
 */
function step(f, count = 1) {
  const { World, TaskManager } = core;
  for (let i = 0; i < count; i++) {
    const player = f.player;
    H.PM.updatePlayerZones(player);
    f.tick++;
    World.processCycle++;
    TaskManager.process();
    for (const npc of World.getNpcs()) {
      if (!npc) continue;
      if (npc.getOwner?.() === player) npc.process();
      else npc.getMovementQueue().process();
    }
    f.connection.processTurnPackets();
    AreaManager.process(player);
    player.getCombat().getHitQueue().process(World.processCycle);
    const movement = player.getMovementQueue();
    const combat = player.getCombat();
    movement.beginCycle();
    const fighting = combat.hasPendingWork();
    if (fighting) combat.preMovementProcess();
    movement.processEntityPursuit();
    movement.process();
    if (fighting) combat.postMovementProcess();
    TaskManager.processWalkTo(player.getIndex());
    player.getSession().flushClient(World.processCycle);
    player.resetUpdating();
    // World.process's queue_remove_npcs: the dead leave the world.
    for (let npc = World.getRemoveNPCQueue().shift(); npc; npc = World.getRemoveNPCQueue().shift()) World.getNpcs().remove(npc);
    const line = H.shown(f);
    if (line && f.said.at(-1)?.text !== line.text) f.said.push({ tick: f.tick, ...line });
  }
}

/** A player on `tile` with the quest's requirements (or not), logged in as the quest sees a login. */
function actor(t, tile, { stage = 0, herblore = 16, construction = 15, priest = true, items = [] } = {}) {
  const f = H.actor(t, { at: [...tile, 0], items });
  const skills = f.player.getSkillManager();
  for (const [skill, level] of [[core.Skill.HERBLORE, herblore], [core.Skill.CONSTRUCTION, construction],
    [core.Skill.ATTACK, 99], [core.Skill.STRENGTH, 99], [core.Skill.DEFENCE, 99], [core.Skill.HITPOINTS, 99]]) {
    skills.setMaxLevels(skill, level, false);
    skills.setCurrentLevel(skill, level, false);
  }
  if (priest) {
    const pip = QuestRuntime.questNamed("Priest in Peril");
    pip.setStage(f.player, pip.completionValue);
  }
  if (stage) quest().setStage(f.player, stage);
  login(f);
  return f;
}

/** A login as the server runs one: the login hooks, then the bootstrap's end (the quest list and varps go out). */
function login(f) {
  H.PM.emitPlayerLogin({ player: f.player, username: f.player.getUsername() });
  H.PM.emitCustomEvent("player:bootstrap-complete", { player: f.player });
  step(f, 2);
}

const owned = (f, id) => [...core.World.getNpcs()].filter((npc) => npc?.getOwner?.() === f.player && npc.getId() === id && npc.isRegistered());
const one = (f, id) => { const found = owned(f, id); assert.equal(found.length, 1, `one owned NPC ${id}, not ${found.length}`); return found[0]; };
const stageOf = (f) => quest().getStage(f.player);
const varbit = (f, id) => f.player.getPacketSender().getVarbit(id);
const held = (f, id) => f.player.getInventory().getAmount(id);
const at = (f) => [f.player.getLocation().getX(), f.player.getLocation().getY()];
const lying = (f, id) => core.World.getItems().filter((item) => item.getOwner() === f.player.getUsername() && item.getItem().getId() === id
  && !item.isPendingRemoval()).map((item) => [item.getPosition().getX(), item.getPosition().getY()]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const sorted = (tiles) => [...tiles].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const messages = (f) => f.messages.map((message) => message.text);
/** The journal as one string per line, highlights left out. */
const journal = (f) => quest().buildJournal(f.player, quest()).map((line) => line.replace(/<col=[0-9a-f]+>|<\/col>/g, ""));

function stand(f, [x, y]) {
  f.player.getMovementQueue().reset();
  f.player.setLocation(new core.Location(x, y, 0));
  step(f);
}

function give(f, id, amount = 1) {
  f.player.getInventory().add(new core.Item(id, amount), false);
  f.player.getInventory().refreshItems();
}

function fill(f) {
  const inventory = f.player.getInventory();
  while (inventory.getFreeSlots() > 0) inventory.add(new core.Item(I.POT, 1), false);
  inventory.refreshItems();
}

function empty(f, id = I.POT) {
  f.player.getInventory().deleteNumber(id, 28);
  f.player.getInventory().refreshItems();
}

/** The chatbox: a line, a box, or a menu with its title and options. */
function shown(f) {
  const current = f.player.getDialogueManager().getCurrent?.();
  if (current instanceof OptionDialogue) return { who: "menu", title: current.getTitle(), options: current.getOptions(), text: current.getTitle() };
  return H.shown(f);
}

async function next(f) {
  const group = f.player.getPacketSender().getChatboxGroupId();
  const child = [231, 217].includes(group) ? 5 : group === 229 ? 4 : group === 11 ? 4 : 0;
  await f.connection.dispatch([{ type: "dialogue_continue", widgetId: (group << 16) | child, childIndex: -1 }]);
  step(f);
}

async function choose(f, text) {
  const menu = shown(f);
  assert.equal(menu?.who, "menu", `a menu shows, not ${JSON.stringify(menu)}`);
  const index = menu.options.indexOf(text);
  assert.ok(index >= 0, `"${text}" in ${JSON.stringify(menu.options)}`);
  await f.connection.dispatch([{ type: "dialogue_continue", widgetId: OptionDialogue.OPTIONS_WIDGET_ID, childIndex: index + 1 }]);
  step(f);
}

/** Continues until `text` shows (a line, a box or a menu's title). */
async function until(f, text, limit = 60) {
  for (let i = 0; i < limit; i++) {
    const line = shown(f);
    if (line && (line.text === text || line.title === text)) return;
    if (line && line.who !== "menu") await next(f);
    else step(f);
  }
  assert.fail(`"${text}" never showed; said: ${JSON.stringify(f.said.slice(-6).map((line) => line.text))}`);
}

/** Continues every line to the end of the talk; returns the texts shown, in order. */
async function finish(f, limit = 60) {
  const seen = [];
  for (let i = 0; i < limit; i++) {
    const line = shown(f);
    if (!line) return seen;
    if (line.who === "menu") return [...seen, line.title];
    if (seen.at(-1) !== line.text) seen.push(line.text);
    await next(f);
  }
  return seen;
}

/** Talks to the player's own snail (it must be in reach) and plays the talk; returns what was shown. */
async function talkToSnail(f) {
  const snail = one(f, N.JUVENILE_SNAIL);
  stand(f, [snail.getLocation().getX() - 1, snail.getLocation().getY()]);
  f.said.length = 0;
  await f.connection.dispatch([{ type: "npc_option", index: snail.getIndex(), clickType: 1 }]);
  for (let i = 0; i < 10 && !shown(f); i++) step(f);
  return finish(f);
}

async function pickUp(f, id, [x, y]) {
  stand(f, [x, y]);
  await f.connection.dispatch([{ type: "ground_item_action", itemId: id, x, y, option: "Take", optionIndex: 3 }]);
  step(f, 2);
}

/** Every spot of a set picked up in turn; returns the lines the player said. */
async function gather(f, id, tiles) {
  const lines = [];
  for (const tile of tiles) {
    await pickUp(f, id, tile);
    lines.push(...await finish(f));
  }
  return lines;
}

async function itemOption(f, id, option) {
  const inventory = f.player.getInventory();
  const slot = inventory.getSlotForItemId(id);
  assert.ok(slot >= 0, `control: the player carries ${id}`);
  const optionIndex = core.CacheDefinitions.getItem(id).inventoryActions.indexOf(option) + 1;
  await f.connection.dispatch([{ type: "inventory_action", widgetId: core.Inventory.INTERFACE_ID, slot, itemId: id, option, optionIndex }]);
  step(f);
}

async function destroy(f, id) {
  await itemOption(f, id, "Destroy");
  await f.connection.dispatch([{ type: "dialogue_continue", widgetId: 584 << 16, childIndex: 1 }]);
  step(f);
  f.player.getPacketSender().sendInterfaceRemoval();
}

async function crossStone(f) {
  await f.connection.dispatch([{ type: "object_option", id: O.STEPPING_STONE_66, x: STONE[0], y: STONE[1], clickType: 1 }]);
  step(f, 10);
}

async function buildShelter(f) {
  stand(f, [3564, 3491]);
  f.said.length = 0;
  await f.connection.dispatch([{ type: "object_option", id: core.CacheDefinitions.getLocId("snailquest_tree_multi"), x: TREE[0], y: TREE[1], clickType: 1 }]);
  step(f, 3);
  return finish(f);
}

/** The player hits `npc` until it dies (up to `limit` ticks). */
async function kill(f, npc, limit = 400) {
  const attack = npc.getCurrentDefinition(f.player).getActions().indexOf("Attack") + 1;
  assert.ok(attack > 0, `control: ${npc.getId()} has Attack`);
  await f.connection.dispatch([{ type: "npc_option", index: npc.getIndex(), clickType: attack }]);
  for (let i = 0; i < limit && npc.isRegistered() && npc.getHitpoints() > 0; i++) step(f);
  step(f, 6);
  assert.ok(npc.getHitpoints() <= 0, `${npc.getId()} died (${npc.getHitpoints()} hitpoints left)`);
}

async function reload(t, original) {
  const directory = mkdtempSync(path.join(tmpdir(), "tsps-shell-"));
  const previous = JsonPlayerPersistence.SAVE_DIRECTORY;
  JsonPlayerPersistence.SAVE_DIRECTORY = directory;
  try {
    const persistence = new JsonPlayerPersistence();
    const username = original.player.getUsername();
    persistence.save(original.player);
    await persistence.flush();
    const saved = new JsonPlayerPersistence().load(username);
    assert.ok(saved, "the save loads");
    H.PM.emitPlayerLogout({ player: original.player, username });
    core.World.getPlayers().remove(original.player);
    const restored = H.actor(t, { at: [...ON_ISLAND, 0] });
    restored.player.setUsername(username);
    saved.applyToPlayer(restored.player);
    login(restored);
    return restored;
  } finally {
    JsonPlayerPersistence.SAVE_DIRECTORY = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

// ---- the quest's identity ---------------------------------------------------------------------

test("keyed on the cache: row 220, varbit snailquest, endstate 24, 2 Quest Points, members", () => {
  const { questRowById, nativeQuestIndex } = require("../plugins/quests/QuestList.QuestRuntime");
  const row = questRowById(220, core.CacheDefinitions);
  assert.equal(row.displayname[0], QUEST_NAME);
  assert.equal(row.endstate[0], STAGE.COMPLETE);
  assert.equal(row.questpoints_override[0], quest().questPoints);
  // The cache's stat ids: 15 Herblore, 22 Construction.
  assert.deepEqual(row.requirement_stats, [15, 16, 22, 15]);
  assert.deepEqual(row.requirement_quests, [111]);
  assert.equal(core.CacheDefinitions.getDbRowName(111), "quest_priestinperil");
  assert.deepEqual(row.stat_xp_awarded, [22, 25000, 15, 25000], "2,500.0 Construction and Herblore experience");
  assert.equal(quest().key, "a_shell_of_a_friend");
  assert.equal(quest().varbitId, VARBIT.STAGE);
  assert.equal(core.CacheDefinitions.getVarbitNames().get(VARBIT.STAGE), "snailquest");
  assert.equal(core.CacheDefinitions.getVarbitNames().get(VARBIT.NAME), "snailquest_snail_name");
  assert.equal(nativeQuestIndex(QuestRuntime.getRegisteredQuests(), core.CacheDefinitions).get(220), quest());
  assert.equal(QuestRuntime.hasQuestJournal(220), true);
  assert.ok(require("../plugins/quests/Quests.plugin").QUESTS.includes("ShellOfAFriend"));
  // The tree the stages show: a tree to 10, Build-shelter at 12, the shelter from 13.
  const tree = core.CacheDefinitions.getObject(core.CacheDefinitions.getLocId("snailquest_tree_multi"));
  assert.equal(tree.transformVarbit, VARBIT.STAGE);
  assert.equal(tree.transforms[STAGE.NAMED], O.TREE_182);
  assert.equal(tree.transforms[STAGE.SHELTER], O.TREE_183);
  assert.equal(tree.transforms.at(-1), O.SHELTER_2);
});

test("the start: refused below each requirement, accepted at them; 'No.' leaves it unstarted", async (t) => {
  for (const missing of [{ priest: false }, { herblore: 15 }, { construction: 14 }]) {
    const f = actor(t, ON_ISLAND, missing);
    const snail = one(f, N.JUVENILE_SNAIL);
    const overheads = [];
    const force = snail.forceChat.bind(snail);
    snail.forceChat = (text) => { overheads.push(text); return force(text); };
    await f.connection.dispatch([{ type: "npc_option", index: snail.getIndex(), clickType: 1 }]);
    for (let i = 0; i < 10 && !shown(f); i++) step(f);
    assert.deepEqual(overheads, ["!"], "the snail's overhead");
    assert.equal(shown(f).text, "What are you doing out here, li'l snail?");
    await until(f, START_MENU);
    assert.deepEqual(shown(f).options, ["Yes.", "No."]);
    await choose(f, "Yes.");
    step(f, 2);
    assert.equal(stageOf(f), STAGE.NOT_STARTED, JSON.stringify(missing));
    assert.ok(messages(f).includes(REFUSAL), JSON.stringify(messages(f)));
    assert.equal(shown(f), null, "no story for a player who cannot start it");
  }

  const no = actor(t, ON_ISLAND);
  await no.connection.dispatch([{ type: "npc_option", index: one(no, N.JUVENILE_SNAIL).getIndex(), clickType: 1 }]);
  for (let i = 0; i < 10 && !shown(no); i++) step(no);
  await until(no, START_MENU);
  await choose(no, "No.");
  assert.deepEqual(await finish(no), ["I guess I'll leave you alone."]);
  assert.equal(stageOf(no), STAGE.NOT_STARTED);

  // The quest list's Read journal before the start: the overview, with the journal transcript's start sentence.
  const scripts = [];
  const sender = no.player.getPacketSender();
  const send = sender.sendInterfaceScript.bind(sender);
  sender.sendInterfaceScript = (id, args) => { scripts.push([id, args]); return send(id, args); };
  QuestRuntime.openQuestJournal(no.player, 220);
  const overview = scripts.find(([id]) => id === 6821);
  assert.ok(overview, "questjournal_overview_setup");
  assert.equal(overview[1][1], "finding a <col=800000>Lost Snail<col=000080> in the <col=800000>Haunted Woods<col=000080>.");

  const yes = actor(t, ON_ISLAND); // Priest in Peril, Herblore 16 and Construction 15 exactly
  await yes.connection.dispatch([{ type: "npc_option", index: one(yes, N.JUVENILE_SNAIL).getIndex(), clickType: 1 }]);
  for (let i = 0; i < 10 && !shown(yes); i++) step(yes);
  await until(yes, START_MENU);
  await choose(yes, "Yes.");
  assert.equal(stageOf(yes), STAGE.STARTED);
  assert.ok(messages(yes).some((text) => text.startsWith("You've started a new quest: ") && text.includes(QUEST_NAME)));
  assert.deepEqual(await finish(yes), [
    "Have you become separated from your family?",
    "The snail looks down. You assume you are correct.",
    "Hmm... That's not good... This place is pretty hostile. Maybe I can get you some food?",
    "The snail looks up at you with hopeful eyes.",
    "Okay, li'l snail. I'm sure I can find you something tasty nearby. Maybe some nice leaves...",
  ]);
  assert.equal(varbit(yes, VARBIT.STAGE), STAGE.STARTED);
});

test("the stepping stone takes anyone to the island and back", async (t) => {
  const f = actor(t, SHORE, { priest: false, herblore: 1, construction: 1 });
  await crossStone(f);
  assert.deepEqual(at(f), LANDING);
  await crossStone(f);
  assert.deepEqual(at(f), SHORE);
});

test("the whole quest, by packet, from the leaves to SnelmLover500's snelm", async (t) => {
  let f = actor(t, ON_ISLAND, { stage: STAGE.STARTED });
  const snail = one(f, N.JUVENILE_SNAIL);
  assert.deepEqual([snail.getSpawnPosition().getX(), snail.getSpawnPosition().getY()], TILES.SNAIL_TILE);
  assert.deepEqual(journal(f), ["I found a Young Snail on a small island in the Haunted Woods. It seemed lost and afraid. I decided to help it out by gathering it some food. I'll probably be able to find some Leaves for it to eat nearby."]);
  assert.deepEqual(await talkToSnail(f), [
    "I've not managed to find you any food yet, li'l snail, but I'm sure there's something tasty nearby. Maybe some nice leaves...",
    "The snail gives you a look of affirmation.",
  ]);

  // ---- the leaves: five spots of the player's own; a full pack takes none
  assert.deepEqual(lying(f, I.FRESH_LEAVES), sorted(SPOTS.LEAVES), "the five fresh leaves lie where the Wiki has them");
  fill(f);
  await pickUp(f, I.FRESH_LEAVES, SPOTS.LEAVES[0]);
  assert.equal(held(f, I.FRESH_LEAVES), 0, "a full inventory takes no leaf");
  assert.equal(lying(f, I.FRESH_LEAVES).length, 5, "and the leaf stays");
  empty(f);
  assert.deepEqual(await gather(f, I.FRESH_LEAVES, SPOTS.LEAVES.slice(0, 3)), []);
  assert.equal(held(f, I.FRESH_LEAVES), 3);
  assert.deepEqual(await talkToSnail(f), [
    "I've managed to find you some leaves. What do you think?",
    "You show the leaves to the snail. It gives you a look of affirmation in response, but it doesn't seem fully convinced.",
    "Hmm... I think you're right. It's not quite enough, is it? I'll be back with more soon.",
    "The snail wiggles excitedly.",
  ]);
  assert.deepEqual(await gather(f, I.FRESH_LEAVES, SPOTS.LEAVES.slice(3)), ["There. I reckon that should be enough."]);
  assert.equal(stageOf(f), STAGE.LEAVES_GATHERED);
  assert.deepEqual(lying(f, I.FRESH_LEAVES), [], "no leaves left lying");
  assert.equal(journal(f)[1], "I collected some Leaves from nearby for the Snail to eat.");

  // ---- back over the stone: the leech has the snail
  stand(f, SHORE);
  assert.equal(owned(f, N.LEECH_3).length, 0, "no leech before the player is back on the island");
  await crossStone(f);
  assert.deepEqual(at(f), LANDING);
  const leech = one(f, N.LEECH_3);
  assert.equal(leech.getCombat().getTarget(), one(f, N.JUVENILE_SNAIL), "the leech is attacking the snail");
  f.messages.length = 0;
  await f.connection.dispatch([{ type: "npc_option", index: one(f, N.JUVENILE_SNAIL).getIndex(), clickType: 1 }]);
  step(f, 3);
  assert.ok(messages(f).includes("The snail seems a bit preoccupied right now."), JSON.stringify(messages(f)));
  const victim = one(f, N.JUVENILE_SNAIL);
  step(f, 12);
  assert.equal(leech.getHitpoints(), 25, "the snail never fights back");
  assert.equal(victim.getCombat().getTarget(), null, "nor takes the leech on");
  victim.setHitpoints(11);
  step(f);
  // Whole again (25), less what the leech (max hit 3) may have hit it for since in the same tick.
  assert.ok(victim.getHitpoints() >= 22, `below half its hitpoints the snail is whole again: ${victim.getHitpoints()}`);
  await kill(f, leech);
  assert.equal(stageOf(f), STAGE.LEECH_KILLED);
  assert.equal(victim.isRegistered(), true, "the snail lives");
  assert.ok(!core.World.getItems().some((item) => item.getOwner() === f.player.getUsername() && item.getItem().getId() !== I.FRESH_LEAVES
    && Math.abs(item.getPosition().getX() - TILES.LEECH_TILE[0]) <= 3), "the leech drops nothing");
  assert.equal(journal(f)[1], "I collected some Leaves from nearby for the Snail to eat. However, upon my return, I found it being attacked by a Leech. I was able to quickly defeat it, but not before the Snail was injured. I'll need to search nearby to find something to use as a Balm to heal the Snail with.");

  // ---- the leaves laid down
  fill(f); // a full pack: the hand-over only takes
  assert.deepEqual(await talkToSnail(f), [
    "Are you okay, li'l snail? That leech ambushed you!",
    "The snail is shaking. It's in shock.",
    "Here, have some of this food I gathered for you.",
    "You lay down the leaves in front of the snail. It cautiously starts nibbling on them, but it noticeably winces as it does so.",
    "Oh no! You're injured, you poor thing. I wonder if there's anything nearby that I can make a balm with...",
    "The snail continues to slowly nibble on the food.",
  ]);
  assert.equal(held(f, I.FRESH_LEAVES), 0);
  assert.equal(stageOf(f), STAGE.FED);
  empty(f);
  assert.deepEqual(await talkToSnail(f), [
    "How are you holding up?",
    "The snail looks uncomfortable. It's hurt.",
    "Hmm... Let me see if there's anything nearby that I can make a balm with...",
    "The snail continues to shake.",
  ]);

  // ---- the branches and the dew
  assert.deepEqual(lying(f, I.DEW_COVERED_BRANCH), sorted(SPOTS.BRANCHES));
  await gather(f, I.DEW_COVERED_BRANCH, SPOTS.BRANCHES.slice(0, 2));
  assert.deepEqual((await talkToSnail(f))[2], "Hmm... I have some sticks here. Perhaps I can strip the dew off them to use as a balm...");
  f.xp.length = 0;
  await itemOption(f, I.DEW_COVERED_BRANCH, "Strip");
  step(f, 8);
  assert.equal(held(f, I.DEW_COVERED_BRANCH), 0);
  assert.equal(held(f, I.RESTORATIVE_DEW), 4, "two dew a branch");
  assert.deepEqual(f.xp.map((entry) => [entry.skill, entry.amount]), [["Herblore", 5], ["Herblore", 5]]);
  assert.deepEqual((await talkToSnail(f))[2], "I think this dew I've gathered might help, but it looks like I'll need some more.");
  assert.deepEqual(await gather(f, I.DEW_COVERED_BRANCH, SPOTS.BRANCHES.slice(2)), ["There. I reckon that should be enough."]);
  assert.equal(stageOf(f), STAGE.DEW_GATHERED);
  assert.ok(journal(f)[1].endsWith("I searched nearby and found some Dew. I should use it to heal the Snail."));
  // A destroyed branch: every picked branch lies again, and past enough the player takes no more.
  await destroy(f, I.DEW_COVERED_BRANCH);
  assert.equal(held(f, I.DEW_COVERED_BRANCH), 2);
  assert.deepEqual(lying(f, I.DEW_COVERED_BRANCH), sorted(SPOTS.BRANCHES), "all the branches picked up lie again");
  assert.deepEqual(await gather(f, I.DEW_COVERED_BRANCH, SPOTS.BRANCHES.slice(0, 1)), ["There. I reckon that should be enough."]);
  assert.deepEqual(await gather(f, I.DEW_COVERED_BRANCH, SPOTS.BRANCHES.slice(1, 2)), ["Hmm... I don't think I need any more of these branches."]);
  assert.equal(held(f, I.DEW_COVERED_BRANCH), 3, "the sixth is left lying");
  await itemOption(f, I.DEW_COVERED_BRANCH, "Strip");
  step(f, 12);
  assert.equal(held(f, I.RESTORATIVE_DEW), 10);

  // ---- saved and loaded mid-quest
  f = await reload(t, f);
  assert.equal(stageOf(f), STAGE.DEW_GATHERED);
  assert.equal(varbit(f, VARBIT.STAGE), STAGE.DEW_GATHERED);
  assert.equal(held(f, I.RESTORATIVE_DEW), 10);
  assert.equal(Number(f.player.getAttribute(ATTRIBUTE.PICKED.branches)), 0b1, "the branch picked since the destroy stays picked (the refused one lies on)");
  assert.deepEqual(lying(f, I.DEW_COVERED_BRANCH), sorted(SPOTS.BRANCHES.slice(1)), "and the others lie again for the reloaded player");

  // ---- the balm, and the name
  const snailNow = one(f, N.JUVENILE_SNAIL);
  const overheads = [];
  const force = snailNow.forceChat.bind(snailNow);
  snailNow.forceChat = (text) => { overheads.push(text); return force(text); };
  assert.deepEqual(await talkToSnail(f), [
    "How are you holding up?",
    "The snail looks uncomfortable. It's hurt.",
    "You carefully rub the restorative dew onto the snail's wounds.",
    "There you go. That should feel better soon.",
    "The snail starts to look more comfortable.",
    "Hmm... I can't keep calling you li'l snail. We should think of a name for you.",
    "The snail looks up at you with its wide and round eyes.",
    "I wonder what would fit you best...",
    "Pick a name for the snail.",
  ]);
  assert.equal(held(f, I.RESTORATIVE_DEW), 0);
  assert.equal(stageOf(f), STAGE.HEALED);
  assert.deepEqual(shown(f).options, ["Sprout.", "Sunny.", "Sadie.", "Scout.", "More options..."]);
  await choose(f, "More options...");
  assert.deepEqual(shown(f).options, ["Sasha.", "Sushi.", "Sophie.", "Previous options...", "More options..."]);
  await choose(f, "More options...");
  assert.deepEqual(shown(f).options, ["Samantha.", "Sebastian.", "Snowball.", "Previous options...", "More options..."]);
  await choose(f, "More options...");
  assert.deepEqual(shown(f).options, ["Squishy.", "Orlando.", "Smudge.", "Previous options..."]);
  await choose(f, "Squishy.");
  assert.equal(stageOf(f), STAGE.NAMED);
  assert.deepEqual(await finish(f), [
    "How about Squishy?",
    "The snail wobbles excitedly. You think it's happy.",
    "Haha, Squishy it is then. I think it suits you!",
    "Squishy wobbles excitedly again. You feel like you're properly starting to understand each other.",
    "I think after that attack, you need a shelter to hide from those leeches in.",
    "Squishy playfully goes in and out of their shell.",
    "Haha, I know you have your shell, but I don't think it's quite enough.",
    "I'll go have a look for some materials to build a nice home for you.",
    "Squishy gives you a concerned look. You can tell they're anxious about being left alone.",
    "I'll be quick!",
  ]);
  assert.deepEqual(overheads, ["Squee!"]);
  assert.equal(stageOf(f), STAGE.SHELTER);
  assert.equal(varbit(f, VARBIT.NAME), 11);
  assert.equal(journal(f).at(-1), "I decided to give the Snail a name: Squishy. It seemed happy with my choice. To better protect Squishy from danger, I decided to build a shelter. I should hopefully be able to find the materials to do so nearby.");

  // ---- the shelter: the tree offers Build-shelter now; an axe, then five strong sticks
  assert.deepEqual(core.ObjectDefinition.forPlayer(core.CacheDefinitions.getLocId("snailquest_tree_multi"), f.player).getActions()[0], "Build-shelter");
  f.messages.length = 0;
  assert.deepEqual(await buildShelter(f), []);
  assert.ok(messages(f).includes("To carve out this tree, you'll need an axe that you have the Woodcutting level to use."));
  assert.deepEqual(lying(f, I.BRONZE_AXE), [SPOTS.AXE_SPOT], "the bronze axe by the fairy ring, for a player without one");
  await pickUp(f, I.BRONZE_AXE, SPOTS.AXE_SPOT);
  assert.equal(held(f, I.BRONZE_AXE), 1);
  assert.deepEqual(lying(f, I.BRONZE_AXE), [], "one axe is enough");
  assert.deepEqual(await buildShelter(f), ["I need to find some strong materials to build a shelter here."]);
  assert.deepEqual((await talkToSnail(f)).slice(0, 3), ["Hey, Squishy!", "Squishy looks happy to see you.",
    "I haven't found any suitable materials for a home yet. I'll keep looking."]);
  assert.deepEqual(lying(f, I.STRONG_STICKS), sorted(SPOTS.STICKS));
  await gather(f, I.STRONG_STICKS, SPOTS.STICKS.slice(0, 2));
  assert.deepEqual((await talkToSnail(f))[2], "I've managed to find some strong sticks to build you a home with, but I need a few more. I'll keep looking.");
  assert.deepEqual(await buildShelter(f), ["I have some good sticks for a shelter, but I think I'll need some more."]);
  assert.deepEqual(await gather(f, I.STRONG_STICKS, SPOTS.STICKS.slice(2)), ["There. I reckon that should be enough."]);
  await destroy(f, I.STRONG_STICKS);
  assert.deepEqual(await gather(f, I.STRONG_STICKS, SPOTS.STICKS.slice(0, 1)), ["There. I reckon that should be enough."]);
  assert.deepEqual(await gather(f, I.STRONG_STICKS, SPOTS.STICKS.slice(1, 2)), ["Hmm... I reckon I have enough sticks for a shelter."]);
  assert.deepEqual((await talkToSnail(f)).slice(2), [
    "I've managed to find some strong sticks to make you a home with. I think I'll build it into this tree here.",
    "Squishy wiggles in anticipation.",
  ]);
  fill(f);
  assert.deepEqual(await buildShelter(f), []);
  assert.equal(held(f, I.STRONG_STICKS), 0);
  assert.equal(stageOf(f), STAGE.SHELTER_BUILT);
  assert.equal(core.ObjectDefinition.forPlayer(core.CacheDefinitions.getLocId("snailquest_tree_multi"), f.player).id, O.SHELTER_2);
  empty(f);
  assert.deepEqual(await talkToSnail(f), [
    "I'm happy with that! What do you think, Squishy?",
    "Squishy sways in agreement.",
    "That should keep you protected from those leeches! Make sure you get in here as soon as you see them coming!",
    "Squishy gives you a look of confirmation.",
    "I think you're mostly set. It might be time for me to go now, Squishy.",
    "Squishy gives you a sad look.",
    "I know, but I can't stay with you forever. I'll make sure to visit you all the time!",
    "Squishy looks morose, but accepts reality.",
    "As a last farewell, I'll gather you some more food before I go.",
    "Squishy looks a bit happier.",
    "I'll be right back! Don't forget to use your shelter if the leeches come!",
  ]);
  assert.equal(stageOf(f), STAGE.FAREWELL);
  assert.deepEqual(await talkToSnail(f), [
    "I'm going to go fetch you some more food. I'll be back once I've got enough.",
    "Squishy gives you a happy look.",
  ]);

  // ---- more food, and the snail is gone
  assert.deepEqual(lying(f, I.FRESH_LEAVES), sorted(SPOTS.LEAVES), "the leaves lie again for the farewell food");
  assert.deepEqual(await gather(f, I.FRESH_LEAVES, SPOTS.LEAVES), ["There. I reckon that should be enough."]);
  assert.equal(stageOf(f), STAGE.FOOD_GATHERED);
  assert.equal(owned(f, N.JUVENILE_SNAIL).length, 0, "the snail nowhere in sight");
  const lover = one(f, N.SNELMLOVER500);
  assert.deepEqual([lover.getLocation().getX(), lover.getLocation().getY()], TILES.LOVER_TILE);
  assert.ok(journal(f).at(-1).endsWith("With that done, it's now time to say goodbye to Squishy."));

  // ---- back on the island: SnelmLover500
  stand(f, SHORE);
  f.said.length = 0;
  await crossStone(f);
  await until(f, "Squishy?");
  assert.deepEqual(await finish(f), ["Squishy?", "What have you done?!"]);
  step(f);
  assert.equal(stageOf(f), STAGE.AVENGE);
  const fighter = one(f, N.SNELMLOVER500_2);
  assert.equal(owned(f, N.SNELMLOVER500).length, 0);
  assert.equal(fighter.getCombat().getTarget(), f.player, "SnelmLover500 attacks the player");
  assert.equal(fighter.getDefinition().getMaxHit(), 6);
  assert.ok(journal(f).at(-1).endsWith("There is only one path ahead of me now. They must die."));
  fill(f);
  QuestRuntime.refreshQuestList(f.player, true);
  const completedBefore = varbit(f, 6347); // the quest list's "Completed: n/..."
  const points = Number(f.player.getAttribute("quest.points")) || 0;
  f.xp.length = 0;
  const where = [fighter.getLocation().getX(), fighter.getLocation().getY()];
  await kill(f, fighter);
  assert.equal(stageOf(f), STAGE.COMPLETE);
  assert.equal(varbit(f, VARBIT.STAGE), STAGE.COMPLETE);
  assert.equal(Number(f.player.getAttribute("quest.points")), points + 2);
  assert.deepEqual(f.xp.filter((entry) => entry.amount === 2500).map((entry) => entry.skill), ["Herblore", "Construction"]);
  assert.ok(lying(f, I.PINK_SNELM).some(([x, y]) => Math.abs(x - where[0]) <= 1 && Math.abs(y - where[1]) <= 1),
    `the pink snelm lies where he fell: ${JSON.stringify(lying(f, I.PINK_SNELM))}`);
  assert.ok(messages(f).some((text) => text.startsWith("Congratulations, you've completed a quest: ") && text.includes(QUEST_NAME)));
  assert.deepEqual(journal(f).slice(-2), ["", "QUEST COMPLETE!"]);
  assert.equal(quest().isComplete(f.player), true);
  QuestRuntime.refreshQuestList(f.player, true);
  assert.equal(varbit(f, 6347), completedBefore + 1, "the quest list counts it complete");
  const asked = { player: f.player, key: "a_shell_of_a_friend", complete: false };
  H.PM.emitCustomEvent("quest:is-complete", asked);
  assert.equal(asked.complete, true, "and so does the quest point cape's check");
  step(f, 3);
  const scroll = H.callsNamed(f, "sendString").map((call) => call.args[0]);
  for (const line of ["You have completed A Shell of a Friend!", "2 Quest Points", "2,500 Herblore XP", "2,500 Construction XP"]) {
    assert.ok(scroll.includes(line), `the scroll says ${line}`);
  }

  // ---- paid once
  assert.equal(quest().complete(f.player), false);
  stand(f, SHORE);
  await crossStone(f);
  step(f, 3);
  assert.equal(Number(f.player.getAttribute("quest.points")), points + 2);
  const left = [N.SNELMLOVER500_2, N.SNELMLOVER500, N.JUVENILE_SNAIL].flatMap((id) => owned(f, id))
    .map((npc) => `${npc.getId()} at ${npc.getLocation().getX()},${npc.getLocation().getY()} with ${npc.getHitpoints()}`);
  assert.deepEqual(left, [], "nobody is left on the island");
  assert.equal(lying(f, I.PINK_SNELM).length, 1, "one snelm, once");
});

test("a talk left mid-way: the naming and the shelter lines pick up where they stopped", async (t) => {
  const f = actor(t, ON_ISLAND, { stage: STAGE.HEALED });
  const lines = await talkToSnail(f);
  assert.deepEqual(lines.slice(0, 3), [
    "Hmm... I can't keep calling you li'l snail. We should think of a name for you.",
    "The snail looks up at you with its wide and round eyes.",
    "I wonder what would fit you best...",
  ]);
  await choose(f, "Sprout.");
  f.player.getDialogueManager().reset();
  f.player.getPacketSender().sendInterfaceRemoval();
  assert.equal(stageOf(f), STAGE.NAMED);
  const again = await talkToSnail(f);
  assert.equal(again[0], "Sprout wobbles excitedly again. You feel like you're properly starting to understand each other.");
  assert.equal(again.at(-1), "I'll be quick!");
  assert.equal(stageOf(f), STAGE.SHELTER);
});

test("SnelmLover500 waits by the shelter for a player who left mid-fight, and attacks again on their return", async (t) => {
  const f = actor(t, SHORE, { stage: STAGE.AVENGE });
  f.player.setAttribute(ATTRIBUTE.NAME, 1);
  one(f, N.SNELMLOVER500);
  assert.equal(owned(f, N.SNELMLOVER500_2).length, 0, "not fighting while the player is off the island");
  await crossStone(f);
  const fighter = one(f, N.SNELMLOVER500_2);
  assert.equal(fighter.getCombat().getTarget(), f.player);
  assert.equal(shown(f), null, "no second confrontation");
  stand(f, [3220, 3218]);
  assert.equal(owned(f, N.SNELMLOVER500_2).length + owned(f, N.SNELMLOVER500).length, 0, "gone with the player");
  stand(f, SHORE);
  one(f, N.SNELMLOVER500);
  assert.equal(stageOf(f), STAGE.AVENGE);
});

test("Talk-to on SnelmLover500 is the confrontation too", async (t) => {
  const f = actor(t, ON_ISLAND, { stage: STAGE.FOOD_GATHERED });
  f.player.getDialogueManager().reset();
  f.player.setAttribute(ATTRIBUTE.NAME, 13);
  const lover = one(f, N.SNELMLOVER500);
  await f.connection.dispatch([{ type: "npc_option", index: lover.getIndex(), clickType: 1 }]);
  for (let i = 0; i < 10 && !shown(f); i++) step(f);
  assert.deepEqual(await finish(f), ["Smudge?", "What have you done?!"]);
  step(f);
  assert.equal(stageOf(f), STAGE.AVENGE);
  assert.equal(one(f, N.SNELMLOVER500_2).getCombat().getTarget(), f.player);
});

test("the spawns are the player's own and only while they are in the woods", async (t) => {
  const f = actor(t, ON_ISLAND, { stage: STAGE.STARTED });
  const other = actor(t, ON_ISLAND);
  assert.equal(one(f, N.JUVENILE_SNAIL).isOwnerOnly(), true);
  assert.equal(owned(other, N.JUVENILE_SNAIL).length, 1, "each player their own snail");
  assert.equal(lying(other, I.FRESH_LEAVES).length, 0, "no leaves for a player who has not started");
  stand(f, [3220, 3218]);
  assert.equal(owned(f, N.JUVENILE_SNAIL).length, 0);
  assert.equal(lying(f, I.FRESH_LEAVES).length, 0);
  stand(f, ON_ISLAND);
  assert.equal(owned(f, N.JUVENILE_SNAIL).length, 1);
  assert.equal(lying(f, I.FRESH_LEAVES).length, 5);
});
