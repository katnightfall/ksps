#!/usr/bin/env node
/**
 * The one public web port of our server (3000): the website, the game connection and the game's
 * data addresses all answer on it, so a single address (https://rs.kat-net.us through
 * Cloudflare, or http://<server>:3000) is all a browser needs.
 *
 *   a WebSocket                      -> the game server (the game connection)
 *   /api/..., /regions..., /gateway/ -> the game server (hiscores, world info, map data)
 *   /worlds.json, /servers.json,     -> answered here: the worlds we list and who is on them
 *   /world-list.json                    (deploy/worlds.mjs), for the landing page, the game's
 *                                       world picker and the other worlds
 *   /admin...                        -> the master's admin page (deploy/master/), on our own
 *                                       server only: worlds made and run through the panel
 *   anything else                    -> the website (client/scripts/serve-build.mjs, started
 *                                       here on a private port)
 *
 * Why: an https page may only open secure connections, and Cloudflare only carries web ports,
 * so the game's own port (43594) can't be reached from a page on https. Here the game arrives
 * on the page's own address, and Cloudflare's https covers it.
 *
 * The game server is told each player's real address in X-Real-IP, which it accepts from this
 * machine only (BinaryChannel.ts), so IP bans keep working. That address is the caller's own,
 * or the one Cloudflare reports when the caller is Cloudflare (or its tunnel on this machine).
 *
 * Env: PORT (3000), HOST (0.0.0.0), GAME_PORT (43594), WORLDS_FILE (the list of worlds, from the
 * project's folder: deploy/worlds.json unless set), MASTER_ADMIN (1 on the master: the admin page
 * and its worlds), WORLDS_MASTER_URL (on another world: where the master is), FRONT_STATIC_PORT (a website already
 * running on that port, for tests; by default the website is started here).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listedFrom } from "./master/registry.mjs";
import { createStatusBoard, fetchJson, listFor, loadWorlds, serverList, worldsFrom } from "./worlds.mjs";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const GAME_PORT = Number(process.env.GAME_PORT) || 43594;
const LOCAL = "127.0.0.1";
const GAME_PATH = /^\/(api|regions|gateway)(\/|\?|$)/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The worlds we list. Three places they can come from:
//   deploy/worlds.json      the project's own list; every world started from this project has it
//   the admin page's list   on the master (MASTER_ADMIN=1): worlds made or added at /admin, kept
//                           beside the player saves (deploy/master/registry.mjs)
//   the master              a world told where the master is (WORLDS_MASTER_URL, which the admin
//                           page gives every world it makes) asks it for the whole list
// The files are read again when they change, so a new world needs no restart here (a restart of
// this front door drops every player's connection).
const WORLDS_FILE = path.resolve(ROOT, process.env.WORLDS_FILE || "deploy/worlds.json");
const IS_MASTER = process.env.MASTER_ADMIN === "1";
const REGISTRY_FILE = path.join(ROOT, "server", "data", "saves", "master-worlds.json");
const MASTER_URL = /^https?:\/\/[^\s/]+$/.test(String(process.env.WORLDS_MASTER_URL ?? "").replace(/\/+$/, "")) && !IS_MASTER
    ? String(process.env.WORLDS_MASTER_URL).replace(/\/+$/, "") : "";
const LOCAL_STATUS = `http://${LOCAL}:${GAME_PORT}/api/world-status`;
/** With no list, this world alone: its name comes from the game server's own answer. */
const THIS_WORLD = [{ id: "here", name: "", address: "localhost", secure: false, here: true, description: "" }];

