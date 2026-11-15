import { strict as assert } from "node:assert";
import type { Client } from "@runelite/api/Client";
import { WorldPoint } from "@runelite/api/coords/WorldPoint";
import { GameState } from "@runelite/api/GameState";
import { ConfigChanged, GameStateChanged, NpcSpawned } from "@runelite/api/events";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { inject } from "@runelite/client/plugins/PluginInjector";
import { AGGRESSIVE_TIME_MS, AggroAreaTracker, isInWilderness, timerText } from "../game/plugins/npcaggroarea/aggroArea";
import { NpcAggroAreaConfig } from "../game/plugins/npcaggroarea/NpcAggroAreaConfig";
import { NpcAggroAreaPlugin } from "../game/plugins/npcaggroarea/NpcAggroAreaPlugin";

// --- Config: RuneLite's group, keys and defaults -------------------------------------------------
assert.equal(NpcAggroAreaConfig.group, "npcUnaggroArea");
assert.equal(NpcAggroAreaConfig.items.alwaysActive.keyName, "npcUnaggroAlwaysActive");
assert.equal(NpcAggroAreaConfig.items.npcNamePatterns.keyName, "npcUnaggroNames");
assert.equal(NpcAggroAreaConfig.items.showTimer.default, true);
assert.equal(NpcAggroAreaConfig.items.showAreaLines.default, false);
assert.equal(NpcAggroAreaPlugin.descriptor.name, "NPC Aggression Timer");
assert.equal(NpcAggroAreaPlugin.descriptor.enabledByDefault, false, "off by default, as RuneLite");

// --- The tracker: RuneLite's onGameTick -----------------------------------------------------------
const at = (x: number, y: number, plane = 0) => new WorldPoint(x, y, plane);
{
    const t = new AggroAreaTracker();
    // Walking around before anything is known calibrates nothing.
    t.tick(at(3200, 3200), 0);
    t.tick(at(3215, 3200), 1000);
    assert.deepEqual(t.safeCenters, [null, null]);
    assert.equal(t.endTime, null);
    // A teleport (over 40 tiles in a tick) gives the newer tile and starts the ten minutes.
    assert.equal(t.tick(at(3000, 3000), 2000), true);
    assert.deepEqual(t.safeCenters, [null, at(3000, 3000)]);
    assert.equal(t.endTime, 2000 + AGGRESSIVE_TIME_MS);
    // Inside its 21x21 square nothing changes.
    assert.equal(t.tick(at(3010, 2990), 3000), false);
    assert.equal(t.endTime, 2000 + AGGRESSIVE_TIME_MS);
    // 11 tiles out: the older tile is dropped, the new one is here, the timer restarts.
    assert.equal(t.tick(at(3011, 2990), 4000), true);
    assert.deepEqual(t.safeCenters, [at(3000, 3000), at(3011, 2990)]);
    assert.equal(t.endTime, 4000 + AGGRESSIVE_TIME_MS);
    // Back inside the older square: still safe.
    assert.equal(t.tick(at(2990, 3000), 5000), false);
    // Out of both.
    t.tick(at(2979, 3000), 6000);
    assert.deepEqual(t.safeCenters, [at(3011, 2990), at(2979, 3000)]);
    // The squares, as boxes of tiles on the plane.
    assert.deepEqual(t.boxes(0), [
        { minX: 3001, maxX: 3021, minY: 2980, maxY: 3000, z: 0 },
        { minX: 2969, maxX: 2989, minY: 2990, maxY: 3010, z: 0 },
    ]);
    assert.deepEqual(t.boxes(1), []);
    // Another floor is outside both squares (the server's regions belong to one plane).
    t.tick(at(2979, 3000, 1), 7000);
    assert.deepEqual(t.safeCenters, [at(2979, 3000), at(2979, 3000, 1)]);
    assert.equal(t.endTime, 7000 + AGGRESSIVE_TIME_MS);
    // The expiry is reported once.
    assert.equal(t.takeExpiry(7000 + AGGRESSIVE_TIME_MS), false);
    assert.equal(t.takeExpiry(7001 + AGGRESSIVE_TIME_MS), true);
    assert.equal(t.takeExpiry(7002 + AGGRESSIVE_TIME_MS), false);
}
{
    // Going back into the unknown older area before the second tile is found: uncalibrated again.
    const t = new AggroAreaTracker();
    t.tick(at(3200, 3200), 0);
    t.tick(at(3300, 3300), 1000);
    assert.deepEqual(t.safeCenters, [null, at(3300, 3300)]);
    t.tick(at(3215, 3200), 2000);
    assert.deepEqual(t.safeCenters, [null, null]);
    assert.equal(t.endTime, null);
}
{
    // A logout keeps the area; a login on the same tile carries on, anywhere else starts over.
    const t = new AggroAreaTracker();
    t.tick(at(3200, 3200), 0);
    t.tick(at(3300, 3300), 0);
    t.tick(at(3311, 3300), 1000);
    const saved = t.save(61_000)!;
    assert.deepEqual(saved, { center1: "3300,3300,0", center2: "3311,3300,0", location: "3311,3300,0", duration: AGGRESSIVE_TIME_MS - 60_000 });
    const same = new AggroAreaTracker();
    same.login(saved, at(3311, 3300), 500_000);
    assert.deepEqual(same.safeCenters, [at(3300, 3300), at(3311, 3300)]);
    assert.equal(same.endTime, 500_000 + AGGRESSIVE_TIME_MS - 60_000);
    const moved = new AggroAreaTracker();
    moved.login(saved, at(3312, 3300), 500_000);
    assert.deepEqual(moved.safeCenters, [null, null]);
    assert.equal(moved.endTime, null);
    assert.equal(new AggroAreaTracker().save(0), null, "nothing to keep while uncalibrated");
}
assert.equal(timerText(AGGRESSIVE_TIME_MS), "10:00");
assert.equal(timerText(59_999), "0:59");
assert.equal(isInWilderness(at(3100, 3600)), true);
assert.equal(isInWilderness(at(3200, 3200)), false);

