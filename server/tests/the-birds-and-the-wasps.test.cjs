// Run after `yarn build`: node --test tests/the-birds-and-the-wasps.test.cjs
//
// The Birds and the Wasps, played by packet on the real plugins, cache, map and a real Player (the between-a-rock harness:
// talks, clicks, item options and item uses are packets, each tick runs as World.process does), from Farmer Bea's start
// to the reward: every hand-over, every requirement refused below it and accepted at it, the journal at each step, the
// reward paid once, full inventories, a save and reload in the middle, and the quest complete in the quest list.
//
// What each step rests on is in plugins/quests/birdsandthewasps/*.js (the Wiki's transcripts and the cache).
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { before, after, test } = require("node:test");
const H = require("./between-a-rock-harness.cjs");
const QuestRuntime = require("../plugins/quests/QuestRuntime");
const { JsonPlayerPersistence } = require("../plugins/persistence/JsonPlayerPersistence.plugin");

const KEY = "the_birds_and_the_wasps";
const STAGE = { STARTED: 10, BEES: 15, DELIVERED: 20, WASPS: 25, WASPS_CAUGHT: 30, BIRDS: 35, BIRDS_CAUGHT: 40, DARTS: 45, DARTS_MADE: 50, COMPLETE: 55 };
const VARBIT = { STAGE: 10992, WASP_1: 16841, KILLER_1: 16844, BIRDS_CAUGHT: 16847, HAD_CIDER: 16848, WASPS_NOTIFIED: 16850, BIRDS_NOTIFIED: 16852 };
// The cache map's placements and spawns (data/definitions/npc-spawns.json).
const BEA = [3316, 3376, 0];
const BESIDE_BEA = [3316, 3377, 0];
const CRATE = [3315, 3376];
const DEALER = [3187, 3493, 0];
const BESIDE_DEALER = [3188, 3493, 0];
const HIVES = [3316, 3366, 0];
const SNARE_TILE = [3314, 3361, 0];

let core;
let I;
let N;
let OptionDialogue;
let ItemStatementDialogue;
let DoubleItemStatementDialogue;
const quest = () => QuestRuntime.getRegisteredQuests().find((entry) => entry.key === KEY);
const npcId = (name) => core.CacheDefinitions.getNpcId(name);

before(async () => {
  core = await H.boot();
  I = core.ItemIdentifiers;
  N = core.NpcIdentifiers;
  OptionDialogue = core.OptionDialogue;
  ItemStatementDialogue = core.ItemStatementDialogue;
  DoubleItemStatementDialogue = core.DoubleItemStatementDialogue;
  for (const [x, y] of [BEA, DEALER, HIVES]) core.RegionManager.loadMapFiles(x, y);
});
after(H.shutdown);

/** A player at `tile` at a stage, logged in as the quest sees a login. */
function at(t, tile, { stage = 0, items = [], worn = [] } = {}) {
  const f = H.actor(t, { at: tile, items, worn });
  typed(f);
  if (stage) quest().setStage(f.player, stage);
  H.PM.emitPlayerLogin({ player: f.player, username: f.player.getUsername() });
  f.player.getSkillManager().setCurrentLevel(core.Skill.HITPOINTS, 10, false);
  return f;
}

/** Typed chat lines (spam, game) are messages too. */
function typed(f) {
  const sender = f.player.getPacketSender();
  const sendTyped = sender.sendTypedMessage.bind(sender);
  sender.sendTypedMessage = (type, text, ...rest) => {
    f.messages.push({ tick: f.tick, text, type });
    return sendTyped(type, text, ...rest);
  };
}

const stageOf = (f) => quest().getStage(f.player);
const varbit = (f, id) => f.player.getPacketSender().getVarbit(id);
const inv = (f) => f.player.getInventory();
const amount = (f, id) => inv(f).getAmount(id);
const stand = (f, [x, y, z = 0]) => f.player.setLocation(new core.Location(x, y, z));
const xp = (f, skill) => f.player.getSkillManager().getExperience(skill);
const points = (f) => Number(f.player.getAttribute(QuestRuntime.QUEST_POINTS_ATTRIBUTE)) || 0;
const hp = (f) => f.player.getHitpoints();
/** The journal as one string, without its highlight colours. */
const journal = (f) => quest().buildJournal(f.player, quest()).join(" ").split("<col=800000>").join("").split("</col>").join("")
  .split("</str> <str>").join(" ");
const texts = (f, from = 0) => f.said.filter((line) => line.tick >= from).map((line) => line.text);
const lastMessage = (f) => f.messages.at(-1)?.text ?? "";

function give(f, id, count = 1) {
  if (core.ItemDefinition.forId(id).isStackable()) inv(f).add(new core.Item(id, count), false);
  else for (let i = 0; i < count; i++) inv(f).add(new core.Item(id, 1), false);
  inv(f).refreshItems();
}

function fill(f, filler = I.RAKE) {
  while (inv(f).getFreeSlots() > 0) inv(f).add(new core.Item(filler, 1), false);
  inv(f).refreshItems();
}

function empty(f, filler = I.RAKE) {
  inv(f).deleteNumber(filler, 28);
  inv(f).refreshItems();
}

function wear(f, slot, id) {
  f.player.getEquipment().setItem(slot, new core.Item(id, 1));
  f.player.getEquipment().refreshItems();
}

/** The chatbox: a menu (either kind), a line or a box. */
function shown(f) {
  const current = f.player.getDialogueManager().getCurrent?.();
  if (current instanceof OptionDialogue) return { who: "menu", title: current.getTitle(), options: current.getOptions(), text: current.getOptions().join(" | ") };
  const line = H.shown(f);
  if (line) {
    if (current instanceof DoubleItemStatementDialogue) line.items = current.getItemIds();
    else if (current instanceof ItemStatementDialogue) line.item = current.itemId ?? current.getItemId?.();
  }
  return line;
}

/** Continues lines (and answers menus from `answers`, in order) until the chatbox is clear; returns an unanswered menu. */
async function chat(f, answers = [], limit = 120) {
  const queue = [...answers];
  for (let i = 0; i < limit; i++) {
    const line = shown(f);
    if (!line) {
      H.tick(f);
      if (!shown(f)) return null;
      continue;
    }
    if (f.said.at(-1)?.text !== line.text) f.said.push({ tick: f.tick, ...line });
    if (line.who === "menu") {
      if (!queue.length) return line;
      const answer = queue.shift();
      const index = line.options.findIndex((option) => option === answer);
      assert.ok(index >= 0, `"${answer}" in ${JSON.stringify(line.options)}`);
      await f.connection.dispatch([{ type: "dialogue_continue", widgetId: OptionDialogue.OPTIONS_WIDGET_ID, childIndex: index + 1 }]);
      H.tick(f);
      continue;
    }
    await H.continueLine(f);
  }
  assert.fail(`the chat never ended: ${JSON.stringify(f.said.slice(-4))}`);
}