const stampOf = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
function managedWorlds() {
    if (!IS_MASTER) return [];
    try { return listedFrom(JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")).worlds ?? []); } catch { return []; }
}
let listed = { worlds: [], stamp: "", checked: 0 };
/** The project's list and, on the master, the admin page's: a world of the same id is listed once. */
function localWorlds() {
    if (Date.now() - listed.checked > 5_000) {
        const stamp = `${stampOf(WORLDS_FILE)}|${IS_MASTER ? stampOf(REGISTRY_FILE) : 0}`;
        if (stamp !== listed.stamp) {
            const project = loadWorlds(WORLDS_FILE);
            const ids = new Set(project.map((world) => world.id));
            listed = { worlds: [...project, ...managedWorlds().filter((world) => !ids.has(world.id))], stamp, checked: Date.now() };
        } else {
            listed.checked = Date.now();
        }
    }
    return listed.worlds;
}

// What the master last said, kept a minute; while it does not answer, what it said before, and
// before it has ever answered, the project's own list.
let fromMaster = { worlds: null, at: 0, pending: null };
async function everyWorld() {
    if (!MASTER_URL) return localWorlds();
    if (Date.now() - fromMaster.at > 60_000 && !fromMaster.pending) {
        fromMaster.pending = fetchJson(`${MASTER_URL}/world-list.json`, 4_000)
            .then((answer) => { fromMaster.worlds = worldsFrom(answer); }, () => {})
            .finally(() => { fromMaster.at = Date.now(); fromMaster.pending = null; });
    }
    if (fromMaster.worlds === null && fromMaster.pending) await fromMaster.pending;
    return fromMaster.worlds ?? localWorlds();
}

// Which world is this one: the game server beside us says its name, kept a minute (and kept on
// while it restarts).
let own = { name: null, at: 0 };
async function ownWorldName() {
    if (own.name !== null && Date.now() - own.at < 60_000) return own.name;
    try {
        own = { name: String((await fetchJson(LOCAL_STATUS, 2_000))?.name ?? ""), at: Date.now() };
    } catch {
        // Not answering (starting, restarting): what it last said still stands.
    }
    return own.name;
}

/** The list as this world shows it (itself marked), or [] when this world is not on it. */
async function listedWorlds() {
    return listFor(await everyWorld(), await ownWorldName());
}

const worldBoard = createStatusBoard((world) => fetchJson(world.here ? LOCAL_STATUS : `${world.secure ? "https" : "http"}://${world.address}/api/world-status`));

/** Whether the visitor's page is https: an https page may not open an insecure game connection. */
function secureVisitor(request) {
    return request.headers["x-forwarded-proto"] === "https" || String(request.headers["cf-visitor"] ?? "").includes('"scheme":"https"');
}

const WORLD_LIST_PATHS = new Set(["/worlds.json", "/servers.json", "/world-list.json"]);

/**
 * /worlds.json (the landing page), /world-list.json (the bare list, which other worlds ask the
 * master for) and, when this world is on the list, /servers.json (the game's world picker).
 * Resolves to false when the request is for the website (no list: its own servers.json answers).
 */
async function answerWorldList(request, response, pathname) {
    const send = (body, cors = false) => {
        const json = JSON.stringify(body);
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(json),
            "Cache-Control": "public, max-age=15", "Cross-Origin-Resource-Policy": cors ? "cross-origin" : "same-origin" });
        response.end(request.method === "HEAD" ? undefined : json);
    };
    if (pathname === "/world-list.json") {
        send({ worlds: (await everyWorld()).map(({ here, ...world }) => world) }, true);
        return true;
    }
    const worlds = await listedWorlds();
    if (pathname === "/worlds.json") {
        send(await worldBoard(worlds.length > 0 ? worlds : THIS_WORLD).catch(() => ({ worlds: [] })));
        return true;
    }
    if (worlds.length === 0) return false;
    // The world picker of a page on https cannot reach a world without https: it is left out there.
    send(serverList(secureVisitor(request) ? worlds.filter((world) => world.secure) : worlds));
    return true;
}

// Cloudflare's published addresses (https://www.cloudflare.com/ips/): only they, and this
// machine itself (a Cloudflare tunnel runs here), are believed about who the visitor is.
const trusted = new net.BlockList();
for (const range of ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
    "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14",
    "172.64.0.0/13", "131.0.72.0/22", "127.0.0.0/8"]) {
    const [address, prefix] = range.split("/");
    trusted.addSubnet(address, Number(prefix), "ipv4");
}
for (const range of ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32", "::1/128"]) {
    const [address, prefix] = range.split("/");
    trusted.addSubnet(address, Number(prefix), "ipv6");
}

