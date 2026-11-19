import { strict as assert } from "node:assert";

import { decodeClientPacket } from "../../server/src/main/typescript/elvarg/net/protocol/ClientProtocol";
import { ClientScriptLoader } from "../game/cs2/ClientScriptLoader";
import { state } from "../network/serverConnection/state";
import { setPacketSocket } from "../network/packet";
import { CacheSystem } from "../rs/cache/CacheSystem";
import { Cs2Vm } from "../rs/cs2/Cs2Vm";
import { loadCache, loadCacheInfos, loadCacheList } from "../scripts/cache/load-util";

// Upstream issue #5203 ("Private, Channel, Clan and Group chat show nothing"), the part that is
// not RuneLite's alone: nothing a Group Ironman typed to their group was ever sent.
//
// The cache's chat_send (script 5517) sends a group line through CHAT_SENDCLAN as chat type 3 on
// clan type 1, after putting a capital on it and the "|" that marks a group line in front. The
// server has taken clan type 1 since Group Ironman was added (Chat.GroupIronman.js), but this
// client's CHAT_SENDCLAN still only knew the player's own clan and the guest clan and dropped it.

let sentPacket: Uint8Array | undefined;
(globalThis as any).WebSocket = { OPEN: 1 };
state.socket = { readyState: 1, send: (packet: Uint8Array) => { sentPacket = packet; } } as any;

const cacheInfo = loadCacheList(loadCacheInfos()).latest;
const cache = CacheSystem.fromFiles(cacheInfo, loadCache(cacheInfo).files);
const scripts = new ClientScriptLoader({ getCacheSystem: () => cache });
const cleared: string[] = [];
const vm = new Cs2Vm({
    loadScript: (id: number) => scripts.load(id),
    varManager: {
        getVarbit: () => 0, getVarcInt: () => 0, setVarcInt() {},
        setVarcString: (id: number, value: string) => { if (id === 335) cleared.push(value); },
    },
    widgetManager: { beginBatch() {}, endBatch() {}, flushBatch() {} },
} as any);
const chatSend = scripts.load(5517);
assert.ok(chatSend, "the cache has chat_send");

/** chat_send(chat type, clan type, 0, -1)(text), and what reached the server. */
const send = (chatType: number, clanType: number, text: string) => {
    sentPacket = undefined;
    cleared.length = 0;
    vm.execute(chatSend, [chatType, clanType, 0, -1], [text]);
    return sentPacket ? decodeClientPacket(Buffer.from(sentPacket)) : undefined;
};

try {
    // The group's line: clan type 1, with the script's own bar and capital.
    assert.deepEqual(send(3, 1, "hello group"), { type: "clan_chat", text: "|Hello group", clanType: 1 });
    assert.deepEqual(cleared, [""], "the chat input is emptied, as after any line that was sent");

    // The player's own clan and the guest clan are sent as they were.
    assert.deepEqual(send(3, 0, "hello clan"), { type: "clan_chat", text: "hello clan", clanType: 0 });
    assert.deepEqual(send(4, 0, "hello guest"), { type: "clan_chat", text: "hello guest", clanType: -1 });

    // A clan type the server has nothing for (2 is a PvP Arena group) still goes nowhere, and a
    // group line with nothing in it is not sent (the script stops at an empty line; "|" alone is
    // what the bar leaves of one made of spaces).
    assert.equal(send(3, 2, "hello arena"), undefined);
    assert.deepEqual(cleared, [], "a line that was not sent stays in the input");
} finally {
    setPacketSocket(null);
    state.socket = null;
}

console.log("group chat send: a Group Ironman's line reaches the server on clan type 1");
