#!/usr/bin/env bash
# Updates TSPS on its server. It is the only thing the deploy key can run
# (`npm run deploy`, set up once with deploy/setup.sh): a fixed, root-owned
# copy at /usr/local/sbin/tsps-update, and the key can only ask it for
#
#   update <commit|full>   the new files arrive as a .tgz on stdin
#   rebuild                build both halves again from what is installed
#   version | check | status | logs [game|web|update] [lines] | restart [game|web] | rollback
#
# How an update goes:
#   - Only the files that changed since the version on the server are sent,
#     with the list of every file the new version has. Files that left the
#     project are removed; files the project never had (saves, the game
#     cache, logs, .env, your world settings) are never looked at.
#   - If the game server's code or the web client changed, it is built in a
#     copy beside the live one first. A build that fails changes nothing.
#   - What gets replaced is kept as a backup, the new files go in, and only
#     the half that changed is restarted: a client-only update leaves the
#     game server and everyone playing alone.
#   - If the restarted half does not come back up, the backup is put back.
#
# Root does very little here: it passes the upload on, restarts the two
# services and reads their logs. Everything that touches the project's files
# runs as the tsps user, so nothing from an upload ever runs as root.
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
TEST="${TSPS_TEST:-}"                      # set by the simulated runs on the dev PC
CONF="${TSPS_CONF:-/etc/tsps-deploy.conf}"
DEST="${TSPS_DEST:-/opt/tsps}"
BASE="${TSPS_BASE:-/opt/tsps-deploy}"
APP_USER=tsps
INSTALLED=/usr/local/sbin/tsps-update
WEB_PORT=3000
GAME_PORT=43594
# shellcheck disable=SC1090
if [ -f "$CONF" ]; then . "$CONF"; fi      # WEB_PORT, GAME_PORT (root-owned file)

STAGE="$BASE/stage"
INCOMING="$BASE/incoming"
BACKUPS="$BASE/backups"
KEEP_BACKUPS=3
GAME_WAIT="${GAME_WAIT:-600}"              # seconds the game server gets to open its port
FIRST_GAME_WAIT="${FIRST_GAME_WAIT:-2400}" # the first start also downloads the game cache
WEB_WAIT="${WEB_WAIT:-40}"
export LC_ALL=C

# What belongs to the server: never sent, never copied to the build folder, never replaced.
OWN=(.env node_modules server/node_modules client/node_modules server/dist client/build
  server/caches server/logs .yarn server/.yarn client/.yarn)
