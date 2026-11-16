#!/bin/bash
# The egg's install script (it is copied into egg-kat-net-tsps.json by make-egg.mjs).
# Runs once, as root, in the install container (node:22-bookworm), with the server's files at
# /mnt/server and the egg's variables in the environment. Running it again ("Reinstall" in the
# panel) fetches the project afresh and keeps everything that is not the project's: player
# saves, the game cache, .env and world.local.json.
set -e
cd /mnt/server

REPO="${GIT_REPO:-https://github.com/katnightfall/ksps.git}"
BRANCH="${GIT_BRANCH:-main}"
git config --global --add safe.directory '*'

echo "[egg] Fetching $REPO ($BRANCH)..."
if [ ! -d .git ]; then
    git init -q .
    git remote add origin "$REPO"
else
    git remote set-url origin "$REPO"
fi
git fetch --depth 1 origin "$BRANCH"
git checkout -q -f -B "$BRANCH" FETCH_HEAD
git branch -q --set-upstream-to="origin/$BRANCH" "$BRANCH" || true

# Packages, the game server and the website: the same steps a start runs when something changed.
node deploy/pterodactyl/launch.mjs --prepare

echo "[egg] Installed. Start the server: its first start downloads the game cache."
