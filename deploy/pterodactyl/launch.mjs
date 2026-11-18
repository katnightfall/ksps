#!/usr/bin/env node
/**
 * What a Pterodactyl server of this game runs (deploy/pterodactyl/egg-kat-net-tsps.json).
 *
 *   node deploy/pterodactyl/launch.mjs             update, prepare, then run the world
 *   node deploy/pterodactyl/launch.mjs --prepare   packages and builds only (the egg's install script)
 *
 * One container, one port: the game server and the website's front door (deploy/front.mjs) are
 * started here, and the front door answers on the server's port (SERVER_PORT) with the website,
 * the game connection and the game's /api addresses. The game's own port stays inside the
 * container.
 *
 * Everything is set by the egg's variables (the environment). deploy/settings.env is NOT read:
 * it holds our own server's settings (its developers, its public address), which must never
 * reach somebody else's world. A `.env` file in the server's folder is read, for anything the
 * egg has no variable for (see .env.example); a variable set in the panel wins over it.
 *
 *   AUTO_UPDATE       1: `git pull` before starting. What changed is rebuilt (the website takes minutes).
 *   REBUILD           1: build everything again on this start, whatever changed.
 *   WORLD_NAME        the world's name; also the name on the login screen's server button.
 *   WORLD_DESCRIPTION a line about the world.
 *   XP_RATE           experience multiplier (1 is OSRS).
 *   BOT_COUNT         how many levelling bots walk the world; 0 turns every bot off.
 *   DEV_USERNAME      accounts that are developers, comma-separated.
 *   PUBLIC_WS_URL     where players reach the game from outside (wss://play.example.com), for a world list.
 *   GAME_HEAP_MB      the game's memory in MB; by default 70% of the server's (SERVER_MEMORY).
 *
 * The world's settings above are written to server/data/definitions/world.local.json, which the
 * game lays over world.json. Only the keys set here are touched; a variable left empty gives its
 * key back to world.json.
 *
 * Stopping: "stop" typed on the console (the egg's stop command), or the container's stop
 * signal. The game is asked to shut down, saves every player, and only then does this exit.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BRIDGE_PATH, questHelperToken } from "../quest-helper.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE_FILE = path.join(ROOT, ".egg-state.json");
const WORLD_FILE = path.join(ROOT, "server/data/definitions/world.json");
const WORLD_LOCAL_FILE = path.join(ROOT, "server/data/definitions/world.local.json");
const SITES_KEY = "PlayerBots:sites";
/** The game's own port, inside the container. */
const GAME_PORT = 43594;
/** The game saves and exits with this code when its settings page asks for a restart. */
const RESTART_CODE = 75;
export const READY_LINE = "[egg] The world is online";
const DEFAULT_HEAP_MB = 8192;

const say = (text) => console.log(`[egg] ${text}`);

// ---- settings: pure, tested in server/tests/pterodactyl-egg.test.cjs -------------------------------

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * `sites` with its levelling crowds' numbers scaled so that they come to `total` in all. Each
 * mode keeps its share; the rounding is settled on the largest shares, so the sum is exact.
 * A crowd scaled to nothing is turned off. Sites that are not crowds are left as they are.
 */
export function scaleBotSites(sites, total) {
    const crowds = Object.entries(sites ?? {}).filter(([, site]) => site?.progression === true && site.bots && typeof site.bots === "object");
    const counts = crowds.flatMap(([id, site]) => Object.entries(site.bots)
        .filter(([, count]) => Number.isInteger(count) && count > 0).map(([mode, count]) => ({ id, mode, count })));
    const now = counts.reduce((sum, entry) => sum + entry.count, 0);
    if (now === 0) return sites;
    const shares = counts.map((entry) => ({ ...entry, exact: (entry.count * total) / now }));
    for (const share of shares) share.scaled = Math.floor(share.exact);
    let left = total - shares.reduce((sum, share) => sum + share.scaled, 0);
    for (const share of [...shares].sort((a, b) => (b.exact - b.scaled) - (a.exact - a.scaled))) {
        if (left <= 0) break;
        share.scaled++;
        left--;
    }
    const scaled = structuredClone(sites);
    for (const [id] of crowds) {
        const mine = shares.filter((share) => share.id === id);
        for (const share of mine) scaled[id].bots[share.mode] = share.scaled;
        if (mine.every((share) => share.scaled === 0)) scaled[id].enabled = false;
    }
    return scaled;
}

