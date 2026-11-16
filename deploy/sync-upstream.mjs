#!/usr/bin/env node
// Keeps this copy up to date with the project it was forked from, with our own changes kept.
//
//   npm run sync                    fetch the original project, merge what is new into ours,
//                                   check the result, then commit, push and deploy it
//   npm run sync -- --check         only say how far behind we are
//   npm run sync -- --no-deploy     stop after the push
//   npm run sync -- --verify        only run the checks on the folder as it is
//   npm run sync -- --schedule 05:00    run it every day at that time on this PC (Windows)
//   npm run sync -- --unschedule    stop the daily run
//
// Nothing leaves this PC unless every check passes. A merge git cannot make by itself, a build
// that fails or a server that does not start puts the folder back as it was and says why; the
// live server and the fork are then untouched. See deploy/README.txt.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const UPSTREAM = { remote: "upstream", url: "https://github.com/RSPSApp/tsps", branch: "main" };
export const OURS = { remote: "origin", branch: "main" };
export const TASK_NAME = "Kat-Net TSPS upstream sync";

// Written by a script from the code: the other side's copy is taken and the file is made again.
export const GENERATED = ["docs/world-configuration.md"];
// Our own pictures: ours are kept whatever the original project does to its own.
export const KEEP_OURS = [/^client\/public\/favicon\//, /^server\/plugins\/tools\/worldadmin\/panel\/favicon/];
// Rewritten by the bots and their tests when they run; never part of a change of ours.
export const SCRATCH = "server/plugins/bots/data/object-index.json";
// A change to one of these means the packages must be installed again before building.
export const PACKAGE_FILES = /^(?:(?:server\/|client\/)?(?:package\.json|yarn\.lock)|\.yarnrc\.yml|server\/\.yarnrc\.yml)$/;
// Lines a starting server must not print.
export const TRIAL_ERRORS = /TypeError|ReferenceError|SyntaxError|RangeError|hook failed|Unhandled|Cannot find module|no valid plugins/;

export function git(root, args, options = {}) {
    const run = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
    return { ok: run.status === 0, out: (run.stdout ?? "").trim(), err: (run.stderr ?? "").trim() };
}

function lines(text) {
    return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * Is the folder in a state a merge may start from? Returns why not, or null.
 */
export function notReady(root) {
    const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
    if (branch !== OURS.branch) return `the folder is on branch '${branch}', not '${OURS.branch}'`;
    const gitDir = path.resolve(root, git(root, ["rev-parse", "--git-dir"]).out);
    if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) return "a merge is already under way in the folder";
    const changed = lines(git(root, ["status", "--porcelain"]).out);
    if (changed.length > 0) {
        return `there are changes that are not committed (${changed.slice(0, 3).map((line) => line.replace(/^\S{1,2}\s+/, "")).join(", ")}${changed.length > 3 ? ", ..." : ""})`;
    }
    return null;
}

/**
 * Fetches the original project and merges what is new into the folder, without committing.
 * Returns { result, ... }:
 *   "current"   nothing new
 *   "merged"    merged and staged: commits (how many), resolved (files settled by rule), changed
 *   "conflict"  both sides changed the same lines of `files`; the folder is back as it was
 *   "failed"    git could not do it (`reason`); the folder is back as it was
 */
export function mergeUpstream(root, log = () => {}) {
    if (!git(root, ["remote", "get-url", UPSTREAM.remote]).ok) {
        git(root, ["remote", "add", UPSTREAM.remote, UPSTREAM.url]);
    }
    const fetched = git(root, ["fetch", "--quiet", UPSTREAM.remote, UPSTREAM.branch]);
    if (!fetched.ok) return { result: "failed", reason: `could not fetch the original project: ${fetched.err.split("\n").pop()}` };
    const theirs = git(root, ["rev-parse", "FETCH_HEAD"]).out;
    const commits = Number(git(root, ["rev-list", "--count", `HEAD..${theirs}`]).out);
    if (!(commits > 0)) return { result: "current" };

    log(`The original project has ${commits} new commit${commits === 1 ? "" : "s"}. Merging...`);
    const merge = git(root, ["merge", "--no-ff", "--no-commit", theirs]);
    const resolved = [];
    if (!merge.ok) {
        const conflicted = lines(git(root, ["diff", "--name-only", "--diff-filter=U"]).out);
        const open = [];
        for (const file of conflicted) {
            const side = GENERATED.includes(file) ? "--theirs" : KEEP_OURS.some((rule) => rule.test(file)) ? "--ours" : null;
            // A file one side deleted has no copy to take on that side: left for a person.
            if (side && git(root, ["checkout", side, "--", file]).ok && git(root, ["add", "--", file]).ok) resolved.push(file);
            else open.push(file);
        }
        if (open.length > 0 || conflicted.length === 0) {
            git(root, ["merge", "--abort"]);
            return open.length > 0
                ? { result: "conflict", commits, files: open }
                : { result: "failed", reason: `git could not merge: ${(merge.err || merge.out).split("\n").pop()}` };
        }
    }
    const changed = lines(git(root, ["diff", "--cached", "--name-only", "HEAD"]).out);
    return { result: "merged", commits, resolved, changed, theirs };
}

/** Puts the folder back as it was before mergeUpstream. */
export function undoMerge(root) {
    git(root, ["checkout", "--", SCRATCH]);
    return git(root, ["merge", "--abort"]).ok;
}

/** The tests that are ours: in our copy and not in the original project's. */
export function ourTests(root, theirs) {
    const added = lines(git(root, ["diff", "--name-only", "--diff-filter=A", theirs, "HEAD", "--", "server/tests", "client/tests"]).out);
    return {
        server: added.filter((file) => /^server\/tests\/[^/]+\.test\.cjs$/.test(file)).map((file) => file.slice("server/".length)),
        client: added.filter((file) => /^client\/tests\/[^/]+\.test\.ts$/.test(file)).map((file) => path.basename(file, ".test.ts")),
    };
}

/** What a trial start of the server printed: null when it is healthy, or what is wrong. */
export function trialVerdict(status, output) {
    if (status !== 0) return `the server stopped with code ${status}`;
    if (!/\[plugins\] active=\d+/.test(output)) return "the plugins did not load";
    if (!/websocket listening/.test(output)) return "the server never opened its port";
    const bad = output.split("\n").filter((line) => TRIAL_ERRORS.test(line));
    if (bad.length > 0) return `the server printed errors while starting (${bad.length}), the first: ${bad[0].trim().slice(0, 200)}`;
    const failedSaves = /savePlayers[^\n]*failed=([1-9]\d*)/.exec(output);
    if (failedSaves) return `${failedSaves[1]} players could not be saved on shutdown`;
    return null;
}

export function commitMessage(merged) {
    const settled = merged.resolved.length > 0
        ? `. Settled by rule: ${merged.resolved.map((file) => (GENERATED.includes(file) ? `${file} (generated, made again)` : `${file} (ours kept)`)).join(", ")}`
        : "";
    return `Merge upstream (RSPSApp/tsps) main: ${merged.commits} commit${merged.commits === 1 ? "" : "s"}, by deploy/sync-upstream.mjs${settled}`;
}

// ---------------------------------------------------------------------------------------------

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, ...options });
    return { status: result.status ?? 1, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`, error: result.error };
}

function tail(text, count = 15) {
    return text.split("\n").filter((line) => line.trim()).slice(-count).map((line) => `    ${line.slice(0, 240)}`).join("\n");
}

/** Starts the merged server on a scratch save file with a handful of bots, and stops it. */
function trialStart(root, seconds) {
    const server = path.join(root, "server");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tsps-sync-"));
    const local = path.join(server, "data", "definitions", "world.local.json");
    const kept = fs.existsSync(local) ? fs.readFileSync(local) : null;
    const world = JSON.parse(fs.readFileSync(path.join(server, "data", "definitions", "world.json"), "utf8"));
    const sites = structuredClone(world.pluginConfig?.["PlayerBots:sites"] ?? {});
    for (const site of Object.values(sites)) {
        // A few bots of every kind: enough to see them start, walk and be saved.
        if (site?.bots && typeof site.bots === "object") for (const mode of Object.keys(site.bots)) site.bots[mode] = Math.min(site.bots[mode], 4);
    }
    // The server stops itself the way a service manager would stop it, so players are saved.
    const stopper = path.join(scratch, "stop-after.cjs");
    fs.writeFileSync(stopper, `setTimeout(() => process.emit("SIGTERM", "SIGTERM"), ${seconds * 1000});\n`);
    try {
        fs.writeFileSync(local, JSON.stringify({ pluginConfig: { "PlayerBots:sites": sites } }));
        const started = run(process.execPath, ["-r", stopper, "--max-old-space-size=4096", "./dist/Server.js"], {
            cwd: server,
            timeout: (seconds + 180) * 1000,
            env: { ...process.env, NODE_ENV: "production", WEBSOCKET_PORT: "43777", TASK_SLOW_WARN_ENABLED: "0",
                PLAYER_SAVE_DATABASE_PATH: path.join(scratch, "players.sqlite"), WEBRTC_WORLD_ID: "", WEBRTC_WORLD_TOKEN: "" },
        });
        return { verdict: trialVerdict(started.status, started.output), output: started.output };
    } finally {
        if (kept) fs.writeFileSync(local, kept);
        else fs.rmSync(local, { force: true });
        fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

/** Builds and tests the merged folder. Returns null, or what failed. */
function check(root, merged, log) {
    const server = path.join(root, "server");
    const client = path.join(root, "client");
    const node = process.execPath;

    if (merged.changed.some((file) => PACKAGE_FILES.test(file))) {
        log("The packages changed: installing them (a few minutes)...");
        const installed = run("npm", ["run", "setup"], { cwd: root, shell: true });
        if (installed.status !== 0) return `the packages could not be installed:\n${tail(installed.output)}`;
    }

    log("Building the game server...");
    const built = run(node, ["node_modules/typescript/bin/tsc", "--build"], { cwd: server });
    if (built.status !== 0) return `the game server does not build:\n${tail(built.output)}`;

    const docs = run(node, ["node_modules/ts-node/dist/bin.js", "./scripts/world-config-docs.ts"], {
        cwd: server, env: { ...process.env, TS_NODE_COMPILER_OPTIONS: '{"target":"es2020"}' },
    });
    if (docs.status !== 0) return `the settings document could not be made again:\n${tail(docs.output)}`;
    git(root, ["add", "--", ...GENERATED]);

    const tests = ourTests(root, merged.theirs);
    if (tests.server.length > 0) {
        log(`Running our ${tests.server.length} server tests...`);
        const tested = run(node, ["--test", ...tests.server], { cwd: server });
        git(root, ["checkout", "--", SCRATCH]);
        if (tested.status !== 0) {
            const failed = tested.output.split("\n").filter((line) => /^✖|^not ok/.test(line.trim()));
            return `our server tests fail:\n${tail(failed.length > 0 ? failed.join("\n") : tested.output)}`;
        }
    }

    log("Checking the web client's types...");
    const typed = run(node, ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.json"], { cwd: client });
    if (typed.status !== 0) return `the web client does not type-check:\n${tail(typed.output)}`;
    if (tests.client.length > 0) {
        log(`Running our ${tests.client.length} client tests...`);
        const tested = run(node, ["scripts/run-tests.mjs", ...tests.client], { cwd: client });
        if (tested.status !== 0) return `our client tests fail:\n${tail(tested.output)}`;
    }

    log("Starting the merged server for a minute on a scratch save file...");
    const trial = trialStart(root, 45);
    git(root, ["checkout", "--", SCRATCH]);
    if (trial.verdict) return `${trial.verdict}`;
    const active = /\[plugins\] active=(\d+)/.exec(trial.output);
    log(`It started cleanly (${active?.[1]} plugins).`);
    return null;
}

// What the last run could not finish, kept beside git's own files (never in the project).
function stateFile(root) {
    return path.join(path.resolve(root, git(root, ["rev-parse", "--git-dir"]).out), "tsps-sync.json");
}
function readState(root) {
    try { return JSON.parse(fs.readFileSync(stateFile(root), "utf8")); } catch { return {}; }
}
function writeState(root, state) {
    fs.writeFileSync(stateFile(root), JSON.stringify(state));
}

function deploy(root, log) {
    log("Deploying (the game restarts if its files changed: players are saved and disconnected)...");
    const deployed = run(process.execPath, ["deploy/remote.mjs", "update"], { cwd: root });
    log(tail(deployed.output, 14));
    return deployed.status === 0;
}

/** One whole run. Returns the process's exit code: 0 done or nothing to do, 2 needs a person. */
export function sync(root, options, log) {
    if (options.verify) {
        // The same checks on the folder as it is: before committing a merge made by hand, say.
        git(root, ["fetch", "--quiet", UPSTREAM.remote, UPSTREAM.branch]);
        const failure = check(root, { changed: [], theirs: git(root, ["rev-parse", "FETCH_HEAD"]).out }, log);
        log(failure ? `The folder as it is does not pass: ${failure}` : "The folder as it is passes every check.");
        return failure ? 2 : 0;
    }
    if (options.check) {
        // Only a look: it changes nothing, so it does not mind work in progress.
        const fetched = git(root, ["fetch", "--quiet", UPSTREAM.remote, UPSTREAM.branch]);
        if (!fetched.ok) {
            log(`Could not fetch the original project: ${fetched.err.split("\n").pop()}`);
            return 2;
        }
        const behind = git(root, ["rev-list", "--count", "HEAD..FETCH_HEAD"]).out;
        log(behind === "0" ? "Up to date with the original project." : `The original project has ${behind} commits we do not have yet.`);
        return 0;
    }

    const why = notReady(root);
    if (why) {
        log(`Not now: ${why}. Nothing was changed.`);
        return 2;
    }
    // Ours first: what was pushed from elsewhere, and what a run before this one left behind.
    git(root, ["fetch", "--quiet", OURS.remote, OURS.branch]);
    const ahead = Number(git(root, ["rev-list", "--count", `HEAD..${OURS.remote}/${OURS.branch}`]).out);
    if (ahead > 0 && !git(root, ["merge", "--ff-only", `${OURS.remote}/${OURS.branch}`]).ok) {
        log("Not now: the fork has commits this folder lacks, and the folder has commits the fork lacks. Nothing was changed.");
        return 2;
    }
    const state = readState(root);
    const head = () => git(root, ["rev-parse", "HEAD"]).out;

    const merged = mergeUpstream(root, log);
    if (merged.result === "failed") {
        log(`Stopped: ${merged.reason}. Nothing was changed.`);
        return 2;
    }
    if (merged.result === "conflict") {
        log(`Needs a hand: the original project (${merged.commits} new commits) and we changed the same lines of:`);
        for (const file of merged.files) log(`    ${file}`);
        log("The folder is back as it was; the fork and the live server are untouched. Merge it by hand:");
        log(`    git merge ${UPSTREAM.remote}/${UPSTREAM.branch}`);
        return 2;
    }
    if (merged.result === "merged") {
        const failure = check(root, merged, log);
        if (failure) {
            undoMerge(root);
            // The built server is from the merged code; build it again from ours.
            run(process.execPath, ["node_modules/typescript/bin/tsc", "--build"], { cwd: path.join(root, "server") });
            log(`Stopped: with the ${merged.commits} new commits merged, ${failure}`);
            log("The folder is back as it was; the fork and the live server are untouched.");
            return 2;
        }
        const committed = git(root, ["commit", "--quiet", "-m", commitMessage(merged)]);
        if (!committed.ok) {
            undoMerge(root);
            log(`Stopped: the merge could not be committed: ${committed.err.split("\n").pop()}. The folder is back as it was.`);
            return 2;
        }
        log(`Merged ${merged.commits} commits as ${head().slice(0, 9)}.`);
    } else if (state.pending !== head()) {
        log("Up to date with the original project.");
        return 0;
    } else {
        log("Up to date with the original project; finishing what the last run could not.");
    }

    // From here the merge is a commit: a failure is remembered and finished by the next run.
    writeState(root, { pending: head() });
    const pushed = git(root, ["push", "--quiet", OURS.remote, `HEAD:${OURS.branch}`]);
    if (!pushed.ok) {
        log(`The merge is committed here but could not be pushed: ${pushed.err.split("\n").pop()}. The next run tries again.`);
        return 2;
    }
    log("Pushed to the fork.");
    if (options.deploy === false) {
        writeState(root, {});
        log("Not deployed (--no-deploy): npm run deploy sends it to the server.");
        return 0;
    }
    if (!deploy(root, log)) {
        log("The deploy did not finish (the server keeps the version it had). The next run tries again; or: npm run deploy");
        return 2;
    }
    writeState(root, {});
    log("Done: the live server runs the merged version.");
    return 0;
}

// ---------------------------------------------------------------------------------------------

const LOG = path.join(ROOT, "deploy", "sync.log");

function powershell(script) {
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

function schedule(time) {
    if (process.platform !== "win32") {
        console.log(`On this system, add a line to your crontab (crontab -e):\n  0 5 * * * cd ${ROOT} && ${process.execPath} deploy/sync-upstream.mjs --scheduled`);
        return 0;
    }
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) {
        console.error(`'${time}' is not a time of day (use for example 05:00).`);
        return 1;
    }
    const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;
    // conhost --headless: no window appears on the desktop while it runs.
    const made = powershell([
        `$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${quote(`--headless "${process.execPath}" "${path.join(ROOT, "deploy", "sync-upstream.mjs")}" --scheduled`)} -WorkingDirectory ${quote(ROOT)}`,
        `$trigger = New-ScheduledTaskTrigger -Daily -At ${quote(time)}`,
        "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)",
        `Register-ScheduledTask -TaskName ${quote(TASK_NAME)} -Action $action -Trigger $trigger -Settings $settings -Description 'Merges the original TSPS project into our copy, checks it, pushes and deploys it (deploy/sync-upstream.mjs).' -Force | Out-Null`,
    ].join("; "));
    if (made.status !== 0) {
        console.error(`The daily run could not be set up:\n${tail(made.output)}`);
        return 1;
    }
    console.log(`Every day at ${time} (or as soon as this PC is on after it) while you are signed in. What each run did: deploy/sync.log`);
    return 0;
}

function unschedule() {
    if (process.platform !== "win32") {
        console.log("Remove the line from your crontab (crontab -e).");
        return 0;
    }
    const removed = powershell(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false`);
    console.log(removed.status === 0 ? "The daily run is removed." : "There was no daily run to remove.");
    return 0;
}

