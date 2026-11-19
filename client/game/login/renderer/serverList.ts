import {
    getConfiguredDefaultServer,
    getConfiguredServers,
    getWebRtcRelayConfig,
} from "../../../config/clientEnv";
import { SERVER_LIST_URL } from "./constants";
import type { LoginRendererHost } from "./host";
import type { ServerListEntry } from "./types";

function filterServersForCurrentHost(servers: ServerListEntry[]) {

        // The default server is always pickable, even when the list doesn't name it, so
        // choosing another world never strands the player away from it.
        const preferred = getConfiguredDefaultServer();
        if (preferred && !servers.some((s) => s.address === preferred.address)) {
            servers = [serverEntry(preferred), ...servers];
        }
        if (typeof window === "undefined") return servers;
        const pageHost = window.location.hostname.toLowerCase();
        const pageIsLocal =
            pageHost === "localhost" ||
            pageHost === "127.0.0.1" ||
            pageHost === "[::1]" ||
            pageHost === "::1";
        if (pageIsLocal) return servers;

        return servers.filter((s) => {
            const address = s.address.trim().toLowerCase();
            return !(
                address === "localhost" ||
                address.startsWith("localhost:") ||
                address === "127.0.0.1" ||
                address.startsWith("127.0.0.1:") ||
                address === "[::1]" ||
                address.startsWith("[::1]:") ||
                address === "::1"
            );
        });
    
}

function serverEntry(server: any): ServerListEntry {
    const transport = server?.transport === "webrtc" ? "webrtc" : "websocket";
    const signalUrl = typeof server?.signalUrl === "string" ? server.signalUrl : undefined;
    return {
        name: server?.name ?? "Unknown",
        address:
            typeof server?.address === "string"
                ? server.address
                : transport === "webrtc" && signalUrl
                  ? new URL(signalUrl).host
                  : "",
        secure: server?.secure ?? false,
        playerCount: null,
        maxPlayers: server?.maxPlayers ?? 2047,
        transport,
        signalUrl,
        worldId: typeof server?.worldId === "string" ? server.worldId : undefined,
        ownerUsername: typeof server?.ownerUsername === "string" ? server.ownerUsername : undefined,
        iceServers: Array.isArray(server?.iceServers) ? server.iceServers : [],
        // Ours: what our own list (deploy/worlds.mjs) adds for the World Switcher. A list without
        // them (an older master, somebody else's list) leaves them out, and so do we.
        ...(typeof server?.id === "string" && /^[a-z0-9-]{1,40}$/.test(server.id) ? { id: server.id } : {}),
        ...(Number.isInteger(server?.number) && server.number > 0 ? { number: server.number } : {}),
        ...(validPublicText(server?.location, 40) ? { location: server.location } : {}),
    };
}

/**
 * Ours. The master's /worlds.json (deploy/worlds.mjs) says who is on each world: for the worlds
 * of the list that came with an id, the count the probe cannot give, and whether the world
 * itself answers (the master takes the probe's connection for a world it carries either way).
 */
export function applyWorldBoard(servers: ServerListEntry[], board: unknown): void {
    const worlds = (board as { worlds?: unknown })?.worlds;
    if (!Array.isArray(worlds)) return;
    for (const server of servers) {
        const world = server.id ? worlds.find((entry: any) => entry?.id === server.id) : undefined;
        if (!world) continue;
        if (world.online === false) server.playerCount = null;
        else if (world.online === true) {
            server.playerCount = Number.isInteger(world.players) && world.players >= 0 && world.players <= 2047 ? world.players : -1;
        }
    }
}

/** Where the world board is: beside the list, when the list is our own /servers.json. */
function worldBoardUrl(): string | undefined {
    return /(^|\/)servers\.json$/.test(SERVER_LIST_URL) ? SERVER_LIST_URL.replace(/servers\.json$/, "worlds.json") : undefined;
}

async function fetchWorldBoard(servers: ServerListEntry[]): Promise<void> {
    const url = worldBoardUrl();
    if (!url || !servers.some((server) => server.id)) return;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
        if (response.ok) applyWorldBoard(servers, await response.json());
    } catch {
        // No board: the probe's "online" stands.
    }
}

function validPublicText(value: unknown, maxLength: number): value is string {
    if (typeof value !== "string" || value.length < 1 || value.length > maxLength) return false;
    return !Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
    });
}

