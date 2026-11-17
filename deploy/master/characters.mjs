/**
 * One set of characters for every world of the master.
 *
 * Each world keeps its own save database, as the game has it. The master keeps the latest save
 * of every character here, and the worlds talk to it (server/plugins/world/MasterSync.plugin.js):
 *
 *   at a login      the world asks for the account's saves (POST /sync/checkout) and plays from
 *                   them. An account in another world is refused there: one world at a time.
 *   in the world    the world says who is in it (POST /sync/heartbeat, every half minute), which
 *                   holds those characters for it, and hands in their saves as the game makes
 *                   them (POST /sync/save); the logout save lets the character go.
 *   all the time    every world copies what the others handed in (GET /sync/changes), so a
 *                   character is ranked on every world's hiscores, whichever it plays on.
 *
 * Bots are not characters: no world hands in a bot's save.
 *
 * A fresh start (deploy/reset-accounts.mjs) empties this too: the store belongs to one reset id,
 * and when the master's changes, what was kept is moved aside (characters-<time>.sqlite) and a
 * new one begun. A world still on the old id (not restarted since) is told so and plays on its
 * own until it has restarted.
 *
 * Who may call: a world holding the master's key (MASTER_PROXY_KEY, the one new worlds are
 * given), which signs each request (signRequest).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Loaded when the store is first opened, not with this file: the admin page must come up even
// where this Node has no SQLite of its own (the calls then answer that they cannot).
const require = createRequire(import.meta.url);

export const SYNC_HEADER = "x-master-sync";
/** A world that has not said a character is in it for this long no longer holds it (it stopped, or lost its way here). */
export const HOLD_MS = 150_000;
/** A request signed longer ago than this, or further ahead, is refused. */
const CLOCK_MS = 5 * 60_000;
const MAX_BODY = 16 * 1024 * 1024;
const MAX_KEYS = 64;
const CHANGES_PAGE = 40;
const KEY = /^[a-z0-9_:]{1,64}$/;

/** `<time>.<signature>` for a request: the method, the address asked and the body, under the key. */
export function signRequest(key, method, target, body = "", now = Date.now()) {
    const stamp = String(now);
    const signature = crypto.createHmac("sha256", key).update(`${stamp}\n${method.toUpperCase()}\n${target}\n${body}`).digest("hex");
    return `${stamp}.${signature}`;
}

export function verifyRequest(key, header, method, target, body = "", now = Date.now()) {
    if (!key || typeof header !== "string") return false;
    const [stamp, signature] = header.split(".");
    if (!/^\d{10,16}$/.test(stamp ?? "") || !/^[0-9a-f]{64}$/.test(signature ?? "")) return false;
    if (Math.abs(now - Number(stamp)) > CLOCK_MS) return false;
    const expected = signRequest(key, method, target, body, Number(stamp)).split(".")[1];
    return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
}

/**
 * The store: `file` is its database, `resetId()` the master's reset id now. Every call takes the
 * time, so tests need no clock.
 */