/** A scheduled run nobody is watching: say on screen that it needs a person. */
function notify(text) {
    if (process.platform !== "win32") return;
    spawnSync("msg.exe", [os.userInfo().username, "/TIME:86400", text], { stdio: "ignore" });
}

function main(argv) {
    const has = (flag) => argv.includes(flag);
    if (has("--schedule")) return schedule(argv[argv.indexOf("--schedule") + 1] ?? "05:00");
    if (has("--unschedule")) return unschedule();

    const scheduled = has("--scheduled");
    const said = [];
    const log = (text) => {
        said.push(text);
        console.log(text);
        if (scheduled) fs.appendFileSync(LOG, `${text}\n`);
    };
    if (scheduled) {
        // Keep the log to its last part.
        if (fs.existsSync(LOG) && fs.statSync(LOG).size > 512 * 1024) fs.writeFileSync(LOG, fs.readFileSync(LOG, "utf8").slice(-128 * 1024));
        fs.appendFileSync(LOG, `\n=== ${new Date().toString()}\n`);
    }
    let code;
    try {
        code = sync(ROOT, { check: has("--check"), verify: has("--verify"), deploy: !has("--no-deploy") }, log);
    } catch (error) {
        log(`Stopped by an error of the script itself: ${error?.stack ?? error}`);
        if (fs.existsSync(path.join(ROOT, ".git", "MERGE_HEAD"))) undoMerge(ROOT);
        code = 1;
    }
    if (scheduled && code !== 0) {
        const reason = said.find((line) => /^(Not now|Stopped|Needs a hand|The merge is committed|The deploy did not)/.test(line)) ?? "it did not finish";
        notify(`Kat-Net TSPS update: ${reason.split("\n")[0].slice(0, 180)}\n\nDetails: ${LOG}`);
    }
    return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main(process.argv.slice(2)));
}