/**
 * world.local.json for the egg's variables. `existing` is the file as it is (the owner's own
 * keys are kept), `managed` the keys this wrote last time (one whose variable is now empty is
 * given back to world.json), `world` is world.json. Returns the new file and the keys now managed.
 */
export function worldSettings(env, world = {}, existing = {}, managed = []) {
    const local = structuredClone(existing ?? {});
    const plugins = { ...(local.pluginConfig ?? {}) };
    for (const key of managed) {
        if (key.startsWith("pluginConfig.")) delete plugins[key.slice("pluginConfig.".length)];
        else delete local[key];
    }
    const now = [];
    const set = (key, value) => { local[key] = value; now.push(key); };
    if (text(env.WORLD_NAME)) set("name", text(env.WORLD_NAME));
    if (text(env.WORLD_DESCRIPTION)) set("description", text(env.WORLD_DESCRIPTION));
    const rate = Number(text(env.XP_RATE));
    if (text(env.XP_RATE) && Number.isFinite(rate) && rate > 0) set("experienceMultiplier", rate);
    const bots = Number(text(env.BOT_COUNT));
    const sites = world.pluginConfig?.[SITES_KEY];
    if (text(env.BOT_COUNT) && Number.isInteger(bots) && bots >= 0 && sites) {
        plugins[SITES_KEY] = scaleBotSites(sites, bots);
        now.push(`pluginConfig.${SITES_KEY}`);
    }
    if (Object.keys(plugins).length > 0) local.pluginConfig = plugins;
    else delete local.pluginConfig;
    return { local, managed: now };
}

/** The game's memory: what is asked for, else 70% of the server's, else the project's own default. */
export function heapMb(env) {
    const asked = Number(text(env.GAME_HEAP_MB));
    if (Number.isInteger(asked) && asked >= 512) return asked;
    const server = Number(text(env.SERVER_MEMORY));
    if (Number.isInteger(server) && server > 0) return Math.max(1024, Math.floor(server * 0.7));
    return DEFAULT_HEAP_MB;
}

/**
 * What the game is started with, over the environment it is given. `ownSettings`: the text of
 * the server's own .env files, for the settings that a line there keeps from being set here.
 */
export function gameEnv(env, ownSettings = "") {
    const game = {
        ...env,
        WEBSOCKET_PORT: String(GAME_PORT),
        TSPS_SUPERVISED: "1",
        // The switches of start:prod in server/package.json (deploy/run.sh keeps the same list).
        BOT_RUNTIME_EVENT_LOGGING: "0", BOT_RUNTIME_TELEMETRY_ENABLED: "0", BOT_TASK_PROFILER_ENABLED: "0",
        TASK_SLOW_WARN_ENABLED: "0", PROJECTILE_DEBUG: "0", MAGIC_CAST_DEBUG: "0",
    };
    // An empty variable is "not set": the .env file, or the game's own default, decides.
    for (const key of ["DEV_USERNAME", "WORLD_WEBSOCKET_URL"]) if (!text(game[key])) delete game[key];
    if (text(env.PUBLIC_WS_URL)) game.WORLD_WEBSOCKET_URL = text(env.PUBLIC_WS_URL);
    if (text(env.BOT_COUNT) === "0") game.DISABLE_PLAYER_BOTS = "1";
    // Quest Helper's engine is a Java program, and there is no Java here. A world of a master
    // asks the master's (deploy/quest-helper.mjs), under a token made from the key the two
    // already share. A world told of an engine of its own, in the panel or its .env, keeps it.
    for (const key of ["QUEST_HELPER_URL", "QUEST_HELPER_TOKEN"]) if (!text(game[key])) delete game[key];
    const master = text(env.WORLDS_MASTER_URL).replace(/\/+$/, "");
    const own = game.QUEST_HELPER_URL || game.QUEST_HELPER_TOKEN || /^\s*QUEST_HELPER_(URL|TOKEN|PORT)\s*=\s*\S/m.test(ownSettings);
    if (!own && /^https?:\/\/[^\s/]+$/.test(master) && text(env.MASTER_PROXY_KEY)) {
        game.QUEST_HELPER_URL = `${master}${BRIDGE_PATH}`;
        game.QUEST_HELPER_TOKEN = questHelperToken(text(env.MASTER_PROXY_KEY));
    }
    return game;
}

