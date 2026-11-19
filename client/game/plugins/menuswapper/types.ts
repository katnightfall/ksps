export interface MenuSwapperPresets {
    /** Bankers and bank booths: "Bank" as the left-click. */
    bank: boolean;
    /** Shopkeepers: "Trade" as the left-click. */
    trade: boolean;
    /** Pickpocketable NPCs: "Pickpocket" as the left-click. */
    pickpocket: boolean;
    /** Every inventory item: "Drop" as the shift-click. */
    shiftDrop: boolean;
}

/** A saved swap: the option, and the target's name as it was when saved (for the panel). */
export interface MenuSwap {
    option: string;
    name: string;
}

/** How many a Shift-click buys or sells in a shop; 0 leaves the shop's own left-click (RuneLite's "Off"). */
export type ShopSwapAmount = 0 | 1 | 5 | 10 | 50;
export const SHOP_SWAP_AMOUNTS: ReadonlyArray<ShopSwapAmount> = [0, 1, 5, 10, 50];

export interface MenuSwapperPluginConfig {
    enabled: boolean;
    presets: MenuSwapperPresets;
    /** RuneLite's "Shop buy shift-click": "Buy N" on a shop's stock while Shift is held. */
    shopBuy: ShopSwapAmount;
    /** RuneLite's "Shop sell shift-click": "Sell N" on your items in a shop while Shift is held. */
    shopSell: ShopSwapAmount;
    /** Left-click swaps by target key ("npc:3010", "loc:10355", "obj:995", "item:4151"). */
    swaps: Record<string, MenuSwap>;
    /** Shift-click swaps (inventory items), by target key. */
    shiftSwaps: Record<string, MenuSwap>;
}

export interface MenuSwapperPluginState {
    config: MenuSwapperPluginConfig;
    version: number;
}

export interface MenuSwapperPluginPersistence {
    load(): Partial<MenuSwapperPluginConfig> | undefined;
    save(config: MenuSwapperPluginConfig): void;
}

export type MenuSwapKind = "left" | "shift";
