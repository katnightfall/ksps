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

    /** The nodes worlds can go on, each with how many ports it has free. */
    async function nodes() {
        const list = await all("/nodes", { include: "location" });
        return Promise.all(list.map(async (node) => {
            const free = (await freeAllocations(node.id)).length;
            return { id: node.id, name: node.name, fqdn: node.fqdn, location: node.relationships?.location?.attributes?.short ?? "", maintenance: node.maintenance_mode === true, free };
        }));
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
            // Where players reach it: the allocation's public name when it has one, else its
            // address, else (an allocation on every address) the node's own name.
            const host = text(allocation.alias) || (allocation.ip && allocation.ip !== "0.0.0.0" ? allocation.ip : node.fqdn);
            return { serverId: server.id, identifier: server.identifier, uuid: server.uuid, nodeId: node.id, allocationId: allocation.id, host, port: allocation.port };
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

    return { egg, nodes, createWorld, deleteWorld, power, state, serverUrl: (identifier) => `${settings.url}/server/${identifier}` };
}