/** What the website is built with. A change to any of it rebuilds the website. */
export function clientBuildEnv(env) {
    const build = {
        // The site is the whole address (package.json mounts it at /play, where rsps.app serves it).
        PUBLIC_URL: "/",
        // The game answers on the page's own address (deploy/front.mjs): one port is all there is.
        REACT_APP_SAME_ORIGIN_GAME: "true",
    };
    if (text(env.WORLD_NAME)) build.REACT_APP_DEFAULT_SERVER_NAME = text(env.WORLD_NAME);
    return build;
}

/**
 * A website build that fits a container (client/craco.config.js reads the first two). Left
 * alone a build peaks near 7 GB over all its processes, and the more processors the node has
 * the more it takes: the type checker runs in a process of its own and the minifiers start a
 * helper per processor. With these it is one process peaking a little over 2 GB (both measured
 * on a cold build), and what is built is the same. Types and lint are checked where the project
 * is developed, not on every server that runs it.
 */
export const FRUGAL_BUILD = {
    TSPS_BUILD_SKIP_TYPECHECK: "1",
    TSPS_BUILD_WORKERS: "0",
    DISABLE_ESLINT_PLUGIN: "true",
};

// ---- what needs building ---------------------------------------------------------------------------

function fileHash(...files) {
    const hash = createHash("sha1");
    for (const file of files) {
        try { hash.update(fs.readFileSync(path.join(ROOT, file))); } catch { hash.update("-"); }
    }
    return hash.digest("hex");
}

function git(...args) {
    const run = spawnSync("git", ["-c", "safe.directory=*", ...args], { cwd: ROOT, encoding: "utf8" });
    return run.status === 0 ? run.stdout.trim() : null;
}

/** What each step was last done for; a step is due when its mark differs (or its output is missing). */
function marks(env) {
    const tree = (dir) => git("rev-parse", `HEAD:${dir}`) ?? "no-git";
    const reactLines = Object.entries(env).filter(([key]) => key.startsWith("REACT_APP_")).sort().map(([key, value]) => `${key}=${value}`);
    return {
        serverPackages: fileHash("server/package.json", "server/yarn.lock"),
        clientPackages: fileHash("client/package.json", "client/yarn.lock"),
        serverBuild: `${tree("server/src")}:${fileHash("server/tsconfig.json")}`,
        // The website's build also takes three files of the server's (client/craco.config.js).
        clientBuild: [tree("client"), fileHash("server/plugins/world/ContinuousMotion.FreeMovement.js", "server/plugins/items/BlightedItems.js",
            "server/plugins/items/data/food.json", "scripts/run-with-env.mjs", ".env"), JSON.stringify(clientBuildEnv(env)), ...reactLines].join(":"),
    };
}

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function run(label, cwd, command, args, env = process.env) {
    say(`${label}...`);
    // npm is a .cmd file on Windows (a local try-out), which only a shell can start.
    const done = spawnSync(command, args, { cwd, env, stdio: "inherit", shell: command.endsWith(".cmd") });
    if (done.status !== 0) throw new Error(`${label} failed (exit ${done.status ?? done.signal}).`);
}