/** The visitor's address: the caller's, or what Cloudflare says when Cloudflare is the caller. */
function visitorAddress(request) {
    const caller = String(request.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const family = net.isIP(caller) === 6 ? "ipv6" : "ipv4";
    const reported = request.headers["cf-connecting-ip"];
    if (net.isIP(caller) && trusted.check(caller, family) && typeof reported === "string" && net.isIP(reported)) return reported;
    return caller;
}

/** The request's headers for the server behind, with the visitor's address as only this proxy may state it. */
function forwardedHeaders(request) {
    const headers = { ...request.headers };
    delete headers["x-real-ip"];
    const address = visitorAddress(request);
    if (net.isIP(address)) headers["x-real-ip"] = address;
    return headers;
}

const ADMIN_PATH = /^\/admin(\/|\?|$)/;
// The master's admin page (deploy/master/server.mjs), on our own server only: a process of its
// own on a private port, started again by itself if it stops. Nothing of a player's is in it.
let masterPort = 0;
async function startMaster() {
    masterPort = Number(process.env.FRONT_MASTER_PORT) || await freePort();
    if (process.env.FRONT_MASTER_PORT) return; // already running there (tests)
    const run = () => {
        // The server's .env holds the panel's keys and the admin password; deploy/settings.env wins over it.
        const master = spawn(process.execPath, [`--env-file-if-exists=${path.join(ROOT, ".env")}`,
            `--env-file-if-exists=${path.join(ROOT, "deploy", "settings.env")}`, path.join(ROOT, "deploy", "master", "server.mjs")], {
            cwd: ROOT,
            env: { ...process.env, MASTER_PORT: String(masterPort), GAME_PORT: String(GAME_PORT) },
            stdio: "inherit",
        });
        master.on("exit", (code) => {
            console.log(`[front] the admin page stopped (exit ${code}); starting it again`);
            setTimeout(run, 3_000).unref();
        });
        for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { master.removeAllListeners("exit"); master.kill(); });
    };
    run();
}

function listen(staticPort) {
    /** Hands the request to the game server, the admin page or the website behind us. */
    const pass = (request, response) => {
        const admin = masterPort > 0 && ADMIN_PATH.test(request.url ?? "");
        const port = admin ? masterPort : GAME_PATH.test(request.url ?? "") ? GAME_PORT : staticPort;
        const headers = forwardedHeaders(request);
        // The admin page sets its cookie Secure on an https visit; only this proxy may say so.
        if (admin) headers["x-forwarded-proto"] = secureVisitor(request) ? "https" : "http";
        const upstream = http.request({ host: LOCAL, port, method: request.method, path: request.url, headers }, (answer) => {
            response.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(response);
        });
        upstream.on("error", () => {
            if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
            response.end(admin ? "The admin page is not answering. It may be starting." : port === GAME_PORT ? "The game server is not answering. It may be restarting." : "The website is not answering.");
        });
        response.on("close", () => upstream.destroy());
        request.pipe(upstream);
    };
    const server = http.createServer((request, response) => {
        const pathname = String(request.url ?? "").split("?")[0];
        if ((request.method === "GET" || request.method === "HEAD") && WORLD_LIST_PATHS.has(pathname)) {
            // The world list: ours to answer, unless this world is on no list (then the website's own file).
            answerWorldList(request, response, pathname).then(
                (answered) => { if (!answered) pass(request, response); },
                () => { if (!response.headersSent) pass(request, response); },
            );
            return;
        }
        pass(request, response);
    });

    // The game connection: hand the request to the game server as it came and join the two sockets.
    server.on("upgrade", (request, socket, head) => {
        const game = net.connect(GAME_PORT, LOCAL);
        const close = () => { socket.destroy(); game.destroy(); };
        game.on("error", close);
        socket.on("error", close);
        game.on("connect", () => {
            const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
            for (const [name, value] of Object.entries(forwardedHeaders(request))) {
                for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
            }
            game.setNoDelay(true);
            socket.setNoDelay(true);
            game.write(`${lines.join("\r\n")}\r\n\r\n`);
            if (head.length) game.write(head);
            socket.pipe(game);
            game.pipe(socket);
        });
        socket.on("close", () => game.destroy());
        game.on("close", () => socket.destroy());
    });

    server.keepAliveTimeout = 30_000;
    server.listen(PORT, HOST, () => console.log(`[front] http://${HOST}:${PORT}: website on ${staticPort}, game on ${GAME_PORT}`));
}

/** A port nothing is using on this machine. */
function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on("error", reject);
        probe.listen(0, LOCAL, () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

if (IS_MASTER) await startMaster();
if (process.env.FRONT_STATIC_PORT) {
    listen(Number(process.env.FRONT_STATIC_PORT));
} else {
    const staticPort = await freePort();
    const client = path.join(ROOT, "client");
    const website = spawn(process.execPath, ["scripts/serve-build.mjs"], {
        cwd: client,
        env: { ...process.env, PORT: String(staticPort), HOST: LOCAL },
        stdio: "inherit",
    });
    // One service: if the website stops, so does this, and systemd starts both again.
    website.on("exit", (code) => process.exit(code ?? 1));
    for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { website.kill(); process.exit(0); });
    listen(staticPort);
}
