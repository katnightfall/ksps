/**
 * Ours. Worlds played through the master's site. A world with no https of its own is reached
 * at the master's address under /w/<id>: its game connection (wss://master/w/<id>) and its
 * /api (https://master/w/<id>/api/...), which the master's front door carries to wherever the
 * world runs (deploy/front.mjs, deploy/worlds.mjs). A link to play such a world is
 * /play?world=<id>.
 */
const PREFIX = /^\/w\/[a-z0-9-]{1,40}(?=\/|$)/;
const ID = /^[a-z0-9-]{1,40}$/;

/** "/w/<id>" when an address's path starts with it, else "". */
export function masterWorldPrefix(pathname: string): string {
    return PREFIX.exec(pathname)?.[0] ?? "";
}

/** The world a page's ?world=<id> names, or undefined. */
export function worldFromQuery(search: string): string | undefined {
    try {
        const id = new URLSearchParams(search).get("world") ?? "";
        return ID.test(id) ? id : undefined;
    } catch {
        return undefined;
    }
}

/** Where a world named by ?world=<id> is reached from this page: the page's own address, under /w/<id>. */
export function masterWorldServer(location: { host: string; protocol: string; search: string } | undefined):
    { id: string; address: string; secure: boolean } | undefined {
    const id = location ? worldFromQuery(location.search) : undefined;
    if (!id || !location?.host || !/^https?:$/.test(location.protocol)) return undefined;
    return { id, address: `${location.host}/w/${id}`, secure: location.protocol === "https:" };
}