function prepare(env) {
    const state = readJson(STATE_FILE, {});
    const now = marks(env);
    const all = text(env.REBUILD) === "1";
    const save = (key) => { state[key] = now[key]; fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); };
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    // What a build may take: 70% of the server's memory, between 1 and 4 GB (4 GB on a server with no limit).
    const serverMb = Number(text(env.SERVER_MEMORY));
    const buildHeap = Number.isInteger(serverMb) && serverMb > 0 ? Math.max(1024, Math.min(4096, Math.floor(serverMb * 0.7))) : 4096;

    // A headless world (HEADLESS=1) is played on its master's site: no website is installed or built.
    const headless = text(env.HEADLESS) === "1";
    for (const pkg of headless ? ["server"] : ["server", "client"]) {
        const key = `${pkg}Packages`;
        if (!all && state[key] === now[key] && fs.existsSync(path.join(ROOT, pkg, "node_modules"))) continue;
        // The Yarn version the project pins, fetched through npm (as `npm run setup` does).
        const yarn = readJson(path.join(ROOT, pkg, "package.json"), {}).packageManager?.split("@")[1]?.split("+")[0] ?? "4.12.0";
        run(`Installing the ${pkg} packages (a few minutes)`, path.join(ROOT, pkg), npm,
            ["exec", "--yes", "--package", `@yarnpkg/cli-dist@${yarn}`, "--", "yarn", "install", "--immutable"]);
        save(key);
        // New packages: what was built with the old ones is built again.
        delete state[`${pkg}Build`];
    }
    if (all || state.serverBuild !== now.serverBuild || !fs.existsSync(path.join(ROOT, "server/dist/Server.js"))) {
        run("Building the game server", path.join(ROOT, "server"), process.execPath, [`--max-old-space-size=${buildHeap}`, "node_modules/typescript/bin/tsc", "--build"]);
        save("serverBuild");
    }
    if (!headless && (all || state.clientBuild !== now.clientBuild || !fs.existsSync(path.join(ROOT, "client/build/index.html")))) {
        const buildEnv = { ...env, ...clientBuildEnv(env), ...FRUGAL_BUILD, NODE_OPTIONS: `--max-old-space-size=${buildHeap}` };
        run("Building the website (several minutes)", path.join(ROOT, "client"), process.execPath,
            ["../scripts/run-with-env.mjs", "production", "./node_modules/@craco/craco/dist/bin/craco.js", "build"], buildEnv);
        run("Compressing the website's files", path.join(ROOT, "client"), process.execPath, ["scripts/serve-build.mjs", "--precompress"]);
        save("clientBuild");
    }
}

/** Files of the project the game rewrites as it runs: no edit of the owner's, so not kept over an update. */
const REWRITTEN_BY_THE_GAME = ["server/plugins/bots/data/object-index.json"];

/**
 * Brings the copy in `root` up to its branch's newest version, when that only adds to what is
 * here. Files of the project the owner has edited are put aside (git stash) and put back over
 * the new version; where the same lines changed on both sides the new version's file is kept
 * and the owner's edits stay in the stash, never half-merged into a file the game then reads.
 * Returns "none" (no git), "current", "updated", "updated-edits-stashed", "diverged" or "failed".
 */
