#!/usr/bin/env bash
# One-time setup on the server, as root. `npm run deploy:setup` sends this
# folder and runs it; by hand it is:
#   bash ~/tsps-deploy-setup/setup.sh 'ssh-ed25519 AAAA... tsps-deploy' <login user> [--web-port 3000] [--game-port 43594]
#
# It installs nothing of the game itself (the first `npm run deploy` sends
# that). It
#   1. installs Node.js 22 if the server has none new enough;
#   2. makes the tsps user and the folders /opt/tsps (the project) and
#      /opt/tsps-deploy (backups, build folder, package caches);
#   3. installs two services, tsps-game and tsps-web, which start once the
#      first deploy has put the project there, and after every reboot;
#   4. opens the two ports if a firewall is running;
#   5. installs the updater as /usr/local/sbin/tsps-update and lets the deploy
#      key run that and nothing else (no shell, no forwarding).
# Running it again is safe: it refreshes the updater and the services and
# keeps everything else.
set -euo pipefail

key="${1:-}"
login="${2:-}"
shift 2 || true
WEB_PORT=3000
GAME_PORT=43594
CONF=/etc/tsps-deploy.conf
# shellcheck disable=SC1090
if [ -f "$CONF" ]; then . "$CONF"; fi     # keep the ports of an earlier setup unless told otherwise
while [ $# -gt 0 ]; do
  case "$1" in
    --web-port) WEB_PORT="${2:-}"; shift 2 ;;
    --game-port) GAME_PORT="${2:-}"; shift 2 ;;
    *) echo "Unknown option $1"; exit 1 ;;
  esac
done

DEST=/opt/tsps
BASE=/opt/tsps-deploy
APP_USER=tsps
UPDATER=/usr/local/sbin/tsps-update
NODE_NEEDS="22.16.0"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! "$key" =~ ^ssh-(ed25519|rsa)\ [A-Za-z0-9+/=]+(\ [A-Za-z0-9_.@-]*)?$ ]]; then
  echo "Give the public key (starting ssh-ed25519) as the first argument, in quotes."; exit 1
fi
if [ "$(id -u)" -ne 0 ]; then echo "Run it as root (or with sudo)."; exit 1; fi
if ! id "$login" >/dev/null 2>&1; then echo "Give the user the deploy key logs in as (root, or your own login) as the second argument."; exit 1; fi
for port in "$WEB_PORT" "$GAME_PORT"; do
  if [[ ! "$port" =~ ^[0-9]{2,5}$ ]] || [ "$port" -gt 65535 ]; then echo "$port isn't a port number."; exit 1; fi
done
if [ "$WEB_PORT" = "$GAME_PORT" ]; then echo "The web client and the game server need two different ports."; exit 1; fi
if ! command -v systemctl >/dev/null; then echo "This server has no systemd, which the setup needs to keep the game running."; exit 1; fi

say() { printf '\n==> %s\n' "$1"; }
ask() {   # question -> yes or no
  local answer
  read -r -p "$1 [y/N] " answer < /dev/tty || answer=n
  [[ "$answer" =~ ^[Yy] ]]
}
up() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# ---- the ports ------------------------------------------------------------------------------------
# Something else on a port (another site on 3000, say) would keep the service from ever starting.
busy=''
if up "$WEB_PORT" && ! systemctl is-active --quiet tsps-web; then busy+=" $WEB_PORT (web client: choose another with --web-port)"; fi
if up "$GAME_PORT" && ! systemctl is-active --quiet tsps-game; then busy+=" $GAME_PORT (game server: choose another with --game-port)"; fi
if [ -n "$busy" ]; then
  echo "Something on this server already uses port$busy."
  echo "For example: npm run deploy:setup -- --web-port 3100"
  exit 1
fi

# ---- 1. Node.js -----------------------------------------------------------------------------------
new_enough() { [ "$(printf '%s\n' "$NODE_NEEDS" "$1" | sort -V | head -1)" = "$NODE_NEEDS" ]; }
have=''
if command -v node >/dev/null; then have="$(node -p 'process.versions.node' 2>/dev/null || true)"; fi
if [ -n "$have" ] && new_enough "$have"; then
  echo "Node $have is installed."
else
  if [ -n "$have" ]; then
    echo "This server has Node $have; TSPS needs $NODE_NEEDS or newer."
    echo "Replacing it changes Node for everything else on this server that uses it."
    if ! ask "Install Node 22 over it?"; then echo "Nothing was changed."; exit 1; fi
  fi
  say "Installing Node.js 22"
  if command -v apt-get >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates gnupg >/dev/null
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  elif command -v dnf >/dev/null; then
    dnf install -y -q curl ca-certificates >/dev/null
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - >/dev/null
    dnf install -y -q nodejs >/dev/null
  else
    echo "This isn't a Debian/Ubuntu or Fedora/RHEL family server, so Node can't be installed for you."
    echo "Install Node.js $NODE_NEEDS or newer by hand, then run this again."
    exit 1
  fi
  have="$(node -p 'process.versions.node')"
  if ! new_enough "$have"; then echo "Node $have was installed, which is still older than $NODE_NEEDS."; exit 1; fi
  echo "Node $have is installed."
