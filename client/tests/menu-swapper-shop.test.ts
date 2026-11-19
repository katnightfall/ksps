import { strict as assert } from "node:assert";

import { ClientState } from "../game/ClientState";
import { createPrimaryWidgetActionResolver } from "../game/widgets/input/widgetPrimaryAction";
import { MenuSwapperPlugin } from "../game/plugins/menuswapper/MenuSwapperPlugin";
import { SWAP_LEFT_CLICK, applyShopSwaps } from "../game/plugins/menuswapper/menuSwaps";
import type { MenuSwapperPluginConfig } from "../game/plugins/menuswapper/types";
import { Inventory } from "../rs/inventory/Inventory";
import { MenuTargetType } from "../rs/MenuEntry";
import { createCacheVm } from "../scripts/cache/cs2-sweep";
import { chooseDefaultMenuEntry, type SimpleMenuEntry } from "../ui/menu/MenuEngine";
import { applyMenuTransform, setMenuTransform } from "../ui/menu/menuTransforms";
import { deriveMenuEntriesForWidget } from "../widgets/menu/utils";

// Upstream issue #6256: RuneLite's Menu Entry Swapper has "Shop buy shift-click" and "Shop sell
// shift-click" (Off, 1, 5, 10, 50): with Shift held, that Buy or Sell amount changes places with
// "Value" and is the left-click. Ours had neither, and no plugin was asked about the left-click
// of anything in a shop at all.

const SHOPMAIN = 300;
const SHOPSIDE = 301;
const SHARK = 385;

const config = (overrides: Partial<MenuSwapperPluginConfig> = {}): MenuSwapperPluginConfig => ({
    enabled: true,
    presets: { bank: false, trade: false, pickpocket: false, shiftDrop: false },
    shopBuy: 0,
    shopSell: 0,
    swaps: {},
    shiftSwaps: {},
    ...overrides,
});
const options = (entries: SimpleMenuEntry[]) => entries.map((e) => e.option);
const shopContext = (group: number, isShiftHeld: boolean, menu = false) => ({
    surface: "widget" as const, menu, widgetId: group << 16, childIndex: 3, itemId: SHARK, isShiftHeld,
});
const item = (...names: string[]): SimpleMenuEntry[] => [
    ...names.map((option, i) => ({ option, target: "<col=ff9040>Shark", opIndex: i + 1 })),
    { option: "Cancel" },
];
const stockMenu = () => item("Value", "Buy 1", "Buy 5", "Buy 10", "Buy 50");
const sideMenu = () => item("Value", "Sell 1", "Sell 5", "Sell 10", "Sell 50");

// ---- The swap itself ------------------------------------------------------------------------

// Sell 50 changes places with Value, as RuneLite's swap("value", "sell 50") does.
const sold = applyShopSwaps(sideMenu(), shopContext(SHOPSIDE, true), config({ shopSell: 50 }));
assert.deepEqual(options(sold), ["Sell 50", "Sell 1", "Sell 5", "Sell 10", "Value", "Cancel"]);
assert.equal(chooseDefaultMenuEntry(sold)?.option, "Sell 50");
assert.equal((sold[0] as any).opIndex, 5, "the entry keeps its own op: the server is sent Sell 50's");

const bought = applyShopSwaps(stockMenu(), shopContext(SHOPMAIN, true), config({ shopBuy: 10 }));
assert.deepEqual(options(bought), ["Buy 10", "Buy 1", "Buy 5", "Value", "Buy 50", "Cancel"]);

// Each setting is its own side of the shop.
assert.deepEqual(options(applyShopSwaps(stockMenu(), shopContext(SHOPMAIN, true), config({ shopSell: 50 }))), options(stockMenu()));
assert.deepEqual(options(applyShopSwaps(sideMenu(), shopContext(SHOPSIDE, true), config({ shopBuy: 50 }))), options(sideMenu()));