export function relayWorldEntries(
    signalUrl: string,
    iceServers: RTCIceServer[],
    payload: unknown,
): ServerListEntry[] {
    const worlds = (payload as any)?.worlds;
    if (!Array.isArray(worlds)) return [];
    const relayUrl = new URL(signalUrl);
    return worlds
        // The relay also lists recently offline worlds; only the website shows those.
        .filter((world: any) => typeof world?.worldId === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(world.worldId) && world.online !== false)
        .flatMap((world: any): ServerListEntry[] => {
            let endpoint = relayUrl;
            if (world.transport === "websocket") {
                try {
                    endpoint = new URL(world.webSocketUrl);
                    if (!["ws:", "wss:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) return [];
                } catch { return []; }
            }
            return [{
                name:
                    validPublicText(world.name, 64) && world.name === world.name.trim()
                        ? world.name
                        : world.worldId,
                address: endpoint.host + (world.transport === "websocket" ? endpoint.pathname + endpoint.search : ""),
                secure: endpoint.protocol === "wss:",
                playerCount:
                    Number.isInteger(world.playerCount) && world.playerCount >= 0 && world.playerCount <= 2047
                        ? world.playerCount
                        : -1,
                maxPlayers: 2047,
                transport: world.transport === "websocket" ? "websocket" : "webrtc",
                signalUrl,
                worldId: world.worldId,
                ownerUsername:
                    validPublicText(world.ownerUsername, 100)
                        ? world.ownerUsername
                        : undefined,
                iceServers,
                relayDiscovered: true,
            }];
        });
}

export function forumProfileUrl(ownerUsername: string): string {
    return `https://rsps.app/public/u/${encodeURIComponent(ownerUsername)}`;
}

export function replaceRelayWorlds(
    current: ServerListEntry[],
    discovered: ServerListEntry[],
): ServerListEntry[] {
    const permanent = current.filter((server) => !server.relayDiscovered);
    const configured = new Set(
        permanent
            .filter((server) => server.signalUrl && server.worldId)
            .map((server) => `${server.signalUrl}|${server.worldId}`),
    );
    return [
        ...permanent,
        ...discovered.filter((server) => !configured.has(`${server.signalUrl}|${server.worldId}`)),
    ];
}

export async function discoverRelayWorlds(relay = getWebRtcRelayConfig()): Promise<ServerListEntry[]> {
    if (!relay) return [];
    try {
        const url = new URL(relay.signalUrl);
        url.protocol = url.protocol === "wss:" ? "https:" : "http:";
        url.pathname = "/worlds";
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        return response.ok
            ? relayWorldEntries(relay.signalUrl, relay.iceServers, await response.json())
            : [];
    } catch {
        return [];
    }
}

function probeWebSocket(url: string, timeoutMs: number) {

        return new Promise((resolve) => {
            let settled = false;
            const ws = new WebSocket(url);
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    ws.close();
                    resolve(false);
                }
            }, timeoutMs);
            ws.addEventListener("open", () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    ws.close();
                    resolve(true);
                }
            });
            ws.addEventListener("error", () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(false);
                }
            });
        });
    
}

export async function fetchServerList(host: LoginRendererHost): Promise<void> {

        if (host.serverListFetched) return;

        const configured = getConfiguredServers();
        if (configured && configured.length > 0) {
            host.serverList = filterServersForCurrentHost(
                configured.map(serverEntry),
            );
            host.serverListFetched = true;
            return;
        }

        try {
            const res = await fetch(SERVER_LIST_URL, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data) && data.length > 0) {
                    host.serverList = filterServersForCurrentHost(
                        data.map(serverEntry),
                    );
                }
            }
        } catch {
            // keep fallback
        }
        host.serverListFetched = true;
    
}

/** Ours: the refresh under way for each list, so a second asker can wait for the same answers. */
const refreshing = new WeakMap<LoginRendererHost, Promise<void>>();

/** Asks every listed world how it is. Resolves when the answers are in (it never rejects). */
export function refreshServerList(host: LoginRendererHost): Promise<void> {

        if (host.probing) return refreshing.get(host) ?? Promise.resolve();
        host.probed = false;
        host.probing = true;

        const visibleServers = host.serverList.filter((server) => !server.relayDiscovered);
        const promises = visibleServers.map(async (server) => {
            if (server.signalUrl && server.worldId) {
                try {
                    const statusUrl = new URL(server.signalUrl);
                    statusUrl.protocol = statusUrl.protocol === "wss:" ? "https:" : "http:";
                    statusUrl.pathname = "/worlds";
                    const response = await fetch(statusUrl, { signal: AbortSignal.timeout(8000) });
                    const data = response.ok ? await response.json() : undefined;
                    const world = data?.worlds?.find((entry: any) => entry?.worldId === server.worldId && entry.online !== false);
                    const entry = relayWorldEntries(server.signalUrl, server.iceServers ?? [], { worlds: world ? [world] : [] })[0];
                    if (entry) Object.assign(server, entry, { name: server.name, relayDiscovered: false });
                    server.playerCount = Number.isInteger(world?.playerCount) ? world.playerCount : world ? -1 : null;
                } catch {
                    server.playerCount = null;
                }
                return;
            }
            const wsProto = server.secure ? "wss" : "ws";
            const alive = await probeWebSocket(`${wsProto}://${server.address}`, 5000);
            server.playerCount = alive ? -1 : null;
        });

        // The board after the probes: it knows more than they do, so its word is the last.
        const probes = Promise.all(promises).then(() => fetchWorldBoard(visibleServers));
        const done = Promise.all([probes, discoverRelayWorlds()]).then(([, discovered]) => {
            host.serverList = replaceRelayWorlds(visibleServers, discovered);
        }).catch(() => {}).finally(() => {
            host.probing = false;
            host.probed = true;
        });
        refreshing.set(host, done);
        return done;

}
