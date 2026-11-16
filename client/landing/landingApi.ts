/**
 * Ours. The landing page's list of worlds: /worlds.json, answered by the server's front door
 * (deploy/front.mjs from deploy/worlds.mjs) with every world we list and who is on it now.
 */
export interface LandingWorld {
    id: string;
    name: string;
    description: string;
    /** The world this site itself runs: its links stay on this site. */
    here: boolean;
    home: string;
    play: string;
    hiscores: string;
    online: boolean;
    /** People connected now; null when the world did not say. Bots are counted apart. */
    players: number | null;
    bots: number | null;
    experienceRate?: number;
}

/** Only links we would follow: this site's own paths, or another world's http(s) address. */
function safeLink(value: unknown, fallback: string): string {
    if (typeof value !== "string") return fallback;
    if (/^\/[a-z0-9/_-]*$/i.test(value)) return value;
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : fallback;
    } catch {
        return fallback;
    }
}

const count = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);

/** The answer as the page uses it; anything not shaped as expected is dropped. */
export function readWorlds(answer: unknown): LandingWorld[] {
    const worlds = (answer as { worlds?: unknown })?.worlds;
    if (!Array.isArray(worlds)) return [];
    return worlds
        .filter((world): world is Record<string, unknown> => !!world && typeof world === "object")
        .map((world) => ({
            id: String(world.id ?? ""),
            name: typeof world.name === "string" && world.name ? world.name.slice(0, 40) : "World",
            description: typeof world.description === "string" ? world.description.slice(0, 160) : "",
            here: world.here === true,
            home: safeLink(world.home, "/"),
            play: safeLink(world.play, "/play"),
            hiscores: safeLink(world.hiscores, "/hiscores"),
            online: world.online === true,
            players: count(world.players),
            bots: count(world.bots),
            experienceRate: typeof world.experienceRate === "number" && world.experienceRate > 0 ? world.experienceRate : undefined,
        }))
        .filter((world) => world.id !== "");
}

export async function fetchWorlds(signal?: AbortSignal): Promise<LandingWorld[]> {
    const response = await fetch("/worlds.json", { signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`worlds.json: HTTP ${response.status}`);
    return readWorlds(await response.json());
}

/** "3 players", "1 player", "No one on"; "-" when the world is up but did not say. */
export function playersText(world: LandingWorld): string {
    if (!world.online) return "Offline";
    if (world.players === null) return "Online";
    if (world.players === 0) return "No one on";
    return `${world.players.toLocaleString("en-US")} ${world.players === 1 ? "player" : "players"}`;
}

/** Where the front page's query-less address goes: the landing page; anything else of the app is the game. */
export function isLandingAddress(pathname: string, search: string): boolean {
    // A front-page address with a query (?username=..., ?renderer=...) is a link or a tool from
    // before the game moved to /play: it still opens the game.
    return pathname === "/" && search === "";
}
