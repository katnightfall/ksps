// Ours. Area loot (game/plugins/arealoot): a window over the game lists the drops within the
// world's loot distance, "Take all" sends ::loot and a click on an item sends ::loot for that
// pile. The server does the taking (server/tests/area-loot.test.cjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
import { AreaLootConfig, AreaLootPlugin } from "../game/plugins/arealoot/AreaLootPlugin";
import { AreaLootWindow } from "../game/plugins/arealoot/AreaLootWindow";
import { clampPosition, lootCommand, lootInRange, parsePosition, readSettings, windowOpen } from "../game/plugins/arealoot/areaLoot";

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

test("the window shows when something new is in reach, and closing it means not these, not never", () => {
    const rows = [{ id: 1 }, { id: 2 }];
    assert.equal(windowOpen([], new Set(), true, false), false, "nothing to show");
    assert.equal(windowOpen(rows, new Set(), true, false), true, "opens by itself");
    assert.equal(windowOpen(rows, new Set([1, 2]), true, false), false, "closed by the player");
    assert.equal(windowOpen([...rows, { id: 3 }], new Set([1, 2]), true, false), true, "a new drop opens it again");
    assert.equal(windowOpen(rows, new Set(), false, false), false, "not by itself when that is switched off");
    assert.equal(windowOpen(rows, new Set([1, 2]), false, true), true, "opened by hand");
    assert.equal(windowOpen([], new Set(), false, true), false);
});

test("the window's place: kept as x,y, and a drag stays inside the game view", () => {
    assert.deepEqual(parsePosition("40,120", { x: 1, y: 2 }), { x: 40, y: 120 });
    assert.deepEqual(parsePosition("nonsense", { x: 1, y: 2 }), { x: 1, y: 2 });
    assert.deepEqual(parsePosition("-5,3.6", { x: 1, y: 2 }), { x: 0, y: 4 });
    const view = { width: 800, height: 500 };
    const size = { width: 196, height: 150 };
    assert.deepEqual(clampPosition({ x: 300, y: 200 }, view, size), { x: 300, y: 200 });
    assert.deepEqual(clampPosition({ x: 900, y: 600 }, view, size), { x: 604, y: 350 });
    assert.deepEqual(clampPosition({ x: -40, y: -9 }, view, size), { x: 0, y: 0 });
    assert.deepEqual(clampPosition({ x: 900.4, y: 600 }), { x: 900, y: 600 }, "sizes unknown: only kept on the near side");
});

