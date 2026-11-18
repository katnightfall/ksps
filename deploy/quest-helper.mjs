#!/usr/bin/env node
/**
 * Ours. Quest Helper's engine, for a master and every world of it.
 *
 * The Quest Helper panel in the game is driven by the real Quest Helper's Java code, run by a
 * small program of the original project's (tools/quest-helper-bridge, "the bridge"). A game
 * server with no bridge to ask tells the player "Quest Helper token is not configured on the
 * server". Our worlds run in Node-only containers on the panel's nodes, with no Java, so the
 * bridge runs once, here on the master, and every world asks it through the master's website:
 *
 *   world's game server --https--> <master>/quest-helper/... (deploy/front.mjs) --> the bridge
 *                                                                                  on 127.0.0.1
 *
 * Nothing to set up and no new secret: the token is made from the key the master and its
 * worlds already share (the proxy key), on both sides (deploy/pterodactyl/launch.mjs hands a
 * world of a master the address and the token by itself).
 *
 *   node deploy/quest-helper.mjs          fetch what is missing, build, run, and keep it running
 *
 * It needs nothing installed: a JDK 21 (Eclipse Temurin, checksum checked) and the pinned
 * Quest Helper source are downloaded, and the bridge is built with the Gradle wrapper it ships
 * with. All of that lives in QUEST_HELPER_WORK (by default "quest-helper" in the home folder of
 * the user this runs as), outside the project's folder, so no deploy copies or removes it. A new
 * version of the bridge (a deploy that changes tools/quest-helper-bridge) is noticed, built
 * beside the running one and swapped in. The first build takes some minutes; later starts are
 * immediate.
 *
 * Env: QUEST_HELPER_WORK, QUEST_HELPER_PORT (16471), QUEST_HELPER_HEAP_MB (2048),
 * QUEST_HELPER_JAVA_HOME or JAVA_HOME (a JDK 21 to use instead of downloading one),
 * QUEST_HELPER_TOKEN (a token of your own instead of the one made from the proxy key).
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_SOURCE = path.join(ROOT, "tools", "quest-helper-bridge");
const PROXY_KEY_FILE = path.join(ROOT, "server", "data", "saves", "master", "proxy-key");

/** Where the master's website answers for the bridge, and the bridge's own port beside it. */
export const BRIDGE_PATH = "/quest-helper";
export const BRIDGE_PORT = 16471;
/** The bridge's four addresses; nothing else is passed on to it. */
export const BRIDGE_ROUTES = new Set(["/health", "/catalog", "/evaluate", "/close"]);
/** What the bridge takes in one request (BridgeServer.java), and so what the website passes on. */
export const BRIDGE_MAX_BODY = 4 * 1024 * 1024;
const JAVA_VERSION = 21;

// ---- pure: tested in server/tests/quest-helper-master.test.cjs --------------------------------------

/**
 * The token a master's bridge and its worlds use, made from the key they already share. One
 * way only: the token does not give the key away, and the key is never sent to the bridge.
 */
export function questHelperToken(proxyKey) {
    const key = String(proxyKey ?? "").trim();
    return key ? crypto.createHmac("sha256", key).update("quest-helper-bridge").digest("hex") : "";
}

/** The Quest Helper commit the bridge is written against, as its build file names it. */
export function pinnedCommit(buildGradle) {
    const commits = new Set(String(buildGradle ?? "").match(/\b[0-9a-f]{40}\b/g) ?? []);
    return commits.size === 1 ? [...commits][0] : null;
}

/** Folders of the bridge's that are made by building it, or are a developer's own checkout. */
const NOT_SOURCE = new Set(["build", ".gradle", "bin", "quest-helper-upstream", "node_modules"]);

/** Every file of the bridge's own source under `folder`, as sorted paths with forward slashes. */
export function sourceFiles(folder) {
    const files = [];
    const walk = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (prefix === "" && NOT_SOURCE.has(entry.name)) continue;
            const name = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(path.join(dir, entry.name), name);
            else if (entry.isFile()) files.push(name);
        }
    };
    walk(folder, "");
    return files.sort();
}

