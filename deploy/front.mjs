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
 *   /sync/...                        -> the same process: its worlds' shared characters
 *                                       (deploy/master/characters.mjs), for worlds with its key
 *   /quest-helper/...                -> on the master: Quest Helper's engine, which runs here once
 *                                       for every world (deploy/quest-helper.mjs), for worlds
 *                                       with its key
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
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { timingSafeEqual } from "node:crypto";

import { listedFrom } from "./master/registry.mjs";
import { BRIDGE_MAX_BODY, BRIDGE_PATH, BRIDGE_PORT, BRIDGE_ROUTES, questHelperToken } from "./quest-helper.mjs";
import { masterResetId } from "./reset-accounts.mjs";
import { createStatusBoard, fetchJson, listFor, loadWorlds, masterRoute, serverList, signVisitor, throughMaster, verifyVisitor, VISITOR_HEADER, worldsFrom } from "./worlds.mjs";

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
const REGISTRY_FILE = path.join(ROOT, "server", "data", "saves", "master", "master-worlds.json");
const MASTER_URL = /^https?:\/\/[^\s/]+$/.test(String(process.env.WORLDS_MASTER_URL ?? "").replace(/\/+$/, "")) && !IS_MASTER
    ? String(process.env.WORLDS_MASTER_URL).replace(/\/+$/, "") : "";
const LOCAL_STATUS = `http://${LOCAL}:${GAME_PORT}/api/world-status`;
/** With no list, this world alone: its name comes from the game server's own answer. */
const THIS_WORLD = [{ id: "here", name: "", address: "localhost", secure: false, here: true, description: "" }];

/**
 * A master that runs no world of its own (MASTER_ONLY=1 in deploy/settings.env): the website,
 * the admin page and the carrying of every world's connections, and nothing else. Its bare
 * address (/play, /hiscores, /api) is then the default world's: the one picked on the admin
 * page, or the first on the list. The game server beside us is parked (deploy/run.sh).
 */
const MASTER_ONLY = IS_MASTER && process.env.MASTER_ONLY === "1";

const stampOf = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
/** The admin page's file: its worlds, and the default world picked there. */
function adminList() {
    if (!IS_MASTER) return { worlds: [], defaultId: "" };
    try {
        const kept = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
        return { worlds: listedFrom(kept.worlds ?? []), defaultId: typeof kept.default === "string" ? kept.default : "" };
    } catch {
        return { worlds: [], defaultId: "" };
    }
}
let listed = { worlds: [], defaultId: "", stamp: "", checked: 0 };
/** The project's list and, on the master, the admin page's: a world of the same id is listed once. */
function localWorlds() {
    if (Date.now() - listed.checked > 5_000) {
        const stamp = `${stampOf(WORLDS_FILE)}|${IS_MASTER ? stampOf(REGISTRY_FILE) : 0}`;
        if (stamp !== listed.stamp) {
            const project = loadWorlds(WORLDS_FILE);
            const ids = new Set(project.map((world) => world.id));
            const admin = adminList();
            listed = { worlds: [...project, ...admin.worlds.filter((world) => !ids.has(world.id))], defaultId: admin.defaultId, stamp, checked: Date.now() };
        } else {
            listed.checked = Date.now();
        }
    }
    return listed.worlds;
}

/** On a master with no world of its own: the world its bare address plays, or null when none is listed. */
function defaultWorld() {
    if (!MASTER_ONLY) return null;
    const worlds = localWorlds();
    return worlds.find((world) => world.id === listed.defaultId) ?? worlds[0] ?? null;
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
    // A master with no world of its own lists every world, and none of them is "here".
    if (MASTER_ONLY) return localWorlds();
    return listFor(await everyWorld(), await ownWorldName());
}

// Links to a world played through the master go to the master's own /play: here when we are it,
// at its address when we know it.
const worldBoard = createStatusBoard(
    (world) => fetchJson(world.here ? LOCAL_STATUS : `${world.secure ? "https" : "http"}://${world.address}/api/world-status`),
    undefined, IS_MASTER ? "" : MASTER_URL || undefined);

