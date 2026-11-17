/**
 * The Pterodactyl panel, as the master's admin page uses it to make and run worlds
 * (the same two APIs our FreeMC site uses, freemc/src/ptero.js).
 *
 *   application API  PTERO_APP_KEY     makes and deletes servers; reads eggs, nodes, allocations, users
 *   client API       PTERO_CLIENT_KEY  starts and stops a server and reads how it is; the key
 *                                      belongs to a root admin, so it reaches every server
 *
 * Settings (the server's .env; the two keys are secrets and never go in the project):
 *   PTERO_URL          the panel's address (https://panel.example.com)
 *   PTERO_APP_KEY, PTERO_CLIENT_KEY
 *   PTERO_EGG_ID, PTERO_NEST_ID   optional: the world egg. Without them it is found by its name.
 *   PTERO_OWNER_ID     optional: the panel user that owns the worlds. Without it, the client key's.
 *   PTERO_PORT_RANGE   optional: only these ports are given to worlds ("5000-5099,6000")
 */

/** The egg this project makes (deploy/pterodactyl/make-egg.mjs). */
export const EGG_NAME = "Kat-Net TSPS";

export class PanelError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const text = (value) => (typeof value === "string" ? value.trim() : "");
const whole = (value) => (/^\d+$/.test(text(value)) ? Number(text(value)) : 0);

/** "5000-5099,6000" as [[5000, 5099], [6000, 6000]]; [] takes any port. */
export function portRanges(raw) {
    return text(raw).split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
        const [from, to = from] = part.split("-").map((n) => Number(n.trim()));
        return Number.isInteger(from) && Number.isInteger(to) && from > 0 && to >= from && to <= 65535 ? [from, to] : null;
    }).filter(Boolean);
}

export function panelSettings(env = process.env) {
    const url = text(env.PTERO_URL).replace(/\/+$/, "");
    const settings = {
        url: /^https?:\/\/[^\s/]+/.test(url) ? url : "",
        appKey: text(env.PTERO_APP_KEY),
        clientKey: text(env.PTERO_CLIENT_KEY),
        eggId: whole(env.PTERO_EGG_ID),
        nestId: whole(env.PTERO_NEST_ID),
        ownerId: whole(env.PTERO_OWNER_ID),
        portRanges: portRanges(env.PTERO_PORT_RANGE),
    };
    const missing = [!settings.url && "PTERO_URL", !settings.appKey && "PTERO_APP_KEY", !settings.clientKey && "PTERO_CLIENT_KEY"].filter(Boolean);
    return { ...settings, missing, configured: missing.length === 0 };
}

