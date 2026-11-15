import { getDefaultWsUrl } from "../config/clientEnv";

/** What the game server's /api/hiscores sends (server/plugins/world/Hiscores.plugin.js). */
export type HiscoresMeta = {
    world: string;
    /** The list these numbers are for, and the two there are: "official" (people only) and "unofficial" (bots included). */
    list: string;
    lists: { key: string; name: string; players: number }[];
    players: number;
    online: number;
    pageSize: number;
    skills: { name: string; icon: string | null }[];
    activities: { key: string; name: string }[];
    monsters: string[];
    modes: { key: string; name: string }[];
};

export type HiscoresRow = {
    rank: number;
    name: string;
    rights: number;
    mode: string;
    dead: boolean;
    online: boolean;
    /** The level, for a skill table; null for activities and kills. */
    level: number | null;
    score: number;
};

export type HiscoresTable = { table: string; mode: string; page: number; pages: number; total: number; rows: HiscoresRow[] };

export type HiscoresRank = { name: string; rank: number | null; level?: number; score: number; key?: string };

export type HiscoresProfile = {
    name: string;
    rights: number;
    mode: string;
    dead: boolean;
    online: boolean;
    combat: number;
    overall: { rank: number | null; level: number; score: number };
    skills: HiscoresRank[];
    activities: HiscoresRank[];
    kills: HiscoresRank[];
};

/** Which table is open: a skill ("overall" too), an activity or a monster's kills. */
export type TableView = { kind: "skill" | "activity" | "kills"; name: string };

/** The game server's HTTP address: the game connection's own, as http(s). */
export function hiscoresUrl(params: Record<string, string | number | undefined>): string {
    const url = new URL("/api/hiscores", getDefaultWsUrl().replace(/^ws/i, "http"));
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    return url.toString();
}

/** Fetches one answer; null when the server has nothing by that name (a 404). */
export async function fetchHiscores<T>(params: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T | null> {
    const response = await fetch(hiscoresUrl(params), { signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`The game server answered ${response.status}`);
    return (await response.json()) as T;
}