export function updateProject(root, log = say) {
    if (!fs.existsSync(path.join(root, ".git"))) { log("No git folder here, so there is nothing to update from."); return "none"; }
    const run = (...args) => spawnSync("git", ["-c", "safe.directory=*", "-c", "user.name=egg", "-c", "user.email=egg@localhost", ...args],
        { cwd: root, encoding: "utf8" });
    const out = (...args) => { const done = run(...args); return done.status === 0 ? done.stdout.trim() : null; };
    const lastLine = (done) => String(done.stderr ?? "").trim().split(/\r?\n/).pop();
    const before = out("rev-parse", "HEAD");
    const fetched = run("fetch", "--quiet");
    if (fetched.status !== 0) { log(`The newest version could not be fetched (${lastLine(fetched)}); starting the version already here.`); return "failed"; }
    const newest = out("rev-parse", "@{u}");
    if (!newest) { log("This copy follows no branch to update from; starting the version already here."); return "failed"; }
    if (newest === before) { log("Already the newest version."); return "current"; }
    if (run("merge-base", "--is-ancestor", "HEAD", "@{u}").status !== 0) {
        log("This copy has changes of its own committed, or the project's history was rewritten: not updating. Reinstall the server to fetch the project afresh (saves are kept).");
        return "diverged";
    }
    for (const file of REWRITTEN_BY_THE_GAME) if (fs.existsSync(path.join(root, file))) run("checkout", "-q", "--", file);
    const edited = (out("status", "--porcelain", "--untracked-files=no") ?? "") !== "";
    if (edited && run("stash", "push", "-q", "-m", "egg: edits put aside for an update").status !== 0) {
        log("Your edits to the project's files could not be put aside; starting the version already here.");
        return "failed";
    }
    const merged = run("merge", "--ff-only", "-q", "@{u}");
    if (merged.status !== 0) {
        if (edited) run("stash", "pop", "-q");
        log(`The update did not go through (${lastLine(merged)}); starting the version already here.`);
        return "failed";
    }
    let result = "updated";
    if (edited && run("stash", "pop", "-q").status !== 0) {
        // The same lines changed on both sides. The new version's files are kept whole.
        run("reset", "-q", "--hard");
        result = "updated-edits-stashed";
        log("Some of your edits to the project's files could not be put back over the new version. The new version is running; your edits are kept aside: \"git stash show -p\" shows them.");
    }
    log(`Updated to ${out("rev-parse", "--short=9", "HEAD")}.`);
    return result;
}

/** Whether the update brought a new version (and so, perhaps, a new launcher). */
function update(env) {
    if (text(env.AUTO_UPDATE) !== "1" || env.EGG_UPDATED === "1") return false;
    return updateProject(ROOT).startsWith("updated");
}

/**
 * Temporary files go on the server's own disk. A panel container's /tmp is a small memory disk
 * (100 MB by default, in the install container too), and installing the packages unpacks far
 * more than that through the temporary folder: "ENOSPC: no space left on device" with the
 * server's disk nearly empty. The folder is emptied at every start.
 */
export function useDiskForTemporaryFiles(env, root = ROOT) {
    const folder = path.join(root, ".egg-tmp");
    fs.rmSync(folder, { recursive: true, force: true });
    fs.mkdirSync(folder, { recursive: true });
    for (const name of ["TMPDIR", "TMP", "TEMP"]) env[name] = folder;
    return folder;
}

