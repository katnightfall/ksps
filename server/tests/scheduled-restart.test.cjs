// node --test tests/scheduled-restart.test.cjs
// Ours: the world restarts itself every ScheduledRestart:hours with a system update (GameUpdate's
// countdown), and exits 76 so the panel's launcher takes the newest version as it starts again.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const HOUR = 3600 * 1000;

function world({ config = {}, supervised = true, withGameUpdate = true } = {}) {
  for (const file of ["../plugins/world/GameUpdate.plugin", "../plugins/world/ScheduledRestart.plugin"]) {
    delete require.cache[require.resolve(file)];
  }
  const gameUpdate = require("../plugins/world/GameUpdate.plugin");
  const restart = require("../plugins/world/ScheduledRestart.plugin");
  const events = new Map();
  const tasks = [];
  const pushes = [];
  const messages = [];
  const shutdowns = [];
  const logs = [];
  const commands = new Map();
  let shuttingDown = false;
  class Task {
    constructor(delay, key) { this.delay = delay; this.key = key; this.stopped = false; }
    stop() { this.stopped = true; }
  }
  const players = [{
    sendMessage: (text) => messages.push(text),
    getPacketSender: () => ({ sendSystemUpdate: (value) => pushes.push(value) }),
  }];
  const core = {
    Task,
    TaskManager: { submit: (task) => tasks.push(task), cancelTasks: () => {} },
    World: { getPlayers: () => players },
    PlayerRights: { OWNER: 5 },
    Server: {
      getLogger: () => ({ info: (text) => logs.push(text), warn: (text) => logs.push(text) }),
      shutdown: (reason, options) => { shuttingDown = true; shutdowns.push({ reason, options }); },
      isShuttingDown: () => shuttingDown,
    },
  };
  const api = (name) => ({
    core,
    getPluginConfig: (key, fallback) => (key in config ? config[key] : fallback),
    registerCommand: (command, handler) => commands.set(command, handler),
    onPlayerLogin() {},
    onServerShutdown() {},
    onServerStartup() {},
    onCustomEvent: (event, handler) => events.set(event, handler),
    emitCustomEvent: (event, payload) => { events.get(event)?.(payload); return payload; },
  });
  if (withGameUpdate) gameUpdate.register(api("GameUpdate"));
  restart.register(api("ScheduledRestart"));
  const checker = tasks.find((task) => task.delay === 50);
  const previous = process.env.TSPS_SUPERVISED;
  if (supervised) process.env.TSPS_SUPERVISED = "1";
  else delete process.env.TSPS_SUPERVISED;
  const started = 1_000_000_000_000;
  restart._test.reset(started);
  const at = (ms, fn) => {
    const realNow = Date.now;
    Date.now = () => started + ms;
    try { return fn(); } finally { Date.now = realNow; }
  };
  return {
    restart, events, tasks, pushes, messages, shutdowns, logs, commands, checker, at,
    countdown: () => tasks.find((task) => task !== checker && !task.stopped),
    emit: (event, payload) => { events.get(event)(payload); return payload; },
    done: () => { if (previous === undefined) delete process.env.TSPS_SUPERVISED; else process.env.TSPS_SUPERVISED = previous; },
  };
}

