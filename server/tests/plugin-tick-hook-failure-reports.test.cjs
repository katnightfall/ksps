// Ours. Run after `yarn build`: node --test tests/plugin-tick-hook-failure-reports.test.cjs
// A plugin's hook that throws is contained: the failure is logged and the rest of the hooks and the tick run on. But
// two kinds of hook run on every tick: the player-process hooks, for each player, and an area's process, for each
// actor in it. One that throws throws again every tick, and each failure wrote its whole stack to the log: a hook
// failing for 2,000 players was 2,000 stack traces every 600 ms, for as long as the world ran. Their failures are now
// reported the first time and then every 1,000th, by plugin and message; every other hook still reports each one.
const assert = require("node:assert/strict");
const { beforeEach, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { PluginManager } = require("../dist/plugins/PluginManager");

let logged;
beforeEach((t) => {
  logged = [];
  t.mock.method(console, "error", (...args) => { logged.push(String(args[0])); });
});

function hook(list, pluginName, handler, t) {
  list.push({ pluginName, handler });
  t.after(() => list.splice(list.findIndex((entry) => entry.handler === handler), 1));
}

for (const perf of [false, true]) {
  test(`a player-process hook that throws every tick is reported once, not on every tick (plugin timing ${perf ? "on" : "off"})`, (t) => {
    const previous = PluginManager.pluginPerfEnabled;
    PluginManager.pluginPerfEnabled = perf;
    t.after(() => { PluginManager.pluginPerfEnabled = previous; });
    let after = 0;
    hook(PluginManager.playerProcessHooks, "BrokenEveryTick" + perf, () => { throw new Error(`fails every tick (expected by this test, ${perf})`); }, t);
    hook(PluginManager.playerProcessHooks, "Fine" + perf, () => { after++; }, t);
    const players = Array.from({ length: 50 }, (_, index) => ({ index }));
    for (let tick = 0; tick < 40; tick++) {
      for (const player of players) PluginManager.emitPlayerProcess({ player });
    }
    assert.equal(after, 2000, "the hook after it ran for every player on every tick");
    const reports = logged.filter((line) => line.includes("player_process hook failed"));
    assert.equal(reports.length, 3, "2,000 failures: the first, then the 1,000th and the 2,000th with their counts");
    assert.match(reports[1], /\(1000 times now\)/);
    assert.match(reports[2], /\(2000 times now\)/);
  });
}

test("a different failure of the same hook is reported on its own, and other hooks still report every failure", (t) => {
  let message = "first way (expected by this test)";
  hook(PluginManager.playerProcessHooks, "TwoWays", () => { throw new Error(message); }, t);
  PluginManager.emitPlayerProcess({ player: {} });
  PluginManager.emitPlayerProcess({ player: {} });
  message = "second way (expected by this test)";
  PluginManager.emitPlayerProcess({ player: {} });
  assert.equal(logged.length, 2);

  logged.length = 0;
  hook(PluginManager.logoutHooks, "BrokenLogout", () => { throw new Error("logout failed (expected by this test)"); }, t);
  for (let i = 0; i < 3; i++) PluginManager.emitPlayerLogout({ player: {} });
  assert.equal(logged.length, 3, "a logout hook's failures are each reported, as before");
});

test("an area whose process throws for every actor is reported once; its other methods as before", () => {
  const area = {
    pluginName: "BrokenArea",
    getName: () => "Broken area",
    process() { throw new Error("area process failed (expected by this test)"); },
    canAttack() { throw new Error("area canAttack failed (expected by this test)"); },
  };
  for (let i = 0; i < 500; i++) assert.equal(PluginManager.callArea(area, "process", {}), null);
  assert.equal(logged.length, 1);
  for (let i = 0; i < 3; i++) PluginManager.callArea(area, "canAttack", {}, {});
  assert.equal(logged.length, 4);
});