/** Whether the visitor's page is https: an https page may not open an insecure game connection. */
function secureVisitor(request) {
    return request.socket?.encrypted === true || request.headers["x-forwarded-proto"] === "https" || String(request.headers["cf-visitor"] ?? "").includes('"scheme":"https"');
}

// https of our own (FRONT_TLS_CERT and FRONT_TLS_KEY, two PEM files): a world on a panel node
// answers at the node's own name with the node's own certificate, so a page on https can connect
// to it directly. Files that cannot be read (the node does not show them to the world) leave the
// world on plain http, where its master carries it. A renewed certificate is taken up within the hour.
const TLS_FILES = { cert: String(process.env.FRONT_TLS_CERT ?? "").trim(), key: String(process.env.FRONT_TLS_KEY ?? "").trim() };
function readCertificate() {
    if (!TLS_FILES.cert || !TLS_FILES.key) return null;
    try {
        return { cert: fs.readFileSync(TLS_FILES.cert), key: fs.readFileSync(TLS_FILES.key), stamp: `${fs.statSync(TLS_FILES.cert).mtimeMs}|${fs.statSync(TLS_FILES.key).mtimeMs}` };
    } catch (error) {
        console.log(`[front] no https here: ${error.code ?? error.message} reading ${error.path ?? "the certificate"}. Answering on plain http; the master carries this world.`);
        return null;
    }
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
        // With the list, the master's word on a fresh start (deploy/reset-accounts.mjs): its worlds apply it as they start.
        send({ worlds: (await everyWorld()).map(({ here, ...world }) => world), ...(IS_MASTER ? { accountsReset: masterResetId(ROOT) } : {}) }, true);
        return true;
    }
    const worlds = await listedWorlds();
    const standard = defaultWorld();
    if (pathname === "/worlds.json") {
        const board = await worldBoard(worlds.length > 0 ? worlds : MASTER_ONLY ? [] : THIS_WORLD).catch(() => ({ worlds: [] }));
        // The default world of a master with none of its own is played at the bare /play.
        if (standard) board.worlds = board.worlds.map((world) => (world.id === standard.id ? { ...world, home: "/play", play: "/play", hiscores: "/hiscores", default: true } : world));
        send(board);
        return true;
    }
    if (worlds.length === 0) return false;
    // On the master, a world with no https of its own is listed at the master's address, which
    // carries it (/w/<id>). Elsewhere, a page on https cannot reach such a world: it is left out.
    const site = IS_MASTER ? { host: String(request.headers.host ?? ""), secure: secureVisitor(request) } : null;
    const reachable = secureVisitor(request) ? worlds.filter((world) => world.secure || (site && throughMaster(world))) : worlds;
    // The default world is listed at the bare address, which is also where the game client looks
    // before a world is picked: one entry for it, not two.
    // A world keeps its number (its place on the whole list) on a page that cannot list them all.
    send(serverList(reachable, site, (world) => worlds.indexOf(world) + 1).map((entry, index) => (standard && reachable[index].id === standard.id ? { ...entry, address: site.host, secure: site.secure } : entry)));
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

// The key the master signs a visitor's address with for the worlds it carries (worlds.mjs
// signVisitor). The master's is made by its admin page (deploy/master/server.mjs) and kept in
// its folder; a world is given the same key as MASTER_PROXY_KEY and believes only what it signs.
const PROXY_KEY_FILE = process.env.FRONT_PROXY_KEY_FILE || path.join(ROOT, "server", "data", "saves", "master", "proxy-key"); // the env: tests
const OWN_PROXY_KEY = IS_MASTER ? "" : String(process.env.MASTER_PROXY_KEY ?? "").trim();
let masterKey = { key: "", checked: 0 };
function proxyKey() {
    if (Date.now() - masterKey.checked > 10_000) {
        let key = "";
        try { key = fs.readFileSync(PROXY_KEY_FILE, "utf8").trim(); } catch {}
        masterKey = { key, checked: Date.now() };
    }
    return masterKey.key;
}