/** What a build of the bridge is named after: it changes when any file of its source does. */
export function sourceKey(folder) {
    const hash = crypto.createHash("sha1");
    for (const file of sourceFiles(folder)) {
        hash.update(`${file}\0`);
        hash.update(fs.readFileSync(path.join(folder, file)));
        hash.update("\0");
    }
    return hash.digest("hex").slice(0, 16);
}

/** How the JDK's download service names this machine, or null where no download is offered here. */
export function jdkPlatform(platform = process.platform, arch = process.arch) {
    const system = { linux: "linux", win32: "windows" }[platform];
    const processor = { x64: "x64", arm64: "aarch64" }[arch];
    return system && processor ? { os: system, architecture: processor } : null;
}

/** The major version in what `java -version` prints, or 0. */
export function javaMajor(versionOutput) {
    const found = /version "(\d+)(?:\.(\d+))?/.exec(String(versionOutput ?? ""));
    if (!found) return 0;
    return Number(found[1]) === 1 ? Number(found[2] ?? 0) : Number(found[1]);
}

/** How long to wait before starting a bridge again that has stopped `times` times in a row. */
export function restartDelay(times) {
    return Math.min(60_000, 5_000 * 2 ** Math.max(0, Math.min(times, 6) - 1));
}

// ---- fetching and building --------------------------------------------------------------------------

const say = (text) => console.log(`[quest-helper] ${text}`);
const exe = (name) => (process.platform === "win32" ? `${name}.exe` : name);

/** Windows' own tar reads .zip as well as .tar.gz; Git Bash's, earlier on the PATH, does not. */
function tar() {
    const own = process.platform === "win32" && path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    return own && fs.existsSync(own) ? own : "tar";
}

async function download(url, file, sha256 = null) {
    const answer = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20 * 60_000) });
    if (!answer.ok || !answer.body) throw new Error(`${url} answered ${answer.status}`);
    const hash = crypto.createHash("sha256");
    const part = `${file}.part`;
    await pipeline(Readable.fromWeb(answer.body), async function* (chunks) {
        for await (const chunk of chunks) { hash.update(chunk); yield chunk; }
    }, fs.createWriteStream(part));
    const got = hash.digest("hex");
    if (sha256 && got !== sha256) {
        fs.rmSync(part, { force: true });
        throw new Error(`${path.basename(file)} is not the file its checksum describes`);
    }
    fs.renameSync(part, file);
}

/** Unpacks `archive` (its one top folder dropped) into `folder`, which is whole or not there. */
function unpack(archive, folder) {
    const making = `${folder}.making`;
    fs.rmSync(making, { recursive: true, force: true });
    fs.mkdirSync(making, { recursive: true });
    const done = spawnSync(tar(), ["-xf", archive, "-C", making, "--strip-components=1"], { stdio: ["ignore", "inherit", "inherit"] });
    if (done.status !== 0) {
        fs.rmSync(making, { recursive: true, force: true });
        throw new Error(`${path.basename(archive)} could not be unpacked`);
    }
    fs.rmSync(folder, { recursive: true, force: true });
    fs.renameSync(making, folder);
}

function javaIn(home) {
    if (!home) return 0;
    const java = path.join(home, "bin", exe("java"));
    if (!fs.existsSync(java)) return 0;
    const asked = spawnSync(java, ["-version"], { encoding: "utf8" });
    return javaMajor(`${asked.stderr ?? ""}${asked.stdout ?? ""}`);
}

