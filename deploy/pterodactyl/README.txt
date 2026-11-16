The Pterodactyl egg
===================

egg-kat-net-tsps.json runs this game on a Pterodactyl (or Pelican) panel: the game server and
its website in one server, on one port. Players open the server's address in a browser.

What a server needs
-------------------
  Memory   4 GB or more (the website's build peaks a little over 2 GB; the game takes 70% of
           the server's memory as its limit, and wants more the more bots there are).
  Disk     5 GB or more (the project, its packages, the built website and the game cache).
  Ports    one. The website, the game connection and the game's data all answer on it.
  Image    Node.js 22 (ghcr.io/parkervcp/yolks:nodejs_22), set by the egg.

Adding it to the panel
----------------------
  1. Admin > Nests > Import Egg, choose egg-kat-net-tsps.json and a nest to put it in.
  2. Create a server with that egg. The variables on the Startup page are the world's settings.
  3. The install fetches the project and builds it: several minutes. Its log is on the
     server's install screen.
  4. Start the server. The first start downloads the game cache (about 250 MB) and takes a
     while longer; the panel shows the server as running once the console says
     "[egg] The world is online".
  5. Open http://<the node's address>:<the server's port> in a browser.

The variables
-------------
  World name          the world's name and the name on the login screen. Changing it rebuilds
                      the website on the next start (several minutes).
  World description   a line about the world.
  XP rate             1 is as the original game.
  Bots                how many levelling bots walk the world; 0 turns every bot off.
  Developer accounts  account names that are developers when they log in, comma-separated.
                      Register the account in game BEFORE naming it here: a name nobody has
                      registered yet belongs to whoever logs in with it first.
  Public game address only for a world list (wss://play.example.com).
  Update on start     1: each start fetches the newest version and rebuilds what changed.
  Rebuild on start    1: build everything again on the next start; set it back to 0 after.
  Game memory (MB)    empty: 70% of the server's memory.
  Project address     where the project is installed and updated from (admins only).
  Project branch      which branch (admins only).

Good to know
------------
  * Stopping the server from the panel saves every player first. Killing it does not.
  * https. On a plain http address the game works but runs slower: browsers only allow the
    faster drawing and the shared memory the game uses on an https page. Put the server's port
    behind a proxy with a certificate (Cloudflare, nginx, Caddy); websockets must pass through.
  * What is never replaced by an update or a reinstall: player saves (server/data/saves), the
    game cache (server/caches), .env, and server/data/definitions/world.local.json.
  * More settings. Anything the egg has no variable for goes in a file named .env in the
    server's folder (see .env.example), or in world.local.json for the world's own settings
    (docs/world-configuration.md lists them). The launcher only writes the keys of the variables
    above into world.local.json and leaves the rest of it alone.
  * Editing the game. Most content is plain JavaScript and JSON under server/plugins and
    server/data: edit it in the file manager and restart. With "Update on start" on, your edits
    to the project's files are put aside during the update and put back over the new version.
    If the same lines changed on both sides, the new version's files are kept whole, the console
    says so, and your edits stay aside in git's stash ("git stash show -p" shows them) for you
    to put back by hand. Turn updates off to stay on your version.
  * An update only ever adds to the version installed. If the project's history was rewritten,
    or the copy has commits of its own, the console says so and the version installed starts;
    "Reinstall" in the panel fetches the project afresh (saves are kept).
  * Our own server's settings (deploy/settings.env: its developers, its address) are not read
    by the egg. They are for the server this project is deployed to with "npm run deploy".

Changing the egg
----------------
The egg file is made by a script, not edited by hand:

  node deploy/pterodactyl/make-egg.mjs

Its install script is install.sh, its variables are listed in make-egg.mjs, and what a server
runs is launch.mjs. server/tests/pterodactyl-egg.test.cjs checks that the file is up to date.
After changing the egg, import it again in the panel (the panel keeps its own copy).
