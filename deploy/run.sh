#!/usr/bin/env bash
# What runs on the server, always as the unprivileged tsps user: the two
# services start through this file, and the updater uses it to install
# packages and build. It travels with every deploy, so how the server starts
# and builds is changed here, not in the service files or the updater.
#
#   run.sh game            the game server (what start:prod in server/package.json does)
#   run.sh web             the web client's static server
#   run.sh install <pkg>   install the packages of server or client
#   run.sh build-server
#   run.sh build-client
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_PORT=3000
GAME_PORT=43594
CONF="${TSPS_CONF:-/etc/tsps-deploy.conf}"
# shellcheck disable=SC1090
if [ -f "$CONF" ]; then . "$CONF"; fi

# MASTER_ONLY=1 in deploy/settings.env: this server is the master and hosts no world of its own.
# The worlds run on the panel's nodes; here are the website, the admin page and the carrying of
# their connections (deploy/front.mjs). Set it to 0 and deploy to run a world here again.
MASTER_ONLY="$(sed -n 's/^MASTER_ONLY=\([01]\)[[:space:]]*$/\1/p' "$ROOT/deploy/settings.env" 2>/dev/null | tail -n 1)"

case "${1:-}" in
  game)
    cd "$ROOT/server"
    # The one folder the website's service may write to (the admin page's worlds, deploy/master/):
    # made here, by the service that may make it.
    mkdir -p "$ROOT/server/data/saves/master"
    # A fresh start the master called (deploy/reset-accounts.mjs): the saves are moved aside, once,
    # before anything opens them.
    node "$ROOT/deploy/reset-accounts.mjs" || true
    export WEBSOCKET_PORT="$GAME_PORT"
    if [ "$MASTER_ONLY" = 1 ]; then
      # No world here. The website still hands players the game cache, which the game server
      # used to fetch when it started: fetched here instead, beside the parked port, so a
      # slow download cannot keep the port shut (the updater waits on it).
      (TS_NODE_COMPILER_OPTIONS='{"target":"es2020"}' node node_modules/ts-node/dist/bin.js ./scripts/ensure-cache.ts \
        || echo "[parked] the game cache could not be checked; the website serves the one it has") &
      # Quest Helper's engine, once for every world of this master (deploy/quest-helper.mjs): the
      # worlds have no Java, so they ask this one through the website. It fetches and builds what
      # it needs by itself and is kept running beside the parked port. QUEST_HELPER_BRIDGE=0 in
      # deploy/settings.env turns it off.
      if [ "$(sed -n 's/^QUEST_HELPER_BRIDGE=\([01]\)[[:space:]]*$/\1/p' "$ROOT/deploy/settings.env" 2>/dev/null | tail -n 1)" != 0 ]; then
        node "$ROOT/deploy/quest-helper.mjs" &
      fi
      exec node "$ROOT/deploy/master/parked.mjs"
    fi
    # The world config page saves, then exits with code 75 for systemd to start it again.
    export TSPS_SUPERVISED=1
    # The same switches as start:prod. Keep the two in step when upstream changes them.
    export BOT_RUNTIME_EVENT_LOGGING=0 BOT_RUNTIME_TELEMETRY_ENABLED=0 BOT_TASK_PROFILER_ENABLED=0
    export TASK_SLOW_WARN_ENABLED=0 PROJECTILE_DEBUG=0 MAGIC_CAST_DEBUG=0
    # One process, so systemd's stop signal reaches the server itself and it saves every
    # player before it exits. The .env files are read the way scripts/run-with-env.mjs
    # reads them (server/.env over the root one), then deploy/settings.env over those,
    # and anything set above over all of them.
    exec node --env-file-if-exists=../.env --env-file-if-exists=.env --env-file-if-exists=../deploy/settings.env \
      --max-old-space-size="${GAME_HEAP_MB:-8192}" --max-semi-space-size=16 ./dist/Server.js
    ;;
  web)
    cd "$ROOT/client"
    export PORT="$WEB_PORT" GAME_PORT
    # The game cache the client downloads is the one the game server fetched. Named outright:
    # left to itself the web server only looks for that folder once, when it starts, and on a
    # new server it starts before the game has downloaded anything.
    export CACHE_DIR="$ROOT/server/caches"
    # The worlds our landing page and the game's world picker list (deploy/worlds.mjs).
    export WORLDS_FILE="${WORLDS_FILE:-deploy/worlds.json}"
    # This server is the master: the admin page (/admin) and the worlds made there (deploy/master/).
    export MASTER_ADMIN=1 MASTER_ONLY="${MASTER_ONLY:-0}"
    # The front door: the website (client/scripts/serve-build.mjs, which it starts), and the game
    # connection and the game's /api addresses passed on to the game server, all on this one port.
    exec node "$ROOT/deploy/front.mjs"
    ;;
  install)
    case "${2:-}" in server|client) ;; *) echo "install server or client"; exit 1 ;; esac
    cd "$ROOT/$2"
    # The Yarn version the project pins, fetched through npm like `npm run setup` does.
    yarn_version="$(node -p 'require("./package.json").packageManager.split("@")[1].split("+")[0]')"
    exec npm exec --yes --package "@yarnpkg/cli-dist@$yarn_version" -- yarn install --immutable
    ;;
  build-server)
    cd "$ROOT/server"
    exec npm run --silent build
    ;;
  build-client)
    cd "$ROOT/client"
    # package.json mounts the client at /play (where rsps.app serves it). Here it is the whole site.
    export PUBLIC_URL=/
    # The client looks for the game on the page's own host, port 43594, unless told otherwise.
    if [ "$GAME_PORT" != 43594 ] && ! grep -qs '^REACT_APP_DEFAULT_WS_URL=' ../.env ../deploy/settings.env; then
      export REACT_APP_DEFAULT_WS_URL="ws://localhost:$GAME_PORT"
      export REACT_APP_DEFAULT_SERVER_ADDRESS="localhost:$GAME_PORT"
    fi
    # What "build" in client/package.json runs, with deploy/settings.env read first so its
    # lines win over the server's .env. Keep the two in step when upstream changes theirs.
    node --env-file-if-exists=../deploy/settings.env ../scripts/run-with-env.mjs production \
      ./node_modules/@craco/craco/dist/bin/craco.js build
    exec node scripts/serve-build.mjs --precompress
    ;;
  *)
    echo "run.sh game | web | install <server|client> | build-server | build-client"
    exit 1
    ;;
esac