test("12 hours after the start the system update counts down, then the game saves and exits 76", () => {
  const w = world({ config: { "ScheduledRestart:hours": 12 } });
  try {
    assert.ok(w.checker, "the time is looked at every 30 seconds");
    w.at(12 * HOUR - 5 * 60 * 1000 - 1000, () => w.checker.execute());
    assert.equal(w.pushes.length, 0, "not before 11 hours 55 minutes");
    w.at(12 * HOUR - 5 * 60 * 1000, () => w.checker.execute());
    assert.deepEqual(w.pushes, [30000], "every player sees the system update timer: 5 minutes");
    assert.match(w.messages[0], /server will shut down in 5 minutes/);
    assert.deepEqual(w.emit("GameUpdate:status", {}).id, "ScheduledRestart");
    w.at(12 * HOUR - 60 * 1000, () => { w.checker.execute(); w.countdown().execute(); });
    assert.equal(w.shutdowns.length, 0, "a minute left: still counting");
    assert.equal(w.pushes.length, 2, "only one system update was started");
    w.at(12 * HOUR + 1000, () => w.countdown().execute());
    assert.equal(w.shutdowns.length, 1);
    assert.equal(w.shutdowns[0].reason, "gameUpdate");
    assert.equal(w.shutdowns[0].options.exitCode, 76, "the launcher's code for: update, then start again");
    w.at(12 * HOUR + 2000, () => w.checker.execute());
    assert.equal(w.shutdowns.length, 1, "nothing more while the game shuts down");
  } finally {
    w.done();
  }
});

test("the countdown's length is a setting", () => {
  const w = world({ config: { "ScheduledRestart:hours": 6, "ScheduledRestart:countdownMinutes": 15 } });
  try {
    w.at(6 * HOUR - 15 * 60 * 1000, () => w.checker.execute());
    assert.deepEqual(w.pushes, [90000]);
  } finally {
    w.done();
  }
});

test("off when the hours are 0, and in a game nothing would start again", () => {
  for (const options of [{ config: {} }, { config: { "ScheduledRestart:hours": 0 } }, { config: { "ScheduledRestart:hours": 12 }, supervised: false }]) {
    const w = world(options);
    try {
      w.at(100 * HOUR, () => w.checker.execute());
      assert.equal(w.pushes.length, 0);
      assert.equal(w.shutdowns.length, 0);
    } finally {
      w.done();
    }
  }
});

test("a system update already counting down is left to restart the world", () => {
  const w = world({ config: { "ScheduledRestart:hours": 12 } });
  try {
    w.at(12 * HOUR - 10 * 60 * 1000, () => w.emit("GameUpdate:start", { seconds: 1200, exitCode: 75 }));
    w.at(12 * HOUR, () => w.checker.execute());
    assert.equal(w.emit("GameUpdate:status", {}).id, undefined, "the owner's countdown is the one running");
    assert.equal(w.pushes.length, 1);
  } finally {
    w.done();
  }
});

test("an owner who cancels it gets an hour's peace, then it is started again", () => {
  const w = world({ config: { "ScheduledRestart:hours": 12 } });
  try {
    const due = 12 * HOUR - 5 * 60 * 1000;
    w.at(due, () => w.checker.execute());
    assert.equal(w.emit("GameUpdate:cancel", {}).cancelled, true);
    w.at(due + 30_000, () => w.checker.execute());
    w.at(due + 59 * 60 * 1000, () => w.checker.execute());
    assert.equal(w.emit("GameUpdate:status", {}).scheduled, false, "not again within the hour");
    w.at(due + 30_000 + HOUR, () => w.checker.execute());
    const status = w.emit("GameUpdate:status", {});
    assert.equal(status.scheduled, true);
    assert.equal(status.id, "ScheduledRestart");
  } finally {
    w.done();
  }
});

test("without GameUpdate nobody is thrown out unwarned: no restart, said once", () => {
  const w = world({ config: { "ScheduledRestart:hours": 12 }, withGameUpdate: false });
  try {
    w.at(12 * HOUR, () => w.checker.execute());
    w.at(13 * HOUR, () => w.checker.execute());
    assert.equal(w.shutdowns.length, 0);
    assert.equal(w.logs.filter((line) => /GameUpdate is off/.test(line)).length, 1);
  } finally {
    w.done();
  }
});

test("::nextrestart tells the owner when it is", () => {
  const w = world({ config: { "ScheduledRestart:hours": 12 } });
  try {
    const told = [];
    w.at(2 * HOUR, () => w.commands.get("nextrestart")({ player: { sendMessage: (text) => told.push(text) } }));
    assert.equal(told[0], "The world restarts with a system update in 10 h 0 min (every 12 hours).");
  } finally {
    w.done();
  }
});
