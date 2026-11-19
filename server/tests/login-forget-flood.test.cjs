// Run after `yarn build`: node --test tests/login-forget-flood.test.cjs
// "Forget this login" is sent by the client once, on a socket of its own, before any login. The server read the
// named account's whole save for every such packet, and a 64 KB message holds about 4,000 of them: one message
// from a client that never logged in held the server for over a second with the smallest save there is (measured:
// 4,096 packets, 1,047 ms), in which no tick ran. Now a connection's first forget is answered and the rest are
// not. Real ClientConnection, the real frame decoder.
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.TSPS_ACCOUNTS_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'accounts-')), 'accounts.json');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { GameConstants } = require('../dist/game/GameConstants');
const net = require('../dist/net/NetworkBuilder');
const tokens = require('../dist/net/login/LoginTokens');

function stubChannel() {
  return {
    kind: 'test', remoteAddress: '203.0.113.9', data: null, closes: [],
    isOpen: () => true, send: () => true, close(code, reason) { this.closes.push({ code, reason }); },
    onData(callback) { this.data = callback; }, onError() {}, onClose() {},
  };
}

/** The LOGIN_FORGET packet as the client writes it: opcode 207, a length byte, two strings. */
function forgetPacket(username, token) {
  const body = Buffer.concat([Buffer.from(username, 'latin1'), Buffer.from([0]), Buffer.from(token, 'latin1'), Buffer.from([0])]);
  return Buffer.concat([Buffer.from([207, body.length]), body]);
}

function withStore(t, save) {
  const loads = [];
  const updates = [];
  const original = GameConstants.PLAYER_PERSISTENCE;
  GameConstants.PLAYER_PERSISTENCE = {
    load: (name) => { loads.push(name); return save; },
    updateOffline: async (name, update) => { updates.push(name); update(save); return true; },
  };
  t.after(() => { GameConstants.PLAYER_PERSISTENCE = original; });
  return { loads, updates };
}

test('a message full of forget packets reads the account\'s save once, not once a packet', async (t) => {
  const { loads } = withStore(t, { attributes: {} });
  const channel = stubChannel();
  const connection = new net.ClientConnection(channel);
  const frame = Buffer.concat(Array.from({ length: 500 }, () => forgetPacket('Floodvictim', 'x')));
  channel.data(frame);
  await connection.idle();
  assert.equal(loads.length, 1, `the save was read ${loads.length} times`);
  assert.deepEqual(channel.closes, [], 'the connection is left open: nothing a real client does is refused');
});

test('the forget a client really sends, one on its own socket, still drops its token', async (t) => {
  const issued = tokens.issueLoginToken([], Date.now());
  const save = { attributes: { [tokens.LOGIN_TOKENS_ATTRIBUTE]: issued.entries } };
  const { updates } = withStore(t, save);
  const channel = stubChannel();
  const connection = new net.ClientConnection(channel);
  channel.data(forgetPacket('Tokenowner', issued.token));
  await connection.idle();
  assert.equal(updates.length, 1);
  assert.deepEqual(save.attributes[tokens.LOGIN_TOKENS_ATTRIBUTE], [], 'the token is gone');
});
