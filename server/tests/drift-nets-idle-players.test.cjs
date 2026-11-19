// node --test tests/drift-nets-idle-players.test.cjs
//
// The drift nets' tick looks for a net that is due a passive catch. It used to look at every
// player online for one (every bot of the crowd, every tick), and to make a drift net record for
// each of them on the way; it now looks only at the players who have set a net. A net that is
// due still catches, and a player who logs out leaves the list.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { H } = require("../plugins/skills/hunter/Context.Hunter");
const DriftNets = require("../plugins/skills/hunter/DriftNets.Hunter");

function player(attributes = new Map()) {
  const sets = [];
  const xp = [];
  const asked = { count: 0 };
  return {
    sets, xp, attributes, asked,
    getAttribute: (key) => { asked.count++; return attributes.get(key); },
    setAttribute: (key, value) => { sets.push(key); attributes.set(key, value); },
    getLocation: () => ({ getX: () => 3222, getY: () => 3218, getZ: () => 0 }),
    getSkillManager: () => ({ addExperiences: (skill, amount) => xp.push([skill, amount]), getMaxLevel: () => 50 }),
    getPacketSender: () => ({ sendVarbit() {} }),
    sendMessage() {},
  };
}

test("the drift nets' tick looks only at players who have set a net, and still fills a net that is due", (t) => {
  const kept = { core: H.core, players: H.players, tick: H.tick };
  t.after(() => { Object.assign(H, kept); DriftNets.holders?.clear(); });
  H.core = { Skill: { FISHING: "fishing", HUNTER: "hunter" } };
  H.tick = 1;
  DriftNets.holders?.clear();

  const idle = player();
  const netted = player(new Map([[DriftNets.ATTRIBUTE, { nets: { 31433: { count: 2, last: Date.now() - 61_000 } }, stored: 0, until: -1 }]]));
  const fresh = player(new Map([[DriftNets.ATTRIBUTE, { nets: { 31433: { count: 2, last: Date.now() } }, stored: 0, until: -1 }]]));
  H.players = new Set([idle, netted, fresh]);
  for (const p of H.players) DriftNets.login({ player: p });

  for (const p of H.players) { p.sets.length = 0; p.asked.count = 0; }
  DriftNets.process();

  assert.equal(idle.asked.count, 0, "the tick asks nothing of a player who has set no net");
  assert.deepEqual(idle.sets, [], "and makes no drift net record for them");
  assert.equal(netted.attributes.get(DriftNets.ATTRIBUTE).nets[31433].count, 3, "a net due its catch gets it");
  assert.equal(netted.xp.length, 1, "with the Fishing experience");
  assert.equal(fresh.attributes.get(DriftNets.ATTRIBUTE).nets[31433].count, 2, "a net not yet due is left");

  // Logging out takes a player off the Hunter set; the tick lets them go and catches nothing more.
  netted.attributes.get(DriftNets.ATTRIBUTE).nets[31433].last = Date.now() - 61_000;
  H.players.delete(netted);
  DriftNets.process();
  assert.equal(netted.attributes.get(DriftNets.ATTRIBUTE).nets[31433].count, 3, "no catch for a player who has logged out");
  assert.equal(DriftNets.holders.has(netted), false, "and they leave the list");
  assert.equal(DriftNets.holders.has(fresh), true, "a player still online with a net stays on it");
});
