/**
 * The worlds made or added on the master's admin page: one JSON file beside the player saves
 * (server/data/saves/master/master-worlds.json), which no deploy or update ever replaces.
 *
 * The master's list of worlds is the project's own (deploy/worlds.json) and then these. A record:
 *
 *   { id, name, world, address, secure, description, listed, createdAt,
 *     panel: { serverId, identifier, nodeId, allocationId } }     // panel: only worlds made here
 *
 *   name     what the list calls it
 *   world    its own name, as its game server reports it (how a world knows itself on the list)
 *   listed   false keeps it off the landing page and the world picker
 */
import fs from "node:fs";
import path from "node:path";

import { cleanWorld } from "../worlds.mjs";

export function createRegistry(file) {
    function read() {
        try {
            const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
            return Array.isArray(parsed?.worlds) ? parsed.worlds : [];
        } catch {
            return [];
        }
    }
    /** Written whole, to a file beside it first: a crash mid-write leaves the old list. */
    function write(worlds) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, `${JSON.stringify({ worlds }, null, 2)}\n`);
        fs.renameSync(temporary, file);
    }
    return {
        file,
        all: read,
        get: (id) => read().find((world) => world.id === id) ?? null,
        add(world) {
            const worlds = read();
            if (worlds.some((existing) => existing.id === world.id)) throw new Error(`There is already a world with the id "${world.id}".`);
            write([...worlds, world]);
            return world;
        },
        update(id, changes) {
            const worlds = read();
            const index = worlds.findIndex((world) => world.id === id);
            if (index < 0) return null;
            worlds[index] = { ...worlds[index], ...changes, id };
            write(worlds);
            return worlds[index];
        },
        remove(id) {
            const worlds = read();
            write(worlds.filter((world) => world.id !== id));
            return worlds.length;
        },
    };
}

/** The registry's worlds as list entries (deploy/worlds.mjs), the unlisted and the unusable left out. */
export function listedFrom(records) {
    return records.filter((record) => record?.listed !== false).map(cleanWorld).filter(Boolean);
}

/** A world's id from its name: "Kat-Net New York" -> "kat-net-new-york". */
export function slug(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
