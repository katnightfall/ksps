#!/usr/bin/env node
/**
 * A fresh start: every account and everything players built up on a world is set aside, once per
 * reset the master calls. Nothing is deleted. What was there is moved into a folder beside it
 * (server/data/saves/reset-<date>-<time>/), from where it can be put back by hand.
 *
 * Who calls a reset: the master, and only the master. Its reset id is two parts joined:
 *   ACCOUNTS_RESET_ID in deploy/settings.env   (a deploy)
 *   the admin page's "Reset all accounts"      (kept with its worlds)
 * A world applies a reset when the id it is given differs from the one it last applied
 * (server/data/saves/.accounts-reset), before its game server starts:
 *   the master's own world    node deploy/reset-accounts.mjs            (deploy/run.sh)
 *   a world made by the master node deploy/reset-accounts.mjs --from-master <address>
 *                             --world <its name>   (deploy/pterodactyl/launch.mjs; the id
 *                             comes with the world list)
 *
 * A world joined to a master by hand that has never heard of a reset (no marker) only notes the
 * id it is first given: it is not wiped by a reset called before it joined. A world the master
 * made (on its admin page) and the master's own saves have no such doubt and are reset. A world with no master is never reset:
 * nothing in this project's own files can wipe somebody else's world.
 *
 * Kept in place: bans and mutes, the bank PIN key, and the master's own folder.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MARKER = ".accounts-reset";
/** What a reset leaves where it is. */
export const KEPT = /^(master|\.accounts-reset|reset-\d{8}-\d{6}(-\d+)?|Bans\.txt|IPBans\.txt|Mutes\.txt|IPMutes\.txt|bank-pin-host\.key)$/;

const clean = (value) => String(value ?? "").replace(/[^A-Za-z0-9:._-]/g, "").slice(0, 64);

/** The master's reset id from its two parts; "" when no reset was ever called. */
export function combinedResetId(fromSettings, fromAdmin) {
    const parts = [clean(fromSettings), clean(fromAdmin)];
    return parts.some(Boolean) ? parts.join("|") : "";
}

/** The master's reset id, read from its own files (`root`: the project's folder). */
export function masterResetId(root = ROOT) {
    let fromSettings = "", fromAdmin = "";
    try {
        fromSettings = /^ACCOUNTS_RESET_ID=(.*)$/m.exec(fs.readFileSync(path.join(root, "deploy", "settings.env"), "utf8"))?.[1]?.trim() ?? "";
    } catch {}
    try {
        fromAdmin = JSON.parse(fs.readFileSync(path.join(root, "server", "data", "saves", "master", "master-worlds.json"), "utf8")).accountsReset ?? "";
    } catch {}
    return combinedResetId(fromSettings, fromAdmin);
}

/**
 * Applies reset `id` to a saves folder. `adopt`: a folder with no marker notes the id and keeps
 * its saves (a world's first word from its master). Returns { result, moved, backup }:
 *   "none"     no reset has been called (or the id is unusable)
 *   "current"  this reset was applied before
 *   "adopted"  first contact: noted, nothing moved
 *   "reset"    `moved` (file and folder names) are now in `backup`
 */
export function applyReset(savesDir, id, { adopt = false, now = new Date() } = {}) {
    if (!id || typeof id !== "string") return { result: "none", moved: [], backup: null };
    const marker = path.join(savesDir, MARKER);
    let applied = null;
    try { applied = fs.readFileSync(marker, "utf8").trim(); } catch {}
    if (applied === id) return { result: "current", moved: [], backup: null };
    fs.mkdirSync(savesDir, { recursive: true });
    if (applied === null && adopt) {
        fs.writeFileSync(marker, `${id}\n`);
        return { result: "adopted", moved: [], backup: null };
    }
    const entries = fs.readdirSync(savesDir).filter((name) => !KEPT.test(name));
    let backup = null;
    if (entries.length > 0) {
        const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
        backup = path.join(savesDir, `reset-${stamp}`);
        for (let n = 2; fs.existsSync(backup); n++) backup = path.join(savesDir, `reset-${stamp}-${n}`);
        fs.mkdirSync(backup);
        for (const name of entries) fs.renameSync(path.join(savesDir, name), path.join(backup, name));
    }
    // Written last: a reset cut short is done again at the next start, on what is left.
    fs.writeFileSync(marker, `${id}\n`);
    return { result: "reset", moved: entries, backup };
}

/**
 * Whether the world named `worldName` was made by the master (on its admin page: such worlds are
 * the list's headless ones). It has been the master's since it was made, so every reset the
 * master calls is meant for it, the first one it hears of included. Any other world (one joined
 * to the master by hand) only notes its first.
 */
export function bornUnderMaster(worlds, worldName) {
    if (!Array.isArray(worlds) || typeof worldName !== "string" || !worldName) return false;
    return worlds.some((world) => world?.world === worldName && world.headless === true);
}

async function main(argv) {
    const saves = path.join(ROOT, "server", "data", "saves");
    const from = argv.indexOf("--from-master");
    let id, adopt = false;
    if (from >= 0) {
        // A world of a master: the id comes with the world list. No answer, no reset.
        const master = String(argv[from + 1] ?? "").replace(/\/+$/, "");
        if (!/^https?:\/\/[^\s/]+$/.test(master)) return;
        let answer;
        try {
            const response = await fetch(`${master}/world-list.json`, { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
            if (!response.ok) return;
            answer = await response.json();
        } catch {
            return;
        }
        id = clean(answer.accountsReset);
        adopt = !bornUnderMaster(answer.worlds, argv[argv.indexOf("--world") + 1]);
    } else {
        id = masterResetId(ROOT);
    }
    const done = applyReset(saves, id, { adopt });
    if (done.result === "reset") console.log(`[reset] A fresh start (${id}): ${done.moved.length ? `${done.moved.length} saves moved to ${done.backup}` : "there was nothing to set aside"}.`);
    if (done.result === "adopted") console.log(`[reset] Noted the master's reset (${id}); this world's saves are kept.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    // Never in the way of the game starting.
    main(process.argv.slice(2)).catch((error) => console.log(`[reset] skipped: ${error?.message ?? error}`));
}