# Live state that sits among the project's own files: once it exists here it is
# never overwritten or removed (bans and mutes are rewritten by the running server).
protected() { case "$1" in server/data/saves/*) return 0 ;; esac; return 1; }

say() { printf '%s\n' "$*"; }
fail() { say "$*"; exit 1; }

# ====================================================================================================
# The parts that run as the tsps user (this same file, started again with --phase).
# ====================================================================================================

flag() {   # name -> 0 or 1, from the plan the stage phase wrote
  if grep -qx "$1=1" "$INCOMING/plan" 2>/dev/null; then echo 1; else echo 0; fi
}

run_logged() {   # log name, what it is, command...
  local log="$INCOMING/$1.log" what="$2"
  shift 2
  if ! "$@" > "$log" 2>&1; then
    say "$what failed. The live server was not touched. The end of the log:"
    tail -n 40 "$log"
    exit 1
  fi
}

phase_stage() {   # <commit of the version the upload builds on> | full | rebuild
  local base="$1" src="$INCOMING/tree" current new_commit first=0
  rm -rf "$INCOMING" "$STAGE"
  mkdir -p "$src" "$BACKUPS"
  current="$(cat "$BASE/commit" 2>/dev/null || echo none)"
  if [ "$current" = none ]; then first=1; fi

  if [ "$base" = rebuild ]; then
    if [ "$first" = 1 ]; then fail "Nothing is installed yet, so there is nothing to rebuild. Run npm run deploy."; fi
    new_commit="$current"
    cp "$BASE/manifest" "$INCOMING/manifest"
    : > "$INCOMING/changed"
    : > "$INCOMING/deleted"
  else
    tar -xzmf - -C "$src" --no-same-owner     # -m: the PC's clock may run a little ahead of this one
    if [ ! -f "$src/.tsps-deploy/commit" ] || [ ! -f "$src/.tsps-deploy/manifest" ]; then fail "That upload isn't a TSPS deploy."; fi
    new_commit="$(tr -dc '0-9a-f' < "$src/.tsps-deploy/commit" | head -c 40)"
    if [ "${#new_commit}" -ne 40 ]; then fail "The upload doesn't say which version it is."; fi
    if [ "$base" != full ] && [ "$base" != "$current" ]; then
      say "BASE-MISMATCH: the server has $current, the upload builds on $base."
      exit 3
    fi
    sort -u "$src/.tsps-deploy/manifest" > "$INCOMING/manifest"
    rm -rf "$src/.tsps-deploy"
    # Every path stays inside the project folder: nothing absolute, no "..", nothing odd.
    if grep -qE '^$|^/|^-|/$|//|(^|/)\.\.?(/|$)|\\|[^ -~]' "$INCOMING/manifest"; then
      fail "The upload lists a file name this updater won't take. Nothing was changed."
    fi
    if [ -n "$(find "$src" -type l -print -quit)" ]; then fail "The upload contains a link, which this updater won't take. Nothing was changed."; fi
    local own
    for own in "${OWN[@]}"; do
      if [ -e "$src/$own" ] || grep -qE "^${own//./\\.}(/|$)" "$INCOMING/manifest"; then
        fail "The upload contains $own, which belongs to the server. Nothing was changed."
      fi
    done
    (cd "$src" && find . -type f -print | sed 's|^\./||' | sort) > "$INCOMING/arrived"
    if [ -n "$(comm -23 "$INCOMING/arrived" "$INCOMING/manifest" | head -1)" ]; then fail "The upload has files its own list doesn't. Nothing was changed."; fi
    if [ "$base" = full ] && ! cmp -s "$INCOMING/arrived" "$INCOMING/manifest"; then fail "The full upload is missing files. Nothing was changed."; fi

    local p
    while IFS= read -r p; do
      if protected "$p" && [ -e "$DEST/$p" ]; then continue; fi
      printf '%s\n' "$p"
    done < "$INCOMING/arrived" > "$INCOMING/changed"
    if [ -f "$BASE/manifest" ]; then
      comm -23 "$BASE/manifest" "$INCOMING/manifest" | while IFS= read -r p; do
        if protected "$p"; then continue; fi
        printf '%s\n' "$p"
      done > "$INCOMING/deleted"
    else
      : > "$INCOMING/deleted"
    fi
  fi
  say "$new_commit" > "$INCOMING/commit"

  # ---- what this update needs -----------------------------------------------------------------------
  cat "$INCOMING/changed" "$INCOMING/deleted" > "$INCOMING/touched"
  touched() { grep -qE "$1" "$INCOMING/touched"; }
  touched_except() {   # is there a path matching the first pattern that doesn't match the second
    awk -v a="$1" -v b="$2" '$0 ~ a && $0 !~ b { found = 1; exit } END { exit !found }' "$INCOMING/touched"
  }
  local pk_server=0 pk_client=0 build_server=0 build_client=0 restart_game=0 restart_web=0
  if touched '^server/(package\.json|yarn\.lock)$' || [ ! -d "$DEST/server/node_modules" ]; then pk_server=1; fi
  if touched '^client/(package\.json|yarn\.lock)$' || [ ! -d "$DEST/client/node_modules" ]; then pk_client=1; fi
  if [ "$base" = rebuild ] || [ "$pk_server" = 1 ] || [ ! -f "$DEST/server/dist/Server.js" ] \
    || touched '^server/(src/|tsconfig)'; then build_server=1; fi
  # The client build also pulls in three files of the server's (client/craco.config.js).
  if [ "$base" = rebuild ] || [ "$pk_client" = 1 ] || [ ! -f "$DEST/client/build/index.html" ] \
    || touched_except '^client/' '^client/(tests/|scripts/serve-build[.]mjs$)' \
    || touched '^server/plugins/(world/ContinuousMotion\.FreeMovement\.js|items/BlightedItems\.js|items/data/food\.json)$' \
    || touched '^scripts/run-with-env\.mjs$'; then build_client=1; fi
  if [ "$build_server" = 1 ] || touched '^deploy/run\.sh$' \
    || touched_except '^server/' '^server/(tests|docs|scripts|deploy)/'; then restart_game=1; fi
  if [ "$first" = 1 ] || touched '^(deploy/run\.sh|client/scripts/serve-build\.mjs)$'; then restart_web=1; fi
  # Our own settings file: the game reads it at start, the client build reads some of its lines.
  if touched '^deploy/settings\.env$'; then
    restart_game=1
    client_lines() { grep -E '^(REACT_APP_|WEBRTC_)' "$1" 2>/dev/null | sort || true; }
    if [ "$(client_lines "$src/deploy/settings.env")" != "$(client_lines "$DEST/deploy/settings.env")" ]; then build_client=1; fi
  fi
  printf '%s\n' "pk_server=$pk_server" "pk_client=$pk_client" "build_server=$build_server" "build_client=$build_client" \
    "restart_game=$restart_game" "restart_web=$restart_web" "first=$first" > "$INCOMING/plan"

  say "Files: $(wc -l < "$INCOMING/changed" | tr -d ' ') new or changed, $(wc -l < "$INCOMING/deleted" | tr -d ' ') removed."
  if [ "$pk_server$pk_client$build_server$build_client" = 0000 ]; then return 0; fi

  # ---- build beside the live copy -------------------------------------------------------------------
  say "Copying the live version to build the new one beside it..."
  mkdir -p "$STAGE"
  if [ "$first" = 0 ]; then
    local excludes=(--exclude=./server/data/saves) own
    for own in "${OWN[@]}"; do excludes+=("--exclude=./$own"); done
    tar -C "$DEST" --anchored "${excludes[@]}" -cf - . | tar -C "$STAGE" -xf -
  fi
  if [ -s "$INCOMING/changed" ]; then tar -C "$src" -cf - --verbatim-files-from -T "$INCOMING/changed" | tar -C "$STAGE" -xf -; fi
  if [ -s "$INCOMING/deleted" ]; then (cd "$STAGE" && xargs -d '\n' rm -f -- < "$INCOMING/deleted"); fi
  if [ -f "$DEST/.env" ]; then cp -p "$DEST/.env" "$STAGE/.env"; fi     # the client build reads its REACT_APP_ settings from it

  local pkg
  for pkg in server client; do
    if [ "$(flag "pk_$pkg")" = 1 ]; then
      say "Installing the $pkg packages (a few minutes)..."
      run_logged "install-$pkg" "Installing the $pkg packages" bash "$STAGE/deploy/run.sh" install "$pkg"
    else
      ln -s "$DEST/$pkg/node_modules" "$STAGE/$pkg/node_modules"
    fi
  done
  if [ "$build_server" = 1 ]; then
    say "Building the game server..."
    run_logged build-server "Building the game server" bash "$STAGE/deploy/run.sh" build-server
    if [ ! -f "$STAGE/server/dist/Server.js" ]; then fail "The game server build finished without making dist/Server.js. The live server was not touched."; fi
  fi
  if [ "$build_client" = 1 ]; then
    say "Building the web client (several minutes)..."
    run_logged build-client "Building the web client" bash "$STAGE/deploy/run.sh" build-client
    if [ ! -f "$STAGE/client/build/index.html" ]; then fail "The web client build finished without making build/index.html. The live server was not touched."; fi
  fi
}

swap_in() {   # what, live path, staged path, backup path
  if [ -e "$2" ]; then mv "$2" "$4"; fi
  mkdir -p "$(dirname "$2")"
  mv "$3" "$2"
}

phase_swap() {
  local id b src="$INCOMING/tree" p
  id="$(date +%Y%m%d-%H%M%S)"
  b="$BACKUPS/$id"
  mkdir -p "$b" "$DEST"

  # What is about to be replaced or removed, and what will be new (to take out again on a rollback).
  cat "$INCOMING/changed" "$INCOMING/deleted" | (cd "$DEST" && while IFS= read -r p; do
    if [ -e "$p" ]; then printf '%s\n' "$p"; fi
  done) | sort > "$b/replaced"
  comm -23 "$INCOMING/changed" "$b/replaced" > "$b/added"
  if [ -s "$b/replaced" ]; then tar -C "$DEST" -czf "$b/old.tgz" --verbatim-files-from -T "$b/replaced"; fi
  if [ -f "$BASE/commit" ]; then cp "$BASE/commit" "$BASE/manifest" "$b/"; fi
  cp "$INCOMING/plan" "$b/plan"

  if [ -s "$INCOMING/changed" ]; then tar -C "$src" -cf - --verbatim-files-from -T "$INCOMING/changed" | tar -C "$DEST" -xf -; fi
  if [ -s "$INCOMING/deleted" ]; then
    (cd "$DEST" && xargs -d '\n' rm -f -- < "$INCOMING/deleted")
    # Folders the removals emptied.
    sed -n 's|/[^/]*$||p' "$INCOMING/deleted" | sort -ur | (cd "$DEST" && while IFS= read -r p; do
      rmdir -p --ignore-fail-on-non-empty "$p" 2>/dev/null || true
    done)
  fi
  local pkg
  for pkg in server client; do
    if [ "$(flag "pk_$pkg")" = 1 ]; then swap_in packages "$DEST/$pkg/node_modules" "$STAGE/$pkg/node_modules" "$b/node_modules-$pkg"; fi
  done
  if [ "$(flag build_server)" = 1 ]; then swap_in server "$DEST/server/dist" "$STAGE/server/dist" "$b/dist"; fi
  if [ "$(flag build_client)" = 1 ]; then swap_in client "$DEST/client/build" "$STAGE/client/build" "$b/build"; fi

  cp "$INCOMING/manifest" "$BASE/manifest"
  cp "$INCOMING/commit" "$BASE/commit"
  say "$id" > "$BASE/last-backup"
  say "The new files are in place (what they replaced is kept as backup $id)."
}

put_back() {   # live path, backup path
  if [ -e "$2" ]; then
    rm -rf "$1"
    mv "$2" "$1"
  fi
}

phase_rollback() {
  local id b pkg
  id="$(cat "$BASE/last-backup" 2>/dev/null || true)"
  b="$BACKUPS/$id"
  if [ -z "$id" ] || [ ! -f "$b/plan" ]; then fail "There is no backup to go back to."; fi
  if [ -s "$b/added" ]; then (cd "$DEST" && xargs -d '\n' rm -f -- < "$b/added"); fi
  if [ -f "$b/old.tgz" ]; then tar -C "$DEST" -xzf "$b/old.tgz" --no-same-owner; fi
  for pkg in server client; do put_back "$DEST/$pkg/node_modules" "$b/node_modules-$pkg"; done
  put_back "$DEST/server/dist" "$b/dist"
  put_back "$DEST/client/build" "$b/build"
  if [ -f "$b/commit" ]; then
    cp "$b/commit" "$b/manifest" "$BASE/"
  else
    rm -f "$BASE/commit" "$BASE/manifest"     # it was the first install
  fi
  cp "$b/plan" "$BASE/rolled-back-plan"
  rm -rf "$b"
  # The backup before that one becomes the next to go back to.
  (cd "$BACKUPS" && ls -1d 20* 2>/dev/null | sort | tail -n 1) > "$BASE/last-backup" || true
  say "Backup $id is back in place."
}

phase_finish() {
  rm -rf "$STAGE" "$INCOMING/tree"
  (cd "$BACKUPS" && ls -1d 20* 2>/dev/null | sort -r | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -rf --) || true
}

if [ "${1:-}" = "--phase" ]; then
  if [ -z "$TEST" ] && [ "$(id -un)" != "$APP_USER" ]; then fail "The phases run as $APP_USER."; fi
  umask 022
  case "${2:-}" in
    stage) phase_stage "${3:-}" ;;
    swap) phase_swap ;;
    rollback) phase_rollback ;;
    finish) phase_finish ;;
    *) fail "Unknown phase." ;;
  esac
  exit 0
fi

# ====================================================================================================
# The part that runs as root.
# ====================================================================================================

as_app() {
  if [ -n "$TEST" ]; then "$@"; else runuser -u "$APP_USER" -- env HOME="$BASE/home" PATH="$PATH" "$@"; fi
}
phase() { as_app bash "$SELF" --phase "$@"; }
service() {   # start|restart|is-active|status, game|web
  if [ -n "$TEST" ]; then "${TSPS_TEST_SERVICE:-true}" "$1" "$2"; else systemctl "$1" "tsps-$2" "${@:3}"; fi
}
up() {
  if [ -n "$TEST" ]; then "${TSPS_TEST_UP:-true}" "$1"; else (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; fi
}
wait_up() {   # what, port, seconds
  local i
  for ((i = 0; i < $3; i += 2)); do
    if up "$2"; then return 0; fi
    if [ "$i" -gt 0 ] && [ $((i % 60)) -eq 0 ]; then say "  ...the $1 is still starting (${i}s)"; fi
    if [ -z "$TEST" ]; then sleep 2; fi
  done
  return 1
}
show_logs() {   # game|web, lines
  local n="${2:-200}"
  if [[ ! "$n" =~ ^[0-9]{1,5}$ ]]; then n=200; fi
  if [ -n "$TEST" ]; then say "(log of $1)"; else journalctl -u "tsps-$1" -n "$n" --no-pager; fi
}
restart_and_wait() {   # game 0|1, web 0|1, seconds for the game
  local ok=0
  if [ "$1" = 1 ]; then
    say "Restarting the game server (players are saved and disconnected)..."
    service restart game
    if ! wait_up "game server" "$GAME_PORT" "$3"; then
      say "The game server did not open port $GAME_PORT. Its log:"
      show_logs game 40
      ok=1
    fi
  else
    service start game || true
  fi
  if [ "$2" = 1 ]; then
    service restart web
  else
    service start web || true
  fi
  if ! wait_up "web client" "$WEB_PORT" "$WEB_WAIT"; then
    say "The web client is not answering on port $WEB_PORT. Its log:"
    show_logs web 40
    ok=1
  fi
  return "$ok"
}
check() {
  local commit last
  commit="$(cat "$BASE/commit" 2>/dev/null || echo 'nothing installed yet')"
  say "Version:       $commit"
  say "Folder:        $DEST"
  say "Node:          $(node -v 2>/dev/null || echo 'not found')"
  if up "$GAME_PORT"; then say "Game server:   answering on $GAME_PORT"; else say "Game server:   NOT answering on $GAME_PORT"; fi
  if up "$WEB_PORT"; then say "Web client:    answering on $WEB_PORT"; else say "Web client:    NOT answering on $WEB_PORT"; fi
  if [ -f "$DEST/server/data/saves/players.sqlite" ]; then say "Player saves:  $(du -h "$DEST/server/data/saves/players.sqlite" | cut -f1) (server/data/saves/players.sqlite)"
  else say "Player saves:  none yet"; fi
  if [ -d "$DEST" ]; then say "Disk free:     $(df -h "$DEST" | awk 'NR==2 { print $4 " of " $2 }')"; fi
  if [ -r /proc/meminfo ]; then say "Memory:        $(awk '/MemAvailable/ { a = $2 } /MemTotal/ { t = $2 } END { printf "%.1f GB free of %.1f GB", a / 1048576, t / 1048576 }' /proc/meminfo)"; fi
  last="$(cat "$BASE/last-backup" 2>/dev/null || true)"
  say "Last backup:   ${last:-none yet}"
  if [ -z "$TEST" ] && [ -f "$DEST/deploy/update.sh" ] && ! cmp -s "$DEST/deploy/update.sh" "$INSTALLED"; then
    say "Note:          the updater on this server is older than the one in the project (see the end of an update)."
  fi
}

if [ -z "$TEST" ] && [ "$(id -u)" -ne 0 ]; then fail "Run it as root."; fi
if [ ! -d "$BASE" ]; then fail "This server isn't set up for deploys yet. Run npm run deploy:setup once."; fi
cd /     # the login's home folder, where this starts, is closed to the tsps user
UPDATE_LOG=/var/log/tsps-update.log

args=("$@")
if [ "${1:-}" = "--ssh" ]; then read -r -a args <<< "${2:-${SSH_ORIGINAL_COMMAND:-}}"; fi
which="${args[1]:-}"
case "${args[0]:-}" in
  update|rebuild) ;;
  version) cat "$BASE/commit" 2>/dev/null || say none; exit ;;
  check) check; exit ;;
  status)
    if [ -n "$TEST" ]; then say "(status)"; else systemctl status tsps-game tsps-web --no-pager || true; fi
    exit ;;
  logs)
    case "$which" in
      game|web) show_logs "$which" "${args[2]:-200}" ;;
      update)   # what the last updates printed, for when the connection dropped during one
        n="${args[2]:-80}"
        if [[ ! "$n" =~ ^[0-9]{1,5}$ ]]; then n=80; fi
        tail -n "$n" "$UPDATE_LOG" 2>/dev/null || say "No update has been logged yet." ;;
      *) show_logs game "${args[1]:-200}" ;;
    esac
    exit ;;
  restart)
    case "$which" in
      game) restart_and_wait 1 0 "$GAME_WAIT" ;;
      web) restart_and_wait 0 1 "$GAME_WAIT" ;;
      *) restart_and_wait 1 1 "$GAME_WAIT" ;;
    esac
    say "Both halves are up."
    exit ;;
  rollback)
    plan="$BASE/backups/$(cat "$BASE/last-backup" 2>/dev/null || echo none)/plan"
    if [ ! -f "$plan" ]; then fail "There is no backup to go back to."; fi
    game=0; web=0
    if grep -qx 'restart_game=1' "$plan"; then game=1; fi
    if grep -qx 'restart_web=1' "$plan"; then web=1; fi
    phase rollback
    if restart_and_wait "$game" "$web" "$GAME_WAIT"; then say "The server is running the version from before the last update."; else exit 1; fi
    exit ;;
  *) fail "This key can only run: update, rebuild, version, check, status, logs [game|web] [lines], restart [game|web], rollback" ;;
esac

# ---- update, rebuild --------------------------------------------------------------------------------
if [ -z "$TEST" ]; then
  exec 9> /run/tsps-update.lock
  if ! flock -n 9; then fail "Another update is running. Try again when it has finished."; fi
  # An update that has started finishes even if the connection from the PC drops: hang-ups
  # are ignored, and everything printed also goes to a log that outlives the connection
  # (npm run remote -- logs update).
  trap '' HUP PIPE
  exec > >(tee --output-error=warn -a "$UPDATE_LOG") 2>&1
  say "---- $(date '+%F %T') ${args[*]}"
fi

if [ "${args[0]}" = rebuild ]; then
  base=rebuild
  phase stage rebuild < /dev/null
else
  base="${args[1]:-}"
  if [[ ! "$base" =~ ^(full|[0-9a-f]{40})$ ]]; then fail "update needs the version the upload builds on, or full."; fi
  phase stage "$base"       # reads the upload from stdin
fi

first="$(flag first)"
game="$(flag restart_game)"
web="$(flag restart_web)"
wait="$GAME_WAIT"
if [ ! -d "$DEST/server/caches" ]; then
  wait="$FIRST_GAME_WAIT"
  say "The first start downloads the game cache, so it takes a good while longer than later ones."
fi
phase swap

if restart_and_wait "$game" "$web" "$wait"; then
  phase finish
  if [ "$game" = 0 ]; then say "The game server was not restarted: nothing it runs changed."; fi
  say "The server is running the new version."
else
  say
  if [ "$first" = 1 ]; then
    say "This was the first install, so there is no earlier version to put back. The files stay in place;"
    say "look at: npm run remote -- logs game"
    exit 1
  fi
  say "Putting the previous version back..."
  phase rollback
  if restart_and_wait "$game" "$web" "$GAME_WAIT"; then say "The previous version is running again."
  else say "The previous version did not come up either. Look at: npm run remote -- logs game"; fi
  exit 1
fi

if [ -z "$TEST" ] && ! cmp -s "$DEST/deploy/update.sh" "$INSTALLED"; then
  say
  say "Note: this version comes with a newer updater. To use it, run on the server as root:"
  say "  install -m 755 $DEST/deploy/update.sh $INSTALLED"
fi
for unit in tsps-game tsps-web; do
  if [ -z "$TEST" ] && ! cmp -s "$DEST/deploy/$unit.service" "/etc/systemd/system/$unit.service"; then
    say
    say "Note: this version changes $unit.service. To apply it, run on the server as root:"
    say "  cp $DEST/deploy/$unit.service /etc/systemd/system/ && systemctl daemon-reload && systemctl restart $unit"
  fi
done
say
check