/** A panel reached with `settings`. `fetchImpl` is for tests. */
export function createPanel(settings, fetchImpl = fetch) {
    async function call(scope, method, path, { query, body, timeout = 30_000 } = {}) {
        if (!settings.configured) throw new PanelError(503, `The panel is not set up: ${settings.missing.join(", ")} missing.`);
        const url = new URL(`${settings.url}/api/${scope}${path}`);
        for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
        const headers = { Accept: "application/json", Authorization: `Bearer ${scope === "application" ? settings.appKey : settings.clientKey}` };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        let response;
        try {
            response = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
        } catch (error) {
            throw new PanelError(502, `Can't reach the panel (${error?.cause?.code ?? error?.name ?? "no answer"}).`);
        }
        const raw = await response.text();
        if (!response.ok) {
            let detail = response.statusText || `HTTP ${response.status}`;
            try {
                const first = JSON.parse(raw).errors?.[0];
                detail = first?.detail || first?.code || detail;
            } catch {}
            // The two commonest set-up faults, said in full: what the key may not do, and a key the panel does not know.
            if (response.status === 403 && scope === "application") {
                const area = /\/allocations/.test(path) ? "allocations" : /\/eggs/.test(path) ? "eggs" : path.split("/")[1];
                detail = `the application key may not ${method === "GET" ? "read" : "change"} ${area} (Admin > Application API: Servers read & write; Users, Nodes, Allocations, Nests and Eggs read)`;
            } else if (response.status === 401) {
                detail = scope === "application"
                    ? "it does not know the application key (PTERO_APP_KEY)"
                    : "it does not know the client key (PTERO_CLIENT_KEY: Account > API Credentials of an admin account; if the key lists allowed IPs, this server's must be among them)";
            }
            throw new PanelError(response.status, String(detail).slice(0, 300));
        }
        if (!raw) return null;
        try { return JSON.parse(raw); } catch { return raw; }
    }
    const app = (method, path, options) => call("application", method, path, options);
    const client = (method, path, options) => call("client", method, path, options);

    /** Every page of a list. */
    async function all(path, query = {}) {
        const out = [];
        for (let page = 1, pages = 1; page <= pages && page <= 50; page++) {
            const answer = await app("GET", path, { query: { ...query, page, per_page: 100 } });
            pages = answer?.meta?.pagination?.total_pages ?? 1;
            out.push(...(answer?.data ?? []).map((entry) => entry.attributes));
        }
        return out;
    }

    /** The world egg: its ids, image, start command and its variables' defaults. */
    async function egg() {
        let { eggId, nestId } = settings;
        if (!eggId || !nestId) {
            for (const nest of await all("/nests")) {
                const found = (await all(`/nests/${nest.id}/eggs`)).find((candidate) => candidate.name === EGG_NAME);
                if (found) { eggId = found.id; nestId = nest.id; break; }
            }
            if (!eggId) throw new PanelError(404, `The panel has no egg named "${EGG_NAME}". Import deploy/pterodactyl/egg-kat-net-tsps.json (Admin > Nests > Import Egg), or set PTERO_EGG_ID and PTERO_NEST_ID.`);
        }
        const found = (await app("GET", `/nests/${nestId}/eggs/${eggId}`, { query: { include: "variables" } })).attributes;
        const images = Object.values(found.docker_images ?? {});
        const environment = {};
        for (const variable of found.relationships?.variables?.data ?? []) environment[variable.attributes.env_variable] = variable.attributes.default_value ?? "";
        return { id: found.id, nestId, name: found.name, image: images[0] ?? found.docker_image, startup: found.startup, environment };
    }

    /**
     * The nodes worlds can go on, each with how many ports it has free and the location it is in.
     * `place` is what the admin page's location picker goes by: the panel's location, or the node
     * itself where the panel names no location for it.
     */
    async function nodes() {
        // The location comes with the node when the key may read Locations; the node's own
        // location_id is there either way.
        const list = await all("/nodes", { include: "location" });
        return Promise.all(list.map(async (node) => {
            // null: the key may not read Allocations, so the free ports are not known.
            const free = await freeAllocations(node.id).then((ports) => ports.length, () => null);
            const location = node.relationships?.location?.attributes;
            const locationId = location?.id ?? node.location_id;
            return {
                id: node.id, name: node.name, fqdn: node.fqdn, maintenance: node.maintenance_mode === true, free,
                location: location?.short ?? "",
                place: locationId ? `location-${locationId}` : `node-${node.id}`,
                placeName: text(location?.long) || location?.short || "",
            };
        }));
    }

    /**
     * The places a world can be made in: each location with its nodes' free ports added up
     * (null where they are not known). A location the panel will not name is called by its nodes.
     */
    async function places() {
        const byPlace = new Map();
        for (const node of await nodes()) {
            const place = byPlace.get(node.place) ?? { key: node.place, name: node.placeName, free: 0, nodes: [] };
            if (!node.maintenance) place.free = place.free === null || node.free === null ? null : place.free + node.free;
            place.nodes.push({ id: node.id, name: node.name, fqdn: node.fqdn, free: node.free, maintenance: node.maintenance });
            byPlace.set(node.place, place);
        }
        return [...byPlace.values()].map((place) => ({ ...place, name: place.name || place.nodes.map((node) => node.name).join(" / ") }));
    }

    /** The node a new world goes on in `place`: the one with the most free ports that is not in maintenance. */
    async function nodeIn(place) {
        const found = (await places()).find((candidate) => candidate.key === place);
        if (!found) throw new PanelError(404, "The panel has no such location.");
        const best = found.nodes.filter((node) => !node.maintenance && node.free !== 0).sort((a, b) => (b.free ?? 0) - (a.free ?? 0))[0];
        if (!best) throw new PanelError(409, `${found.name} has no free port. Add allocations to its node in the panel.`);
        return best.id;
    }

    /**
     * What stands between this page and making a world, in the panel's own words for its
     * settings: [] when the keys can do all of it. Only reads are tried.
     */
    async function check() {
        const problems = [];
        const may = (path, query) => app("GET", path, { query, timeout: 15_000 }).then(() => true, (error) => (error.status === 403 || error.status === 401 ? false : null));
        const firstNode = await app("GET", "/nodes", { query: { per_page: 1 } }).then((answer) => answer?.data?.[0]?.attributes?.id, () => undefined);
        const firstNest = await app("GET", "/nests", { query: { per_page: 1 } }).then((answer) => answer?.data?.[0]?.attributes?.id, () => undefined);
        const [servers, users, nests, eggs, allocations, locations] = await Promise.all([
            may("/servers", { per_page: 1 }), may("/users", { per_page: 1 }), may("/nests", { per_page: 1 }),
            firstNest ? may(`/nests/${firstNest}/eggs`, { per_page: 1 }) : null,
            firstNode ? may(`/nodes/${firstNode}/allocations`, { per_page: 1 }) : null,
            may("/locations", { per_page: 1 }),
        ]);
        const missing = [servers === false && "Servers (read & write)", users === false && "Users (read)", allocations === false && "Allocations (read)",
            nests === false && "Nests (read)", eggs === false && "Eggs (read)"].filter(Boolean);
        if (missing.length) problems.push(`The application key (Admin > Application API) is missing: ${missing.join(", ")}.`);
        if (locations === false) problems.push("Optional: with Locations (read) the picker shows your locations' names; without it, it goes by node.");
        const account = await client("GET", "/account", { timeout: 15_000 }).then((answer) => answer?.attributes, (error) => error);
        if (account instanceof PanelError) {
            problems.push(account.status === 401 || account.status === 403
                ? "The panel does not accept the client key (PTERO_CLIENT_KEY). Make one under Account > API Credentials, signed in as an admin; if you give it allowed IPs, include this server's."
                : `The client key could not be checked: ${account.message}`);
        } else if (account && account.admin !== true) {
            problems.push("The client key belongs to an account that is not an admin, so it cannot start or stop the worlds.");
        }
        return { problems, blocking: missing.length > 0 || account instanceof PanelError };
    }

    const inRange = (port) => settings.portRanges.length === 0 || settings.portRanges.some(([from, to]) => port >= from && port <= to);
    async function freeAllocations(nodeId) {
        return (await all(`/nodes/${nodeId}/allocations`)).filter((allocation) => !allocation.assigned && inRange(allocation.port));
    }

    /** The panel user the worlds belong to. */
    async function ownerId() {
        if (settings.ownerId) return settings.ownerId;
        const email = (await client("GET", "/account")).attributes.email;
        const user = (await all("/users", { "filter[email]": email })).find((candidate) => candidate.email === email);
        if (!user) throw new PanelError(404, "Could not find the client key's account among the panel's users. Set PTERO_OWNER_ID.");
        return user.id;
    }

    // Ports picked by creates still under way, so two at once do not take the same one.
    const claimed = new Set();

    /**
     * Makes a world's server and starts its install. `world`: { name, description, nodeId,
     * environment (the egg's variables to set), memoryMb, diskMb, cpu, externalId }.
     * Returns { serverId, identifier, uuid, nodeId, allocationId, host, port }.
     */
    async function createWorld(world) {
        const [theEgg, owner, node] = await Promise.all([egg(), ownerId(), app("GET", `/nodes/${world.nodeId}`).then((answer) => answer.attributes)]);
        const allocation = (await freeAllocations(world.nodeId)).find((candidate) => !claimed.has(candidate.id));
        if (!allocation) {
            const range = settings.portRanges.length ? ` in ${settings.portRanges.map(([from, to]) => (from === to ? from : `${from}-${to}`)).join(",")}` : "";
            throw new PanelError(409, `Node "${node.name}" has no free port${range}. Add allocations to it in the panel.`);
        }
        claimed.add(allocation.id);
        try {
            const server = (await app("POST", "/servers", {
                body: {
                    name: world.name,
                    description: world.description ?? "",
                    external_id: world.externalId,
                    user: owner,
                    egg: theEgg.id,
                    docker_image: theEgg.image,
                    startup: theEgg.startup,
                    environment: { ...theEgg.environment, ...world.environment },
                    limits: { memory: world.memoryMb, swap: 0, disk: world.diskMb, io: 500, cpu: world.cpu },
                    feature_limits: { databases: 0, allocations: 0, backups: 0 },
                    allocation: { default: allocation.id },
                    start_on_completion: true,
                },
            })).attributes;
            // Where players reach it: the node's own name (which is what its certificate is for,
            // so the world can answer on https there); without one, the allocation's name or address.
            const named = text(node.fqdn) && !/^[\d.]+$|:/.test(node.fqdn);
            const host = named ? node.fqdn : text(allocation.alias) || allocation.ip;
            return { serverId: server.id, identifier: server.identifier, uuid: server.uuid, nodeId: node.id, nodeName: node.name, fqdn: named ? node.fqdn : "",
                allocationId: allocation.id, host, port: allocation.port };
        } finally {
            claimed.delete(allocation.id);
        }
    }

    /** Deletes a world's server and everything on it. A server the node cannot reach is forced. */
    async function deleteWorld(serverId) {
        try {
            await app("DELETE", `/servers/${serverId}`);
        } catch (error) {
            if (error.status === 404) return;
            await app("DELETE", `/servers/${serverId}/force`);
        }
    }

    /** "start", "stop", "restart" or "kill". */
    const power = (identifier, signal) => client("POST", `/servers/${identifier}/power`, { body: { signal } });

    /** How a server is: { state: "running" | "starting" | "stopping" | "offline" | "installing" | "unknown", memoryMb, cpu }. */
    async function state(identifier) {
        try {
            const usage = (await client("GET", `/servers/${identifier}/resources`, { timeout: 10_000 })).attributes;
            return { state: usage.current_state ?? "unknown", memoryMb: Math.round((usage.resources?.memory_bytes ?? 0) / 1048576), cpu: Math.round(usage.resources?.cpu_absolute ?? 0) };
        } catch (error) {
            // The panel answers 409 while a server installs.
            return { state: error.status === 409 ? "installing" : error.status === 404 ? "gone" : "unknown", memoryMb: 0, cpu: 0 };
        }
    }

    return { egg, nodes, places, nodeIn, check, createWorld, deleteWorld, power, state, serverUrl: (identifier) => `${settings.url}/server/${identifier}` };
}
