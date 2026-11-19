// Run after `yarn build`: node --test tests/dig-site-tray-teddy.test.cjs
//
// The Dig Site's mud tray keeps its mud when the coin reward can't be added (a stack at the cap), and
// the teddy bush gives no second teddy while one is banked. Real plugins, a real Player, Inventory
// and Bank; the clicks go through PluginManager.emitItemAction / emitObjectInteraction with the
// cache's own Search option. No client ran.
process.env.DISABLE_PLAYER_BOTS = "1";
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { ObjectDefinition } = require("../dist/game/definition/ObjectDefinition");
const { ItemActionPacketListener } = require("../dist/net/packet/impl/ItemActionPacketListener");
const QuestRuntime = require("../plugins/quests/QuestRuntime");

const MAX_STACK = 2147483647;
let core;
let index = 7640;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  ObjectDefinition.init();
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));

function player(t, name) {
  const channel = {
    kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true,
    close() {}, onData() {}, onError() {}, onClose() {},
  };
  const p = new Player(new PlayerSession(channel));
  p.setIndex(index++);
  p.setUsername(name);
  p.setRegistered(true);
  p.setLocation(new core.Location(3370, 3378, 0));
  p.needsPlacement = false;
  const messages = [];
  const send = p.sendMessage.bind(p);
  p.sendMessage = (text, ...rest) => { messages.push(String(text)); return send(text, ...rest); };
  t.after(() => {
    PM.emitPlayerLogout({ player: p, username: p.getUsername() });
    p.setRegistered(false);
  });
  return { p, messages };
}

const digSite = () => QuestRuntime.getRegisteredQuests().find((entry) => entry.key === "the_dig_site");

function searchTray(p, slot) {
  const item = p.getInventory().getItems()[slot];
  const action = [2, 3, 4, 6, 7].map((op) => ItemActionPacketListener.resolveInventoryWidgetAction(item.getId(), op))
    .find((candidate) => candidate?.option?.toLowerCase() === "search");
  assert.ok(action, "the native resolver exposes Search");
  return PM.emitItemAction({ player: p, item, itemId: item.getId(), slot, interfaceId: (149 << 16),
    clickType: action.optionIndex, option: action.option, handled: false });
}

function searchBush(p) {
  const id = core.ObjectIdentifiers.BUSH_10;
  const definition = ObjectDefinition.forPlayer(id, p) ?? ObjectDefinition.forId(id);
  const clickType = definition.getInteractions().findIndex((option) => option?.toLowerCase() === "search") + 1;
  assert.ok(clickType > 0, "the bush has the cache's Search option");
  const at = { x: 3370, y: 3379, z: 0 };
  return PM.emitObjectInteraction({ player: p, object: { getId: () => id, getLocation: () => new core.Location(at.x, at.y, 0) },
    objectId: id, definition, clickType, location: at, sourceLocation: { x: 3370, y: 3378, z: 0 }, handled: false });
}

test("a coin stack at the cap leaves the mud in the tray instead of losing the coins", (t) => {
  const { p } = player(t, "digsitetray1");
  const I = core.ItemIdentifiers;
  const inventory = p.getInventory();
  inventory.setItem(0, new core.Item(I.PANNING_TRAY_3, 1));
  inventory.setItem(1, new core.Item(I.COINS, MAX_STACK));
  t.mock.method(Math, "random", () => 0); // roll 0: coins, then the smallest amount
  assert.equal(searchTray(p, 0), true);
  assert.equal(inventory.getItems()[0].getId(), I.PANNING_TRAY_3, "the mud stays for later");
  assert.equal(inventory.getAmount(I.COINS), MAX_STACK);

  inventory.setItem(1, new core.Item(I.COINS, 100));
  assert.equal(searchTray(p, 0), true);
  assert.equal(inventory.getItems()[0].getId(), I.PANNING_TRAY, "searched once there is room");
  assert.equal(inventory.getAmount(I.COINS), 101);
});

test("the teddy bush gives no second teddy while one is banked, and does once it is gone", (t) => {
  const { p, messages } = player(t, "digsiteteddy1");
  const I = core.ItemIdentifiers;
  digSite().setStage(p, 1);
  p.getBank(0).add(new core.Item(I.TEDDY, 1));
  assert.equal(searchBush(p), true);
  assert.equal(p.getInventory().getAmount(I.TEDDY), 0, "already owned in the bank");
  assert.ok(messages.includes("You find nothing of interest."));

  p.getBank(0).resetItems();
  p.getBank(0).add(new core.Item(I.TEDDY, 0)); // a placeholder is not a teddy
  assert.equal(searchBush(p), true);
  assert.equal(p.getInventory().getAmount(I.TEDDY), 1, "a lost teddy can be found again");
});

