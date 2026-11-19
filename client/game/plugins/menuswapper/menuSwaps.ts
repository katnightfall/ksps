import { MenuTargetType } from "../../../rs/MenuEntry";
import type { SimpleMenuEntry } from "../../../ui/menu/MenuEngine";
import type { MenuTransformContext } from "../../../ui/menu/menuTransforms";
import { SHOPMAIN, SHOPSIDE } from "../../../runelite/api/gameval/InterfaceID";
import type { MenuSwapKind, MenuSwapperPluginConfig, MenuSwapperPresets } from "./types";

export type SwapContext = MenuTransformContext & {
    isShiftHeld: boolean;
    /**
     * Ctrl held: opens the same "Swap ... click" submenus as Shift. Some browsers (Firefox) show
     * their own menu on Shift + right-click, whatever the page does, so Shift alone can't be relied on.
     */
    isCtrlHeld?: boolean;
};

/** Saves (or with `option` null, clears) a swap chosen from the "Swap … click" submenus. */
export type SaveSwap = (
    kind: MenuSwapKind,
    key: string,
    option: string | null,
    name: string,
) => void;

/** Built-in swaps: the option they make the left-click (or shift-click) and where they apply. */
const PRESETS: ReadonlyArray<{
    preset: keyof MenuSwapperPresets;
    option: string;
    types: ReadonlyArray<MenuTargetType>;
    kind: MenuSwapKind;
}> = [
    {
        preset: "bank",
        option: "bank",
        types: [MenuTargetType.NPC, MenuTargetType.LOC],
        kind: "left",
    },
    { preset: "trade", option: "trade", types: [MenuTargetType.NPC], kind: "left" },
    { preset: "pickpocket", option: "pickpocket", types: [MenuTargetType.NPC], kind: "left" },
    { preset: "shiftDrop", option: "drop", types: [MenuTargetType.ITEM], kind: "shift" },
];

const KEY_PREFIX: Partial<Record<MenuTargetType, string>> = {
    [MenuTargetType.NPC]: "npc",
    [MenuTargetType.LOC]: "loc",
    [MenuTargetType.OBJ]: "obj",
    [MenuTargetType.ITEM]: "item",
};

/** Options that never become a swap target. */
const NOT_SWAPPABLE = new Set(["cancel", "walk here", "cast"]);

export const SWAP_LEFT_CLICK = "Swap left click";
export const SWAP_SHIFT_CLICK = "Swap shift click";

export function swapKey(
    type: MenuTargetType | undefined,
    id: number | undefined,
): string | undefined {
    const prefix = type === undefined ? undefined : KEY_PREFIX[type];
    return prefix && typeof id === "number" && id >= 0 ? `${prefix}:${id}` : undefined;
}

/** A menu target without colour tags or a combat level: "Banker", not "<col=ffff00>Banker". */
export function plainTargetName(target: string | undefined): string {
    return String(target ?? "")
        .replace(/<[^>]*>/g, "")
        .replace(/\s*\(level-\d+\)\s*$/i, "")
        .trim();
}

type Group = { key: string; type: MenuTargetType; name: string; positions: number[] };

/** Entries per target, in menu order; a "Use x -> y" or spell entry is left out. */
function groupTargets(entries: SimpleMenuEntry[], context: SwapContext): Group[] {
    const groups = new Map<string, Group>();
    entries.forEach((entry, index) => {
        const option = String(entry.option ?? "").toLowerCase();
        if (!option || NOT_SWAPPABLE.has(option) || String(entry.target ?? "").includes("->"))
            return;
        const type = context.surface === "inventory" ? context.target.type : entry.targetType;
        const id = context.surface === "inventory" ? context.target.id : entry.targetId;
        const key = swapKey(type, id);
        if (!key || type === undefined) return;
        // Two NPCs or objects of the same kind in one menu are separate targets.
        const { npcServerId = "", mapX = "", mapY = "" } = entry;
        const instance = `${key}@${npcServerId},${mapX},${mapY}`;
        let group = groups.get(instance);
        if (!group) {
            const name =
                context.surface === "inventory"
                    ? context.target.name
                    : plainTargetName(entry.target);
            group = { key, type, name, positions: [] };
            groups.set(instance, group);
        }
        group.positions.push(index);
    });
    return [...groups.values()];
}

function chosenOption(
    group: Group,
    kind: MenuSwapKind,
    config: MenuSwapperPluginConfig,
): string | undefined {
    const saved = (kind === "left" ? config.swaps : config.shiftSwaps)[group.key];
    if (saved) return saved.option.toLowerCase();
    return PRESETS.find(
        (p) => p.kind === kind && config.presets[p.preset] && p.types.includes(group.type),
    )?.option;
}

