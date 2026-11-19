// Run after `yarn build`: node --test tests/insect-net-wield.test.cjs
//
// The insect net has no level to wield (Wiki: Insect net, whose infobox lists none; Swarm of wasps and Wasp sting: the
// wasps are caught "with level 1 Hunter ... and an insect net"). item-gameplay.json, an old export, gave it 15 Hunter,
// which went unread while the row still said "Butterfly net" and came back with the 11 November cache's rename.
const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const H = require("./between-a-rock-harness.cjs");

let core;
before(async () => { core = await H.boot(); });
after(H.shutdown);

test("a player with level 1 Hunter wields an insect net", async (t) => {
  const f = H.actor(t, { at: [3316, 3377, 0], items: [core.ItemIdentifiers.INSECT_NET] });
  assert.equal(f.player.getSkillManager().getCurrentLevel(core.Skill.HUNTER), 1, "control: Hunter 1");
  await H.itemOption(f, core.ItemIdentifiers.INSECT_NET, "Wield");
  H.ticks(f, 2);
  assert.equal(f.player.getEquipment().get(core.Equipment.WEAPON_SLOT).getId(), core.ItemIdentifiers.INSECT_NET);
  assert.equal(f.messages.some((message) => /to wear this/.test(message.text)), false);
});