/** Real Talk-to variant selection, as the dialogue runtime asks every plugin. */
const talkToStudent = (p, npcId) => PM.emitNpcDialogueVariant({ player: p, npcId, pages: [] });

test("the three students ask for their own lost item and take it back on the second talk", (t) => {
  const { p } = player(t, "digsitestudents1");
  const I = core.ItemIdentifiers;
  const N = core.NpcIdentifiers;
  digSite().setStage(p, 1);
  p.setAttribute("quest.the_dig_site.letter_stamped", true);
  p.setAttribute("quest.the_dig_site.letter_delivered", true);

  const cases = [
    [N.STUDENT, I.ANIMAL_SKULL, "green-top", "skull"],
    [N.STUDENT_2, I.TEDDY, "purple-skirt", "teddy-bear"],
    [N.STUDENT_3, I.SPECIAL_CUP, "orange-shirt", "cup"],
  ];
  for (const [npcId, itemId, who, lost] of cases) {
    const prefix = `the-first-exam-the-student-in-the-${who}`;
    assert.equal(talkToStudent(p, npcId), `${prefix}-asking-the-student-for-help`,
      `${who} asks for help on the first talk`);
    assert.equal(talkToStudent(p, npcId), `${prefix}-returning-to-the-student-without-the-${lost}`,
      `${who} asks for their own item while it is missing`);
    p.getInventory().adds(itemId, 1);
    assert.equal(talkToStudent(p, npcId), `${prefix}-returning-the-${lost}`,
      `${who} takes the item back`);
    assert.equal(p.getInventory().getAmount(itemId), 0, `${who} consumes the item`);
    assert.equal(talkToStudent(p, npcId), `${prefix}-talking-to-the-student-again`,
      `${who} repeats the answer after the item is returned`);
  }
});

// Upstream issue #6215: the students tell their answers and never sign a certificate (the examiner's own exam does
// that: tests/quest-reward-room-2.test.cjs sits the three exams by packet).
test("helping all three students gives no certificate and leaves the stage for the exam", (t) => {
  const { p } = player(t, "digsiteallthree1");
  const I = core.ItemIdentifiers;
  const N = core.NpcIdentifiers;
  digSite().setStage(p, 1);
  p.setAttribute("quest.the_dig_site.letter_stamped", true);
  p.setAttribute("quest.the_dig_site.letter_delivered", true);
  for (const [npcId, itemId] of [[N.STUDENT, I.ANIMAL_SKULL], [N.STUDENT_2, I.TEDDY], [N.STUDENT_3, I.SPECIAL_CUP]]) {
    talkToStudent(p, npcId);
    p.getInventory().adds(itemId, 1);
    talkToStudent(p, npcId);
    talkToStudent(p, npcId);
  }
  for (const id of [I.LEVEL_1_CERTIFICATE, I.LEVEL_2_CERTIFICATE, I.LEVEL_3_CERTIFICATE]) {
    assert.equal(p.getInventory().getAmount(id), 0);
  }
  assert.equal(digSite().getStage(p), 1);
});

test("the students speak for the exam the player is on: second-exam notes, then third, the purple one after her opal", (t) => {
  const { p } = player(t, "digsitestages1");
  const I = core.ItemIdentifiers;
  const N = core.NpcIdentifiers;
  digSite().setStage(p, 2);
  assert.equal(talkToStudent(p, N.STUDENT), "the-second-exam-the-student-in-the-green-top");
  assert.equal(talkToStudent(p, N.STUDENT_2), "the-second-exam-the-student-in-the-purple-skirt");
  assert.equal(talkToStudent(p, N.STUDENT_3), "the-second-exam-the-student-in-the-orange-shirt");
  digSite().setStage(p, 3);
  assert.equal(talkToStudent(p, N.STUDENT), "the-third-exam-the-student-in-the-green-top");
  assert.equal(talkToStudent(p, N.STUDENT_3), "the-third-exam-the-student-in-the-orange-shirt");
  assert.equal(talkToStudent(p, N.STUDENT_2), "the-third-exam-the-student-in-the-purple-skirt", "she asks for an opal");
  assert.equal(talkToStudent(p, N.STUDENT_2), "the-third-exam-the-student-in-the-purple-skirt-returning-without-an-opal");
  p.getInventory().adds(I.OPAL, 1);
  assert.equal(talkToStudent(p, N.STUDENT_2), "the-third-exam-the-student-in-the-purple-skirt-giving-the-student-the-opal");
  assert.equal(p.getInventory().getAmount(I.OPAL), 0, "a cut opal does as well as an uncut one");
  assert.equal(talkToStudent(p, N.STUDENT_2), "the-third-exam-the-student-in-the-purple-skirt-talking-to-the-student-again");
});

