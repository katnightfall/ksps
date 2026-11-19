/**
 * The list of worlds this server shows: on its landing page (/worlds.json, with who is online)
 * and in the game's own world picker on the login screen (/servers.json).
 *
 * The list is a file we control (deploy/worlds.json): nobody lists a world but us. Every world
 * started from this project reads the same file and looks for itself in it by its own name (the
 * "name" in its world.json or world.local.json, or the egg's World name). A world that is on the
 * list shows the whole list, with itself marked; one that is not (somebody else's world from the
 * Pterodactyl egg) shows itself alone and nothing of ours.
 *
 *   [
 *     { "id": "kat-net", "name": "Kat-Net", "world": "Kat-Net", "address": "rs.kat-net.us",
 *       "secure": true, "description": "..." }
 *   ]
 *
 *   name     what the list calls the world
 *   world    the world's own name, as its game server reports it: how a world knows itself
 *   address  where the world answers: its website, its game connection and its /api, as one
 *            address (what deploy/front.mjs gives a world)
 *   secure   true for https/wss. A page on https cannot open a game connection to a world
 *            without it, so such a world is left out of an https page's world picker.
 */
import crypto from "node:crypto";
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
    // A port there is: connecting to one that is not (70000) throws where it is asked for, which
    // stopped the front door, and every player's connection with it, at the first visitor.
    const port = address.includes(":") ? Number(address.split(":")[1]) : 1;
    if (port < 1 || port > 65535) return null;
    const name = text(entry.name, 40);
    if (!name) return null;
    const id = text(entry.id, 40).toLowerCase().replace(/[^a-z0-9-]+/g, "-") || address.replace(/[^a-z0-9]+/g, "-");
    return { id, name, world: text(entry.world, 40) || name, address, secure: entry.secure !== false, here: false, description: text(entry.description, 160),
        // A world with no website of its own (made on the master's admin page): played on the master's site.
        ...(entry.headless === true ? { headless: true } : {}) };
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

/**
 * The list as the world named `ownName` shows it: itself marked "here" (its status is asked of
 * the game server beside it, its links stay on its own site). [] when that world is not listed.
 */
export function listFor(worlds, ownName) {
    const mine = ownName ? worlds.find((world) => world.world === ownName) : undefined;
    return mine ? worlds.map((world) => ({ ...world, here: world === mine })) : [];
}

/** The master's /world-list.json answer as a list: checked entry by entry, as a file's is. */
export function worldsFrom(answer) {
    const entries = Array.isArray(answer?.worlds) ? answer.worlds : [];
    const seen = new Set();
    return entries.map(cleanWorld).filter((world) => world && !seen.has(world.id) && seen.add(world.id));
}

/**
 * Through the master. A world with no https of its own (a panel server on a bare address and
 * port, a headless world with no website at all) is played on the master's site: the master
 * carries its game connection and its /api at /w/<id> (deploy/front.mjs), so the one https
 * address serves every world. A world with https of its own is reached directly.
 */
export const throughMaster = (world) => !world.here && !world.secure;
export const masterPath = (id) => `/w/${id}`;
/** "/w/<id>" at the start of a request's address: [id, the rest] or null. */
export function masterRoute(url) {
    const match = /^\/w\/([a-z0-9-]{1,40})(?=[/?]|$)(.*)$/.exec(String(url ?? ""));
    return match ? [match[1], match[2] || "/"] : null;
}

/**
 * /servers.json: the list as the game's world picker reads it (client/game/login/renderer/serverList.ts).
 * `site`, on the master: { host, secure } of the page asking; worlds played through the master
 * are then listed at its own address.
 */
export function serverList(worlds, site = null) {
    return worlds.map((world) => (site && throughMaster(world)
        ? { name: world.name, address: `${site.host}${masterPath(world.id)}`, secure: site.secure, maxPlayers: 2047 }
        : { name: world.name, address: world.address, secure: world.secure, maxPlayers: 2047 }));
}

/**
 * Where a world's site is, and where its game is played. `masterUrl`: "" on the master itself,
 * the master's address on another world that knows it, undefined on a world that knows no master.
 */
export function worldUrls(world, masterUrl = undefined) {
    if (world.here) return { home: "/", play: "/play", hiscores: "/hiscores" };
    // A headless world has no site of its own to link to, https or not: the master's is its site.
    if ((throughMaster(world) || world.headless) && masterUrl !== undefined) {
        const play = `${masterUrl}/play?world=${world.id}`;
        return { home: play, play, hiscores: `${masterUrl}/hiscores?world=${world.id}` };
    }
    const base = `${world.secure ? "https" : "http"}://${world.address}`;
    return { home: `${base}/`, play: `${base}/play`, hiscores: `${base}/hiscores` };
}

// A visitor's address, as the master states it to a world it carries a connection to. The world
// would otherwise see every player arriving from the master's own address (an IP ban would then
// ban them all). Signed with a key both hold
// (MASTER_PROXY_KEY), and good for two minutes: only the master can state it.
const VISITOR_SECONDS = 120;
const visitorMac = (ip, expires, key) => crypto.createHmac("sha256", key).update(`${ip}|${expires}`).digest("base64url");
export const VISITOR_HEADER = "x-master-visitor";
export function signVisitor(ip, key, now = Date.now()) {
    const expires = Math.floor(now / 1000) + VISITOR_SECONDS;
    return `${ip}|${expires}|${visitorMac(ip, expires, key)}`;
}
/** The address a signed header states, or null when it is not the master's, or stale. */
export function verifyVisitor(header, key, now = Date.now()) {
    if (!key || typeof header !== "string") return null;
    const [ip, expires, mac] = header.split("|");
    const left = Number(expires) - Math.floor(now / 1000);
    if (!ip || !mac || !(left >= 0 && left <= VISITOR_SECONDS * 2)) return null;
    const want = Buffer.from(visitorMac(ip, expires, key)), got = Buffer.from(mac);
    return got.length === want.length && crypto.timingSafeEqual(got, want) ? ip : null;
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
export function createStatusBoard(ask, now = () => Date.now(), masterUrl = undefined) {
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
                    ...worldUrls(world, masterUrl),
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
