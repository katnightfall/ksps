/**
 * Ours. One set of characters for every world of a master (deploy/master/characters.mjs).
 *
 * A world made by the master is given the master's address and key (WORLDS_MASTER_URL and
 * MASTER_PROXY_KEY; the egg's variables of the same names). With both, this world:
 *
 *   at a login     asks the master for the account's saves and plays from those, so a character
 *                  is the same on whichever world it logs in. An account that is in another
 *                  world is refused ("logged in on <world>"). If the master cannot be reached the
 *                  login is refused too: playing on from an old copy would undo what was done on
 *                  another world. (World setting "MasterSync:offlineLogins" allows it.)
 *   in the world   tells the master every half minute who is here, and hands in each save the
 *                  game makes (autosaves within seconds, the logout save at once, which also lets
 *                  the character go). As the world stops, the last saves are handed in before
 *                  it exits.
 *   all the time   copies the saves other worlds handed in into its own save database, so its
 *                  hiscores rank every character of every world, and a login finds its save here
 *                  already.
 *
 * Bots are not characters: only a save an account logged in for is ever handed in.
 *
 * As it starts, the world also hands in the characters it had before it shared anything, once
 * each. Where the master already has a character of that name (made on another world meanwhile),
 * the one with more experience is kept, and that one is copied here.
 *
 * Kept in data/saves/master-sync.json: how far the copying has come, the master's version of
 * each save this world has, and which saves are still to be handed in (so a world that stops in
 * the middle hands them in when it starts). A fresh start (deploy/reset-accounts.mjs) moves it
 * aside with the saves. A world still on the old reset is told so by the master and plays on
 * its own until it has restarted.
 *
 * Not shared: bans and mutes, extra characters under one account, and changed display names
 * are still each world's own.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ENABLED_CONFIG = "MasterSync:enabled";
const OFFLINE_CONFIG = "MasterSync:offlineLogins";
const SYNC_HEADER = "x-master-sync";
const PROFILES = ["main", "league", "hardcore"];
const HEARTBEAT_MS = 30_000;
const PUSH_MS = 15_000;
const MIRROR_MS = 60_000;
const CALL_MS = 6_000;
// A login that asked for its saves and never entered the world (wrong password) is forgotten after this.
const PENDING_MS = 2 * 60_000;
// The logout save follows the logout at once; if none comes, the character is let go anyway after this.
const RELEASE_WAIT_MS = 3_000;
const MIRROR_PAGES = 10;
// The levelling bots' saves (bots/brain/SiteSpawner): never a player's, whatever another world calls its players.
const BOT_KEY = /^sitebot\d+$/;

/** The key two spellings of a login name share: capitals, underscores and extra spaces don't count. */
const nameKey = (name) => String(name ?? "").replace(/_/g, " ").trim().replace(/\s+/g, " ").toLowerCase();

/** A reset id as it is compared (deploy/master/characters.mjs resetKey): a world's copy has no "|" in it. */
const resetKey = (id) => String(id ?? "").replace(/[^A-Za-z0-9:._-]/g, "");
// Told by the master that this world is on an old reset: asked again after this long.
const STALE_RETRY_MS = 2 * 60_000;

/** `<time>.<signature>`, as the master checks it (deploy/master/characters.mjs signRequest). */
function signRequest(key, method, target, body = "", now = Date.now()) {
  const stamp = String(now);
  return `${stamp}.${crypto.createHmac("sha256", key).update(`${stamp}\n${method.toUpperCase()}\n${target}\n${body}`).digest("hex")}`;
}

/** The master to talk to, or null when this world has none. */
function settings(env = process.env) {
  const master = String(env.WORLDS_MASTER_URL ?? "").trim().replace(/\/+$/, "");
  const key = String(env.MASTER_PROXY_KEY ?? "").trim();
  return /^https?:\/\/[^\s/]+$/.test(master) && key.length >= 16 ? { master, key } : null;
}

/** Asks the master over HTTP: (method, target, body) -> { status, answer }. */
function httpCaller({ master, key }) {
  return async (method, target, body) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(`${master}${target}`, {
      method,
      headers: { [SYNC_HEADER]: signRequest(key, method, target, text), ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      body: method === "POST" ? text : undefined,
      signal: AbortSignal.timeout(CALL_MS),
    });
    return { status: response.status, answer: await response.json().catch(() => ({})) };
  };
}

