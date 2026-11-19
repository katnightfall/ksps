// Run after `yarn build`: node --test tests/login-wrong-password-lockout.test.cjs
// A login holds its account's name from its first check until its password has been checked, so that two logins
// of one account cannot both get in. While it was held, any other login of the account was refused with "Your
// account is already logged in": so anybody, with nothing but the name, kept an account's owner out by guessing
// passwords one after another (measured: 200 guesses in one 4.7 KB message took 10.7 s, and each of the owner's
// 105 tries in that time was refused). Now a login waits its turn behind the one being checked, and the right
// password gets in. Real ClientConnection, the real login decoder, real password hashing.
const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');

process.env.TSPS_ACCOUNTS_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'accounts-')), 'accounts.json');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { GameConstants } = require('../dist/game/GameConstants');
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PasswordUtil } = require('../dist/util/PasswordUtil');
const net = require('../dist/net/NetworkBuilder');

const REVISION = 435;
CachePipeline.getActive = () => ({ revision: REVISION });

function stubChannel() {
  const sent = [];
  return {
    sent, kind: 'test', remoteAddress: '203.0.113.9', data: null, closed: null,
    isOpen: () => true, send(packet) { sent.push(Buffer.from(packet)); return true; }, close() {},
    onData(callback) { this.data = callback; }, onError() {}, onClose(callback) { this.closed = callback; },
  };
}

/** LOGIN (opcode 204, two length bytes) as the client writes it: username, password, revision, flags. */
function loginPacket(username, password) {
  const revision = Buffer.alloc(4);
  revision.writeInt32BE(REVISION);
  const body = Buffer.concat([Buffer.from(`${username}\0${password}\0`, 'latin1'), revision, Buffer.from([0])]);
  return Buffer.concat([Buffer.from([204, body.length >>> 8, body.length & 255]), body]);
}

/** The LOGIN_RESPONSE packets a connection was sent: { ok, code }. */
const answers = (channel) => channel.sent.filter((packet) => packet[0] === 3)
  .map((packet) => ({ ok: packet.subarray(2)[0] === 1, code: packet.subarray(2).readInt32BE(1) }));

let checks;
beforeEach(async () => {
  net.ClientConnection.pendingNames.clear();
  const hash = await PasswordUtil.generatePasswordHashWithSalt('the-real-password');
  const save = { attributes: {}, getPasswordHashWithSalt: () => hash, applyToPlayer() {} };
  checks = 0;
  GameConstants.PLAYER_PERSISTENCE = {
    load: () => save, exists: () => true, save() {}, flush: async () => {},
    checkPassword: (password, stored) => { checks++; return PasswordUtil.passwordsMatch(password, stored.getPasswordHashWithSalt()); },
    encryptPassword: (password) => PasswordUtil.generatePasswordHashWithSalt(password),
    updateOffline: async () => true,
  };
});

test('the owner gets in while somebody else is guessing the account\'s password', async () => {
  const guesser = stubChannel();
  const guessing = new net.ClientConnection(guesser);
  guesser.data(Buffer.concat(Array.from({ length: 6 }, (_, i) => loginPacket('Victim', `guess${i}`))));

  const owner = stubChannel();
  const owning = new net.ClientConnection(owner);
  owner.data(loginPacket('Victim', 'the-real-password'));

  await Promise.all([guessing.idle(), owning.idle()]);
  assert.deepEqual(answers(owner), [{ ok: true, code: -1 }], 'the right password is let in');
  assert.equal(answers(guesser).length, 6, 'every guess was answered');
  assert.equal(answers(guesser).some((answer) => answer.ok), false, 'and none of them got in');
});

test('two logins of one account at once: one gets in, the other is told it is logged in', async () => {
  const first = stubChannel();
  const second = stubChannel();
  const connections = [new net.ClientConnection(first), new net.ClientConnection(second)];
  first.data(loginPacket('Victim', 'the-real-password'));
  second.data(loginPacket('victim', 'the-real-password'));
  await Promise.all(connections.map((connection) => connection.idle()));
  assert.deepEqual(answers(first), [{ ok: true, code: -1 }]);
  assert.deepEqual(answers(second), [{ ok: false, code: 5 }], 'as before: "Your account is already logged in."');
  assert.equal(checks, 1, 'the second was refused without its password being checked');
});

test('a login whose connection closed while it waited is not checked at all', async () => {
  const first = stubChannel();
  const waiting = stubChannel();
  const connections = [new net.ClientConnection(first), new net.ClientConnection(waiting)];
  first.data(loginPacket('Victim', 'wrong'));
  waiting.data(loginPacket('Victim', 'also-wrong'));
  waiting.closed();
  await Promise.all(connections.map((connection) => connection.idle()));
  assert.equal(checks, 1);
  assert.deepEqual(answers(waiting), []);
});

test('a login whose check never returns stops holding the account once its connection closes', async () => {
  const stuck = stubChannel();
  const stuckConnection = new net.ClientConnection(stuck);
  const check = GameConstants.PLAYER_PERSISTENCE.checkPassword;
  let hang = true;
  GameConstants.PLAYER_PERSISTENCE.checkPassword = (password, stored) => {
    if (!hang) return check(password, stored);
    hang = false;
    return new Promise(() => {});
  };
  stuck.data(loginPacket('Victim', 'whatever'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  stuck.closed();

  const owner = stubChannel();
  const owning = new net.ClientConnection(owner);
  owner.data(loginPacket('Victim', 'the-real-password'));
  await owning.idle();
  assert.deepEqual(answers(owner), [{ ok: true, code: -1 }]);
  assert.ok(stuckConnection);
});
