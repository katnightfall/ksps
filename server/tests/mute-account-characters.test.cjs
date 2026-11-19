// Ours. Run after `yarn build`: node --test tests/mute-account-characters.test.cjs
// An account has several characters (the character picker makes more), and a ban of the account's main character
// (its primary) holds on every one of them at login. A mute was only ever looked up under the name of the character
// speaking: muted on their main, a player went on chatting with another character of the same account, or made a
// new one in the picker for it. A mute of the primary now holds on each of the account's characters, in public
// chat, private messages, friends, clan and Group Ironman chat (which share one check) and ::yell, as a ban does.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { beforeEach, afterEach, test } = require("node:test");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mutes-"));
process.env.TSPS_ACCOUNTS_FILE = path.join(scratch, "accounts.json");
process.env.TSPS_DISPLAY_NAMES_FILE = path.join(scratch, "display-names.json");
require("../dist/Server").Server.installProductionPathResolver();
const { Accounts } = require("../dist/game/entity/impl/player/Accounts");
const { PlayerPunishment } = require("../dist/util/PlayerPunishment");
const { PlayerRights } = require("../dist/game/model/rights/PlayerRights");
const { Misc } = require("../dist/util/Misc");
const { ChatPacketListener } = require("../dist/net/packet/impl/ChatPacketListener");
const { FriendsChatManager } = require("../plugins/interface/FriendsChatManager");
const PlayerCommands = require("../plugins/commands/PlayerCommands.plugin");

/** ::yell's handler, registered through a stand-in for the plugin api. */
const commands = new Map();
const noop = () => undefined;
PlayerCommands.register(new Proxy({
  core: { PlayerRights },
  getPlayerPunishment: () => PlayerPunishment,
  registerCommand: (name, handler) => commands.set(name, handler),
}, { get: (api, key) => (key in api ? api[key] : noop) }));

/** A speaker: what the chat checks read of a player, and what they were told. */
function speaker(name) {
  const messages = [];
  return {
    messages,
    getUsername: () => name,
    getHostAddress: () => "203.0.113.20",
    isStaff: () => true,
    isDonator: () => false,
    sendMessage: (text) => messages.push(text),
    getPacketSender: () => ({ sendMessage: (text) => { messages.push(text); } }),
  };
}

let mutedBefore;
beforeEach(() => {
  Accounts.reset();
  fs.rmSync(process.env.TSPS_ACCOUNTS_FILE, { force: true });
  Accounts.ensure("Bobmain");
  Accounts.addCharacter(Accounts.accountOf("Bobmain"), "Bobalt");
  Accounts.ensure("Carol");
  mutedBefore = [...PlayerPunishment.AccountsMuted];
});
afterEach(() => { PlayerPunishment.AccountsMuted = mutedBefore; });

// The mute as ::mute writes it (PlayerPunishment.mute also writes the list's file).
const mute = (name) => PlayerPunishment.AccountsMuted.push(Misc.formatPlayerName(name.toLowerCase()));

test("a mute of the account's main character holds on its other characters, in every chat", () => {
  mute("Bobmain");
  for (const name of ["Bobmain", "Bobalt"]) {
    const publicChat = speaker(name);
    ChatPacketListener.handleText(publicChat, "hello");
    assert.deepEqual(publicChat.messages, ["You are muted and cannot chat."], `${name}: public chat`);

    const social = speaker(name);
    assert.equal(FriendsChatManager.allowChat(social, "hello"), false, `${name}: private, friends and clan chat`);
    assert.deepEqual(social.messages, ["You are muted and cannot chat."]);

    const yeller = speaker(name);
    commands.get("yell")({ player: yeller, raw: "yell hello", parts: ["yell", "hello"] });
    assert.deepEqual(yeller.messages, ["You are muted and cannot yell."], `${name}: ::yell`);
  }
});

test("a mute of one other character is that character's, and nobody else is muted", () => {
  mute("Bobalt");
  assert.equal(FriendsChatManager.allowChat(speaker("Bobalt"), "hello"), false);
  assert.equal(FriendsChatManager.allowChat(speaker("Bobmain"), "hello"), true, "as a ban of another character is");
  assert.equal(FriendsChatManager.allowChat(speaker("Carol"), "hello"), true);
  assert.equal(PlayerPunishment.muted("Bobmain"), false, "::unmute and the mute list are unchanged: the mute is Bobalt's");
});

test("a name with no account, and an account file that cannot be read, still go by the name", (t) => {
  mute("Nobody");
  assert.equal(FriendsChatManager.allowChat(speaker("Nobody"), "hello"), false);
  assert.equal(FriendsChatManager.allowChat(speaker("Someone"), "hello"), true);
  t.mock.method(Accounts, "accountOf", () => { throw new Error("the accounts file cannot be read (expected by this test)"); });
  assert.equal(FriendsChatManager.allowChat(speaker("Nobody"), "hello"), false);
  assert.equal(FriendsChatManager.allowChat(speaker("Bobalt"), "hello"), true);
});