/**
 * The syncing itself, apart from the game: `persistence` is the save database (saveKey,
 * currentJson, enqueue), `call` asks the master, `world` is this world's name, `reset` the reset
 * id it is on, `online()` the save keys of the people in the world, `kick(names, message)` puts
 * an account out.
 */
function createMasterSync({ persistence, call, world, reset = "", stateFile = null, offlineLogins = () => false, online = () => new Set(), localKeys = () => [], kick = () => {}, log = () => {}, now = () => Date.now() }) {
  /** name (lower case) -> the login it belongs to: { names, keys, online, releasing, at }. */
  const sessions = new Map();
  /** save key -> its login. Only these saves are handed in. */
  const tracked = new Map();
  /** save key -> { release, mark }: still to be handed in. */
  const dirty = new Map();
  /** save key -> the master's version of the save this world has. */
  const versions = new Map();
  let cursor = 0;
  let applying = false;
  let marks = 0;
  /**
   * While the master says this world is on an old reset it plays on its own. It asks again
   * every couple of minutes, so it shares as soon as the master agrees (`stale` is a time).
   */
  let staleUntil = 0;
  const isStale = () => now() < staleUntil;
  const markStale = (masterReset) => {
    if (!isStale()) log("stale_reset", { world: reset, master: masterReset ?? null });
    staleUntil = now() + STALE_RETRY_MS;
  };
  /** An answer that is neither yes nor a known no (a proxy's error page): said once per kind. */
  const odd = new Set();
  const unexpected = (what, status) => {
    if (odd.has(`${what}:${status}`)) return;
    odd.add(`${what}:${status}`);
    log("unexpected_answer", { call: what, status });
  };

  try {
    const kept = stateFile ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : null;
    // A file from another reset is another world's story.
    if (kept && String(kept.reset ?? "") === reset) {
      cursor = Math.max(0, Math.floor(Number(kept.cursor) || 0));
      for (const [key, version] of Object.entries(kept.versions ?? {})) versions.set(key, Number(version) || 0);
      // Whatever was still to be handed in when the world stopped: its player is gone, so it is let go too.
      for (const key of kept.dirty ?? []) dirty.set(key, { release: true, mark: ++marks });
    }
  } catch {}

  function persist() {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      // Written whole beside it, then put in its place. Written straight over the file, a stop or
      // a full disk in the middle left half a file, which the next start reads as nothing: the
      // saves still to hand in were forgotten, and the master's older copy then replaced them here.
      fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify({ reset, cursor, dirty: [...dirty.keys()], versions: Object.fromEntries(versions) }));
      fs.renameSync(`${stateFile}.tmp`, stateFile);
    } catch (error) {
      log("state_write_failed", { error: String(error?.message ?? error) });
    }
  }

  const keysFor = (names) => [...new Set(names.flatMap((name) => PROFILES.map((profile) => persistence.saveKey(name, profile))))];

  /** Writes a save that came from the master, without it being taken for one to hand in. */
  function apply(key, json) {
    applying = true;
    try {
      persistence.enqueue(key, [{ kind: "row", json }]);
    } finally {
      applying = false;
    }
  }

  function forget(session) {
    for (const key of session.keys) if (tracked.get(key) === session) tracked.delete(key);
    for (const name of session.names) if (sessions.get(name) === session) sessions.delete(name);
  }

  /** Hands one save in. Returns "done", "retry" (the master was not reached) or "dropped". */
  async function push(key) {
    const entry = dirty.get(key);
    if (!entry) return "done";
    const json = persistence.currentJson(key);
    if (typeof json !== "string") {
      dirty.delete(key);
      persist();
      return "dropped";
    }
    let result;
    try {
      result = await call("POST", "/sync/save", { world, reset, key, json, base: versions.get(key) ?? 0, release: entry.release === true });
    } catch {
      return "retry";
    }
    const { status, answer } = result;
    if (status === 200 && Number.isInteger(answer.version)) {
      versions.set(key, answer.version);
      // Saved again while this one was on its way: that one is still to go.
      if (dirty.get(key)?.mark === entry.mark) dirty.delete(key);
      persist();
      return "done";
    }
    if (status === 409 && answer.stale) {
      markStale(answer.reset);
      return "retry";
    }
    if (status >= 500 || status === 401 || status === 403) return "retry";
    // Another world has the character now, or saved it since: its save is the one that counts.
    log("save_not_taken", { key, lost: answer.lost ?? null, conflict: answer.conflict ?? null, stale: answer.stale === true });
    dirty.delete(key);
    persist();
    if (answer.lost) {
      const session = tracked.get(key);
      if (session?.online) kick(session.names, `Your account has logged in on ${answer.lost}.`);
    }
    return "dropped";
  }

  async function pushAll(keys = [...dirty.keys()]) {
    for (const key of keys) if (dirty.has(key)) await push(key);
  }

  /** The logout save is in (or never came): hand it in and let the account go. */
  async function finish(session) {
    if (session.finished) return;
    session.finished = true;
    session.online = false;
    for (const key of session.keys) if (dirty.has(key)) dirty.get(key).release = true;
    await pushAll([...session.keys]);
    try {
      await call("POST", "/sync/release", { world, reset, keys: [...session.keys] });
    } catch {}
    forget(session);
  }

  return {
    /**
     * Before a login reads the account's saves (PluginManager.onLoginPrepare): `request.names`
     * are its login names; `request.refuse` is set to refuse it.
     */
    async prepare(request) {
      if (isStale()) return;
      const names = [...new Set((request.names ?? []).map(nameKey))];
      const keys = keysFor(request.names ?? []);
      if (keys.length === 0) return;
      // What this world still owes the master of this account goes first.
      await pushAll(keys);
      let result;
      try {
        result = await call("POST", "/sync/checkout", { world, reset, keys });
      } catch {
        result = null;
      }
      if (!result || result.status >= 500 || result.status === 401) {
        if (!offlineLogins()) request.refuse = "The account server can't be reached. Please try again in a moment.";
        return;
      }
      const { status, answer } = result;
      if (status === 409 && answer.stale) {
        markStale(answer.reset);
        return;
      }
      if (status !== 200) {
        unexpected("checkout", status);
        return;
      }
      if (answer.busy) {
        request.refuse = `Your account is logged in on ${answer.busy}.`;
        return;
      }
      for (const row of answer.rows ?? []) {
        if (dirty.has(row.key)) continue;
        versions.set(row.key, Number(row.version) || 0);
        if (typeof row.json === "string" && persistence.currentJson(row.key) !== row.json) apply(row.key, row.json);
      }
      const session = { names, keys: new Set(keys), online: false, releasing: false, finished: false, at: now() };
      for (const name of names) sessions.set(name, session);
      for (const key of keys) tracked.set(key, session);
      persist();
    },

    /** The account entered the world: the master is told at once, so no other world lets it in. */
    async entered(username) {
      const session = sessions.get(nameKey(username));
      if (!session) return;
      session.online = true;
      session.releasing = false;
      session.finished = false;
      await this.heartbeat();
    },

    /** The account is leaving: its logout save, which follows, lets it go. */
    left(username) {
      const session = sessions.get(nameKey(username));
      if (!session || !session.online) return null;
      session.releasing = true;
      session.releaseBy = now() + RELEASE_WAIT_MS;
      return session;
    },

    /** The game wrote a save (every write to the save database comes through here). */
    rowWritten(key) {
      if (applying) return null;
      const session = tracked.get(key);
      if (!session) return null;
      dirty.set(key, { release: false, mark: ++marks });
      persist();
      return session.releasing ? finish(session) : null;
    },

    /** Who is here, said to the master; whoever another world has taken is put out. */
    async heartbeat() {
      if (isStale()) return;
      const here = [...new Set([...sessions.values()])].filter((session) => session.online);
      let result;
      try {
        result = await call("POST", "/sync/heartbeat", { world, reset, keys: here.flatMap((session) => [...session.keys]) });
      } catch {
        return;
      }
      if (result.status === 409 && result.answer.stale) markStale(result.answer.reset);
      else if (result.status !== 200) unexpected("heartbeat", result.status);
      // An account has several saves (one per profile): it is put out once.
      const taken = new Set((result.answer?.lost ?? []).map((key) => tracked.get(key)).filter((session) => session?.online));
      for (const session of taken) kick(session.names, "Your account has logged in on another world.");
    },

    /** Every so often: saves still to hand in, logouts whose save never came, logins that came to nothing. */
    async tick() {
      const at = now();
      for (const session of new Set(sessions.values())) {
        if (session.releasing && !session.finished && at >= session.releaseBy) await finish(session);
        else if (!session.online && !session.releasing && at - session.at > PENDING_MS) forget(session);
      }
      if (!isStale()) await pushAll();
    },

    /** Copies what other worlds handed in since last time into this world's save database. */
    async mirror() {
      if (isStale()) return 0;
      let copied = 0;
      for (let page = 0; page < MIRROR_PAGES; page++) {
        let result;
        try {
          result = await call("GET", `/sync/changes?since=${cursor}`);
        } catch {
          break;
        }
        const { status, answer } = result;
        if (status !== 200) {
          unexpected("changes", status);
          break;
        }
        if (resetKey(answer.reset) !== resetKey(reset)) break;
        const here = online();
        for (const row of answer.rows ?? []) {
          if (typeof row.json !== "string" || BOT_KEY.test(row.key)) continue;
          // A save of someone here, or one this world has yet to hand in, is newer here.
          if (tracked.get(row.key)?.online || dirty.has(row.key) || here.has(row.key)) continue;
          versions.set(row.key, Number(row.version) || 0);
          if (persistence.currentJson(row.key) !== row.json) {
            apply(row.key, row.json);
            copied++;
          }
        }
        cursor = Math.max(cursor, Number(answer.cursor) || 0);
        if (!answer.more) break;
      }
      persist();
      return copied;
    },

    /**
     * Hands in the characters this world had before it shared anything (`localKeys()`: every
     * save it holds), once each. The master keeps its own where it has a more played one of
     * that name, and the copying that follows brings that one here. Returns how many it took.
     */
    async seed() {
      if (isStale()) return 0;
      let taken = 0;
      for (const key of localKeys()) {
        if (BOT_KEY.test(key) || versions.has(key) || dirty.has(key)) continue;
        const json = persistence.currentJson(key);
        if (typeof json !== "string") continue;
        let result;
        try {
          result = await call("POST", "/sync/seed", { world, reset, key, json });
        } catch {
          break;
        }
        if (result.status === 409 && result.answer.stale) {
          markStale(result.answer.reset);
          break;
        }
        if (result.status !== 200) {
          unexpected("seed", result.status);
          break;
        }
        // Known to the master now, whichever copy it kept: never handed in this way again.
        versions.set(key, result.answer.kept ? 0 : Number(result.answer.version) || 0);
        if (!result.answer.kept) taken++;
      }
      persist();
      if (taken) log("seeded", { characters: taken });
      return taken;
    },

    /**
     * The world is stopping, its last saves written: they are handed in before it goes, and
     * its characters let go, so a player who moves to another world at once finds there what
     * they had here (a setting changed a minute ago, not the copy of the last autosave).
     * Given `limitMs` at most: a master out of reach must not hold a shutdown up, and what
     * could not be sent is handed in when the world starts again.
     */
    async shutdown(limitMs = 10_000) {
      if (isStale()) return;
      for (const entry of dirty.values()) entry.release = true;
      const keys = [...tracked.keys()];
      const work = (async () => {
        await pushAll();
        if (keys.length) await call("POST", "/sync/release", { world, reset, keys }).catch(() => {});
      })();
      let timer;
      await Promise.race([work.catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, limitMs); })]);
      clearTimeout(timer);
    },

    /** The world has just started: nobody is here, and what it still owed is handed in. */
    async started() {
      await this.heartbeat();
      await pushAll();
      await this.seed();
      await this.mirror();
    },

    state: () => ({ cursor, stale: isStale(), dirty: [...dirty.keys()], tracked: [...tracked.keys()], versions: Object.fromEntries(versions) }),
  };
}

