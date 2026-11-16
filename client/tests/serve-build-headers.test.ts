// Ours: scripts/serve-build.mjs answers every file but the page the same for every browser, so a
// CDN that keeps one copy of a file (and ignores "Vary: User-Agent") can never hand Chrome a
// worker script without the isolation header its page has.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const CURL = "curl/8.9.1";

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const { port } = probe.address() as net.AddressInfo;
            probe.close(() => resolve(port));
        });
    });
}

test("only the page is answered by browser; every other file is the same for all, with the header", async () => {
    // The server serves ../build beside its own folder: a copy of it in a folder of our own.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "serve-build-headers-"));
    fs.mkdirSync(path.join(root, "scripts"));
    fs.copyFileSync(path.resolve(__dirname, "../scripts/serve-build.mjs"), path.join(root, "scripts/serve-build.mjs"));
    for (const [file, body] of Object.entries({
        "build/index.html": "<!doctype html><title>game</title>",
        "build/static/js/55.abcdef12.v2.chunk.js": "self.postMessage('worker')",
        "build/static/media/module.wasm": "wasm",
        "build/gameframe317/compass.png": "png",
        "build/favicon/site.webmanifest": "{}",
    })) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), body);
    }
    const port = await freePort();
    const server = spawn(process.execPath, ["scripts/serve-build.mjs"], { cwd: root, env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), CACHE_DIR: "" }, stdio: ["ignore", "pipe", "inherit"] });
    try {
        await new Promise<void>((resolve, reject) => {
            server.stdout.on("data", (chunk: Buffer) => { if (chunk.toString().includes("[serve-build] serving")) resolve(); });
            server.once("exit", () => reject(new Error("the server stopped before it was ready")));
        });
        const headers = async (urlPath: string, userAgent: string) => {
            const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, { headers: { "User-Agent": userAgent } });
            await response.arrayBuffer();
            return {
                status: response.status,
                coep: response.headers.get("cross-origin-embedder-policy"),
                vary: response.headers.get("vary"),
                cache: response.headers.get("cache-control"),
            };
        };

        // A script (a worker's among them), a wasm module, a picture, a missing file: one answer.
        for (const urlPath of ["/static/js/55.abcdef12.v2.chunk.js", "/static/media/module.wasm", "/gameframe317/compass.png", "/static/js/missing.js"]) {
            const answers = await Promise.all([CHROME, FIREFOX, SAFARI, CURL].map((userAgent) => headers(urlPath, userAgent)));
            for (const answer of answers) {
                assert.deepEqual(answer, answers[0], `${urlPath}: the same for every browser`);
                assert.equal(answer.coep, "require-corp", `${urlPath}: with the isolation header`);
                assert.equal(answer.vary, "Accept-Encoding", `${urlPath}: nothing varies by browser`);
            }
        }

        // The page, and an address that is one of the page's own (the app's routes): by browser, never kept.
        for (const urlPath of ["/", "/hiscores"]) {
            const chrome = await headers(urlPath, CHROME);
            assert.equal(chrome.coep, "require-corp");
            assert.equal(chrome.cache, "no-cache");
            assert.equal(chrome.vary, "User-Agent, Accept-Encoding");
            for (const userAgent of [FIREFOX, SAFARI, CURL]) {
                const other = await headers(urlPath, userAgent);
                assert.equal(other.coep, null, `${urlPath}: no isolation for ${userAgent.slice(0, 20)}`);
                assert.equal(other.cache, "no-cache");
            }
        }

        // How long each kind is kept.
        assert.equal((await headers("/static/js/55.abcdef12.v2.chunk.js", CHROME)).cache, "public, max-age=31536000, immutable");
        assert.equal((await headers("/gameframe317/compass.png", CHROME)).cache, "public, max-age=86400", "a picture: a day");
        assert.equal((await headers("/favicon/site.webmanifest", CHROME)).cache, "no-cache");
    } finally {
        // The folder is the server's own (its working directory): it goes once the server has.
        const stopped = new Promise((resolve) => server.once("exit", resolve));
        server.kill();
        await stopped;
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* left for the system to clear */ }
    }
});
