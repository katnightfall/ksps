// Ours. The landing page's reading of /worlds.json, and which address is the landing page.
import assert from "node:assert/strict";
import { test } from "node:test";

import { isLandingAddress, playersText, readWorlds } from "../landing/landingApi";

test("the front page is the landing page; the game is everywhere else, and at old front-page links with a query", () => {
    assert.equal(isLandingAddress("/", ""), true);
    assert.equal(isLandingAddress("/play", ""), false);
    assert.equal(isLandingAddress("/hiscores", ""), false);
    // Links and tools from before the game moved to /play.
    assert.equal(isLandingAddress("/", "?username=someone&password=secret"), false);
    assert.equal(isLandingAddress("/", "?renderer=webgl"), false);
});

test("the worlds are read as the front door sends them", () => {
    const worlds = readWorlds({ worlds: [
        { id: "kat-net", name: "Kat-Net", description: "10x custom", here: true, home: "/", play: "/play", hiscores: "/hiscores",
            online: true, players: 3, bots: 1475, experienceRate: 10 },
        { id: "two", name: "Second", description: "", here: false, home: "https://two.example.com/", play: "https://two.example.com/play",
            hiscores: "https://two.example.com/hiscores", online: false, players: null, bots: null },
    ] });
    assert.equal(worlds.length, 2);
    assert.deepEqual(worlds[0], { id: "kat-net", name: "Kat-Net", description: "10x custom", here: true, home: "/", play: "/play",
        hiscores: "/hiscores", online: true, players: 3, bots: 1475, experienceRate: 10 });
    assert.equal(worlds[1].play, "https://two.example.com/play");
    assert.equal(worlds[1].online, false);
});

test("an answer that is not what we expect never becomes a link or a number on the page", () => {
    const [world] = readWorlds({ worlds: [
        { id: "x", name: 5, play: "javascript:alert(1)", home: "//evil.example.com", hiscores: "data:text/html,hi", online: "yes", players: -1, bots: 2.5 },
        null,
        "a string",
        { name: "No id" },
    ] });
    assert.deepEqual(world, { id: "x", name: "World", description: "", here: false, home: "/", play: "/play", hiscores: "/hiscores",
        online: false, players: null, bots: null, experienceRate: undefined });
    assert.equal(readWorlds({ worlds: [null, "a string", { name: "No id" }] }).length, 0);
    assert.deepEqual(readWorlds(null), []);
    assert.deepEqual(readWorlds({ worlds: "none" }), []);
});

test("who is on a world, in words", () => {
    const world = (extra: object) => readWorlds({ worlds: [{ id: "w", name: "W", ...extra }] })[0];
    assert.equal(playersText(world({ online: false })), "Offline");
    assert.equal(playersText(world({ online: true })), "Online");
    assert.equal(playersText(world({ online: true, players: 0 })), "No one on");
    assert.equal(playersText(world({ online: true, players: 1 })), "1 player");
    assert.equal(playersText(world({ online: true, players: 1234 })), "1,234 players");
});