function writeWorld(env) {
    const state = readJson(STATE_FILE, {});
    const { local, managed } = worldSettings(env, readJson(WORLD_FILE, {}), readJson(WORLD_LOCAL_FILE, {}), state.worldKeys ?? []);
    if (Object.keys(local).length > 0) fs.writeFileSync(WORLD_LOCAL_FILE, `${JSON.stringify(local, null, 2)}\n`);
    else fs.rmSync(WORLD_LOCAL_FILE, { force: true });
    state.worldKeys = managed;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---- running ---------------------------------------------------------------------------------------

function start(env) {
    const port = Number(text(env.SERVER_PORT)) || 3000;
    // A world of a master applies the master's fresh start, if it called one, before the game
    // opens its saves (deploy/reset-accounts.mjs: moved aside, never deleted; a world with no
    // master is never reset).
    if (text(env.WORLDS_MASTER_URL)) {
        spawnSync(process.execPath, [path.join(ROOT, "deploy/reset-accounts.mjs"), "--from-master", text(env.WORLDS_MASTER_URL), "--world", text(env.WORLD_NAME)], { cwd: ROOT, stdio: "inherit", timeout: 30_000 });
    }
    let stopping = false;
    let game = null;
    // The .env files the game reads (below): what is set there is the owner's own.
    const ownSettings = [".env", "server/.env"].map((file) => { try { return fs.readFileSync(path.join(ROOT, file), "utf8"); } catch { return ""; } }).join("\n");
    const startGame = () => {
        game = spawn(process.execPath, ["--env-file-if-exists=../.env", "--env-file-if-exists=.env",
            `--max-old-space-size=${heapMb(env)}`, "--max-semi-space-size=16", "./dist/Server.js"],
        { cwd: path.join(ROOT, "server"), env: gameEnv(env, ownSettings), stdio: ["ignore", "inherit", "inherit"] });
        game.on("exit", (code, signal) => {
            if (!stopping && code === RESTART_CODE) { say("The game asked to be started again."); startGame(); return; }
            if (!stopping) say(`The game server stopped (${signal ?? `exit ${code}`}).`);
            front.kill();
            process.exit(stopping ? 0 : code ?? 1);
        });
    };
    const front = spawn(process.execPath, [path.join(ROOT, "deploy/front.mjs")], {
        cwd: path.join(ROOT, "client"),
        // WORLDS_MASTER_URL (a world in a group): the front door asks that master for the list of worlds.
        env: { ...env, PORT: String(port), HOST: "0.0.0.0", GAME_PORT: String(GAME_PORT), CACHE_DIR: path.join(ROOT, "server/caches"),
            WORLDS_MASTER_URL: text(env.WORLDS_MASTER_URL),
            // Headless: the game and its /api only. MASTER_PROXY_KEY: the master's word on who a visitor is.
            FRONT_HEADLESS: text(env.HEADLESS) === "1" ? "1" : "", MASTER_PROXY_KEY: text(env.MASTER_PROXY_KEY),
            // https at the node's own name, when the node shows the world its certificate.
            FRONT_TLS_CERT: text(env.TLS_CERT), FRONT_TLS_KEY: text(env.TLS_KEY) },
        stdio: ["ignore", "inherit", "inherit"],
    });
    front.on("exit", (code) => {
        if (stopping) return;
        say(`The website stopped (exit ${code}); stopping the game too.`);
        stop();
    });
    startGame();

    function stop() {
        if (stopping) return;
        stopping = true;
        say("Stopping: the game is saving every player...");
        // The game's own shutdown: it saves, then exits (the exit handler above ends this).
        game.kill("SIGTERM");
        setTimeout(() => { say("The game did not stop in two minutes; ending it."); game.kill("SIGKILL"); }, 120_000).unref();
    }
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { if (/^\s*(stop|end|exit)\s*$/im.test(chunk)) stop(); });
    process.stdin.on("error", () => {});

    // The panel shows the server as running once this line is printed.
    if (!fs.existsSync(path.join(ROOT, "server/caches"))) say("The first start downloads the game cache (about 250 MB), so it takes a while longer.");
    const waitForGame = setInterval(async () => {
        try {
            // Asked of the game server itself: the front door may be answering on https.
            const answer = await fetch(`http://127.0.0.1:${GAME_PORT}/api/world-info`, { signal: AbortSignal.timeout(2000) });
            if (!answer.ok) return;
            clearInterval(waitForGame);
            console.log(`${READY_LINE}: ${text(env.HEADLESS) === "1" ? "the game answers" : "the website and the game answer"} on port ${port}.`);
        } catch { /* not up yet */ }
    }, 2000);
    waitForGame.unref();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    // process.env itself: everything started from here (packages, builds, the game) takes it.
    const env = process.env;
    try {
        useDiskForTemporaryFiles(env);
        if (process.argv.includes("--prepare")) {
            prepare(env);
            say("Packages and builds are ready.");
        } else if (update(env)) {
            // The update may have changed this file: the rest of the start is the new version's.
            say("Starting with the updated version...");
            const again = spawn(process.execPath, process.argv.slice(1), { stdio: "inherit", env: { ...env, EGG_UPDATED: "1" } });
            for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => again.kill(signal));
            again.on("exit", (code) => process.exit(code ?? 1));
        } else {
            prepare(env);
            writeWorld(env);
            start(env);
        }
    } catch (error) {
        console.error(`[egg] ${error.message}`);
        process.exit(1);
    }
}
