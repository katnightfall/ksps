/**
 * The master's admin page (/admin): sign in with MASTER_ADMIN_PASSWORD, then make worlds on the
 * Pterodactyl panel, start and stop them, list or unlist them, and delete them.
 *
 *   GET    /admin                         the page
 *   POST   /admin/api/login               { password }
 *   POST   /admin/api/logout
 *   GET    /admin/api/state               the panel (egg, nodes) and every world with how it is
 *   POST   /admin/api/worlds              make a world on the panel
 *   POST   /admin/api/worlds/external     add a world that already runs somewhere, by its address
 *   PATCH  /admin/api/worlds/<id>         its listing: name, address, secure, description, listed
 *   POST   /admin/api/worlds/<id>/power   { signal: start | stop | restart | kill }
 *   DELETE /admin/api/worlds/<id>         { confirm: <its name> }: the server and all on it
 *
 * Worlds from the project's own list (deploy/worlds.json) are shown and cannot be changed here.
 */
import crypto from "node:crypto";
import fs from "node:fs";

import { cleanWorld } from "../worlds.mjs";
import { PanelError } from "./panel.mjs";
import { slug } from "./registry.mjs";

const COOKIE = "tsps_admin";
const SESSION_MS = 7 * 86_400_000;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_TRIES = 10;
const MAX_BODY = 16 * 1024;
const PANEL_CACHE_MS = 30_000;
export const MIN_PASSWORD = 12;
/** What a world's server gets unless the form says otherwise (the egg needs 4 GB to build). */
export const DEFAULTS = { memoryMb: 6144, diskMb: 15360, cpu: 0, xpRate: 10, bots: 100 };
/** Where a node keeps the certificate for its own name (Let's Encrypt's layout, as Wings uses). */
const TLS_DIR = "/etc/letsencrypt/live";

class Refusal extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const text = (value, max) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "");
const digest = (value) => crypto.createHash("sha256").update(value).digest();

function number(value, { min, max, whole = true, name }) {
    const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
    if (!Number.isFinite(n) || (whole && !Number.isInteger(n)) || n < min || n > max) throw new Refusal(400, `${name} must be ${whole ? "a whole number" : "a number"} from ${min} to ${max}.`);
    return n;
}

/** Where the world goes: a place from the location picker ("location-3", "node-2"), or a node outright. */
function readPlace(body) {
    const place = text(body?.place, 40);
    if (/^(location|node)-\d{1,9}$/.test(place)) return { place };
    if (body?.nodeId === undefined || body?.nodeId === "") throw new Refusal(400, "Pick a location.");
    return { nodeId: number(body.nodeId, { min: 1, max: 1e9, name: "The node" }) };
}

/** What the create form sent, checked. */
export function readNewWorld(body) {
    const name = text(body?.name, 40);
    if (!name) throw new Refusal(400, "Give the world a name.");
    if (!slug(name)) throw new Refusal(400, "The name needs at least one letter or number.");
    return {
        name,
        description: text(body?.description, 120) || "A new world.",
        ...readPlace(body),
        xpRate: number(body?.xpRate ?? DEFAULTS.xpRate, { min: 1, max: 1000, whole: false, name: "The XP rate" }),
        bots: number(body?.bots ?? DEFAULTS.bots, { min: 0, max: 2000, name: "Bots" }),
        developers: text(body?.developers, 200),
        memoryMb: number(body?.memoryMb ?? DEFAULTS.memoryMb, { min: 4096, max: 262144, name: "Memory (MB)" }),
        diskMb: number(body?.diskMb ?? DEFAULTS.diskMb, { min: 5120, max: 1048576, name: "Disk (MB)" }),
        cpu: number(body?.cpu ?? DEFAULTS.cpu, { min: 0, max: 12800, name: "CPU (%)" }),
    };
}

/**
 * `options`: password, secret (signs the sessions), registry, projectWorlds() (deploy/worlds.json),
 * panel + settings (deploy/master/panel.mjs), publicUrl (the master's own address, given to new
 * worlds), statusOf(worlds) (who is on them), page (the HTML file), now().
 */
