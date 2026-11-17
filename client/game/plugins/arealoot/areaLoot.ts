/**
 * Ours. Area loot: which ground items are in reach of the server's ::loot, and what to send.
 * The server decides what is actually taken (server/plugins/world/AreaLoot.plugin.js); this
 * lists the same piles so the window shows what a click will bring.
 */
export type AreaLootStack = {
    id: number;
    itemId: number;
    quantity: number;
    tile: { x: number; y: number; level: number };
    name: string;
    gePrice: number;
    expiresTick?: number;
};

export type AreaLootRow = {
    id: number;
    itemId: number;
    name: string;
    quantity: number;
    /** Guide price of the whole pile, 0 when the item has none. */
    value: number;
    distance: number;
    x: number;
    y: number;
};

export type AreaLootSettings = { enabled: boolean; radius: number; wilderness: boolean };

export const DEFAULT_SETTINGS: AreaLootSettings = { enabled: true, radius: 10, wilderness: false };

/** The world's settings as its /api/area-loot gives them; anything odd falls back to the defaults. */
export function readSettings(raw: unknown): AreaLootSettings {
    const value = (raw ?? {}) as Record<string, unknown>;
    const radius = Number(value.radius);
    return {
        enabled: value.enabled !== false,
        radius: Number.isFinite(radius) ? Math.max(1, Math.min(30, Math.floor(radius))) : DEFAULT_SETTINGS.radius,
        wilderness: value.wilderness === true,
    };
}

/**
 * The piles in reach, the most valuable first (then the nearest). A pile that never expires is
 * one the world itself puts out (an item on a table): the server leaves those, so they are not
 * listed.
 */
export function lootInRange(
    stacks: ReadonlyArray<AreaLootStack>,
    player: { x: number; y: number; level: number } | undefined,
    radius: number,
): AreaLootRow[] {
    if (!player) return [];
    const rows: AreaLootRow[] = [];
    for (const stack of stacks) {
        if ((stack.tile.level | 0) !== (player.level | 0)) continue;
        if (!((stack.expiresTick ?? 0) > 0)) continue;
        const distance = Math.max(Math.abs(stack.tile.x - player.x), Math.abs(stack.tile.y - player.y));
        if (distance > radius) continue;
        const quantity = Math.max(1, stack.quantity | 0);
        rows.push({
            id: stack.id | 0,
            itemId: stack.itemId | 0,
            name: stack.name || `Item ${stack.itemId | 0}`,
            quantity,
            value: Math.max(0, Math.floor(stack.gePrice || 0)) * quantity,
            distance,
            x: stack.tile.x | 0,
            y: stack.tile.y | 0,
        });
    }
    return rows.sort((a, b) => b.value - a.value || a.distance - b.distance || a.name.localeCompare(b.name) || a.id - b.id);
}

/** What is typed for the server: everything in reach, or one pile. */
export function lootCommand(row?: Pick<AreaLootRow, "itemId" | "x" | "y">): string {
    return row ? `::loot ${row.itemId} ${row.x} ${row.y}` : "::loot";
}

/** Two lists show the same thing when their rows match one for one. */
export function sameRows(a: ReadonlyArray<AreaLootRow>, b: ReadonlyArray<AreaLootRow>): boolean {
    return a.length === b.length && a.every((row, index) => {
        const other = b[index];
        return row.id === other.id && row.quantity === other.quantity && row.distance === other.distance && row.value === other.value;
    });
}

export type AreaLootPosition = { x: number; y: number };

/** The window's place as it is kept in the settings ("x,y"); anything else gives `fallback`. */
export function parsePosition(raw: string, fallback: AreaLootPosition): AreaLootPosition {
    const [x, y] = String(raw ?? "").split(",").map((part) => Number(part.trim()));
    return Number.isFinite(x) && Number.isFinite(y) ? { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) } : fallback;
}

/** A dragged window stays whole inside the game view (when the view's and its own size are known). */
export function clampPosition(
    at: AreaLootPosition,
    view?: { width: number; height: number },
    size?: { width: number; height: number },
): AreaLootPosition {
    const maxX = view && size ? Math.max(0, view.width - size.width) : Infinity;
    const maxY = view && size ? Math.max(0, view.height - size.height) : Infinity;
    return { x: Math.round(Math.max(0, Math.min(maxX, at.x))), y: Math.round(Math.max(0, Math.min(maxY, at.y))) };
}

/**
 * Whether the window shows. Opened by hand it shows while there is anything to list. Left to
 * open by itself, it shows when a pile is listed that was not there when the player last
 * closed it: closing it means "not these", not "never again".
 */
export function windowOpen(rows: ReadonlyArray<Pick<AreaLootRow, "id">>, dismissed: ReadonlySet<number>, autoOpen: boolean, forced: boolean): boolean {
    if (rows.length === 0) return false;
    if (forced) return true;
    return autoOpen && rows.some((row) => !dismissed.has(row.id));
}
