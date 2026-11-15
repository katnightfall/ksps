import { fetchContent } from "../contentApi";

/**
 * Examine texts the connected world has changed (/api/item-examines, our server's
 * ItemExamines plugin). The client examines backpack and worn items by itself from the cache,
 * so a world's own text has to be asked for; a world without the address simply has none.
 */
let examines: Map<number, string> | undefined;
let loading: Promise<void> | undefined;

/** Loads the connected world's changed examine texts; a new login loads them again. */
export function loadItemExamines(): Promise<void> {
    examines = undefined;
    const request = fetchContent("/api/item-examines")
        .then((table: Record<string, string>) => {
            if (loading !== request) return;
            examines = new Map(
                Object.entries(table ?? {})
                    .filter(([, text]) => typeof text === "string" && text.length > 0)
                    .map(([id, text]) => [Number(id), text]),
            );
        })
        .catch(() => {
            if (loading !== request) return;
            examines = new Map();
        });
    loading = request;
    return request;
}

/** The world's own examine text for an item, when it has one. */
export function examineOverride(itemId: number): string | undefined {
    if (!examines) {
        if (!loading) void loadItemExamines();
        return undefined;
    }
    return examines.get(itemId);
}