/** A JDK 21: one named in the environment, the one fetched before, or a fresh download. */
async function ensureJava(work, env) {
    for (const home of [env.QUEST_HELPER_JAVA_HOME, env.JAVA_HOME]) {
        if (javaIn(home) === JAVA_VERSION) return home;
    }
    const home = path.join(work, `jdk-${JAVA_VERSION}`);
    if (javaIn(home) === JAVA_VERSION) return home;
    const platform = jdkPlatform();
    if (!platform) throw new Error(`no JDK ${JAVA_VERSION} is offered for this machine (${process.platform} ${process.arch}); install one and set QUEST_HELPER_JAVA_HOME`);
    say(`Fetching a JDK ${JAVA_VERSION} (Eclipse Temurin, about 200 MB)...`);
    const listed = await fetch(`https://api.adoptium.net/v3/assets/latest/${JAVA_VERSION}/hotspot?architecture=${platform.architecture}&image_type=jdk&os=${platform.os}&vendor=eclipse`,
        { signal: AbortSignal.timeout(30_000) });
    if (!listed.ok) throw new Error(`the JDK's download service answered ${listed.status}`);
    const pack = (await listed.json())?.[0]?.binary?.package;
    if (!pack?.link || !/^[0-9a-f]{64}$/.test(pack.checksum ?? "") || !/^[\w.+-]+$/.test(pack.name ?? "")) throw new Error("the JDK's download service named no file");
    const archive = path.join(work, pack.name);
    await download(pack.link, archive, pack.checksum);
    unpack(archive, home);
    fs.rmSync(archive, { force: true });
    if (javaIn(home) !== JAVA_VERSION) throw new Error("the JDK that was fetched does not run here");
    return home;
}

/** The Quest Helper source at the pinned commit, as GitHub serves that commit. */
async function ensureSource(work, commit) {
    const folder = path.join(work, `source-${commit}`);
    if (fs.existsSync(path.join(folder, "src", "main", "java"))) return folder;
    say(`Fetching Quest Helper's source (${commit.slice(0, 7)})...`);
    const archive = path.join(work, `source-${commit}.tar.gz`);
    await download(`https://codeload.github.com/Zoinkwiz/quest-helper/tar.gz/${commit}`, archive);
    unpack(archive, folder);
    fs.rmSync(archive, { force: true });
    if (!fs.existsSync(path.join(folder, "src", "main", "java"))) throw new Error("Quest Helper's source did not unpack as expected");
    return folder;
}

/** The built bridge's folder of jars for the source as it is now, building it when there is none. */
async function ensureBuild(work, env) {
    const key = sourceKey(BRIDGE_SOURCE);
    const folder = path.join(work, `build-${key}`);
    const lib = path.join(folder, "build", "install", "offline-quest-helper-bridge", "lib");
    const java = await ensureJava(work, env);
    if (fs.existsSync(path.join(folder, ".built")) && fs.existsSync(lib)) return { key, lib, java };

    const commit = pinnedCommit(fs.readFileSync(path.join(BRIDGE_SOURCE, "build.gradle"), "utf8"));
    if (!commit) throw new Error("tools/quest-helper-bridge/build.gradle does not name one Quest Helper commit");
    const source = await ensureSource(work, commit);
    fs.rmSync(folder, { recursive: true, force: true });
    for (const file of sourceFiles(BRIDGE_SOURCE)) {
        fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
        fs.copyFileSync(path.join(BRIDGE_SOURCE, file), path.join(folder, file));
    }
    say("Building the bridge (the first build downloads Gradle and RuneLite's libraries: several minutes)...");
    // The Gradle wrapper, started as its own script starts it. The build's check that the source
    // is a git checkout at the pinned commit is left out: the source here is that commit's
    // archive, fetched by its hash, and this machine may have no git.
    const built = await new Promise((resolve) => {
        const gradle = spawn(path.join(java, "bin", exe("java")), ["-Xmx64m", "-Dorg.gradle.appname=gradlew",
            "-classpath", path.join(folder, "gradle", "wrapper", "gradle-wrapper.jar"), "org.gradle.wrapper.GradleWrapperMain",
            "installDist", "-x", "verifyPinnedSource", "--no-daemon", "--console=plain", "--quiet"], {
            cwd: folder,
            env: { ...env, JAVA_HOME: java, GRADLE_USER_HOME: path.join(work, "gradle"), QUEST_HELPER_SOURCE: source },
            stdio: ["ignore", "inherit", "inherit"],
        });
        const limit = setTimeout(() => gradle.kill("SIGKILL"), 45 * 60_000);
        gradle.on("error", () => { clearTimeout(limit); resolve(false); });
        gradle.on("exit", (code) => { clearTimeout(limit); resolve(code === 0); });
    });
    if (!built || !fs.existsSync(lib)) throw new Error("the bridge did not build (what Gradle said is above)");
    fs.writeFileSync(path.join(folder, ".built"), `${new Date().toISOString()}\n`);
    // Builds and sources of earlier versions.
    for (const entry of fs.readdirSync(work)) {
        const old = (entry.startsWith("build-") && entry !== `build-${key}`) || (entry.startsWith("source-") && entry !== `source-${commit}`);
        if (old) fs.rmSync(path.join(work, entry), { recursive: true, force: true });
    }
    say("The bridge is built.");
    return { key, lib, java };
}

