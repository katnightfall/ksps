// Ours. Run after `yarn build`: node --test tests/set-skill-level-admins.test.cjs
// World setting SetSkillLevel:adminsOnly (plugins/interface/SetSkillLevel.plugin.js): "View
// <skill> guide" on the Skills tab opens the guide for players, and only an administrator or
// higher is offered setting the level, as a choice beside the guide.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { Skill } = require("../dist/game/model/Skill");
const { PlayerRights } = require("../dist/game/model/rights/PlayerRights");
const Presets = require("../plugins/modes/pvp/Presets.PvpMode");
const SetSkillLevel = require("../plugins/interface/SetSkillLevel.plugin");

Presets.register({ persistAttribute() {}, registerCustomInterface() {}, onCanBankItem() {}, onInterfaceActionButton() {} });

let claim;
let adminsOnly = true;
const asked = [];
SetSkillLevel.register({
  onCustomEvent(name, handler) { if (name === "skills:stat-clicked") claim = handler; },
  getPluginConfig: (key, fallback) => (key === SetSkillLevel._test.ADMINS_ONLY_CONFIG ? adminsOnly : fallback),
  sendMultiChatboxPrompt(player, title, ...pairs) {
    const options = [];
    for (let i = 0; i < pairs.length; i += 2) options.push({ label: pairs[i], pick: pairs[i + 1] });
    asked.push({ player, title, options });
  },
});

function account(rights = 0, gear = []) {
  let entered = null;
  const state = { prompts: [], messages: [], levels: [], guides: 0, rights };
  return Object.assign(state, {
    getRights: () => ({ getId: () => state.rights }),
    sendMessage: (line) => state.messages.push(line),
    getPacketSender: () => ({ sendInterfaceRemoval() {}, sendEnterAmountPrompt: (title) => state.prompts.push(title) }),
    setEnteredAmountAction: (action) => { entered = action; },
    typed: (amount) => entered.execute(amount),
    hasPrompt: () => entered !== null,
    getEquipment: () => ({ getItems: () => gear }),
    getCombat: () => ({ getTarget: () => null, getAttacker: () => null }),
    getLocation: () => undefined,
    busy: () => false,
    getSkillManager: () => ({ setLevel: (skill, level) => state.levels.push([skill, level]) }),
  });
}
/** A click on a Skills tab stat, as SkillGuide offers it before opening the guide. */
function click(player, childId) {
  asked.length = 0;
  const offer = { player, childId, handled: false, openGuide: () => { player.guides++; } };
  claim(offer);
  // What SkillGuide does with an offer nobody claimed.
  if (!offer.handled) offer.openGuide();
  return offer;
}
const ATTACK = 1;
const MINING = 17;

test("a player's click opens the skill guide, for every skill: nothing asks them for a level", () => {
  assert.equal(Presets.isEnabled(), true, "on a world with presets, where anyone could set combat levels");
  for (const rights of [0, PlayerRights.MODERATOR?.getId?.() ?? 1]) {
    for (let childId = 1; childId <= 24; childId++) {
      const player = account(rights);
      const offer = click(player, childId);
      assert.equal(offer.handled, false, `stat ${childId}, rights ${rights}`);
      assert.equal(player.guides, 1, "the guide opens");
      assert.deepEqual([player.prompts, asked.length, player.hasPrompt()], [[], 0, false]);
    }
  }
});

test("an administrator, owner or developer is asked: view the guide, or set the level", () => {
  for (const rights of [PlayerRights.ADMINISTRATOR.getId(), 3, 4]) {
    const admin = account(rights);
    const offer = click(admin, ATTACK);
    assert.equal(offer.handled, true);
    assert.equal(admin.guides, 0, "nothing opens until they choose");
    assert.deepEqual(asked[0].options.map((option) => option.label), ["View Attack guide", "Set Attack level"]);
    asked[0].options[0].pick();
    assert.equal(admin.guides, 1, "the guide, on their choice");
    assert.deepEqual(admin.prompts, []);

    click(admin, MINING);
    assert.deepEqual(asked[0].options.map((option) => option.label), ["View Mining guide", "Set Mining level"]);
    asked[0].options[1].pick();
    assert.deepEqual(admin.prompts, ["Set Mining Level (1-99)"], "any skill, not only the combat ones");
    admin.typed(60);
    assert.deepEqual(admin.levels, [[Skill.MINING, 60]]);
    assert.deepEqual(admin.messages, []);
  }
});

test("worn gear and the other PvP-world checks do not stand in an administrator's way; a bad number does", () => {
  const admin = account(PlayerRights.ADMINISTRATOR.getId(), [{ getId: () => 4151 }]);
  click(admin, 9);
  asked[0].options[1].pick();
  assert.deepEqual(admin.prompts, ["Set Hitpoints Level (10-99)"]);
  admin.typed(5);
  assert.deepEqual(admin.levels, []);
  assert.deepEqual(admin.messages, ["Invalid level. Please enter a level from 10 to 99."]);
  admin.typed(99);
  assert.deepEqual(admin.levels, [[Skill.HITPOINTS, 99]]);
});

test("a prompt left open does not outlive the rank", () => {
  const admin = account(PlayerRights.ADMINISTRATOR.getId());
  click(admin, ATTACK);
  asked[0].options[1].pick();
  admin.rights = 0;
  admin.typed(99);
  assert.deepEqual(admin.levels, []);
  assert.deepEqual(admin.messages, ["Only administrators can set skill levels."]);
});

test("with the setting off it is upstream's PvP world again: a player sets a combat level with a click", () => {
  adminsOnly = false;
  try {
    const player = account(0);
    const offer = click(player, ATTACK);
    assert.equal(offer.handled, true);
    assert.deepEqual(player.prompts, ["Set Attack Level (1-99)"]);
    assert.equal(player.guides, 0);
    assert.equal(asked.length, 0);
  } finally {
    adminsOnly = true;
  }
});

test("our world has the setting on, and the guide hands a claimed click its own way to open", () => {
  const world = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/definitions/world.json"), "utf8"));
  assert.equal(world.pluginConfig[SetSkillLevel._test.ADMINS_ONLY_CONFIG], true);
  assert.equal(SetSkillLevel.config[SetSkillLevel._test.ADMINS_ONLY_CONFIG].default, false, "upstream's behaviour unless a world asks");
  const guide = fs.readFileSync(path.join(__dirname, "../plugins/interface/SkillGuide.plugin.js"), "utf8");
  assert.ok(guide.includes("openGuide: () => openGuide(event.player, guideSkill)"));
});