export function createCharacterStore(file, resetId = () => "") {
    let db = null;
    let opened = null;

    function open() {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const { DatabaseSync } = require("node:sqlite");
        const database = new DatabaseSync(file);
        database.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA busy_timeout = 5000;
            CREATE TABLE IF NOT EXISTS characters (
                key TEXT PRIMARY KEY,
                save_json TEXT,
                version INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT,
                saved_by TEXT,
                held_by TEXT,
                held_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS characters_version ON characters (version);
            CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
        `);
        return database;
    }

    const meta = (name) => db.prepare("SELECT value FROM meta WHERE name = ?").get(name)?.value;
    const setMeta = (name, value) => db.prepare("INSERT INTO meta (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(name, String(value));

    /** The database for the master's reset id as it is now: a new id sets the old characters aside. */
    function current(now) {
        const id = String(resetId() ?? "");
        if (db && opened === id) return db;
        if (!db) db = open();
        const kept = meta("reset");
        if (kept === undefined) {
            setMeta("reset", id);
        } else if (kept !== id) {
            db.close();
            const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
            let aside = path.join(path.dirname(file), `characters-${stamp}.sqlite`);
            for (let n = 2; fs.existsSync(aside); n++) aside = path.join(path.dirname(file), `characters-${stamp}-${n}.sqlite`);
            fs.renameSync(file, aside);
            for (const suffix of ["-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
            db = open();
            setMeta("reset", id);
        } else if (opened === null) {
            // The master has just started: a world that held a character before still does, until
            // it has had time to say so again.
            db.prepare("UPDATE characters SET held_at = ? WHERE held_by IS NOT NULL").run(now);
        }
        opened = id;
        return db;
    }

    const heldByAnother = (row, world, now) => !!row?.held_by && row.held_by !== world && now - row.held_at < HOLD_MS;
    const read = (database, key) => database.prepare("SELECT key, save_json AS json, version, saved_by, held_by, held_at FROM characters WHERE key = ?").get(key);

    return {
        /** The reset id the store is on. */
        reset(now = Date.now()) {
            current(now);
            return opened;
        },

        /**
         * An account's saves for a world about to log it in. { busy: world } when any is in
         * another world; else { rows: [{ key, json (null: no such character yet), version }] }.
         * Nothing is held by asking: a wrong password must not keep the account's owner out.
         */
        checkout(world, keys, now = Date.now()) {
            const database = current(now);
            const rows = keys.map((key) => read(database, key) ?? { key, json: null, version: 0 });
            const elsewhere = rows.find((row) => heldByAnother(row, world, now));
            if (elsewhere) return { busy: elsewhere.held_by };
            return { rows: rows.map(({ key, json, version }) => ({ key, json: json ?? null, version })) };
        },

        /**
         * A world saying who is in it. Those characters are held for it (taken when free), and
         * any other it held are let go. Returns { lost: [keys] }: the ones another world holds,
         * whose players this world must put out.
         */
        heartbeat(world, keys, now = Date.now()) {
            const database = current(now);
            const lost = [];
            database.exec("BEGIN IMMEDIATE");
            try {
                for (const key of keys) {
                    const row = read(database, key);
                    if (heldByAnother(row, world, now)) {
                        lost.push(key);
                    } else if (row) {
                        database.prepare("UPDATE characters SET held_by = ?, held_at = ? WHERE key = ?").run(world, now, key);
                    } else {
                        database.prepare("INSERT INTO characters (key, held_by, held_at) VALUES (?, ?, ?)").run(key, world, now);
                    }
                }
                const mine = database.prepare("SELECT key FROM characters WHERE held_by = ?").all(world).map((row) => row.key);
                const still = new Set(keys);
                for (const key of mine) if (!still.has(key)) database.prepare("UPDATE characters SET held_by = NULL, held_at = 0 WHERE key = ?").run(key);
                database.exec("COMMIT");
            } catch (error) {
                database.exec("ROLLBACK");
                throw error;
            }
            return { lost };
        },

        /**
         * A save handed in. Refused ({ lost: world }) when another world holds the character:
         * that world's saves are the ones that count now. Refused too ({ conflict: version })
         * when another world has handed one in since the save (`base`, a version) this one was
         * played on from: a world that was away must not put an old character over a newer one.
         * `release` lets the character go.
         */
        save(world, key, json, { release = false, base = null } = {}, now = Date.now()) {
            const database = current(now);
            database.exec("BEGIN IMMEDIATE");
            try {
                const row = read(database, key);
                if (heldByAnother(row, world, now)) {
                    database.exec("COMMIT");
                    return { lost: row.held_by };
                }
                if (Number.isInteger(base) && row?.json != null && row.version !== base && row.saved_by !== world) {
                    database.exec("COMMIT");
                    return { conflict: row.version };
                }
                const version = Number(meta("version") ?? 0) + 1;
                setMeta("version", version);
                // Still this world's while it plays on; nobody's once it is let go (or was another's long ago).
                const holder = !release && row?.held_by === world ? world : null;
                database.prepare(`
                    INSERT INTO characters (key, save_json, version, updated_at, saved_by, held_by, held_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET save_json = excluded.save_json, version = excluded.version,
                        updated_at = excluded.updated_at, saved_by = excluded.saved_by, held_by = excluded.held_by, held_at = excluded.held_at
                `).run(key, json, version, new Date(now).toISOString(), world, holder, holder ? row.held_at : 0);
                database.exec("COMMIT");
                return { version };
            } catch (error) {
                database.exec("ROLLBACK");
                throw error;
            }
        },

        /** Lets go of characters a world holds without a save (it stopped; a login that came to nothing). */
        release(world, keys, now = Date.now()) {
            const database = current(now);
            for (const key of keys) database.prepare("UPDATE characters SET held_by = NULL, held_at = 0 WHERE key = ? AND held_by = ?").run(key, world);
            return { released: keys.length };
        },

        /** Saves handed in after `since` (a version), oldest first, a page at a time: { rows, cursor, more }. */
        changes(since, now = Date.now()) {
            const database = current(now);
            const rows = database.prepare(
                "SELECT key, save_json AS json, version, saved_by AS world FROM characters WHERE version > ? AND save_json IS NOT NULL ORDER BY version LIMIT ?"
            ).all(Math.max(0, Math.floor(Number(since) || 0)), CHANGES_PAGE + 1);
            const page = rows.slice(0, CHANGES_PAGE);
            return { rows: page, cursor: page.length ? page[page.length - 1].version : Math.max(0, Math.floor(Number(since) || 0)), more: rows.length > CHANGES_PAGE };
        },

        /** How many characters are kept, and how many are in a world now. */
        counts(now = Date.now()) {
            const database = current(now);
            return {
                characters: database.prepare("SELECT COUNT(*) AS n FROM characters WHERE save_json IS NOT NULL").get().n,
                online: database.prepare("SELECT COUNT(*) AS n FROM characters WHERE held_by IS NOT NULL AND held_at > ?").get(now - HOLD_MS).n,
            };
        },

        close() {
            db?.close();
            db = null;
            opened = null;
        },
    };
}

const text = (value, max = 80) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const keysOf = (value) => (Array.isArray(value) ? [...new Set(value.filter((key) => typeof key === "string" && KEY.test(key)))].slice(0, MAX_KEYS) : null);

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(Object.assign(new Error("too large"), { status: 413 }));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        request.on("error", reject);
    });
}

/**
 * The worlds' side of the store over HTTP: a (request, response) handler for /sync/... that
 * returns false for any other address. `key()` is the master's key now; none, no syncing.
 */
export function createSyncApi({ store, key, now = () => Date.now() }) {
    const answer = (response, status, body) => {
        response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(body));
    };
    return async function handle(request, response) {
        const target = request.url ?? "";
        if (!/^\/sync\//.test(target)) return false;
        try {
            const secret = key();
            const body = request.method === "POST" ? await readBody(request) : "";
            if (!secret) return answer(response, 503, { error: "The master has no key yet: open its admin page once." }), true;
            if (!verifyRequest(secret, request.headers[SYNC_HEADER], request.method ?? "", target, body, now())) {
                return answer(response, 401, { error: "Not one of this master's worlds." }), true;
            }
            const url = new URL(target, "http://master");
            if (request.method === "GET" && url.pathname === "/sync/changes") {
                return answer(response, 200, { reset: store.reset(now()), ...store.changes(url.searchParams.get("since"), now()) }), true;
            }
            if (request.method !== "POST") return answer(response, 405, { error: "POST" }), true;
            const asked = JSON.parse(body || "{}");
            const world = text(asked.world);
            if (!world) return answer(response, 400, { error: "Which world?" }), true;
            // A world that has not restarted since the last fresh start still has the old characters.
            const reset = store.reset(now());
            if (String(asked.reset ?? "") !== reset) return answer(response, 409, { stale: true, reset }), true;
            if (url.pathname === "/sync/save") {
                if (typeof asked.key !== "string" || !KEY.test(asked.key)) return answer(response, 400, { error: "Which character?" }), true;
                if (asked.json == null) return answer(response, 200, store.release(world, [asked.key], now())), true;
                if (typeof asked.json !== "string") return answer(response, 400, { error: "No save." }), true;
                JSON.parse(asked.json);
                return answer(response, 200, store.save(world, asked.key, asked.json, { release: asked.release === true, base: Number.isInteger(asked.base) ? asked.base : null }, now())), true;
            }
            const keys = keysOf(asked.keys);
            if (!keys) return answer(response, 400, { error: "Which characters?" }), true;
            if (url.pathname === "/sync/checkout") return answer(response, 200, store.checkout(world, keys, now())), true;
            if (url.pathname === "/sync/heartbeat") return answer(response, 200, store.heartbeat(world, keys, now())), true;
            if (url.pathname === "/sync/release") return answer(response, 200, store.release(world, keys, now())), true;
            return answer(response, 404, { error: "No such call." }), true;
        } catch (error) {
            return answer(response, error?.status ?? (error instanceof SyntaxError ? 400 : 500), { error: error?.status === 413 ? "Too large." : error instanceof SyntaxError ? "Not JSON." : "The master could not do that." }), true;
        }
    };
}