// Off, Shift up, the plugin off, or another interface: untouched (the very same array).
const untouched = sideMenu();
assert.equal(applyShopSwaps(untouched, shopContext(SHOPSIDE, true), config()), untouched);
assert.equal(applyShopSwaps(untouched, shopContext(SHOPSIDE, false), config({ shopSell: 50 })), untouched);
assert.equal(applyShopSwaps(untouched, shopContext(SHOPSIDE, true), config({ shopSell: 50, enabled: false })), untouched);
assert.equal(applyShopSwaps(untouched, shopContext(12, true), config({ shopBuy: 50, shopSell: 50 })), untouched);

// A shop without "Buy 50" (the infinite-stock ones) keeps its menu; the input is never modified.
const noFifty = item("Value", "Buy 1", "Buy 5", "Buy 10");
assert.equal(applyShopSwaps(noFifty, shopContext(SHOPMAIN, true), config({ shopBuy: 50 })), noFifty);
const before = JSON.stringify(untouched);
applyShopSwaps(untouched, shopContext(SHOPSIDE, true), config({ shopSell: 5 }));
assert.equal(JSON.stringify(untouched), before);

// The shop's own quantity buttons may have put an amount first already: the chosen one still
// ends up as the left-click, and one already on top is left alone.
const selected = item("Buy 5", "Value", "Buy 1", "Buy 10", "Buy 50");
assert.deepEqual(
    options(applyShopSwaps(selected, shopContext(SHOPMAIN, true), config({ shopBuy: 50 }))),
    ["Buy 50", "Value", "Buy 1", "Buy 10", "Buy 5", "Cancel"],
);
assert.equal(applyShopSwaps(selected, shopContext(SHOPMAIN, true), config({ shopBuy: 5 })), selected);

// ---- Through the plugin and the menu pipeline ------------------------------------------------

let persisted: MenuSwapperPluginConfig | undefined;
const plugin = new MenuSwapperPlugin({
    load: () => ({ shopSell: 50, shopBuy: 7 as any }),
    save: (c) => (persisted = c),
});
(plugin as any).isEnabled = () => true;
assert.equal(plugin.getState().config.shopSell, 50, "a saved amount loads");
assert.equal(plugin.getState().config.shopBuy, 0, "an amount no shop offers loads as off");
plugin.setConfig({ shopBuy: 10 });
assert.deepEqual([persisted?.shopBuy, persisted?.shopSell], [10, 50], "and is saved");
plugin.setSwap("left", "npc:3010", "Bank", "Banker");
assert.deepEqual([persisted?.shopBuy, persisted?.shopSell], [10, 50], "saving a swap keeps the shop settings");