test("the teddy bush is empty once the student has her teddy back", (t) => {
  const { p, messages } = player(t, "digsiteteddy2");
  const I = core.ItemIdentifiers;
  digSite().setStage(p, 1);
  assert.equal(searchBush(p), true);
  assert.equal(p.getInventory().getAmount(I.TEDDY), 1, "found once");
  talkToStudent(p, core.NpcIdentifiers.STUDENT_2);
  assert.equal(talkToStudent(p, core.NpcIdentifiers.STUDENT_2), "the-first-exam-the-student-in-the-purple-skirt-returning-the-teddy-bear");
  assert.equal(p.getInventory().getAmount(I.TEDDY), 0);
  p.getDialogueManager().reset();
  messages.length = 0;
  assert.equal(searchBush(p), true);
  assert.equal(p.getInventory().getAmount(I.TEDDY), 0, "no second teddy from the bush");
  assert.ok(messages.includes("You find nothing of interest."), messages.join("|"));
});

test("the exam centre's cupboards open, hand over a specimen jar and a rock pick, and shut again", (t) => {
  const { p, messages } = player(t, "digsitecupboard1");
  const I = core.ItemIdentifiers;
  const O = core.ObjectIdentifiers;
  const { MapObjects } = require("../dist/game/entity/impl/object/MapObjects");
  core.RegionManager.init();
  core.RegionManager.loadMapFiles(3354, 3332);
  const click = (id, x, y, option) => {
    const object = MapObjects.get(id, new core.Location(x, y, 0), null);
    assert.ok(object, `loc ${id} stands at ${x},${y}`);
    const definition = ObjectDefinition.forId(id);
    const clickType = definition.getInteractions().indexOf(option) + 1;
    assert.ok(clickType > 0, `loc ${id} offers ${option}`);
    return PM.emitObjectInteraction({ player: p, object, objectId: id, definition, clickType, option: option.toLowerCase(),
      location: { x, y, z: 0 }, sourceLocation: { x, y: y + 1, z: 0 }, handled: false });
  };
  for (const [closed, open, x, y, itemId, line] of [
    [O.CUPBOARD_45, O.CUPBOARD_46, 3354, 3332, I.SPECIMEN_JAR, "You find a specimen jar."],
    [O.CUPBOARD_43, O.CUPBOARD_44, 3355, 3337, I.ROCK_PICK, "You find a rock pick."],
  ]) {
    assert.equal(click(closed, x, y, "Open"), true, "Open is answered");
    assert.equal(click(open, x, y, "Search"), true, "Search is answered");
    assert.equal(p.getInventory().getAmount(itemId), 1, line);
    assert.ok(messages.includes(line), messages.join("|"));
    p.getDialogueManager().reset();
    assert.equal(click(open, x, y, "Search"), true);
    assert.equal(p.getInventory().getAmount(itemId), 1, "one at a time");
    assert.equal(click(open, x, y, "Close"), true, "Close is answered");
    assert.ok(MapObjects.get(closed, new core.Location(x, y, 0), null), "the shut cupboard is back");
  }
});

// Ours: Wiki (The Dig Site, Rewards): 2 gold bars with the 15,300 Mining and 2,000 Herblore experience.
test("completing The Dig Site hands over two gold bars", (t) => {
  const { p } = player(t, "digbars");
  const GOLD_BAR = core.ItemIdentifiers.GOLD_BAR;
  assert.equal(p.getInventory().getAmount(GOLD_BAR), 0);
  assert.equal(digSite().complete(p, { scroll: false, announce: false }), true);
  assert.equal(p.getInventory().getAmount(GOLD_BAR), 2);
  assert.equal(digSite().complete(p, { scroll: false, announce: false }), false, "only once");
  assert.equal(p.getInventory().getAmount(GOLD_BAR), 2);
});