/**
 * The visitor's address: the caller's; what Cloudflare says when Cloudflare is the caller; or, on
 * a world the master carries connections to, what the master signed.
 */
function visitorAddress(request) {
    const stated = OWN_PROXY_KEY ? verifyVisitor(request.headers[VISITOR_HEADER], OWN_PROXY_KEY) : null;
    if (stated && net.isIP(stated)) return stated;
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
    delete headers[VISITOR_HEADER];
    const address = visitorAddress(request);
    if (net.isIP(address)) headers["x-real-ip"] = address;
    return headers;
}

/**
 * On the master, a /w/<id>... address: the listed world it means and the rest of the address.
 * { world: null } for an id that is not on the list; null when the address is not one of these.
 */
async function carried(url) {
    const route = IS_MASTER ? masterRoute(url) : null;
    if (!route) return null;
    return { world: (await listedWorlds()).find((world) => world.id === route[0]) ?? null, rest: route[1] };
}

/** The request's headers for a world the master carries it to: its own host, and the visitor's address, signed. */
function carriedHeaders(request, world) {
    const headers = forwardedHeaders(request);
    const visitor = headers["x-real-ip"];
    // Only the signed header says who the visitor is; nothing of Cloudflare's or ours is passed on.
    for (const name of Object.keys(headers)) if (/^(x-real-ip|x-forwarded-|cf-|cdn-loop|cookie$)/.test(name)) delete headers[name];
    headers.host = world.address;
    const key = proxyKey();
    if (key && visitor) headers[VISITOR_HEADER] = signVisitor(visitor, key);
    return headers;
}

function worldTarget(world) {
    const [host, port] = world.address.split(":");
    return { host, port: Number(port) || (world.secure ? 443 : 80) };
}

// /admin is the admin page; /sync/ is where the master's worlds hand in and fetch their
// characters (deploy/master/characters.mjs). Both are the master's own process.
const ADMIN_PATH = /^\/(admin(\/|\?|$)|sync\/)/;
// Quest Helper's engine beside us (deploy/quest-helper.mjs); FRONT_QUEST_HELPER_PORT is for tests.
const QUEST_HELPER_PORT = Number(process.env.FRONT_QUEST_HELPER_PORT) || Number(process.env.QUEST_HELPER_PORT) || BRIDGE_PORT;
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

/** Whether the website we started has ever answered: one that has is started again when it stops; one that never did has failed to start. */
let websiteAnswered = false;