test("the plugin: the window opens over the game by itself, takes on a click, and has no sidebar panel", async () => {
    (state as any).webRtcConfig = {};
    (state as any).socket = { fetchContent: async (address: string) => (address === "/api/area-loot" ? { enabled: true, radius: 12, wilderness: false } : {}) };
    const groundItems = new GroundItemStore();
    groundItems.setMetadataResolver((itemId) => ({ name: itemId === 4151 ? "Abyssal whip" : `Item ${itemId}`, gePrice: itemId === 4151 ? 1000 : 0, haPrice: 0, tradeable: true }));
    const client: any = {
        controlledPlayerServerId: 42,
        groundItems,
        playerEcs: { getIndexForServerId: (id: number) => (id === 42 ? 0 : undefined), getX: () => 3200 << 7, getY: () => 3200 << 7, getLevel: () => 0 },
    };
    const configManager = new ConfigManager(undefined, new MemoryStorage());
    const pluginManager = new PluginManager(new EventBus(), configManager);
    pluginManager.getInjector().provide(CLIENT_TOKEN, client);
    pluginManager.loadCorePlugins([AreaLootPlugin]);
    const plugin = pluginManager.getPlugin(AreaLootPlugin)!;
    const sent: string[] = [];
    plugin.send = (command) => { sent.push(command); };
    await pluginManager.setPluginEnabled(AreaLootPlugin, true);
    await plugin.loadSettings();
    assert.equal(plugin.getState().settings.radius, 12, "the world's own distance");
    assert.equal(plugin.getState().open, false, "nothing on the ground, no window");
    assert.equal(renderToStaticMarkup(React.createElement(AreaLootWindow, { plugin })), "");

    const whip = { id: 7, itemId: 4151, quantity: 1, tile: { x: 3212, y: 3200, level: 0 }, createdTick: 100, expiresTick: 400, ownerId: 42, ownership: 1 };
    const far = { id: 8, itemId: 526, quantity: 1, tile: { x: 3213, y: 3200, level: 0 }, createdTick: 100, expiresTick: 400, ownerId: 42, ownership: 1 };
    groundItems.update({ kind: "snapshot", serial: 1, stacks: [whip, far] as any });
    let heard = 0;
    plugin.subscribe(() => { heard++; });
    plugin.refresh();
    assert.deepEqual(plugin.getState().rows.map((row) => [row.name, row.distance]), [["Abyssal whip", 12]], "twelve tiles is in reach, thirteen is not");
    assert.equal(plugin.getState().open, true, "it opens by itself");
    assert.equal(heard, 1);
    plugin.refresh();
    assert.equal(heard, 1, "nothing changed, nobody is told");

    const html = renderToStaticMarkup(React.createElement(AreaLootWindow, { plugin }));
    assert.ok(html.includes('class="area-loot-window"'), "a window over the game");
    assert.ok(html.includes("Loot (1)"), "titled with how many piles");
    assert.ok(html.includes(">Take all<") && html.includes('data-loot="all"'), "a Take all button");
    assert.ok(html.includes('data-loot="pile" data-pile="7"') && html.includes("Abyssal whip (1,000 gp), 12 tiles away"), "the pile, with what it is on hover");

    plugin.takeAll();
    plugin.take(plugin.getState().rows[0]);
    assert.deepEqual(sent, ["::loot", "::loot 4151 3212 3200"]);

    // The cross closes it; the same pile does not bring it back, a new one does.
    plugin.dismiss();
    assert.equal(plugin.getState().open, false);
    plugin.refresh();
    assert.equal(plugin.getState().open, false);
    groundItems.update({ kind: "snapshot", serial: 2, stacks: [whip, { ...whip, id: 9, itemId: 995, quantity: 50, tile: { x: 3201, y: 3200, level: 0 } }] as any });
    plugin.refresh();
    assert.equal(plugin.getState().open, true, "something new dropped");

    // ::lootwindow closes and opens it by hand, and is not sent to the server.
    assert.equal(plugin.handleClientCommand("lootwindow"), true);
    assert.equal(plugin.getState().open, false);
    assert.equal(plugin.handleClientCommand("lootwindow"), true);
    assert.equal(plugin.getState().open, true);
    assert.equal(plugin.handleClientCommand("loot"), false, "::loot is the server's");

    // A drag moves it and the place is remembered.
    plugin.moveTo(900, 20, { width: 800, height: 500 }, { width: 196, height: 150 });
    assert.deepEqual(plugin.getState().position, { x: 604, y: 20 });
    plugin.savePosition();
    assert.equal(configManager.getConfig(AreaLootConfig).position(), "604,20");

    // With "Open by itself" off, a drop does not open it.
    configManager.setConfigValue(AreaLootConfig, "autoOpen", false);
    plugin.onConfigChanged({ getGroup: () => AreaLootConfig.group } as any);
    groundItems.update({ kind: "snapshot", serial: 3, stacks: [] as any });
    plugin.refresh();
    groundItems.update({ kind: "snapshot", serial: 4, stacks: [whip] as any });
    plugin.refresh();
    assert.equal(plugin.getState().open, false);

    assert.equal(typeof (plugin as any).renderHud, "function", "drawn over the game");
    const source = fs.readFileSync(path.join(process.cwd(), "game/plugins/arealoot/AreaLootPlugin.ts"), "utf8");
    assert.ok(!source.includes("ClientToolbar") && !source.includes("NavigationButton"), "no sidebar button");
    await pluginManager.setPluginEnabled(AreaLootPlugin, false);
    assert.equal(plugin.getState().open, false);
});
