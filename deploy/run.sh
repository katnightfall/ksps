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

case "${1:-}" in
  game)
    cd "$ROOT/server"
    export WEBSOCKET_PORT="$GAME_PORT"
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
    export PORT="$WEB_PORT"
    # The game cache the client downloads is the one the game server fetched. Named outright:
    # left to itself the web server only looks for that folder once, when it starts, and on a
    # new server it starts before the game has downloaded anything.
    export CACHE_DIR="$ROOT/server/caches"
    exec node scripts/serve-build.mjs
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
