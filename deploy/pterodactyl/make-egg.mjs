#!/usr/bin/env node
/**
 * Writes egg-kat-net-tsps.json, the file imported into the panel (Admin > Nests > Import Egg).
 * The egg is made here, not edited by hand: its install script is install.sh, and its variables
 * are the ones launch.mjs reads.
 *
 *   node deploy/pterodactyl/make-egg.mjs           write the file
 *   node deploy/pterodactyl/make-egg.mjs --check   exit 1 if the file is not what this would write
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { READY_LINE } from "./launch.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const EGG_FILE = path.join(here, "egg-kat-net-tsps.json");

const variable = (name, env_variable, default_value, rules, description, user_editable = true) => ({
    name, description, env_variable, default_value, user_viewable: true, user_editable, rules, field_type: "text",
});

export function makeEgg() {
    return {
        _comment: "DO NOT EDIT: FILE GENERATED AUTOMATICALLY BY PTERODACTYL PANEL - PTERODACTYL.IO",
        meta: { version: "PTDL_v2", update_url: null },
        // Fixed, so that making the egg again changes nothing unless the egg changed.
        exported_at: "2026-11-15T00:00:00+00:00",
        name: "Kat-Net TSPS",
        author: "noreply@kat-net.us",
        description: "A browser RuneScape private server (TSPS, the Kat-Net edition): the game server and its website on one port. " +
            "Players open the server's address in a browser; nothing to download. Needs Node.js 22, one port, 4 GB of memory or more and 5 GB of disk.",
        features: null,
        docker_images: { "Node.js 22": "ghcr.io/parkervcp/yolks:nodejs_22" },
        file_denylist: [],
        startup: "node deploy/pterodactyl/launch.mjs",
        config: {
            files: "{}",
            startup: JSON.stringify({ done: READY_LINE }),
            logs: "{}",
            stop: "stop",
        },
        scripts: {
            installation: {
                script: fs.readFileSync(path.join(here, "install.sh"), "utf8").replace(/\r\n/g, "\n"),
                container: "node:22-bookworm",
                entrypoint: "bash",
            },
        },
        variables: [
            variable("World name", "WORLD_NAME", "My World", "required|string|max:40",
                "The world's name, also shown on the login screen's server button. Changing it rebuilds the website on the next start (several minutes)."),
            variable("World description", "WORLD_DESCRIPTION", "A new world.", "required|string|max:120",
                "A line about the world, shown with its name."),
            variable("XP rate", "XP_RATE", "10", "required|numeric|min:1|max:1000",
                "Experience multiplier: 1 is as the original game, 10 is ten times as fast."),
            variable("Bots", "BOT_COUNT", "100", "required|integer|min:0|max:2000",
                "How many levelling bots walk the world (they start as new characters and train like players). 0 turns every bot off. More bots need more memory and processor."),
            variable("Developer accounts", "DEV_USERNAME", "", "nullable|string|max:200",
                "Account names that are developers (the highest rank) each time they log in, comma-separated. Create the account in game first: a name listed here that nobody has registered yet belongs to whoever logs in with it first."),
            variable("Public game address", "PUBLIC_WS_URL", "", "nullable|string|max:255",
                "Only for a world list: where players reach the game from outside, for example wss://play.example.com. Leave empty otherwise."),
            variable("Master address", "WORLDS_MASTER_URL", "", "nullable|string|max:255",
                "Only for a world that belongs to a group of worlds: the address of the group's master (for example https://rs.kat-net.us), which this world asks for the list of worlds to show. Leave empty for a world on its own."),
            variable("Headless", "HEADLESS", "0", "required|boolean",
                "1: this world builds and serves no website of its own. It is played on its master's site, which carries the game connection to it (needs Master address). 0: a world with its own website."),
            variable("Master proxy key", "MASTER_PROXY_KEY", "", "nullable|string|max:128",
                "Only for a world played through a master: the key the master signs each visitor's address with, so this world sees who is really connecting. The master's admin page shows it."),
            variable("Certificate file", "TLS_CERT", "", "nullable|string|max:255",
                "For https at this server's own address: the certificate (fullchain.pem) as the server can read it, for example /etc/letsencrypt/live/<the node's name>/fullchain.pem through a panel mount. Empty, or a file it cannot read: plain http."),
            variable("Certificate key file", "TLS_KEY", "", "nullable|string|max:255",
                "The certificate's private key (privkey.pem), beside the certificate."),
            variable("Update on start", "AUTO_UPDATE", "1", "required|boolean",
                "1: fetch the newest version of the project each time the server starts, and rebuild what changed. 0: stay on the version installed."),
            variable("Rebuild on start", "REBUILD", "0", "required|boolean",
                "1: build everything again on the next start, whatever changed (after editing the project's source by hand). Set it back to 0 afterwards."),
            variable("Game memory (MB)", "GAME_HEAP_MB", "", "nullable|integer|min:512",
                "Memory for the game server in MB. Empty: 70% of the server's memory."),
            variable("Project address", "GIT_REPO", "https://github.com/katnightfall/ksps.git", "required|string|max:255",
                "The git address the project is installed and updated from.", false),
            variable("Project branch", "GIT_BRANCH", "main", "required|string|max:100",
                "The branch of the project to install.", false),
        ],
    };
}

const text = () => `${JSON.stringify(makeEgg(), null, 4)}\n`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.includes("--check")) {
        const current = fs.existsSync(EGG_FILE) ? fs.readFileSync(EGG_FILE, "utf8").replace(/\r\n/g, "\n") : "";
        if (current !== text()) {
            console.error("egg-kat-net-tsps.json is out of date: run node deploy/pterodactyl/make-egg.mjs");
            process.exit(1);
        }
    } else {
        fs.writeFileSync(EGG_FILE, text());
        console.log(`wrote ${EGG_FILE}`);
    }
}