// --- The plugin ------------------------------------------------------------------------------------
type FakeNpc = { index: number; name: string; level: number; x: number; y: number };
let npcs: FakeNpc[] = [];
let playerAt = at(3200, 3200);
let combatLevel = 20;
let gameState = GameState.LOGGED_IN;
const npc = (n: FakeNpc) => ({
    getIndex: () => n.index,
    getComposition: () => ({ getName: () => n.name, getActions: () => ["Attack"], getCombatLevel: () => n.level }),
    getWorldLocation: () => at(n.x, n.y),
});
const client = {
    getGameState: () => gameState,
    getLocalPlayer: () => ({ getName: () => "Kat", getCombatLevel: () => combatLevel, getWorldLocation: () => playerAt }),
    getNpcs: () => npcs.map(npc),
    getNpcByIndex: (index: number) => { const found = npcs.find((n) => n.index === index); return found ? npc(found) : null; },
} as unknown as Client;
const osrsClient: any = { sceneGeometry: { tileHeight: () => 0, worldToScreen: (x: number, h: number, y: number) => [x, y + h] } };
const config = inject(ConfigManager);
const sent: string[] = [];
const set = (key: keyof typeof NpcAggroAreaConfig.items, value: string | number | boolean) => {
    config.setConfigValue(NpcAggroAreaConfig, key as string, value);
    plugin.onConfigChanged(new ConfigChanged(NpcAggroAreaConfig.group, NpcAggroAreaConfig.items[key].keyName ?? (key as string), undefined, String(value)));
};
const plugin = new NpcAggroAreaPlugin(osrsClient, { client, configManager: config, notifier: { notify: (m) => sent.push(m) } });
let clock = 0;
plugin.now = () => clock;

