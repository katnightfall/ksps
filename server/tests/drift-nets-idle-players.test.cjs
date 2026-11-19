// node --test tests/drift-nets-idle-players.test.cjs
//
// The drift nets' tick looks at every player online for a net that is due a passive catch. It
// used to make a drift net record for each of them on the way (every bot of the crowd, every
// tick); a player who never set a net is now only looked at. A net that is due still catches.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { H } = require("../plugins/skills/hunter/Context.Hunter");
const DriftNets = require("../plugins/skills/hunter/DriftNets.Hunter");

function player(attributes = new Map()) {
  const sets = [];
  const xp = [];
  return {
    sets, xp, attributes,
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => { sets.push(key); attributes.set(key, value); },
    getSkillManager: () => ({ addExperiences: (skill, amount) => xp.push([skill, amount]), getMaxLevel: () => 50 }),
    getPacketSender: () => ({ sendVarbit() {} }),
    sendMessage() {},
  };
}

test("the drift nets' tick makes no record for a player with no net, and still fills a net that is due", (t) => {
  const kept = { core: H.core, players: H.players, tick: H.tick };
  t.after(() => Object.assign(H, kept));
  H.core = { Skill: { FISHING: "fishing", HUNTER: "hunter" } };
  H.tick = 1;

  const idle = player();
  const netted = player(new Map([[DriftNets.ATTRIBUTE, { nets: { 31433: { count: 2, last: Date.now() - 61_000 } }, stored: 0, until: -1 }]]));
  const fresh = player(new Map([[DriftNets.ATTRIBUTE, { nets: { 31433: { count: 2, last: Date.now() } }, stored: 0, until: -1 }]]));
  H.players = new Set([idle, netted, fresh]);

  DriftNets.process();

  assert.deepEqual(idle.sets, [], "no drift net record is made for a player who has none");
  assert.equal(idle.attributes.size, 0);
  assert.equal(netted.attributes.get(DriftNets.ATTRIBUTE).nets[31433].count, 3, "a net due its catch gets it");
  assert.equal(netted.xp.length, 1, "with the Fishing experience");
  assert.equal(fresh.attributes.get(DriftNets.ATTRIBUTE).nets[31433].count, 2, "a net not yet due is left");
});
