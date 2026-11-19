// Run after `yarn build`, from server/: node --test tests/npc-combat-sounds.test.cjs
//
// NPCs make sounds in a fight that live sends as private synths to the player in it: a hit sound when the
// NPC is hit, an attack sound when it starts an attack, a death sound when it dies (rsprox captures,
// data/definitions/npc-combat-sounds.json from scripts/mine-npc-combat-sounds.mjs). The old NPC attack and
// death sounds went out as radius-0 area sounds, which the client drops, so nothing was heard.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { Server } = require('../dist/Server'); Server.installProductionPathResolver();
const { NpcCombatSounds } = require('../dist/game/definition/NpcCombatSounds');

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/definitions/npc-combat-sounds.json'), 'utf8')).npcs;

function player() {
  const sent = [];
  return {
    sent,
    isRegistered: () => true,
    isUnwatchedBot: () => false,
    getUsername: () => 'p',
    getPacketSender: () => ({ sendSoundEffect: (id, loops, delay) => sent.push([id, loops, delay]) }),
  };
}
const npc = (id, deathSound = -1) => ({ getCurrentDefinition: () => ({ getId: () => id, getDeathSound: () => deathSound }) });
const withKind = (kind) => Object.entries(data).find(([, v]) => v[kind]?.length)[0];

test('the data is well formed: [sound, delay] pairs of positive ids', () => {
  assert.ok(Object.keys(data).length > 100);
  for (const [id, kinds] of Object.entries(data)) {
    assert.ok(Number.isInteger(Number(id)));
    for (const [kind, list] of Object.entries(kinds)) {
      assert.ok(['hit', 'attack', 'death'].includes(kind), `${id} ${kind}`);
      for (const [sound, delay] of list) assert.ok(Number.isInteger(sound) && sound > 0 && Number.isInteger(delay) && delay >= 0);
    }
  }
});

test('a hit NPC plays its hit sound to the attacker as a private synth', () => {
  const id = withKind('hit');
  const p = player();
  NpcCombatSounds.hit(npc(Number(id)), p);
  assert.equal(p.sent.length, 1);
  assert.ok(data[id].hit.some(([sound, delay]) => sound === p.sent[0][0] && delay === p.sent[0][2]));
});

test('an attacking NPC plays its attack sound to its target', () => {
  const id = withKind('attack');
  const p = player();
  NpcCombatSounds.attack(npc(Number(id)), p);
  assert.equal(p.sent.length, 1);
  assert.ok(data[id].attack.some(([sound]) => sound === p.sent[0][0]));
});

test('a dying NPC plays its death sound to everyone who fought it; the definition\'s own wins', () => {
  const id = withKind('death');
  const a = player();
  const b = player();
  NpcCombatSounds.death(npc(Number(id)), [a, b]);
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 1);
  assert.ok(data[id].death.some(([sound]) => sound === a.sent[0][0]));
  const c = player();
  NpcCombatSounds.death(npc(Number(id), 512), [c]);
  assert.deepEqual(c.sent, [[512, 0, 0]]);
});

test('an NPC with no captured sounds, and a logged-out listener, stay silent', () => {
  const p = player();
  NpcCombatSounds.hit(npc(999999), p);
  NpcCombatSounds.attack(npc(999999), p);
  NpcCombatSounds.death(npc(999999), [p]);
  const gone = player();
  gone.isRegistered = () => false;
  NpcCombatSounds.hit(npc(Number(withKind('hit'))), gone);
  assert.deepEqual(p.sent, []);
  assert.deepEqual(gone.sent, []);
});

// ------------------------------------------------------------------ upstream issue #4745
// The recordings met only some ids of most monsters, and the table is keyed by id: the Cyclopes of the
// Warriors' Guild (12 ids, 4 recorded) were silent for most players. An NPC without a sound of its own takes
// the one recorded for an NPC of the same name playing the same animation.
const sharing = () => {
  const { CachePipeline } = require('../dist/game/cache/CachePipeline');
  const { NpcDefinitionLoader } = require('../dist/game/definition/loader/impl/NpcDefinitionLoader');
  const { NpcDefinition } = require('../dist/game/definition/NpcDefinition');
  CachePipeline.initialize();
  new NpcDefinitionLoader().load();
  return { NpcDefinition, real: (id) => ({ getCurrentDefinition: () => NpcDefinition.forId(id) }) };
};
const CYCLOPES = [2463, 2464, 2465, 2466, 2467, 2468, 2137, 2138, 2139, 2140, 2141, 2142];

