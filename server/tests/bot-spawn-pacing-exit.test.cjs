// Run: node --test tests/bot-spawn-pacing-exit.test.cjs
//
// A queue of paced bot spawns must not keep a process alive on its own. With our world's 1,565 site bots
// every test file that ran the server startup hooks stayed up for about two and a half minutes after its
// last test, spawning bots 8 at a time, before it could exit.
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const pacing = path.resolve(__dirname, "../plugins/bots/runtime/SpawnPacing.PlayerBots.js");
const { runPaced, SPAWNS_PER_BATCH, SPAWN_BATCH_DELAY_MS } = require(pacing);

test("a process with nothing else to do exits with the rest of the spawn queue unrun", () => {
  const script = `
    const { runPaced, SPAWNS_PER_BATCH } = require(${JSON.stringify(pacing)});
    let ran = 0;
    process.on("exit", () => process.stdout.write(String(ran)));
    runPaced(Array.from({ length: SPAWNS_PER_BATCH * 40 }, () => () => ran++));
  `;
  const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(Number(child.stdout), SPAWNS_PER_BATCH, "only the first batch ran before the process was free to exit");
});

test("a process that stays up still runs every batch", async () => {
  let ran = 0;
  let done = false;
  runPaced(Array.from({ length: SPAWNS_PER_BATCH * 2 + 1 }, () => () => ran++), () => { done = true; });
  assert.equal(ran, SPAWNS_PER_BATCH);
  await new Promise((resolve) => setTimeout(resolve, SPAWN_BATCH_DELAY_MS * 2 + 400));
  assert.equal(ran, SPAWNS_PER_BATCH * 2 + 1);
  assert.equal(done, true);
});