/** The reset id this world is on (deploy/reset-accounts.mjs writes it beside the saves). */
function worldResetId(savesDir) {
  try {
    return fs.readFileSync(path.join(savesDir, ".accounts-reset"), "utf8").trim();
  } catch {
    return "";
  }
}

module.exports = {
  name: "MasterSync",
  description: "On a world of a master: characters are shared with the master's other worlds (fetched at login, handed in on every save), an account can be in one world at a time, and every world's saves are copied here so the hiscores rank them all.",
  config: {
    [ENABLED_CONFIG]: {
      type: "boolean", label: "Share characters with the master's other worlds", default: true,
      help: "Only on a world that was given a master's address and key (WORLDS_MASTER_URL and MASTER_PROXY_KEY). Off: this world keeps its characters to itself.",
    },
    [OFFLINE_CONFIG]: {
      type: "boolean", label: "Let players in while the master cannot be reached", default: false,
      help: "Off (recommended): a login waits for the master, so nobody plays on from an old copy of a character. On: logins go ahead from this world's own copy; what was done on another world since may be lost.",
    },
  },
  register(api) {
    const master = settings();
    if (!master || api.getPluginConfig?.(ENABLED_CONFIG, true) === false) return;
    const { PluginManager } = require("../../src/main/typescript/elvarg/plugins/PluginManager");
    const { GameConstants } = require("../../src/main/typescript/elvarg/game/GameConstants");
    const core = api.core;
    const savesDir = path.join(process.cwd(), "data", "saves");
    let sync = null;
    let stopping = false;
    api.onServerShutdown?.(() => { stopping = true; });

    api.onServerStartup(() => {
      const persistence = GameConstants.PLAYER_PERSISTENCE;
      if (typeof persistence?.enqueue !== "function" || typeof persistence.currentJson !== "function") {
        console.warn("[master-sync] off: this world's save database is not the SQLite one");
        return;
      }
      const keyOf = (player) => persistence.saveKey(player.getUsername(), player.getProfile?.() ?? "main");
      sync = createMasterSync({
        persistence,
        call: httpCaller(master),
        world: String(core.WorldDefinition.getWorldDefinition().name ?? ""),
        reset: worldResetId(savesDir),
        stateFile: path.join(savesDir, "master-sync.json"),
        offlineLogins: () => api.getPluginConfig?.(OFFLINE_CONFIG, false) === true,
        online: () => new Set([...core.World.getPlayers()].filter((player) => player && player.isPlayerBot?.() !== true).map(keyOf)),
        // Every save this world holds, by its key (the save database's own read connection).
        localKeys: () => {
          try {
            return persistence.database.prepare("SELECT username FROM player_saves").all().map((row) => row.username);
          } catch {
            return [];
          }
        },
        kick(names, message) {
          for (const name of names) {
            const player = core.World.getPlayerByName(name);
            if (!player || player.isPlayerBot?.() === true) continue;
            player.sendMessage?.(message);
            player.requestLogout?.();
          }
        },
        log: (event, details) => console.info(`[master-sync] ${event} ${JSON.stringify(details ?? {})}`),
      });
      // Every write to the save database passes here: the game's own saves are handed in.
      const enqueue = persistence.enqueue.bind(persistence);
      persistence.enqueue = (key, writes) => {
        const seq = enqueue(key, writes);
        if (Array.isArray(writes) && writes.some((write) => write?.kind === "row")) {
          Promise.resolve(sync.rowWritten(key)).catch((error) => console.error("[master-sync] handing in a save failed", error));
        }
        return seq;
      };
      // The engine waits for the save database to be written before it exits (Server's
      // shutdown awaits flush): the hand-in of those last saves is waited for in the same place.
      const flush = persistence.flush.bind(persistence);
      persistence.flush = async () => {
        await flush();
        if (stopping) await sync.shutdown();
      };
      const quietly = (work) => () => { work().catch((error) => console.error("[master-sync]", error)); };
      setInterval(quietly(() => sync.heartbeat()), HEARTBEAT_MS).unref();
      setInterval(quietly(() => sync.tick()), PUSH_MS).unref();
      setInterval(quietly(() => sync.mirror()), MIRROR_MS).unref();
      quietly(() => sync.started())();
      console.info(`[master-sync] characters are shared through ${master.master}`);
    });
    PluginManager.onLoginPrepare((request) => sync?.prepare(request));
    api.onPlayerLogin(({ player }) => {
      if (!sync || player.isPlayerBot?.() === true) return;
      sync.entered(player.getUsername()).catch((error) => console.error("[master-sync]", error));
    });
    api.onPlayerLogout(({ player }) => {
      if (!sync || player.isPlayerBot?.() === true) return;
      sync.left(player.getUsername());
    });
  },
  _test: { createMasterSync, settings, signRequest, worldResetId, SYNC_HEADER, PROFILES },
};