/** Moves the target's entry for `option` to the target's first position; true when found. */
function moveFirst(out: SimpleMenuEntry[], group: Group, option: string, pin: boolean): boolean {
    const entries = group.positions.map((index) => out[index]);
    const chosen = entries.find((e) => String(e.option).toLowerCase() === option);
    if (!chosen) return false;
    const ordered = [chosen, ...entries.filter((e) => e !== chosen)];
    group.positions.forEach((index, i) => {
        out[index] = ordered[i];
    });
    // A swap the player chose wins even over "Attack set to right-click" (deprioritized).
    out[group.positions[0]] = { ...chosen, deprioritized: false, swapPinned: pin || undefined };
    return true;
}

function swapSubmenu(
    label: string,
    kind: MenuSwapKind,
    group: Group,
    options: string[],
    save: SaveSwap,
): SimpleMenuEntry {
    const entry = (option: string, chosen: string | null): SimpleMenuEntry => ({
        option,
        target: "",
        onClick: () => save(kind, group.key, chosen, group.name),
    });
    return {
        option: label,
        target: group.name,
        targetType: MenuTargetType.NONE,
        deprioritized: true,
        onClick: () => {},
        subEntries: [...options.map((option) => entry(option, option)), entry("Reset", null)],
    };
}

/**
 * The menu with the player's swaps and the enabled presets applied (display order, top first;
 * the first eligible entry is the left-click). With Shift held, a shift-click swap is pinned as
 * the left-click. With Shift or Ctrl held, the opened menu gets "Swap left click" / "Swap shift
 * click" submenus.
 */
export function applyMenuSwaps(
    entries: SimpleMenuEntry[],
    context: SwapContext,
    config: MenuSwapperPluginConfig,
    save: SaveSwap,
): SimpleMenuEntry[] {
    if (!config.enabled) return entries;
    const out = entries.slice();
    const groups = groupTargets(out, context);
    for (const group of groups) {
        const shift = context.isShiftHeld ? chosenOption(group, "shift", config) : undefined;
        if (shift && moveFirst(out, group, shift, true)) continue;
        const left = chosenOption(group, "left", config);
        if (left) moveFirst(out, group, left, false);
    }
    if (!context.menu || !(context.isShiftHeld || context.isCtrlHeld)) return out;
    // The submenus go below each target's options (Examine sits at the bottom of the menu),
    // inserted from the bottom up so the positions above stay valid.
    const anchored = groups.flatMap((group) => {
        const ops = group.positions.filter(
            (i) => String(out[i].option).toLowerCase() !== "examine",
        );
        if (ops.length === 0) return [];
        const options = [...new Set(ops.map((index) => String(out[index].option)))];
        return [{ group, options, after: ops[ops.length - 1] }];
    });
    for (const { group, options, after } of anchored.sort((a, b) => b.after - a.after)) {
        const submenus = [swapSubmenu(SWAP_LEFT_CLICK, "left", group, options, save)];
        if (group.type === MenuTargetType.ITEM) {
            submenus.push(swapSubmenu(SWAP_SHIFT_CLICK, "shift", group, options, save));
        }
        out.splice(after + 1, 0, ...submenus);
    }
    return out;
}

/** "Buy 50", "Sell 5" (a script-set op may carry colour tags; some interfaces write "Buy-50"). */
function shopAmountOption(option: unknown): { verb: "buy" | "sell"; amount: number } | undefined {
    const match = /^(buy|sell)[ -](\d+)$/.exec(
        String(option ?? "").replace(/<[^>]*>/g, "").trim().toLowerCase(),
    );
    return match ? { verb: match[1] as "buy" | "sell", amount: Number(match[2]) } : undefined;
}

/**
 * RuneLite's "Shop buy shift-click" and "Shop sell shift-click" (upstream issue #6256): while
 * Shift is held, the chosen "Buy N" of an item in a shop's stock, or "Sell N" of one of the
 * player's items beside it, changes places with the item's first option ("Value", unless the
 * shop's own quantity buttons put another there) and so becomes the left-click, the hover text
 * and the top of the right-click menu. Off (0), Shift not held, another interface, or an item
 * without that option (the infinite-stock shops have no "Buy 50"): the menu is returned as it is.
 */
export function applyShopSwaps(
    entries: SimpleMenuEntry[],
    context: SwapContext,
    config: MenuSwapperPluginConfig,
): SimpleMenuEntry[] {
    if (!config.enabled || !context.isShiftHeld || context.surface !== "widget") return entries;
    const group = context.widgetId >>> 16;
    const verb = group === SHOPMAIN ? "buy" : group === SHOPSIDE ? "sell" : undefined;
    const amount = verb === "buy" ? config.shopBuy : verb === "sell" ? config.shopSell : 0;
    if (!verb || !(amount > 0)) return entries;
    const at = entries.findIndex((entry) => {
        const named = shopAmountOption(entry.option);
        return named?.verb === verb && named.amount === amount;
    });
    // Not offered, or first already (the shop's quantity buttons chose the same amount).
    if (at <= 0) return entries;
    const out = entries.slice();
    out[at] = entries[0];
    // Pinned, as a shift-click swap of an inventory item is: it is the left-click whatever else
    // would decide it.
    out[0] = { ...entries[at], deprioritized: false, swapPinned: true };
    return out;
}
