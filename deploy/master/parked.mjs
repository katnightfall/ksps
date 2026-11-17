#!/usr/bin/env node
/**
 * What the game service runs on a master that hosts no world of its own (MASTER_ONLY=1 in
 * deploy/settings.env; deploy/run.sh starts this in the game server's place).
 *
 * It holds the game's port and nothing else: the updater takes an open port as "the game came
 * back" after a deploy and puts the previous version back when it stays shut. Every request is
 * told the world is parked; no player can connect, nothing is loaded, and the player saves
 * (server/data/saves) are not opened. To run the world here again, set MASTER_ONLY=0 and deploy.
 */
import http from "node:http";

const port = Number(process.env.WEBSOCKET_PORT) || 43594;
const server = http.createServer((request, response) => {
    const body = JSON.stringify({ parked: true, error: "This server hosts no world of its own. The worlds run on their own servers." });
    response.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
    response.end(body);
});
server.on("upgrade", (request, socket) => socket.destroy());
server.listen(port, "127.0.0.1", () => console.log(`[parked] no world runs here (MASTER_ONLY): holding port ${port} for the updater`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