/** `staticPort`: the website's private port, or 0 on a headless world (no website of its own). */
function listen(staticPort) {
    const refuse = (response, status, message) => {
        if (!response.headersSent) response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(message);
    };
    /** Hands the request to the game server, the admin page or the website behind us. */
    const pass = (request, response, url = request.url) => {
        const admin = masterPort > 0 && ADMIN_PATH.test(url ?? "");
        const game = GAME_PATH.test(url ?? "");
        if (!admin && !game && staticPort === 0) {
            // A headless world: its game and its /api, and nothing to look at. The master has the site.
            if (MASTER_URL) { response.writeHead(302, { Location: `${MASTER_URL}/` }); return response.end(); }
            return refuse(response, 404, "This world has no website of its own.");
        }
        const port = admin ? masterPort : game ? GAME_PORT : staticPort;
        const headers = forwardedHeaders(request);
        // The admin page sets its cookie Secure on an https visit; only this proxy may say so.
        if (admin) headers["x-forwarded-proto"] = secureVisitor(request) ? "https" : "http";
        const upstream = http.request({ host: LOCAL, port, method: request.method, path: url, headers }, (answer) => {
            if (port === staticPort) websiteAnswered = true;
            response.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(response);
        });
        upstream.on("error", () => refuse(response, 502, admin ? "The admin page is not answering. It may be starting." : port === GAME_PORT ? "The game server is not answering. It may be restarting." : "The website is not answering."));
        response.on("close", () => upstream.destroy());
        request.pipe(upstream);
    };
    /** The master, carrying a world's /api (and nothing else of it) at /w/<id>/api... */
    const carry = (request, response, { world, rest }) => {
        if (!world) return refuse(response, 404, "There is no such world.");
        if (!GAME_PATH.test(rest)) return refuse(response, 404, "Not found.");
        if (world.here) return pass(request, response, rest);
        const upstream = (world.secure ? https : http).request({ ...worldTarget(world), method: request.method, path: rest, headers: carriedHeaders(request, world), timeout: 20_000 }, (answer) => {
            response.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(response);
        });
        upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
        upstream.on("error", () => refuse(response, 502, "That world is not answering. It may be starting."));
        response.on("close", () => upstream.destroy());
        request.pipe(upstream);
    };
    /**
     * The master, answering its worlds' game servers for Quest Helper's engine, which runs here
     * once for all of them (deploy/quest-helper.mjs) and listens on this machine only. A caller
     * without the token made from the worlds' shared key is turned away here, before the engine
     * (two requests at a time is all it takes) hears of it.
     */
    const questHelper = (request, response, route) => {
        if (!BRIDGE_ROUTES.has(route)) return refuse(response, 404, "Not found.");
        if (route !== "/health") {
            const expected = Buffer.from(`Bearer ${questHelperToken(proxyKey())}`);
            const given = Buffer.from(String(request.headers.authorization ?? ""));
            if (expected.length <= "Bearer ".length || given.length !== expected.length || !timingSafeEqual(given, expected)) return refuse(response, 401, "{}");
        }
        if (Number(request.headers["content-length"] ?? 0) > BRIDGE_MAX_BODY) return refuse(response, 413, "{}");
        const headers = {};
        for (const name of ["authorization", "content-type", "content-length", "transfer-encoding"]) {
            if (request.headers[name] !== undefined) headers[name] = request.headers[name];
        }
        const upstream = http.request({ host: LOCAL, port: QUEST_HELPER_PORT, method: request.method, path: route, headers, timeout: 20_000 }, (answer) => {
            response.writeHead(answer.statusCode ?? 502, { "Content-Type": answer.headers["content-type"] ?? "application/json", "Cache-Control": "no-store" });
            answer.pipe(response);
        });
        upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
        upstream.on("error", () => refuse(response, 503, "Quest Helper's engine is not answering on the master. It may be starting, or still being built."));
        response.on("close", () => upstream.destroy());
        request.pipe(upstream);
    };
    let certificate = readCertificate();
    const server = (certificate ? https : http).createServer(certificate ? { cert: certificate.cert, key: certificate.key } : {}, (request, response) => {
        const pathname = String(request.url ?? "").split("?")[0];
        if (IS_MASTER && pathname.startsWith(`${BRIDGE_PATH}/`)) return questHelper(request, response, pathname.slice(BRIDGE_PATH.length));
        if ((request.method === "GET" || request.method === "HEAD") && WORLD_LIST_PATHS.has(pathname)) {
            // The world list: ours to answer, unless this world is on no list (then the website's own file).
            answerWorldList(request, response, pathname).then(
                (answered) => { if (!answered) pass(request, response); },
                () => { if (!response.headersSent) pass(request, response); },
            );
            return;
        }
        if (IS_MASTER && pathname.startsWith("/w/")) {
            carried(request.url).then(
                (route) => (route ? carry(request, response, route) : pass(request, response)),
                () => refuse(response, 502, "The world list is not answering."),
            );
            return;
        }
        if (MASTER_ONLY && GAME_PATH.test(request.url ?? "")) {
            // No world of our own: the bare address's /api is the default world's.
            const world = defaultWorld();
            return world ? carry(request, response, { world, rest: request.url }) : refuse(response, 503, "No world is running yet.");
        }
        pass(request, response);
    });

    /** Joins the visitor's socket to a game server's, after sending it the request that asked for it. */
    const join = (request, socket, head, game, url, headers, ready = "connect") => {
        const close = () => { socket.destroy(); game.destroy(); };
        game.on("error", close);
        socket.on("error", close);
        game.on(ready, () => {
            const lines = [`${request.method} ${url} HTTP/${request.httpVersion}`];
            for (const [name, value] of Object.entries(headers)) {
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
    };
    // The game connection: hand the request to the game server as it came and join the two
    // sockets. On the master, /w/<id> is the game connection of that world, wherever it runs.
    server.on("upgrade", (request, socket, head) => {
        const local = (url = request.url) => join(request, socket, head, net.connect(GAME_PORT, LOCAL), url, forwardedHeaders(request));
        const remote = (world, url) => {
            const target = worldTarget(world);
            if (world.secure) join(request, socket, head, tls.connect({ ...target, servername: target.host }), url, carriedHeaders(request, world), "secureConnect");
            else join(request, socket, head, net.connect(target), url, carriedHeaders(request, world));
        };
        if (IS_MASTER && String(request.url ?? "").startsWith("/w/")) {
            socket.on("error", () => socket.destroy());
            carried(request.url).then((route) => {
                if (socket.destroyed) return;
                if (!route) return MASTER_ONLY ? socket.destroy() : local();
                if (!route.world) return socket.destroy();
                if (route.world.here) return local(route.rest);
                remote(route.world, route.rest);
            }, () => socket.destroy());
            return;
        }
        if (MASTER_ONLY) {
            // No world of our own: the bare address's game connection is the default world's.
            const world = defaultWorld();
            if (!world) return socket.destroy();
            return remote(world, request.url);
        }
        local();
    });

    if (certificate) {
        // A renewed certificate, without a restart (which would drop every player).
        setInterval(() => {
            try {
                const stamp = `${fs.statSync(TLS_FILES.cert).mtimeMs}|${fs.statSync(TLS_FILES.key).mtimeMs}`;
                if (stamp === certificate.stamp) return;
                const renewed = readCertificate();
                if (!renewed) return;
                server.setSecureContext({ cert: renewed.cert, key: renewed.key });
                certificate = renewed;
                console.log("[front] the renewed certificate is in use");
            } catch {}
        }, 3_600_000).unref();
    }
    server.keepAliveTimeout = 30_000;
    server.listen(PORT, HOST, () => console.log(`[front] ${certificate ? "https" : "http"}://${HOST}:${PORT}: ${staticPort ? `website on ${staticPort}` : "no website (headless)"}, game on ${GAME_PORT}${IS_MASTER ? ", master" : MASTER_URL ? `, master at ${MASTER_URL}` : ""}`));
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
} else if (process.env.FRONT_HEADLESS === "1") {
    // A world played on the master's site: no website is built or served here.
    listen(0);
} else {
    const staticPort = await freePort();
    const client = path.join(ROOT, "client");
    // The website is started again by itself when it stops, as the admin page is. This process
    // used to stop with it, and every game connection carried here, to every world, went too:
    // for a fault in serving a static file. A website that stops before it has answered anything
    // has not started (nothing built, a fault in its own file): then this stops too, as before,
    // so that systemd starts both again and the updater sees a port that does not stay open.
    let website = null;
    const startWebsite = () => {
        website = spawn(process.execPath, ["scripts/serve-build.mjs"], {
            cwd: client,
            env: { ...process.env, PORT: String(staticPort), HOST: LOCAL },
            stdio: "inherit",
        });
        website.on("exit", (code) => {
            if (!websiteAnswered) process.exit(code ?? 1);
            console.log(`[front] the website stopped (exit ${code}); starting it again`);
            setTimeout(startWebsite, 3_000).unref();
        });
    };
    startWebsite();
    for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { website.removeAllListeners("exit"); website.kill(); process.exit(0); });
    listen(staticPort);
}
