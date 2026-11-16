#!/usr/bin/env node
/**
 * The one public web port of our server (3000): the website, the game connection and the game's
 * data addresses all answer on it, so a single address (https://rs.kat-net.us through
 * Cloudflare, or http://<server>:3000) is all a browser needs.
 *
 *   a WebSocket                      -> the game server (the game connection)
 *   /api/..., /regions..., /gateway/ -> the game server (hiscores, world info, map data)
 *   /worlds.json, /servers.json      -> answered here: the worlds we list and who is on them
 *                                       (deploy/worlds.mjs), for the landing page and the
 *                                       game's world picker
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
 * project's folder; without it this world is the only one), FRONT_STATIC_PORT (a website already
 * running on that port, for tests; by default the website is started here).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStatusBoard, fetchJson, loadWorlds, serverList } from "./worlds.mjs";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const GAME_PORT = Number(process.env.GAME_PORT) || 43594;
const LOCAL = "127.0.0.1";
const GAME_PATH = /^\/(api|regions|gateway)(\/|\?|$)/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The worlds we list. The file is read again when it changes, so a new world needs no restart
// here (a restart of this front door drops every player's connection).
const WORLDS_FILE = process.env.WORLDS_FILE ? path.resolve(ROOT, process.env.WORLDS_FILE) : "";
/** With no list, this world alone: its name comes from the game server's own answer. */
const THIS_WORLD = [{ id: "here", name: "", address: "localhost", secure: false, here: true, description: "" }];
let listed = { worlds: loadWorlds(WORLDS_FILE), stamp: -1, checked: 0 };
function listedWorlds() {
    if (WORLDS_FILE && Date.now() - listed.checked > 5_000) {
        let stamp = 0;
        try { stamp = fs.statSync(WORLDS_FILE).mtimeMs; } catch {}
        listed = stamp === listed.stamp ? { ...listed, checked: Date.now() } : { worlds: loadWorlds(WORLDS_FILE), stamp, checked: Date.now() };
    }
    return listed.worlds;
}
const worldBoard = createStatusBoard((world) => fetchJson(world.here
    ? `http://${LOCAL}:${GAME_PORT}/api/world-status`
    : `${world.secure ? "https" : "http"}://${world.address}/api/world-status`));

/** /worlds.json and, when we list worlds, /servers.json. False when the request is not one of them. */
function answerWorldList(request, response) {
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    const pathname = String(request.url ?? "").split("?")[0];
    if (pathname !== "/worlds.json" && pathname !== "/servers.json") return false;
    const worlds = listedWorlds();
    const send = (body) => {
        const json = JSON.stringify(body);
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(json),
            "Cache-Control": "public, max-age=15", "Cross-Origin-Resource-Policy": "same-origin" });
        response.end(request.method === "HEAD" ? undefined : json);
    };
    if (pathname === "/worlds.json") {
        worldBoard(worlds.length > 0 ? worlds : THIS_WORLD).then(send, () => send({ worlds: [] }));
        return true;
    }
    // Without a list of ours the website's own servers.json answers, as before.
    if (worlds.length === 0) return false;
    send(serverList(worlds));
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

function listen(staticPort) {
    const server = http.createServer((request, response) => {
        if (answerWorldList(request, response)) return;
        const port = GAME_PATH.test(request.url ?? "") ? GAME_PORT : staticPort;
        const upstream = http.request({ host: LOCAL, port, method: request.method, path: request.url, headers: forwardedHeaders(request) }, (answer) => {
            response.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(response);
        });
        upstream.on("error", () => {
            if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
            response.end(port === GAME_PORT ? "The game server is not answering. It may be restarting." : "The website is not answering.");
        });
        response.on("close", () => upstream.destroy());
        request.pipe(upstream);
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