export function createAdmin(options) {
    const { registry, panel, settings, publicUrl } = options;
    /** Why worlds cannot be saved (the folder is not writable), or null. */
    const storage = options.storage ?? null;
    const now = options.now ?? (() => Date.now());
    const enabled = String(options.password ?? "").length >= MIN_PASSWORD;
    const key = digest(`admin:${options.secret}:${options.password}`);
    const sign = (issued) => crypto.createHmac("sha256", key).update(String(issued)).digest("base64url");

    function signedIn(request) {
        const cookie = String(request.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
        const [issued, mac] = String(cookie ?? "").slice(COOKIE.length + 1).split(".");
        const age = now() - Number(issued);
        if (!mac || !(age >= 0 && age < SESSION_MS)) return false;
        const want = Buffer.from(sign(issued)), got = Buffer.from(mac);
        return got.length === want.length && crypto.timingSafeEqual(got, want);
    }

    // Sign-in tries by visitor: the front door states the visitor's address (x-real-ip).
    const tries = new Map();
    function mayTry(request) {
        const who = String(request.headers["x-real-ip"] ?? request.socket?.remoteAddress ?? "");
        const recent = (tries.get(who) ?? []).filter((at) => now() - at < LOGIN_WINDOW_MS);
        if (recent.length >= LOGIN_TRIES) { tries.set(who, recent); return false; }
        tries.set(who, [...recent, now()]);
        if (tries.size > 5000) tries.clear();
        return true;
    }

    const secure = (request) => request.headers["x-forwarded-proto"] === "https" || String(request.headers["cf-visitor"] ?? "").includes('"scheme":"https"');

    function send(response, status, body, headers = {}) {
        const json = JSON.stringify(body);
        response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(json), "Cache-Control": "no-store", ...headers });
        response.end(json);
    }

    async function readBody(request) {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
            size += chunk.length;
            if (size > MAX_BODY) throw new Refusal(413, "That is too much to send.");
            chunks.push(chunk);
        }
        if (size === 0) return {};
        try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            return parsed && typeof parsed === "object" ? parsed : {};
        } catch {
            throw new Refusal(400, "That was not JSON.");
        }
    }

    /** Every name and id in use, so a new world cannot take one. */
    function taken() {
        const all = [...options.projectWorlds(), ...registry.all()];
        return {
            ids: new Set(all.map((world) => world.id)),
            names: new Set(all.flatMap((world) => [world.name, world.world]).filter(Boolean).map((name) => String(name).toLowerCase())),
        };
    }

    let panelCache = { at: -Infinity, value: null };
    async function panelState(fresh = false) {
        if (!settings.configured) return { configured: false, missing: settings.missing };
        if (!fresh && now() - panelCache.at < PANEL_CACHE_MS) return panelCache.value;
        let value;
        try {
            const [egg, nodes, places] = await Promise.all([panel.egg(), panel.nodes(), panel.places()]);
            value = { configured: true, host: new URL(settings.url).host, egg: { id: egg.id, name: egg.name }, nodes, places };
        } catch (error) {
            value = { configured: true, host: new URL(settings.url).host, error: error.message };
        }
        panelCache = { at: now(), value };
        return value;
    }

    async function state() {
        // A world made here that has started answering on https at its node's name (the node lets
        // it read the certificate) is from then on listed there, and reached directly.
        if (options.answersHttps && !storage) {
            await Promise.all(registry.all().filter((record) => record.panel && record.secure === false).map(async (record) => {
                if (await options.answersHttps(record.address)) registry.update(record.id, { secure: true });
            }));
        }
        const project = options.projectWorlds().map((world) => ({ ...world, source: "project", listed: true }));
        const managed = registry.all().map((record) => ({ ...record, source: record.panel ? "panel" : "added" }));
        const worlds = [...project, ...managed];
        const usable = worlds.map((world) => cleanWorld(world));
        const [board, panelInfo, servers] = await Promise.all([
            options.statusOf(usable.filter(Boolean)),
            panelState(),
            Promise.all(worlds.map((world) => (world.panel && settings.configured ? panel.state(world.panel.identifier) : null))),
        ]);
        const statuses = new Map(board.worlds.map((world) => [world.id, world]));
        return {
            site: publicUrl,
            storage,
            defaults: DEFAULTS,
            panel: panelInfo,
            worlds: worlds.map((world, index) => {
                const status = statuses.get(world.id);
                return {
                    id: world.id, name: world.name, world: world.world ?? world.name, address: world.address, secure: world.secure !== false,
                    description: world.description ?? "", listed: world.listed !== false, source: world.source,
                    location: world.location ?? "", headless: world.headless === true,
                    createdAt: world.createdAt ?? null,
                    online: status?.online === true, players: status?.players ?? null, bots: status?.bots ?? null, experienceRate: status?.experienceRate ?? null,
                    link: `${world.secure !== false ? "https" : "http"}://${world.address}/`,
                    server: servers[index] ? { ...servers[index], url: panel.serverUrl(world.panel.identifier) } : null,
                };
            }),
        };
    }

    async function createWorld(body) {
        // Before the panel is asked: a server nobody could then list would be an orphan.
        if (storage) throw new Refusal(503, storage);
        const world = readNewWorld(body);
        const used = taken();
        if (used.names.has(world.name.toLowerCase())) throw new Refusal(409, `There is already a world called "${world.name}".`);
        let id = slug(world.name);
        for (let n = 2; used.ids.has(id); n++) id = `${slug(world.name).slice(0, 36)}-${n}`;
        const nodeId = world.nodeId ?? await panel.nodeIn(world.place);
        const fqdn = (await panel.nodes()).find((node) => node.id === nodeId)?.fqdn ?? "";
        const named = fqdn && !/^[\d.]+$|:/.test(fqdn);
        const made = await panel.createWorld({
            name: world.name,
            description: world.description,
            nodeId,
            externalId: `tsps-world-${id}`,
            memoryMb: world.memoryMb, diskMb: world.diskMb, cpu: world.cpu,
            environment: {
                WORLD_NAME: world.name,
                WORLD_DESCRIPTION: world.description,
                XP_RATE: String(world.xpRate),
                BOT_COUNT: String(world.bots),
                DEV_USERNAME: world.developers,
                // The new world asks us for the list of worlds, so it shows them all.
                WORLDS_MASTER_URL: publicUrl,
                // It is played on our site (/play?world=<id>, carried at /w/<id>): it builds and
                // serves no website of its own, and believes the visitor's address we sign.
                HEADLESS: "1",
                MASTER_PROXY_KEY: options.proxyKey ?? "",
                // https at the node's own name, with the node's own certificate, where the node
                // lets the world read it (deploy/README.txt). Where it does not, the world answers
                // on plain http and is played through us as before.
                ...(named ? { TLS_CERT: `${TLS_DIR}/${fqdn}/fullchain.pem`, TLS_KEY: `${TLS_DIR}/${fqdn}/privkey.pem` } : {}),
            },
        });
        panelCache.at = -Infinity; // a port was taken
        return registry.add({
            id, name: world.name, world: world.name, address: `${made.host}:${made.port}`, secure: false,
            description: world.description, listed: true, headless: true, createdAt: new Date(now()).toISOString(),
            location: made.nodeName ?? "",
            panel: { serverId: made.serverId, identifier: made.identifier, nodeId: made.nodeId, allocationId: made.allocationId },
        });
    }

    function addExternal(body) {
        if (storage) throw new Refusal(503, storage);
        const name = text(body?.name, 40);
        const entry = cleanWorld({ name, world: text(body?.world, 40) || name, address: text(body?.address, 255), secure: body?.secure === true, description: text(body?.description, 160) });
        if (!entry) throw new Refusal(400, "Give a name and an address like play.example.com or 203.0.113.10:5000 (no http://, no path).");
        const used = taken();
        if (used.names.has(entry.name.toLowerCase()) || used.names.has(entry.world.toLowerCase())) throw new Refusal(409, `There is already a world called "${entry.name}".`);
        let id = slug(entry.name);
        for (let n = 2; used.ids.has(id); n++) id = `${slug(entry.name).slice(0, 36)}-${n}`;
        return registry.add({ id, name: entry.name, world: entry.world, address: entry.address, secure: entry.secure, description: entry.description, listed: true, createdAt: new Date(now()).toISOString() });
    }

    function managed(id) {
        const record = registry.get(id);
        if (record) return record;
        if (options.projectWorlds().some((world) => world.id === id)) throw new Refusal(403, "That world is in the project's own list (deploy/worlds.json) and is changed there.");
        throw new Refusal(404, "There is no such world.");
    }

    function editListing(id, body) {
        const record = managed(id);
        const next = {
            name: body?.name === undefined ? record.name : text(body.name, 40),
            world: body?.world === undefined ? record.world : text(body.world, 40),
            address: body?.address === undefined ? record.address : text(body.address, 255),
            secure: body?.secure === undefined ? record.secure : body.secure === true,
            description: body?.description === undefined ? record.description : text(body.description, 160),
        };
        const entry = cleanWorld(next);
        if (!entry) throw new Refusal(400, "The name or the address is not usable (an address is like play.example.com or 203.0.113.10:5000).");
        const others = [...options.projectWorlds(), ...registry.all()].filter((world) => world.id !== id);
        if (others.some((world) => String(world.name).toLowerCase() === entry.name.toLowerCase())) throw new Refusal(409, `There is already a world called "${entry.name}".`);
        return registry.update(id, { name: entry.name, world: entry.world, address: entry.address, secure: entry.secure, description: entry.description, listed: body?.listed === undefined ? record.listed !== false : body.listed === true });
    }

    async function power(id, body) {
        const record = managed(id);
        if (!record.panel) throw new Refusal(400, "That world was not made here, so it is not ours to start or stop.");
        const signal = text(body?.signal, 10);
        if (!["start", "stop", "restart", "kill"].includes(signal)) throw new Refusal(400, "The signal is start, stop, restart or kill.");
        await panel.power(record.panel.identifier, signal);
        return { ok: true };
    }

    async function remove(id, body) {
        const record = managed(id);
        if (text(body?.confirm, 40) !== record.name) throw new Refusal(400, `To delete it, type the world's name exactly: ${record.name}`);
        if (record.panel) {
            await panel.deleteWorld(record.panel.serverId);
            panelCache.at = -Infinity;
        }
        registry.remove(id);
        return { ok: true, deletedServer: !!record.panel };
    }

    const page = () => fs.readFileSync(options.page, "utf8");

    /** Answers a request under /admin. */
    return async function handle(request, response) {
        const url = new URL(request.url ?? "/", "http://master");
        const route = url.pathname.replace(/\/+$/, "") || "/";
        const method = request.method ?? "GET";
        try {
            if (route === "/admin" && (method === "GET" || method === "HEAD")) {
                const html = page();
                response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html), "Cache-Control": "no-store",
                    "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
                    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
                return response.end(method === "HEAD" ? undefined : html);
            }
            if (!route.startsWith("/admin/api/")) throw new Refusal(404, "Not found.");
            if (!enabled) throw new Refusal(503, `The admin page is off: set MASTER_ADMIN_PASSWORD (${MIN_PASSWORD} characters or more) in the server's .env and restart the website.`);
            const action = route.slice("/admin/api/".length);

            // Anything that changes something must come from our own page: a header another site
            // cannot send, and when the browser names the page it came from, it must be this site.
            if (method !== "GET" && method !== "HEAD") {
                if (request.headers["x-tsps-admin"] !== "1") throw new Refusal(403, "That request did not come from the admin page.");
                const origin = request.headers.origin;
                if (origin && new URL(origin).host !== request.headers.host) throw new Refusal(403, "That request came from another site.");
            }

            if (action === "login" && method === "POST") {
                if (!mayTry(request)) throw new Refusal(429, "Too many tries. Wait 15 minutes and try again.");
                const body = await readBody(request);
                if (!crypto.timingSafeEqual(digest(String(body.password ?? "")), digest(options.password))) {
                    console.warn("[master] a wrong admin password was tried");
                    throw new Refusal(401, "That isn't the admin password.");
                }
                const issued = now();
                return send(response, 200, { ok: true }, { "Set-Cookie": `${COOKIE}=${issued}.${sign(issued)}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${SESSION_MS / 1000}${secure(request) ? "; Secure" : ""}` });
            }
            if (action === "logout" && method === "POST") {
                return send(response, 200, { ok: true }, { "Set-Cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0` });
            }
            if (!signedIn(request)) throw new Refusal(401, "Sign in first.");

            if (action === "state" && method === "GET") return send(response, 200, await state());
            // For a world set up by hand (its egg's "Master proxy key"): asked for, never sent with the state.
            if (action === "proxy-key" && method === "GET") return send(response, 200, { key: options.proxyKey ?? "" });
            if (action === "worlds" && method === "POST") return send(response, 201, await createWorld(await readBody(request)));
            if (action === "worlds/external" && method === "POST") return send(response, 201, addExternal(await readBody(request)));
            const world = /^worlds\/([a-z0-9-]{1,40})(\/power)?$/.exec(action);
            if (world && world[2] && method === "POST") return send(response, 200, await power(world[1], await readBody(request)));
            if (world && !world[2] && method === "PATCH") return send(response, 200, editListing(world[1], await readBody(request)));
            if (world && !world[2] && method === "DELETE") return send(response, 200, await remove(world[1], await readBody(request)));
            throw new Refusal(404, "Not found.");
        } catch (error) {
            if (error instanceof Refusal) return send(response, error.status, { error: error.message });
            if (error instanceof PanelError) return send(response, 502, { error: `The panel said: ${error.message}` });
            console.error("[master] admin request failed", error);
            return send(response, 500, { error: "Something went wrong here. The server's log has the details." });
        }
    };
}