/** An NPC beside the player for this test (the world's spawns are not loaded here). */
function npcAt(f, id, tile) {
  return H.spawn(f, id, tile);
}

async function talkTo(f, npc, answers = [], option = "Talk-to") {
  const actions = npc.getCurrentDefinition(f.player)?.getActions() ?? [];
  const index = actions.indexOf(option);
  assert.ok(index >= 0, `control: ${npc.getId()} shows ${option}: ${JSON.stringify(actions)}`);
  const from = f.tick;
  await H.talk(f, npc, index + 1);
  const left = await chat(f, answers);
  return { left, said: texts(f, from) };
}

async function useItem(f, usedId, targetId) {
  const slot = inv(f).getSlotForItemId(usedId);
  const target = inv(f).getSlotForItemId(targetId);
  assert.ok(slot >= 0 && target >= 0, `control: the player carries ${usedId} and ${targetId}`);
  await f.connection.dispatch([{ type: "inventory_use_on", slot, itemId: usedId, target: { kind: "inventory", slot: target, id: targetId } }]);
  H.tick(f);
}

async function option(f, itemId, name) {
  const from = f.tick;
  await H.itemOption(f, itemId, name);
  await chat(f);
  return texts(f, from);
}

async function clickCrate(f, op, answers = []) {
  const from = f.tick;
  await H.objectOption(f, core.CacheDefinitions.getLocId("baw_equipment_crate"), CRATE, op);
  for (let i = 0; i < 6 && !shown(f); i++) H.tick(f);
  const left = await chat(f, answers);
  return { left, said: texts(f, from) };
}