const SHIFT = 81;
const CTRL = 82;
const hold = (key: number, down: boolean) => ClientState.setKeybindState(key, down);
setMenuTransform((entries, context) => plugin.transformMenuEntries(entries, context));
try {
    // The left-click/hover pass of a shop item (menu: false) now reaches the plugin.
    const order = (group: number, entries: SimpleMenuEntry[], menu = false) =>
        options(applyMenuTransform(entries, { surface: "widget", menu, widgetId: group << 16, childIndex: 3, itemId: SHARK }));
    assert.equal(order(SHOPSIDE, sideMenu())[0], "Value", "Shift up: Value");
    hold(SHIFT, true);
    assert.equal(order(SHOPSIDE, sideMenu())[0], "Sell 50", "Shift held: the chosen Sell amount");
    assert.equal(order(SHOPMAIN, stockMenu())[0], "Buy 10", "and the chosen Buy amount in the stock");
    assert.equal(order(SHOPSIDE, sideMenu(), true)[0], "Sell 50", "the opened menu shows the same order");
    // Other interfaces' left-click order is still not the plugins' business.
    assert.equal(order(12, sideMenu())[0], "Value");
    hold(SHIFT, false);

    // Ours: Ctrl + right-click still opens the swap submenus on an inventory item, and Ctrl alone
    // does nothing in a shop.
    hold(CTRL, true);
    const inventoryMenu = applyMenuTransform(item("Eat", "Use", "Drop"), {
        surface: "inventory", menu: true, target: { type: MenuTargetType.ITEM, id: SHARK, name: "Shark" },
    });
    assert.ok(options(inventoryMenu).includes(SWAP_LEFT_CLICK), "Ctrl + right-click offers Swap left click");
    assert.equal(order(SHOPSIDE, sideMenu())[0], "Value");
    assert.ok(!order(SHOPSIDE, sideMenu(), true).includes(SWAP_LEFT_CLICK));
    hold(CTRL, false);

    // ---- The real shop, built by the cache's own scripts -----------------------------------
    // shop_main_init (1074) and interface_inv_init (149) as ShopManager.openInterface sends them,
    // with the event flags it sets on the slots (1662 on the stock, 1086 on the inventory side).
    const { vm, scripts } = createCacheVm();
    const widgets = vm.context.widgetManager;
    widgets.getGroup(SHOPMAIN);
    widgets.getGroup(SHOPSIDE);
    const stock = new Inventory(300);
    const backpack = new Inventory(28);
    stock.setSlot(0, SHARK, 100);
    backpack.setSlot(2, SHARK, 80);
    vm.context.inventories = new Map([[516, stock], [93, backpack]]);
    const errors: string[] = [];
    vm.logError = (error: Error) => errors.push(error.message);
    const stockParent = widgets.getWidgetByUid((SHOPMAIN << 16) | 16);
    const sideParent = widgets.getWidgetByUid(SHOPSIDE << 16);
    vm.run(scripts.load(1074), [516, -1, 0, 1], ["Shop"]);
    vm.invokeEventHandler(stockParent, "onInvTransmit");
    vm.run(scripts.load(149), [SHOPSIDE << 16, 93, 4, 7, 0, -1], ["Value", "Sell 1", "Sell 5", "Sell 10", "Sell 50"]);
    assert.deepEqual(errors, []);
    const stockItem = stockParent.children.find((child: any) => child?.itemId === SHARK);
    const sideItem = sideParent.children.find((child: any) => child?.itemId === SHARK);
    assert.ok(stockItem && sideItem, "the scripts made a slot for the shark on both sides");

    const flags = (w: any) => ((w.uid >>> 16) === SHOPMAIN ? 1662 : 1086);
    const lookup = (uid: number) => widgets.getWidgetByUid(uid);
    const menuOf = (w: any) => options(deriveMenuEntriesForWidget(w, false, flags, lookup));
    const primary = createPrimaryWidgetActionResolver(
        { getSpellSelection: () => ({ getWidgetTargetMask: () => 0 }) } as any,
        {} as any,
        { getWidgetFlags: flags, getWidgetOpMask: () => 0, getWidgetByUid: lookup } as any,
        {} as any,
    );
    const click = (w: any) => [primary(w).option, primary(w).opIndex];

    assert.deepEqual(menuOf(sideItem).slice(0, 5), ["Value", "Sell 1", "Sell 5", "Sell 10", "Sell 50"]);
    assert.deepEqual(menuOf(stockItem).slice(0, 5), ["Value", "Buy 1", "Buy 5", "Buy 10", "Buy 50"]);
    assert.deepEqual(click(sideItem), ["Value", 1]);
    hold(SHIFT, true);
    assert.deepEqual(menuOf(sideItem).slice(0, 5), ["Sell 50", "Sell 1", "Sell 5", "Sell 10", "Value"]);
    // Op 5 is what ShopManager.actionAmount reads as 50, op 4 as 10.
    assert.deepEqual(click(sideItem), ["Sell 50", 5], "Shift + left click sells 50");
    assert.deepEqual(click(stockItem), ["Buy 10", 4], "Shift + left click buys 10");
    plugin.setConfig({ shopBuy: 0, shopSell: 0 });
    assert.deepEqual([click(sideItem), click(stockItem)], [["Value", 1], ["Value", 1]], "Off: the shop's own left-click");
    hold(SHIFT, false);
} finally {
    hold(SHIFT, false);
    hold(CTRL, false);
    setMenuTransform(undefined);
}

console.log("menu swapper shop tests passed");
