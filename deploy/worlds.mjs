/**
 * The list of worlds this server shows: on its landing page (/worlds.json, with who is online)
 * and in the game's own world picker on the login screen (/servers.json).
 *
 * The list is a file we control (deploy/worlds.json for our server, named by WORLDS_FILE in
 * deploy/settings.env): nobody lists a world but us. Without a file the only world is this one,
 * so a world started from the Pterodactyl egg shows itself and nothing of ours.
 *
 *   [
 *     { "id": "kat-net", "name": "Kat-Net", "address": "rs.kat-net.us", "secure": true,
 *       "description": "...", "here": true }
 *   ]
 *
 *   address  where the world answers: its website, its game connection and its /api, as one
 *            address (what deploy/front.mjs gives a world)
 *   secure   true for https/wss
 *   here     true for the world this server runs itself: its status is asked of the game
 *            server beside us, and its Play link stays on this site
 */
import fs from "node:fs";

/** How long a world's answer is kept, and how long it is given to answer. */
export const STATUS_TTL_MS = 20_000;
export const STATUS_TIMEOUT_MS = 4_000;

const text = (value, max) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "");

/** A list entry as written by hand, checked: null when it cannot be used. */
export function cleanWorld(entry) {
    if (!entry || typeof entry !== "object") return null;
    const address = text(entry.address, 255).toLowerCase();
    // A host, with a port if it has one: nothing that could carry a path or a login.
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(address)) return null;
    const name = text(entry.name, 40);
    if (!name) return null;
    const id = text(entry.id, 40).toLowerCase().replace(/[^a-z0-9-]+/g, "-") || address.replace(/[^a-z0-9]+/g, "-");
    return { id, name, address, secure: entry.secure !== false, here: entry.here === true, description: text(entry.description, 160) };
}

/** The worlds in `file`, or [] when there is no file or it cannot be read as a list. */
export function loadWorlds(file) {
    if (!file) return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!Array.isArray(parsed)) return [];
        const seen = new Set();
        return parsed.map(cleanWorld).filter((world) => world && !seen.has(world.id) && seen.add(world.id));
    } catch {
        return [];
    }
}

/** /servers.json: the list as the game's world picker reads it (client/game/login/renderer/serverList.ts). */
export function serverList(worlds) {
    return worlds.map((world) => ({ name: world.name, address: world.address, secure: world.secure, maxPlayers: 2047 }));
}

/** Where a world's own site is, and where its game is played. */
export function worldUrls(world) {
    const base = `${world.secure ? "https" : "http"}://${world.address}`;
    return { home: world.here ? "/" : `${base}/`, play: world.here ? "/play" : `${base}/play`, hiscores: world.here ? "/hiscores" : `${base}/hiscores` };
}

/** What a world's /api/world-status said, as the landing page shows it. Anything unexpected is left out. */
export function readStatus(answer) {
    const count = (value) => (Number.isInteger(value) && value >= 0 && value < 1_000_000 ? value : null);
    if (!answer || typeof answer !== "object") return { online: true, players: null, bots: null };
    const rate = Number(answer.experienceRate);
    return {
        online: true,
        players: count(answer.players),
        bots: count(answer.bots),
        ...(text(answer.name, 40) ? { reportedName: text(answer.name, 40) } : {}),
        ...(text(answer.description, 160) ? { reportedDescription: text(answer.description, 160) } : {}),
        ...(Number.isFinite(rate) && rate > 0 && rate <= 10_000 ? { experienceRate: rate } : {}),
    };
}

/**
 * Asks worlds how they are and remembers each answer for STATUS_TTL_MS, so a busy landing page
 * costs each world one question every twenty seconds. `ask(world)` resolves to the world's
 * /api/world-status answer (parsed), or rejects when the world does not answer.
 */
export function createStatusBoard(ask, now = () => Date.now()) {
    const kept = new Map();
    async function statusOf(world) {
        const cached = kept.get(world.id);
        if (cached && now() - cached.at < STATUS_TTL_MS) return cached.status;
        // One question at a time per world: callers that arrive meanwhile share it.
        if (cached?.pending) return cached.pending;
        const pending = (async () => {
            let status;
            try {
                status = readStatus(await ask(world));
            } catch {
                status = { online: false, players: null, bots: null };
            }
            kept.set(world.id, { at: now(), status });
            return status;
        })();
        kept.set(world.id, { ...(cached ?? { at: -Infinity, status: null }), pending });
        return pending;
    }
    /** /worlds.json: every world with its links and how it is now. */
    return async function board(worlds) {
        const statuses = await Promise.all(worlds.map(statusOf));
        return {
            worlds: worlds.map((world, index) => {
                const { reportedName, reportedDescription, ...status } = statuses[index];
                return {
                    id: world.id,
                    name: world.name || reportedName || "World",
                    description: world.description || reportedDescription || "",
                    here: world.here,
                    ...worldUrls(world),
                    ...status,
                };
            }),
        };
    };
}

/** GET an http(s) JSON address with a time limit. */
export async function fetchJson(url, timeoutMs = STATUS_TIMEOUT_MS) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" }, redirect: "error" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}