/** The player saved and loaded again, then logged in (as tests/dig-site-second-half's reload). */
async function reload(t, original, tile) {
  const directory = mkdtempSync(path.join(tmpdir(), "tsps-baw-"));
  const previous = JsonPlayerPersistence.SAVE_DIRECTORY;
  JsonPlayerPersistence.SAVE_DIRECTORY = directory;
  try {
    const persistence = new JsonPlayerPersistence();
    const username = original.player.getUsername();
    original.player.setAttribute("bot-skip-persistence", false);
    persistence.save(original.player);
    await persistence.flush();
    const saved = new JsonPlayerPersistence().load(username);
    assert.ok(saved, "control: the save loads");
    const restored = H.actor(t, { at: tile });
    typed(restored);
    saved.applyToPlayer(restored.player);
    H.PM.emitPlayerLogin({ player: restored.player, username: restored.player.getUsername() });
    return restored;
  } finally {
    JsonPlayerPersistence.SAVE_DIRECTORY = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Runs ticks with Math.random answering `value` (the catch, the enraging and the feathers). */
async function withRandom(t, value, run) {
  const random = t.mock.method(Math, "random", () => value);
  try { return await run(); } finally { random.mock.restore(); }
}

// ------------------------------------------------------------------ the quest, start to reward

test("the whole quest, from Farmer Bea's start to the reward, by packets", async (t) => {
  const f = at(t, BESIDE_BEA);
  const bea = npcAt(f, npcId("baw_bea_multi"), BEA);
  assert.equal(bea.getCurrentDefinition(f.player).getId(), N.FARMER_BEA, "Bea shows as baw_bea before the quest");
  assert.equal(journal(f), "I can start this quest by talking to Farmer Bea south west of the Digsite.");

  // The start: refused, then taken with the cider, which refills the run energy.
  let talk = await talkTo(f, bea, ["No."]);
  assert.deepEqual(talk.said.slice(0, 4), ["Alright, me luvver! Welcome to me farm!", "Thank you! What exactly do you farm here?",
    "Well, this place is new i'nt it? Bea's farm be a bee farm, just as soon as we set 'er up. Don't s'pose yer could give us an 'and with that, could yer?",
    "Yes. | No."]);
  assert.deepEqual(talk.said.slice(4), ["Actually, I think I might be allergic to bees.", "Well, tha's a shame ain't it?"]);
  assert.equal(stageOf(f), 0);
  f.player.setRunEnergy(20);
  talk = await talkTo(f, bea, ["Yes.", "I'd love one."]);
  assert.equal(stageOf(f), STAGE.STARTED);
  assert.equal(varbit(f, VARBIT.STAGE), STAGE.STARTED);
  assert.ok(f.messages.some((m) => m.text.includes("You've started a new quest") && m.text.includes("The Birds and the Wasps")));
  assert.ok(talk.said.includes("Bea hands you a glass of cider. You drink it right away and find yourself feeling refreshed."));
  assert.deepEqual(talk.said.slice(-2), ["When yer've got me bees from the bloke in the Grand Exchange, just pop back.", "Will do!"]);
  assert.equal(f.player.getRunEnergy(), 100, "the cider restores run energy fully (Wiki)");
  assert.equal(varbit(f, VARBIT.HAD_CIDER), 1);
  assert.match(journal(f), /^I spoke to Farmer Bea south west of the Digsite and agreed to help her set up her Bee Farm\. To do so, I need to head to the Grand Exchange/);
  talk = await talkTo(f, bea);
  assert.deepEqual(talk.said, ["Alright, me luvver! When yer've got me bees from the bloke in the Grand Exchange, just pop back.", "Will do!"]);

  // The bee dealer at the Grand Exchange: only now does he show; a full inventory keeps the box.
  stand(f, BESIDE_DEALER);
  const dealer = npcAt(f, npcId("baw_bee_dealer_multi"), DEALER);
  assert.equal(dealer.getCurrentDefinition(f.player).getId(), N.BEE_DEALER);
  fill(f);
  talk = await talkTo(f, dealer);
  assert.deepEqual(talk.said, ["Need any... bees?", "I've come to collect Bea's bees.", "Then you've come to the right place.",
    "Out of nowhere, the dealer produces a rather insecure looking box.",
    "Before I hand you this box, I should tell you about proper insect handling.",
    "If they get annoyed, give them a shake. If they don't, don't ever shake them.", "That's it?", "That's it.",
    "But you'll need to make some more space to carry them."]);
  assert.equal(stageOf(f), STAGE.STARTED, "refused at a full inventory");
  assert.equal(amount(f, I.BEE_BOX), 0);
  empty(f);
  talk = await talkTo(f, dealer);
  assert.equal(talk.said.at(-1), "The dealer shoves the box into your hands.");
  assert.equal(amount(f, I.BEE_BOX), 1);
  assert.equal(stageOf(f), STAGE.BEES);
  assert.match(journal(f), /I should carefully transport them back to Bea\.$/);
  talk = await talkTo(f, dealer);
  assert.deepEqual(talk.said, ["Need any... bees?", "Thanks, but I'm already at my stinging insect quota right now."]);

  // Back to Bea with the box: the hand-over and the hive that turns out to hold wasps.
  stand(f, BESIDE_BEA);
  talk = await talkTo(f, bea);
  assert.deepEqual(talk.said, ["Here are your bees!", "You hand over the box of disgruntled insects.",
    "Great! I'll get these lovelies in their new 'ome. You wanna watch 'em move in?", "I'd be delighted!",
    "Right, lets get these lil' fuzzy bumblers moved in.", "Are they...?", "Wasps?!", "They look mad!", "Every farmer fer 'emself!",
    "Wot kind o' bees turn inta wasps on transit!", "I'm not sure they were ever bees.",
    "Well, I'd appreciate a bit more o ya help! Ain't got two bees t'rub togetha' and now we got wasps squattin' in me 'ives!",
    "How can I get rid of wasps?",
    "Grab some kit outta me box 'ere. You'll need a net t'catch 'em, somethin' to protect yerself and a bit o' the ol' bug spray to calm 'em down.",
    "Catch 50 o' the blighters to thin 'em out, then bring me some proof ya done it, right?", "Alright, I'll gear up and catch some wasps."]);
  assert.equal(amount(f, I.BEE_BOX), 0, "Bea keeps the box");
  assert.equal(stageOf(f), STAGE.WASPS);
  assert.match(journal(f), /Bea asked me to thin down the number of Wasps by catching 50 of them and bringing her back proof\./);
  talk = await talkTo(f, bea);
  assert.deepEqual(talk.said, ["Ain't got two bees t'rub togetha' and now we got wasps squattin' in me 'ives!",
    "Could you remind me how to get rid of them?",
    "Grab some kit outta me box 'ere. You'll need a net t'catch 'em, somethin' to protect yerself and a bit o' the ol' bug spray to calm 'em down.",
    "Catch 50 o' the blighters to thin 'em out, then bring me some proof ya done it, right?", "Alright, I'll gear up and catch some wasps."]);

  // The crate: everything at once.
  const crate = await clickCrate(f, 1, ["Take everything."]);
  assert.equal(crate.said.at(-1), "You take a full set of equipment from the crate.");
  for (const id of [I.INSECT_NET, I.BEE_HUNTERS_HAT, I.INSECT_REPELLENT]) assert.equal(amount(f, id), 1, `the crate gives ${id}`);

  // The wasps: the net wielded and the hat worn, then a sting a tick until 50.
  await option(f, I.INSECT_NET, "Wield");
  await option(f, I.BEE_HUNTERS_HAT, "Wear");
  assert.equal(f.player.getEquipment().get(core.Equipment.WEAPON_SLOT).getId(), I.INSECT_NET, "control: the net is wielded");
  assert.equal(f.player.getEquipment().get(core.Equipment.HEAD_SLOT).getId(), I.BEE_HUNTERS_HAT, "control: the hat is worn");
  stand(f, [HIVES[0], HIVES[1] + 1, 0]);
  const swarm = npcAt(f, npcId("baw_wasp_1_multi"), HIVES);
  assert.equal(varbit(f, VARBIT.WASP_1), 1, "the swarm shows from Bea's request");
  assert.equal(swarm.getCurrentDefinition(f.player).getId(), N.SWARM_OF_WASPS_2);
  const hunter = xp(f, core.Skill.HUNTER);
  await withRandom(t, 0.99, async () => {
    await H.talk(f, swarm, 1);
    for (let i = 0; i < 80 && amount(f, I.WASP_STING) < 50; i++) H.tick(f);
  });
  assert.equal(amount(f, I.WASP_STING), 50);
  assert.equal(stageOf(f), STAGE.WASPS_CAUGHT);
  assert.equal(varbit(f, VARBIT.WASPS_NOTIFIED), 1);
  assert.equal(shown(f)?.text, "Looks like I've caught enough. I'd best let Bea know.");
  await chat(f);
  for (let i = 0; i < 5; i++) H.tick(f);
  assert.equal(amount(f, I.WASP_STING), 50, "the line ends the catching");
  assert.deepEqual(f.xp.filter((entry) => entry.skill === "Hunter").map((entry) => entry.amount),
    Array.from({ length: 50 }, (_, catchNumber) => catchNumber % 2 === 0 ? 1 : 2), "1 and 2 Hunter XP in turn (Wiki: Swarm of wasps)");
  assert.ok(xp(f, core.Skill.HUNTER) > hunter, "paid through the world's rate");
  assert.match(journal(f), /I did so and gathered 50 Wasp Stingers in the process\. I should show them to Bea\.$/);

  // A save and reload in the middle keeps everything.
  const g = await reload(t, f, BESIDE_BEA);
  assert.equal(stageOf(g), STAGE.WASPS_CAUGHT);
  assert.equal(varbit(g, VARBIT.STAGE), STAGE.WASPS_CAUGHT);
  assert.equal(varbit(g, VARBIT.WASPS_NOTIFIED), 1);
  assert.equal(varbit(g, VARBIT.HAD_CIDER), 1);
  assert.equal(varbit(g, VARBIT.WASP_1), 1, "the swarms show again at login");
  assert.equal(amount(g, I.WASP_STING), 50);
  const xpAfterWasps = xp(g, core.Skill.HUNTER);
  assert.equal(xpAfterWasps, xp(f, core.Skill.HUNTER));

  // Bea sees the stings; the honey buzzards; two bird snares.
  const bea2 = npcAt(g, npcId("baw_bea_multi"), BEA);
  talk = await talkTo(g, bea2);
  assert.deepEqual(talk.said, ["I've caught 50 wasps. Here, I have some of their stings as proof.", "You show the wasp stings to Bea.",
    "Reckon the wasps ain't gonna be 'appy 'bout that. They're still all o'er the shop tho'.", "Well, I s'pose we'd best...",
    "... Did ye hear tha'?", "We should probably go and find out what's going on...", "See anythin'?", "Yeah, I spotted something.",
    "Well, this won' do at all.", "Birds really wasn't wot I was 'opin' to farm.", "It's quite a diverse ecosystem you are building up here!",
    "If we do get any bees, these birds'll wipe 'em out.", "In that case, how can I deal with them?", "Bea hands you some bird snares.",
    "If ye set yer bird snares up around the birds, there's a good chance they'll land an' get caught in 'em.",
    "Catch us five birds at least, and bring 50 o' their feathers to prove it.", "Alright, back in a bit!"]);
  assert.equal(amount(g, I.WASP_STING), 50, "she only looks at the stings");
  assert.equal(amount(g, I.BIRD_SNARE), 2);
  assert.equal(stageOf(g), STAGE.BIRDS);
  assert.match(journal(g), /Bea asked me to thin down the number of Honey Buzzards by catching at least 5 of them and collecting 50 of their feathers\. If needed/);
  talk = await talkTo(g, bea2);
  assert.deepEqual(talk.said, ["Could you remind me how to deal with those birds?",
    "If ye set yer bird snares up around the birds, there's a good chance they'll land an' get caught in 'em.",
    "Catch us five birds at least, and bring 50 o' their feathers to prove it.", "Alright, back in a bit!"], "no third snare");

  // Five honey buzzards in a bird snare: each catch counted, 50 feathers.
  stand(g, SNARE_TILE);
  const buzzard = npcAt(g, npcId("baw_honey_buzzard_multi"), [SNARE_TILE[0] + 2, SNARE_TILE[1], 0]);
  assert.equal(buzzard.getCurrentDefinition(g.player)?.getId(), npcId("baw_honey_buzzard"), "the buzzards show from 35");
  for (let bird = 1; bird <= 5; bird++) {
    stand(g, SNARE_TILE);
    await withRandom(t, 0, async () => {
      await H.itemOption(g, I.BIRD_SNARE, "Lay");
      const snare = () => core.MapObjects.getObjectsAt(new core.Location(SNARE_TILE[0], SNARE_TILE[1], 0), null)
        .find((object) => object.getId() === core.CacheDefinitions.getLocId("hunting_ojibway_trap_full_honey_buzzard"));
      // World.process rebuilds the NPC update buckets traps look for prey in every cycle and ends it with each NPC's
      // update flags reset (a revealed buzzard's placement); the harness's tick does neither.
      for (let i = 0; i < 60 && !snare(); i++) {
        core.World.rebuildUpdateBuckets();
        H.tick(g);
        buzzard.resetUpdating();
      }
      const { H: hunter } = require("../plugins/skills/hunter/Context.Hunter");
      assert.ok(snare(), `bird ${bird}: the snare holds a honey buzzard (traps: ${JSON.stringify([...hunter.traps].map((trap) => trap.state))})`);
      stand(g, [SNARE_TILE[0], SNARE_TILE[1] + 1, 0]);
      await H.objectOption(g, snare().getId(), SNARE_TILE, 1);
      for (let i = 0; i < 4; i++) H.tick(g);
      // A caught buzzard is gone for ten ticks, then back at its spot (Hunter's reveal).
      for (let i = 0; i < 12; i++) { H.tick(g); buzzard.resetUpdating(); }
      assert.deepEqual(H.xy(buzzard.getLocation()), [SNARE_TILE[0] + 2, SNARE_TILE[1], 0]);
    });
    assert.ok(g.messages.some((m) => m.text === "You've caught a honey buzzard."), `bird ${bird}: the catch line`);
    assert.equal(varbit(g, VARBIT.BIRDS_CAUGHT), bird);
    if (bird < 5) assert.equal(stageOf(g), STAGE.BIRDS);
  }
  assert.equal(amount(g, I.BROWN_FEATHER), 50, "10 feathers each at the lowest roll");
  assert.equal(amount(g, I.BONES), 5);
  assert.equal(stageOf(g), STAGE.BIRDS_CAUGHT);
  assert.equal(varbit(g, VARBIT.BIRDS_NOTIFIED), 1);
  assert.ok(texts(g).includes("Looks like I've caught enough. I'd best let Bea know.") || shown(g)?.text === "Looks like I've caught enough. I'd best let Bea know.");
  await chat(g);
  assert.match(journal(g), /Having done that, I should speak to Bea again\.$/);

  // Wasp darts before Bea asks for them: refused.
  await useItem(g, I.WASP_STING, I.BROWN_FEATHER);
  assert.equal(shown(g)?.text, "You are not sure how or why you would combine these two items.");
  assert.deepEqual(shown(g).items, [I.BROWN_FEATHER, I.WASP_STING]);
  await chat(g);
  assert.equal(amount(g, I.WASP_DART), 0);

  // Bea and the killer wasps.
  stand(g, BESIDE_BEA);
  talk = await talkTo(g, bea2);
  assert.deepEqual(talk.said, ["I've culled some birds and collected 50 of their feathers.",
    "Good job! While yer were doin' that, I went an' gave that bee dealer a piece o' me mind. Got us some replacement bees, I did. Got 'nother spot picked out for 'em just up there.",
    "Let's go get them set up then.", "You head over to the new hives, excited to finally introduce some bees to their new homes...",
    "However, some time later...", "So you say these killer wasps are much worse than the normal ones?", "Yeah, I reckon they are...",
    "This bee dealer is leaving a lot to be desired.", "I'm not gonna' get me 'oney am I?", "Doesn't look like it...",
    "Do me another solid will ya? See if y'can make anythin' useful by puttin' those bird feathers 'n' stings you gathered togetha. Might be we can still achieve somethin' 'ere.",
    "Can't hurt to try."]);
  assert.equal(stageOf(g), STAGE.DARTS);
  assert.equal(amount(g, I.BROWN_FEATHER), 50, "she keeps nothing");
  assert.match(journal(g), /Bea has asked me to see if I can make anything out of the Wasp Stings and Feathers I gathered\.$/);
  talk = await talkTo(g, bea2);
  assert.deepEqual(talk.said, ["What did you want me to do again?",
    "See if y'can make anythin' useful by puttin' those bird feathers 'n' stings you gathered togetha.", "Can't hurt to try."]);

  // The darts: ten a use (the setting for one set a click, option_fletch_dart_or_bolt_makex 0), 5 Fletching XP each ten.
  g.player.getPacketSender().sendVarbit(core.CacheDefinitions.getVarbitId("option_fletch_dart_or_bolt_makex"), 0);
  const fletching = xp(g, core.Skill.FLETCHING);
  await useItem(g, I.WASP_STING, I.BROWN_FEATHER);
  await chat(g);
  assert.equal(amount(g, I.WASP_DART), 10);
  assert.ok(g.messages.some((m) => m.text === "You finish making 10 darts."));
  assert.equal(stageOf(g), STAGE.DARTS_MADE);
  assert.match(journal(g), /I was able to use them to make some Darts\. I should discuss this with Bea\.$/);
  assert.ok(xp(g, core.Skill.FLETCHING) > fletching);
  assert.deepEqual(g.xp.filter((entry) => entry.skill === "Fletching").map((entry) => entry.amount), [5], "5 Fletching XP for ten darts (Wiki: Wasp dart)");
  talk = await talkTo(g, bea2);
  assert.deepEqual(talk.said, ["I've made some darts using the stings and feathers I gathered. I reckon they could be useful for something, but I'm going to make some more first.",
    "Well, at least we're makin' the best o' a bad job."]);
  for (let i = 0; i < 4; i++) {
    await useItem(g, I.WASP_STING, I.BROWN_FEATHER);
    await chat(g);
  }
  assert.equal(amount(g, I.WASP_DART), 50);
  assert.equal(amount(g, I.WASP_STING), 0);
  assert.equal(amount(g, I.BROWN_FEATHER), 0);
  const inspected = await option(g, I.WASP_DART, "Inspect");
  assert.deepEqual(inspected, ["Some darts made using wasp stings. They don't look like the sort of thing you'd want to use yourself, but maybe Bea will have a use for them."]);

  // The reward, once.
  const before = { hunter: xp(g, core.Skill.HUNTER), fletching: xp(g, core.Skill.FLETCHING), points: points(g) };
  talk = await talkTo(g, bea2);
  assert.deepEqual(talk.said.slice(0, 7), ["I've made 50 darts using the stings and feathers I gathered. I can't see myself ever having a use for them, but maybe someone else will want them.",
    "Can probably sell 'em to the local guards. They ain't too picky with the gear they use. Feel free to give me any ya make an' I can pay yer back in useful supplies.",
    "Sounds good to me.", "You glance around at the mess of insects and birds on the plot of land.",
    "It's certainly a unique farm we've created here.",
    "It's a shame I won't get me 'oney, but at least we ain't come away with nothin'. Yer help's been wonderful, it has!",
    "Happy to be a part of it!"]);
  assert.equal(stageOf(g), STAGE.COMPLETE);
  assert.equal(varbit(g, VARBIT.STAGE), STAGE.COMPLETE, "the quest table's endstate");
  assert.equal(quest().isComplete(g.player), true);
  assert.equal(points(g) - before.points, 1);
  const paid = { hunter: xp(g, core.Skill.HUNTER) - before.hunter, fletching: xp(g, core.Skill.FLETCHING) - before.fletching };
  assert.ok(paid.hunter > 0 && Math.abs(paid.hunter / paid.fletching - 1000 / 250) < 1e-6, "1,000 Hunter and 250 Fletching XP, at the world's rate");
  assert.deepEqual(g.xp.filter((entry) => entry.amount >= 250).map((entry) => [entry.skill, entry.amount]), [["Hunter", 1000], ["Fletching", 250]],
    "the reward as the quest row's stat_xp_awarded, before the world's rate");
  assert.equal(amount(g, I.WASP_DART), 50, "she leaves the darts with the player");
  assert.ok(g.messages.some((m) => m.text.startsWith("Congratulations, you've completed a quest")));
  assert.match(journal(g), /Bee-less Bee Farm\.<\/str>  <col=ff0000>QUEST COMPLETE!$/);
  assert.equal(varbit(g, VARBIT.KILLER_1), 1, "the killer wasps show once the quest is done");
  assert.equal(bea2.getCurrentDefinition(g.player).getId(), N.FARMER_BEA_2, "Bea with Trade and Swap-darts");

  // Afterwards: no second reward; her menu; the darts traded for supplies.
  for (let i = 0; i < 3; i++) H.tick(g);
  g.player.getPacketSender().sendInterfaceRemoval();
  talk = await talkTo(g, bea2, ["How's the farm going, Bea?"]);
  assert.deepEqual(talk.said.slice(0, 6), ["Alright, me luvver!",
    "How's the farm going, Bea? | Do you have anything for sale? | Can I trade in some darts? | Do you have any hunting tips for me? | I'd best be off.",
    "How's the farm going Bea?", "It's alright. Not surrounded by 'oney like what I intended, but I'm getting by.",
    "Good to hear! I suppose you won't mind if I hunt some more of your creatures?",
    "Not at all. Take as many as yer like! Remember, if yer make more darts, I can swap 'em for stuff."]);
  assert.equal(talk.left?.who, "menu", "back to her menu");
  g.player.getDialogueManager().reset();
  assert.equal(points(g) - before.points, 1, "no second quest point");
  assert.equal(xp(g, core.Skill.HUNTER) - before.hunter, paid.hunter, "no second experience");
  talk = await talkTo(g, bea2, [], "Swap-darts");
  assert.equal(amount(g, I.BEAS_SUPPLIES), 1);
  assert.equal(amount(g, I.WASP_DART), 15, "35 wasp darts a bag");

  // The quest list: complete, on its own cache row.
  const { nativeQuestIndex } = require("../plugins/quests/QuestList.QuestRuntime");
  assert.equal(nativeQuestIndex(QuestRuntime.getRegisteredQuests(), core.CacheDefinitions).get(221)?.key, KEY);
  const request = { player: g.player, key: KEY, complete: false };
  H.PM.emitCustomEvent("quest:is-complete", request);
  assert.equal(request.complete, true);
});

// ------------------------------------------------------------------ the bee box

test("the bee box: agitated insects, shaking them, stings, and a lost box", async (t) => {
  const f = at(t, BESIDE_DEALER, { stage: STAGE.STARTED });
  const { bees } = quest().units;
  const dealer = npcAt(f, npcId("baw_bee_dealer_multi"), DEALER);
  await talkTo(f, dealer);
  assert.equal(amount(f, I.BEE_BOX), 1);

  // Shaken while calm: a sting.
  let life = hp(f);
  let said = await option(f, I.BEE_BOX, "Shake");
  assert.deepEqual(said, ["The insects don't seem to appreciate being shook and sting you through the holes in the box."]);
  for (let i = 0; i < 3; i++) H.tick(f);
  assert.equal(hp(f), life - 1);

  // Agitated: the red line; left alone, a sting; shaken, calm again with the green line.
  bees.hurry(f.player);
  H.tick(f);
  assert.equal(bees.agitated(f.player), true);
  assert.match(lastMessage(f), /^<col=ef1020>You can sense the insects in the box getting agitated\. Best give them a shake\.<\/col>$/);
  life = hp(f);
  bees.hurry(f.player);
  H.tick(f);
  for (let i = 0; i < 3; i++) H.tick(f);
  assert.match(lastMessage(f), /The agitated insects lash out and sting you through the holes in the box\./);
  assert.equal(hp(f), life - 1);
  said = await option(f, I.BEE_BOX, "Shake");
  assert.deepEqual(said, ["You give the box a firm shake and the insects seem to calm down."]);
  assert.ok(f.messages.some((m) => /^<col=06600c>You give the box a firm shake and the insects seem to calm down\.<\/col>$/.test(m.text)));
  assert.equal(bees.agitated(f.player), false);

  // Lost: the journal says so and the dealer hands over another.
  inv(f).deleteNumber(I.BEE_BOX, 1);
  inv(f).refreshItems();
  assert.match(journal(f), /If I lose the Bees, I'll need to speak to the Bee Dealer about getting some more\.$/);
  const talk = await talkTo(f, dealer);
  assert.deepEqual(talk.said, ["Need any... bees?", "I've lost Bea's bees.", "Plenty more where they came from.", "The dealer shoves a box into your hands."]);
  assert.equal(amount(f, I.BEE_BOX), 1);

  // The insects keep their mood across a save, and stop with the box handed over.
  const g = await reload(t, f, BESIDE_BEA);
  assert.equal(amount(g, I.BEE_BOX), 1);
  bees.hurry(g.player);
  H.tick(g);
  assert.equal(bees.agitated(g.player), true, "the box's insects go on after a login");
});

// ------------------------------------------------------------------ the crate, the wasps and the snares

test("the equipment crate: one at a time, back to its menu, and a full inventory", async (t) => {
  const f = at(t, BESIDE_BEA, { stage: STAGE.WASPS });
  let crate = await clickCrate(f, 1, ["Insect net.", "Bee hunter's hat.", "Insect repellent.", "Take nothing."]);
  assert.deepEqual(crate.said, ["Insect net. | Bee hunter's hat. | Insect repellent. | Take everything. | Take nothing.",
    "You take an insect net from the crate.", "Insect net. | Bee hunter's hat. | Insect repellent. | Take everything. | Take nothing.",
    "You take a bee hunter's hat from the crate.", "Insect net. | Bee hunter's hat. | Insect repellent. | Take everything. | Take nothing.",
    "You take some insect repellent from the crate.", "Insect net. | Bee hunter's hat. | Insect repellent. | Take everything. | Take nothing."]);
  for (const id of [I.INSECT_NET, I.BEE_HUNTERS_HAT, I.INSECT_REPELLENT]) assert.equal(amount(f, id), 1);
  crate = await clickCrate(f, 2);
  assert.deepEqual(crate.said, ["You take a full set of equipment from the crate."], "Take-all");
  assert.equal(amount(f, I.INSECT_NET), 2);
  fill(f);
  crate = await clickCrate(f, 1);
  assert.deepEqual(crate.said, ["You don't have space to take anything from the crate."]);

  // Before Bea's request the crate is a plain crate with no options (the cache's baw_equipment_crate).
  const early = at(t, BESIDE_BEA, { stage: STAGE.BEES });
  const definition = core.ObjectDefinition.forPlayer(core.CacheDefinitions.getLocId("baw_equipment_crate"), early.player);
  assert.equal(definition.getName(), "Crate");
  assert.deepEqual((definition.getInteractions?.() ?? []).filter(Boolean), []);
});

test("the wasps: the net, the hat and room are needed; an enraged swarm is calmed with insect repellent", async (t) => {
  const f = at(t, [HIVES[0], HIVES[1] + 1, 0], { stage: STAGE.WASPS });
  const swarm = npcAt(f, npcId("baw_wasp_2_multi"), HIVES);
  let said = (await talkTo(f, swarm, [], "Catch")).said;
  assert.deepEqual(said, ["You need to be holding an insect net to catch these wasps."]);
  wear(f, core.Equipment.WEAPON_SLOT, I.INSECT_NET);
  said = (await talkTo(f, swarm, [], "Catch")).said;
  assert.deepEqual(said, ["The wasps sting you in the face. Some sort of protective hat is probably in order."]);
  wear(f, core.Equipment.HEAD_SLOT, I.BEEKEEPERS_HAT);
  fill(f);
  said = (await talkTo(f, swarm, [], "Catch")).said;
  assert.deepEqual(said, ["You need more inventory space to catch these wasps."]);
  assert.equal(amount(f, I.WASP_STING), 0);
  empty(f);

  // Enraged on a catch: the swarm turns furious for this player only.
  await withRandom(t, 0, async () => {
    await H.talk(f, swarm, 1);
    for (let i = 0; i < 4 && !shown(f); i++) H.tick(f);
  });
  assert.equal(shown(f)?.text, "The wasps become enraged with you!");
  await chat(f);
  assert.equal(amount(f, I.WASP_STING), 1);
  assert.equal(varbit(f, 16842), 2);
  assert.equal(swarm.getCurrentDefinition(f.player).getId(), N.SWARM_OF_WASPS_FURIOUS_);
  const other = at(t, [HIVES[0], HIVES[1] - 1, 0], { stage: STAGE.WASPS });
  assert.equal(swarm.getCurrentDefinition(other.player).getId(), N.SWARM_OF_WASPS_2, "calm for everyone else");

  said = (await talkTo(f, swarm, [], "Spray")).said;
  assert.deepEqual(said, ["You need to have some insect repellent to spray these wasps."]);
  give(f, I.INSECT_REPELLENT);
  said = (await talkTo(f, swarm, [], "Spray")).said;
  assert.deepEqual(said, ["You calm the wasps down a bit by spraying them with insect repellent."]);
  assert.equal(varbit(f, 16842), 1);
  assert.equal(amount(f, I.INSECT_REPELLENT), 1, "the repellent is kept");
  assert.ok(f.animations.some((a) => a.id === core.CacheDefinitions.getSeqId("human_use_insect_repellant")));

  // Before the quest gets this far the swarms do not show at all; the killer wasps wait for its end.
  const early = at(t, BESIDE_BEA, { stage: STAGE.BEES });
  assert.equal(varbit(early, VARBIT.WASP_1), 0);
  assert.equal(swarm.getCurrentDefinition(early.player), undefined);
  assert.equal(varbit(f, VARBIT.KILLER_1), 0);
});

test("Bea's bird snares: a full inventory gets none, one carried gets one", async (t) => {
  const f = at(t, BESIDE_BEA, { stage: STAGE.BIRDS });
  const bea = npcAt(f, npcId("baw_bea_multi"), BEA);
  fill(f);
  let talk = await talkTo(f, bea);
  assert.deepEqual(talk.said, ["Could you remind me how to deal with those birds?", "You'll need a bit more space to 'elp. Got some bird snares for ya here."]);
  assert.equal(amount(f, I.BIRD_SNARE), 0);
  empty(f);
  give(f, I.BIRD_SNARE);
  talk = await talkTo(f, bea);
  assert.equal(talk.said[1], "Bea hands you a bird snare.");
  assert.equal(amount(f, I.BIRD_SNARE), 2);
});

/** Lays a bird snare on `tile` and runs up to `limit` ticks (every catch roll a success); the trap's full loc, if any. */
async function snareFor(t, f, prey, tile, fullName, { limit = 40, lay = true } = {}) {
  const full = () => core.MapObjects.getObjectsAt(new core.Location(tile[0], tile[1], 0), null)
    .find((object) => object.getId() === core.CacheDefinitions.getLocId(fullName));
  await withRandom(t, 0, async () => {
    if (lay) {
      stand(f, tile);
      give(f, I.BIRD_SNARE);
      await H.itemOption(f, I.BIRD_SNARE, "Lay");
    }
    for (let i = 0; i < limit && !full(); i++) {
      core.World.rebuildUpdateBuckets();
      H.tick(f);
      prey.resetUpdating();
    }
  });
  return full();
}

test("a honey buzzard is no prey before Bea wants birds, a black honey buzzard none before the quest is done", async (t) => {
  const early = at(t, SNARE_TILE, { stage: STAGE.WASPS });
  const honey = npcAt(early, npcId("baw_honey_buzzard_multi"), [SNARE_TILE[0] + 2, SNARE_TILE[1], 0]);
  assert.equal(honey.getCurrentDefinition(early.player), undefined, "hidden before 35 (the cache)");
  assert.equal(await snareFor(t, early, honey, SNARE_TILE, "hunting_ojibway_trap_full_honey_buzzard"), undefined);
  const { H: hunter } = require("../plugins/skills/hunter/Context.Hunter");
  assert.equal([...hunter.traps].filter((trap) => trap.player === early.player).length, 1, "control: the snare was laid");
  core.World.getNpcs().remove(honey);

  // The first player leaves, and their snare with them (Hunter's cleanup).
  H.PM.emitPlayerLogout({ player: early.player, username: early.player.getUsername() });
  const tile = SNARE_TILE;
  const darts = at(t, tile, { stage: STAGE.DARTS });
  const black = npcAt(darts, npcId("baw_black_honey_buzzard_multi"), [tile[0] + 2, tile[1], 0]);
  assert.equal(black.getCurrentDefinition(darts.player)?.getId(), npcId("baw_black_honey_buzzard"), "shown from 45 (the cache)");
  darts.player.getSkillManager().setCurrentLevel(core.Skill.HUNTER, 17, false);
  assert.equal(await snareFor(t, darts, black, tile, "hunting_ojibway_trap_full_black_honey_buzzard"), undefined,
    "not caught before the quest is done (Wiki: Black Honey Buzzard)");
  assert.equal([...hunter.traps].filter((trap) => trap.player === darts.player).length, 1, "control: the snare was laid");
  quest().setStage(darts.player, STAGE.COMPLETE);
  const full = await snareFor(t, darts, black, tile, "hunting_ojibway_trap_full_black_honey_buzzard", { lay: false });
  assert.ok(full, "caught once the quest is done, in the same snare");
  stand(darts, [tile[0] + 1, tile[1], 0]);
  await H.objectOption(darts, full.getId(), [tile[0], tile[1]], 1);
  for (let i = 0; i < 4; i++) H.tick(darts);
  const feathers = amount(darts, I.BLACK_FEATHER);
  assert.ok(feathers >= 10 && feathers <= 24, `10-24 black feathers (Wiki): ${feathers}`);
  assert.equal(amount(darts, I.BONES), 1);
  assert.ok(darts.messages.some((m) => m.text === "You've caught a black honey buzzard."));
  assert.deepEqual(darts.xp.filter((entry) => entry.skill === "Hunter").map((entry) => entry.amount), [87.4]);
});

// ------------------------------------------------------------------ after the quest

test("after the quest: the supplies a bag holds, killer wasp darts, and the trade with too few darts", async (t) => {
  const f = at(t, BESIDE_BEA, { stage: STAGE.COMPLETE });
  const { farm } = quest().units;
  const bea = npcAt(f, npcId("baw_bea_multi"), BEA);
  const talk = await talkTo(f, bea, ["Can I trade in some darts?"]);
  assert.deepEqual(talk.said.slice(2), ["Can I trade in some darts?",
    "Yer can, but I'm 'fraid yer not got enough darts. For one supply bag it'll either be 35 wasp darts or 20 killer wasp darts.",
    "How's the farm going, Bea? | Do you have anything for sale? | Can I trade in some darts? | Do you have any hunting tips for me? | I'd best be off."]);
  f.player.getDialogueManager().reset();

  // Her shop, from the menu and from Trade.
  let shop = await talkTo(f, bea, ["Do you have anything for sale?"]);
  assert.deepEqual(shop.said.slice(-2), ["Do you have anything for sale?", "I've got a stock o' hunting gear, given me farm seems t'revolve 'round it."]);
  for (let i = 0; i < 2; i++) H.tick(f);
  const open = core.ShopManager.getOpenShop(f.player);
  assert.equal(open?.name, "Bea's Hunting Gear");
  assert.deepEqual(open.stock.map((entry) => [entry.itemId, entry.amount]).slice(0, 4),
    [[I.BUTTERFLY_JAR, 100], [I.MAGIC_BOX, 30], [I.NOOSE_WAND, 50], [I.BIRD_SNARE, 50]], "the Wiki's stock");
  assert.equal(open.stock.length, 12);
  core.ShopManager.close(f.player);
  f.player.getPacketSender().sendInterfaceRemoval();
  await talkTo(f, bea, [], "Trade");
  assert.equal(core.ShopManager.getOpenShop(f.player)?.name, "Bea's Hunting Gear", "Trade opens it too");
  core.ShopManager.close(f.player);
  f.player.getPacketSender().sendInterfaceRemoval();

  // Her hunting tips.
  const tips = await talkTo(f, bea, ["Do you have any hunting tips for me?", "Could you tell me about hunting further afield?", "Actually, let's talk about something else.", "I'd best be off."]);
  assert.ok(tips.said.includes("Piscatoris 'as a load o' woodland creatures to trap. If ya don't mind the cold, north of Rellekka there's plenty o' animals in the ice 'n' snow. Finally, the Feldip Hills 'as a lot of jungle critters for 'untin'."));
  assert.equal(tips.said.at(-1), "I'd best be off.");

  // Killer wasps once the quest is done: Hunter 12, a killer wasp sting a catch, 2 and 3 XP in turn.
  const swarm = npcAt(f, npcId("baw_killer_wasp_1_multi"), [3300, 3387, 0]);
  stand(f, [3300, 3388, 0]);
  assert.equal(swarm.getCurrentDefinition(f.player).getId(), N.SWARM_OF_KILLER_WASPS_2);
  wear(f, core.Equipment.WEAPON_SLOT, I.INSECT_NET);
  wear(f, core.Equipment.HEAD_SLOT, I.BEE_HUNTERS_HAT);
  f.player.getSkillManager().setCurrentLevel(core.Skill.HUNTER, 11, false);
  await talkTo(f, swarm, [], "Catch");
  assert.equal(lastMessage(f), "You need a Hunter level of at least 12 to catch these wasps.");
  assert.equal(amount(f, I.KILLER_WASP_STING), 0);
  f.player.getSkillManager().setCurrentLevel(core.Skill.HUNTER, 12, false);
  await withRandom(t, 0.99, async () => {
    await H.talk(f, swarm, 1);
    for (let i = 0; i < 4; i++) H.tick(f);
  });
  f.player.setLocation(new core.Location(3300, 3389, 0)); // walks off: the catching stops
  for (let i = 0; i < 3; i++) H.tick(f);
  assert.ok(amount(f, I.KILLER_WASP_STING) >= 2);
  assert.deepEqual(f.xp.filter((entry) => entry.skill === "Hunter").map((entry) => entry.amount).slice(0, 2), [2, 3]);
  stand(f, BESIDE_BEA);

  give(f, I.KILLER_WASP_DART, 40);
  await talkTo(f, bea, [], "Swap-darts");
  assert.equal(amount(f, I.BEAS_SUPPLIES), 2, "20 killer wasp darts a bag");
  assert.equal(amount(f, I.KILLER_WASP_DART), 0);
  await H.itemOption(f, I.BEAS_SUPPLIES, "Open");
  assert.equal(amount(f, I.BEAS_SUPPLIES), 1);
  const table = new Set(farm.SUPPLIES.map(([, id]) => id));
  const got = inv(f).getItems().filter((item) => item && table.has(item.getId()));
  assert.ok(got.length >= 1, "a bag holds one of the Wiki's supplies");
  assert.deepEqual(farm.rollSupplies(() => 0), [I.HEADLESS_ARROW, 60]);
  assert.deepEqual(farm.rollSupplies(() => 0.9999), [I.STEEL_DART, 70]);

  // Killer wasp darts: Fletching 15, from killer wasp stings.
  give(f, I.KILLER_WASP_STING, 10);
  give(f, I.FEATHER, 10);
  f.player.getSkillManager().setCurrentLevel(core.Skill.FLETCHING, 14, false);
  await useItem(f, I.KILLER_WASP_STING, I.FEATHER);
  await chat(f);
  assert.equal(amount(f, I.KILLER_WASP_DART), 0, "refused below 15");
  f.player.getSkillManager().setCurrentLevel(core.Skill.FLETCHING, 15, false);
  await useItem(f, I.KILLER_WASP_STING, I.FEATHER);
  await chat(f);
  assert.equal(amount(f, I.KILLER_WASP_DART), 10, "made at 15");
});

// ------------------------------------------------------------------ the retired tutors' data

test("the retired tutors' data does not answer for the new NPCs on their ids", (t) => {
  for (const [id, text] of [[3217, "Bea believes bees be bringing big bucks."], [3216, "Bea believes bees be bringing big bucks."],
    [3220, "A bee in the hand is worth two in the hive."], [3227, "Also known as cloud of ouch, ouch, ouch."],
    [8665, "Also known as cloud of very, very, very, ouch, ouch, ouch."], [3224, "The buzzing is wasps in its belly."]]) {
    assert.equal(core.NpcDefinition.forId(id).getExamine(), text, `${id}'s examine`);
  }
  // A transcript asked for the bee dealer's id finds nothing of the crafting tutor's; Cadmus, his successor, still plays it.
  const f = at(t, BESIDE_DEALER, { stage: STAGE.STARTED });
  const request = { player: f.player, npcId: N.BEE_DEALER, handled: false };
  H.PM.emitCustomEvent("npc-dialogue:start", request);
  assert.equal(request.handled, false, "no tutor transcript for the bee dealer");
  f.player.getDialogueManager().reset();
  const cadmus = { player: f.player, npcId: N.CADMUS, handled: false };
  H.PM.emitCustomEvent("npc-dialogue:start", cadmus);
  assert.equal(cadmus.handled, true, "Cadmus keeps the crafting tutor's transcript");
  f.player.getDialogueManager().reset();
});

test("the spawns: Bea, the dealer, three swarms of each kind and the buzzards, by their cache parents", () => {
  const spawns = require("../data/definitions/npc-spawns.json");
  const by = (id) => spawns.filter((spawn) => spawn.id === id).map((spawn) => [spawn.x, spawn.y, spawn.level]);
  assert.deepEqual(by(npcId("baw_bea_multi")), [[3316, 3376, 0]]);
  assert.deepEqual(by(npcId("baw_bee_dealer_multi")), [[3187, 3493, 0]]);
  for (const name of ["baw_wasp_1_multi", "baw_wasp_2_multi", "baw_wasp_3_multi", "baw_killer_wasp_1_multi", "baw_killer_wasp_2_multi", "baw_killer_wasp_3_multi"]) {
    assert.equal(by(npcId(name)).length, 1, name);
  }
  assert.equal(by(npcId("baw_honey_buzzard_multi")).length, 3);
  assert.equal(by(npcId("baw_black_honey_buzzard_multi")).length, 3);
  assert.equal(spawns.some((spawn) => spawn.name === "Goblin" && spawn.x === 3311 && spawn.y === 3375), false, "the farm took the goblin's hill (Wiki: Bea's farm)");
});
