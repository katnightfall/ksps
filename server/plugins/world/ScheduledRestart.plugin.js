/**
 * Ours. The world restarts itself every so many hours (the owner's wish, 2026-11-19: "a 12 hour
 * restart, and it uses the system update feature when it restarts").
 *
 * When the time comes it starts the game's system update (GameUpdate): every player is told in
 * chat and sees the "System update in" timer, and at zero the game saves everyone and exits with
 * UPDATE_RESTART_CODE. A world on the panel (deploy/pterodactyl/launch.mjs) then takes the newest
 * version of the project, builds what changed and starts again, as a restart from the panel does;
 * under systemd (deploy/run.sh, Restart=always) the game simply starts again.
 *
 * Only a world that something starts again arms it (TSPS_SUPERVISED=1, set by both of those): a
 * game run by hand would stay down.
 *
 * The hours count from when the game started. If a system update is already counting down
 * (::gameUpdate, the world config page), the world is restarting anyway and this one waits. If an
 * owner cancels the scheduled one (::gameUpdate cancel), it is tried again an hour later.
 *
 * World settings: ScheduledRestart:hours (0 turns it off), ScheduledRestart:countdownMinutes.
 */
const HOURS_CONFIG = "ScheduledRestart:hours";
const COUNTDOWN_CONFIG = "ScheduledRestart:countdownMinutes";
const DEFAULT_COUNTDOWN_MINUTES = 5;
const MAX_COUNTDOWN_MINUTES = 60;
const MAX_HOURS = 7 * 24;
/** The game's exit code for "take the newest version and start again" (deploy/pterodactyl/launch.mjs). */
const UPDATE_RESTART_CODE = 76;
/** How often the time is looked at, in game ticks (30 seconds). */
const CHECK_TICKS = 50;
const RETRY_AFTER_CANCEL_MS = 60 * 60 * 1000;
/** The id this plugin's system update carries, so that GameUpdate:status tells it from another's. */
const UPDATE_ID = "ScheduledRestart";
const TASK_KEY = {};

let api;
let core;
/** When the game process started (ms), whatever reloads this plugin. */
let startedAt = Date.now() - process.uptime() * 1000;
/** Not before this (ms): set when an owner cancelled ours. */
let notBefore = 0;
/** Our system update is counting down. */
let counting = false;
/** Said once: GameUpdate is off, so there is no system update to start. */
let toldNoGameUpdate = false;

const logger = () => core.Server.getLogger();

function hours() {
  const value = Number(api.getPluginConfig?.(HOURS_CONFIG, 0));
  return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_HOURS) : 0;
}

function countdownSeconds() {
  const value = Number(api.getPluginConfig?.(COUNTDOWN_CONFIG, DEFAULT_COUNTDOWN_MINUTES));
  const minutes = Number.isFinite(value) ? Math.round(value) : DEFAULT_COUNTDOWN_MINUTES;
  return Math.min(MAX_COUNTDOWN_MINUTES, Math.max(1, minutes)) * 60;
}

const supervised = () => process.env.TSPS_SUPERVISED === "1";

/** When the system update starts (ms): the restart itself lands `hours` after the start. */
function dueAt() {
  const period = hours();
  if (!period) return null;
  return Math.max(startedAt + period * 3600 * 1000 - countdownSeconds() * 1000, notBefore);
}

function gameUpdateStatus() {
  const payload = {};
  api.emitCustomEvent("GameUpdate:status", payload);
  return payload;
}

function check(now = Date.now()) {
  if (!supervised() || core.Server.isShuttingDown?.() === true) return;
  const due = dueAt();
  if (due === null) return;
  const status = gameUpdateStatus();
  if (counting) {
    if (status.scheduled === true && status.id === UPDATE_ID) return;
    // No longer ours and no shutdown under way: an owner cancelled it (or saving failed).
    counting = false;
    notBefore = now + RETRY_AFTER_CANCEL_MS;
    logger().info("[ScheduledRestart] the scheduled restart was cancelled; it is tried again in an hour");
    return;
  }
  if (status.scheduled === true || now < due) return;
  const seconds = countdownSeconds();
  const start = { seconds, exitCode: UPDATE_RESTART_CODE, id: UPDATE_ID };
  api.emitCustomEvent("GameUpdate:start", start);
  if (start.accepted === true) {
    counting = true;
    const minutes = seconds / 60;
    logger().info(`[ScheduledRestart] ${hours()} hours up: system update started, restarting in ${minutes} minute${minutes === 1 ? "" : "s"}`);
  } else if (start.error) {
    logger().warn?.(`[ScheduledRestart] the system update did not start: ${start.error}`);
  } else if (!toldNoGameUpdate) {
    toldNoGameUpdate = true;
    logger().warn?.("[ScheduledRestart] GameUpdate is off, so there is no system update to restart with; the world is not restarted");
  }
}

function describeNext() {
  const due = dueAt();
  if (due === null) return "Scheduled restarts are off on this world.";
  if (!supervised()) return "Scheduled restarts need a world that is started again by itself (the panel or the service).";
  if (counting) return "The scheduled restart's system update is counting down.";
  const minutes = Math.max(0, Math.round((due + countdownSeconds() * 1000 - Date.now()) / 60000));
  return `The world restarts with a system update in ${Math.floor(minutes / 60)} h ${minutes % 60} min (every ${hours()} hours).`;
}

module.exports = {
  name: "ScheduledRestart",
  description: "Restarts the world every so many hours with a system update: players see the countdown, then the game saves, takes the newest version and starts again.",
  config: {
    [HOURS_CONFIG]: {
      type: "number", label: "Restart every (hours)", default: 0, min: 0, max: MAX_HOURS,
      help: "The world restarts with a system update this many hours after it started, and takes the newest version as it starts again. 0 turns it off.",
    },
    [COUNTDOWN_CONFIG]: {
      type: "number", label: "Scheduled restart countdown (minutes)", default: DEFAULT_COUNTDOWN_MINUTES, integer: true, min: 1, max: MAX_COUNTDOWN_MINUTES,
      help: "How long players see the system update timer before a scheduled restart.",
    },
  },
  register(pluginApi) {
    api = pluginApi;
    core = pluginApi.core;
    const CheckTask = class extends core.Task {
      constructor() {
        super(CHECK_TICKS, TASK_KEY, false);
      }
      execute() {
        check();
      }
    };
    core.TaskManager.submit(new CheckTask());
    api.registerCommand("nextrestart", ({ player }) => {
      player.sendMessage(describeNext());
      return true;
    }, core.PlayerRights.OWNER, "When the world's scheduled restart is");
    api.onServerStartup?.(() => {
      if (dueAt() !== null && supervised()) logger().info(`[ScheduledRestart] ${describeNext()}`);
    });
  },
  _test: {
    check, dueAt, describeNext, UPDATE_RESTART_CODE, UPDATE_ID,
    reset: (at) => { startedAt = at; notBefore = 0; counting = false; toldNoGameUpdate = false; },
  },
};
