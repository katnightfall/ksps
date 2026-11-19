// Run after `yarn build`: node --test tests/protocol-name-cache-bound.test.cjs
// Misc.formatNameForProtocol remembers its answers (8,192 of them) to spare the name searches their garbage. It
// is also given whatever name a client types: a login's username is formatted before its length is checked, and
// one can be as long as a message, 64 KB. Remembered, 8,192 such names and their formatted copies are about a
// gigabyte held by a client that never logged in. Only names a player can have are remembered now.
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.TSPS_ACCOUNTS_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'accounts-')), 'accounts.json');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { Misc } = require('../dist/util/Misc');
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const net = require('../dist/net/NetworkBuilder');

test('a real name is still remembered, and formatted as before', () => {
  assert.equal(Misc.formatNameForProtocol('Mod Kat'), 'mod_kat');
  assert.equal(Misc.protocolNames.get('Mod Kat'), 'mod_kat');
  assert.equal(Misc.formatNameForProtocol('Mod Kat'), 'mod_kat');
});

test('a name longer than any player\'s is formatted but not kept', () => {
  const long = 'A b'.repeat(20000);
  assert.equal(Misc.formatNameForProtocol(long), 'a_b'.repeat(20000));
  assert.equal(Misc.protocolNames.has(long), false);
});

test('a login with a 60,000-character username leaves nothing behind', async () => {
  CachePipeline.getActive = () => ({ revision: 435 });
  const sent = [];
  const channel = {
    kind: 'test', remoteAddress: '203.0.113.9', data: null, isOpen: () => true,
    send(packet) { sent.push(Buffer.from(packet)); return true; }, close() {},
    onData(callback) { this.data = callback; }, onError() {}, onClose() {},
  };
  const connection = new net.ClientConnection(channel);
  const username = 'x'.repeat(60000);
  // LOGIN (opcode 204, two length bytes): username, password, revision, flags.
  const body = Buffer.concat([Buffer.from(username, 'latin1'), Buffer.from([0]), Buffer.from('pw\0', 'latin1'), Buffer.from([0, 0, 1, 179, 0])]);
  channel.data(Buffer.concat([Buffer.from([204, body.length >>> 8, body.length & 255]), body]));
  await connection.idle();
  assert.ok(sent.some((packet) => packet[0] === 3), 'the login was answered (refused)');
  const kept = [...Misc.protocolNames.keys()].filter((name) => name.length > 1000);
  assert.deepEqual(kept.map((name) => name.length), [], 'no long name is held');
});