// ---- running ----------------------------------------------------------------------------------------

/** The token the bridge is started with: one set by hand, else the one made from the proxy key. */
function tokenNow(env) {
    const own = String(env.QUEST_HELPER_TOKEN ?? "").trim();
    if (own.length >= 24) return own;
    try { return questHelperToken(fs.readFileSync(PROXY_KEY_FILE, "utf8")); } catch { return ""; }
}

async function main() {
    const env = process.env;
    const work = path.resolve(env.QUEST_HELPER_WORK || path.join(os.homedir(), "quest-helper"));
    const port = Number(env.QUEST_HELPER_PORT) || BRIDGE_PORT;
    const heap = Number(env.QUEST_HELPER_HEAP_MB) || 2048;
    fs.mkdirSync(work, { recursive: true });

    let bridge = null;      // the running process
    let running = null;     // { key, token } it was started for
    let stopping = false;
    let failures = 0;
    let waitUntil = 0;
    let lastProblem = "";

    const start = (build, token) => {
        const started = Date.now();
        const child = spawn(path.join(build.java, "bin", exe("java")), ["-Djava.awt.headless=true", `-Xmx${heap}m`,
            "-cp", path.join(build.lib, "*"), "local.questbridge.BridgeServer"], {
            env: { ...env, JAVA_HOME: build.java, QUEST_HELPER_TOKEN: token, QUEST_HELPER_PORT: String(port) },
            stdio: ["ignore", "inherit", "inherit"],
        });
        bridge = child;
        running = { key: build.key, token };
        say(`The bridge is starting on 127.0.0.1:${port} (version ${build.key}).`);
        const gone = (why) => {
            if (bridge !== child) return;
            bridge = null;
            running = null;
            if (stopping) return;
            failures = Date.now() - started > 60_000 ? 1 : failures + 1;
            waitUntil = Date.now() + restartDelay(failures);
            say(`The bridge stopped (${why}); starting it again in ${Math.round(restartDelay(failures) / 1000)} s.`);
        };
        child.on("error", (error) => gone(error.message));
        child.on("exit", (code, signal) => gone(signal ?? `exit ${code}`));
    };

    /** One look: is the right bridge running; if not, make it so. */
    const look = async () => {
        if (stopping || Date.now() < waitUntil) return;
        try {
            const token = tokenNow(env);
            if (!token) throw new Error("the master has no proxy key yet (its admin page makes one when it first starts); waiting for it");
            const build = await ensureBuild(work, env);
            if (stopping) return;
            if (bridge && running.key === build.key && running.token === token) return;
            if (bridge) {
                say(running.key === build.key ? "The key changed: starting the bridge again with the new token." : "A new version of the bridge is built: swapping it in.");
                const old = bridge;
                bridge = null;
                running = null;
                await new Promise((resolve) => { old.once("exit", resolve); old.kill(); setTimeout(resolve, 10_000).unref(); });
            }
            start(build, token);
            lastProblem = "";
        } catch (error) {
            // Said once per problem, not every look.
            if (error.message !== lastProblem) say(`Not running: ${error.message}.`);
            lastProblem = error.message;
            if (!bridge) waitUntil = Date.now() + 60_000;
        }
    };

    for (const signal of ["SIGTERM", "SIGINT"]) {
        process.on(signal, () => {
            stopping = true;
            bridge?.kill();
            process.exit(0);
        });
    }
    let looking = false;
    const tick = async () => {
        if (looking) return;
        looking = true;
        try { await look(); } finally { looking = false; }
    };
    await tick();
    // Soon after a stop; and every look also notices a new version or a changed key.
    setInterval(tick, 15_000);
}

const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && same(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) main();
