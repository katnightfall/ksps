// Ours. Area loot (game/plugins/arealoot): the panel lists the drops within the world's loot
// distance, "Take all" sends ::loot and a row sends ::loot for that pile. The server does the
// taking (server/tests/area-loot.test.cjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigManager } from "../runelite/client/config/ConfigManager";
import type { ConfigStorage } from "../runelite/client/config/ConfigStorage";
import { EventBus } from "../runelite/client/eventbus/EventBus";
import { PluginManager } from "../runelite/client/plugins/PluginManager";
import { CLIENT_TOKEN } from "../runelite/client/plugins/PluginInjector";
import { state } from "../network/serverConnection/state";
import { GroundItemStore } from "../game/data/ground/GroundItemStore";
import { AreaLootPlugin } from "../game/plugins/arealoot/AreaLootPlugin";
import { AreaLootPanel } from "../game/plugins/arealoot/AreaLootPanel";
import { lootCommand, lootInRange, readSettings } from "../game/plugins/arealoot/areaLoot";

class MemoryStorage implements ConfigStorage {
    private readonly values = new Map<string, string>();
    getItem(key: string): string | null { return this.values.get(key) ?? null; }
    setItem(key: string, value: string): void { this.values.set(key, value); }
    removeItem(key: string): void { this.values.delete(key); }
    key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
    get length(): number { return this.values.size; }
}

const pile = (id: number, itemId: number, name: string, quantity: number, x: number, y: number, extra: Record<string, unknown> = {}) =>
    ({ id, itemId, quantity, tile: { x, y, level: 0 }, name, gePrice: 0, expiresTick: 5000, ...extra });
const ME = { x: 3200, y: 3200, level: 0 };

test("the piles within the distance, the most valuable first; the world's own items are not listed", () => {
    const stacks = [
        pile(1, 526, "Bones", 1, 3201, 3200),
        pile(2, 995, "Coins", 300, 3210, 3190, { gePrice: 1 }),
        pile(3, 4151, "Abyssal whip", 1, 3195, 3205, { gePrice: 2_000_000 }),
        pile(4, 1265, "Bronze pickaxe", 1, 3200, 3201, { expiresTick: 0 }),      // spawns in the world
        pile(5, 1511, "Logs", 1, 3211, 3200),                                    // a tile too far
        { ...pile(6, 1511, "Logs", 1, 3200, 3200), tile: { x: 3200, y: 3200, level: 1 } }, // upstairs
    ];
    assert.deepEqual(lootInRange(stacks, ME, 10).map((row) => [row.name, row.quantity, row.value, row.distance]), [
        ["Abyssal whip", 1, 2_000_000, 5],
        ["Coins", 300, 300, 10],
        ["Bones", 1, 0, 1],
    ]);
    assert.equal(lootInRange(stacks, ME, 30).length, 4, "thirty tiles reaches the logs too");
    assert.deepEqual(lootInRange(stacks, undefined, 10), [], "no player, no list");
});

test("what is sent: ::loot for everything, ::loot <item> <x> <y> for one pile", () => {
    assert.equal(lootCommand(), "::loot");
    assert.equal(lootCommand({ itemId: 4151, x: 3195, y: 3205 }), "::loot 4151 3195 3205");
});

test("the world's settings: its distance, held to 1..30; a world without the feature gets the defaults", () => {
    assert.deepEqual(readSettings({ enabled: true, radius: 30, wilderness: false }), { enabled: true, radius: 30, wilderness: false });
    assert.deepEqual(readSettings({ enabled: false, radius: 999, wilderness: true }), { enabled: false, radius: 30, wilderness: true });
    assert.deepEqual(readSettings(undefined), { enabled: true, radius: 10, wilderness: false });
    assert.deepEqual(readSettings({ radius: "x" }), { enabled: true, radius: 10, wilderness: false });
});

test("the plugin lists what the client sees on the ground and sends the server's commands", async () => {
    (state as any).webRtcConfig = {};
    (state as any).socket = { fetchContent: async (path: string) => (path === "/api/area-loot" ? { enabled: true, radius: 12, wilderness: false } : {}) };
    const groundItems = new GroundItemStore();
    groundItems.setMetadataResolver((itemId) => ({ name: itemId === 4151 ? "Abyssal whip" : `Item ${itemId}`, gePrice: itemId === 4151 ? 1000 : 0, haPrice: 0, tradeable: true }));
    const client: any = {
        controlledPlayerServerId: 42,
        groundItems,
        playerEcs: { getIndexForServerId: (id: number) => (id === 42 ? 0 : undefined), getX: () => 3200 << 7, getY: () => 3200 << 7, getLevel: () => 0 },
    };
    const pluginManager = new PluginManager(new EventBus(), new ConfigManager(undefined, new MemoryStorage()));
    pluginManager.getInjector().provide(CLIENT_TOKEN, client);
    pluginManager.loadCorePlugins([AreaLootPlugin]);
    const plugin = pluginManager.getPlugin(AreaLootPlugin)!;
    const sent: string[] = [];
    plugin.send = (command) => { sent.push(command); };
    await pluginManager.setPluginEnabled(AreaLootPlugin, true);
    await plugin.loadSettings();
    assert.equal(plugin.getState().settings.radius, 12, "the world's own distance");

    groundItems.update({ kind: "snapshot", serial: 1, stacks: [
        { id: 7, itemId: 4151, quantity: 1, tile: { x: 3212, y: 3200, level: 0 }, createdTick: 100, expiresTick: 400, ownerId: 42, ownership: 1 },
        { id: 8, itemId: 526, quantity: 1, tile: { x: 3213, y: 3200, level: 0 }, createdTick: 100, expiresTick: 400, ownerId: 42, ownership: 1 },
    ] as any });
    let heard = 0;
    plugin.subscribe(() => { heard++; });
    plugin.refresh();
    assert.deepEqual(plugin.getState().rows.map((row) => [row.name, row.distance]), [["Abyssal whip", 12]], "twelve tiles is in reach, thirteen is not");
    assert.equal(heard, 1);
    plugin.refresh();
    assert.equal(heard, 1, "nothing changed, nobody is told");

    const html = renderToStaticMarkup(React.createElement(AreaLootPanel, { plugin }));
    assert.match(html, /Take all/);
    assert.match(html, /Abyssal whip/);
    assert.match(html, /Piles within 12 tiles/);

    plugin.takeAll();
    plugin.take(plugin.getState().rows[0]);
    assert.deepEqual(sent, ["::loot", "::loot 4151 3212 3200"]);
    await pluginManager.setPluginEnabled(AreaLootPlugin, false);
});