(async () => {
    await plugin.start();
    const [lines, infobox] = plugin.widgetOverlays() as any[];
    assert.equal(lines.drawBelowWidgets, true, "RuneLite's ABOVE_SCENE layer");

    // Nothing named, not always active: inactive. The "?" box shows until calibrated, as RuneLite's does.
    assert.equal(plugin.isActive(), false);
    plugin.onGameTick();
    assert.deepEqual(infobox.entries(), [["?", 0xffffff]]);

    // A named NPC makes it active; one the player is over double the level of does not, outside the Wilderness.
    npcs = [{ index: 1, name: "Rock Crab", level: 13, x: 3201, y: 3201 }];
    set("npcNamePatterns", "rock crab, sand*");
    assert.equal(plugin.isActive(), true);
    combatLevel = 27;
    set("npcNamePatterns", "rock crab");
    assert.equal(plugin.isActive(), false, "27 is more than double 13");
    npcs = [{ index: 2, name: "Sand Crab", level: 15, x: 3201, y: 3201 }];
    set("npcNamePatterns", "sand*");
    assert.equal(plugin.isActive(), true, "wildcards, any case");
    set("npcNamePatterns", "");
    assert.equal(plugin.isActive(), false);
    // An NPC that comes into view later switches it on.
    set("npcNamePatterns", "ammonite crab");
    npcs = [{ index: 3, name: "Ammonite Crab", level: 25, x: 3202, y: 3202 }];
    plugin.onNpcSpawned(new NpcSpawned({ ecsId: 9, index: 3, id: 7799 }));
    assert.equal(plugin.isActive(), true);

    // Teleport, then walk out of the square: both tiles known, timer running, lines drawn.
    playerAt = at(3700, 3800);
    clock = 1000;
    plugin.onGameTick();
    assert.deepEqual(infobox.entries(), [["10:00", 0xffffff]], "the newer tile is known: the ? box goes, as RuneLite's does");
    playerAt = at(3711, 3800);
    clock = 2000;
    plugin.onGameTick();
    assert.deepEqual(infobox.entries(), [["10:00", 0xffffff]]);
    assert.equal(lines.signature(), "", "area lines are off by default");
    set("showAreaLines", true);
    const drawn = JSON.parse(lines.signature());
    assert.ok(drawn.length > 0);
    assert.deepEqual(drawn[0][1], [1, 1, 0, 0x64 / 255], "the aggressive colour while the timer runs");

    // The last minute is red; at the end the box goes, the lines change colour and the notification is sent once.
    clock = 2000 + AGGRESSIVE_TIME_MS - 30_000;
    assert.deepEqual(infobox.entries(), [["0:30", 0xff0000]]);
    set("notifyExpire", true);
    clock = 2001 + AGGRESSIVE_TIME_MS;
    plugin.onGameTick();
    plugin.onGameTick();
    assert.deepEqual(sent, ["NPC aggression has expired!"]);
    assert.deepEqual(infobox.entries(), []);
    assert.deepEqual(JSON.parse(lines.signature())[0][1], [1, 1, 0, 1], "the unaggressive colour");
    set("showTimer", false);
    clock = 3000;
    assert.deepEqual(infobox.entries(), [], "the timer can be hidden");
    set("showTimer", true);

    // Always active needs no names.
    set("npcNamePatterns", "");
    assert.equal(plugin.isActive(), false);
    set("alwaysActive", true);
    assert.equal(plugin.isActive(), true);

    // Logging out saves the area under the account; logging in on the same tile takes it up again.
    playerAt = at(3722, 3800);
    clock = 10_000;
    plugin.onGameTick();
    gameState = GameState.LOGIN_SCREEN;
    plugin.onGameStateChanged(new GameStateChanged(GameState.LOGIN_SCREEN));
    assert.deepEqual(plugin.tracker.safeCenters, [null, null]);
    assert.ok(config.getConfiguration(NpcAggroAreaConfig.group, "saved.kat"));
    assert.deepEqual(infobox.entries(), [], "nothing on the login screen");
    gameState = GameState.LOGGED_IN;
    plugin.onGameStateChanged(new GameStateChanged(GameState.LOGGED_IN));
    clock = 900_000;
    plugin.onGameTick();
    assert.deepEqual(plugin.tracker.safeCenters, [at(3711, 3800), at(3722, 3800)]);
    assert.equal(plugin.tracker.endTime, 900_000 + AGGRESSIVE_TIME_MS, "the time left when logging out carries over");
    assert.equal(config.getConfiguration(NpcAggroAreaConfig.group, "saved.kat"), undefined, "read once");

    await plugin.stop();
    assert.deepEqual(plugin.widgetOverlays(), []);
    assert.equal(plugin.isActive(), false);
    console.log("npc aggro area tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