test('a monster id the recordings never met sounds like its recorded namesake with the same animations', () => {
  const { NpcDefinition, real } = sharing();
  for (const id of CYCLOPES) assert.equal(NpcDefinition.forId(id).getName(), 'Cyclops', `${id}`);
  const recorded = CYCLOPES.filter((id) => data[id]?.hit?.length && data[id]?.attack?.length);
  const unrecorded = CYCLOPES.filter((id) => !data[id]);
  assert.ok(recorded.length > 0 && unrecorded.length > 0, 'some recorded, some not');
  const [hit] = data[recorded[0]].hit;
  const [attack] = data[recorded[0]].attack;
  for (const id of unrecorded) {
    const definition = NpcDefinition.forId(id);
    const source = NpcDefinition.forId(recorded[0]);
    if (definition.getAttackAnim() !== source.getAttackAnim() || definition.getDeathAnim() !== source.getDeathAnim()
      || definition.getDefenceAnim() !== source.getDefenceAnim()) continue;
    const p = player();
    NpcCombatSounds.hit(real(id), p);
    NpcCombatSounds.attack(real(id), p);
    assert.deepEqual(p.sent, [[hit[0], 0, hit[1]], [attack[0], 0, attack[1]]], `Cyclops ${id}`);
  }
  // At least one unrecorded Cyclops shares every animation, so the loop above checked something.
  assert.ok(unrecorded.some((id) => NpcDefinition.forId(id).getAttackAnim() === NpcDefinition.forId(recorded[0]).getAttackAnim()));
});

test('an id with a recorded sound keeps its own, and another name with the same animation takes nothing', () => {
  const { NpcDefinition, real } = sharing();
  const id = CYCLOPES.find((entry) => data[entry]?.hit?.length);
  const p = player();
  NpcCombatSounds.hit(real(id), p);
  assert.ok(data[id].hit.some(([sound]) => sound === p.sent[0][0]));
  // An unrecorded NPC of another name: silent, whatever it shares with a Cyclops.
  const cyclops = NpcDefinition.forId(id);
  const stranger = { getCurrentDefinition: () => ({
    getId: () => 999999, getDeathSound: () => -1, getName: () => 'Not a cyclops',
    getAttackAnim: () => cyclops.getAttackAnim(), getDeathAnim: () => cyclops.getDeathAnim(), getDefenceAnim: () => cyclops.getDefenceAnim(),
  }) };
  const q = player();
  NpcCombatSounds.hit(stranger, q);
  NpcCombatSounds.attack(stranger, q);
  NpcCombatSounds.death(stranger, [q]);
  assert.deepEqual(q.sent, []);
});

test('where recorded NPCs of one name and animation disagree, their unrecorded namesakes stay silent', (t) => {
  const { real } = sharing();
  const [first, second] = CYCLOPES.filter((id) => data[id]?.hit?.length);
  const unrecorded = CYCLOPES.find((id) => !data[id]);
  const saved = { data: NpcCombatSounds.data, shared: NpcCombatSounds.shared };
  t.after(() => Object.assign(NpcCombatSounds, saved));
  // The same two recorded ids, now with different hit sounds.
  NpcCombatSounds.data = { [first]: { hit: [[1, 0]] }, [second]: { hit: [[2, 0]] } };
  NpcCombatSounds.shared = null;
  const p = player();
  NpcCombatSounds.hit(real(unrecorded), p);
  assert.deepEqual(p.sent, []);
  // And agreeing again, it is shared.
  NpcCombatSounds.data = { [first]: { hit: [[1, 0]] }, [second]: { hit: [[1, 0]] } };
  NpcCombatSounds.shared = null;
  NpcCombatSounds.hit(real(unrecorded), p);
  assert.deepEqual(p.sent, [[1, 0, 0]]);
});

test("an NPC's melee swing sends no sound of its own: its attack sound is the recorded one, to its target", (t) => {
  sharing();
  const { PluginManager } = require('../dist/plugins/PluginManager');
  const { MeleeCombatMethod } = require('../dist/game/content/combat/method/impl/MeleeCombatMethod');
  const core = PluginManager.getCoreApi();
  const cyclops = new core.NPC(CYCLOPES[0], new core.Location(2847, 3541, 2));
  assert.equal(cyclops.getAttackSound(), null);
  const area = t.mock.method(core.Sounds, 'playAreaSound', () => {});
  cyclops.performAnimation = () => {};
  new MeleeCombatMethod().start(cyclops, {});
  assert.equal(area.mock.callCount(), 0, 'no area sound (it was one of range 0, which the client drops)');
});
