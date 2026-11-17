#!/usr/bin/env node
/**
 * The master's admin page as a process of its own, started by the front door (deploy/front.mjs)
 * on our own server only (deploy/run.sh sets MASTER_ADMIN=1) and reached through it at /admin.
 * It listens on this machine alone. Should it stop, the front door starts it again; no player's
 * connection is touched by that.
 *
 * Settings, from the server's .env (secrets) and deploy/settings.env:
 *   MASTER_ADMIN_PASSWORD   12 characters or more; without it the page says how to turn it on
 *   MASTER_PUBLIC_URL       the master's own address, which new worlds are told (https://rs.kat-net.us)
 *   PTERO_URL, PTERO_APP_KEY, PTERO_CLIENT_KEY and the optional ones: deploy/master/panel.mjs
 *   MASTER_PORT, GAME_PORT  set by the front door
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStatusBoard, fetchJson, loadWorlds } from "../worlds.mjs";
import { createAdmin, MIN_PASSWORD } from "./admin.mjs";
import { createPanel, panelSettings } from "./panel.mjs";
import { createRegistry } from "./registry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const LOCAL = "127.0.0.1";
const PORT = Number(process.env.MASTER_PORT) || 0;
const GAME_PORT = Number(process.env.GAME_PORT) || 43594;
/**
 * A folder of its own beside the player saves: never sent, replaced or rolled back by a deploy.
 * The website's service may write nowhere else (deploy/tsps-web.service names it), and the game
 * server makes the folder when it starts (deploy/run.sh).
 */
export const DATA_DIR = path.join(ROOT, "server", "data", "saves", "master");
export const REGISTRY_FILE = path.join(DATA_DIR, "master-worlds.json");

/** Why worlds cannot be saved here, or null when they can. */
function storageProblem() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const probe = path.join(DATA_DIR, `.write-test-${process.pid}`);
        fs.writeFileSync(probe, "");
        fs.rmSync(probe, { force: true });
        return null;
    } catch (error) {
        return `This page cannot save its worlds: ${DATA_DIR} is not writable (${error.code ?? error.message}). On our server, install the current service file once: sudo cp /opt/tsps/deploy/tsps-web.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart tsps-web`;
    }
}
const storage = storageProblem();

/** What signs the sign-ins: made once, kept in the folder, readable by this user only. Without the folder, one for this run. */
function sessionSecret() {
    const file = path.join(DATA_DIR, "master-secret");
    try {
        const kept = fs.readFileSync(file, "utf8").trim();
        if (kept.length >= 32) return kept;
    } catch {}
    const made = crypto.randomBytes(32).toString("hex");
    if (!storage) fs.writeFileSync(file, `${made}\n`, { mode: 0o600 });
    return made;
}

/**
 * The key the master signs each visitor's address with for the worlds it carries game
 * connections to (deploy/worlds.mjs signVisitor; the front door reads this file). Every world
 * made here is given it; made once, kept in the folder.
 */
function proxyKey() {
    const file = path.join(DATA_DIR, "proxy-key");
    try {
        const kept = fs.readFileSync(file, "utf8").trim();
        if (kept.length >= 32) return kept;
    } catch {}
    if (storage) return "";
    const made = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, `${made}\n`, { mode: 0o600 });
    return made;
}

const password = String(process.env.MASTER_ADMIN_PASSWORD ?? "");
const publicUrl = String(process.env.MASTER_PUBLIC_URL ?? "").replace(/\/+$/, "");
const settings = panelSettings(process.env);
const worldsFile = path.resolve(ROOT, process.env.WORLDS_FILE || "deploy/worlds.json");

// The world beside us is asked directly; the others at their own addresses.
let ownName = null;
const localStatus = `http://${LOCAL}:${GAME_PORT}/api/world-status`;
const statusBoard = createStatusBoard(async (world) => {
    if (ownName === null) ownName = await fetchJson(localStatus, 2_000).then((answer) => String(answer?.name ?? ""), () => null);
    return fetchJson(ownName !== null && world.world === ownName ? localStatus : `${world.secure ? "https" : "http"}://${world.address}/api/world-status`);
});

// Whether a world answers on https at its address, asked at most every two minutes per address.
const httpsSeen = new Map();
async function answersHttps(address) {
    const kept = httpsSeen.get(address);
    if (kept && Date.now() - kept.at < 120_000) return kept.ok;
    const ok = await fetchJson(`https://${address}/api/world-status`, 2_500).then(() => true, () => false);
    httpsSeen.set(address, { at: Date.now(), ok });
    return ok;
}

const registry = createRegistry(REGISTRY_FILE);
// A world made here that has started answering on https at its node's name is listed there from
// then on, whether or not anyone has the admin page open.
setInterval(async () => {
    if (storage) return;
    for (const record of registry.all()) {
        if (record.panel && record.secure === false && await answersHttps(record.address)) registry.update(record.id, { secure: true });
    }
}, 60_000).unref();

const handle = createAdmin({
    answersHttps,
    password,
    secret: sessionSecret(),
    registry,
    storage,
    proxyKey: proxyKey(),
    projectWorlds: () => loadWorlds(worldsFile),
    panel: createPanel(settings),
    settings,
    publicUrl,
    statusOf: statusBoard,
    page: path.join(HERE, "admin.html"),
});

http.createServer((request, response) => { handle(request, response); }).listen(PORT, LOCAL, function listening() {
    const notes = [
        password.length >= MIN_PASSWORD ? null : `off until MASTER_ADMIN_PASSWORD (${MIN_PASSWORD}+ characters) is set`,
        settings.configured ? null : `the panel is not set up (${settings.missing.join(", ")})`,
        publicUrl ? null : "MASTER_PUBLIC_URL is not set, so new worlds will not know the master",
        storage,
    ].filter(Boolean);
    console.log(`[master] the admin page is on ${LOCAL}:${this.address().port}${notes.length ? `: ${notes.join("; ")}` : ""}`);
});