fi
for tool in tar gzip flock runuser comm xargs; do
  if ! command -v "$tool" >/dev/null; then echo "This server is missing the '$tool' command. Install it, then run this again."; exit 1; fi
done

mem_gb="$(awk '/MemTotal/ { printf "%d", $2 / 1048576 }' /proc/meminfo)"
if [ "$mem_gb" -lt 6 ]; then
  echo
  echo "Note: this server has about ${mem_gb} GB of memory. The game server and building the web client"
  echo "are both hungry; with less than 6 GB a build may fail or the game may be slow to start."
fi

# ---- 2. the user and the folders ------------------------------------------------------------------
say "The $APP_USER user and its folders"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$BASE/home" --shell "$(command -v nologin || echo /usr/sbin/nologin)" "$APP_USER"
fi
install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$DEST"
install -d -m 750 -o "$APP_USER" -g "$APP_USER" "$BASE" "$BASE/home" "$BASE/backups"
if [ ! -f "$DEST/.env" ]; then
  # Never sent or replaced by a deploy. Settings and secrets for this server only go here.
  cat > "$DEST/.env" <<'ENV'
# This server's own settings. A deploy never sends or replaces this file.
# The full list of what can go here is in .env.example next to it.
# After changing it: restart the game (npm run remote -- restart game), and for
# REACT_APP_ lines also rebuild the web client (npm run remote -- rebuild).

# Accounts that are developers (highest rank) every time they log in, comma-separated.
# DEV_USERNAME=

# To list the world on rsps.app (token from Settings > Server tokens there):
# WEBRTC_WORLD_ID=my-world
# WEBRTC_WORLD_TOKEN=

GATEWAY_LOGIN_HTTP_PORT=0
GATEWAY_LOGIN_TRUST_LOOPBACK_PROXY=false
ENV
  chown "$APP_USER:$APP_USER" "$DEST/.env"
  chmod 600 "$DEST/.env"
fi
echo "Project folder: $DEST    Backups and build folder: $BASE"

umask 022
{
  echo "# Written by deploy/setup.sh on $(date +%F). Read by the services and the updater."
  echo "WEB_PORT=$WEB_PORT"
  echo "GAME_PORT=$GAME_PORT"
} > "$CONF"

# ---- 3. the services ------------------------------------------------------------------------------
say "The services tsps-game and tsps-web"
install -m 644 -o root -g root "$here/tsps-game.service" "$here/tsps-web.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable tsps-game tsps-web >/dev/null 2>&1
echo "They start with the first deploy, and by themselves after a reboot."

# ---- 4. the firewall ------------------------------------------------------------------------------
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
  say "Opening ports $WEB_PORT and $GAME_PORT in ufw"
  ufw allow "$WEB_PORT/tcp" >/dev/null
  ufw allow "$GAME_PORT/tcp" >/dev/null
elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  say "Opening ports $WEB_PORT and $GAME_PORT in firewalld"
  firewall-cmd --quiet --permanent --add-port="$WEB_PORT/tcp" --add-port="$GAME_PORT/tcp"
  firewall-cmd --quiet --reload
else
  echo
  echo "No ufw or firewalld is running here. If your host has its own firewall (a panel on their website),"
  echo "allow TCP ports $WEB_PORT and $GAME_PORT there."
fi

# ---- 5. the updater and the key -------------------------------------------------------------------
say "The updater and the deploy key"
install -m 755 -o root -g root "$here/update.sh" "$UPDATER"
home="$(getent passwd "$login" | cut -d: -f6)"
if [ "$login" = root ]; then
  forced="$UPDATER --ssh \\\"\$SSH_ORIGINAL_COMMAND\\\""
else
  # A login that isn't root may run exactly the updater as root, and nothing else.
  rule=/etc/sudoers.d/tsps-deploy
  printf '%s ALL=(root) NOPASSWD: %s\n' "$login" "$UPDATER" > "$rule.tmp"
  chmod 440 "$rule.tmp"
  if visudo -cf "$rule.tmp" >/dev/null; then mv "$rule.tmp" "$rule"
  else rm -f "$rule.tmp"; echo "The sudo rule didn't validate, so the key was not added."; exit 1; fi
  forced="sudo -n $UPDATER --ssh \\\"\$SSH_ORIGINAL_COMMAND\\\""
fi
install -d -m 700 -o "$login" -g "$(id -gn "$login")" "$home/.ssh"
touch "$home/.ssh/authorized_keys"
chown "$login:$(id -gn "$login")" "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"
read -r _ blob _ <<< "$key"
if grep -qF "$blob" "$home/.ssh/authorized_keys"; then
  echo "That key is already allowed for $login. The updater it runs has been refreshed."
else
  echo "command=\"$forced\",restrict $key" >> "$home/.ssh/authorized_keys"
  echo "Key added for $login. It can only run: update, rebuild, version, check, status, logs, restart, rollback."
fi

echo
"$UPDATER" check
echo
echo "All set. Now run  npm run deploy  on your PC: the first one sends the whole project, installs its"
echo "packages, builds it and downloads the game cache, so give it 15 to 30 minutes. Later ones are quick."
echo "Then the game is at http://$(hostname -I 2>/dev/null | awk '{print $1}'):$WEB_PORT"
